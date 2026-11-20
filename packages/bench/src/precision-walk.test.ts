import { describe, expect, it } from "vitest";
import {
  ARM_REACH_M, ActionSchema, clinicWorld, createEncounter, distanceToArea, freeSpot, siteOf, step, walkPlan, walkTarget,
  type ActionInput, type EncounterState,
} from "@acucraft/core";
import { actionTool } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "./content.js";

const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
const world = clinicWorld(scenario);

function beforeInsertion(): EncounterState {
  let state = createEncounter(scenario, { seed: 1 });
  for (const request of scenario.field.solution) {
    if (request.action.type === "insert_needle") return state;
    const result = step(scenario, state, request, { strict: true });
    if (!["executed", "partial"].includes(result.attempt.status)) throw new Error(result.attempt.message);
    state = result.state;
  }
  throw new Error("Reference contains no insertion");
}

function move(state: EncounterState, to: Extract<ActionInput, { type: "move" }>["to"], withPatient = false) {
  return step(scenario, state, { requestId: `precision-${state.attempts.length}`, actor: "practitioner", patient: "patient", action: { type: "move", to, withPatient } }, { strict: true });
}

describe("explicit precision approach walks", () => {
  it("shares finite bounded approach distances with model tools, only for region-side targets", () => {
    const target = { region: "lumbar", side: "left" as const };
    for (const within of [0.3, 0.75, 0.85]) {
      expect(ActionSchema.safeParse({ type: "move", to: { ...target, within } }).success).toBe(true);
      expect(actionTool("move").toAction({ to: { ...target, within } }).ok).toBe(true);
    }
    for (const within of [NaN, Infinity, -Infinity, 0.299, 0.851, "0.75"]) {
      expect(ActionSchema.safeParse({ type: "move", to: { ...target, within } }).success).toBe(false);
      expect(actionTool("move").toAction({ to: { ...target, within } }).ok).toBe(false);
    }
    expect(ActionSchema.safeParse({ type: "move", to: { person: "patient", within: 0.75 } }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "move", to: { x: 1, z: 2, within: 0.75 } }).success).toBe(false);
  });

  it("keeps omitted distance on the original 0.85 m contract and preserves legacy paths", () => {
    const state = beforeInsertion();
    const target = { region: "lumbar", side: "left" as const };
    const legacy = walkTarget(scenario, state, target);
    expect(legacy).toMatchObject({ ok: true, target: { kind: "near", within: ARM_REACH_M } });
    expect(walkTarget(scenario, state, { ...target, within: 0.85 })).toEqual(legacy);
    const ordinary = move(state, target);
    const explicit = move(state, { ...target, within: 0.85 });
    expect(ordinary.attempt.status).toBe("executed");
    expect(explicit.state.actors.practitioner).toEqual(ordinary.state.actors.practitioner);
    expect(explicit.state.walks).toEqual(ordinary.state.walks);
    expect(ordinary.attempt.request.action).not.toHaveProperty("to.within");
  });

  it("executes the requested closer stance through a real collision-planned walk", () => {
    const state = beforeInsertion();
    const target = { region: "lumbar", side: "left" as const, within: 0.75 };
    const site = siteOf(scenario, state, target.region, target.side);
    const before = state.actors.practitioner!.at;
    const originalDistance = distanceToArea(before.x, before.z, site.area);
    expect(originalDistance).toBeGreaterThan(target.within);
    const planned = walkPlan(scenario, state, "practitioner", target);
    expect(planned.ok).toBe(true);
    const result = move(state, target);
    expect(result.attempt.status).toBe("executed");
    const after = result.state.actors.practitioner!.at;
    expect(distanceToArea(after.x, after.z, site.area)).toBeLessThanOrEqual(target.within + 1e-6);
    expect(distanceToArea(after.x, after.z, site.area)).toBeLessThan(originalDistance);
    expect(freeSpot(world, after)).toBe(true);
    expect(result.state.walks.at(-1)).toMatchObject({ actor: "practitioner", withPatient: false, to: { x: after.x, z: after.z } });
    expect(result.state.walks.at(-1)!.metres).toBeGreaterThan(0);
    expect(result.state.patient).toEqual(state.patient);
    expect(result.state.clinical.clock).toBeGreaterThan(state.clinical.clock);
  });

  it("refuses a no-spot request without changing the actor, patient, walks or clinical clock", () => {
    const state = beforeInsertion();
    const target = { region: "lumbar", side: "left" as const, within: 0.35 };
    expect(walkPlan(scenario, state, "practitioner", target)).toMatchObject({ ok: false, code: "no-spot" });
    const refused = move(state, target);
    // The action's existing interface maps planner no-spot/no-route to no-route with the detailed reason.
    expect(refused.attempt).toMatchObject({ status: "rejected", code: "no-route" });
    expect(refused.attempt.message).toContain("nowhere to stand within 0.35 m");
    expect(refused.state.actors).toEqual(state.actors);
    expect(refused.state.patient).toEqual(state.patient);
    expect(refused.state.walks).toEqual(state.walks);
    expect(refused.state.clinical.clock).toBe(state.clinical.clock);
  });

  it("retains the existing patient-pose and escort destination checks", () => {
    const state = beforeInsertion();
    expect(state.patient.position).toBe("prone");
    const inaccessible = move(state, { region: "abdomen", side: "midline", within: 0.75 });
    expect(inaccessible.attempt).toMatchObject({ status: "rejected", code: "not-accessible" });
    expect(inaccessible.state.actors).toEqual(state.actors);
    const escort = move(state, { region: "lumbar", side: "left", within: 0.75 }, true);
    expect(escort.attempt).toMatchObject({ status: "rejected", code: "invalid" });
    expect(escort.state.patient).toEqual(state.patient);
  });
});
