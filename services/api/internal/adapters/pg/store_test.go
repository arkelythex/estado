package pg

import (
	"testing"
	"time"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

func TestBuildAuditRecordMatchesJsonbRoundTrip(t *testing.T) {
	// Include sub-microsecond nanoseconds to verify truncation matches Postgres timestamptz precision.
	ts := time.Date(2026, 3, 1, 12, 34, 56, 789123456, time.FixedZone("PET", -5*3600))
	occurredAt, actorID, targetID, metaJSON, eventHash, err := buildAuditRecord(
		domain.GenesisHash,
		ts,
		domain.Actor{Type: "citizen", ID: "  anonymous  "},
		"report_create",
		"report",
		"  rep-123 ",
		map[string]any{
			"municipality_id": "lima",
			"status":          "DRAFT",
			"count":           2,
		},
	)
	if err != nil {
		t.Fatalf("buildAuditRecord error: %v", err)
	}
	if actorID != "anonymous" || targetID != "rep-123" {
		t.Fatalf("expected trimmed IDs, got actor=%q target=%q", actorID, targetID)
	}
	if occurredAt.Nanosecond()%1000 != 0 {
		t.Fatalf("expected microsecond-aligned timestamp, got %d ns", occurredAt.Nanosecond())
	}

	// Simulate Postgres jsonb::text reordering keys by length & adding whitespace.
	pgJsonbText := `{"count": 2, "status": "DRAFT", "municipality_id": "lima"}`
	recanonicalMeta, err := domain.CanonicalJSON([]byte(pgJsonbText))
	if err != nil {
		t.Fatalf("canonicalize simulated jsonb: %v", err)
	}
	if recanonicalMeta != metaJSON {
		t.Fatalf("metadata canonical mismatch: %s vs %s", recanonicalMeta, metaJSON)
	}

	recomputed := domain.ComputeAuditEventHash(domain.AuditChainInput{
		PrevHash:     domain.GenesisHash,
		OccurredAt:   formatAuditTimestamp(occurredAt),
		ActorType:    "citizen",
		ActorID:      actorID,
		Action:       "report_create",
		TargetType:   "report",
		TargetID:     targetID,
		MetadataJSON: recanonicalMeta,
	})
	if recomputed != eventHash {
		t.Fatalf("hash mismatch after simulated pg round-trip: got %s, want %s", recomputed, eventHash)
	}
}
