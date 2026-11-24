package httpapi

import (
	"io"
	"net/http"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

const llmsTxtGuide = `# CivicTech Peru API — AI Agent Guide

## Purpose
Public fiscal transparency, citizen irregularity reporting with immutable SSE-S3 evidence,
auditable moderation workflow, and idempotent CSV dataset ingestion for Peruvian municipalities.

## Discovery Endpoints
- OpenAPI 3.1 schema: GET /openapi.json
- Machine-readable agent capabilities: GET /.well-known/agent.json
- Health check: GET /health
- Prometheus metrics: GET /metrics

## Municipality Scoping
All domain endpoints are scoped by municipality_id (defaults to "lima" when omitted).
Pass ?municipality_id=lima on GET requests or {"municipality_id":"lima"} in JSON bodies.

## Exact Money Representation
Monetary amounts are NEVER represented as floating-point numbers.
- amount_cents (int64): exact integer cents (e.g. 125075 = S/ 1250.75)
- amount (string): exact decimal representation formatted from integer cents (e.g. "1250.75")

## Report State Machine (No Skipped States)
Allowed transitions:
- DRAFT -> SUBMITTED (POST /reports/{id}/submit)
- SUBMITTED -> TRIAGED (POST /moderation/cases/{id}/triage)
- SUBMITTED -> REJECTED (POST /moderation/cases/{id}/reject)
- TRIAGED -> VERIFIED (POST /moderation/cases/{id}/verify)
- TRIAGED -> REJECTED (POST /moderation/cases/{id}/reject)
- VERIFIED -> PUBLISHED (POST /moderation/reports/{id}/publish)

Evidence attachments (POST /reports/{id}/evidence) are immutable and only permitted while status is DRAFT.
Invalid transitions return HTTP 422 with code="INVALID_STATE_TRANSITION" and allowed_actions=[...].

## Authentication & RBAC
- Public & Citizen endpoints (/public/*, /reports*): unauthenticated.
- Moderation endpoints (/moderation/*): Authorization: Bearer <token> with MODERATOR or ADMIN role.
- Admin ingestion (/admin/ingest/demo): Authorization: Bearer <token> with ADMIN role.

## Idempotency & Anonymous Whistleblower Receipts
- POST /reports supports optional header Idempotency-Key (scoped per municipality_id and bound to SHA-256 payload digest). Retrying with the same payload returns the existing draft report; reusing the key with a different payload returns 409 IDEMPOTENCY_KEY_CONFLICT.
- POST /reports returns a one-time anonymous receipt_code (XXXX-XXXX-XXXX-XXXX, stored only as SHA-256 hash). Citizens can track status via GET /public/reports/track with header X-Receipt-Code (no PII exposed).
- POST /admin/ingest/demo deduplicates by SHA-256 dataset checksum and returns deduplicated=true on replay.
- Public write/track endpoints (/reports*, /public/reports/track) enforce per-IP rate limiting (429 RATE_LIMITED with Retry-After).

## Base Endpoints
- GET /public/datasets?municipality_id=lima
- GET /public/expenses?municipality_id=lima&entity=...&category=...&from=YYYY-MM-DD&to=YYYY-MM-DD
- GET /public/ocds/releases.json?municipality_id=lima
- GET /public/anomalies?municipality_id=lima&threshold_cents=...
- GET /public/audit/verify
- GET /public/reports?municipality_id=lima
- GET /public/reports/track (header: X-Receipt-Code)
- GET /public/reports/{id}?municipality_id=lima
- POST /reports (supports Idempotency-Key; returns one-time receipt_code)
- POST /reports/{id}/evidence
- POST /reports/{id}/submit
- GET /moderation/cases?municipality_id=lima&status=SUBMITTED
- POST /moderation/cases/{id}/triage
- POST /moderation/cases/{id}/verify
- POST /moderation/cases/{id}/reject
- POST /moderation/reports/{id}/publish
- POST /admin/ingest/demo
`

func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, buildOpenAPISpec())
}

func (s *Server) handleLLMsTxt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, llmsTxtGuide)
}

