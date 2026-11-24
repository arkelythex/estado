package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/arkelythex/estado/services/api/internal/auth"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/arkelythex/estado/services/api/internal/httpapi"
	"github.com/google/uuid"
)

type fakeStore struct {
	mu           sync.Mutex
	datasets     []domain.Dataset
	expenses     []domain.Expense
	reports      map[uuid.UUID]domain.Report
	evidence     map[uuid.UUID][]domain.Evidence
	publications map[uuid.UUID]domain.Publication
	cases        map[uuid.UUID]domain.ModerationCase
	versionsByCS map[string]uuid.UUID
	auditEvents  []domain.AuditEvent
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		reports:      make(map[uuid.UUID]domain.Report),
		evidence:     make(map[uuid.UUID][]domain.Evidence),
		publications: make(map[uuid.UUID]domain.Publication),
		cases:        make(map[uuid.UUID]domain.ModerationCase),
		versionsByCS: make(map[string]uuid.UUID),
	}
}

func (f *fakeStore) recordAudit(actor domain.Actor, action, targetType, targetID string, meta map[string]any) {
	actorID := actor.ID
	tid := targetID
	f.auditEvents = append(f.auditEvents, domain.AuditEvent{
		ID:         uuid.New(),
		OccurredAt: time.Now().UTC(),
		ActorType:  actor.Type,
		ActorID:    &actorID,
		Action:     action,
		TargetType: targetType,
		TargetID:   &tid,
		Metadata:   meta,
	})
}

