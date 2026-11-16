import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, SkinnedMesh, Triangle, Vector3, type Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraMode } from "./types.js";

/**
 * The camera. In `auto` it is directed: a shot of the room when the patient moves, the patient's face while they
 * speak, a close view of each needle as it goes in, then back to the patient — each move eased like a camera on
 * a dolly. The viewer can take it at any time (drag, scroll): it is then `free` until given back.
 */

export interface Shot {
  eye: Vector3;
  at: Vector3;
  /** How long the move takes (ms). */
  ms?: number;
  /** How long to hold before the director may move on by itself (ms; 0: stay). */
  hold?: number;
  /** Lens (degrees of vertical field of view). */
  fov?: number;
  /** A close inspection stays on the exterior side of the patient's local skin plane. */
  exterior?: { point: Vector3; normal: Vector3 };
  /** Exact working-hand landmarks whose sightlines must clear the visible scene geometry. */
  inspectionPoints?: Vector3[];
  inspectionBlocked?: number;
  inspectionOptionalPoints?: Vector3[];
  needleAxis?: Vector3;
  inspectionAvoidDirections?: Vector3[];
  inspectionDetails?: Record<string, unknown>;
}

/** World-space landmarks of the visible working hand, supplied by its actual articulated pose. */
export interface HandInspectionFrame {
  contact: Vector3;
  wrist: Vector3;
  palmNormal: Vector3;
  radial: Vector3;
  surfaceNormal?: Vector3;
  center?: Vector3;
  radius: number;
  visibilityPoints?: Vector3[];
  needleAxis?: Vector3;
}
export const GRIP_VIEWS = ["three-quarter", "side", "palmar"] as const;
export type GripView = typeof GRIP_VIEWS[number];

/** Fit the whole grip and wrist rather than aiming only at the needle's skin entry. */
export function gripShot(frame: HandInspectionFrame, view: GripView, aspect = 16 / 9): Shot {
  const normal = frame.surfaceNormal?.clone() ?? new Vector3(0, 1, 0);
  if (normal.lengthSq() < 1e-10) normal.set(0, 1, 0);
  normal.normalize();
  const along = frame.wrist.clone().sub(frame.contact);
  if (along.lengthSq() < 1e-10) along.set(1, 0, 0);
  along.normalize();
  const radial = frame.radial.clone();
  if (radial.lengthSq() < 1e-10) radial.crossVectors(along, normal);
  if (radial.lengthSq() < 1e-10) radial.set(0, 0, 1);
  radial.normalize();
  const palmar = frame.palmNormal.clone();
  if (palmar.lengthSq() < 1e-10) palmar.crossVectors(radial, along);
  palmar.normalize();
  const direction = view === "side" ? radial.clone().addScaledVector(palmar, 0.12).addScaledVector(along, 0.1)
    : view === "palmar" ? palmar.clone().addScaledVector(radial, 0.2).addScaledVector(along, -0.1)
    // From the opposed thumb's nail side, both the short thumb and curled index are identifiable.
    : radial.clone().multiplyScalar(-0.9).addScaledVector(palmar, -0.45).addScaledVector(along, -0.2);
  direction.addScaledVector(normal, 0.25).normalize();
  // A palm-facing shot can otherwise put the eye inside the patient. Retain the requested
  // tangent direction while keeping every inspection angle in the skin's exterior hemisphere.
  const outward = direction.dot(normal);
  if (outward < 0.34) {
    direction.addScaledVector(normal, -outward);
    if (direction.lengthSq() < 1e-10) direction.copy(radial).addScaledVector(normal, -radial.dot(normal));
    if (direction.lengthSq() < 1e-10) direction.crossVectors(normal, new Vector3(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0));
    direction.normalize().multiplyScalar(Math.sqrt(1 - 0.34 ** 2)).addScaledVector(normal, 0.34);
  }
  const at = frame.center?.clone() ?? frame.contact.clone().lerp(frame.wrist, 0.45);
  const radius = Math.max(0.045, frame.radius, at.distanceTo(frame.wrist) + 0.015, at.distanceTo(frame.contact) + 0.045);
  const fov = 32;
  const halfAngle = Math.atan(Math.tan(fov * Math.PI / 360) * Math.min(1, Math.max(0.2, aspect)));
  const distance = radius / Math.sin(halfAngle) * 1.12;
  return { eye: at.clone().addScaledVector(direction, distance), at, fov, ms: 650, hold: 60_000,
    exterior: { point: frame.contact.clone(), normal },
    inspectionPoints: (frame.visibilityPoints?.slice(0, 3) ?? [frame.contact]).map(p => p.clone()),
    inspectionOptionalPoints: [...(frame.visibilityPoints?.slice(3) ?? []), at].map(p => p.clone()),
    needleAxis: frame.needleAxis?.clone() };
}

