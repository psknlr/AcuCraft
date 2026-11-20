import type { ObjectSchema } from "../tools/schema.js";

/**
 * What the agent loop needs of a language model, whoever serves it: one request in, one complete turn out. The loop
 * speaks these neutral types; a provider translates them to its wire format and back, and never throws — a failure
 * is a value the loop can report.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The most output a single turn is asked for (a reply cut short is asked for again with this much room, once). */
export const MAX_TOKENS_CAP = 64_000;

/** A tool as the model is told of it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: ChatPart[];
  /**
   * An assistant turn exactly as its provider returned it (its native content blocks: thinking, tool use, compaction
   * …). A provider sends this back verbatim instead of rebuilding the turn from `parts`: a model's own blocks are
   * only valid unchanged.
   */
  raw?: unknown;
}

/** A part of the standing instructions. Sections are sent in order and never change within an encounter. */
export interface SystemSection {
  id: string;
  text: string;
}

export interface ChatRequest {
  system: readonly SystemSection[];
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  /** Overrides the provider's own output limit for this request (a reply cut short is asked for again with more room). */
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache, and written to it. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/**
 * Why the turn ended: the model called tools; it finished without calling any; its reply hit the output limit; it
 * declined; the server paused a long turn (send it back to continue); or something else.
 */
export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal" | "pause_turn" | "other";

export interface Completion {
  ok: true;
  /** The provider's id of the response, and the model that produced it (a fallback may differ from the one asked). */
  id: string;
  model: string;
  stopReason: StopReason;
  /** The text of the turn (what the model wrote besides its tool calls). */
  text: string;
  toolCalls: ToolCall[];
  /** The turn in the provider's own form, for `ChatMessage.raw` and for the transcript. */
  raw: unknown;
  usage: Usage;
}

export type ProviderErrorKind = "auth" | "rate_limit" | "overloaded" | "bad_request" | "context_exceeded" | "network" | "timeout" | "aborted" | "unknown";

export interface ProviderError {
  ok: false;
  kind: ProviderErrorKind;
  message: string;
  /** Worth asking again as it is (the provider has already retried as its policy allows). */
  retryable: boolean;
  status?: number;
}

export interface LLMProvider {
  /** Who serves the model (`anthropic`, `scripted` …). */
  readonly id: string;
  readonly model: string;
  /** A line for reports: the model and the settings that matter to a reader of results. */
  readonly label: string;
  complete(request: ChatRequest, signal?: AbortSignal): Promise<Completion | ProviderError>;
}
