import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assessmentSupport,
  caseSupport,
  clone,
  createEncounter,
  DEQI_THRESHOLD,
  digest,
  needleAudit,
  needleEvidence,
  observeAs,
  patternSupport,
  referenceLibrary,
  resolveScenario,
  showsDeqi,
  step,
  STIMULATION,
  STIMULATION_TOLERANCE,
  type ActionInput,
  type ActionRequestInput,
  type EncounterState,
  type NeedleResponseClaim,
  type Scenario,
} from "@acucraft/core";
import { lookup } from "@acucraft/agent";
import { loadContentPack, requireScenario, scenarioIds } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";
import { episodeMarkdown } from "./report.js";

/**
 * Evidence (docs/EVIDENCE.md): what is obtained enters a ledger under a stable id; a pattern differentiation and a
 * recorded needle response name the ids they rest on; what they are worth is read from the field — the findings' signs,
 * the tissue's response — never from the claim.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");
const hotKnee = requireScenario(pack, "sg-knee-oa/hot-knee");
const back = requireScenario(pack, "sg-low-back-pain/base");

let n = 0;
const req = (action: ActionInput, actor = "practitioner"): ActionRequestInput => ({ requestId: `e-${++n}`, actor, patient: "patient", action });
const act = (sc: Scenario, s: EncounterState, action: ActionInput, actor = "practitioner") => step(sc, s, req(action, actor), { strict: true });

/** The reference trajectory, strictly, up to (not including) the `nth` action that `stop` picks. */
function ref(sc: Scenario, stop: (a: ActionInput) => boolean, nth = 1): EncounterState {
  let s = createEncounter(sc, { seed: 1 });
  let seen = 0;
  for (const r of sc.field.solution) {
    if (stop(r.action as ActionInput) && ++seen === nth) return s;
    const res = step(sc, s, r, { strict: true });
    if (res.attempt.status !== "executed" && res.attempt.status !== "partial") throw new Error(`${r.requestId}: ${res.attempt.message}`);
    s = res.state;
  }
  return s;
}
const full = (sc: Scenario): EncounterState => ref(sc, () => false);
const beforeType = (sc: Scenario, type: ActionInput["type"], nth = 1) => ref(sc, (a) => a.type === type, nth);
/** The knee encounter with every needle in, worked and asked about as the reference does: at the first monitor after them. */
const kneeNeedled = () => ref(knee, (a) => a.type === "monitor");

/** A variant of a family with a field patch applied on top. */
function patched(id: string, patch: (field: Record<string, unknown>) => void) {
  const [familyId, variantId] = id.split("/");
  const fam = pack.families.get(familyId!)!;
  const field = clone(fam.source.field) as Record<string, unknown>;
  patch(field);
  return resolveScenario(pack.bundle, { ...fam.source, field, variants: new Map(fam.source.variants) }, variantId!);
}

describe("the evidence ledger", () => {
  it("enters every answer, finding, record, reading and observation once, under a stable id", () => {
    let s = createEncounter(knee, { seed: 1 });
    expect(s.evidence).toEqual([]);
    s = act(knee, s, { type: "ask", itemId: "hx-weather" }).state;
    s = act(knee, s, { type: "ask", itemId: "hx-weather" }).state; // asked again: the same evidence
    s = act(knee, s, { type: "ask", text: "What makes it worse or better?" }).state; // free text: the item's own id
    s = act(knee, s, { type: "move", to: { fixture: "consult-terminal" } }).state;
    s = act(knee, s, { type: "review_result", investigationId: "inv-xray" }).state;
    s = act(knee, s, { type: "move", to: { person: "patient" } }).state;
    s = act(knee, s, { type: "examine", text: "Inspect the tongue" }).state;
    s = act(knee, s, { type: "check_vitals" }).state;
    s = act(knee, s, { type: "observe" }).state;
    s = act(knee, s, { type: "check_vitals" }).state;
    expect(s.evidence.map((e) => [e.id, e.kind])).toEqual([
      ["hx-weather", "history"],
      ["hx-pattern", "history"],
      ["inv-xray.visit-1", "record"],
      ["ex-tongue", "exam"],
      ["vitals-1", "vitals"],
      ["obs-1", "observation"],
      ["vitals-2", "vitals"],
    ]);
    expect(s.evidence.every((e) => e.by === "practitioner" && e.visit === 1 && e.text.length > 0)).toBe(true);
    // the practitioner sees what was obtained with the id of each item — what a conclusion may name
    const v = observeAs(knee, s, "practitioner");
    expect(v.record.history.map((h) => h.id)).toEqual(["hx-weather", "hx-pattern"]);
    expect(v.record.examination.map((e) => e.id)).toEqual(["ex-tongue"]);
    expect(v.record.results.map((r) => r.id)).toEqual(["inv-xray.visit-1"]);
    expect(v.record.vitals.map((x) => x.id)).toEqual(["vitals-1", "vitals-2"]);
    expect(v.record.observations.map((o) => o.id)).toEqual(["obs-1"]);
  });

  it("examines the finding a request names when several match it equally", () => {
    // "Inspect the tongue" also matches a general inspection: the tongue is what was asked for
    for (const id of scenarioIds(pack).filter((x) => x.endsWith("/base"))) {
      const sc = requireScenario(pack, id);
      let s = act(sc, createEncounter(sc, { seed: 1 }), { type: "move", to: { person: "patient" } }).state;
      s = act(sc, s, { type: "examine", text: "Inspect the tongue" }).state;
      expect(s.evidence.map((e) => e.id), id).toEqual(["ex-tongue"]);
    }
  });
});

