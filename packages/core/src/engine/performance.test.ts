import { describe, expect, it } from "vitest";
import {
  MANIPULATION_TECHNIQUE_IDS, ManipulationMotionSettingsSchema, PerformTechniqueSchema,
  type ManipulationMotionSettings,
} from "../schema/manipulation.js";
import { MANIPULATION_TECHNIQUES, manipulationCatalogueComplete, manipulationTechnique, resolveManipulationMotion, sampleTechnique } from "./performance.js";

const length = (p: { u: number; v: number }) => Math.hypot(p.u, p.v);

describe("the authored manipulation catalogue", () => {
  it("covers 24 named maneuvers, ten compound recipes and bu/xie with explicit provenance and target contexts", () => {
    expect(manipulationCatalogueComplete()).toBe(true);
    expect(MANIPULATION_TECHNIQUES).toHaveLength(36);
    expect(MANIPULATION_TECHNIQUES.filter((t) => t.family === "compound")).toHaveLength(10);
    expect(new Set(MANIPULATION_TECHNIQUES.map((t) => t.id)).size).toBe(36);
    expect(MANIPULATION_TECHNIQUES.filter((t) => t.context === "skin").map((t) => t.id)).toEqual(["chuai", "zhua", "xun", "she", "an"]);
    expect(manipulationTechnique("men")).toMatchObject({ context: "removed", needsNeedle: true });
    for (const technique of MANIPULATION_TECHNIQUES) {
      expect(technique.zh).not.toBe("");
      expect(technique).toMatchObject({ evidence: "illustrative", source: { review: "unreviewed" } });
      for (const phase of technique.phases) expect(manipulationTechnique(phase.primitive)).not.toBeNull();
      expect(ManipulationMotionSettingsSchema.safeParse(technique.defaults).success).toBe(true);
      for (const key of technique.controls) expect(Object.hasOwn(technique.defaults, key)).toBe(true);
    }
    expect(manipulationTechnique("not-a-technique")).toBeNull();
  });

  it("rejects unbounded or invented control values at the shared operator/LLM action boundary", () => {
    for (const motion of [
      { durationMs: 399 }, { durationMs: 30_001 }, { durationMs: 500.5 }, { cycles: 0 }, { cycles: 13 }, { cycles: 1.5 },
      { strokeMm: -0.01 }, { strokeMm: 3.01 }, { rotationDeg: 180.1 }, { lateralMm: 4.1 }, { tiltDeg: 8.1 },
      { tempoBias: 0.19 }, { tempoBias: 0.81 }, { gripApertureMm: 12.1 }, { contactIntensity: 1.1 },
      { direction: "free" }, { hand: "both" }, { support: "force" }, { forceN: 3 }, { unsafeDepthCm: 5 },
    ]) {
      expect(PerformTechniqueSchema.safeParse({ type: "perform_technique", technique: "nian", motion }).success, JSON.stringify(motion)).toBe(false);
    }
    expect(PerformTechniqueSchema.safeParse({ type: "perform_technique", technique: "nonsense" }).success).toBe(false);
    expect(PerformTechniqueSchema.safeParse({ type: "perform_technique", technique: "nian", source: "expert-validated" }).success).toBe(false);
    expect(PerformTechniqueSchema.parse({ type: "perform_technique", technique: "tui-withdraw", needleId: "pack-a.1", motion: { hand: "right", grip: "three-finger", contactIntensity: 0 } })).toMatchObject({ technique: "tui-withdraw", motion: { contactIntensity: 0 } });
  });

  it("defaults every retained technique to thumb-index holding while retaining explicit middle support", () => {
    const retained = MANIPULATION_TECHNIQUES.filter((entry) => entry.context === "retained");
    expect(retained).toHaveLength(30);
    for (const entry of retained) {
      expect(entry.defaults.grip, `${entry.id} catalogue default`).toBe("two-finger");
      expect(resolveManipulationMotion(entry.id).grip, `${entry.id} resolved default`).toBe("two-finger");
      expect(resolveManipulationMotion(entry.id, { grip: "three-finger" }).grip, `${entry.id} explicit support`).toBe("three-finger");
    }
  });

  it("keeps the selected primary grip through ordinary and compound phases, including Fei", () => {
    for (const entry of MANIPULATION_TECHNIQUES.filter((entry) => entry.context === "retained")) {
      const totalWeight = entry.phases.reduce((sum, phase) => sum + phase.weight, 0);
      let startWeight = 0;
      for (const phase of entry.phases) {
        const at = (startWeight + phase.weight * 0.5) / totalWeight * entry.defaults.durationMs;
        startWeight += phase.weight;
        // Nail work has separate active-finger roles; its main thumb-index pair stays held by the renderer.
        if (phase.primitive === "gua" || phase.primitive === "tan") continue;
        expect(sampleTechnique(entry.id, at).handPose, `${entry.id}/${phase.primitive} default`).toBe("pinch");
        expect(sampleTechnique(entry.id, at, { grip: "two-finger" }).handPose, `${entry.id}/${phase.primitive} thumb-index`).toBe("pinch");
        expect(sampleTechnique(entry.id, at, { grip: "three-finger" }).handPose, `${entry.id}/${phase.primitive} opt-in support`).toBe("tripod");
      }
    }
    expect(manipulationTechnique("fei")!.controls).toContain("grip");
    expect(sampleTechnique("chi-feng-ying-yuan", 7000, { durationMs: 9000, grip: "two-finger" }))
      .toMatchObject({ phase: { primitive: "fei" }, handPose: "pinch", gripEngagement: 0 });
  });

  it("advertises controls consumed by each primitive and unions them for compound recipes", () => {
    const controls = (id: string) => manipulationTechnique(id)!.controls;
    expect(controls("chuai")).toEqual(["durationMs", "cycles", "hand", "support", "contactIntensity", "lateralMm", "tempoBias"]);
    expect(controls("gua")).toEqual(["durationMs", "cycles", "hand", "support", "contactIntensity", "gripApertureMm", "lateralMm", "tempoBias"]);
    expect(controls("tan")).toEqual(["durationMs", "cycles", "hand", "support", "contactIntensity", "lateralMm", "tiltDeg"]);
    expect(controls("nu")).not.toContain("strokeMm");
    expect(controls("nu")).toContain("grip");
    expect(controls("yao")).not.toContain("direction");
    expect(controls("pan")).toContain("direction");
    expect(controls("nian")).toContain("rotationDeg");
    expect(controls("nian")).not.toContain("strokeMm");
    expect(controls("she")).toContain("gripApertureMm");
    expect(controls("she")).not.toContain("grip");
    for (const id of ["zhua", "an", "men"]) expect(controls(id)).toEqual(["durationMs", "cycles", "hand", "support", "contactIntensity"]);
    for (const entry of MANIPULATION_TECHNIQUES.filter((t) => t.family === "compound")) {
      const expected = [...new Set(entry.phases.flatMap((phase) => controls(phase.primitive)))];
      expect(new Set(entry.controls), entry.id).toEqual(new Set(expected));
    }
    // A scraping phase's timing control really changes nail engagement, although its grip pose stays fixed.
    const settings = { durationMs: 1000, cycles: 1 };
    expect(sampleTechnique("gua", 250, { ...settings, tempoBias: 0.2 }).nailContact)
      .not.toBeCloseTo(sampleTechnique("gua", 250, { ...settings, tempoBias: 0.8 }).nailContact, 5);
  });
});

