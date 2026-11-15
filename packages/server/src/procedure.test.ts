import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group, Vector3 } from "three";
import { NeedleLayer, type NeedleSpec } from "../web/stage/needles.js";
import { NeedleProcedure } from "../web/stage/procedure.js";
import { sampleProcedure } from "../web/stage/choreography.js";
import type { Person } from "../web/stage/cast.js";
import { createEncounter, observeAs, step, type ActionRequestInput, type EncounterState } from "@acucraft/core";
import { loadContentPack, requireScenario } from "@acucraft/bench";

/** No WebGL or pixel rendering: these tests exercise the actual scene graph, clock and lifecycle. */
beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      fillStyle: "", fillRect: () => {}, createRadialGradient: () => ({ addColorStop: () => {} }),
    }) }),
  });
});
afterEach(() => vi.unstubAllGlobals());

function spec(id = "needle-a", depthCm = 2): NeedleSpec {
  return {
    id, target: "ST36:right", angleDeg: 0, azimuthDeg: 0, depthCm, length: 0.04,
    site: { p: new Vector3(0, 0.8, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, 1), bare: true },
  };
}

function body(layer: NeedleLayer, id = "needle-a"): Group {
  const root = layer.group.getObjectByName(`needle:${id}`);
  if (!root) throw new Error(`Missing needle ${id}`);
  return root.children[0] as Group;
}

function practitioner() {
  const actor = {
    isMoving: false,
    holder: new Group(),
    shoulderAt: (side: string) => new Vector3(side === "left" ? -0.2 : 0.2, 1.3, 0),
    reach: (_side: string, wrist: Vector3 | null) => ({ wrist: wrist?.clone() ?? new Vector3(), reachable: true }),
  };
  return actor as typeof actor & Person;
}

