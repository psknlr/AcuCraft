import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ACUCRAFT_VERSION } from "@acucraft/core";
import { CLINICALCRAFT_REV } from "@acucraft/bench";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, type EncounterStore } from "@acucraft/mcp";
import { operator, type HubEvent, type HubResult, type RecordHub } from "./hub.js";
import { DEBRIEF_CSP, hostnameOf, isLoopbackHost, originOf, securityHeaders, tokenCookie, tokenSource } from "./security.js";

/**
 * `acu serve` — the browser workspace over HTTP (docs/WEB.md):
 *
 *  - `/` and `/app/*`: the browser app (its TypeScript modules transpiled as they are served);
 *  - `/api/*`: the records — list, start, import, read, act through the practitioner's tools, close, delete, the
 *    server's language model (start, pause, resume, stop, approve), the log, the evaluation, the debrief;
 *  - `/api/stream`: Server-Sent Events — every change to every record, as it happens;
 *  - `/mcp`: the MCP server (Streamable HTTP) on the same records, so a client such as Claude Code works on the
 *    encounter an operator has open in the browser.
 */

export interface ServeOptions {
  hub: RecordHub;
  /** The address to listen on (default 127.0.0.1). Anything but a loopback address needs a token. */
  host?: string;
  /** The port (default 8787; 0: any free one). */
  port?: number;
  /** An access token: then the API and `/mcp` need it (`Authorization: Bearer`, `?token=` once, or the cookie that sets). */
  token?: string | null;
  /** The browser app's directory (default: this package's `web/`). */
  appDir?: string;
  /** One line per request (method, path, status — never a query string). */
  log?: (line: string) => void;
}

