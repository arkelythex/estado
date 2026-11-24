use axum::{
    extract::{rejection::JsonRejection, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use civictech_domain::{transition, ReportStatus, VerificationAction};
use civictech_ingest::{parse_expenses_csv_cents, sha256_hex, ExpenseRowCents};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
pub struct EngineState {
    internal_token: Arc<str>,
}

impl EngineState {
    pub fn new(internal_token: impl Into<String>) -> Self {
        Self {
            internal_token: Arc::from(internal_token.into().trim().to_string()),
        }
    }
}

pub fn app(state: EngineState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/internal/v1/reports/transition", post(transition_report))
        .route("/internal/v1/ingest/parse-expenses", post(parse_expenses))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: &'static str,
}

fn error_response(status: StatusCode, message: &'static str) -> Response {
    (status, Json(ErrorResponse { error: message })).into_response()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_authorized_internal(headers: &HeaderMap, state: &EngineState) -> bool {
    if state.internal_token.is_empty() {
        return false;
    }

    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    let token = auth_header
        .strip_prefix("Bearer ")
        .or_else(|| auth_header.strip_prefix("bearer "))
        .unwrap_or_default()
        .trim();

    !token.is_empty() && constant_time_eq(token.as_bytes(), state.internal_token.as_bytes())
}

async fn health() -> (StatusCode, Json<HealthResponse>) {
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            service: "civictech-engine",
        }),
    )
}

#[derive(Debug, Deserialize)]
struct TransitionRequest {
    current_status: String,
    action: String,
}

#[derive(Debug, Serialize)]
struct TransitionResponse {
    from_status: &'static str,
    to_status: &'static str,
    action: &'static str,
}

async fn transition_report(
    State(state): State<EngineState>,
    headers: HeaderMap,
    payload: Result<Json<TransitionRequest>, JsonRejection>,
) -> Response {
    if !is_authorized_internal(&headers, &state) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let Json(req) = match payload {
        Ok(json) => json,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid request payload"),
    };

    let from_status = match ReportStatus::parse_canonical(&req.current_status) {
        Ok(status) => status,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid report status"),
    };

    let action = match VerificationAction::parse_canonical(&req.action) {
        Ok(action) => action,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid verification action"),
    };

    match transition(from_status.clone(), action) {
        Ok(to_status) => (
            StatusCode::OK,
            Json(TransitionResponse {
                from_status: from_status.as_db_str(),
                to_status: to_status.as_db_str(),
                action: action.as_str(),
            }),
        )
            .into_response(),
        Err(_) => error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid state transition"),
    }
}

#[derive(Debug, Deserialize)]
struct ParseExpensesRequest {
    csv: String,
}

#[derive(Debug, Serialize)]
struct ParseExpensesResponse {
    checksum_sha256: String,
    row_count: usize,
    rows: Vec<ExpenseRowCents>,
}

async fn parse_expenses(
    State(state): State<EngineState>,
    headers: HeaderMap,
    payload: Result<Json<ParseExpensesRequest>, JsonRejection>,
) -> Response {
    if !is_authorized_internal(&headers, &state) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let Json(req) = match payload {
        Ok(json) => json,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid request payload"),
    };

    let checksum_sha256 = sha256_hex(req.csv.as_bytes());
    match parse_expenses_csv_cents(&req.csv) {
        Ok(rows) => (
            StatusCode::OK,
            Json(ParseExpensesResponse {
                checksum_sha256,
                row_count: rows.len(),
                rows,
            }),
        )
            .into_response(),
        Err(_) => error_response(StatusCode::BAD_REQUEST, "invalid csv input"),
    }
}

#[cfg(test)]
mod tests {
    use super::{app, EngineState};
    use axum::body::Body;
    use http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    fn test_state() -> EngineState {
        EngineState::new("test-internal-engine-token")
    }

