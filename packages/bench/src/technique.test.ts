import { describe, expect, it } from "vitest";
import {
  angleClass,
  clone,
  createEncounter,
  manipulationCharacter,
  needleAudit,
  needleEvidence,
  observeAs,
  referenceLibrary,
  showsDeqi,
  step,
  stimulusDose,
  STIMULATION,
  STUCK_AT_DEG,
  TECHNIQUES,
  type ActionInput,
  type ActionRequestInput,
  type EncounterState,
  type Scenario,
} from "@acucraft/core";
import { lookup } from "./agents/claude.js";
import { loadContentPack, requireScenario } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";
import { episodeMarkdown } from "./report.js";

/**
 * Needling technique (docs/TECHNIQUE.md): how a needle is put in, worked and taken out, as parameters the engine
 * executes, records and compares with what was planned.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");

let n = 0;
const req = (action: ActionInput): ActionRequestInput => ({ requestId: `q-${++n}`, actor: "practitioner", patient: "patient", action });
const act = (sc: Scenario, s: EncounterState, action: ActionInput) => step(sc, s, req(action), { strict: true });

/** The reference trajectory up to (not including) the `nth` action that `stop` picks. */
function ref(sc: Scenario, stop: (a: ActionInput) => boolean, nth = 1): EncounterState {
  let s = createEncounter(sc, { seed: 1 });
  let seen = 0;
  for (const r of sc.field.solution) {
    if (stop(r.action as ActionInput) && ++seen === nth) return s;
    s = step(sc, s, r, { strict: true }).state;
  }
  return s;
}
/** The knee with all five needles in, worked and asked about as the reference does. */
const needled = () => ref(knee, (a) => a.type === "monitor");
const atKnee = (s: EncounterState) => act(knee, s, { type: "move", to: { region: "knee-leg", side: "right" } }).state;
const work = (s: EncounterState, needleId: string, how: Partial<Extract<ActionInput, { type: "adjust_needle" }>>) => act(knee, atKnee(s), { type: "adjust_needle", needleId, ...how });

describe("technique as parameters", () => {
  it("gives the two basic manipulations their dose at the default parameters, and scales it by how they are done", () => {
    expect(stimulusDose({ technique: "lift-thrust", amplitudeMm: 3, frequencyPerMin: 60, durationSec: 10, emphasis: "even" })).toBe(STIMULATION["lift-thrust"]);
    expect(stimulusDose({ technique: "rotate", arcDeg: 180, frequencyPerMin: 80, durationSec: 10, direction: "both" })).toBe(STIMULATION.rotate);
    // twice the amplitude is not twice the stimulus; and one act is never more than the tissue can use
    const big = stimulusDose({ technique: "lift-thrust", amplitudeMm: 6, frequencyPerMin: 60, durationSec: 10, emphasis: "even" });
    expect(big).toBeCloseTo(0.35 * Math.SQRT2, 3);
    expect(stimulusDose({ technique: "lift-thrust", amplitudeMm: 10, frequencyPerMin: 240, durationSec: 120, emphasis: "even" })).toBe(1);
    // the auxiliary techniques give a little
    const dose = (id: (typeof TECHNIQUES)[number]["id"]) => TECHNIQUES.find((t) => t.id === id)!.dose;
    for (const id of ["scrape", "flick", "shake", "tremble"] as const) expect(dose(id)).toBeLessThan(dose("rotate"));
  });

  it("reads how a needle was worked as reinforcing, reducing or even", () => {
    const lt = (amplitudeMm: number, frequencyPerMin: number, emphasis: "even" | "thrust" | "lift", durationSec = 10) => manipulationCharacter({ technique: "lift-thrust", amplitudeMm, frequencyPerMin, durationSec, emphasis });
    expect(lt(3, 60, "even")).toBe("even"); // the defaults
    expect(lt(2, 40, "thrust")).toBe("reinforcing"); // small, slow, forceful on the thrust
    expect(lt(6, 120, "lift")).toBe("reducing"); // large, fast, forceful on the lift
    expect(lt(2, 40, "even")).toBe("reinforcing");
    expect(lt(6, 60, "thrust")).toBe("even"); // contrasts that cancel make no character
    const tw = (arcDeg: number, frequencyPerMin: number, durationSec = 10) => manipulationCharacter({ technique: "rotate", arcDeg, frequencyPerMin, durationSec, direction: "both" });
    expect(tw(180, 80)).toBe("even");
    expect(tw(90, 50)).toBe("reinforcing");
    expect(tw(360, 150)).toBe("reducing");
    expect(manipulationCharacter({ technique: "scrape", durationSec: 10 })).toBeNull();
    // the names of the angles, measured from the perpendicular
    expect([0, 20, 45, 75, 90].map((a) => angleClass(a).id)).toEqual(["perpendicular", "perpendicular", "oblique", "transverse", "transverse"]);
  });

  it("is reference knowledge: the catalogue is in the library and behind a lookup", () => {
    const lib = referenceLibrary(knee);
    expect(lib.techniques.manipulation.techniques.map((t) => t.id)).toEqual(["lift-thrust", "rotate", "scrape", "flick", "shake", "tremble"]);
    expect(lib.techniques.insertion.methods.map((m) => m.id)).toContain("tube");
    expect(lib.techniques.manipulation.stuck).toContain(`${STUCK_AT_DEG}°`);
    expect(lookup(lib, { topic: "techniques" })).toBe(lib.techniques);
  });
});

