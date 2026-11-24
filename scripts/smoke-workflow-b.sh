#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
MUNICIPALITY_ID="${MUNICIPALITY_ID:-lima}"
REQUIRE_AUDIT_DB_CHECK="${REQUIRE_AUDIT_DB_CHECK:-1}"
ADMIN_TOKEN="${ADMIN_TOKEN:-${AUTH_DEV_ADMIN_TOKEN:-}}"
MOD_TOKEN="${MOD_TOKEN:-${AUTH_DEV_MODERATOR_TOKEN:-}}"

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "missing required token: set ADMIN_TOKEN or AUTH_DEV_ADMIN_TOKEN" >&2
  exit 1
fi

if [[ -z "$MOD_TOKEN" ]]; then
  echo "missing required moderator token: set MOD_TOKEN or AUTH_DEV_MODERATOR_TOKEN" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl

json_field() {
  local key="$1"
  local payload="$2"

  if command -v jq >/dev/null 2>&1; then
    echo "$payload" | jq -r ".$key"
    return
  fi

  echo "$payload" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local token="${4:-}"
  local tmp
  tmp="$(mktemp)"

  local -a headers=()
  if [[ -n "$token" ]]; then
    headers+=(-H "authorization: Bearer $token")
  fi

  local status
  if [[ -n "$body" ]]; then
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path" "${headers[@]}" -H "content-type: application/json" -d "$body")"
  else
    status="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path" "${headers[@]}")"
  fi

  local response
  response="$(<"$tmp")"
  rm -f "$tmp"
  echo "$status|$response"
}

expect_status() {
  local expected="$1"
  local got_line="$2"
  local got_status="${got_line%%|*}"
  if [[ "$got_status" != "$expected" ]]; then
    echo "unexpected status: expected $expected got $got_status" >&2
    exit 1
  fi
}

verify_audit_trail() {
  local report_id="$1"
  local expected_actions_csv="$2"

  if [[ ! "$report_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "audit verification failed: invalid report_id format" >&2
    exit 1
  fi

  local compose_file="infra/docker-compose.yml"
  if [[ ! -f "$compose_file" ]]; then
    compose_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/docker-compose.yml"
  fi

  local -a psql_cmd=()
  if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq -c "SELECT 1;" >/dev/null 2>&1; then
      psql_cmd=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq)
    fi
  fi

  if [[ ${#psql_cmd[@]} -eq 0 ]] && command -v docker >/dev/null 2>&1 && [[ -f "$compose_file" ]]; then
    if docker compose -f "$compose_file" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-civictech}" -v ON_ERROR_STOP=1 -Atq -c "SELECT 1;" >/dev/null 2>&1; then
      psql_cmd=(docker compose -f "$compose_file" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-civictech}" -v ON_ERROR_STOP=1 -Atq)
    fi
  fi

  if [[ ${#psql_cmd[@]} -eq 0 ]]; then
    if [[ "${REQUIRE_AUDIT_DB_CHECK:-1}" != "0" ]]; then
      echo "audit DB verification required (REQUIRE_AUDIT_DB_CHECK=${REQUIRE_AUDIT_DB_CHECK:-1}) but Postgres is not reachable via DATABASE_URL/psql or docker compose" >&2
      exit 1
    fi
    echo "[audit] skipping DB audit_events verification (Postgres not reachable via DATABASE_URL/psql or docker compose)"
    return 0
  fi

  local invalid_audit_rows=""
  if ! invalid_audit_rows="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM audit_events ae
JOIN reports r ON r.id::text = COALESCE(ae.metadata->>'report_id', ae.target_id) AND r.municipality_id = :'municipality_id'
WHERE (ae.target_id = :'report_id' OR ae.metadata->>'report_id' = :'report_id')
  AND (
    ae.actor_type IS NULL OR btrim(ae.actor_type) = ''
    OR ae.actor_id IS NULL OR btrim(ae.actor_id) = ''
    OR ae.occurred_at IS NULL
    OR ae.action IS NULL OR btrim(ae.action) = ''
  );
SQL
  )"; then
    echo "audit verification query failed for audit_events invariants" >&2
    exit 1
  fi
  if [[ "$invalid_audit_rows" != "0" ]]; then
    echo "audit invariant failed: found $invalid_audit_rows audit_events row(s) with null/empty actor_type, actor_id, occurred_at, or action for report $report_id" >&2
    exit 1
  fi

  local invalid_status_rows=""
  if ! invalid_status_rows="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM report_status_events rse
JOIN reports r ON r.id = rse.report_id AND r.municipality_id = :'municipality_id'
WHERE rse.report_id = :'report_id'::uuid
  AND (
    rse.from_status IS NULL OR btrim(rse.from_status) = ''
    OR rse.to_status IS NULL OR btrim(rse.to_status) = ''
    OR rse.action IS NULL OR btrim(rse.action) = ''
    OR rse.actor_id IS NULL OR btrim(rse.actor_id) = ''
    OR rse.reason IS NULL OR btrim(rse.reason) = ''
    OR rse.occurred_at IS NULL
  );
SQL
  )"; then
    echo "audit verification query failed for report_status_events invariants" >&2
    exit 1
  fi
  if [[ "$invalid_status_rows" != "0" ]]; then
    echo "audit invariant failed: found $invalid_status_rows report_status_events row(s) with missing from_status, to_status, action, actor_id, or reason for report $report_id" >&2
    exit 1
  fi

  local -a expected_actions=()
  IFS=',' read -ra expected_actions <<< "$expected_actions_csv"

  local expected_status_events=0
  local item=""
  for item in "${expected_actions[@]}"; do
    item="${item//[[:space:]]/}"
    if [[ -z "$item" ]]; then
      continue
    fi
    if [[ ! "$item" =~ ^[A-Za-z0-9_]+$ ]]; then
      echo "audit verification failed: invalid action token '$item'" >&2
      exit 1
    fi

    local action=""
    local expected_from=""
    local expected_to=""
    local audit_count=""

    case "$item" in
      SUBMIT)
        action="SUBMIT"
        expected_from="DRAFT"
        expected_to="SUBMITTED"
        ;;
      TRIAGE)
        action="TRIAGE"
        expected_from="SUBMITTED"
        expected_to="TRIAGED"
        ;;
      VERIFY)
        action="VERIFY"
        expected_from="TRIAGED"
        expected_to="VERIFIED"
        ;;
      REJECT)
        action="REJECT"
        expected_from="SUBMITTED"
        expected_to="REJECTED"
        ;;
      PUBLISH|report_publish)
        action="PUBLISH"
        expected_from="VERIFIED"
        expected_to="PUBLISHED"
        ;;
      evidence_attach)
        if ! audit_count="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM audit_events ae
