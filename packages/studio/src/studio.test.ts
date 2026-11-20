import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionSchema, digest, replayLog } from "@acucraft/core";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { readGesture, type Sample } from "./client/world/gesture.js";
import { actionSpecs, buildClient, handleMcp, hintOf, localBackend, remoteBackend, sceneOf, startStudioServer, StudioError, StudioSession, type Snapshot, type StudioEvent, type StudioServer } from "./index.js";

const pack = loadContentPack();
const SCENARIO = "sg-knee-oa/base";

const until = async (ok: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("the action catalogue", () => {
  it("describes every action the engine accepts, and nothing else", () => {
    const specs = actionSpecs();
    expect(specs.map((s) => s.type)).toEqual(ActionSchema.options.map((o) => o.shape.type.value));
    for (const s of specs) {
      expect(s.title.length, s.type).toBeGreaterThan(0);
      expect(s.summary.length, s.type).toBeGreaterThan(0);
    }
  });

  it("carries the ranges and defaults a form needs", () => {
    const adjust = actionSpecs().find((s) => s.type === "adjust_needle")!;
    const field = (n: string) => adjust.fields.find((f) => f.name === n)!;
    expect(field("amplitudeMm").spec).toEqual({ kind: "number", min: 0.5, max: 10 });
    expect(field("arcDeg").spec).toEqual({ kind: "number", min: 30, max: 720 });
    expect(field("technique")).toMatchObject({ optional: true, default: "none", spec: { kind: "enum" } });
    expect(field("needleId").optional).toBe(false);
    const insert = actionSpecs().find((s) => s.type === "insert_needle")!;
    expect(insert.fields.find((f) => f.name === "at")!.spec).toMatchObject({ kind: "object", fields: [{ name: "u" }, { name: "v" }] });
    expect(insert.fields.find((f) => f.name === "method")).toMatchObject({ default: "single-hand" });
    const move = actionSpecs().find((s) => s.type === "move")!;
    expect(move.fields.find((f) => f.name === "to")!.spec.kind).toBe("union");
  });
});

describe("the scene", () => {
  it("is the clinic as data: walls, openings, floors and every fixture as the boxes it is made of", () => {
    const scene = sceneOf(requireScenario(pack, SCENARIO));
    expect(scene.rooms.length).toBeGreaterThanOrEqual(4);
    expect(scene.walls.reduce((n, w) => n + w.boxes.length, 0)).toBeGreaterThan(10);
    expect(scene.openings.some((o) => o.kind === "window")).toBe(true);
    expect(scene.openings.some((o) => o.kind.includes("door"))).toBe(true);
    const couch = scene.fixtures.find((f) => f.fixture?.kind === "couch")!;
    expect(couch.parts.length).toBeGreaterThan(5);
    expect(couch.footprint.d).toBeGreaterThan(1.5);
    for (const f of scene.fixtures) for (const part of f.parts) expect(scene.materials[part.m], `${f.type}: material ${part.m}`).toBeDefined();
    // charts without patient geometry: a landmark is named, never placed
    expect(JSON.stringify(scene.regions)).not.toMatch(/"at"|"palpation"|"structures"|"tissue"/);
  });
});

describe("the session", () => {
  it("acts through the engine and reports what happened, with the walk a refusal names", () => {
    const session = new StudioSession(pack, { scenario: SCENARIO });
    const before = session.snapshot();
    expect(before.session).toMatchObject({ mode: "assessment", version: 0, finished: false, steps: 0, canUndo: false, reportReady: false });
    const far = session.act({ action: { type: "move", to: { room: "prep-area" } }, via: "operator" });
    expect(far.attempt.status).toBe("executed");
    expect(far.snapshot.stage.walks.length).toBe(1);
    expect(far.snapshot.stage.walks[0]!.path.length).toBeGreaterThan(1);
    const refused = session.act({ action: { type: "check_vitals" }, via: "operator" });
    expect(refused.attempt.status).toBe("rejected");
    expect(refused.attempt.hint).toEqual({ type: "move", to: { person: "patient" } });
    const back = session.act({ action: refused.attempt.hint, via: "operator" });
    expect(back.attempt.status).toBe("executed");
    expect(session.act({ action: { type: "check_vitals" }, via: "operator" }).attempt.status).toBe("executed");
    expect(session.snapshot().feed.map((f) => f.type)).toEqual(["move", "check_vitals", "move", "check_vitals"]);
    expect(() => session.act({ action: "observe" })).toThrow(StudioError);
    expect(hintOf('Go to it first: move {"to":{"fixture":"prep-sink"}}.')).toEqual({ type: "move", to: { fixture: "prep-sink" } });
    expect(hintOf("nothing to walk to")).toBeUndefined();
  });

  it("keeps what is hidden on the server in assessment mode", () => {
    const session = new StudioSession(pack, { scenario: SCENARIO });
    const agent = session.attachAgent("reference");
    return agent.then(async () => {
      // far enough into the reference encounter for needles to be in
      for (let i = 0; i < 400 && session.snapshot().view.needling.length < 2; i++) await session.stepAgent();
      const snap = session.snapshot();
      expect(snap.view.needling.length).toBeGreaterThanOrEqual(2);
      const text = JSON.stringify(snap);
      expect(snap.teaching).toBeUndefined();
      expect(text).not.toContain(session.sc.id);
      for (const hidden of ['"tipTissue"', '"intensity"', '"strata"', '"structures"', '"toleranceCm"', '"overstimulated"']) expect(text, hidden).not.toContain(hidden);
      expect(() => session.teachingRegion("knee-leg", "right")).toThrow(/teaching mode only/);
      expect(() => session.teachingProbe({ region: "knee-leg", side: "right", u: 0, v: 0, angleDeg: 0, azimuthDeg: 0, depthCm: 2 })).toThrow(StudioError);
      expect(() => session.report()).toThrow(/finished/);
      expect(() => session.undo()).toThrow(StudioError);
      expect(() => session.view("assistant")).toThrow(StudioError);
    });
  });

  it("shows what lies under the skin in teaching mode, and takes an action back", async () => {
    const session = new StudioSession(pack, { scenario: SCENARIO, mode: "teaching" });
    const region = session.teachingRegion("knee-leg", "right");
    expect(region.landmarks.length).toBeGreaterThan(3);
    expect(region.layers[0]!.tissue).toBe("skin");
    expect(region.structures.length).toBeGreaterThan(0);
    const probe = session.teachingProbe({ region: "knee-leg", side: "right", u: region.landmarks[0]!.u, v: region.landmarks[0]!.v, angleDeg: 0, azimuthDeg: 0, depthCm: 1.5 });
    expect(probe.strata[0]!.from).toBe(0);
    expect(probe.traversed[0]).toBe("skin");
    await session.attachAgent("reference");
    for (let i = 0; i < 400 && session.snapshot().view.needling.length < 1; i++) await session.stepAgent();
    const snap = session.snapshot();
    expect(snap.teaching!.needles.length).toBe(1);
    expect(snap.teaching!.needles[0]!.strata.length).toBeGreaterThan(2);
    expect(snap.session.reportReady).toBe(true);
    expect(session.report().schema).toBe("acucraft/report@2");
    const steps = snap.session.steps;
    const version = snap.session.version;
    const undone = session.undo();
    expect(undone.session.steps).toBe(steps - 1);
    expect(undone.session.version).toBeLessThan(version);
    expect(undone.view.needling.length).toBe(0);
    expect(undone.agent.name).toBeNull();
  });

  it("lets a built-in agent run the encounter, and the operator stop it and step in", async () => {
    const session = new StudioSession(pack, { scenario: SCENARIO });
    const events: StudioEvent[] = [];
    session.on((e) => events.push(e));
    await session.attachAgent("protocol", { stepDelayMs: 0 });
    const proposed = await session.proposeAgent();
    expect(proposed.pending?.action).toMatchObject({ type: expect.any(String) });
    expect(session.snapshot().session.steps).toBe(0);
    const first = await session.stepAgent();
    expect("attempt" in first && first.attempt.via).toBe("agent");
    expect("attempt" in first && first.attempt.agent).toBe("protocol");
    expect("attempt" in first && first.attempt.action).toEqual(proposed.pending!.action);
    // slow enough to be caught at work
    session.setStepDelay(15);
    session.runAgent();
    await until(() => session.snapshot().session.steps >= 4);
    expect(() => session.act({ action: { type: "observe" }, via: "operator" })).toThrow(/Pause it first/);
    const mine = session.act({ action: { type: "observe" }, via: "operator", takeover: true });
    expect(mine.attempt.via).toBe("operator");
    expect(session.agentStatus().running).toBe(false);
    session.setStepDelay(0);
    session.runAgent();
    await until(() => session.snapshot().session.finished || !session.agentStatus().running, 60000);
    const snap = session.snapshot();
    expect(snap.session.finished).toBe(true);
    expect(session.report().primary.status).toBeDefined();
    // the log is the whole encounter: replaying it reproduces the state, whoever took each step
    const log = session.log();
    expect((log.meta as { via: string[] }).via).toContain("operator");
    expect(digest(replayLog(session.sc, log).state)).toBe(log.finalDigest);
    expect(events.some((e) => e.cause === "step" && e.added[0]?.via === "agent")).toBe(true);
  }, 90000);

  it("reports an agent that cannot run here instead of attaching it", async () => {
    const session = new StudioSession(pack, { scenario: SCENARIO, agents: { model: { label: "a model without a key", make: () => ({ name: "x", next: () => ({ done: true }) }), ready: () => "no key" } } });
    await expect(session.attachAgent("model")).rejects.toThrow(/no key/);
    await expect(session.attachAgent("nobody")).rejects.toThrow(/no agent nobody/);
    expect(session.agentStatus().available.find((a) => a.name === "model")).toMatchObject({ ready: false, why: "no key" });
  });
});

describe("the HTTP interface", () => {
  let studio: StudioServer;
  let dist: string;
  const get = async (path: string, headers: Record<string, string> = {}) => fetch(`${studio.url}${path}`, { headers });
  const post = async (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`${studio.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), "acucraft-studio-"));
    await buildClient({ outDir: dist, minify: false });
    studio = await startStudioServer({ pack, scenario: SCENARIO, port: 0, clientDir: dist });
  }, 120000);
  afterAll(async () => {
    await studio.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the client it built, without the engine in it", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const app = readFileSync(join(dist, "app.js"), "utf8");
    expect(app.length).toBeGreaterThan(1000);
    // the page is given what it shows as JSON: nothing of the engine or of a scenario is compiled into it
    for (const engine of ["acucraft/encounter@", "needle-response", "DEQI_THRESHOLD", "createEncounter"]) expect(app).not.toContain(engine);
    expect((await get("/app.js")).headers.get("content-type")).toContain("javascript");
    expect((await get("/../package.json")).status).toBe(404);
    expect((await get("/nothing.js")).status).toBe(404);
  });

  it("gives the session, the scene, the catalogue and the library", async () => {
    expect(await (await get("/api/health")).json()).toMatchObject({ ok: true });
    const scenarios = (await (await get("/api/scenarios")).json()) as { id: string }[];
    expect(scenarios.map((s) => s.id)).toContain(SCENARIO);
    const snap = (await (await get("/api/session")).json()) as Snapshot;
    expect(snap.view.schema).toBe("acucraft/view@2");
    expect(((await (await get("/api/session/scene")).json()) as { fixtures: unknown[] }).fixtures.length).toBeGreaterThan(10);
    expect(((await (await get("/api/session/actions")).json()) as unknown[]).length).toBe(ActionSchema.options.length);
    expect(await (await get("/api/session/actions?format=text")).text()).toContain("- adjust_needle");
    expect(await (await get("/api/session/library?topic=techniques")).json()).toBeTruthy();
    expect(((await (await get("/api/session/library?topic=point&id=ST36")).json()) as { id: string }).id).toBe("ST36");
  });

  it("acts on JSON only, from its own address only, and says why not otherwise", async () => {
    const ok = await post("/api/session/act", { action: { type: "observe" }, via: "operator" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { attempt: { status: string } }).attempt.status).toBe("executed");
    expect((await post("/api/session/act", { action: { type: "observe" } }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/api/session/act", { action: 3 })).status).toBe(400);
    expect((await post("/api/session/act", { action: { type: "observe" } }, { "content-type": "application/json", origin: "https://elsewhere.example" })).status).toBe(403);
    const stale = (await (await post("/api/session/act", { action: { type: "observe" }, expectedVersion: 0 })).json()) as { attempt: { status: string; code: string } };
    expect(stale.attempt).toMatchObject({ status: "rejected", code: "stale-version" });
    expect((await post("/api/session/act", { action: { type: "observe" } }, { "content-type": "application/json", origin: "null" })).status).toBe(403);
    expect((await get("/api/session/report")).status).toBe(403);
    // the log names the variant: not before the end
    expect((await get("/api/session/log")).status).toBe(403);
    expect((await get("/api/session/teaching?region=knee-leg&side=right")).status).toBe(403);
    expect((await post("/api/session/undo", {})).status).toBe(403);
    expect((await post("/api/session/agent", { agent: "nobody" })).status).toBe(404);
    expect((await get("/api/nothing")).status).toBe(404);
  });

  it("streams every change to whoever listens", async () => {
    const res = await get("/api/session/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<StudioEvent> => {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)) as StudioEvent;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const hello = await next();
    expect(hello.snapshot.session.id).toBe(studio.session().id);
    await post("/api/session/act", { action: { type: "say", text: "Good morning." }, via: "operator" });
    const step = await next();
    expect(step).toMatchObject({ cause: "step", added: [{ type: "say", via: "operator" }] });
    await reader.cancel();
  });

  it("starts another encounter on request, in teaching mode with what that shows", async () => {
    const fresh = (await (await post("/api/session", { scenario: SCENARIO, mode: "teaching", seed: 3 })).json()) as Snapshot;
    expect(fresh.session).toMatchObject({ mode: "teaching", seed: 3, steps: 0 });
    expect(fresh.view.teaching).toBeDefined();
    expect((await get("/api/session/teaching?region=knee-leg&side=right")).status).toBe(200);
    expect((await get("/api/session/teaching/probe?region=knee-leg&side=right&u=1&v=2&depthCm=2")).status).toBe(200);
    expect((await get("/api/session/report")).status).toBe(200);
    expect(((await (await get("/api/session/log")).json()) as { scenarioId: string }).scenarioId).toBe(SCENARIO);
    expect(await (await get("/api/session/review")).text()).toContain("<svg");
    expect((await post("/api/session", { scenario: "no/such" })).status).toBe(500);
    await post("/api/session", { scenario: SCENARIO, mode: "assessment", seed: 1 });
  });

  it("is the practitioner's three tools to an MCP client, on the encounter the studio shows", async () => {
    const backend = remoteBackend(studio.url);
    const init = (await handleMcp(backend, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { protocolVersion: string; instructions: string } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.instructions).toContain("adjust_needle");
    expect(await handleMcp(backend, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const tools = (await handleMcp(backend, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).toEqual(["act", "view", "lookup", "report"]);
    const call = async (name: string, args: unknown) => {
      const r = (await handleMcp(backend, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } })) as { result: { content: { text: string }[]; isError?: boolean } };
      return { json: JSON.parse(r.result.content[0]!.text) as Record<string, unknown>, isError: r.result.isError === true };
    };
    const acted = await call("act", { action: { type: "ask", text: "What brings you in today?" } });
    expect((acted.json.result as { status: string }).status).toBe("executed");
    expect(studio.session().snapshot().feed.at(-1)).toMatchObject({ type: "ask", via: "mcp" });
    expect((await call("view", {})).json.schema).toBe("acucraft/view@2");
    expect((await call("lookup", { topic: "deqi" })).json).toBeTruthy();
    expect(await call("report", {})).toMatchObject({ isError: true, json: { error: "not-finished" } });
    expect((await handleMcp(backend, { jsonrpc: "2.0", id: 4, method: "nothing/here" })) as { error: { code: number } }).toMatchObject({ error: { code: -32601 } });
    // the same tools on a session of the bridge's own
    const own = localBackend(new StudioSession(pack, { scenario: SCENARIO }));
    const r = (await handleMcp(own, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "act", arguments: { type: "observe" } } })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(r.result.content[0]!.text).result.status).toBe("executed");
  });
});

describe("a needle worked by hand", () => {
  /** Samples every 20 ms of a movement given as functions of the time in seconds. */
  const record = (seconds: number, lift: (t: number) => number, turn: (t: number) => number = () => 0): Sample[] => {
    const out: Sample[] = [];
    for (let ms = 0; ms <= seconds * 1000; ms += 20) out.push({ t: ms, lift: lift(ms / 1000), turn: turn(ms / 1000) });
    return out;
  };
  const wave = (t: number, hz: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * hz * t);

  it("is read as lifting and thrusting, with its stroke, its rate and the stroke that was quicker", () => {
    const even = readGesture("n1", record(4, (t) => 0.3 * wave(t, 1.5))).gesture!;
    expect(even).toMatchObject({ needle: "n1", technique: "lift-thrust", emphasis: "even", durationSec: 4 });
    expect(even.amplitudeMm).toBeCloseTo(3, 0);
    expect(even.frequencyPerMin).toBeGreaterThan(80);
    expect(even.frequencyPerMin).toBeLessThan(100);
    // a slow lift and a quick thrust, each second
    const thrust = readGesture("n1", record(5, (t) => { const p = t % 1; return 0.4 * (p < 0.8 ? p / 0.8 : (1 - p) / 0.2); })).gesture!;
    expect(thrust).toMatchObject({ technique: "lift-thrust", emphasis: "thrust" });
    const lift = readGesture("n1", record(5, (t) => { const p = t % 1; return 0.4 * (p < 0.2 ? p / 0.2 : (1 - p) / 0.8); })).gesture!;
    expect(lift.emphasis).toBe("lift");
  });

  it("is read as twirling: back and forth by its arc, or one way by the whole turn", () => {
    const both = readGesture("n1", record(4, () => 0, (t) => (Math.PI / 2) * Math.sin(2 * Math.PI * 1.2 * t))).gesture!;
    expect(both).toMatchObject({ technique: "rotate", direction: "both" });
    expect(both.arcDeg).toBeGreaterThanOrEqual(170);
    expect(both.arcDeg).toBeLessThanOrEqual(185);
    expect(both.frequencyPerMin).toBeGreaterThan(60);
    const oneWay = readGesture("n1", record(3, () => 0, (t) => (-2 * Math.PI * t) / 3)).gesture!;
    expect(oneWay).toMatchObject({ technique: "rotate", direction: "clockwise", arcDeg: 360 });
    expect(oneWay.frequencyPerMin).toBeUndefined();
    expect(readGesture("n1", record(3, () => 0, (t) => (Math.PI * t) / 3)).gesture).toMatchObject({ direction: "counter-clockwise", arcDeg: 180 });
  });

  it("is read as trembling when the strokes are minute and fast, and stays within what the engine accepts", () => {
    expect(readGesture("n1", record(3, (t) => 0.05 * wave(t, 5))).gesture).toMatchObject({ technique: "tremble", durationSec: 3 });
    const wild = readGesture("n1", record(4, (t) => 1 * wave(t, 3.9), (t) => 0.1 * Math.sin(t))).gesture!;
    expect(wild.amplitudeMm).toBeLessThanOrEqual(10);
    expect(wild.frequencyPerMin).toBeLessThanOrEqual(240);
    const spec = actionSpecs().find((a) => a.type === "adjust_needle")!;
    for (const key of ["amplitudeMm", "frequencyPerMin", "arcDeg", "durationSec"] as const) expect(spec.fields.some((f) => f.name === key), key).toBe(true);
  });

  it("is not sent when the needle was only held, or worked for less than two seconds", () => {
    expect(readGesture("n1", record(3, () => 0))).toMatchObject({ gesture: null, why: expect.stringContaining("held") });
    expect(readGesture("n1", record(1.2, (t) => 0.3 * wave(t, 2)))).toMatchObject({ gesture: null, why: expect.stringContaining("at least 2 s") });
    expect(readGesture("n1", [])).toMatchObject({ gesture: null });
  });
});
