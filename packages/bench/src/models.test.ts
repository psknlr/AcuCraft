import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModelReference, lookLayers, lookOf, parseGlb } from "@clinicalcraft/core";
import { DEFAULT_CONTENT_DIR, loadContentPack } from "./content.js";

/**
 * How the clinic is drawn (docs/MODELS.md): every equipment type of the pack has a model built in Blender, checked
 * here the way ClinicalCraft's own inspector checks one (`clinicalcraft assets inspect --type`): on disk, pinned by
 * hash, cleared for use, the size of its footprint, its layers the ones its looks show. The two needling stations
 * are built round a body the world draws: their sites are on file and stand for points this pack defines.
 *
 * And what must not change by accident: the solid furniture of the clinic's rooms is the floor plan every reference
 * walk was planned on.
 */

const WORLD = join(DEFAULT_CONTENT_DIR, "world");
const ROOT = join(DEFAULT_CONTENT_DIR, "..");
const pack = loadContentPack();
const catalog = pack.bundle.world.catalogs.find((c) => c.id === "acucraft-tcm")!;
const types = catalog.equipment;
const STATIONS = ["acu-needling-station-prone", "acu-needling-station-supine"];

describe("the pack's equipment models", () => {
  it("the content pack loads with them: no issue of the catalog, the templates or the facilities", () => {
    expect(pack.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(pack.issues.filter((i) => /catalog|template|facilit/.test(i.path))).toEqual([]);
    expect(types.length).toBe(11);
  });

  it("every type is drawn as a model that is on disk, and nothing else lies beside them", () => {
    for (const type of types) {
      expect(type.model, `${type.id} has no model: tools/blender/build.py, then tools/content/clinic_world.py`).toBeDefined();
      expect(type.model!.uri).toBe(`models/${type.id}.glb`);
      expect(existsSync(join(WORLD, "assets", type.model!.uri)), `${type.id}: ${type.model!.uri} is not on disk`).toBe(true);
    }
    expect(readdirSync(join(WORLD, "assets", "models")).sort()).toEqual(types.map((t) => `${t.id}.glb`).sort());
  });

  it("each passes the engine's inspection against its catalog reference: licence, use status, pinned hash, size, layers", () => {
    for (const type of types) {
      const bytes = readFileSync(join(WORLD, "assets", type.model!.uri));
      const info = parseGlb(new Uint8Array(bytes));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const issues = checkModelReference(info, type.model!, type.footprint, { sha256, layers: lookLayers(type) });
      expect(issues.filter((i) => i.severity !== "info"), type.id).toEqual([]);
      expect(type.model).toMatchObject({ license: "MIT", use: "cleared", scale: 1, sha256 });
      expect(type.model!.source?.url).toBe("https://github.com/psknlr/AcuCraft");
      // one file, drawn at once: within what a centrepiece may cost (ClinicalCraft docs/BLENDER.md "Triangles")
      expect(info.counts.triangles, type.id).toBeLessThanOrEqual(10_000);
      expect(info.counts.animations + info.counts.skins).toBe(0);
    }
  });

  it("the catalog's references are the builder's own (tools/blender/models.json)", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "tools", "blender", "models.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(types.map((t) => t.id).sort());
    for (const type of types) expect(type.model, type.id).toEqual(manifest[type.id]);
  });
});

