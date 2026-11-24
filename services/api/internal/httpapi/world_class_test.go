package httpapi_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/arkelythex/estado/services/api/internal/auth"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/arkelythex/estado/services/api/internal/httpapi"
	"github.com/google/uuid"
)

func TestPublicAuditVerifyValidAndDetectsTampering(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	// Empty chain verifies at genesis
	emptyRec := doReq(t, h, http.MethodGet, "/public/audit/verify", nil, "")
	if emptyRec.Code != http.StatusOK {
		t.Fatalf("GET /public/audit/verify failed: %d %s", emptyRec.Code, emptyRec.Body.String())
	}
	var emptyRes domain.ChainVerification
	if err := json.Unmarshal(emptyRec.Body.Bytes(), &emptyRes); err != nil {
		t.Fatalf("unmarshal verify resp: %v", err)
	}
	if !emptyRes.Valid || emptyRes.CheckedEvents != 0 || emptyRes.HeadHash != domain.GenesisHash {
		t.Fatalf("unexpected empty chain verification: %#v", emptyRes)
	}

	// Create and submit a report to produce chained audit events
	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"category":    "OBRAS",
		"description": "Auditoría de cadena",
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create failed: %d", createRec.Code)
	}
	var created domain.Report
	_ = json.Unmarshal(createRec.Body.Bytes(), &created)
	_ = doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, "")

	validRec := doReq(t, h, http.MethodGet, "/public/audit/verify", nil, "")
	if validRec.Code != http.StatusOK {
		t.Fatalf("GET /public/audit/verify failed: %d %s", validRec.Code, validRec.Body.String())
	}
	var validRes domain.ChainVerification
	_ = json.Unmarshal(validRec.Body.Bytes(), &validRes)
	if !validRes.Valid || validRes.CheckedEvents != 2 || len(validRes.HeadHash) != 64 || validRes.BrokenAtSeq != nil || validRes.Reason != nil {
		t.Fatalf("unexpected valid chain verification: %#v", validRes)
	}

	// Tamper with stored audit entry -> verify must detect broken chain
	store.mu.Lock()
	store.auditChain[1].Action = "TAMPERED_ACTION"
	store.mu.Unlock()

	tamperRec := doReq(t, h, http.MethodGet, "/public/audit/verify", nil, "")
	if tamperRec.Code != http.StatusOK {
		t.Fatalf("GET /public/audit/verify after tamper failed: %d", tamperRec.Code)
	}
	var tamperRes domain.ChainVerification
	_ = json.Unmarshal(tamperRec.Body.Bytes(), &tamperRes)
	if tamperRes.Valid || tamperRes.BrokenAtSeq == nil || *tamperRes.BrokenAtSeq != 2 || tamperRes.Reason == nil {
		t.Fatalf("expected broken chain at seq 2, got %#v", tamperRes)
	}
}

