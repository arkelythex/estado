package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
