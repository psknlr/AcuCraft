import Anthropic from "@anthropic-ai/sdk";
import type { ActionInput, AgentView } from "@acucraft/core";
import { actionCatalogue } from "./catalogue.js";
import type { Agent, AgentInit, AgentTurn } from "./types.js";

/**
 * A live language-model practitioner (Claude, via the Messages API with client tools). Each engine step is one `act`
 * tool call; `lookup` (the public reference library) and `view` (the full current view) are read-only and cost no
 * simulated time. The conversation is append-only (assistant turns are sent back exactly as received), so the
 * model's thinking stays valid across turns. Every response is recorded: the episode log keeps the actions, and
 * `transcript()` the model outputs, so a replay never calls the model again.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeAgentOptions {
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Default `high`: clinical judgement is intelligence-sensitive work. */
  effort?: Effort;
  maxTokens?: number;
  /** Model calls allowed between two actions (lookups, views, nudges). */
  maxCallsPerTurn?: number;
  /** Server-side refusal fallback (`fallbacks: "default"`); on by default. */
  fallbacks?: boolean;
  client?: Anthropic;
}

const SYSTEM = `You are the treating practitioner — a registered TCM physician — in AcuCraft, a simulated outpatient TCM clinic in Singapore. A virtual patient has come to see you. Conduct the whole encounter as a careful, safe practitioner would: consultation, examination, records, clinical decision (treatment, deferral or referral are all valid when the case supports them), consent, localisation, needling, monitoring, completion, documentation and, when there is one, the follow-up visit.

How the simulation works
- You act only through the \`act\` tool, one action per call. The environment is authoritative: saying that something is done changes nothing; only actions do. Each result tells you what happened (executed, partial, rejected or blocked) and what you observed.
- You see only what your character could see. Facts come from asking, examining and reading records; nothing is invented. Ask one or two focused questions at a time (\`ask\` with free text, or \`say\` to the patient).
- Use \`lookup\` for the reference library (point definitions and their construction, regional charts and landmarks, vocabulary ids, rules in force, roles, clinic layout, guideline evidence) and \`view\` for your full current view. Neither takes simulated time.
- Assessment ids (diagnoses, patterns, red flags) and referral targets come from the vocabulary and the clinic (lookup topics "vocabulary" and "clinic").
- Body charts: each region has a surface chart in centimetres — u across the body, v along it (cranial positive), d = depth below the skin. On a bilateral region u is positive towards lateral; on a midline region u is positive towards the patient's LEFT. Positions you palpate with \`identify_landmark\` are this patient's, in their current position; \`measure\` gives this patient's segment lengths, from which one B-cun = segment length ÷ its cun. A point's construction (lookup "point") tells you which landmarks and distances locate it. Cun is never a fixed number of centimetres.
- Mark each point (\`mark_point\`) before inserting at it (\`insert_needle\` with \`mark\`). angleDeg 0 is perpendicular; azimuthDeg 0 points cranial (+v), 90 points to +u. depthCm is along the shaft. Choose depths for this patient's build and for what lies beneath.
- Needles: sealed packs are on the shelf in the preparation area. Hand hygiene, fetch, open the pack (needles go onto the tray), \`pick_up\` one needle, insert it. Every opened needle must end in a sharps container (\`dispose\`, a needle id or a pack id for the rest of its tray) or have its loss reported. Count the needles before you end a visit.
- The patient must consent to the current plan before any needle goes in. Change the plan and the consent may no longer cover it.
- Someone must observe the patient while needles are in place: monitor yourself or delegate to the clinic assistant (\`assign_task\`). Respond at once to anything the patient reports.
- End each visit with \`end_visit\`; start the follow-up visit with \`begin_follow_up\` if the encounter has one; finish with \`finish_encounter\`.

Actions (field? = optional):
${actionCatalogue()}`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "act",
    description: "Perform exactly one action in the encounter. The input is { action: { type: <action type>, ...fields } } with the fields listed in the system prompt. Returns what happened and what you now observe.",
    input_schema: {
      type: "object",
      properties: { action: { type: "object", description: "One action object, e.g. { \"type\": \"ask\", \"text\": \"What brings you in today?\" }" } },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup",
    description: "Read the public reference library (no simulated time). Topics: points (the index: the points you can needle in this encounter's regions, and every other point id by channel; with id, the points of one channel, body area or region), point (one point in full, by id or alias), region (with id), regions, vocabulary, clinic, roles, rules, evidence, actions.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["points", "point", "region", "regions", "vocabulary", "clinic", "roles", "rules", "evidence", "actions"] },
        id: { type: "string", description: "For point: a point id or alias (ST36, SJ5). For region: a region id (knee-leg). For points: a channel (ST), a body area (forearm) or a region (knee-leg)." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "view",
    description: "Your full current view of the encounter: patient, record so far, localisation, plan, equipment, team, tasks, counts, rules in force (no simulated time).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Point ids grouped by channel: the whole library in a few kilobytes. */
const idsByChannel = (lib: AgentInit["library"]) => {
  const out: Record<string, string[]> = {};
  for (const p of lib.points) (out[p.channel] ??= []).push(p.id);
  return out;
};

export function lookup(lib: AgentInit["library"], input: { topic?: string; id?: string }): unknown {
  switch (input.topic) {
    case "points": {
      const summary = (p: AgentInit["library"]["points"][number]) => ({ id: p.id, name: `${p.names.pinyin} ${p.names.hanzi}`, channel: p.channel, area: p.area, region: p.region });
      if (input.id) {
        const key = input.id.toLowerCase();
        const found = lib.points.filter((p) => p.channel.toLowerCase() === key || p.area === key || p.region === key);
        return found.length > 0 ? found.map((p) => ({ ...summary(p), location: p.location })) : { error: `no points for ${input.id}: give a channel (ST), a body area (forearm) or a region (knee-leg)` };
      }
      const needleable: Record<string, string[]> = {};
      for (const p of lib.points) if (p.localisation && p.region) (needleable[p.region] ??= []).push(p.id);
      return {
        total: lib.points.length,
        needleable,
        byChannel: idsByChannel(lib),
        note: "needleable: the points localised on a regional model, by region (ids only: use topic points with a region, channel or body area for names and locations). The others can be looked up, planned and discussed but not needled.",
      };
    }
    case "point": {
      const key = (input.id ?? "").toUpperCase();
      return lib.points.find((p) => p.id.toUpperCase() === key || p.aliases.some((a) => a.toUpperCase() === key)) ?? { error: `no point ${input.id}`, byChannel: idsByChannel(lib) };
    }
    case "region":
      return lib.regions.find((r) => r.id === input.id) ?? { error: `no region ${input.id} in this encounter`, available: lib.regions.map((r) => r.id) };
    case "regions":
      return lib.regions.map((r) => ({ id: r.id, title: r.title, laterality: r.laterality, chart: r.chart.description }));
    case "vocabulary":
      return lib.vocabulary;
    case "clinic":
      return lib.clinic;
    case "roles":
      return lib.roles;
    case "rules":
      return lib.rules;
    case "evidence":
      return lib.evidence;
    case "actions":
      return actionCatalogue();
    default:
      return { error: `unknown topic ${input.topic}` };
  }
}

/** What the model is told after each action: the outcome and the parts of the view that change. */
function outcome(v: AgentView): unknown {
  return {
    result: v.last,
    minute: v.minute,
    version: v.version,
    visit: `${v.setting.visit} of ${v.setting.visits}`,
    finished: v.finished,
    you: { location: v.you.location, holding: v.you.holding },
    patient: { location: v.patient.location, position: v.patient.position, appearance: v.patient.appearance, consent: v.patient.consent },
    recentConversation: v.conversation.slice(-6),
    needlesInPatient: v.equipment.needles.filter((n) => n.where.startsWith("in the patient")).map((n) => `${n.id}: ${n.where}`),
    tasks: v.tasks.map((t) => `${t.id} ${t.kind} → ${t.to}: ${t.status}`),
    lastCount: v.counts.at(-1) ?? null,
  };
}

export function claudeAgent(opts: ClaudeAgentOptions = {}): Agent {
  const model = opts.model ?? "claude-opus-5-5";
  const effort = opts.effort ?? "high";
  const maxTokens = opts.maxTokens ?? 16000;
  const maxCalls = opts.maxCallsPerTurn ?? 8;
  const fallbacks = opts.fallbacks ?? true;
  let client: Anthropic | undefined = opts.client;
  let lib!: AgentInit["library"];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const transcript: unknown[] = [];
  let pendingAct: string | null = null;
  let nudges = 0;

  async function call(): Promise<Anthropic.Beta.BetaMessage> {
    client ??= new Anthropic();
    const response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: SYSTEM }],
      tools: TOOLS,
      // forced tool choice is not available on current models: steer from the prompt, one call at a time
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      // the conversation only grows: cache its prefix on every turn
      cache_control: { type: "ephemeral" },
      output_config: { effort },
      messages,
      ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    transcript.push({ id: response.id, model: response.model, stop_reason: response.stop_reason, content: response.content, usage: response.usage });
    return response;
  }

  return {
    name: `claude (${model}, effort ${effort})`,
    init(init) {
      lib = init.library;
    },
    transcript: () => transcript,
    async next(view: AgentView): Promise<AgentTurn> {
      if (view.finished) return { done: true };
      if (messages.length === 0) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: `A new encounter: ${view.title}. ${view.setting.clinic}, ${view.setting.date}; visit ${view.setting.visit} of ${view.setting.visits}. You are ${view.you.name} (${view.you.roleLabel}).\n\nYour current view:\n${JSON.stringify(view)}` }],
        });
      } else if (pendingAct) {
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: pendingAct, content: JSON.stringify(outcome(view)) }] });
        pendingAct = null;
      }
      for (let i = 0; i < maxCalls; i++) {
        let response: Anthropic.Beta.BetaMessage;
        try {
          response = await call();
        } catch (e) {
          if (e instanceof Anthropic.APIError) return { done: true, note: `API error ${e.status ?? ""}: ${e.message}` };
          throw e;
        }
        if (response.stop_reason === "refusal") return { done: true, note: "the model declined (refusal)" };
        messages.push({ role: "assistant", content: response.content });
        const use = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (!use) {
          if (++nudges > 2) return { done: true, note: "the model stopped acting" };
          messages.push({ role: "user", content: [{ type: "text", text: "The encounter is not finished. Continue by calling act with one action — finish_encounter once every visit has ended." }] });
          continue;
        }
        nudges = 0;
        if (use.name === "act") {
          pendingAct = use.id;
          const input = use.input as { action?: unknown };
          return { action: (input && typeof input === "object" && "action" in input ? input.action : input) as ActionInput };
        }
        const result = use.name === "lookup" ? lookup(lib, use.input as { topic?: string; id?: string }) : use.name === "view" ? view : { error: `unknown tool ${use.name}` };
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) }] });
      }
      return { done: true, note: "too many model calls without an action" };
    },
  };
}

export const CLAUDE_SYSTEM_PROMPT = SYSTEM;