func TestAnonymousWhistleblowerReceiptAndPrivacySafeTracking(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	secretDesc := "Nombre testigo Juan Perez DNI 12345678 tel 999888777"
	createRec := doReq(t, h, http.MethodPost, "/reports", map[string]string{
		"municipality_id": "lima",
		"category":        "SOBORNO",
		"description":     secretDesc,
	}, "")
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create failed: %d %s", createRec.Code, createRec.Body.String())
	}
	var created domain.Report
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create: %v", err)
	}

	receiptPattern := regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`)
	if !receiptPattern.MatchString(created.ReceiptCode) {
		t.Fatalf("expected XXXX-XXXX-XXXX-XXXX receipt_code, got %q", created.ReceiptCode)
	}

	// Stored report must hold SHA-256 hash, NEVER plaintext receipt_code
	sum := sha256.Sum256([]byte(created.ReceiptCode))
	wantHash := hex.EncodeToString(sum[:])
	store.mu.Lock()
	stored := store.reports[created.ID]
	store.mu.Unlock()
	if stored.ReceiptHash != wantHash {
		t.Fatalf("expected stored receipt_hash %q, got %q", wantHash, stored.ReceiptHash)
	}
	if stored.ReceiptCode != "" {
		t.Fatalf("store must never persist plaintext receipt_code")
	}

	// Attach evidence and transition report
	evRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/evidence", map[string]any{
		"content_type": "application/pdf",
		"size_bytes":   1024,
		"sha256":       strings.Repeat("ab", 32),
	}, "")
	if evRec.Code != http.StatusOK {
		t.Fatalf("add evidence failed: %d", evRec.Code)
	}
	submitRec := doReq(t, h, http.MethodPost, "/reports/"+created.ID.String()+"/submit", nil, "")
	if submitRec.Code != http.StatusOK {
		t.Fatalf("submit failed: %d", submitRec.Code)
	}
	// Transition responses must NOT re-emit receipt_code
	if strings.Contains(submitRec.Body.String(), "receipt_code") {
		t.Fatalf("submit response must not include receipt_code: %s", submitRec.Body.String())
	}

	_ = doReq(t, h, http.MethodPost, "/moderation/cases/"+created.ID.String()+"/triage", map[string]string{
		"reason": "Internal moderator note CONFIDENTIAL",
	}, testModToken)

	// Missing / malformed X-Receipt-Code -> 400
	missingReq := httptest.NewRequest(http.MethodGet, "/public/reports/track?municipality_id=lima", nil)
	missingRec := httptest.NewRecorder()
	h.ServeHTTP(missingRec, missingReq)
	if missingRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing X-Receipt-Code, got %d", missingRec.Code)
	}

	malformedReq := httptest.NewRequest(http.MethodGet, "/public/reports/track?municipality_id=lima", nil)
	malformedReq.Header.Set("X-Receipt-Code", "invalid-code!")
	malformedRec := httptest.NewRecorder()
	h.ServeHTTP(malformedRec, malformedReq)
	if malformedRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed X-Receipt-Code, got %d", malformedRec.Code)
	}

	// Valid lowercase/whitespace X-Receipt-Code -> 200 with status & timeline, ZERO PII/description/evidence
	trackReq := httptest.NewRequest(http.MethodGet, "/public/reports/track?municipality_id=lima", nil)
	trackReq.Header.Set("X-Receipt-Code", "  "+strings.ToLower(created.ReceiptCode)+"  ")
	trackRec := httptest.NewRecorder()
	h.ServeHTTP(trackRec, trackReq)
	if trackRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /public/reports/track, got %d: %s", trackRec.Code, trackRec.Body.String())
	}

	rawTrack := trackRec.Body.String()
	for _, forbidden := range []string{secretDesc, "Juan Perez", "CONFIDENTIAL", "storage_ref", "evidence", created.ID.String(), "description", "reason", "actor_id"} {
		if strings.Contains(rawTrack, forbidden) {
			t.Fatalf("track response leaked forbidden field/content %q: %s", forbidden, rawTrack)
		}
	}

	var tracking domain.ReportTracking
	if err := json.Unmarshal(trackRec.Body.Bytes(), &tracking); err != nil {
		t.Fatalf("unmarshal tracking: %v", err)
	}
	if tracking.Status != "TRIAGED" || tracking.Category != "SOBORNO" || tracking.MunicipalityID != "lima" {
		t.Fatalf("unexpected tracking summary: %#v", tracking)
	}
	if len(tracking.Timeline) != 2 || tracking.Timeline[0].Action != "SUBMIT" || tracking.Timeline[1].Action != "TRIAGE" {
		t.Fatalf("unexpected tracking timeline: %#v", tracking.Timeline)
	}

	// Wrong municipality -> 404
	wrongMuniReq := httptest.NewRequest(http.MethodGet, "/public/reports/track?municipality_id=cusco", nil)
	wrongMuniReq.Header.Set("X-Receipt-Code", created.ReceiptCode)
	wrongMuniRec := httptest.NewRecorder()
	h.ServeHTTP(wrongMuniRec, wrongMuniReq)
	if wrongMuniRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on wrong municipality, got %d", wrongMuniRec.Code)
	}

	// Wrong receipt code -> 404
	wrongCodeReq := httptest.NewRequest(http.MethodGet, "/public/reports/track?municipality_id=lima", nil)
	wrongCodeReq.Header.Set("X-Receipt-Code", "AAAA-BBBB-CCCC-DDDD")
	wrongCodeRec := httptest.NewRecorder()
	h.ServeHTTP(wrongCodeRec, wrongCodeReq)
	if wrongCodeRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on unknown receipt, got %d", wrongCodeRec.Code)
	}
}

func TestIdempotencyKeyPayloadConflictReturns409(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	send := func(cat, desc, key string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{
			"municipality_id": "lima",
			"category":        cat,
			"description":     desc,
		})
		req := httptest.NewRequest(http.MethodPost, "/reports", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	rec1 := send("OBRAS", "Payload original", "shared-key-1")
	if rec1.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec1.Code)
	}
	var r1 domain.Report
	_ = json.Unmarshal(rec1.Body.Bytes(), &r1)
	if r1.ReceiptCode == "" {
		t.Fatalf("expected receipt_code on initial 201")
	}

	// Same key, same payload -> 200 replay, same ID, receipt_code omitted on replay
	recReplay := send("OBRAS", "Payload original", "shared-key-1")
	if recReplay.Code != http.StatusOK {
		t.Fatalf("expected 200 replay, got %d", recReplay.Code)
	}
	if strings.Contains(recReplay.Body.String(), "receipt_code") {
		t.Fatalf("idempotent replay must not re-emit receipt_code: %s", recReplay.Body.String())
	}

	// Same key, DIFFERENT payload -> 409 Conflict with IDEMPOTENCY_KEY_CONFLICT
	recConflict := send("OBRAS", "Payload distinto", "shared-key-1")
	if recConflict.Code != http.StatusConflict {
		t.Fatalf("expected 409 on payload conflict, got %d: %s", recConflict.Code, recConflict.Body.String())
	}
	var errResp struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(recConflict.Body.Bytes(), &errResp)
	if errResp.Code != "IDEMPOTENCY_KEY_CONFLICT" {
		t.Fatalf("expected IDEMPOTENCY_KEY_CONFLICT, got %q", errResp.Code)
	}
	if len(store.reports) != 1 {
		t.Fatalf("conflict must not create second report, got %d", len(store.reports))
	}
}

func TestOCDSReleasesExactDecimalAndAnomalies(t *testing.T) {
	srv, store := setupTestServer(t)
	h := srv.Handler()

	d1 := "2026-02-01"
	d2 := "2026-02-05"
	ref1 := "DOC-101"
	ref2 := "DOC-102"
	store.mu.Lock()
	store.expenses = []domain.Expense{
		{
			ID:             uuid.New(),
			MunicipalityID: "lima",
			VersionID:      uuid.New(),
			Entity:         "Muni Lima",
			Category:       "OBRAS",
			AmountCents:    250075,
			Amount:         "2500.75",
			OccurredOn:     &d1,
			DocRef:         &ref1,
		},
		{
			ID:             uuid.New(),
			MunicipalityID: "lima",
			VersionID:      uuid.New(),
			Entity:         "Muni Lima",
			Category:       "OBRAS",
			AmountCents:    210000,
			Amount:         "2100.00",
			OccurredOn:     &d2,
			DocRef:         &ref2,
		},
	}
	store.mu.Unlock()

	// 1. OCDS 1.1 releases.json
	ocdsRec := doReq(t, h, http.MethodGet, "/public/ocds/releases.json?municipality_id=lima", nil, "")
	if ocdsRec.Code != http.StatusOK {
		t.Fatalf("GET /public/ocds/releases.json failed: %d %s", ocdsRec.Code, ocdsRec.Body.String())
	}
	rawOCDS := ocdsRec.Body.String()
	// Exact JSON decimal numbers without quotes
	if !strings.Contains(rawOCDS, `"amount":2500.75`) || !strings.Contains(rawOCDS, `"amount":2100.00`) {
		t.Fatalf("OCDS release must emit exact JSON decimal amounts without float64 artifacts: %s", rawOCDS)
	}
	var pkg struct {
		Version       string `json:"version"`
		URI           string `json:"uri"`
		PublishedDate string `json:"publishedDate"`
		Publisher     struct {
			Name string `json:"name"`
		} `json:"publisher"`
		Releases []struct {
			OCID           string   `json:"ocid"`
			ID             string   `json:"id"`
			Tag            []string `json:"tag"`
			InitiationType string   `json:"initiationType"`
			Buyer          struct {
				Name string `json:"name"`
			} `json:"buyer"`
			Tender struct {
				ID    string `json:"id"`
				Title string `json:"title"`
				Value struct {
					Amount   json.Number `json:"amount"`
					Currency string      `json:"currency"`
				} `json:"value"`
			} `json:"tender"`
			Awards    []map[string]any `json:"awards"`
			Contracts []map[string]any `json:"contracts"`
		} `json:"releases"`
	}
	if err := json.Unmarshal(ocdsRec.Body.Bytes(), &pkg); err != nil {
		t.Fatalf("unmarshal OCDS package: %v", err)
	}
	if pkg.Version != "1.1" || pkg.Publisher.Name != "CivicTech Peru" || len(pkg.Releases) != 2 {
		t.Fatalf("unexpected OCDS package metadata: %#v", pkg)
	}
	if pkg.Releases[0].Tender.Value.Amount.String() != "2500.75" || pkg.Releases[0].Tender.Value.Currency != "PEN" {
		t.Fatalf("unexpected tender value: %#v", pkg.Releases[0].Tender.Value)
	}
	if len(pkg.Releases[0].Awards) != 1 || len(pkg.Releases[0].Contracts) != 1 {
		t.Fatalf("expected awards and contracts in OCDS release")
	}

	// 2. Anomalies forwarding to Rust engine
	anomRec := doReq(t, h, http.MethodGet, "/public/anomalies?municipality_id=lima&threshold_cents=428000", nil, "")
	if anomRec.Code != http.StatusOK {
		t.Fatalf("GET /public/anomalies failed: %d %s", anomRec.Code, anomRec.Body.String())
	}
	var anomResp domain.AnalyzeExpensesResponse
	if err := json.Unmarshal(anomRec.Body.Bytes(), &anomResp); err != nil {
		t.Fatalf("unmarshal anomalies: %v", err)
	}
	if anomResp.TotalExpenses != 2 || anomResp.TotalAmountCents != 460075 || anomResp.ThresholdCents != 428000 || anomResp.FlagCount < 1 {
		t.Fatalf("unexpected anomalies response: %#v", anomResp)
	}

	// Invalid threshold_cents -> 400
	badAnom := doReq(t, h, http.MethodGet, "/public/anomalies?threshold_cents=-10", nil, "")
	if badAnom.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative threshold_cents, got %d", badAnom.Code)
	}
}

func TestRateLimiterAndCORSReceiptHeader(t *testing.T) {
	store := newFakeStore()
	authSvc := auth.NewService(auth.Config{
		Mode:              auth.ModeDevStatic,
		DevAdminToken:     testAdminToken,
		DevModeratorToken: testModToken,
	})
	srv := httpapi.NewServer(store, fakeEngine{}, fakeSigner{}, authSvc, nil, httpapi.Config{
		RateLimitPerMinute: 2,
		RateLimitBurst:     2,
	})
	h := srv.Handler()

	// CORS preflight allows X-Receipt-Code
	preReq := httptest.NewRequest(http.MethodOptions, "/public/reports/track", nil)
	preReq.Header.Set("Origin", "http://localhost:3000")
	preRec := httptest.NewRecorder()
	h.ServeHTTP(preRec, preReq)
	if !strings.Contains(preRec.Header().Get("Access-Control-Allow-Headers"), "X-Receipt-Code") {
		t.Fatalf("CORS Allow-Headers must include X-Receipt-Code, got %q", preRec.Header().Get("Access-Control-Allow-Headers"))
	}

	// First 2 requests from IP 1.2.3.4 succeed, 3rd returns 429 + Retry-After + RATE_LIMITED
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/public/reports/track", nil)
		req.RemoteAddr = "1.2.3.4:12345"
		req.Header.Set("X-Receipt-Code", "AAAA-BBBB-CCCC-DDDD")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("request %d expected 404 (not rate limited), got %d", i+1, rec.Code)
		}
	}

	limitedReq := httptest.NewRequest(http.MethodGet, "/public/reports/track", nil)
	limitedReq.RemoteAddr = "1.2.3.4:12345"
	limitedReq.Header.Set("X-Receipt-Code", "AAAA-BBBB-CCCC-DDDD")
	limitedRec := httptest.NewRecorder()
	h.ServeHTTP(limitedRec, limitedReq)
	if limitedRec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests, got %d: %s", limitedRec.Code, limitedRec.Body.String())
	}
	if limitedRec.Header().Get("Retry-After") == "" {
		t.Fatalf("expected Retry-After header on 429 response")
	}
	var errPayload struct {
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
	}
	_ = json.Unmarshal(limitedRec.Body.Bytes(), &errPayload)
	if errPayload.Code != "RATE_LIMITED" || !errPayload.Retryable {
		t.Fatalf("expected RATE_LIMITED retryable error, got %#v", errPayload)
	}

	// Different IP is independent and NOT limited
	otherIPReq := httptest.NewRequest(http.MethodGet, "/public/reports/track", nil)
	otherIPReq.RemoteAddr = "5.6.7.8:22222"
	otherIPReq.Header.Set("X-Receipt-Code", "AAAA-BBBB-CCCC-DDDD")
	otherIPRec := httptest.NewRecorder()
	h.ServeHTTP(otherIPRec, otherIPReq)
	if otherIPRec.Code != http.StatusNotFound {
		t.Fatalf("different IP should not be rate limited, got %d", otherIPRec.Code)
	}

	// Non-rate-limited route (/public/audit/verify) still succeeds for 1.2.3.4
	auditReq := httptest.NewRequest(http.MethodGet, "/public/audit/verify", nil)
	auditReq.RemoteAddr = "1.2.3.4:12345"
	auditRec := httptest.NewRecorder()
	h.ServeHTTP(auditRec, auditReq)
	if auditRec.Code != http.StatusOK {
		t.Fatalf("/public/audit/verify must not share write/track rate limit, got %d", auditRec.Code)
	}

	// Verify POST /reports, POST /reports/{id}/evidence, and POST /reports/{id}/submit are also rate-limited
	reportID := uuid.NewString()
	for _, tc := range []struct {
		ip     string
		method string
		path   string
		body   string
	}{
		{"9.9.9.1:1000", http.MethodPost, "/reports", `{"category":"OBRAS","description":"test"}`},
		{"9.9.9.2:1000", http.MethodPost, "/reports/" + reportID + "/evidence", `{"content_type":"application/pdf","size_bytes":100}`},
		{"9.9.9.3:1000", http.MethodPost, "/reports/" + reportID + "/submit", `{}`},
	} {
		for attempt := 0; attempt < 2; attempt++ {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.RemoteAddr = tc.ip
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code == http.StatusTooManyRequests {
				t.Fatalf("%s %s attempt %d should not be rate limited yet", tc.method, tc.path, attempt+1)
			}
		}
		req3 := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
		req3.RemoteAddr = tc.ip
		req3.Header.Set("Content-Type", "application/json")
		rec3 := httptest.NewRecorder()
		h.ServeHTTP(rec3, req3)
		if rec3.Code != http.StatusTooManyRequests {
			t.Fatalf("%s %s 3rd attempt expected 429, got %d", tc.method, tc.path, rec3.Code)
		}
	}
}

func TestAgentDiscoveryDocumentsNewWorldClassEndpoints(t *testing.T) {
	srv, _ := setupTestServer(t)
	h := srv.Handler()

	oaRec := doReq(t, h, http.MethodGet, "/openapi.json", nil, "")
	if oaRec.Code != http.StatusOK {
		t.Fatalf("GET /openapi.json failed: %d", oaRec.Code)
	}
	var oa map[string]any
	_ = json.Unmarshal(oaRec.Body.Bytes(), &oa)
	paths := oa["paths"].(map[string]any)
	for _, p := range []string{
		"/public/audit/verify",
		"/public/reports/track",
		"/public/ocds/releases.json",
		"/public/anomalies",
	} {
		if _, ok := paths[p]; !ok {
			t.Fatalf("/openapi.json missing %q", p)
		}
	}
	if !strings.Contains(oaRec.Body.String(), "X-Receipt-Code") {
		t.Fatalf("/openapi.json must document X-Receipt-Code")
	}

	llmsRec := doReq(t, h, http.MethodGet, "/llms.txt", nil, "")
	llmsBody := llmsRec.Body.String()
	for _, token := range []string{
		"/public/audit/verify",
		"/public/reports/track",
		"/public/ocds/releases.json",
		"/public/anomalies",
		"X-Receipt-Code",
	} {
		if !strings.Contains(llmsBody, token) {
			t.Fatalf("/llms.txt missing %q", token)
		}
	}

	agentRec := doReq(t, h, http.MethodGet, "/.well-known/agent.json", nil, "")
	if !strings.Contains(agentRec.Body.String(), "X-Receipt-Code") {
		t.Fatalf("/.well-known/agent.json must document X-Receipt-Code")
	}
}
