import {
  CivicTechApiError,
  type CivicTechClient,
  type ModerationAction,
} from "./client.ts";

export interface JsonSchemaProperty {
  type: "string";
  description: string;
  enum?: readonly string[];
  format?: string;
  maxLength?: number;
  default?: string;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: readonly string[];
  additionalProperties: false;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  isError?: true;
}

export interface ToolDeps {
  client: CivicTechClient;
}

export class UnknownToolError extends Error {
  constructor(_toolName?: string) {
    super("Unknown tool");
    this.name = "UnknownToolError";
  }
}

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_YYYY_MM_DD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MODERATION_ACTIONS: readonly ModerationAction[] = ["TRIAGE", "VERIFY", "REJECT", "PUBLISH"];
const REPORT_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "TRIAGED",
  "VERIFIED",
  "PUBLISHED",
  "REJECTED",
] as const;

const MUNICIPALITY_PROP: JsonSchemaProperty = {
  type: "string",
  description: "Municipality scope identifier (for example 'lima'). Required for tenant isolation.",
  maxLength: 64,
};

export const TOOLS: readonly McpToolDefinition[] = [
  {
    name: "list_datasets",
    description: "List published transparency datasets scoped to a municipality.",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
      },
      required: ["municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_expenses",
    description:
      "Query public municipal expenses with exact integer amount_cents and formatted amount string.",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
        entity: {
          type: "string",
          description: "Optional executing entity name filter.",
          maxLength: 200,
        },
        category: {
          type: "string",
          description: "Optional expense category filter.",
          maxLength: 100,
        },
        from: {
          type: "string",
          format: "date",
          description: "Optional start date inclusive in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          format: "date",
          description: "Optional end date inclusive in YYYY-MM-DD format.",
        },
      },
      required: ["municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_public_reports",
    description: "List published citizen irregularity reports (PII redacted) for a municipality.",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
      },
      required: ["municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_public_report",
    description: "Get a single published citizen report detail including evidence_count.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "Report UUID.",
        },
        municipality_id: MUNICIPALITY_PROP,
      },
      required: ["id", "municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_report",
    description:
      "Create a DRAFT citizen irregularity report. Supports optional idempotency_key to prevent duplicate drafts on retries.",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
        category: {
          type: "string",
          description: "Report category (max 100 characters).",
          maxLength: 100,
        },
        description: {
          type: "string",
          description: "Detailed report description (max 10000 characters).",
          maxLength: 10000,
        },
        idempotency_key: {
          type: "string",
          description: "Optional Idempotency-Key header value scoped per municipality_id.",
          maxLength: 128,
        },
      },
      required: ["municipality_id", "category", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_report",
    description: "Transition a citizen report from DRAFT to SUBMITTED.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "Draft report UUID.",
        },
        municipality_id: MUNICIPALITY_PROP,
      },
      required: ["id", "municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_moderation_cases",
    description:
      "List moderation queue cases for a municipality (requires MODERATOR or ADMIN token in CIVICTECH_API_TOKEN).",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
        status: {
          type: "string",
          description: "Optional report status filter.",
          enum: REPORT_STATUSES,
        },
      },
      required: ["municipality_id"],
      additionalProperties: false,
    },
  },
  {
    name: "moderate_case",
    description:
      "Execute an auditable moderation transition (TRIAGE, VERIFY, REJECT, or PUBLISH) with a mandatory reason. PUBLISH also requires redacted public_text.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "Report UUID associated with the moderation case.",
        },
        municipality_id: MUNICIPALITY_PROP,
        action: {
          type: "string",
          enum: MODERATION_ACTIONS,
          description: "Moderation action: TRIAGE, VERIFY, REJECT, or PUBLISH.",
        },
        reason: {
          type: "string",
          description: "Mandatory non-empty auditable moderation reason.",
          maxLength: 2000,
        },
        public_text: {
          type: "string",
          description: "Redacted public summary text (required when action is PUBLISH).",
          maxLength: 10000,
        },
      },
      required: ["id", "municipality_id", "action", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "run_demo_ingest",
    description:
      "Trigger idempotent demo CSV expense ingestion for a municipality (requires ADMIN token in CIVICTECH_API_TOKEN).",
    inputSchema: {
      type: "object",
      properties: {
        municipality_id: MUNICIPALITY_PROP,
      },
      required: ["municipality_id"],
      additionalProperties: false,
    },
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new ToolInputError("Unexpected argument");
    }
  }
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  field: string,
  maxLength?: number,
): string {
  const val = obj[field];
  if (typeof val !== "string") {
    throw new ToolInputError(`${field} must be a non-empty string`);
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    throw new ToolInputError(`${field} must not be blank`);
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ToolInputError(`${field} exceeds maximum length of ${maxLength}`);
  }
  return trimmed;
}

function optionalTrimmedString(
  obj: Record<string, unknown>,
  field: string,
  maxLength?: number,
): string | undefined {
  const val = obj[field];
  if (val === undefined) {
    return undefined;
  }
  if (typeof val !== "string") {
    throw new ToolInputError(`${field} must be a string`);
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ToolInputError(`${field} exceeds maximum length of ${maxLength}`);
  }
  return trimmed;
}

function requireUuid(obj: Record<string, unknown>, field: string): string {
  const value = requireNonEmptyString(obj, field, 64);
  if (!UUID_REGEX.test(value)) {
    throw new ToolInputError(`${field} must be a valid UUID`);
  }
  return value;
}

