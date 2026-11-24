export interface Dataset {
  id: string;
  municipality_id: string;
  name: string;
  kind: string;
  versions: number;
  created_at: string;
}

export interface Expense {
  id: string;
  municipality_id: string;
  entity: string;
  category: string;
  amount_cents: number;
  amount: string;
  occurred_on: string | null;
  doc_ref: string | null;
}

export interface PublicReportSummary {
  id: string;
  municipality_id: string;
  status: string;
  category: string;
  public_text: string;
  published_at: string;
}

export interface PublicReportDetail extends PublicReportSummary {
  evidence_count: number;
}

export interface Report {
  id: string;
  municipality_id: string;
  status: string;
  category: string;
  description: string;
  created_at: string;
}

export interface ModerationCase {
  id: string;
  report_id: string;
  municipality_id: string;
  status: string;
  category: string;
  description: string;
  assigned_to: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Publication {
  id: string;
  report_id: string;
  municipality_id: string;
  public_text: string;
  published_at: string;
}

export interface PublishReportResponse {
  report_id: string;
  status: string;
  publication: Publication;
}

export interface IngestResult {
  municipality_id: string;
  dataset_version_id: string;
  checksum_sha256: string;
  rows_ingested: number;
  deduplicated: boolean;
}

export interface QueryExpensesParams {
  municipality_id: string;
  entity?: string | undefined;
  category?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface CreateReportParams {
  municipality_id: string;
  category: string;
  description: string;
  idempotency_key?: string | undefined;
}

export interface ListModerationCasesParams {
  municipality_id: string;
  status?: string | undefined;
}

export type ModerationAction = "TRIAGE" | "VERIFY" | "REJECT" | "PUBLISH";

export interface ModerateCaseParams {
  id: string;
  municipality_id: string;
  action: ModerationAction;
  reason: string;
  public_text?: string | undefined;
}

export interface CivicTechApiErrorDetails {
  status: number;
  code: string;
  retryable: boolean;
  allowed_actions?: string[] | undefined;
}

export class CivicTechApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly allowedActions?: string[] | undefined;

  constructor(message: string, details: CivicTechApiErrorDetails) {
    super(message);
    this.name = "CivicTechApiError";
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable;
    if (details.allowed_actions !== undefined) {
      this.allowedActions = details.allowed_actions;
    }
  }