func (s *Server) handleAgentManifest(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":                 "civictech-peru-api",
		"version":              "1.0.0",
		"openapi_url":          "/openapi.json",
		"llms_txt_url":         "/llms.txt",
		"auth_modes":           []string{"disabled", "dev_static", "oidc_jwks"},
		"municipalities":       []string{domain.DefaultMunicipalityID},
		"default_municipality": domain.DefaultMunicipalityID,
		"idempotency_header":   "Idempotency-Key",
		"receipt_header":       "X-Receipt-Code",
		"ocds_version":         "1.1",
		"money_representation": map[string]any{
			"field":               "amount_cents",
			"type":                "int64",
			"currency":            "PEN",
			"exact_decimal_field": "amount",
		},
		"report_lifecycle": map[string]any{
			"states": []string{"DRAFT", "SUBMITTED", "TRIAGED", "VERIFIED", "PUBLISHED", "REJECTED"},
			"transitions": map[string][]string{
				"DRAFT":     {"SUBMIT"},
				"SUBMITTED": {"TRIAGE", "REJECT"},
				"TRIAGED":   {"VERIFY", "REJECT"},
				"VERIFIED":  {"PUBLISH"},
				"PUBLISHED": {},
				"REJECTED":  {},
			},
		},
	})
}

func buildOpenAPISpec() map[string]any {
	muniParam := map[string]any{
		"name":        "municipality_id",
		"in":          "query",
		"required":    false,
		"description": "Municipality scope (defaults to lima)",
		"schema":      map[string]any{"type": "string", "default": domain.DefaultMunicipalityID},
	}
	idPathParam := map[string]any{
		"name":     "id",
		"in":       "path",
		"required": true,
		"schema":   map[string]any{"type": "string", "format": "uuid"},
	}
	bearerSec := []map[string]any{{"BearerAuth": []string{}}}
	errRespRef := map[string]any{"$ref": "#/components/schemas/ErrorResponse"}

	jsonContent := func(schemaRef string) map[string]any {
		return map[string]any{
			"application/json": map[string]any{
				"schema": map[string]any{"$ref": schemaRef},
			},
		}
	}
	arrayContent := func(schemaRef string) map[string]any {
		return map[string]any{
			"application/json": map[string]any{
				"schema": map[string]any{
					"type":  "array",
					"items": map[string]any{"$ref": schemaRef},
				},
			},
		}
	}

	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "CivicTech Peru API",
			"version":     "1.0.0",
			"description": "Public transparency, citizen reporting, auditable moderation, and idempotent expense ingestion API.",
		},
		"servers": []map[string]string{
			{"url": "/"},
		},
		"paths": map[string]any{
			"/health": map[string]any{
				"get": map[string]any{
					"summary": "Service health check",
					"responses": map[string]any{
						"200": map[string]any{"description": "Service is healthy"},
					},
				},
			},
			"/metrics": map[string]any{
				"get": map[string]any{
					"summary": "Prometheus metrics exposition",
					"responses": map[string]any{
						"200": map[string]any{"description": "Prometheus metrics text"},
					},
				},
			},
			"/openapi.json": map[string]any{
				"get": map[string]any{
					"summary": "OpenAPI 3.1 specification",
					"responses": map[string]any{
						"200": map[string]any{"description": "OpenAPI JSON document"},
					},
				},
			},
			"/llms.txt": map[string]any{
				"get": map[string]any{
					"summary": "Concise AI agent guide",
					"responses": map[string]any{
						"200": map[string]any{"description": "Plain-text guide"},
					},
				},
			},
			"/.well-known/agent.json": map[string]any{
				"get": map[string]any{
					"summary": "AI agent capability manifest",
					"responses": map[string]any{
						"200": map[string]any{"description": "Capability metadata JSON"},
					},
				},
			},
			"/public/datasets": map[string]any{
				"get": map[string]any{
					"summary":    "List public datasets",
					"parameters": []any{muniParam},
					"responses": map[string]any{
						"200": map[string]any{"description": "Dataset list", "content": arrayContent("#/components/schemas/Dataset")},
					},
				},
			},
			"/public/expenses": map[string]any{
				"get": map[string]any{
					"summary": "Query public municipal expenses with exact integer amount_cents",
					"parameters": []any{
						muniParam,
						map[string]any{"name": "entity", "in": "query", "schema": map[string]any{"type": "string"}},
						map[string]any{"name": "category", "in": "query", "schema": map[string]any{"type": "string"}},
						map[string]any{"name": "from", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}, "description": "Start date YYYY-MM-DD"},
						map[string]any{"name": "to", "in": "query", "schema": map[string]any{"type": "string", "format": "date"}, "description": "End date YYYY-MM-DD"},
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Expense rows", "content": arrayContent("#/components/schemas/Expense")},
						"400": map[string]any{"description": "Invalid date filter", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/public/reports": map[string]any{
				"get": map[string]any{
					"summary":    "List published citizen reports (PII redacted)",
					"parameters": []any{muniParam},
					"responses": map[string]any{
						"200": map[string]any{"description": "Published report summaries", "content": arrayContent("#/components/schemas/PublicReportSummary")},
					},
				},
			},
			"/public/reports/track": map[string]any{
				"get": map[string]any{
					"summary": "Track an anonymous citizen report using its one-time receipt code (PII-free)",
					"parameters": []any{
						muniParam,
						map[string]any{
							"name":        "X-Receipt-Code",
							"in":          "header",
							"required":    true,
							"description": "One-time anonymous receipt code formatted XXXX-XXXX-XXXX-XXXX",
							"schema":      map[string]any{"type": "string"},
						},
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Privacy-safe report status and timeline", "content": jsonContent("#/components/schemas/ReportTracking")},
						"400": map[string]any{"description": "Missing or malformed X-Receipt-Code", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"404": map[string]any{"description": "Receipt not found", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"429": map[string]any{"description": "Rate limit exceeded", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/public/reports/{id}": map[string]any{
				"get": map[string]any{
					"summary":    "Get a published citizen report detail",
					"parameters": []any{idPathParam, muniParam},
					"responses": map[string]any{
						"200": map[string]any{"description": "Published report detail", "content": jsonContent("#/components/schemas/PublicReportDetail")},
						"404": map[string]any{"description": "Report not found", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/public/audit/verify": map[string]any{
				"get": map[string]any{
					"summary": "Verify cryptographic SHA-256 audit log chain integrity via Rust engine",
					"responses": map[string]any{
						"200": map[string]any{"description": "Chain verification status", "content": jsonContent("#/components/schemas/ChainVerification")},
					},
				},
			},
			"/public/ocds/releases.json": map[string]any{
				"get": map[string]any{
					"summary":    "Export municipal expenses as an OCDS 1.1 JSON release package",
					"parameters": []any{muniParam},
					"responses": map[string]any{
						"200": map[string]any{"description": "OCDS 1.1 release package"},
					},
				},
			},
			"/public/anomalies": map[string]any{
				"get": map[string]any{
					"summary": "Detect deterministic fiscal red flags in municipal expenses via Rust engine",
					"parameters": []any{
						muniParam,
						map[string]any{"name": "threshold_cents", "in": "query", "required": false, "schema": map[string]any{"type": "integer", "format": "int64", "minimum": 1}},
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Fiscal red-flag analysis", "content": jsonContent("#/components/schemas/AnalyzeExpensesResponse")},
						"400": map[string]any{"description": "Invalid threshold_cents", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/reports": map[string]any{
				"post": map[string]any{
					"summary": "Create a draft citizen report (supports Idempotency-Key; returns one-time receipt_code)",
					"parameters": []any{
						map[string]any{
							"name":        "Idempotency-Key",
							"in":          "header",
							"required":    false,
							"description": "Optional idempotency key scoped by municipality_id and payload digest to prevent duplicate drafts on retry",
							"schema":      map[string]any{"type": "string", "maxLength": 128},
						},
					},
					"requestBody": map[string]any{
						"required": true,
						"content":  jsonContent("#/components/schemas/CreateReportRequest"),
					},
					"responses": map[string]any{
						"201": map[string]any{"description": "Draft report created with one-time receipt_code", "content": jsonContent("#/components/schemas/Report")},
						"200": map[string]any{"description": "Idempotent replay returning existing draft report", "content": jsonContent("#/components/schemas/Report")},
						"400": map[string]any{"description": "Validation error", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"409": map[string]any{"description": "Idempotency-Key reused with different payload", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"429": map[string]any{"description": "Rate limit exceeded", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/reports/{id}/evidence": map[string]any{
				"post": map[string]any{
					"summary":    "Attach evidence metadata and receive SSE-S3 presigned upload URL (DRAFT only)",
					"parameters": []any{idPathParam},
					"requestBody": map[string]any{
						"required": true,
						"content":  jsonContent("#/components/schemas/AddEvidenceRequest"),
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Presigned upload details", "content": jsonContent("#/components/schemas/AddEvidenceResponse")},
						"400": map[string]any{"description": "Validation error", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"422": map[string]any{"description": "Report not in DRAFT state", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/reports/{id}/submit": map[string]any{
				"post": map[string]any{
					"summary":    "Submit a draft report (DRAFT -> SUBMITTED)",
					"parameters": []any{idPathParam, muniParam},
					"requestBody": map[string]any{
						"required": false,
						"content":  jsonContent("#/components/schemas/MunicipalityRequest"),
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Submitted report", "content": jsonContent("#/components/schemas/Report")},
						"422": map[string]any{"description": "Invalid state transition", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/moderation/cases": map[string]any{
				"get": map[string]any{
					"summary":  "List moderation cases (MODERATOR or ADMIN)",
					"security": bearerSec,
					"parameters": []any{
						muniParam,
						map[string]any{"name": "status", "in": "query", "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{
						"200": map[string]any{"description": "Moderation cases", "content": arrayContent("#/components/schemas/ModerationCase")},
						"401": map[string]any{"description": "Unauthorized", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"403": map[string]any{"description": "Forbidden", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/moderation/cases/{id}/triage": map[string]any{
				"post": map[string]any{
					"summary":     "Triage a submitted report (SUBMITTED -> TRIAGED)",
					"security":    bearerSec,
					"parameters":  []any{idPathParam, muniParam},
					"requestBody": map[string]any{"required": true, "content": jsonContent("#/components/schemas/ModerationActionRequest")},
					"responses": map[string]any{
						"200": map[string]any{"description": "Triaged report", "content": jsonContent("#/components/schemas/Report")},
						"422": map[string]any{"description": "Invalid state transition", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/moderation/cases/{id}/verify": map[string]any{
				"post": map[string]any{
					"summary":     "Verify a triaged report (TRIAGED -> VERIFIED)",
					"security":    bearerSec,
					"parameters":  []any{idPathParam, muniParam},
					"requestBody": map[string]any{"required": true, "content": jsonContent("#/components/schemas/ModerationActionRequest")},
					"responses": map[string]any{
						"200": map[string]any{"description": "Verified report", "content": jsonContent("#/components/schemas/Report")},
						"422": map[string]any{"description": "Invalid state transition", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/moderation/cases/{id}/reject": map[string]any{
				"post": map[string]any{
					"summary":     "Reject a submitted or triaged report (SUBMITTED|TRIAGED -> REJECTED)",
					"security":    bearerSec,
					"parameters":  []any{idPathParam, muniParam},
					"requestBody": map[string]any{"required": true, "content": jsonContent("#/components/schemas/ModerationActionRequest")},
					"responses": map[string]any{
						"200": map[string]any{"description": "Rejected report", "content": jsonContent("#/components/schemas/Report")},
						"422": map[string]any{"description": "Invalid state transition", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/moderation/reports/{id}/publish": map[string]any{
				"post": map[string]any{
					"summary":     "Publish a verified report with redacted public text (VERIFIED -> PUBLISHED)",
					"security":    bearerSec,
					"parameters":  []any{idPathParam, muniParam},
					"requestBody": map[string]any{"required": true, "content": jsonContent("#/components/schemas/PublishReportRequest")},
					"responses": map[string]any{
						"200": map[string]any{"description": "Published report", "content": jsonContent("#/components/schemas/PublishReportResponse")},
						"422": map[string]any{"description": "Invalid state transition", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
			"/admin/ingest/demo": map[string]any{
				"post": map[string]any{
					"summary":     "Run idempotent demo CSV expense ingestion (ADMIN)",
					"security":    bearerSec,
					"parameters":  []any{muniParam},
					"requestBody": map[string]any{"required": false, "content": jsonContent("#/components/schemas/MunicipalityRequest")},
					"responses": map[string]any{
						"200": map[string]any{"description": "Ingest result", "content": jsonContent("#/components/schemas/IngestResult")},
						"401": map[string]any{"description": "Unauthorized", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
						"403": map[string]any{"description": "Forbidden", "content": map[string]any{"application/json": map[string]any{"schema": errRespRef}}},
					},
				},
			},
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"BearerAuth": map[string]any{
					"type":         "http",
					"scheme":       "bearer",
					"bearerFormat": "JWT",
				},
			},
			"schemas": map[string]any{
				"Dataset": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"name":            map[string]any{"type": "string"},
						"kind":            map[string]any{"type": "string"},
						"versions":        map[string]any{"type": "integer", "format": "int64"},
						"created_at":      map[string]any{"type": "string", "format": "date-time"},
					},
					"required": []string{"id", "municipality_id", "name", "kind", "versions", "created_at"},
				},
				"Expense": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"version_id":      map[string]any{"type": "string", "format": "uuid"},
						"entity":          map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string"},
						"amount_cents":    map[string]any{"type": "integer", "format": "int64", "description": "Exact integer cents"},
						"amount":          map[string]any{"type": "string", "description": "Exact decimal string formatted from amount_cents"},
						"occurred_on":     map[string]any{"type": []string{"string", "null"}, "format": "date"},
						"doc_ref":         map[string]any{"type": []string{"string", "null"}},
					},
					"required": []string{"id", "municipality_id", "version_id", "entity", "category", "amount_cents", "amount"},
				},
				"Report": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"status":          map[string]any{"type": "string", "enum": []string{"DRAFT", "SUBMITTED", "TRIAGED", "VERIFIED", "PUBLISHED", "REJECTED"}},
						"category":        map[string]any{"type": "string"},
						"description":     map[string]any{"type": "string"},
						"created_at":      map[string]any{"type": "string", "format": "date-time"},
						"receipt_code":    map[string]any{"type": "string", "description": "One-time anonymous whistleblower receipt code (returned only on 201 Created)"},
					},
					"required": []string{"id", "municipality_id", "status", "category", "description", "created_at"},
				},
				"ReportTracking": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
						"status":          map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string"},
						"created_at":      map[string]any{"type": "string", "format": "date-time"},
						"timeline": map[string]any{
							"type": "array",
							"items": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"from_status": map[string]any{"type": "string"},
									"to_status":   map[string]any{"type": "string"},
									"action":      map[string]any{"type": "string"},
									"occurred_at": map[string]any{"type": "string", "format": "date-time"},
								},
								"required": []string{"from_status", "to_status", "action", "occurred_at"},
							},
						},
					},
					"required": []string{"municipality_id", "status", "category", "created_at", "timeline"},
				},
				"ChainVerification": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"valid":          map[string]any{"type": "boolean"},
						"checked_events": map[string]any{"type": "integer"},
						"head_hash":      map[string]any{"type": "string"},
						"broken_at_seq":  map[string]any{"type": []string{"integer", "null"}, "format": "int64"},
						"reason":         map[string]any{"type": []string{"string", "null"}},
					},
					"required": []string{"valid", "checked_events", "head_hash"},
				},
				"AnalyzeExpensesResponse": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"total_expenses":     map[string]any{"type": "integer"},
						"total_amount_cents": map[string]any{"type": "integer", "format": "int64"},
						"threshold_cents":    map[string]any{"type": "integer", "format": "int64"},
						"flag_count":         map[string]any{"type": "integer"},
						"flags":              map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
					},
					"required": []string{"total_expenses", "total_amount_cents", "threshold_cents", "flag_count", "flags"},
				},
				"CreateReportRequest": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string", "maxLength": 100},
						"description":     map[string]any{"type": "string", "maxLength": 10000},
					},
					"required": []string{"category", "description"},
				},
				"AddEvidenceRequest": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
						"content_type":    map[string]any{"type": "string", "enum": []string{"application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"}},
						"size_bytes":      map[string]any{"type": "integer", "format": "int64", "minimum": 1, "maximum": 10485760},
						"sha256":          map[string]any{"type": "string"},
					},
					"required": []string{"content_type", "size_bytes"},
				},
				"AddEvidenceResponse": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"report_id":          map[string]any{"type": "string", "format": "uuid"},
						"evidence_id":        map[string]any{"type": "string", "format": "uuid"},
						"upload_url":         map[string]any{"type": "string", "format": "uri"},
						"object_key":         map[string]any{"type": "string"},
						"expires_in_seconds": map[string]any{"type": "integer", "format": "int64"},
						"upload_headers":     map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}},
					},
					"required": []string{"report_id", "evidence_id", "upload_url", "object_key", "expires_in_seconds", "upload_headers"},
				},
				"MunicipalityRequest": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
					},
				},
				"PublicReportSummary": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"report_id":       map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"status":          map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string"},
						"public_text":     map[string]any{"type": "string"},
						"published_at":    map[string]any{"type": "string", "format": "date-time"},
					},
					"required": []string{"id", "report_id", "municipality_id", "status", "category", "public_text", "published_at"},
				},
				"PublicReportDetail": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"report_id":       map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"status":          map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string"},
						"public_text":     map[string]any{"type": "string"},
						"published_at":    map[string]any{"type": "string", "format": "date-time"},
						"evidence_count":  map[string]any{"type": "integer"},
					},
					"required": []string{"id", "report_id", "municipality_id", "status", "category", "public_text", "published_at", "evidence_count"},
				},
				"ModerationCase": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"report_id":       map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"status":          map[string]any{"type": "string"},
						"category":        map[string]any{"type": "string"},
						"description":     map[string]any{"type": "string"},
						"assigned_to":     map[string]any{"type": []string{"string", "null"}},
						"notes":           map[string]any{"type": []string{"string", "null"}},
						"created_at":      map[string]any{"type": "string", "format": "date-time"},
						"updated_at":      map[string]any{"type": "string", "format": "date-time"},
					},
					"required": []string{"id", "report_id", "municipality_id", "status", "category", "description", "created_at", "updated_at"},
				},
				"ModerationActionRequest": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
						"reason":          map[string]any{"type": "string"},
					},
					"required": []string{"reason"},
				},
				"PublishReportRequest": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id": map[string]any{"type": "string"},
						"public_text":     map[string]any{"type": "string"},
						"reason":          map[string]any{"type": "string"},
					},
					"required": []string{"public_text", "reason"},
				},
				"Publication": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":              map[string]any{"type": "string", "format": "uuid"},
						"report_id":       map[string]any{"type": "string", "format": "uuid"},
						"municipality_id": map[string]any{"type": "string"},
						"public_text":     map[string]any{"type": "string"},
						"published_at":    map[string]any{"type": "string", "format": "date-time"},
					},
					"required": []string{"id", "report_id", "municipality_id", "public_text", "published_at"},
				},
				"PublishReportResponse": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"report_id":   map[string]any{"type": "string", "format": "uuid"},
						"status":      map[string]any{"type": "string"},
						"publication": map[string]any{"$ref": "#/components/schemas/Publication"},
					},
					"required": []string{"report_id", "status", "publication"},
				},
				"IngestResult": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"municipality_id":    map[string]any{"type": "string"},
						"dataset_version_id": map[string]any{"type": "string", "format": "uuid"},
						"checksum_sha256":    map[string]any{"type": "string"},
						"rows_ingested":      map[string]any{"type": "integer"},
						"deduplicated":       map[string]any{"type": "boolean"},
					},
					"required": []string{"municipality_id", "dataset_version_id", "checksum_sha256", "rows_ingested", "deduplicated"},
				},
				"ErrorResponse": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"error":     map[string]any{"type": "string"},
						"code":      map[string]any{"type": "string"},
						"retryable": map[string]any{"type": "boolean"},
						"allowed_actions": map[string]any{
							"type":  "array",
							"items": map[string]any{"type": "string"},
						},
					},
					"required": []string{"error", "code", "retryable"},
				},
			},
		},
	}
}
