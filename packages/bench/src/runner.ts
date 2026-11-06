import {
  ACUCRAFT_VERSION,
  createEncounter,
  digest,
  observeAs,
  referenceLibrary,
  step,
  LOG_SCHEMA_ID,
  type ActionRequest,
  type EncounterLog,
  type EncounterState,
  type Mode,
  type Scenario,
} from "@acucraft/core";
import { readFileSync } from "node:fs";
import { evaluateEncounter, type EncounterReport } from "./evaluate.js";
import type { Agent } from "./agents/types.js";

export const CLINICALCRAFT_REV = (() => {
  try {
    return readFileSync(new URL("../../../tools/clinicalcraft.rev", import.meta.url), "utf8").trim().slice(0, 40);
  } catch {
    return "unknown";
  }
})();

export interface RunOptions {
  seed?: number;
  mode?: Mode;
  /** Most actions the agent may take (the step budget). */
  maxSteps?: number;
  /** Check the needle invariants after every step (default true). */
  strict?: boolean;
  onStep?: (info: { index: number; request: ActionRequest; status: string; message: string }) => void;
}

export interface EpisodeResult {
  scenario: string;
  agent: string;
  seed: number;
  stopReason: "finished" | "agent-done" | "max-steps" | "error";
  error?: string;
  steps: number;
  state: EncounterState;
  log: EncounterLog;
  report: EncounterReport;
}

/**
 * Run one encounter: the agent sees its own view, acts, and the engine is the only authority. The evaluator runs after
 * the episode, on the record, independently of the agent.
 */
export async function runEpisode(sc: Scenario, agent: Agent, opts: RunOptions = {}): Promise<EpisodeResult> {
  const seed = opts.seed ?? 1;
  const mode = opts.mode ?? "assessment";
  const maxSteps = opts.maxSteps ?? 250;
  const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
  let s = createEncounter(sc, { seed, mode });
  const requests: ActionRequest[] = [];
  let stopReason: EpisodeResult["stopReason"] = "max-steps";
  let error: string | undefined;
  await agent.init?.({ actorId: actor, library: referenceLibrary(sc) });
  let i = 0;
  try {
    for (; i < maxSteps; i++) {
      const view = observeAs(sc, s, actor);
      const turn = await agent.next(view);
      if ("done" in turn) {
        stopReason = "agent-done";
        break;
      }
      const req = { requestId: `${actor}-${String(i + 1).padStart(4, "0")}`, actor, patient: sc.field.patient.id, action: turn.action, expectedVersion: view.version };
      const res = step(sc, s, req, { strict: opts.strict !== false });
      s = res.state;
      requests.push(res.attempt.request);
      opts.onStep?.({ index: i, request: res.attempt.request, status: res.attempt.status, message: res.attempt.message || res.attempt.executed?.detail || "" });
      if (s.finished) {
        stopReason = "finished";
        i++;
        break;
      }
    }
  } catch (e) {
    stopReason = "error";
    error = (e as Error).message;
  }
  const log: EncounterLog = {
    schema: LOG_SCHEMA_ID,
    scenarioId: sc.id,
    scenarioVersion: sc.family.version,
    engine: { acucraft: ACUCRAFT_VERSION, clinicalcraft: CLINICALCRAFT_REV },
    seed,
    mode,
    requests,
    finalDigest: digest(s),
    meta: { agent: agent.name, stopReason, ...(agent.transcript ? { transcript: agent.transcript() } : {}) },
  };
  return { scenario: sc.id, agent: agent.name, seed, stopReason, ...(error ? { error } : {}), steps: i, state: s, log, report: evaluateEncounter(sc, s) };
}
