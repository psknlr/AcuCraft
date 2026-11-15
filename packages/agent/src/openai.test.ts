import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRequest, minimaxProvider, openaiProvider, toOpenAICompletion, toOpenAIMessages } from "./providers/openai.js";
import type { ChatMessage, ChatRequest } from "./providers/types.js";
import { toolsFor } from "./tools/index.js";

/** Wire contracts and failure handling without a model account or network. */
const request = (messages: ChatMessage[] = [{ role: "user", parts: [{ type: "text", text: "A simulated encounter." }] }]): ChatRequest => ({
  system: [{ id: "role", text: "You are the simulated practitioner." }, { id: "empty", text: " " }],
  messages,
  tools: toolsFor(["ask", "insert_needle"]).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
});
const call = (id = "call-1", args = '{"text":"Where does it hurt?"}') => ({ id, type: "function", function: { name: "ask", arguments: args } });
const response = (message: Record<string, unknown> = { role: "assistant", content: "I will ask.", tool_calls: [call()] }, finish = "tool_calls") => ({
  id: "chat-1", model: "served-model", choices: [{ message, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 30 } },
});
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const transport = (value: unknown, status = 200) => vi.fn<typeof fetch>(async () => json(value, status));
afterEach(() => vi.useRealTimers());

describe("Chat Completions requests", () => {
  it("carries the engine's exact tool schema and the provider's token fields", () => {
    const input = request();
    const openai = buildOpenAIRequest("openai", {}, input);
    expect(openai).toMatchObject({ model: "gpt-4.1", stream: false, max_completion_tokens: 16_384, tool_choice: "auto" });
    expect(openai).not.toHaveProperty("max_tokens");
    expect(openai).not.toHaveProperty("reasoning_split");
    expect(openai).not.toHaveProperty("reasoning_effort");
    expect(openai.messages).toEqual([{ role: "system", content: "You are the simulated practitioner." }, { role: "user", content: "A simulated encounter." }]);
    const needle = input.tools.find((t) => t.name === "insert_needle")!;
    expect(openai.tools).toContainEqual({ type: "function", function: { name: needle.name, description: needle.description, parameters: needle.inputSchema } });
    const minimax = buildOpenAIRequest("minimax", { effort: "high" }, input);
    expect(minimax).toMatchObject({ model: "MiniMax-M2.5", max_tokens: 16_384, reasoning_split: true });
    expect(minimax).not.toHaveProperty("max_completion_tokens");
    expect(minimax).not.toHaveProperty("reasoning_effort");
  });

  it("uses an explicit supported reasoning effort and caps output without forcing tools", () => {
    expect(buildOpenAIRequest("openai", { model: "gpt-5", effort: "max" }, { ...request(), maxTokens: 100_000 })).toMatchObject({ reasoning_effort: "high", max_completion_tokens: 64_000 });
    expect(buildOpenAIRequest("openai", { model: "gpt-4.1", effort: "high" }, request())).not.toHaveProperty("reasoning_effort");
    const noTools = buildOpenAIRequest("openai", {}, { ...request(), tools: [] });
    expect(noTools).not.toHaveProperty("tools");
    expect(noTools).not.toHaveProperty("tool_choice");
  });

  it("preserves raw tool calls and MiniMax reasoning while pairing every result with its call id", () => {
    const raw = { role: "assistant", content: null, tool_calls: [call("one", '{ "text" : "Where?" }'), call("two", "{}")], reasoning_details: [{ type: "reasoning.text", text: "opaque provider content" }], reasoning_content: "provider reasoning" };
    const messages: ChatMessage[] = [
      { role: "assistant", parts: [], raw },
      { role: "user", parts: [{ type: "text", text: "The operator has also acted." }, { type: "tool_result", id: "one", content: '{"status":"executed"}' }, { type: "tool_result", id: "two", content: "", isError: true }] },
    ];
    const wire = toOpenAIMessages(messages, "minimax");
    expect(wire).toEqual([raw, { role: "tool", tool_call_id: "one", content: '{"status":"executed"}' }, { role: "tool", tool_call_id: "two", content: "(no output)" }, { role: "user", content: "The operator has also acted." }]);
    expect(toOpenAIMessages(messages)[0]).toEqual({ role: "assistant", content: null, tool_calls: raw.tool_calls });
    expect(toOpenAIMessages([{ role: "assistant", parts: [{ type: "text", text: "Ask." }, { type: "tool_call", id: "c", name: "ask", input: { text: "Where?" } }] }])).toEqual([{ role: "assistant", content: "Ask.", tool_calls: [call("c", '{"text":"Where?"}')] }]);
  });
});

