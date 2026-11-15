import { MAX_TOKENS_CAP, type ChatRequest, type LLMProvider, type ProviderError } from "./types.js";

export type CompatibleProvider = "openai" | "minimax" | "compatible";
export interface OpenAIProviderOptions {
  provider?: CompatibleProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Chat Completions wire adapter; engine schemas still validate every proposed action. */
export function compatibleRequest(request: ChatRequest, model: string) {
  const messages: Record<string, unknown>[] = [{ role: "system", content: request.system.map(s => s.text).join("\n\n") }];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      // MiniMax requires its original reasoning_content as well as tool_calls on subsequent turns.
      if (message.raw && typeof message.raw === "object" && !Array.isArray(message.raw)) {
        messages.push(message.raw as Record<string, unknown>);
      } else {
        const calls = message.parts.filter(p => p.type === "tool_call");
        messages.push({ role: "assistant", content: message.parts.filter(p => p.type === "text").map(p => p.text).join("\n") || null,
          ...(calls.length ? { tool_calls: calls.map(p => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } })) } : {}) });
      }
    } else {
      for (const part of message.parts) {
        if (part.type === "tool_result") messages.push({ role: "tool", tool_call_id: part.id, content: part.content });
        else if (part.type === "text") messages.push({ role: "user", content: part.text });
      }
    }
  }
  return { model, messages, max_completion_tokens: Math.min(request.maxTokens ?? 8192, MAX_TOKENS_CAP),
    ...(request.tools.length ? { tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" } : {}) };
}

export function openaiProvider(options: OpenAIProviderOptions = {}): LLMProvider {
  const id = options.provider ?? "openai";
  const env = typeof process === "undefined" ? {} : process.env;
  const prefix = id === "minimax" ? "MINIMAX" : id === "compatible" ? "LLM" : "OPENAI";
  const model = options.model ?? env[`${prefix}_MODEL`] ?? (id === "openai" ? "gpt-4.1" : "");
  const base = options.baseURL ?? env[`${prefix}_BASE_URL`] ?? (id === "minimax" ? "https://api.minimax.io/v1" : id === "openai" ? "https://api.openai.com/v1" : "");
  const key = options.apiKey ?? env[`${prefix}_API_KEY`];
  const fail = (kind: ProviderError["kind"], message: string, retryable = false, status?: number): ProviderError => ({ ok: false, kind, message, retryable, ...(status ? { status } : {}) });
  return {
    id, model, label: `${id}: ${model || "model not configured"}`,
    async complete(request, signal) {
      if (signal?.aborted) return fail("aborted", "The request was cancelled.");
      if (!key) return fail("auth", `Set ${prefix}_API_KEY on the server.`);
      if (!model || !base) return fail("bad_request", `Set ${prefix}_MODEL and ${prefix}_BASE_URL on the server.`);
      let url: URL;
      try {
        url = new URL(`${base.replace(/\/+$/, "")}/chat/completions`);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
      } catch { return fail("bad_request", "The model endpoint must use HTTPS (HTTP is allowed only on loopback)."); }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
      try {
        const body = compatibleRequest(request, model);
        // MiniMax's compatibility endpoint documents max_tokens, while GPT reasoning models use max_completion_tokens.
        const wire = id === "openai" ? body : (() => { const { max_completion_tokens, ...rest } = body; return { ...rest, max_tokens: max_completion_tokens }; })();
        const response = await (options.fetch ?? fetch)(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(wire), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) {
          const status = response.status;
          // Do not echo server bodies: gateways can include credentials or request data in errors.
          return fail(status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status >= 500 ? "overloaded" : "bad_request", `${id} returned HTTP ${status}.`, status === 429 || status >= 500, status);
        }
        const data = await response.json() as any;
        const choice = data.choices?.[0];
        const message = choice?.message;
        if (!message || message.role !== "assistant") return fail("bad_request", "The provider returned no assistant message.");
        const calls = message.tool_calls ?? [];
        if (!Array.isArray(calls)) return fail("bad_request", "The provider returned malformed tool calls.");
        const toolCalls = calls.map((call: any) => {
          if (call.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function.arguments !== "string") throw new Error("invalid tool call");
          return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown };
        });
        if (new Set(toolCalls.map(c => c.id)).size !== toolCalls.length) return fail("bad_request", "The provider returned duplicate tool-call IDs.");
        const usage = data.usage ?? {};
        const tokens = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
        return { ok: true, id: String(data.id ?? ""), model: String(data.model ?? model), raw: message,
          text: typeof message.content === "string" ? message.content : "", toolCalls,
          stopReason: message.refusal || choice.finish_reason === "content_filter" ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : "end_turn",
          usage: { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens), cacheReadTokens: tokens(usage.prompt_tokens_details?.cached_tokens), cacheWriteTokens: 0 } };
      } catch (error) {
        if (signal?.aborted) return fail("aborted", "The request was cancelled.");
        if (timeout.aborted) return fail("timeout", "The model request timed out.", true);
        return fail(error instanceof SyntaxError || (error instanceof Error && error.message === "invalid tool call") ? "bad_request" : "network", "The provider response could not be read or was malformed.");
      }
    },
  };
}
