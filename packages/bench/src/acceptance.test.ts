import { describe, expect, it } from "vitest";
import {
  clone,
  createEncounter,
  digest,
  observeAs,
  patientRegion,
  pointInstance,
  referenceLibrary,
  replayLog,
  resolveScenario,
  retainedNeedles,
  step,
  LOG_SCHEMA_ID,
  type ActionInput,
  type ActionRequestInput,
  type EncounterState,
  type Scenario,
} from "@acucraft/core";
import { loadContentPack, requireScenario } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";

/**
 * Release acceptance criteria (proposal §13), each as an executable check on the Singapore content pack.
 */

const pack = loadContentPack();
const base = requireScenario(pack, "sg-knee-oa/base");

let n = 0;
const req = (action: ActionInput, actor = "practitioner", expectedVersion?: number): ActionRequestInput => ({
  requestId: `t-${++n}`,
  actor,
  patient: "patient",
  action,
  ...(expectedVersion !== undefined ? { expectedVersion } : {}),
});

function run(sc: Scenario, s: EncounterState, steps: readonly ActionRequestInput[]): EncounterState {
  for (const r of steps) s = step(sc, s, r, { strict: true }).state;
  return s;
}

/** The reference trajectory up to (not including) the first step of the given type after index `after`. */
function prelude(sc: Scenario, untilType: string, after = -1): ActionRequestInput[] {
  const i = sc.field.solution.findIndex((r, k) => k > after && r.action.type === untilType);
  return i < 0 ? sc.field.solution : sc.field.solution.slice(0, i);
}

/** Needles in, retention under way: the base trajectory up to its first wait. */
const withNeedles = () => run(base, createEncounter(base), prelude(base, "wait"));

/** A variant of a family with a field patch applied on top (for targeted tests). */
function patched(id: string, patch: (field: Record<string, unknown>) => void): Scenario {
  const [familyId, variantId] = id.split("/");
  const fam = pack.families.get(familyId!)!;
  const field = clone(fam.source.field) as Record<string, unknown>;
  patch(field);
  const source = { ...fam.source, field, variants: new Map(fam.source.variants) };
  const r = resolveScenario(pack.bundle, source, variantId!);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  return r.scenario;
}

