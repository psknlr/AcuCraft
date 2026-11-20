import { AnimationMixer, Group, LoopOnce, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Ray, SkinnedMesh, Triangle, Vector3, type AnimationAction, type AnimationClip, type Object3D } from "three";
import { needleHandleRadiusAt } from "./needle-shape.js";
import { NAIL_WORK_WRIST_BOUNDS, THREE_FINGER_WRIST_BOUNDS, THREE_FINGER_WRIST_DEFAULT } from "@acucraft/core";
import { ORDINARY_THUMB_PULP_ACQUISITION, ORDINARY_TIP_HOLDING_Y_M, PRECISION_THUMB_ENVELOPE_M, RESTING_FINGER_SPREAD_AT_EXTENSION_DEG, SIDE_INDEX_WORKING_POSTURE, SIDE_THUMB_ACQUISITION_M, THREE_FINGER_WORKING_PROFILE, alignNormalAroundAxis, contactFrameAtElevation, fingerPostureReference, handOffProgress, minimumPlanarContactDistance, minimumPlanarContactRetreat, ordinaryTipPosture, restingFingerBaseRotation, restingFingerPosture, smoothPositiveDistance, tipReleasePalmarBlend } from "./hand-physiology.js";
import { createNailWorkRig, sampleNailWork, type NailWorkRig, type NailWorkSample } from "./hand-nail-work.js";
import { createHandSkinCorrectives } from "./hand-skin-correctives.js";

export type HandPose = "pinch" | "tripod" | "palpate" | "press" | "skin-nail" | "stretch" | "scrape" | "flick" | "release";
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
  tipAlong: Vector3;
  sourceNormal: Vector3;
  sourcePoint: Vector3;
  bindAttachment: Matrix4;
  triangles: { triangle: Triangle; normals: [Vector3, Vector3, Vector3] }[];
}

