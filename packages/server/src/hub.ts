import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_SCHEMA_ID, type ActionInput, type AgentView, type AttemptRecord, type EncounterLog, type Mode } from "@acucraft/core";
import { EncounterSession, openingText, outcomeOf, toolsFor, type ToolContext, type ToolDefinition } from "@acucraft/agent";
import { CLINICALCRAFT_REV, encounterHtml, evaluateEncounter, requireScenario, type ContentPack, type EncounterReport } from "@acucraft/bench";
import { familiesOf, reportOutput, startChoice, type ClientRef, type EncounterStore, type StoreResult } from "@acucraft/mcp";
import { AgentRun, type RunnerOptions, type RunnerSnapshot, type TranscriptItem } from "./runner.js";

/**
 * The live records of the browser workspace (docs/WEB.md): every encounter open on the server, each one session of
 * the engine that everyone works on together — an operator in a browser, a language model run by the server, any
 * number of MCP clients. One way in for all of them: a tool of the practitioner (`@acucraft/agent`), checked
 * against the engine's own schema and stepped by the engine; what it changed is pushed to every subscriber at once.
 *
 * Every change is attributed (who did it: an operator, the server's LLM, an MCP client) and kept: each encounter is
 * written to the data directory as its replayable log and its timeline after every action, and brought back on
 * restart by replaying the log (the engine is deterministic: the replay must reproduce the recorded state).
 *
 * Nothing hidden is served while an encounter is open: the practitioner's view (`AgentView`, an allow-list of the
 * state), the public library and the timeline. The evaluation — and with it the variant and the pathways — exists
 * once the encounter is finished or closed.
 */

export type ActorKind = "operator" | "llm" | "mcp";

/** Who acted: a person at a browser, the server's language model, an MCP client — and which connection or tab. */
export interface Attribution {
  kind: ActorKind;
  name: string;
  id: string;
}

/** One action on the record, as the timeline shows it. */
export interface TimelineEntry {
  seq: number;
  /** Wall-clock time of the action (the encounter has its own simulated clock: `minute`). */
  at: string;
  by: Attribution;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  status: AttemptRecord["status"];
  code: string | null;
  message: string;
  observations: string[];
  /** The encounter's simulated minute and the state version after it. */
  minute: number;
  version: number;
}

/** Open: being worked on. Finished: the practitioner finished it. Closed: abandoned as it stood. */
export type EncounterStatus = "open" | "finished" | "closed";

export interface EncounterSummary {
  id: string;
  family: string;
  title: string;
  patient: string;
  presenting: string;
  /** The variant by number (as it was chosen), never by name. */
  variant: number;
  variants: number;
  seed: number;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  createdBy: Attribution;
  status: EncounterStatus;
  minute: number;
  version: number;
  visit: number;
  visits: number;
  actions: number;
  /** The evaluation's primary outcome, once finished or closed. */
  outcome: EncounterReport["primary"]["status"] | null;
  agent: { state: string; label: string } | null;
  viewers: number;
}

export interface EncounterSnapshot {
  summary: EncounterSummary;
  view: AgentView;
  timeline: TimelineEntry[];
  agent: RunnerSnapshot | null;
  /** The independent evaluation: only once the encounter is finished or closed. */
  report: EncounterReport | null;
}

export type HubEvent =
  | { type: "summary"; summary: EncounterSummary }
  | { type: "update"; id: string; summary: EncounterSummary; view: AgentView; entry: TimelineEntry }
  | { type: "agent"; id: string; summary: EncounterSummary; agent: RunnerSnapshot; item: TranscriptItem | null }
  | { type: "closed"; id: string; summary: EncounterSummary; report: EncounterReport }
  | { type: "removed"; id: string };

/** What the 3D view draws of the people of an encounter beyond its view (`RecordHub.stage`). */
export interface StageInfo {
  /** The clinic's equipment models by type: the set of the 3D view is built from these. */
  models: Record<string, { file: string; offset: [number, number, number]; scale: number }>;
  patient: { appearance: Record<string, unknown>; heightCm: number | null; seed: string };
  practitioner: { appearance: Record<string, unknown>; seed: string };
}

