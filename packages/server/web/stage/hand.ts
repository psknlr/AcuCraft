import { AnimationMixer, Group, LoopOnce, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SkinnedMesh, Triangle, Vector3, type AnimationAction, type AnimationClip, type Object3D } from "three";
import { needleHandleRadiusAt } from "./needle-shape.js";
import { NAIL_WORK_WRIST_BOUNDS, THREE_FINGER_WRIST_BOUNDS, THREE_FINGER_WRIST_DEFAULT } from "@acucraft/core";

export type HandPose = "pinch" | "tripod" | "palpate" | "press" | "stretch" | "scrape" | "flick" | "release";
export type HandContact = "pinch" | "index" | "nail" | "palm" | "handle";
export interface FingerPose {
  pose: HandPose;
  grip: number;
  apertureMm?: number;
  /** Local phase of the authored primitive; contact changes are independent of the wrist trajectory. */
  phase: number;
  rotationRad?: number;
  nailContact?: number;
  intensity?: number;
  /** Constrain individual pads to this rendered handle, rather than aligning their midpoint only. */
  handleRadiusM?: number;
  /** The supporting middle finger stays engaged during an intentional thumb/index release. */
  stabilizerGrip?: number;
  wristElevationDeg?: number;
  gripStyle?: "tip-pinch" | "side-pinch";
  idleFingerPose?: "curled" | "relaxed";
  /** Internal visual share of an already approved axial needle movement; never changes the needle. */
  axialDisplacementMm?: number;
  /** Internal finger-walking presentation for an already approved, unidirectional shaft turn. */
  continuousRoll?: boolean;
}

