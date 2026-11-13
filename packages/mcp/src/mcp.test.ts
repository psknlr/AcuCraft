import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { digest, replayLog, type EncounterLog } from "@acucraft/core";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { classify, LineSplitter, McpServer, runMcpServer, type JsonRpcResponse } from "./index.js";

/**
 * `acucraft mcp` (docs/AGENT.md): an external agent plays the practitioner over the Model Context Protocol, with the
 * built-in agent's tools — and is served nothing hidden before the encounter is over.
 */

const pack = loadContentPack();
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const resultOf = (r: JsonRpcResponse | JsonRpcResponse[] | null) => (r as { result: any }).result;
const errorOf = (r: JsonRpcResponse | JsonRpcResponse[] | null) => (r as { error: { code: number; message: string } }).error;

async function call(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const res = resultOf(await server.handle(rpc(1, "tools/call", { name, arguments: args })));
  const text = res.content[0].text as string;
  return { isError: res.isError === true, text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

describe("the protocol", () => {
  it("answers initialize with its instructions, pings, lists tools, and refuses what it does not know", async () => {
    const server = new McpServer({ pack, log: () => {} });
    const init = resultOf(await server.handle(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } })));
    expect(init).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "acucraft" } });
    expect(init.instructions).toContain("You are the treating practitioner");
    expect(init.instructions).toContain("start_encounter");
    expect(resultOf(await server.handle(rpc(2, "initialize", { protocolVersion: "1999-01-01" }))).protocolVersion).toBe("2025-06-18");
    expect(resultOf(await server.handle(rpc(3, "ping")))).toEqual({});
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(errorOf(await server.handle(rpc(4, "resources/list")))).toMatchObject({ code: -32601 });
    expect(errorOf(await server.handle({ id: 5, method: "ping" }))).toMatchObject({ code: -32600 });
    expect(errorOf(await server.handle(rpc(6, "tools/call", { arguments: {} })))).toMatchObject({ code: -32602 });
    const batch = (await server.handle([rpc(7, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc(8, "ping")])) as JsonRpcResponse[];
    expect(batch.map((r) => r.id)).toEqual([7, 8]);
  });

  it("offers the practitioner's tools, each taking a session_id, and its own three", async () => {
    const server = new McpServer({ pack, log: () => {} });
    const tools = resultOf(await server.handle(rpc(1, "tools/list"))).tools as { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] }; annotations?: { readOnlyHint?: boolean } }[];
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(["list_encounters", "start_encounter", "get_report"]);
    for (const t of ["lookup", "view", "construct_point", "read_skill", "ask", "move", "insert_needle", "count_needles", "finish_encounter"]) expect(names).toContain(t);
    expect(names).not.toContain("approve_plan");
    for (const t of tools.slice(3)) {
      expect(t.inputSchema.required[0], t.name).toBe("session_id");
      expect(t.inputSchema.properties).toHaveProperty("session_id");
    }
    expect(tools.find((t) => t.name === "lookup")!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "insert_needle")!.annotations).toBeUndefined();
    expect(tools.find((t) => t.name === "insert_needle")!.inputSchema.required).toEqual(["session_id", "needleId", "depthCm"]);
  });

  it("classifies messages and splits lines across chunks", () => {
    expect(classify({ jsonrpc: "2.0", id: 1, method: "ping" })).toMatchObject({ kind: "request" });
    expect(classify({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ kind: "notification", method: "notifications/initialized" });
    expect(classify({ jsonrpc: "2.0", id: 1, result: {} })).toEqual({ kind: "response" });
    expect(classify([1])).toMatchObject({ kind: "invalid" });
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(s.push('{"c":3}')).toEqual([]);
    expect(s.end()).toEqual(['{"c":3}']);
  });
});