export interface RunningServer {
  server: Server;
  /** The app's address (with the host as given; a wildcard bind is reached on 127.0.0.1). */
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;
const MAX_IMPORT = 8_000_000;
const MCP_SESSIONS = 64;
const ID = /^enc-[a-z0-9]{6,32}$/;
const MODULE = /^[a-z][a-z0-9-]{0,40}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { ...securityHeaders(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "send JSON (content-type: application/json)");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `the body is over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const byOf = (body: Record<string, unknown>) => {
  const by = record(body.by);
  return operator(by.name, by.tab);
};

/** The browser app: its HTML, its stylesheet and icon, and its TypeScript modules as JavaScript. */
class App {
  private readonly compiled = new Map<string, { mtimeMs: number; code: string }>();
  constructor(private readonly dir: string) {}

  serve(res: ServerResponse, path: string): boolean {
    if (path === "/" || path === "/index.html") return this.file(res, "index.html", "text/html; charset=utf-8");
    if (path === "/app/styles.css") return this.file(res, "styles.css", "text/css; charset=utf-8");
    if (path === "/app/icon.svg") return this.file(res, "icon.svg", "image/svg+xml");
    const m = /^\/app\/([a-z0-9-]+)\.js$/.exec(path);
    if (m && MODULE.test(m[1]!)) {
      const file = join(this.dir, `${m[1]}.ts`);
      if (!existsSync(file)) return false;
      res.writeHead(200, { ...securityHeaders(), "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      res.end(this.module(file));
      return true;
    }
    return false;
  }

  private file(res: ServerResponse, name: string, type: string): boolean {
    const file = join(this.dir, name);
    if (!existsSync(file)) return false;
    res.writeHead(200, { ...securityHeaders(), "content-type": type, "cache-control": "no-cache" });
    res.end(readFileSync(file));
    return true;
  }

  /** A module of the app as JavaScript (type-only imports and types erased), cached until its file changes. */
  module(file: string): string {
    const mtimeMs = statSync(file).mtimeMs;
    const hit = this.compiled.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.code;
    const out = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, inlineSourceMap: true, inlineSources: true, isolatedModules: true },
    });
    this.compiled.set(file, { mtimeMs, code: out.outputText });
    return out.outputText;
  }
}

/** One MCP connection (Streamable HTTP): an MCP server of its own, on the hub's records. */
interface McpConnection {
  server: McpServer;
  used: number;
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  const hub = options.hub;
  const host = options.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const token = options.token ?? null;
  if (!loopback && !token) throw new Error(`listening on ${host} (not a loopback address) needs an access token (--token-file)`);
  const app = new App(options.appDir ?? fileURLToPath(new URL("../web/", import.meta.url)));
  const log = options.log ?? (() => {});
  const store: EncounterStore = hub.mcpStore();
  const mcp = new Map<string, McpConnection>();
  const streams = new Set<ServerResponse>();
  let clock = 0;

  const send = (res: ServerResponse, out: HubResult) => json(res, out.status, out.body);

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const method = req.method ?? "GET";
    if (path === "/api/info" && method === "GET") {
      return json(res, 200, { name: "AcuCraft workspace", version: ACUCRAFT_VERSION, clinicalcraft: CLINICALCRAFT_REV, families: hub.families(), auth: { token: token !== null }, mcp: "/mcp", languageModel: { claude: Boolean(process.env.ANTHROPIC_API_KEY) } });
    }
    if (path === "/api/stream" && method === "GET") return stream(req, res, url.searchParams.get("encounter"));
    if (path === "/api/encounters") {
      if (method === "GET") return json(res, 200, { encounters: hub.summaries() });
      if (method === "POST") {
        const body = record(await readBody(req, MAX_BODY));
        return send(res, hub.create(body, byOf(body)));
      }
    }
    if (path === "/api/encounters/import" && method === "POST") {
      const body = record(await readBody(req, MAX_IMPORT));
      return send(res, hub.importLog(body.log, byOf(body)));
    }
    const m = /^\/api\/encounters\/([^/]+)(?:\/([a-z]+(?:\/[a-z]+)?))?$/.exec(path);
    if (!m) throw new HttpError(404, "no such route");
    const id = m[1]!;
    const sub = m[2] ?? "";
    if (!ID.test(id) || !hub.has(id)) throw new HttpError(404, "no such encounter");
    switch (`${method} ${sub}`) {
      case "GET ":
        return json(res, 200, hub.snapshot(id));
      case "DELETE ":
        return send(res, hub.remove(id));
      case "GET tools":
        return json(res, 200, { tools: hub.tools(id) });
      case "POST act": {
        const body = record(await readBody(req, MAX_BODY));
        return send(res, hub.act(id, body.tool, body.input, byOf(body)));
      }
      case "POST close": {
        const body = record(await readBody(req, MAX_BODY));
        return send(res, hub.close(id, body.abandon === true, byOf(body)));
      }
      case "GET report":
        return send(res, hub.report(id));
      case "GET log": {
        const log = hub.logOf(id);
        return json(res, 200, log, { "content-disposition": `attachment; filename="${id}-log.json"` });
      }
      case "GET debrief": {
        const out = hub.debrief(id);
        if (out.status !== 200) return json(res, out.status, { error: out.body });
        res.writeHead(200, { ...securityHeaders(DEBRIEF_CSP), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(out.body);
        return;
      }
      case "POST agent": {
        const body = record(await readBody(req, MAX_BODY));
        return send(res, hub.agent(id, body.op, record(body.options), byOf(body)));
      }
      case "POST agent/decision": {
        const body = record(await readBody(req, MAX_BODY));
        return send(res, hub.decide(id, body.approve === true, body.reason));
      }
      default:
        throw new HttpError(405, "not here");
    }
  }

  /** Server-Sent Events: the list of records always, and everything about one encounter when it is named. */
  function stream(req: IncomingMessage, res: ServerResponse, encounter: string | null): void {
    const id = encounter && ID.test(encounter) && hub.has(encounter) ? encounter : null;
    res.writeHead(200, { ...securityHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write("retry: 2000\n\n");
    event("hello", { encounters: hub.summaries(), snapshot: id ? hub.snapshot(id) : null });
    if (id) hub.watching(id, 1);
    const off = hub.subscribe((e: HubEvent) => {
      if (e.type === "removed") return event("removed", { id: e.id });
      event("summary", e.summary);
      if (e.type === "summary" || e.id !== id) return;
      if (e.type === "update") event("update", { view: e.view, entry: e.entry });
      else if (e.type === "agent") event("agent", { agent: e.agent, item: e.item });
      else if (e.type === "closed") event("closed", { report: e.report });
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    streams.add(res);
    const done = () => {
      if (!streams.delete(res)) return;
      clearInterval(ping);
      off();
      if (id) hub.watching(id, -1);
    };
    req.on("close", done);
    res.on("close", done);
  }

  /** MCP over Streamable HTTP: POST a JSON-RPC message, get the response as JSON (no server-initiated stream). */
  async function mcpRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (token && tokenSource(req, new URL("http://x/"), token) !== "header") {
      return json(res, 401, { error: "an MCP client sends the server's token as Authorization: Bearer <token>" }, { "www-authenticate": "Bearer" });
    }
    const sid = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    if (req.method === "DELETE") {
      if (!sid || !mcp.delete(sid)) return json(res, 404, { error: "no such MCP session" });
      res.writeHead(204, securityHeaders());
      res.end();
      return;
    }
    if (req.method !== "POST") return json(res, 405, { error: "this endpoint takes POST (and DELETE to end a session)" }, { allow: "POST, DELETE" });
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return json(res, 400, { error: `unsupported MCP protocol version ${version}` });
    let body: unknown;
    try {
      body = await readBody(req, MAX_BODY);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      throw e;
    }
    const messages = Array.isArray(body) ? body : [body];
    const initializing = messages.some((m) => record(m).method === "initialize");
    let id = sid;
    let conn = id ? mcp.get(id) : undefined;
    if (initializing) {
      id = randomBytes(16).toString("hex");
      conn = { server: new McpServer({ pack: hub.pack, store, connection: id, log }), used: ++clock };
      mcp.set(id, conn);
      while (mcp.size > MCP_SESSIONS) mcp.delete([...mcp.entries()].sort((a, b) => a[1].used - b[1].used)[0]![0]);
    } else if (!id) {
      return json(res, 400, { error: "send Mcp-Session-Id (initialize first)" });
    } else if (!conn) {
      return json(res, 404, { error: "no such MCP session: initialize again" });
    }
    conn!.used = ++clock;
    const answer = await conn!.server.handle(body);
    if (answer === null) {
      res.writeHead(202, { ...securityHeaders(), "mcp-session-id": id! });
      res.end();
      return;
    }
    json(res, 200, answer, { "mcp-session-id": id! });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://workspace.invalid");
    const path = url.pathname;
    res.on("finish", () => log(`${req.method} ${path} ${res.statusCode}`));
    void (async () => {
      // DNS rebinding: a loopback-only server answers loopback host names only
      if (loopback && !isLoopbackHost(hostnameOf(String(req.headers.host ?? "")))) return json(res, 403, { error: "this server answers on its loopback address only" });
      // same origin only: another site's page cannot use the operator's cookie here
      if (originOf(req) === "other") return json(res, 403, { error: "cross-origin requests are not allowed" });
      if (path === "/mcp") return mcpRoute(req, res);
      if (req.method === "GET" && (path === "/" || path === "/index.html") && token && tokenSource(req, url, token) === "query") {
        // the token leaves the address bar: a cookie carries it from here
        res.writeHead(303, { ...securityHeaders(), location: "/", "set-cookie": tokenCookie(token), "cache-control": "no-store" });
        res.end();
        return;
      }
      if (req.method === "GET" && app.serve(res, path)) return;
      if (path.startsWith("/api/")) {
        if (token) {
          const source = tokenSource(req, url, token);
          if (!source) return json(res, 401, { error: "a valid access token is needed (open the address the server printed)" }, { "www-authenticate": "Bearer" });
        }
        return api(req, res, url, path);
      }
      json(res, 404, { error: "not found" });
    })().catch((e: unknown) => {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      log(`error on ${req.method} ${path}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return {
    server,
    port,
    url: `http://${shown}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        hub.shutdown();
        for (const res of streams) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
