import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessPath, createEncounter, observeAs, patientRegion, pointInstance, referenceLibrary, regionAccess, ruleSetInForce, step, tipOf, type ActionRequestInput, type EncounterState, type Scenario } from "@acucraft/core";
import { requirements } from "./agents/localise.js";
import { loadContentPack, requireScenario } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";

/**
 * Regression cases from the clinical and gameplay audit of main at cb6a25a (12 November 2026): each test is the
 * audit's counterexample and its expected result.
 */

const pack = loadContentPack();

/** Refused for where the actor stands (docs/WORLD.md): never what the audit's counterexamples are about. */
const SPATIAL = ["not-in-reach", "not-at-patient"];
let walked = 0;

/**
 * One request, made by someone with a body: refused for where they stand, they make the walk the refusal names
 * (`move {"to": …}` in its message) and ask again. The counterexamples say what is done, not where from; their
 * actions are spliced into trajectories that did not walk for them.
 */
function stepFrom(sc: Scenario, s: EncounterState, r: ActionRequestInput, strict: boolean): ReturnType<typeof step> {
  let res = step(sc, s, r, { strict });
  for (let i = 0; i < 3 && res.attempt.status === "rejected" && SPATIAL.includes(res.attempt.code ?? ""); i++) {
    const hint = res.attempt.message.match(/move (\{.*\})\./);
    if (!hint) break;
    const walk = { requestId: `audit-walk-${++walked}`, actor: r.actor, patient: r.patient, action: { type: "move", to: JSON.parse(hint[1]!).to } } as ActionRequestInput;
    res = step(sc, step(sc, res.state, walk, { strict }).state, { ...r, requestId: `${r.requestId}-from-there-${walked}` }, { strict });
  }
  return res;
}

function replay(sc: Scenario, steps: readonly ActionRequestInput[], strict = true): EncounterState {
  let s = createEncounter(sc, { seed: 1 });
  for (const r of steps) s = stepFrom(sc, s, r, strict).state;
  return s;
}

/** The scenario's reference trajectory with some actions replaced. */
function edited(sc: Scenario, edit: (r: ActionRequestInput, i: number) => ActionRequestInput | null): ActionRequestInput[] {
  return sc.field.solution.map(edit).filter((r): r is ActionRequestInput => r !== null);
}

describe("audit: a needle is judged against the point it was meant for", () => {
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const markOf = (id: string) => knee.field.solution.find((r) => r.action.type === "mark_point" && "target" in r.action && r.action.target && "point" in r.action.target && r.action.target.point === id)!;

  it("reversing the marks of ST35 and EX-LE4 gives two errors against the intended points", () => {
    const st35 = markOf("ST35").action as { at: { u: number; v: number } };
    const neixiyan = markOf("EX-LE4").action as { at: { u: number; v: number } };
    const swapped = edited(knee, (r) => {
      if (r === markOf("ST35")) return { ...r, action: { ...r.action, at: neixiyan.at } } as ActionRequestInput;
      if (r === markOf("EX-LE4")) return { ...r, action: { ...r.action, at: st35.at } } as ActionRequestInput;
      return r;
    });
    const report = evaluateEncounter(knee, replay(knee, swapped));
    const wrong = report.points.filter((p) => p.target !== p.entered);
    expect(wrong.map((p) => [p.target, p.entered]).sort()).toEqual([["EX-LE4:right", "ST35:right"], ["ST35:right", "EX-LE4:right"]]);
    for (const p of wrong) {
      expect(p.withinTolerance, p.target).toBe(false);
      expect(p.errorCm!, p.target).toBeGreaterThan(4);
      expect(report.tracks.localisation.items.find((i) => i.id === `identity:${p.needle}`)?.met).toBe(false);
    }
    expect(report.tracks.localisation.score!).toBeLessThan(0.9);
  });

  it("the reference trajectory needles every point it meant", () => {
    const report = evaluateEncounter(knee, replay(knee, knee.field.solution));
    for (const p of report.points) expect(p.entered, p.needle).toBe(p.target);
    expect(report.tracks.localisation.score).toBe(1);
  });
});

