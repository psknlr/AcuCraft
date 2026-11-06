import type { ActionInput, AgentView, referenceLibrary } from "@acucraft/core";

/** What an agent under test is given at the start: its identity and the public reference library — nothing hidden. */
export interface AgentInit {
  actorId: string;
  library: ReturnType<typeof referenceLibrary>;
}

export type AgentTurn = { action: ActionInput; note?: string } | { done: true; note?: string };

/**
 * An agent under test. It sees only the `AgentView` of its own actor (built by the engine from an allow-list of the
 * state) and acts only through actions. The runner stamps each action with the view's version (optimistic
 * concurrency) and a request id.
 */
export interface Agent {
  readonly name: string;
  init?(init: AgentInit): void | Promise<void>;
  next(view: AgentView): AgentTurn | Promise<AgentTurn>;
  /** Recorded model outputs (LLM agents): kept in the episode log so a replay never calls the model again. */
  transcript?(): unknown[];
}

export type AgentFactory = (scenarioId: string) => Agent;
