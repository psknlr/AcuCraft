import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MANIPULATION_TECHNIQUES, MANIPULATION_TECHNIQUE_IDS, digest, replayLog,
  type ActionInput, type EncounterLog,
} from "@acucraft/core";
import { EncounterSession, scriptedProvider } from "@acucraft/agent";
import { CLINICALCRAFT_REV, loadContentPack, requireScenario } from "@acucraft/bench";
import { McpServer, type JsonRpcResponse } from "@acucraft/mcp";
import { operator, RecordHub, type Attribution } from "./hub.js";

const pack = loadContentPack();
const scenario = requireScenario(pack, "sg-low-back-pain/base");
const by = operator("Technique operator", "technique-qa");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function apply(session: EncounterSession, action: ActionInput): void {
  const result = session.act(action);
  expect(["executed", "partial"], result.attempt.message).toContain(result.attempt.status);
}

/** Build realistic clinic snapshots only through recorded actions; no hand-edited encounter state. */
function fixtures(): { skin: EncounterLog; retained: EncounterLog; removed: EncounterLog; needle: string; mark: string } {
  const session = new EncounterSession(scenario, { seed: 1 });
  let needle = "", mark = "";
  let skin: EncounterLog | null = null;
  for (const request of scenario.field.solution) {
    if (request.action.type === "insert_needle") {
      needle = request.action.needleId;
      mark = request.action.mark!;
      skin = session.log({ clinicalcraft: CLINICALCRAFT_REV });
      apply(session, request.action);
      break;
    }
    apply(session, request.action);
  }
  if (!skin || !needle || !mark) throw new Error("Reference insertion fixture missing");
  const retained = session.log({ clinicalcraft: CLINICALCRAFT_REV });
  apply(session, { type: "remove_needle", needleId: needle });
  apply(session, { type: "move", to: { fixture: "sharps-1" } });
  for (const object of [...session.state.actors.practitioner!.holding]) apply(session, { type: "dispose", object });
  apply(session, { type: "move", to: { fixture: "treat-sink" } });
  apply(session, { type: "hand_hygiene" });
  apply(session, { type: "move", to: { region: "lumbar", side: "left" } });
  return { skin, retained, removed: session.log({ clinicalcraft: CLINICALCRAFT_REV }), needle, mark };
}

