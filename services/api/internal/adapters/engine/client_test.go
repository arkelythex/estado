package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/arkelythex/estado/services/api/internal/adapters/engine"
	"github.com/arkelythex/estado/services/api/internal/domain"
)

func TestTransitionReportSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/v1/reports/transition" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var req map[string]string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode req: %v", err)
		}
		if req["current_status"] != "DRAFT" || req["action"] != "SUBMIT" {
			t.Fatalf("unexpected payload: %#v", req)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"from_status": "DRAFT",
			"to_status":   "SUBMITTED",
			"action":      "SUBMIT",
		})
	}))
	defer srv.Close()

	client := engine.NewClient(srv.URL, srv.Client())
	res, err := client.TransitionReport(context.Background(), "DRAFT", "SUBMIT")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.FromStatus != "DRAFT" || res.ToStatus != "SUBMITTED" || res.Action != "SUBMIT" {
		t.Fatalf("unexpected result: %#v", res)
	}
}

func TestTransitionReportErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantErr    error
	}{
		{name: "422 invalid transition", statusCode: http.StatusUnprocessableEntity, wantErr: domain.ErrInvalidTransition},
		{name: "400 validation", statusCode: http.StatusBadRequest, wantErr: domain.ErrValidation},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.statusCode)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad transition"})
			}))
			defer srv.Close()

			client := engine.NewClient(srv.URL, srv.Client())
			_, err := client.TransitionReport(context.Background(), "DRAFT", "PUBLISH")
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("expected %v, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestParseExpensesSuccessAndError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/ingest/parse-expenses" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req map[string]string
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["csv"] == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "empty csv"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"checksum_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"row_count":       1,
			"rows": []map[string]any{
				{
					"entity":       "Municipio Demo",
					"category":     "OBRAS",
					"amount_cents": 125075,
					"occurred_on":  "2026-02-01",
					"doc_ref":      "DOC-001",
				},
			},
		})
	}))
	defer srv.Close()

	client := engine.NewClient(srv.URL, srv.Client())
	parsed, err := client.ParseExpenses(context.Background(), "entity,category,amount\nMunicipio Demo,OBRAS,1250.75\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsed.RowCount != 1 || len(parsed.Rows) != 1 || parsed.Rows[0].AmountCents != 125075 {
		t.Fatalf("unexpected parsed result: %#v", parsed)
	}

	_, err = client.ParseExpenses(context.Background(), "")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
}

func TestComputeAuditHashAndVerifyChain(t *testing.T) {
	wantHash := strings.Repeat("c", 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/v1/audit/hash":
			var req domain.AuditChainInput
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode hash req: %v", err)
			}
			if req.PrevHash != domain.GenesisHash || req.Action != "SUBMIT_REPORT" {
				t.Fatalf("unexpected hash req: %#v", req)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"event_hash": wantHash})
		case "/internal/v1/audit/verify-chain":
			var req struct {
				Entries []domain.AuditChainEntry `json:"entries"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode verify req: %v", err)
			}
			if len(req.Entries) != 1 || req.Entries[0].EventHash != wantHash {
				t.Fatalf("unexpected verify entries: %#v", req.Entries)
			}
			_ = json.NewEncoder(w).Encode(domain.ChainVerification{
				Valid:         true,
				CheckedEvents: 1,
				HeadHash:      wantHash,
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	client := engine.NewClient(srv.URL, srv.Client())
	h, err := client.ComputeAuditHash(context.Background(), domain.AuditChainInput{
		PrevHash:     domain.GenesisHash,
		OccurredAt:   "2026-03-01T10:00:00Z",
		ActorType:    "citizen",
		ActorID:      "anonymous",
		Action:       "SUBMIT_REPORT",
		TargetType:   "report",
		TargetID:     "rep-1",
		MetadataJSON: "{}",
	})
	if err != nil {
		t.Fatalf("ComputeAuditHash error: %v", err)
	}
	if h != wantHash {
		t.Fatalf("got hash %q, want %q", h, wantHash)
	}

	ver, err := client.VerifyAuditChain(context.Background(), []domain.AuditChainEntry{
		{
			SeqNo:        1,
			PrevHash:     domain.GenesisHash,
			EventHash:    wantHash,
			OccurredAt:   "2026-03-01T10:00:00Z",
			ActorType:    "citizen",
			ActorID:      "anonymous",
			Action:       "SUBMIT_REPORT",
			TargetType:   "report",
			TargetID:     "rep-1",
			MetadataJSON: "{}",
		},
	})
	if err != nil {
		t.Fatalf("VerifyAuditChain error: %v", err)
	}
	if !ver.Valid || ver.CheckedEvents != 1 || ver.HeadHash != wantHash {
		t.Fatalf("unexpected verification result: %#v", ver)
	}
}

func TestAnalyzeExpensesSuccessAndValidationError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/analytics/red-flags" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req struct {
			ThresholdCents *int64                         `json:"threshold_cents"`
			Expenses       []domain.ExpenseAnalyticsInput `json:"expenses"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode req: %v", err)
		}
		if req.ThresholdCents != nil && *req.ThresholdCents <= 0 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid threshold_cents"})
			return
		}
		cat := "OBRAS"
		_ = json.NewEncoder(w).Encode(domain.AnalyzeExpensesResponse{
			TotalExpenses:    1,
			TotalAmountCents: 2200000,
			ThresholdCents:   4280000,
			FlagCount:        1,
			Flags: []domain.FiscalRedFlag{
				{
					RuleCode:     "CONTRACT_SPLITTING",
					Severity:     "HIGH",
					Entity:       "Muni Demo",
					Category:     &cat,
					TotalCents:   4400000,
					ExpenseCount: 2,
					AffectedIDs:  []string{"e1", "e2"},
					Summary:      "Splitting detected",
				},
			},
		})
	}))
	defer srv.Close()

	client := engine.NewClient(srv.URL, srv.Client())
	res, err := client.AnalyzeExpenses(context.Background(), nil, []domain.ExpenseAnalyticsInput{
		{ID: "e1", Entity: "Muni Demo", Category: "OBRAS", AmountCents: 2200000},
	})
	if err != nil {
		t.Fatalf("AnalyzeExpenses error: %v", err)
	}
	if res.FlagCount != 1 || len(res.Flags) != 1 || res.Flags[0].RuleCode != "CONTRACT_SPLITTING" {
		t.Fatalf("unexpected analyze result: %#v", res)
	}

	badThresh := int64(0)
	_, err = client.AnalyzeExpenses(context.Background(), &badThresh, nil)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
}