JOIN reports r ON r.id::text = COALESCE(ae.metadata->>'report_id', ae.target_id) AND r.municipality_id = :'municipality_id'
WHERE ae.action = 'evidence_attach'
  AND (ae.target_id = :'report_id' OR ae.metadata->>'report_id' = :'report_id')
  AND ae.actor_type IS NOT NULL AND btrim(ae.actor_type) <> ''
  AND ae.actor_id IS NOT NULL AND btrim(ae.actor_id) <> ''
  AND ae.occurred_at IS NOT NULL;
SQL
        )"; then
          echo "audit verification query failed for action '$item'" >&2
          exit 1
        fi
        ;;
      *)
        if ! audit_count="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" -v action="$item" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM audit_events ae
JOIN reports r ON r.id::text = COALESCE(ae.metadata->>'report_id', ae.target_id) AND r.municipality_id = :'municipality_id'
WHERE ae.target_id = :'report_id'
  AND ae.action = :'action'
  AND ae.actor_type IS NOT NULL AND btrim(ae.actor_type) <> ''
  AND ae.actor_id IS NOT NULL AND btrim(ae.actor_id) <> ''
  AND ae.occurred_at IS NOT NULL;
SQL
        )"; then
          echo "audit verification query failed for action '$item'" >&2
          exit 1
        fi
        ;;
    esac

    if [[ -n "$action" ]]; then
      if [[ "$action" == "PUBLISH" ]]; then
        if ! audit_count="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" -v action="$action" -v from_status="$expected_from" -v to_status="$expected_to" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM audit_events ae
JOIN reports r ON r.id::text = COALESCE(ae.metadata->>'report_id', ae.target_id) AND r.municipality_id = :'municipality_id'
WHERE ae.target_id = :'report_id'
  AND ae.action = 'report_publish'
  AND ae.metadata->>'from_status' = :'from_status'
  AND ae.metadata->>'to_status' = :'to_status'
  AND ae.actor_type IS NOT NULL AND btrim(ae.actor_type) <> ''
  AND ae.actor_id IS NOT NULL AND btrim(ae.actor_id) <> ''
  AND ae.occurred_at IS NOT NULL;
