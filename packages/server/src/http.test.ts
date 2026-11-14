import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadContentPack } from "@acucraft/bench";
import { RecordHub } from "./hub.js";
import { serve, type RunningServer } from "./http.js";
import { labelOf } from "../web/stage/hud.js";
import { siteOfInsertion } from "../web/stage/sites.js";

/**
 * The workspace over HTTP (docs/WEB.md): the API, the event stream, MCP over Streamable HTTP, the browser app and
 * the 3D view's assets — and what keeps them to the operator: loopback, the token, the Host and Origin checks.
 */

const pack = loadContentPack();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

/** A request with full control of its headers (fetch would set Host and Origin itself). */
function call(base: string, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const by = { name: "Ann Tan", tab: "tab-1" };

describe("the workspace on its loopback address", () => {
  let server: RunningServer;
  let base: string;
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "acu-http-"));
    dirs.push(dataDir);
    server = await serve({ hub: new RecordHub({ pack, dataDir }), port: 0, engineDir: null });
    base = server.url;
  });
  afterAll(async () => {
    await server.close();
  });

  it("serves the app: the page, its styles, its modules as JavaScript with the types erased, under a strict CSP", async () => {
    const page = await call(base, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain('<script type="module" src="/app/main.js">');
    expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    const mod = await call(base, "GET", "/app/record.js");
    expect(mod.status).toBe(200);
    expect(mod.headers["content-type"]).toContain("text/javascript");
    expect(mod.text).toContain("export function renderRecord");
    expect(mod.text).not.toMatch(/^import type /m);
    expect((await call(base, "GET", "/app/../src/http.js")).status).toBe(404);
    expect((await call(base, "GET", "/app/styles.css")).headers["content-type"]).toContain("text/css");
  });

  it("says when there is no 3D view, and serves the clinic's models for one", async () => {
    const info = await call(base, "GET", "/api/info");
    expect(info.json.stage).toEqual({ available: false, missing: expect.stringContaining("") });
    expect((await call(base, "GET", "/app/stage.js")).status).toBe(404);
    const couch = await call(base, "GET", "/app/models/acu-treatment-couch.glb");
    expect(couch.status).toBe(200);
    expect(couch.headers["content-type"]).toBe("model/gltf-binary");
    expect(couch.text.slice(0, 4)).toBe("glTF");
    const again = await call(base, "GET", "/app/models/acu-treatment-couch.glb", { headers: { "if-none-match": String(couch.headers.etag) } });
    expect(again.status).toBe(304);
    expect((await call(base, "GET", "/app/models/..%2Fcatalogs%2Facucraft-tcm.json")).status).toBe(404);
    expect((await call(base, "GET", "/app/models/nothing-here.glb")).status).toBe(404);
  });

  it("works a record over the API: create, act, the stage's people, close as it stands, the debrief only once closed", async () => {
    const made = await call(base, "POST", "/api/encounters", { body: { family: "sg-knee-oa", variant: 1, by } });
    expect(made.status).toBe(201);
    const id = made.json.id as string;
    const asked = await call(base, "POST", `/api/encounters/${id}/act`, { body: { tool: "ask", input: { text: "What brings you in today?" }, by } });
    expect(asked.status).toBe(200);
    expect(asked.json.ok).toBe(true);
    expect(asked.json.entry.by).toMatchObject({ kind: "operator", name: "Ann Tan" });
    const stage = await call(base, "GET", `/api/encounters/${id}/stage`);
    expect(stage.status).toBe(200);
    expect(stage.json.patient.heightCm).toBeGreaterThan(100);
    expect(stage.json.patient.appearance).toMatchObject({ presentation: "feminine" });
    expect(stage.json.models["acu-treatment-couch"].file).toBe("models/acu-treatment-couch.glb");
    // nothing hidden in what the stage is given
    expect(JSON.stringify(stage.json)).not.toMatch(/variant|warfarin|diagnos/i);
    expect((await call(base, "GET", `/api/encounters/${id}/debrief`)).status).toBe(409);
    const closed = await call(base, "POST", `/api/encounters/${id}/close`, { body: { abandon: true, by } });
    expect(closed.status).toBe(200);
    const debrief = await call(base, "GET", `/api/encounters/${id}/debrief`);
    expect(debrief.status).toBe(200);
    expect(String(debrief.headers["content-security-policy"])).toContain("default-src 'none'");
    // refused like any action the engine refuses: answered, not done
    const late = await call(base, "POST", `/api/encounters/${id}/act`, { body: { tool: "observe", input: {}, by } });
    expect(late.status).toBe(200);
    expect(late.json).toMatchObject({ ok: false, output: { error: expect.stringContaining("closed") } });
    expect((await call(base, "GET", "/api/encounters/enc-000000000000")).status).toBe(404);
  });

  it("refuses another site's page and another host name (DNS rebinding)", async () => {
    const other = await call(base, "GET", "/api/encounters", { headers: { origin: "https://evil.example" } });
    expect(other.status).toBe(403);
    const same = await call(base, "GET", "/api/encounters", { headers: { origin: base.replace(/\/$/, "") } });
    expect(same.status).toBe(200);
    const rebound = await call(base, "GET", "/api/encounters", { headers: { host: "evil.example" } });
    expect(rebound.status).toBe(403);
  });

  it("streams every change to every browser (server-sent events)", async () => {
    const made = await call(base, "POST", "/api/encounters", { body: { family: "sg-low-back-pain", variant: 1, by } });
    const id = made.json.id as string;
    const url = new URL(`/api/stream?encounter=${id}`, base);
    const got: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { accept: "text/event-stream" } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          got.push(chunk);
          const all = got.join("");
          if (all.includes("event: hello") && all.includes("event: update")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e) => (got.join("").includes("event: update") ? resolve() : reject(e)));
      req.end();
      setTimeout(() => void call(base, "POST", `/api/encounters/${id}/act`, { body: { tool: "observe", input: {}, by } }), 150);
    });
    await done;
    const all = got.join("");
    expect(all).toContain("event: hello");
    const update = all.split("event: update\ndata: ")[1]!.split("\n")[0]!;
    expect(JSON.parse(update).entry).toMatchObject({ tool: "observe", by: { name: "Ann Tan" } });
  });

  it("speaks MCP over Streamable HTTP: a session on initialize, tools, notifications accepted, no GET stream, closed with DELETE", async () => {
    const init = await call(base, "POST", "/mcp", { headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } } } });
    expect(init.status).toBe(200);
    const session = String(init.headers["mcp-session-id"]);
    expect(session).toMatch(/^[0-9a-f-]{16,}$/);
    expect(init.json.result.serverInfo.name).toBeTruthy();
    const note = await call(base, "POST", "/mcp", { headers: { "mcp-session-id": session }, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(note.status).toBe(202);
    const tools = await call(base, "POST", "/mcp", { headers: { "mcp-session-id": session }, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = (tools.json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["start_encounter", "list_open_encounters"]));
    const open = await call(base, "POST", "/mcp", { headers: { "mcp-session-id": session }, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_open_encounters", arguments: {} } } });
    expect(open.json.result.content[0].text).toContain("enc-");
    expect((await call(base, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 4, method: "tools/list" } })).status).toBe(400);
    expect((await call(base, "GET", "/mcp")).status).toBe(405);
    expect((await call(base, "DELETE", "/mcp", { headers: { "mcp-session-id": session } })).status).toBe(204);
    expect((await call(base, "POST", "/mcp", { headers: { "mcp-session-id": session }, body: { jsonrpc: "2.0", id: 5, method: "tools/list" } })).status).toBe(404);
  });
});

