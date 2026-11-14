import type { ActionInput, ActionRequestInput, AgentView, AttemptRecord } from "@acucraft/core";
import { anthropicProvider, llmAgent, oracleProvider, type Effort, type Library, type LlmAgent, type LlmEvent, type LLMProvider, type ProviderError, type Skill } from "@acucraft/agent";

/**
 * A language model working an encounter from inside the server (docs/WEB.md "The LLM in the workspace"): the
 * built-in agent loop (`@acucraft/agent` `llmAgent`) driven against a live record, each of its actions applied
 * through the same path as an operator's and shown to every browser as it happens.
 *
 * The operator stays in charge. A run can be paused (the model's next action waits), resumed and stopped (an
 * in-flight model call is cancelled); in supervised mode each action waits for the operator's approval, and a
 * refusal goes back to the model as that action's result. The operator may act at any time: the model is told what
 * others did meanwhile in the result of its next action, and the rest of its turn waits.
 */

/** Who plays the practitioner: Claude through the Messages API, or the scenario's reference trajectory spoken as tool calls (no network — a demonstration of the loop, not a model). */
export type RunnerProvider = "claude" | "reference";

export interface RunnerOptions {
  provider: RunnerProvider;
  /** The Claude model (default `claude-opus-5-5`). */
  model?: string;
  effort?: Effort;
  /** Each action waits for the operator's approval (default false). */
  supervised?: boolean;
  /** The most actions one run takes (default 400). */
  maxActions?: number;
  /** A pause before each model turn of the reference player, ms (default 600: slow enough to watch). */
  pace?: number;
}

export type RunnerState = "thinking" | "awaiting-approval" | "paused" | "finished" | "stopped" | "failed";

/** One line of what the model did, as the browser shows it. */
export interface TranscriptItem {
  seq: number;
  at: string;
  kind: "model" | "read" | "skipped" | "invalid" | "action" | "approval" | "status";
  text: string;
  detail?: unknown;
}

export interface RunnerSnapshot {
  state: RunnerState;
  provider: RunnerProvider;
  label: string;
  supervised: boolean;
  actions: number;
  /** Why it ended (or what it is waiting for). */
  note: string | null;
  /** The action waiting for the operator's approval, or held while the run is paused. */
  pending: { tool: string; input: Record<string, unknown>; why: "approval" | "paused" } | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; modelCalls: number } | null;
  transcript: TranscriptItem[];
}

/** What a run needs of its encounter (the hub provides it). */
export interface RunnerHost {
  /** The encounter's current view; null once it is closed or gone. */
  view(): AgentView | null;
  library(): Library;
  /** Apply the model's action as the runner: the attempt and the view right after it. Null: the encounter is closed. */
  apply(action: ActionInput): { attempt: AttemptRecord; view: AgentView } | null;
  /** What others did between two views the model was shown. */
  meanwhile(before: AgentView, after: AgentView): unknown[];
  /** Something about the run changed: its state, or a new line of transcript. */
  changed(item: TranscriptItem | null): void;
}

export interface RunnerSetup extends RunnerOptions {
  skills: readonly Skill[];
  /** The scenario's reference trajectory (the `reference` player only). */
  solution?: readonly ActionRequestInput[];
  /** A provider to use instead (tests). */
  providerOverride?: LLMProvider;
  now?: () => Date;
}

const TERMINAL: readonly RunnerState[] = ["finished", "stopped", "failed"];
const MAX_TRANSCRIPT = 300;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fieldsOf = (action: ActionInput): { tool: string; input: Record<string, unknown> } => {
  const { type, ...input } = action as Record<string, unknown>;
  return { tool: String(type), input };
};

