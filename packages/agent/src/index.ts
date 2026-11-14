/**
 * @acucraft/agent — who plays the practitioner, and how.
 *
 *  - the `Agent` interface the runner drives, and the two instruments that need no model: the reference oracle and
 *    the rule-based protocol baseline;
 *  - the runtime of a language-model practitioner: typed tools generated from the engine's action schemas, the
 *    read-only tools, the standing instructions, the skills, model providers and the loop.
 *
 * Isomorphic except `@acucraft/agent/node` (reads the skills from disk). See docs/AGENT.md.
 */
export * from "./types.js";
export * from "./reference.js";
export * from "./protocol.js";
export * from "./localise.js";
export * from "./catalogue.js";
export * from "./skills.js";
export * from "./prompt.js";
export * from "./render.js";
export * from "./tools/index.js";
export * from "./providers/types.js";
export * from "./providers/anthropic.js";
export * from "./providers/scripted.js";
export * from "./llm.js";
export * from "./session.js";
export * from "./claude.js";
