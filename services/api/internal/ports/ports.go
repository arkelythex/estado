package ports

import (
	"context"

	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/google/uuid"
)

type Store interface {
	ListDatasets(ctx context.Context, municipalityID string) ([]domain.Dataset, error)
	ListExpenses(ctx context.Context, filter domain.ExpenseFilter) ([]domain.Expense, error)
	ListPublishedReports(ctx context.Context, municipalityID string) ([]domain.PublicReportSummary, error)
	GetPublishedReport(ctx context.Context, municipalityID string, id uuid.UUID) (*domain.PublicReportDetail, error)
	GetReport(ctx context.Context, municipalityID string, id uuid.UUID) (*domain.Report, error)
	CreateReport(ctx context.Context, report domain.Report, actor domain.Actor) (domain.Report, error)
	AddEvidence(ctx context.Context, evidence domain.Evidence, actor domain.Actor) (domain.Evidence, error)
	TransitionReport(ctx context.Context, id uuid.UUID, municipalityID, fromStatus, toStatus, action, actorID, reason string) (domain.Report, error)
	PublishReport(ctx context.Context, id uuid.UUID, municipalityID, fromStatus, publicText, actorID, reason string) (domain.Publication, error)
	ListModerationCases(ctx context.Context, municipalityID string, statusFilter string) ([]domain.ModerationCase, error)
	IngestExpensesIdempotent(ctx context.Context, municipalityID, sourceKind, checksum string, rows []domain.IngestRow, actorID string) (domain.IngestResult, error)
}

type EngineClient interface {
	TransitionReport(ctx context.Context, currentStatus, action string) (domain.TransitionResult, error)
	ParseExpenses(ctx context.Context, csvContent string) (domain.ParsedExpenses, error)
}

type StorageSigner interface {
	PresignPut(ctx context.Context, reportID uuid.UUID, contentType string, sizeBytes int64) (domain.PresignedUpload, error)
	StorageRef(objectKey string) string
}

type Authenticator interface {
	Authenticate(ctx context.Context, authHeader string) (domain.Principal, error)
	RequireRoles(principal domain.Principal, allowed ...domain.Role) error
}
