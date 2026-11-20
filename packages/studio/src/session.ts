import {
  ACUCRAFT_VERSION,
  LOG_SCHEMA_ID,
  createEncounter,
  digest,
  hash53,
  observeAs,
  referenceLibrary,
  step,
  type ActionRequest,
  type AgentView,
  type AttemptRecord,
  type EncounterLog,
  type EncounterState,
  type Mode,
  type Scenario,
  type Side,
} from "@acucraft/core";
import {
  CLINICALCRAFT_REV,
  claudeAgent,
  encounterHtml,
  episodeMarkdown,
  evaluateEncounter,
  loadScenario,
  protocolAgent,
  referenceAgent,
  type Agent,
  type AgentTurn,
  type ContentPack,
  type EncounterReport,
} from "@acucraft/bench";
import { sceneOf, stageOf, teachingNeedles, teachingProbe, teachingRegion, type StudioScene, type StudioStage, type TeachingNeedle } from "./scene.js";

/**
 * One live encounter that a human operator and a language model share (docs/STUDIO.md).
 *
 * The session is the only holder of the encounter state and `act` is the only way to change it: the operator's
 * clicks, a built-in agent's turns, an HTTP client and the MCP bridge all end in the same call, in the same engine,
 * under the same rules. Whoever acts sees the same thing — the under-test actor's view, built by the engine from its
 * allow-list — so a person can watch a model work, stop it, take a step themselves and hand back.
 *
 * Hidden truth stays on this side: the snapshot a client receives is the view plus where people stand; anatomy under
 * the skin, reference locations, the report before the end and an agent that reads the scenario's solution are given
 * in teaching mode only.
 */

/** Who an action came through. `team`: not sent by anyone — an act of the team or the patient that a step set off. */
export type Via = "operator" | "agent" | "api" | "mcp" | "team";

export interface FeedItem {
  seq: number;
  minute: number;
  via: Via;
  /** The built-in agent that took the turn. */
  agent?: string;
  actor: string;
  actorName: string;
  type: string;
  action: unknown;
  status: AttemptRecord["status"];
  code: string | null;
  message: string;
  observations: string[];
  /** What the agent said about its choice. */
  note?: string;
  /** The walk a refusal named (`move { to }`), ready to send. */
  hint?: unknown;
}

export interface AgentStatus {
  name: string | null;
  /** Acting on its own, turn after turn. */
  running: boolean;
  /** Waiting for the agent's decision. */
  busy: boolean;
  /** An action the agent proposes and the operator has not yet applied or discarded. */
  pending: { action: unknown; note: string | null } | null;
  /** The agent has said it is done. */
  done: boolean;
  turns: number;
  stepDelayMs: number;
  note: string | null;
  error: string | null;
  available: { name: string; label: string; ready: boolean; why?: string }[];
}

export interface Snapshot {
  session: {
    id: string;
    family: string;
    title: string;
    mode: Mode;
    seed: number;
    actor: string;
    /** The actor this snapshot's view is of (the under-test actor unless asked otherwise in teaching mode). */
    viewOf: string;
    version: number;
    minute: number;
    finished: boolean;
    steps: number;
    canUndo: boolean;
    reportReady: boolean;
    /** Counts every change of the session (an action, an undo, a start, the agent's status): a later snapshot has a higher one. */
    revision: number;
    /** Counts the encounters started in this session: it changes when the session starts again. */
    epoch: number;
  };
  agent: AgentStatus;
  view: AgentView;
  stage: StudioStage;
  feed: FeedItem[];
  teaching?: { needles: TeachingNeedle[] };
}

export interface StudioEvent {
  type: "state";
  cause: "step" | "reset" | "agent" | "undo";
  /** Feed items this event added. */
  added: FeedItem[];
  snapshot: Snapshot;
}

export interface ActInput {
  action: unknown;
  via?: Via;
  expectedVersion?: number;
  note?: string;
  /** Stop a running agent and act (the operator's hand on the wheel). */
  takeover?: boolean;
  /** Act as another member of the cast (teaching mode only). */
  as?: string;
}

