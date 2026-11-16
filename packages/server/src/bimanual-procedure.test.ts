import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Box3, Group, Mesh, Quaternion, Ray, Raycaster, SkinnedMesh, Texture, Triangle, Vector3, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ArticulatedHand, handOrientation, surfaceHandOrientation } from "../web/stage/hand.js";
import { NeedleProcedure, type InsertionPresentation, type TechniquePerformanceInput } from "../web/stage/procedure.js";
import { NeedleLayer } from "../web/stage/needles.js";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { Person as ScenePerson, practitionerPlacement } from "../web/stage/cast.js";
import { patientFloorPlacement, practitionerFloorPlacement } from "../web/stage/navigation.js";
import { SiteFinder } from "../web/stage/sites.js";
import type { Person } from "../web/stage/cast.js";
import type { SkinSite } from "../web/stage/sites.js";
import { needleHandleRadiusAt } from "../web/stage/needle-shape.js";
import { PatientClearance } from "../web/stage/clearance.js";
import { sampleProcedure } from "../web/stage/choreography.js";

const asset = readFileSync(process.env.ACUCRAFT_HAND_GEOMETRY_FIXTURE ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const site: SkinSite = { p: new Vector3(0, 0.8, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, 1), bare: true };
const input = (technique: TechniquePerformanceInput["technique"], extra: Partial<TechniquePerformanceInput> = {}): TechniquePerformanceInput => ({ id: `performance-${technique}`, technique, site, ...extra });
const makeActor = () => {
  const targets: Record<string, Vector3 | null> = {};
  const palms: Record<string, Quaternion | null> = {};
  const actor = {
    isMoving: false, holder: new Group(),
    shoulderAt: (side: string) => new Vector3(side === "left" ? -0.2 : 0.2, 1.3, 0),
    reach: (side: string, wrist: Vector3 | null, _blend?: number, palm?: Quaternion) => {
      targets[side] = wrist?.clone() ?? null; palms[side] = palm?.clone() ?? null;
      return { wrist: wrist?.clone() ?? new Vector3(), elbow: new Vector3(), reachable: true };
    },
  };
  return { actor: actor as typeof actor & Person, targets, palms };
};

beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }) }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function makeScene(retained = false) {
  const needles = new NeedleLayer(), { actor, targets, palms } = makeActor();
  if (retained) needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, false);
  const procedure = new NeedleProcedure(needles, () => actor, () => {});
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
  await procedure.load("/hand.glb", "#cba88a");
  return { needles, actor, targets, palms, procedure, dispose() { procedure.dispose(); needles.clear(); } };
}

/** Actual public encounter enc-17441d080d46 after walking from the cart to the working side. */
async function makePublicWorkingScene() {
  const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
  const session = new EncounterSession(scenario, { seed: 1, mode: "teaching" });
  for (const request of scenario.field.solution) {
    if (request.action.type === "insert_needle") break;
    session.act(request.action);
  }
  const original = session.view();
  const view = { ...original, space: { ...original.space, you: { ...original.space.you, x: 0.25, z: -4.25, yaw: -2.5324, room: "treatment-room" } } };
  // These are the public stage's real appearance and seeds, rather than the
  // default Person or a reach stub. They determine the actual figure geometry.
  const patient = new ScenePerson({ presentation: "feminine", skin: "#c39a74", hair: "#1e1917", hairStyle: "ponytail", shirt: "#3f8c86", pants: "#2f3a4a", build: "average", stature: "adult", gown: false, accessory: "none" },
    patientFloorPlacement(view, 160, "patient:sg-low-back-pain/base"));
  const seed = "practitioner:enc-17441d080d46", placement = practitionerFloorPlacement(view, seed);
  placement.options.wear = practitionerPlacement("treatment", 1, 0, seed).options.wear;
  const actor = new ScenePerson({ skin: "#d9b48f", hair: "#24201d", hairStyle: "short", shirt: "#dfe7ea", pants: "#2f3a45", build: "average", presentation: "neutral" }, placement);
  const geometry = { region: "lumbar", side: "left" as const, u: 3.32, v: 6.91, depthCm: 1.8, angleDeg: 0, azimuthDeg: 0, lengthMm: 40, diameterMm: 0.25 };
  const site = new SiteFinder(patient.rig).find(geometry)!;
  expect(site, "actual public BL23:left skin point").not.toBeNull();
  const needles = new NeedleLayer(), procedure = new NeedleProcedure(needles, () => actor, () => {}, () => patient);
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
  await procedure.load("/hand.glb", "#d9b48f");
  needles.sync([{ id: "pack-a.1", target: "BL23:left", site, angleDeg: geometry.angleDeg, azimuthDeg: geometry.azimuthDeg,
    depthCm: geometry.depthCm, length: geometry.lengthMm / 1000, diameterMm: geometry.diameterMm }], 0, false);
  needles.tick(0, 0);
  return { patient, actor, needles, procedure, site, dispose() { procedure.dispose(); needles.clear(); actor.dispose(); patient.dispose(); } };
}

function surfaceDistance(root: Object3D, digit: "thumb" | "index" | "middle", contactName: string): number {
  const surface = root.getObjectByName(`${digit}_skin`) as SkinnedMesh;
  surface.skeleton.update();
  const point = root.getObjectByName(contactName)!.getWorldPosition(new Vector3());
  const positions = Array.from({ length: surface.geometry.getAttribute("position").count }, (_, i) => surface.getVertexPosition(i, new Vector3()).applyMatrix4(surface.matrixWorld));
  const indices = surface.geometry.index!, triangle = new Triangle(), closest = new Vector3();
  let distance = Infinity;
  for (let i = 0; i < indices.count; i += 3) {
    triangle.set(positions[indices.getX(i)]!, positions[indices.getX(i + 1)]!, positions[indices.getX(i + 2)]!);
    distance = Math.min(distance, triangle.closestPointToPoint(point, closest).distanceTo(point));
  }
  return distance;
}

