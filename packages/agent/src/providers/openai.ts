import { MAX_TOKENS_CAP, type ChatMessage, type ChatRequest, type Completion, type Effort, type LLMProvider, type ProviderError, type ToolCall } from "./types.js";

/** Tool-calling models through the OpenAI Chat Completions wire format. Credentials stay on the host. */
export const DEFAULT_OPENAI_MODEL = "gpt-4.1";
export const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.5";

export interface OpenAIProviderOptions {
  model?: string;
  /** Applied only to OpenAI reasoning model families; MiniMax selects its own reasoning budget. */
  effort?: Effort;
  maxTokens?: number;
  apiKey?: string;
  /** API root, including /v1. Defaults to the provider's official HTTPS endpoint. */
  baseUrl?: string;
  /** Per-attempt deadline, including reading the response (default 120 seconds). */
  timeoutMs?: number;
  retries?: number;
  /** Injectable transport for offline tests. */
  fetch?: typeof globalThis.fetch;
}

type ProviderId = "openai" | "minimax";
type WireMessage = Record<string, unknown>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tokens = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const error = (kind: ProviderError["kind"], message: string, retryable = false, status?: number): ProviderError => ({ ok: false, kind, message, retryable, ...(status === undefined ? {} : { status }) });

/** Results are separate `tool` messages; their original IDs bind them to the preceding assistant call. */
export function toOpenAIMessages(messages: readonly ChatMessage[], provider: ProviderId = "openai"): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (record(message.raw) && message.raw.role === "assistant") {
        // Preserve the model's own tool arguments and MiniMax reasoning metadata unchanged between turns.
        const raw: WireMessage = { role: "assistant", content: message.raw.content ?? null };
        if (Array.isArray(message.raw.tool_calls)) raw.tool_calls = message.raw.tool_calls;
        if (provider === "minimax") {
          for (const key of ["reasoning_details", "reasoning_content"]) if (message.raw[key] !== undefined) raw[key] = message.raw[key];
        }
        out.push(raw);
      } else {
        const calls = message.parts.filter((p) => p.type === "tool_call");
        out.push({ role: "assistant", content: message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") || null,
          ...(calls.length ? { tool_calls: calls.map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } })) } : {}) });
      }
    } else {
      for (const p of message.parts) if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: p.content || "(no output)" });
      const text = message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function buildOpenAIRequest(provider: ProviderId, options: Pick<OpenAIProviderOptions, "model" | "effort" | "maxTokens">, request: ChatRequest): Record<string, unknown> {
  const model = options.model ?? (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_MINIMAX_MODEL);
  const limit = Math.max(1, Math.min(request.maxTokens ?? options.maxTokens ?? 16_384, MAX_TOKENS_CAP));
  const body: Record<string, unknown> = {
    model, stream: false,
    messages: [
      ...request.system.filter((s) => s.text.trim()).map((s) => ({ role: "system", content: s.text })),
      ...toOpenAIMessages(request.messages, provider),
    ],
    ...(provider === "openai" ? { max_completion_tokens: limit } : { max_tokens: limit, reasoning_split: true }),
  };
  if (request.tools.length) {
    body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    body.tool_choice = "auto";
  }
  if (provider === "openai" && /^(?:o[1-9](?:-|$)|gpt-5(?:[.-]|$))/i.test(model) && options.effort) {
    body.reasoning_effort = options.effort === "xhigh" || options.effort === "max" ? "high" : options.effort;
  }
  return body;
}

