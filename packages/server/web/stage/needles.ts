import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
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
import type { SkinSite } from "./sites.js";
import { techniqueMotion, type NeedleTechnique, type NeedleMotionSettings } from "@acucraft/core";

/**
 * The needles in the patient and the practitioner's ink marks, drawn where the record has them: a needle of the
 * pack's length, its tip at the recorded depth along the recorded angle and direction (`insert_needle`'s angleDeg
 * from the perpendicular, azimuthDeg round the chart from +v), a steel shaft and a coiled copper handle. A needle
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
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** A coiled handle's wire, as a texture: one turn of the coil per stripe. */
function coilTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 64;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 64; y++) {
    const k = 0.5 + 0.5 * Math.cos((y / 8) * Math.PI * 2);
    const l = Math.round(150 + 105 * k);
    g.fillStyle = `rgb(${l},${l},${l})`;
    g.fillRect(0, y, 16, 1);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  return t;
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
  handle: Mesh;
  hit: Mesh;
  /** 0 … 1 in, as drawn. */
  inserted: number;
  depth: number;
  targetDepth: number;
  leaving: boolean;
  wiggle: { kind: NeedleTechnique; start: number; motion?: NeedleMotionSettings } | null;
  controlled: boolean;
  needsInsertion: boolean;
  needsRemoval: boolean;
  clearance: number;
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
  private readonly handleMat: MeshStandardMaterial;
  private readonly tailMat = new MeshStandardMaterial({ color: 0xe6e9ec, metalness: 1, roughness: 0.22, envMapIntensity: 1.5 });
  private readonly hitMat = new MeshBasicMaterial({ visible: false });
  private readonly markMat: MeshStandardMaterial;
  private readonly staleMarkMat: MeshStandardMaterial;
  private readonly glowMat: MeshBasicMaterial;
  private readonly dot = dotTexture();

  constructor() {
    this.group.name = "needles";
    // (a shaft is a quarter of a millimetre thick: drawn a little thicker, as a game draws a wire, to be seen at all)
    this.shaftGeo = new CylinderGeometry(0.00024, 0.00024, 1, 8, 1);
    this.shaftGeo.translate(0, 0.5, 0);
    this.tipGeo = new CylinderGeometry(0.00024, 0.00002, 0.0016, 8, 1);
    this.tipGeo.translate(0, -0.0008, 0);
    this.tailGeo = new SphereGeometry(0.00095, 14, 10);
    this.hitGeo = new CylinderGeometry(0.004, 0.004, 1, 6, 1);
    this.hitGeo.translate(0, 0.5, 0);
    const coil = coilTexture();
    coil.repeat.set(1, 26);
    // a stainless spiral handle, as most single-use needles have
    this.handleMat = new MeshStandardMaterial({ color: 0xd4d9de, metalness: 1, roughness: 0.26, map: coil, bumpMap: coil, bumpScale: 0.8, envMapIntensity: 1.5 });
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
      const top = new Vector3(0, l.spec.length + 0.025, 0);
      l.body.localToWorld(top);
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
    return { point: l.body.localToWorld(new Vector3(0, l.spec.length + 0.0125, 0)), axis: new Vector3(0, 1, 0).applyQuaternion(l.root.quaternion), rotation: l.body.rotation.y };
  }

  /** Carry the uninserted needle between the approaching fingers, preserving its full shaft length. */
  carry(id: string, grip: Vector3, axis: Vector3): void {
    const l = this.live.get(id);
    if (!l || !l.needsInsertion) return;
    l.root.visible = true;
    l.root.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis);
    l.root.position.copy(grip).addScaledVector(axis, -l.spec.length - 0.0125 - l.body.position.y);
  }

  /** Drive the insertion/withdrawal only while the practitioner's pinch has reached the handle. */
  progress(id: string, kind: "insert" | "remove", fraction: number): void {
    const l = this.live.get(id);
    if (!l) return;
    const t = Math.min(1, Math.max(0, fraction));
    l.controlled = true;
    l.root.visible = true;
    this.place(l);
    l.inserted = kind === "insert" ? t : 1 - t;
    l.clearance = 0.012 * (1 - smooth(l.inserted));
    l.body.position.y = -Math.min(l.depth, l.targetDepth) * smooth(l.inserted) + l.clearance;
    if (t >= 1) {
      if (kind === "remove") return this.drop(l);
      l.needsInsertion = false;
      l.controlled = l.needsRemoval;
      l.clearance = 0;
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
  work(id: string, kind: NeedleTechnique, now: number, motion?: NeedleMotionSettings): void {
    const l = this.live.get(id);
    if (l) l.wiggle = { kind, start: now, motion };
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
      let depth = Math.min(l.depth, l.targetDepth) * smooth(l.inserted) - l.clearance;
      let spin = 0;
      if (l.wiggle) {
        const sample = techniqueMotion(l.wiggle.kind, now - l.wiggle.start, l.wiggle.motion);
        if (sample.complete) l.wiggle = null;
        else {
          depth -= Math.min(Math.max(0, depth), sample.withdrawalMm / 1000);
          spin = sample.rotationRad;
        }
      }
      // the tip at `depth` under the skin along the needle's way in; from it the shaft, the handle and its tail
      l.body.position.set(0, -depth, 0);
      l.body.rotation.y = spin;
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
    shaft.scale.set(1, spec.length, 1);
    const tip = new Mesh(this.tipGeo, this.shaftMat);
    const handle = new Mesh(new CylinderGeometry(0.00072, 0.00068, 0.025, 14, 1), this.handleMat.clone());
    handle.position.y = spec.length + 0.0125;
    const tail = new Mesh(this.tailGeo, this.tailMat);
    tail.position.y = spec.length + 0.025;
    const hit = new Mesh(this.hitGeo, this.hitMat);
    hit.scale.set(1, spec.length + 0.03, 1);
    hit.userData.needle = spec.id;
    for (const m of [shaft, tip, handle, tail]) {
      m.castShadow = true;
      m.receiveShadow = false;
    }
    body.add(shaft, tip, handle, tail, hit);
    root.add(body);
    const pending = inserted === 0;
    const l: Live = { spec, root, body, handle, hit, inserted, depth: spec.depthCm / 100, targetDepth: spec.depthCm / 100, leaving: false, wiggle: null, controlled: pending, needsInsertion: pending, needsRemoval: false, clearance: pending ? 0.012 : 0, glow: null, highlight: false };
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

  private drop(l: Live): void {
    this.group.remove(l.root);
    (l.handle.material as MeshStandardMaterial).dispose();
    l.handle.geometry.dispose();
    if (l.glow) (l.glow.ring.material as MeshBasicMaterial).dispose();
    this.live.delete(l.spec.id);
  }
}