function expectHeldSurfaces(root: Object3D, handle: { point: Vector3; axis: Vector3 }, indexName = "index_pad_contact", axialY = 0): void {
  const branch = root.getObjectByName("palm_frame")?.userData.contactFrameHorizontalBranch;
  const stagger = indexName === "index_side_contact" && branch !== -1 && branch !== 1 ? 0.00025 : 0;
  for (const [digit, name] of [["thumb", "thumb_pad_contact"], ["index", indexName]] as const) {
    const anchor = root.getObjectByName(name)!, point = anchor.getWorldPosition(new Vector3()), delta = point.clone().sub(handle.point);
    const axial = delta.dot(handle.axis), radial = delta.addScaledVector(handle.axis, -axial);
    const targetY = axialY + (digit === "thumb" ? stagger : -stagger);
    expect(Math.abs(axial - targetY), `${name} axial contact`).toBeLessThan(0.000025);
    expect(Math.abs(radial.length() - needleHandleRadiusAt(targetY)), `${name} radial contact`).toBeLessThan(0.000025);
    const normal = anchor.localToWorld(new Vector3(0, 1, 0)).sub(point).normalize();
    expect(normal.dot(radial.normalize()), `${name} opposed surface normal`).toBeLessThan(-0.995);
    expect(surfaceDistance(root, digit, name), `${name} actual deformed skin`).toBeLessThan(0.00005);
  }
}

function threeFingerLayout(root: Object3D): { primaryY: number; middleY: number } {
  const branch = root.getObjectByName("palm_frame")?.userData.contactFrameHorizontalBranch;
  const refitted = (branch === -1 || branch === 1) && !!root.getObjectByName("middle_volar_pulp_88_contact");
  return refitted ? { primaryY: -0.006, middleY: 0.011164059024878269 } : { primaryY: -0.012, middleY: 0.010 };
}

function hasRefittedNailRoles(root: Object3D): boolean {
  const branch = root.getObjectByName("palm_frame")?.userData.contactFrameHorizontalBranch;
  return (branch === -1 || branch === 1) && !!root.getObjectByName("index_nail_edge_contact");
}

/** Independent world-triangle parity and distance for the deliberately blocked renderer fixture. */
function patientInteriorDepth(point: Vector3, patient: ScenePerson): number {
  patient.holder.updateWorldMatrix(true, true);
  const directions = [[0.431, 0.293, 0.853], [0.853, 0.431, 0.293], [0.293, 0.853, 0.431]].map((v) => new Vector3(...v).normalize());
  let depth = 0;
  for (const mesh of new Set(patient.rig.skin.map((skin) => skin.mesh))) {
    if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
    const positions = mesh.geometry.getAttribute("position"), indices = mesh.geometry.index!;
    const vertices = Array.from({ length: positions.count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
    if (!new Box3().setFromPoints(vertices).containsPoint(point)) continue;
    const triangles = Array.from({ length: indices.count / 3 }, (_, i) => new Triangle(vertices[indices.getX(i * 3)]!, vertices[indices.getX(i * 3 + 1)]!, vertices[indices.getX(i * 3 + 2)]!));
    const probe = new Vector3(); let votes = 0;
    for (const direction of directions) {
      const ray = new Ray(point, direction), hits: number[] = [];
      for (const triangle of triangles) if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, probe)) {
        const distance = point.distanceTo(probe);
        if (distance > 1e-8 && !hits.some((hit) => Math.abs(hit - distance) < 1e-7)) hits.push(distance);
      }
      if (hits.length % 2) votes++;
    }
    if (votes < 2) continue;
    let nearest = Infinity;
    for (const triangle of triangles) nearest = Math.min(nearest, triangle.closestPointToPoint(point, probe).distanceTo(point));
    depth = Math.max(depth, nearest);
  }
  return depth;
}

