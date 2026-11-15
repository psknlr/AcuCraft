import { Group, Mesh, Vector3, type Material, type Quaternion } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  manipulationTechnique, resolveManipulationMotion, resolveNeedleMotion, sampleTechnique,
  type ManipulationMotionSettings, type ManipulationTechniqueId, type NeedleMotionSettings, type NeedleTechnique,
  type ResolvedManipulationMotion, type TechniqueMotionSample,
} from "@acucraft/core";
import type { Person } from "./cast.js";
import type { NeedleLayer } from "./needles.js";
import type { SkinSite } from "./sites.js";
import { sampleProcedure, type ProcedureKind } from "./choreography.js";
import { ArticulatedHand, handOrientation, surfaceHandOrientation, type HandContact, type HandPose } from "./hand.js";

export interface InsertionPresentation {
  /** Duration of the actual insertion phase, excluding approach/grasp/release/retreat. */
  durationMs?: number;
  grip?: "two-finger" | "three-finger";
  support?: "none" | "stabilize" | "stretch" | "pinch" | "press";
  hand?: "auto" | "left" | "right";
  gripApertureMm?: number;
}
export interface TechniquePerformanceInput {
  id: string;
  technique: ManipulationTechniqueId;
  site: SkinSite;
  needleId?: string;
  motion?: ManipulationMotionSettings;
}
export interface ProcedurePlayback {
  mode: "idle" | "record" | "preview";
  playing: boolean;
  progress: number;
  speed: number;
  technique: string | null;
  phase: string | null;
  durationMs: number;
  /** A schematic hand target outside arm reach; the clipped hand is not drawn detached from the sleeve. */
  reachWarning?: string | null;
}
export interface PlaybackControl { paused?: boolean; speed?: number; progress?: number }
interface LegacyGesture {
  id: string;
  kind: ProcedureKind;
  technique?: NeedleTechnique;
  motion?: NeedleMotionSettings;
  presentation?: InsertionPresentation;
}
interface PerformanceGesture { id: string; kind: "performance"; input: TechniquePerformanceInput; preview: boolean }
type Gesture = LegacyGesture | PerformanceGesture;
type ActiveGesture = Gesture & {
  start: number; side: "left" | "right"; worked: boolean; finished: boolean;
  grip: Vector3; axis: Vector3; elapsed: number; lastNow: number; primeClock: boolean;
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
  private readonly insertion = new Map<string, InsertionPresentation>();
  private paused = false;
  private speed = 1;
  private lastNow = 0;
  private reachWarning: string | null = null;
  private playbackState: ProcedurePlayback = { ...IDLE };
  private placements: { hand: ArticulatedHand; side: "left" | "right"; desiredWrist: Vector3; orientation: Quaternion; reach: number }[] = [];

  constructor(private readonly needles: NeedleLayer, private readonly practitioner: () => Person | null, private readonly focus: (id: string) => void) {
    this.group.name = "precision-needling";
    this.group.visible = false;
  }

  get playback(): ProcedurePlayback { return { ...this.playbackState }; }

  async load(url: string, skin: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      this.assetGeometries.add(o.geometry);
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) this.assetMaterials.add(material);
    });
    if (this.gone) { this.disposeAssets(); return; }
    this.hand = new ArticulatedHand(gltf.scene, gltf.animations, skin);
    this.supportHand = new ArticulatedHand(gltf.scene.clone(true), gltf.animations, skin);
    this.hand.root.name = "needle-hand";
    this.supportHand.root.name = "support-hand";
    this.group.add(this.hand.root, this.supportHand.root);
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
    if (!manipulationTechnique(input.technique) || !this.validSite(input.site)) return false;
    const definition = manipulationTechnique(input.technique)!;
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
      const duration = sampleProcedure("work", 0, resolveManipulationMotion(active.input.technique, active.input.motion).durationMs).durationMs;
      if (active.elapsed >= duration) { active.elapsed = 0; active.primeClock = true; }
    }
    // Seeking recorded actions would conceal ordering; only a clearly labelled local preview can be sought.
    if (control.progress !== undefined && active?.kind === "performance" && active.preview) {
      const motion = resolveManipulationMotion(active.input.technique, active.input.motion);
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
      const definition = manipulationTechnique(next.input.technique);
      if (!definition) return false;
      const grip = next.input.needleId ? this.needles.grip(next.input.needleId) : null;
      if (definition.context === "retained" && !grip) return false;
      point = grip?.point ?? next.input.site.p.clone();
      axis = grip?.axis ?? next.input.site.n.clone();
      requested = resolveManipulationMotion(next.input.technique, next.input.motion).hand;
    } else {
      const grip = this.needles.grip(next.id);
      if (!grip) return false;
      point = grip.point; axis = grip.axis;
      requested = next.presentation?.hand ?? "auto";
    }
    const side = requested !== "auto" ? requested : person.shoulderAt("left").distanceToSquared(point) < person.shoulderAt("right").distanceToSquared(point) ? "left" : "right";
    this.active = { ...next, start: now, side, worked: false, finished: false, grip: point.clone(), axis: axis.clone(), elapsed: 0, lastNow: now, primeClock: next.kind === "performance" && next.preview };
    this.actor = person;
    this.hand?.setSide(side);
    this.supportHand?.setSide(side === "left" ? "right" : "left");
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

  private renderLegacy(gesture: ActiveGesture & LegacyGesture, person: Person, now: number): void {
    const duration = resolveNeedleMotion(gesture.technique ?? "none", gesture.motion).durationMs;
    const insertionMs = gesture.kind === "insert" && gesture.presentation?.durationMs !== undefined ? finiteClamp(gesture.presentation.durationMs, 400, 8000) : undefined;
    const sample = sampleProcedure(gesture.kind, now - gesture.start, duration, insertionMs);
    if (sample.operation > 0 && !gesture.worked) {
      gesture.worked = true;
      if (gesture.kind === "work") this.needles.work(gesture.id, gesture.technique ?? "none", gesture.start + sample.operationStartMs, gesture.motion);
    }
    if (gesture.kind !== "work" && gesture.worked && !gesture.finished) {
      this.needles.progress(gesture.id, gesture.kind, Math.min(0.99999, sample.operation));
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
      const phase = sample.operating ? ((now - gesture.start - sample.operationStartMs) / duration * (gesture.motion?.cycles ?? 3)) % 1 : 0;
      hand.pose({ pose: gesture.presentation?.grip === "three-finger" ? "tripod" : "pinch", grip: sample.grip,
        apertureMm: Math.max(1.5, gesture.presentation?.gripApertureMm ?? 2), phase, rotationRad: handle?.rotation ?? 0 });
      this.placeHand(hand, person, gesture.side, gesture.grip, gesture.axis, sample.reach, "pinch", (handle?.rotation ?? 0) * 0.22);
    } else this.group.visible = false;
    const support = gesture.presentation?.support ?? "none";
    const site = this.needles.siteOf(gesture.id);
    this.placeSupport(person, gesture.side, site, support, sample.reach, sample.grip, phaseValue(now - gesture.start, duration), 0.5);
    this.settleHands(person);
    if (gesture.kind === "insert" && !gesture.worked && hand?.root.visible) this.needles.carry(gesture.id, hand.contactAt("pinch"), gesture.axis);
    this.group.visible = !!this.hand?.root.visible || !!this.supportHand?.root.visible;
    if (sample.complete) { this.finish(gesture); this.active = null; }
  }

  private renderPerformance(gesture: ActiveGesture & PerformanceGesture, person: Person | null): void {
    if (!person) return;
    const input = gesture.input, definition = manipulationTechnique(input.technique)!;
    const motion = resolveManipulationMotion(input.technique, input.motion);
    const envelope = sampleProcedure("work", gesture.elapsed, motion.durationMs);
    const elapsed = finiteClamp(gesture.elapsed - envelope.operationStartMs, 0, motion.durationMs);
    const sample = sampleTechnique(input.technique, elapsed, motion);
    // Keep the same attachment and base pose through approach and release; sampling the resting endpoint
    // would otherwise switch a scraper back to a pinch in one frame.
    const poseSample = elapsed === 0 || sample.complete ? sampleTechnique(input.technique, elapsed === 0 ? 0.001 : motion.durationMs - 0.001, motion) : sample;
    if (definition.context === "retained" && input.needleId) {
      if (!this.needles.grip(input.needleId)) { this.finish(gesture); this.active = null; return; }
      if (!gesture.worked && elapsed > 0 && !gesture.preview) {
        this.needles.workTechnique(input.needleId, input.technique, this.lastNow - elapsed, motion);
        gesture.worked = true;
      }
      this.needles.poseTechnique(input.needleId, input.technique, elapsed, motion);
    }
    const handle = definition.context === "retained" && input.needleId ? this.needles.grip(input.needleId) : null;
    const contact = handle?.point.clone() ?? input.site.p.clone().addScaledVector(input.site.uDir, sample.lateralMm.u / 1000).addScaledVector(input.site.vDir, sample.lateralMm.v / 1000);
    const axis = handle?.axis.clone() ?? input.site.n.clone();
    let anchor: HandContact = handle ? "pinch" : "index";
    if (poseSample.contact === "nail-handle" || ["zhua", "she"].includes(poseSample.phase.primitive)) anchor = "nail";
    else if (!handle && (poseSample.handPose === "press" || motion.support === "press")) anchor = "palm";
    if (handle && poseSample.handPose === "scrape") contact.addScaledVector(axis, (sample.phase.progress - 0.5) * 0.016);
    if (handle && poseSample.handPose === "flick" && !sample.nailContact) contact.addScaledVector(input.site.uDir, 0.004 * Math.sin(Math.PI * sample.phase.progress));
    if (!handle) contact.addScaledVector(input.site.n, 0.0015);
    const grip = envelope.grip * (elapsed === 0 ? 1 : sample.complete ? 1 : sample.grip);
    person.faceToward?.(input.site.p, envelope.reach);
    this.placements = [];
    this.hand?.pose({ pose: poseSample.handPose,
      grip, apertureMm: handle ? Math.max(1.5, motion.gripApertureMm) : motion.gripApertureMm, phase: (sample.phase.progress * motion.cycles) % 1,
      rotationRad: sample.rotationRad, nailContact: sample.nailContact, intensity: motion.contactIntensity });
    if (this.hand) this.placeHand(this.hand, person, gesture.side, contact, axis, envelope.reach, anchor, (handle?.rotation ?? 0) * 0.22, !handle);
    this.placeSupport(person, gesture.side, input.site, motion.support, envelope.reach, envelope.grip * sample.supportContact, sample.phase.progress, motion.contactIntensity);
    this.settleHands(person);
    this.group.visible = !!this.hand?.root.visible || !!this.supportHand?.root.visible;
    this.publish({ reachWarning: this.reachWarning, mode: gesture.preview ? "preview" : "record", playing: !this.paused && !envelope.complete,
      progress: finiteClamp(gesture.elapsed / envelope.durationMs, 0, 1), speed: this.speed,
      technique: input.technique, phase: gesture.elapsed < envelope.operationStartMs ? "Approach and grip"
        : elapsed < motion.durationMs ? sample.phase.label : envelope.complete ? "Complete" : "Release and retreat", durationMs: envelope.durationMs });
    if (envelope.complete && !gesture.preview) { this.finish(gesture); this.active = null; this.publish({ ...IDLE, speed: this.speed }); }
    else if (envelope.complete && gesture.preview) this.paused = true;
  }

  private placeHand(hand: ArticulatedHand, person: Person, side: "left" | "right", contact: Vector3, axis: Vector3, reach: number, anchor: HandContact, roll = 0, surface = false): void {
    const contactLocal = hand.contact(anchor), wristLocal = hand.wrist();
    const orientation = surface ? surfaceHandOrientation(contactLocal, wristLocal, hand.contactNormal(anchor), contact, axis, person.shoulderAt(side))
      : handOrientation(contact, axis, person.shoulderAt(side), roll);
    const wristOffset = wristLocal.sub(contactLocal).applyQuaternion(orientation);
    const desiredWrist = contact.clone().add(wristOffset);
    person.reach(side, desiredWrist, reach, orientation);
    this.placements.push({ hand, side, desiredWrist, orientation, reach });
  }

  /** Register both arms before attaching either hand: both solves must use the same final torso lean. */
  private settleHands(person: Person): void {
    const unreachable: string[] = [];
    for (const placement of this.placements) {
      const { hand, side, desiredWrist, orientation, reach } = placement;
      const result = person.reach(side, desiredWrist, reach, orientation);
      hand.root.position.copy(result.wrist).sub(hand.wrist().applyQuaternion(orientation));
      hand.root.quaternion.copy(orientation);
      hand.root.visible = person.holder.visible && reach > 0.02 && (result.reachable || reach < 0.99);
      if (reach >= 0.99 && !result.reachable) unreachable.push(side);
    }
    this.reachWarning = unreachable.length ? `Move closer: the ${unreachable.join(" and ")} hand cannot reach the selected contact.` : null;
  }

  private placeSupport(person: Person, mainSide: "left" | "right", site: SkinSite | null, support: NonNullable<InsertionPresentation["support"]>, reach: number, grip: number, phase: number, intensity: number): void {
    const side = mainSide === "left" ? "right" : "left", hand = this.supportHand;
    if (!hand || !site || support === "none") {
      if (hand) hand.root.visible = false;
      person.reach(side, null);
      return;
    }
    const pose: HandPose = support === "stretch" ? "stretch" : support === "pinch" ? "pinch" : support === "press" ? "press" : "palpate";
    hand.pose({ pose, grip, phase, apertureMm: support === "stretch" ? 8 : 2, intensity });
    // Contact remains beside the entry, toward the supporting shoulder, rather than underneath the needle.
    const tangent = person.shoulderAt(side).sub(site.p);
    tangent.addScaledVector(site.n, -tangent.dot(site.n));
    if (tangent.lengthSq() < 1e-10) tangent.copy(site.uDir);
    tangent.normalize();
    const contact = site.p.clone().addScaledVector(tangent, 0.035).addScaledVector(site.n, 0.002);
    this.placeHand(hand, person, side, contact, site.n, reach, support === "press" ? "palm" : support === "pinch" ? "pinch" : "index", 0, true);
  }

  private finish(gesture: ActiveGesture): void {
    if (gesture.kind === "performance" && gesture.input.needleId) this.needles.clearTechnique(gesture.input.needleId);
    this.clearHands();
    this.insertion.delete(gesture.id);
  }

  private clearHands(): void {
    this.placements = [];
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
    this.assetGeometries.clear(); this.assetMaterials.clear();
  }

  dispose(): void {
    this.gone = true;
    this.reset();
    this.hand?.dispose();
    this.supportHand?.dispose();
    this.disposeAssets();
    this.group.removeFromParent();
  }
}

const phaseValue = (elapsed: number, duration: number) => duration > 0 ? (Math.max(0, elapsed) / duration) % 1 : 0;