describe("putting a needle in", () => {
  const first = () => {
    const s = ref(knee, (a) => a.type === "insert_needle");
    const a = knee.field.solution.find((r) => r.action.type === "insert_needle")!.action as Extract<ActionInput, { type: "insert_needle" }>;
    return { s, a };
  };

  it("records how it went in and tells the operator what the fingers felt", () => {
    const { s, a } = first();
    const r = act(knee, s, { ...a, method: "fingernail-press" });
    expect(r.attempt.status).toBe("executed");
    expect(r.state.needles[a.needleId]!.insertion).toMatchObject({ method: "fingernail-press", speed: "swift", angleDeg: 30 });
    const seen = r.attempt.observations.join(" | ");
    expect(seen).toMatch(/perpendicular, fingernail-pressing insertion/);
    // touch, not anatomy: what was passed and where the tip lies, in words for the hand
    expect(seen).toMatch(/Feel: through loose tissue; the tip lies in soft, yielding tissue\./);
    expect(seen).not.toMatch(/fat-pad|subcutaneous|muscle/);
    // the view has the needle as it was placed: where, how deep, at what angle, and what the tip is felt to lie in
    const row = observeAs(knee, r.state, "practitioner").needling[0]!;
    expect(row).toMatchObject({ needle: a.needleId, site: { region: "knee-leg", side: "right" }, depthCm: 1.5, angleDeg: 30, azimuthDeg: 270, method: "fingernail-press", feel: "soft, yielding tissue", stuck: false, worked: [], stimulation: STIMULATION.insertion });
    // swiftly through the skin: no remark from the patient
    expect(r.state.patient.feedback.filter((f) => f.kind === "prick")).toEqual([]);
  });

  it("lets the patient feel a slow insertion, unless it is through a guide tube", () => {
    const { s, a } = first();
    const slow = act(knee, s, { ...a, speed: "slow" }).state;
    expect(slow.patient.feedback.at(-1)).toMatchObject({ kind: "prick", abnormal: false, needleId: a.needleId });
    expect(slow.patient.anxiety).toBeGreaterThan(s.patient.anxiety);
    const tube = act(knee, s, { ...a, speed: "slow", method: "tube" }).state;
    expect(tube.patient.feedback.filter((f) => f.kind === "prick")).toEqual([]);
    expect(tube.patient.anxiety).toBe(s.patient.anxiety);
  });
});

