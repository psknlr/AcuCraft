import { Box3, Group, Mesh, MeshStandardMaterial, Quaternion, SkinnedMesh, Texture, Vector3, type Material } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ActionSchema, handWristBounds, hasClinicalNeedleMotion, needleMotion, resolveNeedleMotion, resolveTechniqueMotion, sampleManipulation, techniqueDefinition,
  type ManipulationMotionSettings, type ManipulationTechniqueId, type NeedleMotionSettings, type NeedleTechnique,
  type ResolvedManipulationMotion, type TechniqueModel,
  type InsertionPresentation as SharedInsertionPresentation,
} from "@acucraft/core";
import type { Person } from "./cast.js";
import type { NeedleLayer } from "./needles.js";
import { SiteFinder, type SkinSite } from "./sites.js";
import { poseSupportPinch, type SupportPinchFrame } from "./support-pinch.js";
import { sampleProcedure, type ProcedureKind } from "./choreography.js";
import { ArticulatedHand, handOrientation, surfaceHandOrientation, type FingerPose, type HandContact, type HandPose } from "./hand.js";
import { alignNeedleWristAzimuth } from "./needle-hand-frame.js";
import type { GripSubjects } from "./director.js";
import { NEEDLE_HANDLE_GRIP_Y_M, NEEDLE_HANDLE_RADIUS_M } from "./needle-shape.js";
import { PatientClearance } from "./clearance.js";
import { handWristSurface, type HandWristSurface } from "./wrist-join.js";
import { subsurfaceShade } from "./skin.js";

export type InsertionPresentation = SharedInsertionPresentation;
export interface HandInspectionFrame {
  contact: Vector3;
  wrist: Vector3;
  center: Vector3;
  /** Actual palmar outward direction, distinct from the needle axis. */
  palmNormal: Vector3;
  radial: Vector3;
  surfaceNormal: Vector3;
  radius: number;
  /** Real working contacts and joint landmarks used to keep inspection views clear of sleeves and bodies. */
  visibilityPoints: Vector3[];
  gripSubjects?: GripSubjects;
  /** Actual shaft direction, for avoiding inspection views that visually collapse the needle. */
  needleAxis?: Vector3;
}
export interface TechniquePerformanceInput {
  id: string;
  technique: ManipulationTechniqueId;
  site: SkinSite;
  needleId?: string;
  motion?: ManipulationMotionSettings;
  /** The catalogue the performance is of (absent: the illustrative one, as in records made before the choice). */
  model?: TechniqueModel;
}
/** The stage of an operative performance under way: what the caption shows. */
export interface PlaybackStage {
  zh: string;
  label: string;
  /** The repetition under way of how many (0 of 0: the stage is not counted). */
  count: number;
  of: number;
  level: "tian" | "ren" | "di" | null;
  breath: "inhale" | "exhale" | null;
  /** Where the tip stands, as a fraction of the depth the needle stands at. */
  depthFraction: number;
}
export interface ProcedurePlayback {
  mode: "idle" | "record" | "preview";
  playing: boolean;
  progress: number;
  speed: number;
  technique: string | null;
  phase: string | null;
  durationMs: number;
  /** A schematic pose, patient-clearance or arm-reach problem; the affected detail hand is hidden. */
  reachWarning?: string | null;
  /** On the operative catalogue: the stage under way (null: approach, release, or the illustrative catalogue). */
  stage?: PlaybackStage | null;
}
export interface PlaybackControl { paused?: boolean; speed?: number; progress?: number }
interface LegacyGesture {
  id: string;
  kind: ProcedureKind;
  technique?: NeedleTechnique;
  motion?: NeedleMotionSettings;
  presentation?: InsertionPresentation;
  workInput?: Record<string, unknown>;
  workDurationMs?: number;
  frequencyHz?: number;
}
interface PerformanceGesture { id: string; kind: "performance"; input: TechniquePerformanceInput; preview: boolean }
type Gesture = LegacyGesture | PerformanceGesture;
type ActiveGesture = Gesture & {
  start: number; side: "left" | "right"; worked: boolean; finished: boolean;
  grip: Vector3; axis: Vector3; initialGrip: Vector3; elapsed: number; lastNow: number; primeClock: boolean;
  /** One-way turning an accepted performance has left on the needle by its end (radians). */
  residualRad?: number;
};
const finiteClamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo));
const copySite = (site: SkinSite): SkinSite => ({ ...site, p: site.p.clone(), n: site.n.clone(), uDir: site.uDir.clone(), vDir: site.vDir.clone() });
const IDLE: ProcedurePlayback = { mode: "idle", playing: false, progress: 0, speed: 1, technique: null, phase: null, durationMs: 0, reachWarning: null };

/**
 * Continuous bimanual choreography for successful encounter actions. Each hand has independent moving contact
 * anchors and anatomical finger controls. Local previews never mutate the encounter or replace a queued action.
 */
export class NeedleProcedure {
  readonly group = new Group();
  onPlayback: (state: ProcedurePlayback) => void = () => {};
  private queue: Gesture[] = [];
  private active: ActiveGesture | null = null;
  private hand: ArticulatedHand | null = null;
  private supportHand: ArticulatedHand | null = null;
  private gone = false;
  private actor: Person | null = null;
  private readonly assetGeometries = new Set<Mesh["geometry"]>();
  private readonly assetMaterials = new Set<Material>();
  private readonly assetTextures = new Set<Texture>();
  private readonly insertion = new Map<string, InsertionPresentation>();
  private paused = false;
  private speed = 1;
  private lastNow = 0;
  private reachWarning: string | null = null;
  private playbackState: ProcedurePlayback = { ...IDLE };
  private readonly clearance = new PatientClearance();
  private readonly supportSites = new WeakMap<Person, SiteFinder>();
  private readonly clearanceRoll = new Map<ArticulatedHand, number>();
  private readonly clearancePlan = new Map<ArticulatedHand, number>();
  private readonly fingerPoses = new Map<ArticulatedHand, FingerPose>();
  private readonly wristSurfaces = new Map<ArticulatedHand, HandWristSurface>();
  private placements: { hand: ArticulatedHand; side: "left" | "right"; desiredWrist: Vector3; orientation: Quaternion; reach: number; anchor: HandContact }[] = [];

