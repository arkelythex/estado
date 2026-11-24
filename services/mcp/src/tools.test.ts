import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { CivicTechClient, CivicTechApiError } from "./client.ts";
import { handleJsonRpcMessage, startStdioServer } from "./server.ts";
import { TOOLS, callTool, UnknownToolError } from "./tools.ts";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const DATASET_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function createMockFetch(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): { fetchFn: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    const recorded: RecordedRequest = { url, method, headers, body };
    requests.push(recorded);
    return handler(recorded);
  }) as typeof fetch;
  return { fetchFn, requests };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("MCP handshake and discovery", () => {
  test("initialize returns protocolVersion, serverInfo, and tools capability", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const res = await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-agent", version: "0.1.0" },
        },
      }),
      { client },
    );

    expect(res).not.toBeNull();
    expect(res?.jsonrpc).toBe("2.0");
    expect(res?.id).toBe(1);
    expect(res?.error).toBeUndefined();
    const result = res?.result as {
      protocolVersion: string;
      capabilities: { tools: { listChanged: boolean } };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities.tools.listChanged).toBe(false);
    expect(result.serverInfo.name).toBe("@civictech/mcp");
  });

  test("notifications/initialized returns null (no stdout frame emitted)", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const res = await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      { client },
    );

    expect(res).toBeNull();
  });

  test("tools/list returns all 13 tools with valid JSON schemas", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const res = await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
      { client },
    );

    expect(res?.error).toBeUndefined();
    const result = res?.result as { tools: typeof TOOLS };
    expect(result.tools).toHaveLength(13);

    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "list_datasets",
      "query_expenses",
      "list_public_reports",
      "get_public_report",
      "create_report",
      "submit_report",
      "list_moderation_cases",
      "moderate_case",
      "run_demo_ingest",
      "verify_audit_chain",
      "detect_spending_anomalies",
      "export_ocds_releases",
      "track_report_by_receipt",
    ]);

    for (const tool of result.tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      if (tool.name === "verify_audit_chain") {
        expect(tool.inputSchema.required).toEqual([]);
      } else {
        expect(tool.inputSchema.required).toContain("municipality_id");
      }
    }
  });
});

describe("Public tools", () => {
  test("list_datasets queries /public/datasets with municipality_id", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse([
        {
          id: DATASET_ID,
          municipality_id: "lima",
          name: "Gasto Municipal Demo",
          kind: "expenses",
          versions: 1,
          created_at: "2026-06-01T00:00:00Z",
        },
      ]),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool("list_datasets", { municipality_id: "lima" }, { client });
    expect(out.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("http://localhost:8080/public/datasets?municipality_id=lima");

    const parsed = JSON.parse(out.content[0]?.text ?? "[]") as Array<{ name: string }>;
    expect(parsed[0]?.name).toBe("Gasto Municipal Demo");
  });

  test("query_expenses forwards optional filters and preserves exact amount_cents", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse([
        {
          id: REPORT_ID,
          municipality_id: "lima",
          version_id: VERSION_ID,
          entity: "Municipio Demo",
          category: "infraestructura",
          amount_cents: 367125,
          amount: "3671.25",
          occurred_on: "2026-05-10",
          doc_ref: "OC-1001",
        },
      ]),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "query_expenses",
      {
        municipality_id: "lima",
        entity: "Municipio Demo",
        category: "infraestructura",
        from: "2026-05-01",
        to: "2026-05-31",
      },
      { client },
    );

    expect(out.isError).toBeUndefined();
    expect(requests[0]?.url).toBe(
      "http://localhost:8080/public/expenses?municipality_id=lima&entity=Municipio+Demo&category=infraestructura&from=2026-05-01&to=2026-05-31",
    );
    const rows = JSON.parse(out.content[0]?.text ?? "[]") as Array<{ amount_cents: number; amount: string }>;
    expect(rows[0]?.amount_cents).toBe(367125);
    expect(rows[0]?.amount).toBe("3671.25");
  });

  test("query_expenses rejects invalid date format before network call", async () => {
    const { fetchFn, requests } = createMockFetch(() => jsonResponse([]));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "query_expenses",
      { municipality_id: "lima", from: "10/05/2026" },
      { client },
    );

    expect(out.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(out.content[0]?.text).toContain("YYYY-MM-DD");
  });

  test("list_public_reports and get_public_report hit /public/reports endpoints", async () => {
    const { fetchFn, requests } = createMockFetch((req) => {
      if (req.url.includes(`/public/reports/${REPORT_ID}`)) {
        return jsonResponse({
          id: CASE_ID,
          report_id: REPORT_ID,
          municipality_id: "lima",
          status: "PUBLISHED",
          category: "obra_inconclusa",
          public_text: "Vereda sin culminar",
          published_at: "2026-06-02T10:00:00Z",
          evidence_count: 1,
        });
      }
      return jsonResponse([
        {
          id: CASE_ID,
          report_id: REPORT_ID,
          municipality_id: "lima",
          status: "PUBLISHED",
          category: "obra_inconclusa",
          public_text: "Vereda sin culminar",
          published_at: "2026-06-02T10:00:00Z",
        },
      ]);
    });
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const listOut = await callTool("list_public_reports", { municipality_id: "lima" }, { client });
    expect(listOut.isError).toBeUndefined();
    expect(requests[0]?.url).toBe("http://localhost:8080/public/reports?municipality_id=lima");

    const detailOut = await callTool(
      "get_public_report",
      { id: REPORT_ID, municipality_id: "lima" },
      { client },
    );
    expect(detailOut.isError).toBeUndefined();
    expect(requests[1]?.url).toBe(
      `http://localhost:8080/public/reports/${REPORT_ID}?municipality_id=lima`,
    );
    const detail = JSON.parse(detailOut.content[0]?.text ?? "{}") as { evidence_count: number };
    expect(detail.evidence_count).toBe(1);
  });
});