describe("the needling stations", () => {
  const stations = STATIONS.map((id) => types.find((t) => t.id === id)!);

  it("each has a body lying flat on its couch under towels, breathing, and a drill of six steps", () => {
    expect(stations.map((s) => s.manikin?.posture)).toEqual(["prone", "lying"]);
    for (const s of stations) {
      expect(s.manikin).toMatchObject({ cover: "towels", breathing: "both", y: 0.67 });
      expect(s.manikin!.appearance?.presentation).toBe("neutral");
      // on the padding: the part a patient of a case would lie on, were this the clinic's couch
      const mattress = s.parts.find((p) => p.name === "mattress")!;
      expect(mattress.p[1] + mattress.s[1] / 2).toBeCloseTo(s.manikin!.y, 6);
      expect(Object.keys(s.behavior!.states)).toEqual(["ready", "located", "prepared", "needled", "retained", "removed"]);
      expect(s.behavior!.initial).toBe("ready");
    }
  });

  it("what stands on the skin follows the step: marks once located, needles while they are in, the timer while they are retained", () => {
    for (const s of stations) {
      const layers = (state: string) => lookOf(s, state).layers;
      expect(layers("ready")).toEqual([]);
      expect(layers("located")).toEqual(["marks"]);
      expect(layers("prepared")).toEqual(["marks"]);
      expect(layers("needled")).toEqual(["marks", "needles"]);
      expect(layers("retained")).toEqual(["marks", "needles", "timer"]);
      expect(layers("removed")).toEqual(["marks"]);
      // no step moves the body: the model is built round one body in one position
      for (const state of Object.keys(s.behavior!.states)) expect(lookOf(s, state).manikin).toEqual(lookOf(s, "ready").manikin);
    }
  });

  it("the drill cannot be reset with needles in, and only a practitioner needles", () => {
    for (const s of stations) {
      const ops = s.behavior!.operations;
      expect(ops.reset!.from).not.toContain("needled");
      expect(ops.reset!.from).not.toContain("retained");
      expect(ops.remove_needles!.from).toEqual(["needled", "retained"]);
      for (const name of ["locate_points", "prepare", "insert_needles", "check_response", "remove_needles"]) expect(ops[name]!.roles, name).toEqual(["clinician", "attending"]);
    }
  });

  it("each model is fitted to its body: the sites on file are points of this pack, on the body's own skin", () => {
    for (const s of stations) {
      const fit = JSON.parse(readFileSync(join(ROOT, "tools", "blender", "fit", `${s.id}.json`), "utf8")) as {
        manikin: { posture: string; y: number; z: number };
        reach: { min: number[]; max: number[] };
        sites: Record<string, { point: string; side: string; p: number[]; n: number[]; depthCm: number }>;
      };
      expect(fit.manikin).toMatchObject({ posture: s.manikin!.posture, y: s.manikin!.y, z: s.manikin!.z });
      const sites = Object.entries(fit.sites);
      expect(sites.length).toBe(s.id.endsWith("prone") ? 5 : 6);
      for (const [id, site] of sites) {
        expect(pack.bundle.acupoints.has(site.point), `${id}: ${site.point} is not a point of this pack`).toBe(true);
        // on the body, above the couch, the way out of the skin not into the couch; never deeper than a 40 mm needle
        expect(site.p[1]).toBeGreaterThan(s.manikin!.y);
        expect(site.p[1]).toBeLessThan(fit.reach.max[1]! + 1e-6);
        expect(Math.hypot(site.n[0]!, site.n[1]!, site.n[2]!)).toBeCloseTo(1, 3);
        expect(site.n[1]).toBeGreaterThan(0.5);
        expect(site.depthCm).toBeGreaterThan(0);
        expect(site.depthCm).toBeLessThan(4);
      }
      // the body lies on the couch: within its length, its arms within its width
      expect(fit.reach.min[2]).toBeGreaterThan(-s.footprint.d / 2);
      expect(fit.reach.max[2]).toBeLessThan(s.footprint.d / 2);
      expect(Math.max(-fit.reach.min[0]!, fit.reach.max[0]!)).toBeLessThan(s.footprint.w / 2);
    }
  });
});

