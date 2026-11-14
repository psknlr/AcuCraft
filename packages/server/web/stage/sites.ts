import { Mesh, Raycaster, Vector3, type Intersection } from "three";
import type { PersonRig } from "@clinicalcraft/web/world/npc.js";
import { placedHeadPoint, placedPoint } from "@clinicalcraft/web/world/manikin.js";
import { armRadii, legRadii, limbPoint, trunkPoint } from "@clinicalcraft/web/world/figure/body.js";
import { HIP, NECK, SHOULDER } from "@clinicalcraft/web/world/figure/anatomy.js";
import { HEAD_CENTRE } from "@clinicalcraft/web/world/figure/skull.js";
import type { ChartSite } from "./types.js";

/**
 * A place on a regional chart (`content/regions/*.json`: u and v in centimetres of the patient's own body, as the
 * chart's description defines them) as a place on the skin of the patient's figure — the world's own figure kit,
 * built to the patient's height. Each chart's origin is found on the figure by proportional measurement, as
 * tools/figure-fit.mts does for the needling stations: the lower border of L4 13 cm above the hip joints, the
 * knee chart from the lower pole of the patella just above the joint line, the forearm from the wrist crease …;
 * then a ray is cast onto the drawn skin from the side the chart is seen from. A drawing aid, schematic like the
 * pack's anatomy: the figure is not the patient's anatomy model, and a point may sit a centimetre or two from
 * where the engine has it.
 */

type V3 = [number, number, number];

/** Where the skin was found: the point, its outward normal, and the chart's +v and +u directions along the skin there. */
export interface SkinSite {
  p: Vector3;
  n: Vector3;
  vDir: Vector3;
  uDir: Vector3;
  /** False when what the ray met first was cloth or hair (the needle still goes to the skin under it, when found). */
  bare: boolean;
}

/* the figure's own frame (an average adult 1.74 m tall; feet at the origin, +Y up, +Z the front, +X their left) */
const C7 = NECK + 0.003;
const NOTCH = NECK - 0.025;
const XIPHISTERNUM = NOTCH - 0.18;
const UMBILICUS = 1.035;
/** As tools/figure-fit.mts: the fourth lumbar spinous process on the line of the iliac crests. */
const L4 = HIP + 0.125;
const PSIS = HIP + 0.065;

/** A ray from `origin` towards `towards` (in the figure's frame, or the head's): the frame's map to the world. */
interface Aim {
  origin: V3;
  towards: V3;
  head?: boolean;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const v3 = (p: { x: number; y: number; z: number }): V3 => [p.x, p.y, p.z];
/** `a` with what lies along unit `axis` taken out. */
const across = (a: V3, axis: V3): V3 => norm(sub(a, mul(axis, dot(a, axis))));

export class SiteFinder {
  private readonly meshes: Mesh[] = [];
  private readonly ray = new Raycaster();
  /** Metres of the patient's own body per metre of the figure's frame (the figure is built to their height). */
  private readonly bodyScale: number;
  private readonly headScale: number;

  constructor(private readonly rig: PersonRig) {
    rig.root.updateMatrixWorld(true);
    rig.root.traverse((o) => {
      if ((o as Mesh).isMesh && o.userData.figure) this.meshes.push(o as Mesh);
    });
    this.bodyScale = rig.body.getWorldScale(new Vector3()).x || 1;
    this.headScale = rig.head.getWorldScale(new Vector3()).x || this.bodyScale;
  }

  private readonly found = new Map<string, SkinSite | null>();

  /**
   * The skin at a place of a chart, or null when the figure has nothing there (a chart this mapping does not know).
   * Kept for the figure's life: the record is drawn again on every change, the figure only when the patient moves.
   */
  find(site: ChartSite): SkinSite | null {
    const key = `${site.region}|${site.side}|${site.u}|${site.v}`;
    if (this.found.has(key)) return this.found.get(key)!;
    const out = this.search(site);
    this.found.set(key, out);
    return out;
  }