describe("Citizen report tools", () => {
  test("create_report forwards Idempotency-Key header when provided", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse(
        {
          id: REPORT_ID,
          municipality_id: "lima",
          status: "DRAFT",
          category: "sobrecosto",
          description: "Compra con precio elevado",
          created_at: "2026-06-01T12:00:00Z",
        },
        201,
      ),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "create_report",
      {
        municipality_id: "lima",
        category: "sobrecosto",
        description: "Compra con precio elevado",
        idempotency_key: "agent-retry-key-001",
      },
      { client },
    );

    expect(out.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("http://localhost:8080/reports");
    expect(requests[0]?.headers["idempotency-key"]).toBe("agent-retry-key-001");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      municipality_id: "lima",
      category: "sobrecosto",
      description: "Compra con precio elevado",
    });
  });

  test("create_report preserves optional receipt_code when present and strips undeclared fields", async () => {
    const { fetchFn } = createMockFetch(() =>
      jsonResponse(
        {
          id: REPORT_ID,
          municipality_id: "lima",
          status: "DRAFT",
          category: "sobrecosto",
          description: "Compra con precio elevado",
          created_at: "2026-06-01T12:00:00Z",
          receipt_code: "ABCD-EFGH-IJKL-MNOP",
          receipt_hash: "deadbeef",
        },
        201,
      ),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "create_report",
      {
        municipality_id: "lima",
        category: "sobrecosto",
        description: "Compra con precio elevado",
      },
      { client },
    );

    expect(out.isError).toBeUndefined();
    const text = out.content[0]?.text ?? "{}";
    expect(text).not.toContain("receipt_hash");
    expect(text).not.toContain("deadbeef");
    const parsed = JSON.parse(text) as { receipt_code?: string };
    expect(parsed.receipt_code).toBe("ABCD-EFGH-IJKL-MNOP");
  });

  test("submit_report calls POST /reports/{id}/submit", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        id: REPORT_ID,
        municipality_id: "lima",
        status: "SUBMITTED",
        category: "sobrecosto",
        description: "Compra con precio elevado",
        created_at: "2026-06-01T12:00:00Z",
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "submit_report",
      { id: REPORT_ID, municipality_id: "lima" },
      { client },
    );

    expect(out.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(`http://localhost:8080/reports/${REPORT_ID}/submit?municipality_id=lima`);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ municipality_id: "lima" });
  });
});