describe("audit: no abdominal or lumbosacral needling after the first trimester", () => {
  const pregnant = requireScenario(pack, "sg-low-back-pain/pregnant");
  // the reference trajectory as it stood before the audit's change (with the walks of the walkable clinic): one
  // side-lying needle in the right lumbar Ashi point
  const original = JSON.parse(readFileSync(new URL("./fixtures/audit-pregnant-original.json", import.meta.url), "utf8")) as ActionRequestInput[];
  const insertAt = original.findIndex((r) => r.action.type === "insert_needle");

  /** The original trajectory with its one insertion replaced. */
  const withInsertion = (action: Record<string, unknown>) => original.map((r, i) => (i === insertAt ? ({ ...r, action: { ...r.action, ...action } } as ActionRequestInput) : r));

  it("the original lumbar needling pathway fails, and the 2021 advisory's provision is recorded", () => {
    let s = createEncounter(pregnant, { seed: 1 });
    let attempt: EncounterState["attempts"][number] | undefined;
    for (const r of original) {
      const res = step(pregnant, s, r, { strict: true });
      s = res.state;
      if (r === original[insertAt]) attempt = res.attempt;
    }
    expect(attempt!.unsafe).toContain("insertion-in-avoided-region");
    expect(attempt!.violations.map((v) => v.rule)).toContain("pregnancy-abdominal-lumbosacral");
    const report = evaluateEncounter(pregnant, s);
    expect(report.primary.status).toBe("failure");
    expect(report.criticalErrors.map((c) => c.id)).toContain("insertion-in-avoided-region");
  });

  it("judges the region, whether the needle is named for a point, for an Ashi point, or not named at all", () => {
    const bl23 = pointInstance(pregnant, pregnant.bundle.acupoints.get("BL23")!, "right", "side-lying")!;
    for (const variant of [
      { mark: undefined, region: "lumbar", side: "right", at: bl23.position, target: { point: "BL23", side: "right" } },
      { mark: undefined, region: "lumbar", side: "right", at: { u: -6.6, v: 3.7 }, target: { ashi: "ashi-right-l3" } },
      { mark: undefined, region: "lumbar", side: "right", at: { u: -9, v: 8 }, target: undefined },
    ]) {
      const steps = withInsertion(variant);
      let s = createEncounter(pregnant, { seed: 1 });
      for (const r of steps.slice(0, insertAt)) s = step(pregnant, s, r, { strict: true }).state;
      const res = stepFrom(pregnant, s, steps[insertAt]!, false);
      expect(res.attempt.unsafe, JSON.stringify(variant.target ?? "bare position")).toContain("insertion-in-avoided-region");
    }
  });

  it("the reviewed deferral and obstetric liaison completes the case without needling", () => {
    const report = evaluateEncounter(pregnant, replay(pregnant, pregnant.field.solution));
    expect(report.primary.status).toBe("success");
    expect(report.primary.pathway).toBe("p-defer-obstetric");
    expect(report.points).toEqual([]);
  });

  it("does not apply in the first trimester", () => {
    const early: Scenario = { ...pregnant, field: { ...pregnant.field, patient: { ...pregnant.field.patient, gestationWeeks: 10 } } };
    let s = createEncounter(early, { seed: 1 });
    let unsafe: string[] = [];
    for (const r of original) {
      const res = step(early, s, r, { strict: true });
      s = res.state;
      if (r === original[insertAt]) unsafe = res.attempt.unsafe;
    }
    expect(unsafe).not.toContain("insertion-in-avoided-region");
  });
});

