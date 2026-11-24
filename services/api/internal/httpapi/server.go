package httpapi

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/arkelythex/estado/services/api/internal/ports"
	"github.com/google/uuid"
)

type Config struct {
	DemoExpensesCSVPath string
	AllowedOrigins      []string
	RateLimitPerMinute  int
	RateLimitBurst      int
}

const (
	idempotencyTTL        = 15 * time.Minute
	idempotencyMaxEntries = 1024
	maxIdempotencyKeyLen  = 128
	defaultRatePerMinute  = 60
)

type idempotencyEntry struct {
	payloadDigest string
	report        domain.Report
	err           error
	createdAt     time.Time
	inFlight      chan struct{}
}

type Server struct {
	store          ports.Store
	engine         ports.EngineClient
	signer         ports.StorageSigner
	auth           ports.Authenticator
	logger         *slog.Logger
	metrics        *Metrics
	demoCSVPath    string
	allowedOrigins map[string]bool
	limiter        *ipRateLimiter
	mux            *http.ServeMux
	idemMu         sync.Mutex
	idemCache      map[string]*idempotencyEntry
}

func NewServer(
	store ports.Store,
	engine ports.EngineClient,
	signer ports.StorageSigner,
	auth ports.Authenticator,
	logger *slog.Logger,
	cfg Config,
) *Server {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	origins := cfg.AllowedOrigins
	if len(origins) == 0 {
		origins = []string{"http://localhost:3000", "http://localhost:3001"}
	}
	originSet := make(map[string]bool, len(origins))
	for _, o := range origins {
		originSet[strings.TrimRight(strings.TrimSpace(o), "/")] = true
	}
	csvPath := strings.TrimSpace(cfg.DemoExpensesCSVPath)
	if csvPath == "" {
		csvPath = "fixtures/demo_expenses.csv"
	}

	ratePerMin := cfg.RateLimitPerMinute
	if ratePerMin <= 0 {
		ratePerMin = defaultRatePerMinute
	}
	burst := cfg.RateLimitBurst
	if burst <= 0 {
		burst = ratePerMin
	}

	s := &Server{
		store:          store,
		engine:         engine,
		signer:         signer,
		auth:           auth,
		logger:         logger,
		metrics:        NewMetrics(),
		demoCSVPath:    csvPath,
		allowedOrigins: originSet,
		limiter:        newIPRateLimiter(ratePerMin, burst),
		mux:            http.NewServeMux(),
		idemCache:      make(map[string]*idempotencyEntry),
	}
	s.registerRoutes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.corsMiddleware(s.loggingMiddleware(s.mux))
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /metrics", s.handleMetrics)
	s.mux.HandleFunc("GET /openapi.json", s.handleOpenAPI)
	s.mux.HandleFunc("GET /llms.txt", s.handleLLMsTxt)
	s.mux.HandleFunc("GET /.well-known/agent.json", s.handleAgentManifest)

	s.mux.HandleFunc("GET /public/datasets", s.handleListDatasets)
	s.mux.HandleFunc("GET /public/expenses", s.handleListExpenses)
	s.mux.HandleFunc("GET /public/reports", s.handleListPublishedReports)
	s.mux.HandleFunc("GET /public/reports/track", s.rateLimit(s.handleTrackReport))
	s.mux.HandleFunc("GET /public/reports/{id}", s.handleGetPublishedReport)
	s.mux.HandleFunc("GET /public/audit/verify", s.handleVerifyAuditChain)
	s.mux.HandleFunc("GET /public/ocds/releases.json", s.handleOCDSReleases)
	s.mux.HandleFunc("GET /public/anomalies", s.handleAnomalies)

	s.mux.HandleFunc("POST /reports", s.rateLimit(s.handleCreateReport))
	s.mux.HandleFunc("POST /reports/{id}/evidence", s.rateLimit(s.handleAddEvidence))
	s.mux.HandleFunc("POST /reports/{id}/submit", s.rateLimit(s.handleSubmitReport))

	s.mux.HandleFunc("GET /moderation/cases", s.handleListModerationCases)
	s.mux.HandleFunc("POST /moderation/cases/{id}/triage", s.handleModerationTransition("TRIAGE"))
	s.mux.HandleFunc("POST /moderation/cases/{id}/verify", s.handleModerationTransition("VERIFY"))
	s.mux.HandleFunc("POST /moderation/cases/{id}/reject", s.handleModerationTransition("REJECT"))
	s.mux.HandleFunc("POST /moderation/reports/{id}/publish", s.handlePublishReport)

	s.mux.HandleFunc("POST /admin/ingest/demo", s.handleIngestDemo)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "civictech-api",
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, s.metrics.Render())
}

