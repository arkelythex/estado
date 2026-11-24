package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultMunicipalityID = "lima"
	GenesisHash           = "0000000000000000000000000000000000000000000000000000000000000000"
)

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
	ReceiptHash    string    `json:"-"`
	ReceiptCode    string    `json:"receipt_code,omitempty"`
}

type ReportTrackingEvent struct {
	FromStatus string    `json:"from_status"`
	ToStatus   string    `json:"to_status"`
	Action     string    `json:"action"`
	OccurredAt time.Time `json:"occurred_at"`
}

type ReportTracking struct {
	MunicipalityID string                `json:"municipality_id"`
	Status         string                `json:"status"`
	Category       string                `json:"category"`
	CreatedAt      time.Time             `json:"created_at"`
	Timeline       []ReportTrackingEvent `json:"timeline"`
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

type AuditChainInput struct {
	PrevHash     string `json:"prev_hash"`
	OccurredAt   string `json:"occurred_at"`
	ActorType    string `json:"actor_type"`
	ActorID      string `json:"actor_id"`
	Action       string `json:"action"`
	TargetType   string `json:"target_type"`
	TargetID     string `json:"target_id"`
	MetadataJSON string `json:"metadata_json"`
}

type AuditChainEntry struct {
	SeqNo        int64  `json:"seq_no"`
	PrevHash     string `json:"prev_hash"`
	EventHash    string `json:"event_hash"`
	OccurredAt   string `json:"occurred_at"`
	ActorType    string `json:"actor_type"`
	ActorID      string `json:"actor_id"`
	Action       string `json:"action"`
	TargetType   string `json:"target_type"`
	TargetID     string `json:"target_id"`
	MetadataJSON string `json:"metadata_json"`
}

type ChainVerification struct {
	Valid         bool    `json:"valid"`
	CheckedEvents int     `json:"checked_events"`
	HeadHash      string  `json:"head_hash"`
	BrokenAtSeq   *int64  `json:"broken_at_seq"`
	Reason        *string `json:"reason"`
}

type ExpenseAnalyticsInput struct {
	ID          string  `json:"id"`
	Entity      string  `json:"entity"`
	Category    string  `json:"category"`
	AmountCents int64   `json:"amount_cents"`
	OccurredOn  *string `json:"occurred_on,omitempty"`
	DocRef      *string `json:"doc_ref,omitempty"`
}

type FiscalRedFlag struct {
	RuleCode     string   `json:"rule_code"`
	Severity     string   `json:"severity"`
	Entity       string   `json:"entity"`
	Category     *string  `json:"category"`
	TotalCents   int64    `json:"total_cents"`
	ExpenseCount int      `json:"expense_count"`
	AffectedIDs  []string `json:"affected_ids"`
	ShareBPS     *int64   `json:"share_bps"`
	Summary      string   `json:"summary"`
}

type AnalyzeExpensesResponse struct {
	TotalExpenses    int             `json:"total_expenses"`
	TotalAmountCents int64           `json:"total_amount_cents"`
	ThresholdCents   int64           `json:"threshold_cents"`
	FlagCount        int             `json:"flag_count"`
	Flags            []FiscalRedFlag `json:"flags"`
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

func updateLenPrefixed(h hash.Hash, value string) {
	var lenBuf [8]byte
	binary.BigEndian.PutUint64(lenBuf[:], uint64(len(value)))
	_, _ = h.Write(lenBuf[:])
	_, _ = h.Write([]byte(value))
}

// ComputeAuditEventHash computes the canonical length-prefixed SHA-256 hash matching crates/audit.
func ComputeAuditEventHash(input AuditChainInput) string {
	h := sha256.New()
	_, _ = h.Write([]byte("civictech-audit-v1"))
	updateLenPrefixed(h, input.PrevHash)
	updateLenPrefixed(h, input.OccurredAt)
	updateLenPrefixed(h, input.ActorType)
	updateLenPrefixed(h, input.ActorID)
	updateLenPrefixed(h, input.Action)
	updateLenPrefixed(h, input.TargetType)
	updateLenPrefixed(h, input.TargetID)
	updateLenPrefixed(h, input.MetadataJSON)
	return hex.EncodeToString(h.Sum(nil))
}

// CanonicalJSON normalizes JSON into compact sorted-key representation while preserving exact numbers.
func CanonicalJSON(raw []byte) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "{}", nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", fmt.Errorf("decode canonical json: %w", err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("encode canonical json: %w", err)
	}
	return string(out), nil
}
