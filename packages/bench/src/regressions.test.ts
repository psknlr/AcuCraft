import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createEncounter,
  evaluateField,
  FieldEventSchema,
  observeAs,
  pointInstance,
  step,
  type ActionInput,
  type ActionRequestInput,
  type EncounterState,
  type Scenario,
} from "@acucraft/core";
import { loadContentPack, requireScenario } from "./content.js";
import { evaluateEncounter } from "./evaluate.js";

/**
 * Regression checks for defects found in an independent review of the engine and the evaluator: each test is the
 * smallest trajectory that showed the defect.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");

let n = 0;
const req = (action: ActionInput, actor = "practitioner"): ActionRequestInput => ({ requestId: `r-${++n}`, actor, patient: "patient", action });

function run(sc: Scenario, s: EncounterState, steps: readonly ActionRequestInput[], strict = true): EncounterState {
  for (const r of steps) s = step(sc, s, r, { strict }).state;
  return s;
}

const indexOf = (sc: Scenario, type: string, after = -1) => sc.field.solution.findIndex((r, k) => k > after && r.action.type === type);

function withEvent(id: string, event: unknown): Scenario {
  const sc = requireScenario(pack, id);
  return { ...sc, field: { ...sc.field, events: [...sc.field.events, FieldEventSchema.parse(event)] } };
}

describe("review regressions: localisation and safety", () => {
  it("a cautioned point is cautioned wherever the needle goes for it, whatever target is named", () => {
    const sc = requireScenario(pack, "sg-low-back-pain/pregnant");
    const bl23 = pointInstance(sc, sc.bundle.acupoints.get("BL23")!, "right", "side-lying")!;
    // the pregnant reference no longer needles: replay the audited trajectory that did (one side-lying Ashi needle)
    const steps = JSON.parse(readFileSync(new URL("./fixtures/audit-pregnant-original.json", import.meta.url), "utf8")) as ActionRequestInput[];
    const i = steps.findIndex((r) => r.action.type === "insert_needle");
    // a second needle at the patient's BL23, labelled as her (planned) Ashi point
    steps.splice(i + 1, 0, req({ type: "pick_up", object: "pack-a.2" }), req({ type: "insert_needle", needleId: "pack-a.2", region: "lumbar", side: "right", at: bl23.position, angleDeg: 0, azimuthDeg: 0, depthCm: 1, target: { ashi: "ashi-right-l3" } }));
    let attempt: EncounterState["attempts"][number] | undefined;
    let s = createEncounter(sc, { seed: 1 });
    for (const r of steps) {
      const res = step(sc, s, r, { strict: true });
      s = res.state;
      if (r === steps[i + 2]) attempt = res.attempt;
    }
    expect(attempt!.unsafe).toContain("insertion-at-cautioned-point");
    // shown back as what the operator named; evaluated as where it went
    expect(attempt!.executed!.detail).toMatch(/Ashi/);
    const report = evaluateEncounter(sc, s);
    // meant for the Ashi point, entered at BL23: avoided where it went
    expect(report.points.find((p) => p.needle === "pack-a.2")).toMatchObject({ target: "ashi:ashi-right-l3", entered: "BL23:right", classification: "avoid" });
    expect(report.primary.status).toBe("failure");
  });

  it("an untargeted insertion is not named after the hidden reference point in what the agent sees", () => {
    const sc = knee;
    let s = run(sc, createEncounter(sc, { seed: 1 }), sc.field.solution.slice(0, indexOf(sc, "insert_needle")));
    const st36 = pointInstance(sc, sc.bundle.acupoints.get("ST36")!, "right", "knee-flexed")!;
    const r = step(sc, s, req({ type: "insert_needle", needleId: "pack-a.1", region: "knee-leg", side: "right", at: st36.position, depthCm: 1 }));
    s = r.state;
    expect(r.attempt.executed!.detail).not.toMatch(/ST36/);
    expect(r.attempt.observations.join(" ")).not.toMatch(/ST36/);
    expect(observeAs(sc, s, "practitioner").equipment.needles.find((x) => x.id === "pack-a.1")!.where).not.toMatch(/ST36/);
  });

  it("a region to avoid makes every point in it inappropriate", () => {
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    // the base trajectory, needling the hot knee
    const s = run(sc, createEncounter(sc, { seed: 1 }), knee.field.solution, false);
    const report = evaluateEncounter(sc, s);
    expect(report.points.length).toBeGreaterThan(0);
    expect(report.points.every((p) => p.classification === "avoid")).toBe(true);
  });
});

describe("review regressions: monitoring and adverse events", () => {
  it("time without needles in place does not count as unobserved retention", () => {
    const sc = knee;
    const i = indexOf(sc, "insert_needle");
    const steps: ActionRequestInput[] = [...sc.field.solution];
    // the first needle goes in and straight out again; then twenty minutes with nothing in place
    steps.splice(i + 1, 0, req({ type: "remove_needle", needleId: "pack-a.1" }), req({ type: "dispose", object: "pack-a.1" }), req({ type: "wait", minutes: 20 }));
    const s = run(sc, createEncounter(sc, { seed: 1 }), steps, false);
    const item = evaluateEncounter(sc, s).tracks.procedure.items.find((x) => x.id === "observation:v1")!;
    expect(item.met).toBe(true);
  });

  it("someone is responsible for observation only through a monitoring task taken on in that visit, or their own observation", () => {
    const sc = knee;
    const fu = indexOf(sc, "begin_follow_up");
    const unwatched = sc.field.solution.filter((r, i) => i >= fu || (r.action.type !== "monitor" && !(r.action.type === "assign_task" && r.action.kind === "monitor-patient")));
    const item = (steps: readonly ActionRequestInput[]) => evaluateEncounter(sc, run(sc, createEncounter(sc, { seed: 1 }), steps, false)).tracks.collaboration.items.find((x) => x.id === "responsibility:v1")!.met;
    expect(item(sc.field.solution)).toBe(true);
    expect(item(unwatched)).toBe(false);
    // a monitoring task given at the start of the next visit does not cover the last one
    const later: ActionRequestInput[] = [...unwatched];
    later.splice(later.findIndex((r) => r.action.type === "begin_follow_up") + 1, 0, req({ type: "assign_task", to: "assistant", kind: "monitor-patient", params: {} }));
    expect(item(later)).toBe(false);
  });

  it("only the practitioner's own response counts as responding to an event", () => {
    const sc = requireScenario(pack, "sg-tension-headache/faint");
    // up to the interrupted wait: she has just fainted; the assistant is monitoring
    const s = run(sc, createEncounter(sc, { seed: 1 }), sc.field.solution.slice(0, indexOf(sc, "wait") + 1));
    expect(s.events["ev-vasovagal"]?.firedAt).not.toBeNull();
    const responded = (x: EncounterState) => evaluateField(sc, x, { respondedTo: { event: "ev-vasovagal", withinMinutes: 2 } });
    const idle = run(sc, s, [req({ type: "wait", minutes: 2 })]);
    expect(idle.monitorLog.some((m) => m.by === "assistant" && m.at >= s.events["ev-vasovagal"]!.firedAt!)).toBe(true);
    expect(responded(idle)).toBe(false);
    expect(responded(run(sc, s, [req({ type: "remove_all_needles" })]))).toBe(true);
  });

  it("a fainted patient left sitting up is a failure, not an adjudication", () => {
    const sc = requireScenario(pack, "sg-tension-headache/faint");
    const steps = sc.field.solution.map((r) => (r.action.type === "position_patient" && r.action.position === "supine" ? { ...r, action: { type: "position_patient", position: "seated-forward" } as ActionInput } : r));
    const report = evaluateEncounter(sc, run(sc, createEncounter(sc, { seed: 1 }), steps, false));
    expect(report.tracks.procedure.items.find((x) => x.id === "faint-managed")!.met).toBe(false);
    expect(report.primary.status).toBe("failure");
    expect(report.primary.reasons.join(" ")).toMatch(/p-faint-upright/);
    expect(evaluateEncounter(sc, run(sc, createEncounter(sc, { seed: 1 }), sc.field.solution)).primary.status).toBe("success");
  });

  it("evidence and alternatives explained only after the needles went in earn no credit", () => {
    const sc = knee;
    const steps = sc.field.solution.map((r) => {
      if (r.action.type !== "explain") return r;
      // topics are also read from the text: say nothing of the evidence or the alternatives before the needles
      if (r.action.topics.includes("evidence")) return { ...r, action: { type: "explain", topics: r.action.topics.filter((t) => t !== "evidence" && t !== "alternatives") } } as ActionRequestInput;
      if (r.action.topics.includes("aftercare")) return { ...r, action: { ...r.action, topics: [...r.action.topics, "evidence", "alternatives"] } } as ActionRequestInput;
      return r;
    }) as ActionRequestInput[];
    const report = evaluateEncounter(sc, run(sc, createEncounter(sc, { seed: 1 }), steps, false));
    expect(report.tracks.reasoning.items.find((x) => x.id === "evidence")!.met).toBe(false);
  });
});

describe("review regressions: delegation and needles", () => {
  it("one delegated task waiting does not hold up another", () => {
    const sc = knee;
    const s = run(sc, createEncounter(sc, { seed: 1 }), [
      req({ type: "move", to: "treatment-room", withPatient: true }),
      req({ type: "assign_task", to: "assistant", kind: "monitor-patient", params: { intervalMinutes: 5 } }),
      req({ type: "assign_task", to: "assistant", kind: "fetch", params: { item: "pack-a" } }),
      req({ type: "wait", minutes: 10 }),
    ]);
    const fetch = Object.values(s.tasks).find((t) => t.kind === "fetch")!;
    expect(fetch.status).toBe("completed");
    expect(s.packs["pack-a"]!.holder).toBe("practitioner");
  });

  it("a patient who declines a position is reported once, honestly, without retrying", () => {
    const sc = requireScenario(pack, "sg-tension-headache/faint");
    let s = run(sc, createEncounter(sc, { seed: 1 }), [req({ type: "move", to: "treatment-room", withPatient: true }), req({ type: "assign_task", to: "assistant", kind: "position-patient", params: { position: "prone" } })]);
    s = run(sc, s, [req({ type: "wait", minutes: 3 })]);
    const task = Object.values(s.tasks).find((t) => t.kind === "position-patient")!;
    expect(task.status).toBe("incomplete");
    expect(task.report?.summary).toMatch(/declined/);
    expect(s.attempts.filter((a) => a.actor === "assistant" && a.request.action.type === "position_patient").length).toBe(1);
  });

  it("a needle that falls out unseen is listed where it was placed until someone looks", () => {
    const sc = withEvent("sg-knee-oa/base", { id: "ev-drop", when: { needlesInserted: { gte: 5 } }, afterMinutes: 2, interrupts: false, severity: "warning", effects: { needle: { select: "first-inserted", becomes: "dropped-hidden", area: "couch" } } });
    const s = run(sc, createEncounter(sc, { seed: 1 }), [...sc.field.solution.slice(0, indexOf(sc, "wait")), req({ type: "wait", minutes: 3 })]);
    expect(s.needles["pack-a.1"]!.location).toMatchObject({ kind: "floor", hidden: true });
    const view = observeAs(sc, s, "practitioner");
    expect(view.equipment.needles.find((x) => x.id === "pack-a.1")!.where).toMatch(/^in the patient/);
    // looking finds the discrepancy; a count names it
    const looked = step(sc, s, req({ type: "monitor" }), { strict: true });
    expect(looked.attempt.observations[0]).toMatch(/^4 needle\(s\) in place/);
    const counted = step(sc, s, req({ type: "count_needles" }), { strict: true });
    expect(counted.attempt.observations[0]).toMatch(/1 NOT ACCOUNTED FOR/);
  });

  it("an invalid request is recorded as invalid and breaks nothing downstream", () => {
    const sc = knee;
    const r = step(sc, createEncounter(sc, { seed: 1 }), { requestId: "bad", actor: "practitioner" } as unknown as ActionRequestInput);
    expect(r.attempt.status).toBe("rejected");
    expect(r.state.attempts[0]!.request.action.type).toBe("invalid");
    expect(() => observeAs(sc, r.state, "practitioner")).not.toThrow();
    expect(() => evaluateEncounter(sc, r.state)).not.toThrow();
  });

  it("the encounter tag does not tell the variants of a family apart", () => {
    const tag = (id: string, seed: number) => observeAs(requireScenario(pack, id), createEncounter(requireScenario(pack, id), { seed }), "practitioner").encounter;
    expect(tag("sg-knee-oa/hot-knee", 3)).toBe(tag("sg-knee-oa/base", 3));
    expect(tag("sg-knee-oa/base", 3)).not.toBe(tag("sg-knee-oa/base", 4));
  });
});
