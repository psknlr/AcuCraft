/**
 * JSON-RPC 2.0 as the MCP stdio transport carries it: one JSON message per line. Message shapes, the standard error
 * codes, and a line splitter that tolerates CRLF, blank lines and chunk boundaries anywhere.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown } | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string } };

export const RPC_ERRORS = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 } as const;

/** An error that becomes a JSON-RPC error response. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const rpcResult = (id: JsonRpcId | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export type Incoming = { kind: "request"; message: JsonRpcRequest } | { kind: "notification"; method: string } | { kind: "response" } | { kind: "invalid"; id: JsonRpcId | null; reason: string };

const isId = (v: unknown): v is JsonRpcId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** What one parsed JSON value is, as a JSON-RPC message. */
export function classify(value: unknown): Incoming {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid", id: null, reason: "a message is a JSON object" };
  const m = value as Record<string, unknown>;
  const id = isId(m.id) ? m.id : null;
  if (m.jsonrpc !== "2.0") return { kind: "invalid", id, reason: 'jsonrpc must be "2.0"' };
  if (m.method === undefined && ("result" in m || "error" in m)) return { kind: "response" };
  if (typeof m.method !== "string" || m.method === "") return { kind: "invalid", id, reason: "method must be a non-empty string" };
  if (!("id" in m)) return { kind: "notification", method: m.method };
  if (!isId(m.id)) return { kind: "invalid", id: null, reason: "id must be a string or a number" };
  return { kind: "request", message: { id: m.id, method: m.method, ...("params" in m ? { params: m.params } : {}) } };
}

/** Splits a stream of chunks into lines, skipping blank ones. */
export class LineSplitter {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: string | Uint8Array): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }

  /** What is left when the input ends without a final newline. */
  end(): string[] {
    const rest = (this.buffer + this.decoder.decode()).trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
