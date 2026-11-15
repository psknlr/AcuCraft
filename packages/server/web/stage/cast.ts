import { Group, Quaternion, Vector3 } from "three";
import { buildPerson, disposeRig, PLAIN_WEAR, setBlink, setBreath, setDistressed, setMouth, type AppearanceLike, type PersonOptions, type PersonRig } from "@clinicalcraft/web/world/npc.js";
import { breathOf } from "@clinicalcraft/web/world/manikin.js";
import { CONSULT, COUCH_TOP, SEAT_TOP, TREATMENT } from "./set.js";
import type { StageInfo } from "./types.js";
import { AvatarRig, type HandSide, type ReachResult } from "./rig.js";
import { turnTowards } from "./kinematics.js";

/**
 * The people of the encounter as the 3D world draws people (ClinicalCraft's figure kit): the patient as their case
 * describes them, built to their height, in the position the record has them in — sitting at the consultation
 * desk, standing, or on the couch on their back, face down or on one side, bare under towels as on a treatment
 * couch; and the practitioner, in a white coat, beside them. They breathe, blink, and the patient's mouth moves
 * while they speak.
 */

export type SetName = "consult" | "treatment";

/** Where and how a person is: the set, the figure's posture and options, and where the figure's root stands. */
export interface Placement {
  set: SetName;
  options: PersonOptions;
  at: { x: number; y: number; z: number; rot: number };
  /** For the patient: their position on the record (as the figure's posture cannot say all of it). */
  position: string;
}

const DEG = Math.PI / 180;

/** The patient's placement for their position and the room they are in. */
export function patientPlacement(position: string, location: string, heightCm: number | null, seed: string): Placement {
  const height = heightCm ? heightCm / 174 : 1;
  const base = { seed, height } as const;
  const lyingDown = position.startsWith("supine") || position === "prone" || position.startsWith("side-lying");
  const set: SetName = lyingDown || /treat|couch|bay/.test(location) ? "treatment" : "consult";
  const couch = TREATMENT.couch;
  if (position === "prone") return { set, position, options: { ...base, posture: "prone", surfaceY: COUCH_TOP, cover: "towels" }, at: { x: couch.x, y: 0, z: couch.z - 0.15, rot: 0 } };
  if (position.startsWith("supine")) return { set, position, options: { ...base, posture: "lying", surfaceY: COUCH_TOP, cover: "towels" }, at: { x: couch.x, y: 0, z: couch.z - 0.05, rot: 0 } };
  if (position.startsWith("side-lying")) {
    // lying on the left side: the right is up
    const up = position === "side-lying-left" ? "right" : "left";
    return { set, position, options: { ...base, posture: "lateral", surfaceY: COUCH_TOP, up, cover: "blanket", flex: 0 }, at: { x: couch.x, y: 0, z: couch.z - 0.05, rot: 0 } };
  }
  if (position === "standing") {
    const spot = set === "treatment" ? { x: couch.x + 0.75, z: couch.z + 1.15, rot: -150 } : { x: CONSULT.patientChair.x + 0.55, z: CONSULT.patientChair.z + 0.35, rot: 180 };
    return { set, position, options: { ...base, posture: "standing" }, at: { x: spot.x, y: 0, z: spot.z, rot: spot.rot } };
  }
  // seated (or seated leaning forward): on the patient's chair of the room
  const chair = set === "treatment" ? TREATMENT.chair : CONSULT.patientChair;
  return { set, position, options: { ...base, posture: "sitting", surfaceY: SEAT_TOP }, at: { x: chair.x, y: 0, z: chair.z, rot: chair.rot } };
}

/** The practitioner's placement: beside the couch on the side being worked, or at the desk. */
export function practitionerPlacement(set: SetName, side: 1 | -1, along: number, seed: string): Placement {
  if (set === "consult") {
    const c = CONSULT.practitionerChair;
    return { set, position: "seated", options: { posture: "sitting", surfaceY: SEAT_TOP, seed, wear: COAT }, at: { x: c.x, y: 0, z: c.z, rot: c.rot } };
  }
  const couch = TREATMENT.couch;
  const z = Math.min(0.62, Math.max(-0.55, along));
  return { set, position: "standing", options: { posture: "standing", seed, wear: COAT }, at: { x: couch.x + side * 0.66, y: 0, z: couch.z + z, rot: side > 0 ? -90 : 90 } };
}

/** A white coat over a shirt, as a TCM physician wears in clinic. */
const COAT = { ...PLAIN_WEAR, top: "shirt" as const, over: "coat" as const, shoes: "leather" as const, badge: true, pens: true };

/** One person of the scene, animated. */
export class Person {
  readonly rig: PersonRig;
  readonly holder = new Group();
  private blinkAt: number;
  private blinkPhase = -1;
  private speakingUntil = 0;
  private speech = 0;
  private readonly breathPhase: number;
  private readonly animation: AvatarRig | null;
  private route: { x: number; z: number }[] = [];
  private destination: Placement["at"];
  private gestureFacing: number | null = null;

