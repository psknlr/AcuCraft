import { llmAgent, type LlmAgent, type LlmAgentOptions } from "./llm.js";
import { anthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic.js";

/**
 * Claude as the practitioner: the agent loop (`llm.ts`) over the Messages API (`providers/anthropic.ts`). Defaults:
 * `claude-opus-5-5` at effort `high`, server-side refusal fallback on, server-side compaction of a very long
 * conversation. Credentials come from the environment (`ANTHROPIC_API_KEY`, or an `ant auth login` profile).
 */
export type ClaudeAgentOptions = AnthropicProviderOptions & Omit<LlmAgentOptions, "provider">;

export function claudeAgent(options: ClaudeAgentOptions = {}): LlmAgent {
  const { skills, locate, maxCallsPerTurn, maxModelCalls, approve, onEvent, ...provider } = options;
  return llmAgent({ provider: anthropicProvider(provider), skills, locate, maxCallsPerTurn, maxModelCalls, approve, onEvent });
}
