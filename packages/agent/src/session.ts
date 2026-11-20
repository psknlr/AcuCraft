import { ACUCRAFT_VERSION, createEncounter, digest, LOG_SCHEMA_ID, observeAs, referenceLibrary, step, type ActionInput, type ActionRequest, type AgentView, type AttemptRecord, type EncounterLog, type EncounterState, type Mode, type Scenario, type TechniqueModel } from "@acucraft/core";
import { outcomeOf } from "./render.js";

/**
 * One encounter with one practitioner in it: the engine's state, the requests made so far and the view of whoever
 * is under test. Everything that drives an encounter from outside — the benchmark runner, the MCP server, a person
 * at the command line — goes through `act`, so there is one way a request gets its id and its version, and one log.
 */

export interface SessionOptions {
  seed?: number;
  mode?: Mode;
  /** Check the needle invariants after every step (default true). */
  strict?: boolean;
  /** The cast member acting (default: the one under test). */
  actor?: string;
  /**
   * The catalogue of techniques the encounter runs on (default: illustrative, the engine's own default). The places
   * that start encounters for people and models — the workspace, the MCP server, the benchmark — ask for operative.
   */
  techniques?: TechniqueModel;
}

export interface ActOutcome {
  /** The attempt the request produced (the practitioner's own; NPC attempts it set off are in the state). */
  attempt: AttemptRecord;
  /** The practitioner's view after it. */
  view: AgentView;
  /** The outcome as a practitioner is told it: what the engine did, and what changed in their view. */
  result: Record<string, unknown>;
}

export class EncounterSession {
  readonly scenario: Scenario;
  readonly actor: string;
  readonly seed: number;
  readonly mode: Mode;
  readonly techniques: TechniqueModel;
  private readonly strict: boolean;
  private current: EncounterState;
  private readonly made: ActionRequest[] = [];

  constructor(scenario: Scenario, options: SessionOptions = {}) {
    this.scenario = scenario;
    this.seed = options.seed ?? 1;
    this.mode = options.mode ?? "assessment";
    this.strict = options.strict !== false;
    this.actor = options.actor ?? scenario.field.cast.find((m) => m.agent === "under-test")!.id;
    this.techniques = options.techniques ?? "illustrative";
    this.current = createEncounter(scenario, { seed: this.seed, mode: this.mode, techniques: this.techniques });
  }

  /**
   * A session brought back from its log: the recorded requests stepped again, exactly as they were made (their ids
   * and versions), so the state is the one the log was written from. The engine is deterministic: a log whose
   * digest the replay does not reproduce was written by another engine or content, and is refused.
   */
  static fromLog(scenario: Scenario, log: EncounterLog, options: Omit<SessionOptions, "seed" | "mode" | "techniques"> = {}): EncounterSession {
    if (log.scenarioId !== scenario.id) throw new Error(`the log is of ${log.scenarioId}, not ${scenario.id}`);
    // a log says which catalogue it ran on; one that does not was made on the illustrative one
    const session = new EncounterSession(scenario, { ...options, seed: log.seed, mode: log.mode, techniques: log.techniques ?? "illustrative" });
    for (const request of log.requests) {
      const stepped = step(scenario, session.current, request, { strict: session.strict });
      session.current = stepped.state;
      session.made.push(stepped.attempt.request);
    }
    if (log.finalDigest !== undefined && log.finalDigest !== digest(session.current)) {
      throw new Error(`replaying the log of ${log.scenarioId} does not reproduce its recorded state (another engine or content wrote it)`);
    }
    return session;
  }

  get state(): EncounterState {
    return this.current;
  }

  get finished(): boolean {
    return this.current.finished;
  }

  /** The requests made so far, as the engine recorded them. */
  get requests(): readonly ActionRequest[] {
    return this.made;
  }

  view(actor = this.actor): AgentView {
    return observeAs(this.scenario, this.current, actor);
  }

  library(): ReturnType<typeof referenceLibrary> {
    return referenceLibrary(this.scenario);
  }

  /** One action, decided on the current state. The engine decides what becomes of it. */
  act(action: ActionInput, actor = this.actor): ActOutcome {
    const before = this.view(actor);
    const request = { requestId: `${actor}-${String(this.made.length + 1).padStart(4, "0")}`, actor, patient: this.scenario.field.patient.id, action, expectedVersion: before.version };
    const stepped = step(this.scenario, this.current, request, { strict: this.strict });
    this.current = stepped.state;
    this.made.push(stepped.attempt.request);
    const view = this.view(actor);
    return { attempt: stepped.attempt, view, result: outcomeOf(before, view).result };
  }

  /** The replayable log of the encounter so far (`clinicalcraft`: the engine revision it ran on). */
  log(engine: { clinicalcraft: string }, meta: Record<string, unknown> = {}): EncounterLog {
    return {
      schema: LOG_SCHEMA_ID,
      scenarioId: this.scenario.id,
      scenarioVersion: this.scenario.family.version,
      engine: { acucraft: ACUCRAFT_VERSION, clinicalcraft: engine.clinicalcraft },
      seed: this.seed,
      mode: this.mode,
      ...(this.techniques === "operative" ? { techniques: "operative" as const } : {}),
      requests: [...this.made],
      finalDigest: digest(this.current),
      meta,
    };
  }
}
