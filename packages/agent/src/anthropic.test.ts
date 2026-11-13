import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { loadContentPack, requireScenario, runEpisode } from "@acucraft/bench";
import { anthropicProvider, buildAnthropicRequest, claudeAgent, echoBlocks, systemSections, toAnthropicMessages, toCompletion, toolsFor, toProviderError, type ChatMessage, type ChatRequest } from "./index.js";

/**
 * Claude through the Messages API (docs/AGENT.md): what a request carries, how a turn is read and sent back, and what
 * becomes of a failure — against a stand-in for the SDK client: no network.
 */

const pack = loadContentPack();
const tools = toolsFor(["ask", "insert_needle", "finish_encounter"], { skills: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
const request = (messages: ChatMessage[] = [{ role: "user", parts: [{ type: "text", text: "A new encounter." }] }]): ChatRequest => ({ system: systemSections(pack.skills), messages, tools });

type Message = Anthropic.Beta.Messages.BetaMessage;
const message = (content: unknown[], extra: Partial<Message> = {}): Message =>
  ({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 }, ...extra }) as unknown as Message;

/** A client whose `beta.messages.stream` answers from `replies` (a message, or an error to throw). */
function client(replies: (Message | Error)[]) {
  const seen: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const fake = {
    beta: {
      messages: {
        stream: (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => {
          seen.push(JSON.parse(JSON.stringify(params)));
          const reply = replies[Math.min(seen.length, replies.length) - 1]!;
          return { finalMessage: async () => (reply instanceof Error ? Promise.reject(reply) : reply) };
        },
      },
    },
  } as unknown as Anthropic;
  return { fake, seen };
}

describe("a request to the Messages API", () => {
  it("carries the current model's settings: effort, no thinking parameter, no forced tool choice, caching, fallback, compaction", () => {
    const p = buildAnthropicRequest({}, request());
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(32_000);
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.tool_choice).toEqual({ type: "auto" });
    // two cache breakpoints: after the standing instructions (and the tools before them), and moving with the conversation
    const system = p.system as { text: string; cache_control?: unknown }[];
    expect(system.map((s) => s.cache_control !== undefined)).toEqual([...system.slice(1).map(() => false), true]);
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01", "compact-2026-01-12"]);
    expect(p.context_management).toMatchObject({ edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 300_000 } }] });
    const tool = (p.tools as { name: string; input_schema: unknown; eager_input_streaming?: boolean }[]).find((t) => t.name === "insert_needle")!;
    expect(tool.eager_input_streaming).toBe(true);
    expect(tool.input_schema).toEqual(tools.find((t) => t.name === "insert_needle")!.inputSchema);
    // the same input gives the same bytes: nothing in a request varies by itself
    expect(JSON.stringify(buildAnthropicRequest({}, request()))).toBe(JSON.stringify(p));
  });

  it("follows the options and the model: effort, limits, what a model does not take", () => {
    expect(buildAnthropicRequest({ effort: "xhigh", maxTokens: 500_000 }, request())).toMatchObject({ output_config: { effort: "xhigh" }, max_tokens: 64_000 });
    expect(buildAnthropicRequest({}, { ...request(), maxTokens: 64_000 }).max_tokens).toBe(64_000);
    const plain = buildAnthropicRequest({ fallbacks: false, compactAt: false }, request());
    expect(plain).not.toHaveProperty("fallbacks");
    expect(plain).not.toHaveProperty("context_management");
    expect(plain).not.toHaveProperty("betas");
    expect(buildAnthropicRequest({ compactAt: 150_000 }, request()).context_management).toMatchObject({ edits: [{ trigger: { value: 150_000 } }] });
    // an older model: no effort parameter, no server-side fallback
    const old = buildAnthropicRequest({ model: "claude-haiku-4-5" }, request());
    expect(old).not.toHaveProperty("output_config");
    expect(old).not.toHaveProperty("fallbacks");
    expect(old).not.toHaveProperty("context_management");
    expect(buildAnthropicRequest({ model: "claude-sonnet-5-5" }, request())).toMatchObject({ fallbacks: "default", output_config: { effort: "high" } });
  });

  it("sends tool results first in a user turn, and an assistant turn exactly as it came", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
    const use = { type: "tool_use", id: "tu_1", name: "ask", input: { text: "Where does it hurt?" }, caller: { type: "direct" } };
    const sent = toAnthropicMessages([
      { role: "user", parts: [{ type: "text", text: "A new encounter." }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "tu_1", name: "ask", input: { text: "Where does it hurt?" } }], raw: [thinking, use] },
      { role: "user", parts: [{ type: "text", text: "(a note)" }, { type: "tool_result", id: "tu_1", content: '{"status":"executed"}' }, { type: "tool_result", id: "tu_2", content: "", isError: true }] },
    ]);
    expect(sent[1]).toEqual({ role: "assistant", content: [thinking, use] });
    expect(sent[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: '{"status":"executed"}' },
      { type: "tool_result", tool_use_id: "tu_2", content: "(no output)", is_error: true },
      { type: "text", text: "(a note)" },
    ]);
    // without the provider's own blocks (another provider's turn), the turn is rebuilt from its parts
    expect(toAnthropicMessages([{ role: "assistant", parts: [{ type: "text", text: "Asking." }, { type: "tool_call", id: "c1", name: "ask", input: {} }] }])[0]!.content).toEqual([{ type: "text", text: "Asking." }, { type: "tool_use", id: "c1", name: "ask", input: {} }]);
  });

  it("after a refusal fallback part-way through a turn, only what the serving model produced counts", () => {
    const declined = [{ type: "thinking", thinking: "", signature: "a" }, { type: "text", text: "Let me" }, { type: "tool_use", id: "tu_old", name: "ask", input: {} }];
    const boundary = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } };
    const served = [{ type: "thinking", thinking: "", signature: "b" }, { type: "text", text: "" }, { type: "tool_use", id: "tu_new", name: "ask", input: { text: "Where?" } }];
    const all = [...declined, boundary, ...served];
    // sent back: before the boundary only the text; the boundary where it was; everything after it; never empty text
    expect(echoBlocks(all)).toEqual([declined[1], boundary, served[0], served[2]]);
    expect(echoBlocks(served)).toEqual([served[0], served[2]]);
    // read: the declined model's call was never asked for by the one that answered
    const done = toCompletion(message(all, { model: "claude-opus-5" }));
    expect(done.toolCalls).toEqual([{ id: "tu_new", name: "ask", input: { text: "Where?" } }]);
    expect(done.model).toBe("claude-opus-5");
    expect(done.raw).toEqual(all);
  });

  it("reads a turn by block type, with its usage", () => {
    const done = toCompletion(message([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Two things." }, { type: "tool_use", id: "a", name: "ask", input: { text: "1" } }, { type: "tool_use", id: "b", name: "observe", input: {} }]));
    expect(done).toMatchObject({ ok: true, stopReason: "tool_use", text: "Two things.", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 40 } });
    expect(done.toolCalls.map((c) => c.name)).toEqual(["ask", "observe"]);
    expect(toCompletion(message([], { stop_reason: "refusal" })).stopReason).toBe("refusal");
    expect(toCompletion(message([{ type: "text", text: "…" }], { stop_reason: "max_tokens" })).stopReason).toBe("max_tokens");
    expect(toCompletion(message([], { stop_reason: "model_context_window_exceeded" as never })).stopReason).toBe("other");
  });
});

