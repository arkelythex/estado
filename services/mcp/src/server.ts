import { TOOLS, UnknownToolError, callTool, type ToolDeps } from "./tools.ts";

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26"]);
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = {
  name: "@civictech/mcp",
  version: "1.0.0",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function makeError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function makeResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export async function handleJsonRpcRequest(
  payload: unknown,
  deps: ToolDeps,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    const id = isRecord(payload) && isValidId(payload.id) ? payload.id : null;
    return makeError(id, -32600, "Invalid Request");
  }

  const hasId = Object.prototype.hasOwnProperty.call(payload, "id");
  const id: JsonRpcId = hasId && isValidId(payload.id) ? payload.id : null;
  if (hasId && !isValidId(payload.id)) {
    return makeError(null, -32600, "Invalid Request: id must be string, number, or null");
  }

  const method = payload.method;
  const params = payload.params;

  // JSON-RPC notifications have no "id" member and MUST NOT receive a response.
  if (!hasId) {
    return null;
  }

  switch (method) {
    case "initialize": {
      let protocolVersion = DEFAULT_PROTOCOL_VERSION;
      if (isRecord(params) && typeof params.protocolVersion === "string") {
        if (SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)) {
          protocolVersion = params.protocolVersion;
        }
      }
      return makeResult(id, {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: SERVER_INFO,
        instructions:
          "CivicTech Peru MCP server. All tools require municipality_id (e.g. 'lima'). Moderation and ingest tools require CIVICTECH_API_TOKEN.",
      });
    }

    case "ping": {
      return makeResult(id, {});
    }

    case "tools/list": {
      return makeResult(id, {
        tools: TOOLS,
      });
    }

    case "tools/call": {
      if (!isRecord(params) || typeof params.name !== "string" || params.name.trim() === "") {
        return makeError(id, -32602, "Invalid params: tools/call requires a non-empty tool name");
      }
      const toolName = params.name;
      const toolArgs = params.arguments ?? {};

      try {
        const result = await callTool(toolName, toolArgs, deps);
        return makeResult(id, result);
      } catch (err) {
        if (err instanceof UnknownToolError) {
          return makeError(id, -32602, "Unknown tool");
        }
        return makeError(id, -32603, "Internal error");
      }
    }

    default: {
      return makeError(id, -32601, "Method not found");
    }
  }
}

export async function handleJsonRpcMessage(
  rawLine: string,
  deps: ToolDeps,
): Promise<JsonRpcResponse | null> {
  const trimmed = rawLine.trim();
  if (trimmed === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return makeError(null, -32700, "Parse error: invalid JSON");
  }

  return handleJsonRpcRequest(parsed, deps);
}

export interface StdinReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface StdioServerOptions {
  deps: ToolDeps;
  stdin?: StdinReadable;
  writeLine?: (line: string) => void;
}

export function startStdioServer(options: StdioServerOptions): Promise<void> {
  const stdin: StdinReadable = options.stdin ?? process.stdin;
  const writeLine =
    options.writeLine ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    let pending = Promise.resolve();

    const processLine = (line: string): void => {
      pending = pending.then(async () => {
        const response = await handleJsonRpcMessage(line, options.deps);
        if (response !== null) {
          writeLine(JSON.stringify(response));
        }
      });
    };

    stdin.setEncoding("utf8");

    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf("\n");
      }
    });

    stdin.on("end", () => {
      if (buffer.trim() !== "") {
        processLine(buffer);
        buffer = "";
      }
      pending.then(resolve, reject);
    });

    stdin.on("error", (err: Error) => {
      reject(err);
    });
  });
}
