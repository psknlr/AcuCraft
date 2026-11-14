import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digest, replayLog } from "@acucraft/core";
import { referenceAgent } from "@acucraft/agent";
import { loadContentPack, requireScenario, runEpisode } from "@acucraft/bench";
import { McpServer } from "@acucraft/mcp";
import { operator, RecordHub, type HubEvent } from "./hub.js";

/**
 * The live records of the workspace (docs/WEB.md): one engine session per encounter that an operator, the server's
 * language model and MCP clients work on together — every action attributed, kept, replayable and told to everyone.
 */

const pack = loadContentPack();
const ann = operator("Ann Tan", "tab-1");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "acu-hub-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const started = (hub: RecordHub, args: Record<string, unknown> = { family: "sg-knee-oa", variant: 3 }) => {
  const made = hub.create(args, ann);
  expect(made.status).toBe(201);
  return (made.body as { id: string }).id;
};
const act = (hub: RecordHub, id: string, tool: string, input: Record<string, unknown> = {}, by = ann) => {
  const out = hub.act(id, tool, input, by);
  expect(out.status).toBe(200);
  return out.body as { ok: boolean; output: any; entry?: any };
};

describe("a live record", () => {
  it("is worked through the practitioner's tools: each action attributed, on the timeline, told to every subscriber", () => {
    const hub = new RecordHub({ pack });
    const events: HubEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const id = started(hub);
    expect(id).toMatch(/^enc-[0-9a-f]{12}$/);
    const first = hub.snapshot(id)!;
    expect(first.summary).toMatchObject({ family: "sg-knee-oa", variant: 3, variants: 3, status: "open", actions: 0, createdBy: { kind: "operator", name: "Ann Tan" } });
    expect(first.view.record.history).toEqual([]);
    expect(first.report).toBeNull();

    const asked = act(hub, id, "ask", { text: "What brings you in today?" });
    expect(asked).toMatchObject({ ok: true, output: { status: "executed", changed: { record: { history: [{ id: "hx-chief" }] } } }, entry: { seq: 1, tool: "ask", by: { kind: "operator", name: "Ann Tan" }, status: "executed" } });
    const update = events.find((e) => e.type === "update");
    expect(update).toMatchObject({ type: "update", id, entry: { tool: "ask" }, summary: { actions: 1 } });
    expect((update as Extract<HubEvent, { type: "update" }>).view.record.history.map((h) => h.id)).toEqual(["hx-chief"]);

    // a read changes nothing and is not on the timeline
    const looked = act(hub, id, "lookup", { topic: "vocabulary" });
    expect(looked.ok).toBe(true);
    expect(looked.output).toHaveProperty("redFlags");
    // an input the engine would not take: an error, and nothing reaches it
    const bad = act(hub, id, "refer", { to: "emergency" });
    expect(bad).toMatchObject({ ok: false, output: { error: expect.stringMatching(/Not a valid refer/) } });
    expect(hub.snapshot(id)!.timeline).toHaveLength(1);
    expect(hub.act(id, "no_such_tool", {}, ann).status).toBe(400);
    expect(hub.act("enc-000000000000", "ask", {}, ann).status).toBe(404);
  });

  it("keeps the written record in the view: decisions, referrals, notes — what the practitioner wrote", () => {
    const hub = new RecordHub({ pack });
    const id = started(hub);
    act(hub, id, "decide", { disposition: "refer", rationale: "hot swollen knee with fever" });
    act(hub, id, "refer", { to: "emergency", urgency: "emergency", reason: "hot swollen knee with fever" });
    const noted = act(hub, id, "document", { record: { presentingComplaint: "Knee pain", assessment: "Possible septic arthritis", followUp: "Emergency department today" } });
    expect(noted.output.changed.documentation.notes).toEqual([expect.objectContaining({ record: expect.objectContaining({ assessment: "Possible septic arthritis" }) })]);
    const doc = hub.snapshot(id)!.view.documentation;
    expect(doc.decisions).toEqual([expect.objectContaining({ disposition: "refer", rationale: "hot swollen knee with fever" })]);
    expect(doc.referrals).toEqual([expect.objectContaining({ to: "emergency", urgency: "emergency" })]);
    expect(doc.notes[0]!.record.followUp).toBe("Emergency department today");
    expect(doc.visits).toEqual([{ visit: 1, date: expect.any(String), current: true, ended: false }]);
  });

  it("is closed as it stands (abandon) or by finishing; then evaluated, read-only, and deletable", () => {
    const hub = new RecordHub({ pack });
    const events: HubEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const id = started(hub);
    expect(hub.report(id).status).toBe(409);
    expect(hub.debrief(id).status).toBe(409);
    expect(hub.close(id, false, ann).status).toBe(409);
    const closed = hub.close(id, true, ann);
    expect(closed.status).toBe(200);
    expect((closed.body as { report: { finished: boolean } }).report.finished).toBe(false);
    expect(events.some((e) => e.type === "closed")).toBe(true);
    expect(hub.snapshot(id)!.summary).toMatchObject({ status: "closed", outcome: "failure" });
    expect(act(hub, id, "observe").output.error).toMatch(/closed/);
    expect(hub.debrief(id)).toMatchObject({ status: 200, body: expect.stringContaining("<html") });
    expect(hub.remove(id).status).toBe(200);
    expect(hub.has(id)).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "removed", id });
  });
});