describe("working a needle", () => {
  it("records the manipulation as it was done, takes the time it takes, and is evidence of the needle's response", () => {
    const s0 = needled();
    const r = work(s0, "pack-a.3", { technique: "lift-thrust", amplitudeMm: 2, frequencyPerMin: 40, durationSec: 20, emphasis: "thrust" });
    expect(r.attempt.status).toBe("executed");
    const needle = r.state.needles["pack-a.3"]!;
    expect(needle.manipulations).toHaveLength(2); // the reference's own lift and thrust, then this one
    expect(needle.manipulations[0]).toMatchObject({ technique: "lift-thrust", amplitudeMm: 3, frequencyPerMin: 60, durationSec: 10, emphasis: "even", dose: 0.35, character: "even" });
    const done = needle.manipulations[1]!;
    expect(done).toMatchObject({ technique: "lift-thrust", amplitudeMm: 2, frequencyPerMin: 40, durationSec: 20, emphasis: "thrust", character: "reinforcing", depthCm: 2 });
    expect(done.dose).toBeCloseTo(0.35 * Math.sqrt(2 / 3) * Math.sqrt(40 / 60) * Math.sqrt(2), 3);
    expect(r.state.clinical.clock - atKnee(s0).clinical.clock).toBeCloseTo((20 + 20) / 60, 2);
    expect(r.attempt.executed!.detail).toMatch(/lifting and thrusting, 2 mm, 40\/min, 20 s, forceful on the thrust \(reinforcing\)/);
    // the feel is evidence, under the id the log names
    const felt = needleEvidence(r.state, "pack-a.3").filter((e) => e.kind === "needle-feel").at(-1)!;
    expect(felt.id).toBe(done.evidence);
    const row = observeAs(knee, r.state, "practitioner").needling.find((x) => x.needle === "pack-a.3")!;
    expect(row.worked.map((m) => m.character)).toEqual(["even", "reinforcing"]);
    expect(row.worked[1]!.summary).toMatch(/2 mm, 40\/min/);
    expect(row.stimulation).toBeCloseTo(0.45 + 0.35 + done.dose, 3);
  });

  it("hastens a response that is nearly there with an auxiliary technique, and no further than the tissue allows", () => {
    // the lateral knee eye: rotated once by the reference, and not held
    let s = needled();
    const id = "pack-a.1";
    expect(showsDeqi(knee, needleEvidence(s, id).find((e) => e.kind === "needle-feel")!)).toBe(false);
    const r = work(s, id, { technique: "tremble" });
    s = r.state;
    expect(r.attempt.observations.join(" ")).toMatch(/gripped as you make the needle tremble/);
    expect(s.needles[id]!.manipulations.at(-1)).toMatchObject({ technique: "tremble", character: null, dose: 0.2 });
    expect(showsDeqi(knee, needleEvidence(s, id).at(-1)!)).toBe(true);
    // the Ashi needle lies under the skin: no technique, basic or auxiliary, makes that tissue answer
    for (const technique of ["scrape", "flick", "shake", "tremble"] as const) s = work(s, "pack-a.5", { technique }).state;
    expect(needleEvidence(s, "pack-a.5").filter((e) => e.kind === "needle-feel").every((e) => !showsDeqi(knee, e))).toBe(true);
    expect(s.needles["pack-a.5"]!.response).toMatchObject({ deqi: false, arrivedAt: null });
  });

  it("says what the fingers feel when a needle is taken to another depth", () => {
    const back = requireScenario(pack, "sg-low-back-pain/base");
    const s = ref(back, (a) => a.type === "adjust_needle" && a.depthCm !== undefined);
    const r = step(back, s, req({ type: "adjust_needle", needleId: "pack-a.5", depthCm: 2.0 }), { strict: true });
    expect(r.attempt.observations.join(" | ")).toMatch(/Feel: through loose tissue; the tip lies in springy tissue\./);
    expect(observeAs(back, r.state, "practitioner").needling.find((x) => x.needle === "pack-a.5")!.feel).toBe("springy tissue");
  });
});