  constructor(private readonly needles: NeedleLayer, private readonly practitioner: () => Person | null, private readonly focus: (id: string) => void,
    private readonly patient: () => Person | null = () => null) {
    this.group.name = "precision-needling";
    this.group.visible = false;
  }

  get playback(): ProcedurePlayback { return { ...this.playbackState }; }

  /** A complete hand frame for inspection, without rescanning every deformed mesh each display frame. */
  inspectionFrame(forCamera = false): HandInspectionFrame | null {
    const hand = this.hand, placement = this.placements.find((p) => p.hand === hand);
    if (!hand?.root.visible || !placement) return null;
    hand.root.updateWorldMatrix(true, true);
    const contact = hand.contactAt(placement.anchor), wrist = hand.root.localToWorld(hand.wrist());
    const bounds = new Box3().setFromPoints([contact, wrist]);
    for (const digit of ["thumb", "index", "middle", "ring", "little"]) for (const landmark of [digit === "thumb" ? "CMC" : "MCP", "tip"]) {
      const node = hand.model.getObjectByName(`${digit}_${landmark}`);
      if (node) bounds.expandByPoint(node.getWorldPosition(new Vector3()));
    }
    const palm = hand.model.getObjectByName("palm_frame") ?? hand.model;
    const palmOrigin = palm.getWorldPosition(new Vector3());
    const gesture = this.active;
    const site = gesture?.kind === "performance" ? gesture.input.site : gesture ? this.needles.siteOf(gesture.id) : null;
    const visibilityPoints = [contact.clone()];
    let gripSubjects: GripSubjects | undefined;
    if (placement.anchor === "handle") {
      // Inspect the real participating materials: side pulp, third-finger
      // support and nail work do not share one inferred thumb/index midpoint.
      const contacts = hand.materialContacts();
      for (const name of Object.keys(contacts)) {
        const material = hand.model.getObjectByName(name);
        if (material) visibilityPoints.push(material.getWorldPosition(new Vector3()));
      }
      if (forCamera) {
        const id = gesture?.kind === "performance" ? gesture.input.needleId : gesture?.id;
        const handle = id ? this.needles.grip(id) : null;
        if (handle) {
          const digits = [...new Set(Object.values(contacts).map(contact => contact.surface.split("_")[0]))]
            .filter((digit): digit is string => !!digit && digit !== "palm")
            .map(digit => ({ digit, points: [`${digit}_nail_contact`, digit === "thumb" ? "thumb_IP" : `${digit}_DIP`]
              .flatMap(name => hand.model.getObjectByName(name)?.getWorldPosition(new Vector3()) ?? []) }))
            .filter(target => target.points.length > 0);
          gripSubjects = { hand: hand.root, digits,
            thenar: { landmarks: ["palm_frame", "thumb_CMC", "index_MCP"].flatMap(name => hand.model.getObjectByName(name)?.getWorldPosition(new Vector3()) ?? []),
              outward: palm.localToWorld(new Vector3(0, -1, 0)).sub(palmOrigin).normalize() },
            handlePoints: [-1, 1].map(sign => handle.point.clone().addScaledVector(handle.axis, sign * NEEDLE_HANDLE_GRIP_Y_M * 0.85)) };
        }
      }
      for (const name of ["thumb_MCP", "index_PIP"]) {
        const joint = hand.model.getObjectByName(name);
        if (joint) visibilityPoints.push(joint.getWorldPosition(new Vector3()));
      }
    }
    return {
      contact, wrist, center: bounds.getCenter(new Vector3()), radius: bounds.getSize(new Vector3()).length() / 2 + 0.015,
      palmNormal: palm.localToWorld(new Vector3(0, -1, 0)).sub(palmOrigin).normalize(),
      radial: palm.localToWorld(new Vector3(0, 0, 1)).sub(palmOrigin).normalize(),
      surfaceNormal: site?.n.clone() ?? new Vector3(0, 1, 0),
      visibilityPoints, gripSubjects,
      ...(placement.anchor === "handle" ? { needleAxis: new Vector3(0, 1, 0).applyQuaternion(hand.root.quaternion) } : {}),
    };
  }

