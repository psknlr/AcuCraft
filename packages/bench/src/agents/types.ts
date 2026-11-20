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
  /**
   * The turn the agent last returned was not carried out (a supervising operator declined it): the agent may offer
   * it again or think again. Without this an agent takes its turn as taken.
   */
  declined?(): void;
  /**
   * The agent replays a scenario's hidden solution. It reads the answer: never a fair agent, and never to be put in
   * front of someone who is being assessed.
   */
  readonly oracle?: boolean;
}

export type AgentFactory = (scenarioId: string) => Agent;