export interface ActResult {
  attempt: FeedItem;
  /** Acts the step set off (the team's, the patient's): teaching mode only. */
  others: FeedItem[];
  snapshot: Snapshot;
}

export class StudioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AgentFactory = (sc: Scenario, opts: { model?: string; effort?: string }) => Agent;

export interface AgentOffer {
  label: string;
  make: AgentFactory;
  ready?: () => true | string;
  /** It replays the scenario's hidden solution: offered in teaching mode only. */
  oracle?: boolean;
}

export interface StudioOptions {
  /** `family/variant`, or a family alone: its variant is then drawn by the seed and not named to anyone. */
  scenario: string;
  seed?: number;
  mode?: Mode;
  /** More agents than the built-in ones (tests: a model behind a mock client). */
  agents?: Record<string, AgentOffer>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ORACLE_REFUSAL = "it replays the scenario's hidden solution: teaching mode only";

/** The `move { "to": … }` a refusal ends with, if it names one. */
export function hintOf(message: string): unknown {
  const at = message.lastIndexOf("move {");
  if (at < 0) return undefined;
  const text = message.slice(at + 5);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, i + 1)) as { to?: unknown };
          return parsed && typeof parsed === "object" && "to" in parsed ? { type: "move", to: parsed.to } : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * The scenario an id names. `family/variant` is that instance. A family alone is one of its variants, drawn by the
 * seed: whoever starts an assessment this way does not know which.
 */
export function resolveScenario(pack: ContentPack, id: string, seed: number): Scenario {
  let full = id;
  if (!id.includes("/")) {
    const family = pack.families.get(id);
    if (!family || family.variantIds.length === 0) throw new StudioError(404, "unknown-scenario", `There is no scenario family ${id}.`);
    const draw = parseInt(hash53(`${id}#variant#${seed}`).slice(-8), 16) % family.variantIds.length;
    full = `${id}/${family.variantIds[draw]!}`;
  }
  const r = loadScenario(pack, full);
  if (!r.ok) throw new StudioError(404, "unknown-scenario", `There is no scenario ${id}: ${r.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ")}.`);
  return r.scenario;
}

const BUILT_IN: Record<string, AgentOffer> = {
  protocol: { label: "Protocol agent (scripted, sees only its view)", make: () => protocolAgent() },
  reference: { label: "Reference (the scenario's own solution: an oracle, for demonstration)", make: (sc) => referenceAgent(sc), oracle: true },
  claude: {
    label: "Claude (live model)",
    make: (_sc, opts) => claudeAgent({ ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort as never } : {}) }),
    ready: () => (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? true : "no API key in the environment (ANTHROPIC_API_KEY)"),
  },
};

let COUNTER = 0;

interface AgentState {
  name: string | null;
  instance: Agent | null;
  running: boolean;
  busy: boolean;
  pending: { turn: Extract<AgentTurn, { action: unknown }> } | null;
  done: boolean;
  turns: number;
  stepDelayMs: number;
  note: string | null;
  error: string | null;
  /** Changes when the agent is attached or detached: a decision that comes back to another agent is dropped. */
  loop: number;
  /** Changes with every run and pause: a run loop that is no longer the current one ends. */
  run: number;
}

export class StudioSession {
  readonly id: string;
  readonly pack: ContentPack;
  sc: Scenario;
  seed: number;
  mode: Mode;
  state: EncounterState;
  actor: string;
  /** The external requests, in order: with the seed and the mode, the whole encounter. */
  requests: ActionRequest[] = [];
  private via: Via[] = [];
  /** The feed's sequence number before each request: what an undo takes the feed back to. */
  private marks: number[] = [];
  private feed: FeedItem[] = [];
  private seq = 0;
  private counter = 0;
  private revision = 0;
  private epoch = 0;
  private agentsUsed = new Set<string>();
  private listeners = new Set<(e: StudioEvent) => void>();
  private factories: Record<string, AgentOffer>;
  private agent: AgentState = { name: null, instance: null, running: false, busy: false, pending: null, done: false, turns: 0, stepDelayMs: 900, note: null, error: null, loop: 0, run: 0 };