describe("Moderation and admin ingest tools", () => {
  test("list_moderation_cases sends Authorization Bearer token and optional status", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse([
        {
          id: CASE_ID,
          report_id: REPORT_ID,
          municipality_id: "lima",
          status: "SUBMITTED",
          category: "sobrecosto",
          description: "Caso pendiente",
          assigned_to: null,
          notes: null,
          created_at: "2026-06-01T12:00:00Z",
          updated_at: "2026-06-01T12:00:00Z",
        },
      ]),
    );
    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: "ephemeral-test-token",
      fetchFn,
    });

    const out = await callTool(
      "list_moderation_cases",
      { municipality_id: "lima", status: "SUBMITTED" },
      { client },
    );

    expect(out.isError).toBeUndefined();
    expect(requests[0]?.url).toBe(
      "http://localhost:8080/moderation/cases?municipality_id=lima&status=SUBMITTED",
    );
    expect(requests[0]?.headers["authorization"]).toBe("Bearer ephemeral-test-token");
  });

  test("moderate_case rejects blank reason and missing public_text on PUBLISH", async () => {
    const { fetchFn, requests } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: "ephemeral-test-token",
      fetchFn,
    });

    const blankReason = await callTool(
      "moderate_case",
      {
        id: REPORT_ID,
        municipality_id: "lima",
        action: "TRIAGE",
        reason: "   ",
      },
      { client },
    );
    expect(blankReason.isError).toBe(true);
    expect(blankReason.content[0]?.text).toContain("reason");
    expect(requests).toHaveLength(0);

    const missingPublicText = await callTool(
      "moderate_case",
      {
        id: REPORT_ID,
        municipality_id: "lima",
        action: "PUBLISH",
        reason: "Verificado con acta",
      },
      { client },
    );
    expect(missingPublicText.isError).toBe(true);
    expect(missingPublicText.content[0]?.text).toContain("public_text");
    expect(requests).toHaveLength(0);
  });

  test("moderate_case dispatches TRIAGE, VERIFY, REJECT, and PUBLISH correctly", async () => {
    const { fetchFn, requests } = createMockFetch((req) => {
      if (req.url.includes("/publish")) {
        return jsonResponse({
          report_id: REPORT_ID,
          status: "PUBLISHED",
          publication: {
            id: CASE_ID,
            report_id: REPORT_ID,
            municipality_id: "lima",
            public_text: "Texto redactado",
            published_at: "2026-06-02T12:00:00Z",
          },
        });
      }
      return jsonResponse({
        id: REPORT_ID,
        municipality_id: "lima",
        status: "TRIAGED",
        category: "sobrecosto",
        description: "desc",
        created_at: "2026-06-01T12:00:00Z",
      });
    });
    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: "ephemeral-test-token",
      fetchFn,
    });

    const triage = await callTool(
      "moderate_case",
      { id: REPORT_ID, municipality_id: "lima", action: "TRIAGE", reason: "Validado inicialmente" },
      { client },
    );
    expect(triage.isError).toBeUndefined();
    expect(requests[0]?.url).toBe(
      `http://localhost:8080/moderation/cases/${REPORT_ID}/triage?municipality_id=lima`,
    );

    const verify = await callTool(
      "moderate_case",
      { id: REPORT_ID, municipality_id: "lima", action: "VERIFY", reason: "Evidencia contrastada" },
      { client },
    );
    expect(verify.isError).toBeUndefined();
    expect(requests[1]?.url).toBe(
      `http://localhost:8080/moderation/cases/${REPORT_ID}/verify?municipality_id=lima`,
    );

    const reject = await callTool(
      "moderate_case",
      { id: REPORT_ID, municipality_id: "lima", action: "REJECT", reason: "Reporte duplicado" },
      { client },
    );
    expect(reject.isError).toBeUndefined();
    expect(requests[2]?.url).toBe(
      `http://localhost:8080/moderation/cases/${REPORT_ID}/reject?municipality_id=lima`,
    );

    const publish = await callTool(
      "moderate_case",
      {
        id: REPORT_ID,
        municipality_id: "lima",
        action: "PUBLISH",
        reason: "Aprobado para publicación",
        public_text: "Texto redactado",
      },
      { client },
    );
    expect(publish.isError).toBeUndefined();
    expect(requests[3]?.url).toBe(
      `http://localhost:8080/moderation/reports/${REPORT_ID}/publish?municipality_id=lima`,
    );
    expect(JSON.parse(requests[3]?.body ?? "{}")).toEqual({
      municipality_id: "lima",
      reason: "Aprobado para publicación",
      public_text: "Texto redactado",
    });
  });

  test("run_demo_ingest posts to /admin/ingest/demo with Bearer token", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        municipality_id: "lima",
        dataset_version_id: VERSION_ID,
        checksum_sha256: "5e22e50e1234",
        rows_ingested: 0,
        deduplicated: true,
      }),
    );
    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: "ephemeral-admin-token",
      fetchFn,
    });

    const out = await callTool("run_demo_ingest", { municipality_id: "lima" }, { client });
    expect(out.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("http://localhost:8080/admin/ingest/demo?municipality_id=lima");
    expect(requests[0]?.headers["authorization"]).toBe("Bearer ephemeral-admin-token");
    const parsed = JSON.parse(out.content[0]?.text ?? "{}") as { deduplicated: boolean };
    expect(parsed.deduplicated).toBe(true);
  });
});

