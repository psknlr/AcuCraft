import * as THREE from "three";

/**
 * The people in the clinic as articulated mannequins: smooth, proportioned, and plainly figures rather than
 * portraits. Each is a small skeleton (pelvis, spine, head, two-bone arms and legs) posed by the engine's own states
 * — standing, walking a planned path, seated, lying supine, prone or on a side along the couch — and a body site of
 * the body map can be found on the surface in any of those poses, which is where the needles are drawn.
 */

export type Outfit = "physician" | "assistant" | "supervisor" | "patient";
export type Pose = "standing" | "seated" | "seated-forward" | "supine" | "supine-knee-flexed" | "prone" | "side-lying-left" | "side-lying-right";
export type Face = "front" | "back" | "top" | "side" | "sole";

const OUTFITS: Record<Outfit, { top: string; sleeves: string | null; legs: string | null; shoes: string | null; hair: string }> = {
  physician: { top: "#f4f5f2", sleeves: "#f4f5f2", legs: "#34485c", shoes: "#2a2d30", hair: "#2b2622" },
  assistant: { top: "#4f9c95", sleeves: "#4f9c95", legs: "#3f837d", shoes: "#e8e8e4", hair: "#3a2d25" },
  supervisor: { top: "#f4f5f2", sleeves: "#f4f5f2", legs: "#4a4a50", shoes: "#2a2d30", hair: "#8c8c8c" },
  patient: { top: "#b9cfe0", sleeves: null, legs: null, shoes: null, hair: "#2e2a27" },
};

/** Which face of the body a regional chart lies on. */
const FACES: Record<string, Face> = { "upper-back": "back", lumbar: "back", "sacrum-buttock": "back", "neck-shoulder": "back", scalp: "top", "head-lateral": "side", sole: "sole", "hand-palm": "back" };

interface Limb {
  root: THREE.Group;
  mid: THREE.Group;
  end: THREE.Group;
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  tip: THREE.Mesh;
  upperLen: number;
  lowerLen: number;
  upperR: number;
  lowerR: number;
}

const skinMaterial = () => new THREE.MeshPhysicalMaterial({ color: "#d9ad8c", roughness: 0.55, sheen: 0.35, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffd2bd") });
const clothMaterial = (color: string) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.85, sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.6) });

export class Mannequin {
  readonly root = new THREE.Group();
  readonly H: number;
  pose: Pose = "standing";
  private pelvis = new THREE.Group();
  private spine = new THREE.Group();
  private neck = new THREE.Group();
  private head: THREE.Mesh;
  private chest: THREE.Mesh;
  private hips: THREE.Mesh;
  private arms: { left: Limb; right: Limb };
  private legs: { left: Limb; right: Limb };
  private d: Record<string, number>;
  private walkPhase = 0;
  private reach: { side: "left" | "right"; target: THREE.Vector3 } | null = null;