func (s *Server) handleListDatasets(w http.ResponseWriter, r *http.Request) {
	muni := domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
	items, err := s.store.ListDatasets(r.Context(), muni)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	if items == nil {
		items = make([]domain.Dataset, 0)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleListExpenses(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from := strings.TrimSpace(q.Get("from"))
	to := strings.TrimSpace(q.Get("to"))
	if from != "" {
		if _, err := time.Parse("2006-01-02", from); err != nil {
			writeError(w, http.StatusBadRequest, "invalid 'from' date; expected YYYY-MM-DD")
			return
		}
	}
	if to != "" {
		if _, err := time.Parse("2006-01-02", to); err != nil {
			writeError(w, http.StatusBadRequest, "invalid 'to' date; expected YYYY-MM-DD")
			return
		}
	}

	filter := domain.ExpenseFilter{
		MunicipalityID: domain.NormalizeMunicipality(q.Get("municipality_id")),
		Entity:         strings.TrimSpace(q.Get("entity")),
		Category:       strings.TrimSpace(q.Get("category")),
		From:           from,
		To:             to,
	}

	items, err := s.store.ListExpenses(r.Context(), filter)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	if items == nil {
		items = make([]domain.Expense, 0)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleListPublishedReports(w http.ResponseWriter, r *http.Request) {
	muni := domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
	items, err := s.store.ListPublishedReports(r.Context(), muni)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	if items == nil {
		items = make([]domain.PublicReportSummary, 0)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleGetPublishedReport(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid report id")
		return
	}
	muni := domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
	item, err := s.store.GetPublishedReport(r.Context(), muni, id)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

type createReportRequest struct {
	MunicipalityID string `json:"municipality_id"`
	Category       string `json:"category"`
	Description    string `json:"description"`
}

func (s *Server) handleCreateReport(w http.ResponseWriter, r *http.Request) {
	var req createReportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	category := strings.TrimSpace(req.Category)
	description := strings.TrimSpace(req.Description)
	if category == "" || description == "" {
		writeError(w, http.StatusBadRequest, "category and description are required")
		return
	}
	if len(category) > 100 || len(description) > 10000 {
		writeError(w, http.StatusBadRequest, "category or description exceeds maximum length")
		return
	}

	muni := domain.NormalizeMunicipality(req.MunicipalityID)
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) > maxIdempotencyKeyLen {
		writeError(w, http.StatusBadRequest, "Idempotency-Key exceeds maximum length")
		return
	}

	if idempotencyKey != "" {
		cacheKey := muni + ":" + idempotencyKey
		payloadDigest := createReportPayloadDigest(muni, category, description)
		now := time.Now()
		s.idemMu.Lock()
		s.pruneIdempotencyLocked(now)
		if existing, ok := s.idemCache[cacheKey]; ok {
			if existing.payloadDigest != payloadDigest {
				s.idemMu.Unlock()
				writeStructuredError(w, http.StatusConflict, "Idempotency-Key was already used with a different request payload", "IDEMPOTENCY_KEY_CONFLICT", false)
				return
			}
			if existing.inFlight != nil {
				ch := existing.inFlight
				s.idemMu.Unlock()
				select {
				case <-ch:
					if existing.err == nil {
						writeJSON(w, http.StatusOK, existing.report)
						return
					}
					s.writeMappedError(w, existing.err)
					return
				case <-r.Context().Done():
					writeError(w, http.StatusRequestTimeout, "request cancelled")
					return
				}
			}
			rep := existing.report
			s.idemMu.Unlock()
			writeJSON(w, http.StatusOK, rep)
			return
		}

		entry := &idempotencyEntry{
			payloadDigest: payloadDigest,
			createdAt:     now,
			inFlight:      make(chan struct{}),
		}
		s.idemCache[cacheKey] = entry
		s.idemMu.Unlock()

		created, err := s.createDraftReport(r, muni, category, description)

		s.idemMu.Lock()
		cached := created
		cached.ReceiptCode = ""
		cached.ReceiptHash = ""
		entry.report = cached
		entry.err = err
		if err != nil {
			delete(s.idemCache, cacheKey)
		}
		close(entry.inFlight)
		entry.inFlight = nil
		s.idemMu.Unlock()

		if err != nil {
			s.writeMappedError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, created)
		return
	}

	created, err := s.createDraftReport(r, muni, category, description)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) createDraftReport(r *http.Request, muni, category, description string) (domain.Report, error) {
	receiptCode, err := generateReceiptCode()
	if err != nil {
		return domain.Report{}, fmt.Errorf("generate receipt code: %w", err)
	}
	report := domain.Report{
		ID:             uuid.New(),
		MunicipalityID: muni,
		Status:         "DRAFT",
		Category:       category,
		Description:    description,
		CreatedAt:      time.Now().UTC(),
		ReceiptHash:    sha256Hex(receiptCode),
	}
	actor := domain.Actor{Type: "citizen", ID: "anonymous"}
	created, err := s.store.CreateReport(r.Context(), report, actor)
	if err != nil {
		return domain.Report{}, err
	}
	created.ReceiptHash = ""
	created.ReceiptCode = receiptCode
	return created, nil
}

func (s *Server) pruneIdempotencyLocked(now time.Time) {
	for k, e := range s.idemCache {
		if e.inFlight == nil && now.Sub(e.createdAt) >= idempotencyTTL {
			delete(s.idemCache, k)
		}
	}
	for len(s.idemCache) >= idempotencyMaxEntries {
		var oldestKey string
		var oldestTime time.Time
		for k, e := range s.idemCache {
			if e.inFlight != nil {
				continue
			}
			if oldestKey == "" || e.createdAt.Before(oldestTime) {
				oldestKey = k
				oldestTime = e.createdAt
			}
		}
		if oldestKey == "" {
			break
		}
		delete(s.idemCache, oldestKey)
	}
}

type addEvidenceRequest struct {
	MunicipalityID string `json:"municipality_id"`
	ContentType    string `json:"content_type"`
	SizeBytes      *int64 `json:"size_bytes"`
	SHA256         string `json:"sha256"`
}

type addEvidenceResponse struct {
	ReportID         uuid.UUID         `json:"report_id"`
	EvidenceID       uuid.UUID         `json:"evidence_id"`
	UploadURL        string            `json:"upload_url"`
	ObjectKey        string            `json:"object_key"`
	ExpiresInSeconds int64             `json:"expires_in_seconds"`
	UploadHeaders    map[string]string `json:"upload_headers"`
}

func (s *Server) handleAddEvidence(w http.ResponseWriter, r *http.Request) {
	reportID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid report id")
		return
	}

	var req addEvidenceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.SizeBytes == nil || *req.SizeBytes <= 0 || *req.SizeBytes > s3.MaxEvidenceSizeBytes {
		writeError(w, http.StatusBadRequest, "size_bytes must be between 1 and 10485760 bytes")
		return
	}
	sizeBytes := *req.SizeBytes

	normalizedType, _, err := s3.ValidateEvidenceUpload(req.ContentType, sizeBytes)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	muni := domain.NormalizeMunicipality(req.MunicipalityID)
	report, err := s.store.GetReport(r.Context(), muni, reportID)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	if report.Status != "DRAFT" {
		s.writeInvalidTransitionError(w, fmt.Sprintf("cannot add evidence when report status is %s", report.Status), report.Status)
		return
	}

	sha := strings.TrimSpace(req.SHA256)
	if sha == "" {
		sha = "pending"
	} else if sha != "pending" && !isValidSHA256Hex(sha) {
		writeError(w, http.StatusBadRequest, "sha256 must be a 64-character hex string")
		return
	}

	presigned, err := s.signer.PresignPut(r.Context(), reportID, normalizedType, sizeBytes)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	uploadHeaders := presigned.UploadHeaders
	if len(uploadHeaders) == 0 {
		uploadHeaders = map[string]string{
			"Content-Type":                 normalizedType,
			"x-amz-server-side-encryption": "AES256",
		}
	}

	evidence := domain.Evidence{
		ID:             uuid.New(),
		ReportID:       reportID,
		MunicipalityID: muni,
		StorageRef:     s.signer.StorageRef(presigned.ObjectKey),
		SHA256:         sha,
		UploadedAt:     time.Now().UTC(),
	}

	saved, err := s.store.AddEvidence(r.Context(), evidence, domain.Actor{Type: "citizen", ID: "anonymous"})
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, addEvidenceResponse{
		ReportID:         reportID,
		EvidenceID:       saved.ID,
		UploadURL:        presigned.UploadURL,
		ObjectKey:        presigned.ObjectKey,
		ExpiresInSeconds: presigned.ExpiresInSeconds,
		UploadHeaders:    uploadHeaders,
	})
}

type submitRequest struct {
	MunicipalityID string `json:"municipality_id"`
}

func (s *Server) handleSubmitReport(w http.ResponseWriter, r *http.Request) {
	reportID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid report id")
		return
	}

	var req submitRequest
	if err := decodeOptionalJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload")
		return
	}

	muni := municipalityFromQueryOrBody(r, req.MunicipalityID)
	report, err := s.store.GetReport(r.Context(), muni, reportID)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	tr, err := s.engine.TransitionReport(r.Context(), report.Status, "SUBMIT")
	if err != nil {
		if errors.Is(err, domain.ErrInvalidTransition) {
			s.writeInvalidTransitionError(w, err.Error(), report.Status)
			return
		}
		s.writeMappedError(w, err)
		return
	}

	updated, err := s.store.TransitionReport(
		r.Context(),
		reportID,
		muni,
		tr.FromStatus,
		tr.ToStatus,
		tr.Action,
		"anonymous",
		"citizen submission",
	)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	s.metrics.ObserveTransition(tr.FromStatus, tr.ToStatus, tr.Action)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleListModerationCases(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.authorize(w, r, domain.RoleModerator, domain.RoleAdmin); !ok {
		return
	}

	q := r.URL.Query()
	muni := domain.NormalizeMunicipality(q.Get("municipality_id"))
	statusFilter := strings.TrimSpace(q.Get("status"))

	cases, err := s.store.ListModerationCases(r.Context(), muni, statusFilter)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	if cases == nil {
		cases = make([]domain.ModerationCase, 0)
	}
	writeJSON(w, http.StatusOK, cases)
}

type moderationActionRequest struct {
	MunicipalityID string `json:"municipality_id"`
	Reason         string `json:"reason"`
}

func (s *Server) handleModerationTransition(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := s.authorize(w, r, domain.RoleModerator, domain.RoleAdmin)
		if !ok {
			return
		}

		reportID, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid report id")
			return
		}

		var req moderationActionRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		reason := strings.TrimSpace(req.Reason)
		if reason == "" {
			writeError(w, http.StatusBadRequest, "reason is required")
			return
		}

		muni := municipalityFromQueryOrBody(r, req.MunicipalityID)
		report, err := s.store.GetReport(r.Context(), muni, reportID)
		if err != nil {
			s.writeMappedError(w, err)
			return
		}

		tr, err := s.engine.TransitionReport(r.Context(), report.Status, action)
		if err != nil {
			if errors.Is(err, domain.ErrInvalidTransition) {
				s.writeInvalidTransitionError(w, err.Error(), report.Status)
				return
			}
			s.writeMappedError(w, err)
			return
		}

		updated, err := s.store.TransitionReport(
			r.Context(),
			reportID,
			muni,
			tr.FromStatus,
			tr.ToStatus,
			tr.Action,
			principal.Subject,
			reason,
		)
		if err != nil {
			s.writeMappedError(w, err)
			return
		}
		s.metrics.ObserveTransition(tr.FromStatus, tr.ToStatus, tr.Action)
		writeJSON(w, http.StatusOK, updated)
	}
}

