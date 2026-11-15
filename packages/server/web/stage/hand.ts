import { AnimationMixer, Group, LoopOnce, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3, type AnimationAction, type AnimationClip, type Object3D } from "three";

export type HandPose = "pinch" | "tripod" | "palpate" | "press" | "stretch" | "scrape" | "flick" | "release";
export type HandContact = "pinch" | "index" | "nail" | "palm";
export interface FingerPose {
  pose: HandPose;
  grip: number;
  apertureMm?: number;
  /** Local phase of the authored primitive; contact changes are independent of the wrist trajectory. */
  phase: number;
  rotationRad?: number;
  nailContact?: number;
  intensity?: number;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const anatomical: Record<string, string> = {
  thumb_CMC: "thumb_proximal", thumb_MCP: "thumb_middle", thumb_IP: "thumb_distal",
  index_MCP: "index_proximal", index_PIP: "index_middle", index_DIP: "index_distal",
  middle_MCP: "middle_proximal", middle_PIP: "middle_middle", middle_DIP: "middle_distal",
  ring_MCP: "ring_proximal", ring_PIP: "ring_middle", ring_DIP: "ring_distal",
  little_MCP: "little_proximal", little_PIP: "little_middle", little_DIP: "little_distal",
};

/** A Blender hand with independent anatomical joint controls and moving contact anchors. */
export class ArticulatedHand {
  readonly root = new Group();
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  private readonly controls = new Map<string, Object3D>();
  private readonly neutral = new Map<Object3D, Quaternion>();
  private readonly hasAliases: boolean;

