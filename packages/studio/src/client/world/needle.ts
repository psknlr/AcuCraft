import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * A filiform needle and the ways it is worked (docs/TECHNIQUE.md), drawn as it is done: lifting and thrusting moves
 * the shaft along its line by the amplitude given, at the rate given, quicker on the stroke that is emphasised;
 * twirling turns the handle through the arc given, back and forth or one way; scraping runs a nail up the wound
 * handle; flicking, shaking and trembling each move as their names say. The parameters are those of the action the
 * engine executed — the picture is of what was done, not of an effect.
 */

export interface Motion {
  technique: string;
  amplitudeMm?: number | undefined;
  frequencyPerMin?: number | undefined;
  arcDeg?: number | undefined;
  durationSec?: number | undefined;
  direction?: string | undefined;
  emphasis?: string | undefined;
}

const HANDLE_CM = 2.4;
const steel = new THREE.MeshStandardMaterial({ color: "#d9dee2", metalness: 1, roughness: 0.2, envMapIntensity: 1.6 });
const copper = new THREE.MeshStandardMaterial({ color: "#c98a5b", metalness: 1, roughness: 0.32, envMapIntensity: 1.4 });
// every needle's shaft is of the one steel: a needle that is taken away leaves it to the others
steel.userData.shared = true;

function coil(radius: number, wire: number, length: number): THREE.BufferGeometry {
  const turns = Math.round(length / (wire * 1.9));
  const rings: THREE.BufferGeometry[] = [];
  for (let i = 0; i < turns; i++) {
    const g = new THREE.TorusGeometry(radius, wire, 6, 14);
    g.rotateX(Math.PI / 2);
    g.translate(0, (i + 0.5) * (length / turns), 0);
    rings.push(g);
  }
  const loop = new THREE.TorusGeometry(radius * 1.7, wire, 6, 16);
  loop.translate(0, length + radius * 1.6, 0);
  rings.push(loop);
  return mergeGeometries(rings, false)!;
}

type Anim =
  | { kind: "work"; m: Motion; t: number; dur: number }
  | { kind: "insert"; t: number; dur: number; from: number; to: number; tube: boolean }
  | { kind: "withdraw"; t: number; dur: number; from: number; press: boolean; done: () => void };

export class NeedleModel {
  /** Origin at the entry point on the skin; the needle travels along local −Y. */
  readonly group = new THREE.Group();
  private tilt = new THREE.Group();
  private slider = new THREE.Group();
  private spinner = new THREE.Group();
  private nail: THREE.Mesh;
  private tube: THREE.Mesh;
  private swab: THREE.Mesh;
  private handleMaterial: THREE.MeshStandardMaterial;
  private anim: Anim | null = null;
  private depthCm = 1;
  readonly lengthCm: number;
  /** Lift (cm) and turn (rad) given from outside: the operator's hand on the needle. */
  manual: { lift: number; turn: number } | null = null;

