package pg

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) ListDatasets(ctx context.Context, municipalityID string) ([]domain.Dataset, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	rows, err := s.pool.Query(ctx, `
		SELECT
			ds.id,
			ds.municipality_id,
			coalesce(ds.owner, ds.municipality_id || ' - ' || ds.kind) AS name,
			ds.kind,
			count(dv.id)::bigint AS versions,
			ds.created_at
		FROM dataset_sources ds
		LEFT JOIN dataset_versions dv ON dv.source_id = ds.id
		WHERE ds.municipality_id = $1
		GROUP BY ds.id, ds.municipality_id, ds.owner, ds.kind, ds.created_at
		ORDER BY max(dv.ingested_at) DESC NULLS LAST, ds.created_at DESC
	`, muni)
	if err != nil {
		return nil, fmt.Errorf("list datasets: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Dataset, 0)
	for rows.Next() {
		var d domain.Dataset
		if err := rows.Scan(&d.ID, &d.MunicipalityID, &d.Name, &d.Kind, &d.Versions, &d.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan dataset: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate datasets: %w", err)
	}
	return out, nil
}

func (s *Store) ListExpenses(ctx context.Context, filter domain.ExpenseFilter) ([]domain.Expense, error) {
	muni := domain.NormalizeMunicipality(filter.MunicipalityID)

	var sb strings.Builder
	sb.WriteString(`
		SELECT
			id,
			municipality_id,
			version_id,
			entity,
			category,
			amount_cents,
			to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on,
			doc_ref
		FROM expense_records
		WHERE municipality_id = $1
	`)
	args := []any{muni}

	if entity := strings.TrimSpace(filter.Entity); entity != "" {
		args = append(args, entity)
		sb.WriteString(fmt.Sprintf(" AND entity = $%d", len(args)))
	}
	if category := strings.TrimSpace(filter.Category); category != "" {
		args = append(args, category)
		sb.WriteString(fmt.Sprintf(" AND category = $%d", len(args)))
	}
	if from := strings.TrimSpace(filter.From); from != "" {
		args = append(args, from)
		sb.WriteString(fmt.Sprintf(" AND occurred_on >= $%d::date", len(args)))
	}
	if to := strings.TrimSpace(filter.To); to != "" {
		args = append(args, to)
		sb.WriteString(fmt.Sprintf(" AND occurred_on <= $%d::date", len(args)))
	}

	sb.WriteString(" ORDER BY occurred_on DESC NULLS LAST, id ASC LIMIT 200")

	rows, err := s.pool.Query(ctx, sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list expenses: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Expense, 0)
	for rows.Next() {
		var e domain.Expense
		if err := rows.Scan(
			&e.ID,
			&e.MunicipalityID,
			&e.VersionID,
			&e.Entity,
			&e.Category,
			&e.AmountCents,
			&e.OccurredOn,
			&e.DocRef,
		); err != nil {
			return nil, fmt.Errorf("scan expense: %w", err)
		}
		e.Amount = domain.FormatCents(e.AmountCents)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate expenses: %w", err)
	}
	return out, nil
}

func (s *Store) ListPublishedReports(ctx context.Context, municipalityID string) ([]domain.PublicReportSummary, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	rows, err := s.pool.Query(ctx, `
		SELECT
			p.id,
			p.report_id,
			p.municipality_id,
			r.status,
			r.category,
			p.public_text,
			p.published_at
		FROM publications p
		JOIN reports r ON r.id = p.report_id
		WHERE p.municipality_id = $1 AND r.municipality_id = $1 AND r.status = 'PUBLISHED'
		ORDER BY p.published_at DESC
		LIMIT 200
	`, muni)
	if err != nil {
		return nil, fmt.Errorf("list published reports: %w", err)
	}
	defer rows.Close()

	out := make([]domain.PublicReportSummary, 0)
	for rows.Next() {
		var item domain.PublicReportSummary
		if err := rows.Scan(
			&item.ID,
			&item.ReportID,
			&item.MunicipalityID,
			&item.Status,
			&item.Category,
			&item.PublicText,
			&item.PublishedAt,
		); err != nil {
			return nil, fmt.Errorf("scan published report: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate published reports: %w", err)
	}
	return out, nil
}

func (s *Store) GetPublishedReport(ctx context.Context, municipalityID string, id uuid.UUID) (*domain.PublicReportDetail, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	var detail domain.PublicReportDetail
	err := s.pool.QueryRow(ctx, `
		SELECT
			p.id,
			p.report_id,
			p.municipality_id,
			r.status,
			r.category,
			p.public_text,
			p.published_at
		FROM publications p
		JOIN reports r ON r.id = p.report_id
		WHERE p.municipality_id = $1
		  AND r.municipality_id = $1
		  AND r.status = 'PUBLISHED'
		  AND (p.id = $2 OR p.report_id = $2)
		LIMIT 1
	`, muni, id).Scan(
		&detail.ID,
		&detail.ReportID,
		&detail.MunicipalityID,
		&detail.Status,
		&detail.Category,
		&detail.PublicText,
		&detail.PublishedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, fmt.Errorf("get published report: %w", err)
	}

	evRows, err := s.pool.Query(ctx, `
		SELECT id, report_id, storage_ref, sha256, uploaded_at
		FROM evidence
		WHERE report_id = $1
		ORDER BY uploaded_at ASC
	`, detail.ReportID)
	if err != nil {
		return nil, fmt.Errorf("list published report evidence: %w", err)
	}
	defer evRows.Close()

	detail.Evidence = make([]domain.Evidence, 0)
	for evRows.Next() {
		var ev domain.Evidence
		ev.MunicipalityID = detail.MunicipalityID
		if err := evRows.Scan(&ev.ID, &ev.ReportID, &ev.StorageRef, &ev.SHA256, &ev.UploadedAt); err != nil {
			return nil, fmt.Errorf("scan published report evidence: %w", err)
		}
		detail.Evidence = append(detail.Evidence, ev)
	}
	if err := evRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate published report evidence: %w", err)
	}

	return &detail, nil
}

func (s *Store) GetReport(ctx context.Context, municipalityID string, id uuid.UUID) (*domain.Report, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	var r domain.Report
	err := s.pool.QueryRow(ctx, `
		SELECT id, municipality_id, status, category, description, created_at
		FROM reports
		WHERE id = $1 AND municipality_id = $2
	`, id, muni).Scan(&r.ID, &r.MunicipalityID, &r.Status, &r.Category, &r.Description, &r.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, fmt.Errorf("get report: %w", err)
	}
	return &r, nil
}

func (s *Store) CreateReport(ctx context.Context, report domain.Report, actor domain.Actor) (domain.Report, error) {
	if report.ID == uuid.Nil {
		report.ID = uuid.New()
	}
	report.MunicipalityID = domain.NormalizeMunicipality(report.MunicipalityID)
	if report.Status == "" {
		report.Status = "DRAFT"
	}
	if report.CreatedAt.IsZero() {
		report.CreatedAt = time.Now().UTC()
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Report{}, fmt.Errorf("begin create report tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO reports (id, municipality_id, status, category, description, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, report.ID, report.MunicipalityID, report.Status, report.Category, report.Description, report.CreatedAt)
	if err != nil {
		return domain.Report{}, fmt.Errorf("insert report: %w", err)
	}

	if err := insertAuditEvent(ctx, tx, actor, "report_create", "report", report.ID.String(), map[string]any{
		"municipality_id": report.MunicipalityID,
		"status":          report.Status,
		"category":        report.Category,
	}); err != nil {
		return domain.Report{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Report{}, fmt.Errorf("commit create report: %w", err)
	}
	return report, nil
}

func (s *Store) AddEvidence(ctx context.Context, evidence domain.Evidence, actor domain.Actor) (domain.Evidence, error) {
	if evidence.ID == uuid.Nil {
		evidence.ID = uuid.New()
	}
	evidence.MunicipalityID = domain.NormalizeMunicipality(evidence.MunicipalityID)
	if evidence.UploadedAt.IsZero() {
		evidence.UploadedAt = time.Now().UTC()
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Evidence{}, fmt.Errorf("begin add evidence tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx, `
		SELECT status FROM reports WHERE id = $1 AND municipality_id = $2
	`, evidence.ReportID, evidence.MunicipalityID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Evidence{}, domain.ErrNotFound
		}
		return domain.Evidence{}, fmt.Errorf("check report for evidence: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO evidence (id, report_id, storage_ref, sha256, uploaded_at)
		VALUES ($1, $2, $3, $4, $5)
	`, evidence.ID, evidence.ReportID, evidence.StorageRef, evidence.SHA256, evidence.UploadedAt)
	if err != nil {
		return domain.Evidence{}, fmt.Errorf("insert evidence: %w", err)
	}

	if err := insertAuditEvent(ctx, tx, actor, "evidence_attach", "evidence", evidence.ID.String(), map[string]any{
		"municipality_id": evidence.MunicipalityID,
		"report_id":       evidence.ReportID.String(),
		"report_status":   status,
		"sha256":          evidence.SHA256,
	}); err != nil {
		return domain.Evidence{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Evidence{}, fmt.Errorf("commit add evidence: %w", err)
	}
	return evidence, nil
}

func (s *Store) TransitionReport(
	ctx context.Context,
	id uuid.UUID,
	municipalityID, fromStatus, toStatus, action, actorID, reason string,
) (domain.Report, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	now := time.Now().UTC()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Report{}, fmt.Errorf("begin transition tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var updated domain.Report
	err = tx.QueryRow(ctx, `
		UPDATE reports
		SET status = $1
		WHERE id = $2 AND municipality_id = $3 AND status = $4
		RETURNING id, municipality_id, status, category, description, created_at
	`, toStatus, id, muni, fromStatus).Scan(
		&updated.ID,
		&updated.MunicipalityID,
		&updated.Status,
		&updated.Category,
		&updated.Description,
		&updated.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var existingStatus string
			checkErr := tx.QueryRow(ctx, `
				SELECT status FROM reports WHERE id = $1 AND municipality_id = $2
			`, id, muni).Scan(&existingStatus)
			if errors.Is(checkErr, pgx.ErrNoRows) {
				return domain.Report{}, domain.ErrNotFound
			}
			return domain.Report{}, fmt.Errorf("%w: report status changed concurrently", domain.ErrConflict)
		}
		return domain.Report{}, fmt.Errorf("update report status: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO report_status_events
			(id, report_id, from_status, to_status, action, occurred_at, actor_id, reason)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, uuid.New(), id, fromStatus, toStatus, action, now, nullableText(actorID), reason)
	if err != nil {
		return domain.Report{}, fmt.Errorf("insert report status event: %w", err)
	}

	if err := upsertVerificationCase(ctx, tx, id, toStatus, actorID, reason, now); err != nil {
		return domain.Report{}, err
	}

	actor := actorFromID(action, actorID)
	if err := insertAuditEvent(ctx, tx, actor, "report_transition", "report", id.String(), map[string]any{
		"municipality_id": muni,
		"from_status":     fromStatus,
		"to_status":       toStatus,
		"action":          action,
		"reason":          reason,
	}); err != nil {
		return domain.Report{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Report{}, fmt.Errorf("commit transition report: %w", err)
	}
	return updated, nil
}

func (s *Store) PublishReport(
	ctx context.Context,
	id uuid.UUID,
	municipalityID, fromStatus, publicText, actorID, reason string,
) (domain.Publication, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	now := time.Now().UTC()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Publication{}, fmt.Errorf("begin publish tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cmd, err := tx.Exec(ctx, `
		UPDATE reports
		SET status = 'PUBLISHED'
		WHERE id = $1 AND municipality_id = $2 AND status = $3
	`, id, muni, fromStatus)
	if err != nil {
		return domain.Publication{}, fmt.Errorf("update report published status: %w", err)
	}
	if cmd.RowsAffected() == 0 {
		var existingStatus string
		checkErr := tx.QueryRow(ctx, `
			SELECT status FROM reports WHERE id = $1 AND municipality_id = $2
		`, id, muni).Scan(&existingStatus)
		if errors.Is(checkErr, pgx.ErrNoRows) {
			return domain.Publication{}, domain.ErrNotFound
		}
		return domain.Publication{}, fmt.Errorf("%w: report status changed concurrently", domain.ErrConflict)
	}

	pub := domain.Publication{
		ID:             uuid.New(),
		ReportID:       id,
		MunicipalityID: muni,
		PublicText:     publicText,
		PublishedAt:    now,
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO publications (id, report_id, public_text, published_at, municipality_id)
		VALUES ($1, $2, $3, $4, $5)
	`, pub.ID, pub.ReportID, pub.PublicText, pub.PublishedAt, pub.MunicipalityID)
	if err != nil {
		return domain.Publication{}, fmt.Errorf("insert publication: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO report_status_events
			(id, report_id, from_status, to_status, action, occurred_at, actor_id, reason)
		VALUES ($1, $2, $3, 'PUBLISHED', 'PUBLISH', $4, $5, $6)
	`, uuid.New(), id, fromStatus, now, nullableText(actorID), reason)
	if err != nil {
		return domain.Publication{}, fmt.Errorf("insert publish status event: %w", err)
	}

	if err := upsertVerificationCase(ctx, tx, id, "PUBLISHED", actorID, reason, now); err != nil {
		return domain.Publication{}, err
	}

	actor := domain.Actor{Type: "moderator", ID: actorID}
	if err := insertAuditEvent(ctx, tx, actor, "report_publish", "report", id.String(), map[string]any{
		"municipality_id": muni,
		"from_status":     fromStatus,
		"to_status":       "PUBLISHED",
		"publication_id":  pub.ID.String(),
		"reason":          reason,
	}); err != nil {
		return domain.Publication{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Publication{}, fmt.Errorf("commit publish report: %w", err)
	}
	return pub, nil
}

func (s *Store) ListModerationCases(ctx context.Context, municipalityID string, statusFilter string) ([]domain.ModerationCase, error) {
	muni := domain.NormalizeMunicipality(municipalityID)

	var sb strings.Builder
	sb.WriteString(`
		SELECT
			coalesce(vc.id, r.id) AS id,
			r.id AS report_id,
			r.municipality_id,
			r.status,
			r.category,
			r.description,
			vc.assigned_to,
			vc.notes,
			r.created_at,
			coalesce(vc.updated_at, r.created_at) AS updated_at
		FROM reports r
		LEFT JOIN verification_cases vc ON vc.report_id = r.id
		WHERE r.municipality_id = $1 AND r.status <> 'DRAFT'
	`)
	args := []any{muni}
	if sf := strings.ToUpper(strings.TrimSpace(statusFilter)); sf != "" {
		args = append(args, sf)
		sb.WriteString(fmt.Sprintf(" AND r.status = $%d", len(args)))
	}
	sb.WriteString(" ORDER BY coalesce(vc.updated_at, r.created_at) DESC, r.created_at DESC LIMIT 200")

	rows, err := s.pool.Query(ctx, sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list moderation cases: %w", err)
	}
	defer rows.Close()

	out := make([]domain.ModerationCase, 0)
	for rows.Next() {
		var c domain.ModerationCase
		if err := rows.Scan(
			&c.ID,
			&c.ReportID,
			&c.MunicipalityID,
			&c.Status,
			&c.Category,
			&c.Description,
			&c.AssignedTo,
			&c.Notes,
			&c.CreatedAt,
			&c.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan moderation case: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate moderation cases: %w", err)
	}
	return out, nil
}

func (s *Store) IngestExpensesIdempotent(
	ctx context.Context,
	municipalityID, sourceKind, checksum string,
	rows []domain.IngestRow,
	actorID string,
) (domain.IngestResult, error) {
	muni := domain.NormalizeMunicipality(municipalityID)
	now := time.Now().UTC()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.IngestResult{}, fmt.Errorf("begin ingest tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sourceID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT id
		FROM dataset_sources
		WHERE municipality_id = $1 AND kind = $2
		ORDER BY created_at ASC
		LIMIT 1
	`, muni, sourceKind).Scan(&sourceID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return domain.IngestResult{}, fmt.Errorf("lookup dataset source: %w", err)
		}
		sourceID = uuid.New()
		owner := muni
		if len(rows) > 0 && strings.TrimSpace(rows[0].Entity) != "" {
			owner = rows[0].Entity
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO dataset_sources (id, kind, url, owner, license, created_at, municipality_id)
			VALUES ($1, $2, $3, $4, 'open', $5, $6)
		`, sourceID, sourceKind, "file://fixtures/demo_expenses.csv", owner, now, muni)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert dataset source: %w", err)
		}
	}

	var existingVersionID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT id
		FROM dataset_versions
		WHERE source_id = $1 AND checksum_sha256 = $2
		LIMIT 1
	`, sourceID, checksum).Scan(&existingVersionID)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return domain.IngestResult{}, fmt.Errorf("commit dedup ingest: %w", err)
		}
		return domain.IngestResult{
			MunicipalityID:   muni,
			DatasetVersionID: existingVersionID,
			ChecksumSHA256:   checksum,
			RowsIngested:     0,
			Deduplicated:     true,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.IngestResult{}, fmt.Errorf("lookup dataset version: %w", err)
	}

	versionID := uuid.New()
	_, err = tx.Exec(ctx, `
		INSERT INTO dataset_versions (id, source_id, checksum_sha256, ingested_at)
		VALUES ($1, $2, $3, $4)
	`, versionID, sourceID, checksum, now)
	if err != nil {
		return domain.IngestResult{}, fmt.Errorf("insert dataset version: %w", err)
	}

	for _, r := range rows {
		amountDecimal := domain.FormatCents(r.AmountCents)
		_, err = tx.Exec(ctx, `
			INSERT INTO expense_records
				(id, version_id, entity, category, amount, occurred_on, doc_ref, municipality_id, amount_cents)
			VALUES ($1, $2, $3, $4, $5::numeric(18,2), $6::date, $7, $8, $9)
		`, uuid.New(), versionID, r.Entity, r.Category, amountDecimal, r.OccurredOn, r.DocRef, muni, r.AmountCents)
		if err != nil {
			return domain.IngestResult{}, fmt.Errorf("insert expense record: %w", err)
		}
	}

	actor := domain.Actor{Type: "admin", ID: actorID}
	if err := insertAuditEvent(ctx, tx, actor, "dataset_ingest_demo", "dataset_version", versionID.String(), map[string]any{
		"municipality_id": muni,
		"source_id":       sourceID.String(),
		"checksum_sha256": checksum,
		"rows_ingested":   len(rows),
		"deduplicated":    false,
	}); err != nil {
		return domain.IngestResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.IngestResult{}, fmt.Errorf("commit ingest tx: %w", err)
	}

	return domain.IngestResult{
		MunicipalityID:   muni,
		DatasetVersionID: versionID,
		ChecksumSHA256:   checksum,
		RowsIngested:     len(rows),
		Deduplicated:     false,
	}, nil
}

func upsertVerificationCase(
	ctx context.Context,
	tx pgx.Tx,
	reportID uuid.UUID,
	status, assignedTo, notes string,
	updatedAt time.Time,
) error {
	cmd, err := tx.Exec(ctx, `
		UPDATE verification_cases
		SET status = $1,
		    assigned_to = coalesce(nullif($2, ''), assigned_to),
		    notes = $3,
		    updated_at = $4
		WHERE report_id = $5
	`, status, assignedTo, nullableText(notes), updatedAt, reportID)
	if err != nil {
		return fmt.Errorf("update verification case: %w", err)
	}
	if cmd.RowsAffected() > 0 {
		return nil
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO verification_cases (id, report_id, status, assigned_to, notes, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, uuid.New(), reportID, status, nullableText(assignedTo), nullableText(notes), updatedAt)
	if err != nil {
		return fmt.Errorf("insert verification case: %w", err)
	}
	return nil
}

func insertAuditEvent(
	ctx context.Context,
	tx pgx.Tx,
	actor domain.Actor,
	action, targetType, targetID string,
	metadata map[string]any,
) error {
	metaJSON, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("marshal audit metadata: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events
			(id, occurred_at, actor_type, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
	`, uuid.New(), time.Now().UTC(), actor.Type, nullableText(actor.ID), action, targetType, nullableText(targetID), string(metaJSON))
	if err != nil {
		return fmt.Errorf("insert audit event: %w", err)
	}
	return nil
}

func nullableText(v string) *string {
	trimmed := strings.TrimSpace(v)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func actorFromID(action, actorID string) domain.Actor {
	if strings.EqualFold(action, "SUBMIT") {
		if strings.TrimSpace(actorID) == "" {
			return domain.Actor{Type: "citizen", ID: "anonymous"}
		}
		return domain.Actor{Type: "citizen", ID: actorID}
	}
	return domain.Actor{Type: "moderator", ID: actorID}
}