describe("audit: asepsis and consent are states, not checkboxes", () => {
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const sol = knee.field.solution;
  const at = (type: string) => sol.findIndex((r) => r.action.type === type);
  const firstInsert = at("insert_needle");
  const req = (id: string, action: Record<string, unknown>): ActionRequestInput => ({ requestId: id, actor: "practitioner", patient: "patient", action } as ActionRequestInput);

  /** Replay with extra actions spliced in before step `i`; the attempt at the first insertion. */
  function attemptAt(steps: ActionRequestInput[], target: ActionRequestInput) {
    let s = createEncounter(knee, { seed: 1 });
    for (const r of steps) {
      const res = stepFrom(knee, s, r, false);
      s = res.state;
      if (r === target) return res.attempt;
    }
    throw new Error("target step not reached");
  }

  it("palpating a prepared site again undoes its preparation, until it is cleaned again", () => {
    const repalpate = req("audit-repalpate", { type: "identify_landmark", region: "knee-leg", side: "right", landmark: "st35-depression" });
    const steps = [...sol.slice(0, firstInsert), repalpate, ...sol.slice(firstInsert)];
    const attempt = attemptAt(steps, sol[firstInsert]!);
    expect(attempt.unsafe).toContain("site-not-prepared");
    expect(attempt.violations.find((v) => v.unsafe === "site-not-prepared")!.detail).toMatch(/touched after cleaning \(palpated st35-depression\)/);
    // cleaned again: prepared
    const again = [...sol.slice(0, firstInsert), repalpate, req("audit-reclean", { type: "prepare_site", region: "knee-leg", side: "right" }), ...sol.slice(firstInsert)];
    expect(attemptAt(again, sol[firstInsert]!).unsafe).not.toContain("site-not-prepared");
  });

  it("topic tags without words explain nothing: no consent, no credit", () => {
    const explain = at("explain");
    const tagsOnly = sol.map((r, i) => (i === explain ? req("audit-tags", { type: "explain", topics: ["procedure", "risks", "alternatives", "benefits", "evidence", "right-to-stop"] }) : r));
    const attempt = attemptAt(tagsOnly, sol[firstInsert]!);
    expect(attempt.unsafe).toContain("insertion-without-consent");
  });

  it("a change of stimulation with the same points and retention needs a further discussion", () => {
    const plan = sol[at("propose_plan")]!.action as { plan: { technique: Record<string, unknown> } };
    const changed = req("audit-reducing", { type: "propose_plan", plan: { ...plan.plan, technique: { ...plan.plan.technique, stimulation: "reducing" } } });
    const steps = [...sol.slice(0, firstInsert), changed, ...sol.slice(firstInsert)];
    expect(attemptAt(steps, sol[firstInsert]!).unsafe).toContain("insertion-without-consent");
    // reducing stimulation to none is not a change the patient must agree to
    const gentler = req("audit-none", { type: "propose_plan", plan: { ...plan.plan, technique: { ...plan.plan.technique, stimulation: "none" } } });
    expect(attemptAt([...sol.slice(0, firstInsert), gentler, ...sol.slice(firstInsert)], sol[firstInsert]!).unsafe).not.toContain("insertion-without-consent");
  });
});

