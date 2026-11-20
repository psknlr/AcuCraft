import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OPERATIVE_TECHNIQUES, clone, createEncounter, digest, now, observeAs, replayLog, resolveScenario, step,
  type ActionInput, type EncounterLog, type EncounterState, type Mode, type Scenario, type TechniqueModel,
} from "@acucraft/core";
import { EncounterSession, lookupTool, referenceAgent } from "@acucraft/agent";
import { CLINICALCRAFT_REV, evaluateEncounter, loadContentPack, requireScenario, runEpisode } from "./index.js";

/**
 * The 36 techniques done to the needle (docs/TECHNIQUES.md): an encounter on the operative catalogue, where a
 * technique takes its time, stimulates the needle, tells the hand how the tissue holds it, reads as reinforcing or
 * reducing, and — turned one way — winds the tissue round the shaft.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");
const back = requireScenario(pack, "sg-low-back-pain/base");
const NEEDLE = "pack-a.1";

/** The reference trajectory up to (not including) its first action of a type. */
function before(sc: Scenario, type: string, techniques: TechniqueModel = "operative", mode: Mode = "assessment"): EncounterState {
  let state = createEncounter(sc, { seed: 1, mode, techniques });
  for (const request of sc.field.solution) {
    if (request.action.type === type) return state;
    const result = step(sc, state, request, { strict: true });
    if (!["executed", "partial"].includes(result.attempt.status)) throw new Error(result.attempt.message);
    state = result.state;
  }
  throw new Error(`no ${type} in the reference`);
}

let serial = 0;
const act = (sc: Scenario, state: EncounterState, action: ActionInput) =>
  step(sc, state, { requestId: `op-${++serial}`, actor: "practitioner", patient: "patient", action }, { strict: true });
const perform = (sc: Scenario, state: EncounterState, technique: string, extra: Record<string, unknown> = {}) =>
  act(sc, state, { type: "perform_technique", technique, needleId: NEEDLE, ...extra } as ActionInput);
const needle = (state: EncounterState) => state.needles[NEEDLE]!;

