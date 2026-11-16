import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ActionSchema, MANIPULATION_TECHNIQUES, createEncounter, digest, now, observeAs, referenceLibrary, resolveManipulationMotion, step,
  type ActionInput, type ActionRequestInput, type EncounterLog, type EncounterState,
} from "@acucraft/core";
import { EncounterSession, actionTool, lookupTool, toolsFor } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "./content.js";

const pack = loadContentPack();
const scenario = requireScenario(pack, "sg-knee-oa/base");
type PerformanceAction = Extract<ActionInput, { type: "perform_technique" }>;

function before(type: "insert_needle" | "adjust_needle"): EncounterState {
  let state = createEncounter(scenario, { seed: 1 });
  for (const request of scenario.field.solution) {
    if (request.action.type === type) return state;
    const result = step(scenario, state, request, { strict: true });
    if (!["executed", "partial"].includes(result.attempt.status)) throw new Error(result.attempt.message);
    state = result.state;
  }
  throw new Error(`No ${type} in reference`);
}

function perform(state: EncounterState, fields: Omit<PerformanceAction, "type">, actor = "practitioner") {
  return step(scenario, state, {
    requestId: `perform-${state.attempts.length}-${fields.technique}`, actor, patient: "patient",
    action: { type: "perform_technique", ...fields },
  }, { strict: true });
}