describe("failures", () => {
  const headers = new Headers();
  const error = (status: number, type: string, text: string) => Anthropic.APIError.generate(status, { type: "error", error: { type, message: text } }, text, headers);

  it("are told apart by the SDK's own classes: what is worth asking again and what is not", () => {
    expect(toProviderError(error(401, "authentication_error", "invalid x-api-key"))).toMatchObject({ kind: "auth", retryable: false, status: 401 });
    expect(toProviderError(error(429, "rate_limit_error", "slow down"))).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(toProviderError(error(529, "overloaded_error", "Overloaded"))).toMatchObject({ kind: "overloaded", retryable: true });
    expect(toProviderError(error(500, "api_error", "Internal"))).toMatchObject({ kind: "overloaded", retryable: true });
    expect(toProviderError(error(400, "invalid_request_error", "tools.0: bad schema"))).toMatchObject({ kind: "bad_request", retryable: false });
    expect(toProviderError(error(400, "invalid_request_error", "prompt is too long: 1200000 tokens"))).toMatchObject({ kind: "context_exceeded", retryable: false });
    expect(toProviderError(new Anthropic.APIConnectionError({ message: "socket hang up" }))).toMatchObject({ kind: "network", retryable: true });
    expect(toProviderError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: "aborted", retryable: false });
    expect(toProviderError(new Error("boom"))).toMatchObject({ kind: "unknown", retryable: false, message: "boom" });
  });

  it("an overloaded request is asked again after a wait, a bad one is not", async () => {
    const waits: number[] = [];
    const busy = client([error(529, "overloaded_error", "Overloaded"), error(529, "overloaded_error", "Overloaded"), message([{ type: "text", text: "ok" }])]);
    const provider = anthropicProvider({ client: busy.fake, sleep: async (ms) => void waits.push(ms) });
    expect(await provider.complete(request())).toMatchObject({ ok: true, text: "ok" });
    expect(waits).toEqual([2000, 4000]);
    expect(busy.seen).toHaveLength(3);
    const never = client([error(529, "overloaded_error", "Overloaded")]);
    expect(await anthropicProvider({ client: never.fake, retries: 1, sleep: async () => {} }).complete(request())).toMatchObject({ ok: false, kind: "overloaded" });
    expect(never.seen).toHaveLength(2);
    const bad = client([error(400, "invalid_request_error", "messages: at least one message is required")]);
    expect(await anthropicProvider({ client: bad.fake, sleep: async () => {} }).complete(request())).toMatchObject({ ok: false, kind: "bad_request" });
    expect(bad.seen).toHaveLength(1);
  });

  it("an endpoint that will not take compaction is asked again without it, and the encounter goes on", async () => {
    const strict = client([error(400, "invalid_request_error", "context_management: Extra inputs are not permitted"), message([{ type: "text", text: "ok" }])]);
    const provider = anthropicProvider({ client: strict.fake, sleep: async () => {} });
    expect(await provider.complete(request())).toMatchObject({ ok: true });
    expect(strict.seen[0]).toHaveProperty("context_management");
    expect(strict.seen[1]).not.toHaveProperty("context_management");
    expect(strict.seen[1]!.betas).toEqual(["server-side-fallback-2026-07-01"]);
    // and it is not offered again in this encounter
    await provider.complete(request());
    expect(strict.seen[2]).not.toHaveProperty("context_management");
  });
});