describe("a technique done to the needle", () => {
  const start = before(knee, "adjust_needle");

  it("takes its time, stimulates the needle by its own dose, and leaves the feel of it as evidence", () => {
    const stood = needle(start);
    expect(start.techniques).toBe("operative");
    for (const t of OPERATIVE_TECHNIQUES.filter((x) => x.context === "retained")) {
      const r = perform(knee, start, t.id);
      expect(r.attempt.status, `${t.id}: ${r.attempt.message}`).toBe("executed");
      const n = needle(r.state), done = r.state.performances!.at(-1)!;
      // the clock moves by the performance
      expect(now(r.state) - now(start), t.id).toBeCloseTo(Math.max(0.05, t.defaults.durationMs / 60_000), 1);
      // the needle has had the method's dose, and is where it stood
      expect(n.response!.stimulation, t.id).toBeCloseTo(stood.response!.stimulation + t.effect.dose, 3);
      expect(n.response!.manipulations, t.id).toBe(1);
      expect(n.location, t.id).toEqual(stood.location);
      expect(done).toMatchObject({
        technique: t.id, context: "retained", needleId: NEEDLE,
        provenance: { kind: "operative", source: "acucraft-operative-techniques-v2", review: "unreviewed", forces: "not-modelled" },
        effect: { dose: t.effect.dose, reading: t.effect.reading },
      });
      // the needle's own history says it was worked, and how the working reads
      expect(n.events.at(-1)).toMatchObject({ what: "adjusted", ...(t.effect.reading ? { reading: t.effect.reading } : {}) });
      // a hand that holds the needle in the tissue is told how the tissue holds it; a touch on the handle is not
      const felt = r.state.evidence.filter((e) => e.kind === "needle-feel" && e.ref === NEEDLE);
      expect(felt.length, t.id).toBe(t.family === "handle" ? 0 : 1);
      if (felt[0]) expect(felt[0].needle!.grasp, t.id).toBe(n.response!.deqi);
    }
  });

  it("leaves an encounter on the illustrative catalogue exactly as it was: shown and recorded, nothing else", () => {
    const old = before(knee, "adjust_needle", "illustrative");
    expect(old.techniques).toBeUndefined();
    const r = perform(knee, old, "shao-shan-huo", { motion: { support: "none" } });
    expect(r.attempt.status).toBe("executed");
    expect(now(r.state)).toBe(now(old));
    expect(r.state.needles).toEqual(old.needles);
    expect(r.state.evidence).toEqual(old.evidence);
    expect(r.state.performances!.at(-1)).toMatchObject({ provenance: { kind: "illustrative" } });
    expect(r.state.performances!.at(-1)!.effect).toBeUndefined();
    // and it will not take a setting that belongs to the other catalogue: to it, that is not a request at all
    expect(act(knee, old, { type: "perform_technique", technique: "xun", needleId: NEEDLE, motion: { travelMm: 20 } } as ActionInput).attempt)
      .toMatchObject({ status: "rejected", code: "invalid-request" });
  });

  it("works between levels of the depth the needle stands at, and refuses a needle too shallow for them", () => {
    const shallow = act(knee, start, { type: "adjust_needle", needleId: NEEDLE, depthCm: 0.5, technique: "none" }).state;
    const refused = perform(knee, shallow, "shao-shan-huo");
    expect(refused.attempt).toMatchObject({ status: "rejected", code: "too-shallow" });
    expect(refused.attempt.message).toMatch(/5 mm.*at least 6 mm/);
    expect(refused.state.performances ?? []).toEqual(shallow.performances ?? []);
    expect(needle(refused.state)).toEqual(needle(shallow));
    // a single method needs no levels
    expect(perform(knee, shallow, "nian").attempt.status).toBe("executed");
    // counts that do not fit the method are refused before anything happens
    expect(perform(knee, start, "shao-shan-huo", { motion: { phaseCycles: [9, 9] } }).attempt).toMatchObject({ status: "rejected", code: "technique-parameter" });
    expect(perform(knee, start, "nian", { motion: { phaseCycles: [2, 2] } }).attempt).toMatchObject({ status: "rejected", code: "technique-parameter" });
    const custom = perform(knee, start, "shao-shan-huo", { motion: { phaseCycles: [3, 3, 3] } });
    expect(custom.state.performances!.at(-1)!.motion.phaseCycles).toEqual([3, 3, 3]);
    expect(custom.state.performances!.at(-1)!.effect!.dose).toBeLessThan(0.7);
  });

  it("winds the needle when it is rolled one way: held, then stuck — and a stuck needle is freed, not worked", () => {
    let s = perform(knee, start, "cuo").state;
    expect(needle(s).winding).toBe(360);
    expect(s.attempts.at(-1)!.observations.join(" ")).toMatch(/is held: the fibres have taken the shaft/);
    const second = perform(knee, s, "cuo");
    s = second.state;
    expect(needle(s).winding).toBe(720);
    expect(second.attempt.observations.join(" ")).toMatch(/is stuck/);
    // it hurts, the patient says so, and that is on the record as what it is: not deqi
    expect(s.patient.feedback.at(-1)).toMatchObject({ kind: "sharp-pain", needleId: NEEDLE, abnormal: true });
    expect(s.evidence.filter((e) => e.kind === "needle-feel").at(-1)).toMatchObject({ needle: { grasp: false } });
    expect(s.evidence.filter((e) => e.kind === "needle-feel").at(-1)!.text).toMatch(/will not turn or lift/);
    // nothing that works the needle is done to it while it is stuck
    for (const technique of ["ti", "nian", "shao-shan-huo", "yao"]) expect(perform(knee, s, technique).attempt, technique).toMatchObject({ status: "rejected", code: "stuck-needle" });
    expect(act(knee, s, { type: "adjust_needle", needleId: NEEDLE, technique: "lift-thrust" }).attempt).toMatchObject({ status: "rejected", code: "stuck-needle" });
    expect(act(knee, s, { type: "adjust_needle", needleId: NEEDLE, depthCm: 1, technique: "none" }).attempt).toMatchObject({ status: "rejected", code: "stuck-needle" });
    // stroking and nipping along the channel let it go, little by little
    s = perform(knee, s, "xun").state;
    expect(needle(s).winding).toBe(600);
    const nipped = perform(knee, s, "she");
    s = nipped.state;
    expect(needle(s).winding).toBe(360);
    expect(nipped.attempt.observations.join(" ")).toMatch(/no longer stuck/);
    // and rolling it back the other way frees it
    const back = perform(knee, s, "cuo", { motion: { direction: "counterclockwise" } });
    expect(needle(back.state).winding).toBeUndefined();
    expect(back.attempt.observations.join(" ")).toMatch(/is free again/);
    expect(perform(knee, back.state, "ti").attempt.status).toBe("executed");
  });

  it("tells a needle held by its winding from a needle the tissue has answered", () => {
    // at half a centimetre the tip is short of the tissue that answers: no amount of winding is deqi
    const shallow = act(knee, start, { type: "adjust_needle", needleId: NEEDLE, depthCm: 0.5, technique: "none" }).state;
    const wound = perform(knee, shallow, "cuo");
    const n = needle(wound.state);
    expect(n.winding).toBe(360);
    expect(n.response!.deqi).toBe(false);
    const felt = wound.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)!;
    expect(felt.needle!.grasp).toBe(false);
    expect(felt.text).toMatch(/it is the winding that holds it, not the tissue answering/);
  });

  it("pulling out a stuck needle is unsafe: it hurts and it bleeds — and 扪 closes the hole", () => {
    const stuck = perform(knee, perform(knee, start, "cuo").state, "cuo").state;
    const pulled = act(knee, stuck, { type: "remove_needle", needleId: NEEDLE });
    expect(pulled.attempt.status).toBe("executed");
    expect(pulled.attempt.unsafe).toContain("stuck-needle-forced");
    expect(needle(pulled.state)).toMatchObject({ bleeding: true, location: { kind: "hand" } });
    expect(needle(pulled.state).winding).toBeUndefined();
    expect(pulled.state.patient.feedback.some((f) => f.kind === "sharp-pain" && /hurt coming out/.test(f.text))).toBe(true);
    // a needle freed first comes out like any other
    const freed = perform(knee, perform(knee, stuck, "she").state, "cuo", { motion: { direction: "counterclockwise", cycles: 2 } }).state;
    const clean = act(knee, freed, { type: "remove_needle", needleId: NEEDLE });
    expect(clean.attempt.unsafe).not.toContain("stuck-needle-forced");
    // 扪: on the hole of the needle just withdrawn
    const closed = perform(knee, pulled.state, "men");
    expect(closed.attempt.status, closed.attempt.message).toBe("executed");
    expect(needle(closed.state)).toMatchObject({ bleeding: false, holeClosed: true });
    expect(closed.attempt.observations.join(" ")).toMatch(/pressed closed: the bleeding has stopped/);
    expect(closed.state.performances!.at(-1)).toMatchObject({ technique: "men", context: "removed", effect: { dose: 0 } });
  });

  it("past what the patient tolerates, more only hurts", () => {
    let s = perform(knee, start, "shao-shan-huo").state;
    expect(needle(s).response!.overstimulated).toBe(false);
    const again = perform(knee, s, "zi-wu-dao-jiu");
    s = again.state;
    expect(needle(s).response!.overstimulated).toBe(true);
    expect(s.patient.feedback.at(-1)).toMatchObject({ kind: "too-strong", needleId: NEEDLE });
    expect(evaluateEncounter(knee, s).tracks.procedure!.items.find((i) => i.id === "no-overstimulation")?.met).toBe(false);
  });

  it("lets the pressing hand call the qi beside a needle without taking hold of it", () => {
    const r = perform(knee, start, "xun");
    const n = needle(r.state), was = needle(start);
    expect(n.response!.stimulation).toBeCloseTo(was.response!.stimulation + 0.05, 3);
    expect(n.response!.manipulations).toBe(was.response!.manipulations);
    expect(n.events).toEqual(was.events);
    expect(r.state.performances!.at(-1)).toMatchObject({ technique: "xun", context: "skin", needleId: NEEDLE });
    expect(r.attempt.executed?.detail).toMatch(/beside pack-a\.1/);
    // the skin was handled: a prepared site there is no longer prepared
    expect(r.attempt.observations.join(" ")).toMatch(/touched again: prepare it again/);
    // palpating and the nail are for the point, before the needle: named with a needle they leave it alone
    expect(needle(perform(knee, start, "chuai").state).response).toEqual(was.response);
  });
});

