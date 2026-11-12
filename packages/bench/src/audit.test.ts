import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createEncounter, pointInstance, step, type ActionRequestInput, type EncounterState, type Scenario } from "@acucraft/core";
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