  constructor(readonly model: Group, clips: AnimationClip[], skin: string) {
    this.root.add(model);
    this.root.visible = false;
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = object.receiveShadow = true;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial && material.name === "hand_skin") material.color.set(skin);
      }
    });
    this.mixer = new AnimationMixer(model);
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions.set(clip.name, action);
    }
    this.hasAliases = !!model.getObjectByName("thumb_CMC");
    for (const [name, old] of Object.entries(anatomical)) {
      const node = model.getObjectByName(name) ?? model.getObjectByName(old);
      if (node) { this.controls.set(name, node); this.neutral.set(node, node.quaternion.clone()); }
    }
  }

  setSide(side: "left" | "right"): void { this.model.scale.z = side === "left" ? -1 : 1; }

  pose(settings: FingerPose): void {
    const grip = clamp(settings.grip), phase = clamp(settings.phase);
    // Legacy nodes carry the Blender clips; zero-offset anatomical parents can add fine articulation.
    this.mixer.stopAllAction();
    const clip = settings.pose === "press" || settings.pose === "stretch" || settings.pose === "palpate" ? "hand_support"
      : settings.pose === "scrape" ? "hand_scrape" : settings.pose === "flick" ? "hand_flick"
      : settings.pose === "tripod" ? "hand_three_finger" : "hand_open";
    const action = this.actions.get(clip) ?? this.actions.get("hand_open");
    if (action) {
      action.reset().play();
      action.paused = true;
      action.time = clip === "hand_flick" && this.actions.has(clip) ? phase
        : clip === "hand_open" || !this.actions.has(clip) ? 1 - grip : grip;
      this.mixer.update(0);
    }
    if (this.hasAliases) for (const [node, neutral] of this.neutral) node.quaternion.copy(neutral);
    const roll = Math.sin((settings.rotationRad ?? 0) * 1.2) * 0.045;
    const aperture = clamp(settings.apertureMm ?? 2, 0, 12) / 1000;
    const pulse = Math.sin(phase * Math.PI * 2);
    const intensity = clamp(settings.intensity ?? 0.5);
    const turn = (name: string, angle: number, axis = new Vector3(0, 0, 1)) => {
      const node = this.controls.get(name);
      if (node) node.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, angle));
    };
    // Counter-moving distal joints roll the handle while the contact midpoint remains anchored by the controller.
    turn("thumb_IP", roll);
    turn("thumb_MCP", -roll * 0.35);

    turn("index_PIP", -roll);
    turn("index_DIP", roll * 0.5);

    if (settings.pose === "tripod") {
      turn("middle_MCP", pulse * 0.012);
      turn("middle_DIP", -pulse * 0.012);
    }
    if (settings.pose === "palpate" || settings.pose === "press") {
      turn("index_PIP", pulse * 0.025 * intensity);
      turn("middle_PIP", -pulse * 0.018 * intensity);
      turn("ring_PIP", pulse * 0.012 * intensity);
    }
    if (settings.pose === "stretch") {
      turn("thumb_CMC", -0.12 * grip, new Vector3(1, 0, 0));
      turn("index_MCP", 0.07 * grip, new Vector3(0, 1, 0));
    }
    if (settings.pose === "scrape") {
      const scrape = clamp(settings.nailContact ?? 0);
      turn("index_PIP", 0.08 * scrape * pulse);
      turn("index_DIP", -0.055 * scrape * pulse);
    }
    if (settings.pose === "pinch" || settings.pose === "tripod" || settings.pose === "scrape") this.solveAperture(aperture);
    this.model.updateMatrixWorld(true);
  }

  /** Geometric thumb/index pad clearance, measured after the articulated pose rather than inferred from angles. */
  gapMm(): number {
    return this.anchor(["index_pad_contact", "index_pad", "index_tip"], new Vector3(0, 0, 0.001))
      .distanceTo(this.anchor(["thumb_pad_contact", "thumb_pad", "thumb_tip"], new Vector3(0, 0, -0.001))) * 1000;
  }

  private solveAperture(targetMetres: number): void {
    const index = this.model.getObjectByName("index_pad_contact") ?? this.model.getObjectByName("index_tip");
    const thumb = this.model.getObjectByName("thumb_pad_contact") ?? this.model.getObjectByName("thumb_tip");
    const joints = [this.controls.get("thumb_CMC"), this.controls.get("index_MCP")];
    if (!index || !thumb || joints.some((joint) => !joint)) return;
    // Solve before mirroring so the same anatomically articulated pose works for either hand.
    const mirror = this.model.scale.z;
    this.model.scale.z = Math.abs(mirror);
    const correction = [0, 0];
    for (let step = 0; step < 32; step++) {
      this.root.updateWorldMatrix(true, true);
      const a = thumb.getWorldPosition(new Vector3()), b = index.getWorldPosition(new Vector3());
      const difference = b.clone().sub(a), distance = difference.length();
      const error = targetMetres - distance;
      if (Math.abs(error) < 0.000005) break;
      const direction = distance > 1e-9 ? difference.divideScalar(distance) : new Vector3(0, 0, 1).applyQuaternion(this.model.getWorldQuaternion(new Quaternion()));
      const gradients = joints.map((joint, i) => {
        const tip = i === 0 ? a : b, sign = i === 0 ? -1 : 1;
        const lever = tip.clone().sub(joint!.getWorldPosition(new Vector3()));
        const axis = new Vector3().crossVectors(lever, direction.clone().multiplyScalar(sign));
        if (axis.lengthSq() < 1e-12) return { axis, value: 0 };
        axis.normalize();
        return { axis, value: new Vector3().crossVectors(axis, lever).dot(direction) * sign };
      });
      const denominator = gradients.reduce((sum, g) => sum + g.value * g.value, 0);
      if (denominator < 1e-12) break;
      for (let i = 0; i < joints.length; i++) {
        const node = joints[i]!, gradient = gradients[i]!;
        const proposed = clamp(error * gradient.value / denominator, -0.055, 0.055);
        const angle = clamp(correction[i]! + proposed, -0.55, 0.55) - correction[i]!;
        correction[i]! += angle;
        const parent = node.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
        const localAxis = gradient.axis.clone().applyQuaternion(parent.invert()).normalize();
        if (localAxis.lengthSq() > 1e-12) node.quaternion.premultiply(new Quaternion().setFromAxisAngle(localAxis, angle));
      }
    }
    this.model.scale.z = mirror;
    this.root.updateWorldMatrix(true, true);
  }

  private anchor(names: string[], fallback: Vector3): Vector3 {
    const object = names.map((name) => this.model.getObjectByName(name)).find(Boolean);
    this.root.updateWorldMatrix(true, true);
    return object ? this.root.worldToLocal(object.getWorldPosition(new Vector3())) : fallback.clone();
  }

  /** Contacts follow the moving phalanges, rather than static empties at the model origin. */
  contact(kind: HandContact): Vector3 {
    const index = this.anchor(["index_pad_contact", "index_pad", "index_tip"], new Vector3(0, 0, 0.006));
    if (kind === "index") return index;
    if (kind === "nail") return this.anchor(["index_nail_contact", "index_tip"], index);
    if (kind === "palm") return this.anchor(["palm_contact", "support_contact"], new Vector3(0.105, -0.012, 0));
    const thumb = this.anchor(["thumb_pad_contact", "thumb_pad", "thumb_tip"], new Vector3(0, 0, -0.006));
    return index.add(thumb).multiplyScalar(0.5);
  }

  contactNormal(kind: HandContact): Vector3 {
    const names = kind === "nail" ? ["index_nail_contact"] : kind === "palm" ? ["palm_contact", "support_contact"] : ["index_pad_contact", "index_pad"];
    const node = names.map((name) => this.model.getObjectByName(name)).find(Boolean);
    this.root.updateWorldMatrix(true, true);
    if (!node) return new Vector3(0, -1, 0);
    const origin = node.getWorldPosition(new Vector3());
    return node.localToWorld(new Vector3(0, 1, 0)).sub(origin).normalize()
      .transformDirection(new Matrix4().copy(this.root.matrixWorld).invert());
  }

  wrist(): Vector3 { return this.anchor(["wrist"], new Vector3(0.162, 0.004, 0)); }

  /** World contact used by tests and optional diagnostic overlays. */
  contactAt(kind: HandContact): Vector3 { return this.root.localToWorld(this.contact(kind)); }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.root.removeFromParent();
  }
}

