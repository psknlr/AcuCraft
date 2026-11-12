import { describe, expect, it } from "vitest";
import { assessPath, createEncounter, derivedBuild, patientRegion, pointInstance, pointTargets, referenceLibrary, regionAccess, seamMap, step, type Side } from "@acucraft/core";
import { constructPoint, requirements } from "./agents/localise.js";
import { loadContentPack, requireScenario, scenarioIds } from "./content.js";

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

  it("no localised point sits on a critical hazard at a shallow perpendicular depth (5 mm), for any patient or side", () => {
    const shallow: string[] = [];
    let checked = 0;
    for (const id of scenarioIds(pack)) {
      const patient = requireScenario(pack, id);
      for (const point of patient.bundle.acupoints.values()) {
        for (const { site, def } of pointTargets(point)) {
          const r = patient.bundle.regions.get(def.region!)!;
          for (const side of (def.bilateral ? ["left", "right"] : ["midline"]) as Side[]) {
            const cfg = def.configuration ?? regionAccess(r, side, r.access[0]!.position).configuration;
            const inst = pointInstance(patient, point, side, cfg, site);
            if (!inst) continue;
            const frame = patientRegion(patient, def.region!, inst.side, cfg);
            if (assessPath(frame, inst.position, 0, 0, 0.5, NEEDLE).critical) shallow.push(`${id} ${def.id}${site ? `:${site}` : ""} ${side}`);
            checked++;
          }
        }
      }
    }
    // ST9 and LI18 lie over the carotid sheath. The reference body's carotid is shallower than imaging of living
    // subjects reports, so in a slim patient its wall is within 5 mm: the guard stops it (docs/ANATOMY.md §8)
    const overCarotid = (s: string) => / (ST9|LI18) (left|right)$/.test(s);
    expect(shallow.filter((s) => !overCarotid(s))).toEqual([]);
    for (const s of shallow.filter(overCarotid)) {
      const p = requireScenario(pack, s.split(" ")[0]!).case.patient as { heightCm: number; weightKg: number };
      expect(p.weightKg / (p.heightCm / 100) ** 2, s).toBeLessThan(24);
    }
    expect(checked).toBeGreaterThan(700);
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
    // a woman's muscle is scaled down from a male reference body; her shorter frame scales it too
    expect(chest.muscleScale).toBeLessThan(0.8);
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

describe("the groin: abdomen and thigh stitched at their seam", () => {
  const def = (id: string) => pack.bundle.acupoints.get(id)!;
  const sides: Side[] = ["left", "right"];
  const cases = scenarioIds(pack).flatMap((id) => sides.flatMap((side) => pack.bundle.regions.get("thigh")!.configurations.map((c) => [id, side, c.id] as const)));
  // distance from a point to a polyline in the chart
  const toPath = (p: { u: number; v: number }, path: { u: number; v: number }[]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const len2 = (b.u - a.u) ** 2 + (b.v - a.v) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((p.u - a.u) * (b.u - a.u) + (p.v - a.v) * (b.v - a.v)) / len2));
      best = Math.min(best, Math.hypot(p.u - (a.u + t * (b.u - a.u)), p.v - (a.v + t * (b.v - a.v))));
    }
    return best;
  };

  it.each(cases)("%s %s %s: the landmarks of the seam agree, and the femoral artery runs on across it", (id, side, cfg) => {
    const patient = requireScenario(pack, id);
    const seam = seamMap(patient, "abdomen", "thigh", side, cfg)!;
    expect(seam).not.toBeNull();
    for (const p of seam.pairs) expect(p.residualCm, `${p.here} ↔ ${p.there}`).toBeLessThan(1);
    // where both charts draw the femoral artery (the abdomen's from above the inguinal ligament to the crease, the
    // thigh's from the ligament down), the abdomen's, carried to the thigh, runs on the thigh's
    const abd = patientRegion(patient, "abdomen", side, seam.fromConfiguration).structures.find((s) => s.id === `femoral-artery-${side}`)!.path.map((p) => seam.map(p));
    const thigh = patientRegion(patient, "thigh", side, cfg).structures.find((s) => s.id === "femoral-artery")!.path;
    const [lo, hi] = [Math.min(...abd.map((p) => p.v)), Math.max(...abd.map((p) => p.v))];
    const shared = thigh.filter((p) => p.v >= lo && p.v <= hi);
    expect(shared.length).toBeGreaterThan(0);
    for (const p of shared) expect(toPath(p, abd), `femoral artery at v ${p.v.toFixed(1)}`).toBeLessThan(1);
    // and back: the map from the thigh is its exact inverse
    const back = seamMap(patient, "thigh", "abdomen", side, seam.fromConfiguration)!;
    const q = back.map(seam.map({ u: 3, v: -2 }));
    expect(Math.hypot(q.u - 3, q.v + 2)).toBeLessThan(1e-9);
  });

  it.each(cases)("%s %s %s: LR11 and LR10 are measured down the thigh from ST30 where the abdomen places it", (id, side, cfg) => {
    const patient = requireScenario(pack, id);
    const seam = seamMap(patient, "abdomen", "thigh", side, cfg)!;
    const st30 = seam.map(pointInstance(patient, def("ST30"), side, seam.fromConfiguration)!.position);
    const thigh = patientRegion(patient, "thigh", side, cfg);
    // ST30 is level with the upper border of the pubic symphysis, medial to the femoral artery, on both charts
    expect(Math.abs(st30.v - thigh.landmark("pubic-symphysis-upper")!.v)).toBeLessThan(1);
    expect(st30.u).toBeLessThan(thigh.landmark("femoral-pulse-inguinal")!.u);
    const cun = thigh.cunCm("seg.symphysis-medial-epicondyle")!;
    for (const [pid, n] of [["LR11", 2], ["LR10", 3]] as const) {
      const p = pointInstance(patient, def(pid), side, cfg)!.position;
      expect(p.u, pid).toBeCloseTo(st30.u, 6);
      expect(st30.v - p.v, pid).toBeCloseTo(n * cun, 6);
    }
    // SP11 lies a third of the way from SP12 to the patella, over the femoral artery
    const sp12 = seam.map(pointInstance(patient, def("SP12"), side, seam.fromConfiguration)!.position);
    const sp11 = pointInstance(patient, def("SP11"), side, cfg)!.position;
    const pbm = thigh.landmark("patella-base-medial")!;
    expect(Math.hypot(sp11.u - (pbm.u + (2 / 3) * (sp12.u - pbm.u)), sp11.v - (pbm.v + (2 / 3) * (sp12.v - pbm.v)))).toBeLessThan(0.01);
    expect(toPath(sp11, thigh.structures.find((s) => s.id === "femoral-artery")!.path)).toBeLessThan(1.5);
  });

  it("an agent constructs them from what it palpates on both charts, as the engine places them", () => {
    const lib = referenceLibrary(sc);
    const cfgOf = (region: string) => (region === "thigh" ? "knee-extended" : "supine");
    for (const id of ["LR11", "LR10", "SP11"]) {
      for (const side of sides) {
        const reqs = requirements(lib, id, side)!;
        expect(reqs.map((r) => r.region), id).toEqual(["thigh", "abdomen"]);
        // a perfect palpation and tape: the patient's own positions and lengths
        const observed = (region: string, s: Side) => {
          const frame = patientRegion(sc, region, s, cfgOf(region));
          const r = reqs.find((x) => x.region === region && x.side === s)!;
          return { landmarks: new Map(r.landmarks.map((l) => [l, frame.landmark(l)!] as const)), segments: new Map(r.segments.map((g) => [g, frame.segmentCm(g)!] as const)) };
        };
        const at = constructPoint(lib, id, side, observed)!;
        const truth = pointInstance(sc, def(id), side, "knee-extended")!.position;
        expect(Math.hypot(at.u - truth.u, at.v - truth.v), `${id} ${side}`).toBeLessThan(1e-9);
      }
    }
  });

  it("only charts that meet have a seam", () => {
    expect(seamMap(sc, "face", "sole", "left", "supine")).toBeNull();
  });
});