describe("the server's language model on a record", () => {
  it("plays the encounter through to the end, each action applied as it is made and attributed to it", async () => {
    const hub = new RecordHub({ pack, runner: { pace: 0 } });
    const agentEvents: HubEvent[] = [];
    hub.subscribe((e) => e.type === "agent" && agentEvents.push(e));
    const id = started(hub, { family: "sg-knee-oa", variant: 3 });
    const go = hub.agent(id, "start", { provider: "reference" }, ann);
    expect(go.status).toBe(200);
    expect(hub.agent(id, "start", { provider: "reference" }, ann).status).toBe(409);
    await hub.settle();
    const snap = hub.snapshot(id)!;
    expect(snap.agent).toMatchObject({ state: "finished", provider: "reference", supervised: false });
    expect(snap.summary).toMatchObject({ status: "finished", outcome: "success" });
    expect(snap.timeline.length).toBeGreaterThan(5);
    expect(new Set(snap.timeline.map((e) => e.by.kind))).toEqual(new Set(["llm"]));
    expect(snap.agent!.transcript.some((t) => t.kind === "action")).toBe(true);
    expect(agentEvents.length).toBeGreaterThan(5);
    // the reference trajectory through the loop and the hub reaches the state the reference itself reaches
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    const reference = await runEpisode(sc, referenceAgent(sc), { seed: 1 });
    expect(digest(replayLog(sc, hub.logOf(id)!).state)).toBe(digest(reference.state));
  });

  it("waits for the operator's approval in supervised mode: approved, applied; not approved, the model is told and goes on", async () => {
    const hub = new RecordHub({ pack, runner: { pace: 0 } });
    const id = started(hub, { family: "sg-knee-oa", variant: 3 });
    hub.agent(id, "start", { provider: "reference", supervised: true }, ann);
    const waiting = async () => {
      for (let i = 0; i < 200 && hub.snapshot(id)!.agent!.state !== "awaiting-approval"; i++) await new Promise((r) => setTimeout(r, 5));
      return hub.snapshot(id)!.agent!;
    };
    const first = await waiting();
    expect(first).toMatchObject({ state: "awaiting-approval", pending: { why: "approval", tool: expect.any(String) } });
    expect(hub.snapshot(id)!.timeline).toHaveLength(0);
    // approved: applied, as the model's
    expect(hub.decide(id, true, undefined).status).toBe(200);
    const second = await waiting();
    expect(hub.snapshot(id)!.timeline.map((e) => [e.tool, e.by.kind])).toEqual([[first.pending!.tool, "llm"]]);
    // not approved: it never reaches the engine, and the model is told why
    expect(hub.decide(id, false, "not yet: wash your hands first").status).toBe(200);
    const third = await waiting();
    expect(hub.snapshot(id)!.timeline).toHaveLength(1);
    expect(third.transcript.some((t) => t.kind === "approval" && t.text === `not approved: ${second.pending!.tool} — not yet: wash your hands first`)).toBe(true);
    expect(hub.agent(id, "stop", {}, ann).status).toBe(200);
    await hub.settle();
    expect(hub.snapshot(id)!.agent).toMatchObject({ state: "stopped", pending: null });
    expect(hub.decide(id, true, undefined).status).toBe(409);
  });

  it("is paused, resumed and stopped by the operator; it is told what the operator did meanwhile", async () => {
    const hub = new RecordHub({ pack, runner: { pace: 20 } });
    const id = started(hub, { family: "sg-knee-oa", variant: 3 });
    hub.agent(id, "start", { provider: "reference" }, ann);
    for (let i = 0; i < 200 && hub.snapshot(id)!.timeline.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hub.agent(id, "pause", {}, ann).status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    const held = hub.snapshot(id)!.timeline.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(hub.snapshot(id)!.timeline.length).toBe(held);
    expect(hub.snapshot(id)!.agent!.state).toBe("paused");
    // the operator works the record while the model is paused
    act(hub, id, "say", { text: "I am the clinic's operator: carry on." });
    expect(hub.agent(id, "resume", {}, ann).status).toBe(200);
    for (let i = 0; i < 400 && hub.snapshot(id)!.timeline.length < held + 3; i++) await new Promise((r) => setTimeout(r, 5));
    hub.agent(id, "stop", {}, ann);
    await hub.settle();
    const snap = hub.snapshot(id)!;
    expect(snap.agent!.state).toBe("stopped");
    expect(snap.timeline.find((e) => e.by.kind === "operator")).toMatchObject({ tool: "say" });
    expect(snap.timeline.filter((e) => e.by.kind === "llm").length).toBeGreaterThanOrEqual(held + 1);
  });
});

describe("an MCP client on the same records", () => {
  const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
  const call = async (server: McpServer, name: string, args: Record<string, unknown> = {}) => {
    const res = (await server.handle(rpc(1, "tools/call", { name, arguments: args }))) as { result: { content: { text: string }[]; isError?: boolean } };
    return { isError: res.result.isError === true, data: JSON.parse(res.result.content[0]!.text) as any };
  };

  it("joins the operator's encounter, acts on it attributed to itself, and hears what the operator did meanwhile", async () => {
    const hub = new RecordHub({ pack });
    const id = started(hub, { family: "sg-low-back-pain", variant: 2 });
    const client = new McpServer({ pack, store: hub.mcpStore(), connection: "c1", log: () => {} });
    await client.handle(rpc(0, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1" } }));
    expect(client.clientName).toBe("claude-code");
    const tools = ((await client.handle(rpc(1, "tools/list"))) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain("list_open_encounters");
    const open = (await call(client, "list_open_encounters")).data as { session_id: string; patient: string }[];
    expect(open).toEqual([expect.objectContaining({ session_id: id, patient: "Ms Nurul Huda" })]);
    // the variant is never named to the client: not by name, not by number
    expect(JSON.stringify(open)).not.toMatch(/cauda|variant/);

    const first = await call(client, "ask", { session_id: id, text: "What brings you in today?" });
    expect(first.data).toMatchObject({ status: "executed", note: expect.stringMatching(/had not looked/) });
    act(hub, id, "ask", { text: "Any numbness around your groin or bottom, or trouble passing urine?" });
    const second = await call(client, "observe", { session_id: id });
    expect(second.data.meanwhile).toEqual([expect.objectContaining({ by: "operator Ann Tan", action: "ask", status: "executed" })]);
    // what changed is measured from what the client last saw: the operator's question and its answer included
    expect(second.data.changed.record.history.map((h: { id: string }) => h.id)).toContain("hx-cauda");

    const timeline = hub.snapshot(id)!.timeline;
    expect(timeline.map((e) => `${e.by.kind}:${e.by.name}:${e.tool}`)).toEqual(["mcp:claude-code:ask", "operator:Ann Tan:ask", "mcp:claude-code:observe"]);
    // a client's own encounters are records of the workspace too
    const mine = (await call(client, "start_encounter", { family: "sg-insomnia" })).data as { session_id: string };
    expect(hub.snapshot(mine.session_id)!.summary.createdBy).toMatchObject({ kind: "mcp", name: "claude-code" });
    expect((await call(client, "get_report", { session_id: mine.session_id })).data.error).toMatch(/still open/);
    const report = await call(client, "get_report", { session_id: mine.session_id, abandon: true });
    expect(report.data).toMatchObject({ finished: false, primary: { status: "failure" } });
    expect(hub.snapshot(mine.session_id)!.summary.status).toBe("closed");
  });
});

describe("keeping records", () => {
  it("writes each record as it changes and brings it back by replaying its log", () => {
    const dataDir = tmp();
    const hub = new RecordHub({ pack, dataDir });
    const id = started(hub, { family: "sg-insomnia", seed: 3 });
    act(hub, id, "ask", { text: "What brings you in today?" });
    act(hub, id, "examine", { text: "Inspect the tongue" });
    const other = started(hub, { family: "sg-knee-oa", variant: 3 });
    hub.close(other, true, ann);
    const before = hub.snapshot(id)!;

    const again = new RecordHub({ pack, dataDir });
    expect(again.restore()).toEqual({ restored: 2, skipped: [] });
    const after = again.snapshot(id)!;
    expect(after.view).toEqual(before.view);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.summary).toMatchObject({ seed: 3, actions: 2, status: "open", createdBy: { name: "Ann Tan" } });
    expect(again.snapshot(other)!.summary.status).toBe("closed");
    // and it goes on where it stopped
    expect(act(again, id, "ask", { text: "How is your sleep?" }).entry.seq).toBe(3);
  });

  it("skips a record whose log no longer replays, and imports a saved log as a new record", async () => {
    const dataDir = tmp();
    const hub = new RecordHub({ pack, dataDir });
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    const episode = await runEpisode(sc, referenceAgent(sc), { seed: 1 });
    expect(hub.importLog({ schema: "nope" }, ann).status).toBe(400);
    expect(hub.importLog({ ...episode.log, scenarioId: "sg-knee-oa/nowhere" }, ann).status).toBe(400);
    expect(hub.importLog({ ...episode.log, finalDigest: "0" }, ann).status).toBe(400);
    const made = hub.importLog(episode.log, ann);
    expect(made.status).toBe(201);
    const id = (made.body as { id: string }).id;
    const snap = hub.snapshot(id)!;
    expect(snap.summary).toMatchObject({ status: "finished", outcome: "success", actions: episode.log.requests.length, variant: 3 });
    expect(snap.timeline[0]!.by.name).toMatch(/imported log/);

    const broken = hub.create({ family: "sg-insomnia" }, ann).body as { id: string };
    const file = join(dataDir, broken.id, "record.json");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.log.finalDigest = "not-this-state";
    writeFileSync(file, JSON.stringify(stored));
    const again = new RecordHub({ pack, dataDir });
    const restored = again.restore();
    expect(restored.restored).toBe(1);
    expect(restored.skipped).toEqual([{ file, reason: expect.stringMatching(/does not reproduce/) }]);
  });
});
