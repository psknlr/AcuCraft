import { describe, expect, it } from "vitest";
import { assessPath, createEncounter, derivedBuild, patientRegion, pointInstance, regionAccess, step, type Side } from "@acucraft/core";
import { loadContentPack, requireScenario } from "./content.js";

/** Every regional model is internally consistent, and its hazards are reachable only by going too deep. */

const pack = loadContentPack();
const regions = [...pack.bundle.regions.values()];
const sc = requireScenario(pack, "sg-knee-oa/base");
const NEEDLE = { diameterMm: 0.25, lengthMm: 40 };

describe("regional models", () => {
  it.each(regions.map((r) => [r.id, r] as const))("%s: landmarks, structures, zones and segments lie on the chart", (_id, r) => {
    const [u0, u1] = r.chart.uRange;
    const [v0, v1] = r.chart.vRange;
    const inside = (u: number, v: number, margin = 1) => u >= Math.min(u0, u1) - margin && u <= Math.max(u0, u1) + margin && v >= Math.min(v0, v1) - margin && v <= Math.max(v0, v1) + margin;
    const configs = new Set(r.configurations.map((c) => c.id));
    expect(configs.has(r.defaultConfiguration)).toBe(true);
    for (const a of r.access) expect(configs.has(a.configuration), `${r.id} access ${a.position}`).toBe(true);
    const ids = new Set<string>();
    for (const l of r.landmarks) {
      expect(ids.has(l.id), `duplicate landmark ${l.id}`).toBe(false);
      ids.add(l.id);
      expect(inside(l.at.u, l.at.v), `${r.id} landmark ${l.id}`).toBe(true);
      for (const c of Object.keys(l.configurations)) expect(configs.has(c), `${r.id} landmark ${l.id} configuration ${c}`).toBe(true);
    }
    for (const g of r.segments) {
      expect(ids.has(g.from) && ids.has(g.to), `${r.id} segment ${g.id}`).toBe(true);
    }
    for (const s of r.structures) {
      for (const p of s.path) {
        expect(inside(p.u, p.v, 3), `${r.id} structure ${s.id} at ${p.u}, ${p.v}`).toBe(true);
        expect(p.d, `${r.id} structure ${s.id} depth`).toBeGreaterThanOrEqual(0);
      }
      for (const c of Object.keys(s.configurations)) expect(configs.has(c), `${r.id} structure ${s.id} configuration ${c}`).toBe(true);
    }
    for (const z of r.tissue.zones) {
      expect(inside(z.centre.u, z.centre.v, 2), `${r.id} zone ${z.id}`).toBe(true);
      expect(z.layers[0]!.tissue, `${r.id} zone ${z.id} starts at the skin`).toBe("skin");
    }
    expect(r.tissue.layers[0]!.tissue).toBe("skin");
    expect(r.provenance.licence.length).toBeGreaterThan(0);
  });

  it("no localised point sits on a critical hazard at a shallow perpendicular depth (5 mm)", () => {
    const shallow: string[] = [];
    for (const def of pack.bundle.acupoints.values()) {
      if (!def.region || !def.localisation) continue;
      const r = pack.bundle.regions.get(def.region)!;
      const side: Side = def.bilateral ? "right" : "midline";
      const cfg = def.configuration ?? regionAccess(r, side, r.access[0]!.position).configuration;
      const inst = pointInstance(sc, def, side, cfg);
      if (!inst) continue;
      const frame = patientRegion(sc, def.region, inst.side, cfg);
      const path = assessPath(frame, inst.position, 0, 0, 0.5, NEEDLE);
      if (path.critical) shallow.push(def.id);
    }
    expect(shallow).toEqual([]);
  });
});

describe("the whole body in every encounter", () => {
  const at = (id: string, side: Side = "right") => {
    const def = pack.bundle.acupoints.get(id)!;
    const r = pack.bundle.regions.get(def.region!)!;
    const s: Side = def.bilateral ? side : "midline";
    const cfg = def.configuration ?? regionAccess(r, s, r.access[0]!.position).configuration;
    const inst = pointInstance(sc, def, s, cfg)!;
    return { frame: patientRegion(sc, def.region!, inst.side, cfg), entry: inst.position };
  };
  const deep = (id: string, depth: number, side?: Side) => {
    const { frame, entry } = at(id, side);
    return assessPath(frame, entry, 0, 0, depth, { diameterMm: 0.25, lengthMm: 125 });
  };

  it("derives the build of a region the scenario does not author from height and BMI", () => {
    // the knee patient: 156 cm, 68 kg (BMI 27.9); the chest's reference body is 183 cm, BMI 27.8
    const chest = derivedBuild(sc, pack.bundle.regions.get("chest")!);
    expect(chest.scale.v).toBeCloseTo(156 / 183, 2);
    expect(chest.subcutaneousScale).toBeCloseTo(1, 1);
    // the schematic regions' reference adult is 170 cm, BMI 22.5: a heavier build has more subcutaneous fat
    expect(derivedBuild(sc, pack.bundle.regions.get("face")!).subcutaneousScale).toBeGreaterThan(1.3);
    // a scenario's own authored build is untouched
    expect(sc.field.regions).toContain("knee-leg");
  });

  it("reaches the measured hazards of the trunk and neck when a needle goes too deep", () => {
    expect(deep("KI25", 1.5).critical).toBe(false);
    expect(deep("KI25", 7).pleuraPenetrated).toBe(true);
    expect(deep("BL13", 8).critical || deep("BL13", 8).stoppedBy === "bone").toBe(true);
    expect(deep("CV14", 7).layersReached.map((l) => l.label)).toContain("liver");
    expect(deep("GV9", 8).layersReached.some((l) => l.label.startsWith("spinal canal") && l.hazard === "critical")).toBe(true);
    expect(deep("CV4", 7).layersReached.some((l) => l.hazard === "caution")).toBe(true);
    expect(deep("BL28", 5).stoppedBy).toBe("bone");
    expect(deep("BL32", 3).stoppedBy).toBeNull(); // into the second sacral foramen
    expect(deep("ST9", 2).findings.some((f) => f.structure === "carotid-right" && f.contact)).toBe(true);
    expect(deep("GB30", 9).findings.some((f) => f.structure === "sciatic-nerve-right" && (f.contact || f.near))).toBe(true);
  });

  it("a critical organ layer makes the path critical; the guard blocks a needle into the pleura of a region the scenario never named", () => {
    const liver = deep("CV14", 7);
    expect(liver.critical).toBe(true);
    let s = createEncounter(sc, { seed: 1 });
    const i = sc.field.solution.findIndex((r) => r.action.type === "insert_needle");
    for (const r of sc.field.solution.slice(0, i)) s = step(sc, s, r, { strict: true }).state;
    // the clinic's needles are 40 mm (at most 3.6 cm goes in): enough to reach this patient's pleura under KI25
    const { entry } = at("KI25");
    const r = step(sc, s, { requestId: "deep-ki25", actor: "practitioner", patient: "patient", action: { type: "insert_needle", needleId: "pack-a.1", region: "chest", side: "right", at: entry, depthCm: 3.5 } }, { strict: true });
    expect(r.attempt.status).toBe("blocked");
    expect(r.attempt.unsafe).toContain("pleura-penetration");
  });
});
