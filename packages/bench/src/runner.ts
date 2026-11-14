import { EncounterSession, type Agent } from "@acucraft/agent";
import type { ActionRequest, EncounterLog, EncounterState, Mode, Scenario } from "@acucraft/core";
import { readFileSync } from "node:fs";
import { evaluateEncounter, type EncounterReport } from "./evaluate.js";

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
  /** Why the agent stopped by itself before the encounter was finished, when it said. */
  note?: string;
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
  const maxSteps = opts.maxSteps ?? 250;
  const session = new EncounterSession(sc, { ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.mode ? { mode: opts.mode } : {}), strict: opts.strict !== false });
  let stopReason: EpisodeResult["stopReason"] = "max-steps";
  let error: string | undefined;
  /** Why the agent stopped by itself, when it said (a model that could not be reached, a refusal). */
  let note: string | undefined;
  await agent.init?.({ actorId: session.actor, library: session.library() });
  let i = 0;
  try {
    for (; i < maxSteps; i++) {
      const turn = await agent.next(session.view());
      if ("done" in turn) {
        stopReason = "agent-done";
        note = turn.note;
        break;
      }
      const { attempt } = session.act(turn.action);
      opts.onStep?.({ index: i, request: attempt.request, status: attempt.status, message: attempt.message || attempt.executed?.detail || "" });
      if (session.finished) {
        stopReason = "finished";
        i++;
        break;
      }
    }
  } catch (e) {
    stopReason = "error";
    error = (e as Error).message;
  }
  const log = session.log({ clinicalcraft: CLINICALCRAFT_REV }, { agent: agent.name, stopReason, ...(note ? { note } : {}), ...(agent.usage ? { usage: agent.usage() } : {}), ...(agent.transcript ? { transcript: agent.transcript() } : {}) });
  return { scenario: sc.id, agent: agent.name, seed: session.seed, stopReason, ...(error ? { error } : {}), ...(note ? { note } : {}), steps: i, state: session.state, log, report: evaluateEncounter(sc, session.state) };
}