func (f *fakeStore) ListDatasets(_ context.Context, municipalityID string) ([]domain.Dataset, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.Dataset, 0)
	for _, d := range f.datasets {
		if d.MunicipalityID == municipalityID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (f *fakeStore) ListExpenses(_ context.Context, filter domain.ExpenseFilter) ([]domain.Expense, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.Expense, 0)
	for _, e := range f.expenses {
		if e.MunicipalityID != filter.MunicipalityID {
			continue
		}
		if filter.Entity != "" && e.Entity != filter.Entity {
			continue
		}
		if filter.Category != "" && e.Category != filter.Category {
			continue
		}
		if filter.From != "" && (e.OccurredOn == nil || *e.OccurredOn < filter.From) {
			continue
		}
		if filter.To != "" && (e.OccurredOn == nil || *e.OccurredOn > filter.To) {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

func (f *fakeStore) ListPublishedReports(_ context.Context, municipalityID string) ([]domain.PublicReportSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.PublicReportSummary, 0)
	for _, p := range f.publications {
		if p.MunicipalityID != municipalityID {
			continue
		}
		r := f.reports[p.ReportID]
		if r.Status != "PUBLISHED" {
			continue
		}
		out = append(out, domain.PublicReportSummary{
			ID:             p.ID,
			ReportID:       p.ReportID,
			MunicipalityID: p.MunicipalityID,
			Status:         r.Status,
			Category:       r.Category,
			PublicText:     p.PublicText,
			PublishedAt:    p.PublishedAt,
		})
	}
	return out, nil
}

func (f *fakeStore) GetPublishedReport(_ context.Context, municipalityID string, id uuid.UUID) (*domain.PublicReportDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.publications {
		if p.MunicipalityID != municipalityID {
			continue
		}
		if p.ID != id && p.ReportID != id {
			continue
		}
		r := f.reports[p.ReportID]
		if r.Status != "PUBLISHED" {
			continue
		}
		return &domain.PublicReportDetail{
			ID:             p.ID,
			ReportID:       p.ReportID,
			MunicipalityID: p.MunicipalityID,
			Status:         r.Status,
			Category:       r.Category,
			PublicText:     p.PublicText,
			PublishedAt:    p.PublishedAt,
			EvidenceCount:  len(f.evidence[p.ReportID]),
		}, nil
	}
	return nil, domain.ErrNotFound
}

func (f *fakeStore) GetReport(_ context.Context, municipalityID string, id uuid.UUID) (*domain.Report, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.reports[id]
	if !ok || r.MunicipalityID != municipalityID {
		return nil, domain.ErrNotFound
	}
	copyR := r
	return &copyR, nil
}

func (f *fakeStore) CreateReport(_ context.Context, report domain.Report, actor domain.Actor) (domain.Report, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports[report.ID] = report
	f.recordAudit(actor, "report_create", "report", report.ID.String(), map[string]any{
		"municipality_id": report.MunicipalityID,
		"status":          report.Status,
	})
	return report, nil
}

func (f *fakeStore) AddEvidence(_ context.Context, evidence domain.Evidence, actor domain.Actor) (domain.Evidence, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.reports[evidence.ReportID]
	if !ok || r.MunicipalityID != evidence.MunicipalityID {
		return domain.Evidence{}, domain.ErrNotFound
	}
	if r.Status != "DRAFT" {
		return domain.Evidence{}, fmt.Errorf("%w: cannot add evidence when report status is %s", domain.ErrInvalidTransition, r.Status)
	}
	f.evidence[evidence.ReportID] = append(f.evidence[evidence.ReportID], evidence)
	f.recordAudit(actor, "evidence_attach", "evidence", evidence.ID.String(), map[string]any{
		"report_id": evidence.ReportID.String(),
	})
	return evidence, nil
}

func (f *fakeStore) TransitionReport(_ context.Context, id uuid.UUID, municipalityID, fromStatus, toStatus, action, actorID, reason string) (domain.Report, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.reports[id]
	if !ok || r.MunicipalityID != municipalityID {
		return domain.Report{}, domain.ErrNotFound
	}
	if r.Status != fromStatus {
		return domain.Report{}, domain.ErrConflict
	}
	r.Status = toStatus
	f.reports[id] = r

	now := time.Now().UTC()
	notes := reason
	assigned := actorID
	mc := f.cases[id]
	if mc.ID == uuid.Nil {
		mc.ID = uuid.New()
	}
	mc.ReportID = id
	mc.MunicipalityID = municipalityID
	mc.Status = toStatus
	mc.Category = r.Category
	mc.Description = r.Description
	mc.AssignedTo = &assigned
	mc.Notes = &notes
	mc.CreatedAt = r.CreatedAt
	mc.UpdatedAt = now
	f.cases[id] = mc

	actorType := "moderator"
	if action == "SUBMIT" {
		actorType = "citizen"
	}
	f.recordAudit(domain.Actor{Type: actorType, ID: actorID}, "report_transition", "report", id.String(), map[string]any{
		"from_status": fromStatus,
		"to_status":   toStatus,
		"action":      action,
		"reason":      reason,
	})
	return r, nil
}

func (f *fakeStore) PublishReport(_ context.Context, id uuid.UUID, municipalityID, fromStatus, publicText, actorID, reason string) (domain.Publication, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.reports[id]
	if !ok || r.MunicipalityID != municipalityID {
		return domain.Publication{}, domain.ErrNotFound
	}
	if r.Status != fromStatus {
		return domain.Publication{}, domain.ErrConflict
	}
	r.Status = "PUBLISHED"
	f.reports[id] = r

	pub := domain.Publication{
		ID:             uuid.New(),
		ReportID:       id,
		MunicipalityID: municipalityID,
		PublicText:     publicText,
		PublishedAt:    time.Now().UTC(),
	}
	f.publications[pub.ID] = pub

	mc := f.cases[id]
	mc.Status = "PUBLISHED"
	mc.Notes = &reason
	mc.UpdatedAt = pub.PublishedAt
	f.cases[id] = mc

	f.recordAudit(domain.Actor{Type: "moderator", ID: actorID}, "report_publish", "report", id.String(), map[string]any{
		"publication_id": pub.ID.String(),
		"reason":         reason,
	})
	return pub, nil
}

func (f *fakeStore) ListModerationCases(_ context.Context, municipalityID string, statusFilter string) ([]domain.ModerationCase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]domain.ModerationCase, 0)
	for _, mc := range f.cases {
		if mc.MunicipalityID != municipalityID {
			continue
		}
		if statusFilter != "" && mc.Status != strings.ToUpper(statusFilter) {
			continue
		}
		out = append(out, mc)
	}
	return out, nil
}