describe("authoritative technique performances", () => {
  it("publishes and enforces the actual middle-support variant for insertion and retained work", () => {
    const retained = before("adjust_needle");
    for (const wristElevationDeg of [43.9, 51.1, 55, 70]) {
      const result = perform(retained, { technique: "nian", needleId: "pack-a.1", motion: { grip: "three-finger", wristElevationDeg } });
      expect(result.attempt.code).toBe("technique-parameter");
      expect(result.state.performances).toBeUndefined();
      expect(result.state.needles).toEqual(retained.needles);
    }
    for (const wristElevationDeg of [44, 48, 51, undefined]) {
      const result = perform(retained, { technique: "nian", needleId: "pack-a.1", motion: { grip: "three-finger", wristElevationDeg } });
      expect(result.attempt.status).toBe("executed");
      const recorded = result.state.performances!.at(-1)!.motion;
      expect(resolveManipulationMotion("nian", recorded).wristElevationDeg).toBe(wristElevationDeg ?? 48);
      if (wristElevationDeg === undefined) expect(recorded).not.toHaveProperty("wristElevationDeg");
      else expect(recorded.wristElevationDeg).toBe(wristElevationDeg);
      expect(result.state.needles).toEqual(retained.needles);
    }
    expect(perform(retained, { technique: "nian", needleId: "pack-a.1", motion: { grip: "three-finger", gripStyle: "side-pinch" } }).attempt.code).toBe("technique-parameter");

    const state = before("insert_needle"), request = scenario.field.solution.find((r) => r.action.type === "insert_needle")!;
    const original = request.action;
    if (original.type !== "insert_needle") throw new Error("Missing insertion fixture");
    for (const presentation of [
      { grip: "three-finger", wristElevationDeg: 55 },
      { grip: "three-finger", gripStyle: "side-pinch" },
    ] as const) {
      const result = step(scenario, state, { ...request, action: { ...original, presentation } }, { strict: true });
      expect(result.attempt.code).toBe("presentation-parameter");
      expect(result.state.needles).toEqual(state.needles);
    }
    const baseline = step(scenario, state, request, { strict: true });
    for (const wristElevationDeg of [44, 48, 51, undefined]) {
      const result = step(scenario, state, { ...request, action: { ...original, presentation: { grip: "three-finger", wristElevationDeg } } }, { strict: true });
      expect(result.attempt.status).toBe(baseline.attempt.status);
      expect(result.state.needles).toEqual(baseline.state.needles);
    }
  });

  it("rejects unsupported nail-work wrist angles without recording a different pose or changing the needle", () => {
    const state = before("adjust_needle");
    for (const technique of ["gua", "tan"] as const) {
      for (const wristElevationDeg of [35, 49.9, 60.1, 70]) {
        const result = perform(state, { technique, needleId: "pack-a.1", motion: { wristElevationDeg } });
        expect(result.attempt.code).toBe("technique-parameter");
        expect(result.attempt.message).toContain("50 to 60");
        expect(result.state.performances).toBeUndefined();
        expect(result.state.needles).toEqual(state.needles);
      }
      for (const wristElevationDeg of [50, 55, 60]) {
        const result = perform(state, { technique, needleId: "pack-a.1", motion: { wristElevationDeg } });
        expect(result.attempt.status).toBe("executed");
        expect(result.state.performances!.at(-1)!.motion.wristElevationDeg).toBe(wristElevationDeg);
        expect(result.state.needles).toEqual(state.needles);
      }
    }
    // Ordinary holds retain their wider range.
    for (const wristElevationDeg of [35, 70]) {
      expect(perform(state, { technique: "nian", needleId: "pack-a.1", motion: { wristElevationDeg } }).attempt.status).toBe("executed");
    }
  });

  it("accepts every retained technique with canonical parameters, without changing needle geometry or clinical response", () => {
    const state = before("adjust_needle");
    for (const definition of MANIPULATION_TECHNIQUES.filter((definition) => definition.context === "retained")) {
      const result = perform(state, { technique: definition.id, needleId: "pack-a.1", motion: { cycles: 2, durationMs: 3200, hand: "left", support: "none" } });
      expect(result.attempt.status, definition.id).toBe("executed");
      expect(result.state.needles).toEqual(state.needles);
      expect(result.state.evidence).toEqual(state.evidence);
      expect(now(result.state)).toBe(now(state));
      expect(result.state.performances?.at(-1)).toMatchObject({
        technique: definition.id, context: "retained", needleId: "pack-a.1", patientPosition: state.patient.position,
        motion: { cycles: 2, durationMs: 3200, hand: "left", support: "none" },
        provenance: { kind: "illustrative", review: "unreviewed", forces: "not-modelled" },
      });
    }
  });

  it("allows consecutive skin gestures while invalidating preparation and hand sterility for a later insertion", () => {
    const state = before("insert_needle");
    expect(state).not.toHaveProperty("performances");
    const mark = Object.values(state.marks)[0]!;
    const first = perform(state, { technique: "chuai", mark: mark.id });
    expect(first.attempt.status).toBe("executed");
    expect(first.state.sitesPrepared.some((site) => site.region === mark.region && site.side === mark.side && site.touched !== null)).toBe(true);
    expect(first.state.actors.practitioner!.soiledSeq).not.toBeNull();
    const second = perform(first.state, { technique: "zhua", mark: mark.id });
    expect(second.attempt.status).toBe("executed");
    expect(second.state.performances).toHaveLength(2);
    const insert = scenario.field.solution.find((request) => request.action.type === "insert_needle")!;
    const checked = step(scenario, second.state, insert, { strict: true });
    // This scenario's governance records these breaches rather than blocking them: preserve that policy.
    expect(checked.attempt.unsafe).toContain("hand-hygiene-omitted");
    expect(checked.attempt.unsafe).toContain("site-not-prepared");
    expect(checked.state.performances).toEqual(second.state.performances);
  });

  it("requires a retained needle or an actually withdrawn current-visit needle according to context", () => {
    const state = before("adjust_needle");
    expect(perform(state, { technique: "nian", needleId: "pack-a.5" }).attempt.code).toBe("wrong-visit");
    expect(perform(state, { technique: "men", needleId: "pack-a.1" }).attempt.code).toBe("not-removed");
    const removed = step(scenario, state, { requestId: "remove-before-men", actor: "practitioner", patient: "patient", action: { type: "remove_needle", needleId: "pack-a.1" } }, { strict: true }).state;
    expect(perform(removed, { technique: "nian", needleId: "pack-a.1" }).attempt.code).toBe("not-inserted");
    const aftercare = structuredClone(removed);
    aftercare.patient.consent.status = "withdrawn";
    aftercare.stopped = { visit: 1, at: now(aftercare), by: "practitioner", reason: "patient asked to stop" };
    aftercare.patient.fainted = true;
    const result = perform(aftercare, { technique: "men", needleId: "pack-a.1" });
    expect(result.attempt.status).toBe("executed");
    expect(result.state.performances?.at(-1)?.context).toBe("removed");
    expect(result.state.needles).toEqual(aftercare.needles);
  });

  it("refuses unsafe or ambiguous targets atomically, including stopped care, withdrawn consent, roles and reach", () => {
    const state = before("adjust_needle");
    const withdrawn = structuredClone(state);
    withdrawn.patient.consent.status = "withdrawn";
    const stopped = structuredClone(state);
    stopped.stopped = { visit: 1, at: now(stopped), by: "practitioner", reason: "stop" };
    const distant = structuredClone(state);
    distant.actors.practitioner!.at = { x: 200, z: 200, yaw: 0 };
    const cases = [
      perform(withdrawn, { technique: "nian", needleId: "pack-a.1" }),
      perform(stopped, { technique: "nian", needleId: "pack-a.1" }),
      perform(state, { technique: "nian", needleId: "pack-a.1" }, "assistant"),
      perform(distant, { technique: "nian", needleId: "pack-a.1" }),
      perform(state, { technique: "nian", needleId: "pack-a.1", region: "lumbar" }),
      perform(state, { technique: "an", region: "knee-leg", side: "right", at: { u: 9999, v: 9999 } }),
    ];
    for (const result of cases) {
      expect(["blocked", "rejected"]).toContain(result.attempt.status);
      expect(result.state.performances).toBeUndefined();
    }
    expect(cases[2]!.attempt.code).toBe("not-authorised");
    expect(cases[3]!.attempt.code).toBe("not-in-reach");
    expect(cases[4]!.attempt.code).toBe("target-mismatch");
    expect(cases[5]!.attempt.code).toBe("off-chart");
  });

  it("is deterministic, idempotent and exposes only accepted public performance fields", () => {
    const state = before("adjust_needle");
    const request: ActionRequestInput = { requestId: "performance-once", actor: "practitioner", patient: "patient", action: { type: "perform_technique", technique: "shao-shan-huo", needleId: "pack-a.1", motion: { support: "none", tempoBias: 0.6 } } };
    const a = step(scenario, state, request, { strict: true });
    const b = step(scenario, state, request, { strict: true });
    expect(digest(a.state)).toBe(digest(b.state));
    const repeated = step(scenario, a.state, request, { strict: true });
    expect(repeated.duplicate).toBe(true);
    expect(repeated.state.performances).toHaveLength(1);
    const view = observeAs(scenario, a.state, "practitioner");
    expect(view.performances).toEqual(a.state.performances);
    expect(view.performances?.[0]?.requestId).toBe(request.requestId);
    expect(view.performances?.[0]?.site).not.toHaveProperty("target");
    expect(view.performances?.[0]?.site).not.toHaveProperty("findings");
    view.performances![0]!.motion.cycles = 12;
    expect(a.state.performances![0]!.motion.cycles).not.toBe(12);
  });
});