export interface HandMaterialContact {
  surface: string;
  normalField: string;
  definition: Record<string, unknown>;
  engaged?: boolean;
  /** A preparation pad may contact the opposing finger rather than the needle. */
  engagedWith?: string;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const primaryHoldingY = (pose: HandPose) => ["tripod", "scrape", "flick"].includes(pose) ? -0.012 : 0;
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
  private readonly materialBinds = new Map<Object3D, { position: Vector3; quaternion: Quaternion }>();
  private readonly contactSolutions = new Map<string, { key: string; alpha: number; beta: number; rotations: Quaternion[]; openingKey?: string; openRotations?: Quaternion[] }>();
  private validContacts = true;
  private readonly hasAliases: boolean;
  private readonly patches = new Map<string, RollingPatch>();
  private readonly palmFrame: Object3D | undefined;
  private readonly authoredPoseFrame: Object3D | undefined;
  private readonly sourceWristElevation: number;
  private readonly sourceWristDirection: Vector3;
  private readonly sourceWristPosition: Vector3;
  private readonly sourceElevationAxis: Vector3;
  private readonly contactFrameHorizontalBranch: -1 | 1 | undefined;
  private readonly graspWristDirection = new Vector3();
  private readonly sideIndexReference?: ReturnType<typeof fingerPostureReference>;
  private readonly sideIndexFrame?: { point: Vector3; normal: Vector3 };
  private readonly sideThumbPatch?: RollingPatch;
  private readonly ordinaryThumbPatch?: RollingPatch;
  private readonly tripodIndexReference?: ReturnType<typeof fingerPostureReference>;
  private readonly tripodIndexFrame?: { point: Vector3; normal: Vector3 };
  private readonly tripodThumbPatch?: RollingPatch;
  private readonly tripodMiddleContact?: { point: Vector3; orientation: Quaternion };
  private readonly nailWorkRig?: NailWorkRig;
  private readonly skinCorrectives: ReturnType<typeof createHandSkinCorrectives>;
  private nailWorkSample?: NailWorkSample;
  private readonly sourceIndex?: { base: Vector3; a: Vector3; b: Vector3; c: Vector3; palm: Matrix4 };
  private ordinaryIndexReference?: ReturnType<typeof fingerPostureReference>;
  private ordinaryIndexFrame?: { point: Vector3; normal: Vector3 };
  private ordinaryPosture = ordinaryTipPosture(55);
  private poseState?: FingerPose;
  private indexHoldingName = "index_pad_contact";
  private readonly rollingEngagement = new Map<string, number>();
  private readonly materialEngagement = new Map<string, number>();
  private walkingRetreatTransition: { from: { point: Vector3; normal: Vector3 }; to: { point: Vector3; normal: Vector3 }; progress: number } | undefined;

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
    model.traverse((node) => { if (node.name.endsWith("_contact")) this.materialBinds.set(node, { position: node.position.clone(), quaternion: node.quaternion.clone() }); });
    const wrist = this.wrist();
    this.sourceWristPosition = wrist.clone();
    const branch = this.palmFrame?.userData.contactFrameHorizontalBranch;
    this.contactFrameHorizontalBranch = branch === -1 || branch === 1 ? branch : undefined;
    this.sourceWristElevation = Math.atan2(wrist.y, Math.hypot(wrist.x, wrist.z)) * 180 / Math.PI;
    this.sourceWristDirection = wrist.clone().normalize();
    this.graspWristDirection.copy(this.sourceWristDirection);
    const horizontal = new Vector3(wrist.x, 0, wrist.z);
    if (horizontal.lengthSq() < 1e-20) horizontal.set(1, 0, 0);
    this.sourceElevationAxis = horizontal.normalize().cross(new Vector3(0, 1, 0)).normalize();
    for (const [digit, name] of [["thumb", "thumb_pad_contact"], ["index", "index_pad_contact"], ["index", "index_side_contact"]] as const) this.captureRollingPatch(digit, name);
    if (this.contactFrameHorizontalBranch !== undefined) {
      const side = this.patches.get("index_side_contact"), thumb = this.patches.get("thumb_pad_contact");
      const base = this.controls.get("index_MCP"), pip = this.controls.get("index_PIP"), dip = this.controls.get("index_DIP"), tip = model.getObjectByName("index_tip");
      if (base && pip && dip && tip) this.sourceIndex = { base: base.position.clone(), a: pip.position.clone(), b: dip.position.clone(), c: tip.position.clone(), palm: this.palmTransform().clone() };
      if (side && base && pip && dip && tip) {
        this.sideIndexReference = fingerPostureReference(base.position, pip.position, dip.position, tip.position, this.palmTransform(), SIDE_INDEX_WORKING_POSTURE);
        this.sideIndexFrame = {
          point: side.origin.clone().applyMatrix4(this.sideIndexReference.attachment),
          normal: new Vector3(0, 1, 0).applyQuaternion(side.orientation).transformDirection(this.sideIndexReference.attachment),
        };
      }
      if (thumb) {
        const cap = this.projectRollingPatch(thumb, thumb.origin.clone().addScaledVector(thumb.tipAlong, SIDE_THUMB_ACQUISITION_M));
        if (cap) this.sideThumbPatch = { ...thumb, origin: cap.point, orientation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), cap.normal),
          sourcePoint: cap.point.clone().applyMatrix4(thumb.bindAttachment), sourceNormal: cap.normal.clone().transformDirection(thumb.bindAttachment) };
        this.ordinaryThumbPatch = this.acquireThumbPulp(thumb, ORDINARY_THUMB_PULP_ACQUISITION.tipwardM, ORDINARY_THUMB_PULP_ACQUISITION.lateralM);
        this.tripodThumbPatch = this.acquireThumbPulp(thumb, THREE_FINGER_WORKING_PROFILE.thumbAcquisitionM, THREE_FINGER_WORKING_PROFILE.thumbLateralAcquisitionM);
      }
      const pad = this.patches.get("index_pad_contact"), source = this.sourceIndex;
      if (pad && source && this.tripodThumbPatch) {
        this.tripodIndexReference = fingerPostureReference(source.base, source.a, source.b, source.c, source.palm, THREE_FINGER_WORKING_PROFILE.index);
        this.tripodIndexFrame = { point: pad.origin.clone().applyMatrix4(this.tripodIndexReference.attachment), normal: new Vector3(0, 1, 0).applyQuaternion(pad.orientation).transformDirection(this.tripodIndexReference.attachment) };
        this.captureRollingPatch("middle", THREE_FINGER_WORKING_PROFILE.middleContact);
        const middle = this.patches.get(THREE_FINGER_WORKING_PROFILE.middleContact);
        const field = middle && this.projectRollingPatch(middle, middle.origin);
        if (field) this.tripodMiddleContact = { point: field.point, orientation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), field.normal) };
      }
    }
    // Capture actual skin and keratin in the immutable source frame, after the
    // authored pose frame is cleared and before any animation or role is sampled.
    this.nailWorkRig = createNailWorkRig(model);
    this.skinCorrectives = createHandSkinCorrectives(model);
  }

  setSide(side: "left" | "right"): void {
    const mirror = side === "left" ? -1 : 1;
    if (Math.sign(this.model.scale.z) !== mirror) this.mirrorPresentation();
    if (this.model.scale.z === mirror) return;
    this.model.scale.z = mirror;
    this.root.updateWorldMatrix(true, false);
    this.model.updateMatrixWorld(true);
  }

  /** S R S reflection: a general elevation rotation does not commute with the left-hand scale. */
  private mirrorPresentation(): void {
    this.model.position.z *= -1;
    this.model.quaternion.x *= -1;
    this.model.quaternion.y *= -1;
  }

  get contactValid(): boolean { return this.validContacts; }

  /** Standard glTF morph weights, driven by the final anatomical joint rotations. */
  skinCorrectiveWeights(): Record<string, number> { return this.skinCorrectives?.weights() ?? {}; }

  pose(settings: FingerPose): void {
    this.validContacts = true;
    this.skinCorrectives?.reset();
    this.poseState = { ...settings };
    this.materialEngagement.clear();
    this.rollingEngagement.clear();
    this.walkingRetreatTransition = undefined;
    this.nailWorkSample = undefined;
    // Every role starts in the canonical source frame before choosing its actual contacts.
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.indexHoldingName = settings.handleRadiusM !== undefined && ["pinch", "tripod"].includes(settings.pose) && settings.gripStyle === "side-pinch"
      ? "index_side_contact" : "index_pad_contact";
    if (settings.handleRadiusM !== undefined && this.contactFrameHorizontalBranch !== undefined
      && (this.usesOrdinaryReference && !this.ordinaryThumbPatch || settings.pose === "tripod" && !this.tripodThumbPatch)) {
      this.validContacts = false;
      return;
    }
    const grip = clamp(settings.grip), phase = clamp(settings.phase);
    // Legacy nodes carry the Blender clips; zero-offset anatomical parents can add fine articulation.
    this.mixer.stopAllAction();
    const clip = ["press", "stretch", "palpate", "skin-nail"].includes(settings.pose) ? "hand_support"
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
    // A baked clip can contain corrective channels. The operator's final joint
    // solution below supplies the live weights, independently of the last clip.
    this.skinCorrectives?.reset();
    if (this.authoredPoseFrame) { this.authoredPoseFrame.position.set(0, 0, 0); this.authoredPoseFrame.quaternion.identity(); }
    // Material channels in baked clips must not leak from a preceding role into
    // support/no-handle poses. Only contact aliases are restored; no bone is translated.
    for (const [node, bind] of this.materialBinds) { node.position.copy(bind.position); node.quaternion.copy(bind.quaternion); }
    if (this.hasAliases) for (const [node, neutral] of this.neutral) node.quaternion.copy(neutral);
    if (this.palmFrame && settings.pose === "tripod" && settings.gripStyle === "side-pinch") {
      this.validContacts = false;
      return;
    }
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
      if (this.nailWorkRig && (settings.pose === "scrape" || settings.pose === "flick")) {
        this.applyNailWork({ ...settings, pose: settings.pose });
        this.relaxUnusedFingers(settings);
      } else {
        this.orientPalm(settings);
        this.relaxUnusedFingers(settings);
        this.rollHoldingSurfaces(settings);
        this.accommodateRollingContact(settings);
        this.solveHandleContacts(settings);
      }
    }
    else {
      if (["palpate", "press", "stretch", "skin-nail"].includes(settings.pose)) {
        if (this.palmFrame || settings.pose === "skin-nail") this.relaxSurfaceFingers(settings);
        this.relaxSurfaceThumb();
      }
      if (settings.pose === "skin-nail") {
        // The nail works on the skin while the remaining long fingers rest clear of it.
        this.relaxUnusedFingers({ ...settings, idleFingerPose: "relaxed" });
        if (aperture > 0 && grip < 1) this.solveAperture(this.gapMm() / 1000 + aperture * (1 - grip), true);
      }
      if (settings.pose === "pinch" || settings.pose === "tripod" || settings.pose === "scrape") this.solveAperture(aperture);
    }
    // All joint solutions use the same canonical source frame. Reflect the complete final
    // presentation so a left hand preserves the source azimuth and actual wrist elevation.
    if (this.model.scale.z < 0) this.mirrorPresentation();
    this.skinCorrectives?.apply();
    this.model.updateMatrixWorld(true);
  }

  /** Single-hand nail work uses its real tail/skin/keratin roles, independently of pad pinching. */
  private applyNailWork(settings: FingerPose & { pose: "scrape" | "flick" }): void {
    const sample = this.nailWorkRig && sampleNailWork(this.nailWorkRig, settings);
    if (!sample) { this.validContacts = false; return; }
    const materials = Object.entries(sample.contacts).map(([name, material]) => ({ node: this.model.getObjectByName(name), material }));
    if (materials.some(({ node, material }) => !node || node.parent?.name !== material.parent)) { this.validContacts = false; return; }
    this.nailWorkSample = sample;
    this.validContacts &&= sample.valid;
    this.model.position.copy(sample.modelPosition);
    this.model.quaternion.copy(sample.modelQuaternion);
    for (const [digit, labels, rotations] of [["thumb", ["CMC", "MCP", "IP"], sample.thumbRotations], ["index", ["MCP", "PIP", "DIP"], sample.indexRotations]] as const) {
      for (let i = 0; i < 3; i++) {
        const control = this.controls.get(`${digit}_${labels[i]}`), legacy = this.model.getObjectByName(`${digit}_${["proximal", "middle", "distal"][i]}`);
        if (!control || !legacy) { this.validContacts = false; continue; }
        control.quaternion.copy(rotations[i]!).multiply(legacy.quaternion.clone().invert());
      }
    }
    for (const { node, material } of materials) {
      node!.position.copy(material.point);
      node!.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), material.normal);
      this.materialEngagement.set(node!.name, material.engaged ? 1 : 0);
    }
  }

  /** Keep the needle frame canonical while raising the actual palm around the holding contact line. */
  private orientPalm(settings: FingerPose): void {
    if (!this.palmFrame) return;
    const nailWork = settings.pose === "scrape" || settings.pose === "flick";
    const bounds = nailWork ? NAIL_WORK_WRIST_BOUNDS : settings.pose === "tripod" ? THREE_FINGER_WRIST_BOUNDS : { min: 35, max: 70 };
    const elevation = clamp(settings.wristElevationDeg ?? (settings.pose === "tripod" ? THREE_FINGER_WRIST_DEFAULT : 55), bounds.min, bounds.max);
    const patch = this.patches.get(this.indexHoldingName);
    const pivot = new Vector3(0, this.holdingY(settings.pose), 0);
    if (this.contactFrameHorizontalBranch !== undefined && patch) {
      if (this.usesOrdinaryReference && this.sourceIndex) {
        const source = this.sourceIndex;
        this.ordinaryPosture = ordinaryTipPosture(elevation);
        this.ordinaryIndexReference = fingerPostureReference(source.base, source.a, source.b, source.c, source.palm, this.ordinaryPosture);
        this.ordinaryIndexFrame = { point: patch.origin.clone().applyMatrix4(this.ordinaryIndexReference.attachment), normal: new Vector3(0, 1, 0).applyQuaternion(patch.orientation).transformDirection(this.ordinaryIndexReference.attachment) };
      }
      const reference = this.indexHoldingName === "index_side_contact" ? this.sideIndexFrame : settings.pose === "tripod" ? this.tripodIndexFrame : this.usesOrdinaryReference ? this.ordinaryIndexFrame : undefined;
      this.applyContactFrame(settings, reference?.point ?? patch.sourcePoint, reference?.normal ?? patch.sourceNormal, elevation);
      return;
    }
    this.graspWristDirection.copy(this.sourceWristDirection);
    const elevationRotation = new Quaternion().setFromAxisAngle(this.sourceElevationAxis, (elevation - this.sourceWristElevation) * Math.PI / 180);
    const sourceNormal = this.patches.get(this.indexHoldingName)?.sourceNormal;
    const targetNormal = new Vector3(0, 0, -1).applyQuaternion(elevationRotation.clone().invert());
    this.model.quaternion.copy(elevationRotation);
    if (sourceNormal) this.model.quaternion.multiply(alignNormalAroundAxis(sourceNormal, targetNormal, this.sourceWristDirection));
    // The reference bind holds at its own origin. Move that complete grasp to the selected handle
    // segment, then elevate about that contact line rather than stretching the fingers down to it.
    this.model.position.copy(pivot);
    if (this.indexHoldingName === "index_side_contact") this.model.position.addScaledVector(this.sourceWristDirection.clone().applyQuaternion(this.model.quaternion), -0.006);
    this.model.position.y -= (this.indexHoldingName === "index_side_contact" ? 0.00035 : 0.00065) * Math.tanh(clamp(settings.axialDisplacementMm ?? 0, -3, 3));
  }

  private applyContactFrame(settings: FingerPose, sourcePoint: Vector3, sourceNormal: Vector3, elevation: number): void {
    const pivot = new Vector3(0, this.holdingY(settings.pose), 0);
    const radius = pivot.y ? needleHandleRadiusAt(pivot.y) : clamp(settings.handleRadiusM ?? 0.0007, 0.0001, 0.002);
    const origin = sourcePoint.clone().addScaledVector(sourceNormal, radius);
    const frame = contactFrameAtElevation(origin, sourceNormal, this.sourceWristPosition, elevation, this.contactFrameHorizontalBranch!);
    if (!frame) { this.validContacts = false; return; }
    this.model.quaternion.copy(frame.rotation);
    this.model.position.copy(frame.position).add(pivot);
    this.graspWristDirection.copy(frame.wristDirection);
    // ProcedureController moves the complete hand with the actual handle.point during
    // lifting/thrusting. This anatomically refitted grip keeps that handle contact fixed;
    // an additional internal Y shift would stretch the nearly extended thumb twice.
  }

  /** A small wrist accommodation keeps circumferential rolling inside the real IP workspace. */
  private accommodateRollingContact(settings: FingerPose): void {
    if (!this.palmFrame || settings.pose !== "pinch" || (this.indexHoldingName !== "index_pad_contact" && this.contactFrameHorizontalBranch === undefined)) return;
    if (this.contactFrameHorizontalBranch !== undefined && this.indexHoldingName === "index_side_contact") {
      const patch = this.patches.get(this.indexHoldingName);
      if (patch) {
        // A lateral pulp normal is nearly parallel to the IP hinges. Let a small palm roll
        // accompany material migration, instead of demanding impossible hinge compensation.
        // Reconstruct it only through the immutable bind attachment: posed world transforms
        // would make seeking or switching styles change the next request's source frame.
        const attachment = this.sideIndexReference?.attachment ?? patch.bindAttachment;
        const point = patch.anchor.position.clone().applyMatrix4(attachment);
        const normal = new Vector3(0, 1, 0).applyQuaternion(patch.anchor.quaternion).transformDirection(attachment);
        this.applyContactFrame(settings, point, normal, clamp(settings.wristElevationDeg ?? 55, 35, 70));
      }
      // This complete frame already supplies a known, valid IP posture for the exact
      // material point/normal. A separate singular-workspace reserve would reject it.
      return;
    }
    const mcp = this.controls.get("index_MCP"), pip = this.controls.get("index_PIP"), dip = this.controls.get("index_DIP");
    const anchor = this.model.getObjectByName(this.indexHoldingName), tip = this.model.getObjectByName("index_tip");
    if (!mcp || !pip || !dip || !anchor || !tip) return;
    const hinge = pip.position.clone().cross(dip.position).normalize(), distalHinge = dip.position.clone().cross(tip.position).normalize();
    if (Math.abs(hinge.dot(distalHinge)) < 0.99999) return;
    const y = this.holdingY(settings.pose) - this.sideStagger;
    const radius = y ? needleHandleRadiusAt(y) : clamp(settings.handleRadiusM ?? 0.0007, 0.0001, 0.002);
    const inverse = this.model.quaternion.clone().invert();
    const delta = new Vector3(0, y, radius).sub(this.model.position).applyQuaternion(inverse).sub(mcp.position);
    const normal = new Vector3(0, 0, -1).applyQuaternion(inverse);
    // Keep 0.25 mm away from the singular workspace edge. The C2 onset avoids a palm jump
    // when the moving skin normal first requires a longer reach.
    const distance = delta.length();
    const retreatFor = (point: Vector3, surfaceNormal: Vector3) => {
      const sourceContact = pip.position.clone().add(dip.position).add(point);
      const sourceNormal = surfaceNormal.clone().normalize(), alongNormal = sourceNormal.dot(hinge);
      const transverseNormalSquared = Math.max(0, 1 - alongNormal * alongNormal);
      const minimum = minimumPlanarContactDistance(hinge, sourceContact, sourceNormal, delta.dot(normal));
      let squaredClearance = 0;
      if (transverseNormalSquared > 1e-10 && Number.isFinite(minimum)) {
        const extra = smoothPositiveDistance(minimum + 0.00025 - distance);
        if (extra < 1e-12) return 0;
        const target = distance + extra;
        // This is exactly the previous distance margin for a wrist orthogonal to the
        // contact normal; the general quadratic also accounts for a changing target dot.
        squaredClearance = transverseNormalSquared * Math.max(0, target * target - minimum * minimum);
      }
      return minimumPlanarContactRetreat({ displacement: delta, direction: this.graspWristDirection, targetNormal: normal,
        hinge, contactVector: sourceContact, contactNormal: sourceNormal, squaredClearance, maximum: 0.003 });
    };
    const transition = this.walkingRetreatTransition;
    // An airborne pad has no bearing normal. Move smoothly between the two endpoint
    // accommodations while its real material point resets, rather than chasing that normal.
    const retreat = transition
      ? retreatFor(transition.from.point, transition.from.normal) * (1 - transition.progress) + retreatFor(transition.to.point, transition.to.normal) * transition.progress
      : retreatFor(anchor.position, new Vector3(0, 1, 0).applyQuaternion(anchor.quaternion));
    if (!Number.isFinite(retreat) || retreat > 0.003) { this.validContacts = false; return; }
    this.model.position.addScaledVector(this.graspWristDirection.clone().applyQuaternion(this.model.quaternion), Math.max(0, retreat));
  }

  private get sideStagger(): number {
    return this.palmFrame && this.indexHoldingName === "index_side_contact" && this.contactFrameHorizontalBranch === undefined ? 0.00025 : 0;
  }

  private holdingY(pose: HandPose): number {
    if (this.usesOrdinaryReference && (pose === "pinch" || pose === "release")) return ORDINARY_TIP_HOLDING_Y_M;
    return this.contactFrameHorizontalBranch !== undefined && pose === "tripod" && this.tripodIndexReference ? THREE_FINGER_WORKING_PROFILE.primaryY : primaryHoldingY(pose);
  }

  private get usesOrdinaryReference(): boolean {
    return this.contactFrameHorizontalBranch !== undefined && this.indexHoldingName === "index_pad_contact" && (this.poseState?.pose === "pinch" || this.poseState?.pose === "release");
  }

  private get activeIndexReference(): ReturnType<typeof fingerPostureReference> | undefined {
    return this.indexHoldingName === "index_side_contact" ? this.sideIndexReference : this.poseState?.pose === "tripod" ? this.tripodIndexReference : this.usesOrdinaryReference ? this.ordinaryIndexReference : undefined;
  }

  private holdingPatch(name: string): RollingPatch | undefined {
    if (name === "thumb_pad_contact") {
      if (this.indexHoldingName === "index_side_contact") return this.sideThumbPatch ?? this.patches.get(name);
      if (this.poseState?.pose === "tripod") return this.tripodThumbPatch ?? this.patches.get(name);
      if (this.usesOrdinaryReference) return this.ordinaryThumbPatch ?? this.patches.get(name);
    }
    return this.patches.get(name);
  }

  /** Acquire actual volar skin, including its oblique normal, rather than rotating a flat contact into place. */
  private acquireThumbPulp(patch: RollingPatch, tipwardM: number, lateralM: number): RollingPatch | undefined {
    const volar = new Vector3(0, 1, 0).applyQuaternion(patch.orientation);
    const lateral = volar.clone().cross(patch.tipAlong).normalize();
    const field = this.rayProjectRollingPatch(patch, patch.origin.clone().addScaledVector(patch.tipAlong, tipwardM).addScaledVector(lateral, lateralM));
    // Stay on the fleshy volar half. Neither the dorsal nail side nor an almost axial tip is a substitute pulp.
    if (!field || field.normal.dot(volar) < 0.5) return undefined;
    return { ...patch, origin: field.point, orientation: new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), field.normal),
      sourcePoint: field.point.clone().applyMatrix4(patch.bindAttachment), sourceNormal: field.normal.clone().transformDirection(patch.bindAttachment) };
  }

  /** Project onto actual terminal triangles and the same normal field exported by Blender. */
  private projectRollingPatch(patch: RollingPatch, target: Vector3) {
    const closest = new Vector3(), barycentric = new Vector3(), normal = new Vector3();
    let best: { point: Vector3; normal: Vector3; distance: number } | undefined;
    for (const surface of patch.triangles) {
      surface.triangle.closestPointToPoint(target, closest);
      const error = closest.distanceToSquared(target);
      if (best && error >= best.distance) continue;
      surface.triangle.getBarycoord(closest, barycentric);
      normal.copy(surface.normals[0]).multiplyScalar(barycentric.x).addScaledVector(surface.normals[1], barycentric.y).addScaledVector(surface.normals[2], barycentric.z).normalize();
      best = { point: closest.clone(), normal: normal.clone(), distance: error };
    }
    return best;
  }

  /** A front-pulp acquisition uses the real outward ray, rather than a different closest flank. */
  private rayProjectRollingPatch(patch: RollingPatch, target: Vector3) {
    const direction = new Vector3(0, 1, 0).applyQuaternion(patch.orientation);
    const ray = new Ray(target.clone().addScaledVector(direction, 0.02), direction.clone().negate());
    const hit = new Vector3(), barycentric = new Vector3();
    let best: { point: Vector3; normal: Vector3; distance: number } | undefined;
    for (const surface of patch.triangles) {
      if (!ray.intersectTriangle(surface.triangle.a, surface.triangle.b, surface.triangle.c, false, hit)) continue;
      const distance = hit.distanceToSquared(ray.origin);
      if (best && distance >= best.distance) continue;
      surface.triangle.getBarycoord(hit, barycentric);
      const normal = surface.normals[0].clone().multiplyScalar(barycentric.x).addScaledVector(surface.normals[1], barycentric.y).addScaledVector(surface.normals[2], barycentric.z).normalize();
      best = { point: hit.clone(), normal, distance };
    }
    return best;
  }

  /** Real terminal skin triangles, expressed in the distal attachment's frame at bind pose. */
  private captureRollingPatch(digit: "thumb" | "index" | "middle", name: string): void {
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
    const before = this.model.getObjectByName(`${digit}_pad_roll_m3_contact`), after = this.model.getObjectByName(`${digit}_pad_roll_p3_contact`);
    const inverseAttachment = anchor.parent.matrixWorld.clone().invert();
    // Authored material samples follow skin-normal × needle-axis around the shaft.
    // This circumferential direction is independent of the distal phalanx's long axis.
    const along = before && after
      ? after.getWorldPosition(new Vector3()).sub(before.getWorldPosition(new Vector3())).transformDirection(inverseAttachment)
      : new Vector3(0, 1, 0).transformDirection(anchor.matrixWorld)
        .cross(new Vector3(0, 1, 0).transformDirection(this.root.matrixWorld)).transformDirection(inverseAttachment);
    const surfaceNormal = new Vector3(0, 1, 0).applyQuaternion(anchor.quaternion);
    const sourceNormal = new Vector3(0, 1, 0).transformDirection(anchor.matrixWorld).transformDirection(this.model.matrixWorld.clone().invert());
    const sourcePoint = anchor.getWorldPosition(new Vector3()).applyMatrix4(this.model.matrixWorld.clone().invert());
    const bindAttachment = this.model.matrixWorld.clone().invert().multiply(anchor.parent.matrixWorld);
    const tipAlong = this.model.getObjectByName(`${digit}_tip`)!.position.clone();
    tipAlong.addScaledVector(surfaceNormal, -tipAlong.dot(surfaceNormal)).normalize();
    this.patches.set(name, { anchor, origin: anchor.position.clone(), orientation: anchor.quaternion.clone(), along, tipAlong, sourceNormal, sourcePoint, bindAttachment, triangles });
  }

  /** Contact material migrates over real pulp while the distal hinges roll the needle. */
  private rollHoldingSurfaces(settings: FingerPose): void {
    // Reflection reverses axial rotation handedness. Keep the same physical needle
    // turn by reversing the left hand's canonical material roll before SRS mirroring.
    const handedness = this.contactFrameHorizontalBranch !== undefined && this.model.scale.z < 0 ? -1 : 1;
    const rotation = (Number.isFinite(settings.rotationRad) ? settings.rotationRad! : 0) * handedness;
    const sideGrip = this.indexHoldingName === "index_side_contact";
    // One-way turns repeat the same short bite with staggered release and acquisition.
    const travel = 0.00015;
    const bounded = this.palmFrame ? travel * Math.tanh(rotation / 1.2) * clamp(settings.grip) : 0;
    this.rollingEngagement.clear();
    this.walkingRetreatTransition = undefined;
    for (const patch of this.patches.values()) {
      patch.anchor.position.copy(patch.origin); patch.anchor.quaternion.copy(patch.orientation);
    }
    const thumb = this.holdingPatch("thumb_pad_contact");
    if (thumb) { thumb.anchor.position.copy(thumb.origin); thumb.anchor.quaternion.copy(thumb.orientation); }
    const materialTangents = new Map<string, Vector3>();
    if (this.contactFrameHorizontalBranch !== undefined) {
      // Capture the tangent in the actually opposed distal frame. The bind marker's
      // circumferential direction can become axial after the palm changes azimuth.
      const y = this.holdingY(settings.pose), stagger = this.sideStagger;
      for (const [digit, name, sign, contactY, kind] of [["thumb", "thumb_pad_contact", -1, y + stagger, "pad"],
        ["index", this.indexHoldingName, 1, y - stagger, sideGrip ? "side" : "pad"]] as const) {
        const patch = this.holdingPatch(name);
        if (!patch?.anchor.parent) continue;
        const radius = contactY ? needleHandleRadiusAt(contactY) : clamp(settings.handleRadiusM ?? 0.0007, 0.0001, 0.002);
        const target = new Vector3(0, contactY, sign * radius), outward = new Vector3(0, 0, -sign);
        this.solveFingerContact(digit, kind, target, outward, 1, target);
        this.model.updateWorldMatrix(true, true);
        const attachment = this.model.matrixWorld.clone().invert().multiply(patch.anchor.parent.matrixWorld);
        const tangent = outward.cross(new Vector3(0, 1, 0)).applyQuaternion(this.model.quaternion.clone().invert()).transformDirection(attachment.invert());
        const surfaceNormal = new Vector3(0, 1, 0).applyQuaternion(patch.orientation);
        tangent.addScaledVector(surfaceNormal, -tangent.dot(surfaceNormal)).normalize();
        materialTangents.set(name, tangent);
      }
    }
    const smooth = (value: number) => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };
    const cycles = Math.abs(rotation) / 2.4, warm = smooth(cycles), direction = Math.sign(rotation) || 1;
    for (const [name] of this.patches) {
      const patch = this.holdingPatch(name)!;
      patch.anchor.position.copy(patch.origin); patch.anchor.quaternion.copy(patch.orientation);
      if (name !== "thumb_pad_contact" && name !== this.indexHoldingName) continue;
      let distance = bounded;
      if (this.palmFrame && settings.continuousRoll) {
        const phase = (cycles + (name === "thumb_pad_contact" ? 0 : 0.5)) % 1;
        const material = phase < 0.52 ? -1 + 2 * handOffProgress(phase / 0.52) : phase < 0.67 ? 1 : phase < 0.85 ? 1 - 2 * handOffProgress((phase - 0.67) / 0.18) : -1;
        // Each finger is fully engaged for more than half the cycle. Its counterpart
        // supplies support while the released finger returns through a relaxed pose.
        const engagement = phase < 0.52 ? 1 : phase < 0.67 ? 1 - handOffProgress((phase - 0.52) / 0.15) : phase < 0.85 ? 0 : handOffProgress((phase - 0.85) / 0.15);
        distance = travel * material * direction * warm * clamp(settings.grip);
        this.rollingEngagement.set(name, 1 - warm * (1 - engagement));
      }
      // Acquiring the fleshy tip and rolling around the needle are independent directions.
      // The corrected thumb's distal axis differs from its circumferential material tangent.
      const tipSettle = this.palmFrame && this.contactFrameHorizontalBranch === undefined && name === "thumb_pad_contact"
        ? (sideGrip ? 1 : smooth(Math.abs(rotation) / 0.3)) * 0.00065 * clamp(settings.grip) : 0;
      const acquireWalkingReach = !!settings.continuousRoll && name === "index_pad_contact" && !sideGrip;
      if (Math.abs(distance) < 1e-9 && tipSettle < 1e-9 && !acquireWalkingReach) continue;
      const along = materialTangents.get(name) ?? patch.along;
      const target = patch.origin.clone().addScaledVector(along, -distance).addScaledVector(patch.tipAlong, tipSettle);
      const best = this.projectRollingPatch(patch, target);
      if (best) {
        patch.anchor.position.copy(best.point);
        patch.anchor.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), best.normal);
        if (acquireWalkingReach) {
          const phase = (cycles + 0.5) % 1;
          if (warm >= 0.999999 && phase >= 0.67 && phase < 0.85) {
            const amplitude = travel * warm * clamp(settings.grip) * direction;
            const from = this.projectRollingPatch(patch, patch.origin.clone().addScaledVector(along, -amplitude));
            const to = this.projectRollingPatch(patch, patch.origin.clone().addScaledVector(along, amplitude));
            if (from && to) this.walkingRetreatTransition = { from, to, progress: handOffProgress((phase - 0.67) / 0.18) };
          }
        }
      }
    }
  }

  /** Unused fingers fold toward the palm in the selected closed or relaxed idle posture. */
  private relaxUnusedFingers(settings: FingerPose): void {
    const palm = this.palmFrame ? this.palmTransform() : new Matrix4();
    for (const digit of ["middle", "ring", "little"] as const) {
      if (digit === "middle" && (settings.pose === "tripod" || !this.nailWorkSample && ["scrape", "flick"].includes(settings.pose))) continue;
      const joints = ["MCP", "PIP", "DIP"].map((joint) => this.controls.get(`${digit}_${joint}`));
      const legacy = ["proximal", "middle", "distal"].map((joint) => this.model.getObjectByName(`${digit}_${joint}`));
      const tip = this.model.getObjectByName(`${digit}_tip`);
      if (!tip || joints.some((joint) => !joint) || legacy.some((joint) => !joint)) continue;
      const a = joints[1]!.position, b = joints[2]!.position, c = tip.position;
      const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
      if (hingeB.dot(hingeA) < 0) hingeB.negate();
      const signed = (x: Vector3, y: Vector3, hinge: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
      const restA = signed(a, b, hingeA), restB = signed(b, c, hingeB);
      const posture = restingFingerPosture(digit, settings.idleFingerPose === "relaxed" ? "relaxed" : "curled");
      const angles = this.palmFrame ? [posture.mcpDeg, posture.pipDeg, posture.dipDeg] : [80, 90, 65];
      const flexion = angles[0]! * Math.PI / 180;
      const direction = new Vector3(-Math.cos(flexion), -Math.sin(flexion), 0).transformDirection(palm);
      const relaxed = this.palmFrame
        ? restingFingerBaseRotation(a, hingeA, palm, posture.mcpDeg, posture.ulnarSpreadDeg)
        : new Quaternion().setFromUnitVectors(a.clone().normalize(), direction);
      if (!this.palmFrame && digit === "middle") relaxed.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 5 * Math.PI / 180));
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
    const roundedVolarTip = this.model.getObjectByName("index_volar_contact")?.userData.feature === "true-volar-distal-tip";
    const nail = settings.pose === "skin-nail";
    for (const digit of ["index", "middle", "ring", "little"] as const) {
      if (nail && digit !== "index") continue;
      const joints = ["MCP", "PIP", "DIP"].map((label) => this.controls.get(`${digit}_${label}`));
      const legacy = ["proximal", "middle", "distal"].map((label) => this.model.getObjectByName(`${digit}_${label}`));
      const tip = this.model.getObjectByName(`${digit}_tip`);
      if (!tip || joints.some((joint) => !joint) || legacy.some((joint) => !joint)) continue;
      const a = joints[1]!.position, b = joints[2]!.position, c = tip.position;
      const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
      if (hingeB.dot(hingeA) < 0) hingeB.negate();
      const signed = (x: Vector3, y: Vector3, hinge: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
      if (roundedVolarTip || nail) {
        // Palpation uses the rounded forward pulp, with a lightly flexed index.
        // Keep the other fingers above that contact instead of retaining the
        // source needle-grasp C or rotating the entire palm through the skin.
        const ordinal = digit === "index" ? -1 : ["middle", "ring", "little"].indexOf(digit);
        const pressing = settings.pose === "press";
        let mcpDeg: number, pipDeg: number, dipDeg: number;
        if (nail) {
          // A bent index presents the distal edge of the nail while the palm stays above the skin.
          const contact = clamp(settings.nailContact ?? 0);
          mcpDeg = 14 + 4 * contact; pipDeg = 43 + 5 * contact; dipDeg = 36 + 6 * contact;
        } else {
          mcpDeg = pressing ? 0 : digit === "index" ? 5 : [-10, -7, -4][ordinal]!;
          pipDeg = (digit === "index" ? pressing ? 5 : 10 : [5, 7, 9][ordinal]!) + pulse * 0.5;
          dipDeg = pressing ? 0 : 5;
        }
        const spreadDeg = digit === "index" ? settings.pose === "stretch" ? -5 * clamp(settings.grip) : 0
          : RESTING_FINGER_SPREAD_AT_EXTENSION_DEG[digit] * (0.2 + 0.8 * Math.cos(mcpDeg * Math.PI / 180) ** 2);
        const rotations = [restingFingerBaseRotation(a, hingeA, palm, mcpDeg, spreadDeg),
          new Quaternion().setFromAxisAngle(hingeA, pipDeg * Math.PI / 180 - signed(a, b, hingeA)),
          new Quaternion().setFromAxisAngle(hingeB, dipDeg * Math.PI / 180 - signed(b, c, hingeB))];
        for (let i = 0; i < 3; i++) joints[i]!.quaternion.copy(rotations[i]!).multiply(legacy[i]!.quaternion.clone().invert());
        continue;
      }
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

  /** Fold the supporting thumb clear of the contact plane and the extended supporting fingers. */
  private relaxSurfaceThumb(): void {
    const cmc = this.controls.get("thumb_CMC"), mcp = this.controls.get("thumb_MCP"), ip = this.controls.get("thumb_IP");
    const proximal = this.model.getObjectByName("thumb_proximal"), middle = this.model.getObjectByName("thumb_middle"), distal = this.model.getObjectByName("thumb_distal"), tip = this.model.getObjectByName("thumb_tip");
    if (!cmc || !mcp || !ip || !proximal || !middle || !distal || !tip) return;
    const a = mcp.position, b = ip.position, c = tip.position;
    const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
    if (hingeB.dot(hingeA) < 0) hingeB.negate();
    const restA = Math.atan2(a.clone().cross(b).dot(hingeA), a.dot(b));
    const restB = Math.atan2(b.clone().cross(c).dot(hingeB), b.dot(c));
    if (this.model.getObjectByName("index_volar_contact")?.userData.feature === "true-volar-distal-tip") {
      // The corrected source opposition is already suitable for a relaxed
      // supporting thumb; preserve its CMC frame and gently flex its hinges.
      cmc.quaternion.copy(proximal.quaternion).invert();
      mcp.quaternion.setFromAxisAngle(hingeA, 20 * Math.PI / 180 - restA).multiply(middle.quaternion.clone().invert());
      ip.quaternion.setFromAxisAngle(hingeB, 20 * Math.PI / 180 - restB).multiply(distal.quaternion.clone().invert());
      return;
    }
    if (this.palmFrame) {
      // Palmar CMC motion separates the thumb from the straight middle/ring
      // proximal segments; flexing its own hinges brings the pulp back above
      // the supporting surface. These authored angles preserve every bone
      // length and do not change the index/heel contact or the patient's target.
      const radial = new Vector3(0, 0, 1).transformDirection(this.palmTransform());
      cmc.quaternion.setFromAxisAngle(radial, 20 * Math.PI / 180).multiply(proximal.quaternion.clone().invert());
      mcp.quaternion.setFromAxisAngle(hingeA, 55 * Math.PI / 180 - restA).multiply(middle.quaternion.clone().invert());
      ip.quaternion.setFromAxisAngle(hingeB, 55 * Math.PI / 180 - restB).multiply(distal.quaternion.clone().invert());
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
    const holdingY = this.holdingY(settings.pose);
    const holdingRadius = holdingY ? needleHandleRadiusAt(holdingY) : radius;
    const holdingOpening = Math.max(holdingRadius + 0.0015, clamp(settings.apertureMm ?? 2, 0, 12) / 2000);
    const thumbRadial = radial.clone().negate();
    // A side grip bears on a longer section of the index. Its two real contact centres are gently
    // staggered along the handle, leaving room for the rounded thumb rather than intersecting skin.
    const sideStagger = this.sideStagger;
    for (const [digit, direction, y, kind] of [["thumb", thumbRadial, holdingY + sideStagger, "pad"],
      ["index", radial, holdingY - sideStagger, this.indexHoldingName === "index_side_contact" ? "side" : "pad"]] as const) {
      const contactRadius = y === 0 ? radius : needleHandleRadiusAt(y);
      const openingDistance = settings.continuousRoll && grip >= 0.999999 ? contactRadius + 0.0006 : holdingOpening;
      const target = direction.clone().multiplyScalar(contactRadius).setY(y);
      let open = direction.clone().multiplyScalar(openingDistance).setY(y);
      if (digit === "thumb" && this.usesOrdinaryReference) {
        const blend = tipReleasePalmarBlend(openingDistance - contactRadius, this.ordinaryPosture.mcpDeg);
        const palmar = new Vector3(0, -1, 0).transformDirection(this.sourceIndex!.palm).applyQuaternion(this.model.quaternion);
        // Preserve the requested two-pad gap while opening outward from the palm.
        // The small walking release has zero extra palmar excursion.
        const separation = direction.clone().addScaledVector(palmar, blend).normalize();
        open = new Vector3(0, y, openingDistance).addScaledVector(separation, 2 * openingDistance);
      }
      // The true lateral grip keeps its opposed CMC reference while airborne. Returning
      // to the tip-grip source opposition would sweep the thumb through the index/handle.
      const independentOpening = !!settings.continuousRoll && !this.activeIndexReference;
      this.solveFingerContact(digit, kind, target, direction.clone().negate(), grip * (this.rollingEngagement.get(digit === "thumb" ? "thumb_pad_contact" : this.indexHoldingName) ?? 1), open, independentOpening);
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
      const refitted = this.contactFrameHorizontalBranch !== undefined && this.tripodMiddleContact && this.tripodIndexReference;
      const middleY = refitted ? THREE_FINGER_WORKING_PROFILE.middleY : this.palmFrame ? 0.010 : 0.006, middleRadius = needleHandleRadiusAt(middleY);
      const base = this.controls.get("middle_MCP")!.position.clone().applyQuaternion(this.model.quaternion).add(this.model.position);
      const side = this.model.getObjectByName("middle_side_contact")!;
      if (refitted) { side.position.copy(this.tripodMiddleContact!.point); side.quaternion.copy(this.tripodMiddleContact!.orientation); }
      // Reference support uses an authored oblique pulp route. Legacy lateral patches retain their
      // analytical normal/hinge relation instead of rotating a finger or moving its surface marker.
      const phi = refitted ? THREE_FINGER_WORKING_PROFILE.middleAzimuthRad : this.palmFrame ? -Math.PI / 3 : Math.atan2(base.z, base.x) + Math.acos(clamp((middleRadius - side.position.z) / Math.hypot(base.x, base.z), -1, 1));
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
  private solveFingerContact(digit: "thumb" | "index" | "middle", kind: "pad" | "nail" | "nail_edge" | "side", target: Vector3, outward: Vector3, engagement: number, openingTarget: Vector3, independentOpening = false): void {
    this.materialEngagement.set(`${digit}_${kind}_contact`, clamp(engagement));
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
    const inverseAnatomicalPalm = digit === "thumb" && this.activeIndexReference && this.indexHoldingName !== "index_side_contact"
      ? this.palmTransform().clone().invert() : undefined;
    const cmcInPalm = inverseAnatomicalPalm && base.clone().applyMatrix4(inverseAnatomicalPalm);
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
      const refittedPrecision = !!this.activeIndexReference && this.indexHoldingName !== "index_side_contact";
      const maximumTwist = refittedPrecision ? digit === "thumb" ? 30 : 20
        : digit === "thumb" ? 100 : 40;
      if (twist > maximumTwist * radians) return null;
      if (opposition.angleTo(new Quaternion()) > (digit === "thumb" ? 120 : 100) * radians) return null;
      if (digit === "thumb" && inverseAnatomicalPalm && cmcInPalm) {
        const mcp = base.clone().add(a.clone().applyQuaternion(opposition)).applyMatrix4(inverseAnatomicalPalm);
        // Exact pad fitting alone can put the thumb knuckle behind the palm. Keep its real bone on the
        // authored volar/radial route; no joint translation, bone scaling or reversed IP hinge repairs it.
        if (mcp.y > PRECISION_THUMB_ENVELOPE_M.maximumMcpDorsal
          || mcp.z - cmcInPalm.z < PRECISION_THUMB_ENVELOPE_M.minimumRadialFromCmc) return null;
      }
      if (digit !== "thumb") {
        const result = evaluate(alpha, beta);
        const first = a.clone().applyQuaternion(opposition).normalize();
        const second = b.clone().applyQuaternion(result.proximal).applyQuaternion(opposition).normalize();
        const third = c.clone().applyQuaternion(result.distal).applyQuaternion(result.proximal).applyQuaternion(opposition).normalize();
        // At 90° MCP flexion the proximal bone is parallel to the palmar direction,
        // so palmUp × first cannot recover a joint axis. Use the actual transported
        // hinges of the refitted rig; retain the older asset's presentation convention.
        const pipHinge = this.contactFrameHorizontalBranch !== undefined ? hingeA.clone().applyQuaternion(opposition) : palmUp.clone().cross(first).normalize();
        const dipHinge = this.contactFrameHorizontalBranch !== undefined ? hingeB.clone().applyQuaternion(result.proximal).applyQuaternion(opposition) : pipHinge;
        const signed = (x: Vector3, y: Vector3, hinge: Vector3) => Math.atan2(x.clone().cross(y).dot(hinge), x.dot(y));
        const pip = signed(first, second, pipHinge), dip = signed(second, third, dipHinge);
        if (pip < -5 * radians || dip < -10 * radians || dip > Math.max(0, pip) * 1.5 + 15 * radians) return null;
      }
      const reference = digit === "index" ? this.activeIndexReference : undefined;
      if (reference) {
        const posture = this.indexHoldingName === "index_side_contact" ? SIDE_INDEX_WORKING_POSTURE : this.poseState?.pose === "tripod" ? THREE_FINGER_WORKING_PROFILE.index : this.ordinaryPosture;
        return opposition.angleTo(reference.rotations[0]) * 2 + Math.abs(alpha - posture.pipDeg * radians) + Math.abs(beta - posture.dipDeg * radians);
      }
      return opposition.angleTo(new Quaternion()) + twist * 2 + Math.abs(beta - alpha * 0.7) * 0.2;
    };
    if (independentOpening && engagement < 0.000001) {
      const reference = evaluate(restA, restB);
      rotations = { key: cacheKey, alpha: restA, beta: restB, rotations: [new Quaternion(), reference.proximal, reference.distal] };
    } else if (rotations?.key !== cacheKey) {
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
      const openingKey = `${modelOpening.toArray().join(",")}:${independentOpening}`;
      if (rotations.openingKey !== openingKey || !rotations.openRotations) {
        // A released finger has no contact normal to satisfy. Solve its point with the same fixed
        // hinges and choose the MCP rotation nearest the held pose, rather than twisting it in air.
        const openDelta = modelOpening.clone().sub(base), openDistance = openDelta.length();
        let bestOpen: { score: number; rotations: Quaternion[] } | undefined;
        const consider = (alpha: number, beta: number) => {
          const result = evaluate(alpha, beta);
          if (Math.abs(result.vector.length() - openDistance) > 1e-7) return;
          const reference = independentOpening ? new Quaternion() : rotations!.rotations[0]!;
          const heldDirection = result.vector.clone().applyQuaternion(reference).normalize();
          const opposition = new Quaternion().setFromUnitVectors(heldDirection, openDelta.clone().normalize()).multiply(reference);
          if (naturalOpposition(opposition, alpha, beta) === null) return;
          const score = opposition.angleTo(rotations!.rotations[0]!) * 2 + Math.abs(alpha - rotations!.alpha) + Math.abs(beta - rotations!.beta);
          if (!bestOpen || score < bestOpen.score) bestOpen = { score, rotations: [opposition, result.proximal, result.distal] };
        };
        // Opening constrains a point, rather than a surface normal. Project the held angles
        // continuously onto that one distance constraint; choosing among discrete beta seeds
        // can switch the released DIP to a different branch during a material reset.
        let openAlpha = independentOpening ? restA : rotations.alpha, openBeta = independentOpening ? restB : rotations.beta;
        for (let iteration = 0; iteration < 20; iteration++) {
          const length = evaluate(openAlpha, openBeta).vector.length(), error = length - openDistance;
          if (Math.abs(error) < 1e-9) break;
          const epsilon = 1e-4;
          const gradientA = (evaluate(openAlpha + epsilon, openBeta).vector.length() - length) / epsilon;
          const gradientB = (evaluate(openAlpha, openBeta + epsilon).vector.length() - length) / epsilon;
          const squared = gradientA * gradientA + gradientB * gradientB;
          if (squared < 1e-12) break;
          const stepA = -error * gradientA / squared, stepB = -error * gradientB / squared;
          const scale = Math.min(1, 0.1 / Math.max(Math.abs(stepA), Math.abs(stepB)));
          openAlpha = clamp(openAlpha + stepA * scale, minA, maxA);
          openBeta = clamp(openBeta + stepB * scale, minB, maxB);
        }
        consider(openAlpha, openBeta);
        if (!bestOpen) for (const betaSeed of [rotations.beta, restB, rotations.beta * 0.5, rotations.beta + 15 * radians]) {
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

  private solveAperture(targetMetres: number, thumbOnly = false): void {
    const index = this.model.getObjectByName("index_pad_contact") ?? this.model.getObjectByName("index_tip");
    const thumb = this.model.getObjectByName("thumb_pad_contact") ?? this.model.getObjectByName("thumb_tip");
    const joints = thumbOnly ? [this.controls.get("thumb_CMC")] : [this.controls.get("thumb_CMC"), this.controls.get("index_MCP")];
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

  /** Nominal reference for the selected wrist bearing, independent of released pad midpoints. */
  principalContact(): Vector3 {
    if (this.nailWorkSample) {
      const reference = this.nailWorkSample.principalContact.clone();
      if (this.model.scale.z < 0) reference.z *= -1;
      return reference;
    }
    const pose = this.poseState?.pose ?? "pinch";
    if (pose === "skin-nail") return this.contact("nail");
    if (pose === "press") return this.contact("palm");
    if (pose === "palpate" || pose === "stretch") return this.contact("index");
    return new Vector3(0, this.holdingY(pose), 0);
  }

  /** Read-only material provenance; the exporter reads each canonical node's actual local P/Q. */
  materialContacts(): Record<string, HandMaterialContact> {
    const pose = this.poseState?.pose ?? "pinch", refitted = this.contactFrameHorizontalBranch !== undefined;
    if (this.nailWorkSample) return Object.fromEntries(Object.entries(this.nailWorkSample.contacts).map(([name, material]) => [name, {
      surface: material.surface, normalField: material.normalField, definition: structuredClone(material.definition), engaged: material.engaged,
      ...(material.engagedWith ? { engagedWith: material.engagedWith } : {}),
    }]));
    const skin = (name: string, digit: string, definition: Record<string, unknown>): HandMaterialContact => {
      const engagement = this.materialEngagement.get(name);
      return { surface: `${digit}_skin`, normalField: refitted ? "skin-bary" : "legacy-authored", definition,
        ...(engagement === undefined ? {} : { engaged: engagement >= 0.999999 }) };
    };
    if (pose === "skin-nail") return {
      index_nail_contact: { surface: "index_nail", normalField: "area-weighted-nail-bed", definition: { role: "surface-index-nail" } },
    };
    if (["palpate", "stretch", "press"].includes(pose)) return {
      [pose === "press" ? "palm_contact" : "index_volar_contact"]: pose === "press"
        ? { surface: "palm_surface", normalField: refitted ? "actual-triangle-facet" : "legacy-authored", definition: { role: "surface-heel-support" } }
        : { surface: "index_skin", normalField: refitted ? "actual-triangle-facet" : "legacy-authored", definition: { role: "surface-index-support", source: "true-volar-distal-tip" } },
    };
    const tripod = refitted && pose === "tripod" && !!this.tripodIndexReference;
    const side = refitted && this.indexHoldingName === "index_side_contact";
    const contacts: Record<string, HandMaterialContact> = {
      thumb_pad_contact: skin("thumb_pad_contact", "thumb", { role: "primary-thumb", acquisition: tripod || this.usesOrdinaryReference ? "oblique-volar-ray" : side ? "closest-surface" : "flat-pulp",
        principalY: this.holdingY(pose),
        tipwardMm: tripod ? THREE_FINGER_WORKING_PROFILE.thumbAcquisitionM * 1000 : side ? SIDE_THUMB_ACQUISITION_M * 1000 : this.usesOrdinaryReference ? ORDINARY_THUMB_PULP_ACQUISITION.tipwardM * 1000 : 0,
        ...(tripod || this.usesOrdinaryReference ? { lateralMm: (tripod ? THREE_FINGER_WORKING_PROFILE.thumbLateralAcquisitionM : ORDINARY_THUMB_PULP_ACQUISITION.lateralM) * 1000,
          minimumSourceVolarNormalDot: 0.5 } : {}) }),
      [this.indexHoldingName]: skin(this.indexHoldingName, "index", { role: "primary-index", principalY: this.holdingY(pose), reference: side ? { ...SIDE_INDEX_WORKING_POSTURE } : tripod ? { ...THREE_FINGER_WORKING_PROFILE.index } : this.usesOrdinaryReference ? { ...this.ordinaryPosture } : "source-bind" }),
    };
    if (pose === "tripod") contacts.middle_side_contact = skin("middle_side_contact", "middle", { role: "third-finger-pulp-support", source: tripod ? THREE_FINGER_WORKING_PROFILE.middleContact : "legacy-middle-side", principalY: this.holdingY(pose),
      ...(tripod ? { targetY: THREE_FINGER_WORKING_PROFILE.middleY, azimuthRad: THREE_FINGER_WORKING_PROFILE.middleAzimuthRad } : {}) });
    if (pose === "scrape" || pose === "flick") contacts.middle_nail_edge_contact = { surface: "middle_nail", normalField: "legacy-authored", definition: { role: "legacy-middle-nail-work" },
      engaged: (this.materialEngagement.get("middle_nail_edge_contact") ?? 0) >= 0.999999 };
    return contacts;
  }

  /** Contacts follow the moving phalanges, rather than static empties at the model origin. */
  contact(kind: HandContact): Vector3 {
    if (kind === "handle") return new Vector3();
    const index = this.anchor([this.indexHoldingName, "index_pad_contact", "index_pad", "index_tip"], new Vector3(0, 0, 0.006));
    if (kind === "index") return this.anchor(["index_volar_contact", "index_pad_contact", "index_pad", "index_tip"], index);
    if (kind === "nail") return this.anchor(this.nailWorkSample ? ["index_nail_edge_contact", "index_nail_contact", "index_tip"] : ["index_nail_contact", "index_tip"], index);
    if (kind === "palm") return this.anchor(["palm_contact", "support_contact"], new Vector3(0.105, -0.012, 0));
    const thumb = this.anchor(["thumb_pad_contact", "thumb_pad", "thumb_tip"], new Vector3(0, 0, -0.006));
    return index.add(thumb).multiplyScalar(0.5);
  }

  contactNormal(kind: HandContact): Vector3 {
    const names = kind === "nail" ? this.nailWorkSample ? ["index_nail_edge_contact"] : ["index_nail_contact"] : kind === "palm" ? ["palm_contact", "support_contact"]
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