type publishReportRequest struct {
	MunicipalityID string `json:"municipality_id"`
	PublicText     string `json:"public_text"`
	Reason         string `json:"reason"`
}

func (s *Server) handlePublishReport(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.authorize(w, r, domain.RoleModerator, domain.RoleAdmin)
	if !ok {
		return
	}

	reportID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid report id")
		return
	}

	var req publishReportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	publicText := strings.TrimSpace(req.PublicText)
	reason := strings.TrimSpace(req.Reason)
	if publicText == "" || reason == "" {
		writeError(w, http.StatusBadRequest, "public_text and reason are required")
		return
	}

	muni := municipalityFromQueryOrBody(r, req.MunicipalityID)
	report, err := s.store.GetReport(r.Context(), muni, reportID)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	tr, err := s.engine.TransitionReport(r.Context(), report.Status, "PUBLISH")
	if err != nil {
		if errors.Is(err, domain.ErrInvalidTransition) {
			s.writeInvalidTransitionError(w, err.Error(), report.Status)
			return
		}
		s.writeMappedError(w, err)
		return
	}

	pub, err := s.store.PublishReport(
		r.Context(),
		reportID,
		muni,
		tr.FromStatus,
		publicText,
		principal.Subject,
		reason,
	)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	s.metrics.ObserveTransition(tr.FromStatus, tr.ToStatus, tr.Action)
	writeJSON(w, http.StatusOK, map[string]any{
		"report_id":   reportID,
		"status":      "PUBLISHED",
		"publication": pub,
	})
}

