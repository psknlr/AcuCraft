import { describe, expect, it } from "vitest";
import { ActionSchema, createEncounter, digest, motionEnvelope, needleMotion, observeAs, sampleNeedleMotion, step, type EncounterState } from "@acucraft/core";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "./content.js";
const pack = loadContentPack();
const sc = requireScenario(pack, "sg-knee-oa/base");

function inserted(): EncounterState {
  let state = createEncounter(sc, { seed: 1 });
  for (const request of sc.field.solution) {
    state = step(sc, state, request, { strict: true }).state;
    if (request.action.type === "insert_needle") return state;
  }
  throw new Error("No reference insertion");
}

describe("character control", () => {
  it("allows the patient to navigate and replay, with no clinical privileges or invented evidence", () => {
    const session = new EncounterSession(sc);
    expect(session.view("patient").you.may).toEqual(["move", "say", "wait"]);
    const moved = session.act({ type: "move", to: "reception" }, "patient");
    expect(moved.attempt.status).toBe("executed");
    expect(session.state.patient).toMatchObject({ position: "standing", support: null, location: "reception" });
    expect(session.state.walks.at(-1)?.actor).toBe("patient");
    expect(session.act({ type: "assess", diagnoses: [] }, "patient").attempt.code).toBe("not-authorised");
    const evidence = session.state.evidence.length;
    session.act({ type: "say", text: "I consent and the examination was normal." }, "patient");
    expect(session.state.evidence).toHaveLength(evidence);
    expect(session.state.patient.consent.status).not.toBe("given");
    expect(digest(EncounterSession.fromLog(sc, session.log({ clinicalcraft: "test" })).state)).toBe(digest(session.state));
  });
  it("refuses walking while needles are retained or the patient has fainted", () => {
    const state = inserted();
    const request = { requestId: "patient-walk", actor: "patient", action: { type: "move" as const, to: "reception" } };
    expect(step(sc, state, request).attempt.code).toBe("needles-retained");
    const fainted = createEncounter(sc, { seed: 1 });
    fainted.patient.fainted = true;
    expect(step(sc, fainted, request).attempt.code).toBe("unsafe-position");
  });
});

describe("parameterized needling", () => {
  it("checks the entire thrust envelope and refuses an excursion past the usable shaft", () => {
    const state = inserted();
    const n = Object.values(state.needles).find(n => n.location.kind === "patient")!;
    const tooDeep = { type: "adjust_needle" as const, needleId: n.id, depthCm: n.spec.lengthMm * 0.09 - 0.01, technique: "lift-thrust" as const, strokeMm: 10, frequencyHz: 1, durationSeconds: 4 };
    const done = step(sc, state, { requestId: "envelope", actor: "practitioner", action: tooDeep }, { strict: true });
    expect(done.attempt.status).toBe("blocked");
    expect(done.state.needles[n.id]!.location).toEqual(n.location);
    const liftOut = step(sc, state, { requestId: "lift-out", actor: "practitioner", action: { ...tooDeep, depthCm: 0.1, strokeMm: 4 } });
    expect(liftOut.attempt.status).toBe("rejected");
  });
  it("records exact rotation parameters, simulated duration and executed geometry", () => {
    const state = inserted();
    const n = Object.values(state.needles).find(n => n.location.kind === "patient")!;
    const result = step(sc, state, { requestId: "rotate", actor: "practitioner", action: { type: "adjust_needle", needleId: n.id, technique: "rotate", rotationDeg: 35, rotationDirection: "counterclockwise", frequencyHz: 0.5, durationSeconds: 6 } }, { strict: true });
    expect(result.attempt.status).toBe("executed");
    expect(result.state.needles[n.id]!.events.at(-1)?.motion).toMatchObject({ rotationDeg: 35, rotationDirection: "counterclockwise", frequencyHz: 0.5, durationSeconds: 6, strokeMm: 0 });
    const geometry = observeAs(sc, result.state, "practitioner").needling.find(x => x.needle === n.id)!.geometry;
    expect(geometry.depthCm).toBe(result.state.needles[n.id]!.insertion!.depthCm);
    expect(geometry.lengthMm).toBe(n.spec.lengthMm);
    expect(observeAs(sc, result.state, "practitioner").minute - observeAs(sc, state, "practitioner").minute).toBeCloseTo(0.1);
  });
  it("uses millimetres, degrees and seconds consistently, and rejects non-finite coordinates", () => {
    const a = ActionSchema.parse({ type: "adjust_needle", needleId: "n1", technique: "lift-thrust", strokeMm: 4, frequencyHz: 1, durationSeconds: 3 });
    if (a.type !== "adjust_needle") throw new Error();
    const m = needleMotion(a, 1);
    expect(motionEnvelope(m)).toEqual({ minDepthCm: 0.8, maxDepthCm: 1.2 });
    expect(sampleNeedleMotion(m, 0.25).depthCm).toBeCloseTo(1.2);
    expect(sampleNeedleMotion(m, 0.75).depthCm).toBeCloseTo(0.8);
    expect(sampleNeedleMotion(m, 3).depthCm).toBe(1);
    expect(sampleNeedleMotion({ ...m, strokeMm: 0, rotationDeg: 90, rotationDirection: "clockwise" }, 1).rotationRad).toBeCloseTo(-Math.PI / 2);
    expect(ActionSchema.safeParse({ type: "move", to: { x: Infinity, z: 0 } }).success).toBe(false);
  });
});