    async fn send_json(
        state: EngineState,
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req_builder = Request::builder().method(method).uri(uri);
        if let Some(token) = bearer {
            req_builder = req_builder.header("authorization", format!("Bearer {token}"));
        }
        let req = match body {
            Some(payload) => req_builder
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("request should build"),
            None => req_builder
                .body(Body::empty())
                .expect("request should build"),
        };

        let response = app(state)
            .oneshot(req)
            .await
            .expect("router should respond");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn health_returns_ok_without_auth() {
        let (status, body) = send_json(test_state(), "GET", "/health", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "status": "ok", "service": "civictech-engine" })
        );
    }

    #[tokio::test]
    async fn internal_endpoints_reject_unauthenticated_or_wrong_token() {
        let transition_body = Some(json!({
            "current_status": "DRAFT",
            "action": "SUBMIT",
        }));
        let ingest_body = Some(json!({
            "csv": "entity,category,amount\nMuni,OBRAS,10.00\n",
        }));

        for (uri, payload) in [
            ("/internal/v1/reports/transition", transition_body),
            ("/internal/v1/ingest/parse-expenses", ingest_body),
        ] {
            let (s_missing, _) = send_json(test_state(), "POST", uri, None, payload.clone()).await;
            assert_eq!(s_missing, StatusCode::UNAUTHORIZED);

            let (s_wrong, _) = send_json(
                test_state(),
                "POST",
                uri,
                Some("wrong-token"),
                payload.clone(),
            )
            .await;
            assert_eq!(s_wrong, StatusCode::UNAUTHORIZED);

            let (s_empty_cfg, _) = send_json(
                EngineState::new(""),
                "POST",
                uri,
                Some("test-internal-engine-token"),
                payload,
            )
            .await;
            assert_eq!(s_empty_cfg, StatusCode::UNAUTHORIZED);
        }
    }

    #[tokio::test]
    async fn valid_report_transitions_succeed() {
        let cases = [
            ("DRAFT", "SUBMIT", "SUBMITTED"),
            ("SUBMITTED", "TRIAGE", "TRIAGED"),
            ("TRIAGED", "VERIFY", "VERIFIED"),
            ("VERIFIED", "PUBLISH", "PUBLISHED"),
            ("SUBMITTED", "REJECT", "REJECTED"),
            ("TRIAGED", "REJECT", "REJECTED"),
            ("draft", "submit", "SUBMITTED"),
        ];

        for (from, action, expected_to) in cases {
            let (status, body) = send_json(
                test_state(),
                "POST",
                "/internal/v1/reports/transition",
                Some("test-internal-engine-token"),
                Some(json!({
                    "current_status": from,
                    "action": action,
                })),
            )
            .await;

            assert_eq!(status, StatusCode::OK, "failed case {from} -> {action}");
            assert_eq!(body["from_status"], from.to_ascii_uppercase());
            assert_eq!(body["to_status"], expected_to);
            assert_eq!(body["action"], action.to_ascii_uppercase());
        }
    }

    #[tokio::test]
    async fn invalid_skipped_transition_returns_422() {
        let (status, body) = send_json(
            test_state(),
            "POST",
            "/internal/v1/reports/transition",
            Some("test-internal-engine-token"),
            Some(json!({
                "current_status": "DRAFT",
                "action": "PUBLISH",
            })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid state transition");
    }

    #[tokio::test]
    async fn invalid_enum_in_transition_returns_sanitized_400() {
        let (status, body) = send_json(
            test_state(),
            "POST",
            "/internal/v1/reports/transition",
            Some("test-internal-engine-token"),
            Some(json!({
                "current_status": "SENSITIVE_PII_VALUE",
                "action": "SUBMIT",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid report status");
        assert!(!body.to_string().contains("SENSITIVE_PII_VALUE"));

        let (status2, body2) = send_json(
            test_state(),
            "POST",
            "/internal/v1/reports/transition",
            Some("test-internal-engine-token"),
            Some(json!({
                "current_status": "DRAFT",
                "action": "SENSITIVE_ACTION_PII",
            })),
        )
        .await;
        assert_eq!(status2, StatusCode::BAD_REQUEST);
        assert_eq!(body2["error"], "invalid verification action");
        assert!(!body2.to_string().contains("SENSITIVE_ACTION_PII"));
    }

    #[tokio::test]
    async fn parse_expenses_returns_exact_cents_and_deterministic_checksum() {
        let csv = "entity,category,amount,occurred_on,doc_ref\nMunicipio Demo,OBRAS,123.45,2026-02-01,DOC-1\nMunicipio Demo,SERVICIOS,100,2026-02-02,\n";

        let (status1, body1) = send_json(
            test_state(),
            "POST",
            "/internal/v1/ingest/parse-expenses",
            Some("test-internal-engine-token"),
            Some(json!({ "csv": csv })),
        )
        .await;
        let (status2, body2) = send_json(
            test_state(),
            "POST",
            "/internal/v1/ingest/parse-expenses",
            Some("test-internal-engine-token"),
            Some(json!({ "csv": csv })),
        )
        .await;

        assert_eq!(status1, StatusCode::OK);
        assert_eq!(status2, StatusCode::OK);
        assert_eq!(body1["checksum_sha256"], body2["checksum_sha256"]);
        assert_eq!(body1["checksum_sha256"].as_str().map(str::len), Some(64));
        assert_eq!(body1["row_count"], 2);
        assert_eq!(
            body1["rows"],
            json!([
                {
                    "entity": "Municipio Demo",
                    "category": "OBRAS",
                    "amount_cents": 12345,
                    "occurred_on": "2026-02-01",
                    "doc_ref": "DOC-1"
                },
                {
                    "entity": "Municipio Demo",
                    "category": "SERVICIOS",
                    "amount_cents": 10000,
                    "occurred_on": "2026-02-02",
                    "doc_ref": null
                }
            ])
        );
    }

    #[tokio::test]
    async fn parse_expenses_rejects_invalid_csv_or_amount_with_sanitized_400() {
        for bad_csv in [
            "",
            "bad_header\n1\n",
            "entity,category,amount\nMuni,OBRAS,-10.00\n",
            "entity,category,amount\nMuni,OBRAS,12.345\n",
            "entity,category,amount\nMuni,OBRAS,SECRET_PII_TOKEN\n",
        ] {
            let (status, body) = send_json(
                test_state(),
                "POST",
                "/internal/v1/ingest/parse-expenses",
                Some("test-internal-engine-token"),
                Some(json!({ "csv": bad_csv })),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "expected 400 for {bad_csv:?}"
            );
            assert_eq!(body["error"], "invalid csv input");
            assert!(!body.to_string().contains("SECRET_PII_TOKEN"));
        }
    }
}