describe("audit: the clinic's objects and who saw what", () => {
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const sol = knee.field.solution;
  let k = 0;
  const req = (action: Record<string, unknown>, actor = "practitioner"): ActionRequestInput => ({ requestId: `audit-${++k}`, actor, patient: "patient", action } as ActionRequestInput);
  const run = (s: EncounterState, steps: readonly ActionRequestInput[]) => steps.reduce((x, r) => stepFrom(knee, x, r, false).state, s);
  const needlesIn = sol.findIndex((r) => r.action.type === "wait");

  it("a count from reception reads the record; a count at the bedside observes; a colleague's count is received as theirs", () => {
    let s = replay(knee, sol.slice(0, needlesIn));
    s = run(s, [req({ type: "move", to: "reception" }), req({ type: "count_needles" })]);
    expect(s.counts.at(-1)).toMatchObject({ by: "practitioner", method: "read", reconciled: false });
    s = run(s, [req({ type: "move", to: "treatment-room" }), req({ type: "count_needles" })]);
    expect(s.counts.at(-1)).toMatchObject({ by: "practitioner", method: "observed", reconciled: true });
    s = run(s, [req({ type: "assign_task", to: "assistant", kind: "count-needles", params: {} }), req({ type: "wait", minutes: 3 })]);
    expect(Object.values(s.tasks).find((t) => t.kind === "count-needles")!.status).toBe("completed");
    expect(s.counts.filter((c) => c.method === "observed").map((c) => c.by)).toContain("assistant");
    expect(s.counts.at(-1)).toMatchObject({ by: "practitioner", method: "reported", reportedBy: "assistant", reconciled: true });
  });

  it("marks made with the knee extended need rechecking once the patient has walked to a chair", () => {
    const beforePositioning = sol.findIndex((r) => r.action.type === "position_patient");
    let s = replay(knee, sol.slice(0, beforePositioning));
    s = run(s, [req({ type: "position_patient", position: "supine" }), req({ type: "mark_point", target: { point: "ST36", side: "right" }, region: "knee-leg", side: "right", at: { u: 2, v: -8 }, method: "proportional" })]);
    expect(Object.values(s.marks).at(-1)!.stale).toBe(false);
    s = run(s, [req({ type: "move", to: "consult-room", withPatient: true })]);
    expect(s.patient.position).toBe("seated");
    expect(Object.values(s.marks).at(-1)!.stale).toBe(true);
  });

  it("a delegated couch preparation is done, recorded and visible; a report alone does not complete it", () => {
    const inRoom = sol.findIndex((r) => r.action.type === "move" && (r.action as { withPatient?: boolean }).withPatient) + 1;
    let s = replay(knee, sol.slice(0, inRoom));
    s = run(s, [req({ type: "position_patient", position: "seated" })]);
    expect(s.couches["treatment-room"]!.prepared).toBeNull();
    // a report without the work, from an assistant played by someone else (an idle policy)
    const manual: Scenario = { ...knee, field: { ...knee.field, cast: knee.field.cast.map((m) => (m.id === "assistant" ? { ...m, policy: "idle" } : m)) } };
    let m = s;
    for (const r of [req({ type: "assign_task", to: "assistant", kind: "prepare-couch", params: {} })]) m = step(manual, m, r, { strict: false }).state;
    const first = Object.values(m.tasks).find((t) => t.kind === "prepare-couch")!;
    for (const r of [req({ type: "acknowledge_task", taskId: first.id }, "assistant"), req({ type: "move", to: "treatment-room" }, "assistant"), req({ type: "report_task", taskId: first.id, summary: "The couch is ready." }, "assistant")]) m = step(manual, m, r, { strict: false }).state;
    expect(m.tasks[first.id]!.status).toBe("incomplete");
    expect(m.tasks[first.id]!.unmet).toContain("the couch was not cleaned and made up");
    // the work, by the assistant's own policy
    s = run(s, [req({ type: "assign_task", to: "assistant", kind: "prepare-couch", params: {} }), req({ type: "wait", minutes: 4 })]);
    const second = Object.values(s.tasks).filter((t) => t.kind === "prepare-couch").at(-1)!;
    expect(second.status).toBe("completed");
    expect(s.couches["treatment-room"]!.prepared).toMatchObject({ by: "assistant", done: ["surface-cleaned", "linen-changed"] });
    const view = observeAs(knee, s, "practitioner");
    expect(view.couches.find((c) => c.room === "treatment-room")!.prepared).toMatchObject({ by: "assistant" });
  });
});

