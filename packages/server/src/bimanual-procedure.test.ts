import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group, Quaternion, Raycaster, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArticulatedHand, handOrientation, surfaceHandOrientation } from "../web/stage/hand.js";
import { NeedleProcedure, type TechniquePerformanceInput } from "../web/stage/procedure.js";
import { NeedleLayer } from "../web/stage/needles.js";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { Person as ScenePerson, patientPlacement, practitionerPlacement } from "../web/stage/cast.js";
import { practitionerFloorPlacement } from "../web/stage/navigation.js";
import { SiteFinder } from "../web/stage/sites.js";
import type { Person } from "../web/stage/cast.js";
import type { SkinSite } from "../web/stage/sites.js";
import { NEEDLE_HANDLE_RADIUS_M, needleHandleRadiusAt } from "../web/stage/needle-shape.js";

const asset = readFileSync(fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const site: SkinSite = { p: new Vector3(0, 0.8, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, 1), bare: true };
const input = (technique: TechniquePerformanceInput["technique"], extra: Partial<TechniquePerformanceInput> = {}): TechniquePerformanceInput => ({ id: `performance-${technique}`, technique, site, ...extra });
const makeActor = () => {
  const targets: Record<string, Vector3 | null> = {};
  const actor = {
    isMoving: false, holder: new Group(),
    shoulderAt: (side: string) => new Vector3(side === "left" ? -0.2 : 0.2, 1.3, 0),
    reach: (side: string, wrist: Vector3 | null) => { targets[side] = wrist?.clone() ?? null; return { wrist: wrist?.clone() ?? new Vector3(), elbow: new Vector3(), reachable: true }; },
  };
  return { actor: actor as typeof actor & Person, targets };
};

beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }) }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function makeScene(retained = false) {
  const needles = new NeedleLayer(), { actor, targets } = makeActor();
  if (retained) needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, false);
  const procedure = new NeedleProcedure(needles, () => actor, () => {});
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
  await procedure.load("/hand.glb", "#cba88a");
  return { needles, actor, targets, procedure, dispose() { procedure.dispose(); needles.clear(); } };
}