func (f *fakeStore) IngestExpensesIdempotent(_ context.Context, municipalityID, sourceKind, checksum string, rows []domain.IngestRow, actorID string) (domain.IngestResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := municipalityID + "|" + sourceKind + "|" + checksum
	if existingID, ok := f.versionsByCS[key]; ok {
		return domain.IngestResult{
			MunicipalityID:   municipalityID,
			DatasetVersionID: existingID,
			ChecksumSHA256:   checksum,
			RowsIngested:     0,
			Deduplicated:     true,
		}, nil
	}

	versionID := uuid.New()
	f.versionsByCS[key] = versionID
	f.datasets = append(f.datasets, domain.Dataset{
		ID:             uuid.New(),
		MunicipalityID: municipalityID,
		Name:           "Municipio Demo",
		Kind:           sourceKind,
		Versions:       1,
		CreatedAt:      time.Now().UTC(),
	})
	for _, r := range rows {
		f.expenses = append(f.expenses, domain.Expense{
			ID:             uuid.New(),
			MunicipalityID: municipalityID,
			VersionID:      versionID,
			Entity:         r.Entity,
			Category:       r.Category,
			AmountCents:    r.AmountCents,
			Amount:         domain.FormatCents(r.AmountCents),
			OccurredOn:     r.OccurredOn,
			DocRef:         r.DocRef,
		})
	}
	f.recordAudit(domain.Actor{Type: "admin", ID: actorID}, "dataset_ingest_demo", "dataset_version", versionID.String(), map[string]any{
		"checksum_sha256": checksum,
		"rows_ingested":   len(rows),
	})
	return domain.IngestResult{
		MunicipalityID:   municipalityID,
		DatasetVersionID: versionID,
		ChecksumSHA256:   checksum,
		RowsIngested:     len(rows),
		Deduplicated:     false,
	}, nil
}

type fakeEngine struct{}

func (fakeEngine) TransitionReport(_ context.Context, currentStatus, action string) (domain.TransitionResult, error) {
	rules := map[string]string{
		"DRAFT|SUBMIT":     "SUBMITTED",
		"SUBMITTED|TRIAGE": "TRIAGED",
		"TRIAGED|VERIFY":   "VERIFIED",
		"VERIFIED|PUBLISH": "PUBLISHED",
		"SUBMITTED|REJECT": "REJECTED",
		"TRIAGED|REJECT":   "REJECTED",
	}
	next, ok := rules[currentStatus+"|"+action]
	if !ok {
		return domain.TransitionResult{}, fmt.Errorf("%w: cannot %s from %s", domain.ErrInvalidTransition, action, currentStatus)
	}
	return domain.TransitionResult{
		FromStatus: currentStatus,
		ToStatus:   next,
		Action:     action,
	}, nil
}

func (fakeEngine) ParseExpenses(_ context.Context, csvContent string) (domain.ParsedExpenses, error) {
	sum := sha256.Sum256([]byte(csvContent))
	d1 := "2026-02-01"
	d2 := "2026-02-02"
	d3 := "2026-02-03"
	r1 := "DOC-001"
	r2 := "DOC-002"
	r3 := "DOC-003"
	rows := []domain.IngestRow{
		{Entity: "Municipio Demo", Category: "OBRAS", AmountCents: 125075, OccurredOn: &d1, DocRef: &r1},
		{Entity: "Municipio Demo", Category: "SERVICIOS", AmountCents: 32050, OccurredOn: &d2, DocRef: &r2},
		{Entity: "Municipio Demo", Category: "PERSONAL", AmountCents: 210000, OccurredOn: &d3, DocRef: &r3},
	}
	return domain.ParsedExpenses{
		ChecksumSHA256: hex.EncodeToString(sum[:]),
		RowCount:       len(rows),
		Rows:           rows,
	}, nil
}

type fakeSigner struct{}

func (fakeSigner) PresignPut(_ context.Context, reportID uuid.UUID, contentType string, sizeBytes int64) (domain.PresignedUpload, error) {
	normalizedType, ext, err := s3.ValidateEvidenceUpload(contentType, sizeBytes)
	if err != nil {
		return domain.PresignedUpload{}, err
	}
	key := fmt.Sprintf("reports/%s/%s%s", reportID.String(), uuid.NewString(), ext)
	return domain.PresignedUpload{
		ObjectKey:        key,
		UploadURL:        "https://minio.local/evidence/" + key + "?X-Amz-Signature=test",
		ExpiresInSeconds: 900,
		UploadHeaders: map[string]string{
			"Content-Type":                 normalizedType,
			"x-amz-server-side-encryption": "AES256",
		},
	}, nil
}

func (fakeSigner) StorageRef(objectKey string) string {
	return "s3://evidence/" + objectKey
}