describe("what was done to the needles, in the evaluation", () => {
  const start = before(knee, "adjust_needle");
  const item = (state: EncounterState, id: string) => evaluateEncounter(knee, state).tracks.procedure!.items.find((i) => i.id === id);

  it("judges a wound needle by whether it was freed or forced — and says nothing when no needle was wound", () => {
    expect(item(perform(knee, start, "nian").state, "wound-needle-freed")).toBeUndefined();
    const stuck = perform(knee, perform(knee, start, "cuo").state, "cuo").state;
    expect(item(stuck, "wound-needle-freed")).toMatchObject({ met: true });
    expect(item(act(knee, stuck, { type: "remove_needle", needleId: NEEDLE }).state, "wound-needle-freed")).toMatchObject({ met: false });
    const freed = perform(knee, perform(knee, stuck, "she").state, "cuo", { motion: { direction: "counterclockwise", cycles: 2 } }).state;
    expect(item(act(knee, freed, { type: "remove_needle", needleId: NEEDLE }).state, "wound-needle-freed")).toMatchObject({ met: true });
    // an encounter on the illustrative catalogue has no such item
    const old = before(knee, "adjust_needle", "illustrative");
    expect(evaluateEncounter(knee, perform(knee, old, "cuo", { motion: { support: "none" } }).state).tracks.procedure!.items.some((i) => i.id === "wound-needle-freed")).toBe(false);
  });

  it("holds the working of the needles to the stimulation the patient agreed to", () => {
    // the plan of this encounter is for even stimulation: nothing is the opposite of even
    expect(item(perform(knee, start, "xie").state, "stimulation-as-planned")).toBeUndefined();
    // the same encounter with a reinforcing plan, agreed to before the needles
    let s = createEncounter(knee, { seed: 1, techniques: "operative" });
    for (const request of knee.field.solution) {
      if (request.action.type === "adjust_needle") break;
      const action = request.action.type === "propose_plan" ? { ...request.action, plan: { ...request.action.plan, technique: { ...request.action.plan.technique, stimulation: "reinforcing" as const } } } : request.action;
      const done = step(knee, s, { ...request, action }, { strict: true });
      expect(["executed", "partial"], done.attempt.message).toContain(done.attempt.status);
      s = done.state;
    }
    expect(s.plans.at(-1)!.plan.technique.stimulation).toBe("reinforcing");
    expect(item(s, "stimulation-as-planned")).toBeUndefined();
    expect(item(perform(knee, s, "shao-shan-huo").state, "stimulation-as-planned")).toMatchObject({ met: true });
    expect(item(perform(knee, s, "nian").state, "stimulation-as-planned")).toMatchObject({ met: true });
    const against = item(perform(knee, s, "tou-tian-liang").state, "stimulation-as-planned")!;
    expect(against).toMatchObject({ met: false });
    expect(against.detail).toMatch(/pack-a\.1: .*透天凉.* reads as reducing/);
    expect(item(act(knee, s, { type: "adjust_needle", needleId: NEEDLE, technique: "xie" }).state, "stimulation-as-planned")).toMatchObject({ met: false });
  });

  it("does not hold a needle's path against a hand that only strokes the channel beside it", () => {
    const stroked = perform(knee, start, "xun");
    expect(stroked.attempt.unsafe).toEqual([]);
    expect(stroked.attempt.status).toBe("executed");
  });
});