/** What an API call answers: an HTTP status and a body. */
export interface HubResult<T = unknown> {
  status: number;
  body: T;
}

/** The tools by the stage of an encounter they belong to (the order of the action interface). */
export const TOOL_GROUPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["say", "ask", "observe", "examine", "review_result", "order_investigation", "check_vitals"].map((t) => [t, "Consultation"])),
  ...Object.fromEntries(["assess", "decide", "propose_plan", "explain", "seek_consent", "refer"].map((t) => [t, "Decision and consent"])),
  ...Object.fromEntries(["position_patient", "identify_landmark", "measure", "mark_point"].map((t) => [t, "Localisation"])),
  ...Object.fromEntries(["move", "hand_hygiene", "fetch", "handover", "open_pack", "pick_up", "prepare_site", "prepare_couch"].map((t) => [t, "Preparation"])),
  ...Object.fromEntries(["insert_needle", "adjust_needle", "check_sensation", "monitor", "wait", "stop_treatment"].map((t) => [t, "Procedure"])),
  ...Object.fromEntries(["remove_needle", "remove_all_needles", "apply_pressure", "count_needles", "dispose", "search", "report_incident", "document", "end_visit", "begin_follow_up", "finish_encounter"].map((t) => [t, "Completion and records"])),
  ...Object.fromEntries(["assign_task", "acknowledge_task", "decline_task", "report_task", "cancel_task", "approve_plan"].map((t) => [t, "Team"])),
  ...Object.fromEntries(["lookup", "view", "construct_point", "read_skill"].map((t) => [t, "Reference (changes nothing)"])),
};

/** A record as it is kept on disk: the replayable log and the timeline. */
export const LIVE_RECORD_SCHEMA_ID = "acucraft/live-record@1" as const;

interface StoredRecord {
  schema: typeof LIVE_RECORD_SCHEMA_ID;
  id: string;
  family: string;
  variant: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Attribution;
  closed: boolean;
  log: EncounterLog;
  timeline: TimelineEntry[];
}

interface Live {
  id: string;
  family: string;
  variant: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Attribution;
  session: EncounterSession;
  tools: ToolDefinition[];
  timeline: TimelineEntry[];
  /** Closed as it stood (`close` with `abandon`); a finished encounter is closed by finishing. */
  closed: boolean;
  report: EncounterReport | null;
  runner: AgentRun | null;
  runs: number;
  /** The last view each MCP client or run was given: what it is told changed is measured from there. */
  seen: Map<string, AgentView>;
  viewers: number;
}

export interface HubOptions {
  pack: ContentPack;
  /** Where each record is written as it changes (null: in memory only). */
  dataDir?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** Options every LLM run starts with (tests: a provider in place of the network). */
  runner?: Partial<Pick<import("./runner.js").RunnerSetup, "providerOverride" | "pace">>;
}