type ingestDemoRequest struct {
	MunicipalityID string `json:"municipality_id"`
}

func (s *Server) handleIngestDemo(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.authorize(w, r, domain.RoleAdmin)
	if !ok {
		return
	}

	var req ingestDemoRequest
	if err := decodeOptionalJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	muni := municipalityFromQueryOrBody(r, req.MunicipalityID)

	rawCSV, err := os.ReadFile(s.demoCSVPath)
	if err != nil {
		s.metrics.ObserveIngest("failure", 0)
		s.logger.Error("failed to read demo csv", slog.String("error", err.Error()))
		writeError(w, http.StatusInternalServerError, "failed to read demo expenses csv")
		return
	}

	parsed, err := s.engine.ParseExpenses(r.Context(), string(rawCSV))
	if err != nil {
		s.metrics.ObserveIngest("failure", 0)
		s.writeMappedError(w, err)
		return
	}

	res, err := s.store.IngestExpensesIdempotent(
		r.Context(),
		muni,
		"csv_demo",
		parsed.ChecksumSHA256,
		parsed.Rows,
		principal.Subject,
	)
	if err != nil {
		s.metrics.ObserveIngest("failure", 0)
		s.writeMappedError(w, err)
		return
	}

	if res.Deduplicated {
		s.metrics.ObserveIngest("deduplicated", 0)
	} else {
		s.metrics.ObserveIngest("success", res.RowsIngested)
	}

	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleVerifyAuditChain(w http.ResponseWriter, r *http.Request) {
	entries, err := s.store.ListAuditChain(r.Context(), 500)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	ver, err := s.engine.VerifyAuditChain(r.Context(), entries)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ver)
}

