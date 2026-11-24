package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const DefaultMunicipalityID = "lima"

var (
	ErrNotFound          = errors.New("resource not found")
	ErrValidation        = errors.New("validation failed")
	ErrInvalidTransition = errors.New("invalid report state transition")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrForbidden         = errors.New("forbidden")
	ErrConflict          = errors.New("conflict")
)

type Role string

const (
	RoleModerator Role = "MODERATOR"
	RoleAdmin     Role = "ADMIN"
)

type Principal struct {
	Subject string
	Roles   map[Role]bool
}

func (p Principal) HasAnyRole(allowed ...Role) bool {
	for _, r := range allowed {
		if p.Roles[r] {
			return true
		}
	}
	return false
}

type Actor struct {
	Type string
	ID   string
}

type Dataset struct {
	ID             uuid.UUID `json:"id"`
	MunicipalityID string    `json:"municipality_id"`
	Name           string    `json:"name"`
	Kind           string    `json:"kind"`
	Versions       int64     `json:"versions"`
	CreatedAt      time.Time `json:"created_at"`
}

type Expense struct {
	ID             uuid.UUID `json:"id"`
	MunicipalityID string    `json:"municipality_id"`
	VersionID      uuid.UUID `json:"version_id"`
	Entity         string    `json:"entity"`
	Category       string    `json:"category"`
	AmountCents    int64     `json:"amount_cents"`
	Amount         string    `json:"amount"`
	OccurredOn     *string   `json:"occurred_on"`
	DocRef         *string   `json:"doc_ref"`
}

type ExpenseFilter struct {
	MunicipalityID string
	Entity         string
	Category       string
	From           string
	To             string
}

type Report struct {
	ID             uuid.UUID `json:"id"`
	MunicipalityID string    `json:"municipality_id"`
	Status         string    `json:"status"`
	Category       string    `json:"category"`
	Description    string    `json:"description"`
	CreatedAt      time.Time `json:"created_at"`
}

type Evidence struct {
	ID             uuid.UUID `json:"id"`
	ReportID       uuid.UUID `json:"report_id"`
	MunicipalityID string    `json:"municipality_id"`
	StorageRef     string    `json:"storage_ref"`
	SHA256         string    `json:"sha256"`
	UploadedAt     time.Time `json:"uploaded_at"`
}

type Publication struct {
	ID             uuid.UUID `json:"id"`
	ReportID       uuid.UUID `json:"report_id"`
	MunicipalityID string    `json:"municipality_id"`
	PublicText     string    `json:"public_text"`
	PublishedAt    time.Time `json:"published_at"`
}

type PublicReportSummary struct {
	ID             uuid.UUID `json:"id"`
	ReportID       uuid.UUID `json:"report_id"`
	MunicipalityID string    `json:"municipality_id"`
	Status         string    `json:"status"`
	Category       string    `json:"category"`
	PublicText     string    `json:"public_text"`
	PublishedAt    time.Time `json:"published_at"`
}

type PublicReportDetail struct {
	ID             uuid.UUID `json:"id"`
	ReportID       uuid.UUID `json:"report_id"`
	MunicipalityID string    `json:"municipality_id"`
	Status         string    `json:"status"`
	Category       string    `json:"category"`
	PublicText     string    `json:"public_text"`
	PublishedAt    time.Time `json:"published_at"`
	EvidenceCount  int       `json:"evidence_count"`
}

type ModerationCase struct {
	ID             uuid.UUID `json:"id"`
	ReportID       uuid.UUID `json:"report_id"`
	MunicipalityID string    `json:"municipality_id"`
	Status         string    `json:"status"`
	Category       string    `json:"category"`
	Description    string    `json:"description"`
	AssignedTo     *string   `json:"assigned_to"`
	Notes          *string   `json:"notes"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type AuditEvent struct {
	ID         uuid.UUID      `json:"id"`
	OccurredAt time.Time      `json:"occurred_at"`
	ActorType  string         `json:"actor_type"`
	ActorID    *string        `json:"actor_id"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   *string        `json:"target_id"`
	Metadata   map[string]any `json:"metadata"`
}

type TransitionResult struct {
	FromStatus string `json:"from_status"`
	ToStatus   string `json:"to_status"`
	Action     string `json:"action"`
}

type IngestRow struct {
	Entity      string  `json:"entity"`
	Category    string  `json:"category"`
	AmountCents int64   `json:"amount_cents"`
	OccurredOn  *string `json:"occurred_on"`
	DocRef      *string `json:"doc_ref"`
}

type ParsedExpenses struct {
	ChecksumSHA256 string      `json:"checksum_sha256"`
	RowCount       int         `json:"row_count"`
	Rows           []IngestRow `json:"rows"`
}

type IngestResult struct {
	MunicipalityID   string    `json:"municipality_id"`
	DatasetVersionID uuid.UUID `json:"dataset_version_id"`
	ChecksumSHA256   string    `json:"checksum_sha256"`
	RowsIngested     int       `json:"rows_ingested"`
	Deduplicated     bool      `json:"deduplicated"`
}

type PresignedUpload struct {
	ObjectKey        string            `json:"object_key"`
	UploadURL        string            `json:"upload_url"`
	ExpiresInSeconds int64             `json:"expires_in_seconds"`
	UploadHeaders    map[string]string `json:"upload_headers"`
}

// FormatCents formats integer cents into an exact decimal string without float arithmetic.
func FormatCents(cents int64) string {
	sign := ""
	abs := cents
	if cents < 0 {
		sign = "-"
		abs = -cents
	}
	whole := abs / 100
	frac := abs % 100
	return fmt.Sprintf("%s%d.%02d", sign, whole, frac)
}

// NormalizeMunicipality returns the trimmed municipality ID or DefaultMunicipalityID if empty.
func NormalizeMunicipality(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DefaultMunicipalityID
	}
	return trimmed
}