describe("pattern differentiation is linked to evidence", () => {
  const assess = (pattern: string, patternEvidence: string[]): ActionInput => ({ type: "assess", diagnoses: ["knee-osteoarthritis"], pattern, patternEvidence, redFlags: [] });

  it("refuses a pattern that names no evidence, or evidence that was never obtained", () => {
    let s = createEncounter(knee, { seed: 1 });
    const none = act(knee, s, { type: "assess", diagnoses: ["knee-osteoarthritis"], pattern: "wind-cold-damp-bi", redFlags: [] });
    expect(none.attempt.status).toBe("rejected");
    expect(none.attempt.code).toBe("no-evidence");
    expect(none.state.assessments).toEqual([]);
    // the tongue was never looked at: it cannot be cited, however plausible the citation
    s = act(knee, s, { type: "ask", itemId: "hx-weather" }).state;
    const unseen = act(knee, s, assess("wind-cold-damp-bi", ["hx-weather", "ex-tongue"]));
    expect(unseen.attempt.code).toBe("evidence-not-obtained");
    expect(unseen.attempt.message).toMatch(/ex-tongue/);
    expect(unseen.attempt.message).not.toMatch(/hx-weather/);
    // evidence without a pattern to support is not an assessment either
    expect(act(knee, s, { type: "assess", diagnoses: ["knee-osteoarthritis"], patternEvidence: ["hx-weather"], redFlags: [] }).attempt.code).toBe("invalid");
    // a biomedical assessment alone needs none
    expect(act(knee, s, { type: "assess", diagnoses: ["knee-osteoarthritis"], redFlags: [] }).attempt.status).toBe("executed");
    const ok = act(knee, s, assess("wind-cold-damp-bi", ["hx-weather", "hx-weather"]));
    expect(ok.attempt.status).toBe("executed");
    expect(ok.state.assessments[0]).toMatchObject({ pattern: "wind-cold-damp-bi", patternEvidence: ["hx-weather"], visit: 1 });
    expect(observeAs(knee, ok.state, "practitioner").assessment).toMatchObject({ pattern: "wind-cold-damp-bi", patternEvidence: ["hx-weather"] });
  });

  it("reads a differentiation from what the findings it names show, not from its name", () => {
    // the reference: worse in cold and damp, eased by warmth, heavy; feels the cold; stiff; pale tongue, greasy coat; deep slow pulse
    const s = beforeType(knee, "decide");
    const sup = assessmentSupport(knee, s, s.assessments[0]!)!;
    expect(sup.key.map((x) => x.sign)).toEqual(["pain-worse-cold-damp", "pain-better-warmth", "heaviness"]);
    expect(sup.key.every((x) => x.evidence.join() === "hx-weather")).toBe(true);
    expect(sup.supporting.map((x) => x.sign)).toEqual(expect.arrayContaining(["aversion-to-cold", "tongue-pale", "coat-white-greasy", "pulse-deep"]));
    expect(sup.methods).toEqual(expect.arrayContaining(["inquiry", "tongue", "pulse"]));
    expect(sup).toMatchObject({ sufficient: true, contradicted: false, supported: true, idle: [] });
    // the same pattern on one finding is a name, not a differentiation: one key sign short of three in all
    const thin = patternSupport(knee, "wind-cold-damp-bi", ["hx-general-tcm", "ex-tongue"], s.evidence.map((e) => e.id));
    expect(thin.key).toEqual([]);
    expect(thin.supported).toBe(false);
    // a finding that shows none of the pattern's signs supports nothing
    expect(patternSupport(knee, "wind-cold-damp-bi", ["hx-weather", "hx-meds"]).idle).toEqual(["hx-meds"]);
    // a pattern the case's findings do not show cannot be made to rest on them
    expect(patternSupport(knee, "damp-heat-bi", s.evidence.map((e) => e.id)).supported).toBe(false);
  });

  it("counts what speaks against a pattern wherever it was found, cited or not", () => {
    // the hot knee: the weather still makes it worse — and the joint is hot, red and swollen, with fever
    let s = createEncounter(hotKnee, { seed: 1 });
    for (const itemId of ["hx-weather", "hx-general-tcm", "hx-pattern", "hx-swelling", "hx-systemic"]) s = act(hotKnee, s, { type: "ask", itemId }).state;
    const cited = ["hx-weather", "hx-general-tcm", "hx-pattern"];
    const r = act(hotKnee, s, assess("wind-cold-damp-bi", cited));
    expect(r.attempt.status).toBe("executed"); // recorded as claimed: the engine gives no verdict
    const sup = assessmentSupport(hotKnee, r.state, r.state.assessments[0]!)!;
    expect(sup.sufficient).toBe(true);
    expect(sup.against.map((x) => x.sign)).toEqual(["joint-hot-red-swollen", "fever"]);
    expect(sup.against.flatMap((x) => x.evidence)).toEqual(["hx-swelling", "hx-systemic"]);
    expect(sup).toMatchObject({ contradicted: true, supported: false });
    // evidence obtained after an assessment does not count against it
    const early = act(hotKnee, createEncounter(hotKnee, { seed: 1 }), { type: "ask", itemId: "hx-weather" }).state;
    let later = act(hotKnee, early, assess("wind-cold-damp-bi", ["hx-weather"])).state;
    later = act(hotKnee, later, { type: "ask", itemId: "hx-swelling" }).state;
    expect(assessmentSupport(hotKnee, later, later.assessments[0]!)!.against).toEqual([]);
  });

  it("shows its reading in teaching mode only, and never the hidden mapping", () => {
    const steps = knee.field.solution.slice(0, knee.field.solution.findIndex((r) => r.action.type === "assess") + 1);
    const play = (mode: "assessment" | "teaching") => {
      let s = createEncounter(knee, { seed: 1, mode });
      let last = null as ReturnType<typeof step> | null;
      for (const r of steps) {
        last = step(knee, s, r, { strict: true });
        s = last.state;
      }
      return last!;
    };
    expect(play("assessment").attempt.observations.join(" ")).not.toMatch(/Teaching|key sign/);
    const taught = play("teaching").attempt.observations.join(" ");
    expect(taught).toMatch(/3 key sign\(s\) of wind-cold-damp-bi/);
    expect(taught).toMatch(/pain-worse-cold-damp \(hx-weather\)/);
    // public: the signs and each pattern's criteria. Hidden: which finding of this case shows which sign
    const lib = referenceLibrary(knee);
    expect(lib.vocabulary.signs.length).toBeGreaterThan(50);
    expect(lib.vocabulary.patterns.find((p) => p.id === "wind-cold-damp-bi")!.criteria!.key).toContain("pain-worse-cold-damp");
    expect(JSON.stringify(lib)).not.toMatch(/hx-weather|ex-tongue/);
    const view = JSON.stringify(observeAs(knee, play("assessment").state, "practitioner"));
    expect(view).not.toMatch(/pain-worse-cold-damp|tongue-pale|pulse-deep/);
    // the lookup an agent uses: the criteria in words, with the rule
    const p = lookup(lib, { topic: "pattern", id: "wind-cold-damp-bi" }) as { key: string[]; against: string[]; rule: string };
    expect(p.key.join(" ")).toMatch(/cold or damp weather \[inquiry\]/);
    expect(p.against.join(" ")).toMatch(/hot, red, swollen joint/i);
    expect(p.rule).toMatch(/at least 1 key sign\(s\) of the pattern and 3 of its signs in all/);
    expect((lookup(lib, { topic: "pattern" }) as { patterns: unknown[] }).patterns).toHaveLength(13);
  });

  it("keeps each scenario's lists true to its own findings", () => {
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      const phase = sc.field.visits[0]!.phase;
      for (const p of sc.field.evaluation.patterns.defensible) expect(caseSupport(sc, p, phase).supported, `${id}: ${p} (defensible)`).toBe(true);
      for (const p of sc.field.evaluation.patterns.implausible) expect(caseSupport(sc, p, phase).supported, `${id}: ${p} (implausible)`).toBe(false);
    }
    // a pattern its findings cannot support is not accepted as defensible; nor is one they speak against
    const unsupported = patched("sg-knee-oa/base", (f) => ((f.evaluation as { patterns: { defensible: string[] } }).patterns.defensible = ["damp-heat-bi"]));
    expect(unsupported.ok).toBe(false);
    expect(!unsupported.ok && unsupported.issues.map((i) => i.message).join(" ")).toMatch(/damp-heat-bi is listed as defensible, but the findings of this case show only 0 key/);
    const against = patched("sg-insomnia/base", (f) => ((f.evaluation as { patterns: { defensible: string[] } }).patterns.defensible = ["heart-kidney-disharmony"]));
    expect(!against.ok && against.issues.map((i) => i.message).join(" ")).toMatch(/heart-kidney-disharmony is listed as defensible, but the findings of this case speak against it \(tongue-pale, tongue-swollen-toothmarked\)/);
    // the mapping names findings of the case and signs of the vocabulary
    const unknown = patched("sg-knee-oa/base", (f) => ((f.evaluation as { signs: Record<string, string[]> }).signs = { "hx-nothing": ["tongue-pale"], "ex-tongue": ["tongue-blue"] }));
    expect(!unknown.ok && unknown.issues.map((i) => i.message).join(" ")).toMatch(/no history item, exam finding or record hx-nothing.*unknown sign tongue-blue/);
  });

  it("scores the link apart from the conclusion", () => {
    // the reference: a defensible pattern that rests on its evidence and draws on tongue and pulse
    const good = evaluateEncounter(knee, full(knee));
    const item = (r: ReturnType<typeof evaluateEncounter>, id: string) => r.tracks.reasoning.items.find((i) => i.id === id);
    expect(item(good, "pattern")).toMatchObject({ met: true });
    expect(item(good, "pattern-evidence")).toMatchObject({ met: true, weight: 2 });
    expect(item(good, "four-examinations")).toMatchObject({ met: true });
    expect(good.evidence.pattern).toMatchObject({ pattern: "wind-cold-damp-bi", supported: true });
    const citing = (patternEvidence: string[]) => {
      let s = createEncounter(knee, { seed: 1 });
      for (const r of knee.field.solution) s = step(knee, s, r.action.type === "assess" ? { ...r, action: { ...r.action, patternEvidence } } : r, { strict: true }).state;
      return evaluateEncounter(knee, s);
    };
    // the same defensible pattern on findings that show none of its key signs: the right name, no differentiation
    const thin = citing(["hx-general-tcm", "ex-tongue"]);
    expect(thin.primary.status).toBe("success"); // not a critical error: a weaker reasoning score
    expect(item(thin, "pattern")).toMatchObject({ met: true });
    expect(item(thin, "pattern-evidence")).toMatchObject({ met: false });
    expect(item(thin, "pattern-evidence")!.detail).toMatch(/0 key sign\(s\), 3 supporting \(aversion-to-cold, tongue-pale, coat-white-greasy\); needs 1 key and 3 in all/);
    expect(thin.tracks.reasoning.score!).toBeLessThan(good.tracks.reasoning.score!);
    // on the weather question alone: its three key signs are there, the tongue and the pulse are not
    const narrow = citing(["hx-weather"]);
    expect(item(narrow, "pattern-evidence")).toMatchObject({ met: true });
    expect(item(narrow, "four-examinations")).toMatchObject({ met: false, detail: "inquiry" });
    // on a finding that has nothing to do with it
    const idle = citing(["hx-meds"]);
    expect(item(idle, "pattern-evidence")).toMatchObject({ met: false });
    expect(item(idle, "pattern-evidence")!.detail).toMatch(/cited without showing it: hx-meds/);
    expect(episodeMarkdown(good)).toMatch(/## Evidence links[\s\S]*Pattern differentiation: `wind-cold-damp-bi`.*rests on its evidence[\s\S]*\| pain-worse-cold-damp \| key \| hx-weather \|/);
  });
});

