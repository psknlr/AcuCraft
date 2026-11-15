import type { ActionInput, AgentView } from "@acucraft/core";
import { NUDGE, systemSections } from "./prompt.js";
import { addUsage, MAX_TOKENS_CAP, NO_USAGE, type ChatMessage, type ChatPart, type LLMProvider, type ToolCall, type ToolSpec, type Usage } from "./providers/types.js";
import { interruption, openingText, outcomeOf } from "./render.js";
import type { Skill } from "./skills.js";
import { toolsFor, type ToolContext, type ToolDefinition } from "./tools/index.js";
import type { Agent, AgentInit, AgentTurn } from "./types.js";

/**
 * A language model as the practitioner.
 *
 * The runner asks for one action at a time (`next(view)`); a model's turn may hold several tool calls. So the loop
 * works through a turn's calls in order: a read-only call is answered at once; an action call is checked against the
 * engine's schema and handed to the runner, and its result — what the engine did, and what changed in the view — is
 * written when the runner comes back with the next view. When an action does not go as asked, or the patient or a
 * colleague then needs an answer, the calls after it are not carried out. Every call of a turn is answered in one
 * message, then the model is asked for its next turn.
 *
 * The conversation is only ever appended to and assistant turns go back exactly as they came, so a provider's prompt
 * cache holds the growing prefix and a model's own blocks stay valid. The loop never throws for something the model
 * or the provider did: it ends the encounter's turn with a note the episode log keeps.
 */

export interface LlmAgentOptions {
  provider: LLMProvider;
  /** The clinic's written skills the model may read (default: none). */
  skills?: readonly Skill[];
  /** Offer `construct_point`, the arithmetic of localisation on the model's own observations (default true). */
  locate?: boolean;
  /** Model turns allowed between two actions — lookups, views, turns without an act (default 8). */
  maxCallsPerTurn?: number;
  /** Model turns allowed in the whole encounter (default 800). */
  maxModelCalls?: number;
  /**
   * Asked before an action is handed to the engine: return a reason to refuse it. For a person supervising the
   * agent — it may take its time (a promise): the loop waits for the answer. The refusal goes back to the model as
   * the action's result and is kept in the transcript.
   */
  approve?: (action: ActionInput, view: AgentView) => string | null | undefined | void | Promise<string | null | undefined | void>;
  /**
   * What others did to the encounter between the view an action was decided on and the view after it — a person
   * working the same record, another client. Non-empty, it goes into the action's result as `meanwhile`, and the
   * rest of the model's turn waits: it was decided without knowing.
   */
  meanwhile?: (before: AgentView, after: AgentView) => unknown[] | undefined;
  /** Watches the loop (a command line showing the model at work). */
  onEvent?: (event: LlmEvent) => void;
}

export type LlmEvent =
  | { type: "model"; text: string; calls: { name: string; input: unknown }[]; usage: Usage; model: string }
  | { type: "read"; name: string; ok: boolean }
  | { type: "skipped"; name: string; reason: string }
  | { type: "invalid"; name: string; error: string };

/** A tool result this long is cut, and says so (nothing in the library comes near it: this bounds a mistake). */
const MAX_RESULT_CHARS = 120_000;