  constructor(appearance: AppearanceLike, readonly placement: Placement) {
    this.rig = buildPerson(appearance, placement.options);
    this.holder.add(this.rig.root);
    this.rig.root.position.set(placement.at.x, placement.at.y, placement.at.z);
    this.rig.root.rotation.y = placement.at.rot * DEG;
    this.destination = { ...placement.at };
    this.animation = placement.options.posture === "standing" ? new AvatarRig(this.rig) : null;
    this.rig.root.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh && o.visible) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.breathPhase = (this.rig.phase * 7.3) % 1;
    this.blinkAt = 900 + this.rig.phase * 2600;
  }

  /** Where the head is (world), for the camera. */
  headAt(): Vector3 {
    return this.rig.head.getWorldPosition(new Vector3());
  }

  /** Where the middle of the body is (world). */
  centre(): Vector3 {
    return this.rig.body.getWorldPosition(new Vector3()).add(new Vector3(0, 0, 0));
  }

  speak(ms: number, now: number): void {
    this.speakingUntil = Math.max(this.speakingUntil, now + ms);
  }

  distress(on: boolean): void {
    if (this.rig.distressed !== on) setDistressed(this.rig, on);
  }

  /** Follow the world's already validated polyline. New walks can arrive while the previous one is being drawn. */
  moveTo(at: Placement["at"], path: { x: number; z: number }[] = [], animate = true): void {
    this.gestureFacing = null;
    const old = this.destination;
    this.destination = { ...at };
    Object.assign(this.placement.at, at);
    if (!animate || !this.animation) {
      this.route = [];
      this.rig.root.position.set(at.x, at.y, at.z);
      this.rig.root.rotation.y = at.rot * DEG;
      return;
    }
    if (Math.hypot(old.x - at.x, old.z - at.z) < 0.001) return;
    const points = path.length ? path.map((p) => ({ ...p })) : [{ x: at.x, z: at.z }];
    const end = points[points.length - 1]!;
    if (Math.hypot(end.x - at.x, end.z - at.z) > 0.001) points.push({ x: at.x, z: at.z });
    // An action stream can be much faster than the animation: preserve the preceding planned corners.
    if (!this.route.length || !path.length || Math.hypot(points[0]!.x - old.x, points[0]!.z - old.z) > 0.08) this.route = [];
    this.route.push(...points);
  }

  get isMoving(): boolean {
    return this.route.length > 0;
  }

  /** A presentation turn on the spot toward the working hands. The feet's floor position never changes. */
  faceToward(target: Vector3 | null, blend = 1): void {
    if (!target || this.isMoving) { this.gestureFacing = null; return; }
    const at = this.rig.root.position;
    const yaw = Math.atan2(target.x - at.x, target.z - at.z);
    this.gestureFacing = turnTowards(this.destination.rot * DEG, yaw, Math.max(0, Math.min(1, blend)));
    this.rig.root.rotation.y = this.gestureFacing;
    this.rig.root.updateMatrixWorld(true);
  }

  shoulderAt(side: HandSide): Vector3 {
    return this.animation?.shoulderAt(side) ?? this.rig.body.getWorldPosition(new Vector3());
  }

  wristAt(side: HandSide): Vector3 {
    return this.animation?.wristAt(side) ?? this.shoulderAt(side);
  }

  /** Request a hand target in world space. The returned wrist is clamped to the person's own arm lengths. */
  reach(side: HandSide, wristWorld: Vector3 | null, blend = 1, palmQuat?: Quaternion): ReachResult {
    return this.animation?.reach(side, wristWorld, blend, palmQuat) ?? { wrist: this.wristAt(side), elbow: this.shoulderAt(side), reachable: false };
  }

  private walk(dt: number): number {
    const position = this.rig.root.position;
    let budget = Math.max(0, Math.min(100, dt)) * 0.0011;
    let travelled = 0;
    while (this.route.length && budget > 0) {
      const point = this.route[0]!;
      const dx = point.x - position.x, dz = point.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.001) { this.route.shift(); continue; }
      const step = Math.min(budget, distance);
      position.x += dx / distance * step;
      position.z += dz / distance * step;
      this.rig.root.rotation.y = turnTowards(this.rig.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt / 120));
      budget -= step;
      travelled += step;
      if (step >= distance - 1e-6) this.route.shift();
    }
    if (!this.route.length) {
      position.y = this.destination.y;
      this.rig.root.rotation.y = turnTowards(this.rig.root.rotation.y, this.gestureFacing ?? this.destination.rot * DEG, Math.min(1, dt / 140));
    }
    return travelled;
  }

  tick(now: number, dt: number): void {
    const travelled = this.walk(dt);
    this.animation?.tick(dt, travelled, this.isMoving);
    const o = this.placement.options;
    const breathing = { breathing: "both" as const, posture: o.posture, cover: o.cover ?? "clothes" };
    const [depth, rise] = breathOf(breathing as Parameters<typeof breathOf>[0], now, this.breathPhase);
    setBreath(this.rig, depth, rise);
    // blinking: every few seconds, a little more often when speaking
    if (this.blinkPhase < 0 && now >= this.blinkAt) this.blinkPhase = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / 170;
      const shut = this.blinkPhase < 1 ? Math.sin(this.blinkPhase * Math.PI) : 0;
      setBlink(this.rig, shut);
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkAt = now + 1800 + ((Math.sin(now * 0.0137 + this.rig.phase * 40) + 1) / 2) * 3800;
      }
    }
    // the jaw while speaking: syllables at four or five a second
    const target = now < this.speakingUntil ? 0.35 + 0.35 * Math.abs(Math.sin(now / 105 + Math.sin(now / 47))) : 0;
    this.speech += (target - this.speech) * Math.min(1, dt / 60);
    setMouth(this.rig, this.speech);
  }

  dispose(): void {
    this.holder.remove(this.rig.root);
    disposeRig(this.rig);
  }
}

/** The patient's appearance for their figure, in the gown or clothes their case gives. */
export function patientAppearance(info: StageInfo): AppearanceLike {
  return { ...(info.patient.appearance as AppearanceLike) };
}

export function practitionerAppearance(info: StageInfo): AppearanceLike {
  return { ...(info.practitioner.appearance as AppearanceLike) };
}