func (s *Server) handleTrackReport(w http.ResponseWriter, r *http.Request) {
	canonicalCode, ok := normalizeReceiptCode(r.Header.Get("X-Receipt-Code"))
	if !ok {
		writeError(w, http.StatusBadRequest, "valid X-Receipt-Code header is required")
		return
	}
	muni := domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
	tracking, err := s.store.TrackReportByReceiptHash(r.Context(), muni, sha256Hex(canonicalCode))
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tracking)
}

type ocdsValue struct {
	Amount   json.Number `json:"amount"`
	Currency string      `json:"currency"`
}

type ocdsParty struct {
	Name string `json:"name"`
}

type ocdsTender struct {
	ID     string    `json:"id"`
	Title  string    `json:"title"`
	Status string    `json:"status"`
	Value  ocdsValue `json:"value"`
}

type ocdsAward struct {
	ID     string    `json:"id"`
	Status string    `json:"status"`
	Value  ocdsValue `json:"value"`
}

type ocdsContract struct {
	ID      string    `json:"id"`
	AwardID string    `json:"awardID"`
	Status  string    `json:"status"`
	Value   ocdsValue `json:"value"`
}

type ocdsRelease struct {
	OCID           string         `json:"ocid"`
	ID             string         `json:"id"`
	Date           string         `json:"date"`
	Tag            []string       `json:"tag"`
	InitiationType string         `json:"initiationType"`
	Buyer          ocdsParty      `json:"buyer"`
	Tender         ocdsTender     `json:"tender"`
	Awards         []ocdsAward    `json:"awards"`
	Contracts      []ocdsContract `json:"contracts"`
}

