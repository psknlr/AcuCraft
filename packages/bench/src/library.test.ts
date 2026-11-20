import { describe, expect, it } from "vitest";
import { createEncounter, observeAs, pointInstance, pointTargets, referenceLibrary, type Side } from "@acucraft/core";
import { loadContentPack, requireScenario, scenarioIds } from "./content.js";
import { lookup } from "@acucraft/agent";

/** The acupoint library: complete against the standards it cites, and every localised point placeable. */

const pack = loadContentPack();
const points = [...pack.bundle.acupoints.values()];

describe("acupoint library", () => {
  it("holds all 361 points of the WHO standard (2008), channel by channel, numbered without gaps", () => {
    const expected: Record<string, number> = { LU: 11, LI: 20, ST: 45, SP: 21, HT: 9, SI: 19, BL: 67, KI: 27, PC: 9, TE: 23, GB: 44, LR: 14, GV: 28, CV: 24 };
    let total = 0;
    for (const [ch, count] of Object.entries(expected)) {
      const ids = points.filter((p) => p.channel === ch).map((p) => p.id);
      expect(ids.sort(), ch).toEqual(Array.from({ length: count }, (_, i) => `${ch}${i + 1}`).sort());
      total += count;
    }
    expect(total).toBe(361);
    const edition = pack.bundle.standards.editions.find((e) => e.id === "who-wpro-2008")!;
    expect(points.filter((p) => p.codes.some((c) => c.edition === edition.id && c.relation === "same")).length).toBe(edition.meridianPointCount);
  });

  it("holds the 48 extra points of the WHO standard nomenclature (1991)", () => {
    const extra = points.filter((p) => p.channel === "EX");
    expect(extra.length).toBe(48);
    const codes = extra.map((p) => p.codes.find((c) => c.edition === "who-1991-nomenclature")!.code);
    const groups: Record<string, number> = { "EX-HN": 15, "EX-CA": 1, "EX-B": 9, "EX-UE": 11, "EX-LE": 12 };
    for (const [g, count] of Object.entries(groups)) expect(codes.filter((c) => c.replace(/\d+$/, "") === g).sort(), g).toEqual(Array.from({ length: count }, (_, i) => `${g}${i + 1}`).sort());
    // Yintang keeps its id; its code and the national standard's reclassification are recorded
    expect(pack.bundle.acupoints.get("Yintang")!.aliases).toContain("EX-HN3");
  });

  it("gives every point names, a body area and a location, and old channel codes as aliases", () => {
    for (const p of points) {
      expect(p.names.pinyin.length * p.names.hanzi.length, p.id).toBeGreaterThan(0);
      expect(p.area, p.id).toBeDefined();
      expect(String(p.location.text).length, p.id).toBeGreaterThan(20);
      expect(p.provenance.review.status, p.id).toBe("unreviewed");
    }
    expect(pack.bundle.acupoints.get("TE5")!.aliases).toContain("SJ5");
    expect(pack.bundle.acupoints.get("LR3")!.aliases).toContain("LIV3");
    expect(pack.bundle.acupoints.get("GV20")!.bilateral).toBe(false);
    expect(pack.bundle.acupoints.get("EX-UE9")!.sites).toBe(4);
  });

  it("cautions the points traditionally avoided in pregnancy, and notes what lies beneath the hazardous ones", () => {
    for (const id of ["LI4", "SP6", "BL60", "BL67", "GB21", "CV3", "BL32"]) expect(pack.bundle.acupoints.get(id)!.cautions.map((c) => c.when), id).toContain("pregnancy");
    for (const id of ["LU1", "ST9", "BL1", "GV16", "CV22", "GB30"]) expect(pack.bundle.acupoints.get(id)!.notes, id).toBeTruthy();
    expect(pack.bundle.acupoints.get("ST17")!.notes).toMatch(/not needled/);
    expect(pack.bundle.acupoints.get("CV8")!.notes).toMatch(/Not needled/);
  });

  it("places every localised point inside its chart, for every scenario's patient, side and configuration", () => {
    let checked = 0;
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      for (const point of sc.bundle.acupoints.values()) {
        // every target: the point, or each site of a group point on its own chart
        for (const { site, def } of pointTargets(point)) {
          const r = sc.bundle.regions.get(def.region!)!;
          const sides: Side[] = def.bilateral ? ["left", "right"] : ["midline"];
          for (const side of sides) {
            for (const cfg of def.configuration ? [def.configuration] : r.configurations.map((c) => c.id)) {
              const inst = pointInstance(sc, point, side, cfg, site);
              const what = `${id} ${def.id}${site ? `:${site}` : ""} ${side} ${cfg}`;
              expect(inst, what).not.toBeNull();
              const { u, v } = inst!.position;
              expect(u >= r.chart.uRange[0] && u <= r.chart.uRange[1] && v >= r.chart.vRange[0] && v <= r.chart.vRange[1], `${what} at ${u.toFixed(2)}, ${v.toFixed(2)}`).toBe(true);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("the library as an agent sees it", () => {
  const sc = requireScenario(pack, "sg-knee-oa/base");
  const lib = referenceLibrary(sc);

  it("offers every point and every regional model: the whole body is modelled in every encounter", () => {
    expect(lib.points.length).toBe(409);
    const localised = lib.points.filter((p) => p.localisation).map((p) => p.region);
    expect(localised.length).toBe(points.filter((p) => p.localisation).length);
    expect(lib.regions.map((r) => r.id).sort()).toEqual([...pack.bundle.regions.keys()].sort());
    // the view is unchanged by the size of the library
    expect(() => observeAs(sc, createEncounter(sc), "practitioner")).not.toThrow();
  });

  it("keeps the lookup index compact and filterable", () => {
    const index = lookup(lib, { topic: "points" }) as { total: number; needleable: Record<string, string[]>; byChannel: Record<string, string[]> };
    expect(index.total).toBe(409);
    expect(JSON.stringify(index).length).toBeLessThan(12000);
    expect(index.byChannel.BL!.length).toBe(67);
    expect(index.needleable["knee-leg"]).toContain("ST36");
    expect((lookup(lib, { topic: "points", id: "ST" }) as unknown[]).length).toBe(45);
    // a key matches a channel, a body area or a region ("face" is both an area and a region)
    expect((lookup(lib, { topic: "points", id: "face" }) as { area: string; region: string | null }[]).every((p) => p.area === "face" || p.region === "face")).toBe(true);
    expect((lookup(lib, { topic: "points", id: "wrist" }) as { area: string }[]).every((p) => p.area === "wrist")).toBe(true);
    expect((lookup(lib, { topic: "point", id: "SJ5" }) as { id: string }).id).toBe("TE5");
    expect(lookup(lib, { topic: "point", id: "XX9" })).toHaveProperty("error");
  });
});