describe("Claude as the practitioner (a stand-in client)", () => {
  it("runs an encounter: each turn's blocks go back exactly as they came, and every call is answered", async () => {
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    const turn = (id: string, name: string, input: unknown) => message([{ type: "thinking", thinking: "", signature: `sig-${id}` }, { type: "tool_use", id, name, input, caller: { type: "direct" } }]);
    const { fake, seen } = client([
      turn("tu_1", "lookup", { topic: "vocabulary" }),
      turn("tu_2", "ask", { text: "What brings you in today?" }),
      turn("tu_3", "refer", { to: "emergency", urgency: "emergency", reason: "hot swollen knee with fever" }),
      turn("tu_4", "end_visit", {}),
      turn("tu_5", "finish_encounter", {}),
    ]);
    const agent = claudeAgent({ client: fake, skills: pack.skills });
    expect(agent.name).toBe("claude (claude-opus-5-5, effort high)");
    const e = await runEpisode(sc, agent, { seed: 1 });
    expect(e.stopReason).toBe("finished");
    expect(e.report.primary.pathway).toBe("p-emergency-referral");
    expect(seen).toHaveLength(5);
    for (let k = 1; k < seen.length; k++) {
      const prev = seen[k - 1]!.messages;
      // append-only: a model's thinking blocks stay valid, and the prompt cache holds the prefix
      expect(seen[k]!.messages.slice(0, prev.length)).toEqual(prev);
      const assistant = seen[k]!.messages[prev.length]!;
      expect((assistant.content as { type: string; signature?: string }[])[0]).toMatchObject({ type: "thinking", signature: `sig-tu_${k}` });
      const reply = seen[k]!.messages[prev.length + 1]!;
      expect((reply.content as { type: string; tool_use_id?: string }[])[0]).toMatchObject({ type: "tool_result", tool_use_id: `tu_${k}` });
      expect(seen[k]!.system).toEqual(seen[0]!.system);
      expect(seen[k]!.tools).toEqual(seen[0]!.tools);
    }
    expect(e.log.meta).toMatchObject({ usage: { modelCalls: 5, inputTokens: 50, cacheReadTokens: 4500 } });
    expect((e.log.meta!.transcript as { model: string }[]).every((t) => t.model === "claude-opus-5-5")).toBe(true);
  });
});
