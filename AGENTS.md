# CivicTech Peru Coding Standards — GGA Review Rules

> **Última actualización**: 2026-06-29
> Estas reglas son aplicadas por Gentleman Guardian Angel (gga) en cada commit y PR.
>
> Stack: Go (HTTP API) + Rust (Critical Engines) + Bun & TanStack Start (TypeScript Frontends)
> Ámbito: civic tech, transparencia gubernamental, participación ciudadana, servicios públicos digitales

## ⛔ NON-NEGOTIABLES (MUST NOT)

These rules are absolute. Any violation causes the review to FAIL.

- **MUST NOT** leak PII, citizen data, evidence metadata, or any sensitive personal information in logs, APIs, responses, or error messages.
- **MUST NOT** bypass audit trail — every state-changing operation on reports, cases, or evidence MUST be logged with actor, timestamp, and previous state.
- **MUST NOT** introduce hardcoded secrets, tokens, API keys, or credentials in source code.
- **MUST NOT** use `any` type in TypeScript; use precise types, `unknown`, or justified generics instead.
- **MUST NOT** allow unauthenticated access to moderation, ingestion, or admin endpoints — all protected routes MUST enforce authentication.
- **MUST NOT** perform broad unsafe rewrites of audit-critical flows (report lifecycle, evidence chain, moderation) without explicit migration plan and tests.
- **MUST NOT** skip access control checks on multi-tenant or role-scoped data (citizen vs. moderator vs. admin).

## ✅ REQUIRED PRACTICES (MUST)

- **MUST** validate all API inputs at service boundaries (Go request validation / Zod schemas).
- **MUST** preserve end-to-end type safety across the full stack (Rust/Go contracts → OpenAPI → strict TypeScript).
- **MUST** add or update tests for changed behavior — domain logic MUST have unit tests.
- **MUST** update docs when public behavior, API contracts, setup, or security assumptions change.
- **MUST** prefer small, verifiable, reversible changes over large refactors.
- **MUST** log actor, action, timestamp, and resource ID for every state mutation on reports, verification cases, and evidence.
- **MUST** scope database queries by `municipality_id` or `actor_id` to prevent cross-tenant data leaks.

## 🏗️ Architecture Rules

- Use **Hexagonal Architecture (Ports & Adapters)** in both Go (`services/api`) and Rust (`crates/*`): domain core is framework-free; adapters live in `internal/adapters/*` (Go) and `crates/adapters_*` (Rust).
- Keep **critical domain engines in Rust** (`crates/domain`, `crates/verify`, `crates/ingest`, `crates/engine`) — deterministic, covered by tests, no I/O or clock in `crates/domain`.
- `crates/engine` exposes an internal HTTP service consumed by the Go backend (`services/api`) for report state-machine transitions and CSV ingestion/SHA-256/exact-money parsing.
- Go backend (`services/api`) handles public/citizen/moderation/admin HTTP routes, OIDC/RBAC auth, Postgres (parameterized `pgx` queries), S3/MinIO presigned URLs, and audit logging.
- Frontends (`apps/web`, `apps/admin`) are strict TypeScript apps built with **Bun + TanStack Start** and consume the Go API via HTTP; no direct DB access from frontend.

## 🔒 Security & Privacy Rules

- **MUST NOT** expose internal IDs (UUIDs, database keys) in public responses unless explicitly required.
- **MUST NOT** log raw request bodies or query parameters that may contain PII — use structured logging with redacted fields.
- **MUST validate and sanitize** all file uploads (evidence attachments): check MIME type, size limits, scan for malware vectors.
- **MUST implement rate limiting** on public report submission endpoints.
- **MUST** use parameterized queries via `pgx` (Go) or `sqlx` (Rust) — no raw string interpolation in SQL.
- **MUST follow least-privilege** for OIDC roles: citizen / moderator / admin scopes enforced per endpoint.
- **MUST NOT** store plaintext tokens or session secrets — use secure, HttpOnly cookies or short-lived bearer tokens.
- **MUST hash or encrypt** evidence at rest (S3 server-side encryption).

## 🧪 Testing Rules

- **MUST** write tests for new business logic (domain rules, usecase orchestration).
- **MUST** verify audit invariants in tests: every state transition must produce an audit log entry.
- **MUST prefer** Rust `#[cfg(test)]` unit tests for domain, integration tests for API endpoints.
- **MUST use** deterministic test fixtures — no timezone-dependent assertions, no shared mutable state.
- **MUST** cover error paths: invalid state transitions, unauthorized access, malformed input.
- **Next.js tests**: Vitest for unit, Playwright for E2E if applicable.

## 📐 Style & Conventions

- **MUST** use conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`.
- **MUST** keep commits atomic — one logical change per commit.
- **MUST NOT** add `Co-Authored-By` or AI attribution to commits.
- **Rust**: follow `cargo fmt` + `cargo clippy` — these are enforced in CI.
- **Go**: follow `gofmt` + `go vet` + `go test ./...` — enforced in CI.
- **TypeScript/Bun**: strict TypeScript (`strict: true`, zero `any`), `bun test`, and `bun run build`.
- **Prefer** small focused files over large monolithic ones.
- **Document unsafe or complex** logic with inline comments explaining _why_, not _what_.

## 🏛️ Civic Tech / Transparency Rules

When reviewing code that touches public-interest flows:

- **MUST** preserve the audit chain for reports: `draft → submitted → triaged → verified → published` — no skipped states.
- **MUST** redact PII in published public data (witness names, contact info, exact locations if sensitive).
- **MUST** support municipality-level scoping: all data queries must filter by `municipality_id`.
- **MUST** implement idempotent ingestion: bulk imports must be retry-safe (upsert, not duplicate).
- **MUST** keep evidence immutable after submission — no editing uploaded evidence, only appending.
- **MUST** verify that moderation actions (triage, verify, publish, reject) include an auditable reason.
- **Review**: any change to report lifecycle, evidence handling, or moderation flow needs compliance-focused tests.

## 📦 Dependency Rules

- **MUST NOT** introduce unnecessary dependencies to Rust crates or JS packages.
- **Prefer** existing patterns and libraries over new ones.
- **MUST** keep lockfiles in sync (`bun.lock` matches `package.json`, `go.sum` matches `go.mod`, `Cargo.lock` matches `Cargo.toml`).

## 🚫 REJECT (Fail Review)

The review MUST FAIL if any of these are detected:

1. Hardcoded secrets or credentials.
2. `any` type without explicit justification.
3. Missing audit log entry for state mutation on reports/cases/evidence.
4. Production `console.log` or `dbg!()` (warn first offense, fail second).
5. Missing authentication/authorization on admin or moderation endpoints.
6. Missing municipality-level scoping in multi-tenant queries.
7. PII leaked in logs, API responses, or error messages.
8. Direct DB access from frontend (Next.js server components must call API).
9. Raw SQL string interpolation without sqlx parameterized queries.
10. Report lifecycle state transitions that skip required states.
11. Missing tests for new business logic.
12. Public contract changes without docs and tests.
13. `Co-Authored-By` or AI attribution in commit messages.
14. Floating-point money or percentage calculations.