describe("what the models must not change", () => {
  /**
   * The solid furniture of the clinic: every reference walk was planned round exactly this (docs/WORLD.md). A
   * change here is a change of the floor plan — plan the walks of every reference trajectory again, then update
   * this list; never the other way round.
   */
  const SOLID = [
    "consult-room.desk desk -5.5,-5.3",
    "consult-room.hand-rub hand-sanitizer -2.45,-2.2",
    "consult-room.herb-cabinet acu-herb-cabinet -3.3,-5.55",
    "consult-room.patient-chair acu-patient-chair -7.25,-4.25",
    "consult-room.physician-chair office-chair -5.4,-4.3",
    "consult-room.plant potted-plant -7.4,-1.6",
    "consult-room.records records-terminal -6.75,-5.35",
    "prep-area.bin trash-bin 4.45,-1.6",
    "prep-area.sharps sharps-bin 4.45,-5.55",
    "prep-area.shelf acu-supply-shelf 6,-5.6",
    "prep-area.sink sink 7.5,-3.5",
    "prep-area.worktop instrument-table 4.55,-3.3",
    "treatment-room.couch acu-treatment-couch 1,-3.9",
    "treatment-room.model acu-meridian-model -1.5,-5.5",
    "treatment-room.patient-chair acu-patient-chair -1.25,-2.75",
    "treatment-room.sink sink 3.2,-5.55",
    "treatment-room.trolley acu-needle-trolley 1,-2.675",
  ];

  it("the clinic's solid furniture in its three rooms is the floor plan the reference walks were planned on", () => {
    const facility = pack.bundle.world.facilities.get("sg-tcm-outpatient")!;
    const typeOf = new Map(pack.bundle.world.catalogs.flatMap((c) => c.equipment).map((e) => [e.id, e] as const));
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const solid = facility.placements
      .filter((p) => ["consult-room", "treatment-room", "prep-area"].includes(p.room ?? "") && typeOf.get(p.type)?.solid)
      .map((p) => `${p.id} ${p.type} ${round(p.x)},${round(p.z)}`)
      .sort();
    expect(solid).toEqual(SOLID);
    // and their footprints, which are the colliders
    const size = (id: string) => typeOf.get(id)!.footprint;
    expect(size("acu-treatment-couch")).toEqual({ w: 0.7, d: 1.9, h: 0.75 });
    expect(size("acu-needle-trolley")).toEqual({ w: 0.6, d: 0.45, h: 1.1 });
    expect(size("acu-patient-chair")).toEqual({ w: 0.5, d: 0.5, h: 0.9 });
    expect(size("acu-meridian-model")).toEqual({ w: 0.4, d: 0.4, h: 1.5 });
    expect(size("acu-herb-cabinet")).toEqual({ w: 1.6, d: 0.45, h: 1.9 });
    expect(size("acu-supply-shelf")).toEqual({ w: 1.2, d: 0.45, h: 1.9 });
  });

  it("what was added to the clinic's rooms is drawn only: nobody walks round it", () => {
    const typeOf = new Map(types.map((e) => [e.id, e] as const));
    expect(typeOf.get("acu-pulse-cushion")!.solid).toBe(false);
    expect(typeOf.get("acu-meridian-chart")!.solid).toBe(false);
    // the heat lamp and the stations are solid, and stand in the skills room only
    const clinic = pack.bundle.world.facilities.get("sg-tcm-outpatient")!;
    for (const id of ["acu-heat-lamp", ...STATIONS]) {
      expect(typeOf.get(id)!.solid).toBe(true);
      expect(clinic.placements.some((p) => p.type === id), id).toBe(false);
    }
    const skills = pack.bundle.world.facilities.get("sg-tcm-skills-room")!;
    for (const id of STATIONS) expect(skills.placements.filter((p) => p.type === id).length).toBe(1);
  });

  it("the people of both facilities have a position and an appearance; every patient has one too", () => {
    for (const id of ["sg-tcm-outpatient", "sg-tcm-skills-room"]) {
      const staff = pack.bundle.world.facilities.get(id)!.staff;
      expect(staff.length).toBeGreaterThan(0);
      for (const s of staff) {
        expect(s.position, s.id).toBeDefined();
        expect(s.appearance, s.id).toMatchObject({ skin: expect.any(String), hair: expect.any(String), hairStyle: expect.any(String) });
      }
    }
    for (const entry of pack.families.values()) {
      const look = (entry.source.case as { patient: { appearance?: Record<string, unknown> } }).patient.appearance;
      expect(look, entry.id).toMatchObject({ skin: expect.any(String), hair: expect.any(String), hairStyle: expect.any(String), shirt: expect.any(String), pants: expect.any(String) });
    }
  });
});