describe("deqi is linked to evidence", () => {
  it("puts nothing on record for a needle until someone asks or works it", () => {
    // the first needle is in; the reference has not yet worked it
    let s = beforeType(knee, "adjust_needle");
    const first = () => observeAs(knee, s, "practitioner").needling[0]!;
    expect(first()).toMatchObject({ needle: "pack-a.1", target: "ST35:right", inPlace: true, manipulations: 0, evidence: [], recorded: null });
    expect(s.needles["pack-a.1"]!.response).toMatchObject({ stimulation: STIMULATION.insertion, manipulations: 0 });
    // asked: the patient's words, and the qualities they named — evidence of this needle
    const asked = act(knee, s, { type: "check_sensation", needleId: "pack-a.1" });
    s = asked.state;
    expect(asked.attempt.observations.join(" ")).toMatch(/evidence sense-1/);
    expect(first().evidence).toEqual([expect.objectContaining({ id: "sense-1", from: "patient", grasp: null, unasked: false })]);
    // worked: what the operator feels in the needle
    const worked = act(knee, s, { type: "adjust_needle", needleId: "pack-a.1", technique: "rotate" });
    s = worked.state;
    expect(worked.attempt.observations.join(" ")).toMatch(/evidence feel-1/);
    expect(first()).toMatchObject({ manipulations: 1 });
    expect(first().evidence[1]).toMatchObject({ id: "feel-1", from: "operator", qualities: [] });
    expect(typeof first().evidence[1]!.grasp).toBe("boolean");
    // the view never says whether that is deqi: the field's response stays hidden
    expect(JSON.stringify(observeAs(knee, s, "practitioner"))).not.toMatch(/intensity|arrivedAt|"deqi":/);
    // a needle that is not in the patient has nothing to feel at it
    expect(act(knee, s, { type: "check_sensation", needleId: "pack-a.5" }).attempt.code).toBe("not-inserted");
  });

  it("answers from the tissue: a muscle belly holds a worked needle, the layer under the skin does not", () => {
    const s = kneeNeedled();
    const audit = Object.fromEntries(needleAudit(knee, s).map((a) => [a.target, a]));
    // ST36 and SP9, lifted and thrust in muscle: gripped, and felt by the patient
    for (const target of ["ST36:right", "SP9:right"]) {
      expect(audit[target]!.field).toMatchObject({ tipTissue: "muscle", arrived: true, manipulations: 1 });
      expect(audit[target]!.evidence.every((e) => e.deqi)).toBe(true);
    }
    // the shallow Ashi needle at the joint line was asked about and not worked: nothing there
    const ashi = audit["ashi:ashi-medial-joint-line"]!;
    expect(ashi.field).toMatchObject({ tipTissue: "subcutaneous", arrived: false, manipulations: 0 });
    expect(ashi.evidence).toEqual([expect.objectContaining({ kind: "sensation", deqi: false })]);
    expect(s.evidence.find((e) => e.id === ashi.evidence[0]!.id)!.needle!.qualities).toEqual([]);
    // what the patient names at ST36 are sensations of deqi
    const st36 = needleEvidence(s, "pack-a.3").find((e) => e.kind === "sensation")!;
    expect(st36.needle!.qualities.length).toBeGreaterThanOrEqual(2);
    expect(showsDeqi(knee, st36)).toBe(true);
  });

  it("never rewards stronger stimulation: a shallow tip stays unanswered, and working it on hurts", () => {
    let s = kneeNeedled();
    const id = "pack-a.5"; // tip in the subcutaneous layer
    const feels: (boolean | null)[] = [];
    const intensity: number[] = [];
    let complained = false;
    for (let i = 0; i < 4; i++) {
      s = act(knee, s, { type: "move", to: { region: "knee-leg", side: "right" } }).state;
      const r = act(knee, s, { type: "adjust_needle", needleId: id, technique: "lift-thrust" });
      expect(r.attempt.status).toBe("executed");
      s = r.state;
      feels.push(needleEvidence(s, id).filter((e) => e.kind === "needle-feel").at(-1)!.needle!.grasp);
      intensity.push(s.needles[id]!.response!.intensity);
      complained ||= s.patient.feedback.some((f) => f.kind === "too-strong" && f.needleId === id);
      // three times is within what a patient tolerates; the fourth is not
      expect(complained, `after ${i + 1}`).toBe(i === 3);
    }
    expect(feels).toEqual([false, false, false, false]);
    expect(Math.max(...intensity)).toBeLessThan(DEQI_THRESHOLD);
    // the response stops growing once the tissue has had its stimulus: more work adds nothing
    expect(intensity[2]).toBe(intensity[1]);
    expect(intensity[3]).toBe(intensity[2]);
    const r = s.needles[id]!.response!;
    expect(r.stimulation).toBeGreaterThan(STIMULATION_TOLERANCE);
    expect(r).toMatchObject({ overstimulated: true, deqi: false, arrivedAt: null, noxious: "sharp-pain" });
    expect(s.patient.feedback.find((f) => f.kind === "too-strong")).toMatchObject({ abnormal: true, needleId: id });
    // asked now, the patient speaks of pain: not a sensation of deqi
    s = act(knee, s, { type: "check_sensation", needleId: id }).state;
    const said = needleEvidence(s, id).at(-1)!;
    expect(said.needle!.qualities).toEqual(["sharp-pain"]);
    expect(showsDeqi(knee, said)).toBe(false);
  });

  it("is reached by depth, not force: the same needle taken into the muscle is held at once", () => {
    // the reference's Ashi needle in the back: nothing at 1.5 cm, its tip just short of the muscle
    let s = ref(back, (a) => a.type === "adjust_needle" && a.depthCm !== undefined);
    const id = "pack-a.5";
    expect(needleEvidence(s, id).map((e) => [e.kind, showsDeqi(back, e)])).toEqual([["needle-feel", false], ["sensation", false]]);
    const deeper = act(back, s, { type: "adjust_needle", needleId: id, depthCm: 2.0, technique: "lift-thrust" });
    s = deeper.state;
    expect(deeper.attempt.observations.join(" ")).toMatch(/gripped/);
    expect(s.needles[id]!.response).toMatchObject({ deqi: true, manipulations: 2, overstimulated: false });
    expect(s.needles[id]!.insertion).toMatchObject({ depthCm: 2.0, tipTissue: "muscle" });
    // a strong response is spoken of unasked, and that too is evidence of this needle
    const unasked = needleEvidence(s, id).at(-1)!;
    expect(unasked).toMatchObject({ kind: "sensation", needle: { volunteered: true } });
    expect(showsDeqi(back, unasked)).toBe(true);
    expect(s.patient.feedback.at(-1)).toMatchObject({ kind: "deqi", abnormal: false, needleId: id });
  });

  it("is deterministic, and the patient's own: the same at every seed, different from site to site", () => {
    expect(digest(kneeNeedled())).toBe(digest(kneeNeedled()));
    const responses = (sc: Scenario, seed: number) => {
      let s = createEncounter(sc, { seed });
      for (const r of sc.field.solution) {
        if (r.action.type === "monitor") break;
        s = step(sc, s, r).state;
      }
      return Object.fromEntries(Object.values(s.needles).filter((x) => x.response).map((x) => [x.id, x.response!.intensity]));
    };
    const a = responses(knee, 1);
    expect(Object.keys(a)).toHaveLength(5);
    // how her tissue answers is part of the patient, like her anatomy: the encounter's seed does not change it
    expect(responses(knee, 7)).toEqual(a);
    // ST36 and SP9: both in muscle, both lifted and thrust once — and not the same
    expect(a["pack-a.3"]).not.toBe(a["pack-a.4"]);
    // within a fifth either way of what the tissue and the stimulus give
    for (const x of Object.values(a)) expect(x).toBeLessThanOrEqual(1.2);
    for (const id of ["pack-a.3", "pack-a.4"]) expect(a[id]! / 0.8).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it("leaves the reference trajectories true at any seed", () => {
    // what a reference recorded of its needles names evidence by id: it must be the same evidence in every run
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      for (const seed of [2, 7]) {
        let s = createEncounter(sc, { seed });
        for (const r of sc.field.solution) {
          const res = step(sc, s, r, { strict: true });
          expect(["executed", "partial"], `${id} seed ${seed} ${r.requestId}: ${res.attempt.message}`).toContain(res.attempt.status);
          s = res.state;
        }
        const report = evaluateEncounter(sc, s);
        expect(report.primary.status, `${id} seed ${seed}`).toBe("success");
        expect(report.evidence.needles.every((x) => x.verdict === "supported" || x.verdict === "not-sought"), `${id} seed ${seed}`).toBe(true);
      }
    }
  });

  it("takes a question that names a needle's point as a question about that needle", () => {
    let s = kneeNeedled();
    const before = s.evidence.length;
    // how are you: an answer about the needles in general — evidence of none of them
    const general = act(knee, s, { type: "say", to: "patient", text: "How does it feel now?" });
    s = general.state;
    expect(s.evidence.length).toBe(before);
    expect(general.attempt.observations.join(" ")).toMatch(/check_sensation/);
    expect(s.utterances.at(-1)!.text).toMatch(/dull ache at some of them/);
    const named = act(knee, s, { type: "say", to: "patient", text: "What do you feel at ST36?" });
    s = named.state;
    expect(s.evidence.length).toBe(before + 1);
    expect(s.evidence.at(-1)).toMatchObject({ kind: "sensation", ref: "pack-a.3", needle: { id: "pack-a.3", volunteered: false } });
    // a question about the history still goes to the history
    s = act(knee, s, { type: "ask", text: "Do you have any allergies?" }).state;
    expect(s.evidence.at(-1)).toMatchObject({ kind: "history", id: "hx-allergies" });
    expect(s.evidence.length).toBe(before + 2);
  });

  it("refuses a recorded response that names no evidence of that needle", () => {
    const s = beforeType(knee, "document");
    const doc = (responses: NeedleResponseClaim[]) => act(knee, s, { type: "document", record: { needling: { responses } } });
    const st36 = needleEvidence(s, "pack-a.3").map((e) => e.id);
    const ashi = needleEvidence(s, "pack-a.5").map((e) => e.id);
    expect(st36.length).toBeGreaterThan(0);
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: [] }]).attempt).toMatchObject({ status: "rejected", code: "no-evidence" });
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: [] }]).attempt.message).toContain(st36[0]);
    expect(doc([{ needle: "pack-a.3", response: "none", evidence: [] }]).attempt.code).toBe("no-evidence");
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: ["sense-99"] }]).attempt.code).toBe("evidence-not-obtained");
    // another needle's evidence, or a history answer, is not evidence of this needle
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: ashi }]).attempt.code).toBe("evidence-mismatch");
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: ["hx-weather"] }]).attempt.code).toBe("evidence-mismatch");
    expect(doc([{ needle: "pack-a.3", response: "not-sought", evidence: st36 }]).attempt.code).toBe("invalid");
    expect(doc([{ needle: "pack-b.1", response: "not-sought", evidence: [] }]).attempt.code).toBe("unknown-id");
    expect(doc([{ needle: "pack-a.3", response: "deqi", evidence: st36 }, { needle: "pack-a.3", response: "not-sought", evidence: [] }]).attempt.code).toBe("invalid");
    const ok = doc([{ needle: "pack-a.3", response: "deqi", evidence: st36 }, { needle: "pack-a.5", response: "none", evidence: ashi }, { needle: "pack-a.1", response: "not-sought", evidence: [] }]);
    expect(ok.attempt.status).toBe("executed");
    expect(observeAs(knee, ok.state, "practitioner").needling.map((x) => x.recorded)).toEqual(["not-sought", null, "deqi", null, "none"]);
  });

  it("compares what is recorded with what was observed and with what the tissue did", () => {
    const s = beforeType(knee, "document");
    const ev = (id: string) => needleEvidence(s, id).map((e) => e.id);
    // the knee eyes rotated and not held; ST36 and SP9 lifted, thrust and held; the Ashi needle asked about, nothing
    const recorded: NeedleResponseClaim[] = [
      { needle: "pack-a.3", response: "deqi", evidence: ev("pack-a.3") }, // supported
      { needle: "pack-a.2", response: "deqi", evidence: ev("pack-a.2") }, // overclaimed: its evidence shows none
      { needle: "pack-a.4", response: "none", evidence: ev("pack-a.4") }, // contradicted: its own evidence shows deqi
      { needle: "pack-a.1", response: "not-sought", evidence: [] }, // it was worked and not held: nothing to contradict
    ];
    const r = act(knee, s, { type: "document", record: { needling: { responses: recorded } } });
    expect(r.attempt.status).toBe("executed"); // recorded as claimed
    const verdicts = Object.fromEntries(needleAudit(knee, r.state).map((a) => [a.needle, a.verdict]));
    expect(verdicts).toEqual({ "pack-a.1": "not-sought", "pack-a.2": "overclaimed", "pack-a.3": "supported", "pack-a.4": "contradicted", "pack-a.5": "unrecorded" });
    // a later record replaces an earlier one, needle by needle; "not sought" of a needle that was held is contradicted too
    const fixed = act(knee, r.state, {
      type: "document",
      record: { needling: { responses: [{ needle: "pack-a.2", response: "none", evidence: [ev("pack-a.2").at(-1)!] }, { needle: "pack-a.5", response: "none", evidence: ev("pack-a.5") }, { needle: "pack-a.4", response: "not-sought", evidence: [] }] } },
    });
    const again = Object.fromEntries(needleAudit(knee, fixed.state).map((a) => [a.needle, a.verdict]));
    expect(again).toEqual({ "pack-a.1": "not-sought", "pack-a.2": "supported", "pack-a.3": "supported", "pack-a.4": "contradicted", "pack-a.5": "supported" });
  });

  it("calls a negative record out of date when the needle was moved after the check", () => {
    // the back's Ashi needle: asked about at 1.5 cm (nothing), then taken into the muscle without working or asking
    let s = ref(back, (a) => a.type === "adjust_needle" && a.depthCm !== undefined);
    const id = "pack-a.5";
    const checked = needleEvidence(s, id).at(-1)!.id;
    s = act(back, s, { type: "adjust_needle", needleId: id, depthCm: 2.0, technique: "none" }).state;
    expect(needleEvidence(s, id).at(-1)!.id).toBe(checked); // moving a needle is not evidence of its response
    expect(s.needles[id]!.response!.arrivedAt).not.toBeNull();
    s = act(back, s, { type: "document", record: { needling: { responses: [{ needle: id, response: "none", evidence: [checked] }] } } }).state;
    expect(needleAudit(back, s).find((a) => a.needle === id)).toMatchObject({ verdict: "out-of-date", field: { arrived: true } });
  });

  it("holds a sensation that is not deqi apart: a nerve met by the needle is evidence against, said unasked", () => {
    const nausea = requireScenario(pack, "sg-chemo-nausea/base");
    // the first PC6 needle, driven on past the tendons to the median nerve
    let s = ref(nausea, (a) => a.type === "insert_needle");
    const first = nausea.field.solution.find((r) => r.action.type === "insert_needle")!.action as Extract<ActionInput, { type: "insert_needle" }>;
    const r = act(nausea, s, { ...first, depthCm: 2.2 });
    s = r.state;
    expect(r.attempt.status).toBe("executed");
    expect(r.attempt.unsafe).toContain("nerve-contact");
    const said = needleEvidence(s, first.needleId);
    expect(said).toEqual([expect.objectContaining({ kind: "sensation", needle: expect.objectContaining({ qualities: ["electric"], volunteered: true }) })]);
    expect(showsDeqi(nausea, said[0]!)).toBe(false);
    expect(s.needles[first.needleId]!.response).toMatchObject({ noxious: "electric", deqi: false });
    // recorded as deqi on that report: an overclaim, whatever it is called
    s = act(nausea, s, { type: "document", record: { needling: { responses: [{ needle: first.needleId, response: "deqi", evidence: [said[0]!.id] }] } } }).state;
    expect(needleAudit(nausea, s)[0]).toMatchObject({ verdict: "overclaimed" });
  });

  it("gives nothing away about a needle that fell out unseen", () => {
    // the first needle, worked and felt, drops to the floor during retention: nobody saw it
    const r = patched("sg-knee-oa/base", (f) => {
      f.events = [{ id: "ev-drop", when: { needlesRetained: { gte: 5 } }, afterMinutes: 1, effects: { needle: { select: "first-inserted", becomes: "dropped-hidden", area: "floor" } } }];
    });
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join("; "));
    const sc = r.scenario;
    let s = ref(sc, (a) => a.type === "wait");
    s = act(sc, s, { type: "wait", minutes: 2 }).state;
    const fallen = Object.values(s.needles).find((x) => x.location.kind === "floor")!;
    expect(fallen.id).toBe("pack-a.1");
    const before = needleEvidence(s, fallen.id).length;
    // the view still takes it to be in place, as its equipment list does
    const row = () => observeAs(sc, s, "practitioner").needling.find((x) => x.needle === fallen.id)!;
    expect(row().inPlace).toBe(true);
    // asked about it, the patient feels nothing there — an answer like that of any quiet needle, and evidence of it
    const asked = act(sc, s, { type: "check_sensation", needleId: fallen.id });
    s = asked.state;
    expect(asked.attempt.status).toBe("executed");
    expect(s.utterances.at(-1)!.text).toBe("I hardly feel that one at all.");
    expect(needleEvidence(s, fallen.id).length).toBe(before + 1);
    expect(showsDeqi(sc, needleEvidence(s, fallen.id).at(-1)!)).toBe(false);
    expect(row().inPlace).toBe(true);
    // the same by naming its point
    s = act(sc, s, { type: "say", to: "patient", text: "And what do you feel at ST35?" }).state;
    expect(needleEvidence(s, fallen.id).length).toBe(before + 2);
  });

  it("checks a claim of deqi, spoken or written, against the evidence", () => {
    // before anything has been observed at a needle
    let s = beforeType(knee, "adjust_needle");
    s = act(knee, s, { type: "say", to: "assistant", text: "Deqi obtained at ST35." }).state;
    expect(s.claims.at(-1)).toMatchObject({ claim: "deqi-obtained", supported: false });
    // a negative statement is no claim; nor is what was sought
    const quiet = act(knee, s, { type: "say", to: "assistant", text: "No deqi at that one, and deqi was not sought at the Ashi point." }).state;
    expect(quiet.claims.length).toBe(s.claims.length);
    // after the reference has worked and asked: the claim matches the evidence
    s = kneeNeedled();
    s = act(knee, s, { type: "say", to: "assistant", text: "We obtained deqi at ST36." }).state;
    expect(s.claims.at(-1)).toMatchObject({ claim: "deqi-obtained", supported: true });
    // the written response of a record is a claim like a spoken one
    const written = evaluateEncounter(knee, full(knee));
    expect(written.claims).toEqual({ total: 1, unsupported: 0 });
  });

  it("scores the record of the needles on its evidence, and asks for no deqi", () => {
    const item = (r: ReturnType<typeof evaluateEncounter>, id: string) => r.tracks.procedure.items.find((i) => i.id === id);
    const good = evaluateEncounter(knee, full(knee));
    expect(item(good, "needle-responses-recorded")).toMatchObject({ met: true, detail: "5/5" });
    expect(item(good, "deqi-evidence")).toMatchObject({ met: true, weight: 2 });
    expect(item(good, "needle-responses-true")).toMatchObject({ met: true });
    expect(item(good, "no-overstimulation")).toMatchObject({ met: true });
    expect(good.evidence.responses).toMatchObject({ needles: 5, recorded: 5, overclaimed: 0, contradicted: 0, outOfDate: 0 });
    expect(episodeMarkdown(good)).toMatch(/Needle responses[\s\S]*\| pack-a\.3 \| ST36:right \| qi arrived[\s\S]*Deqi is never required/);
    // the anticoagulated patient: no needle worked, every needle asked about — an honest record of none scores the same
    const gentle = requireScenario(pack, "sg-knee-oa/anticoagulated");
    const quiet = evaluateEncounter(gentle, full(gentle));
    expect(quiet.evidence.needles.every((x) => x.field.manipulations === 0 && x.claim?.response !== "deqi")).toBe(true);
    expect(item(quiet, "deqi-evidence")).toMatchObject({ met: true });
    expect(item(quiet, "no-overstimulation")).toBeUndefined();
    expect(quiet.tracks.procedure.score).toBe(1);
    // one gentle needle, nothing looked for, and said so: the pregnant patient's reference as it stood before the
    // audit, on the same patient in her first trimester (at 24 weeks her lumbar region is not needled: audit.test.ts)
    const pregnant = requireScenario(pack, "sg-low-back-pain/pregnant");
    const early: Scenario = { ...pregnant, field: { ...pregnant.field, patient: { ...pregnant.field.patient, gestationWeeks: 10 } } };
    const gentleNeedle = JSON.parse(readFileSync(new URL("./fixtures/audit-pregnant-original.json", import.meta.url), "utf8")) as ActionRequestInput[];
    let firstTrimester = createEncounter(early, { seed: 1 });
    for (const r of gentleNeedle) firstTrimester = step(early, firstTrimester, r, { strict: true }).state;
    const unsought = evaluateEncounter(early, firstTrimester);
    expect(unsought.evidence.needles.map((x) => [x.claim?.response, x.verdict])).toEqual([["not-sought", "not-sought"]]);
    expect(unsought.tracks.procedure.score).toBe(1);
    // "deqi at every needle", written without regard to the evidence: overclaims, and a lower procedure score
    const steps = knee.field.solution.map((r) => {
      if (r.action.type !== "document" || !r.action.record.needling?.responses) return r;
      const responses = r.action.record.needling.responses.map((x) => (x.response === "none" ? { ...x, response: "deqi" as const } : x));
      return { ...r, action: { ...r.action, record: { ...r.action.record, needling: { ...r.action.record.needling, responses } } } };
    });
    let s = createEncounter(knee, { seed: 1 });
    for (const r of steps) s = step(knee, s, r, { strict: true }).state;
    const over = evaluateEncounter(knee, s);
    expect(over.primary.status).toBe("success");
    // the two knee eyes and the Ashi needle: asked about, nothing there, recorded as deqi all the same
    expect(over.evidence.responses.overclaimed).toBe(3);
    expect(item(over, "deqi-evidence")).toMatchObject({ met: false });
    expect(item(over, "deqi-evidence")!.detail).toBe("pack-a.1 (ST35:right), pack-a.2 (EX-LE4:right), pack-a.5 (ashi:ashi-medial-joint-line)");
    expect(over.tracks.procedure.score!).toBeLessThan(good.tracks.procedure.score!);
    // nothing recorded of the needles at all
    const silent = knee.field.solution.map((r) => {
      if (r.action.type !== "document" || !r.action.record.needling) return r;
      const { responses: _dropped, ...needling } = r.action.record.needling;
      return { ...r, action: { ...r.action, record: { ...r.action.record, needling } } };
    });
    s = createEncounter(knee, { seed: 1 });
    for (const r of silent) s = step(knee, s, r, { strict: true }).state;
    const none = evaluateEncounter(knee, s);
    expect(item(none, "needle-responses-recorded")).toMatchObject({ met: false, detail: "0/5" });
    expect(item(none, "deqi-evidence")).toBeUndefined();
    expect(none.evidence.needles.every((x) => x.verdict === "unrecorded")).toBe(true);
  });
});

describe("the reference trajectories", () => {
  it("rest every conclusion on evidence: patterns on findings that show them, needle responses on what was observed", () => {
    const seen = new Set<string>();
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      const s = full(sc);
      for (const a of s.assessments) {
        const sup = assessmentSupport(sc, s, a);
        if (!sup) continue;
        expect(sup.supported, `${id}: ${a.pattern}`).toBe(true);
        expect(sup.idle, `${id}: ${a.pattern}`).toEqual([]);
        expect(sup.methods.includes("tongue") || sup.methods.includes("pulse"), `${id}: ${a.pattern}`).toBe(true);
      }
      for (const x of needleAudit(sc, s)) {
        expect(["supported", "not-sought"], `${id}: ${x.needle} ${x.detail}`).toContain(x.verdict);
        expect(x.field.overstimulated, `${id}: ${x.needle}`).toBe(false);
        seen.add(`${x.claim!.response}:${x.verdict}`);
      }
      expect(s.claims.every((c) => c.supported), id).toBe(true);
    }
    // between them they show all three honest records
    expect([...seen].sort()).toEqual(["deqi:supported", "none:supported", "not-sought:not-sought"]);
  });
});
