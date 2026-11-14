import type { ActionInput, AgentView, referenceLibrary } from "@acucraft/core";
import type { Skill } from "../skills.js";
import type { ObjectSchema } from "./schema.js";

/** The public reference library a practitioner may consult (identical for every variant of a family). */
export type Library = ReturnType<typeof referenceLibrary>;

/** What a read-only tool may read: what the practitioner could know — never the scenario or the engine state. */
export interface ToolContext {
  library: Library;
  /** The practitioner's current view. */
  view: AgentView;
  skills: readonly Skill[];
}

interface ToolBase {
  name: string;
  /** What the tool does and when to call it. */
  description: string;
  inputSchema: ObjectSchema;
}

/**
 * One engine action. Calling it is the only way to change anything: the harness validates the input against the
 * engine's own schema and submits it as a request; the result is what the engine did with it.
 */
export interface ActionTool extends ToolBase {
  kind: "act";
  /** The action the input stands for, or why it is not one (nothing is sent to the engine then). */
  toAction(input: unknown): { ok: true; action: ActionInput } | { ok: false; error: string };
}

/** Reads something the practitioner may know. Takes no simulated time and changes nothing. */
export interface ReadTool extends ToolBase {
  kind: "read";
  run(input: unknown, ctx: ToolContext): { ok: boolean; output: unknown };
}

export type ToolDefinition = ActionTool | ReadTool;