describe("the workspace with an access token", () => {
  let server: RunningServer;
  let base: string;
  const token = "a-long-enough-test-token-0123456789";
  beforeAll(async () => {
    server = await serve({ hub: new RecordHub({ pack }), port: 0, token, engineDir: null });
    base = server.url;
  });
  afterAll(async () => {
    await server.close();
  });

  it("asks for the token on the API and /mcp, takes it as a Bearer, or once in the address, which becomes a cookie", async () => {
    expect((await call(base, "GET", "/api/encounters")).status).toBe(401);
    expect((await call(base, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status).toBe(401);
    expect((await call(base, "GET", "/api/encounters", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(base, "GET", "/api/encounters", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const opened = await call(base, "GET", `/?token=${token}`);
    expect(opened.status).toBe(303);
    expect(opened.headers.location).toBe("/");
    const cookie = String(opened.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const pair = cookie.split(";")[0]!;
    expect((await call(base, "GET", "/api/encounters", { headers: { cookie: pair } })).status).toBe(200);
  });

  it("will not listen beyond loopback without a token", async () => {
    await expect(serve({ hub: new RecordHub({ pack }), host: "0.0.0.0", port: 0, engineDir: null })).rejects.toThrow(/token/);
  });
});

describe("the 3D view's reading of the record", () => {
  it("finds where a needle went in: at its mark, or at the place given with it", () => {
    const marks = [{ id: "m1", region: "lumbar", side: "left", u: 3.3, v: 6.9 }];
    expect(siteOfInsertion({ mark: "m1" }, marks)).toEqual({ region: "lumbar", side: "left", u: 3.3, v: 6.9 });
    expect(siteOfInsertion({ mark: "m9" }, marks)).toBeNull();
    expect(siteOfInsertion({ region: "knee-leg", side: "right", at: { u: 1, v: -7 } }, marks)).toEqual({ region: "knee-leg", side: "right", u: 1, v: -7 });
    expect(siteOfInsertion({ region: "knee-leg" }, marks)).toBeNull();
  });

  it("labels a needle by its point and side, an ashi point by itself", () => {
    expect(labelOf("ST36:left")).toEqual({ name: "ST36", side: "L" });
    expect(labelOf("GV3:midline")).toEqual({ name: "GV3", side: "" });
    expect(labelOf("ashi:ashi-right-l45")).toEqual({ name: "ashi", side: "R" });
  });
});