SQL
        )"; then
          echo "audit verification query failed for action '$item'" >&2
          exit 1
        fi
      else
        if ! audit_count="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" -v action="$action" -v from_status="$expected_from" -v to_status="$expected_to" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM audit_events ae
JOIN reports r ON r.id::text = COALESCE(ae.metadata->>'report_id', ae.target_id) AND r.municipality_id = :'municipality_id'
WHERE ae.target_id = :'report_id'
  AND ae.action = 'report_transition'
  AND ae.metadata->>'action' = :'action'
  AND ae.metadata->>'from_status' = :'from_status'
  AND ae.metadata->>'to_status' = :'to_status'
  AND ae.actor_type IS NOT NULL AND btrim(ae.actor_type) <> ''
  AND ae.actor_id IS NOT NULL AND btrim(ae.actor_id) <> ''
  AND ae.occurred_at IS NOT NULL;
SQL
        )"; then
          echo "audit verification query failed for action '$item'" >&2
          exit 1
        fi
      fi
    fi

    if [[ -z "$audit_count" || "$audit_count" -lt 1 ]]; then
      echo "audit invariant failed: missing audit_events row for action '$item' on report $report_id" >&2
      exit 1
    fi

    if [[ -n "$action" ]]; then
      expected_status_events=$((expected_status_events + 1))
      local status_count=""
      if ! status_count="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" -v action="$action" -v from_status="$expected_from" -v to_status="$expected_to" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM report_status_events rse
JOIN reports r ON r.id = rse.report_id AND r.municipality_id = :'municipality_id'
WHERE rse.report_id = :'report_id'::uuid
  AND rse.action = :'action'
  AND rse.from_status = :'from_status'
  AND rse.to_status = :'to_status'
  AND rse.actor_id IS NOT NULL AND btrim(rse.actor_id) <> ''
  AND btrim(rse.reason) <> '';
SQL
      )"; then
        echo "audit verification query failed for report_status_events action '$action'" >&2
        exit 1
      fi
      if [[ -z "$status_count" || "$status_count" -ne 1 ]]; then
        echo "audit invariant failed: expected 1 report_status_events row for action '$action' ($expected_from -> $expected_to) on report $report_id, got ${status_count:-0}" >&2
        exit 1
      fi
    fi
  done

  if [[ "$expected_status_events" -gt 0 ]]; then
    local total_status_events=""
    if ! total_status_events="$("${psql_cmd[@]}" -v report_id="$report_id" -v municipality_id="$MUNICIPALITY_ID" <<'SQL' | tr -d '[:space:]'
SELECT count(*)
FROM report_status_events rse
JOIN reports r ON r.id = rse.report_id AND r.municipality_id = :'municipality_id'
WHERE rse.report_id = :'report_id'::uuid;
SQL
    )"; then
      echo "audit verification query failed for report_status_events count" >&2
      exit 1
    fi
    if [[ -z "$total_status_events" || "$total_status_events" -ne "$expected_status_events" ]]; then
      echo "audit invariant failed: expected $expected_status_events report_status_events row(s) for report $report_id, got ${total_status_events:-0}" >&2
      exit 1
    fi
  fi
}

echo "[workflow-b] create report"
create_resp="$(request POST /reports '{"municipality_id":"'"$MUNICIPALITY_ID"'","category":"OBRAS","description":"Workflow B integration"}')"
expect_status 201 "$create_resp"
report_id="$(json_field id "${create_resp#*|}")"

if [[ -z "$report_id" || "$report_id" == "null" ]]; then
  echo "failed to parse report id (http_status=${create_resp%%|*})" >&2
  exit 1
fi

echo "[workflow-b] invalid transition: TRIAGE before SUBMIT should fail with 422"
triage_before_submit="$(request POST "/moderation/cases/$report_id/triage" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Invalid triage before submit"}' "$MOD_TOKEN")"
expect_status 422 "$triage_before_submit"

echo "[workflow-b] attach evidence"
evidence_resp="$(request POST "/reports/$report_id/evidence" '{"municipality_id":"'"$MUNICIPALITY_ID"'","content_type":"application/pdf","size_bytes":1024,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}')"
expect_status 200 "$evidence_resp"