describe("audit: disposition, red-flag evidence, the first visit and the full course are reported apart", () => {
  const redFlagCases = ["sg-knee-oa/hot-knee", "sg-low-back-pain/cauda-equina", "sg-insomnia/low-mood", "sg-chemo-nausea/neutropenic"];

  it.each(redFlagCases)("%s: disposition and referral alone keep the disposition but show no red flag recognised on evidence", (id) => {
    const sc = requireScenario(pack, id);
    const minimal = sc.field.solution.filter((r) => ["decide", "refer", "end_visit", "finish_encounter"].includes(r.action.type));
    const report = evaluateEncounter(sc, replay(sc, minimal, false));
    expect(report.outcomes.disposition).toBe(true);
    expect(report.outcomes.redFlagsOnEvidence).toBe(false);
    expect(report.outcomes.fullCourse).toBeNull();
    // the reference trajectory recognises every red flag on evidence it obtained
    const full = evaluateEncounter(sc, replay(sc, sc.field.solution));
    expect(full.outcomes).toMatchObject({ disposition: true, redFlagsOnEvidence: true, initialVisit: true, fullCourse: null });
  });

  it("a red flag shown at the outset is evidence enough to refer at once", () => {
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    const minimal = sc.field.solution.filter((r) => ["decide", "refer", "end_visit", "finish_encounter"].includes(r.action.type));
    const report = evaluateEncounter(sc, replay(sc, minimal, false));
    // the triage note shows the hot, swollen knee and the fever; weight-bearing is not yet known
    expect(report.redFlags).toEqual([
      { id: "hot-swollen-joint-fever", asserted: false, evidenced: true },
      { id: "unable-to-bear-weight", asserted: false, evidenced: false },
    ]);
  });

  it("ending a course of treatment after the first visit completes the initial visit, not the course", () => {
    const knee = requireScenario(pack, "sg-knee-oa/base");
    const endFirst = knee.field.solution.findIndex((r) => r.action.type === "end_visit");
    const first = [...knee.field.solution.slice(0, endFirst + 1), { requestId: "audit-finish", actor: "practitioner", patient: "patient", action: { type: "finish_encounter" } } as ActionRequestInput];
    const report = evaluateEncounter(knee, replay(knee, first, false));
    expect(report.outcomes).toMatchObject({ disposition: true, initialVisit: true, fullCourse: false });
    expect(evaluateEncounter(knee, replay(knee, knee.field.solution)).outcomes.fullCourse).toBe(true);
    // a deferral with obstetric liaison calls for no further visit here
    const pregnant = requireScenario(pack, "sg-low-back-pain/pregnant");
    expect(evaluateEncounter(pregnant, replay(pregnant, pregnant.field.solution)).outcomes.fullCourse).toBeNull();
  });
});