const NAME = /^[\p{L}\p{N} .,'()_-]{1,40}$/u;
const ID = /^enc-[a-z0-9]{6,32}$/;
const fieldsOf = (action: ActionInput): Record<string, unknown> => {
  const { type: _type, ...rest } = action as Record<string, unknown>;
  return rest;
};

/** An operator's attribution from what a browser sent (a name it chose, a tab id): never trusted further than that. */
export function operator(name: unknown, tab: unknown): Attribution {
  const n = typeof name === "string" && NAME.test(name.trim()) ? name.trim() : "Operator";
  const id = typeof tab === "string" && /^[a-z0-9-]{4,40}$/i.test(tab) ? tab : "operator";
  return { kind: "operator", name: n, id: `operator:${id}` };
}

export class RecordHub {
  readonly pack: ContentPack;
  private readonly records = new Map<string, Live>();
  private readonly listeners = new Set<(event: HubEvent) => void>();
  private readonly dataDir: string | null;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly runnerDefaults: HubOptions["runner"];
  /** The practitioner's view of each state (the engine makes a new state object on every step, a rejection too). */
  private readonly views = new WeakMap<object, AgentView>();

  constructor(options: HubOptions) {
    this.pack = options.pack;
    this.dataDir = options.dataDir ?? null;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.runnerDefaults = options.runner ?? {};
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HubEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        this.log(`a listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** A browser started or stopped watching an encounter. */
  watching(id: string, delta: 1 | -1): void {
    const live = this.records.get(id);
    if (!live) return;
    live.viewers = Math.max(0, live.viewers + delta);
    this.emit({ type: "summary", summary: this.summaryOf(live) });
  }

  /* ------------------------------------------------------------------ */
  /* reading                                                             */
  /* ------------------------------------------------------------------ */

  families() {
    return familiesOf(this.pack);
  }

  summaries(): EncounterSummary[] {
    return [...this.records.values()].map((l) => this.summaryOf(l)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  snapshot(id: string): EncounterSnapshot | null {
    const live = this.records.get(id);
    if (!live) return null;
    return { summary: this.summaryOf(live), view: this.viewOf(live), timeline: [...live.timeline], agent: live.runner?.snapshot() ?? null, report: this.reportOf(live) };
  }

  /** The directory of the content pack the records are of (its 3D models are served from `world/assets/models`). */
  get contentDir(): string {
    return this.pack.dir;
  }

  /**
   * What the 3D view of an encounter draws that its view does not say: how the patient looks and how tall they
   * are — what anyone in the room sees of them (their case's `appearance` and `heightCm`; a variant may change
   * them, never its name) — and the look of the practitioner. Everything else the view draws (where the patient
   * is and how they lie, the marks, the needles) comes from the record's view and timeline.
   */
  stage(id: string): StageInfo | null {
    const live = this.records.get(id);
    if (!live) return null;
    const p = live.session.scenario.case.patient as { heightCm?: number; sex?: string; appearance?: Record<string, unknown> };
    const presentation = p.sex === "female" ? "feminine" : p.sex === "male" ? "masculine" : "neutral";
    return {
      models: this.models(),
      patient: { appearance: { presentation, ...(p.appearance ?? {}) }, heightCm: typeof p.heightCm === "number" ? p.heightCm : null, seed: `patient:${live.session.scenario.id}` },
      practitioner: { appearance: { skin: "#d9b48f", hair: "#24201d", hairStyle: "short", shirt: "#dfe7ea", pants: "#2f3a45", build: "average", presentation: "neutral" }, seed: `practitioner:${live.id}` },
    };
  }

  private modelRefs: Record<string, { file: string; offset: [number, number, number]; scale: number }> | null = null;

  /** The clinic's equipment models by type (its catalogs under `world/catalogs`): the file, its offset and scale. */
  private models(): Record<string, { file: string; offset: [number, number, number]; scale: number }> {
    if (this.modelRefs) return this.modelRefs;
    const out: Record<string, { file: string; offset: [number, number, number]; scale: number }> = {};
    const dir = join(this.pack.dir, "world", "catalogs");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".json")) continue;
        try {
          const catalog = JSON.parse(readFileSync(join(dir, name), "utf8")) as { equipment?: { id: string; model?: { uri?: string; offset?: number[]; scale?: number } }[] };
          for (const e of catalog.equipment ?? []) {
            const uri = e.model?.uri;
            if (!uri || !/^models\/[a-z0-9-]+\.glb$/.test(uri)) continue;
            const o = e.model?.offset ?? [0, 0, 0];
            out[e.id] = { file: uri, offset: [Number(o[0] ?? 0), Number(o[1] ?? 0), Number(o[2] ?? 0)], scale: Number(e.model?.scale ?? 1) };
          }
        } catch {
          /* not a catalog */
        }
      }
    }
    this.modelRefs = out;
    return out;
  }

  /** The tools of the encounter's practitioner, with their stage, description and input schema. */
  tools(id: string): { name: string; kind: string; group: string; description: string; inputSchema: unknown }[] | null {
    const live = this.records.get(id);
    return live ? live.tools.map((t) => ({ name: t.name, kind: t.kind, group: TOOL_GROUPS[t.name] ?? "Other", description: t.description, inputSchema: t.inputSchema })) : null;
  }

  /** The replayable log of an encounter so far (`acu replay`, `acu view`), with who did what. */
  logOf(id: string): EncounterLog | null {
    const live = this.records.get(id);
    return live ? live.session.log({ clinicalcraft: CLINICALCRAFT_REV }, { agent: "acucraft workspace", record: live.id, by: live.timeline.map((e) => ({ requestId: e.requestId, by: `${e.by.kind}: ${e.by.name}` })) }) : null;
  }

  /** The debrief page of a finished or closed encounter: it shows hidden truth (the reference locations, the tissue). */
  debrief(id: string): HubResult<string> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: "no such encounter" };
    const report = this.reportOf(live);
    if (!report) return { status: 409, body: "The debrief shows what is hidden while the encounter is open: finish or close it first." };
    return { status: 200, body: encounterHtml(live.session.scenario, live.session.state, report) };
  }

  /* ------------------------------------------------------------------ */
  /* changing                                                            */
  /* ------------------------------------------------------------------ */

  /** Start an encounter (a family, a variant by number or from the seed, a seed, a mode). */
  create(args: Record<string, unknown>, by: Attribution): HubResult<{ id: string; summary: EncounterSummary } | { error: unknown }> {
    const choice = startChoice(this.pack, args);
    if (!choice.ok) return { status: 400, body: { error: (choice.output as { error: unknown }).error ?? choice.output } };
    const session = new EncounterSession(requireScenario(this.pack, choice.scenarioId), { seed: choice.seed, mode: choice.mode });
    const live = this.adopt(session, choice.family.id, choice.index + 1, by, []);
    this.save(live);
    this.emit({ type: "summary", summary: this.summaryOf(live) });
    return { status: 201, body: { id: live.id, summary: this.summaryOf(live) } };
  }

  /** Bring a saved log (`acu run`, `acu mcp`, `acu play`, a download from here) back as a live record. */
  importLog(value: unknown, by: Attribution): HubResult<{ id: string; summary: EncounterSummary } | { error: string }> {
    const log = value as EncounterLog;
    if (!log || typeof log !== "object" || log.schema !== LOG_SCHEMA_ID || typeof log.scenarioId !== "string" || !Array.isArray(log.requests)) return { status: 400, body: { error: `not an encounter log (${LOG_SCHEMA_ID})` } };
    const [familyId, variantId] = log.scenarioId.split("/");
    const family = familyId ? this.pack.families.get(familyId) : undefined;
    const index = family && variantId ? family.variantIds.indexOf(variantId) : -1;
    if (!family || index < 0) return { status: 400, body: { error: `this content pack has no scenario ${log.scenarioId}` } };
    let session: EncounterSession;
    try {
      session = EncounterSession.fromLog(requireScenario(this.pack, log.scenarioId), log);
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    const at = this.now().toISOString();
    const from: Attribution = { kind: "operator", name: `imported log (${typeof log.meta?.agent === "string" ? log.meta.agent : "unknown"})`, id: "import" };
    const timeline = session.requests.map((r, i): TimelineEntry => {
      const a = session.state.attempts.find((x) => x.requestId === r.requestId)!;
      return { seq: i + 1, at, by: from, requestId: r.requestId, tool: r.action.type, input: fieldsOf(r.action as ActionInput), status: a.status, code: a.code, message: a.message || a.executed?.detail || "", observations: [...a.observations], minute: Math.round(a.at * 100) / 100, version: a.resultVersion };
    });
    const live = this.adopt(session, family.id, index + 1, by, timeline);
    if (session.finished) live.report = evaluateEncounter(session.scenario, session.state);
    this.save(live);
    this.emit({ type: "summary", summary: this.summaryOf(live) });
    return { status: 201, body: { id: live.id, summary: this.summaryOf(live) } };
  }

  /**
   * One tool of the practitioner on an encounter, by whoever: a read is answered from the view and the library and
   * changes nothing; an action is checked against the engine's schema, stepped by the engine, attributed, kept and
   * pushed to every subscriber. The result is what the practitioner is told: what the engine did, what it changed
   * since the caller last looked, and what others did meanwhile.
   */
  act(id: string, toolName: unknown, input: unknown, by: Attribution): HubResult<{ ok: boolean; output: unknown; entry?: TimelineEntry } | { error: string }> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: { error: "no such encounter" } };
    const tool = typeof toolName === "string" ? live.tools.find((t) => t.name === toolName) : undefined;
    if (!tool) return { status: 400, body: { error: `there is no tool ${String(toolName)}` } };
    const fields = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const done = this.callTool(live, tool, fields, by);
    return { status: 200, body: done };
  }

  private callTool(live: Live, tool: ToolDefinition, input: Record<string, unknown>, by: Attribution): { ok: boolean; output: unknown; entry?: TimelineEntry } {
    if (tool.kind === "read") {
      const view = this.viewOf(live);
      const ctx: ToolContext = { library: live.session.library(), view, skills: this.pack.skills };
      if (tool.name === "view" && by.kind !== "operator") live.seen.set(by.id, view);
      return tool.run(input, ctx);
    }
    if (live.closed || live.session.finished) return { ok: false, output: { error: "This encounter is closed: its record can be read, not changed." } };
    const parsed = tool.toAction(input);
    if (!parsed.ok) return { ok: false, output: { error: parsed.error } };
    const joined = by.kind !== "operator" && !live.seen.has(by.id);
    const before = by.kind === "operator" ? this.viewOf(live) : (live.seen.get(by.id) ?? this.viewOf(live));
    const applied = this.apply(live, parsed.action, by);
    const { result } = outcomeOf(before, applied.view);
    const others = this.meanwhile(live, by, before.version, applied.entry.seq);
    const output = { ...result, ...(others.length ? { meanwhile: others } : {}), ...(joined ? { note: "You had not looked at this encounter before: `view` gives its whole record." } : {}) };
    return { ok: applied.attempt.status !== "rejected" && applied.attempt.status !== "blocked", output, entry: applied.entry };
  }

  /** Step one action as `by`, keep it, tell everyone. */
  private apply(live: Live, action: ActionInput, by: Attribution): { attempt: AttemptRecord; view: AgentView; entry: TimelineEntry } {
    const wasFinished = live.session.finished;
    const done = live.session.act(action);
    this.views.set(live.session.state, done.view);
    const a = done.attempt;
    const entry: TimelineEntry = {
      seq: live.timeline.length + 1,
      at: this.now().toISOString(),
      by,
      requestId: a.requestId,
      tool: a.request.action.type,
      input: fieldsOf(a.request.action as ActionInput),
      status: a.status,
      code: a.code,
      message: a.message || a.executed?.detail || "",
      observations: [...a.observations],
      minute: done.view.minute,
      version: done.view.version,
    };
    live.timeline.push(entry);
    live.updatedAt = entry.at;
    if (by.kind !== "operator") live.seen.set(by.id, done.view);
    const finishedNow = !wasFinished && live.session.finished;
    if (finishedNow) live.report = evaluateEncounter(live.session.scenario, live.session.state);
    this.save(live);
    const summary = this.summaryOf(live);
    this.emit({ type: "update", id: live.id, summary, view: done.view, entry });
    if (finishedNow && live.report) this.emit({ type: "closed", id: live.id, summary, report: live.report });
    return { attempt: a, view: done.view, entry };
  }

  /** What others did on the record after `sinceVersion` (and before the caller's own entry `upTo`). */
  private meanwhile(live: Live, by: Attribution, sinceVersion: number, upTo = Number.POSITIVE_INFINITY): unknown[] {
    return live.timeline
      .filter((e) => e.version > sinceVersion && e.seq < upTo && e.by.id !== by.id)
      .map((e) => ({ by: `${e.by.kind === "operator" ? "operator" : e.by.kind === "llm" ? "language model" : "MCP client"} ${e.by.name}`, action: e.tool, input: e.input, status: e.status, ...(e.message ? { message: e.message.length > 240 ? `${e.message.slice(0, 240)}…` : e.message } : {}), minute: e.minute }));
  }

  /** End an encounter as it stands (`abandon`), or give the evaluation of a finished one. */
  close(id: string, abandon: boolean, by: Attribution): HubResult<{ report: EncounterReport } | { error: string }> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: { error: "no such encounter" } };
    if (!live.session.finished && !live.closed) {
      if (!abandon) return { status: 409, body: { error: "The encounter is still open: finish it (end_visit, then finish_encounter), or close it as it stands." } };
      live.runner?.stop(`the encounter was closed by ${by.name}`);
      live.closed = true;
      live.updatedAt = this.now().toISOString();
      live.report = evaluateEncounter(live.session.scenario, live.session.state);
      this.save(live);
      this.emit({ type: "closed", id: live.id, summary: this.summaryOf(live), report: live.report });
    }
    return { status: 200, body: { report: this.reportOf(live)! } };
  }

  report(id: string): HubResult<{ report: EncounterReport } | { error: string }> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: { error: "no such encounter" } };
    const report = this.reportOf(live);
    return report ? { status: 200, body: { report } } : { status: 409, body: { error: "The evaluation exists once the encounter is finished or closed." } };
  }

  /** Delete a record (its run stopped, its file removed). */
  remove(id: string): HubResult<{ removed: string } | { error: string }> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: { error: "no such encounter" } };
    live.runner?.stop("the record was deleted");
    this.records.delete(id);
    if (this.dataDir) rmSync(join(this.dataDir, id), { recursive: true, force: true });
    this.emit({ type: "removed", id });
    return { status: 200, body: { removed: id } };
  }

  /* ------------------------------------------------------------------ */
  /* the server's language model                                         */
  /* ------------------------------------------------------------------ */

  /** Start, pause, resume or stop the server's LLM on an encounter. */
  agent(id: string, op: unknown, options: Partial<RunnerOptions>, by: Attribution): HubResult<{ agent: RunnerSnapshot | null } | { error: string }> {
    const live = this.records.get(id);
    if (!live) return { status: 404, body: { error: "no such encounter" } };
    const runner = live.runner;
    switch (op) {
      case "start": {
        if (runner?.active) return { status: 409, body: { error: "A language model is already working on this encounter: pause or stop it first." } };
        if (live.closed || live.session.finished) return { status: 409, body: { error: "This encounter is closed." } };
        const provider = options.provider === "claude" ? "claude" : options.provider === "reference" ? "reference" : null;
        if (!provider) return { status: 400, body: { error: 'provider is "claude" or "reference"' } };
        const effort = options.effort && ["low", "medium", "high", "xhigh", "max"].includes(options.effort) ? options.effort : undefined;
        const model = typeof options.model === "string" && /^[a-z0-9][a-z0-9.\-_]{2,60}$/i.test(options.model) ? options.model : undefined;
        live.runs += 1;
        const me: Attribution = { kind: "llm", name: provider === "claude" ? `Claude (${model ?? "claude-opus-5-5"})` : "reference trajectory", id: `llm:${live.id}:${live.runs}` };
        live.runner = new AgentRun(this.runnerHost(live, me), {
          provider,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          supervised: options.supervised === true,
          ...(typeof options.maxActions === "number" && options.maxActions > 0 ? { maxActions: Math.min(options.maxActions, 2000) } : {}),
          ...(typeof options.pace === "number" && options.pace >= 0 ? { pace: Math.min(options.pace, 10_000) } : {}),
          ...this.runnerDefaults,
          skills: this.pack.skills,
          solution: live.session.scenario.field.solution,
          now: this.now,
        });
        this.log(`${live.id}: ${me.name} started by ${by.name}`);
        return { status: 200, body: { agent: live.runner.snapshot() } };
      }
      case "pause":
      case "resume":
      case "stop": {
        if (!runner) return { status: 409, body: { error: "No language model has worked on this encounter." } };
        const ok = op === "pause" ? runner.pause() : op === "resume" ? runner.resume() : runner.stop(`stopped by ${by.name}`);
        if (!ok) return { status: 409, body: { error: `The language model is ${runner.snapshot().state}: it cannot ${op}.` } };
        return { status: 200, body: { agent: runner.snapshot() } };
      }
      default:
        return { status: 400, body: { error: 'op is "start", "pause", "resume" or "stop"' } };
    }
  }

  /** The operator's answer to the action the supervised LLM is waiting with. */
  decide(id: string, approve: boolean, reason: unknown): HubResult<{ agent: RunnerSnapshot } | { error: string }> {
    const live = this.records.get(id);
    if (!live?.runner) return { status: 404, body: { error: "no language model is working on this encounter" } };
    if (!live.runner.decide(approve, typeof reason === "string" ? reason : undefined)) return { status: 409, body: { error: "The language model is not waiting for an approval." } };
    return { status: 200, body: { agent: live.runner.snapshot() } };
  }

  /** Wait for every run to end (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.records.values()].map((l) => l.runner?.done));
  }

  shutdown(): void {
    for (const live of this.records.values()) live.runner?.stop("the server stopped");
  }

  private runnerHost(live: Live, me: Attribution) {
    return {
      view: () => (this.records.get(live.id) === live && !live.closed ? this.viewOf(live) : null),
      library: () => live.session.library(),
      apply: (action: ActionInput) => {
        if (this.records.get(live.id) !== live || live.closed || live.session.finished) return null;
        const applied = this.apply(live, action, me);
        return { attempt: applied.attempt, view: applied.view };
      },
      meanwhile: (before: AgentView) => this.meanwhile(live, me, before.version),
      changed: (item: TranscriptItem | null) => {
        if (this.records.get(live.id) !== live || !live.runner) return;
        this.emit({ type: "agent", id: live.id, summary: this.summaryOf(live), agent: live.runner.snapshot(), item });
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* MCP: the same records for an MCP client (`/mcp`)                    */
  /* ------------------------------------------------------------------ */

  /** The hub as an MCP server's store: the client's encounters are records of the workspace, and it may join any open one. */
  mcpStore(): EncounterStore {
    const as = (c: ClientRef): Attribution => ({ kind: "mcp", name: c.name, id: `mcp:${c.id}` });
    return {
      families: () => this.families(),
      open: (args, client): StoreResult => {
        const made = this.create(args, as(client));
        if (made.status !== 201) return { ok: false, output: made.body };
        const live = this.records.get((made.body as { id: string }).id)!;
        const view = this.viewOf(live);
        live.seen.set(as(client).id, view);
        return { ok: true, output: { session_id: live.id, opening: openingText(view) } };
      },
      openEncounters: (): StoreResult => ({
        ok: true,
        output: this.summaries()
          .filter((s) => s.status === "open")
          .map((s) => ({ session_id: s.id, title: s.title, patient: s.patient, presenting: s.presenting, minute: s.minute, visit: `${s.visit} of ${s.visits}`, mode: s.mode, startedBy: `${s.createdBy.kind}: ${s.createdBy.name}`, ...(s.agent && ["thinking", "awaiting-approval", "paused"].includes(s.agent.state) ? { languageModel: s.agent.label } : {}) })),
      }),
      call: (id, tool, input, client): StoreResult | null => {
        const live = this.records.get(id);
        if (!live) return null;
        const { ok, output } = this.callTool(live, tool, input, as(client));
        return { ok, output };
      },
      report: (id, abandon, client): StoreResult | null => {
        const live = this.records.get(id);
        if (!live) return null;
        if (!live.session.finished && !live.closed && !abandon) return { ok: false, output: { error: "The encounter is still open. Finish it (end_visit, then finish_encounter) — or pass abandon: true to close it as it stands." } };
        const closed = this.close(id, true, as(client));
        if (closed.status !== 200) return { ok: false, output: closed.body };
        return { ok: true, output: reportOutput((closed.body as { report: EncounterReport }).report, live.session.finished) };
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* keeping records                                                     */
  /* ------------------------------------------------------------------ */

  /** Bring back every record of the data directory (each log replayed; a record that does not replay is skipped). */
  restore(): { restored: number; skipped: { file: string; reason: string }[] } {
    const skipped: { file: string; reason: string }[] = [];
    let restored = 0;
    if (!this.dataDir || !existsSync(this.dataDir)) return { restored, skipped };
    for (const name of readdirSync(this.dataDir).sort()) {
      const file = join(this.dataDir, name, "record.json");
      if (!ID.test(name) || !existsSync(file)) continue;
      try {
        const stored = JSON.parse(readFileSync(file, "utf8")) as StoredRecord;
        if (stored.schema !== LIVE_RECORD_SCHEMA_ID || stored.id !== name) throw new Error("not a live record");
        const session = EncounterSession.fromLog(requireScenario(this.pack, stored.log.scenarioId), stored.log);
        if (stored.timeline.length !== session.requests.length) throw new Error("its timeline and its log disagree");
        const live = this.adopt(session, stored.family, stored.variant, stored.createdBy, stored.timeline, stored.id, stored.createdAt);
        live.updatedAt = stored.updatedAt;
        live.closed = stored.closed;
        if (live.closed || session.finished) live.report = evaluateEncounter(session.scenario, session.state);
        restored++;
      } catch (e) {
        skipped.push({ file, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { restored, skipped };
  }

  private adopt(session: EncounterSession, family: string, variant: number, by: Attribution, timeline: TimelineEntry[], id = `enc-${randomBytes(6).toString("hex")}`, createdAt = this.now().toISOString()): Live {
    const live: Live = {
      id,
      family,
      variant,
      createdAt,
      updatedAt: createdAt,
      createdBy: by,
      session,
      tools: toolsFor(session.view().you.may, { skills: this.pack.skills.length > 0 }),
      timeline,
      closed: false,
      report: null,
      runner: null,
      runs: 0,
      seen: new Map(),
      viewers: 0,
    };
    this.records.set(id, live);
    return live;
  }

  private save(live: Live): void {
    if (!this.dataDir) return;
    const stored: StoredRecord = {
      schema: LIVE_RECORD_SCHEMA_ID,
      id: live.id,
      family: live.family,
      variant: live.variant,
      createdAt: live.createdAt,
      updatedAt: live.updatedAt,
      createdBy: live.createdBy,
      closed: live.closed,
      log: live.session.log({ clinicalcraft: CLINICALCRAFT_REV }, { agent: "acucraft workspace", record: live.id }),
      timeline: live.timeline,
    };
    const dir = join(this.dataDir, live.id);
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `record.json.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(stored)}\n`);
      renameSync(tmp, join(dir, "record.json"));
    } catch (e) {
      this.log(`could not write ${live.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The practitioner's view of the encounter as it stands (built once per state). */
  private viewOf(live: Live): AgentView {
    const state = live.session.state;
    let view = this.views.get(state);
    if (!view) {
      view = live.session.view();
      this.views.set(state, view);
    }
    return view;
  }

  private reportOf(live: Live): EncounterReport | null {
    return live.closed || live.session.finished ? (live.report ??= evaluateEncounter(live.session.scenario, live.session.state)) : null;
  }

  private summaryOf(live: Live): EncounterSummary {
    const view = this.viewOf(live);
    const family = this.pack.families.get(live.family);
    const report = live.closed || live.session.finished ? live.report : null;
    const run = live.runner?.snapshot();
    return {
      id: live.id,
      family: live.family,
      title: view.title,
      patient: view.patient.name,
      presenting: view.patient.presenting,
      variant: live.variant,
      variants: family?.variantIds.length ?? 0,
      seed: live.session.seed,
      mode: live.session.mode,
      createdAt: live.createdAt,
      updatedAt: live.updatedAt,
      createdBy: live.createdBy,
      status: live.session.finished ? "finished" : live.closed ? "closed" : "open",
      minute: view.minute,
      version: view.version,
      visit: view.setting.visit,
      visits: view.setting.visits,
      actions: live.timeline.length,
      outcome: report?.primary.status ?? null,
      agent: run ? { state: run.state, label: run.label } : null,
      viewers: live.viewers,
    };
  }
}