describe("warmth and coolness", () => {
  it("come to some patients and not to others, with the response and only with it", () => {
    const start = before(back, "adjust_needle");
    const fire = perform(back, start, "shao-shan-huo");
    const n = needle(fire.state);
    expect(n.response!.thermal).toBe("warmth");
    expect(n.response!.deqi).toBe(true);
    // this patient, at this site, feels it: she says so unasked, and asked
    expect(n.response!.qualities).toContain("warmth");
    expect(fire.state.patient.feedback.at(-1)!.text).toMatch(/getting warm/);
    const asked = act(back, fire.state, { type: "check_sensation", needleId: NEEDLE }).state;
    expect(asked.evidence.at(-1)).toMatchObject({ kind: "sensation", needle: { id: NEEDLE } });
    expect(asked.evidence.at(-1)!.needle!.qualities).toContain("warmth");
    expect(asked.evidence.at(-1)!.text).toMatch(/a warm feeling/);
    // the same patient is the same in every encounter with her, whatever the seed
    let other = createEncounter(back, { seed: 7, techniques: "operative" });
    for (const request of back.field.solution) { if (request.action.type === "adjust_needle") break; other = step(back, other, request, { strict: true }).state; }
    expect(needle(perform(back, other, "shao-shan-huo").state).response!.qualities).toContain("warmth");
    // 透天凉 is done for coolness
    const cool = perform(back, start, "tou-tian-liang");
    expect(needle(cool.state).response!.thermal).toBe("coolness");
    expect(needle(cool.state).response!.qualities).toContain("coolness");
    expect(cool.state.patient.feedback.at(-1)!.text).toMatch(/feels cool/);
    // without the response there is nothing to feel warm
    const shallow = act(back, start, { type: "adjust_needle", needleId: NEEDLE, depthCm: 0.6, technique: "none" }).state;
    const none = needle(perform(back, shallow, "shao-shan-huo").state).response!;
    expect(none.deqi).toBe(false);
    expect(none.qualities).toEqual([]);
    // and a plain method seeks neither
    expect(needle(perform(back, start, "nian").state).response!.thermal).toBeUndefined();
  });
});

describe("working a needle with adjust_needle on the operative catalogue", () => {
  const start = before(knee, "adjust_needle");
  const adjust = (state: EncounterState, fields: Record<string, unknown>) => act(knee, state, { type: "adjust_needle", needleId: NEEDLE, ...fields } as ActionInput);

  it("is the act it always was when no excursion, rate or time is stated", () => {
    const old = before(knee, "adjust_needle", "illustrative");
    for (const technique of ["lift-thrust", "rotate", "bu", "xie"]) {
      const a = adjust(start, { technique }).state, b = act(knee, old, { type: "adjust_needle", needleId: NEEDLE, technique } as ActionInput).state;
      expect(needle(a).response, technique).toEqual(needle(b).response);
      expect(now(a) - now(start), technique).toBe(now(b) - now(old));
    }
  });

  it("doses by what is stated, reads the form asked for, and winds when turned one way", () => {
    const base = needle(start).response!.stimulation;
    const gentle = adjust(start, { technique: "lift-thrust", strokeMm: 1, frequencyHz: 1, durationSeconds: 10 }).state;
    const strong = adjust(start, { technique: "lift-thrust", strokeMm: 8, frequencyHz: 2, durationSeconds: 60 }).state;
    expect(needle(gentle).response!.stimulation - base).toBeLessThan(0.35);
    expect(needle(strong).response!.stimulation - base).toBeGreaterThan(0.35);
    expect(needle(strong).response!.stimulation - base).toBeLessThanOrEqual(1);
    expect(needle(adjust(start, { technique: "bu" }).state).events.at(-1)).toMatchObject({ reading: "reinforcing" });
    expect(needle(adjust(start, { technique: "xie" }).state).events.at(-1)).toMatchObject({ reading: "reducing" });
    expect(needle(adjust(start, { technique: "lift-thrust" }).state).events.at(-1)).toMatchObject({ reading: "even" });
    // one turn one way is half-way to a held needle; thirty seconds of it is a stuck one
    const quarter = adjust(start, { technique: "rotate", rotationDirection: "clockwise", rotationDeg: 90, frequencyHz: 1, durationSeconds: 1 });
    expect(needle(quarter.state).winding).toBe(90);
    expect(needle(quarter.state).events.at(-1)).toMatchObject({ reading: "reinforcing" });
    const seized = adjust(start, { technique: "rotate", rotationDirection: "clockwise" });
    expect(needle(seized.state).winding).toBe(1080);
    expect(seized.attempt.observations.join(" ")).toMatch(/is stuck/);
    // turned back the other way it comes free again; turned to and fro it never winds
    const unwound = adjust(seized.state, { technique: "rotate", rotationDirection: "counterclockwise", rotationDeg: 180, frequencyHz: 1, durationSeconds: 6 });
    expect(unwound.attempt.status).toBe("executed");
    expect(needle(unwound.state).winding).toBeUndefined();
    expect(needle(adjust(start, { technique: "rotate", rotationDeg: 180, frequencyHz: 2, durationSeconds: 30 }).state).winding).toBeUndefined();
    // on the illustrative catalogue none of this exists
    const old = before(knee, "adjust_needle", "illustrative");
    const plain = act(knee, old, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "clockwise" } as ActionInput).state;
    expect(needle(plain).winding).toBeUndefined();
    expect(needle(plain).events.at(-1)!.reading).toBeUndefined();
  });
});

