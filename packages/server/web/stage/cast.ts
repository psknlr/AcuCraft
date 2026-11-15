import { Group, Vector3 } from "three";
import { buildPerson, disposeRig, PLAIN_WEAR, setBlink, setBreath, setDistressed, setMouth, type AppearanceLike, type PersonOptions, type PersonRig } from "@clinicalcraft/web/world/npc.js";
import { breathOf } from "@clinicalcraft/web/world/manikin.js";
import { CONSULT, COUCH_TOP, SEAT_TOP, TREATMENT } from "./set.js";
import type { StageInfo } from "./types.js";

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
  private route: Vector3[] = [];
  private readonly restY: number;
  private readonly restRoll: number;
  private walkAttempt = -1;
  private targetRot = 0;
  private lookTarget: Vector3 | null = null;
  private stride = 0;
  private blinkAt: number;
  private blinkPhase = -1;
  private speakingUntil = 0;
  private speech = 0;
  private readonly breathPhase: number;

  constructor(appearance: AppearanceLike, readonly placement: Placement) {
    this.rig = buildPerson(appearance, placement.options);
    this.holder.add(this.rig.root);
    this.restY = this.rig.body.position.y;
    this.restRoll = this.rig.body.rotation.z;
    this.rig.root.position.set(placement.at.x, placement.at.y, placement.at.z);
    this.rig.root.rotation.y = placement.at.rot * DEG;
    this.rig.root.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh && o.visible) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.breathPhase = (this.rig.phase * 7.3) % 1;
    this.blinkAt = 900 + this.rig.phase * 2600;
  }

  /** Keep the same geometry while moving. Follow recorded corners instead of cutting through furniture. */
  moveTo(at: Placement["at"], walk: import("@acucraft/core").WalkRecord | undefined, animate: boolean): void {
    this.targetRot = at.rot * DEG;
    this.placement.at = { ...at };
    if (animate && walk && walk.attempt !== this.walkAttempt && this.placement.options.posture === "standing") {
      this.walkAttempt = walk.attempt;
      this.rig.root.position.set(walk.from.x, 0, walk.from.z);
      this.route = [...walk.path, walk.to].map(p => new Vector3(p.x, 0, p.z));
    } else if (!animate || !this.route.length) {
      this.walkAttempt = walk?.attempt ?? this.walkAttempt;
      this.route = [];
      this.rig.root.position.set(at.x, at.y, at.z);
      this.rig.root.rotation.y = this.targetRot;
    }
  }

  lookAt(target: Vector3): void { this.lookTarget = target; }

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

  tick(now: number, dt: number): void {
    let budget = Math.min(dt, 100) / 1000 * 1.2;
    const walking = this.route.length > 0;
    while (this.route.length && budget > 0) {
      const to = this.route[0]!;
      const delta = to.clone().sub(this.rig.root.position);
      const distance = delta.length();
      if (distance < 1e-5) { this.route.shift(); continue; }
      const step = Math.min(distance, budget);
      this.rig.root.position.addScaledVector(delta, step / distance);
      this.rig.root.rotation.y = Math.atan2(delta.x, delta.z);
      budget -= step;
      this.stride += step * 5.7;
      if (step >= distance) this.route.shift();
    }
    this.rig.body.position.y = this.restY + (walking ? Math.abs(Math.sin(this.stride)) * 0.025 : 0);
    this.rig.body.rotation.z = this.restRoll + (walking ? Math.sin(this.stride) * 0.02 : 0);
    if (!this.route.length) this.rig.root.rotation.y = this.targetRot || this.placement.at.rot * DEG;
    if (this.lookTarget && !walking) {
      const local = this.rig.root.worldToLocal(this.lookTarget.clone());
      const yaw = Math.max(-0.45, Math.min(0.45, Math.atan2(local.x, local.z)));
      this.rig.head.rotation.y += (yaw - this.rig.head.rotation.y) * Math.min(1, dt / 180);
    }
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
