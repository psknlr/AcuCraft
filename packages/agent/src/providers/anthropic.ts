import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS_CAP, type ChatMessage, type ChatRequest, type Completion, type Effort, type LLMProvider, type ProviderError, type StopReason, type ToolCall } from "./types.js";

/**
 * Claude through the Messages API (the official SDK; streamed, so a long turn cannot time out the connection).
 *
 * What a request carries, and why:
 *  - no `thinking` parameter: current models think adaptively by themselves, and `output_config.effort` is the control;
 *  - no forced `tool_choice`: current models reject it. The instructions ask for tools, and the loop asks again when
 *    a turn ends without one;
 *  - the standing instructions and the tools are identical on every request of an encounter, and the conversation is
 *    only ever appended to: the prompt cache holds the growing prefix (a breakpoint on the instructions, automatic
 *    caching of the conversation), and a model's thinking blocks stay valid;
 *  - an assistant turn is sent back exactly as it came (`ChatMessage.raw`);
 *  - server-side refusal fallback (`fallbacks: "default"`), so a safety classifier's false positive on clinical text
 *    does not end an encounter;
 *  - server-side compaction of a conversation that has grown very long, where the model supports it.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Room for a turn's thinking as well as its tool calls. */
export const DEFAULT_MAX_TOKENS = 32_000;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const COMPACTION_BETA = "compact-2026-01-12";
/** Models that take server-side refusal fallbacks in the `"default"` form. */
const FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1|fable-5-2|mythos-5-1|mythos-5-2)$/;
/** Models that take server-side compaction (`compact_20260112`). */
const COMPACTION_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5-5)/;
/** Models without `output_config.effort`. */
const NO_EFFORT_MODELS = /^claude-(sonnet-4-5|haiku-4-5|sonnet-4-0|opus-4-[01])/;

const COMPACTION_INSTRUCTIONS =
  "Summarise this clinical encounter so far for the practitioner who continues it. Keep: the patient's story and findings with their evidence ids; the assessment and the decision with their reasons; the plan and what the patient consented to; what was done at each needle (needle id, point, depth, what was felt, with evidence ids); anything the patient or a colleague is waiting for; and what remains to be done, in order. The environment holds the authoritative state and can be read again with the view tool, so prefer reasons and intentions to copies of state.";

export interface AnthropicProviderOptions {
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Default `high`: clinical judgement and anatomy are intelligence-sensitive work. Set explicitly: model defaults differ. */
  effort?: Effort;
  /** Output limit of a turn, thinking included (default 32 000). */
  maxTokens?: number;
  /** Server-side refusal fallback (default on). */
  fallbacks?: boolean;
  /** Input tokens at which the server compacts the conversation (default 300 000); `false` turns compaction off. */
  compactAt?: number | false;
  /** Attempts after the first for an overloaded or rate-limited request, on top of the SDK's own retries (default 3). */
  retries?: number;
  /** A client to use (tests; another endpoint or credentials). Default: `new Anthropic()`, from the environment. */
  client?: Anthropic;
  /** Waits between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An assistant turn's own blocks, ready to send back. They go back unchanged, with one exception the API asks for:
 * when a refusal fallback took over part-way through the turn, what the declined model produced before the last
 * `fallback` block is dropped except its text, and the `fallback` block stays where it was. Empty text is never sent.
 */
export function echoBlocks(blocks: readonly unknown[]): ContentParam[] {
  let boundary = -1;
  blocks.forEach((b, i) => {
    if (isRecord(b) && b.type === "fallback") boundary = i;
  });
  const out: ContentParam[] = [];
  blocks.forEach((b, i) => {
    if (!isRecord(b) || typeof b.type !== "string") return;
    if (b.type === "text" && (typeof b.text !== "string" || b.text === "")) return;
    if (i < boundary && b.type !== "text" && b.type !== "fallback") return;
    out.push(b as unknown as ContentParam);
  });
  return out;
}

/** The conversation in the API's form: tool results first in a user turn, assistant turns verbatim when we have them. */
export function toAnthropicMessages(messages: readonly ChatMessage[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.Messages.BetaMessageParam => {
    if (m.role === "assistant" && Array.isArray(m.raw)) return { role: "assistant", content: echoBlocks(m.raw) };
    const results: ContentParam[] = [];
    const rest: ContentParam[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") results.push({ type: "tool_result", tool_use_id: p.id, content: p.content || "(no output)", ...(p.isError ? { is_error: true } : {}) });
      else if (p.type === "tool_call") rest.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
      else if (p.text) rest.push({ type: "text", text: p.text });
    }
    return { role: m.role, content: [...results, ...rest] };
  });
}

/** The exact request body for one turn (pure: the same input always gives the same bytes). */
export function buildAnthropicRequest(options: Pick<AnthropicProviderOptions, "model" | "effort" | "maxTokens" | "fallbacks" | "compactAt">, request: ChatRequest): Params {
  const model = options.model ?? DEFAULT_MODEL;
  const sections = request.system.filter((s) => s.text.trim().length > 0);
  const params: Params = {
    model,
    max_tokens: Math.max(1, Math.min(request.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP)),
    // one breakpoint after the standing instructions (with the tools before them), one moving with the conversation
    system: sections.map((s, i) => (i === sections.length - 1 ? { type: "text" as const, text: s.text, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text: s.text })),
    cache_control: { type: "ephemeral" },
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as unknown as Anthropic.Beta.Messages.BetaTool.InputSchema, eager_input_streaming: true })),
    tool_choice: { type: "auto" },
    messages: toAnthropicMessages(request.messages),
  };
  if (!NO_EFFORT_MODELS.test(model)) params.output_config = { effort: options.effort ?? "high" };
  const betas: string[] = [];
  if (options.fallbacks !== false && FALLBACK_MODELS.test(model)) {
    betas.push(FALLBACK_BETA);
    params.fallbacks = "default";
  }
  if (options.compactAt !== false && COMPACTION_MODELS.test(model)) {
    betas.push(COMPACTION_BETA);
    params.context_management = { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: options.compactAt ?? 300_000 }, instructions: COMPACTION_INSTRUCTIONS }] };
  }
  if (betas.length > 0) params.betas = betas;
  return params;
}

function stopReasonOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
      return reason;
    case "stop_sequence":
      return "end_turn";
    default:
      return "other";
  }
}

/** A response as the loop reads it. Only what the serving model produced counts: tool calls before a `fallback` block were never asked for by it. */
export function toCompletion(message: Anthropic.Beta.Messages.BetaMessage): Completion {
  const blocks = message.content as unknown as readonly unknown[];
  let boundary = -1;
  blocks.forEach((b, i) => {
    if (isRecord(b) && b.type === "fallback") boundary = i;
  });
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  blocks.forEach((b, i) => {
    if (!isRecord(b)) return;
    if (b.type === "text" && typeof b.text === "string") text.push(b.text);
    if (b.type === "tool_use" && i > boundary && typeof b.id === "string" && typeof b.name === "string") toolCalls.push({ id: b.id, name: b.name, input: b.input });
  });
  const u = message.usage;
  return {
    ok: true,
    id: message.id,
    model: message.model,
    stopReason: stopReasonOf(message.stop_reason),
    text: text.join("\n").trim(),
    toolCalls,
    raw: JSON.parse(JSON.stringify(message.content)) as unknown,
    usage: { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheWriteTokens: u?.cache_creation_input_tokens ?? 0 },
  };
}

/** An SDK error as the loop reads it: the typed classes, most specific first. */
export function toProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  const of = (kind: ProviderError["kind"], retryable: boolean, message: string, status?: number): ProviderError => ({ ok: false, kind, retryable, message, ...(status ? { status } : {}) });
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return of("aborted", false, "The request was cancelled.");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return of("timeout", true, "The request to the Claude API timed out.");
  if (err instanceof Anthropic.APIConnectionError) return of("network", true, `Could not reach the Claude API: ${err.message}`);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return of("auth", false, `The Claude API did not accept the credentials: ${err.message}`, err.status);
  if (err instanceof Anthropic.RateLimitError) return of("rate_limit", true, err.message, err.status);
  if (err instanceof Anthropic.BadRequestError) return of(/prompt is too long|context window|too many tokens/i.test(err.message) ? "context_exceeded" : "bad_request", false, err.message, err.status);
  if (err instanceof Anthropic.NotFoundError) return of("bad_request", false, err.message, err.status);
  if (err instanceof Anthropic.InternalServerError) return of("overloaded", true, err.message, err.status);
  if (err instanceof Anthropic.APIError) {
    // an error event inside a stream carries no HTTP status
    const transient = err.status === 529 || err.status === undefined;
    return of(transient ? "overloaded" : "unknown", transient, err.message, err.status);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // a tool input that could not be parsed at all (inputs stream as they are generated): asking again may succeed
    if (/JSON/i.test(err.message)) return of("bad_request", true, `The model's tool input was not valid JSON: ${err.message.slice(0, 200)}`);
    return of(/api ?key|auth|credential/i.test(err.message) ? "auth" : "bad_request", false, err.message);
  }
  return of("unknown", false, err instanceof Error ? err.message : String(err));
}

/** Seconds the server asked us to wait, if it said. */
function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  const value = Number(headers?.get?.("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value * 1000, 60_000) : null;
}

export function anthropicProvider(options: AnthropicProviderOptions = {}): LLMProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? "high";
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let client = options.client;
  // compaction is an optimisation: if the endpoint will not take it, the encounter goes on without
  let compactAt = options.compactAt;

  return {
    id: "anthropic",
    model,
    label: `${model}, effort ${effort}`,
    async complete(request, signal) {
      for (let attempt = 0; ; attempt++) {
        const params = buildAnthropicRequest({ ...options, model, effort, compactAt }, request);
        try {
          client ??= new Anthropic();
          const message = await client.beta.messages.stream(params, signal ? { signal } : undefined).finalMessage();
          return toCompletion(message);
        } catch (err) {
          const error = toProviderError(err, signal);
          if (error.kind === "bad_request" && !error.retryable && compactAt !== false && params.context_management && /context_management|compact/i.test(error.message)) {
            compactAt = false;
            continue;
          }
          if (!error.retryable || attempt >= retries) return error;
          await sleep(retryAfterMs(err) ?? Math.min(2000 * 2 ** attempt, 30_000));
        }
      }
    },
  };
}