describe("records, replay and what a practitioner is shown", () => {
  it("a log says which catalogue it ran on, and replays on it", async () => {
    const session = new EncounterSession(knee, { techniques: "operative" });
    for (const request of knee.field.solution) { if (request.action.type === "adjust_needle") break; session.act(request.action as ActionInput, request.actor); }
    expect(session.act({ type: "perform_technique", technique: "long-hu-jiao-zhan", needleId: NEEDLE } as ActionInput).attempt.status).toBe("executed");
    const log = session.log({ clinicalcraft: CLINICALCRAFT_REV });
    expect(log.techniques).toBe("operative");
    expect(digest(replayLog(knee, log).state)).toBe(log.finalDigest);
    expect(EncounterSession.fromLog(knee, log).techniques).toBe("operative");
    // the same requests on the other catalogue are another encounter: a log is not moved from one to the other
    const { techniques: _dropped, ...moved } = log;
    expect(() => EncounterSession.fromLog(knee, moved)).toThrow(/does not reproduce its recorded state/);
    // a session that is not told runs on the illustrative catalogue, and its log does not name one
    const plain = new EncounterSession(knee);
    expect(plain.techniques).toBe("illustrative");
    expect("techniques" in plain.log({ clinicalcraft: CLINICALCRAFT_REV })).toBe(false);
    // the benchmark runs new encounters on the operative catalogue, and the reference reaches the same end on either
    const operative = await runEpisode(knee, referenceAgent(knee), { seed: 1 });
    const illustrative = await runEpisode(knee, referenceAgent(knee), { seed: 1, techniques: "illustrative" });
    expect(operative.log.techniques).toBe("operative");
    expect(illustrative.log.techniques).toBeUndefined();
    expect(operative.report.primary).toEqual(illustrative.report.primary);
    expect(operative.report.tracks).toEqual(illustrative.report.tracks);
  });

  it("serves the catalogue the encounter runs on, to a model and to the operator's panel alike", () => {
    const start = before(knee, "adjust_needle");
    const session = new EncounterSession(knee, { techniques: "operative" });
    const context = { library: session.library(), view: observeAs(knee, start, "practitioner"), skills: [] };
    const index = lookupTool.run({ topic: "techniques" }, context).output as Record<string, any>;
    expect(index.model).toBe("operative");
    expect(index.techniques).toHaveLength(36);
    expect(index.techniques[0]).toMatchObject({ id: "chuai", evidence: "operative", group: "channel" });
    expect(index.techniques[0].method).toBeUndefined();
    expect(Object.keys(index.defaults)).toHaveLength(36);
    expect(index.motionSchema.properties.travelMm).toMatchObject({ minimum: 0, maximum: 60 });
    // one technique in full: how it is done, its stages with their levels and counts
    const one = lookupTool.run({ topic: "techniques", id: "烧山火" }, context).output as Record<string, any>;
    expect(one.techniques).toHaveLength(1);
    expect(one.techniques[0]).toMatchObject({ id: "shao-shan-huo", formula: { from: "《金针赋》" }, effect: { dose: 0.7, reading: "reinforcing", seeks: "warmth" } });
    expect(one.techniques[0].stages.filter((x: any) => x.times).map((x: any) => [x.level, x.times])).toEqual([["天部 (shallow level)", 9], ["人部 (middle level)", 9], ["地部 (deep level)", 9]]);
    expect(lookupTool.run({ topic: "techniques", id: "compound" }, context).output).toMatchObject({ techniques: expect.arrayContaining([expect.objectContaining({ id: "tou-tian-liang" })]) });
    expect(lookupTool.run({ topic: "techniques", id: "不存在" }, context).ok).toBe(false);
    // an encounter on the illustrative catalogue is served the illustrative one, as before
    const oldView = observeAs(knee, before(knee, "adjust_needle", "illustrative"), "practitioner");
    const old = lookupTool.run({ topic: "techniques" }, { ...context, view: oldView }).output as Record<string, any>;
    expect(old.model).toBeUndefined();
    expect(old.techniques.every((t: any) => t.evidence === "illustrative")).toBe(true);
  });

  it("shows a practitioner what was done, never how the needle is held or how the tissue answered", () => {
    const start = before(knee, "adjust_needle");
    const wound = perform(knee, perform(knee, start, "cuo").state, "shao-shan-huo", { motion: { phaseCycles: [3, 3, 3] } }).state;
    const view = observeAs(knee, wound, "practitioner");
    expect(view.techniques).toBe("operative");
    expect(view.performances!.at(-1)).toMatchObject({ technique: "shao-shan-huo", effect: { reading: "reinforcing" }, provenance: { kind: "operative" } });
    const shown = JSON.stringify(view);
    // (what the performance wound on is the operator's own doing; how the needle is now held is felt, not read)
    for (const hidden of ["\"winding\":", "\"intensity\"", "thermal", "tipTissue", "holeClosed"]) expect(shown.includes(hidden), hidden).toBe(false);
    // (the plan names a stimulation in words; the needle's stimulation so far is a number, and is not shown)
    expect(/"stimulation":\s*[\d.]/.test(shown)).toBe(false);
    // the illustrative view has no such entry at all
    expect("techniques" in observeAs(knee, before(knee, "adjust_needle", "illustrative"), "practitioner")).toBe(false);
  });
});

