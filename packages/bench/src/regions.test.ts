import { describe, expect, it } from "vitest";
import { assessPath, patientRegion, pointInstance, regionAccess, type Side } from "@acucraft/core";
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