describe("historical manipulation record compatibility", () => {
  const legacyKeys = ["durationMs", "cycles", "strokeMm", "rotationDeg", "lateralMm", "tiltDeg", "tempoBias", "direction", "grip", "support", "hand", "gripApertureMm", "contactIntensity"].sort();

  it("preserves the original 13-field record for requests that omit the new hand controls", () => {
    const state = before("adjust_needle");
    for (const motion of [undefined, {}, { grip: "three-finger" as const }, { cycles: 3, wristElevationDeg: undefined }]) {
      const result = perform(state, { technique: "nian", needleId: "pack-a.1", motion });
      expect(result.attempt.status).toBe("executed");
      const recorded = result.state.performances!.at(-1)!.motion;
      expect(Object.keys(recorded).sort()).toEqual(legacyKeys);
      const resolved = resolveManipulationMotion("nian", recorded);
      expect(resolved.wristElevationDeg).toBe(motion?.grip === "three-finger" ? 48 : 55);
      expect(resolved.gripStyle).toBe("tip-pinch");
      expect(resolved.idleFingerPose).toBe("curled");
    }
  });

  it("records all resolved hand controls whenever any new control is explicitly supplied", () => {
    const state = before("adjust_needle");
    for (const motion of [
      { wristElevationDeg: 60 }, { gripStyle: "side-pinch" as const }, { idleFingerPose: "relaxed" as const },
      { grip: "three-finger" as const, gripStyle: "tip-pinch" as const },
    ]) {
      const result = perform(state, { technique: "nian", needleId: "pack-a.1", motion });
      expect(result.attempt.status).toBe("executed");
      const recorded = result.state.performances!.at(-1)!.motion;
      expect(Object.keys(recorded).sort()).toEqual([...legacyKeys, "wristElevationDeg", "gripStyle", "idleFingerPose"].sort());
      expect(recorded).toEqual(resolveManipulationMotion("nian", motion));
      expect(result.state.needles).toEqual(state.needles);
    }
  });

  it("strictly restores an actual old-engine log against its independent golden digest and still rejects tampering", () => {
    // Synthetic studio encounter saved before the three hand controls existed. Its original
    // requests and digest are a golden fixture, not regenerated from the current implementation.
    const log = JSON.parse(readFileSync(new URL("./fixtures/legacy-manipulation-log.json", import.meta.url), "utf8")) as EncounterLog;
    const oldScenario = requireScenario(pack, log.scenarioId);
    expect(log.finalDigest).toBe("11e2e21581004a");
    const restored = EncounterSession.fromLog(oldScenario, log);
    expect(digest(restored.state)).toBe("11e2e21581004a");
    expect(restored.state.performances).toHaveLength(1);
    expect(restored.state.performances![0]!.motion).toEqual({
      durationMs: 5000, cycles: 3, strokeMm: 1.5, rotationDeg: 65, lateralMm: 2, tiltDeg: 3,
      tempoBias: 0.5, direction: "alternating", grip: "two-finger", support: "stabilize", hand: "auto", gripApertureMm: 2, contactIntensity: 0.45,
    });
    expect(Object.keys(restored.state.performances![0]!.motion).sort()).toEqual(legacyKeys);
    const tampered = structuredClone(log), request = tampered.requests.find((r) => r.action.type === "perform_technique")!;
    if (request.action.type !== "perform_technique") throw new Error("Missing historical performance");
    request.action.motion = { ...request.action.motion, cycles: 4 };
    expect(() => EncounterSession.fromLog(oldScenario, tampered)).toThrow(/does not reproduce its recorded state/);

    // The historical encounter ends after withdrawal: continue it with current-visit aftercare,
    // then reopen the combined old/new records through the same strict persistence boundary.
    const originalMotion = structuredClone(restored.state.performances![0]!.motion);
    const newMotion = { wristElevationDeg: 60, gripStyle: "side-pinch", idleFingerPose: "relaxed", support: "none" } as const;
    expect(restored.act({ type: "perform_technique", technique: "men", needleId: "pack-a.1", motion: newMotion }).attempt.status).toBe("executed");
    const mixedLog = restored.log({ clinicalcraft: log.engine.clinicalcraft });
    const reopened = EncounterSession.fromLog(oldScenario, mixedLog);
    expect(digest(reopened.state)).toBe(mixedLog.finalDigest);
    expect(reopened.state.performances).toHaveLength(2);
    expect(reopened.state.performances![0]!.motion).toEqual(originalMotion);
    expect(Object.keys(reopened.state.performances![0]!.motion).sort()).toEqual(legacyKeys);
    expect(reopened.state.performances![1]!.motion).toEqual(resolveManipulationMotion("men", newMotion));
    expect(Object.keys(reopened.state.performances![1]!.motion)).toHaveLength(16);
  });
});

