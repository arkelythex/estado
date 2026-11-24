# CivicTech Perú MCP Server (`@civictech/mcp`)

Self-contained Model Context Protocol (JSON-RPC 2.0 over stdio) server running on Bun so AI agents can query public municipal transparency data, submit citizen irregularity reports, moderate cases, and trigger idempotent CSV ingestion without scraping HTML.

## Environment Variables

- `CIVICTECH_API_URL`: Base URL of the Go HTTP API (default: `http://localhost:8080`).
- `CIVICTECH_API_TOKEN`: Optional Bearer token used only for protected endpoints (`/moderation/*` requires `MODERATOR` or `ADMIN`; `/admin/ingest/demo` requires `ADMIN`). Never commit tokens in config files.

## Available Tools

| Tool | Scope / Auth | Description |
| --- | --- | --- |
| `list_datasets` | Public | List published datasets for a `municipality_id`. |
| `query_expenses` | Public | Filter municipal expenses (`entity`, `category`, `from`, `to`) returning exact integer `amount_cents` and decimal `amount`. |
| `list_public_reports` | Public | List PII-redacted published citizen reports for a `municipality_id`. |
| `get_public_report` | Public | Get a published citizen report detail including `evidence_count`. |
| `create_report` | Citizen | Create a `DRAFT` report; supports optional `idempotency_key` (`Idempotency-Key` header) and returns a one-time `receipt_code` when issued. |
| `submit_report` | Citizen | Transition a report from `DRAFT` to `SUBMITTED`. |
| `list_moderation_cases` | Moderator/Admin | List moderation cases (`municipality_id`, optional `status`). |
| `moderate_case` | Moderator/Admin | Execute `TRIAGE`, `VERIFY`, `REJECT`, or `PUBLISH` with mandatory `reason` (`PUBLISH` also requires redacted `public_text`). |
| `run_demo_ingest` | Admin | Trigger idempotent CSV demo ingestion for a `municipality_id`. |
| `verify_audit_chain` | Public | Verify cryptographic SHA-256 audit hash-chain integrity (`GET /public/audit/verify`). |
| `detect_spending_anomalies` | Public | Detect exact-integer fiscal red flags (`CONTRACT_SPLITTING`, `DUPLICATE_DISBURSEMENT`, `HIGH_ENTITY_CONCENTRATION`) for a `municipality_id` with optional positive safe integer `threshold_cents`. |
| `export_ocds_releases` | Public | Export municipal expenses as a validated OCDS 1.1 JSON release package for a `municipality_id`. |
| `track_report_by_receipt` | Citizen | Track an anonymous whistleblower report status and redacted timeline (`municipality_id`, `receipt_code` sent via `X-Receipt-Code` header). |

## Running Locally

```bash
cd services/mcp
bun test
bunx tsc --noEmit
CIVICTECH_API_URL=http://localhost:8080 bun run start
```

## Client Configuration Examples

### Claude Desktop / Cursor / Codex (`mcpServers`)

```json
{
  "mcpServers": {
    "civictech-peru": {
      "command": "bun",
      "args": ["run", "/path/to/estado/services/mcp/src/index.ts"],
      "env": {
        "CIVICTECH_API_URL": "http://localhost:8080",
        "CIVICTECH_API_TOKEN": "${CIVICTECH_API_TOKEN}"
      }
    }
  }
}
```

### Pi / CLI stdio smoke test

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1.0.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | bun run services/mcp/src/index.ts
```