describe("presentation motion primitives", () => {
  it("stays within every configured amplitude for all 36 techniques, including extreme valid controls", () => {
    const settings: ManipulationMotionSettings = { durationMs: 30_000, cycles: 12, strokeMm: 3, rotationDeg: 180, lateralMm: 4, tiltDeg: 8, tempoBias: 0.2, contactIntensity: 1 };
    for (const id of MANIPULATION_TECHNIQUE_IDS) {
      for (let step = 0; step <= 600; step++) {
        const sample = sampleTechnique(id, step * 50, settings);
        expect(sample.withdrawalMm, id).toBeGreaterThanOrEqual(-1e-10);
        expect(sample.withdrawalMm, id).toBeLessThanOrEqual(3 + 1e-10);
        expect(Math.abs(sample.rotationRad), id).toBeLessThanOrEqual(Math.PI + 1e-10);
        expect(length(sample.lateralMm), id).toBeLessThanOrEqual(4 + 1e-10);
        expect(length(sample.tiltRad), id).toBeLessThanOrEqual(8 * Math.PI / 180 + 1e-10);
        for (const fraction of [sample.grip, sample.gripEngagement, sample.nailContact, sample.supportContact, sample.phase.progress]) {
          expect(fraction, id).toBeGreaterThanOrEqual(-1e-10);
          expect(fraction, id).toBeLessThanOrEqual(1 + 1e-10);
        }
        expect(JSON.stringify(sample)).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("settles at performance endpoints and every compound phase boundary", () => {
    for (const entry of MANIPULATION_TECHNIQUES) {
      const { durationMs } = entry.defaults;
      const weights = entry.phases.reduce((sum, p) => sum + p.weight, 0);
      const boundaries = [0];
      let sum = 0;
      for (const phase of entry.phases) { sum += phase.weight; boundaries.push(sum / weights * durationMs); }
      for (const time of boundaries) {
        const sample = sampleTechnique(entry.id, time);
        expect(sample.withdrawalMm, `${entry.id}@${time}`).toBeCloseTo(0, 7);
        expect(sample.rotationRad, `${entry.id}@${time}`).toBeCloseTo(0, 7);
        expect(length(sample.lateralMm), `${entry.id}@${time}`).toBeCloseTo(0, 7);
        expect(length(sample.tiltRad), `${entry.id}@${time}`).toBeCloseTo(0, 7);
        expect(sample.gripEngagement, `${entry.id}@${time}`).toBeCloseTo(1, 7);
      }
      expect(sampleTechnique(entry.id, durationMs)).toMatchObject({ complete: true, grip: 0, contact: "none", nailContact: 0, supportContact: 0 });
    }
  });

  it("keeps ordinary holding engaged across work endpoints without applying approach/release twice", () => {
    // The procedure already closes the hand before work begins and opens it after work ends.
    // A second whole-performance envelope would abruptly reopen it at the first work frame.
    for (const entry of MANIPULATION_TECHNIQUES.filter((entry) => !entry.primitives.includes("fei"))) {
      const durationMs = 2400;
      for (const time of [0, 0.001, 1, 60, 1200, durationMs - 60, durationMs - 1, durationMs - 0.001, durationMs]) {
        expect(sampleTechnique(entry.id, time, { durationMs }).gripEngagement, `${entry.id}@${time}`).toBe(1);
      }
    }
    // The old envelope remains available for clients that do not supply procedure timing.
    expect(sampleTechnique("nian", 1, { durationMs: 2400 }).grip).toBeLessThan(0.001);
    expect(sampleTechnique("nian", 1200, { durationMs: 2400 }).grip).toBe(1);
  });

  it("releases only the intentional Fei engagement and rejoins contact at compound boundaries", () => {
    const settings = { durationMs: 3000, cycles: 3 };
    expect(sampleTechnique("fei", 350, settings).gripEngagement).toBeCloseTo(1, 7);
    expect(sampleTechnique("fei", 1000, settings).gripEngagement).toBeCloseTo(0, 7);
    expect(sampleTechnique("fei", 1350, settings).gripEngagement).toBeCloseTo(1, 7);
    expect(sampleTechnique("fei", 2000, settings).gripEngagement).toBeCloseTo(0, 7);
    expect(sampleTechnique("fei", 3000, settings).gripEngagement).toBe(1);

    const compound = { durationMs: 9000, cycles: 3 };
    for (const time of [6000 - 0.001, 6000, 6000 + 0.001, 9000 - 0.001, 9000]) {
      expect(sampleTechnique("chi-feng-ying-yuan", time, compound).gripEngagement).toBeCloseTo(1, 7);
    }
    expect(sampleTechnique("chi-feng-ying-yuan", 7000, compound)).toMatchObject({
      phase: { primitive: "fei" }, gripEngagement: 0,
    });
  });

  it("keeps axial, rotational, external orientation and nail contact mechanically distinct", () => {
    const settings = { durationMs: 1000, cycles: 1 };
    const ti = sampleTechnique("ti", 350, settings);
    const nian = sampleTechnique("nian", 350, settings);
    const pan = sampleTechnique("pan", 350, settings);
    const gua = sampleTechnique("gua", 350, settings);
    expect(ti.withdrawalMm).toBeGreaterThan(0);
    expect(ti.rotationRad).toBe(0);
    expect(length(ti.lateralMm)).toBe(0);
    expect(nian.withdrawalMm).toBe(0);
    expect(Math.abs(nian.rotationRad)).toBeGreaterThan(0.01);
    expect(length(nian.lateralMm)).toBe(0);
    expect(pan.withdrawalMm).toBe(0);
    expect(pan.rotationRad).toBe(0);
    expect(length(pan.lateralMm)).toBeGreaterThan(0.01);
    expect(gua).toMatchObject({ contact: "nail-handle", handPose: "scrape" });
    expect(gua.nailContact).toBeGreaterThan(0);
    expect(sampleTechnique("an", 350, settings)).toMatchObject({ contact: "skin", handPose: "press", withdrawalMm: 0 });
  });

  it("honors direction and asymmetric timing independently of the technique label", () => {
    const settings = { durationMs: 1000, cycles: 1 };
    expect(sampleTechnique("nian", 350, { ...settings, direction: "clockwise" }).rotationRad).toBeGreaterThan(0);
    expect(sampleTechnique("nian", 350, { ...settings, direction: "counterclockwise" }).rotationRad).toBeLessThan(0);
    expect(sampleTechnique("nian", 250, { ...settings, tempoBias: 0.2 }).rotationRad).not.toBeCloseTo(sampleTechnique("nian", 250, { ...settings, tempoBias: 0.8 }).rotationRad, 4);
    expect(sampleTechnique("ti", 300, { ...settings, tempoBias: 0.3 }).withdrawalMm).toBeGreaterThan(sampleTechnique("ti", 300, { ...settings, tempoBias: 0.7 }).withdrawalMm);
    expect(sampleTechnique("bu", 300, settings).withdrawalMm).not.toBeCloseTo(sampleTechnique("xie", 300, settings).withdrawalMm, 4);
  });

  it("uses the requested exact cycle count within each compound phase", () => {
    const settings = { durationMs: 4000, cycles: 2, tempoBias: 0.7, strokeMm: 3 };
    // Shao Shan Huo has four equal phases; each of its first axial phases contains two cycles.
    for (const offset of [0, 1000]) {
      expect(sampleTechnique("shao-shan-huo", offset + 350, settings).withdrawalMm).toBeCloseTo(3, 7);
      expect(sampleTechnique("shao-shan-huo", offset + 500, settings).withdrawalMm).toBeCloseTo(0, 7);
      expect(sampleTechnique("shao-shan-huo", offset + 850, settings).withdrawalMm).toBeCloseTo(3, 7);
    }
    expect(sampleTechnique("shao-shan-huo", 1001, settings).phase.index).toBe(1);
  });

  it("resolves direct preview inputs defensively without modifying caller settings or catalogue defaults", () => {
    const before = JSON.stringify(MANIPULATION_TECHNIQUES);
    const input: ManipulationMotionSettings = { durationMs: NaN, cycles: 99, strokeMm: Infinity, rotationDeg: -50, lateralMm: 99, tiltDeg: -Infinity, contactIntensity: -2 };
    const resolved = resolveManipulationMotion("nian", input);
    expect(resolved).toMatchObject({ durationMs: 2400, cycles: 12, strokeMm: 1.5, rotationDeg: 0, lateralMm: 4, tiltDeg: 3, contactIntensity: 0 });
    expect(input.cycles).toBe(99);
    for (const elapsed of [NaN, -1, -Infinity, Infinity, 1, 10_000]) {
      const sample = sampleTechnique("nu", elapsed, input);
      for (const n of [sample.withdrawalMm, sample.rotationRad, length(sample.lateralMm), length(sample.tiltRad), sample.grip]) expect(Number.isFinite(n)).toBe(true);
    }
    expect(JSON.stringify(MANIPULATION_TECHNIQUES)).toBe(before);
    expect(sampleTechnique("sou", 723)).toEqual(sampleTechnique("sou", 723));
  });
});