  private search(site: ChartSite): SkinSite | null {
    const at = this.locate(site);
    if (!at) return null;
    // the chart's directions along the skin: where half a centimetre up (+v) and across (+u) the chart lands
    const up = this.locate({ ...site, v: site.v + 0.5 });
    const right = this.locate({ ...site, u: site.u + 0.5 });
    const tangent = (other: SkinSite | null, fallback: Vector3) => {
      const d = other ? other.p.clone().sub(at.p) : fallback.clone();
      d.addScaledVector(at.n, -d.dot(at.n));
      return d.lengthSq() > 1e-10 ? d.normalize() : fallback.clone().addScaledVector(at.n, -fallback.dot(at.n)).normalize();
    };
    const worldUp = new Vector3(0, 1, 0);
    const vDir = tangent(up, worldUp);
    const uDir = tangent(right, new Vector3().crossVectors(at.n, vDir));
    return { ...at, vDir, uDir };
  }

  private locate(site: ChartSite): SkinSite | null {
    const aim = this.aim(site);
    if (!aim) return null;
    const toWorld = (p: V3) => (aim.head ? placedHeadPoint(this.rig, p) : placedPoint(this.rig, p));
    const origin = toWorld(aim.origin);
    const target = toWorld(aim.towards);
    const dir = target.clone().sub(origin);
    const far = dir.length();
    if (far < 1e-6) return null;
    dir.normalize();
    const hit = this.cast(origin, dir, far * 1.05);
    if (!hit) return null;
    // the way out of the skin: across four rays 4 mm round the site (one facet's normal is not smooth enough)
    const side = new Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
    const other = new Vector3().crossVectors(dir, side).normalize();
    const near = (d: Vector3, by: number) => this.cast(origin.clone().addScaledVector(d, by), dir, far * 1.05);
    const [a, b, c, e] = [near(side, 0.004), near(side, -0.004), near(other, 0.004), near(other, -0.004)];
    let n: Vector3;
    if (a && b && c && e) n = new Vector3().crossVectors(a.p.clone().sub(b.p), c.p.clone().sub(e.p)).normalize();
    else n = hit.n.clone();
    if (n.dot(dir) > 0) n.negate();
    return { p: hit.p, n, vDir: new Vector3(), uDir: new Vector3(), bare: hit.bare };
  }

  /** The first skin a ray meets (through cloth or hair over it), else the first surface. */
  private cast(origin: Vector3, dir: Vector3, far: number): { p: Vector3; n: Vector3; bare: boolean } | null {
    this.ray.set(origin, dir);
    this.ray.far = far;
    const hits: Intersection[] = [];
    // (a rig's meshes take no aim of their own — its unseen box does: ask the meshes themselves)
    for (const mesh of this.meshes) Mesh.prototype.raycast.call(mesh, this.ray, hits);
    hits.sort((x, y) => x.distance - y.distance);
    const skinOf = (h: Intersection) => this.rig.skin.some((s) => s.mesh === h.object && h.face && s.ranges.some(([start, count]) => h.face!.a >= start && h.face!.a < start + count));
    const first = hits[0];
    if (!first) return null;
    const skin = skinOf(first) ? first : hits.find((h) => h.distance - first.distance < 0.05 && skinOf(h));
    const h = skin ?? first;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate();
    if (n.dot(dir) > 0) n.negate();
    return { p: h.point.clone(), n, bare: h === first && skin === first };
  }