export class AgentRun {
  readonly provider: RunnerProvider;
  readonly label: string;
  readonly supervised: boolean;
  private state: RunnerState = "thinking";
  private note: string | null = null;
  private actions = 0;
  private readonly transcript: TranscriptItem[] = [];
  private seq = 0;
  private pending: (RunnerSnapshot["pending"] & { resolve?: (reason: string | null) => void }) | null = null;
  private paused = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly abort = new AbortController();
  private readonly agent: LlmAgent;
  /** The model's own last attempt: the `last` of the view it is shown (an operator's acts reach it as `meanwhile`). */
  private ownLast: AgentView["last"] = null;
  private readonly maxActions: number;
  private readonly now: () => Date;
  /** Settles when the run has ended. */
  readonly done: Promise<void>;

  constructor(
    private readonly host: RunnerHost,
    setup: RunnerSetup,
  ) {
    this.provider = setup.provider;
    this.supervised = setup.supervised === true;
    this.maxActions = setup.maxActions ?? 400;
    this.now = setup.now ?? (() => new Date());
    const inner = setup.providerOverride ?? (setup.provider === "claude" ? anthropicProvider({ ...(setup.model ? { model: setup.model } : {}), ...(setup.effort ? { effort: setup.effort } : {}) }) : oracleProvider(setup.solution ?? [], { batch: 1 }));
    this.label = setup.provider === "claude" ? `claude (${inner.label})` : "reference trajectory (offline, not a model)";
    const pace = setup.provider === "reference" ? (setup.pace ?? 600) : 0;
    const stopped = (): ProviderError => ({ ok: false, kind: "aborted", message: "The run was stopped.", retryable: false });
    const provider: LLMProvider = {
      id: inner.id,
      model: inner.model,
      label: inner.label,
      complete: async (request) => {
        if (this.stopped) return stopped();
        if (pace > 0) await this.sleep(pace);
        if (this.stopped) return stopped();
        return inner.complete(request, this.abort.signal);
      },
    };
    this.agent = llmAgent({
      provider,
      skills: setup.skills,
      onEvent: (e) => this.heard(e),
      approve: (action) => this.approval(action),
      meanwhile: (before, after) => this.host.meanwhile(before, after),
    });
    this.done = this.run();
  }

  snapshot(): RunnerSnapshot {
    const pending = this.pending ? { tool: this.pending.tool, input: this.pending.input, why: this.pending.why } : null;
    return {
      state: this.state,
      provider: this.provider,
      label: this.label,
      supervised: this.supervised,
      actions: this.actions,
      note: this.note,
      pending,
      usage: this.agent.usage(),
      transcript: this.transcript.slice(-MAX_TRANSCRIPT),
    };
  }

  get active(): boolean {
    return !TERMINAL.includes(this.state);
  }

  /** Hold the model's next action until `resume` (a model call already under way finishes first). */
  pause(): boolean {
    if (!this.active || this.paused) return false;
    this.paused = true;
    if (this.state !== "awaiting-approval") this.setState("paused");
    this.item("status", "paused by the operator");
    return true;
  }

  resume(): boolean {
    if (!this.active || !this.paused) return false;
    this.paused = false;
    this.item("status", "resumed");
    this.setState(this.pending?.why === "approval" ? "awaiting-approval" : "thinking");
    this.wake?.();
    return true;
  }

  /** End the run: a model call under way is cancelled, an action waiting is dropped. */
  stop(note = "stopped by the operator"): boolean {
    if (!this.active) return false;
    this.stopped = true;
    const pending = this.pending;
    // stopped at once, for the answer and every browser: the loop unwinds after, and acts no more
    this.end("stopped", note);
    this.abort.abort();
    pending?.resolve?.("The run was stopped.");
    this.wake?.();
    return true;
  }

  /** The operator's answer to the action waiting for approval. */
  decide(approve: boolean, reason?: string): boolean {
    const p = this.pending;
    if (!p || p.why !== "approval" || !p.resolve) return false;
    this.pending = null;
    const why = reason?.trim() ? clip(reason.trim(), 500) : "";
    this.item("approval", approve ? `approved: ${p.tool}` : `not approved: ${p.tool}${why ? ` — ${why}` : ""}`, { tool: p.tool, approve });
    this.setState(this.paused ? "paused" : "thinking");
    p.resolve(approve ? null : `The operator did not approve it${why ? `: ${why}` : ""}.`);
    return true;
  }