  constructor(heightM: number, outfit: Outfit, sex = "female") {
    const H = (this.H = heightM);
    const o = OUTFITS[outfit];
    const skin = skinMaterial();
    const top = clothMaterial(o.top);
    const sleeves = o.sleeves ? clothMaterial(o.sleeves) : skin;
    const legsM = o.legs ? clothMaterial(o.legs) : skin;
    const broad = sex === "male" ? 1.06 : 1;
    const d = (this.d = {
      hip: 0.53 * H,
      waist: 0.075 * H,
      chestLen: 0.215 * H,
      shoulderW: 0.122 * H * broad,
      hipW: 0.052 * H,
      upperArm: 0.172 * H,
      forearm: 0.148 * H,
      hand: 0.1 * H,
      thigh: 0.245 * H,
      shin: 0.245 * H,
      foot: 0.04 * H,
      neck: 0.045 * H,
      headR: 0.062 * H,
      chestW: 0.098 * H * broad,
      chestD: 0.066 * H,
      thighR: 0.047 * H,
      shinR: 0.033 * H,
      upperArmR: 0.029 * H,
      forearmR: 0.024 * H,
    });
    const cast = <T extends THREE.Mesh>(m: T): T => {
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    const capsule = (radius: number, length: number, material: THREE.Material) => {
      const g = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 6, 18);
      g.translate(0, -length / 2, 0);
      return cast(new THREE.Mesh(g, material));
    };

    this.root.add(this.pelvis);
    this.pelvis.position.y = d.hip;
    // pelvis and abdomen
    const hipG = new THREE.SphereGeometry(1, 24, 16);
    hipG.scale(d.chestW * 0.9, d.waist * 1.2, d.chestD * 0.86);
    // a coat or a tunic hangs over the hips
    this.hips = cast(new THREE.Mesh(hipG, top));
    this.hips.position.y = d.waist * 0.35;
    this.pelvis.add(this.hips);
    // chest: an ellipsoid capsule from the waist to the shoulders
    this.spine.position.y = d.waist;
    this.pelvis.add(this.spine);
    const chestG = new THREE.CapsuleGeometry(1, 1.45, 8, 24);
    chestG.scale(d.chestW, d.chestLen / 3.45, d.chestD);
    chestG.translate(0, d.chestLen * 0.5, 0);
    this.chest = cast(new THREE.Mesh(chestG, top));
    this.spine.add(this.chest);
    // neck and head
    this.neck.position.y = d.chestLen;
    this.spine.add(this.neck);
    const neckMesh = cast(new THREE.Mesh(new THREE.CylinderGeometry(d.headR * 0.48, d.headR * 0.55, d.neck * 1.5, 16), skin));
    neckMesh.position.y = d.neck * 0.45;
    this.neck.add(neckMesh);
    const headG = new THREE.SphereGeometry(d.headR, 28, 20);
    headG.scale(0.92, 1.14, 1);
    this.head = cast(new THREE.Mesh(headG, skin));
    this.head.position.y = d.neck + d.headR * 1.02;
    this.neck.add(this.head);
    // hair: a cap over the crown and the back of the head
    const hairG = new THREE.SphereGeometry(d.headR * 1.045, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.6);
    hairG.scale(0.95, 1.15, 1.03);
    const hair = cast(new THREE.Mesh(hairG, new THREE.MeshStandardMaterial({ color: o.hair, roughness: 0.9 })));
    hair.rotation.x = -0.42;
    this.head.add(hair);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(d.headR * 0.13, 10, 8), skin);
    nose.position.set(0, -d.headR * 0.08, d.headR * 0.98);
    this.head.add(nose);