  toSanitizedPayload(): {
    error: string;
    status: number;
    code: string;
    retryable: boolean;
    allowed_actions?: string[];
  } {
    const payload: {
      error: string;
      status: number;
      code: string;
      retryable: boolean;
      allowed_actions?: string[];
    } = {
      error: this.message,
      status: this.status,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.allowedActions !== undefined) {
      payload.allowed_actions = this.allowedActions;
    }
    return payload;
  }
}

export interface CivicTechClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

const DEFAULT_API_URL = "http://localhost:8080";
const MAX_ERROR_MESSAGE_LEN = 240;

const ALLOWED_API_CODES = new Set([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATE_TRANSITION",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

const ALLOWED_REPORT_ACTIONS = new Set([
  "SUBMIT",
  "TRIAGE",
  "VERIFY",
  "REJECT",
  "PUBLISH",
]);

function safeStatusError(status: number): { code: string; message: string } {
  switch (status) {
    case 400:
      return { code: "VALIDATION_ERROR", message: "CivicTech API validation error (HTTP 400)" };
    case 401:
      return { code: "UNAUTHORIZED", message: "CivicTech API unauthorized (HTTP 401)" };
    case 403:
      return { code: "FORBIDDEN", message: "CivicTech API forbidden (HTTP 403)" };
    case 404:
      return { code: "NOT_FOUND", message: "CivicTech API resource not found (HTTP 404)" };
    case 409:
      return { code: "CONFLICT", message: "CivicTech API conflict (HTTP 409)" };
    case 422:
      return {
        code: "INVALID_STATE_TRANSITION",
        message: "CivicTech API rejected request or state transition (HTTP 422)",
      };
    case 429:
      return { code: "RATE_LIMITED", message: "CivicTech API rate limit exceeded (HTTP 429)" };
    default:
      if (status >= 500) {
        return {
          code: "INTERNAL_ERROR",
          message: `CivicTech API internal server error (HTTP ${status})`,
        };
      }
      return {
        code: `HTTP_${status}`,
        message: `CivicTech API returned HTTP ${status}`,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function decodeDataset(value: unknown): Dataset | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.municipality_id) ||
    !isString(value.name) ||
    !isString(value.kind) ||
    !isNumber(value.versions) ||
    !isString(value.created_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    municipality_id: value.municipality_id,
    name: value.name,
    kind: value.kind,
    versions: value.versions,
    created_at: value.created_at,
  };
}

function decodeExpense(value: unknown): Expense | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.municipality_id) ||
    !isString(value.version_id) ||
    !isString(value.entity) ||
    !isString(value.category) ||
    typeof value.amount_cents !== "number" ||
    !Number.isSafeInteger(value.amount_cents) ||
    !isString(value.amount) ||
    !isNullableString(value.occurred_on) ||
    !isNullableString(value.doc_ref)
  ) {
    return null;
  }
  return {
    id: value.id,
    municipality_id: value.municipality_id,
    entity: value.entity,
    category: value.category,
    amount_cents: value.amount_cents,
    amount: value.amount,
    occurred_on: value.occurred_on,
    doc_ref: value.doc_ref,
  };
}

function decodePublicReportSummary(value: unknown): PublicReportSummary | null {
  if (!isRecord(value)) return null;
  const publicId =
    isString(value.report_id) && value.report_id.trim().length > 0
      ? value.report_id
      : isString(value.id)
        ? value.id
        : null;
  if (
    publicId === null ||
    !isString(value.municipality_id) ||
    !isString(value.status) ||
    !isString(value.category) ||
    !isString(value.public_text) ||
    !isString(value.published_at)
  ) {
    return null;
  }
  return {
    id: publicId,
    municipality_id: value.municipality_id,
    status: value.status,
    category: value.category,
    public_text: value.public_text,
    published_at: value.published_at,
  };
}

function decodePublicReportDetail(value: unknown): PublicReportDetail | null {
  const summary = decodePublicReportSummary(value);
  if (summary === null || !isRecord(value) || !isNumber(value.evidence_count)) {
    return null;
  }
  return {
    ...summary,
    evidence_count: value.evidence_count,
  };
}

function decodeReport(value: unknown): Report | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.municipality_id) ||
    !isString(value.status) ||
    !isString(value.category) ||
    !isString(value.description) ||
    !isString(value.created_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    municipality_id: value.municipality_id,
    status: value.status,
    category: value.category,
    description: value.description,
    created_at: value.created_at,
  };
}

function decodeModerationCase(value: unknown): ModerationCase | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.report_id) ||
    !isString(value.municipality_id) ||
    !isString(value.status) ||
    !isString(value.category) ||
    !isString(value.description) ||
    !isNullableString(value.assigned_to) ||
    !isNullableString(value.notes) ||
    !isString(value.created_at) ||
    !isString(value.updated_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    report_id: value.report_id,
    municipality_id: value.municipality_id,
    status: value.status,
    category: value.category,
    description: value.description,
    assigned_to: value.assigned_to,
    notes: value.notes,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function decodePublication(value: unknown): Publication | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    !isString(value.report_id) ||
    !isString(value.municipality_id) ||
    !isString(value.public_text) ||
    !isString(value.published_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    report_id: value.report_id,
    municipality_id: value.municipality_id,
    public_text: value.public_text,
    published_at: value.published_at,
  };
}

function decodePublishReportResponse(value: unknown): PublishReportResponse | null {
  if (!isRecord(value) || !isString(value.report_id) || !isString(value.status)) {
    return null;
  }
  const publication = decodePublication(value.publication);
  if (publication === null) {
    return null;
  }
  return {
    report_id: value.report_id,
    status: value.status,
    publication,
  };
}

function decodeIngestResult(value: unknown): IngestResult | null {
  if (!isRecord(value)) return null;
  if (
    !isString(value.municipality_id) ||
    !isString(value.dataset_version_id) ||
    !isString(value.checksum_sha256) ||
    !isNumber(value.rows_ingested) ||
    !isBoolean(value.deduplicated)
  ) {
    return null;
  }
  return {
    municipality_id: value.municipality_id,
    dataset_version_id: value.dataset_version_id,
    checksum_sha256: value.checksum_sha256,
    rows_ingested: value.rows_ingested,
    deduplicated: value.deduplicated,
  };
}