  async load(url: string, skin: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      if (o instanceof SkinnedMesh) o.frustumCulled = false;
      this.assetGeometries.add(o.geometry);
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
        this.assetMaterials.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) this.assetTextures.add(value);
      }
    });
    if (this.gone) { this.disposeAssets(); return; }
    // the detail hand's skin answers light as the figures' skin does: warm where it is in shade (and the wrist
    // bridge, made from this material, with it)
    for (const material of this.assetMaterials) {
      if (!(material instanceof MeshStandardMaterial) || material.name !== "hand_skin") continue;
      material.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", `#include <lights_fragment_end>${subsurfaceShade("1.0")}`); };
      material.customProgramCacheKey = () => "hand-skin-shade-1";
      material.needsUpdate = true;
    }
    this.hand = new ArticulatedHand(gltf.scene, gltf.animations, skin);
    this.supportHand = new ArticulatedHand(cloneSkeleton(gltf.scene) as Group, gltf.animations, skin);
    for (const hand of [this.hand, this.supportHand]) {
      const surface = handWristSurface(hand.model);
      if (surface) this.wristSurfaces.set(hand, surface);
    }
    this.hand.root.name = "needle-hand";
    this.supportHand.root.name = "support-hand";
    this.group.add(this.hand.root, this.supportHand.root);
    if (this.active) {
      this.setHandSides(this.active.side);
      if (this.active.kind === "performance") this.renderPerformance(this.active, this.actor);
    }
  }

  setInsertionPresentation(id: string, presentation: InsertionPresentation): void {
    this.insertion.set(id, { ...presentation });
    // The transition may already have been reconciled by a preceding state update.
    for (const gesture of this.queue) if (gesture.kind === "insert" && gesture.id === id) gesture.presentation = { ...presentation };
  }

  /** Catch insertion/removal transitions, including compound removal and field events. */
  sync(): void {
    const transitions = this.needles.transitions();
    if (transitions.length) this.stopPreview();
    for (const transition of transitions) {
      if (this.active?.id === transition.id && this.active.kind === transition.kind) continue;
      if (!this.queue.some((g) => g.id === transition.id && g.kind === transition.kind)) {
        this.queue.push({ ...transition, ...(transition.kind === "insert" ? { presentation: this.insertion.get(transition.id) } : {}) });
      }
    }
  }

  work(id: string, technique: NeedleTechnique, motion?: NeedleMotionSettings): void {
    this.stopPreview();
    this.sync();
    this.queue.push({ id, kind: "work", technique, motion });
  }

  /** Queue the complete executed action so top-level frequency, excursion and duration reach both hands and needle. */
  workAction(id: string, input: Record<string, unknown>): void {
    const parsed = ActionSchema.safeParse({ ...input, type: "adjust_needle", needleId: id });
    if (!parsed.success || parsed.data.type !== "adjust_needle") return;
    if (!hasClinicalNeedleMotion(parsed.data)) {
      this.work(id, parsed.data.technique, parsed.data.motion);
      return;
    }
    const profile = needleMotion(parsed.data, 0);
    this.stopPreview();
    this.sync();
    this.queue.push({ id, kind: "work", technique: parsed.data.technique, workInput: { ...parsed.data },
      workDurationMs: profile.durationSeconds * 1000, frequencyHz: profile.frequencyHz });
  }

  /** A performance from the engine's executed public record. */
  perform(input: TechniquePerformanceInput, _now?: number): void {
    this.stopPreview();
    this.sync();
    if (this.active?.kind === "performance" && this.active.id === input.id || this.queue.some((g) => g.kind === "performance" && g.id === input.id)) return;
    this.queue.push({ id: input.id, kind: "performance", input: { ...input, site: copySite(input.site), motion: { ...input.motion } }, preview: false });
  }

  /** Preview only while the actor is idle; never discard accepted actions to show an operator draft. */
  preview(input: TechniquePerformanceInput): boolean {
    if (this.queue.length || this.active && (this.active.kind !== "performance" || !this.active.preview)) return false;
    if (!techniqueDefinition(input.model, input.technique) || !this.validSite(input.site)) return false;
    const definition = techniqueDefinition(input.model, input.technique)!;
    if (definition.context === "retained" && (!input.needleId || !this.needles.has(input.needleId))) return false;
    const person = this.practitioner();
    if (!person || person.isMoving) return false;
    this.stopPreview();
    const gesture: PerformanceGesture = { id: input.id, kind: "performance", input: { ...input, site: copySite(input.site), motion: { ...input.motion } }, preview: true };
    const started = this.start(gesture, person, this.lastNow);
    // Transport controls must become usable even when the canvas is currently below/outside the viewport.
    if (started && this.active?.kind === "performance") this.renderPerformance(this.active, person);
    return started;
  }

  setPlayback(control: PlaybackControl): void {
    if (control.speed !== undefined) this.speed = finiteClamp(control.speed, 0.1, 3);
    const wasPaused = this.paused;
    if (control.paused !== undefined) this.paused = control.paused;
    const active = this.active;
    if (active?.kind === "performance" && active.preview && control.paused === false) {
      if (wasPaused) active.primeClock = true;
      const duration = sampleProcedure("work", 0, resolveTechniqueMotion(active.input.model, active.input.technique, active.input.motion).durationMs).durationMs;
      if (active.elapsed >= duration) { active.elapsed = 0; active.primeClock = true; }
    }
    // Seeking recorded actions would conceal ordering; only a clearly labelled local preview can be sought.
    if (control.progress !== undefined && active?.kind === "performance" && active.preview) {
      this.clearanceRoll.clear();
      const motion = resolveTechniqueMotion(active.input.model, active.input.technique, active.input.motion);
      active.elapsed = finiteClamp(control.progress, 0, 1) * sampleProcedure("work", 0, motion.durationMs).durationMs;
      active.lastNow = this.lastNow;
      active.primeClock = true;
    }
    if (active?.kind === "performance") this.renderPerformance(active, this.practitioner());
  }

  stopPreview(): void {
    if (this.active?.kind !== "performance" || !this.active.preview) return;
    this.finish(this.active);
    this.active = null;
    this.paused = false;
    this.publish({ ...IDLE, speed: this.speed });
  }

  reset(): void {
    if (this.active) this.finish(this.active);
    this.queue = [];
    this.insertion.clear();
    this.active = null;
    this.clearHands();
    this.actor = null;
    this.paused = false;
    this.publish({ ...IDLE, speed: this.speed });
  }

  private validSite(site: SkinSite): boolean {
    return [...site.p.toArray(), ...site.n.toArray(), ...site.uDir.toArray(), ...site.vDir.toArray()].every(Number.isFinite) && site.n.lengthSq() > 1e-10;
  }

  private start(next: Gesture, person: Person, now: number): boolean {
    let point: Vector3, axis: Vector3;
    let requested: "auto" | "left" | "right" = "auto";
    if (next.kind === "performance") {
      if (!this.validSite(next.input.site)) return false;
      const definition = techniqueDefinition(next.input.model, next.input.technique);
      if (!definition) return false;
      // a method of the pressing hand named with a needle is done on the skin beside it, not on its handle
      const grip = next.input.needleId && !(definition.context === "skin" && next.input.model === "operative") ? this.needles.grip(next.input.needleId) : null;
      if (definition.context === "retained" && !grip) return false;
      point = grip?.point ?? next.input.site.p.clone();
      axis = grip?.axis ?? next.input.site.n.clone();
      requested = resolveTechniqueMotion(next.input.model, next.input.technique, next.input.motion).hand;
    } else {
      const grip = this.needles.grip(next.id);
      if (!grip) return false;
      point = grip.point; axis = grip.axis;
      requested = next.presentation?.hand ?? "auto";
    }
    const side = requested !== "auto" ? requested : person.shoulderAt("left").distanceToSquared(point) < person.shoulderAt("right").distanceToSquared(point) ? "left" : "right";
    this.active = { ...next, start: now, side, worked: false, finished: false, grip: point.clone(), axis: axis.clone(), initialGrip: point.clone(), elapsed: 0, lastNow: now, primeClock: next.kind === "performance" && next.preview };
    this.actor = person;
    this.setHandSides(side);
    const needleId = next.kind === "performance" ? next.input.needleId : next.id;
    if (needleId) this.focus(needleId);
    return true;
  }

  tick(now: number): void {
    this.lastNow = Number.isFinite(now) ? now : this.lastNow;
    const person = this.practitioner();
    if (this.actor && person !== this.actor) this.reset();
    if (!this.active && person && !person.isMoving) {
      let next: Gesture | undefined;
      while ((next = this.queue.shift())) if (this.start(next, person, this.lastNow)) break;
    }
    const gesture = this.active;
    if (!gesture || !person) return;
    if (person.isMoving) {
      if (gesture.kind !== "performance" && gesture.kind !== "work") this.needles.progress(gesture.id, gesture.kind, 1);
      this.finish(gesture);
      this.active = null;
      this.publish({ ...IDLE, speed: this.speed });
      return;
    }
    if (gesture.kind === "performance") {
      if (gesture.primeClock) gesture.primeClock = false;
      else if (!this.paused) gesture.elapsed += Math.max(0, this.lastNow - gesture.lastNow) * this.speed;
      gesture.lastNow = this.lastNow;
      this.renderPerformance(gesture, person);
    } else this.renderLegacy(gesture, person, this.lastNow);
  }

  private setHandSides(side: "left" | "right"): void {
    this.hand?.setSide(side);
    this.supportHand?.setSide(side === "left" ? "right" : "left");
  }

  private renderLegacy(gesture: ActiveGesture & LegacyGesture, person: Person, now: number): void {
    const duration = gesture.workDurationMs ?? resolveNeedleMotion(gesture.technique ?? "none", gesture.motion).durationMs;
    const insertionMs = gesture.kind === "insert" && gesture.presentation?.durationMs !== undefined ? finiteClamp(gesture.presentation.durationMs, 400, 8000) : undefined;
    const sample = sampleProcedure(gesture.kind, now - gesture.start, duration, insertionMs);
    if (sample.operation > 0 && !gesture.worked) {
      gesture.worked = true;
      if (gesture.kind === "work") {
        if (gesture.workInput) this.needles.work(gesture.id, gesture.workInput, gesture.start + sample.operationStartMs);
        else this.needles.work(gesture.id, gesture.technique ?? "none", gesture.start + sample.operationStartMs, gesture.motion);
      }
    }
    if (gesture.kind !== "work" && gesture.worked && !gesture.finished) {
      this.needles.progress(gesture.id, gesture.kind, Math.min(0.99999, sample.operation), gesture.presentation?.skinContactFraction);
      if (sample.operation === 1 && sample.grip < 0.01) {
        this.needles.progress(gesture.id, gesture.kind, 1);
        gesture.finished = true;
      }
    }
    const handle = this.needles.grip(gesture.id);
    if (handle && (gesture.worked || gesture.kind !== "insert")) { gesture.grip.copy(handle.point); gesture.axis.copy(handle.axis); }
    person.faceToward?.(this.needles.siteOf(gesture.id)?.p ?? gesture.grip, sample.reach);
    this.placements = [];
    const hand = this.hand;
    if (hand) {
      const phase = sample.operating ? (gesture.frequencyHz !== undefined
        ? (now - gesture.start - sample.operationStartMs) / 1000 * gesture.frequencyHz
        : (now - gesture.start - sample.operationStartMs) / duration * (gesture.motion?.cycles ?? 3)) % 1 : 0;
      // An insertion starts with a needle already in the fingers. Retained work/removal instead
      // approaches an existing needle before closing; bringing an open hand with a floating needle
      // to the patient is not the insertion gesture shown in the references.
      const carrying = gesture.kind === "insert" && now - gesture.start < sample.operationStartMs;
      this.poseHand(hand, { pose: gesture.presentation?.grip === "three-finger" ? "tripod" : "pinch", grip: carrying ? 1 : sample.grip,
        apertureMm: gesture.presentation?.gripApertureMm ?? 2, handleRadiusM: NEEDLE_HANDLE_RADIUS_M,
        wristElevationDeg: gesture.presentation?.wristElevationDeg ?? handWristBounds(gesture.presentation).default,
        gripStyle: gesture.presentation?.gripStyle ?? "tip-pinch", idleFingerPose: gesture.presentation?.idleFingerPose ?? "curled",
        axialDisplacementMm: gesture.kind === "work" && handle ? handle.point.clone().sub(gesture.initialGrip).dot(gesture.axis) * 1000 : 0,
        continuousRoll: gesture.workInput?.technique === "rotate" && (gesture.workInput.rotationDirection === "clockwise" || gesture.workInput.rotationDirection === "counterclockwise"),
        phase, rotationRad: handle?.rotation ?? 0 });
      const wristRoll = Math.sin(handle?.rotation ?? 0) * 0.04;
      this.placeHand(hand, person, gesture.side, gesture.grip, gesture.axis, sample.reach, "handle", wristRoll);
    } else this.group.visible = false;
    const support = gesture.presentation?.support ?? "none";
    const site = this.needles.siteOf(gesture.id);
    this.placeSupport(person, gesture.side, site, support, sample.reach, sample.grip, phaseValue(now - gesture.start, duration), 0.5);
    this.settleHands(person);
    if (gesture.kind === "insert" && !gesture.worked && hand?.root.visible) this.needles.carry(gesture.id, hand.contactAt("handle"), gesture.axis);
    this.group.visible = !!this.hand?.root.visible || !!this.supportHand?.root.visible;
    // Clinical insertion/work has its own clock; expose geometry feedback without offering the
    // catalogue's local preview transport as a way to pause or seek that clinical action.
    this.publish({ ...IDLE, speed: this.speed, reachWarning: this.reachWarning });
    if (sample.complete) { this.finish(gesture); this.active = null; this.publish({ ...IDLE, speed: this.speed }); }
  }

  private renderPerformance(gesture: ActiveGesture & PerformanceGesture, person: Person | null): void {
    if (!person) return;
    const input = gesture.input, definition = techniqueDefinition(input.model, input.technique)!;
    const motion = resolveTechniqueMotion(input.model, input.technique, input.motion);
    const envelope = sampleProcedure("work", gesture.elapsed, motion.durationMs);
    const elapsed = finiteClamp(gesture.elapsed - envelope.operationStartMs, 0, motion.durationMs);
    const sample = this.sample(input, elapsed, motion);
    // Keep the same attachment and base pose through approach and release; sampling the resting endpoint
    // would otherwise switch a scraper back to a pinch in one frame.
    const poseSample = elapsed === 0 || sample.complete ? this.sample(input, elapsed === 0 ? 0.001 : motion.durationMs - 0.001, motion) : sample;
    if (definition.context === "retained" && input.needleId) {
      if (!this.needles.grip(input.needleId)) { this.finish(gesture); this.active = null; return; }
      if (!gesture.worked && elapsed > 0 && !gesture.preview) {
        this.needles.workTechnique(input.needleId, input.technique, this.lastNow - elapsed, motion, input.model);
        gesture.worked = true;
      }
      this.needles.poseTechnique(input.needleId, input.technique, elapsed, motion, input.model);
      // what one-way turning leaves on the needle stays on it once an accepted performance is over
      if (sample.complete && !gesture.preview) gesture.residualRad = sample.windingRad ?? 0;
    }
    const handle = definition.context === "retained" && input.needleId ? this.needles.grip(input.needleId) : null;
    const site = handle ? input.site : input.site.currentSurface?.() ?? input.site;
    const contact = handle?.point.clone() ?? site.p.clone().addScaledVector(site.uDir, (sample.lateralMm.u + (sample.offsetMm ?? 0)) / 1000).addScaledVector(site.vDir, (sample.lateralMm.v + (sample.travelMm ?? 0)) / 1000);
    const axis = handle?.axis.clone() ?? site.n.clone();
    // a hand that travels along the channel follows the skin it is drawn on, not the plane of the point
    if (!handle && ((sample.travelMm ?? 0) !== 0 || (sample.offsetMm ?? 0) !== 0)) {
      const patient = this.patient();
      if (patient) {
        let finder = this.supportSites.get(patient);
        if (!finder) { finder = new SiteFinder(patient.rig); this.supportSites.set(patient, finder); }
        const skin = finder.nearbySkin(contact, site.n);
        if (skin) { contact.copy(skin.p); axis.copy(skin.n); }
      }
    }
    let anchor: HandContact = handle ? "handle" : "index";
    if (!handle && poseSample.handPose === "skin-nail") anchor = "nail";
    else if (!handle && poseSample.handPose === "press") anchor = "palm";
    if (!handle && anchor !== "nail") contact.addScaledVector(site.n, 0.0015);
    const grip = envelope.grip * sample.gripEngagement;
    person.faceToward?.(site.p, envelope.reach);
    this.placements = [];
    if (this.hand) this.poseHand(this.hand, { pose: poseSample.handPose,
      grip, apertureMm: motion.gripApertureMm, handleRadiusM: handle ? NEEDLE_HANDLE_RADIUS_M : undefined,
      stabilizerGrip: envelope.grip, phase: sample.phase.cycleProgress,
      wristElevationDeg: motion.wristElevationDeg, gripStyle: motion.gripStyle, idleFingerPose: motion.idleFingerPose,
      axialDisplacementMm: handle && sample.withdrawalMm > 0 ? Math.max(0, contact.clone().sub(gesture.initialGrip).dot(gesture.axis) * 1000) : 0,
      rotationRad: sample.fingerRollRad ?? sample.rotationRad, nailContact: sample.nailContact, intensity: motion.contactIntensity });
    if (this.hand) this.placeHand(this.hand, person, gesture.side, contact, axis, envelope.reach, anchor, Math.sin(handle?.rotation ?? 0) * 0.04, !handle);
    this.placeSupport(person, gesture.side, site, motion.support, envelope.reach, envelope.grip, sample.phase.progress, motion.contactIntensity);
    this.settleHands(person);
    this.group.visible = !!this.hand?.root.visible || !!this.supportHand?.root.visible;
    const working = gesture.elapsed >= envelope.operationStartMs && elapsed < motion.durationMs;
    this.publish({ reachWarning: this.reachWarning, mode: gesture.preview ? "preview" : "record", playing: !this.paused && !envelope.complete,
      progress: finiteClamp(gesture.elapsed / envelope.durationMs, 0, 1), speed: this.speed,
      technique: input.technique, phase: gesture.elapsed < envelope.operationStartMs ? "Approach and grip"
        : elapsed < motion.durationMs ? sample.phase.label : envelope.complete ? "Complete" : "Release and retreat", durationMs: envelope.durationMs,
      stage: working && sample.stage ? { zh: sample.stage.zh, label: sample.stage.label, count: sample.stage.count, of: sample.stage.of, level: sample.stage.level, breath: sample.stage.breath, depthFraction: sample.depthFraction ?? 1 } : null });
    if (envelope.complete && !gesture.preview) { this.finish(gesture); this.active = null; this.publish({ ...IDLE, speed: this.speed }); }
    else if (envelope.complete && gesture.preview) this.paused = true;
  }

  /** Where the needle and hands are, on the catalogue the performance is of, told the depth the needle stands at. */
  private sample(input: TechniquePerformanceInput, elapsed: number, motion: ResolvedManipulationMotion) {
    const depthMm = input.needleId ? this.needles.depthMm(input.needleId) : null;
    return sampleManipulation(input.model, input.technique, elapsed, motion, {
      ...(depthMm !== null ? { depthMm } : {}),
      besideNeedle: !!input.needleId && this.needles.has(input.needleId) && techniqueDefinition(input.model, input.technique)?.context === "skin",
    });
  }

  private poseHand(hand: ArticulatedHand, pose: FingerPose): void {
    this.fingerPoses.set(hand, { ...pose });
    hand.pose(pose);
  }

  /** Include the geometry that will close around the retained handle, before choosing a palm branch. */
  private needleClearancePoses(hand: ArticulatedHand, current: FingerPose): FingerPose[] {
    const poses = [current], gesture = this.active;
    const endpoints = [current];
    if (hand === this.hand && gesture?.kind === "performance") {
      const motion = resolveTechniqueMotion(gesture.input.model, gesture.input.technique, gesture.input.motion);
      // an operative program has many more repetitions than hand shapes: a fixed number of samples covers them
      const steps = gesture.input.model === "operative" ? 128 : Math.max(...(motion.phaseCycles ?? [motion.cycles])) * 32;
      for (let step = 0; step <= steps; step++) {
        const elapsed = finiteClamp(motion.durationMs * step / steps, 0.001, motion.durationMs - 0.001);
        const sample = this.sample(gesture.input, elapsed, motion);
        const pose: FingerPose = { ...current, pose: sample.handPose, grip: sample.gripEngagement, stabilizerGrip: 1,
          phase: sample.phase.cycleProgress, rotationRad: sample.fingerRollRad ?? sample.rotationRad,
          nailContact: sample.nailContact, axialDisplacementMm: sample.withdrawalMm };
        poses.push(pose);
        if (step === 0 || step === steps) endpoints.push(pose);
      }
    }
    // A fully closed shape alone misses the wider thumb and finger geometry
    // during acquisition and release. These are the same anatomical poses used
    // by the renderer; no inflated proxy or altered hand scale is involved.
    for (const endpoint of endpoints) for (let step = 0; step <= 8; step++) {
      const grip = step / 8;
      poses.push({ ...endpoint, grip: endpoint.grip * grip, stabilizerGrip: grip });
    }
    return poses;
  }

  private placeHand(hand: ArticulatedHand, person: Person, side: "left" | "right", contact: Vector3, axis: Vector3, reach: number, anchor: HandContact, roll = 0, surface = false, pinch?: SupportPinchFrame | null): void {
    const gesture = this.active;
    const site = gesture?.kind === "performance" ? gesture.input.site : gesture ? this.needles.siteOf(gesture.id) : null;
    const workingContact = contact;
    // Approach and retreat above the local skin plane rather than cutting diagonally through the
    // patient with the carried needle. The arc vanishes before any recorded insertion takes place.
    if (site && reach > 0 && reach < 1) contact = contact.clone().addScaledVector(site.n, Math.sin(Math.PI * reach) * 0.08);
    const contactLocal = pinch?.point ?? hand.contact(anchor), wristLocal = hand.wrist();
    let orientation = surface ? surfaceHandOrientation(contactLocal, wristLocal, pinch?.normal ?? hand.contactNormal(anchor), contact, axis, person.shoulderAt(side))
      : alignNeedleWristAzimuth(handOrientation(contact, axis, person.shoulderAt(side), roll), contactLocal, wristLocal);
    const patient = this.patient();
    if (patient && hand.contactValid) {
      const base = orientation.clone(), normal = axis.clone().normalize();
      // Choose a needle-hand branch against the working point before adding
      // the approach arc. A branch that only clears while hovering can force
      // a sudden palm turn when the hand arrives or starts retreating.
      const clearanceContact = anchor === "handle" && !surface ? workingContact : contact;
      const currentPose = this.fingerPoses.get(hand);
      const tripod = anchor === "handle" && currentPose?.pose === "tripod";
      const turns = [0, -15, -30, -45, 15, 30, 45, -60, 60, -75, 75, -90, 90];
      if (tripod) turns.push(-105, 105, -120, 120);
      const candidates = turns.map((degrees) => degrees * Math.PI / 180);
      if (tripod) {
        // Turn the tripod outward first so the proximal index joint stays away from the moving trunk.
        const outward = side === "right" ? 1 : -1;
        candidates.sort((a, b) => Number(outward * a < 0) - Number(outward * b < 0) || Math.abs(a) - Math.abs(b));
      }
      const fits = (angle: number) => {
        const candidate = new Quaternion().setFromAxisAngle(normal, angle).multiply(base);
        hand.root.quaternion.copy(candidate);
        // Once a working branch is planned, judge the opening hand at its actual approach height.
        const frameContact = tripod && reach > 0.02 && reach < 1 && this.clearancePlan.has(hand) ? contact : clearanceContact;
        hand.root.position.copy(frameContact).sub(contactLocal.clone().applyQuaternion(candidate));
        return !this.clearance.intersects(hand.model, patient);
      };
      // Registration can precede the patient's first animated pose. Replan while
      // the hand is still off screen if that first real skin pose invalidates it.
      const plan = this.clearancePlan.get(hand);
      // During a tripod approach the facing shoulder is still turning. Its resting wrist
      // cannot invalidate a plan measured in the eventual working frame while hidden.
      const detachedTripod = tripod && !!gesture && reach <= 0.02;
      if (!detachedTripod && reach <= 0.02 && plan !== undefined && !fits(plan)) {
        this.clearancePlan.delete(hand);
        this.clearanceRoll.delete(hand);
      }
      if (anchor === "handle" && !surface && currentPose && !this.clearancePlan.has(hand)) {
        const poses = this.needleClearancePoses(hand, currentPose);
        const workingShoulder = person.shoulderAt(side);
        if (tripod && site && person.faceToward) {
          try {
            person.faceToward(site.p, 1);
            workingShoulder.copy(person.shoulderAt(side));
          } finally { person.faceToward(site.p, reach); }
        }
        const workingBase = handOrientation(clearanceContact, axis, workingShoulder);
        const planEnvelope = () => {
          for (const angle of candidates) {
            let clearsEnvelope = true;
            for (const pose of poses) {
              hand.pose(pose);
              const local = hand.contact(anchor), wrist = hand.wrist();
              const candidate = new Quaternion().setFromAxisAngle(normal, angle + Math.sin(pose.rotationRad ?? 0) * 0.04)
                .multiply(alignNeedleWristAzimuth(workingBase, local, wrist));
              hand.root.quaternion.copy(candidate);
              hand.root.position.copy(clearanceContact).sub(local.applyQuaternion(candidate));
              if (!hand.contactValid || this.clearance.intersects(hand.model, patient)) { clearsEnvelope = false; break; }
            }
            if (clearsEnvelope) return angle;
          }
          return undefined;
        };
        try {
          let planned = (tripod && patient.atFullInhalation ? patient.atFullInhalation(planEnvelope) : undefined) ?? planEnvelope();
          if (planned === undefined && tripod) {
            // A fully open tripod tested at the seated handle may rule out every working
            // branch. Start the raised acquisition laterally, with the index knuckle turned
            // away from the torso. Every visible frame still checks the current mesh.
            planned = (side === "right" ? 1 : -1) * Math.PI / 2;
          }
          if (planned !== undefined) this.clearancePlan.set(hand, planned);
        } finally { hand.pose(currentPose); }
      }
      const preferred = this.clearanceRoll.get(hand) ?? this.clearancePlan.get(hand) ?? 0;
      let selected: number | null = (detachedTripod && this.clearancePlan.has(hand)) || fits(preferred) ? preferred
        : !tripod && preferred !== 0 && fits(0) ? 0 : null;
      if (selected === null) {
        // Stay on the previous side of the shaft whenever an adjacent cleared wrist angle exists.
        const nearest = tripod ? candidates.filter((angle) => angle !== preferred)
          .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred)) : candidates.slice(1);
        for (const end of nearest) {
          if (!fits(end)) continue;
          let blocked = tripod ? preferred : end - Math.sign(end) * Math.PI / 12, clear = end;
          for (let i = 0; i < 5; i++) {
            const middle = (blocked + clear) / 2;
            if (fits(middle)) clear = middle; else blocked = middle;
          }
          selected = clear;
          break;
        }
      }
      if (selected !== null) {
        orientation = new Quaternion().setFromAxisAngle(normal, selected).multiply(base);
        this.clearanceRoll.set(hand, selected);
        // A preview seek resets frame feedback, but retains the branch planned
        // at gesture start. Its approach and retreat must use the same side.
        if (!this.clearancePlan.has(hand)) this.clearancePlan.set(hand, selected);
      } else this.clearanceRoll.delete(hand);
    }
    const wristOffset = wristLocal.sub(contactLocal).applyQuaternion(orientation);
    const desiredWrist = contact.clone().add(wristOffset);
    person.reach(side, desiredWrist, reach, hand.wristOrientation(orientation));
    this.placements.push({ hand, side, desiredWrist, orientation, reach, anchor });
  }

  /** Register both arms before attaching either hand: both solves must use the same final torso lean. */
  private settleHands(person: Person): void {
    const unreachable: string[] = [];
    const invalidContacts: string[] = [];
    const blocked: string[] = [];
    for (const placement of this.placements) {
      const { hand, side, desiredWrist, orientation, reach } = placement;
      const result = person.reach(side, desiredWrist, reach, hand.wristOrientation(orientation));
      hand.root.position.copy(result.wrist).sub(hand.wrist().applyQuaternion(orientation));
      hand.root.quaternion.copy(orientation);
      const lacksSpace = hand.contactValid && this.clearance.intersects(hand.model, this.patient());
      hand.root.visible = hand.contactValid && !lacksSpace && person.holder.visible && reach > 0.02 && (result.reachable || reach < 0.99);
      person.setDetailHand?.(side, hand.root.visible, this.wristSurfaces.get(hand));
      if (reach >= 0.99 && !result.reachable) unreachable.push(side);
      if (reach >= 0.99 && !hand.contactValid) invalidContacts.push(side);
      if (reach > 0.02 && lacksSpace) blocked.push(side);
    }
    this.reachWarning = invalidContacts.length
      ? "手型无法自然贴合针柄；请调整持针方式或手法参数。 · This hand pose cannot maintain a natural grip; adjust the grip or technique."
      : blocked.length ? "当前示意手型空间不足，已隐藏相交的细节手模型；针位和临床参数保持不变。 · This schematic hand lacks clearance; the intersecting detail hand is hidden."
      : unreachable.length ? `Move closer: the ${unreachable.join(" and ")} hand cannot reach the selected contact.` : null;
  }

  private placeSupport(person: Person, mainSide: "left" | "right", site: SkinSite | null, support: NonNullable<InsertionPresentation["support"]>, reach: number, grip: number, phase: number, intensity: number): void {
    const side = mainSide === "left" ? "right" : "left", hand = this.supportHand;
    if (!hand || !site || support === "none") {
      if (hand) hand.root.visible = false;
      person.reach(side, null);
      return;
    }
    site = site.currentSurface?.() ?? site;
    const pose: HandPose = support === "stretch" ? "stretch" : support === "pinch" ? "pinch" : support === "press" ? "press" : "palpate";
    const pinch = support === "pinch" ? poseSupportPinch(hand, grip) : null;
    if (!pinch) this.poseHand(hand, { pose, grip, phase, apertureMm: support === "stretch" ? 8 : 2, intensity });
    // Contact remains beside the entry, toward the supporting shoulder, rather than underneath the needle.
    const tangent = person.shoulderAt(side).sub(site.p);
    tangent.addScaledVector(site.n, -tangent.dot(site.n));
    if (tangent.lengthSq() < 1e-10) tangent.copy(site.uDir);
    tangent.normalize();
    const contact = site.p.clone().addScaledVector(tangent, 0.035);
    let normal = site.n;
    const patient = pinch && this.patient();
    if (patient) {
      let finder = this.supportSites.get(patient);
      if (!finder) { finder = new SiteFinder(patient.rig); this.supportSites.set(patient, finder); }
      const skin = finder.nearbySkin(contact, normal);
      if (skin) { contact.copy(skin.p); normal = skin.n; }
    }
    // An open pair approaches with both rounded tips just above the patch,
    // then settles its bearing surfaces as the thumb and index close.
    contact.addScaledVector(normal, pinch ? 0.00012 + 0.0004 * (1 - grip) : 0.002);
    this.placeHand(hand, person, side, contact, normal, reach, support === "press" ? "palm" : support === "pinch" ? "pinch" : "index", 0, true, pinch);
  }

  private finish(gesture: ActiveGesture): void {
    if (gesture.kind === "performance" && gesture.input.needleId) this.needles.clearTechnique(gesture.input.needleId, gesture.preview ? 0 : gesture.residualRad ?? 0);
    this.clearHands();
    this.insertion.delete(gesture.id);
  }

  private clearHands(): void {
    this.placements = [];
    this.clearanceRoll.clear();
    this.clearancePlan.clear();
    this.fingerPoses.clear();
    this.reachWarning = null;
    this.actor?.faceToward?.(null);
    this.actor?.reach("left", null);
    this.actor?.reach("right", null);
    if (this.hand) this.hand.root.visible = false;
    if (this.supportHand) this.supportHand.root.visible = false;
    this.group.visible = false;
  }

  private publish(state: ProcedurePlayback): void {
    this.playbackState = state;
    this.onPlayback({ ...state });
  }

  private disposeAssets(): void {
    for (const geometry of this.assetGeometries) geometry.dispose();
    for (const material of this.assetMaterials) material.dispose();
    const images = new Set<{ close?: () => void }>();
    for (const texture of this.assetTextures) {
      texture.dispose();
      if (texture.source.data && typeof texture.source.data === "object") images.add(texture.source.data);
    }
    for (const bitmap of images) bitmap.close?.();
    this.assetGeometries.clear(); this.assetMaterials.clear();
    this.assetTextures.clear();
  }

  dispose(): void {
    this.gone = true;
    this.reset();
    this.hand?.dispose();
    this.supportHand?.dispose();
    this.wristSurfaces.clear();
    this.disposeAssets();
    this.group.removeFromParent();
  }
}

const phaseValue = (elapsed: number, duration: number) => duration > 0 ? (Math.max(0, elapsed) / duration) % 1 : 0;