function validateDateString(dateStr: string, field: string): string {
  if (!DATE_YYYY_MM_DD_REGEX.test(dateStr)) {
    throw new ToolInputError(`${field} must be in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
    throw new ToolInputError(`${field} is not a valid calendar date (expected YYYY-MM-DD)`);
  }
  return dateStr;
}

function requireModerationAction(obj: Record<string, unknown>): ModerationAction {
  const raw = requireNonEmptyString(obj, "action", 16).toUpperCase();
  if (raw !== "TRIAGE" && raw !== "VERIFY" && raw !== "REJECT" && raw !== "PUBLISH") {
    throw new ToolInputError("action must be one of TRIAGE, VERIFY, REJECT, PUBLISH");
  }
  return raw;
}

type ReportStatus = (typeof REPORT_STATUSES)[number];

function optionalReportStatus(obj: Record<string, unknown>): ReportStatus | undefined {
  const raw = optionalTrimmedString(obj, "status", 32);
  if (raw === undefined) {
    return undefined;
  }
  if (!(REPORT_STATUSES as readonly string[]).includes(raw)) {
    throw new ToolInputError(`status must be one of ${REPORT_STATUSES.join(", ")}`);
  }
  return raw as ReportStatus;
}

function formatJsonResult(payload: unknown): McpToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatErrorResult(payload: unknown): McpToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: true,
  };
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

export async function callTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<McpToolCallResult> {
  if (!TOOL_NAMES.has(name)) {
    throw new UnknownToolError(name);
  }

  if (!isPlainObject(args)) {
    return formatErrorResult({
      error: "Tool arguments must be a JSON object",
      code: "VALIDATION_ERROR",
      retryable: false,
    });
  }

  try {
    switch (name) {
      case "list_datasets": {
        assertAllowedKeys(args, ["municipality_id"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const datasets = await deps.client.listDatasets(municipalityId);
        return formatJsonResult(datasets);
      }

      case "query_expenses": {
        assertAllowedKeys(args, ["municipality_id", "entity", "category", "from", "to"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const entity = optionalTrimmedString(args, "entity", 200);
        const category = optionalTrimmedString(args, "category", 100);
        const rawFrom = optionalTrimmedString(args, "from", 10);
        const rawTo = optionalTrimmedString(args, "to", 10);
        const from = rawFrom !== undefined ? validateDateString(rawFrom, "from") : undefined;
        const to = rawTo !== undefined ? validateDateString(rawTo, "to") : undefined;

        const expenses = await deps.client.queryExpenses({
          municipality_id: municipalityId,
          entity,
          category,
          from,
          to,
        });
        return formatJsonResult(expenses);
      }

      case "list_public_reports": {
        assertAllowedKeys(args, ["municipality_id"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const reports = await deps.client.listPublicReports(municipalityId);
        return formatJsonResult(reports);
      }

      case "get_public_report": {
        assertAllowedKeys(args, ["id", "municipality_id"]);
        const id = requireUuid(args, "id");
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const report = await deps.client.getPublicReport(id, municipalityId);
        return formatJsonResult(report);
      }

      case "create_report": {
        assertAllowedKeys(args, ["municipality_id", "category", "description", "idempotency_key"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const category = requireNonEmptyString(args, "category", 100);
        const description = requireNonEmptyString(args, "description", 10000);
        const idempotencyKey = optionalTrimmedString(args, "idempotency_key", 128);
        const report = await deps.client.createReport({
          municipality_id: municipalityId,
          category,
          description,
          idempotency_key: idempotencyKey,
        });
        return formatJsonResult(report);
      }

      case "submit_report": {
        assertAllowedKeys(args, ["id", "municipality_id"]);
        const id = requireUuid(args, "id");
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const report = await deps.client.submitReport(id, municipalityId);
        return formatJsonResult(report);
      }

      case "list_moderation_cases": {
        assertAllowedKeys(args, ["municipality_id", "status"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const status = optionalReportStatus(args);
        const cases = await deps.client.listModerationCases({
          municipality_id: municipalityId,
          status,
        });
        return formatJsonResult(cases);
      }

      case "moderate_case": {
        assertAllowedKeys(args, ["id", "municipality_id", "action", "reason", "public_text"]);
        const id = requireUuid(args, "id");
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const action = requireModerationAction(args);
        const reason = requireNonEmptyString(args, "reason", 2000);
        let publicText: string | undefined;

        if (action === "PUBLISH") {
          publicText = requireNonEmptyString(args, "public_text", 10000);
        } else {
          publicText = optionalTrimmedString(args, "public_text", 10000);
        }

        const result = await deps.client.moderateCase({
          id,
          municipality_id: municipalityId,
          action,
          reason,
          public_text: publicText,
        });
        return formatJsonResult(result);
      }

      case "run_demo_ingest": {
        assertAllowedKeys(args, ["municipality_id"]);
        const municipalityId = requireNonEmptyString(args, "municipality_id", 64);
        const result = await deps.client.runDemoIngest(municipalityId);
        return formatJsonResult(result);
      }

      default:
        throw new UnknownToolError(name);
    }
  } catch (err) {
    if (err instanceof UnknownToolError) {
      throw err;
    }
    if (err instanceof ToolInputError) {
      return formatErrorResult({
        error: err.message,
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    }
    if (err instanceof CivicTechApiError) {
      return formatErrorResult(err.toSanitizedPayload());
    }
    return formatErrorResult({
      error: "Unexpected tool execution error",
      code: "INTERNAL_ERROR",
      retryable: false,
    });
  }
}