function decodeArray<T>(decodeItem: (item: unknown) => T | null): (value: unknown) => T[] | null {
  return (value: unknown): T[] | null => {
    if (!Array.isArray(value)) return null;
    const result: T[] = [];
    for (const item of value) {
      const decoded = decodeItem(item);
      if (decoded === null) return null;
      result.push(decoded);
    }
    return result;
  };
}

function sanitizeText(raw: string, tokenToRedact?: string): string {
  let clean = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (tokenToRedact && tokenToRedact.length > 0) {
    clean = clean.split(tokenToRedact).join("[REDACTED]");
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  if (clean.length > MAX_ERROR_MESSAGE_LEN) {
    clean = `${clean.slice(0, MAX_ERROR_MESSAGE_LEN)}...`;
  }
  return clean;
}

function normalizeBaseUrl(rawUrl: string | undefined): string {
  const candidate = (rawUrl ?? DEFAULT_API_URL).trim() || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CivicTechApiError("Invalid CIVICTECH_API_URL", {
      status: 0,
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CivicTechApiError("CIVICTECH_API_URL must use https (or http for loopback only)", {
      status: 0,
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new CivicTechApiError("CIVICTECH_API_URL must use https for non-loopback hosts", {
      status: 0,
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CivicTechApiError("CIVICTECH_API_URL must not embed credentials", {
      status: 0,
      code: "CONFIGURATION_ERROR",
      retryable: false,
    });
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class CivicTechClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: CivicTechClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.CIVICTECH_API_URL);
    const rawToken = options.token ?? process.env.CIVICTECH_API_TOKEN;
    const trimmedToken = rawToken?.trim();
    this.token = trimmedToken && trimmedToken.length > 0 ? trimmedToken : undefined;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async listDatasets(municipalityId: string): Promise<Dataset[]> {
    const query = new URLSearchParams({ municipality_id: municipalityId });
    return this.request(
      "GET",
      `/public/datasets?${query.toString()}`,
      { requiresAuth: false },
      decodeArray(decodeDataset),
    );
  }

  async queryExpenses(params: QueryExpensesParams): Promise<Expense[]> {
    const query = new URLSearchParams({ municipality_id: params.municipality_id });
    if (params.entity !== undefined && params.entity !== "") {
      query.set("entity", params.entity);
    }
    if (params.category !== undefined && params.category !== "") {
      query.set("category", params.category);
    }
    if (params.from !== undefined && params.from !== "") {
      query.set("from", params.from);
    }
    if (params.to !== undefined && params.to !== "") {
      query.set("to", params.to);
    }
    return this.request(
      "GET",
      `/public/expenses?${query.toString()}`,
      { requiresAuth: false },
      decodeArray(decodeExpense),
    );
  }

  async listPublicReports(municipalityId: string): Promise<PublicReportSummary[]> {
    const query = new URLSearchParams({ municipality_id: municipalityId });
    return this.request(
      "GET",
      `/public/reports?${query.toString()}`,
      { requiresAuth: false },
      decodeArray(decodePublicReportSummary),
    );
  }

  async getPublicReport(id: string, municipalityId: string): Promise<PublicReportDetail> {
    const query = new URLSearchParams({ municipality_id: municipalityId });
    return this.request(
      "GET",
      `/public/reports/${encodeURIComponent(id)}?${query.toString()}`,
      { requiresAuth: false },
      decodePublicReportDetail,
    );
  }

  async createReport(params: CreateReportParams): Promise<Report> {
    return this.request(
      "POST",
      "/reports",
      {
        requiresAuth: false,
        idempotencyKey: params.idempotency_key,
        body: {
          municipality_id: params.municipality_id,
          category: params.category,
          description: params.description,
        },
      },
      decodeReport,
    );
  }

  async submitReport(id: string, municipalityId: string): Promise<Report> {
    const query = new URLSearchParams({ municipality_id: municipalityId });
    return this.request(
      "POST",
      `/reports/${encodeURIComponent(id)}/submit?${query.toString()}`,
      {
        requiresAuth: false,
        body: { municipality_id: municipalityId },
      },
      decodeReport,
    );
  }

  async listModerationCases(params: ListModerationCasesParams): Promise<ModerationCase[]> {
    const query = new URLSearchParams({ municipality_id: params.municipality_id });
    if (params.status !== undefined && params.status !== "") {
      query.set("status", params.status);
    }
    return this.request(
      "GET",
      `/moderation/cases?${query.toString()}`,
      { requiresAuth: true },
      decodeArray(decodeModerationCase),
    );
  }

  async moderateCase(params: ModerateCaseParams): Promise<Report | PublishReportResponse> {
    const query = new URLSearchParams({ municipality_id: params.municipality_id });
    const encodedId = encodeURIComponent(params.id);

    if (params.action === "PUBLISH") {
      return this.request(
        "POST",
        `/moderation/reports/${encodedId}/publish?${query.toString()}`,
        {
          requiresAuth: true,
          body: {
            municipality_id: params.municipality_id,
            reason: params.reason,
            public_text: params.public_text ?? "",
          },
        },
        decodePublishReportResponse,
      );
    }

    const actionPath = params.action.toLowerCase();
    return this.request(
      "POST",
      `/moderation/cases/${encodedId}/${actionPath}?${query.toString()}`,
      {
        requiresAuth: true,
        body: {
          municipality_id: params.municipality_id,
          reason: params.reason,
        },
      },
      decodeReport,
    );
  }

  async runDemoIngest(municipalityId: string): Promise<IngestResult> {
    const query = new URLSearchParams({ municipality_id: municipalityId });
    return this.request(
      "POST",
      `/admin/ingest/demo?${query.toString()}`,
      {
        requiresAuth: true,
        body: { municipality_id: municipalityId },
      },
      decodeIngestResult,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    pathAndQuery: string,
    options: {
      requiresAuth: boolean;
      idempotencyKey?: string | undefined;
      body?: unknown;
    },
    decode: (value: unknown) => T | null,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (options.requiresAuth && this.token !== undefined) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (options.idempotencyKey !== undefined && options.idempotencyKey !== "") {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    const init: RequestInit = {
      method,
      headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${pathAndQuery}`, init);
    } catch {
      throw new CivicTechApiError("CivicTech API unreachable: network error", {
        status: 503,
        code: "UPSTREAM_UNREACHABLE",
        retryable: true,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.toLowerCase().includes("application/json");

    if (!response.ok) {
      const fallback = safeStatusError(response.status);
      let code = fallback.code;
      let retryable = response.status >= 500 || response.status === 429;
      let allowedActions: string[] | undefined;

      if (isJson) {
        let errBody: unknown;
        try {
          errBody = await response.json();
        } catch {
          errBody = null;
        }
        if (isRecord(errBody)) {
          if (isString(errBody.code) && ALLOWED_API_CODES.has(errBody.code)) {
            code = errBody.code;
          }
          if (isBoolean(errBody.retryable)) {
            retryable = errBody.retryable;
          }
          if (Array.isArray(errBody.allowed_actions)) {
            const filtered = errBody.allowed_actions.filter(
              (item): item is string => isString(item) && ALLOWED_REPORT_ACTIONS.has(item),
            );
            if (filtered.length > 0) {
              allowedActions = filtered;
            }
          }
        }
      }

      throw new CivicTechApiError(fallback.message, {
        status: response.status,
        code,
        retryable,
        allowed_actions: allowedActions,
      });
    }

    if (!isJson) {
      throw new CivicTechApiError("CivicTech API returned a non-JSON response", {
        status: 502,
        code: "INVALID_RESPONSE",
        retryable: false,
      });
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CivicTechApiError("CivicTech API returned malformed JSON", {
        status: 502,
        code: "INVALID_RESPONSE",
        retryable: false,
      });
    }

    const decoded = decode(parsed);
    if (decoded === null) {
      throw new CivicTechApiError("CivicTech API response failed schema validation", {
        status: 502,
        code: "INVALID_RESPONSE",
        retryable: false,
      });
    }

    return decoded;
  }
}