type ocdsReleasePackage struct {
	Version       string        `json:"version"`
	URI           string        `json:"uri"`
	PublishedDate string        `json:"publishedDate"`
	Publisher     ocdsParty     `json:"publisher"`
	Releases      []ocdsRelease `json:"releases"`
}

func (s *Server) handleOCDSReleases(w http.ResponseWriter, r *http.Request) {
	muni := domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
	expenses, err := s.store.ListExpenses(r.Context(), domain.ExpenseFilter{
		MunicipalityID: muni,
	})
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	now := time.Now().UTC()
	publishedDate := now.Format(time.RFC3339)
	releases := make([]ocdsRelease, 0, len(expenses))
	for _, e := range expenses {
		releaseDate := publishedDate
		if e.OccurredOn != nil && strings.TrimSpace(*e.OccurredOn) != "" {
			releaseDate = strings.TrimSpace(*e.OccurredOn) + "T00:00:00Z"
		}
		tenderID := e.ID.String()
		if e.DocRef != nil && strings.TrimSpace(*e.DocRef) != "" {
			tenderID = strings.TrimSpace(*e.DocRef)
		}
		val := ocdsValue{
			Amount:   json.Number(domain.FormatCents(e.AmountCents)),
			Currency: "PEN",
		}
		awardID := "award-" + e.ID.String()
		contractID := "contract-" + e.ID.String()
		releases = append(releases, ocdsRelease{
			OCID:           fmt.Sprintf("ocds-pe-%s-%s", muni, e.ID.String()),
			ID:             e.ID.String(),
			Date:           releaseDate,
			Tag:            []string{"implementation"},
			InitiationType: "tender",
			Buyer:          ocdsParty{Name: e.Entity},
			Tender: ocdsTender{
				ID:     tenderID,
				Title:  e.Category,
				Status: "complete",
				Value:  val,
			},
			Awards: []ocdsAward{
				{ID: awardID, Status: "active", Value: val},
			},
			Contracts: []ocdsContract{
				{ID: contractID, AwardID: awardID, Status: "active", Value: val},
			},
		})
	}

	pkg := ocdsReleasePackage{
		Version:       "1.1",
		URI:           "/public/ocds/releases.json?municipality_id=" + url.QueryEscape(muni),
		PublishedDate: publishedDate,
		Publisher:     ocdsParty{Name: "CivicTech Peru"},
		Releases:      releases,
	}
	writeJSON(w, http.StatusOK, pkg)
}

func (s *Server) handleAnomalies(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	muni := domain.NormalizeMunicipality(q.Get("municipality_id"))

	var thresholdPtr *int64
	if rawThresh := strings.TrimSpace(q.Get("threshold_cents")); rawThresh != "" {
		parsed, err := strconv.ParseInt(rawThresh, 10, 64)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "threshold_cents must be a positive integer")
			return
		}
		thresholdPtr = &parsed
	}

	expenses, err := s.store.ListExpenses(r.Context(), domain.ExpenseFilter{
		MunicipalityID: muni,
	})
	if err != nil {
		s.writeMappedError(w, err)
		return
	}

	inputs := make([]domain.ExpenseAnalyticsInput, 0, len(expenses))
	for _, e := range expenses {
		inputs = append(inputs, domain.ExpenseAnalyticsInput{
			ID:          e.ID.String(),
			Entity:      e.Entity,
			Category:    e.Category,
			AmountCents: e.AmountCents,
			OccurredOn:  e.OccurredOn,
			DocRef:      e.DocRef,
		})
	}

	res, err := s.engine.AnalyzeExpenses(r.Context(), thresholdPtr, inputs)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request, roles ...domain.Role) (domain.Principal, bool) {
	principal, err := s.auth.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return domain.Principal{}, false
	}
	if err := s.auth.RequireRoles(principal, roles...); err != nil {
		writeError(w, http.StatusForbidden, "forbidden")
		return domain.Principal{}, false
	}
	return principal, true
}

