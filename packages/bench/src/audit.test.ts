import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createEncounter, observeAs, pointInstance, step, type ActionRequestInput, type EncounterState, type Scenario } from "@acucraft/core";
import { loadContentPack, requireScenario } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";

/**
 * Regression cases from the clinical and gameplay audit of main at cb6a25a (12 November 2026): each test is the
 * audit's counterexample and its expected result.
 */

const pack = loadContentPack();

function replay(sc: Scenario, steps: readonly ActionRequestInput[], strict = true): EncounterState {
  let s = createEncounter(sc, { seed: 1 });
  for (const r of steps) s = step(sc, s, r, { strict }).state;
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
  // the reference trajectory as it stood at the audited commit: one side-lying needle in the right lumbar Ashi point
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
      const res = step(pregnant, s, steps[insertAt]!, { strict: false });
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
      const res = step(knee, s, r, { strict: false });
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
  const run = (s: EncounterState, steps: readonly ActionRequestInput[]) => steps.reduce((x, r) => step(knee, x, r, { strict: false }).state, s);
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
