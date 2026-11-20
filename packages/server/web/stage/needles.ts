import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Raycaster,
} from "three";
import { exteriorShaftMaterial } from "./needle-shaft-material.js";
import type { SkinSite } from "./sites.js";
import { insertionDepth, INSERTION_HOVER_M } from "./choreography.js";
import { INSERTION_SKIN_CONTACT, ActionSchema, hasClinicalNeedleMotion, needleMotion, sampleManipulation, sampleNeedleMotion, techniqueMotion, type ManipulationMotionSettings, type ManipulationTechniqueId, type NeedleMotion, type NeedleTechnique, type NeedleMotionSettings, type TechniqueModel, type TechniqueMotionSample } from "@acucraft/core";
import { exteriorGeometry, exteriorShape, updateExteriorGeometry, NEEDLE_HANDLE_GRIP_Y_M, NEEDLE_HANDLE_LENGTH_M, NEEDLE_HANDLE_RADIUS_M, needleHandleRadiusAt } from "./needle-shape.js";

/**
 * The needles in the patient and the practitioner's ink marks, drawn where the record has them: a needle of the
 * pack's length, its tip at the recorded depth along the recorded angle and direction (`insert_needle`'s angleDeg
 * from the perpendicular, azimuthDeg round the chart from +v), a steel shaft and a wound steel handle. A needle
 * slides in when it is inserted and out when it is withdrawn; lift-thrust moves it along its shaft, rotation
 * turns it; a response on record (deqi) glows once round it.
 */

export interface NeedleSpec {
  id: string;
  target: string;
  site: SkinSite;
  angleDeg: number;
  azimuthDeg: number;
  depthCm: number;
  /** Length of the needle's shaft (m). */
  length: number;
  /** Recorded shaft diameter. Older scene snapshots omit it and retain the 0.48 mm display diameter. */
  diameterMm?: number;
}