/** Bake posed world triangles once: figure picking is disabled and skinning per ray is expensive. */
function inspectionMeshes(objects: readonly Object3D[], material: MeshBasicMaterial): Mesh[] {
  const seen = new Set<Object3D>(), meshes: Mesh[] = [];
  for (const root of objects) {
    root.updateWorldMatrix(true, true); root.updateMatrixWorld(true);
    root.traverse(object => {
      if (!(object instanceof Mesh) || seen.has(object)) return;
      seen.add(object);
      for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.some(m => m.visible && (!m.transparent || m.opacity > 0.05))) return;
      if (object instanceof SkinnedMesh) object.skeleton.update();
      const count = object.geometry.getAttribute("position").count, vertices = new Float32Array(count * 3), point = new Vector3();
      for (let i = 0; i < count; i++) object.getVertexPosition(i, point).applyMatrix4(object.matrixWorld).toArray(vertices, i * 3);
      const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
      if (object.geometry.index) geometry.setIndex(object.geometry.index.clone());
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, material), names: string[] = [];
      for (let node: Object3D | null = object; node; node = node.parent) if (node.name) names.unshift(node.name);
      mesh.name = names.join("/") || object.type; mesh.updateMatrixWorld(true); meshes.push(mesh);
    });
  }
  return meshes;
}