describe("what an independent review found, and what holds now", () => {
  const start = before(knee, "adjust_needle");
  const stuck = () => act(knee, start, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "clockwise" } as ActionInput).state;

  it("a wound needle can always be freed: stopping the treatment, a faint or a withdrawn consent do not stop that", () => {
    for (const [why, state] of [
      ["stopped", act(knee, stuck(), { type: "stop_treatment", reason: "the patient asks to stop" } as ActionInput).state],
      ["fainted", (() => { const s = clone(stuck()); s.patient.fainted = true; return s; })()],
      ["consent withdrawn", (() => { const s = clone(stuck()); s.patient.consent.status = "withdrawn"; return s; })()],
    ] as const) {
      expect(needle(state).winding, why).toBe(1080);
      // working the needle is refused as before — it is stuck, and the treatment is over
      expect(perform(knee, state, "nian").attempt.status, why).not.toBe("executed");
      // every way of freeing it is open, and none of them is an unsafe act
      for (const [technique, extra] of [["xun", {}], ["she", {}], ["tan", {}], ["gua", {}], ["an", {}], ["cuo", { motion: { direction: "counterclockwise" } }]] as const) {
        const freed = perform(knee, state, technique, extra);
        expect(freed.attempt.status, `${why}: ${technique}: ${freed.attempt.message}`).toBe("executed");
        expect(freed.attempt.unsafe, `${why}: ${technique}`).toEqual([]);
        expect(Math.abs(needle(freed.state).winding ?? 0), `${why}: ${technique}`).toBeLessThan(1080);
      }
      const back = act(knee, state, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "counterclockwise" } as ActionInput);
      expect(back.attempt.status, `${why}: ${back.attempt.message}`).toBe("executed");
      expect(back.attempt.unsafe, why).toEqual([]);
      expect(needle(back.state).winding, why).toBeUndefined();
      // freed, it comes out without force
      expect(act(knee, back.state, { type: "remove_needle", needleId: NEEDLE }).attempt.unsafe, why).not.toContain("stuck-needle-forced");
    }
    // on a needle that is not wound none of this is an exemption: after a stop, 循 is refused like any other technique
    const stopped = act(knee, start, { type: "stop_treatment", reason: "the patient asks to stop" } as ActionInput).state;
    expect(perform(knee, stopped, "xun").attempt.status).toBe("blocked");
  });

  it("a turn against the winding frees the needle and stops there, and unlocks nothing else", () => {
    const seized = stuck();
    // with a change of depth it is not a freeing turn: the needle is stuck
    expect(act(knee, seized, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", depthCm: 1, rotationDirection: "counterclockwise", rotationDeg: 1, frequencyHz: 0.5, durationSeconds: 1 } as ActionInput).attempt)
      .toMatchObject({ status: "rejected", code: "stuck-needle" });
    // a small turn back is a little freed, and the hand says the needle is still fast: no grip is on record
    const little = act(knee, seized, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "counterclockwise", rotationDeg: 90, frequencyHz: 1, durationSeconds: 1 } as ActionInput);
    expect(needle(little.state).winding).toBe(990);
    expect(little.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)).toMatchObject({ needle: { grasp: false } });
    expect(little.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)!.text).toMatch(/will not turn or lift/);
    // rolled back further than it was wound, it is free — not wound the other way
    const over = perform(knee, perform(knee, start, "cuo").state, "cuo", { motion: { direction: "counterclockwise", cycles: 12, rotationDeg: 180 } });
    expect(needle(over.state).winding).toBeUndefined();
    // and the record says what was taken off the needle, not what was asked for
    expect(over.state.performances!.at(-1)!.effect).toMatchObject({ windingDeg: -360 });
    // the hand that winds a needle with adjust_needle is told what holds it
    const shallow = act(knee, start, { type: "adjust_needle", needleId: NEEDLE, depthCm: 0.5, technique: "none" }).state;
    const wound = act(knee, shallow, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "clockwise" } as ActionInput);
    expect(wound.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)!.text).toMatch(/will not turn or lift/);
    const held = act(knee, shallow, { type: "adjust_needle", needleId: NEEDLE, technique: "rotate", rotationDirection: "clockwise", rotationDeg: 90, frequencyHz: 1, durationSeconds: 3 } as ActionInput);
    expect(needle(held.state).winding).toBe(270);
    const worked = act(knee, held.state, { type: "adjust_needle", needleId: NEEDLE, technique: "lift-thrust" });
    expect(worked.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)).toMatchObject({ needle: { grasp: false } });
    expect(worked.state.evidence.filter((e) => e.kind === "needle-feel").at(-1)!.text).toMatch(/it is the winding that holds it/);
  });

  it("doses by the counts a performance really has, and its defaults are a performance the engine accepts", () => {
    // 进 is two advances: a count does not apply, and changes nothing
    const plain = perform(knee, start, "jin"), counted = perform(knee, start, "jin", { motion: { cycles: 12 } });
    expect(needle(counted.state).response!.stimulation).toBe(needle(plain.state).response!.stimulation);
    expect(counted.state.performances!.at(-1)!.motion.cycles).toBe(2);
    expect(OPERATIVE_TECHNIQUES.find((t) => t.id === "jin")!.controls).not.toContain("cycles");
    // 搜 has room for three rounds: asked for twelve, three are performed, recorded and dosed
    const searched = perform(knee, start, "sou", { motion: { cycles: 12 } });
    expect(searched.state.performances!.at(-1)!.motion.cycles).toBe(3);
    expect(searched.state.performances!.at(-1)!.effect!.dose).toBeCloseTo(0.25 * Math.sqrt(3), 3);
    // every technique performed with the defaults the catalogue serves is accepted (弩 with the wrist of its own grip)
    const withdrawn = act(knee, start, { type: "remove_needle", needleId: NEEDLE }).state;
    for (const t of OPERATIVE_TECHNIQUES) {
      const done = perform(knee, t.context === "removed" ? withdrawn : start, t.id, { motion: t.defaults });
      expect(done.attempt.status, `${t.id}: ${done.attempt.message}`).toBe("executed");
      expect(done.state.performances!.at(-1)!.motion, t.id).toEqual(t.defaults);
    }
    expect(OPERATIVE_TECHNIQUES.find((t) => t.id === "nu")!.defaults).toMatchObject({ grip: "three-finger", wristElevationDeg: 48 });
    // the three-finger hold takes tip-pinch whether it was asked for or is the method's own
    expect(perform(knee, start, "nu", { motion: { gripStyle: "side-pinch" } }).attempt).toMatchObject({ status: "rejected", code: "technique-parameter" });
    // the clock and the record agree, also for the shortest performance
    const quick = perform(knee, start, "tan", { motion: { durationMs: 400 } });
    expect(quick.state.performances!.at(-1)!.effect!.minutes).toBe(0.05);
    expect(now(quick.state) - now(start)).toBeCloseTo(0.05, 6);
  });

  it("finds a needle gone when a technique reaches for it", () => {
    const family = pack.families.get("sg-knee-oa")!;
    const field = clone(family.source.field) as Record<string, unknown>;
    field.events = [{ id: "ev-drop", when: { needlesRetained: { gte: 1 } }, afterMinutes: 1, effects: { needle: { select: "first-inserted", becomes: "dropped-hidden", area: "floor" } } }];
    const resolved = resolveScenario(pack.bundle, { ...family.source, field, variants: new Map(family.source.variants) }, "base");
    if (!resolved.ok) throw new Error("the patched scenario did not resolve");
    const sc = resolved.scenario;
    let s = before(sc, "adjust_needle");
    s = act(sc, s, { type: "wait", minutes: 2 }).state;
    expect(needle(s).location).toMatchObject({ kind: "floor", hidden: true });
    const where = (state: EncounterState) => observeAs(sc, state, "practitioner").equipment.needles.find((x) => x.id === NEEDLE)!.where;
    expect(where(s)).toMatch(/^in the patient/);
    const reached = perform(sc, s, "nian");
    expect(reached.attempt.observations.join(" ")).toMatch(/not where it was placed/);
    // from then on it is known to be gone: the view says so, and there is nothing to feel at it
    expect(where(reached.state)).not.toMatch(/^in the patient/);
    expect(act(sc, reached.state, { type: "check_sensation", needleId: NEEDLE }).attempt).toMatchObject({ status: "rejected", code: "not-inserted" });
  });

  it("judges each working by the plan in force when it was done", () => {
    const item = (state: EncounterState) => evaluateEncounter(knee, state).tracks.procedure!.items.find((i) => i.id === "stimulation-as-planned");
    let s = createEncounter(knee, { seed: 1, techniques: "operative" });
    let proposal: Extract<ActionInput, { type: "propose_plan" }> | null = null;
    for (const request of knee.field.solution) {
      if (request.action.type === "adjust_needle") break;
      const action = request.action.type === "propose_plan" ? (proposal = { ...request.action, plan: { ...request.action.plan, technique: { ...request.action.plan.technique, stimulation: "reinforcing" as const } } }) : request.action;
      s = step(knee, s, { ...request, action }, { strict: true }).state;
    }
    const replan = (state: EncounterState, stimulation: "reducing" | "even") =>
      act(knee, state, { ...proposal!, plan: { ...proposal!.plan, technique: { ...proposal!.plan.technique, stimulation } } }).state;
    // 补 under a reinforcing plan is as planned — and stays so when another plan is proposed afterwards
    const reinforced = perform(knee, s, "bu").state;
    expect(item(reinforced)).toMatchObject({ met: true });
    expect(item(replan(reinforced, "reducing"))).toMatchObject({ met: true });
    // 透天凉 under a reinforcing plan is against it — and a later plan does not make it disappear
    const reduced = perform(knee, s, "tou-tian-liang").state;
    expect(item(reduced)).toMatchObject({ met: false });
    expect(item(replan(reduced, "even"))).toMatchObject({ met: false });
  });

  it("an encounter on the illustrative catalogue refuses the operative catalogue's settings in the words it always used", () => {
    const old = before(knee, "adjust_needle", "illustrative");
    const refused = act(knee, old, { type: "perform_technique", technique: "xun", needleId: NEEDLE, motion: { travelMm: 20 } } as ActionInput).attempt;
    expect(refused).toMatchObject({ status: "rejected", code: "invalid-request" });
    expect(refused.message).toBe("action.motion: Unrecognized key(s) in object: 'travelMm'");
    // and its lookup does not offer them
    const context = { library: new EncounterSession(knee).library(), view: observeAs(knee, old, "practitioner"), skills: [] };
    const served = lookupTool.run({ topic: "techniques" }, context).output as Record<string, any>;
    expect("travelMm" in served.motionSchema.properties).toBe(false);
    expect("travelMm" in served.parameters).toBe(false);
  });
});