interface RollingPatch {
  anchor: Object3D;
  origin: Vector3;
  orientation: Quaternion;
  along: Vector3;
  triangles: { triangle: Triangle; normals: [Vector3, Vector3, Vector3] }[];
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
  private readonly contactSolutions = new Map<string, { key: string; alpha: number; beta: number; rotations: Quaternion[]; openingKey?: string; openRotations?: Quaternion[] }>();
  private validContacts = true;
  private readonly hasAliases: boolean;
  private readonly patches = new Map<string, RollingPatch>();
  private readonly palmFrame: Object3D | undefined;
  private readonly authoredPoseFrame: Object3D | undefined;
  private readonly sourceWristElevation: number;
  private readonly sourceWristDirection: Vector3;
  private indexHoldingName = "index_pad_contact";
  private readonly rollingEngagement = new Map<string, number>();

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
    this.palmFrame = model.getObjectByName("palm_frame");
    this.authoredPoseFrame = model.getObjectByName("hand_pose_frame");
    if (this.authoredPoseFrame) { this.authoredPoseFrame.position.set(0, 0, 0); this.authoredPoseFrame.quaternion.identity(); }
    const wrist = this.wrist();
    this.sourceWristElevation = Math.atan2(wrist.y, wrist.x) * 180 / Math.PI;
    this.sourceWristDirection = wrist.clone().normalize();
    for (const [digit, name] of [["thumb", "thumb_pad_contact"], ["index", "index_pad_contact"], ["index", "index_side_contact"]] as const) this.captureRollingPatch(digit, name);
  }

  setSide(side: "left" | "right"): void { this.model.scale.z = side === "left" ? -1 : 1; }

  get contactValid(): boolean { return this.validContacts; }

  pose(settings: FingerPose): void {
    this.validContacts = true;
    if (this.palmFrame && settings.pose === "tripod" && settings.gripStyle === "side-pinch") {
      this.validContacts = false;
      return;
    }
    // The thumb/index precision grip supplies the stable frame for ordinary and nail manipulations.
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.indexHoldingName = settings.handleRadiusM !== undefined && ["pinch", "tripod"].includes(settings.pose) && settings.gripStyle === "side-pinch"
      ? "index_side_contact" : "index_pad_contact";
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
    if (this.authoredPoseFrame) { this.authoredPoseFrame.position.set(0, 0, 0); this.authoredPoseFrame.quaternion.identity(); }
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
      // Spread the index toward the ulnar fingers; radial motion crowds the opposed thumb.
      turn("index_MCP", -0.07 * grip, new Vector3(0, 1, 0));
    }
    if (settings.handleRadiusM !== undefined) {
      this.orientPalm(settings);
      this.relaxUnusedFingers(settings);
      this.rollHoldingSurfaces(settings);
      this.solveHandleContacts(settings);
    }
    else {
      if (["palpate", "press", "stretch"].includes(settings.pose)) {
        if (this.palmFrame) this.relaxSurfaceFingers(settings);
        this.relaxSurfaceThumb();
      }
      if (settings.pose === "pinch" || settings.pose === "tripod" || settings.pose === "scrape") this.solveAperture(aperture);
    }
    this.model.updateMatrixWorld(true);
  }

  /** Keep the needle frame canonical while raising the actual palm around the holding contact line. */
  private orientPalm(settings: FingerPose): void {
    if (!this.palmFrame) return;
    const nailWork = settings.pose === "scrape" || settings.pose === "flick";
    const bounds = nailWork ? NAIL_WORK_WRIST_BOUNDS : settings.pose === "tripod" ? THREE_FINGER_WRIST_BOUNDS : { min: 35, max: 70 };
    const elevation = clamp(settings.wristElevationDeg ?? (settings.pose === "tripod" ? THREE_FINGER_WRIST_DEFAULT : 55), bounds.min, bounds.max);
    this.model.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), (elevation - this.sourceWristElevation) * Math.PI / 180);
    const pivot = new Vector3(0, ["tripod", "scrape", "flick"].includes(settings.pose) ? -0.012 : 0, 0);
    // The reference bind holds at its own origin. Move that complete grasp to the selected handle
    // segment, then elevate about that contact line rather than stretching the fingers down to it.
    this.model.position.copy(pivot);
    if (this.indexHoldingName === "index_side_contact") this.model.position.addScaledVector(this.sourceWristDirection.clone().applyQuaternion(this.model.quaternion), -0.006);
    this.model.position.y -= (this.indexHoldingName === "index_side_contact" ? 0.00035 : 0.00065) * Math.tanh(clamp(settings.axialDisplacementMm ?? 0, -3, 3));
  }

  /** Real terminal skin triangles, expressed in the distal attachment's frame at bind pose. */
  private captureRollingPatch(digit: "thumb" | "index", name: string): void {
    const anchor = this.model.getObjectByName(name), skin = this.model.getObjectByName(`${digit}_skin`);
    if (!anchor?.parent || !(skin instanceof SkinnedMesh)) return;
    this.model.updateMatrixWorld(true); skin.skeleton.update();
    const matrix = anchor.parent.matrixWorld.clone().invert().multiply(skin.matrixWorld), normalMatrix = new Matrix3().getNormalMatrix(matrix);
    const positions = skin.geometry.getAttribute("position"), normals = skin.geometry.getAttribute("normal");
    const indices = skin.geometry.index, joints = skin.geometry.getAttribute("skinIndex"), weights = skin.geometry.getAttribute("skinWeight");
    const rigid = (vertex: number) => {
      let weight = 0;
      for (let i = 0; i < joints.itemSize; i++) if (skin.skeleton.bones[joints.getComponent(vertex, i)]?.name === `${digit}_distal`) weight += weights.getComponent(vertex, i);
      return weight > 0.9999;
    };
    const triangles: RollingPatch["triangles"] = [];
    for (let i = 0, count = indices?.count ?? positions.count; i < count; i += 3) {
      const vertices = [0, 1, 2].map((j) => indices ? indices.getX(i + j) : i + j);
      if (!vertices.every(rigid)) continue;
      const points = vertices.map((vertex) => new Vector3().fromBufferAttribute(positions, vertex).applyMatrix4(matrix));
      triangles.push({ triangle: new Triangle(points[0]!, points[1]!, points[2]!), normals: vertices.map((vertex) => new Vector3().fromBufferAttribute(normals, vertex).applyNormalMatrix(normalMatrix)) as [Vector3, Vector3, Vector3] });
    }
    if (!triangles.length) return;
    const forward = Math.sign(this.model.getObjectByName(`${digit}_tip`)!.position.x) || 1;
    const along = new Vector3(forward, 0, 0).transformDirection(this.model.matrixWorld).transformDirection(anchor.parent.matrixWorld.clone().invert());
    this.patches.set(name, { anchor, origin: anchor.position.clone(), orientation: anchor.quaternion.clone(), along, triangles });
  }

  /** Contact material migrates over real pulp while the distal hinges roll the needle. */
  private rollHoldingSurfaces(settings: FingerPose): void {
    const rotation = Number.isFinite(settings.rotationRad) ? settings.rotationRad! : 0;
    const sideGrip = this.indexHoldingName === "index_side_contact";
    // Bounded turns take a short pulp bite; one-way turns walk across a larger patch.
    // The thumb settles nearer its true tip to keep its stem clear of the opposed index pulp.
    const travel = sideGrip || !settings.continuousRoll ? 0.00015 : 0.0005;
    const bounded = this.palmFrame ? travel * Math.tanh(rotation / 1.2) * clamp(settings.grip) : 0;
    this.rollingEngagement.clear();
    const smooth = (value: number) => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };
    const cycles = Math.abs(rotation) / 2.4, warm = smooth(cycles), direction = Math.sign(rotation) || 1;
    const closest = new Vector3(), barycentric = new Vector3(), normal = new Vector3();
    for (const [name, patch] of this.patches) {
      patch.anchor.position.copy(patch.origin); patch.anchor.quaternion.copy(patch.orientation);
      if (name !== "thumb_pad_contact" && name !== this.indexHoldingName) continue;
      let distance = bounded;
      if (this.palmFrame && settings.continuousRoll) {
        const phase = (cycles + (name === "thumb_pad_contact" ? 0 : 0.5)) % 1;
        const material = phase < 0.72 ? -1 + 2 * smooth(phase / 0.72) : phase < 0.8 ? 1 : phase < 0.92 ? 1 - 2 * smooth((phase - 0.8) / 0.12) : -1;
        const engagement = phase < 0.72 ? 1 : phase < 0.8 ? 1 - smooth((phase - 0.72) / 0.08) : phase < 0.92 ? 0 : smooth((phase - 0.92) / 0.08);
        distance = travel * material * direction * warm * clamp(settings.grip);
        this.rollingEngagement.set(name, 1 - warm * (1 - engagement));
      }
      if (this.palmFrame && name === "thumb_pad_contact") {
        // Preserve the authored zero-turn bind; the first bounded turn gently acquires the new patch.
        const settle = sideGrip ? 1 : settings.continuousRoll ? 0 : smooth(Math.abs(rotation) / 0.3);
        distance -= 0.00065 * settle * clamp(settings.grip);
      }
      if (Math.abs(distance) < 1e-9) continue;
      const target = patch.origin.clone().addScaledVector(patch.along, -distance);
      let best: { point: Vector3; normal: Vector3; distance: number } | undefined;
      for (const surface of patch.triangles) {
        surface.triangle.closestPointToPoint(target, closest);
        const error = closest.distanceToSquared(target);
        if (best && error >= best.distance) continue;
        surface.triangle.getBarycoord(closest, barycentric);
        normal.copy(surface.normals[0]).multiplyScalar(barycentric.x).addScaledVector(surface.normals[1], barycentric.y).addScaledVector(surface.normals[2], barycentric.z).normalize();
        best = { point: closest.clone(), normal: normal.clone(), distance: error };
      }
      if (best) {
        patch.anchor.position.copy(best.point);
        patch.anchor.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), best.normal);
      }
    }
  }

  /** Unused fingers stay softly folded back toward the palm, away from the working pair and patient. */
  private relaxUnusedFingers(settings: FingerPose): void {
    const presets = settings.idleFingerPose === "relaxed"
      ? [[60, 65, 30], [48, 64, 39], [54, 70, 44]]
      : [[65, 82, 48], [72, 90, 35], [78, 96, 60]];
    const palm = this.palmFrame ? this.palmTransform() : new Matrix4();
    for (const digit of ["middle", "ring", "little"]) {
      if (digit === "middle" && ["tripod", "scrape", "flick"].includes(settings.pose)) continue;
      const joints = ["MCP", "PIP", "DIP"].map((joint) => this.controls.get(`${digit}_${joint}`));
      const legacy = ["proximal", "middle", "distal"].map((joint) => this.model.getObjectByName(`${digit}_${joint}`));
      const tip = this.model.getObjectByName(`${digit}_tip`);
      if (!tip || joints.some((joint) => !joint) || legacy.some((joint) => !joint)) continue;
      const a = joints[1]!.position, b = joints[2]!.position, c = tip.position;
      const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
      if (hingeB.dot(hingeA) < 0) hingeB.negate();
      const signed = (x: Vector3, y: Vector3, hinge: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
      const restA = signed(a, b, hingeA), restB = signed(b, c, hingeB);
      const angles = this.palmFrame ? presets[["middle", "ring", "little"].indexOf(digit)]! : [80, 90, 65];
      const flexion = angles[0]! * Math.PI / 180;
      const direction = new Vector3(-Math.cos(flexion), -Math.sin(flexion), 0).transformDirection(palm);
      const relaxed = new Quaternion().setFromUnitVectors(a.clone().normalize(), direction);
      if (this.palmFrame || digit === "middle") {
        const ulna = new Vector3(0, 0, -1).transformDirection(palm);
        const spreadAxis = this.palmFrame ? new Vector3().crossVectors(direction, ulna).normalize() : new Vector3(0, 1, 0);
        const spread = this.palmFrame ? (settings.idleFingerPose === "relaxed" ? [25, 20, 10] : [22, 17, 7])[["middle", "ring", "little"].indexOf(digit)]! : 5;
        relaxed.premultiply(new Quaternion().setFromAxisAngle(spreadAxis, spread * Math.PI / 180));
      }
      const rotations = [relaxed,
        new Quaternion().setFromAxisAngle(hingeA, angles[1]! * Math.PI / 180 - restA),
        new Quaternion().setFromAxisAngle(hingeB, angles[2]! * Math.PI / 180 - restB)];
      for (let i = 0; i < 3; i++) joints[i]!.quaternion.copy(rotations[i]!).multiply(legacy[i]!.quaternion.clone().invert());
    }
  }

  private palmTransform(): Matrix4 {
    this.model.updateWorldMatrix(true, true);
    return this.palmFrame ? this.model.matrixWorld.clone().invert().multiply(this.palmFrame.matrixWorld) : new Matrix4();
  }

  private relaxSurfaceFingers(settings: FingerPose): void {
    const palm = this.palmTransform(), pulse = Math.sin(clamp(settings.phase) * Math.PI * 2) * clamp(settings.intensity ?? 0.5);
    for (const digit of ["index", "middle", "ring", "little"]) {
      const joints = ["MCP", "PIP", "DIP"].map((label) => this.controls.get(`${digit}_${label}`));
      const legacy = ["proximal", "middle", "distal"].map((label) => this.model.getObjectByName(`${digit}_${label}`));
      const tip = this.model.getObjectByName(`${digit}_tip`);
      if (!tip || joints.some((joint) => !joint) || legacy.some((joint) => !joint)) continue;
      const a = joints[1]!.position, b = joints[2]!.position, c = tip.position;
      const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
      if (hingeB.dot(hingeA) < 0) hingeB.negate();
      const signed = (x: Vector3, y: Vector3, hinge: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
      if (digit === "index" && settings.pose !== "press") {
        const proximal = new Quaternion();
        if (settings.pose === "stretch") {
          const direction = a.clone().normalize(), radial = new Vector3(0, 0, 1).transformDirection(palm);
          proximal.setFromAxisAngle(new Vector3().crossVectors(direction, radial).normalize(), 5 * clamp(settings.grip) * Math.PI / 180);
        }
        const rotations = [proximal, new Quaternion().setFromAxisAngle(hingeA, pulse * 0.0125), new Quaternion()];
        for (let i = 0; i < 3; i++) joints[i]!.quaternion.copy(rotations[i]!).multiply(legacy[i]!.quaternion.clone().invert());
        continue;
      }
      const ordinal = ["middle", "ring", "little"].indexOf(digit);
      const mcp = (settings.pose === "press" ? 0 : [-10, -7, -4][ordinal]!) * Math.PI / 180;
      const direction = new Vector3(-Math.cos(mcp), -Math.sin(mcp), 0).transformDirection(palm);
      const proximal = new Quaternion().setFromUnitVectors(a.clone().normalize(), direction);
      const pip = (settings.pose === "press" ? 10 + pulse * (digit === "index" ? 0.65 : 0.3) : [12, 14, 16][ordinal]!) * Math.PI / 180;
      const dip = (settings.pose === "press" ? 7 : [7, 8, 9][ordinal]!) * Math.PI / 180;
      const rotations = [proximal, new Quaternion().setFromAxisAngle(hingeA, pip - signed(a, b, hingeA)), new Quaternion().setFromAxisAngle(hingeB, dip - signed(b, c, hingeB))];
      for (let i = 0; i < 3; i++) joints[i]!.quaternion.copy(rotations[i]!).multiply(legacy[i]!.quaternion.clone().invert());
    }
  }

  /** The pressing hand's thumb stays gently flexed instead of extending past the contacting index pulp. */
  private relaxSurfaceThumb(): void {
    const cmc = this.controls.get("thumb_CMC"), mcp = this.controls.get("thumb_MCP"), ip = this.controls.get("thumb_IP");
    const proximal = this.model.getObjectByName("thumb_proximal"), middle = this.model.getObjectByName("thumb_middle"), distal = this.model.getObjectByName("thumb_distal"), tip = this.model.getObjectByName("thumb_tip");
    if (!cmc || !mcp || !ip || !proximal || !middle || !distal || !tip) return;
    const a = mcp.position, b = ip.position, c = tip.position;
    const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
    if (hingeB.dot(hingeA) < 0) hingeB.negate();
    const restA = Math.atan2(a.clone().cross(b).dot(hingeA), a.dot(b));
    const restB = Math.atan2(b.clone().cross(c).dot(hingeB), b.dot(c));
    if (this.palmFrame) {
      cmc.quaternion.copy(proximal!.quaternion).invert();
      mcp.quaternion.setFromAxisAngle(hingeA, 40 * Math.PI / 180 - restA).multiply(middle.quaternion.clone().invert());
      ip.quaternion.setFromAxisAngle(hingeB, 20 * Math.PI / 180 - restB).multiply(distal.quaternion.clone().invert());
      return;
    }
    const swing = new Quaternion().setFromUnitVectors(a.clone().normalize(), new Vector3(-0.83, -0.10, 0.55).normalize());
    const angle = 2 * Math.acos(clamp(swing.w, -1, 1));
    const radial = new Vector3(swing.x, swing.y, swing.z).normalize();
    cmc.quaternion.setFromAxisAngle(radial, Math.min(angle, 35 * Math.PI / 180)).multiply(proximal.quaternion.clone().invert());
    mcp.quaternion.setFromAxisAngle(hingeA, 40 * Math.PI / 180 - restA).multiply(middle.quaternion.clone().invert());
    ip.quaternion.setFromAxisAngle(hingeB, 20 * Math.PI / 180 - restB).multiply(distal.quaternion.clone().invert());
  }

  /** A precision grip has opposing surface contacts, not merely a midpoint on the needle axis. */
  private solveHandleContacts(settings: FingerPose): void {
    const radius = clamp(settings.handleRadiusM ?? 0.0007, 0.0001, 0.002);
    // Even a zero opening setting must release the handle before the hand retreats.
    const opening = Math.max(radius + 0.0015, clamp(settings.apertureMm ?? 2, 0, 12) / 2000);
    const grip = clamp(settings.grip), stable = clamp(settings.stabilizerGrip ?? grip);
    // The wrist supplies the small rotation around the handle; the two opposing pads keep their
    // contacts. Orbiting each fingertip independently would twist an interphalangeal hinge sideways.
    const radial = new Vector3(0, 0, 1);
    const nailWork = settings.pose === "scrape" || settings.pose === "flick";
    // The optional third finger bears on a real oblique pulp patch above the primary pair.
    const holdingY = nailWork || settings.pose === "tripod" ? -0.012 : 0;
    const holdingRadius = holdingY ? needleHandleRadiusAt(holdingY) : radius;
    const holdingOpening = Math.max(holdingRadius + 0.0015, clamp(settings.apertureMm ?? 2, 0, 12) / 2000);
    const thumbRadial = radial.clone().negate();
    // A side grip bears on a longer section of the index. Its two real contact centres are gently
    // staggered along the handle, leaving room for the rounded thumb rather than intersecting skin.
    const sideStagger = this.palmFrame && this.indexHoldingName === "index_side_contact" ? 0.00025 : 0;
    for (const [digit, direction, y, kind] of [["thumb", thumbRadial, holdingY + sideStagger, "pad"],
      ["index", radial, holdingY - sideStagger, this.indexHoldingName === "index_side_contact" ? "side" : "pad"]] as const) {
      const contactRadius = y === 0 ? radius : needleHandleRadiusAt(y);
      const openingDistance = settings.continuousRoll && grip >= 0.999999 ? contactRadius + 0.0006 : holdingOpening;
      const target = direction.clone().multiplyScalar(contactRadius).setY(y);
      const open = direction.clone().multiplyScalar(openingDistance).setY(y);
      this.solveFingerContact(digit, kind, target, direction.clone().negate(), grip * (this.rollingEngagement.get(digit === "thumb" ? "thumb_pad_contact" : this.indexHoldingName) ?? 1), open);
    }
    if (settings.pose === "scrape" || settings.pose === "flick") {
      // Thumb and index keep their opposing pad contacts while the middle nail works the handle.
      const phase = clamp(settings.phase);
      const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
      const release = settings.pose !== "flick" || phase < 0.28 ? 0
        : phase < 0.42 ? smooth((phase - 0.28) / 0.14)
        : phase < 0.72 ? 1 : 1 - smooth((phase - 0.72) / 0.28);
      const y = 0.006 + (settings.pose === "scrape" ? clamp(settings.nailContact ?? 0) * 0.006 : Math.sin(phase * Math.PI) * 0.002);
      const azimuth = this.palmFrame ? Math.PI : 88 * Math.PI / 180;
      const nailRadial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)), nailRadius = needleHandleRadiusAt(y);
      const target = nailRadial.clone().multiplyScalar(nailRadius);
      target.y = y;
      const openTarget = this.palmFrame
        ? target.clone().addScaledVector(nailRadial, 0.00015).add(new Vector3(0, -0.0025, 0))
        : nailRadial.clone().multiplyScalar(nailRadius + Math.max(opening - radius, settings.pose === "flick" ? 0.006 : 0)).setY(y);
      this.solveFingerContact("middle", "nail_edge", target, nailRadial.clone().negate(), grip * (1 - release), openTarget);
    }
    if (settings.pose === "tripod") {
      const middleY = this.palmFrame ? 0.010 : 0.006, middleRadius = needleHandleRadiusAt(middleY);
      const base = this.controls.get("middle_MCP")!.position.clone().applyQuaternion(this.model.quaternion).add(this.model.position);
      const side = this.model.getObjectByName("middle_side_contact")!;
      // Reference support uses an authored oblique pulp route. Legacy lateral patches retain their
      // analytical normal/hinge relation instead of rotating a finger or moving its surface marker.
      const phi = this.palmFrame ? -Math.PI / 3 : Math.atan2(base.z, base.x) + Math.acos(clamp((middleRadius - side.position.z) / Math.hypot(base.x, base.z), -1, 1));
      const middleRadial = new Vector3(Math.cos(phi), 0, Math.sin(phi));
      const contact = middleRadial.clone().multiplyScalar(middleRadius).setY(middleY);
      const released = middleRadial.clone().multiplyScalar(middleRadius + opening - radius).setY(middleY);
      this.solveFingerContact("middle", "side", contact, middleRadial.clone().negate(), stable, released);
    }
  }

  /**
   * The MCP/CMC supplies opposition; the two downstream joints are anatomical hinges, never arbitrary
   * quaternion rotations. Two invariant equations determine their flexion angles while preserving exact
   * surface position and normal: |contact vector| and its dot product with the terminal surface normal.
   */
  private solveFingerContact(digit: "thumb" | "index" | "middle", kind: "pad" | "nail" | "nail_edge" | "side", target: Vector3, outward: Vector3, engagement: number, openingTarget: Vector3): void {
    if (this.palmFrame && digit === "middle" && kind === "nail_edge" && engagement < 0.999999) {
      // The keratin tip follows an explicit surface-to-clearance path. Blending two solved joint
      // poses bows the nail through the handle even when both endpoint poses are correct.
      target = target.clone().lerp(openingTarget, 1 - clamp(engagement));
      engagement = 1;
    }
    const labels = digit === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
    const controls = labels.map((label) => this.controls.get(`${digit}_${label}`));
    const legacy = ["proximal", "middle", "distal"].map((name) => this.model.getObjectByName(`${digit}_${name}`));
    const anchor = this.model.getObjectByName(`${digit}_${kind}_contact`), tip = this.model.getObjectByName(`${digit}_tip`);
    if (!anchor || !tip || controls.some((node) => !node) || legacy.some((node) => !node)) { this.validContacts = false; return; }
    this.root.updateWorldMatrix(true, true);
    const inversePalm = this.model.quaternion.clone().invert();
    const modelTarget = target.clone().sub(this.model.position).applyQuaternion(inversePalm);
    const modelOpening = openingTarget.clone().sub(this.model.position).applyQuaternion(inversePalm);
    const modelOutward = outward.clone().applyQuaternion(inversePalm);
    const cacheId = `${digit}:${kind}`, cacheKey = [...modelTarget.toArray(), ...modelOutward.toArray(), ...anchor.position.toArray(), ...anchor.quaternion.toArray()].join(",");
    let rotations = this.contactSolutions.get(cacheId);
    const base = controls[0]!.position.clone();
    const a = controls[1]!.position.clone(), b = controls[2]!.position.clone(), c = tip.position.clone();
    if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10 || c.lengthSq() < 1e-10) { this.validContacts = false; return; }
    const hingeA = a.clone().cross(b).normalize();
    // The opposed thumb bends in its own volar plane after CMC opposition. Applying the fingers'
    // global palmar sign to it would turn normal thumb flexion into an artificial reverse joint.
    const palmUp = new Vector3(0, 1, 0).transformDirection(this.palmTransform());
    if (digit !== "thumb" && hingeA.dot(palmUp.clone().cross(a)) < 0) hingeA.negate();
    const hingeB = b.clone().cross(c).normalize();
    if (hingeB.dot(hingeA) < 0) hingeB.negate();
    const restA = Math.atan2(a.clone().cross(b).dot(hingeA), a.dot(b));
    const restB = Math.atan2(b.clone().cross(c).dot(hingeB), b.dot(c));
    const localNormal = new Vector3(0, 1, 0).applyQuaternion(anchor.quaternion);
    const delta = modelTarget.clone().sub(base), distance = delta.length(), normal = modelOutward.normalize();
    const desiredDot = delta.dot(normal), radians = Math.PI / 180;
    const minA = -5 * radians, maxA = (digit === "thumb" ? 85 : 115) * radians;
    const minB = -5 * radians, maxB = 95 * radians;
    const evaluate = (alpha: number, beta: number) => {
        const proximal = new Quaternion().setFromAxisAngle(hingeA, alpha - restA);
        const distal = new Quaternion().setFromAxisAngle(hingeB, beta - restB);
        const vector = anchor.position.clone().applyQuaternion(distal).add(b).applyQuaternion(proximal).add(a);
        const terminalNormal = localNormal.clone().applyQuaternion(distal).applyQuaternion(proximal);
        return { proximal, distal, vector, normal: terminalNormal,
          lengthError: vector.length() - distance, normalError: vector.dot(terminalNormal) - desiredDot };
    };
    const frame = (along: Vector3, surface: Vector3) => {
        const x = along.clone().normalize(), y = surface.clone().addScaledVector(x, -surface.dot(x)).normalize();
        return new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y));
    };
    const naturalOpposition = (opposition: Quaternion, alpha: number, beta: number) => {
      const axis = a.clone().normalize(), projection = new Vector3(opposition.x, opposition.y, opposition.z).dot(axis);
      const raw = Math.abs(2 * Math.atan2(projection, opposition.w)), twist = Math.min(raw, 2 * Math.PI - raw);
      if (twist > (digit === "thumb" ? 100 : 40) * radians) return null;
      if (opposition.angleTo(new Quaternion()) > (digit === "thumb" ? 120 : 100) * radians) return null;
      if (digit !== "thumb") {
        const result = evaluate(alpha, beta);
        const first = a.clone().applyQuaternion(opposition).normalize();
        const second = b.clone().applyQuaternion(result.proximal).applyQuaternion(opposition).normalize();
        const third = c.clone().applyQuaternion(result.distal).applyQuaternion(result.proximal).applyQuaternion(opposition).normalize();
        const hinge = palmUp.clone().cross(first).normalize();
        const signed = (x: Vector3, y: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
        const pip = signed(first, second), dip = signed(second, third);
        if (pip < -5 * radians || dip < -10 * radians || dip > Math.max(0, pip) * 1.5 + 15 * radians) return null;
      }
      return opposition.angleTo(new Quaternion()) + twist * 2 + Math.abs(beta - alpha * 0.7) * 0.2;
    };
    if (rotations?.key !== cacheKey) {
      let best: { score: number; alpha: number; beta: number; rotations: Quaternion[] } | undefined;
      const refine = (alphaSeed: number, betaSeed: number) => {
        let alpha = clamp(alphaSeed, minA, maxA), beta = clamp(betaSeed, minB, maxB);
        for (let iteration = 0; iteration < 20; iteration++) {
          const result = evaluate(alpha, beta);
          if (Math.hypot(result.lengthError, result.normalError) < 1e-8) break;
          const epsilon = 1e-4, alongA = evaluate(alpha + epsilon, beta), alongB = evaluate(alpha, beta + epsilon);
          const j00 = (alongA.lengthError - result.lengthError) / epsilon, j01 = (alongB.lengthError - result.lengthError) / epsilon;
          const j10 = (alongA.normalError - result.normalError) / epsilon, j11 = (alongB.normalError - result.normalError) / epsilon;
          const determinant = j00 * j11 - j01 * j10;
          if (Math.abs(determinant) < 1e-12) break;
          const stepA = (-result.lengthError * j11 + result.normalError * j01) / determinant;
          const stepB = (-j00 * result.normalError + j10 * result.lengthError) / determinant;
          const scale = Math.min(1, 0.4 / Math.max(Math.abs(stepA), Math.abs(stepB)));
          alpha = clamp(alpha + stepA * scale, minA, maxA);
          beta = clamp(beta + stepB * scale, minB, maxB);
        }
        const result = evaluate(alpha, beta);
        if (Math.hypot(result.lengthError, result.normalError) > 1e-8) return;
        const opposition = new Quaternion().setFromRotationMatrix(frame(delta, normal).multiply(frame(result.vector, result.normal).transpose()));
        const score = naturalOpposition(opposition, alpha, beta);
        if (score !== null && (!best || score < best.score)) best = { score, alpha, beta, rotations: [opposition, result.proximal, result.distal] };
      };
      // Consecutive frames normally need only a few Newton steps; use the full search only to acquire
      // contact or recover from a target change. Finger lengths, hinge limits and contact tolerances
      // are checked identically for warm and cold starts.
      if (rotations) refine(rotations.alpha, rotations.beta);
      if (!best) for (const alphaSeed of [5, 35, 65, 95]) for (const betaSeed of [0, 30, 60, 90]) {
        refine(alphaSeed * radians, betaSeed * radians);
      }
      // A true side pad can lie parallel to both hinge axes. Its normal invariant is then already
      // satisfied and the two-equation Jacobian loses rank; solve the remaining length equation.
      if (!best) for (const betaSeed of [restB, 15 * radians, 30 * radians, 45 * radians, 60 * radians, 75 * radians, 90 * radians]) {
        const beta = clamp(betaSeed, minB, maxB);
        let previousAlpha = minA, previousError = evaluate(minA, beta).lengthError;
        for (let sample = 1; sample <= 12; sample++) {
          const nextAlpha = minA + (maxA - minA) * sample / 12, nextError = evaluate(nextAlpha, beta).lengthError;
          if (previousError * nextError <= 0) {
            let lo = previousAlpha, hi = nextAlpha, errorLo = previousError;
            for (let iteration = 0; iteration < 25; iteration++) {
              const middle = (lo + hi) / 2, error = evaluate(middle, beta).lengthError;
              if (errorLo * error <= 0) hi = middle;
              else { lo = middle; errorLo = error; }
            }
            refine((lo + hi) / 2, beta);
          }
          previousAlpha = nextAlpha; previousError = nextError;
        }
      }
      if (!best) { this.validContacts = false; return; }
      rotations = { key: cacheKey, alpha: best.alpha, beta: best.beta, rotations: best.rotations };
      this.contactSolutions.set(cacheId, rotations);
    }
    let applied = rotations.rotations;
    if (engagement < 0.999999) {
      const openingKey = modelOpening.toArray().join(",");
      if (rotations.openingKey !== openingKey || !rotations.openRotations) {
        // A released finger has no contact normal to satisfy. Solve its point with the same fixed
        // hinges and choose the MCP rotation nearest the held pose, rather than twisting it in air.
        const openDelta = modelOpening.clone().sub(base), openDistance = openDelta.length();
        let bestOpen: { score: number; rotations: Quaternion[] } | undefined;
        const consider = (alpha: number, beta: number) => {
          const result = evaluate(alpha, beta);
          if (Math.abs(result.vector.length() - openDistance) > 1e-7) return;
          const heldDirection = result.vector.clone().applyQuaternion(rotations!.rotations[0]!).normalize();
          const opposition = new Quaternion().setFromUnitVectors(heldDirection, openDelta.clone().normalize()).multiply(rotations!.rotations[0]!);
          if (naturalOpposition(opposition, alpha, beta) === null) return;
          const score = opposition.angleTo(rotations!.rotations[0]!) * 2 + Math.abs(alpha - rotations!.alpha) + Math.abs(beta - rotations!.beta);
          if (!bestOpen || score < bestOpen.score) bestOpen = { score, rotations: [opposition, result.proximal, result.distal] };
        };
        for (const betaSeed of [rotations.beta, restB, rotations.beta * 0.5, rotations.beta + 15 * radians]) {
          const beta = clamp(betaSeed, minB, maxB);
          let previousAlpha = minA, previousError = evaluate(minA, beta).vector.length() - openDistance;
          for (let sample = 1; sample <= 12; sample++) {
            const nextAlpha = minA + (maxA - minA) * sample / 12;
            const nextError = evaluate(nextAlpha, beta).vector.length() - openDistance;
            if (previousError * nextError <= 0) {
              let lo = previousAlpha, hi = nextAlpha, errorLo = previousError;
              for (let iteration = 0; iteration < 25; iteration++) {
                const middle = (lo + hi) / 2, error = evaluate(middle, beta).vector.length() - openDistance;
                if (errorLo * error <= 0) hi = middle;
                else { lo = middle; errorLo = error; }
              }
              consider((lo + hi) / 2, beta);
            }
            previousAlpha = nextAlpha; previousError = nextError;
          }
        }
        if (!bestOpen) { this.validContacts = false; return; }
        rotations.openingKey = openingKey;
        rotations.openRotations = bestOpen.rotations;
      }
      applied = rotations.rotations.map((rotation, index) => rotation.clone().slerp(rotations!.openRotations![index]!, 1 - clamp(engagement)));
    }
    for (let i = 0; i < 3; i++) controls[i]!.quaternion.copy(applied[i]!).multiply(legacy[i]!.quaternion.clone().invert());
    this.root.updateWorldMatrix(true, true);
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
    for (let step = 0; step < 96; step++) {
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
    if (kind === "handle") return new Vector3();
    const index = this.anchor([this.indexHoldingName, "index_pad_contact", "index_pad", "index_tip"], new Vector3(0, 0, 0.006));
    if (kind === "index") return this.anchor(["index_volar_contact", "index_pad_contact", "index_pad", "index_tip"], index);
    if (kind === "nail") return this.anchor(["index_nail_contact", "index_tip"], index);
    if (kind === "palm") return this.anchor(["palm_contact", "support_contact"], new Vector3(0.105, -0.012, 0));
    const thumb = this.anchor(["thumb_pad_contact", "thumb_pad", "thumb_tip"], new Vector3(0, 0, -0.006));
    return index.add(thumb).multiplyScalar(0.5);
  }

  contactNormal(kind: HandContact): Vector3 {
    const names = kind === "nail" ? ["index_nail_contact"] : kind === "palm" ? ["palm_contact", "support_contact"]
      : kind === "index" ? ["index_volar_contact", "index_pad_contact", "index_pad"] : [this.indexHoldingName, "index_pad_contact", "index_pad"];
    const node = names.map((name) => this.model.getObjectByName(name)).find(Boolean);
    this.root.updateWorldMatrix(true, true);
    if (!node) return new Vector3(0, -1, 0);
    const origin = node.getWorldPosition(new Vector3());
    return node.localToWorld(new Vector3(0, 1, 0)).sub(origin).normalize()
      .transformDirection(new Matrix4().copy(this.root.matrixWorld).invert());
  }

  wrist(): Vector3 { return this.anchor(["wrist"], new Vector3(0.162, 0.004, 0)); }

  /** Actual palm/cuff orientation, independent of the needle-aligned contact frame. */
  wristOrientation(needleOrientation: Quaternion): Quaternion {
    const frame = this.model.getObjectByName("wrist_frame") ?? this.palmFrame;
    if (!frame) return needleOrientation.clone();
    this.root.updateWorldMatrix(true, true);
    const origin = frame.getWorldPosition(new Vector3()), inverse = this.root.matrixWorld.clone().invert();
    const x = frame.localToWorld(new Vector3(1, 0, 0)).sub(origin).transformDirection(inverse);
    const y = frame.localToWorld(new Vector3(0, 1, 0)).sub(origin).transformDirection(inverse);
    y.addScaledVector(x, -x.dot(y)).normalize();
    return needleOrientation.clone().multiply(new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y).normalize())));
  }

  /** World contact used by tests and optional diagnostic overlays. */
  contactAt(kind: HandContact): Vector3 { return this.root.localToWorld(this.contact(kind)); }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    const skeletons = new Set<SkinnedMesh["skeleton"]>();
    this.model.traverse((object) => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
    for (const skeleton of skeletons) skeleton.dispose();
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