describe("continuous needling choreography", () => {
  it("approaches, pinches, operates, releases and retreats in that order with a settled final pose", () => {
    for (const kind of ["insert", "remove", "work"] as const) {
      const operationMs = kind === "insert" ? 1100 : kind === "remove" ? 850 : 2400;
      expect(sampleProcedure(kind, 0, 2400)).toMatchObject({ reach: 0, grip: 0, operation: 0, complete: false });
      expect(sampleProcedure(kind, 850, 2400)).toMatchObject({ reach: 1, grip: 0, operation: 0 });
      expect(sampleProcedure(kind, 1070, 2400)).toMatchObject({ reach: 1, grip: 1, operation: 0, operating: true });
      expect(sampleProcedure(kind, 1070 + operationMs / 2, 2400).operation).toBeCloseTo(0.5);
      expect(sampleProcedure(kind, 1070 + operationMs, 2400)).toMatchObject({ reach: 1, grip: 1, operation: 1, operating: false });
      expect(sampleProcedure(kind, 1270 + operationMs, 2400)).toMatchObject({ reach: 1, grip: 0, operation: 1 });
      expect(sampleProcedure(kind, 1920 + operationMs, 2400)).toMatchObject({ reach: 0, grip: 0, operation: 1, complete: true });
    }
  });

  it("draws insertion before a manipulation received immediately after it", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    const progress = vi.spyOn(needles, "progress");
    const work = vi.spyOn(needles, "work");
    needles.sync([spec()], 0, true);
    // This is the same arrival order as stage.sync: fresh adjustments, then transition reconciliation.
    procedure.work("needle-a", "bu", { durationMs: 400 });
    procedure.sync();
    procedure.tick(0);
    procedure.tick(1200);
    expect(progress).toHaveBeenCalledWith("needle-a", "insert", expect.any(Number));
    expect(work).not.toHaveBeenCalled();
    expect(needles.group.getObjectByName("needle:needle-a")?.visible).toBe(true);
    procedure.dispose();
    needles.clear();
  });

  it("settles an insertion and removal if a frame arrives after their whole operation window", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    needles.sync([spec()], 0, true);
    procedure.sync();
    procedure.tick(0);
    procedure.tick(10_000);
    expect(needles.transitions()).toEqual([]);
    expect(body(needles).position.y).toBeCloseTo(-0.02);
    needles.sync([], 11_000, true);
    procedure.sync();
    procedure.tick(11_000);
    procedure.tick(21_000);
    expect(needles.grip("needle-a")).toBeNull();
    expect(needles.transitions()).toEqual([]);
    procedure.dispose();
    needles.clear();
  });

  it("keeps distinct manipulation parameters in FIFO order", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    needles.sync([spec()], 0, false);
    const work = vi.spyOn(needles, "work");
    const first = { durationMs: 400, cycles: 1, rotationDeg: 25 };
    const second = { durationMs: 2400, cycles: 4, strokeMm: 2.5 };
    procedure.work("needle-a", "twist", first);
    procedure.work("needle-a", "xie", second);
    procedure.tick(0);
    procedure.tick(1100);
    expect(work).toHaveBeenNthCalledWith(1, "needle-a", "twist", 1070, first);
    procedure.tick(2320);
    procedure.tick(2400);
    procedure.tick(3500);
    expect(work).toHaveBeenNthCalledWith(2, "needle-a", "xie", 3470, second);
    expect(work).toHaveBeenCalledTimes(2);
    procedure.dispose();
    needles.clear();
  });

  it("does not start a detached manipulation after a large frame gap has completed its gesture", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    needles.sync([spec()], 0, false);
    procedure.work("needle-a", "bu", { durationMs: 400, cycles: 1, strokeMm: 3 });
    procedure.tick(0);
    procedure.tick(10_000);
    needles.tick(16, 10_100);
    expect(body(needles).position.y).toBeCloseTo(-0.02, 8);
    expect(body(needles).rotation.y).toBeCloseTo(0, 8);
    procedure.dispose();
    needles.clear();
  });

  it("survives rapid insertion then removal, and skips stale work for an already removed needle", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    needles.sync([spec()], 0, true);
    procedure.sync();
    procedure.tick(0);
    needles.sync([], 50, true);
    procedure.sync();
    for (let time = 50; time < 8000; time += 25) {
      needles.tick(25, time);
      procedure.tick(time);
    }
    expect(needles.grip("needle-a")).toBeNull();
    const work = vi.spyOn(needles, "work");
    procedure.work("needle-a", "bu");
    procedure.tick(8100);
    procedure.tick(9500);
    expect(work).not.toHaveBeenCalled();
    procedure.dispose();
    needles.clear();
  });

  it("cancels the reach and settles the needle when a newer walk starts", () => {
    const needles = new NeedleLayer();
    const actor = practitioner();
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    needles.sync([spec()], 0, true);
    procedure.sync();
    procedure.tick(0);
    procedure.tick(1200);
    actor.isMoving = true;
    procedure.tick(1250);
    expect(needles.transitions()).toEqual([]);
    expect(body(needles).position.y).toBeCloseTo(-0.02);
    expect(procedure.group.visible).toBe(false);
    procedure.dispose();
    needles.clear();
  });
});