  /** `unit`: scene units to the centimetre; `thick`: how many times the true diameter the shaft is drawn. */
  constructor(spec: { diameterMm: number; lengthMm: number }, unit: number, thick: number) {
    this.lengthCm = spec.lengthMm / 10;
    const r = (spec.diameterMm / 20) * thick;
    this.group.scale.setScalar(unit);
    this.group.add(this.tilt);
    this.tilt.add(this.slider);
    this.slider.add(this.spinner);
    // the shaft, tapering to its point over the last millimetres
    const shaft = new THREE.CylinderGeometry(r, r, this.lengthCm - 0.25, 10);
    shaft.translate(0, 0.25 + (this.lengthCm - 0.25) / 2, 0);
    const point = new THREE.ConeGeometry(r, 0.25, 10);
    point.rotateX(Math.PI);
    point.translate(0, 0.125, 0);
    const body = new THREE.Mesh(mergeGeometries([shaft, point], false)!, steel);
    body.castShadow = true;
    this.spinner.add(body);
    this.handleMaterial = copper.clone();
    const handle = new THREE.Mesh(coil(r * 2.3, r * 0.9, HANDLE_CM), this.handleMaterial);
    handle.position.y = this.lengthCm;
    handle.castShadow = true;
    this.spinner.add(handle);
    // a mark on the handle, so a turn can be seen
    const flag = new THREE.Mesh(new THREE.SphereGeometry(r * 1.5, 10, 8), new THREE.MeshStandardMaterial({ color: "#f3f1ea", roughness: 0.4 }));
    flag.position.set(r * 3.4, this.lengthCm + HANDLE_CM * 0.5, 0);
    this.spinner.add(flag);
    this.nail = new THREE.Mesh(new THREE.CapsuleGeometry(r * 3.2, r * 4, 4, 10), new THREE.MeshPhysicalMaterial({ color: "#f1d9cc", roughness: 0.35, clearcoat: 0.6 }));
    this.nail.visible = false;
    this.slider.add(this.nail);
    this.tube = new THREE.Mesh(new THREE.CylinderGeometry(r * 5, r * 5, this.lengthCm - 0.4, 16, 1, true), new THREE.MeshPhysicalMaterial({ color: "#eaf4f6", roughness: 0.08, transmission: 0.85, thickness: 0.05, transparent: true, side: THREE.DoubleSide }));
    this.tube.position.y = (this.lengthCm - 0.4) / 2;
    this.tube.visible = false;
    this.group.add(this.tube);
    this.swab = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 10), new THREE.MeshStandardMaterial({ color: "#fbfbf8", roughness: 1 }));
    this.swab.scale.set(1, 0.45, 1);
    this.swab.visible = false;
    this.group.add(this.swab);
    this.setDepth(1);
  }

  /** Point the needle: `angleDeg` from the perpendicular, towards `azimuthDeg` (0 = +v, 90 = +u), in a frame where +x is u, +y is out of the skin and −z is +v. */
  aim(angleDeg: number, azimuthDeg: number): void {
    const theta = (angleDeg * Math.PI) / 180;
    const phi = (azimuthDeg * Math.PI) / 180;
    const travel = new THREE.Vector3(Math.sin(theta) * Math.sin(phi), -Math.cos(theta), -Math.sin(theta) * Math.cos(phi));
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), travel.normalize());
  }

  /** How much of the shaft is in the tissue (cm along the shaft). */
  setDepth(depthCm: number): void {
    this.depthCm = Math.max(0, Math.min(this.lengthCm * 0.95, depthCm));
    if (!this.anim || this.anim.kind === "work") this.slider.position.y = -this.depthCm;
  }

  /** The handle shows that the needle is bound. */
  setStuck(stuck: boolean): void {
    this.handleMaterial.emissive.set(stuck ? "#ff3b1f" : "#000000");
    this.handleMaterial.emissiveIntensity = stuck ? 0.9 : 0;
  }

  setHighlight(on: boolean): void {
    if (this.handleMaterial.emissiveIntensity > 0.5) return;
    this.handleMaterial.emissive.set(on ? "#ffd27a" : "#000000");
    this.handleMaterial.emissiveIntensity = on ? 0.35 : 0;
  }

  get busy(): boolean {
    return this.anim !== null;
  }

  /** Is it going in or coming out (it cannot be taken hold of then)? */
  get travelling(): boolean {
    return this.anim !== null && this.anim.kind !== "work";
  }

  /** Stop showing a working (the hand has taken the needle). */
  still(): void {
    if (this.anim?.kind === "work") this.anim = null;
  }

  play(m: Motion): void {
    // a long working is shown at its true rate, for a few seconds of it
    this.anim = { kind: "work", m, t: 0, dur: THREE.MathUtils.clamp(m.durationSec ?? 3, 1.4, 5) };
  }

  playInsert(speed: string, method: string): void {
    const tube = method === "tube";
    this.anim = { kind: "insert", t: 0, dur: speed === "slow" ? 1.5 : 0.45, from: 0.6, to: -this.depthCm, tube };
    this.tube.visible = tube;
    this.slider.position.y = 0.6;
  }

  playWithdraw(speed: string, press: boolean, done: () => void): void {
    this.anim = { kind: "withdraw", t: 0, dur: speed === "slow" ? 1.6 : 0.45, from: this.slider.position.y, press, done };
  }

  /** Advance by `dt` seconds. */
  update(dt: number, clock: number): void {
    const a = this.anim;
    this.tilt.rotation.set(0, 0, 0);
    this.nail.visible = false;
    if (!a) {
      if (this.manual) {
        this.slider.position.y = -this.depthCm + this.manual.lift;
        this.spinner.rotation.y = this.manual.turn;
      } else {
        this.slider.position.y = -this.depthCm;
        // a needle at rest keeps the turn it was left with
      }
      return;
    }
    a.t += dt;
    const k = Math.min(1, a.t / a.dur);
    if (a.kind === "insert") {
      // through the skin at once, then on to the depth
      const e = a.dur < 1 ? 1 - (1 - k) ** 3 : k * k * (3 - 2 * k);
      this.slider.position.y = a.from + (a.to - a.from) * e;
      if (a.tube) (this.tube.material as THREE.Material).opacity = 1 - Math.max(0, k - 0.7) / 0.3;
      if (k >= 1) {
        this.tube.visible = false;
        this.anim = null;
      }
      return;
    }
    if (a.kind === "withdraw") {
      const e = a.dur < 1 ? k * k : k;
      this.slider.position.y = a.from + (0.8 + this.lengthCm - a.from) * e;
      this.swab.visible = a.press;
      this.swab.position.set(0.5, 0.2, 0.2);
      if (k >= 1) {
        this.anim = null;
        this.swab.visible = false;
        a.done();
      }
      return;
    }
    const m = a.m;
    const fade = Math.min(1, a.t * 6, (a.dur - a.t) * 6);
    const hz = (m.frequencyPerMin ?? 60) / 60;
    const p = (a.t * hz) % 1;
    let lift = 0;
    switch (m.technique) {
      case "lift-thrust": {
        const amp = (m.amplitudeMm ?? 3) / 10;
        // the emphasised stroke is the quick, forceful one
        const up = m.emphasis === "thrust" ? 0.68 : m.emphasis === "lift" ? 0.32 : 0.5;
        const w = p < up ? p / up : 1 - (p - up) / (1 - up);
        lift = amp * (0.5 - 0.5 * Math.cos(w * Math.PI)) * fade;
        break;
      }
      case "rotate": {
        const arc = ((m.arcDeg ?? 180) * Math.PI) / 180;
        if (m.direction === "clockwise" || m.direction === "counter-clockwise") this.spinner.rotation.y = (m.direction === "clockwise" ? -1 : 1) * arc * (k * k * (3 - 2 * k));
        else this.spinner.rotation.y = (arc / 2) * Math.sin(a.t * hz * Math.PI * 2) * fade;
        break;
      }
      case "tremble":
        lift = 0.035 * Math.sin(clock * 58) * fade;
        this.spinner.rotation.y += 0.12 * Math.sin(clock * 71) * fade;
        break;
      case "shake":
        this.tilt.rotation.z = 0.085 * Math.sin(a.t * Math.PI * 5) * fade;
        this.tilt.rotation.x = 0.05 * Math.cos(a.t * Math.PI * 5) * fade;
        break;
      case "flick": {
        const since = a.t % 0.9;
        this.tilt.rotation.z = 0.13 * Math.exp(-since * 5) * Math.sin(since * 46);
        break;
      }
      case "scrape": {
        const since = (a.t % 0.6) / 0.6;
        this.nail.visible = true;
        this.nail.position.set(0.11, this.depthCm * 0 + this.lengthCm + since * HANDLE_CM, 0);
        lift = 0.012 * Math.sin(clock * 90) * fade;
        break;
      }
      default:
        break;
    }
    this.slider.position.y = -this.depthCm + lift;
    if (k >= 1) this.anim = null;
  }
}
