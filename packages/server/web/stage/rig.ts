import { BufferAttribute, Mesh, Quaternion, Vector3 } from "three";
import type { PersonRig } from "@clinicalcraft/web/world/npc.js";
import { boneTurn, smoothUnit, solveTwoBone, type TwoBonePose } from "./kinematics.js";

export type HandSide = "left" | "right";
export interface ReachResult { wrist: Vector3; elbow: Vector3; reachable: boolean }

/** Presentation-only hip hinge limits, in the figure's metre frame. Feet and limb lengths are unchanged. */
export const MAX_REACH_LEAN = { forward: 0.30, down: 0.20 } as const;
/** Authored presentation limit; clinical forearm range is not inferred from the hand's target frame. */
const MAX_FOREARM_ROLL = 85 * Math.PI / 180;

interface Limb {
  root: Vector3;
  mid: Vector3;
  end: Vector3;
  along: Vector3;
  face: Vector3;
  upper: number;
  lower: number;
}
interface VertexBinding { index: number; limb: number; t: number }
interface Reach { target: Vector3; blend: number; palm?: Quaternion }

const sideIndex = (side: HandSide): 0 | 1 => side === "left" ? 0 : 1;

/**
 * A small animation skin over the pinned figure kit's own sleeve, hand and trouser meshes. No replacement
 * cylinder arms: vertices follow two rigid bones, with a blended elbow/knee seam. The original measurements
 * remain the source of the bone lengths. A Blender pinch hand replaces only the default hand at full reach.
 */
export class AvatarRig {
  private readonly mesh: Mesh;
  private readonly positions: BufferAttribute;
  private readonly normals: BufferAttribute;
  private readonly original: Float32Array;
  private readonly originalNormals: Float32Array;
  private readonly torsoPositions: BufferAttribute;
  private readonly torsoOriginal: Float32Array;
  private readonly headRest: Vector3;
  private readonly limbs: Limb[];
  private readonly bindings: VertexBinding[] = [];
  private readonly neck: number[] = [];
  private readonly reaches: [Reach | null, Reach | null] = [null, null];
  private readonly forearmRoll: [number, number] = [0, 0];
  private lean = new Vector3();
  private walkPhase = 0;
  private gait = 0;
  private changed = false;
  private readonly v = new Vector3();
  private readonly n = new Vector3();

  constructor(private readonly rig: PersonRig) {
    this.mesh = rig.body.children.find((o) => o instanceof Mesh && o.userData.figure && o !== rig.torso) as Mesh;
    this.positions = this.mesh.geometry.getAttribute("position") as BufferAttribute;
    this.normals = this.mesh.geometry.getAttribute("normal") as BufferAttribute;
    this.original = new Float32Array(this.positions.array);
    this.originalNormals = new Float32Array(this.normals.array);
    this.torsoPositions = rig.torso.geometry.getAttribute("position") as BufferAttribute;
    this.torsoOriginal = new Float32Array(this.torsoPositions.array);
    this.headRest = rig.head.position.clone();
    this.mesh.frustumCulled = false;
    this.limbs = [...rig.skeleton.arms, ...rig.skeleton.legs].map((l, i) => {
      const mirror = i % 2 === 0 ? 1 : -1;
      const toV = (p: readonly number[]) => new Vector3(p[0]! * mirror, p[1]!, p[2]!);
      const root = toV(l.root), mid = toV(l.mid), end = toV(l.end);
      return { root, mid, end, along: toV(l.along).normalize(), face: toV(l.face).normalize(), upper: root.distanceTo(mid), lower: mid.distanceTo(end) };
    });
    for (let i = 0; i < this.positions.count; i++) {
      this.v.fromArray(this.original, i * 3);
      if (Math.abs(this.v.x) < 0.1 && this.v.y > 1.32) { this.neck.push(i); continue; }
      let best = { distance: Infinity, limb: -1, t: 0 };
      for (let j = 0; j < this.limbs.length; j++) {
        const l = this.limbs[j]!;
        const pairs = [[l.root, l.mid], [l.mid, l.end], [l.end, l.end.clone().addScaledVector(l.along, j < 2 ? 0.20 : 0.22)]] as const;
        for (let k = 0; k < pairs.length; k++) {
          const [a, b] = pairs[k]!;
          const d = b.clone().sub(a);
          const t = Math.max(0, Math.min(1, this.v.clone().sub(a).dot(d) / d.lengthSq()));
          const distance = this.v.distanceToSquared(a.clone().addScaledVector(d, t));
          if (distance < best.distance) best = { distance, limb: j, t: k + t };
        }
      }
      if (best.limb >= 0) this.bindings.push({ index: i, limb: best.limb, t: best.t });
    }
  }