/** Validate the entire turn before returning any calls: partial or malformed tool arguments never reach the engine. */
export function toOpenAICompletion(value: unknown, fallbackModel: string): Completion | ProviderError {
  if (!record(value) || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)) return error("bad_request", "The model API returned no assistant turn.");
  const choice = value.choices[0];
  const message = choice.message as Record<string, unknown>;
  const raw = JSON.parse(JSON.stringify({ ...message, role: "assistant" })) as unknown;
  const toolCalls: ToolCall[] = [];
  if (choice.finish_reason !== "length" && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return error("bad_request", "The model returned invalid tool calls.");
    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      if (!record(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || ids.has(call.id) || !record(call.function) || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") return error("bad_request", "The model returned an invalid tool call or duplicate call ID.");
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); }
      catch { return error("bad_request", "The model's tool input was not valid JSON; no calls from this turn were executed."); }
      if (!record(input)) return error("bad_request", "The model's tool input must be an object; no calls from this turn were executed.");
      ids.add(call.id);
      toolCalls.push({ id: call.id, name: call.function.name, input });
    }
  }
  const usage = record(value.usage) ? value.usage : {};
  const details = record(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = Math.min(tokens(usage.prompt_tokens), tokens(details.cached_tokens));
  return {
    ok: true, id: typeof value.id === "string" ? value.id : "", model: typeof value.model === "string" ? value.model : fallbackModel,
    stopReason: choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "content_filter" || message.refusal ? "refusal" : toolCalls.length ? "tool_use" : choice.finish_reason === "stop" ? "end_turn" : "other",
    text: typeof message.content === "string" ? message.content.trim() : "", toolCalls, raw,
    usage: { inputTokens: tokens(usage.prompt_tokens) - cached, outputTokens: tokens(usage.completion_tokens), cacheReadTokens: cached, cacheWriteTokens: 0 },
  };
}

function httpError(status: number, value: unknown, provider: ProviderId, key: string): ProviderError {
  const detail = record(value) && record(value.error) && typeof value.error.message === "string" ? value.error.message : `HTTP ${status}`;
  const message = `${provider} API: ${detail.split(key).join("[redacted]").slice(0, 500)}`;
  const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status >= 500 ? "overloaded" : /context|too many tokens|token limit/i.test(detail) ? "context_exceeded" : "bad_request";
  return error(kind, message, kind === "rate_limit" || kind === "overloaded", status);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function compatibleProvider(provider: ProviderId, options: OpenAIProviderOptions): LLMProvider {
  const model = options.model ?? (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_MINIMAX_MODEL);
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "MINIMAX_API_KEY";
  const baseName = provider === "openai" ? "OPENAI_BASE_URL" : "MINIMAX_BASE_URL";
  const env = typeof process === "undefined" ? {} : process.env;
  const base = (options.baseUrl ?? env[baseName] ?? (provider === "openai" ? "https://api.openai.com/v1" : "https://api.minimax.io/v1")).replace(/\/+$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  return {
    id: provider, model, label: `${provider}: ${model}`,
    async complete(request, signal) {
      const apiKey = options.apiKey ?? env[keyName];
      if (!apiKey?.trim()) return error("auth", `Set ${keyName} on the server to use ${provider}.`);
      if (signal?.aborted) return error("aborted", "The request was cancelled.");
      for (let attempt = 0; ; attempt++) {
        const timeout = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000;
        const deadline = AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.floor(timeout))));
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let failure: ProviderError;
        let delay = Math.min(1000 * 2 ** attempt, 30_000);
        try {
          const response = await transport(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(buildOpenAIRequest(provider, { ...options, model }, request)), signal: combined });
          const body = await response.text();
          let value: unknown = null;
          try { value = JSON.parse(body); } catch { /* A malformed body is handled as a provider response error below. */ }
          if (response.ok) return toOpenAICompletion(value, model);
          failure = httpError(response.status, value, provider, apiKey);
          const retryAfter = Number(response.headers.get("retry-after"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.min(retryAfter * 1000, 30_000);
        } catch {
          failure = signal?.aborted ? error("aborted", "The request was cancelled.") : deadline.aborted ? error("timeout", `The ${provider} API request timed out.`, true) : error("network", `Could not reach the ${provider} API.`, true);
        }
        if (!failure.retryable || attempt >= (options.retries ?? 2)) return failure;
        await wait(delay, signal);
        if (signal?.aborted) return error("aborted", "The request was cancelled.");
      }
    },
  };
}

export function openaiProvider(options: OpenAIProviderOptions = {}): LLMProvider { return compatibleProvider("openai", options); }
export function minimaxProvider(options: OpenAIProviderOptions = {}): LLMProvider { return compatibleProvider("minimax", options); }