const asContent = (output: unknown): string => {
  const s = typeof output === "string" ? output : JSON.stringify(output);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[cut at ${MAX_RESULT_CHARS} characters of ${s.length}: ask for a narrower part]` : s;
};

export interface LlmAgent extends Agent {
  /** Tokens used so far, summed over the model's turns. */
  usage(): Usage & { modelCalls: number };
}

export function llmAgent(options: LlmAgentOptions): LlmAgent {
  const provider = options.provider;
  const skills = options.skills ?? [];
  const maxCallsPerTurn = options.maxCallsPerTurn ?? 8;
  const maxModelCalls = options.maxModelCalls ?? 800;
  const system = systemSections(skills);
  const emit = options.onEvent ?? (() => {});

  let library!: AgentInit["library"];
  let tools: ToolDefinition[] = [];
  let specs: ToolSpec[] = [];
  let byName = new Map<string, ToolDefinition>();
  const messages: ChatMessage[] = [];
  const transcript: unknown[] = [];
  let usage: Usage = NO_USAGE;
  let modelCalls = 0;

  /** The calls of the model's current turn still to carry out, and the answers gathered for it. */
  let queue: ToolCall[] = [];
  let results: ChatPart[] = [];
  /** Why the rest of the current turn's calls are not carried out. */
  let halted: string | null = null;
  /** The action handed to the runner, and the view it was decided on. */
  let awaiting: { call: ToolCall; before: AgentView } | null = null;
  let nudges = 0;
  let maxTokens: number | undefined;

  const answer = (call: ToolCall, output: unknown, isError = false) => void results.push({ type: "tool_result", id: call.id, content: asContent(output), ...(isError ? { isError: true } : {}) });
  const skip = (call: ToolCall, reason: string) => {
    emit({ type: "skipped", name: call.name, reason });
    answer(call, { skipped: true, reason: `Not carried out: ${reason}. Decide again from the results above.` }, true);
  };
  const done = (note: string): AgentTurn => ({ done: true, note });

  return {
    name: `${provider.id === "anthropic" ? "claude" : provider.id} (${provider.label})`,
    init(init) {
      library = init.library;
    },
    transcript: () => transcript,
    usage: () => ({ ...usage, modelCalls }),
    async next(view: AgentView): Promise<AgentTurn> {
      if (view.finished) return { done: true };
      if (messages.length === 0) {
        // the tools of this role, fixed for the encounter
        tools = toolsFor(view.you.may, { locate: options.locate !== false, skills: skills.length > 0 });
        specs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        byName = new Map(tools.map((t) => [t.name, t]));
        messages.push({ role: "user", parts: [{ type: "text", text: openingText(view) }] });
      }
      const ctx: ToolContext = { library, view, skills };

      // the action handed over last time has been stepped: its result, and whether the rest of the turn still stands
      if (awaiting) {
        const { call, before } = awaiting;
        awaiting = null;
        const { status, result } = outcomeOf(before, view);
        const others = options.meanwhile?.(before, view) ?? [];
        answer(call, others.length > 0 ? { ...result, meanwhile: others } : result, status === "rejected" || status === "blocked");
        halted = interruption(call.name, before, view) ?? (others.length > 0 ? "someone else acted on the encounter meanwhile" : null);
      }

      for (let turns = 0; ; ) {
        while (queue.length > 0) {
          const call = queue.shift()!;
          if (halted) {
            skip(call, halted);
            continue;
          }
          const tool = byName.get(call.name);
          if (!tool) {
            emit({ type: "invalid", name: call.name, error: "unknown tool" });
            answer(call, { error: `There is no tool ${call.name}.` }, true);
            halted = `there is no tool ${call.name}`;
            continue;
          }
          if (tool.kind === "read") {
            const read = tool.run(call.input, ctx);
            emit({ type: "read", name: call.name, ok: read.ok });
            answer(call, read.output, !read.ok);
            continue;
          }
          const parsed = tool.toAction(call.input);
          if (!parsed.ok) {
            emit({ type: "invalid", name: call.name, error: parsed.error });
            answer(call, { error: parsed.error }, true);
            halted = `the input of ${call.name} was not valid`;
            continue;
          }
          const refused = await options.approve?.(parsed.action, view);
          if (typeof refused === "string" && refused) {
            answer(call, { error: `Not carried out: ${refused}` }, true);
            halted = `${call.name} was not approved`;
            continue;
          }
          awaiting = { call, before: view };
          return { action: parsed.action };
        }

        // every call of the turn is answered: one message with all the results, then the model's next turn
        if (results.length > 0) {
          messages.push({ role: "user", parts: results });
          results = [];
          halted = null;
        }
        if (turns++ >= maxCallsPerTurn) return done("too many model turns without an action");
        if (modelCalls >= maxModelCalls) return done(`the budget of ${maxModelCalls} model turns is spent`);
        modelCalls++;
        const reply = await provider.complete({ system, messages, tools: specs, ...(maxTokens ? { maxTokens } : {}) });
        if (!reply.ok) return done(`the model could not be reached (${reply.kind}${reply.status ? ` ${reply.status}` : ""}): ${reply.message}`);
        usage = addUsage(usage, reply.usage);
        transcript.push({ id: reply.id, model: reply.model, stop_reason: reply.stopReason, content: reply.raw, usage: reply.usage });
        emit({ type: "model", text: reply.text, calls: reply.toolCalls.map((c) => ({ name: c.name, input: c.input })), usage: reply.usage, model: reply.model });

        if (reply.stopReason === "refusal") return done("the model declined (refusal)");
        if (reply.stopReason === "max_tokens") {
          // a reply cut short may hold a tool input cut short: never run it — ask again with more room, once
          if ((maxTokens ?? 0) >= MAX_TOKENS_CAP) return done("the model's reply was cut off at the output limit");
          maxTokens = MAX_TOKENS_CAP;
          continue;
        }
        messages.push({ role: "assistant", parts: [...(reply.text ? [{ type: "text" as const, text: reply.text }] : []), ...reply.toolCalls.map((c) => ({ type: "tool_call" as const, id: c.id, name: c.name, input: c.input }))], raw: reply.raw });
        if (reply.stopReason === "pause_turn") continue;
        if (reply.toolCalls.length === 0) {
          if (++nudges > 2) return done("the model stopped acting before the encounter was finished");
          messages.push({ role: "user", parts: [{ type: "text", text: NUDGE }] });
          continue;
        }
        nudges = 0;
        queue = [...reply.toolCalls];
      }
    },
  };
}