describe("articulated anatomical hand contacts", () => {
  it("keeps runtime pad and nail anchors on the real deformed skin for both mirrored hands", async () => {
    const s = await makeScene(true);
    for (const hand of ["left", "right"] as const) for (const technique of ["nian", "gua"] as const) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input(technique, { needleId: "needle-a", motion: { hand, support: "none", durationMs: 2400, grip: "three-finger" } }))).toBe(true);
      s.procedure.setPlayback({ progress: 0.5, paused: true });
      s.procedure.group.updateMatrixWorld(true);
      const root = s.procedure.group.getObjectByName("needle-hand")!;
      expect(root.visible).toBe(true);
      for (const [digit, kind] of [["thumb", "pad"], ["index", technique === "gua" ? "nail" : "pad"], ["middle", "side"]] as const) {
        const contact = root.getObjectByName(`${digit}_${kind}_contact`)!;
        const p = contact.getWorldPosition(new Vector3()), normal = contact.localToWorld(new Vector3(0, 1, 0)).sub(p).normalize();
        const surface = root.getObjectByName(kind === "nail" ? `${digit}_nail` : `${digit}_skin`) as SkinnedMesh;
        if (surface instanceof SkinnedMesh) { surface.skeleton.update(); surface.computeBoundingBox(); surface.computeBoundingSphere(); }
        // Exact crest/edge rays can miss both adjacent triangles after a mirrored world transform.
        // Measure the real deformed triangles directly, and probe either side of that shared edge.
        const vertices = Array.from({ length: surface.geometry.getAttribute("position").count }, (_, i) => surface.getVertexPosition(i, new Vector3()).applyMatrix4(surface.matrixWorld));
        const indices = surface.geometry.index!, triangle = new Triangle(), closest = new Vector3();
        let distance = Infinity;
        for (let i = 0; i < indices.count; i += 3) {
          triangle.set(vertices[indices.getX(i)]!, vertices[indices.getX(i + 1)]!, vertices[indices.getX(i + 2)]!);
          distance = Math.min(distance, triangle.closestPointToPoint(p, closest).distanceTo(p));
        }
        expect(distance, `${hand}/${technique}/${digit}/${kind} actual skin fitting`).toBeLessThan(0.00005);
        const tangent = normal.clone().cross(new Vector3(0, 1, 0));
        if (tangent.lengthSq() < 1e-8) tangent.crossVectors(normal, new Vector3(1, 0, 0));
        tangent.normalize();
        const hits = [-0.00003, 0.00003].flatMap((offset) => new Raycaster(p.clone().addScaledVector(tangent, offset).addScaledVector(normal, 0.01), normal.clone().negate(), 0, 0.02).intersectObject(surface, false));
        expect(hits.some((hit) => hit.point.distanceTo(p) < 0.00005), `${hand}/${technique}/${digit}/${kind} surface neighbourhood`).toBe(true);
      }
    }
    s.dispose();
  });

  it("hides an invalid grip and reports the pose failure separately from arm reach", async () => {
    const s = await makeScene(true);
    vi.spyOn(ArticulatedHand.prototype, "contactValid", "get").mockReturnValue(false);
    s.procedure.perform(input("nian", { needleId: "needle-a", motion: { support: "none" } }));
    s.procedure.tick(0); s.procedure.tick(1700);
    expect(s.procedure.group.getObjectByName("needle-hand")!.visible).toBe(false);
    expect(s.procedure.playback.reachWarning).toContain("natural grip");
    expect(s.procedure.playback.reachWarning).not.toContain("Move closer");
    s.dispose();
  });

  it("gives each rendered hand an independent deforming skeleton", async () => {
    const s = await makeScene(true);
    s.procedure.perform(input("nian", { needleId: "needle-a", motion: { support: "press" } }));
    s.procedure.tick(0); s.procedure.tick(1700);
    s.procedure.group.updateMatrixWorld(true);
    const main = s.procedure.group.getObjectByName("needle-hand")!, support = s.procedure.group.getObjectByName("support-hand")!;
    const mainSkin = main.getObjectByName("index_skin") as SkinnedMesh, supportSkin = support.getObjectByName("index_skin") as SkinnedMesh;
    expect(mainSkin.isSkinnedMesh).toBe(true); expect(supportSkin.isSkinnedMesh).toBe(true);
    expect(mainSkin.skeleton).not.toBe(supportSkin.skeleton);
    for (const [root, skin] of [[main, mainSkin], [support, supportSkin]] as const) {
      expect(skin.frustumCulled).toBe(false);
      for (const bone of skin.skeleton.bones) expect(root.getObjectByProperty("uuid", bone.uuid)).toBe(bone);
      skin.skeleton.update();
    }
    const vertex = mainSkin.geometry.getAttribute("position").count - 1;
    const before = mainSkin.getVertexPosition(vertex, new Vector3());
    support.getObjectByName("index_DIP")!.rotateZ(0.3);
    s.procedure.group.updateMatrixWorld(true); supportSkin.skeleton.update(); mainSkin.skeleton.update();
    expect(mainSkin.getVertexPosition(vertex, new Vector3()).distanceTo(before)).toBeLessThan(1e-8);
    s.dispose();
  });

  it("holds both individual pads at the handle surface across operation start and end", async () => {
    const s = await makeScene(true), durationMs = 2400, total = durationMs + 1920;
    for (const hand of ["left", "right"] as const) for (const grip of ["two-finger", "three-finger"] as const) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { durationMs, hand, grip, support: "none", gripApertureMm: 12 } }))).toBe(true);
      for (const workAt of [0, 1, 25, 100, 1200, 2300, 2399, 2400]) {
        s.procedure.setPlayback({ progress: (1070 + workAt) / total, paused: true });
        const root = s.procedure.group.getObjectByName("needle-hand")!, handle = s.needles.grip("needle-a")!;
        for (const digit of ["thumb", "index"]) {
          const offset = root.getObjectByName(`${digit}_pad_contact`)!.getWorldPosition(new Vector3()).sub(handle.point);
          const axial = offset.dot(handle.axis), radial = offset.addScaledVector(handle.axis, -axial).length();
          expect(Math.abs(axial), `${hand}/${grip}/${workAt}/${digit} plane`).toBeLessThan(0.000025);
          expect(Math.abs(radial - NEEDLE_HANDLE_RADIUS_M), `${hand}/${grip}/${workAt}/${digit} surface`).toBeLessThan(0.000025);
        }
      }
    }
    s.dispose();
  });

  it("uses moving pad and nail anchors while each thumb/index joint remains independently controllable", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    hand.pose({ pose: "pinch", grip: 1, phase: 0, rotationRad: 0, apertureMm: 0 });
    const pinch = hand.contact("pinch"), nail = hand.contact("nail");
    hand.pose({ pose: "scrape", grip: 1, phase: 0.35, rotationRad: 0.6, apertureMm: 6, nailContact: 1 });
    expect(hand.contact("nail").distanceTo(nail)).toBeGreaterThan(0.002);
    expect(hand.gapMm()).toBeCloseTo(6, 1);
    expect(hand.contact("pinch").distanceTo(pinch)).toBeGreaterThan(0.0001);
    const ip = gltf.scene.getObjectByName("thumb_IP")!, pip = gltf.scene.getObjectByName("index_PIP")!, dip = gltf.scene.getObjectByName("index_DIP")!;
    expect(ip.quaternion.angleTo(new Quaternion())).toBeGreaterThan(0.001);
    expect(pip.quaternion.angleTo(dip.quaternion)).toBeGreaterThan(0.001);
    const target = new Vector3(0.25, 0.88, -0.12);
    const q = handOrientation(target, site.n, new Vector3(0.5, 1.3, 0));
    hand.root.position.copy(target).sub(hand.contact("nail").applyQuaternion(q));
    hand.root.quaternion.copy(q);
    expect(hand.contactAt("nail").distanceTo(target)).toBeLessThan(1e-8);
    hand.dispose();
  });

  it("matches requested pad clearance with joint rotations, preserving bone translations for both hands", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    const translations = new Map<string, Vector3>();
    gltf.scene.traverse((node) => { if (/_(CMC|MCP|IP|PIP|DIP)$/.test(node.name)) translations.set(node.name, node.position.clone()); });
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const gap of [0, 2, 6, 12]) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.35, rotationRad: 0.65, apertureMm: gap });
        expect(hand.gapMm(), `${side} ${gap} mm`).toBeCloseTo(gap, 1);
        for (const [name, position] of translations) expect(gltf.scene.getObjectByName(name)!.position.equals(position)).toBe(true);
      }
    }
    hand.dispose();
  });

  it("aligns moving pad and nail normals against the skin for either mirrored hand", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const contact of ["index", "nail", "palm"] as const) {
        hand.pose({ pose: contact === "nail" ? "scrape" : "press", grip: 1, phase: 0.4, apertureMm: 2 });
        const normal = new Vector3(0.1, 0.96, -0.2).normalize(), target = new Vector3(0.2, 0.8, 0.1);
        const orientation = surfaceHandOrientation(hand.contact(contact), hand.wrist(), hand.contactNormal(contact), target, normal, new Vector3(-0.4, 1.3, 0));
        hand.root.position.copy(target).sub(hand.contact(contact).applyQuaternion(orientation)); hand.root.quaternion.copy(orientation);
        expect(hand.contactAt(contact).distanceTo(target)).toBeLessThan(1e-8);
        expect(hand.contactNormal(contact).applyQuaternion(orientation).dot(normal)).toBeCloseTo(-1, 7);
      }
    }
    hand.dispose();
  });

  it("builds finite palm frames for collinear shoulders and zero input normals", () => {
    for (const normal of [new Vector3(), new Vector3(1, 0, 0), new Vector3(0, 1, 0)]) {
      expect(handOrientation(new Vector3(), normal, normal.clone()).toArray().every(Number.isFinite)).toBe(true);
    }
  });
});