  constructor(pack: ContentPack, opts: StudioOptions) {
    this.pack = pack;
    this.id = `studio-${Date.now().toString(36)}-${(++COUNTER).toString(36)}`;
    this.factories = { ...BUILT_IN, ...(opts.agents ?? {}) };
    this.seed = opts.seed ?? 1;
    this.mode = opts.mode ?? "assessment";
    this.sc = resolveScenario(pack, opts.scenario, this.seed);
    this.actor = this.underTest(this.sc);
    this.state = createEncounter(this.sc, { seed: this.seed, mode: this.mode });
  }

  private underTest(sc: Scenario): string {
    return sc.field.cast.find((m) => m.agent === "under-test")!.id;
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  view(as?: string): AgentView {
    return observeAs(this.sc, this.state, this.actorFor(as));
  }

  private actorFor(as?: string): string {
    if (!as || as === this.actor) return this.actor;
    if (this.mode !== "teaching") throw new StudioError(403, "assessment-mode", "Only the practitioner under test is driven in assessment mode. Start the session in teaching mode to act as another member of the team.");
    if (!this.state.actors[as]) throw new StudioError(404, "unknown-actor", `${as} is not part of this encounter.`);
    return as;
  }

  library() {
    return referenceLibrary(this.sc);
  }

  scene(): StudioScene {
    return sceneOf(this.sc);
  }

  /** Can this agent be attached here and now (true), or why not. */
  private readiness(offer: AgentOffer): true | string {
    if (offer.oracle && this.mode !== "teaching") return ORACLE_REFUSAL;
    return offer.ready ? offer.ready() : true;
  }

  agentStatus(): AgentStatus {
    const a = this.agent;
    return {
      name: a.name,
      running: a.running,
      busy: a.busy,
      pending: a.pending ? { action: a.pending.turn.action, note: a.pending.turn.note ?? null } : null,
      done: a.done,
      turns: a.turns,
      stepDelayMs: a.stepDelayMs,
      note: a.note,
      error: a.error,
      available: Object.entries(this.factories).map(([name, f]) => {
        const ready = this.readiness(f);
        return { name, label: f.label, ready: ready === true, ...(ready === true ? {} : { why: ready }) };
      }),
    };
  }

  snapshot(sinceAttempt = this.state.attempts.length, as?: string): Snapshot {
    const viewOf = this.actorFor(as);
    const s = this.state;
    return {
      session: {
        id: this.id,
        family: this.sc.family.id,
        title: this.sc.family.title,
        mode: this.mode,
        seed: this.seed,
        actor: this.actor,
        viewOf,
        version: s.version,
        minute: Math.round(s.clinical.clock * 100) / 100,
        finished: s.finished,
        steps: this.requests.length,
        canUndo: this.mode === "teaching" && this.requests.length > 0,
        reportReady: s.finished || this.mode === "teaching",
        revision: this.revision,
        epoch: this.epoch,
      },
      agent: this.agentStatus(),
      view: observeAs(this.sc, s, viewOf),
      stage: stageOf(this.sc, s, sinceAttempt),
      feed: this.feed.slice(-80),
      ...(this.mode === "teaching" ? { teaching: { needles: teachingNeedles(this.sc, s) } } : {}),
    };
  }

  /** The record of the encounter so far: replaying it reproduces the state. */
  log(): EncounterLog {
    return {
      schema: LOG_SCHEMA_ID,
      scenarioId: this.sc.id,
      scenarioVersion: this.sc.family.version,
      engine: { acucraft: ACUCRAFT_VERSION, clinicalcraft: CLINICALCRAFT_REV },
      seed: this.seed,
      mode: this.mode,
      requests: this.requests,
      finalDigest: digest(this.state),
      meta: { studio: this.id, via: this.via, agents: [...this.agentsUsed], ...(this.agent.instance?.transcript ? { transcript: this.agent.instance.transcript() } : {}) },
    };
  }

  /** The evaluator's report: when the encounter has finished, or at any time in teaching mode. */
  report(): EncounterReport {
    if (!this.state.finished && this.mode !== "teaching") throw new StudioError(403, "not-finished", "The report is written when the encounter has finished (finish_encounter). In teaching mode it can be read at any time.");
    return evaluateEncounter(this.sc, this.state);
  }

  reportMarkdown(): string {
    return episodeMarkdown(this.report());
  }

  /** The stand-alone review page of the encounter (bench viewer). */
  reviewHtml(): string {
    return encounterHtml(this.sc, this.state, this.report());
  }

  private needTeaching(): void {
    if (this.mode !== "teaching") throw new StudioError(403, "assessment-mode", "What lies under the skin is shown in teaching mode only.");
  }

  teachingRegion(region: string, side: Side) {
    this.needTeaching();
    const r = teachingRegion(this.sc, this.state, region, side);
    if (!r) throw new StudioError(404, "unknown-region", `There is no regional model ${region}.`);
    return r;
  }

  teachingProbe(q: Parameters<typeof teachingProbe>[2]) {
    this.needTeaching();
    const r = teachingProbe(this.sc, this.state, q);
    if (!r) throw new StudioError(404, "unknown-region", `There is no regional model ${q.region}.`);
    return r;
  }

  /* ---------------------------------------------------------------- */
  /* Acting                                                            */
  /* ---------------------------------------------------------------- */

  on(listener: (e: StudioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(cause: StudioEvent["cause"], added: FeedItem[] = [], sinceAttempt = this.state.attempts.length): Snapshot {
    this.revision += 1;
    const snapshot = this.snapshot(sinceAttempt);
    const event: StudioEvent = { type: "state", cause, added, snapshot };
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // a listener that fails is its own problem
      }
    }
    return snapshot;
  }

  private feedItem(a: AttemptRecord, via: Via, note?: string): FeedItem {
    const message = a.message || a.executed?.detail || "";
    const hint = a.status === "rejected" || a.status === "blocked" ? hintOf(message) : undefined;
    return {
      seq: ++this.seq,
      minute: Math.round(a.at * 100) / 100,
      via,
      ...(via === "agent" && this.agent.name ? { agent: this.agent.name } : {}),
      actor: a.actor,
      actorName: this.sc.field.cast.find((m) => m.id === a.actor)?.name ?? (a.actor === this.sc.field.patient.id ? "the patient" : a.actor),
      type: a.request.action.type,
      action: a.request.action,
      status: a.status,
      code: a.code,
      message,
      observations: [...a.observations],
      ...(note ? { note } : {}),
      ...(hint ? { hint } : {}),
    };
  }

  /** The one way the encounter changes. */
  act(input: ActInput): ActResult {
    const via = input.via ?? "api";
    if (this.agent.running && via !== "agent") {
      if (!input.takeover) throw new StudioError(409, "agent-in-control", `The agent (${this.agent.name}) is acting. Pause it first, or send the action with takeover: true.`);
      this.pauseAgent();
    }
    const action = input.action;
    // a person's malformed request is theirs to correct; an agent's is its act, and is on the record as the engine has it
    if (via !== "agent" && (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string")) {
      throw new StudioError(400, "invalid-action", 'An action is an object with a `type`, for example { "type": "observe" }.');
    }
    const actor = this.actorFor(input.as);
    const before = this.state.attempts.length;
    const req = {
      requestId: `${actor}-${String(++this.counter).padStart(4, "0")}`,
      actor,
      patient: this.sc.field.patient.id,
      action,
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
    };
    const res = step(this.sc, this.state, req as never);
    this.marks.push(this.seq);
    this.state = res.state;
    this.requests.push(res.attempt.request);
    this.via.push(via);
    const attempt = this.feedItem(res.attempt, via, input.note);
    // what the step set off in others is theirs to report: shown as it happens in teaching mode only
    const others = this.mode === "teaching" ? res.attempts.slice(1).map((a) => this.feedItem(a, "team")) : [];
    this.feed.push(attempt, ...others);
    if (this.feed.length > 400) this.feed.splice(0, this.feed.length - 400);
    const snapshot = this.emit("step", [attempt, ...others], before);
    return { attempt, others, snapshot };
  }

  /** Take back the last action (teaching mode): the encounter is replayed without it. A built-in agent is detached. */
  undo(): Snapshot {
    if (this.mode !== "teaching") throw new StudioError(403, "assessment-mode", "An action cannot be taken back in assessment mode.");
    if (this.requests.length === 0) throw new StudioError(409, "nothing-to-undo", "Nothing has been done yet.");
    this.detachAgent();
    this.requests.pop();
    this.via.pop();
    let s = createEncounter(this.sc, { seed: this.seed, mode: this.mode });
    for (const r of this.requests) s = step(this.sc, s, r).state;
    this.state = s;
    // the feed goes back to where it stood before that request, whoever sent it and as whom
    const mark = this.marks.pop() ?? 0;
    this.feed = this.feed.filter((f) => f.seq <= mark);
    return this.emit("undo");
  }

  /** Start again: the same scenario, or another; another seed or mode. */
  reset(opts: Partial<Pick<StudioOptions, "scenario" | "seed" | "mode">> = {}): Snapshot {
    const seed = opts.seed ?? this.seed;
    // nothing is touched until the scenario asked for is known to exist
    const sc = opts.scenario ? resolveScenario(this.pack, opts.scenario, seed) : this.sc;
    this.detachAgent();
    this.sc = sc;
    this.seed = seed;
    if (opts.mode) this.mode = opts.mode;
    this.actor = this.underTest(this.sc);
    this.state = createEncounter(this.sc, { seed: this.seed, mode: this.mode });
    this.requests = [];
    this.via = [];
    this.marks = [];
    this.feed = [];
    this.counter = 0;
    this.epoch += 1;
    this.agentsUsed.clear();
    return this.emit("reset");
  }

  /* ---------------------------------------------------------------- */
  /* The built-in agent                                                */
  /* ---------------------------------------------------------------- */

  async attachAgent(name: string | null, opts: { stepDelayMs?: number; model?: string; effort?: string } = {}): Promise<AgentStatus> {
    if (name !== null) {
      // the agent in place stays in place until the one asked for is known to be attachable
      const offer = this.factories[name];
      if (!offer) throw new StudioError(404, "unknown-agent", `There is no agent ${name}. Available: ${Object.keys(this.factories).join(", ")}.`);
      const ready = this.readiness(offer);
      if (ready !== true) throw new StudioError(offer.oracle && this.mode !== "teaching" ? 403 : 409, "agent-not-ready", `The agent ${name} cannot run here: ${ready}.`);
    }
    this.detachAgent();
    if (opts.stepDelayMs !== undefined) this.setStepDelay(opts.stepDelayMs);
    if (name === null) {
      this.emit("agent");
      return this.agentStatus();
    }
    const instance = this.factories[name]!.make(this.sc, opts);
    if (instance.oracle && this.mode !== "teaching") {
      this.emit("agent");
      throw new StudioError(403, "agent-not-ready", `The agent ${name} cannot run here: ${ORACLE_REFUSAL}.`);
    }
    const loop = this.agent.loop;
    await instance.init?.({ actorId: this.actor, library: this.library() });
    if (this.agent.loop !== loop) throw new StudioError(409, "agent-replaced", "Another agent was attached meanwhile.");
    this.agent = { ...this.agent, name, instance, running: false, busy: false, pending: null, done: false, turns: 0, note: null, error: null, loop: loop + 1, run: this.agent.run + 1 };
    this.agentsUsed.add(name);
    this.emit("agent");
    return this.agentStatus();
  }

  /** Let go of the agent. A decision it is still making is dropped when it comes back. */
  detachAgent(): void {
    this.agent = { ...this.agent, name: null, instance: null, running: false, busy: false, pending: null, done: false, turns: 0, note: null, error: null, loop: this.agent.loop + 1, run: this.agent.run + 1 };
  }

  pauseAgent(): AgentStatus {
    if (this.agent.running) {
      this.agent.running = false;
      this.agent.run += 1;
      this.emit("agent");
    }
    return this.agentStatus();
  }

  setStepDelay(ms: number): void {
    this.agent.stepDelayMs = Math.max(0, Math.min(10000, ms));
  }

  private async decide(): Promise<AgentTurn> {
    const a = this.agent;
    if (!a.instance) throw new StudioError(409, "no-agent", "No agent is attached.");
    if (a.busy) throw new StudioError(409, "agent-busy", "The agent is already deciding.");
    if (this.state.finished) throw new StudioError(409, "finished", "The encounter has finished.");
    const loop = a.loop;
    a.busy = true;
    a.error = null;
    this.emit("agent");
    try {
      const turn = await a.instance.next(this.view());
      if (this.agent.loop !== loop) throw new StudioError(409, "agent-replaced", "The agent was detached while it was deciding.");
      return turn;
    } catch (e) {
      if (this.agent.loop === loop) {
        this.agent.error = (e as Error).message;
        this.agent.running = false;
        this.agent.run += 1;
      }
      throw e;
    } finally {
      if (this.agent.loop === loop) {
        this.agent.busy = false;
        // whoever watches is told the agent has stopped deciding, and with what
        this.emit("agent");
      }
    }
  }

  private finished(turn: Extract<AgentTurn, { done: true }>): void {
    this.agent.done = true;
    this.agent.running = false;
    this.agent.run += 1;
    this.agent.note = turn.note ?? "The agent has nothing more to do.";
  }

  /** Ask the agent what it would do next, without doing it: the operator applies or discards it. */
  async proposeAgent(): Promise<AgentStatus> {
    if (this.agent.running) throw new StudioError(409, "agent-in-control", "The agent is acting on its own: pause it to be asked what it would do.");
    if (this.agent.pending) return this.agentStatus();
    const turn = await this.decide();
    if ("done" in turn) this.finished(turn);
    else this.agent.pending = { turn: { action: turn.action, ...(turn.note ? { note: turn.note } : {}) } };
    this.emit("agent");
    return this.agentStatus();
  }

  /** Decline the agent's proposal: it is not carried out, and the agent is told so if it can be. */
  discardProposal(): AgentStatus {
    if (this.agent.pending) {
      this.agent.pending = null;
      this.agent.instance?.declined?.();
      this.emit("agent");
    }
    return this.agentStatus();
  }

  /** One turn of the agent: its proposal if one is waiting, else what it decides now. */
  async stepAgent(): Promise<ActResult | { done: true; snapshot: Snapshot }> {
    const a = this.agent;
    if (a.pending) {
      // applied by the operator, who has seen both the proposal and the state as it is now: it is decided now
      const { turn } = a.pending;
      a.pending = null;
      a.turns += 1;
      a.note = turn.note ?? null;
      return this.act({ action: turn.action, via: "agent", ...(turn.note ? { note: turn.note } : {}) });
    }
    const version = this.state.version;
    const turn = await this.decide();
    if ("done" in turn) {
      this.finished(turn);
      return { done: true, snapshot: this.emit("agent") };
    }
    this.agent.turns += 1;
    this.agent.note = turn.note ?? null;
    // decided on the view it was shown: if someone acted meanwhile the engine says so, and the agent sees that next
    return this.act({ action: turn.action, via: "agent", expectedVersion: version, ...(turn.note ? { note: turn.note } : {}) });
  }

  /** Let the agent act on its own until it is paused, done, or the encounter has finished. */
  runAgent(): AgentStatus {
    const a = this.agent;
    if (!a.instance) throw new StudioError(409, "no-agent", "No agent is attached.");
    if (a.running) return this.agentStatus();
    a.running = true;
    a.done = false;
    a.error = null;
    const run = ++a.run;
    const mine = () => this.agent.run === run && this.agent.running;
    this.emit("agent");
    void (async () => {
      while (mine() && !this.state.finished) {
        // a decision still on its way (a step taken by hand, an earlier run) is waited for, not raced
        while (this.agent.busy && mine()) await sleep(25);
        if (!mine()) break;
        try {
          const r = await this.stepAgent();
          if ("done" in r) break;
        } catch (e) {
          if (this.agent.run === run || !this.agent.running) {
            this.agent.error ??= (e as Error).message;
            this.agent.running = false;
            this.emit("agent");
          }
          break;
        }
        // always a turn of the event loop between two steps: a pause can be heard even at no pace at all
        await sleep(this.agent.stepDelayMs);
      }
      if (mine()) {
        this.agent.running = false;
        this.agent.run += 1;
        this.emit("agent");
      }
    })();
    return this.agentStatus();
  }
}
