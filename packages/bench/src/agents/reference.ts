import type { Scenario } from "@acucraft/core";
import type { Agent, AgentTurn } from "./types.js";

/**
 * The oracle: replays the scenario's hidden reference trajectory. It is a check on the scenario (every reference
 * must reach an acceptable pathway) and an upper bound for reports — never a fair agent, since it reads the answer.
 */
export function referenceAgent(sc: Scenario): Agent {
  const steps = sc.field.solution.filter((r) => sc.field.cast.find((m) => m.id === r.actor)?.agent === "under-test");
  let i = 0;
  return {
    name: "reference (oracle)",
    next(): AgentTurn {
      const r = steps[i++];
      return r ? { action: r.action } : { done: true };
    },
  };
}