type NeedlePose = Pick<TechniqueMotionSample, "withdrawalMm" | "rotationRad" | "lateralMm" | "tiltRad"> & {
  phase?: TechniqueMotionSample["phase"];
  /** An executed adjust_needle envelope, sampled by the shared clinical-motion implementation. */
  depthM?: number;
};
const shaftDiameterMm = (spec: NeedleSpec) => typeof spec.diameterMm === "number" && Number.isFinite(spec.diameterMm) && spec.diameterMm > 0 ? spec.diameterMm : 0.48;

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** One continuous winding. Its tangent normal follows the rounded wire across the cylinder UV seam. */
function coilNormalMap(): DataTexture {
  const size = 64, turns = 80;
  const pitch = NEEDLE_HANDLE_LENGTH_M / turns;
  const circumference = 2 * Math.PI * NEEDLE_HANDLE_RADIUS_M;
  const relief = 0.000033;
  const data = new Uint8Array(size * size * 4);
  const normal = new Vector3();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const phase = 2 * Math.PI * (y - x) / size;
      // Derivative of a broad wire crown with a narrower groove, in metres per turn.
      const slope = 2 * Math.PI * relief * (-Math.sin(phase) + 0.4 * Math.sin(2 * phase));
      normal.set(slope / circumference, -slope / pitch, 1).normalize();
      const index = 4 * (y * size + x);
      data[index] = Math.round((normal.x + 1) * 127.5);
      data[index + 1] = Math.round((normal.y + 1) * 127.5);
      data[index + 2] = Math.round((normal.z + 1) * 127.5);
      data[index + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.y = turns;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** A soft round dot (an ink mark's edge, a glow). */
function dotTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.55, "rgba(255,255,255,0.95)");
  r.addColorStop(0.8, "rgba(255,255,255,0.35)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

interface Live {
  spec: NeedleSpec;
  root: Group;
  body: Group;
  interior: Mesh;
  exterior: Group;
  exteriorShaft: Mesh;
  handleRoot: Group;
  handle: Mesh;
  hit: Mesh;
  /** 0 … 1 in, as drawn. */
  inserted: number;
  depth: number;
  targetDepth: number;
  leaving: boolean;
  wiggle: { type: "legacy"; kind: NeedleTechnique; start: number; motion?: NeedleMotionSettings }
    | { type: "clinical"; motion: NeedleMotion; start: number } | null;
  performance: { technique: ManipulationTechniqueId; start: number; elapsed?: number; motion?: ManipulationMotionSettings; model?: TechniqueModel } | null;
  /** One-way turning accepted performances have left on the needle: where its handle rests (radians). */
  spinRest: number;
  /** The turn of the performance under way, without what rests on the needle: what the holding fingers follow. */
  spin: number;
  controlled: boolean;
  needsInsertion: boolean;
  needsRemoval: boolean;
  skinContactFraction: number;
  glow: { ring: Mesh; start: number } | null;
  highlight: boolean;
}

export class NeedleLayer {
  readonly group = new Group();
  private readonly live = new Map<string, Live>();
  private readonly marks = new Map<string, Mesh>();
  private readonly shaftGeo: CylinderGeometry;
  private readonly tipGeo: CylinderGeometry;
  private readonly tailGeo: SphereGeometry;
  private readonly hitGeo: CylinderGeometry;
  private readonly markGeo = new CircleGeometry(0.0019, 20);
  private readonly ringGeo = new RingGeometry(0.75, 1, 48);
  private readonly shaftMat = new MeshStandardMaterial({ color: 0xdde2e8, metalness: 1, roughness: 0.16, envMapIntensity: 1.4 });
  private readonly exteriorMat = exteriorShaftMaterial(this.shaftMat);
  private readonly handleMat: MeshStandardMaterial;
  private readonly tailMat = new MeshStandardMaterial({ color: 0xe6e9ec, metalness: 1, roughness: 0.22, envMapIntensity: 1.5 });
  private readonly hitMat = new MeshBasicMaterial({ visible: false });
  private readonly markMat: MeshStandardMaterial;
  private readonly staleMarkMat: MeshStandardMaterial;
  private readonly glowMat: MeshBasicMaterial;
  private readonly dot = dotTexture();

  constructor() {
    this.group.name = "needles";
    // Geometry uses a 0.48 mm baseline; both shaft sections and the tip scale to the recorded diameter.
    this.shaftGeo = new CylinderGeometry(0.00024, 0.00024, 1, 8, 1);
    this.shaftGeo.translate(0, 0.5, 0);
    this.tipGeo = new CylinderGeometry(0.00024, 0.00002, 0.0016, 8, 1);
    // The point ends at local y=0, so its visible geometry never extends past the approved tip.
    this.tipGeo.translate(0, 0.0008, 0);
    this.tailGeo = new SphereGeometry(0.00095, 14, 10);
    this.hitGeo = new CylinderGeometry(0.004, 0.004, 1, 6, 1);
    this.hitGeo.translate(0, 0.5, 0);
    this.handleMat = new MeshStandardMaterial({ color: 0xd4d9de, metalness: 1, roughness: 0.3, normalMap: coilNormalMap(), envMapIntensity: 1.5 });
    this.markMat = new MeshStandardMaterial({ color: 0x35104f, roughness: 0.62, metalness: 0, transparent: true, opacity: 0.9, alphaMap: this.dot, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.staleMarkMat = this.markMat.clone();
    this.staleMarkMat.color = new Color(0x8b8597);
    this.staleMarkMat.opacity = 0.5;
    this.glowMat = new MeshBasicMaterial({ color: 0xffc26b, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
  }

  /** The needles drawn now, with where each one's handle ends (for its label). */
  anchors(): { id: string; target: string; at: Vector3; inserted: number; highlight: boolean }[] {
    const out: { id: string; target: string; at: Vector3; inserted: number; highlight: boolean }[] = [];
    for (const l of this.live.values()) {
      if (l.leaving) continue;
      l.root.updateMatrixWorld(true);
      const top = l.handleRoot.localToWorld(new Vector3(0, NEEDLE_HANDLE_LENGTH_M, 0));
      out.push({ id: l.spec.id, target: l.spec.target, at: top, inserted: l.inserted, highlight: l.highlight });
    }
    return out;
  }

  /** Where a needle enters the skin, and the skin's normal there. */
  siteOf(id: string): SkinSite | null {
    return this.live.get(id)?.spec.site ?? null;
  }

  has(id: string): boolean {
    const l = this.live.get(id);
    return !!l && !l.leaving;
  }

  /** Visual transitions awaiting the practitioner's hand. The record has already passed the engine's guards. */
  transitions(): { id: string; kind: "insert" | "remove" }[] {
    return [...this.live.values()].flatMap((l) => [
      ...(l.needsInsertion ? [{ id: l.spec.id, kind: "insert" as const }] : []),
      ...(l.needsRemoval ? [{ id: l.spec.id, kind: "remove" as const }] : []),
    ]);
  }

  /** The precision pinch follows the actual animated handle, including depth adjustments. */
  grip(id: string): { point: Vector3; axis: Vector3; rotation: number } | null {
    const l = this.live.get(id);
    if (!l) return null;
    l.root.updateMatrixWorld(true);
    return { point: l.handleRoot.localToWorld(new Vector3(0, NEEDLE_HANDLE_GRIP_Y_M, 0)), axis: new Vector3(0, 1, 0).applyQuaternion(l.handleRoot.getWorldQuaternion(new Quaternion())), rotation: l.spin };
  }

  /** The depth a needle stands at (mm), for a technique that works between levels of it. */
  depthMm(id: string): number | null {
    const l = this.live.get(id);
    return l && !l.leaving ? l.targetDepth * 1000 : null;
  }

  /** Carry the uninserted needle between the approaching fingers, preserving its full shaft length. */
  carry(id: string, grip: Vector3, axis: Vector3): void {
    const l = this.live.get(id);
    if (!l || !l.needsInsertion) return;
    l.root.visible = true;
    l.root.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis);
    l.root.updateMatrixWorld(true);
    const current = l.handleRoot.localToWorld(new Vector3(0, NEEDLE_HANDLE_GRIP_Y_M, 0));
    l.root.position.add(grip.clone().sub(current));
  }

  /** Drive the insertion/withdrawal only while the practitioner's pinch has reached the handle. */
  progress(id: string, kind: "insert" | "remove", fraction: number, skinContactFraction?: number): void {
    const l = this.live.get(id);
    if (!l) return;
    const t = Math.min(1, Math.max(0, fraction));
    l.controlled = true;
    l.root.visible = true;
    this.place(l);
    l.inserted = kind === "insert" ? t : 1 - t;
    if (kind === "insert" && skinContactFraction !== undefined) l.skinContactFraction = skinContactFraction;
    this.applyPose(l);
    if (t >= 1) {
      if (kind === "remove") return this.drop(l);
      l.needsInsertion = false;
      l.controlled = l.needsRemoval;
    }
  }

  /**
   * Make the needles drawn the ones given: new ones slide in (or are simply there, without `animate`), ones no
   * longer in are withdrawn, a changed depth is followed; `moved` (a needle worked) wiggles it.
   */
  sync(specs: NeedleSpec[], now: number, animate: boolean): void {
    const keep = new Set(specs.map((s) => s.id));
    for (const [id, l] of this.live) if (!keep.has(id) && !l.leaving) {
      l.leaving = true;
      l.needsRemoval = animate;
      l.controlled = animate;
    }
    for (const spec of specs) {
      const l = this.live.get(spec.id);
      if (!l || l.leaving) {
        if (l) this.drop(l);
        this.add(spec, animate ? 0 : 1);
        continue;
      }
      const moved = !l.spec.site.p.equals(spec.site.p) || l.spec.angleDeg !== spec.angleDeg || l.spec.azimuthDeg !== spec.azimuthDeg;
      l.spec = spec;
      l.targetDepth = spec.depthCm / 100;
      if (!animate) l.depth = l.targetDepth;
      if (moved) this.place(l);
    }
    void now;
  }

  /** The needle worked (`adjust_needle`): lifted and thrust along its shaft, or turned. */
  work(id: string, input: Record<string, unknown>, now: number): void;
  work(id: string, kind: NeedleTechnique, now: number, motion?: NeedleMotionSettings): void;
  work(id: string, input: Record<string, unknown> | NeedleTechnique, now: number, motion?: NeedleMotionSettings): void {
    const l = this.live.get(id);
    if (!l) return;
    if (typeof input === "string") {
      l.performance = null;
      l.wiggle = { type: "legacy", kind: input, start: now, motion };
      return;
    }
    const parsed = ActionSchema.safeParse({ ...input, type: "adjust_needle", needleId: id });
    if (!parsed.success || parsed.data.type !== "adjust_needle") return;
    if (!hasClinicalNeedleMotion(parsed.data)) {
      this.work(id, parsed.data.technique, now, parsed.data.motion);
      return;
    }
    l.performance = null;
    l.wiggle = parsed.data.technique === "none" ? null
      : { type: "clinical", motion: needleMotion(parsed.data, l.targetDepth * 100), start: now };
    if (!l.wiggle) this.applyPose(l);
  }

  /** Interrupt presentation without changing the executed needle geometry or its insertion/removal queue. */
  stopWork(): void {
    for (const l of this.live.values()) {
      l.wiggle = null;
      l.performance = null;
      this.applyPose(l);
    }
  }

  /** Begin one accepted catalogue performance. Presentation does not mutate the needle's executed geometry. */
  workTechnique(id: string, technique: ManipulationTechniqueId, start: number, motion?: ManipulationMotionSettings, model?: TechniqueModel): void {
    const l = this.live.get(id);
    if (l) { l.wiggle = null; l.performance = { technique, start, motion, model }; }
  }

  /** Exact deterministic pose for a local preview or a locally paused record performance. */
  poseTechnique(id: string, technique: ManipulationTechniqueId, elapsed: number, motion?: ManipulationMotionSettings, model?: TechniqueModel): void {
    const l = this.live.get(id);
    if (!l) return;
    l.performance = { technique, start: 0, elapsed, motion, model };
    this.applyPose(l, this.samplePerformance(l, elapsed));
  }

  /** End a performance. `residualRad`: one-way turning it has left on the needle, which stays where it was turned to. */
  clearTechnique(id: string, residualRad = 0): void {
    const l = this.live.get(id);
    if (!l) return;
    l.performance = null;
    if (Number.isFinite(residualRad)) l.spinRest = (l.spinRest + residualRad) % (2 * Math.PI);
    this.applyPose(l);
  }

  private samplePerformance(l: Live, elapsed: number) {
    const p = l.performance!;
    return sampleManipulation(p.model, p.technique, elapsed, p.motion, { depthMm: l.targetDepth * 1000 });
  }

  /** A response on record at a needle: a glow spreads round it once. */
  respond(id: string, now: number): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.glow) l.root.remove(l.glow.ring);
    const ring = new Mesh(this.ringGeo, this.glowMat.clone());
    ring.renderOrder = 5;
    // on the skin: square to its normal, not to the needle
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), l.spec.site.n);
    ring.quaternion.copy(l.root.quaternion.clone().invert().multiply(q));
    l.root.add(ring);
    l.glow = { ring, start: now };
  }

  highlight(id: string | null): void {
    for (const l of this.live.values()) {
      const on = l.spec.id === id;
      if (on === l.highlight) continue;
      l.highlight = on;
      const m = l.handle.material as MeshStandardMaterial;
      m.emissive = new Color(on ? 0xffb347 : 0x000000);
      m.emissiveIntensity = on ? 0.9 : 0;
    }
  }

  /** The needle a ray from the camera passes nearest, if any. */
  pick(ray: Raycaster): string | null {
    const hits = ray.intersectObjects([...this.live.values()].filter((l) => !l.leaving).map((l) => l.hit), false);
    const h = hits[0];
    return h ? (h.object.userData.needle as string) : null;
  }

  /** The ink marks, drawn where the record has them. */
  syncMarks(marks: { id: string; site: SkinSite; stale: boolean }[]): void {
    const keep = new Set(marks.map((m) => m.id));
    for (const [id, mesh] of this.marks) {
      if (keep.has(id)) continue;
      this.group.remove(mesh);
      this.marks.delete(id);
    }
    for (const m of marks) {
      let mesh = this.marks.get(m.id);
      if (!mesh) {
        mesh = new Mesh(this.markGeo, this.markMat);
        mesh.renderOrder = 2;
        this.marks.set(m.id, mesh);
        this.group.add(mesh);
      }
      mesh.material = m.stale ? this.staleMarkMat : this.markMat;
      mesh.position.copy(m.site.p).addScaledVector(m.site.n, 0.0004);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), m.site.n);
    }
  }

  clear(): void {
    for (const l of [...this.live.values()]) this.drop(l);
    for (const mesh of this.marks.values()) this.group.remove(mesh);
    this.marks.clear();
  }

  /** Advance the needles' movements to time `now` (ms). */
  tick(dt: number, now: number): void {
    for (const l of [...this.live.values()]) {
      const rate = dt / 650;
      if (l.leaving && !l.controlled) {
        l.inserted = Math.max(0, l.inserted - dt / 520);
        if (l.inserted <= 0) {
          this.drop(l);
          continue;
        }
      } else if (!l.controlled && l.inserted < 1) l.inserted = Math.min(1, l.inserted + rate);
      if (Math.abs(l.depth - l.targetDepth) > 1e-5) l.depth += (l.targetDepth - l.depth) * Math.min(1, dt / 220);
      let motion: NeedlePose | undefined;
      if (l.performance) {
        const sample = this.samplePerformance(l, l.performance.elapsed ?? now - l.performance.start);
        if (sample.complete && l.performance.elapsed === undefined) {
          l.spinRest = (l.spinRest + (sample.windingRad ?? 0)) % (2 * Math.PI);
          l.performance = null;
        } else motion = sample;
      } else if (l.wiggle) {
        if (l.wiggle.type === "clinical") {
          const seconds = Math.max(0, now - l.wiggle.start) / 1000;
          if (seconds >= l.wiggle.motion.durationSeconds || l.leaving) l.wiggle = null;
          else {
            const sample = sampleNeedleMotion(l.wiggle.motion, seconds);
            motion = { depthM: sample.depthCm / 100, withdrawalMm: 0, rotationRad: sample.rotationRad,
              lateralMm: { u: 0, v: 0 }, tiltRad: { u: 0, v: 0 } };
          }
        } else {
          const sample = techniqueMotion(l.wiggle.kind, now - l.wiggle.start, l.wiggle.motion);
          if (sample.complete) l.wiggle = null;
          else motion = { ...sample, lateralMm: { u: 0, v: 0 }, tiltRad: { u: 0, v: 0 } };
        }
      }
      this.applyPose(l, motion);
      if (l.glow) {
        const age = (now - l.glow.start) / 1600;
        if (age >= 1) {
          l.root.remove(l.glow.ring);
          (l.glow.ring.material as MeshBasicMaterial).dispose();
          l.glow = null;
        } else {
          const r = 0.004 + 0.03 * smooth(age);
          l.glow.ring.scale.setScalar(r);
          (l.glow.ring.material as MeshBasicMaterial).opacity = 0.85 * (1 - age) * (1 - age);
        }
      }
    }
  }

  private add(spec: NeedleSpec, inserted: number): void {
    const root = new Group();
    root.name = `needle:${spec.id}`;
    const body = new Group();
    const shaft = new Mesh(this.shaftGeo, this.shaftMat);
    shaft.name = "internal-shaft";
    const tip = new Mesh(this.tipGeo, this.shaftMat);
    tip.name = "needle-tip";
    const diameterScale = shaftDiameterMm(spec) / 0.48;
    tip.scale.set(diameterScale, 1, diameterScale);
    const exterior = new Group();
    exterior.name = "external-shaft";
    const exteriorShaft = new Mesh(exteriorGeometry(), this.exteriorMat);
    exteriorShaft.frustumCulled = false;
    const handleRoot = new Group();
    handleRoot.name = "needle-handle";
    const handle = new Mesh(new CylinderGeometry(needleHandleRadiusAt(NEEDLE_HANDLE_GRIP_Y_M), needleHandleRadiusAt(-NEEDLE_HANDLE_GRIP_Y_M), NEEDLE_HANDLE_LENGTH_M, 14, 1), this.handleMat.clone());
    handle.position.y = NEEDLE_HANDLE_GRIP_Y_M;
    const tail = new Mesh(this.tailGeo, this.tailMat);
    tail.position.y = NEEDLE_HANDLE_LENGTH_M;
    const hit = new Mesh(this.hitGeo, this.hitMat);
    hit.scale.set(1, spec.length + 0.03, 1);
    hit.userData.needle = spec.id;
    for (const m of [shaft, exteriorShaft, tip, handle, tail]) {
      m.castShadow = true;
      m.receiveShadow = false;
    }
    handleRoot.add(handle, tail);
    exterior.add(exteriorShaft, handleRoot);
    body.add(shaft, tip, exterior, hit);
    root.add(body);
    const pending = inserted === 0;
    const l: Live = { spec, root, body, interior: shaft, exterior, exteriorShaft, handleRoot, handle, hit, inserted, depth: spec.depthCm / 100, targetDepth: spec.depthCm / 100, leaving: false, wiggle: null, performance: null, spinRest: 0, spin: 0, controlled: pending, needsInsertion: pending, needsRemoval: false, skinContactFraction: INSERTION_SKIN_CONTACT.default, glow: null, highlight: false };
    root.visible = !pending;
    this.place(l);
    this.live.set(spec.id, l);
    this.group.add(root);
    this.tick(0, 0);
  }

  /** Stand the needle where its site is, along its way in. */
  private place(l: Live): void {
    const { site, angleDeg, azimuthDeg } = l.spec;
    const a = (angleDeg * Math.PI) / 180, z = (azimuthDeg * Math.PI) / 180;
    // the way the tip travels: in through the skin, leaning towards the chart's direction `azimuth`
    const across = site.vDir.clone().multiplyScalar(Math.cos(z)).addScaledVector(site.uDir, Math.sin(z));
    const inward = site.n.clone().multiplyScalar(-Math.cos(a)).addScaledVector(across, Math.sin(a)).normalize();
    l.root.position.copy(site.p);
    l.root.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), inward.clone().negate());
  }

  private applyPose(l: Live, motion?: NeedlePose): void {
    const baseDepth = motion?.depthM === undefined ? Math.min(l.depth, l.targetDepth) : Math.max(0, Math.min(l.spec.length, motion.depthM));
    const retained = l.needsInsertion ? insertionDepth(l.inserted, baseDepth, l.skinContactFraction)
      : baseDepth * smooth(l.inserted) - (l.needsRemoval && l.controlled ? INSERTION_HOVER_M * (1 - smooth(l.inserted)) : 0);
    const outward = Math.min(Math.max(0, retained), Math.max(0, motion?.withdrawalMm ?? 0) / 1000);
    const depth = retained - outward;
    // the turn of what is being done now, on top of what one-way turning has left on the needle
    l.spin = motion?.rotationRad ?? 0;
    const spin = l.spinRest + l.spin;
    l.body.position.set(0, -depth, 0);
    if (l.needsInsertion && l.inserted > 0 && l.inserted < 1 && l.spec.site.currentSurface) {
      const skin = l.spec.site.currentSurface(), axis = new Vector3(0, 1, 0).applyQuaternion(l.root.quaternion);
      const incidence = axis.dot(skin.n), rise = skin.p.clone().sub(l.spec.site.p).dot(skin.n);
      // Measure both fixed endpoints against the breathing skin so its normal-distance curve
      // crosses zero exactly at the chosen time and keeps both the hover and final depth.
      const liveDepth = insertionDepth(l.inserted, rise + baseDepth * incidence, l.skinContactFraction, INSERTION_HOVER_M * incidence - rise);
      const correction = rise + depth * incidence - liveDepth;
      // Follow the registered shaft at ordinary angles. Near tangency use the skin normal
      // to avoid magnifying millimetres of breathing into centimetres of sideways travel.
      const along = smooth((incidence - .15) / .35);
      const direction = skin.n.clone().multiplyScalar(1 - along).addScaledVector(axis, along / Math.max(.15, incidence));
      l.body.position.addScaledVector(direction.applyQuaternion(l.root.quaternion.clone().invert()), correction);
    }
    l.body.rotation.y = spin;
    const interiorLength = Math.max(0, Math.min(l.spec.length, depth));
    const diameterScale = shaftDiameterMm(l.spec) / 0.48;
    l.interior.scale.set(diameterScale, interiorLength, diameterScale);
    l.body.getObjectByName("needle-tip")?.scale.set(diameterScale, 1, diameterScale);
    l.interior.visible = interiorLength > 1e-7;
    l.exterior.position.set(0, interiorLength, 0);
    const toLocal = (u: number, v: number) => {
      // Pan orbits the shaft in its perpendicular plane, including at oblique sites and mirrored chart frames.
      if (motion?.phase?.primitive === "pan") return new Vector3(u, 0, -v);
      return l.spec.site.uDir.clone().multiplyScalar(u).addScaledVector(l.spec.site.vDir, v)
        .applyQuaternion(l.root.quaternion.clone().invert()).applyAxisAngle(new Vector3(0, 1, 0), -spin);
    };
    const lateral = toLocal((motion?.lateralMm.u ?? 0) / 1000, (motion?.lateralMm.v ?? 0) / 1000);
    const tilt = toLocal(motion?.tiltRad.u ?? 0, motion?.tiltRad.v ?? 0);
    const shape = exteriorShape(l.spec.length - interiorLength, lateral, tilt);
    updateExteriorGeometry(l.exteriorShaft.geometry, shape.points, shaftDiameterMm(l.spec) / 2000);
    l.handleRoot.position.copy(shape.end);
    l.handleRoot.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), shape.tangent);
  }

  private drop(l: Live): void {
    this.group.remove(l.root);
    (l.handle.material as MeshStandardMaterial).dispose();
    l.handle.geometry.dispose();
    l.exteriorShaft.geometry.dispose();
    if (l.glow) (l.glow.ring.material as MeshBasicMaterial).dispose();
    this.live.delete(l.spec.id);
  }
}
