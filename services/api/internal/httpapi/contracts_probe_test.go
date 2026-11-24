package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

func TestPublicReportDetailDoesNotExposeEvidenceMetadata(t *testing.T) {
	srv, _ := setupTestServer(t)
	h := srv.Handler()

	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "OBRAS",
		"description": "Detalle con evidencia sensible",
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create report failed: %d %s", createRec.Code, createRec.Body.String())
	}
	var created domain.Report
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal created report: %v", err)
	}

	evRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/pdf",
		"size_bytes":   2048,
		"sha256":       strings.Repeat("ab", 32),
	}, "")
	if evRec.Code != http.StatusOK {
		t.Fatalf("add evidence failed: %d %s", evRec.Code, evRec.Body.String())
	}
	var evPayload map[string]any
	if err := json.Unmarshal(evRec.Body.Bytes(), &evPayload); err != nil {
		t.Fatalf("unmarshal add evidence payload: %v", err)
	}
	headersRaw, ok := evPayload["upload_headers"].(map[string]any)
	if !ok {
		t.Fatalf("add evidence response must include upload_headers map: %s", evRec.Body.String())
	}
	if headersRaw["Content-Type"] != "application/pdf" || headersRaw["x-amz-server-side-encryption"] != "AES256" {
		t.Fatalf("unexpected upload_headers: %#v", headersRaw)
	}

	if rec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("submit failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/triage", map[string]string{"reason": "triage"}, testModToken); rec.Code != http.StatusOK {
		t.Fatalf("triage failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/verify", map[string]string{"reason": "verify"}, testModToken); rec.Code != http.StatusOK {
		t.Fatalf("verify failed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, "/moderation/reports/"+created.ID.String()+"/publish", map[string]string{
		"public_text": "Resumen público redactado",
		"reason":      "publicar",
	}, testModToken); rec.Code != http.StatusOK {
		t.Fatalf("publish failed: %d %s", rec.Code, rec.Body.String())
	}

	detailRec := doReq(t, h, http.MethodGet, "/public/reports/"+created.ID.String(), nil, "")
	if detailRec.Code != http.StatusOK {
		t.Fatalf("get public report failed: %d %s", detailRec.Code, detailRec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(detailRec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal public report payload: %v", err)
	}

	if _, hasRawEvidence := payload["evidence"]; hasRawEvidence {
		t.Fatalf("public report detail MUST NOT expose raw evidence key: %s", detailRec.Body.String())
	}
	rawBody := detailRec.Body.String()
	for _, forbidden := range []string{"storage_ref", "sha256", "uploaded_at"} {
		if strings.Contains(rawBody, forbidden) {
			t.Fatalf("public report detail MUST NOT contain %q: %s", forbidden, rawBody)
		}
	}

	countVal, hasCount := payload["evidence_count"]
	if !hasCount {
		t.Fatalf("public report detail MUST include evidence_count: %s", rawBody)
	}
	if countNum, ok := countVal.(float64); !ok || int(countNum) != 1 {
		t.Fatalf("expected evidence_count=1, got %v", countVal)
	}
}

func TestAddEvidenceRejectedAfterSubmission(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "SERVICIOS",
		"description": "Reporte para validar inmutabilidad tras envío",
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create report failed: %d %s", createRec.Code, createRec.Body.String())
	}
	var created domain.Report
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal created report: %v", err)
	}

	submitRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, "")
	if submitRec.Code != http.StatusOK {
		t.Fatalf("submit failed: %d %s", submitRec.Code, submitRec.Body.String())
	}

	auditCountBefore := len(store.auditEvents)
	evidenceCountBefore := len(store.evidence[created.ID])

	lateEvRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/pdf",
		"size_bytes":   1024,
		"sha256":       strings.Repeat("cd", 32),
	}, "")
	if lateEvRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 when adding evidence after submission, got %d: %s", lateEvRec.Code, lateEvRec.Body.String())
	}
	if len(store.evidence[created.ID]) != evidenceCountBefore {
		t.Fatalf("rejected evidence must not be stored")
	}
	if len(store.auditEvents) != auditCountBefore {
		t.Fatalf("rejected evidence must not append audit events")
	}
}

func TestMalformedOptionalJSONRejectedWith400(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "OBRAS",
		"description": "Prueba de JSON opcional malformado",
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create report failed: %d %s", createRec.Code, createRec.Body.String())
	}
	var created domain.Report
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal created report: %v", err)
	}

	// Malformed JSON on POST /reports/{id}/submit -> 400 and status unchanged.
	badSubmitReq := httptest.NewRequest(http.MethodPost, "/reports/"+created.ID.String()+"/submit", bytes.NewBufferString("{malformed"))
	badSubmitReq.Header.Set("Content-Type", "application/json")
	badSubmitRec := httptest.NewRecorder()
	h.ServeHTTP(badSubmitRec, badSubmitReq)
	if badSubmitRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed submit JSON, got %d: %s", badSubmitRec.Code, badSubmitRec.Body.String())
	}
	if !strings.Contains(badSubmitRec.Body.String(), "invalid json payload") {
		t.Fatalf("expected 'invalid json payload' error, got %s", badSubmitRec.Body.String())
	}
	if stored := store.reports[created.ID]; stored.Status != "DRAFT" {
		t.Fatalf("malformed submit must leave status as DRAFT, got %s", stored.Status)
	}

	// Empty body on POST /reports/{id}/submit -> 200 (defaults).
	emptySubmitReq := httptest.NewRequest(http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil)
	emptySubmitRec := httptest.NewRecorder()
	h.ServeHTTP(emptySubmitRec, emptySubmitReq)
	if emptySubmitRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for empty submit body, got %d: %s", emptySubmitRec.Code, emptySubmitRec.Body.String())
	}

	// Malformed JSON on POST /admin/ingest/demo -> 400 and no expenses ingested.
	badIngestReq := httptest.NewRequest(http.MethodPost, "/admin/ingest/demo", bytes.NewBufferString("{not-json"))
	badIngestReq.Header.Set("Content-Type", "application/json")
	badIngestReq.Header.Set("Authorization", "Bearer "+testAdminToken)
	badIngestRec := httptest.NewRecorder()
	h.ServeHTTP(badIngestRec, badIngestReq)
	if badIngestRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed ingest JSON, got %d: %s", badIngestRec.Code, badIngestRec.Body.String())
	}
	if !strings.Contains(badIngestRec.Body.String(), "invalid json payload") {
		t.Fatalf("expected 'invalid json payload' error, got %s", badIngestRec.Body.String())
	}
	if len(store.expenses) != 0 {
		t.Fatalf("malformed ingest must not insert expenses, got %d", len(store.expenses))
	}

	// Empty body on POST /admin/ingest/demo -> 200 (defaults).
	emptyIngestReq := httptest.NewRequest(http.MethodPost, "/admin/ingest/demo", bytes.NewBufferString("   "))
	emptyIngestReq.Header.Set("Authorization", "Bearer "+testAdminToken)
	emptyIngestRec := httptest.NewRecorder()
	h.ServeHTTP(emptyIngestRec, emptyIngestReq)
	if emptyIngestRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for whitespace-only ingest body, got %d: %s", emptyIngestRec.Code, emptyIngestRec.Body.String())
	}
}