describe("reference hand scene integration", () => {
  it("carries an already-held needle above the skin during approach, then follows the recorded insertion", async () => {
    const s = await makeScene();
    s.needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, true);
    s.procedure.setInsertionPresentation("needle-a", { durationMs: 4000, hand: "right", grip: "two-finger", support: "none", gripApertureMm: 12 });
    const initialGrip = s.needles.grip("needle-a")!.point.clone();
    s.procedure.sync(); s.procedure.tick(0); s.procedure.tick(430);
    const root = s.procedure.group.getObjectByName("needle-hand")!;
    expect(root.visible).toBe(true);
    s.procedure.group.updateMatrixWorld(true);
    expectHeldSurfaces(root, s.needles.grip("needle-a")!);
    const tip = s.needles.group.getObjectByName("needle-tip")!;
    const hover = tip.getWorldPosition(new Vector3()).sub(site.p).dot(site.n);
    expect(hover).toBeGreaterThan(0.06);
    expect(s.needles.grip("needle-a")!.point.clone().sub(initialGrip).dot(site.n)).toBeGreaterThan(0.06);

    s.procedure.tick(900); s.procedure.group.updateMatrixWorld(true);
    expectHeldSurfaces(root, s.needles.grip("needle-a")!);
    const beforeInsertion = tip.getWorldPosition(new Vector3()).sub(site.p).dot(site.n);
    expect(beforeInsertion).toBeGreaterThan(0.005);
    expect(hover - beforeInsertion).toBeGreaterThan(0.06);
    expect(s.needles.grip("needle-a")!.point.distanceTo(initialGrip)).toBeLessThan(0.000025);
    expect(s.needles.transitions()).toContainEqual({ id: "needle-a", kind: "insert" });

    s.procedure.tick(7000);
    expect(s.needles.transitions()).toEqual([]);
    expect(tip.getWorldPosition(new Vector3()).sub(site.p).dot(site.n)).toBeCloseTo(-0.02, 7);
    s.dispose();
  });

  it.each(["insertion", "preview"] as const)("routes the three public presentation controls into real %s geometry", async (mode) => {
    const capture = async (side: "left" | "right", settings: Pick<InsertionPresentation, "wristElevationDeg" | "gripStyle" | "idleFingerPose">) => {
      const s = await makeScene(mode === "preview");
      if (mode === "insertion") {
        s.needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, true);
        s.procedure.setInsertionPresentation("needle-a", { ...settings, hand: side, grip: "two-finger", support: "none" });
        s.procedure.sync(); s.procedure.tick(0); s.procedure.tick(430);
      } else {
        expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { ...settings, hand: side, grip: "two-finger", support: "none", rotationDeg: 0 } }))).toBe(true);
        s.procedure.setPlayback({ progress: 0.5, paused: true });
      }
      const root = s.procedure.group.getObjectByName("needle-hand")!;
      expect(root.visible, `${mode}/${side}/${JSON.stringify(settings)}`).toBe(true);
      s.procedure.group.updateMatrixWorld(true);
      const handle = s.needles.grip("needle-a")!;
      expectHeldSurfaces(root, handle, settings.gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact");
      const point = (name: string) => root.getObjectByName(name)!.getWorldPosition(new Vector3());
      const wrist = point("wrist").sub(handle.point), height = wrist.dot(handle.axis), lateral = wrist.addScaledVector(handle.axis, -height).length();
      const middleMcp = point("middle_MCP"), middlePip = point("middle_PIP"), middleDip = point("middle_DIP");
      const snapshot = {
        elevation: Math.atan2(height, lateral) * 180 / Math.PI,
        indexTipAxial: point("index_tip").sub(handle.point).dot(handle.axis),
        middleTip: point("middle_tip"),
        middlePip: middlePip.clone().sub(middleMcp).angleTo(middleDip.clone().sub(middlePip)) * 180 / Math.PI,
      };
      s.dispose();
      return snapshot;
    };
    for (const side of ["left", "right"] as const) {
      const baseline = await capture(side, { wristElevationDeg: 55, gripStyle: "tip-pinch", idleFingerPose: "curled" });
      const raised = await capture(side, { wristElevationDeg: 60, gripStyle: "tip-pinch", idleFingerPose: "curled" });
      const lateral = await capture(side, { wristElevationDeg: 55, gripStyle: "side-pinch", idleFingerPose: "curled" });
      const relaxed = await capture(side, { wristElevationDeg: 55, gripStyle: "tip-pinch", idleFingerPose: "relaxed" });
      expect(baseline.elevation).toBeCloseTo(55, 3);
      expect(raised.elevation).toBeCloseTo(60, 3);
      expect(lateral.indexTipAxial).toBeLessThan(baseline.indexTipAxial - 0.005);
      expect(relaxed.middleTip.distanceTo(baseline.middleTip)).toBeGreaterThan(0.005);
      expect(relaxed.middlePip).toBeLessThan(baseline.middlePip - 10);
    }
  });

  it.each(["insertion", "preview"] as const)("uses the three-finger wrist default when %s omits an explicit elevation", async (mode) => {
    for (const hand of ["left", "right"] as const) {
      const s = await makeScene(mode === "preview");
      if (mode === "insertion") {
        s.needles.sync([{ id: "needle-a", target: "ST36:left", site, angleDeg: 0, azimuthDeg: 0, depthCm: 2, length: 0.04 }], 0, true);
        s.procedure.setInsertionPresentation("needle-a", { hand, grip: "three-finger", support: "none" });
        s.procedure.sync(); s.procedure.tick(0); s.procedure.tick(430);
      } else {
        expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { hand, grip: "three-finger", support: "none", rotationDeg: 0 } }))).toBe(true);
        s.procedure.setPlayback({ progress: 0.5, paused: true });
      }
      const root = s.procedure.group.getObjectByName("needle-hand")!, handle = s.needles.grip("needle-a")!;
      expect(root.visible).toBe(true);
      s.procedure.group.updateMatrixWorld(true);
      expectHeldSurfaces(root, handle, "index_pad_contact", threeFingerLayout(root).primaryY);
      const wrist = root.getObjectByName("wrist")!.getWorldPosition(new Vector3()).sub(handle.point.clone().addScaledVector(handle.axis, threeFingerLayout(root).primaryY)), height = wrist.dot(handle.axis), across = wrist.addScaledVector(handle.axis, -height).length();
      expect(Math.atan2(height, across) * 180 / Math.PI).toBeCloseTo(48, 3);
      s.dispose();
    }
  });

  it("reports the actual wrist and palm inspection frame and passes that cuff orientation to the arm solver", async () => {
    const s = await makeScene(true);
    expect(s.procedure.inspectionFrame()).toBeNull();
    for (const side of ["left", "right"] as const) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { hand: side, support: "none", rotationDeg: 0, wristElevationDeg: 60 } }))).toBe(true);
      s.procedure.setPlayback({ progress: 0.5, paused: true });
      const frame = s.procedure.inspectionFrame()!;
      expect(frame).not.toBeNull();
      const root = s.procedure.group.getObjectByName("needle-hand")!, wrist = root.getObjectByName("wrist")!, cuff = root.getObjectByName("wrist_frame")!, palm = root.getObjectByName("palm_frame")!;
      const cuffOrigin = cuff.getWorldPosition(new Vector3()), palmOrigin = palm.getWorldPosition(new Vector3());
      const x = cuff.localToWorld(new Vector3(1, 0, 0)).sub(cuffOrigin).normalize(), y = cuff.localToWorld(new Vector3(0, 1, 0)).sub(cuffOrigin).normalize();
      expect(s.palms[side]).not.toBeNull();
      expect(new Vector3(1, 0, 0).applyQuaternion(s.palms[side]!).distanceTo(x)).toBeLessThan(1e-7);
      expect(new Vector3(0, 1, 0).applyQuaternion(s.palms[side]!).distanceTo(y)).toBeLessThan(1e-7);
      expect(s.palms[side]!.angleTo(root.quaternion)).toBeGreaterThan(0.2);
      expect(frame.wrist.distanceTo(wrist.getWorldPosition(new Vector3()))).toBeLessThan(1e-8);
      expect(frame.wrist.distanceTo(s.targets[side]!)).toBeLessThan(1e-8);
      expect(frame.contact.distanceTo(s.needles.grip("needle-a")!.point)).toBeLessThan(1e-8);
      const dorsal = palm.localToWorld(new Vector3(0, 1, 0)).sub(palmOrigin).normalize();
      expect(frame.palmNormal.clone().negate().distanceTo(dorsal)).toBeLessThan(1e-8);
      expect(frame.surfaceNormal.distanceTo(site.n)).toBeLessThan(1e-8);
      expect(frame.radius).toBeGreaterThan(0.04);
      for (const node of [wrist, ...["thumb", "index", "middle", "ring", "little"].map((digit) => root.getObjectByName(`${digit}_tip`)!)]) {
        expect(node.getWorldPosition(new Vector3()).distanceTo(frame.center)).toBeLessThan(frame.radius);
      }
    }
    for (const hand of ["left", "right"] as const) for (const technique of ["gua", "tan"] as const) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input(technique, { needleId: "needle-a", motion: { hand, support: "none", durationMs: 2400, cycles: 1 } }))).toBe(true);
      s.procedure.setPlayback({ progress: 0.5, paused: true });
      const frame = s.procedure.inspectionFrame()!, root = s.procedure.group.getObjectByName("needle-hand")!;
      const names = hasRefittedNailRoles(root)
        ? ["thumb_pad_contact", "index_nail_edge_contact", ...(technique === "tan" ? ["index_pad_contact"] : [])]
        : ["thumb_pad_contact", "index_pad_contact", "middle_nail_edge_contact"];
      for (const name of names) {
        const actual = root.getObjectByName(name)!.getWorldPosition(new Vector3());
        expect(frame.visibilityPoints.some((point) => point.distanceTo(actual) < 1e-8), `${hand}/${technique}/${name} actual material visibility point`).toBe(true);
      }
    }
    s.procedure.stopPreview();
    expect(s.procedure.inspectionFrame()).toBeNull();
    s.dispose();
  });

  it("carries the complete grip through the full lifting and thrusting stroke without a second local finger displacement", async () => {
    const s = await makeScene(true), durationMs = 2400, totalMs = durationMs + 1920;
    for (const side of ["left", "right"] as const) for (const gripStyle of ["tip-pinch", "side-pinch"] as const) for (const wristElevationDeg of [35, 55, 70]) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input("ti", { needleId: "needle-a", motion: {
        hand: side, support: "none", grip: "two-finger", gripStyle, wristElevationDeg,
        strokeMm: 3, cycles: 1, tempoBias: 0.5, durationMs,
      } }))).toBe(true);
      const frames: { handle: Vector3; axis: Vector3; hand: Vector3; wrist: Vector3; tip: Vector3 }[] = [];
      // Ti's physical withdrawal is 0 -> +3 -> 0 mm: lifting by +3 mm
      // followed by a -3 mm return, rather than an invented ±3 mm depth range.
      for (const workAt of [0, durationMs / 2, durationMs - 0.001]) {
        s.procedure.setPlayback({ progress: (1070 + workAt) / totalMs, paused: true });
        const root = s.procedure.group.getObjectByName("needle-hand")!, handle = s.needles.grip("needle-a")!;
        expect(root.visible, `${side}/${gripStyle}/${wristElevationDeg}/${workAt}`).toBe(true);
        s.procedure.group.updateMatrixWorld(true);
        expectHeldSurfaces(root, handle, gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact");
        const wrist = root.getObjectByName("wrist")!.getWorldPosition(new Vector3());
        const bearing = wrist.clone().sub(handle.point), height = bearing.dot(handle.axis), across = bearing.addScaledVector(handle.axis, -height).length();
        expect(Math.atan2(height, across) * 180 / Math.PI).toBeCloseTo(wristElevationDeg, 3);
        frames.push({ handle: handle.point.clone(), axis: handle.axis.clone(), hand: root.getWorldPosition(new Vector3()), wrist,
          tip: s.needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()) });
      }
      for (let step = 1; step < frames.length; step++) {
        const before = frames[step - 1]!, after = frames[step]!, delta = after.handle.clone().sub(before.handle);
        expect(Math.abs(delta.dot(before.axis) - (step === 1 ? 0.003 : -0.003))).toBeLessThan(0.000025);
        expect(delta.clone().addScaledVector(before.axis, -delta.dot(before.axis)).length()).toBeLessThan(0.000025);
        expect(after.axis.distanceTo(before.axis)).toBeLessThan(1e-10);
        for (const key of ["hand", "wrist", "tip"] as const) {
          expect(after[key].clone().sub(before[key]).distanceTo(delta), `${side}/${gripStyle}/${wristElevationDeg}/${key} full stroke`).toBeLessThan(0.000025);
        }
      }
    }
    s.dispose();
  });

  it("disposes shared PBR textures and closes each real decoded bitmap once across both hand skeletons", async () => {
    const s = await makeScene();
    const textures = new Set<Texture>();
    s.procedure.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    });
    expect(textures.size).toBeGreaterThanOrEqual(4);
    const images = [...new Set([...textures].map((texture) => texture.source.data as { close(): void; width: number; height: number; data: Uint8ClampedArray }))];
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const image of images) expect(image.data.length).toBe(image.width * image.height * 4);
    const disposed = [...textures].map((texture) => vi.spyOn(texture, "dispose")), closed = images.map((image) => vi.spyOn(image, "close"));
    s.dispose(); s.procedure.dispose();
    for (const spy of [...disposed, ...closed]) expect(spy).toHaveBeenCalledTimes(1);
    for (const image of images) expect([image.width, image.height, image.data.length]).toEqual([0, 0, 0]);
  });

  it("releases actual PBR resources when a hand finishes loading after scene disposal", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    const textures = new Set<Texture>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    });
    expect(textures.size).toBeGreaterThanOrEqual(4);
    const images = [...new Set([...textures].map((texture) => texture.source.data as { close(): void; width: number; height: number; data: Uint8ClampedArray }))];
    for (const image of images) expect(image.data.length).toBeGreaterThan(0);
    const disposed = [...textures].map((texture) => vi.spyOn(texture, "dispose")), closed = images.map((image) => vi.spyOn(image, "close"));
    let finishLoading!: (value: typeof gltf) => void;
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementationOnce(() => new Promise((resolve) => { finishLoading = resolve; }));
    const needles = new NeedleLayer(), { actor } = makeActor(), procedure = new NeedleProcedure(needles, () => actor, () => {});
    const loading = procedure.load("/hand.glb", "#cba88a");
    procedure.dispose();
    expect(procedure.group.children).toHaveLength(0);
    for (const spy of [...disposed, ...closed]) expect(spy).not.toHaveBeenCalled();
    finishLoading(gltf); await loading;
    procedure.dispose();
    expect(procedure.group.children).toHaveLength(0);
    for (const spy of [...disposed, ...closed]) expect(spy).toHaveBeenCalledTimes(1);
    for (const image of images) expect([image.width, image.height, image.data.length]).toEqual([0, 0, 0]);
    needles.clear();
  });
});