describe("shared model and operator manipulation contract", () => {
  it("serves a public catalogue and derives the same bounds for lookup and the action tool", () => {
    const context = { library: referenceLibrary(scenario), view: observeAs(scenario, createEncounter(scenario, { seed: 1 }), "practitioner"), skills: pack.skills };
    expect(toolsFor(context.view.you.may).map((tool) => tool.name)).toContain("perform_technique");
    const result = lookupTool.run({ topic: "techniques" }, context) as { ok: boolean; output: any };
    expect(result.ok).toBe(true);
    expect(result.output.techniques).toHaveLength(36);
    expect(result.output.parameters.strokeMm).toMatchObject({ min: 0, max: 3, unit: "mm" });
    expect(result.output.parameters.hand.options).toEqual(["auto", "left", "right"]);
    for (const id of ["gua", "tan"]) expect(result.output.techniques.find((entry: { id: string }) => entry.id === id).parameterBounds)
      .toMatchObject({ wristElevationDeg: { min: 50, max: 60 } });
    expect(result.output.handProfiles.threeFinger).toMatchObject({ wristElevationDeg: { min: 44, max: 51, default: 48 }, gripStyles: ["tip-pinch"] });
    const tool = actionTool("perform_technique");
    expect(tool.inputSchema.properties.motion?.properties?.strokeMm).toMatchObject({ minimum: 0, maximum: 3 });
    expect(tool.toAction({ technique: "nian", needleId: "pack-a.1", motion: { strokeMm: 9 } }).ok).toBe(false);
    expect(tool.toAction({ technique: "nian", needleId: "pack-a.1", motion: { contactIntensity: Infinity } }).ok).toBe(false);
    expect(lookupTool.run({ topic: "techniques", id: "不存在" }, context).ok).toBe(false);
  });

  it("keeps optional insertion presentation finite, bounded and independent from clinical path inputs", () => {
    const insertion = { type: "insert_needle", needleId: "n", mark: "m1", depthCm: 1, presentation: { durationMs: 2000, grip: "three-finger", support: "stretch", hand: "right" } };
    expect(ActionSchema.safeParse(insertion).success).toBe(true);
    for (const presentation of [{ durationMs: NaN }, { durationMs: 8001 }, { durationMs: 399 }, { grip: "unsafe" }, { depthCm: 20 }]) {
      expect(ActionSchema.safeParse({ ...insertion, presentation }).success).toBe(false);
    }
  });
});