describe("Chat Completions replies", () => {
  it("reports parsed calls and counts cached input once", () => {
    const raw = response();
    expect(toOpenAICompletion(raw, "fallback")).toMatchObject({ ok: true, id: "chat-1", model: "served-model", stopReason: "tool_use", text: "I will ask.", toolCalls: [{ id: "call-1", name: "ask", input: { text: "Where does it hurt?" } }], raw: raw.choices[0]!.message, usage: { inputTokens: 70, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 0 } });
    expect(toOpenAICompletion({ ...raw, usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: -1 } }, "fallback")).toMatchObject({ ok: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5 } });
  });

  it.each([undefined, {}, { choices: [] }, { choices: [{}] }])("refuses a response without an assistant turn (%j)", (value) => {
    expect(toOpenAICompletion(value, "fallback")).toMatchObject({ ok: false, kind: "bad_request", retryable: false });
  });

  it.each([
    [call("good"), call("bad", '{"text":')],
    [call("same"), call("same")],
    [call("list", "[]")],
    [{ id: "x", type: "function", function: { arguments: "{}" } }],
  ])("rejects every call in a malformed turn", (...toolCalls) => {
    const result = toOpenAICompletion(response({ role: "assistant", content: null, tool_calls: toolCalls }), "fallback");
    expect(result).toMatchObject({ ok: false, kind: "bad_request" });
    expect(result).not.toHaveProperty("toolCalls");
  });

  it("returns an output-limit stop without exposing even valid calls from a truncated turn", () => {
    expect(toOpenAICompletion(response({ content: null, tool_calls: [call("good"), call("cut", '{"text":')] }, "length"), "fallback")).toMatchObject({ ok: true, stopReason: "max_tokens", toolCalls: [] });
    expect(toOpenAICompletion(response({ content: null, refusal: "declined" }, "stop"), "fallback")).toMatchObject({ ok: true, stopReason: "refusal" });
  });
});

describe("Chat Completions transport", () => {
  it.each([
    [openaiProvider, "https://api.openai.com/v1/chat/completions", "gpt-4.1"],
    [minimaxProvider, "https://api.minimax.io/v1/chat/completions", "MiniMax-M2.5"],
  ] as const)("sends credentials to the provider and returns a tool turn", async (factory, endpoint, model) => {
    const fake = transport(response());
    const result = await factory({ apiKey: "test-secret", fetch: fake, retries: 0 }).complete(request());
    expect(result).toMatchObject({ ok: true, stopReason: "tool_use" });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer test-secret", "content-type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toMatchObject({ model });
  });

  it("fails missing credentials locally without calling the transport", async () => {
    const fake = transport(response());
    expect(await openaiProvider({ apiKey: "", fetch: fake }).complete(request())).toMatchObject({ ok: false, kind: "auth", retryable: false, message: expect.stringContaining("OPENAI_API_KEY") });
    expect(fake).not.toHaveBeenCalled();
  });

  it.each([[401, "auth", false], [403, "auth", false], [429, "rate_limit", true], [503, "overloaded", true], [400, "bad_request", false]] as const)("classifies HTTP %s and redacts credentials", async (status, kind, retryable) => {
    const fake = transport({ error: { message: "bad request with test-secret" } }, status);
    expect(await openaiProvider({ apiKey: "test-secret", fetch: fake, retries: 0 }).complete(request())).toMatchObject({ ok: false, kind, retryable, status, message: "openai API: bad request with [redacted]" });
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("reports context and network failures without throwing or exposing transport secrets", async () => {
    expect(await openaiProvider({ apiKey: "key", fetch: transport({ error: { message: "maximum context length" } }, 400), retries: 0 }).complete(request())).toMatchObject({ ok: false, kind: "context_exceeded", retryable: false });
    const fake = vi.fn<typeof fetch>(async () => { throw new Error("socket failure containing key"); });
    expect(await openaiProvider({ apiKey: "key", fetch: fake, retries: 0 }).complete(request())).toEqual({ ok: false, kind: "network", retryable: true, message: "Could not reach the openai API." });
    expect(await openaiProvider({ apiKey: "key", fetch: vi.fn<typeof fetch>(async () => new Response("not json")), retries: 0 }).complete(request())).toMatchObject({ ok: false, kind: "bad_request" });
  });

  it("retries a rate limit after the server's requested delay", async () => {
    vi.useFakeTimers();
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { message: "slow down" } }, 429, { "retry-after": "2" })).mockResolvedValueOnce(json(response()));
    const pending = openaiProvider({ apiKey: "key", fetch: fake, retries: 1 }).complete(request());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true });
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight request and does not retry it", async () => {
    const abort = new AbortController();
    const fake = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })));
    const pending = minimaxProvider({ apiKey: "key", fetch: fake }).complete(request(), abort.signal);
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "aborted", retryable: false });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(await openaiProvider({ apiKey: "key", fetch: fake }).complete(request(), abort.signal)).toMatchObject({ ok: false, kind: "aborted" });
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("reports a deadline that expires while waiting for the response body", async () => {
    const fake = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({ start(controller) { init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true }); } })));
    expect(await openaiProvider({ apiKey: "key", fetch: fake, timeoutMs: 5, retries: 0 }).complete(request())).toMatchObject({ ok: false, kind: "timeout", retryable: true });
  });
});
