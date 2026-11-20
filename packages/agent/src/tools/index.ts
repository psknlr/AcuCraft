import { actionTools } from "./actions.js";
import { constructPointTool, lookupTool, readSkillTool, viewTool } from "./reference.js";
import type { ToolDefinition } from "./types.js";

export * from "./types.js";
export * from "./schema.js";
export * from "./actions.js";
export * from "./reference.js";

export interface ToolsetOptions {
  /** `construct_point` (the arithmetic of localisation on the practitioner's own observations); default on. */
  locate?: boolean;
  /** `read_skill`; on when there are skills to read. */
  skills?: boolean;
}

/**
 * The tools of a practitioner whose role may take the actions `may` (`view.you.may`): the read-only tools first, then
 * one tool for each permitted action. The set is fixed for the encounter — a model's tools never change mid-session.
 */
export function toolsFor(may: readonly string[], options: ToolsetOptions = {}): ToolDefinition[] {
  return [lookupTool, viewTool, ...(options.locate === false ? [] : [constructPointTool]), ...(options.skills ? [readSkillTool] : []), ...actionTools(may)];
}