describe("audit: a group point is its sites, each a target of its own", () => {
  /** A needle into `region` at `at`, meant for `target`, after the scenario's reference steps up to its first insertion. */
  function needle(sc: Scenario, region: string, side: "left" | "right" | "midline", at: { u: number; v: number }, target: Record<string, unknown>) {
    const sol = sc.field.solution;
    const first = sol.findIndex((r) => r.action.type === "insert_needle");
    const needleId = (sol[first]!.action as { needleId: string }).needleId;
    const s = replay(sc, [...sol.slice(0, first), { requestId: "audit-group", actor: "practitioner", patient: "patient", action: { type: "insert_needle", needleId, region, side, at, target, depthCm: 0.2 } } as ActionRequestInput], false);
    return evaluateEncounter(sc, s).points.find((p) => p.needle === needleId)!;
  }
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const cfgOf = (sc: Scenario, region: string, side: "left" | "right" | "midline") => regionAccess(sc.bundle.regions.get(region)!, side, "supine-knee-flexed").configuration;

  it("Sishencong: four sites 1 B-cun round Baihui, and a needle at Baihui earns no Sishencong credit", () => {
    const sishencong = knee.bundle.acupoints.get("EX-HN1")!;
    const cfg = cfgOf(knee, "scalp", "midline");
    expect(pointInstance(knee, sishencong, "midline", cfg)).toBeNull(); // no site, no target
    const gv20 = pointInstance(knee, knee.bundle.acupoints.get("GV20")!, "midline", cfg)!.position;
    const cun = patientRegion(knee, "scalp", "midline", cfg).cunCm("seg.hairlines")!;
    const sites = ["anterior", "posterior", "left", "right"].map((site) => pointInstance(knee, sishencong, "midline", cfg, site)!.position);
    for (const p of sites) expect(Math.hypot(p.u - gv20.u, p.v - gv20.v) / cun).toBeCloseTo(1, 1);
    const atBaihui = needle(knee, "scalp", "midline", gv20, { point: "EX-HN1", side: "midline", site: "anterior" });
    expect(atBaihui).toMatchObject({ target: "EX-HN1:midline:anterior", entered: "GV20:midline", withinTolerance: false });
    // and at the site itself: credit for that site
    expect(needle(knee, "scalp", "midline", sites[0]!, { point: "EX-HN1", side: "midline", site: "anterior" })).toMatchObject({ entered: "EX-HN1:midline:anterior", withinTolerance: true });
  });

  it("Shixuan: a hand and a digit; the index tip does not count for the middle finger", () => {
    const shixuan = knee.bundle.acupoints.get("EX-UE11")!;
    const cfg = cfgOf(knee, "hand-palm", "right");
    const index = pointInstance(knee, shixuan, "right", cfg, "index")!.position;
    expect(needle(knee, "hand-palm", "right", index, { point: "EX-UE11", side: "right", site: "middle" })).toMatchObject({ target: "EX-UE11:right:middle", entered: "EX-UE11:right:index", withinTolerance: false });
    expect(needle(knee, "hand-palm", "right", index, { point: "EX-UE11", side: "right", site: "index" })).toMatchObject({ entered: "EX-UE11:right:index", withinTolerance: true });
  });

  it("Jiaji: a vertebral level and a side, scored level by level (L4 is not L3)", () => {
    const lbp = requireScenario(pack, "sg-low-back-pain/base");
    const jiaji = lbp.bundle.acupoints.get("EX-B2")!;
    const cfg = regionAccess(lbp.bundle.regions.get("lumbar")!, "right", "prone").configuration;
    const l4 = pointInstance(lbp, jiaji, "right", cfg, "l4")!.position;
    const l3 = pointInstance(lbp, jiaji, "right", cfg, "l3")!.position;
    expect(Math.hypot(l4.u - l3.u, l4.v - l3.v)).toBeGreaterThan(2);
    expect(needle(lbp, "lumbar", "right", l4, { point: "EX-B2", side: "right", site: "l3" })).toMatchObject({ target: "EX-B2:right:l3", entered: "EX-B2:right:l4", withinTolerance: false });
    // T1 to T12 lie on the upper back, L1 to L5 on the lumbar chart
    expect(jiaji.siteLocalisations!.map((x) => x.region ?? jiaji.region)).toEqual([...Array(12).fill("upper-back"), ...Array(5).fill("lumbar")]);
  });

  it("naming a group point without a site, or a single point with one, is refused", () => {
    const sol = knee.field.solution;
    const first = sol.findIndex((r) => r.action.type === "insert_needle");
    let s = replay(knee, sol.slice(0, first));
    // at the head of the couch, with the scalp within reach: what is refused below is the target, not the reach
    s = step(knee, s, { requestId: "audit-m-walk", actor: "practitioner", patient: "patient", action: { type: "move", to: { region: "scalp", side: "midline" } } } as ActionRequestInput).state;
    let m = 0;
    const mark = (target: Record<string, unknown>, region: string, side: string) => step(knee, s, { requestId: `audit-m-${++m}`, actor: "practitioner", patient: "patient", action: { type: "mark_point", target, region, side, at: { u: 0, v: 0 }, method: "proportional" } } as ActionRequestInput);
    for (const refused of [mark({ point: "EX-HN1", side: "midline" }, "scalp", "midline"), mark({ point: "GV20", side: "midline", site: "anterior" }, "scalp", "midline")]) {
      expect(refused.attempt.status).toBe("rejected");
      expect(SPATIAL).not.toContain(refused.attempt.code);
    }
    s = mark({ point: "EX-HN1", side: "midline", site: "left" }, "scalp", "midline").state;
    expect(Object.values(s.marks).at(-1)!.target).toEqual({ point: "EX-HN1", side: "midline", site: "left" });
  });
});