describe("a record made on the operative catalogue, kept", () => {
  /**
   * fixtures/operative-technique-log.json: the knee encounter up to its first needle, then that needle twirled, wound
   * until it is stuck, refused, freed three ways, taken through 烧山火, asked about, reinforced, withdrawn and its hole
   * closed. The engine that wrote it is the engine that must replay it: a change to what a technique does is a
   * change to this file, made on purpose (ACUCRAFT_UPDATE_FIXTURES=1 writes it again).
   */
  const path = fileURLToPath(new URL("./fixtures/operative-technique-log.json", import.meta.url));
  const after: ActionInput[] = [
    { type: "perform_technique", technique: "nian", needleId: NEEDLE },
    { type: "perform_technique", technique: "cuo", needleId: NEEDLE },
    { type: "perform_technique", technique: "cuo", needleId: NEEDLE },
    { type: "perform_technique", technique: "ti", needleId: NEEDLE },
    { type: "perform_technique", technique: "xun", needleId: NEEDLE },
    { type: "perform_technique", technique: "she", needleId: NEEDLE },
    { type: "perform_technique", technique: "cuo", needleId: NEEDLE, motion: { direction: "counterclockwise" } },
    { type: "perform_technique", technique: "shao-shan-huo", needleId: NEEDLE, motion: { phaseCycles: [3, 3, 3] } },
    { type: "check_sensation", needleId: NEEDLE },
    { type: "adjust_needle", needleId: NEEDLE, technique: "bu" },
    { type: "remove_needle", needleId: NEEDLE },
    { type: "perform_technique", technique: "men", needleId: NEEDLE },
  ] as ActionInput[];

  function record(): EncounterLog {
    const session = new EncounterSession(knee, { seed: 1, techniques: "operative" });
    for (const request of knee.field.solution) { if (request.action.type === "adjust_needle") break; session.act(request.action as ActionInput, request.actor); }
    for (const action of after) session.act(action);
    return session.log({ clinicalcraft: CLINICALCRAFT_REV }, { agent: "operative fixture" });
  }

  it("replays to the state it was saved with, and that state is what the catalogue says it should be", () => {
    if (process.env.ACUCRAFT_UPDATE_FIXTURES) writeFileSync(path, `${JSON.stringify(record(), null, 1)}\n`);
    const log = JSON.parse(readFileSync(path, "utf8")) as EncounterLog;
    expect(log.techniques).toBe("operative");
    const { state } = replayLog(knee, log);
    expect(digest(state)).toBe(log.finalDigest);
    // what today's engine makes of the same requests is the same record
    expect(record().finalDigest).toBe(log.finalDigest);
    const done = state.attempts.filter((a) => a.request.actor === "practitioner").slice(-after.length);
    expect(done.map((a) => [a.request.action.type === "perform_technique" ? a.request.action.technique : a.request.action.type, a.status, a.code ?? null])).toEqual([
      ["nian", "executed", null], ["cuo", "executed", null], ["cuo", "executed", null], ["ti", "rejected", "stuck-needle"], ["xun", "executed", null], ["she", "executed", null],
      ["cuo", "executed", null], ["shao-shan-huo", "executed", null], ["check_sensation", "executed", null], ["adjust_needle", "executed", null], ["remove_needle", "executed", null], ["men", "executed", null],
    ]);
    const n = state.needles[NEEDLE]!;
    expect(n).toMatchObject({ holeClosed: true, bleeding: false, location: { kind: "hand" } });
    expect(n.winding).toBeUndefined();
    expect(state.performances!.map((p) => [p.technique, p.effect!.windingDeg, p.effect!.loosenedDeg, p.effect!.reading])).toEqual([
      ["nian", 0, 0, "even"], ["cuo", 360, 0, null], ["cuo", 360, 0, null], ["xun", 0, 120, null], ["she", 0, 240, null], ["cuo", -360, 0, null], ["shao-shan-huo", 0, 0, "reinforcing"], ["men", 0, 0, "reinforcing"],
    ]);
    expect(n.events.filter((e) => e.reading).map((e) => e.reading)).toEqual(["even", "reinforcing", "reinforcing"]);
    expect(done.every((a) => a.unsafe.length === 0)).toBe(true);
  });
});