func (s *Server) writeInvalidTransitionError(w http.ResponseWriter, msg, currentStatus string) {
	allowed := allowedActionsForStatus(currentStatus)
	var allowedPtr *[]string
	if allowed != nil {
		allowedPtr = &allowed
	}
	writeJSON(w, http.StatusUnprocessableEntity, errorResponse{
		Error:          msg,
		Code:           "INVALID_STATE_TRANSITION",
		Retryable:      false,
		AllowedActions: allowedPtr,
	})
}

func (s *Server) writeMappedError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrValidation):
		writeStructuredError(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR", false)
	case errors.Is(err, domain.ErrInvalidTransition):
		writeStructuredError(w, http.StatusUnprocessableEntity, err.Error(), "INVALID_STATE_TRANSITION", false)
	case errors.Is(err, domain.ErrNotFound):
		writeStructuredError(w, http.StatusNotFound, "resource not found", "NOT_FOUND", false)
	case errors.Is(err, domain.ErrConflict):
		writeStructuredError(w, http.StatusConflict, err.Error(), "CONFLICT", true)
	case errors.Is(err, domain.ErrUnauthorized):
		writeStructuredError(w, http.StatusUnauthorized, "unauthorized", "UNAUTHORIZED", false)
	case errors.Is(err, domain.ErrForbidden):
		writeStructuredError(w, http.StatusForbidden, "forbidden", "FORBIDDEN", false)
	default:
		s.logger.Error("internal error", slog.String("error", err.Error()))
		writeStructuredError(w, http.StatusInternalServerError, "internal server error", "INTERNAL_ERROR", true)
	}
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimRight(r.Header.Get("Origin"), "/")
		if origin != "" && s.allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Receipt-Code")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		dur := time.Since(started)

		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		s.metrics.ObserveHTTP(r.Method, route, rec.status, dur)

		// Structured JSON logging without raw bodies, auth headers, or PII.
		s.logger.Info("http_request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.String("route", route),
			slog.Int("status", rec.status),
			slog.Int64("duration_ms", dur.Milliseconds()),
		)
	})
}

func decodeJSON(r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("request body is required")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return errors.New("invalid JSON request body")
	}
	return nil
}

func decodeOptionalJSON(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return errors.New("invalid json payload")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return errors.New("invalid json payload")
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("invalid json payload")
	}
	return nil
}

func municipalityFromQueryOrBody(r *http.Request, bodyValue string) string {
	if strings.TrimSpace(bodyValue) != "" {
		return domain.NormalizeMunicipality(bodyValue)
	}
	return domain.NormalizeMunicipality(r.URL.Query().Get("municipality_id"))
}

func isValidSHA256Hex(v string) bool {
	if len(v) != 64 {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

type errorResponse struct {
	Error          string    `json:"error"`
	Code           string    `json:"code"`
	Retryable      bool      `json:"retryable"`
	AllowedActions *[]string `json:"allowed_actions,omitempty"`
}

func allowedActionsForStatus(status string) []string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "DRAFT":
		return []string{"SUBMIT"}
	case "SUBMITTED":
		return []string{"TRIAGE", "REJECT"}
	case "TRIAGED":
		return []string{"VERIFY", "REJECT"}
	case "VERIFIED":
		return []string{"PUBLISH"}
	case "PUBLISHED", "REJECTED":
		return []string{}
	default:
		return nil
	}
}