/** Stable palm frame: +Y follows the needle/skin normal; +X points from contact toward the shoulder. */
export function handOrientation(contact: Vector3, normal: Vector3, shoulder: Vector3, roll = 0): Quaternion {
  const y = normal.clone();
  if (y.lengthSq() < 1e-10) y.set(0, 1, 0);
  y.normalize();
  const toward = shoulder.clone().sub(contact);
  const x = toward.addScaledVector(y, -toward.dot(y));
  if (x.lengthSq() < 1e-10) {
    x.set(Math.abs(y.x) < 0.9 ? 1 : 0, Math.abs(y.x) < 0.9 ? 0 : 1, 0);
    x.addScaledVector(y, -x.dot(y));
  }
  x.normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Number.isFinite(roll) ? roll : 0));
}

/** Align the actual moving pad/nail normal against the skin, then use the wrist direction to fix its twist. */
export function surfaceHandOrientation(contactLocal: Vector3, wristLocal: Vector3, outwardLocal: Vector3, contactWorld: Vector3, skinNormal: Vector3, shoulderWorld: Vector3): Quaternion {
  const yLocal = outwardLocal.clone().normalize(), yWorld = skinNormal.clone().normalize().negate();
  const tangent = (toward: Vector3, normal: Vector3) => {
    toward.addScaledVector(normal, -toward.dot(normal));
    if (toward.lengthSq() < 1e-10) {
      toward.set(Math.abs(normal.x) < 0.8 ? 1 : 0, Math.abs(normal.x) < 0.8 ? 0 : 1, 0);
      toward.addScaledVector(normal, -toward.dot(normal));
    }
    return toward.normalize();
  };
  if (yLocal.lengthSq() < 1e-10 || yWorld.lengthSq() < 1e-10) return handOrientation(contactWorld, skinNormal, shoulderWorld);
  const xLocal = tangent(wristLocal.clone().sub(contactLocal), yLocal), xWorld = tangent(shoulderWorld.clone().sub(contactWorld), yWorld);
  const localBasis = new Matrix4().makeBasis(xLocal, yLocal, new Vector3().crossVectors(xLocal, yLocal).normalize());
  const worldBasis = new Matrix4().makeBasis(xWorld, yWorld, new Vector3().crossVectors(xWorld, yWorld).normalize());
  return new Quaternion().setFromRotationMatrix(worldBasis.multiply(localBasis.transpose()));
}