    const limb = (parent: THREE.Group, x: number, y: number, upperLen: number, lowerLen: number, upperR: number, lowerR: number, upperM: THREE.Material, lowerM: THREE.Material, tip: THREE.Mesh): Limb => {
      const root = new THREE.Group();
      root.position.set(x, y, 0);
      parent.add(root);
      const upper = capsule(upperR, upperLen + upperR * 0.6, upperM);
      root.add(upper);
      // a rounded joint where the limb leaves the body
      const ball = cast(new THREE.Mesh(new THREE.SphereGeometry(upperR * 1.02, 14, 10), upperM));
      root.add(ball);
      const mid = new THREE.Group();
      mid.position.y = -upperLen;
      root.add(mid);
      const lower = capsule(lowerR, lowerLen + lowerR * 0.6, lowerM);
      mid.add(lower);
      const end = new THREE.Group();
      end.position.y = -lowerLen;
      mid.add(end);
      end.add(tip);
      return { root, mid, end, upper, lower, tip, upperLen, lowerLen, upperR, lowerR };
    };
    const hand = () => {
      const g = new THREE.SphereGeometry(1, 14, 10);
      g.scale(d.forearmR * 1.25, d.hand * 0.5, d.forearmR * 0.7);
      g.translate(0, -d.hand * 0.42, 0);
      return cast(new THREE.Mesh(g, skin));
    };
    const foot = () => {
      const g = new THREE.SphereGeometry(1, 14, 10);
      g.scale(d.shinR * 1.15, d.foot * 0.85, 0.07 * H);
      g.translate(0, -d.foot * 0.55, 0.04 * H);
      return cast(new THREE.Mesh(g, o.shoes ? new THREE.MeshStandardMaterial({ color: o.shoes, roughness: 0.6 }) : skin));
    };
    this.arms = {
      left: limb(this.spine, d.shoulderW, d.chestLen * 0.93, d.upperArm, d.forearm, d.upperArmR, d.forearmR, sleeves, o.sleeves ? sleeves : skin, hand()),
      right: limb(this.spine, -d.shoulderW, d.chestLen * 0.93, d.upperArm, d.forearm, d.upperArmR, d.forearmR, sleeves, o.sleeves ? sleeves : skin, hand()),
    };
    this.legs = {
      left: limb(this.pelvis, d.hipW, 0, d.thigh, d.shin, d.thighR, d.shinR, legsM, legsM, foot()),
      right: limb(this.pelvis, -d.hipW, 0, d.thigh, d.shin, d.thighR, d.shinR, legsM, legsM, foot()),
    };
    // a patient's shorts
    if (!o.legs) {
      for (const leg of [this.legs.left, this.legs.right]) {
        const shorts = capsule(d.thighR * 1.07, d.thigh * 0.42, top);
        leg.root.add(shorts);
      }
    }
    this.setPose("standing");
  }

  /* ---------------------------------------------------------------- */
  /* Posing                                                            */
  /* ---------------------------------------------------------------- */

  private zero(): void {
    const d = this.d;
    for (const g of [this.pelvis, this.spine, this.neck]) g.rotation.set(0, 0, 0);
    this.pelvis.position.set(0, d.hip!, 0);
    for (const side of ["left", "right"] as const) {
      const s = side === "left" ? 1 : -1;
      this.arms[side].root.rotation.set(0, 0, s * 0.09);
      this.arms[side].mid.rotation.set(-0.12, 0, 0);
      this.arms[side].end.rotation.set(0, 0, 0);
      this.legs[side].root.rotation.set(0, 0, 0);
      this.legs[side].mid.rotation.set(0, 0, 0);
      this.legs[side].end.rotation.set(0, 0, 0);
    }
  }

  /** The limbs of a pose. Where the body lies or sits is set by `place*`. */
  setPose(pose: Pose): void {
    this.pose = pose;
    this.zero();
    const { arms, legs, d } = this;
    switch (pose) {
      case "seated":
      case "seated-forward":
        for (const side of ["left", "right"] as const) {
          legs[side].root.rotation.x = -Math.PI / 2;
          legs[side].mid.rotation.x = Math.PI / 2;
          arms[side].root.rotation.x = -0.42;
          arms[side].mid.rotation.x = -1.05;
        }
        if (pose === "seated-forward") {
          this.spine.rotation.x = 0.5;
          this.neck.rotation.x = 0.25;
          for (const side of ["left", "right"] as const) arms[side].root.rotation.x = -0.95;
        }
        break;
      case "supine":
      case "supine-knee-flexed":
        for (const side of ["left", "right"] as const) {
          const s = side === "left" ? 1 : -1;
          arms[side].root.rotation.set(0, 0, s * 0.2);
          arms[side].mid.rotation.set(0, 0, 0);
          // palms up
          arms[side].end.rotation.y = s * -0.3;
          legs[side].root.rotation.z = s * 0.06;
          if (pose === "supine-knee-flexed") {
            legs[side].root.rotation.x = -0.82;
            legs[side].mid.rotation.x = 1.55;
          }
        }
        break;
      case "prone":
        this.neck.rotation.y = 0.0;
        for (const side of ["left", "right"] as const) {
          const s = side === "left" ? 1 : -1;
          arms[side].root.rotation.set(0, 0, s * 0.22);
          legs[side].root.rotation.z = s * 0.06;
          legs[side].end.rotation.x = 0.6;
        }
        break;
      case "side-lying-left":
      case "side-lying-right": {
        const upper = pose === "side-lying-left" ? "right" : "left";
        const lower = upper === "left" ? "right" : "left";
        legs[upper].root.rotation.x = -0.9;
        legs[upper].mid.rotation.x = 1.2;
        legs[lower].root.rotation.x = -0.35;
        legs[lower].mid.rotation.x = 0.55;
        arms[upper].root.rotation.x = -0.8;
        arms[upper].mid.rotation.x = -0.7;
        arms[lower].root.rotation.x = -1.3;
        arms[lower].mid.rotation.x = -1.2;
        break;
      }
      default:
        break;
    }
    void d;
  }

  /** Standing (or walking) at a spot of the floor, facing `yaw` (the engine's: 0 looks north, towards −z). */
  placeStanding(x: number, z: number, yaw: number): void {
    this.root.position.set(x, 0, z);
    this.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI);
  }

  /** Seated on a chair whose front is `front` (a unit vector on the floor). */
  placeSeated(x: number, z: number, front: { x: number; z: number }, seatHeight = 0.46): void {
    const d = this.d;
    this.root.position.set(x - front.x * 0.06, 0, z - front.z * 0.06);
    this.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(front.x, front.z));
    this.pelvis.position.y = seatHeight + d.thighR!;
  }

  /**
   * Lying along a couch: `head` is the unit vector on the floor from the body's centre towards the head, `vertex`
   * where the top of the head is, `top` the height of the surface lain on.
   */
  placeLying(vertex: { x: number; z: number }, head: { x: number; z: number }, top: number): void {
    const d = this.d;
    const up = new THREE.Vector3(head.x, 0, head.z).normalize();
    let front = new THREE.Vector3(0, 1, 0);
    let lift = d.chestD! * 0.98;
    if (this.pose === "prone") front = new THREE.Vector3(0, -1, 0);
    else if (this.pose === "side-lying-left" || this.pose === "side-lying-right") {
      // lying on the left side: the body's left (up × front) points down
      const down = new THREE.Vector3(0, -1, 0);
      front = this.pose === "side-lying-left" ? new THREE.Vector3().crossVectors(down, up) : new THREE.Vector3().crossVectors(up, down);
      lift = d.shoulderW! * 1.05;
    }
    const left = new THREE.Vector3().crossVectors(up, front).normalize();
    this.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, front));
    // the feet are a body's length from the vertex
    this.root.position.set(vertex.x - up.x * this.H, top + lift, vertex.z - up.z * this.H);
    this.pelvis.position.y = d.hip!;
  }

  /** Advance the walk cycle by a distance walked (m); 0 stands still. */
  stride(metres: number): void {
    if (metres <= 0) {
      if (this.walkPhase !== 0) {
        this.walkPhase = 0;
        this.setPose("standing");
        this.applyReach();
      }
      return;
    }
    this.walkPhase += (metres / (0.42 * this.H)) * Math.PI;
    const s = Math.sin(this.walkPhase);
    const c = Math.cos(this.walkPhase);
    const { arms, legs } = this;
    legs.left.root.rotation.x = -0.48 * s;
    legs.right.root.rotation.x = 0.48 * s;
    legs.left.mid.rotation.x = 0.62 * Math.max(0, c) + 0.06;
    legs.right.mid.rotation.x = 0.62 * Math.max(0, -c) + 0.06;
    arms.left.root.rotation.x = 0.36 * s;
    arms.right.root.rotation.x = -0.36 * s;
    arms.left.mid.rotation.x = -0.32;
    arms.right.mid.rotation.x = -0.32;
    this.pelvis.position.y = this.d.hip! - 0.012 * this.H * Math.abs(s);
    this.spine.rotation.y = 0.06 * s;
  }

  /** Stretch an arm towards a point of the world (null: let it hang). */
  reachTo(target: THREE.Vector3 | null, side: "left" | "right" = "right"): void {
    this.reach = target ? { side, target: target.clone() } : null;
    if (!target) {
      const s = side === "left" ? 1 : -1;
      for (const k of ["left", "right"] as const) {
        this.arms[k].root.quaternion.setFromEuler(new THREE.Euler(0, 0, (k === "left" ? 1 : -1) * 0.09));
        this.arms[k].mid.rotation.set(-0.12, 0, 0);
      }
      void s;
      return;
    }
    this.applyReach();
  }

  private applyReach(): void {
    if (!this.reach) return;
    const arm = this.arms[this.reach.side];
    this.root.updateWorldMatrix(true, true);
    const parent = arm.root.parent!;
    const shoulder = arm.root.getWorldPosition(new THREE.Vector3());
    const a = arm.upperLen;
    const b = arm.lowerLen + this.d.hand! * 0.6;
    const to = this.reach.target.clone().sub(shoulder);
    const dist = THREE.MathUtils.clamp(to.length(), Math.abs(a - b) + 0.01, a + b - 0.005);
    // the direction of the target in the shoulder's parent frame
    const inv = new THREE.Quaternion().copy(parent.getWorldQuaternion(new THREE.Quaternion())).invert();
    const dir = to.normalize().applyQuaternion(inv);
    const aim = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    // open the elbow by the law of cosines; the upper arm leads the line to the target by the angle at the shoulder
    const atShoulder = Math.acos(THREE.MathUtils.clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1));
    const atElbow = Math.acos(THREE.MathUtils.clamp((a * a + b * b - dist * dist) / (2 * a * b), -1, 1));
    arm.root.quaternion.copy(aim).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), atShoulder));
    arm.mid.rotation.set(-(Math.PI - atElbow), 0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Body sites                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Where a point of a regional chart is on this body as it is posed: `axial` and `lateral` are the body map's
   * (fraction of the height from the vertex; metres from the midline), `du`/`dv` the point's offset from the middle
   * of its chart (cm). Returns the place and the outward normal in the world.
   */
  surface(regionId: string, side: "left" | "right" | "midline", axial: number, lateral: number, du = 0, dv = 0): { position: THREE.Vector3; normal: THREE.Vector3 } {
    const d = this.d;
    const H = this.H;
    const face = FACES[regionId] ?? "front";
    const s = side === "left" ? 1 : side === "right" ? -1 : 0;
    const fz = face === "back" ? -1 : 1;
    const along = -dv / 100; // cranial is up the body
    let part: THREE.Object3D;
    const local = new THREE.Vector3();
    const normal = new THREE.Vector3(0, 0, fz);
    const onLimb = (limb: Limb, proximal: boolean, t: number, radius: number, length: number) => {
      part = proximal ? limb.root : limb.mid;
      // u runs round the limb: positive towards lateral
      const round = THREE.MathUtils.clamp(du / 100 / radius, -1.3, 1.3) * (s || 1);
      const y = -THREE.MathUtils.clamp(t * length + along, 0.02 * length, 0.98 * length);
      const ang = (fz > 0 ? 0 : Math.PI) + round;
      normal.set(Math.sin(ang), 0, Math.cos(ang));
      local.set(normal.x * radius, y, normal.z * radius);
    };
    const armish = regionId === "upper-arm" || regionId === "forearm" || regionId === "hand-dorsum" || regionId === "hand-palm";
    if (armish) {
      const arm = this.arms[s >= 0 ? "left" : "right"];
      if (regionId === "upper-arm") onLimb(arm, true, 0.5, arm.upperR, arm.upperLen);
      else if (regionId === "forearm") onLimb(arm, false, 0.5, arm.lowerR, arm.lowerLen);
      else {
        part = arm.end;
        normal.set(0, 0, regionId === "hand-palm" ? 1 : -1);
        local.set(THREE.MathUtils.clamp((du / 100) * (s || 1), -0.03, 0.03), -d.hand! * 0.45 + THREE.MathUtils.clamp(-along, -0.03, 0.03), normal.z * d.forearmR! * 0.7);
      }
    } else if (face === "top" || regionId === "face" || face === "side" || axial < 0.12) {
      part = this.head;
      const r = d.headR!;
      if (face === "top") normal.set(THREE.MathUtils.clamp((du / 100 / r) * 0.9, -0.9, 0.9), 1, THREE.MathUtils.clamp(-(dv - 14) / 100 / r, -1, 1) * 0.9).normalize();
      else if (face === "side") normal.set(s || 1, THREE.MathUtils.clamp(dv / 100 / r, -0.6, 0.6), THREE.MathUtils.clamp(-du / 100 / r, -0.6, 0.6)).normalize();
      else normal.set(THREE.MathUtils.clamp((s * lateral + du / 100) / r, -0.7, 0.7), THREE.MathUtils.clamp(dv / 100 / r, -0.7, 0.7), 0.8).normalize();
      local.set(normal.x * r * 0.92, normal.y * r * 1.14, normal.z * r);
    } else if (axial < 0.5) {
      // the trunk: the chest above the waist, the pelvis below
      const y = (1 - axial) * H + along;
      const x = THREE.MathUtils.clamp(s * lateral + (du / 100) * (s || 1), -d.chestW! * 0.92, d.chestW! * 0.92);
      const waistY = d.hip! + d.waist!;
      if (y >= waistY) {
        part = this.spine;
        const depth = d.chestD! * Math.sqrt(Math.max(0.05, 1 - (x / d.chestW!) ** 2));
        local.set(x, THREE.MathUtils.clamp(y - waistY, 0, d.chestLen! * 0.98), fz * depth);
      } else {
        part = this.pelvis;
        const depth = d.chestD! * Math.sqrt(Math.max(0.05, 1 - (x / d.chestW!) ** 2));
        local.set(x, THREE.MathUtils.clamp(y - d.hip!, -d.waist! * 0.6, d.waist!), fz * depth);
      }
    } else {
      const leg = this.legs[s >= 0 ? "left" : "right"];
      const hipY = d.hip!;
      const y = (1 - axial) * H;
      if (face === "sole" || regionId === "foot") {
        part = leg.end;
        if (face === "sole") {
          normal.set(0, -1, 0);
          local.set((du / 100) * (s || 1), -d.foot! * 1.3, 0.04 * H + THREE.MathUtils.clamp(dv / 100, -0.07, 0.07));
        } else {
          normal.set(0, 0.8, 0.6).normalize();
          local.set((du / 100) * (s || 1) * 0.6, -d.foot! * 0.2, 0.05 * H + THREE.MathUtils.clamp(-dv / 100, -0.05, 0.05));
        }
      } else if (y > hipY - d.thigh!) onLimb(leg, true, (hipY - y) / d.thigh!, leg.upperR, leg.upperLen);
      else onLimb(leg, false, (hipY - d.thigh! - y) / d.shin!, leg.lowerR, leg.lowerLen);
    }
    this.root.updateWorldMatrix(true, true);
    const position = part!.localToWorld(local.clone());
    const q = part!.getWorldQuaternion(new THREE.Quaternion());
    return { position, normal: normal.applyQuaternion(q).normalize() };
  }

  /** Where the head is (for a name tag). */
  headTop(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.head.getWorldPosition(new THREE.Vector3());
  }
}