  /** Where to look from for a place on a chart: figure-frame (or head-frame) points. */
  private aim(site: ChartSite): Aim | null {
    const m = (cm: number) => cm / 100 / this.bodyScale;
    const mh = (cm: number) => cm / 100 / this.headScale;
    const u = m(site.u), v = m(site.v);
    const left = site.side !== "right";
    const mirror = (p: V3): V3 => (left ? p : [-p[0], p[1], p[2]]);
    const rig = this.rig;
    // (sitting, the trunk is raised with the seat: the skeleton's `lift`)
    const lift = rig.skeleton.lift;
    switch (site.region) {
      /* the trunk, unrolled round a horizontal section of the skin */
      case "chest":
        return this.trunk(XIPHISTERNUM + v, u, false);
      case "abdomen":
        return this.trunk(UMBILICUS + v, u, false);
      case "upper-back":
        return this.trunk(C7 + v, u, true);
      case "lumbar":
        return this.trunk(L4 + v, u, true);
      case "sacrum-buttock":
        return this.trunk(PSIS + v, u, true);
      case "neck-anterior": {
        const y = NOTCH + v;
        if (y < NECK - 0.01) return this.trunk(y, u, false);
        const a = u / 0.058;
        return { origin: [Math.sin(a) * 0.3, y + lift, -0.01 + Math.cos(a) * 0.3], towards: [0, y + lift, -0.01] };
      }
      case "neck-shoulder": {
        const y = C7 + v;
        // the tops of the shoulders from above; the nape, the occiput and the upper back from behind
        if (Math.abs(u) > 0.065 && v > -0.012) return { origin: [u, SHOULDER + lift + 0.35, -0.025], towards: [u, SHOULDER + lift - 0.2, -0.025] };
        if (Math.abs(u) > 0.065) return this.trunk(y, u, true);
        return { origin: [u, y + lift, -0.45], towards: [u, y + lift, 0.05] };
      }
      /* the head, in its own frame (origin the top of the neck, +Y up, +Z the face) */
      case "face": {
        const [cx, cy, cz] = HEAD_CENTRE;
        const a = mh(site.u) / 0.085;
        const y = cy + 0.016 + mh(site.v);
        return { head: true, origin: [cx + Math.sin(a) * 0.35, y, cz + Math.cos(a) * 0.35], towards: [cx, y, cz] };
      }
      case "head-lateral": {
        const [cx, cy, cz] = HEAD_CENTRE;
        const a = (95 * Math.PI) / 180 + mh(site.u) / 0.08;
        const y = cy - 0.011 + mh(site.v);
        const x = Math.sin(a) * 0.35 * (left ? 1 : -1);
        return { head: true, origin: [cx + x, y, cz + Math.cos(a) * 0.35], towards: [cx, y, cz] };
      }
      case "scalp": {
        const [cx, cy, cz] = HEAD_CENTRE;
        const b = (41 * Math.PI) / 180 + mh(site.v) / 0.105;
        const g = mh(site.u) / 0.09;
        const d0: V3 = [0, Math.sin(b), Math.cos(b)];
        const d = norm(add(mul(d0, Math.cos(g)), [Math.sin(g), 0, 0]));
        return { head: true, origin: add([cx, cy, cz], mul(d, 0.35)), towards: [cx, cy, cz] };
      }
      /* the limbs, unrolled round the limb */
      case "knee-leg": {
        const above = v + m(1);
        return this.limb("legs", left, above >= 0 ? { joint: 1, above } : { joint: 1, below: -above }, u, "front", mirror);
      }
      case "thigh":
        return this.limb("legs", left, { joint: 1, above: v + m(5.5) }, u, "front", mirror);
      case "upper-arm":
        return this.limb("arms", left, { joint: 1, above: v }, u, "front", mirror);
      case "forearm":
        return this.limb("arms", left, { joint: 2, above: v }, u, "palm", mirror);
      case "hand-palm":
      case "hand-dorsum": {
        const limb = rig.skeleton.arms[left ? 0 : 1];
        const wrist: V3 = [...limb.end];
        const along = norm([...limb.along]);
        const palm = across([...limb.face], along);
        const radial = norm(cross(palm, along));
        const p = add(add(wrist, mul(along, m(9) - v)), mul(radial, u));
        const out = site.region === "hand-palm" ? palm : mul(palm, -1);
        return { origin: mirror(add(p, mul(out, 0.15))), towards: mirror(sub(p, mul(out, 0.05))) };
      }
      case "foot": {
        const limb = rig.skeleton.legs[left ? 0 : 1];
        const along = norm([...limb.along]);
        const up = across([...limb.face], along);
        const lateral = norm(cross(up, along));
        const axis = add(add([...limb.end], mul(along, m(13) - v)), mul(up, -m(3)));
        const a = u / m(4.5);
        const d = norm(add(mul(up, Math.cos(a)), mul(lateral, Math.sin(a))));
        return { origin: mirror(add(axis, mul(d, 0.2))), towards: mirror(axis) };
      }
      case "sole": {
        const limb = rig.skeleton.legs[left ? 0 : 1];
        const along = norm([...limb.along]);
        const up = across([...limb.face], along);
        const lateral = norm(cross(up, along));
        const p = add(add([...limb.end], mul(along, m(15.5) - v)), mul(lateral, u));
        return { origin: mirror(sub(p, mul(up, 0.25))), towards: mirror(add(p, mul(up, 0.05))) };
      }
      default:
        return null;
    }
  }

