import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { ACUCRAFT_VERSION, type Mode, type Side } from "@acucraft/core";
import { CLINICALCRAFT_REV, actionCatalogue, loadContentPack, lookup, scenarioIds, type ContentPack } from "@acucraft/bench";
import { actionSpecs } from "./catalogue.js";
import { StudioError, StudioSession, type StudioEvent, type StudioOptions, type Via } from "./session.js";

/**
 * The studio's HTTP interface (docs/STUDIO.md): the session as JSON, live events (server-sent), and the client's
 * files. No framework and no dependency: `node:http`. It listens on the loopback address unless told otherwise, takes
 * JSON bodies only and checks the Host header, so a page on another origin cannot drive a session behind your back.
 */

export interface StudioServerOptions extends Partial<StudioOptions> {
  port?: number;
  host?: string;
  pack?: ContentPack;
  contentDir?: string;
  /** Directory of the built client (index.html, app.js, app.css); absent: the API alone. */
  clientDir?: string | null;
}

export interface StudioServer {
  server: Server;
  url: string;
  port: number;
  session(): StudioSession;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const MAX_BODY = 512 * 1024;

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) throw new StudioError(415, "json-only", "Send a JSON body (content-type: application/json).");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new StudioError(413, "too-large", "The request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StudioError(400, "invalid-json", "The request body is not valid JSON.");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new StudioError(400, "invalid-json", "The request body must be a JSON object.");
  return json as Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const modeOf = (v: unknown): Mode | undefined => (v === "teaching" || v === "assessment" ? v : undefined);
const viaOf = (v: unknown): Via => (v === "operator" || v === "mcp" ? v : "api");

/** The scenario families of the pack, each with the ids of its variants. */
export function listScenarios(pack: ContentPack) {
  return [...pack.families.values()].map((f) => {
    const source = f.source.family as { title?: string; condition?: string } | undefined;
    return { id: f.id, title: source?.title ?? f.id, condition: source?.condition ?? null, split: f.split, variants: [...f.variantIds] };
  });
}

/** Start the studio. `port: 0` takes any free port (tests). */
export async function startStudioServer(opts: StudioServerOptions = {}): Promise<StudioServer> {
  const pack = opts.pack ?? loadContentPack(opts.contentDir);
  const host = opts.host ?? "127.0.0.1";
  const open = host === "0.0.0.0" || host === "::";
  const first = opts.scenario ?? scenarioIds(pack)[0];
  if (!first) throw new Error("the content pack has no scenario");
  const session = new StudioSession(pack, { scenario: first, ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.agents ? { agents: opts.agents } : {}) });
  const streams = new Set<ServerResponse>();
  const broadcast = (e: StudioEvent) => {
    const data = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of streams) res.write(data);
  };
  const off = session.on(broadcast);
  const clientDir = opts.clientDir ?? null;

  const file = (res: ServerResponse, name: string): boolean => {
    if (!clientDir || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
    const path = join(clientDir, name);
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(readFileSync(path));
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://studio");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    // a request must be addressed to this server by name: no other origin's page can reach it through a rebound name.
    // Bound to every address (0.0.0.0, ::) it has no one name: whoever binds it so has opened it to the network.
    const named = String(req.headers.host ?? "");
    const bare = (h: string) => h.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!open && !new Set(["127.0.0.1", "localhost", "::1", bare(host)]).has(bare(named))) throw new StudioError(403, "host", "This server answers on its own address only.");
    const origin = req.headers.origin;
    if (origin && method !== "GET") {
      let from = "";
      try {
        from = new URL(origin).host;
      } catch {
        // an opaque origin ("null") is not this server's page
      }
      // the same origin: the page this server served, on this port
      if (from.toLowerCase() !== named.toLowerCase()) throw new StudioError(403, "origin", "Cross-origin requests are not accepted.");
    }
    const q = url.searchParams;

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new StudioError(405, "method", "Not allowed.");
      const name = path === "/" ? "index.html" : path.slice(1);
      if (file(res, name)) return;
      if (path === "/" && !clientDir) return send(res, 200, "<!doctype html><title>AcuCraft studio</title><p>The studio API is running. The 3D client was not built: run <code>npm run studio:build</code>.</p>", TYPES[".html"]);
      throw new StudioError(404, "not-found", `There is no ${path}.`);
    }

    if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true, acucraft: ACUCRAFT_VERSION, clinicalcraft: CLINICALCRAFT_REV, session: session.id });
    if (path === "/api/scenarios" && method === "GET") return send(res, 200, listScenarios(pack));

    if (path === "/api/session" && method === "GET") return send(res, 200, session.snapshot(undefined, str(q.get("as"))));
    if (path === "/api/session" && method === "POST") {
      const body = await readBody(req);
      const seed = num(body.seed);
      const mode = modeOf(body.mode);
      const snapshot = session.reset({ ...(str(body.scenario) ? { scenario: str(body.scenario)! } : {}), ...(seed !== undefined ? { seed } : {}), ...(mode ? { mode } : {}) });
      return send(res, 200, snapshot);
    }
    if (path === "/api/session/view" && method === "GET") return send(res, 200, session.view(str(q.get("as"))));
    if (path === "/api/session/scene" && method === "GET") return send(res, 200, session.scene());
    if (path === "/api/session/actions" && method === "GET") return send(res, 200, q.get("format") === "text" ? actionCatalogue() : actionSpecs(), q.get("format") === "text" ? "text/plain; charset=utf-8" : undefined);
    if (path === "/api/session/library" && method === "GET") {
      const topic = str(q.get("topic"));
      return send(res, 200, topic ? (lookup(session.library(), { topic, ...(str(q.get("id")) ? { id: str(q.get("id"))! } : {}) }) ?? null) : session.library());
    }
    if (path === "/api/session/log" && method === "GET") {
      // the log names the scenario's variant: in assessment mode it is given when the encounter is over, as the report is
      if (!session.state.finished && session.mode !== "teaching") throw new StudioError(403, "not-finished", "The log is given when the encounter has finished (it names the scenario's variant). In teaching mode it can be read at any time.");
      return send(res, 200, session.log());
    }
    if (path === "/api/session/report" && method === "GET") return send(res, 200, q.get("format") === "markdown" ? session.reportMarkdown() : session.report(), q.get("format") === "markdown" ? "text/markdown; charset=utf-8" : undefined);
    if (path === "/api/session/review" && method === "GET") return send(res, 200, session.reviewHtml(), TYPES[".html"]);

    if (path === "/api/session/teaching" && method === "GET") {
      const region = str(q.get("region"));
      const side = str(q.get("side")) as Side | undefined;
      if (!region || !side || !["left", "right", "midline"].includes(side)) throw new StudioError(400, "bad-request", "Give a region and a side (left, right, midline).");
      return send(res, 200, session.teachingRegion(region, side));
    }
    if (path === "/api/session/teaching/probe" && method === "GET") {
      const region = str(q.get("region"));
      const side = str(q.get("side")) as Side | undefined;
      const [u, v, angleDeg, azimuthDeg, depthCm] = ["u", "v", "angleDeg", "azimuthDeg", "depthCm"].map((k) => num(q.get(k)));
      if (!region || !side || !["left", "right", "midline"].includes(side) || u === undefined || v === undefined || depthCm === undefined) throw new StudioError(400, "bad-request", "Give region, side, u, v and depthCm (angleDeg and azimuthDeg default to 0).");
      return send(res, 200, session.teachingProbe({ region, side, u, v, angleDeg: Math.min(90, Math.max(0, angleDeg ?? 0)), azimuthDeg: azimuthDeg ?? 0, depthCm: Math.min(10, Math.max(0.05, depthCm)) }));
    }

    if (path === "/api/session/events" && method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`retry: 1500\n\nevent: state\ndata: ${JSON.stringify({ type: "state", cause: "reset", added: [], snapshot: session.snapshot() } satisfies StudioEvent)}\n\n`);
      streams.add(res);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 20000);
      req.on("close", () => {
        clearInterval(beat);
        streams.delete(res);
      });
      return;
    }

    if (method !== "POST") throw new StudioError(path.startsWith("/api/session") ? 405 : 404, "not-found", `There is no ${method} ${path}.`);
    const body = await readBody(req);
    if (path === "/api/session/act") {
      const expectedVersion = num(body.expectedVersion);
      const result = session.act({
        action: body.action,
        via: viaOf(body.via),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(str(body.note) ? { note: str(body.note)! } : {}),
        ...(body.takeover === true ? { takeover: true } : {}),
        ...(str(body.as) ? { as: str(body.as)! } : {}),
      });
      return send(res, 200, result);
    }
    if (path === "/api/session/undo") return send(res, 200, session.undo());
    if (path === "/api/session/agent") {
      const delay = num(body.stepDelayMs);
      const name = body.agent === null ? null : str(body.agent);
      if (name === undefined) {
        if (delay === undefined) throw new StudioError(400, "bad-request", "Give an agent name (or null to detach), or a stepDelayMs.");
        session.setStepDelay(delay);
        return send(res, 200, session.agentStatus());
      }
      const status = await session.attachAgent(name, { ...(delay !== undefined ? { stepDelayMs: delay } : {}), ...(str(body.model) ? { model: str(body.model)! } : {}), ...(str(body.effort) ? { effort: str(body.effort)! } : {}) });
      if (body.run === true && name !== null) return send(res, 200, session.runAgent());
      return send(res, 200, status);
    }
    if (path === "/api/session/agent/run") return send(res, 200, session.runAgent());
    if (path === "/api/session/agent/pause") return send(res, 200, session.pauseAgent());
    if (path === "/api/session/agent/propose") return send(res, 200, await session.proposeAgent());
    if (path === "/api/session/agent/discard") return send(res, 200, session.discardProposal());
    if (path === "/api/session/agent/step") return send(res, 200, await session.stepAgent());
    throw new StudioError(404, "not-found", `There is no ${method} ${path}.`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof StudioError) send(res, e.status, { error: e.code, message: e.message });
      else send(res, 500, { error: "internal", message: (e as Error).message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4173, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    port,
    url: `http://${shown}:${port}`,
    session: () => session,
    close: () =>
      new Promise<void>((resolve) => {
        off();
        session.detachAgent();
        for (const res of streams) res.end();
        streams.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