  private async run(): Promise<void> {
    try {
      const first = this.host.view();
      if (!first) return this.end("finished", "the encounter is closed");
      await this.agent.init?.({ actorId: first.you.id, library: this.host.library() });
      this.item("status", `started: ${this.label}${this.supervised ? ", each action waiting for approval" : ""}`);
      while (!this.stopped) {
        await this.gate();
        if (this.stopped) break;
        if (this.actions >= this.maxActions) return this.end("stopped", `the budget of ${this.maxActions} actions is spent`);
        const now = this.host.view();
        if (!now || now.finished) return this.end("finished", now?.finished ? "the encounter is finished" : "the encounter is closed");
        const turn = await this.agent.next(this.ownLast ? { ...now, last: this.ownLast } : now);
        if (this.stopped) break;
        if ("done" in turn) {
          const after = this.host.view();
          return this.end(!after || after.finished ? "finished" : "stopped", turn.note ?? (after?.finished ? "the encounter is finished" : "the model stopped"));
        }
        if (this.paused) {
          this.pending = { ...fieldsOf(turn.action), why: "paused" };
          this.host.changed(null);
          await this.gate();
          if (this.stopped) break;
        }
        this.pending = null;
        const applied = this.host.apply(turn.action);
        if (!applied) return this.end("finished", "the encounter is closed");
        this.actions++;
        this.ownLast = applied.view.last;
        const { tool, input } = fieldsOf(turn.action);
        const message = applied.attempt.message || applied.attempt.executed?.detail || "";
        this.item("action", `${tool} → ${applied.attempt.status}${message ? `: ${clip(message, 240)}` : ""}`, { tool, input, status: applied.attempt.status });
        if (!this.paused && this.state !== "thinking") this.setState("thinking");
      }
      this.end("stopped", this.note ?? "stopped by the operator");
    } catch (e) {
      this.end("failed", e instanceof Error ? e.message : String(e));
    }
  }

  private async gate(): Promise<void> {
    while (this.paused && !this.stopped) await new Promise<void>((resolve) => (this.wake = resolve));
    this.wake = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }

  private approval(action: ActionInput): Promise<string | null> {
    if (this.stopped) return Promise.resolve("The run was stopped.");
    if (!this.supervised) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending = { ...fieldsOf(action), why: "approval", resolve };
      this.setState("awaiting-approval");
    });
  }

  private heard(e: LlmEvent): void {
    if (e.type === "model") this.item("model", e.text ? clip(e.text.trim(), 1500) : e.calls.length ? `(${e.calls.map((c) => c.name).join(", ")})` : "(no text)", { calls: e.calls.map((c) => ({ name: c.name, input: c.input })), model: e.model });
    else if (e.type === "read") this.item("read", `${e.name}${e.ok ? "" : " (nothing found)"}`);
    else if (e.type === "skipped") this.item("skipped", `${e.name} not carried out: ${clip(e.reason, 300)}`);
    else this.item("invalid", `${e.name} not valid: ${clip(e.error, 300)}`);
  }

  private item(kind: TranscriptItem["kind"], text: string, detail?: unknown): void {
    const item: TranscriptItem = { seq: ++this.seq, at: this.now().toISOString(), kind, text, ...(detail !== undefined ? { detail } : {}) };
    this.transcript.push(item);
    if (this.transcript.length > MAX_TRANSCRIPT * 2) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    this.host.changed(item);
  }

  private setState(state: RunnerState): void {
    if (this.state === state || TERMINAL.includes(this.state)) return;
    this.state = state;
    this.host.changed(null);
  }

  private end(state: RunnerState, note: string): void {
    if (TERMINAL.includes(this.state)) return;
    this.pending = null;
    this.note = note;
    this.state = state;
    this.item("status", `${state}: ${note}`);
  }
}