describe("Error handling and sanitization", () => {
  test("unknown tool throws UnknownToolError and JSON-RPC returns -32602", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    await expect(callTool("nonexistent_tool", {}, { client })).rejects.toBeInstanceOf(
      UnknownToolError,
    );

    const res = await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      }),
      { client },
    );

    expect(res?.id).toBe(99);
    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toBe("Unknown tool");
  });

  test("sanitizes structured 422 API errors and non-JSON HTML errors without leaking tokens", async () => {
    const secretToken = "super-secret-bearer-token-value";
    const { fetchFn } = createMockFetch((req) => {
      if (req.url.includes("/submit")) {
        return jsonResponse(
          {
            error: "cannot transition from SUBMITTED with SUBMIT",
            code: "INVALID_STATE_TRANSITION",
            retryable: false,
            allowed_actions: ["TRIAGE", "REJECT"],
          },
          422,
        );
      }
      return new Response("<html><body><h1>502 Bad Gateway</h1><p>Internal secret dump</p></body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    });

    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: secretToken,
      fetchFn,
    });

    const transitionErr = await callTool(
      "submit_report",
      { id: REPORT_ID, municipality_id: "lima" },
      { client },
    );
    expect(transitionErr.isError).toBe(true);
    const errPayload = JSON.parse(transitionErr.content[0]?.text ?? "{}") as {
      status: number;
      code: string;
      retryable: boolean;
      allowed_actions: string[];
    };
    expect(errPayload.status).toBe(422);
    expect(errPayload.code).toBe("INVALID_STATE_TRANSITION");
    expect(errPayload.retryable).toBe(false);
    expect(errPayload.allowed_actions).toEqual(["TRIAGE", "REJECT"]);

    const htmlErr = await callTool("list_datasets", { municipality_id: "lima" }, { client });
    expect(htmlErr.isError).toBe(true);
    const htmlErrText = htmlErr.content[0]?.text ?? "";
    expect(htmlErrText).not.toContain("<html>");
    expect(htmlErrText).not.toContain("Internal secret dump");
    expect(htmlErrText).not.toContain(secretToken);
    expect(htmlErrText).toContain("502");
  });

  test("does not forward raw upstream error PII, unknown codes, or unapproved allowed_actions", async () => {
    const { fetchFn } = createMockFetch(() =>
      jsonResponse(
        {
          error: "Citizen juan.perez@example.com phone +51999888777 caused SQL error",
          code: "RAW_DB_INTERNAL_LEAK",
          retryable: false,
          allowed_actions: ["TRIAGE", "DROP_DATABASE", "citizen@example.com"],
        },
        422,
      ),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "submit_report",
      { id: REPORT_ID, municipality_id: "lima" },
      { client },
    );

    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("juan.perez@example.com");
    expect(text).not.toContain("+51999888777");
    expect(text).not.toContain("SQL error");
    expect(text).not.toContain("RAW_DB_INTERNAL_LEAK");
    expect(text).not.toContain("DROP_DATABASE");
    expect(text).not.toContain("citizen@example.com");

    const payload = JSON.parse(text) as {
      error: string;
      status: number;
      code: string;
      allowed_actions?: string[];
    };
    expect(payload.status).toBe(422);
    expect(payload.code).toBe("INVALID_STATE_TRANSITION");
    expect(payload.allowed_actions).toEqual(["TRIAGE"]);
  });

  test("strips undeclared fields such as private_contact and storage_ref from decoded DTOs", async () => {
    const { fetchFn } = createMockFetch((req) => {
      if (req.url.includes(`/public/reports/${REPORT_ID}`)) {
        return jsonResponse({
          id: CASE_ID,
          report_id: REPORT_ID,
          municipality_id: "lima",
          status: "PUBLISHED",
          category: "obra_inconclusa",
          public_text: "Vereda sin culminar",
          published_at: "2026-06-02T10:00:00Z",
          evidence_count: 1,
          private_contact: "secret-witness@example.com",
          storage_ref: "s3://civictech-evidence/private/file.pdf",
        });
      }
      return jsonResponse([
        {
          id: CASE_ID,
          report_id: REPORT_ID,
          municipality_id: "lima",
          status: "PUBLISHED",
          category: "obra_inconclusa",
          public_text: "Vereda sin culminar",
          published_at: "2026-06-02T10:00:00Z",
          private_contact: "secret-witness@example.com",
        },
      ]);
    });
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const listOut = await callTool("list_public_reports", { municipality_id: "lima" }, { client });
    expect(listOut.isError).toBeUndefined();
    const listText = listOut.content[0]?.text ?? "";
    expect(listText).not.toContain("private_contact");
    expect(listText).not.toContain("secret-witness@example.com");

    const detailOut = await callTool(
      "get_public_report",
      { id: REPORT_ID, municipality_id: "lima" },
      { client },
    );
    expect(detailOut.isError).toBeUndefined();
    const detailText = detailOut.content[0]?.text ?? "";
    expect(detailText).not.toContain("private_contact");
    expect(detailText).not.toContain("storage_ref");
    expect(detailText).not.toContain("s3://");
  });

  test("rejects unsafe integer amount_cents in expense responses", async () => {
    const { fetchFn } = createMockFetch(() =>
      jsonResponse([
        {
          id: REPORT_ID,
          municipality_id: "lima",
          version_id: VERSION_ID,
          entity: "Municipio Demo",
          category: "infraestructura",
          amount_cents: Number.MAX_SAFE_INTEGER + 2,
          amount: "90071992547409.92",
          occurred_on: "2026-05-10",
          doc_ref: "OC-1001",
        },
      ]),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool("query_expenses", { municipality_id: "lima" }, { client });
    expect(out.isError).toBe(true);
    const payload = JSON.parse(out.content[0]?.text ?? "{}") as { code: string };
    expect(payload.code).toBe("INVALID_RESPONSE");
  });

  test("rejects invalid status in list_moderation_cases before calling fetch", async () => {
    const { fetchFn, requests } = createMockFetch(() => jsonResponse([]));
    const client = new CivicTechClient({
      baseUrl: "http://localhost:8080",
      token: "ephemeral-test-token",
      fetchFn,
    });

    const out = await callTool(
      "list_moderation_cases",
      { municipality_id: "lima", status: "NOT_A_STATUS" },
      { client },
    );

    expect(out.isError).toBe(true);
    expect(requests).toHaveLength(0);
    const payload = JSON.parse(out.content[0]?.text ?? "{}") as { code: string; error: string };
    expect(payload.code).toBe("VALIDATION_ERROR");
    expect(payload.error).toContain("status");
  });

  test("invalid JSON-RPC payload returns -32700 parse error", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse({}));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const res = await handleJsonRpcMessage("{not valid json", { client });
    expect(res?.error?.code).toBe(-32700);
    expect(res?.id).toBeNull();
  });

  test("CivicTechClient rejects non-http URLs and non-loopback plaintext HTTP URLs", () => {
    expect(() => new CivicTechClient({ baseUrl: "file:///etc/passwd" })).toThrow(CivicTechApiError);
    expect(() => new CivicTechClient({ baseUrl: "http://api.example.com" })).toThrow(CivicTechApiError);
    expect(() => new CivicTechClient({ baseUrl: "https://api.example.com" })).not.toThrow();
    expect(() => new CivicTechClient({ baseUrl: "http://127.0.0.1:8080" })).not.toThrow();
  });

  test("startStdioServer processes chunked newline-delimited JSON-RPC without emitting notification responses", async () => {
    const { fetchFn } = createMockFetch(() => jsonResponse([]));
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });
    const stdin = new PassThrough();
    const lines: string[] = [];

    const done = startStdioServer({
      deps: { client },
      stdin,
      writeLine: (line) => {
        lines.push(line);
      },
    });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    stdin.write('{"jsonrpc":"2.0","id":2,');
    stdin.write('"method":"tools/call","params":{"name":"list_datasets","arguments":{"municipality_id":"lima"}}}\n');
    stdin.end();

    await done;
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as { id: number; result?: { serverInfo?: { name: string } } };
    const second = JSON.parse(lines[1] ?? "{}") as { id: number; result?: { content?: Array<{ text: string }> } };
    expect(first.id).toBe(1);
    expect(first.result?.serverInfo?.name).toBe("@civictech/mcp");
    expect(second.id).toBe(2);
    expect(second.result?.content?.[0]?.text).toBe("[]");
  });
});

