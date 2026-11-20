import { describe, expect, it } from "vitest";
import { OPERATIVE_TECHNIQUES, digest, replayLog, type ActionInput, type EncounterLog } from "@acucraft/core";
import { EncounterSession, scriptedProvider } from "@acucraft/agent";
import { CLINICALCRAFT_REV, loadContentPack, requireScenario } from "@acucraft/bench";
import { McpServer, type JsonRpcResponse } from "@acucraft/mcp";
import { operator, RecordHub } from "./hub.js";

/**
 * The workspace on the operative catalogue of techniques (docs/TECHNIQUES.md): an operator, a language model the
 * server runs and an MCP client do a technique to the same needle through the same tool, and all three are served
 * the catalogue the encounter runs on.
 */

const pack = loadContentPack();
const scenario = requireScenario(pack, "sg-low-back-pain/base");
const by = operator("Technique operator", "operative-qa");
const NEEDLE = "pack-a.1";

/** A record with one needle in, made through recorded actions on the catalogue asked for. */
function retained(techniques: "operative" | "illustrative"): EncounterLog {
  const session = new EncounterSession(scenario, { seed: 1, techniques });
  for (const request of scenario.field.solution) {
    const done = session.act(request.action as ActionInput);
    expect(["executed", "partial"], done.attempt.message).toContain(done.attempt.status);
    if (request.action.type === "insert_needle") break;
  }
  return session.log({ clinicalcraft: CLINICALCRAFT_REV });
}
const open = (hub: RecordHub, log: EncounterLog): string => {
  const made = hub.importLog(log, by);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return (made.body as { id: string }).id;
};
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function mcpCall(client: McpServer, name: string, args: Record<string, unknown>) {
  const response = await client.handle(rpc(1, "tools/call", { name, arguments: args })) as JsonRpcResponse;
  const result = (response as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

describe("the workspace on the operative catalogue", () => {
  it("starts new records on it, says so in the view and the log, and keeps an imported record on the catalogue it was made on", () => {
    const hub = new RecordHub({ pack });
    const made = hub.create({ family: "sg-low-back-pain", variant: 1 }, by);
    expect(made.status).toBe(201);
    const fresh = (made.body as { id: string }).id;
    expect(hub.snapshot(fresh)!.view.techniques).toBe("operative");
    expect(hub.logOf(fresh)!.techniques).toBe("operative");
    // asked for by name
    const plain = hub.create({ family: "sg-low-back-pain", variant: 1, techniques: "illustrative" }, by);
    const old = (plain.body as { id: string }).id;
    expect(hub.snapshot(old)!.view.techniques).toBeUndefined();
    expect("techniques" in hub.logOf(old)!).toBe(false);
    expect(hub.create({ family: "sg-low-back-pain", techniques: "anything-else" }, by).status).toBe(400);
    // a log brought in runs on what it ran on
    expect(hub.snapshot(open(hub, retained("illustrative")))!.view.techniques).toBeUndefined();
    expect(hub.snapshot(open(hub, retained("operative")))!.view.techniques).toBe("operative");
  });

  it("serves the operator's panel and a model the same catalogue: all 36, grouped, each with what one performance is", () => {
    const hub = new RecordHub({ pack });
    const id = open(hub, retained("operative"));
    const before = hub.logOf(id)!.finalDigest;
    const index = (hub.act(id, "lookup", { topic: "techniques" }, by).body as { ok: boolean; output: Record<string, any> });
    expect(index.ok).toBe(true);
    expect(index.output.model).toBe("operative");
    expect(index.output.techniques.map((t: { id: string }) => t.id)).toEqual(OPERATIVE_TECHNIQUES.map((t) => t.id));
    expect(index.output.groups.map((g: { zh: string }) => g.zh).slice(0, 6)).toEqual(["揣爪循摄", "摇盘捻搓", "进退提插", "刮弹飞摩", "动推颤弩", "按扪搜拨"]);
    // what the panel builds its controls from is there for every technique
    for (const t of index.output.techniques) {
      expect(index.output.defaults[t.id], t.id).toBeTruthy();
      expect(Array.isArray(t.controls) && t.controls.length > 0, t.id).toBe(true);
      expect(t.phases.length, t.id).toBe(t.counts.length);
    }
    const one = (hub.act(id, "lookup", { topic: "techniques", id: "tou-tian-liang" }, by).body as { output: Record<string, any> }).output;
    expect(one.techniques[0].stages.filter((x: { times?: number }) => x.times).map((x: { zh: string }) => x.zh)).toEqual(["地部 · 紧提慢按", "人部 · 紧提慢按", "天部 · 紧提慢按"]);
    // reading the catalogue is not an act on the record
    expect(hub.logOf(id)!.finalDigest).toBe(before);
  });

  it("does the technique to the needle whoever asks: the operator, an MCP client, the server's language model", async () => {
    const hub = new RecordHub({ pack, runner: { providerOverride: scriptedProvider([
      { calls: [{ name: "lookup", input: { topic: "techniques", id: "nian" } }] },
      { calls: [{ name: "perform_technique", input: { technique: "nian", needleId: NEEDLE } }] },
    ]) } });
    const id = open(hub, retained("operative"));
    const minute = () => hub.snapshot(id)!.view.minute;
    // the operator: 搓, one roll short of held
    const t0 = minute();
    const rolled = hub.act(id, "perform_technique", { technique: "cuo", needleId: NEEDLE, motion: { cycles: 1 } }, by).body as { ok: boolean; entry: { observations: string[]; message: string } };
    expect(rolled.ok, rolled.entry?.message).toBe(true);
    expect(minute()).toBeGreaterThan(t0);
    expect(hub.snapshot(id)!.view.performances!.at(-1)).toMatchObject({ technique: "cuo", provenance: { kind: "operative" }, effect: { windingDeg: 120 } });
    expect(rolled.entry.observations.some((line) => /evidence feel-\d+/.test(line))).toBe(true);
    // an MCP client on the same record: a compound method with its own counts
    const client = new McpServer({ pack, store: hub.mcpStore(), connection: "operative-client", log: () => {} });
    await client.handle(rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "operative-client", version: "1" } }));
    const fire = await mcpCall(client, "perform_technique", { session_id: id, technique: "shao-shan-huo", needleId: NEEDLE, motion: { phaseCycles: [3, 3, 3] } });
    expect(fire.isError, JSON.stringify(fire.data).slice(0, 300)).toBe(false);
    expect(hub.snapshot(id)!.view.performances!.at(-1)).toMatchObject({ technique: "shao-shan-huo", motion: { phaseCycles: [3, 3, 3] }, effect: { reading: "reinforcing" } });
    // counts that do not fit the method are refused at the same door, and leave no performance
    const count = hub.snapshot(id)!.view.performances!.length;
    const wrong = await mcpCall(client, "perform_technique", { session_id: id, technique: "shao-shan-huo", needleId: NEEDLE, motion: { phaseCycles: [9, 9] } });
    expect(wrong.isError).toBe(true);
    expect(hub.snapshot(id)!.view.performances).toHaveLength(count);
    // the server's own language model: it reads one technique, then performs it
    expect(hub.agent(id, "start", { provider: "openai", maxActions: 1 }, by).status).toBe(200);
    await hub.settle();
    const last = hub.snapshot(id)!;
    expect(last.view.performances!.at(-1)).toMatchObject({ technique: "nian", effect: { reading: "even" } });
    // (the refused request is on the timeline too, as refused: nothing a client asks for goes unrecorded)
    expect(last.timeline.slice(-4).map((entry) => [entry.by.kind, entry.status])).toEqual([["operator", "executed"], ["mcp", "executed"], ["mcp", "rejected"], ["llm", "executed"]]);
    // and the whole record replays to the state the workspace holds
    const log = hub.logOf(id)!;
    expect(log.techniques).toBe("operative");
    expect(digest(replayLog(scenario, log).state)).toBe(log.finalDigest);
  });
});
