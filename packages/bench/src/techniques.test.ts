import { describe, expect, it } from "vitest";
import {
  ActionSchema, NEEDLE_TECHNIQUES, createEncounter, resolveNeedleMotion, step, techniqueMotion,
  type ActionInput, type EncounterState, type NeedleTechnique,
} from "@acucraft/core";
import { actionTool } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "./content.js";

const scenario = requireScenario(loadContentPack(), "sg-knee-oa/base");

function beforeManipulation(): EncounterState {
  let state = createEncounter(scenario, { seed: 1 });
  for (const request of scenario.field.solution) {
    if (request.action.type === "adjust_needle") return state;
    const result = step(scenario, state, request, { strict: true });
    if (!["executed", "partial"].includes(result.attempt.status)) throw new Error(result.attempt.message);
    state = result.state;
  }
  throw new Error("Reference has no manipulation");
}

function adjust(state: EncounterState, technique: NeedleTechnique, extra: Partial<Extract<ActionInput, { type: "adjust_needle" }>> = {}) {
  return step(scenario, state, {
    requestId: `technique-${technique}`, actor: "practitioner", patient: "patient",
    action: { type: "adjust_needle", needleId: "pack-a.1", technique, ...extra },
  }, { strict: true });
}

describe("explicit needle techniques", () => {
  it("keeps aliases on the same guarded needle and evidence path without a bu/xie efficacy bonus", () => {
    const state = beforeManipulation();
    const axial = adjust(state, "lift-thrust");
    const rotation = adjust(state, "rotate");
    for (const technique of NEEDLE_TECHNIQUES.filter((t) => t !== "none")) {
      const result = adjust(state, technique);
      expect(result.attempt.status, technique).toBe("executed");
      expect(result.state.needles["pack-a.1"]!.response).toEqual((technique === "rotate" || technique === "twist" ? rotation : axial).state.needles["pack-a.1"]!.response);
      expect(result.state.needles["pack-a.1"]!.location).toEqual(state.needles["pack-a.1"]!.location);
      expect(result.state.evidence.at(-1)?.kind).toBe("needle-feel");
      expect(result.state.needles["pack-a.1"]!.events.at(-1)?.detail).toContain(technique);
    }
  });

  it("checks depth and consent for every new technique, and refuses a needle outside the patient", () => {
    const state = beforeManipulation();
    for (const technique of ["lift", "thrust", "twist", "bu", "xie"] as const) {
      expect(adjust(state, technique, { needleId: "pack-a.5" }).attempt.code).toBe("not-inserted");
      const withdrawn = structuredClone(state);
      withdrawn.patient.consent.status = "withdrawn";
      const blocked = adjust(withdrawn, technique);
      expect(blocked.attempt.status, technique).toBe("blocked");
      expect(blocked.state.needles["pack-a.1"]!.response).toEqual(withdrawn.needles["pack-a.1"]!.response);
      const tooDeep = adjust(state, technique, { depthCm: 10 });
      const legacy = adjust(state, "lift-thrust", { depthCm: 10 });
      // This site stops at bone/shaft length rather than a critical structure: aliases must keep that check too.
      expect(tooDeep.attempt.status, technique).toBe(legacy.attempt.status);
      expect(tooDeep.state.needles["pack-a.1"]!.location).toEqual(legacy.state.needles["pack-a.1"]!.location);
      const location = tooDeep.state.needles["pack-a.1"]!.location;
      expect(location.kind === "patient" && location.depthCm).toBeLessThan(10);
    }
  });

  it("bounds presentation settings at the action boundary and leaves the engine response unchanged", () => {
    const state = beforeManipulation();
    const plain = adjust(state, "bu");
    const presented = adjust(state, "bu", { motion: { cycles: 8, durationMs: 8000, strokeMm: 3, rotationDeg: 180 } });
    expect(presented.state.needles["pack-a.1"]!.response).toEqual(plain.state.needles["pack-a.1"]!.response);
    expect(presented.state.needles["pack-a.1"]!.location).toEqual(plain.state.needles["pack-a.1"]!.location);
    for (const motion of [{ cycles: 9 }, { cycles: 0 }, { cycles: 1.5 }, { durationMs: 399 }, { durationMs: 8001 }, { strokeMm: -1 }, { strokeMm: 3.1 }, { rotationDeg: 181 }, { unsafeDepth: 5 }]) {
      expect(ActionSchema.safeParse({ type: "adjust_needle", needleId: "pack-a.1", technique: "bu", motion }).success).toBe(false);
    }
    const schema = actionTool("adjust_needle").inputSchema;
    expect(schema.properties.technique?.enum).toEqual([...NEEDLE_TECHNIQUES]);
    expect(schema.properties.motion?.properties?.strokeMm).toMatchObject({ minimum: 0, maximum: 3 });
  });
});

describe("presentation profiles", () => {
  it("starts and ends at rest and stays within an outward stroke for every technique and profile", () => {
    for (const technique of NEEDLE_TECHNIQUES) {
      for (const motion of [undefined, { cycles: 1, durationMs: 400, strokeMm: 3, rotationDeg: 180 }, { cycles: 8, durationMs: 8000, strokeMm: 0, rotationDeg: 0 }]) {
        const resolved = resolveNeedleMotion(technique, motion);
        const start = techniqueMotion(technique, 0, motion);
        expect(start).toMatchObject({ withdrawalMm: 0, rotationRad: 0 });
        const end = techniqueMotion(technique, resolved.durationMs, motion);
        expect(end).toMatchObject({ withdrawalMm: 0, rotationRad: 0, complete: true });
        for (let i = 0; i < 1000; i++) {
          const sample = techniqueMotion(technique, resolved.durationMs * i / 1000, motion);
          expect(sample.withdrawalMm, technique).toBeGreaterThanOrEqual(-1e-9);
          expect(sample.withdrawalMm, technique).toBeLessThanOrEqual(resolved.strokeMm + 1e-9);
          expect(Math.abs(sample.rotationRad)).toBeLessThanOrEqual(resolved.rotationDeg * Math.PI / 180 + 1e-9);
        }
      }
    }
  });

  it("separates lifting, thrusting, twisting, and the two asymmetric authored gestures", () => {
    const settings = { cycles: 1, durationMs: 1000 };
    const lift = techniqueMotion("lift", 300, settings);
    const thrust = techniqueMotion("thrust", 300, settings);
    expect(lift.withdrawalMm).toBeGreaterThan(thrust.withdrawalMm);
    expect(techniqueMotion("bu", 300, settings).withdrawalMm).toBe(thrust.withdrawalMm);
    expect(techniqueMotion("xie", 300, settings).withdrawalMm).toBe(lift.withdrawalMm);
    expect(techniqueMotion("twist", 300, settings)).toMatchObject({ withdrawalMm: 0 });
    expect(Math.abs(techniqueMotion("twist", 300, settings).rotationRad)).toBeGreaterThan(0.01);
    expect(lift.rotationRad).toBe(0);
  });

  it("is deterministic and tolerates invalid direct-render inputs without non-finite positions", () => {
    expect(techniqueMotion("bu", 732)).toEqual(techniqueMotion("bu", 732));
    for (const elapsed of [NaN, -Infinity, Infinity, -1, 1]) {
      const sample = techniqueMotion("xie", elapsed, { cycles: NaN, durationMs: Infinity, strokeMm: -99, rotationDeg: Infinity });
      expect(Number.isFinite(sample.withdrawalMm)).toBe(true);
      expect(Number.isFinite(sample.rotationRad)).toBe(true);
    }
  });
});