const prepared = fixtures();
const start = (hub: RecordHub, log = prepared.retained): string => {
  const made = hub.importLog(log, by);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return (made.body as { id: string }).id;
};
const act = (hub: RecordHub, id: string, input: Record<string, unknown>, actor: Attribution = by) => {
  const result = hub.act(id, "perform_technique", input, actor);
  expect(result.status).toBe(200);
  return result.body as { ok: boolean; entry?: { status: string; by: Attribution }; output: unknown };
};
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function mcpCall(client: McpServer, name: string, args: Record<string, unknown>) {
  const response = await client.handle(rpc(1, "tools/call", { name, arguments: args })) as JsonRpcResponse;
  const result = (response as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

describe("one parameter contract for operators, models and MCP", () => {
  it("publishes all 36 named demonstrations without changing the encounter", () => {
    const hub = new RecordHub({ pack });
    const id = start(hub);
    const before = hub.snapshot(id)!;
    const log = hub.logOf(id)!;
    const answer = hub.act(id, "lookup", { topic: "techniques" }, by);
    expect(answer.body).toMatchObject({ ok: true });
    const catalogue = (answer.body as { output: { techniques: { id: string; evidence: string }[] } }).output;
    expect(catalogue.techniques.map((entry) => entry.id)).toEqual([...MANIPULATION_TECHNIQUE_IDS]);
    expect(catalogue.techniques).toHaveLength(36);
    expect(catalogue.techniques.every((entry) => entry.evidence === "illustrative")).toBe(true);
    expect(hub.snapshot(id)!.view).toEqual(before.view);
    expect(hub.snapshot(id)!.timeline).toEqual(before.timeline);
    expect(hub.logOf(id)!.finalDigest).toBe(log.finalDigest);
  });

  it("executes every catalogue entry in its required context, without changing the clinical needle or response", () => {
    const hub = new RecordHub({ pack });
    for (const definition of MANIPULATION_TECHNIQUES) {
      const id = start(hub, prepared[definition.context]);
      const beforeLog = hub.logOf(id)!;
      const beforeMinute = hub.snapshot(id)!.view.minute;
      const before = replayLog(scenario, beforeLog).state;
      const target = definition.context === "skin" ? { mark: prepared.mark } : { needleId: prepared.needle };
      const answer = act(hub, id, { technique: definition.id, ...target, motion: { support: "none" } });
      expect(answer.ok, `${definition.id}: ${JSON.stringify(answer.output)}`).toBe(true);
      const snapshot = hub.snapshot(id)!;
      const performance = snapshot.view.performances!.at(-1)!;
      expect(performance).toMatchObject({ technique: definition.id, context: definition.context, patientPosition: before.patient.position,
        provenance: { kind: "illustrative", review: "unreviewed", forces: "not-modelled" } });
      const after = replayLog(scenario, hub.logOf(id)!).state;
      expect(after.needles, definition.id).toEqual(before.needles);
      expect(after.evidence, definition.id).toEqual(before.evidence);
      expect(snapshot.view.minute, definition.id).toBe(beforeMinute);
      expect(hub.logOf(id)!.finalDigest, definition.id).toBe(digest(after));
      hub.remove(id);
    }
  });

  it("rejects malformed parameters before they enter the action log through both operator and MCP paths", async () => {
    const hub = new RecordHub({ pack });
    const id = start(hub);
    const client = new McpServer({ pack, store: hub.mcpStore(), connection: "qa-contract", log: () => {} });
    await client.handle(rpc(0, "initialize", { clientInfo: { name: "qa-llm-client", version: "1" } }));
    const before = hub.snapshot(id)!;
    const log = hub.logOf(id)!;
    for (const motion of [{ cycles: 13 }, { cycles: 1.5 }, { durationMs: 399 }, { durationMs: 30001 }, { lateralMm: 4.1 },
      { tiltDeg: 8.1 }, { strokeMm: -0.1 }, { rotationDeg: 181 }, { tempoBias: 0.1 }, { gripApertureMm: 12.1 },
      { contactIntensity: 1.1 }, { durationMs: Infinity }, { lateralMm: NaN }, { tiltDeg: -Infinity },
      { hand: "either" }, { forceN: 20 }, { unsafeDepthCm: 8 }]) {
      const input = { technique: "nian", needleId: prepared.needle, motion };
      expect(act(hub, id, input).ok, JSON.stringify(motion)).toBe(false);
      expect((await mcpCall(client, "perform_technique", { session_id: id, ...input })).isError, JSON.stringify(motion)).toBe(true);
    }
    for (const input of [{ technique: "unreviewed-custom-needle-path", needleId: prepared.needle },
      { technique: "nian", needleId: prepared.needle, source: "clinically-validated" },
      { technique: "nian", needleId: prepared.needle, provenance: { forces: "measured" } }]) {
      expect(act(hub, id, input).ok).toBe(false);
      expect((await mcpCall(client, "perform_technique", { session_id: id, ...input })).isError).toBe(true);
    }
    expect(hub.snapshot(id)!.view).toEqual(before.view);
    expect(hub.snapshot(id)!.timeline).toEqual(before.timeline);
    expect(hub.logOf(id)!.finalDigest).toBe(log.finalDigest);
  });

  it("attributes identical resolved parameters to an operator and an MCP model on the same record", async () => {
    const hub = new RecordHub({ pack });
    const id = start(hub);
    const input = { technique: "nian", needleId: prepared.needle, motion: { durationMs: 3200, cycles: 5, rotationDeg: 70,
      direction: "counterclockwise", grip: "three-finger", hand: "right", support: "none", gripApertureMm: 3 } };
    expect(act(hub, id, input).ok).toBe(true);
    const client = new McpServer({ pack, store: hub.mcpStore(), connection: "qa-attribution", log: () => {} });
    await client.handle(rpc(0, "initialize", { clientInfo: { name: "parameter-llm", version: "1" } }));
    expect((await mcpCall(client, "perform_technique", { session_id: id, ...input })).isError).toBe(false);
    const snapshot = hub.snapshot(id)!;
    const [first, second] = snapshot.view.performances!;
    expect(first!.motion).toEqual(second!.motion);
    expect(snapshot.timeline.slice(-2).map((entry) => entry.by.kind)).toEqual(["operator", "mcp"]);
    expect(snapshot.timeline.at(-1)!.by.name).toBe("parameter-llm");
  });

  it.each(["openai", "minimax"] as const)("lets a %s practitioner discover and execute the same schema through the server loop", async (provider) => {
    const input = { technique: "long-hu-jiao-zhan", needleId: prepared.needle, motion: { durationMs: 4800, cycles: 2,
      rotationDeg: 45, support: "none", hand: "left", grip: "three-finger" } };
    const model = scriptedProvider([{ calls: [{ name: "lookup", input: { topic: "techniques" } }] },
      { calls: [{ name: "perform_technique", input }] }]);
    const hub = new RecordHub({ pack, runner: { providerOverride: model } });
    const id = start(hub);
    expect(hub.agent(id, "start", { provider, maxActions: 1 }, by).status).toBe(200);
    await hub.settle();
    const snapshot = hub.snapshot(id)!;
    expect(snapshot.view.performances).toHaveLength(1);
    expect(snapshot.view.performances![0]!).toMatchObject({ technique: input.technique, motion: input.motion });
    expect(snapshot.timeline.at(-1)).toMatchObject({ tool: "perform_technique", status: "executed", by: { kind: "llm" } });
    expect(model.requests.flatMap((request) => request.tools).some((tool) => tool.name === "perform_technique")).toBe(true);
  });
});

describe("performance refusal, provenance and replay", () => {
  it("does not record a retained gesture after removal, or a post-removal gesture before withdrawal", () => {
    const hub = new RecordHub({ pack });
    const retained = start(hub);
    expect(act(hub, retained, { technique: "men", needleId: prepared.needle }).ok).toBe(false);
    expect(hub.snapshot(retained)!.view.performances).toBeUndefined();
    const removed = start(hub, prepared.removed);
    const beforeNeedle = replayLog(scenario, hub.logOf(removed)!).state.needles;
    expect(act(hub, removed, { technique: "nian", needleId: prepared.needle }).ok).toBe(false);
    expect(hub.snapshot(removed)!.view.performances).toBeUndefined();
    expect(replayLog(scenario, hub.logOf(removed)!).state.needles).toEqual(beforeNeedle);
  });

  it("restores accepted parameters and explicit provenance from disk, without adding performance fields to old logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "acucraft-performance-"));
    dirs.push(dir);
    const hub = new RecordHub({ pack, dataDir: dir });
    const old = start(hub);
    expect(replayLog(scenario, prepared.retained).state).not.toHaveProperty("performances");
    expect(hub.snapshot(old)!.view).not.toHaveProperty("performances");
    const id = start(hub);
    const input = { technique: "nu", needleId: prepared.needle, motion: { durationMs: 4000, cycles: 2, lateralMm: 3,
      tiltDeg: 5, support: "none", contactIntensity: 0.4 } };
    expect(act(hub, id, input).ok).toBe(true);
    const before = hub.snapshot(id)!;
    const record = before.view.performances![0]!;
    expect(Object.keys(record).sort()).toEqual(["actor", "at", "attempt", "context", "id", "motion", "needleId", "patientPosition", "provenance", "requestId", "site", "technique", "visit"].sort());
    expect(record.requestId).toBe(before.timeline.at(-1)!.requestId);
    expect(Object.keys(record.site).sort()).toEqual(["region", "side", "u", "v"].sort());
    expect(JSON.stringify(record)).not.toMatch(/nearest|tipTissue|findings|diagnosis|riskFactors|criticalErrors/);
    const again = new RecordHub({ pack, dataDir: dir });
    expect(again.restore()).toEqual({ restored: 2, skipped: [] });
    expect(again.snapshot(id)!.view).toEqual(before.view);
    expect(again.snapshot(id)!.timeline).toEqual(before.timeline);
    expect(again.snapshot(old)!.view).not.toHaveProperty("performances");
  });
});