  shoulderAt(side: HandSide): Vector3 {
    this.rig.body.updateWorldMatrix(true, false);
    return this.rig.body.localToWorld(this.limbs[sideIndex(side)]!.root.clone().add(this.lean));
  }

  wristAt(side: HandSide): Vector3 {
    const index = sideIndex(side), l = this.limbs[index]!;
    return this.world(this.pose(index).end ?? l.end);
  }

  private world(p: Vector3): Vector3 {
    this.rig.body.updateWorldMatrix(true, false);
    return this.rig.body.localToWorld(p.clone());
  }

  reach(side: HandSide, wristWorld: Vector3 | null, blend = 1, palm?: Quaternion): ReachResult {
    const index = sideIndex(side);
    this.reaches[index] = wristWorld ? { target: wristWorld.clone(), blend: Math.max(0, Math.min(1, blend)), ...(palm ? { palm: palm.clone() } : {}) } : null;
    if (!wristWorld || !palm) this.forearmRoll[index] = 0;
    this.updateLean();
    const pose = this.pose(index);
    this.changed = true;
    return { wrist: this.world(pose.end), elbow: this.world(pose.mid), reachable: pose.reachable };
  }

  private updateLean(): void {
    this.lean.set(0, 0, 0);
    const targets: { toward: Vector3; comfortable: number; blend: number }[] = [];
    const direction = new Vector3();
    let blend = 0;
    for (let i = 0; i < 2; i++) {
      const r = this.reaches[i];
      if (!r) continue;
      this.rig.body.updateWorldMatrix(true, false);
      const target = this.rig.body.worldToLocal(r.target.clone());
      const limb = this.limbs[i]!;
      const toward = target.sub(limb.root);
      targets.push({ toward, comfortable: limb.upper + limb.lower - 0.015, blend: smoothUnit(r.blend) });
      direction.addScaledVector(toward, smoothUnit(r.blend));
      blend = Math.max(blend, smoothUnit(r.blend));
    }
    if (!targets.length || blend === 0) return;
    const distance = Math.hypot(direction.x, direction.z) || 1;
    const hinge = new Vector3(direction.x / distance * MAX_REACH_LEAN.forward, direction.y < 0 ? -MAX_REACH_LEAN.down : 0, direction.z / distance * MAX_REACH_LEAN.forward);
    // One shared hip hinge must satisfy both arms. Averaging independently solved leans can leave the other
    // hand short even when a common bounded posture is reachable.
    const misses = (fraction: number) => Math.max(...targets.map((r) => r.toward.clone().addScaledVector(hinge, -fraction).length() - r.comfortable));
    let low = 0, high = misses(0) <= 0 ? 0 : 1;
    for (let step = 0; step < 16 && high > 0; step++) {
      const middle = (low + high) / 2;
      if (misses(middle) > 0) low = middle;
      else high = middle;
    }
    this.lean.copy(hinge).multiplyScalar(high * blend);
  }

