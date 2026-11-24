package domain_test

import (
	"testing"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

func TestFormatCents(t *testing.T) {
	cases := []struct {
		cents int64
		want  string
	}{
		{0, "0.00"},
		{5, "0.05"},
		{125075, "1250.75"},
		{210000, "2100.00"},
		{-5, "-0.05"},
	}
	for _, tc := range cases {
		if got := domain.FormatCents(tc.cents); got != tc.want {
			t.Fatalf("FormatCents(%d) = %q, want %q", tc.cents, got, tc.want)
		}
	}
}

func TestComputeAuditEventHashCollisionResistanceAndFormat(t *testing.T) {
	a := domain.AuditChainInput{
		PrevHash:     domain.GenesisHash,
		OccurredAt:   "2026-03-01T10:00:00Z",
		ActorType:    "AB",
		ActorID:      "C",
		Action:       "SUBMIT",
		TargetType:   "REPORT",
		TargetID:     "1",
		MetadataJSON: "{}",
	}
	b := domain.AuditChainInput{
		PrevHash:     domain.GenesisHash,
		OccurredAt:   "2026-03-01T10:00:00Z",
		ActorType:    "A",
		ActorID:      "BC",
		Action:       "SUBMIT",
		TargetType:   "REPORT",
		TargetID:     "1",
		MetadataJSON: "{}",
	}
	ha := domain.ComputeAuditEventHash(a)
	hb := domain.ComputeAuditEventHash(b)
	const wantVector = "23a16bcb3f5b20fc75465ea1534f8947cc8e58e4e904ba33fbdeb76691d1101f"
	if ha != wantVector {
		t.Fatalf("ComputeAuditEventHash vector mismatch: got %q, want %q", ha, wantVector)
	}
	if len(ha) != 64 {
		t.Fatalf("expected 64-char hex hash, got %d (%q)", len(ha), ha)
	}
	if ha == hb {
		t.Fatalf("length-prefixed hash must distinguish field boundaries: %s", ha)
	}
	if ha != domain.ComputeAuditEventHash(a) {
		t.Fatalf("hash must be deterministic")
	}
}

func TestCanonicalJSONMatchesAcrossPgJsonbFormatting(t *testing.T) {
	compact, err := domain.CanonicalJSON([]byte(`{"municipality_id":"lima","count":2,"nested":{"z":"1","aa":"2"}}`))
	if err != nil {
		t.Fatalf("canonicalize compact: %v", err)
	}
	pgFormatted, err := domain.CanonicalJSON([]byte(`{"count": 2, "nested": {"z": "1", "aa": "2"}, "municipality_id": "lima"}`))
	if err != nil {
		t.Fatalf("canonicalize pgFormatted: %v", err)
	}
	if compact != pgFormatted {
		t.Fatalf("canonical json mismatch:\n  compact: %s\n  pg:      %s", compact, pgFormatted)
	}
	empty, err := domain.CanonicalJSON(nil)
	if err != nil || empty != "{}" {
		t.Fatalf("expected {}, got %q (err=%v)", empty, err)
	}
}