func errorCodeForStatus(status int) (string, bool) {
	switch status {
	case http.StatusBadRequest:
		return "VALIDATION_ERROR", false
	case http.StatusUnauthorized:
		return "UNAUTHORIZED", false
	case http.StatusForbidden:
		return "FORBIDDEN", false
	case http.StatusNotFound:
		return "NOT_FOUND", false
	case http.StatusConflict:
		return "CONFLICT", true
	case http.StatusTooManyRequests:
		return "RATE_LIMITED", true
	case http.StatusUnprocessableEntity:
		return "INVALID_STATE_TRANSITION", false
	case http.StatusRequestTimeout:
		return "REQUEST_TIMEOUT", true
	default:
		if status >= 500 {
			return "INTERNAL_ERROR", true
		}
		return "ERROR", false
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeStructuredError(w http.ResponseWriter, status int, msg, code string, retryable bool) {
	writeJSON(w, status, errorResponse{
		Error:     msg,
		Code:      code,
		Retryable: retryable,
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	code, retryable := errorCodeForStatus(status)
	writeStructuredError(w, status, msg, code, retryable)
}

const receiptAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func generateReceiptCode() (string, error) {
	alphaLen := big.NewInt(int64(len(receiptAlphabet)))
	var buf [19]byte
	pos := 0
	for i := 0; i < 16; i++ {
		if i > 0 && i%4 == 0 {
			buf[pos] = '-'
			pos++
		}
		n, err := rand.Int(rand.Reader, alphaLen)
		if err != nil {
			return "", err
		}
		buf[pos] = receiptAlphabet[n.Int64()]
		pos++
	}
	return string(buf[:]), nil
}

func normalizeReceiptCode(raw string) (string, bool) {
	trimmed := strings.ToUpper(strings.TrimSpace(raw))
	if trimmed == "" {
		return "", false
	}
	var clean [16]byte
	idx := 0
	switch len(trimmed) {
	case 19:
		for i := 0; i < len(trimmed); i++ {
			c := trimmed[i]
			if i == 4 || i == 9 || i == 14 {
				if c != '-' {
					return "", false
				}
				continue
			}
			if !isUpperAlnum(c) {
				return "", false
			}
			clean[idx] = c
			idx++
		}
	case 16:
		for i := 0; i < len(trimmed); i++ {
			c := trimmed[i]
			if !isUpperAlnum(c) {
				return "", false
			}
			clean[idx] = c
			idx++
		}
	default:
		return "", false
	}
	return fmt.Sprintf("%s-%s-%s-%s", clean[0:4], clean[4:8], clean[8:12], clean[12:16]), true
}

func isUpperAlnum(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func sha256Hex(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func createReportPayloadDigest(muni, category, description string) string {
	h := sha256.New()
	var lenBuf [8]byte
	for _, s := range []string{muni, category, description} {
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(s)))
		_, _ = h.Write(lenBuf[:])
		_, _ = h.Write([]byte(s))
	}
	return hex.EncodeToString(h.Sum(nil))
}

type ipBucket struct {
	tokens int64
	last   time.Time
}

type ipRateLimiter struct {
	mu             sync.Mutex
	capacity       int64
	refillInterval time.Duration
	buckets        map[string]*ipBucket
}

func newIPRateLimiter(ratePerMinute, burst int) *ipRateLimiter {
	interval := time.Minute / time.Duration(ratePerMinute)
	if interval <= 0 {
		interval = time.Millisecond
	}
	return &ipRateLimiter{
		capacity:       int64(burst),
		refillInterval: interval,
		buckets:        make(map[string]*ipBucket),
	}
}

func (l *ipRateLimiter) allow(ip string, now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.buckets) > 4096 {
		for k, b := range l.buckets {
			if now.Sub(b.last) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
	}

	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{
			tokens: l.capacity,
			last:   now,
		}
		l.buckets[ip] = b
	} else {
		elapsed := now.Sub(b.last)
		if elapsed > 0 {
			added := int64(elapsed / l.refillInterval)
			if added > 0 {
				b.tokens += added
				if b.tokens > l.capacity {
					b.tokens = l.capacity
				}
				b.last = b.last.Add(time.Duration(added) * l.refillInterval)
			}
		}
	}

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}

	wait := l.refillInterval - now.Sub(b.last)
	if wait < 0 {
		wait = l.refillInterval
	}
	retryAfter := int((wait + time.Second - 1) / time.Second)
	if retryAfter < 1 {
		retryAfter = 1
	}
	return false, retryAfter
}

func (s *Server) rateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		allowed, retryAfter := s.limiter.allow(ip, time.Now())
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			writeStructuredError(w, http.StatusTooManyRequests, "rate limit exceeded", "RATE_LIMITED", true)
			return
		}
		next(w, r)
	}
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
		return xrip
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	if addr := strings.TrimSpace(r.RemoteAddr); addr != "" {
		return addr
	}
	return "unknown"
}