/** Keep critical pulp/needle sightlines clear; cuff and centre landmarks are optional composition hints. */
export function clearGripShot(shot: Shot, objects: readonly Object3D[]): Shot {
  const started = performance.now(), points = shot.inspectionPoints ?? [shot.at], optional = shot.inspectionOptionalPoints ?? [];
  const material = new MeshBasicMaterial({ side: DoubleSide }), meshes = inspectionMeshes(objects, material), ray = new Raycaster();
  const trace = (eye: Vector3, probes: Vector3[]) => probes.map(point => {
    const direction = point.clone().sub(eye), distance = direction.length(), blockers: string[] = [];
    if (distance > 0.004) {
      ray.set(eye, direction.multiplyScalar(1 / distance)); ray.near = 0.002; ray.far = distance - 0.001;
      for (const mesh of meshes) if (ray.intersectObject(mesh).length) blockers.push(mesh.name);
    }
    return { point: point.toArray(), blockers };
  });
  try {
    const normal = shot.exterior?.normal.clone().normalize() ?? new Vector3(0, 1, 0);
    const offset = shot.eye.clone().sub(shot.at), distance = offset.length(), initial = offset.clone().normalize();
    const tangent = initial.clone().addScaledVector(normal, -initial.dot(normal));
    if (tangent.lengthSq() < 1e-8) tangent.crossVectors(normal, new Vector3(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0));
    tangent.normalize();
    const axis = shot.needleAxis?.clone().normalize(), contact = points[0] ?? shot.at;
    const allowed = (eye: Vector3) => !axis || Math.abs(eye.clone().sub(contact).normalize().dot(axis)) <= 0.8;
    const candidates: { eye: Vector3; angle: number }[] = allowed(shot.eye) ? [{ eye: shot.eye.clone(), angle: 0 }] : [];
    for (const elevation of [Math.max(0.34, Math.min(0.78, initial.dot(normal))), 0.34, 0.55, 0.78]) for (const degrees of [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150, 180]) {
      const direction = tangent.clone().applyAxisAngle(normal, degrees * Math.PI / 180).multiplyScalar(Math.sqrt(1 - Math.min(0.99, elevation) ** 2)).addScaledVector(normal, Math.min(0.99, elevation)).normalize();
      const eye = shot.at.clone().addScaledVector(direction, distance);
      if (shot.exterior && eye.clone().sub(shot.exterior.point).dot(normal) < 0.03 || !allowed(eye)) continue;
      candidates.push({ eye, angle: direction.angleTo(initial) });
    }
    const preference = (candidate: { eye: Vector3; angle: number }) => candidate.angle + ((shot.inspectionAvoidDirections ?? []).some(direction => candidate.eye.clone().sub(shot.at).normalize().angleTo(direction) < 15 * Math.PI / 180) ? 2.5 : 0);
    candidates.sort((a, b) => preference(a) - preference(b));
    let best = shot.eye, bestBlocked = Infinity;
    for (const candidate of candidates) {
      const count = trace(candidate.eye, points).filter(p => p.blockers.length).length;
      if (count < bestBlocked) { best = candidate.eye; bestBlocked = count; }
      if (!count) break;
    }
    const insideSupport = points.map((point, probe) => {
      const containing: { mesh: string; depthMm: number }[] = [];
      for (const mesh of meshes.filter(m => m.name.includes("support-hand"))) {
        if (!mesh.geometry.boundingBox!.containsPoint(point)) continue;
        let votes = 0;
        for (const direction of [new Vector3(.929,.173,.327), new Vector3(-.231,.941,.247), new Vector3(.317,-.427,.846)]) {
          ray.set(point, direction.normalize()); ray.near = 1e-7; ray.far = Infinity;
          const distances = ray.intersectObject(mesh).map(h => h.distance).sort((a,b) => a-b).filter((d,i,all) => !i || d-all[i-1]! > 1e-7);
          if (distances.length % 2) votes++;
        }
        if (votes < 2) continue;
        const p = mesh.geometry.getAttribute("position"), index = mesh.geometry.index, triangle = new Triangle(), nearest = new Vector3(); let depth = Infinity;
        for (let i = 0, n = index?.count ?? p.count; i < n; i += 3) {
          triangle.a.fromBufferAttribute(p, index ? index.getX(i) : i); triangle.b.fromBufferAttribute(p, index ? index.getX(i+1) : i+1); triangle.c.fromBufferAttribute(p, index ? index.getX(i+2) : i+2);
          depth = Math.min(depth, triangle.closestPointToPoint(point, nearest).distanceTo(point));
        }
        if (depth > 0.00005) containing.push({ mesh: mesh.name, depthMm: depth * 1000 });
      }
      return { probe, containing };
    });
    return { ...shot, eye: best.clone(), inspectionBlocked: bestBlocked,
      inspectionDetails: { cpuMs: performance.now() - started, eye: best.toArray(), direction: best.clone().sub(shot.at).normalize().toArray(), requestedAngleDifferenceDeg: best.clone().sub(shot.at).angleTo(initial) * 180 / Math.PI, shaftAlignment: axis ? Math.abs(best.clone().sub(contact).normalize().dot(axis)) : null, critical: trace(best, points), optional: trace(best, optional), insideSupport } };
  } finally { for (const mesh of meshes) mesh.geometry.dispose(); material.dispose(); }
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Director {
  readonly controls: OrbitControls;
  mode: CameraMode = "auto";
  onMode: (mode: CameraMode) => void = () => {};
  private move: { from: Shot; to: Shot; start: number; ms: number } | null = null;
  private holdUntil = 0;
  private home: () => Shot = () => ({ eye: new Vector3(2.2, 1.9, 2.6), at: new Vector3(0, 0.7, 0) });
  private touched = false;
  private readonly lastSway = new Vector3();

  constructor(private readonly camera: PerspectiveCamera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 0.18;
    this.controls.maxDistance = 6.5;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.8;
    this.controls.panSpeed = 0.6;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("start", () => {
      this.touched = true;
      this.move = null;
      if (this.mode !== "free") {
        this.mode = "free";
        this.onMode(this.mode);
      }
    });
  }

  /** What a shot must see past (the set, the people): a camera is never put behind a curtain or inside a wall. */
  obstacles: () => Object3D[] = () => [];
  inspectionObstacles: () => Object3D[] = () => this.obstacles();
  private inspectedBlocked: number | null = null;
  private inspectedDetails: Record<string, unknown> | null = null;
  get inspectionDetails(): Record<string, unknown> | null { return this.inspectedDetails; }
  get inspectionBlocked(): number | null { return this.inspectedBlocked; }
  private readonly sight = new Raycaster();

  /**
   * The shot, or one swung round its subject until nothing stands between the eye and what it looks at: the same
   * distance, turned 35°, 70°, 110° and 150° either way, then raised — the first clear one.
   */
  clear(shot: Shot): Shot {
    if (shot.inspectionPoints) {
      const clear = clearGripShot(shot, this.inspectionObstacles());
      this.inspectedBlocked = clear.inspectionBlocked ?? null;
      this.inspectedDetails = clear.inspectionDetails ?? null;
      return clear;
    }
    this.inspectedBlocked = null;
    const objects = this.obstacles();
    if (!objects.length) return shot;
    // the subject and a margin round it must be in sight: five rays, to its centre and round it
    const blockedRay = (from: Vector3, eye: Vector3) => {
      const dir = eye.clone().sub(from);
      const far = dir.length();
      dir.normalize();
      this.sight.set(from.clone().addScaledVector(dir, 0.06), dir);
      this.sight.far = Math.max(0, far - 0.06);
      return this.sight.intersectObjects(objects, true).some((h) => (h.object as { isMesh?: boolean }).isMesh && h.object.visible);
    };
    const blocked = (eye: Vector3) => {
      const look = shot.at.clone().sub(eye).normalize();
      const side = new Vector3().crossVectors(look, new Vector3(0, 1, 0)).normalize();
      const up = new Vector3().crossVectors(side, look).normalize();
      const r = Math.min(0.35, eye.distanceTo(shot.at) * 0.18);
      return [shot.at, shot.at.clone().addScaledVector(side, r), shot.at.clone().addScaledVector(side, -r), shot.at.clone().addScaledVector(up, r * 0.6), shot.at.clone().addScaledVector(up, -r * 0.6)].some((p) => blockedRay(p, eye));
    };
    const outside = (eye: Vector3) => !shot.exterior || eye.clone().sub(shot.exterior.point).dot(shot.exterior.normal) > 0.03;
    if (outside(shot.eye) && !blocked(shot.eye)) return shot;
    const offset = shot.eye.clone().sub(shot.at);
    for (const lift of [0, 0.25, 0.5]) {
      for (const deg of [35, -35, 70, -70, 110, -110, 150, -150]) {
        const a = (deg * Math.PI) / 180;
        const o = new Vector3(offset.x * Math.cos(a) - offset.z * Math.sin(a), offset.y + lift, offset.x * Math.sin(a) + offset.z * Math.cos(a));
        const eye = shot.at.clone().add(o);
        if (eye.y > 0.25 && outside(eye) && !blocked(eye)) return { ...shot, eye };
      }
    }
    return shot;
  }

  /** The shot the director returns to when nothing else is happening. */
  setHome(home: () => Shot): void {
    this.home = home;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.onMode(mode);
    if (mode === "auto") this.cut(this.home(), 1400);
  }

  /** Move to a shot (in `auto`; `force` also in `free`, as when the viewer asks for it). */
  cut(shot: Shot, ms = shot.ms ?? 1300, force = false): void {
    if (this.mode !== "auto" && !force) return;
    shot = this.clear(shot);
    const from: Shot = { eye: this.camera.position.clone(), at: this.controls.target.clone(), fov: this.camera.fov };
    this.move = { from, to: { ...shot, fov: shot.fov ?? from.fov }, start: performance.now(), ms: Math.max(1, ms) };
    this.holdUntil = performance.now() + ms + (shot.hold ?? 0);
  }

  /** Put the camera on a shot at once (the first frame). */
  place(shot: Shot): void {
    shot = this.clear(shot);
    this.move = null;
    this.camera.position.copy(shot.eye);
    this.controls.target.copy(shot.at);
    if (shot.fov) {
      this.camera.fov = shot.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /** Whether a held shot has run its time (the director may return home). */
  get idle(): boolean {
    return this.mode === "auto" && !this.move && performance.now() > this.holdUntil;
  }

  /** A shot of a point on the body, from outside it along its normal, leaning towards where the camera is. */
  closeOn(p: Vector3, n: Vector3, distance = 0.78): Shot {
    const toCam = this.camera.position.clone().sub(p).normalize();
    const dir = n.clone().multiplyScalar(0.62).add(toCam.multiplyScalar(0.55)).add(new Vector3(0, 0.3, 0)).normalize();
    // never from below: a site facing the couch (the back of a hand lying palm up) is looked at from above it
    if (dir.y < 0.45) {
      dir.y = 0.45;
      dir.normalize();
    }
    return { eye: p.clone().addScaledVector(dir, distance), at: p.clone(), ms: 1300, hold: 3800, fov: 30 };
  }

  /** How far the camera is from what it looks at (for the lens's focus). */
  get focusDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  get focusPoint(): Vector3 {
    return this.controls.target.clone();
  }

  update(): void {
    // held still in auto, the camera breathes a little, as one held by hand does
    if (this.mode === "auto" && !this.move) {
      const t = performance.now() / 1000;
      const sway = new Vector3(Math.sin(t * 0.37) * 0.0025, Math.sin(t * 0.29 + 1.3) * 0.0018, Math.cos(t * 0.31) * 0.0022);
      this.camera.position.add(sway.sub(this.lastSway));
      this.lastSway.copy(new Vector3(Math.sin(t * 0.37) * 0.0025, Math.sin(t * 0.29 + 1.3) * 0.0018, Math.cos(t * 0.31) * 0.0022));
    }
    if (this.move) {
      const k = Math.min(1, (performance.now() - this.move.start) / this.move.ms);
      const e = ease(k);
      const { from, to } = this.move;
      // the eye travels a gentle arc (it rises a little mid-way), the aim straight
      const lift = Math.sin(Math.PI * e) * Math.min(0.35, from.eye.distanceTo(to.eye) * 0.12);
      this.camera.position.lerpVectors(from.eye, to.eye, e).add(new Vector3(0, lift, 0));
      this.controls.target.lerpVectors(from.at, to.at, e);
      const fov = (from.fov ?? 38) + ((to.fov ?? 38) - (from.fov ?? 38)) * e;
      if (Math.abs(fov - this.camera.fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      if (k >= 1) this.move = null;
    }
    this.controls.update();
    void this.touched;
  }

  dispose(): void {
    this.controls.dispose();
  }
}