describe("articulated anatomical hand contacts", () => {
  it("keeps runtime pad and nail anchors on the real deformed skin for both mirrored hands", async () => {
    const s = await makeScene(true);
    for (const hand of ["left", "right"] as const) for (const technique of ["nian", "gua", "tan"] as const) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input(technique, { needleId: "needle-a", motion: { hand, support: "none", durationMs: 2400, grip: technique === "nian" ? "three-finger" : "two-finger" } }))).toBe(true);
      s.procedure.setPlayback({ progress: 0.5, paused: true });
      s.procedure.group.updateMatrixWorld(true);
      const root = s.procedure.group.getObjectByName("needle-hand")!;
      expect(root.visible, `${hand}/${technique}: ${s.procedure.playback.reachWarning ?? "no warning"}`).toBe(true);
      const contacts: ["thumb" | "index" | "middle", "pad" | "side" | "nail_edge"][] = technique === "nian"
        ? [["thumb", "pad"], ["index", "pad"], ["middle", "side"]]
        : hasRefittedNailRoles(root) ? [["thumb", "pad"], ["index", "nail_edge"], ...(technique === "tan" ? [["index", "pad"] as ["index", "pad"]] : [])]
        : [["thumb", "pad"], ["index", "pad"], ["middle", "nail_edge"]];
      for (const [digit, kind] of contacts) {
        const contact = root.getObjectByName(`${digit}_${kind}_contact`)!;
        const p = contact.getWorldPosition(new Vector3()), normal = contact.localToWorld(new Vector3(0, 1, 0)).sub(p).normalize();
        const surface = root.getObjectByName(kind === "nail_edge" ? `${digit}_nail` : `${digit}_skin`) as SkinnedMesh;
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
        const probes = hasRefittedNailRoles(root) && digit === "index" && kind === "nail_edge"
          ? Array.from({ length: indices.count / 3 }, (_, i) => [indices.getX(i * 3), indices.getX(i * 3 + 1), indices.getX(i * 3 + 2)])
            .filter((ids) => ids.includes(97)).map((ids) => {
              const center = vertices[ids[0]!]!.clone().add(vertices[ids[1]!]!).add(vertices[ids[2]!]!).multiplyScalar(1 / 3);
              const vertex = vertices[97]!; return vertex.clone().lerp(center, Math.min(1, 0.00002 / center.distanceTo(vertex)));
            })
          : [-0.00003, 0.00003].map((offset) => p.clone().addScaledVector(tangent, offset));
        const hits = probes.flatMap((probe) => new Raycaster(probe.clone().addScaledVector(normal, 0.01), normal.clone().negate(), 0, 0.02).intersectObject(surface, false));
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
          const holdY = grip === "three-finger" ? threeFingerLayout(root).primaryY : 0;
          expect(Math.abs(axial - holdY), `${hand}/${grip}/${workAt}/${digit} plane`).toBeLessThan(0.000025);
          expect(Math.abs(radial - needleHandleRadiusAt(holdY)), `${hand}/${grip}/${workAt}/${digit} surface`).toBeLessThan(0.000025);
        }
      }
    }
    s.dispose();
  });

  it("uses true middle pulp support above the main pinch across the full published three-finger wrist range", async () => {
    const s = await makeScene(true), total = 2400 + 1920;
    for (const hand of ["left", "right"] as const) for (const wristElevationDeg of [44, 48, 51]) {
      s.procedure.stopPreview();
      expect(s.procedure.preview(input("nian", { needleId: "needle-a", motion: { durationMs: 2400, hand, grip: "three-finger", support: "none", wristElevationDeg, rotationDeg: 0 } }))).toBe(true);
      for (const workAt of [0, 1200, 2400]) {
        s.procedure.setPlayback({ progress: (1070 + workAt) / total, paused: true });
        const root = s.procedure.group.getObjectByName("needle-hand")!, handle = s.needles.grip("needle-a")!;
        expect(root.visible, `${hand}/${wristElevationDeg}/${workAt}`).toBe(true);
        s.procedure.group.updateMatrixWorld(true);
        expectHeldSurfaces(root, handle, "index_pad_contact", threeFingerLayout(root).primaryY);
        const contact = root.getObjectByName("middle_side_contact")!, point = contact.getWorldPosition(new Vector3()), offset = point.clone().sub(handle.point), y = offset.dot(handle.axis), radial = offset.addScaledVector(handle.axis, -y);
        expect(Math.abs(y - threeFingerLayout(root).middleY)).toBeLessThan(0.000025);
        expect(Math.abs(radial.length() - needleHandleRadiusAt(threeFingerLayout(root).middleY))).toBeLessThan(0.000025);
        expect(contact.localToWorld(new Vector3(0, 1, 0)).sub(point).normalize().dot(radial.normalize())).toBeLessThan(-0.995);
        expect(surfaceDistance(root, "middle", "middle_side_contact")).toBeLessThan(0.00005);
        const wrist = root.getObjectByName("wrist")!.getWorldPosition(new Vector3()).sub(handle.point.clone().addScaledVector(handle.axis, threeFingerLayout(root).primaryY)), height = wrist.dot(handle.axis), across = wrist.addScaledVector(handle.axis, -height).length();
        expect(Math.atan2(height, across) * 180 / Math.PI).toBeCloseTo(wristElevationDeg, 3);
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
    const patient = new ScenePerson({ presentation: "feminine", ...patientInfo.appearance }, patientFloorPlacement(view, patientInfo.heightCm, "patient"));
    const placement = practitionerFloorPlacement(view, "staff");
    placement.options.wear = practitionerPlacement("treatment", 1, 0, "staff").options.wear;
    const actor = new ScenePerson({}, placement), feet = actor.rig.root.position.clone();
    const contactSite = new SiteFinder(patient.rig).find(view.localisation.marks.find((m) => m.id === insertion.mark)!)!;
    const needles = new NeedleLayer();
    needles.sync([{ id: "needle-a", target: "BL23:left", site: contactSite, angleDeg: insertion.angleDeg, azimuthDeg: insertion.azimuthDeg, depthCm: insertion.depthCm, length: 0.04 }], 0, false);
    const procedure = new NeedleProcedure(needles, () => actor, () => {}, () => patient);
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
    const pad = world(support as Group, "index_volar_contact").sub(contactSite.p);
    expect(pad.dot(contactSite.n)).toBeCloseTo(0.002, 3);
    expect(pad.length()).toBeLessThan(0.045);
    expect(actor.rig.root.position.equals(feet)).toBe(true);
    procedure.dispose(); needles.clear(); actor.dispose(); patient.dispose();
  });

  it.each((["left", "right"] as const).flatMap((hand) => [44, 48, 51].flatMap((wristElevationDeg) => [0, 90].map((rotationDeg) => ({ hand, wristElevationDeg, rotationDeg })))))
    ("keeps the actual public working-side three-finger hold clear and reachable for $hand/$wristElevationDeg°/$rotationDeg°", async ({ hand, wristElevationDeg, rotationDeg }) => {
      const s = await makePublicWorkingScene(), feet = s.actor.rig.root.position.clone();
      const before = s.needles.grip("pack-a.1")!, baseline = before.point.clone(), axis = before.axis.clone();
      const tip = s.needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3());
      try {
        expect(feet.x).toBe(0.25); expect(feet.z).toBe(-4.25);
        expect(s.procedure.preview({ id: "public-three-finger", technique: "nian", needleId: "pack-a.1", site: s.site,
          motion: { hand, grip: "three-finger", gripStyle: "tip-pinch", wristElevationDeg, idleFingerPose: "curled", support: "none", rotationDeg, cycles: 2 } })).toBe(true);
        s.procedure.setPlayback({ progress: 0.5, paused: true });
        const root = s.procedure.group.getObjectByName("needle-hand")!, handle = s.needles.grip("pack-a.1")!;
        const collides = new PatientClearance().intersects(root.children[0] as Group, s.patient);
        expect(root.visible, `actual public ${hand}/${wristElevationDeg}/${rotationDeg}: ${s.procedure.playback.reachWarning ?? "no warning"}; patient collision=${collides}`).toBe(true);
        expect(s.procedure.playback.reachWarning).toBeNull();
        expect(collides, "actual complete hand clears actual patient triangles").toBe(false);
        const layout = threeFingerLayout(root);
        expectHeldSurfaces(root, handle, "index_pad_contact", layout.primaryY);
        const middle = root.getObjectByName("middle_side_contact")!, point = middle.getWorldPosition(new Vector3());
        const delta = point.clone().sub(handle.point), y = delta.dot(handle.axis), radial = delta.addScaledVector(handle.axis, -y);
        expect(Math.abs(y - layout.middleY), "actual middle pulp contact plane").toBeLessThan(0.000025);
        expect(Math.abs(radial.length() - needleHandleRadiusAt(y)), "actual middle pulp handle contact").toBeLessThan(0.000025);
        expect(middle.localToWorld(new Vector3(0, 1, 0)).sub(point).normalize().dot(radial.normalize())).toBeLessThan(-0.995);
        expect(surfaceDistance(root, "middle", "middle_side_contact")).toBeLessThan(0.000005);
        const bearing = root.getObjectByName("wrist")!.getWorldPosition(new Vector3()).sub(handle.point.clone().addScaledVector(handle.axis, layout.primaryY));
        const height = bearing.dot(handle.axis), across = bearing.addScaledVector(handle.axis, -height).length();
        expect(Math.atan2(height, across) * 180 / Math.PI, "selected elevation remains actual").toBeCloseTo(wristElevationDeg, 3);
        expect(s.actor.rig.root.position.distanceTo(feet), "practitioner feet stay at the public working location").toBeLessThan(1e-10);
        expect(handle.point.distanceTo(baseline), "actual clinical handle remains fixed").toBeLessThan(1e-9);
        expect(handle.axis.distanceTo(axis), "actual clinical needle axis remains fixed").toBeLessThan(1e-9);
        expect(s.needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()).distanceTo(tip), "actual clinical tip remains fixed").toBeLessThan(1e-9);
        s.procedure.stopPreview();
        expect(s.needles.grip("pack-a.1")!.point.distanceTo(baseline)).toBeLessThan(1e-9);
      } finally { s.dispose(); }
    });

  it.each(["left", "right"] as const)("keeps public %s three-finger approach, work and retreat continuous while the actual patient breathes", async (hand) => {
    const s = await makePublicWorkingScene(), feet = s.actor.rig.root.position.clone();
    const baseline = s.needles.grip("pack-a.1")!, point = baseline.point.clone(), axis = baseline.axis.clone();
    const tip = s.needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()), clearance = new PatientClearance();
    try {
      expect(s.procedure.preview({ id: "public-three-finger-sequential-seeks", technique: "nian", needleId: "pack-a.1", site: s.site,
        motion: { hand, grip: "three-finger", gripStyle: "tip-pinch", wristElevationDeg: 48, idleFingerPose: "curled", support: "none", rotationDeg: 90, cycles: 2, durationMs: 2400 } })).toBe(true);
      let previous: Quaternion | undefined;
      for (let step = 0; step <= 120; step++) {
        const progress = step / 120, now = progress * 4320, dt = step ? 36 : 0, envelope = sampleProcedure("work", now, 2400);
        // Match the real animation loop. The clinical site remains the point
        // found at registration; breathing never triggers a new ray or needle.
        s.patient.tick(now, dt); s.needles.tick(dt, now);
        s.procedure.setPlayback({ progress, paused: true });
        s.actor.tick(now, dt);
        const root = s.procedure.group.getObjectByName("needle-hand")!, current = root.quaternion.clone().normalize();
        expect(root.visible, `${hand}/${progress} real breathing patient: ${s.procedure.playback.reachWarning ?? "no warning"}`).toBe(envelope.reach > 0.02);
        if (root.visible) {
          expect(s.procedure.playback.reachWarning).toBeNull();
          expect(clearance.intersects(root.children[0] as Group, s.patient), `${hand}/${progress} actual current patient surface`).toBe(false);
          if (previous) expect(current.angleTo(previous) * 180 / Math.PI, `${hand}/${progress} actual root continuity`).toBeLessThan(4);
          previous = current;
          if (envelope.grip === 1) expectHeldSurfaces(root, s.needles.grip("pack-a.1")!, "index_pad_contact", threeFingerLayout(root).primaryY);
        } else previous = undefined;
        const actual = s.needles.grip("pack-a.1")!;
        expect(actual.point.distanceTo(point), "fixed registered handle").toBeLessThan(1e-9);
        expect(actual.axis.distanceTo(axis), "fixed clinical needle axis").toBeLessThan(1e-9);
        expect(s.needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()).distanceTo(tip), "fixed clinical needle tip").toBeLessThan(1e-9);
        expect(s.actor.rig.root.position.distanceTo(feet), "fixed public working feet").toBeLessThan(1e-10);
      }
      s.procedure.stopPreview();
      expect(s.needles.grip("pack-a.1")!.point.distanceTo(point)).toBeLessThan(1e-9);
    } finally { s.dispose(); }
  });

  it.each(["nian", "gua"] as const)("keeps %s holds visible on the real patient and preserves the needle when actual geometry blocks a pose", async (technique) => {
    const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
    const session = new EncounterSession(scenario, { seed: 1, mode: "teaching" });
    const insertion = scenario.field.solution.find((r) => r.action.type === "insert_needle")!.action;
    if (insertion.type !== "insert_needle") throw new Error("Missing reference insertion");
    for (const request of scenario.field.solution) { if (request.action.type === "insert_needle") break; session.act(request.action); }
    const view = session.view(), info = scenario.case.patient as { heightCm: number; appearance?: Record<string, unknown> };
    const patient = new ScenePerson({ presentation: "feminine", ...info.appearance }, patientFloorPlacement(view, info.heightCm, "patient"));
    const contactSite = new SiteFinder(patient.rig).find(view.localisation.marks.find((m) => m.id === insertion.mark)!)!;
    const needles = new NeedleLayer();
    const placement = practitionerFloorPlacement(view, "staff");
    placement.options.wear = practitionerPlacement("treatment", 1, 0, "staff").options.wear;
    const actor = new ScenePerson({}, placement);
    const procedure = new NeedleProcedure(needles, () => actor, () => {}, () => patient);
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
    vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValueOnce(gltf);
    await procedure.load("/hand.glb", "#cba88a");
    // Six centimetres exceeds this renderer fixture's 40 mm shaft. It is
    // intentionally malformed view data, not a claim of core action acceptance.
    const depthsCm = technique === "gua" ? [1.8, 3.6, 6] : [1.8];
    for (const depthCm of depthsCm) for (const angleDeg of [0, 25, 45]) for (const hand of ["left", "right"] as const) {
      procedure.stopPreview();
      needles.sync([{ id: "needle-a", target: "BL23:left", site: contactSite, angleDeg, azimuthDeg: 0, depthCm, length: 0.04 }], 0, false);
      needles.tick(0, 0);
      const baseline = needles.grip("needle-a")!.point.clone();
      expect(procedure.preview({ id: `clearance-${depthCm}-${angleDeg}-${hand}-${technique}`, technique, needleId: "needle-a", site: contactSite,
        motion: { hand, support: "none", durationMs: 2400, cycles: 1 } })).toBe(true);
      procedure.setPlayback({ progress: 0.5, paused: true });
      const root = procedure.group.getObjectByName("needle-hand")!, visible = root.visible;
      const intersects = new PatientClearance().intersects(root.children[0] as Group, patient);
      if (depthCm === 1.8) {
        expect(visible, `${hand}/${technique}/${angleDeg} ordinary pose: ${procedure.playback.reachWarning ?? "no warning"}`).toBe(true);
        expect(intersects, "actual ordinary hand clears the real patient").toBe(false);
        expect(procedure.playback.reachWarning).toBeNull();
      } else if (depthCm === 6) {
        const edge = root.getObjectByName(hasRefittedNailRoles(root) ? "index_nail_edge_contact" : "middle_nail_edge_contact")!;
        const localY = root.worldToLocal(edge.getWorldPosition(new Vector3())).y, handle = needles.grip("needle-a")!;
        const requiredCenter = handle.point.clone().addScaledVector(handle.axis, localY);
        // A ball larger than the entire contact ring lies inside a closed real
        // body mesh. Rotating the approach cannot make that required nail clear.
        expect(patientInteriorDepth(requiredCenter, patient), `${hand}/${angleDeg} required contact ring inside actual patient`).toBeGreaterThan(needleHandleRadiusAt(localY) + 0.00005);
        expect(visible, `${hand}/${angleDeg} actual patient penetration`).toBe(false);
        expect(intersects, "actual hidden hand intersects the real patient").toBe(true);
        expect(procedure.playback.reachWarning).toContain("当前示意手型空间不足");
        expect(procedure.playback.reachWarning).not.toContain("Move closer");
      } else {
        expect(visible, `${hand}/${angleDeg} visibility follows actual patient geometry`).toBe(!intersects);
        if (intersects) expect(procedure.playback.reachWarning).toContain("当前示意手型空间不足");
        else expect(procedure.playback.reachWarning).toBeNull();
      }
      // Clearance only controls this detail model; it must never alter the recorded needle path.
      procedure.stopPreview();
      expect(needles.grip("needle-a")!.point.distanceTo(baseline)).toBeLessThan(1e-9);
    }
    if (technique === "gua") {
      needles.sync([{ id: "needle-a", target: "BL23:left", site: contactSite, angleDeg: 45, azimuthDeg: 0, depthCm: 1.8, length: 0.04 }], 0, false);
      needles.tick(0, 0);
      const baseline = needles.grip("needle-a")!, point = baseline.point.clone(), tip = needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()), axis = baseline.axis.clone(), feet = actor.rig.root.position.clone();
      expect(procedure.preview({ id: "gua-continuous-public-seeks", technique: "gua", needleId: "needle-a", site: contactSite,
        motion: { hand: "right", support: "none", durationMs: 2400, cycles: 1, lateralMm: 0 } })).toBe(true);
      let previous: Quaternion | undefined;
      // Includes approach .125 and retreat 109/120 (.90833). Every public seek
      // clears frame feedback; the same physical working branch must survive.
      for (let step = 0; step <= 120; step++) {
        const progress = step / 120, envelope = sampleProcedure("work", progress * 4320, 2400);
        procedure.setPlayback({ progress, paused: true });
        const root = procedure.group.getObjectByName("needle-hand")!, current = root.quaternion.clone().normalize();
        expect(root.visible, `${progress} stable Gua approach/work/retreat: ${procedure.playback.reachWarning ?? "no warning"}`).toBe(envelope.reach > 0.02);
        if (root.visible) {
          expect(procedure.playback.reachWarning).toBeNull();
          if (previous) expect(current.angleTo(previous) * 180 / Math.PI, `${progress} actual root turn between adjacent public seeks`).toBeLessThan(4);
          previous = current;
        } else previous = undefined;
        const actual = needles.grip("needle-a")!;
        expect(actual.point.distanceTo(point), `${progress} unchanged needle handle`).toBeLessThan(1e-9);
        expect(needles.group.getObjectByName("needle-tip")!.getWorldPosition(new Vector3()).distanceTo(tip), `${progress} unchanged internal clinical tip`).toBeLessThan(1e-9);
        expect(actual.axis.distanceTo(axis), `${progress} unchanged clinical needle axis`).toBeLessThan(1e-9);
        expect(actor.rig.root.position.distanceTo(feet), `${progress} fixed practitioner feet`).toBeLessThan(1e-9);
      }
      procedure.stopPreview();
      expect(needles.grip("needle-a")!.point.distanceTo(point)).toBeLessThan(1e-9);
    }
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
    expect(main.visible).toBe(true);
    const refitted = hasRefittedNailRoles(main), contactNode = main.getObjectByName(refitted ? "index_nail_edge_contact" : "middle_nail_edge_contact")!;
    const contact = contactNode.getWorldPosition(new Vector3());
    const handle = s.needles.grip("needle-a")!;
    const offset = contact.sub(handle.point), along = offset.dot(handle.axis);
    expect(along).toBeGreaterThanOrEqual(refitted ? -0.0081 : 0.0059);
    expect(along).toBeLessThanOrEqual(refitted ? -0.0019 : 0.0121);
    expect(Math.abs(offset.addScaledVector(handle.axis, -along).length() - needleHandleRadiusAt(along))).toBeLessThan(0.000025);
    if (refitted) {
      const thumb = main.getObjectByName("thumb_pad_contact")!.getWorldPosition(new Vector3());
      expect(thumb.distanceTo(handle.point.clone().addScaledVector(handle.axis, 0.0125)), "actual thumb tail brace").toBeLessThan(0.000025);
    } else for (const digit of ["thumb", "index"]) {
      const held = main.getObjectByName(`${digit}_pad_contact`)!.getWorldPosition(new Vector3()).sub(handle.point);
      const axial = held.dot(handle.axis);
      expect(Math.abs(axial + 0.012), `${digit} holds the lower handle`).toBeLessThan(0.000025);
      expect(Math.abs(held.addScaledVector(handle.axis, -axial).length() - needleHandleRadiusAt(axial)), `${digit} holds the handle surface`).toBeLessThan(0.000025);
    }
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