const (
	testAdminToken = "test-admin-token"
	testModToken   = "test-mod-token"
)

func setupTestServer(t *testing.T) (*httpapi.Server, *fakeStore) {
	t.Helper()
	tmpDir := t.TempDir()
	csvPath := filepath.Join(tmpDir, "demo_expenses.csv")
	csvBody := "entity,category,amount,occurred_on,doc_ref\nMunicipio Demo,OBRAS,1250.75,2026-02-01,DOC-001\n"
	if err := os.WriteFile(csvPath, []byte(csvBody), 0600); err != nil {
		t.Fatalf("write temp csv: %v", err)
	}

	store := newFakeStore()
	authSvc := auth.NewService(auth.Config{
		Mode:              auth.ModeDevStatic,
		DevAdminToken:     testAdminToken,
		DevModeratorToken: testModToken,
	})
	srv := httpapi.NewServer(store, fakeEngine{}, fakeSigner{}, authSvc, nil, httpapi.Config{
		DemoExpensesCSVPath: csvPath,
	})
	return srv, store
}

func doReq(t *testing.T, handler http.Handler, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestHealthMetricsAndCORS(t *testing.T) {
	srv, _ := setupTestServer(t)
	h := srv.Handler()

	req := httptest.NewRequest(http.MethodOptions, "/public/datasets", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 preflight, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("missing allow origin header: %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}

	healthRec := doReq(t, h, http.MethodGet, "/health", nil, "")
	if healthRec.Code != http.StatusOK {
		t.Fatalf("expected 200 health, got %d", healthRec.Code)
	}

	metricsRec := doReq(t, h, http.MethodGet, "/metrics", nil, "")
	if metricsRec.Code != http.StatusOK || !strings.Contains(metricsRec.Body.String(), "civictech_http_requests_total") {
		t.Fatalf("unexpected metrics response: %d %s", metricsRec.Code, metricsRec.Body.String())
	}
}

func TestPublicEndpointsAndFilters(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	// Seed expenses via idempotent ingest first.
	ingestRec := doReq(t, h, http.MethodPost, "/admin/ingest/demo", nil, testAdminToken)
	if ingestRec.Code != http.StatusOK {
		t.Fatalf("ingest failed: %d %s", ingestRec.Code, ingestRec.Body.String())
	}

	// Datasets
	dsRec := doReq(t, h, http.MethodGet, "/public/datasets?municipality_id=lima", nil, "")
	if dsRec.Code != http.StatusOK {
		t.Fatalf("datasets status: %d", dsRec.Code)
	}
	var datasets []domain.Dataset
	_ = json.Unmarshal(dsRec.Body.Bytes(), &datasets)
	if len(datasets) != 1 {
		t.Fatalf("expected 1 dataset, got %d", len(datasets))
	}

	// Expenses filter by category and date range
	expRec := doReq(t, h, http.MethodGet, "/public/expenses?municipality_id=lima&entity=Municipio+Demo&category=OBRAS&from=2026-02-01&to=2026-02-01", nil, "")
	if expRec.Code != http.StatusOK {
		t.Fatalf("expenses status: %d", expRec.Code)
	}
	var expenses []domain.Expense
	_ = json.Unmarshal(expRec.Body.Bytes(), &expenses)
	if len(expenses) != 1 || expenses[0].AmountCents != 125075 || expenses[0].Amount != "1250.75" {
		t.Fatalf("unexpected filtered expenses: %#v", expenses)
	}

	// Invalid date query returns 400
	badDateRec := doReq(t, h, http.MethodGet, "/public/expenses?from=not-a-date", nil, "")
	if badDateRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad date, got %d", badDateRec.Code)
	}

	// Unknown published report returns 404
	notFoundRec := doReq(t, h, http.MethodGet, "/public/reports/"+uuid.NewString(), nil, "")
	if notFoundRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", notFoundRec.Code)
	}

	if len(store.auditEvents) != 1 {
		t.Fatalf("expected 1 audit event from ingest, got %d", len(store.auditEvents))
	}
}

func TestCitizenAndModerationLifecycleWithAuditTrail(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	// 1. Create report
	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "OBRAS",
		"description": "Irregularidad en obra vial",
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create report failed: %d %s", createRec.Code, createRec.Body.String())
	}
	var created domain.Report
	_ = json.Unmarshal(createRec.Body.Bytes(), &created)
	if created.Status != "DRAFT" || created.MunicipalityID != "lima" {
		t.Fatalf("unexpected created report: %#v", created)
	}

	// 2. Evidence MIME & size validation
	badMime := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/x-msdownload",
		"size_bytes":   1024,
	}, "")
	if badMime.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid mime, got %d", badMime.Code)
	}

	tooLarge := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/pdf",
		"size_bytes":   10*1024*1024 + 1,
	}, "")
	if tooLarge.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized file, got %d", tooLarge.Code)
	}

	// Valid evidence
	goodEv := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/pdf",
		"size_bytes":   2048,
		"sha256":       strings.Repeat("ab", 32),
	}, "")
	if goodEv.Code != http.StatusOK {
		t.Fatalf("valid evidence failed: %d %s", goodEv.Code, goodEv.Body.String())
	}

	// 3. Submit report
	submitRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, "")
	if submitRec.Code != http.StatusOK {
		t.Fatalf("submit failed: %d %s", submitRec.Code, submitRec.Body.String())
	}

	// 4. Moderation queue
	queueRec := doReq(t, h, http.MethodGet, "/moderation/cases?municipality_id=lima&status=SUBMITTED", nil, testModToken)
	if queueRec.Code != http.StatusOK {
		t.Fatalf("queue failed: %d %s", queueRec.Code, queueRec.Body.String())
	}
	var cases []domain.ModerationCase
	_ = json.Unmarshal(queueRec.Body.Bytes(), &cases)
	if len(cases) != 1 || cases[0].ReportID != created.ID {
		t.Fatalf("unexpected moderation queue: %#v", cases)
	}

	// 5. Missing reason rejected on triage
	noReason := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/triage", map[string]string{
		"reason": "   ",
	}, testModToken)
	if noReason.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty reason, got %d", noReason.Code)
	}

	// 6. Triage -> Verify -> Publish
	triageRec := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/triage", map[string]string{
		"reason": "Initial review completed",
	}, testModToken)
	if triageRec.Code != http.StatusOK {
		t.Fatalf("triage failed: %d %s", triageRec.Code, triageRec.Body.String())
	}

	verifyRec := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/verify", map[string]string{
		"reason": "Evidence verified",
	}, testModToken)
	if verifyRec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d %s", verifyRec.Code, verifyRec.Body.String())
	}

	publishRec := doReq(t, h, http.MethodPost, "/moderation/reports/"+created.ID.String()+"/publish", map[string]string{
		"public_text": "Redacted public summary",
		"reason":      "Approved for publication",
	}, testModToken)
	if publishRec.Code != http.StatusOK {
		t.Fatalf("publish failed: %d %s", publishRec.Code, publishRec.Body.String())
	}

	// 7. Public reports list & detail
	feedRec := doReq(t, h, http.MethodGet, "/public/reports?municipality_id=lima", nil, "")
	if feedRec.Code != http.StatusOK {
		t.Fatalf("public reports failed: %d", feedRec.Code)
	}
	var summaries []domain.PublicReportSummary
	_ = json.Unmarshal(feedRec.Body.Bytes(), &summaries)
	if len(summaries) != 1 || summaries[0].PublicText != "Redacted public summary" {
		t.Fatalf("unexpected public summaries: %#v", summaries)
	}

	detailRec := doReq(t, h, http.MethodGet, "/public/reports/"+created.ID.String(), nil, "")
	if detailRec.Code != http.StatusOK {
		t.Fatalf("public report detail failed: %d %s", detailRec.Code, detailRec.Body.String())
	}
	var detail domain.PublicReportDetail
	_ = json.Unmarshal(detailRec.Body.Bytes(), &detail)
	if detail.ReportID != created.ID || detail.EvidenceCount != 1 {
		t.Fatalf("unexpected public detail: %#v", detail)
	}

	// 8. Verify audit trail recorded every mutation (create, evidence, submit, triage, verify, publish = 6 events)
	if len(store.auditEvents) != 6 {
		t.Fatalf("expected 6 audit events, got %d: %#v", len(store.auditEvents), store.auditEvents)
	}
	expectedActions := []string{"report_create", "evidence_attach", "report_transition", "report_transition", "report_transition", "report_publish"}
	for i, want := range expectedActions {
		if store.auditEvents[i].Action != want {
			t.Fatalf("audit[%d]: expected action %s, got %s", i, want, store.auditEvents[i].Action)
		}
		if store.auditEvents[i].TargetID == nil || *store.auditEvents[i].TargetID == "" {
			t.Fatalf("audit[%d]: missing target_id", i)
		}
	}
}