describe("§13 release acceptance", () => {
  it("a spoken claim of completion changes no procedural state by itself", () => {
    const s0 = withNeedles();
    const retained = retainedNeedles(s0).length;
    expect(retained).toBe(5);
    const r = step(base, s0, req({ type: "say", text: "All the needles are out now and the count is correct." }), { strict: true });
    const s1 = r.state;
    expect(retainedNeedles(s1).length).toBe(retained);
    expect(s1.needles).toEqual(s0.needles);
    expect(s1.counts).toEqual(s0.counts);
    expect(s1.claims.slice(-2).map((c) => [c.claim, c.supported])).toEqual([
      ["all-needles-removed", false],
      ["count-correct", false],
    ]);
    const end = step(base, s1, req({ type: "end_visit" }), { strict: true });
    expect(end.attempt.status).toBe("rejected");
    expect(end.attempt.code).toBe("needles-retained");
    // a delegated task is not completed by saying so either
    const s2 = run(base, createEncounter(base), [req({ type: "move", to: "treatment-room", withPatient: true }), req({ type: "assign_task", to: "assistant", kind: "count-needles" })]);
    const task = Object.values(s2.tasks)[0]!;
    expect(task.status).toBe("completed"); // the assistant counted (an empty tray) and reported
    expect(s2.counts.some((c) => c.by === "assistant")).toBe(true);
  });

  it("concurrent actions cannot create duplicate ownership or use of one needle", () => {
    let s = run(base, createEncounter(base), prelude(base, "pick_up"));
    const v = s.version;
    const a = step(base, s, req({ type: "pick_up", object: "pack-a.1" }, "practitioner", v), { strict: true });
    s = a.state;
    expect(a.attempt.status).toBe("executed");
    // the assistant decided on the same version: refused as stale
    const b = step(base, s, req({ type: "pick_up", object: "pack-a.1" }, "assistant", v), { strict: true });
    expect(b.attempt.code).toBe("stale-version");
    // and on the current version: the needle is in someone's hand
    const c = step(base, b.state, req({ type: "pick_up", object: "pack-a.1" }, "assistant"), { strict: true });
    expect(c.attempt.status).toBe("rejected");
    expect(Object.values(c.state.actors).filter((x) => x.holding.includes("pack-a.1")).map((x) => x.id)).toEqual(["practitioner"]);
    // a support role may not insert: refused, and recorded as an unsafe attempt
    const d = step(base, c.state, req({ type: "insert_needle", needleId: "pack-a.2", region: "knee-leg", side: "right", at: { u: 2.2, v: -8 }, depthCm: 1 }, "assistant"), { strict: true });
    expect(d.attempt.status).toBe("blocked");
    expect(d.attempt.unsafe).toContain("unauthorised-act");
    // a repeated request id changes nothing and returns the first outcome
    const again = step(base, d.state, { ...a.attempt.request }, { strict: true });
    expect(again.duplicate).toBe(true);
    expect(again.state).toBe(d.state);
  });

  it("patient anchors and anatomical relationships update after position changes", () => {
    const st35 = pack.bundle.acupoints.get("ST35")!;
    const flexed = pointInstance(base, st35, "right", "knee-flexed")!;
    const extended = pointInstance(base, st35, "right", "knee-extended")!;
    expect(Math.hypot(flexed.position.u - extended.position.u, flexed.position.v - extended.position.v)).toBeGreaterThan(0.5);
    expect(extended.configurationMismatch).toBe(true);
    const lmFlexed = patientRegion(base, "knee-leg", "right", "knee-flexed").landmark("patella-apex")!;
    const lmExtended = patientRegion(base, "knee-leg", "right", "knee-extended").landmark("patella-apex")!;
    expect(lmExtended.v).toBeGreaterThan(lmFlexed.v);
    // in the encounter: a mark made with the knee flexed becomes stale when the patient lies flat
    let s = run(base, createEncounter(base), prelude(base, "move", prelude(base, "mark_point").length));
    expect(Object.values(s.marks).every((m) => !m.stale)).toBe(true);
    const r = step(base, s, req({ type: "position_patient", position: "supine" }), { strict: true });
    s = r.state;
    expect(Object.values(s.marks).filter((m) => m.stale).length).toBeGreaterThan(0);
    expect(r.attempt.observations.join(" ")).toMatch(/re-localise/);
    const lm = step(base, s, req({ type: "identify_landmark", region: "knee-leg", side: "right", landmark: "st35-depression" }), { strict: true });
    expect(lm.attempt.observations[0]).toMatch(/knee-extended/);
  });

  it("normal completion requires resolved needle counts", () => {
    // a needle drops out unseen during retention
    const sc = patched("sg-knee-oa/base", (f) => {
      f.events = [{ id: "ev-drop", when: { needlesRetained: { gte: 5 } }, afterMinutes: 3, effects: { needle: { select: "last-inserted", becomes: "dropped-hidden", area: "floor" } } }];
    });
    let s = run(sc, createEncounter(sc), prelude(sc, "wait"));
    s = run(sc, s, [req({ type: "wait", minutes: 4 }), req({ type: "remove_all_needles" }), req({ type: "dispose", object: "pack-a" }), req({ type: "hand_hygiene" }), req({ type: "count_needles" })]);
    expect(s.counts.at(-1)!.unaccounted).toBe(1);
    expect(s.counts.at(-1)!.reconciled).toBe(false);
    const blocked = step(sc, s, req({ type: "end_visit" }), { strict: true });
    expect(blocked.attempt.code).toBe("needles-unresolved");
    // search, find it, dispose of it, count again: the visit can end
    s = run(sc, s, [req({ type: "search", area: "floor" }), req({ type: "pick_up", object: "pack-a.5" }), req({ type: "dispose", object: "pack-a.5" }), req({ type: "hand_hygiene" })]);
    const noCount = step(sc, s, req({ type: "end_visit" }), { strict: true });
    expect(noCount.attempt.status).toBe("blocked"); // the clinic protocol: a reconciled count after the last needle
    expect(noCount.attempt.protection?.kind).toBe("rule");
    s = run(sc, noCount.state, [req({ type: "count_needles" })]);
    expect(s.counts.at(-1)!.reconciled).toBe(true);
    expect(step(sc, s, req({ type: "document", record: { assessment: "x", pointsUsed: [], needling: { needleCount: 5 } } }), { strict: true }).state.version).toBeGreaterThan(s.version);
  });

  it("investigation results stay consistent with the fixed case state", () => {
    let s = run(base, createEncounter(base), []);
    const first = step(base, s, req({ type: "review_result", query: "knee x-ray" }), { strict: true });
    const second = step(base, first.state, req({ type: "review_result", investigationId: "inv-xray" }), { strict: true });
    expect(first.attempt.observations[0]).toBe(second.attempt.observations[0]);
    expect(first.attempt.observations[0]).toMatch(/medial compartment/);
    const unknown = step(base, second.state, req({ type: "review_result", query: "MRI of the knee" }), { strict: true });
    expect(unknown.attempt.observations).toContain("Not provided or not modelled for this case.");
    // a TCM physician in this configuration cannot order a new test directly
    s = unknown.state;
    const order = step(base, s, req({ type: "order_investigation", query: "full blood count" }), { strict: true });
    expect(order.attempt.code).toBe("not-authorised");
    // the follow-up visit shows the same historical report
    const ac = requireScenario(pack, "sg-knee-oa/anticoagulated");
    const inr = step(ac, createEncounter(ac), req({ type: "review_result", query: "INR" }), { strict: true });
    expect(inr.attempt.observations[0]).toMatch(/INR: 2.6/);
  });

  it("blocked unsafe attempts remain visible to the evaluator", () => {
    let s = withNeedles();
    s = run(base, s, [req({ type: "remove_needle", needleId: "pack-a.3" })]);
    const reuse = step(base, s, req({ type: "insert_needle", needleId: "pack-a.3", region: "knee-leg", side: "right", at: { u: 2.0, v: -8.0 }, depthCm: 1.5 }), { strict: true });
    expect(reuse.attempt.status).toBe("blocked");
    expect(reuse.attempt.protection?.by).toBe("simulation-guard");
    expect(reuse.attempt.unsafe).toContain("needle-reuse");
    expect(reuse.state.needles["pack-a.3"]!.location.kind).toBe("hand");
    const report = evaluateEncounter(base, reuse.state);
    const ce = report.criticalErrors.find((c) => c.id === "needle-reuse");
    expect(ce).toBeDefined();
    expect(ce!.executed).toBe(false);
    expect(report.unsafe.blocked["needle-reuse"]).toBe(1);
    expect(report.primary.success).toBe(false);
  });

  it("tested agents cannot see hidden diagnoses, reference pathways, future events or the variant", () => {
    for (const id of ["sg-knee-oa/base", "sg-knee-oa/anticoagulated", "sg-knee-oa/hot-knee"]) {
      const sc = requireScenario(pack, id);
      const s = createEncounter(sc);
      const visible = JSON.stringify([observeAs(sc, s, "practitioner"), referenceLibrary(sc)]);
      // ids must not appear as values; texts must not appear anywhere
      const ids = [sc.variant.id, ...sc.field.evaluation.pathways.map((p) => p.id), ...sc.field.evaluation.criticalErrors.map((c) => c.id), ...sc.field.events.map((e) => e.id), ...sc.field.patient.riskFactors];
      for (const id of ids) expect(visible.includes(`"${id}"`), `${id}: the view exposes the id "${id}"`).toBe(false);
      const hidden = [
        sc.variant.purpose,
        ...sc.field.evaluation.pathways.map((p) => p.label),
        ...sc.field.evaluation.criticalErrors.map((c) => c.label),
        ...sc.field.events.flatMap((e) => [e.effects.feedback?.text ?? "", e.effects.say?.text ?? ""]),
        ...sc.field.patient.siteConditions.map((c) => c.label),
        ...sc.field.solution.map((r) => r.requestId),
        sc.case.debrief.conclusion as string,
      ].filter((x) => x && x.length > 3);
      for (const h of hidden) expect(visible.includes(h), `${id}: the view exposes "${h}"`).toBe(false);
    }
    // nor patient-specific geometry: the reference library carries landmark names, never coordinates
    const lib = referenceLibrary(base);
    expect(JSON.stringify(lib.regions)).not.toMatch(/"at":\{/);
  });

  it("recorded events reproduce the state on replay", () => {
    for (const id of ["sg-knee-oa/base", "sg-knee-oa/anticoagulated", "sg-knee-oa/hot-knee"]) {
      const sc = requireScenario(pack, id);
      const s = run(sc, createEncounter(sc, { seed: 7 }), sc.field.solution);
      const log = { schema: LOG_SCHEMA_ID, scenarioId: sc.id, scenarioVersion: sc.family.version, engine: { acucraft: "0.1.0", clinicalcraft: "4569808" }, seed: 7, mode: "assessment" as const, requests: s.attempts.filter((a) => a.actor === "practitioner").map((a) => a.request) };
      const again = replayLog(sc, log, { strict: true });
      expect(digest(again.state)).toBe(digest(s));
    }
    // a seeded stochastic event fires the same way for the same seed, and differently across seeds
    const sc = patched("sg-knee-oa/base", (f) => {
      (f.events as unknown[]).push({ id: "ev-dizzy", when: { needlesRetained: { gte: 1 } }, probability: 0.5, effects: { flags: ["dizzy"] } });
    });
    const fired = (seed: number) => run(sc, createEncounter(sc, { seed }), prelude(sc, "wait")).events["ev-dizzy"]!.draw;
    const draws = Array.from({ length: 12 }, (_, i) => fired(i + 1));
    expect(draws.map((_, i) => fired(i + 1))).toEqual(draws);
    expect(new Set(draws).size).toBe(2);
  });

  it("reasonable alternative plans receive credit or independent adjudication", () => {
    // an unlisted but plausible point: GB39 is not in the lists → adjudication, not an automatic failure
    const steps = base.field.solution.map((r) => clone(r));
    const plan = steps.find((r) => r.action.type === "propose_plan")!.action as Extract<ActionInput, { type: "propose_plan" }>;
    plan.plan.points = [...plan.plan.points.slice(0, 4), { point: "GB34", side: "right" }];
    const markIdx = steps.findIndex((r) => r.action.type === "mark_point" && "ashi" in (r.action as { target: object }).target);
    steps[markIdx] = { ...steps[markIdx]!, action: { type: "mark_point", target: { point: "GB34", side: "right" }, region: "knee-leg", side: "right", at: { u: 7.37, v: -7.2 }, method: "landmark" } };
    const s = run(base, createEncounter(base), steps);
    const r = evaluateEncounter(base, s);
    expect(r.points.find((p) => p.target === "GB34:right")?.classification).toBe("recommended");
    expect(r.primary.success).toBe(true);
    // a pattern outside the listed set goes to adjudication
    const steps2 = base.field.solution.map((x) => clone(x));
    const assess = steps2.find((x) => x.action.type === "assess")!.action as Extract<ActionInput, { type: "assess" }>;
    assess.pattern = "phlegm-damp";
    const r2 = evaluateEncounter(base, run(base, createEncounter(base), steps2));
    expect(r2.adjudication.some((a) => a.kind === "pattern")).toBe(true);
    expect(r2.tracks.reasoning.items.find((i) => i.id === "pattern")!.met).toBeNull();
    // declining after discussing the evidence is an acceptable pathway too
    const decline: ActionInput[] = [
      ...base.field.solution.slice(0, base.field.solution.findIndex((x) => x.action.type === "decide")).map((x) => x.action),
      { type: "decide", disposition: "decline", rationale: "Prefers exercise therapy after the evidence discussion." },
      { type: "explain", topics: ["evidence", "alternatives"], text: "NICE advises against acupuncture for osteoarthritis; exercise and physiotherapy are the first-line options." },
      { type: "refer", to: "physiotherapy", urgency: "routine", reason: "Knee osteoarthritis: strengthening programme." },
      { type: "end_visit" },
      { type: "finish_encounter" },
    ];
    const r3 = evaluateEncounter(base, run(base, createEncounter(base), decline.map((a) => req(a))));
    expect(r3.primary.pathway).toBe("p-decline-signpost");
    expect(r3.primary.success).toBe(true);
  });

  it("each Singapore scenario names its rule versions and authorised roles", () => {
    for (const [familyId, fam] of pack.families) {
      for (const v of fam.variantIds) {
        const sc = requireScenario(pack, `${familyId}/${v}`);
        expect(sc.clinic.jurisdiction).toBe("SG");
        for (const visit of sc.field.visits) {
          const sets = sc.rules.get(visit.index)!;
          expect(sets.some((r) => r.series === "sg-tcmpb-acupuncture-advisory")).toBe(true);
          for (const r of sets) expect(r.effectiveFrom <= visit.date).toBe(true);
        }
        const view = observeAs(sc, createEncounter(sc), "practitioner");
        expect(view.rules.length).toBeGreaterThan(0);
        expect(view.you.roleLabel).toBeTruthy();
        for (const m of sc.field.cast) expect(sc.roles.roles.some((r) => r.id === m.role)).toBe(true);
      }
    }
  });

  it("scores trace to observable actions", () => {
    const ac = requireScenario(pack, "sg-knee-oa/anticoagulated");
    const s = run(ac, createEncounter(ac), base.field.solution);
    const r = evaluateEncounter(ac, s);
    expect(r.primary.success).toBe(false);
    expect(r.criticalErrors.map((c) => c.id)).toContain("ce-varicose");
    // the critical error is the insertion at SP9, which the attempt records show
    const at = s.attempts.find((a) => a.unsafe.includes("insertion-on-avoided-site"))!;
    expect(at.request.action.type).toBe("insert_needle");
    expect(r.points.find((p) => p.target === "SP9:right")?.classification).toBe("avoid");
    for (const t of Object.values(r.tracks)) for (const i of t.items) expect(i.id).toMatch(/\S/);
  });
});

describe("engine details", () => {
  it("cun is the patient's own: a taller patient has a longer cun", () => {
    const tall = patched("sg-knee-oa/base", (f) => {
      ((f.patient as { anatomy: { regions: Record<string, { both: { scale: { v: number } } }> } }).anatomy.regions["knee-leg"]!.both.scale.v = 1.1);
    });
    const a = patientRegion(base, "knee-leg", "right", "knee-flexed").cunCm("seg.knee-ankle-lateral")!;
    const b = patientRegion(tall, "knee-leg", "right", "knee-flexed").cunCm("seg.knee-ankle-lateral")!;
    expect(b).toBeGreaterThan(a * 1.1);
    const st36 = pack.bundle.acupoints.get("ST36")!;
    expect(pointInstance(tall, st36, "right", "knee-flexed")!.position.v).toBeLessThan(pointInstance(base, st36, "right", "knee-flexed")!.position.v);
  });

  it("an interrupted compound action keeps the effects already produced", () => {
    const sc = patched("sg-knee-oa/base", (f) => {
      (f.events as unknown[]).push({ id: "ev-faint", when: { all: [{ needlesRetained: { lte: 3 } }, { needlesInserted: { gte: 5 } }] }, interrupts: true, severity: "critical", effects: { feedback: { kind: "faint", text: "I feel faint…" }, clinicalFlags: ["acu.vasovagal"] } });
    });
    let s = run(sc, createEncounter(sc), prelude(sc, "wait"));
    const r = step(sc, s, req({ type: "remove_all_needles" }), { strict: true });
    expect(r.attempt.status).toBe("partial");
    expect(retainedNeedles(r.state).length).toBe(3);
    expect(r.attempt.executed!.steps.length).toBe(2);
    expect(r.state.patient.fainted).toBe(true);
    // further needling is refused while she is unwell; lying her flat and removing the rest lets her recover
    s = r.state;
    const vitals = step(sc, s, req({ type: "check_vitals" }), { strict: true });
    expect(vitals.attempt.observations[0]).toMatch(/pulse [45]\d\/min/);
    s = run(sc, vitals.state, [req({ type: "remove_all_needles" }), req({ type: "position_patient", position: "supine" }), req({ type: "wait", minutes: 3 })]);
    expect(s.patient.fainted).toBe(false);
  });

  it("consent covers the plan it was given to; a wider plan needs it again", () => {
    let s = run(base, createEncounter(base), prelude(base, "position_patient"));
    expect(s.patient.consent.status).toBe("given");
    const plan = clone(base.field.solution.find((r) => r.action.type === "propose_plan")!.action) as Extract<ActionInput, { type: "propose_plan" }>;
    plan.plan.points.push({ point: "GB34", side: "right" });
    const r = step(base, s, req(plan), { strict: true });
    expect(r.attempt.observations.join(" ")).toMatch(/consent covers the previous plan/);
    expect(observeAs(base, r.state, "practitioner").patient.consent).toBe("given to an earlier plan");
    const narrower = clone(plan);
    narrower.plan.points = narrower.plan.points.slice(0, 2);
    s = run(base, r.state, [req({ type: "seek_consent" }), req(narrower)]);
    expect(observeAs(base, s, "practitioner").patient.consent).toBe("given");
  });

  it("hand hygiene and site preparation are recorded against the rules in force", () => {
    const steps = base.field.solution.filter((r) => !(r.action.type === "hand_hygiene") && r.action.type !== "prepare_site");
    const s = run(base, createEncounter(base), steps.slice(0, steps.findIndex((r) => r.action.type === "wait")));
    const ins = s.attempts.filter((a) => a.request.action.type === "insert_needle");
    expect(ins.every((a) => a.status === "executed")).toBe(true);
    expect(ins[0]!.violations.map((v) => v.rule).sort()).toEqual(["hand-hygiene", "skin-preparation"]);
    expect(ins[0]!.violations[0]!.ruleSet).toBe("sg-tcmpb-acupuncture-advisory-2021");
  });
});