describe("World-class CivicTech tools", () => {
  test("verify_audit_chain calls GET /public/audit/verify and projects exact DTO", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        valid: false,
        checked_events: 4,
        head_hash: "a".repeat(64),
        broken_at_seq: 3,
        reason: "hash mismatch at seq 3",
        internal_debug: "should-be-stripped",
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool("verify_audit_chain", {}, { client });
    expect(out.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("http://localhost:8080/public/audit/verify");

    const text = out.content[0]?.text ?? "{}";
    expect(text).not.toContain("internal_debug");
    expect(text).not.toContain("should-be-stripped");
    expect(JSON.parse(text)).toEqual({
      valid: false,
      checked_events: 4,
      head_hash: "a".repeat(64),
      broken_at_seq: 3,
      reason: "hash mismatch at seq 3",
    });
  });

  test("verify_audit_chain rejects unexpected args and unsafe integers", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        valid: true,
        checked_events: Number.MAX_SAFE_INTEGER + 2,
        head_hash: "0".repeat(64),
        broken_at_seq: null,
        reason: null,
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const badArg = await callTool("verify_audit_chain", { extra: "nope" }, { client });
    expect(badArg.isError).toBe(true);
    expect(requests).toHaveLength(0);

    const unsafeRes = await callTool("verify_audit_chain", {}, { client });
    expect(unsafeRes.isError).toBe(true);
    expect(JSON.parse(unsafeRes.content[0]?.text ?? "{}").code).toBe("INVALID_RESPONSE");
  });

  test("detect_spending_anomalies calls /public/anomalies, validates safe integers, and strips undeclared fields", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        total_expenses: 3,
        total_amount_cents: 800000,
        threshold_cents: 428000,
        flag_count: 1,
        internal_engine_host: "http://127.0.0.1:9000",
        flags: [
          {
            rule_code: "CONTRACT_SPLITTING",
            severity: "HIGH",
            entity: "Muni Lima",
            category: "OBRAS",
            total_cents: 600000,
            expense_count: 2,
            affected_ids: [REPORT_ID, CASE_ID],
            share_bps: 7500,
            summary: "Multiple below-threshold disbursements",
            raw_sql_note: "internal-leak",
          },
        ],
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool(
      "detect_spending_anomalies",
      { municipality_id: "lima", threshold_cents: 428000 },
      { client },
    );

    expect(out.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "http://localhost:8080/public/anomalies?municipality_id=lima&threshold_cents=428000",
    );

    const text = out.content[0]?.text ?? "{}";
    expect(text).not.toContain("internal_engine_host");
    expect(text).not.toContain("raw_sql_note");
    expect(text).not.toContain("internal-leak");

    expect(JSON.parse(text)).toEqual({
      total_expenses: 3,
      total_amount_cents: 800000,
      threshold_cents: 428000,
      flag_count: 1,
      flags: [
        {
          rule_code: "CONTRACT_SPLITTING",
          severity: "HIGH",
          entity: "Muni Lima",
          category: "OBRAS",
          total_cents: 600000,
          expense_count: 2,
          affected_ids: [REPORT_ID, CASE_ID],
          share_bps: 7500,
          summary: "Multiple below-threshold disbursements",
        },
      ],
    });
  });

  test("detect_spending_anomalies validates threshold_cents and rejects unsafe response integers", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        total_expenses: 1,
        total_amount_cents: Number.MAX_SAFE_INTEGER + 2,
        threshold_cents: 428000,
        flag_count: 0,
        flags: [],
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    for (const badThreshold of [0, -100, 12.5, Number.MAX_SAFE_INTEGER + 2, "428000"]) {
      const res = await callTool(
        "detect_spending_anomalies",
        { municipality_id: "lima", threshold_cents: badThreshold },
        { client },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0]?.text ?? "{}").code).toBe("VALIDATION_ERROR");
    }
    expect(requests).toHaveLength(0);

    const unsafeOut = await callTool(
      "detect_spending_anomalies",
      { municipality_id: "lima" },
      { client },
    );
    expect(unsafeOut.isError).toBe(true);
    expect(JSON.parse(unsafeOut.content[0]?.text ?? "{}").code).toBe("INVALID_RESPONSE");
  });

  test("export_ocds_releases validates OCDS 1.1 package and strips undeclared fields", async () => {
    const { fetchFn, requests } = createMockFetch(() =>
      jsonResponse({
        version: "1.1",
        uri: "/public/ocds/releases.json?municipality_id=lima",
        publishedDate: "2026-06-15T12:00:00Z",
        publisher: { name: "CivicTech Peru", internal_id: "hidden" },
        extra_root: "strip-me",
        releases: [
          {
            ocid: `ocds-pe-lima-${REPORT_ID}`,
            id: REPORT_ID,
            date: "2026-06-01T00:00:00Z",
            tag: ["implementation"],
            initiationType: "tender",
            buyer: { name: "Muni Lima", tax_id: "secret" },
            tender: {
              id: "DOC-101",
              title: "OBRAS",
              status: "complete",
              value: { amount: 2500.75, currency: "PEN" },
            },
            awards: [
              {
                id: `award-${REPORT_ID}`,
                status: "active",
                value: { amount: 2500.75, currency: "PEN" },
              },
            ],
            contracts: [
              {
                id: `contract-${REPORT_ID}`,
                awardID: `award-${REPORT_ID}`,
                status: "active",
                value: { amount: 2500.75, currency: "PEN" },
              },
            ],
            internal_notes: "private",
          },
        ],
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool("export_ocds_releases", { municipality_id: "lima" }, { client });
    expect(out.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "http://localhost:8080/public/ocds/releases.json?municipality_id=lima",
    );

    const text = out.content[0]?.text ?? "{}";
    expect(text).not.toContain("extra_root");
    expect(text).not.toContain("internal_id");
    expect(text).not.toContain("tax_id");
    expect(text).not.toContain("internal_notes");

    const parsed = JSON.parse(text) as {
      version: string;
      publishedDate: string;
      publisher: { name: string };
      releases: Array<{ tender: { value: { amount: number; currency: string } } }>;
    };
    expect(parsed.version).toBe("1.1");
    expect(parsed.publisher).toEqual({ name: "CivicTech Peru" });
    expect(parsed.releases[0]?.tender.value).toEqual({ amount: 2500.75, currency: "PEN" });
  });

  test("export_ocds_releases rejects non-1.1 OCDS packages", async () => {
    const { fetchFn } = createMockFetch(() =>
      jsonResponse({
        version: "1.0",
        publishedDate: "2026-06-15T12:00:00Z",
        publisher: { name: "CivicTech Peru" },
        releases: [],
      }),
    );
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const out = await callTool("export_ocds_releases", { municipality_id: "lima" }, { client });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]?.text ?? "{}").code).toBe("INVALID_RESPONSE");
  });

  test("track_report_by_receipt sends X-Receipt-Code header, projects DTO cleanly, and never leaks receipt_code", async () => {
    const secretReceipt = "WXYZ-1234-ABCD-5678";
    const { fetchFn, requests } = createMockFetch((req) => {
      if (req.headers["x-receipt-code"] === secretReceipt) {
        return jsonResponse({
          status: "TRIAGED",
          category: "SOBORNO",
          municipality_id: "lima",
          created_at: "2026-06-01T12:00:00Z",
          timeline: [
            {
              from_status: "DRAFT",
              to_status: "SUBMITTED",
              action: "SUBMIT",
              occurred_at: "2026-06-01T12:05:00Z",
              actor_id: "should-be-stripped",
            },
            {
              from_status: "SUBMITTED",
              to_status: "TRIAGED",
              action: "TRIAGE",
              occurred_at: "2026-06-02T09:00:00Z",
              reason: "confidential-moderator-note",
            },
          ],
          description: "PII witness details",
          receipt_code: secretReceipt,
          report_id: REPORT_ID,
        });
      }
      return jsonResponse(
        {
          error: `Receipt ${req.headers["x-receipt-code"]} not found in database`,
          code: "NOT_FOUND",
          retryable: false,
        },
        404,
      );
    });
    const client = new CivicTechClient({ baseUrl: "http://localhost:8080", fetchFn });

    const okOut = await callTool(
      "track_report_by_receipt",
      { municipality_id: "lima", receipt_code: secretReceipt },
      { client },
    );

    expect(okOut.isError).toBeUndefined();
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("http://localhost:8080/public/reports/track?municipality_id=lima");
    expect(requests[0]?.headers["x-receipt-code"]).toBe(secretReceipt);

    const okText = okOut.content[0]?.text ?? "{}";
    expect(okText).not.toContain(secretReceipt);
    expect(okText).not.toContain("PII witness details");
    expect(okText).not.toContain("should-be-stripped");
    expect(okText).not.toContain("confidential-moderator-note");
    expect(okText).not.toContain("report_id");

    expect(JSON.parse(okText)).toEqual({
      status: "TRIAGED",
      category: "SOBORNO",
      municipality_id: "lima",
      created_at: "2026-06-01T12:00:00Z",
      timeline: [
        {
          from_status: "DRAFT",
          to_status: "SUBMITTED",
          action: "SUBMIT",
          occurred_at: "2026-06-01T12:05:00Z",
        },
        {
          from_status: "SUBMITTED",
          to_status: "TRIAGED",
          action: "TRIAGE",
          occurred_at: "2026-06-02T09:00:00Z",
        },
      ],
    });

    // Upstream 404 must NEVER echo the receipt_code or upstream error prose
    const unknownReceipt = "ZZZZ-9999-XXXX-0000";
    const errOut = await callTool(
      "track_report_by_receipt",
      { municipality_id: "lima", receipt_code: unknownReceipt },
      { client },
    );
    expect(errOut.isError).toBe(true);
    const errText = errOut.content[0]?.text ?? "{}";
    expect(errText).not.toContain(unknownReceipt);
    expect(errText).not.toContain("not found in database");
    expect(JSON.parse(errText)).toEqual({
      error: "CivicTech API resource not found (HTTP 404)",
      status: 404,
      code: "NOT_FOUND",
      retryable: false,
    });

    // Validation error on blank or malformed control-char receipt_code must NEVER echo input
    const badReceipt = "BAD\nRECEIPT-VALUE";
    const valErr = await callTool(
      "track_report_by_receipt",
      { municipality_id: "lima", receipt_code: badReceipt },
      { client },
    );
    expect(valErr.isError).toBe(true);
    expect(valErr.content[0]?.text ?? "").not.toContain("BAD");
    expect(valErr.content[0]?.text ?? "").not.toContain("RECEIPT-VALUE");
  });
});