describe("an encounter over MCP", () => {
  it("is played with the same tools, logged, and evaluated once it is finished", async () => {
    const closed: { sessionId: string; log: EncounterLog }[] = [];
    const server = new McpServer({ pack, log: () => {}, onClosed: (c) => closed.push(c) });
    const families = (await call(server, "list_encounters")).data as { family: string; title: string; variants: number }[];
    expect(families.map((f) => f.family)).toContain("sg-knee-oa");
    expect(families.find((f) => f.family === "sg-knee-oa")).toMatchObject({ variants: 3 });
    // the third variant of the knee family (the hot knee): the client is never told which it is
    const started = (await call(server, "start_encounter", { family: "sg-knee-oa", variant: 3 })).data as { session_id: string; opening: string };
    const session_id = started.session_id;
    expect(started.opening).toMatch(/^A new encounter: /);

    expect((await call(server, "lookup", { session_id, topic: "vocabulary" })).data).toHaveProperty("redFlags");
    expect((await call(server, "read_skill", { session_id, id: "red-flags-and-referral" })).text).toMatch(/^# Red flags/);
    const asked = await call(server, "ask", { session_id, text: "What brings you in today?" });
    expect(asked.isError).toBe(false);
    expect(asked.data).toMatchObject({ status: "executed", changed: { record: { history: [{ id: "hx-chief" }] } } });
    expect((await call(server, "view", { session_id, section: "record" })).data.record.history).toHaveLength(1);

    // not a valid input: an error result, and nothing reached the engine
    const invalid = await call(server, "refer", { session_id, to: "emergency" });
    expect(invalid).toMatchObject({ isError: true, data: { error: expect.stringMatching(/Not a valid refer/) } });
    // refused by the engine: an error result with the reason
    const early = await call(server, "finish_encounter", { session_id });
    expect(early).toMatchObject({ isError: true, data: { status: "rejected" } });
    expect((await call(server, "get_report", { session_id })).data.error).toMatch(/still open/);

    await call(server, "refer", { session_id, to: "emergency", urgency: "emergency", reason: "hot swollen knee with fever" });
    await call(server, "end_visit", { session_id });
    expect(closed).toHaveLength(0);
    const finished = await call(server, "finish_encounter", { session_id });
    expect(finished.data).toMatchObject({ status: "executed", changed: { finished: true } });

    // closed: logged for replay, and evaluated
    expect(closed).toHaveLength(1);
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    expect(closed[0]!.log.scenarioId).toBe("sg-knee-oa/hot-knee");
    expect(closed[0]!.log.requests.map((r) => r.action.type)).toEqual(["ask", "finish_encounter", "refer", "end_visit", "finish_encounter"]);
    expect(digest(replayLog(sc, closed[0]!.log).state)).toBe(closed[0]!.log.finalDigest);
    const report = (await call(server, "get_report", { session_id })).data;
    expect(report).toMatchObject({ finished: true, primary: { status: "success", pathway: "p-emergency-referral" } });
    expect(report.notice).toMatch(/not a validated competency score/);
    expect((await call(server, "observe", { session_id })).data.error).toMatch(/closed/);
  });

  it("serves nothing hidden while the encounter is open: no variant, no pathway, no evaluation", async () => {
    const server = new McpServer({ pack, log: () => {} });
    const served: string[] = [];
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(server, name, args);
      served.push(r.text);
      return r;
    };
    served.push(JSON.stringify(resultOf(await server.handle(rpc(1, "initialize", {})))), JSON.stringify(resultOf(await server.handle(rpc(2, "tools/list")))));
    await say("list_encounters");
    const { session_id } = (await say("start_encounter", { family: "sg-low-back-pain", variant: 2 })).data as { session_id: string };
    await say("view", { session_id });
    for (const topic of ["points", "regions", "vocabulary", "pattern", "deqi", "clinic", "floorplan", "roles", "rules", "evidence"]) await say("lookup", { session_id, topic });
    await say("ask", { session_id, text: "What brings you in today?" });
    await say("get_report", { session_id });
    const all = served.join("\n");
    expect(session_id).not.toMatch(/cauda|low-back|variant/);
    for (const hidden of ["cauda-equina\"", "p-emergency-referral", "ce-needled-cauda", "criticalErrors", "\"solution\""]) expect(all, hidden).not.toContain(hidden);
    // the variant by number only: out of range is refused without naming them
    const out = await call(server, "start_encounter", { family: "sg-low-back-pain", variant: 9 });
    expect(out.data.error).toBe("variant is a number from 1 to 3");
    expect((await call(server, "start_encounter", { family: "nowhere" })).isError).toBe(true);
    expect((await call(server, "observe", { session_id: "enc-0" })).data.error).toMatch(/no open encounter/);
  });

  it("abandoning closes an encounter as it stands; old encounters make room for new ones", async () => {
    const closed: string[] = [];
    const server = new McpServer({ pack, log: () => {}, maxSessions: 2, onClosed: (c) => closed.push(c.sessionId) });
    const start = async () => ((await call(server, "start_encounter", { family: "sg-insomnia" })).data as { session_id: string }).session_id;
    const a = await start();
    const b = await start();
    await call(server, "observe", { session_id: a });
    const c = await start();
    // the least recently used (b) made room
    expect(closed).toEqual([b]);
    expect((await call(server, "observe", { session_id: b })).data.error).toMatch(/no open encounter/);
    const report = await call(server, "get_report", { session_id: a, abandon: true });
    expect(report.data).toMatchObject({ finished: false, primary: { status: "failure" } });
    expect(closed).toEqual([b, a]);
    server.shutdown();
    expect(closed).toEqual([b, a, c]);
  });

  it("speaks newline-delimited JSON-RPC on its streams, and only that on its output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
    const served = runMcpServer({ pack, input, output, log: () => {} });
    input.write(`${JSON.stringify(rpc(1, "initialize", {}))}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n`);
    input.end(JSON.stringify(rpc(2, "tools/call", { name: "list_encounters", arguments: {} })));
    await served;
    const messages = lines.map((l) => JSON.parse(l) as { id: number | null; result?: unknown; error?: { code: number } });
    expect(messages.map((m) => m.id)).toEqual([1, null, 2]);
    expect(messages[1]!.error!.code).toBe(-32700);
    expect(messages[2]!.result).toHaveProperty("content");
  });
});