func TestRejectAndInvalidSkippedTransitions(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "SERVICIOS",
		"description": "Reporte para rechazo",
	}, "")
	var created domain.Report
	_ = json.Unmarshal(createRec.Body.Bytes(), &created)

	// Cannot publish directly from DRAFT
	skipDraftPub := doReq(t, h, http.MethodPost, "/moderation/reports/"+created.ID.String()+"/publish", map[string]string{
		"public_text": "Should fail",
		"reason":      "Skipping states",
	}, testModToken)
	if skipDraftPub.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on skipped DRAFT->PUBLISH, got %d", skipDraftPub.Code)
	}

	// Submit then try verify without triage -> 422
	_ = doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, "")
	auditBefore := len(store.auditEvents)
	skipVerify := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/verify", map[string]string{
		"reason": "Skip triage",
	}, testModToken)
	if skipVerify.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on skipped SUBMITTED->VERIFY, got %d", skipVerify.Code)
	}
	if len(store.auditEvents) != auditBefore {
		t.Fatalf("rejected invalid transition must not mutate audit events")
	}

	// Reject from SUBMITTED -> 200 REJECTED
	rejectRec := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/reject", map[string]string{
		"reason": "Insufficient details",
	}, testModToken)
	if rejectRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on reject, got %d %s", rejectRec.Code, rejectRec.Body.String())
	}
	var rejected domain.Report
	_ = json.Unmarshal(rejectRec.Body.Bytes(), &rejected)
	if rejected.Status != "REJECTED" {
		t.Fatalf("expected REJECTED, got %s", rejected.Status)
	}
}