describe("a stuck needle", () => {
  const wound = () => {
    let s = needled();
    const id = "pack-a.4"; // SP9, in muscle
    const turns = [];
    for (let i = 0; i < 2; i++) {
      const r = work(s, id, { technique: "rotate", direction: "clockwise", arcDeg: 180 });
      turns.push(r);
      s = r.state;
    }
    return { s, id, turns };
  };

  it("comes of twirling one way: at a full turn the tissue binds the shaft, and it hurts", () => {
    const { s, id, turns } = wound();
    expect(turns[0]!.state.needles[id]!.response).toMatchObject({ winding: 180, stuck: false });
    expect(s.needles[id]!.response).toMatchObject({ winding: 360, stuck: true, deqi: false, noxious: "sharp-pain" });
    expect(turns[1]!.attempt.observations.join(" ")).toMatch(/bound tight as you twirl the needle.*It is stuck\./);
    expect(s.needles[id]!.events.map((e) => e.what)).toContain("stuck");
    expect(s.patient.feedback.at(-1)).toMatchObject({ kind: "sharp-pain", abnormal: true, needleId: id });
    // felt as bound is not felt as held: this is no evidence of deqi
    expect(showsDeqi(knee, needleEvidence(s, id).filter((e) => e.kind === "needle-feel").at(-1)!)).toBe(false);
    expect(observeAs(knee, s, "practitioner").needling.find((x) => x.needle === id)!.stuck).toBe(true);
    // twirling back and forth never winds
    let t = needled();
    for (let i = 0; i < 3; i++) t = work(t, "pack-a.2", { technique: "rotate", arcDeg: 360 }).state;
    expect(t.needles["pack-a.2"]!.response).toMatchObject({ winding: 0, stuck: false });
  });

  it("is never pulled or driven: the guard stops it, and the rest come out without it", () => {
    const { s, id } = wound();
    const pulled = act(knee, atKnee(s), { type: "remove_needle", needleId: id });
    expect(pulled.attempt).toMatchObject({ status: "blocked", code: "stuck-needle", unsafe: ["forced-stuck-needle"] });
    expect(pulled.attempt.message).toMatch(/turn it back the other way, or loosen the tissue round it/);
    expect(pulled.state.needles[id]!.location.kind).toBe("patient");
    expect(work(s, id, { technique: "lift-thrust" }).attempt).toMatchObject({ status: "blocked", unsafe: ["forced-stuck-needle"] });
    expect(work(s, id, { depthCm: 1.0 }).attempt.status).toBe("blocked");
    // taking them all out leaves the stuck one, and says so
    const all = act(knee, atKnee(s), { type: "remove_all_needles" });
    expect(all.attempt.status).toBe("partial");
    expect(all.attempt.observations.join(" ")).toMatch(/pack-a\.4 is stuck and was left in place/);
    expect(Object.values(all.state.needles).filter((x) => x.location.kind === "patient").map((x) => x.id)).toEqual([id]);
    expect(act(knee, all.state, { type: "end_visit" }).attempt.code).toBe("needles-retained");
  });

  it("is released by turning it back, or by loosening the tissue round it", () => {
    const { s, id } = wound();
    // turned back most of the way: free again
    const back = work(s, id, { technique: "rotate", direction: "counter-clockwise", arcDeg: 270 });
    expect(back.state.needles[id]!.response).toMatchObject({ winding: 90, stuck: false });
    expect(back.attempt.observations.join(" ")).toMatch(/turns free again/);
    expect(back.state.needles[id]!.events.map((e) => e.what)).toContain("released");
    expect(act(knee, atKnee(back.state), { type: "remove_needle", needleId: id, speed: "slow" }).attempt.status).toBe("executed");
    // or the handle flicked until the tissue lets go: each time a quarter turn
    let t = s;
    for (let i = 0; i < 2; i++) t = work(t, id, { technique: "flick" }).state;
    expect(t.needles[id]!.response).toMatchObject({ winding: 180, stuck: true });
    t = work(t, id, { technique: "scrape" }).state;
    expect(t.needles[id]!.response).toMatchObject({ winding: 90, stuck: false });
  });

  it("costs points only when it is forced", () => {
    const { s, id } = wound();
    const finish = (state: EncounterState) => {
      let t = work(state, id, { technique: "rotate", direction: "counter-clockwise", arcDeg: 270 }).state;
      for (const r of knee.field.solution.slice(knee.field.solution.findIndex((x) => x.action.type === "monitor"))) t = step(knee, t, r).state;
      return evaluateEncounter(knee, t);
    };
    const item = (r: ReturnType<typeof evaluateEncounter>) => r.tracks.procedure.items.find((i) => i.id === "stuck-needle-released");
    expect(item(finish(s))).toMatchObject({ met: true, weight: 2 });
    const forced = act(knee, atKnee(s), { type: "remove_needle", needleId: id }).state;
    const report = finish(forced);
    expect(item(report)).toMatchObject({ met: false });
    expect(report.unsafe.blocked["forced-stuck-needle"]).toBe(1);
    expect(report.evidence.needles.find((x) => x.needle === id)!.technique.everStuck).toBe(true);
  });
});

