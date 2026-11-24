package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/arkelythex/estado/services/api/internal/ports"
	"github.com/google/uuid"
)

type Config struct {
	DemoExpensesCSVPath string
	AllowedOrigins      []string
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
	mux            *http.ServeMux
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

	s := &Server{
		store:          store,
		engine:         engine,
		signer:         signer,
		auth:           auth,
		logger:         logger,
		metrics:        NewMetrics(),
		demoCSVPath:    csvPath,
		allowedOrigins: originSet,
		mux:            http.NewServeMux(),
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

	s.mux.HandleFunc("GET /public/datasets", s.handleListDatasets)
	s.mux.HandleFunc("GET /public/expenses", s.handleListExpenses)
	s.mux.HandleFunc("GET /public/reports", s.handleListPublishedReports)
	s.mux.HandleFunc("GET /public/reports/{id}", s.handleGetPublishedReport)

	s.mux.HandleFunc("POST /reports", s.handleCreateReport)
	s.mux.HandleFunc("POST /reports/{id}/evidence", s.handleAddEvidence)
	s.mux.HandleFunc("POST /reports/{id}/submit", s.handleSubmitReport)

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

	report := domain.Report{
		ID:             uuid.New(),
		MunicipalityID: domain.NormalizeMunicipality(req.MunicipalityID),
		Status:         "DRAFT",
		Category:       category,
		Description:    description,
		CreatedAt:      time.Now().UTC(),
	}

	actor := domain.Actor{Type: "citizen", ID: "anonymous"}
	created, err := s.store.CreateReport(r.Context(), report, actor)
	if err != nil {
		s.writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
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
		s.writeMappedError(w, fmt.Errorf("%w: cannot add evidence when report status is %s", domain.ErrInvalidTransition, report.Status))
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

func (s *Server) writeMappedError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, domain.ErrValidation):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrInvalidTransition):
		writeError(w, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, domain.ErrNotFound):
		writeError(w, http.StatusNotFound, "resource not found")
	case errors.Is(err, domain.ErrConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, domain.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden")
	default:
		s.logger.Error("internal error", slog.String("error", err.Error()))
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimRight(r.Header.Get("Origin"), "/")
		if origin != "" && s.allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
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

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
