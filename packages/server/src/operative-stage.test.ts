import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group, Mesh, Quaternion, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { NeedleProcedure, type ProcedurePlayback, type TechniquePerformanceInput } from "../web/stage/procedure.js";
import { NeedleLayer } from "../web/stage/needles.js";
import { OPERATIVE_TECHNIQUES, resolveOperationMotion, resolveTechniqueMotion, sampleOperation } from "@acucraft/core";
import type { Person } from "../web/stage/cast.js";
import type { SkinSite } from "../web/stage/sites.js";
import { sampleProcedure } from "../web/stage/choreography.js";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { Person as ScenePerson, practitionerPlacement } from "../web/stage/cast.js";
import { patientFloorPlacement, practitionerFloorPlacement } from "../web/stage/navigation.js";
import { SiteFinder } from "../web/stage/sites.js";

/**
 * The stage playing the operative catalogue (docs/TECHNIQUES.md): the needle between its levels, the hand in place
 * through every stage of every technique, the stage named as it is played, and what one-way rolling leaves behind.
 */

const asset = readFileSync(process.env.ACUCRAFT_HAND_GEOMETRY_FIXTURE ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const site: SkinSite = { p: new Vector3(0, 0.8, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, 1), bare: true };
const DEPTH_CM = 1.8, NEEDLE = "needle-a";
const input = (technique: TechniquePerformanceInput["technique"], extra: Partial<TechniquePerformanceInput> = {}): TechniquePerformanceInput =>
  ({ id: `performance-${technique}`, technique, site, model: "operative", ...extra });

beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }) }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function makeScene() {
  const needles = new NeedleLayer();
  const actor = {
    isMoving: false, holder: new Group(),
    shoulderAt: (side: string) => new Vector3(side === "left" ? -0.2 : 0.2, 1.3, 0),
    reach: (_side: string, wrist: Vector3 | null, _blend?: number, _palm?: Quaternion) => ({ wrist: wrist?.clone() ?? new Vector3(), elbow: new Vector3(), reachable: true }),
  } as unknown as Person;
  needles.sync([{ id: NEEDLE, target: "BL23:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: DEPTH_CM, length: 0.04 }], 0, false);
  const procedure = new NeedleProcedure(needles, () => actor, () => {});
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
  await procedure.load("/hand.glb", "#cba88a");
  const states: ProcedurePlayback[] = [];
  procedure.onPlayback = (state) => states.push(state);
  return { needles, procedure, states, dispose() { procedure.dispose(); needles.clear(); } };
}

/** The low-back-pain encounter as the workspace draws it: this patient, face down, the practitioner at her left side, a needle at BL23. */
async function makeWorkingScene() {
  const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
  const session = new EncounterSession(scenario, { seed: 1, mode: "teaching", techniques: "operative" });
  for (const request of scenario.field.solution) {
    if (request.action.type === "insert_needle") break;
    session.act(request.action);
  }
  const original = session.view();
  const view = { ...original, space: { ...original.space, you: { ...original.space.you, x: 0.25, z: -4.25, yaw: -2.5324, room: "treatment-room" } } };
  const patient = new ScenePerson({ presentation: "feminine", skin: "#c39a74", hair: "#1e1917", hairStyle: "ponytail", shirt: "#3f8c86", pants: "#2f3a4a", build: "average", stature: "adult", gown: false, accessory: "none" },
    patientFloorPlacement(view, 160, "patient:sg-low-back-pain/base"));
  const seed = "practitioner:enc-17441d080d46", placement = practitionerFloorPlacement(view, seed);
  placement.options.wear = practitionerPlacement("treatment", 1, 0, seed).options.wear;
  const actor = new ScenePerson({ skin: "#d9b48f", hair: "#24201d", hairStyle: "short", shirt: "#dfe7ea", pants: "#2f3a45", build: "average", presentation: "neutral" }, placement);
  const geometry = { region: "lumbar", side: "left" as const, u: 3.32, v: 6.91, depthCm: DEPTH_CM, angleDeg: 0, azimuthDeg: 0, lengthMm: 40, diameterMm: 0.25 };
  const skin = new SiteFinder(patient.rig).find(geometry)!;
  const needles = new NeedleLayer(), procedure = new NeedleProcedure(needles, () => actor, () => {}, () => patient);
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
  await procedure.load("/hand.glb", "#d9b48f");
  needles.sync([{ id: NEEDLE, target: "BL23:left", site: skin, angleDeg: 0, azimuthDeg: 0, depthCm: DEPTH_CM, length: 0.04, diameterMm: 0.25 }], 0, false);
  needles.tick(0, 0);
  return { needles, procedure, site: skin, dispose() { procedure.dispose(); needles.clear(); actor.dispose(); patient.dispose(); } };
}

/** How deep the needle is drawn: the handle rises by what the tip is withdrawn. */
const handleHeight = (needles: NeedleLayer) => needles.grip(NEEDLE)!.point.y;

describe("the stage on the operative catalogue", () => {
  it("keeps the detail hand in place, on the handle, through every stage of every retained technique", async () => {
    const scene = await makeScene();
    try {
      for (const technique of OPERATIVE_TECHNIQUES.filter((t) => t.context === "retained")) {
        const motion = resolveOperationMotion(technique.id);
        const envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview(input(technique.id, { needleId: NEEDLE })), technique.id).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        const hidden: string[] = [];
        for (let step = 1; step < 60; step++) {
          const progress = step / 60;
          scene.procedure.setPlayback({ progress });
          const state = scene.procedure.playback;
          const working = progress * envelope.durationMs > envelope.operationStartMs + 1 && progress * envelope.durationMs < envelope.operationStartMs + motion.durationMs - 1;
          if (!working) continue;
          const hand = scene.procedure.group.getObjectByName("needle-hand")!;
          if (!hand.visible || state.reachWarning) hidden.push(`${Math.round(progress * 100)}% ${state.phase}: ${state.reachWarning ?? "hidden"}`);
          expect(state.stage, `${technique.id} names its stage at ${progress}`).toBeTruthy();
          expect(state.stage!.needle, `${technique.id}: the levels are shown for a needle`).toBe(true);
        }
        expect(hidden, `${technique.id}: the hand left the needle`).toEqual([]);
        scene.procedure.stopPreview();
      }
    } finally { scene.dispose(); }
  }, 120_000);

  it("keeps the detail hand in place beside the real patient too: no technique of the catalogue runs it into her", async () => {
    const scene = await makeWorkingScene();
    try {
      for (const technique of OPERATIVE_TECHNIQUES.filter((t) => t.context === "retained")) {
        const motion = resolveOperationMotion(technique.id);
        const envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview({ id: `preview-${technique.id}`, technique: technique.id, site: scene.site, needleId: NEEDLE, model: "operative" }), technique.id).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        const lost: string[] = [];
        for (let step = 1; step < 24; step++) {
          const progress = step / 24, at = progress * envelope.durationMs;
          scene.procedure.setPlayback({ progress });
          if (at <= envelope.operationStartMs + 1 || at >= envelope.operationStartMs + motion.durationMs - 1) continue;
          const state = scene.procedure.playback;
          if (!scene.procedure.group.getObjectByName("needle-hand")!.visible || state.reachWarning) lost.push(`${Math.round(progress * 100)}% ${state.phase}: ${state.reachWarning ?? "hidden"}`);
        }
        expect(lost, `${technique.id}: the hand left the needle`).toEqual([]);
        scene.procedure.stopPreview();
      }
    } finally { scene.dispose(); }
  }, 300_000);

  it("draws the needle at the level each stage of 烧山火 stands at, and back where it stood at the end", async () => {
    const scene = await makeScene();
    try {
      const motion = resolveOperationMotion("shao-shan-huo");
      const envelope = sampleProcedure("work", 0, motion.durationMs);
      const rest = handleHeight(scene.needles);
      expect(scene.procedure.preview(input("shao-shan-huo", { needleId: NEEDLE }))).toBe(true);
      scene.procedure.setPlayback({ paused: true });
      const seen = new Map<string, { lowest: number; highest: number; counts: Set<number>; of: number }>();
      for (let ms = 5; ms < motion.durationMs; ms += 40) {
        scene.procedure.setPlayback({ progress: (envelope.operationStartMs + ms) / envelope.durationMs });
        const state = scene.procedure.playback, stage = state.stage!;
        expect(stage, `a stage at ${ms} ms`).toBeTruthy();
        // the handle stands as far out of the patient as the sampler withdraws the tip
        const expected = sampleOperation("shao-shan-huo", ms, motion, { depthMm: DEPTH_CM * 10 }).withdrawalMm / 1000;
        expect(handleHeight(scene.needles) - rest, `the needle at ${ms} ms`).toBeCloseTo(expected, 4);
        expect(stage.depthFraction).toBeGreaterThan(0.3);
        const entry = seen.get(stage.zh) ?? { lowest: Infinity, highest: -Infinity, counts: new Set<number>(), of: stage.of };
        entry.lowest = Math.min(entry.lowest, handleHeight(scene.needles) - rest); entry.highest = Math.max(entry.highest, handleHeight(scene.needles) - rest);
        entry.counts.add(stage.count);
        seen.set(stage.zh, entry);
      }
      // nine strokes at the shallow third, nine at the middle, nine at the depth the needle stands at
      const third = DEPTH_CM / 100 / 3;
      for (const [zh, level] of [["天部 · 紧按慢提", 2 * third], ["人部 · 紧按慢提", third], ["地部 · 紧按慢提", 0]] as const) {
        const at = seen.get(zh)!;
        expect(at, zh).toBeTruthy();
        expect(at.lowest, `${zh}: the thrust returns to its level`).toBeCloseTo(level, 3);
        expect(at.highest - at.lowest, `${zh}: the stroke`).toBeCloseTo(0.002, 3);
        expect([...at.counts].sort((a, b) => a - b), `${zh}: counted`).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(at.of).toBe(9);
      }
      expect([...seen.keys()]).toEqual(["退至天部", "天部 · 紧按慢提", "进至人部", "人部 · 紧按慢提", "进至地部", "地部 · 紧按慢提", "紧闭插针"]);
      // the caption names the stage and counts it
      scene.procedure.setPlayback({ progress: (envelope.operationStartMs + motion.durationMs * 0.2) / envelope.durationMs });
      expect(scene.procedure.playback.phase).toMatch(/^天部 · 紧按慢提 \d\/9 · Shallow level/);
      scene.procedure.stopPreview();
      expect(handleHeight(scene.needles)).toBeCloseTo(rest, 9);
      expect(scene.procedure.playback).toMatchObject({ mode: "idle" });
    } finally { scene.dispose(); }
  });

  it("leaves on the needle what an accepted roll wound onto it, and nothing after a preview or a record of the other catalogue", async () => {
    const scene = await makeScene();
    try {
      const spinOf = () => (scene.needles.group.getObjectByName(`needle:${NEEDLE}`)!.children[0] as Group).rotation.y;
      const play = (performance: TechniquePerformanceInput, preview: boolean) => {
        const duration = sampleProcedure("work", 0, resolveOperationMotion(performance.technique, performance.motion).durationMs).durationMs;
        if (preview) {
          expect(scene.procedure.preview(performance)).toBe(true);
          scene.procedure.setPlayback({ paused: true, progress: 0.999 });
          scene.procedure.stopPreview();
          return;
        }
        scene.procedure.perform(performance);
        for (let now = 0; now <= duration + 400; now += 16) { scene.procedure.tick(now); scene.needles.tick(16, now); }
      };
      // a preview is a look, not a doing: nothing stays
      play(input("cuo", { needleId: NEEDLE, motion: { cycles: 2, rotationDeg: 90 } }), true);
      expect(spinOf()).toBeCloseTo(0, 9);
      // an accepted 搓 of two quarter turns leaves the needle half a turn round, thumb forward
      play(input("cuo", { id: "performance-1", needleId: NEEDLE, motion: { cycles: 2, rotationDeg: 90 } }), false);
      expect(scene.procedure.playback.mode).toBe("idle");
      expect(spinOf()).toBeCloseTo(-Math.PI, 6);
      // the fingers that hold it afterwards start from their own rest, not from where the needle was turned to
      expect(scene.needles.grip(NEEDLE)!.rotation).toBe(0);
      // rolled back the other way, it is where it began
      play(input("cuo", { id: "performance-2", needleId: NEEDLE, motion: { cycles: 2, rotationDeg: 90, direction: "counterclockwise" } }), false);
      expect(Math.abs(spinOf())).toBeLessThan(1e-6);
      // a twirl leaves nothing
      play(input("nian", { id: "performance-3", needleId: NEEDLE }), false);
      expect(Math.abs(spinOf())).toBeLessThan(1e-6);
    } finally { scene.dispose(); }
  });

  it("gives each technique of the skin its own hand: the thumbnail for 爪 and 摄, the thumb's pulp for 按, the index pad for 揣, 循 and 扪", async () => {
    const scene = await makeScene();
    try {
      const digits = ["thumb", "index", "middle", "ring", "little"] as const;
      const working: Record<string, string> = {};
      for (const id of ["chuai", "zhua", "xun", "she", "an", "men"] as const) {
        const motion = resolveOperationMotion(id);
        const envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview(input(id)), id).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        const hand = scene.procedure.group.getObjectByName("needle-hand")!;
        const lowestOf = new Map<string, number>(digits.map((digit) => [digit, Infinity]));
        let palm = Infinity;
        for (let step = 1; step < 20; step++) {
          scene.procedure.setPlayback({ progress: (envelope.operationStartMs + motion.durationMs * step / 20) / envelope.durationMs });
          expect(hand.visible && !scene.procedure.playback.reachWarning, `${id} at ${step}/20`).toBe(true);
          // a technique of the skin names its stage, and shows no levels: there is no needle's tip to place among them
          expect(scene.procedure.playback.stage, `${id} at ${step}/20`).toMatchObject({ needle: false, level: null });
          hand.updateMatrixWorld(true);
          // how far above the skin the lowest point of each digit's own skin and nail comes, and how high the palm is held
          for (const digit of digits) for (const part of ["skin", "nail"]) {
            const mesh = hand.getObjectByName(`${digit}_${part}`) as Mesh, position = mesh.geometry.getAttribute("position"), v = new Vector3();
            for (let i = 0; i < position.count; i++) {
              if (mesh instanceof SkinnedMesh) mesh.getVertexPosition(i, v); else v.fromBufferAttribute(position, i);
              lowestOf.set(digit, Math.min(lowestOf.get(digit)!, v.applyMatrix4(mesh.matrixWorld).sub(site.p).dot(site.n) * 1000));
            }
          }
          palm = Math.min(palm, hand.getObjectByName("palm_frame")!.getWorldPosition(new Vector3()).sub(site.p).dot(site.n) * 1000);
        }
        const [first, ...rest] = [...lowestOf].sort((a, b) => a[1] - b[1]);
        working[id] = first![0];
        // one finger is on the skin and never in it; the others are held clear of it, a finger's thickness up; the palm is over them
        expect(first![1], `${id}: the working ${first![0]}, mm above the skin`).toBeGreaterThan(-0.05);
        expect(first![1], `${id}: the working ${first![0]}, mm above the skin`).toBeLessThan(1.6);
        expect(rest[0]![1], `${id}: the next finger down (${rest[0]![0]}), mm above the skin`).toBeGreaterThan(4);
        expect(palm, `${id}: the palm above the skin, mm`).toBeGreaterThan(20);
        scene.procedure.stopPreview();
      }
      expect(working).toEqual({ chuai: "index", zhua: "thumb", xun: "index", she: "thumb", an: "thumb", men: "index" });
    } finally { scene.dispose(); }
  }, 120_000);

  it("presses with the pulp of the pressing hand's thumb when a needle technique is given a pressing hand", async () => {
    const scene = await makeScene();
    try {
      const lowestByDigit = (model: "operative" | "illustrative") => {
        const motion = resolveTechniqueMotion(model, "nian", { support: "press" }), envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview(input("nian", { needleId: NEEDLE, model, motion: { support: "press" } })), model).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        scene.procedure.setPlayback({ progress: (envelope.operationStartMs + motion.durationMs * 0.5) / envelope.durationMs });
        const support = scene.procedure.group.getObjectByName("support-hand")!;
        expect(support.visible && scene.procedure.group.getObjectByName("needle-hand")!.visible, model).toBe(true);
        support.updateMatrixWorld(true);
        const lowest = new Map<string, number>();
        for (const digit of ["thumb", "index", "middle", "ring", "little"]) for (const part of ["skin", "nail"]) {
          const mesh = support.getObjectByName(`${digit}_${part}`) as Mesh, position = mesh.geometry.getAttribute("position"), v = new Vector3();
          for (let i = 0; i < position.count; i++) {
            if (mesh instanceof SkinnedMesh) mesh.getVertexPosition(i, v); else v.fromBufferAttribute(position, i);
            lowest.set(digit, Math.min(lowest.get(digit) ?? Infinity, v.applyMatrix4(mesh.matrixWorld).sub(site.p).dot(site.n) * 1000));
          }
        }
        // where the thumb's end is, beside the needle's entry
        const tip = support.getObjectByName("thumb_tip")!.getWorldPosition(new Vector3()).sub(site.p);
        scene.procedure.stopPreview();
        return { lowest: [...lowest].sort((a, b) => a[1] - b[1]), besideMm: Math.hypot(tip.x, tip.z) * 1000, tipAboveMm: tip.dot(site.n) * 1000 };
      };
      // the operative catalogue: the thumb's pulp is on the skin a couple of fingers' breadths from the needle, the fingers clear of it
      const pressing = lowestByDigit("operative");
      expect(pressing.lowest[0]![0]).toBe("thumb");
      expect(pressing.lowest[0]![1]).toBeGreaterThan(1.5);
      expect(pressing.lowest[0]![1]).toBeLessThan(2.6);
      expect(pressing.lowest[1]![1]).toBeGreaterThan(4);
      expect(pressing.besideMm).toBeGreaterThan(25);
      expect(pressing.besideMm).toBeLessThan(45);
      expect(pressing.tipAboveMm).toBeLessThan(6);
      // the illustrative catalogue keeps the hand it was recorded with: the heel of the palm, the thumb's end well off the skin
      expect(lowestByDigit("illustrative").tipAboveMm).toBeGreaterThan(20);
    } finally { scene.dispose(); }
  });

  it("gives an insertion on an operative encounter the same pressing hand: the thumb beside the point", async () => {
    const thumbAbove = async (catalogue: "operative" | undefined) => {
      const scene = await makeScene();
      try {
        scene.procedure.catalogue = catalogue;
        scene.needles.sync([{ id: NEEDLE, target: "BL23:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: DEPTH_CM, length: 0.04 },
          { id: "needle-b", target: "BL25:left", site: { ...site, p: site.p.clone().add(new Vector3(0, 0, 0.06)) }, angleDeg: 0, azimuthDeg: 0, depthCm: DEPTH_CM, length: 0.04 }], 0, true);
        scene.procedure.setInsertionPresentation("needle-b", { durationMs: 4000, support: "press" });
        scene.procedure.sync(); scene.procedure.tick(0); scene.procedure.tick(2200);
        const support = scene.procedure.group.getObjectByName("support-hand")!;
        expect(support.visible, String(catalogue)).toBe(true);
        support.updateMatrixWorld(true);
        return support.getObjectByName("thumb_tip")!.getWorldPosition(new Vector3()).sub(site.p).dot(site.n) * 1000;
      } finally { scene.dispose(); }
    };
    expect(await thumbAbove("operative")).toBeLessThan(6);
    // a record of the other catalogue is drawn as it was recorded: the heel of the palm
    expect(await thumbAbove(undefined)).toBeGreaterThan(20);
  });

  it("keeps the nails out of their own fingertips' shadow: a nail casts a shadow and takes none, the skin takes both", async () => {
    const scene = await makeScene();
    try {
      for (const name of ["needle-hand", "support-hand"]) {
        const nails: Mesh[] = [], skins: Mesh[] = [];
        scene.procedure.group.getObjectByName(name)!.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          const material = (object.material as { name?: string }).name;
          if (material === "hand_nails") nails.push(object); else if (material === "hand_skin") skins.push(object);
        });
        expect(nails.map((nail) => nail.name).sort(), name).toEqual(["index_nail", "little_nail", "middle_nail", "ring_nail", "thumb_nail"]);
        expect(nails.every((nail) => nail.castShadow && !nail.receiveShadow), name).toBe(true);
        expect(skins.length, name).toBeGreaterThan(4);
        expect(skins.every((skin) => skin.castShadow && skin.receiveShadow), name).toBe(true);
      }
    } finally { scene.dispose(); }
  });

  it("brings the thumbnail down onto the skin as it nips and lifts it between one nip and the next", async () => {
    const scene = await makeScene();
    try {
      const motion = resolveOperationMotion("she"), envelope = sampleProcedure("work", 0, motion.durationMs);
      expect(scene.procedure.preview(input("she"))).toBe(true);
      scene.procedure.setPlayback({ paused: true });
      const hand = scene.procedure.group.getObjectByName("needle-hand")!, nail = hand.getObjectByName("thumb_nail") as Mesh;
      const rimAbove = () => {
        hand.updateMatrixWorld(true);
        const position = nail.geometry.getAttribute("position"), v = new Vector3();
        let lowest = Infinity;
        for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, v.fromBufferAttribute(position, i).applyMatrix4(nail.matrixWorld).sub(site.p).dot(site.n));
        return lowest * 1000;
      };
      const bearing: number[] = [], lifted: number[] = [];
      for (let ms = 10; ms < motion.durationMs; ms += 30) {
        scene.procedure.setPlayback({ progress: (envelope.operationStartMs + ms) / envelope.durationMs });
        const share = sampleOperation("she", ms, motion).nailContact / motion.contactIntensity;
        if (share > 0.98) bearing.push(rimAbove()); else if (share < 0.02) lifted.push(rimAbove());
      }
      expect(bearing.length).toBeGreaterThan(8);
      expect(lifted.length).toBeGreaterThan(8);
      // on the skin (the schematic skin does not give: a hair above it), and two to three millimetres off it in between
      expect(Math.max(...bearing)).toBeLessThan(0.5);
      expect(Math.min(...bearing)).toBeGreaterThan(0);
      expect(Math.min(...lifted)).toBeGreaterThan(2);
      expect(Math.max(...lifted)).toBeLessThan(3.2);
    } finally { scene.dispose(); }
  });

  it("keeps the pressing hand in place on the real patient: at the point, and beside the needle that stands in it", async () => {
    const scene = await makeWorkingScene();
    try {
      const cases = [["chuai", false], ["zhua", false], ["xun", false], ["she", false], ["an", false], ["men", false], ["xun", true], ["she", true], ["an", true]] as const;
      for (const [id, beside] of cases) {
        const motion = resolveOperationMotion(id);
        const envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview({ id: `preview-${id}`, technique: id, site: scene.site, model: "operative", ...(beside ? { needleId: NEEDLE } : {}) }), id).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        const lost: string[] = [];
        for (let step = 1; step < 24; step++) {
          const progress = step / 24, at = progress * envelope.durationMs;
          scene.procedure.setPlayback({ progress });
          if (at <= envelope.operationStartMs + 1 || at >= envelope.operationStartMs + motion.durationMs - 1) continue;
          const state = scene.procedure.playback;
          if (!scene.procedure.group.getObjectByName("needle-hand")!.visible || state.reachWarning) lost.push(`${Math.round(progress * 100)}% ${state.phase}: ${state.reachWarning ?? "hidden"}`);
        }
        expect(lost, `${id}${beside ? " beside the needle" : ""}: the hand left the skin`).toEqual([]);
        scene.procedure.stopPreview();
      }
      // and as the pressing hand of a needle technique: its thumb beside the needle while the other hand works it
      for (const id of ["nian", "shao-shan-huo"] as const) {
        const motion = resolveOperationMotion(id, { support: "press" }), envelope = sampleProcedure("work", 0, motion.durationMs);
        expect(scene.procedure.preview({ id: `preview-pressed-${id}`, technique: id, site: scene.site, model: "operative", needleId: NEEDLE, motion: { support: "press" } }), id).toBe(true);
        scene.procedure.setPlayback({ paused: true });
        const lost: string[] = [];
        for (let step = 1; step < 24; step++) {
          const progress = step / 24, at = progress * envelope.durationMs;
          scene.procedure.setPlayback({ progress });
          if (at <= envelope.operationStartMs + 1 || at >= envelope.operationStartMs + motion.durationMs - 1) continue;
          const state = scene.procedure.playback;
          const both = scene.procedure.group.getObjectByName("needle-hand")!.visible && scene.procedure.group.getObjectByName("support-hand")!.visible;
          if (!both || state.reachWarning) lost.push(`${Math.round(progress * 100)}% ${state.phase}: ${state.reachWarning ?? "hidden"}`);
        }
        expect(lost, `${id} with a pressing hand`).toEqual([]);
        scene.procedure.stopPreview();
      }
    } finally { scene.dispose(); }
  }, 300_000);

  it("takes the stroking hand along the channel on the skin, and beside a needle keeps it clear of the entry", async () => {
    const scene = await makeScene();
    try {
      const motion = resolveOperationMotion("xun");
      const envelope = sampleProcedure("work", 0, motion.durationMs);
      const contactAt = (ms: number) => {
        scene.procedure.setPlayback({ progress: (envelope.operationStartMs + ms) / envelope.durationMs });
        const frame = scene.procedure.inspectionFrame();
        expect(frame, `the hand at ${ms} ms`).not.toBeNull();
        return frame!.contact.clone().sub(site.p);
      };
      // at a mark: to and fro along v, through the point
      expect(scene.procedure.preview(input("xun"))).toBe(true);
      scene.procedure.setPlayback({ paused: true });
      const travel: number[] = [], aside: number[] = [];
      for (let ms = 20; ms < motion.durationMs; ms += 60) { const d = contactAt(ms); travel.push(d.z * 1000); aside.push(d.x * 1000); }
      expect(Math.max(...travel)).toBeGreaterThan(28);
      expect(Math.min(...travel)).toBeLessThan(-28);
      expect(Math.max(...aside.map(Math.abs))).toBeLessThan(0.5);
      scene.procedure.stopPreview();
      // named with the retained needle: the same strokes, a finger's breadth to the side of its entry
      expect(scene.procedure.preview(input("xun", { needleId: NEEDLE }))).toBe(true);
      scene.procedure.setPlayback({ paused: true });
      const beside: number[] = [];
      for (let ms = 20; ms < motion.durationMs; ms += 60) beside.push(contactAt(ms).x * 1000);
      expect(Math.min(...beside)).toBeGreaterThan(11.5);
      expect(Math.max(...beside)).toBeLessThan(12.5);
      // and it arrives there and leaves from there: the hand is never brought to the needle's own entry
      const along = (d: Vector3) => Math.hypot(d.x, d.z) * 1000;
      expect(along(contactAt(-1).sub(contactAt(1)))).toBeLessThan(1);
      expect(along(contactAt(motion.durationMs + 1).sub(contactAt(motion.durationMs - 1)))).toBeLessThan(1);
      expect(along(contactAt(-40))).toBeGreaterThan(11);
      scene.procedure.stopPreview();
      // 摄 begins at its first station and ends at its last: the hand comes to the one and goes from the other
      const nips = resolveOperationMotion("she"), nipEnvelope = sampleProcedure("work", 0, nips.durationMs);
      expect(scene.procedure.preview(input("she"))).toBe(true);
      scene.procedure.setPlayback({ paused: true });
      const nipAt = (ms: number) => { scene.procedure.setPlayback({ progress: (nipEnvelope.operationStartMs + ms) / nipEnvelope.durationMs }); return scene.procedure.inspectionFrame()!.contact.clone().sub(site.p); };
      expect(nipAt(-1).z * 1000).toBeCloseTo(-24, 0);
      expect(nipAt(1).z * 1000).toBeCloseTo(-24, 0);
      expect(nipAt(nips.durationMs - 1).z * 1000).toBeCloseTo(24, 0);
      expect(nipAt(nips.durationMs + 1).z * 1000).toBeCloseTo(24, 0);
      scene.procedure.stopPreview();
    } finally { scene.dispose(); }
  });
});