  /** A trunk chart: height `y` in the figure's frame, `u` metres of arc from the front or back midline (+ the patient's left). */
  private trunk(y: number, u: number, fromBack: boolean): Aim {
    const f = this.rig.frame;
    const lift = this.rig.skeleton.lift;
    const step = 0.006 * Math.sign(u || 1) * (fromBack ? -1 : 1);
    let a = fromBack ? Math.PI : 0;
    let prev = trunkPoint(y, a, f, lift);
    let walked = 0;
    const goal = Math.abs(u);
    for (let i = 0; i < 1200 && walked < goal; i++) {
      const next = trunkPoint(y, a + step, f, lift);
      const d = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
      if (walked + d >= goal) {
        a += (step * (goal - walked)) / Math.max(d, 1e-9);
        walked = goal;
        break;
      }
      walked += d;
      a += step;
      prev = next;
    }
    const p = trunkPoint(y, a, f, lift) as V3;
    const out = norm([p[0], 0, p[2]]);
    return { origin: add(p, mul(out, 0.25)), towards: sub(p, mul(out, 0.08)) };
  }

  /**
   * A limb chart: where along the limb (`above` a joint towards the trunk, or `below` it; joint 1 the elbow or the
   * knee, 2 the wrist or the ankle) and `u` metres round it from its front (or the palm's side), + lateral (radial).
   */
  private limb(which: "arms" | "legs", left: boolean, along: { joint: 1 | 2; above?: number; below?: number }, u: number, front: "front" | "palm", mirror: (p: V3) => V3): Aim {
    const limb = this.rig.skeleton[which][left ? 0 : 1];
    const L1 = Math.hypot(...sub([...limb.mid], [...limb.root]));
    const L2 = Math.hypot(...sub([...limb.end], [...limb.mid]));
    let t: number;
    if (along.joint === 1) t = along.above !== undefined ? 1 - along.above / L1 : 1 + (along.below ?? 0) / L2;
    else t = 2 - (along.above ?? 0) / L2;
    t = Math.min(2, Math.max(0.03, t));
    const axis = v3(limbPoint(limb, t));
    const ahead = v3(limbPoint(limb, Math.min(2, t + 0.02)));
    const behind = v3(limbPoint(limb, Math.max(0, t - 0.02)));
    const bone = norm(sub(ahead, behind));
    const ant = front === "palm" ? across([...limb.face], bone) : across([0, 0, 1], bone);
    // lateral (for a forearm: radial) — in the frame the limb is given in, the left limb's: +X is lateral
    const lat = front === "palm" ? norm(cross(ant, bone)) : across(across([1, 0, 0], bone), ant);
    const radii = (which === "legs" ? legRadii(this.rig.frame) : armRadii(this.rig.frame))(t) as number[];
    const r = Math.max(0.025, ((radii[0] ?? 0.05) + ((radii[1] ?? 0.05) + (radii[2] ?? radii[1] ?? 0.05)) / 2) / 2);
    const a = u / r;
    const d = norm(add(mul(ant, Math.cos(a)), mul(lat, Math.sin(a))));
    return { origin: mirror(add(axis, mul(d, 0.25))), towards: mirror(axis) };
  }
}

/** The chart place a needle went in at: its mark's, or the explicit place given with it. */
export function siteOfInsertion(input: Record<string, unknown>, marks: { id: string; region: string; side: string; u: number; v: number }[]): ChartSite | null {
  if (typeof input.mark === "string") {
    const mark = marks.find((m) => m.id === input.mark);
    return mark ? { region: mark.region, side: mark.side, u: mark.u, v: mark.v } : null;
  }
  const at = input.at as { u?: unknown; v?: unknown } | undefined;
  if (typeof input.region === "string" && at && typeof at.u === "number" && typeof at.v === "number") {
    return { region: input.region, side: typeof input.side === "string" ? input.side : "midline", u: at.u, v: at.v };
  }
  return null;
}