describe("audit: an oblique needle meets the tissue of the zones it crosses", () => {
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const chest = patientRegion(knee, "chest", "left", "supine");
  const needle = { diameterMm: 0.25, lengthMm: 75 };
  const tissueAt = (at: { u: number; v: number }, d: number) => {
    let top = 0;
    for (const l of chest.layersAt(at)) {
      if (d <= top + l.thicknessCm) return l.tissue;
      top += l.thicknessCm;
    }
    return "beyond";
  };

  it("angled laterally from the sternal edge, it passes beside the sternum into the intercostal space", () => {
    const entry = { u: 2, v: 4 };
    expect(assessPath(chest, entry, 0, 0, 2, needle).stoppedBy).toBe("bone"); // straight down: the sternum
    const oblique = assessPath(chest, entry, 60, 90, 3, needle);
    expect(oblique.stoppedBy).toBeNull();
    // what lies under the tip is read there, not under the entry (where the sternum would have stopped it)
    const tip = tipOf(entry, 60, 90, 3);
    expect(tissueAt(entry, tip.d)).toBe("bone");
    expect(oblique.tipTissue).toBe(tissueAt(tip, tip.d));
  });

  it("angled medially from the intercostal space, it stops on the sternum it reaches", () => {
    const entry = { u: 4.6, v: 4 };
    expect(assessPath(chest, entry, 0, 0, 1.5, needle).stoppedBy).toBeNull();
    const oblique = assessPath(chest, entry, 60, 270, 3, needle);
    expect(oblique.stoppedBy).toBe("bone");
    expect(oblique.executedDepthCm).toBeLessThan(3);
  });
});

describe("audit: finger-cun is the patient's own unit", () => {
  const knee = requireScenario(pack, "sg-knee-oa/base");
  const withFinger = (cm: number): Scenario => ({ ...knee, field: { ...knee.field, patient: { ...knee.field.patient, anatomy: { ...knee.field.patient.anatomy, fingerCunCm: cm } } } });
  const cfg = regionAccess(knee.bundle.regions.get("hand-dorsum")!, "right", "supine-knee-flexed").configuration;

  it("LI1 and LU11 (0.1 F-cun from the nail corner) move with the patient's finger", () => {
    for (const id of ["LI1", "LU11"]) {
      const def = knee.bundle.acupoints.get(id)!;
      const a = pointInstance(withFinger(1.6), def, "right", cfg)!.position;
      const b = pointInstance(withFinger(2.4), def, "right", cfg)!.position;
      // 0.07 F-cun proximal and 0.07 F-cun to the side: 0.8 cm more finger cun moves it 0.056 cm each way
      expect(Math.abs(b.v - a.v), id).toBeCloseTo(0.07 * 0.8, 6);
      expect(Math.abs(b.u - a.u), id).toBeCloseTo(0.07 * 0.8, 6);
    }
  });

  it("an agent constructing LI1 measures the patient's finger cun", () => {
    const lib = referenceLibrary(knee);
    expect(requirements(lib, "LI1", "right")![0]!.segments).toContain("finger-cun");
  });
});

describe("audit: the rule set in force follows the encounter date", () => {
  it("selects the 2027 treatment-methods advisory from 1 January 2027, which has no encoded provisions yet", () => {
    const sets = [...pack.bundle.ruleSets.values()];
    const series = "sg-tcmpb-acupuncture-treatment-methods";
    expect(ruleSetInForce(sets, series, "2026-12-31")).toBeNull();
    const in2027 = ruleSetInForce(sets, series, "2027-02-01")!;
    expect(in2027.id).toBe("sg-tcmpb-acupuncture-treatment-methods-2027");
    // version selection is demonstrable; its provisions are not, until they are encoded and reviewed
    expect(in2027.encoding).toBe("not-encoded");
    expect(in2027.rules).toEqual([]);
    // the 2021 advisory stays in force alongside it
    expect(ruleSetInForce(sets, "sg-tcmpb-acupuncture-advisory", "2027-02-01")!.rules.map((r) => r.id)).toContain("pregnancy-abdominal-lumbosacral");
  });
});