describe("taking a needle out", () => {
  it("records how, and a swab held on the hole stops a site that bleeds", () => {
    const s = clone(needled());
    s.needles["pack-a.3"]!.bleeding = true; // as when the shaft has met a small vessel
    const plain = act(knee, atKnee(s), { type: "remove_needle", needleId: "pack-a.3" });
    expect(plain.state.needles["pack-a.3"]).toMatchObject({ bleeding: true, withdrawal: { speed: "quick", pressed: false } });
    expect(plain.attempt.observations.join(" ")).toMatch(/is bleeding: apply pressure/);
    const pressed = act(knee, atKnee(s), { type: "remove_needle", needleId: "pack-a.3", speed: "slow", press: true });
    expect(pressed.state.needles["pack-a.3"]).toMatchObject({ bleeding: false, withdrawal: { speed: "slow", pressed: true } });
    expect(pressed.attempt.observations.join(" ")).toMatch(/held under the swab, it has stopped/);
    expect(pressed.state.patient.feedback.filter((f) => f.kind === "bleeding")).toEqual([]);
    expect(pressed.state.clinical.clock - atKnee(s).clinical.clock).toBeCloseTo(0.5, 2);
  });
});

describe("what is done against what the plan states", () => {
  /** The knee reference with its plan's stimulation and its manipulations changed. */
  const run = (stimulation: "none" | "even" | "reducing" | "reinforcing", how: Partial<Extract<ActionInput, { type: "adjust_needle" }>> = {}) => {
    let s = createEncounter(knee, { seed: 1 });
    for (const r of knee.field.solution) {
      let action = r.action as ActionInput;
      if (action.type === "propose_plan") action = { ...action, plan: { ...action.plan, technique: { ...action.plan.technique, stimulation } } };
      if (action.type === "adjust_needle") action = { ...action, ...how };
      s = step(knee, s, { ...r, action }).state;
    }
    const report = evaluateEncounter(knee, s);
    return { report, item: report.tracks.procedure.items.find((i) => i.id === "stimulation-as-planned:v1") };
  };

  it("compares the manner of working the needles with the stimulation planned", () => {
    // the reference: an even plan, the needles worked at the default parameters
    const even = run("even");
    expect(even.item).toMatchObject({ met: true, weight: 1 });
    expect(even.report.primary.status).toBe("success");
    // the same hands under a plan that says reinforcing: nothing done was reinforcing
    const stated = run("reinforcing");
    expect(stated.item).toMatchObject({ met: false });
    expect(stated.item!.detail).toMatch(/no reinforcing manipulation among/);
    expect(stated.report.primary.status).toBe("success"); // a matter of technique, not of safety
    // worked as stated: small, slow, forceful on the thrust
    expect(run("reinforcing", { amplitudeMm: 2, frequencyPerMin: 40, arcDeg: 90, emphasis: "thrust" }).item).toMatchObject({ met: true });
    // a plan that says no stimulation, and needles worked all the same
    const none = run("none");
    expect(none.item).toMatchObject({ met: false });
    expect(none.item!.detail).toMatch(/pack-a\.1: twirling/);
    // the report says how every needle was put in, worked and taken out
    expect(episodeMarkdown(even.report)).toMatch(/\*\*Technique\*\*[\s\S]*pack-a\.3 \(ST36:right\): 2 cm at 0° from the perpendicular, single-hand, swift; worked: lifting and thrusting, 3 mm, 60\/min, 10 s \(even\) \[\+0\.35\]/);
  });

  it("asks nothing where no needle was worked", () => {
    // the anticoagulated patient: an even plan, and no needle worked — there is nothing to compare
    const gentle = requireScenario(pack, "sg-knee-oa/anticoagulated");
    let s = createEncounter(gentle, { seed: 1 });
    for (const r of gentle.field.solution) s = step(gentle, s, r).state;
    const report = evaluateEncounter(gentle, s);
    expect(report.tracks.procedure.items.find((i) => i.id.startsWith("stimulation-as-planned"))).toBeUndefined();
    expect(needleAudit(gentle, s).every((x) => x.technique.worked.length === 0)).toBe(true);
    // the pregnant patient: the plan says none, and none was given
    const pregnant = requireScenario(pack, "sg-low-back-pain/pregnant");
    s = createEncounter(pregnant, { seed: 1 });
    for (const r of pregnant.field.solution) s = step(pregnant, s, r).state;
    expect(evaluateEncounter(pregnant, s).tracks.procedure.items.find((i) => i.id === "stimulation-as-planned:v1")).toMatchObject({ met: true });
  });
});
