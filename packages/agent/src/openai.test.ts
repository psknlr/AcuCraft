import { describe, expect, it } from "vitest";
import { compatibleRequest, openaiProvider } from "./providers/openai.js";
import type { ChatRequest } from "./providers/types.js";

const request: ChatRequest = { system: [{ id: "role", text: "Simulated clinician" }], messages: [{ role: "user", parts: [{ type: "text", text: "Move" }] }], tools: [{ name: "move", description: "Walk", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"], additionalProperties: false } }] };
const response = (message: unknown, finish_reason = "tool_calls") => new Response(JSON.stringify({ id: "completion-1", model: "test-model", choices: [{ message, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } }));
const call = { id: "call-1", type: "function", function: { name: "move", arguments: '{"to":"reception"}' } };

describe("OpenAI-compatible providers", () => {
  it("sends tools and returns normalized GPT actions and usage", async () => {
    let sent: any;
    const provider = openaiProvider({ apiKey: "test-key", model: "gpt-test", fetch: (async (_url, init) => { sent = JSON.parse(String(init?.body)); return response({ role: "assistant", content: null, tool_calls: [call] }); }) as typeof fetch });
    const out = await provider.complete(request);
    expect(out).toMatchObject({ ok: true, toolCalls: [{ id: "call-1", name: "move", input: { to: "reception" } }], usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5 } });
    expect(sent).toMatchObject({ model: "gpt-test", max_completion_tokens: 8192, tools: [{ type: "function", function: { name: "move" } }] });
  });
  it("preserves MiniMax native tool calls and reasoning in subsequent messages", async () => {
    const native = { role: "assistant", content: "Going", reasoning_content: "provider-native", tool_calls: [call] };
    let body: any;
    const provider = openaiProvider({ provider: "minimax", apiKey: "test-key", model: "MiniMax-test", fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return response(native); }) as typeof fetch });
    const out = await provider.complete(request);
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
    if (!out.ok) throw new Error(out.message);
    const next = compatibleRequest({ ...request, messages: [...request.messages, { role: "assistant", parts: [], raw: out.raw }, { role: "user", parts: [{ type: "tool_result", id: "call-1", content: "executed" }] }] }, "MiniMax-test");
    expect(next.messages[2]).toEqual(native);
    expect(next.messages[3]).toEqual({ role: "tool", tool_call_id: "call-1", content: "executed" });
  });
  it("rejects malformed arguments without executing a partially valid batch", async () => {
    const p = openaiProvider({ apiKey: "key", fetch: (async () => response({ role: "assistant", tool_calls: [call, { ...call, id: "bad", function: { name: "move", arguments: "{" } }] })) as typeof fetch });
    expect(await p.complete(request)).toMatchObject({ ok: false, kind: "bad_request" });
  });
  it("handles refusal, truncation, HTTP errors, cancellation and missing credentials", async () => {
    const make = (fetcher: typeof fetch) => openaiProvider({ apiKey: "key", fetch: fetcher });
    expect(await make((async () => response({ role: "assistant", refusal: "declined" }, "stop")) as typeof fetch).complete(request)).toMatchObject({ ok: true, stopReason: "refusal" });
    expect(await make((async () => response({ role: "assistant", content: "partial" }, "length")) as typeof fetch).complete(request)).toMatchObject({ ok: true, stopReason: "max_tokens" });
    expect(await make((async () => new Response("secret gateway data", { status: 429 })) as typeof fetch).complete(request)).toEqual({ ok: false, kind: "rate_limit", message: "openai returned HTTP 429.", retryable: true, status: 429 });
    expect(await openaiProvider({ apiKey: "" }).complete(request)).toMatchObject({ ok: false, kind: "auth" });
    expect(await make(fetch).complete(request, AbortSignal.abort())).toMatchObject({ ok: false, kind: "aborted" });
  });
});