/** Walks a figure along the paths the engine planned, at a pace the eye can follow. */
export class Walker {
  private queue: { points: THREE.Vector2[]; lengths: number[]; total: number; done: number; finalYaw: number }[] = [];
  x = 0;
  z = 0;
  yaw = 0;
  constructor(
    readonly figure: Mannequin,
    private speed = 2.6,
  ) {}

  get walking(): boolean {
    return this.queue.length > 0;
  }

  /** Stand here now (no walk). */
  set(x: number, z: number, yaw: number): void {
    this.queue = [];
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.figure.stride(0);
    this.figure.placeStanding(x, z, yaw);
  }

  walk(path: { x: number; z: number }[], finalYaw: number): void {
    const points = path.map((p) => new THREE.Vector2(p.x, p.z));
    if (points.length < 2) {
      this.yaw = finalYaw;
      return;
    }
    const lengths = points.slice(1).map((p, i) => p.distanceTo(points[i]!));
    this.queue.push({ points, lengths, total: lengths.reduce((a, b) => a + b, 0), done: 0, finalYaw });
  }

  /** Advance by `dt` seconds. Returns true while walking. */
  update(dt: number): boolean {
    const leg = this.queue[0];
    if (!leg) return false;
    // a long way is covered a little faster, so no walk outstays its welcome
    const pace = this.speed * Math.max(1, leg.total / 9) * (this.queue.length > 1 ? 1.6 : 1);
    const step = Math.min(pace * dt, leg.total - leg.done);
    leg.done += step;
    let rest = leg.done;
    let i = 0;
    while (i < leg.lengths.length - 1 && rest > leg.lengths[i]!) rest -= leg.lengths[i++]!;
    const a = leg.points[i]!;
    const b = leg.points[i + 1]!;
    const t = leg.lengths[i]! > 0 ? Math.min(1, rest / leg.lengths[i]!) : 1;
    this.x = a.x + (b.x - a.x) * t;
    this.z = a.y + (b.y - a.y) * t;
    const heading = Math.atan2(-(b.x - a.x), -(b.y - a.y));
    let turn = heading - this.yaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    this.yaw += turn * Math.min(1, dt * 10);
    this.figure.placeStanding(this.x, this.z, this.yaw);
    this.figure.stride(step);
    if (leg.done >= leg.total - 1e-6) {
      this.queue.shift();
      if (this.queue.length === 0) {
        this.yaw = leg.finalYaw;
        this.figure.stride(0);
        this.figure.placeStanding(this.x, this.z, this.yaw);
      }
    }
    return true;
  }
}