describe("rendered needle depths", () => {
  it("clamps every displayed manipulation to the approved retained depth", () => {
    const needles = new NeedleLayer();
    needles.sync([spec("needle-a", 0.01)], 0, false);
    for (const technique of ["lift", "thrust", "lift-thrust", "twist", "rotate", "bu", "xie"] as const) {
      needles.work("needle-a", technique, 0, { strokeMm: 3, durationMs: 400, cycles: 1 });
      for (let time = 0; time <= 400; time += 5) {
        needles.tick(5, time);
        expect(body(needles).position.y, technique).toBeGreaterThanOrEqual(-0.0001 - 1e-9);
        expect(body(needles).position.y, technique).toBeLessThanOrEqual(1e-9);
      }
    }
    needles.clear();
  });

  it("does not retain a deeper visual tip after an authoritative shallower adjustment", () => {
    const needles = new NeedleLayer();
    needles.sync([spec("needle-a", 3)], 0, false);
    needles.sync([spec("needle-a", 0.5)], 10, true);
    needles.tick(16, 26);
    expect(body(needles).position.y).toBeGreaterThanOrEqual(-0.005 - 1e-9);
    needles.clear();
  });

  it("keeps the approved depth bound while a queued insertion is still being drawn", () => {
    const needles = new NeedleLayer();
    needles.sync([spec("needle-a", 3)], 0, true);
    needles.progress("needle-a", "insert", 0.5);
    needles.sync([spec("needle-a", 0.5)], 10, true);
    needles.tick(16, 26);
    // Procedure runs after NeedleLayer.tick and must obey the same shallower authoritative limit.
    needles.progress("needle-a", "insert", 0.95);
    expect(body(needles).position.y).toBeGreaterThanOrEqual(-0.005 - 1e-9);
    needles.clear();
  });

  it("loads the retained state without replaying old insertions", () => {
    const needles = new NeedleLayer();
    needles.sync([spec()], 0, false);
    expect(needles.transitions()).toEqual([]);
    expect(body(needles).position.y).toBeCloseTo(-0.02);
    needles.clear();
  });
});

describe("the presentation allow-list", () => {
  const scenario = requireScenario(loadContentPack(), "sg-knee-oa/base");
  function advance(stop: (request: ActionRequestInput) => boolean): EncounterState {
    let state = createEncounter(scenario, { seed: 1 });
    for (const request of scenario.field.solution) {
      if (stop(request)) break;
      state = step(scenario, state, request, { strict: true }).state;
    }
    return state;
  }

  it("reports executed needle geometry without anatomy findings or judged target locations", () => {
    const state = advance((r) => r.action.type === "adjust_needle");
    const view = observeAs(scenario, state, "practitioner");
    const needle = state.needles["pack-a.1"]!;
    const placed = view.needling.find((n) => n.needle === "pack-a.1")!.placement!;
    expect(Object.keys(placed).sort()).toEqual(["region", "side", "u", "v", "depthCm", "angleDeg", "azimuthDeg", "lengthMm"].sort());
    expect(placed.depthCm).toBe(needle.insertion!.depthCm);
    expect(placed.lengthMm).toBe(needle.spec.lengthMm);
    expect(JSON.stringify(placed)).not.toMatch(/findings|tipTissue|nearest|configuration/);
  });

  it("uses the executed depth after a requested path stops short, not the requested depth", () => {
    const state = advance((r) => r.action.type === "adjust_needle");
    const result = step(scenario, state, { requestId: "depth-clamped", actor: "practitioner", patient: "patient", action: { type: "adjust_needle", needleId: "pack-a.1", depthCm: 10, technique: "none" } }, { strict: true });
    const retained = result.state.needles["pack-a.1"]!.location;
    if (retained.kind !== "patient") throw new Error("Needle is not retained");
    const placed = observeAs(scenario, result.state, "practitioner").needling[0]!.placement!;
    expect(placed.depthCm).toBe(retained.depthCm);
    expect(placed.depthCm).toBeLessThan(10);
  });

  it("copies only the current actor's latest executed walk and does not expose hidden fields", () => {
    const state = advance((r) => r.action.type === "adjust_needle");
    const walk = state.walks.findLast((w) => w.actor === "practitioner")!;
    const shown = observeAs(scenario, state, "practitioner").space.lastWalk!;
    expect(shown).toEqual({ attempt: walk.attempt, from: walk.from, to: walk.to, path: walk.path, withPatient: walk.withPatient });
    expect(shown.path).not.toBe(walk.path);
    expect(shown.from).not.toBe(walk.from);
    expect(Object.keys(shown).sort()).toEqual(["attempt", "from", "to", "path", "withPatient"].sort());
    const supportWalk = observeAs(scenario, state, "assistant").space.lastWalk;
    const actualSupport = state.walks.findLast((w) => w.actor === "assistant");
    expect(supportWalk?.attempt ?? null).toBe(actualSupport?.attempt ?? null);
  });
});
