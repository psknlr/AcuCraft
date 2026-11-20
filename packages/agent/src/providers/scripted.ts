import type { ActionRequestInput } from "@acucraft/core";
import type { ChatRequest, Completion, LLMProvider, ProviderError, ToolCall } from "./types.js";

/**
 * Models that are not models: a provider that plays a fixed script (tests of the loop), and one that plays a
 * scenario's reference trajectory as tool calls (the whole loop — tools, results, batches, interruptions — run end
 * to end with no network). Neither is a fair agent; both are instruments.
 */

/** One scripted turn: tool calls, a line of text, both, or a failure — or a function of the request it answers. */
export type ScriptedTurn = { calls?: { name: string; input?: unknown }[]; text?: string; stop?: Completion["stopReason"]; error?: Omit<ProviderError, "ok"> } | ((request: ChatRequest, index: number) => ScriptedTurn);

export interface ScriptedProvider extends LLMProvider {
  /** Every request received, in order (deep copies: later mutation of the conversation does not reach them). */
  readonly requests: ChatRequest[];
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A provider that answers its n-th request with the n-th turn of `script` (and ends its turn in silence after that). */
export function scriptedProvider(script: readonly ScriptedTurn[], model = "scripted"): ScriptedProvider {
  const requests: ChatRequest[] = [];
  let ids = 0;
  return {
    id: "scripted",
    model,
    label: model,
    requests,
    async complete(request) {
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(request)) as ChatRequest);
      let turn: ScriptedTurn = script[index] ?? { text: "" };
      if (typeof turn === "function") turn = turn(request, index);
      if (typeof turn === "function") throw new Error("a scripted turn returned a function");
      if (turn.error) return { ok: false, ...turn.error };
      const toolCalls: ToolCall[] = (turn.calls ?? []).map((c) => ({ id: `call-${++ids}`, name: c.name, input: c.input ?? {} }));
      const text = turn.text ?? "";
      return {
        ok: true,
        id: `scripted-${index + 1}`,
        model,
        stopReason: turn.stop ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
        text,
        toolCalls,
        raw: [...(text ? [{ type: "text", text }] : []), ...toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))],
        usage,
      };
    },
  };
}

export interface OracleOptions {
  /** How many of the next actions to ask for in one turn (default 1). More than one exercises batches. */
  batch?: number;
  /** Read-only calls to make before the first action (default: one `view`), so the reading path is exercised too. */
  warmUp?: { name: string; input?: unknown }[];
}

/**
 * The reference trajectory of a scenario, spoken as tool calls: each action becomes a call of the tool named after
 * it, with the action's own fields as input. When the loop reports that calls of a batch were not carried out, they
 * are asked for again. It reads the answer and is no measure of anything — it shows that every reference action can
 * be expressed through the tools, and that the loop carries a whole encounter.
 */
export function oracleProvider(steps: readonly ActionRequestInput[], options: OracleOptions = {}): ScriptedProvider {
  const batch = Math.max(1, options.batch ?? 1);
  const actions = steps.map((r) => r.action as Record<string, unknown>);
  let cursor = 0;
  let asked: number[] = [];
  let warmed = false;
  const provider = scriptedProvider([], "reference trajectory");
  const play = provider.complete.bind(provider);
  return {
    ...provider,
    id: "oracle",
    get requests() {
      return provider.requests;
    },
    async complete(request) {
      // which calls of the last batch were carried out: the others are asked for again, from the first of them
      const last = request.messages[request.messages.length - 1];
      const results = last?.role === "user" ? last.parts.filter((p) => p.type === "tool_result") : [];
      if (asked.length > 0 && results.length === asked.length) {
        const firstSkipped = results.findIndex((p) => p.type === "tool_result" && /"skipped":true/.test(p.content));
        if (firstSkipped >= 0) cursor = asked[firstSkipped]!;
      }
      asked = [];
      if (!warmed) {
        warmed = true;
        const calls = options.warmUp ?? [{ name: "view" }];
        if (calls.length > 0) {
          const turn = await play(request);
          return patch(turn, calls);
        }
      }
      const calls: { name: string; input: unknown }[] = [];
      for (; calls.length < batch && cursor < actions.length; cursor++) {
        const { type, ...input } = actions[cursor]!;
        asked.push(cursor);
        calls.push({ name: String(type), input });
      }
      return patch(await play(request), calls);
    },
  };

  /** Turn the silent scripted reply into one that makes `calls`. */
  function patch(turn: Completion | ProviderError, calls: { name: string; input?: unknown }[]): Completion | ProviderError {
    if (!turn.ok || calls.length === 0) return turn;
    const toolCalls: ToolCall[] = calls.map((c, i) => ({ id: `${turn.id}-${i + 1}`, name: c.name, input: c.input ?? {} }));
    return { ...turn, stopReason: "tool_use", toolCalls, raw: toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })) };
  }
}
