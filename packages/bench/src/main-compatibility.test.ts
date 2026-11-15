import { describe, expect, it } from "vitest";
import {
  createEncounter, hasClinicalNeedleMotion, needleMotion, now, observeAs, step, walkPlan,
  type ActionInput, type EncounterState,
} from "@acucraft/core";
import { loadContentPack, requireScenario } from "./content.js";

const scenario = requireScenario(loadContentPack(), "sg-knee-oa/base");

function beforeAdjustment(): EncounterState {
  let state = createEncounter(scenario, { seed: 1 });
  for (const request of scenario.field.solution) {
    if (request.action.type === "adjust_needle") return state;
    const result = step(scenario, state, request, { strict: true });
    if (!["executed", "partial"].includes(result.attempt.status)) throw new Error(result.attempt.message);
    state = result.state;
  }
  throw new Error("Reference has no adjustment");
}

function act(state: EncounterState, action: ActionInput, actor = "practitioner") {
  return step(scenario, state, { requestId: `compat-${state.attempts.length}`, actor, patient: "patient", action }, { strict: true });
}

describe("character control and technique studio compatibility", () => {
  it("plans a selected patient's walk and publishes both multi-character and legacy walk views without sharing state", () => {
    const state = createEncounter(scenario, { seed: 1 });
    const plan = walkPlan(scenario, state, "patient", { room: "reception" });
    expect(plan.ok).toBe(true);
    const moved = act(state, { type: "move", to: "reception" }, "patient");
    expect(moved.attempt.status).toBe("executed");
    if (!plan.ok) throw new Error(plan.message);
    expect(moved.state.patient.at).toEqual(plan.to);
    const patient = observeAs(scenario, moved.state, "patient");
    expect(patient.you.may).toEqual(["move", "say", "wait"]);
    expect(patient.space.you.yaw).toBe(plan.to.yaw);
    expect(patient.space.rooms.length).toBeGreaterThan(0);
    expect(patient.space.walks.at(-1)?.actor).toBe("patient");
    expect(patient.space.lastWalk).toMatchObject({ attempt: moved.attempt.index, to: { x: plan.to.x, z: plan.to.z } });
    expect(observeAs(scenario, moved.state, "practitioner").space.lastWalk).toBeNull();
    const before = structuredClone(moved.state.walks);
    patient.space.walks[0]!.from.x += 100;
    patient.space.walks[0]!.to.z += 100;
    patient.space.lastWalk!.path[0]!.x += 100;
    expect(moved.state.walks).toEqual(before);
    expect(act(moved.state, { type: "perform_technique", technique: "chuai", region: "knee-leg", side: "right", at: { u: 0.5, v: 0.5 } }, "patient").attempt.code).toBe("not-authorised");
  });

  it("retains recorded clinical motion when the same needle receives an illustrative catalogue performance", () => {
    const state = beforeAdjustment();
    const rotated = act(state, { type: "adjust_needle", needleId: "pack-a.1", technique: "rotate", rotationDeg: 35,
      rotationDirection: "counterclockwise", frequencyHz: 0.5, durationSeconds: 6 });
    expect(rotated.attempt.status).toBe("executed");
    expect(now(rotated.state) - now(state)).toBeCloseTo(0.1);
    const needle = rotated.state.needles["pack-a.1"]!;
    expect(needle.events.at(-1)?.motion).toMatchObject({ technique: "rotate", rotationDeg: 35, frequencyHz: 0.5, durationSeconds: 6 });
    const performed = act(rotated.state, { type: "perform_technique", technique: "nian", needleId: needle.id,
      motion: { support: "none", durationMs: 3200, rotationDeg: 70, hand: "right" } });
    expect(performed.attempt.status).toBe("executed");
    expect(performed.state.needles[needle.id]).toEqual(needle);
    expect(now(performed.state)).toBe(now(rotated.state));
    const view = observeAs(scenario, performed.state, "practitioner");
    expect(view.needling.find((n) => n.needle === needle.id)!.geometry.depthCm).toBe(needle.insertion!.depthCm);
    expect(view.performances!.at(-1)).toMatchObject({ technique: "nian", motion: { rotationDeg: 70, hand: "right" }, provenance: { forces: "not-modelled" } });
  });

  it("separates legacy presentation parameters from explicit clinical parameters without changing legacy event or clock output", () => {
    const state = beforeAdjustment();
    const legacy = act(state, { type: "adjust_needle", needleId: "pack-a.1", technique: "twist",
      motion: { cycles: 8, durationMs: 8000, strokeMm: 0, rotationDeg: 180 } });
    expect(legacy.attempt.status).toBe("executed");
    const request = legacy.attempt.request.action;
    if (request.type !== "adjust_needle") throw new Error("Expected adjustment");
    expect(hasClinicalNeedleMotion(request)).toBe(false);
    expect(needleMotion(request, 1).technique).toBe("rotate");
    expect(legacy.state.needles["pack-a.1"]!.events.at(-1)).not.toHaveProperty("motion");
    expect(now(legacy.state) - now(state)).toBeCloseTo(0.5);
    expect(legacy.attempt.executed!.detail).toMatch(/ cm \(twist\)$/);
    const clinical = act(state, { type: "adjust_needle", needleId: "pack-a.1", technique: "lift-thrust",
      strokeMm: 2, frequencyHz: 0.75, durationSeconds: 4, motion: { strokeMm: 0, durationMs: 8000 } });
    expect(clinical.attempt.status).toBe("executed");
    const accepted = clinical.attempt.request.action;
    if (accepted.type !== "adjust_needle") throw new Error("Expected adjustment");
    expect(hasClinicalNeedleMotion(accepted)).toBe(true);
    expect(clinical.state.needles["pack-a.1"]!.events.at(-1)?.motion).toMatchObject({ strokeMm: 2, frequencyHz: 0.75, durationSeconds: 4 });
    expect(now(clinical.state) - now(state)).toBeCloseTo(4 / 60);
  });
});