echo "[workflow-b] submit"
submit_resp="$(request POST "/reports/$report_id/submit" '{"municipality_id":"'"$MUNICIPALITY_ID"'"}')"
expect_status 200 "$submit_resp"

echo "[workflow-b] invalid transition: PUBLISH before VERIFY should fail with 422"
publish_before_verify="$(request POST "/moderation/reports/$report_id/publish" '{"municipality_id":"'"$MUNICIPALITY_ID"'","public_text":"too early","reason":"Invalid publish before verify"}' "$MOD_TOKEN")"
expect_status 422 "$publish_before_verify"

echo "[workflow-b] malformed JSON and blank reason on triage should fail with 400 without state mutation"
malformed_triage="$(request POST "/moderation/cases/$report_id/triage" '{malformed' "$MOD_TOKEN")"
expect_status 400 "$malformed_triage"
blank_reason_triage="$(request POST "/moderation/cases/$report_id/triage" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"   "}' "$MOD_TOKEN")"
expect_status 400 "$blank_reason_triage"
verify_audit_trail "$report_id" "report_create,evidence_attach,SUBMIT"

echo "[workflow-b] triage + verify + publish"
triage_resp="$(request POST "/moderation/cases/$report_id/triage" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Workflow B triage"}' "$MOD_TOKEN")"
expect_status 200 "$triage_resp"
verify_resp="$(request POST "/moderation/cases/$report_id/verify" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Workflow B verification"}' "$MOD_TOKEN")"
expect_status 200 "$verify_resp"
publish_resp="$(request POST "/moderation/reports/$report_id/publish" '{"municipality_id":"'"$MUNICIPALITY_ID"'","public_text":"Workflow B published","reason":"Workflow B publication"}' "$MOD_TOKEN")"
expect_status 200 "$publish_resp"

echo "[workflow-b] cross-municipality public report access should fail with 404"
cross_municipality_id="arequipa"
if [[ "$MUNICIPALITY_ID" == "arequipa" ]]; then
  cross_municipality_id="cusco"
fi
cross_muni_resp="$(request GET "/public/reports/$report_id?municipality_id=$cross_municipality_id")"
expect_status 404 "$cross_muni_resp"

echo "[workflow-b] invalid transition: VERIFY after PUBLISH should fail with 422"
verify_after_publish="$(request POST "/moderation/cases/$report_id/verify" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Invalid verify after publish"}' "$MOD_TOKEN")"
expect_status 422 "$verify_after_publish"

echo "[workflow-b] reject path"
reject_create_resp="$(request POST /reports '{"municipality_id":"'"$MUNICIPALITY_ID"'","category":"SERVICIOS","description":"Workflow B reject integration"}')"
expect_status 201 "$reject_create_resp"
reject_id="$(json_field id "${reject_create_resp#*|}")"
if [[ -z "$reject_id" || "$reject_id" == "null" ]]; then
  echo "failed to parse reject report id (http_status=${reject_create_resp%%|*})" >&2
  exit 1
fi
expect_status 200 "$(request POST "/reports/$reject_id/submit" '{"municipality_id":"'"$MUNICIPALITY_ID"'"}')"
expect_status 200 "$(request POST "/moderation/cases/$reject_id/reject" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Insufficient supporting evidence"}' "$MOD_TOKEN")"
expect_status 422 "$(request POST "/moderation/cases/$reject_id/triage" '{"municipality_id":"'"$MUNICIPALITY_ID"'","reason":"Invalid triage after reject"}' "$MOD_TOKEN")"

echo "[workflow-b] metrics should expose transition and HTTP request families"
metrics_resp="$(request GET /metrics)"
expect_status 200 "$metrics_resp"
metrics_payload="${metrics_resp#*|}"

if ! echo "$metrics_payload" | grep -q "civictech_report_transitions_total"; then
  echo "missing civictech_report_transitions_total in /metrics" >&2
  exit 1
fi

if ! echo "$metrics_payload" | grep -q "civictech_http_requests_total"; then
  echo "missing civictech_http_requests_total in /metrics" >&2
  exit 1
fi

verify_audit_trail "$report_id" "report_create,evidence_attach,SUBMIT,TRIAGE,VERIFY,report_publish"
verify_audit_trail "$reject_id" "report_create,SUBMIT,REJECT"

echo "[workflow-b] all checks passed"