  private pose(index: number): TwoBonePose {
    const l = this.limbs[index]!;
    const isArm = index < 2;
    const root = l.root.clone().add(isArm ? this.lean : new Vector3());
    const reach = isArm ? this.reaches[index] : null;
    if (reach) {
      this.rig.body.updateWorldMatrix(true, false);
      const target = this.rig.body.worldToLocal(reach.target.clone());
      const rest = l.end.clone().add(this.lean);
      const final = rest.lerp(target, smoothUnit(reach.blend));
      // Elbows open away from the trunk and slightly forward; no arbitrary frame-to-frame pole flips.
      return solveTwoBone(root, final, l.upper, l.lower, new Vector3(index === 0 ? 1 : -1, -0.3, 0.65));
    }
    const sign = index % 2 === 0 ? 1 : -1;
    const angle = Math.sin(this.walkPhase) * sign * this.gait * (isArm ? -0.23 : 0.24);
    const upperQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle);
    const mid = l.mid.clone().sub(l.root).applyQuaternion(upperQ).add(root);
    const lowerAngle = !isArm ? Math.max(0, -Math.sin(this.walkPhase) * sign) * 0.34 * this.gait : 0;
    const lowerQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), angle + lowerAngle);
    const end = l.end.clone().sub(l.mid).applyQuaternion(lowerQ).add(mid);
    return { root, mid, end, reachable: true };
  }

  /** The wrist frame supplies pronation, while the two-bone solve owns the elbow and wrist positions. */
  private wristRoll(index: number, pose: TwoBonePose, lowerTurn: Quaternion): { axis: Vector3; angle: number } | null {
    if (index > 1) return null;
    const reach = this.reaches[index];
    if (!reach?.palm) return null;
    const axis = pose.end.clone().sub(pose.mid).normalize();
    // Figure-kit `face` is palmar; the detail hand's wrist frame +Y is dorsal.
    const dorsal = this.limbs[index]!.face.clone().negate().applyQuaternion(lowerTurn);
    const target = new Vector3(0, 1, 0).applyQuaternion(reach.palm)
      .transformDirection(this.rig.body.matrixWorld.clone().invert());
    dorsal.addScaledVector(axis, -dorsal.dot(axis));
    target.addScaledVector(axis, -target.dot(axis));
    if (dorsal.lengthSq() < 1e-10 || target.lengthSq() < 1e-10) {
      return { axis, angle: this.forearmRoll[index]! * smoothUnit(reach.blend) };
    }
    dorsal.normalize(); target.normalize();
    const raw = Math.atan2(axis.dot(new Vector3().crossVectors(dorsal, target)), dorsal.dot(target));
    const previous = this.forearmRoll[index]!;
    const continuous = previous + Math.atan2(Math.sin(raw - previous), Math.cos(raw - previous));
    const angle = Math.max(-MAX_FOREARM_ROLL, Math.min(MAX_FOREARM_ROLL, continuous));
    this.forearmRoll[index] = angle;
    return { axis, angle: angle * smoothUnit(reach.blend) };
  }

  tick(dt: number, metres: number, moving: boolean): void {
    const previous = this.gait;
    this.gait += ((moving ? 1 : 0) - this.gait) * Math.min(1, dt / 170);
    if (this.gait < 0.001) this.gait = 0;
    this.walkPhase += metres * Math.PI * 2 / 1.15;
    if (!this.changed && this.gait === 0 && previous === 0 && !this.reaches.some(Boolean)) return;
    this.updateLean();
    const poses = this.limbs.map((_, i) => this.pose(i));
    const turns = poses.map((p, i) => {
      const l = this.limbs[i]!;
      return [boneTurn(l.mid.clone().sub(l.root), p.mid.clone().sub(p.root)), boneTurn(l.end.clone().sub(l.mid), p.end.clone().sub(p.mid))] as const;
    });
    const wristRolls = poses.map((p, i) => this.wristRoll(i, p, turns[i]![1]));
    const upperPoint = new Vector3(), lowerPoint = new Vector3(), upperNormal = new Vector3(), lowerNormal = new Vector3();
    const twist = new Quaternion();
    for (const b of this.bindings) {
      const l = this.limbs[b.limb]!, p = poses[b.limb]!, q = turns[b.limb]!;
      this.v.fromArray(this.original, b.index * 3);
      this.n.fromArray(this.originalNormals, b.index * 3);
      upperPoint.copy(this.v).sub(l.root).applyQuaternion(q[0]).add(p.root);
      lowerPoint.copy(this.v).sub(l.mid).applyQuaternion(q[1]).add(p.mid);
      upperNormal.copy(this.n).applyQuaternion(q[0]);
      lowerNormal.copy(this.n).applyQuaternion(q[1]);
      const wristRoll = wristRolls[b.limb];
      if (wristRoll) {
        // The source forearm already turns into its own hand plane. Add only the requested change,
        // with no axial displacement or abrupt seam at the elbow and no rotation of the upper arm.
        const amount = smoothUnit((b.t - 1.1) / 0.85);
        twist.setFromAxisAngle(wristRoll.axis, wristRoll.angle * amount);
        lowerPoint.sub(p.mid).applyQuaternion(twist).add(p.mid);
        lowerNormal.applyQuaternion(twist);
      }
      const weight = smoothUnit((b.t - 0.83) / 0.34);
      this.v.copy(upperPoint).lerp(lowerPoint, weight);
      this.n.copy(upperNormal).lerp(lowerNormal, weight).normalize();
      const reach = b.limb < 2 ? this.reaches[b.limb] : null;
      // Default fingertips disappear into the wrist while the articulated Blender hand takes over.
      if (reach && b.t > 2.01) this.v.lerp(p.end, smoothUnit((reach.blend - 0.55) / 0.45));
      this.positions.setXYZ(b.index, this.v.x, this.v.y, this.v.z);
      this.normals.setXYZ(b.index, this.n.x, this.n.y, this.n.z);
    }
    for (const i of this.neck) {
      this.v.fromArray(this.original, i * 3).add(this.lean);
      this.positions.setXYZ(i, this.v.x, this.v.y, this.v.z);
    }
    this.positions.needsUpdate = this.normals.needsUpdate = true;
    const hip = this.rig.skeleton.hip;
    for (let i = 0; i < this.torsoPositions.count; i++) {
      this.v.fromArray(this.torsoOriginal, i * 3);
      const weight = smoothUnit((this.v.y - hip) / 0.48);
      this.v.addScaledVector(this.lean, weight);
      this.torsoPositions.setXYZ(i, this.v.x, this.v.y, this.v.z);
    }
    this.torsoPositions.needsUpdate = true;
    this.rig.head.position.copy(this.headRest).add(this.lean);
    this.changed = false;
  }
}