func TestRBACEnforcement(t *testing.T) {
	srv, _ := setupTestServer(t)
	h := srv.Handler()
	id := uuid.NewString()

	protectedRoutes := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/moderation/cases", nil},
		{http.MethodPost, "/moderation/cases/" + id + "/triage", map[string]string{"reason": "r"}},
		{http.MethodPost, "/moderation/cases/" + id + "/verify", map[string]string{"reason": "r"}},
		{http.MethodPost, "/moderation/cases/" + id + "/reject", map[string]string{"reason": "r"}},
		{http.MethodPost, "/moderation/reports/" + id + "/publish", map[string]string{"public_text": "p", "reason": "r"}},
		{http.MethodPost, "/admin/ingest/demo", nil},
	}

	for _, rt := range protectedRoutes {
		rec := doReq(t, h, rt.method, rt.path, rt.body, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without token: expected 401, got %d", rt.method, rt.path, rec.Code)
		}
	}

	// Moderator cannot call admin ingest -> 403
	forbRec := doReq(t, h, http.MethodPost, "/admin/ingest/demo", nil, testModToken)
	if forbRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for moderator on /admin/ingest/demo, got %d", forbRec.Code)
	}
}

func TestIdempotentDemoIngest(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	rec1 := doReq(t, h, http.MethodPost, "/admin/ingest/demo", nil, testAdminToken)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first ingest failed: %d %s", rec1.Code, rec1.Body.String())
	}
	var res1 domain.IngestResult
	_ = json.Unmarshal(rec1.Body.Bytes(), &res1)
	if res1.Deduplicated || res1.RowsIngested != 3 {
		t.Fatalf("expected 3 ingested rows on first run, got %#v", res1)
	}

	rec2 := doReq(t, h, http.MethodPost, "/admin/ingest/demo", nil, testAdminToken)
	if rec2.Code != http.StatusOK {
		t.Fatalf("second ingest failed: %d %s", rec2.Code, rec2.Body.String())
	}
	var res2 domain.IngestResult
	_ = json.Unmarshal(rec2.Body.Bytes(), &res2)
	if !res2.Deduplicated || res2.RowsIngested != 0 || res2.DatasetVersionID != res1.DatasetVersionID {
		t.Fatalf("expected deduplicated second run with same version id, got %#v", res2)
	}

	if len(store.expenses) != 3 {
		t.Fatalf("expected 3 total expense rows (no duplicates), got %d", len(store.expenses))
	}
}