describe("bimanual catalogue performances", () => {
  it("animates separate skin-contact hands without inventing a needle or changing the selected site", async () => {
    const s = await makeScene();
    const before = site.p.clone();
    s.procedure.perform(input("chuai", { motion: { support: "stretch", hand: "left", durationMs: 1800 } }));
    s.procedure.tick(0); s.procedure.tick(1700);
    const main = s.procedure.group.getObjectByName("needle-hand")!, support = s.procedure.group.getObjectByName("support-hand")!;
    expect(main.visible).toBe(true); expect(support.visible).toBe(true);
    expect(main.position.distanceTo(support.position)).toBeGreaterThan(0.01);
    expect(s.targets.left).not.toBeNull(); expect(s.targets.right).not.toBeNull();
    expect(s.procedure.playback).toMatchObject({ mode: "record", technique: "chuai", playing: true });
    expect(s.needles.group.children).toHaveLength(0);
    expect(site.p.equals(before)).toBe(true);
    s.dispose();
  });

  it("reaches both reference contacts on the actual 160 cm low-back patient without moving the feet", async () => {
    const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
    const session = new EncounterSession(scenario, { seed: 1, mode: "teaching" });
    const insertion = scenario.field.solution.find((r) => r.action.type === "insert_needle")!.action;
    if (insertion.type !== "insert_needle") throw new Error("Missing reference insertion");
    for (const request of scenario.field.solution) { if (request.action.type === "insert_needle") break; session.act(request.action); }
    const view = session.view(), patientInfo = scenario.case.patient as { heightCm: number; appearance?: Record<string, unknown> };
    expect(patientInfo.heightCm).toBe(160);
    const patient = new ScenePerson({ presentation: "feminine", ...patientInfo.appearance }, patientPlacement(view.patient.position, view.patient.location, patientInfo.heightCm, "patient"));
    const placement = practitionerFloorPlacement(view, "staff");
    placement.options.wear = practitionerPlacement("treatment", 1, 0, "staff").options.wear;
    const actor = new ScenePerson({}, placement), feet = actor.rig.root.position.clone();
    const contactSite = new SiteFinder(patient.rig).find(view.localisation.marks.find((m) => m.id === insertion.mark)!)!;
    const needles = new NeedleLayer();
    needles.sync([{ id: "needle-a", target: "BL23:left", site: contactSite, angleDeg: insertion.angleDeg, azimuthDeg: insertion.azimuthDeg, depthCm: insertion.depthCm, length: 0.04 }], 0, false);
    const procedure = new NeedleProcedure(needles, () => actor, () => {});
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
    await procedure.load("/hand.glb", "#cba88a");
    procedure.perform(input("nian", { needleId: "needle-a", site: contactSite, motion: { support: "stabilize", gripApertureMm: 2 } }));
    procedure.tick(0); procedure.tick(1700); actor.tick(1700, 16);
    const main = procedure.group.getObjectByName("needle-hand")!, support = procedure.group.getObjectByName("support-hand")!;
    expect(main.visible).toBe(true); expect(support.visible).toBe(true);
    const world = (root: Group, name: string) => root.getObjectByName(name)!.getWorldPosition(new Vector3());
    const pinch = world(main as Group, "index_pad_contact").add(world(main as Group, "thumb_pad_contact")).multiplyScalar(0.5);
    expect(pinch.distanceTo(needles.grip("needle-a")!.point)).toBeLessThan(0.0001);
    const pad = world(support as Group, "index_pad_contact").sub(contactSite.p);
    expect(pad.dot(contactSite.n)).toBeCloseTo(0.002, 3);
    expect(pad.length()).toBeLessThan(0.045);
    expect(actor.rig.root.position.equals(feet)).toBe(true);
    procedure.dispose(); needles.clear(); actor.dispose(); patient.dispose();
  });

  it("keeps an accepted deflection before its later queued removal when actions arrive faster than frames", async () => {
    const s = await makeScene(true);
    const baseline = s.needles.grip("needle-a")!.point.clone();
    s.procedure.perform(input("yao", { needleId: "needle-a", motion: { durationMs: 2400, cycles: 1, lateralMm: 4, tiltDeg: 8 } }));
    s.procedure.tick(0);
    s.needles.sync([], 50, true); s.procedure.sync();
    s.procedure.tick(1800);
    expect(s.needles.grip("needle-a")!.point.distanceTo(baseline)).toBeGreaterThan(0.0001);
    expect(s.procedure.playback).toMatchObject({ mode: "record", technique: "yao" });
    s.procedure.tick(10_000); s.procedure.tick(10_020); s.procedure.tick(14_000);
    expect(s.needles.grip("needle-a")).toBeNull();
    s.dispose();
  });

  it("keeps scraping nail contact on the actual animated external handle", async () => {
    const s = await makeScene(true);
    s.procedure.perform(input("gua", { needleId: "needle-a", motion: { hand: "left", support: "none", durationMs: 1800 } }));
    s.procedure.tick(0); s.procedure.tick(1600);
    const main = s.procedure.group.getObjectByName("needle-hand")!;
    const contactNode = main.getObjectByName("index_nail_contact")!;
    const contact = contactNode.getWorldPosition(new Vector3());
    const handle = s.needles.grip("needle-a")!;
    const offset = contact.sub(handle.point), along = offset.dot(handle.axis);
    expect(along).toBeGreaterThanOrEqual(0.0039);
    expect(along).toBeLessThanOrEqual(0.0101);
    expect(Math.abs(offset.addScaledVector(handle.axis, -along).length() - needleHandleRadiusAt(along))).toBeLessThan(0.000025);
    expect(s.targets.right).toBeNull();
    expect(s.procedure.playback.phase).toContain("scraping");
    s.dispose();
  });

  it("keeps local preview seeking deterministic, restores the authoritative needle, and blocks conflicting record playback", async () => {
    const s = await makeScene(true);
    const baseline = s.needles.grip("needle-a")!.point.clone();
    expect(s.procedure.preview(input("yao", { needleId: "needle-a", motion: { durationMs: 1600 } }))).toBe(true);
    s.procedure.setPlayback({ progress: 0.55, paused: true });
    const first = s.needles.grip("needle-a")!.point.clone();
    s.procedure.setPlayback({ progress: 0.2 }); s.procedure.setPlayback({ progress: 0.55 });
    expect(s.needles.grip("needle-a")!.point.distanceTo(first)).toBeLessThan(1e-9);
    expect(s.procedure.playback).toMatchObject({ mode: "preview", progress: 0.55, playing: false });
    s.procedure.stopPreview();
    expect(s.needles.grip("needle-a")!.point.distanceTo(baseline)).toBeLessThan(1e-9);
    s.procedure.perform(input("nian", { needleId: "needle-a" }));
    expect(s.procedure.preview(input("yao", { needleId: "needle-a" }))).toBe(false);
    s.procedure.tick(0); s.procedure.tick(1500);
    const recorded = s.procedure.playback.progress;
    s.procedure.setPlayback({ progress: 0 });
    expect(s.procedure.playback.progress).toBe(recorded);
    s.dispose();
  });

  it("starts or resumes a preview from its first visible frame rather than consuming an offscreen gap", async () => {
    const s = await makeScene(true);
    s.procedure.tick(0);
    expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { durationMs: 2400 } }))).toBe(true);
    expect(s.procedure.playback).toMatchObject({ mode: "preview", progress: 0, playing: true });
    s.procedure.tick(20_000);
    expect(s.procedure.playback.progress).toBe(0);
    s.procedure.tick(20_100);
    expect(s.procedure.playback.progress).toBeGreaterThan(0);
    s.procedure.setPlayback({ paused: true });
    const paused = s.procedure.playback.progress;
    s.procedure.setPlayback({ paused: false });
    s.procedure.tick(60_000);
    expect(s.procedure.playback.progress).toBe(paused);
    s.procedure.tick(60_100);
    expect(s.procedure.playback.progress).toBeGreaterThan(paused);
    s.procedure.setPlayback({ progress: 0.5, paused: true });
    s.procedure.tick(120_000);
    expect(s.procedure.playback.progress).toBe(0.5);
    s.dispose();
  });

  it("pauses and speeds a recorded visual performance while leaving record seeking unavailable", async () => {
    const s = await makeScene(true);
    s.procedure.perform(input("nian", { needleId: "needle-a", motion: { durationMs: 2400 } }));
    s.procedure.tick(0); s.procedure.tick(1600);
    const at = s.procedure.playback.progress, grip = s.needles.grip("needle-a")!.point.clone();
    s.procedure.setPlayback({ paused: true }); s.procedure.tick(7000);
    expect(s.procedure.playback.progress).toBe(at);
    expect(s.needles.grip("needle-a")!.point.distanceTo(grip)).toBeLessThan(1e-9);
    s.procedure.setPlayback({ paused: false, speed: 2 }); s.procedure.tick(7100);
    expect(s.procedure.playback.progress).toBeCloseTo(at + 200 / s.procedure.playback.durationMs, 8);
    s.dispose();
  });

  it("cancels both reaching arms and restores the needle when an authoritative walk begins", async () => {
    const s = await makeScene(true);
    const before = s.needles.grip("needle-a")!.point.clone();
    s.procedure.perform(input("nu", { needleId: "needle-a", motion: { support: "stabilize" } }));
    s.procedure.tick(0); s.procedure.tick(1600); s.actor.isMoving = true; s.procedure.tick(1650);
    expect(s.procedure.group.visible).toBe(false);
    expect(s.targets.left).toBeNull(); expect(s.targets.right).toBeNull();
    expect(s.needles.grip("needle-a")!.point.distanceTo(before)).toBeLessThan(1e-9);
    s.dispose();
  });

  it("honors insertion duration and grip/support overrides without changing legacy defaults", async () => {
    const s = await makeScene();
    s.needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, true);
    s.procedure.setInsertionPresentation("needle-a", { durationMs: 4000, grip: "three-finger", support: "stretch", hand: "left" });
    s.procedure.sync(); s.procedure.tick(0); s.procedure.tick(1800);
    const needle = s.needles.group.getObjectByName("needle:needle-a")!;
    expect(needle.children[0]!.position.y).toBeGreaterThan(0);
    expect(s.procedure.group.getObjectByName("support-hand")?.visible).toBe(true);
    s.procedure.tick(6100);
    expect(s.needles.transitions()).toEqual([]);
    s.dispose();
  });
});
