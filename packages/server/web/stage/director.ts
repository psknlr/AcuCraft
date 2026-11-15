import { PerspectiveCamera, Raycaster, Vector3, type Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraMode } from "./types.js";

/**
 * The camera. In `auto` it is directed: a shot of the room when the patient moves, the patient's face while they
 * speak, a close view of each needle as it goes in, then back to the patient — each move eased like a camera on
 * a dolly. The viewer can take it at any time (drag, scroll): it is then `free` until given back.
 */

export interface Shot {
  eye: Vector3;
  at: Vector3;
  /** How long the move takes (ms). */
  ms?: number;
  /** How long to hold before the director may move on by itself (ms; 0: stay). */
  hold?: number;
  /** Lens (degrees of vertical field of view). */
  fov?: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Director {
  readonly controls: OrbitControls;
  mode: CameraMode = "auto";
  onMode: (mode: CameraMode) => void = () => {};
  private move: { from: Shot; to: Shot; start: number; ms: number } | null = null;
  private holdUntil = 0;
  private home: () => Shot = () => ({ eye: new Vector3(2.2, 1.9, 2.6), at: new Vector3(0, 0.7, 0) });
  private touched = false;
  private readonly lastSway = new Vector3();

  constructor(private readonly camera: PerspectiveCamera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 0.18;
    this.controls.maxDistance = 6.5;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.8;
    this.controls.panSpeed = 0.6;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("start", () => {
      this.touched = true;
      this.move = null;
      if (this.mode !== "free") {
        this.mode = "free";
        this.onMode(this.mode);
      }
    });
  }

  /** What a shot must see past (the set, the people): a camera is never put behind a curtain or inside a wall. */
  obstacles: () => Object3D[] = () => [];
  private readonly sight = new Raycaster();

  /**
   * The shot, or one swung round its subject until nothing stands between the eye and what it looks at: the same
   * distance, turned 35°, 70°, 110° and 150° either way, then raised — the first clear one.
   */
  clear(shot: Shot): Shot {
    const objects = this.obstacles();
    if (!objects.length) return shot;
    // the subject and a margin round it must be in sight: five rays, to its centre and round it
    const blockedRay = (from: Vector3, eye: Vector3) => {
      const dir = eye.clone().sub(from);
      const far = dir.length();
      dir.normalize();
      this.sight.set(from.clone().addScaledVector(dir, 0.06), dir);
      this.sight.far = Math.max(0, far - 0.06);
      return this.sight.intersectObjects(objects, true).some((h) => (h.object as { isMesh?: boolean }).isMesh && h.object.visible);
    };
    const blocked = (eye: Vector3) => {
      const look = shot.at.clone().sub(eye).normalize();
      const side = new Vector3().crossVectors(look, new Vector3(0, 1, 0)).normalize();
      const up = new Vector3().crossVectors(side, look).normalize();
      const r = Math.min(0.35, eye.distanceTo(shot.at) * 0.18);
      return [shot.at, shot.at.clone().addScaledVector(side, r), shot.at.clone().addScaledVector(side, -r), shot.at.clone().addScaledVector(up, r * 0.6), shot.at.clone().addScaledVector(up, -r * 0.6)].some((p) => blockedRay(p, eye));
    };
    if (!blocked(shot.eye)) return shot;
    const offset = shot.eye.clone().sub(shot.at);
    for (const lift of [0, 0.25, 0.5]) {
      for (const deg of [35, -35, 70, -70, 110, -110, 150, -150]) {
        const a = (deg * Math.PI) / 180;
        const o = new Vector3(offset.x * Math.cos(a) - offset.z * Math.sin(a), offset.y + lift, offset.x * Math.sin(a) + offset.z * Math.cos(a));
        const eye = shot.at.clone().add(o);
        if (eye.y > 0.25 && !blocked(eye)) return { ...shot, eye };
      }
    }
    return shot;
  }

  /** The shot the director returns to when nothing else is happening. */
  setHome(home: () => Shot): void {
    this.home = home;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.onMode(mode);
    if (mode === "auto") this.cut(this.home(), 1400);
  }

  /** Move to a shot (in `auto`; `force` also in `free`, as when the viewer asks for it). */
  cut(shot: Shot, ms = shot.ms ?? 1300, force = false): void {
    if (this.mode !== "auto" && !force) return;
    shot = this.clear(shot);
    const from: Shot = { eye: this.camera.position.clone(), at: this.controls.target.clone(), fov: this.camera.fov };
    this.move = { from, to: { ...shot, fov: shot.fov ?? from.fov }, start: performance.now(), ms: Math.max(1, ms) };
    this.holdUntil = performance.now() + ms + (shot.hold ?? 0);
  }

  /** Put the camera on a shot at once (the first frame). */
  place(shot: Shot): void {
    shot = this.clear(shot);
    this.move = null;
    this.camera.position.copy(shot.eye);
    this.controls.target.copy(shot.at);
    if (shot.fov) {
      this.camera.fov = shot.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /** Whether a held shot has run its time (the director may return home). */
  get idle(): boolean {
    return this.mode === "auto" && !this.move && performance.now() > this.holdUntil;
  }

  /** A shot of a point on the body, from outside it along its normal, leaning towards where the camera is. */
  closeOn(p: Vector3, n: Vector3, distance = 0.78): Shot {
    const toCam = this.camera.position.clone().sub(p).normalize();
    const dir = n.clone().multiplyScalar(0.62).add(toCam.multiplyScalar(0.55)).add(new Vector3(0, 0.3, 0)).normalize();
    // never from below: a site facing the couch (the back of a hand lying palm up) is looked at from above it
    if (dir.y < 0.45) {
      dir.y = 0.45;
      dir.normalize();
    }
    return { eye: p.clone().addScaledVector(dir, distance), at: p.clone(), ms: 1300, hold: 3800, fov: 30 };
  }

  /** How far the camera is from what it looks at (for the lens's focus). */
  get focusDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  update(): void {
    // held still in auto, the camera breathes a little, as one held by hand does
    if (this.mode === "auto" && !this.move) {
      const t = performance.now() / 1000;
      const sway = new Vector3(Math.sin(t * 0.37) * 0.0025, Math.sin(t * 0.29 + 1.3) * 0.0018, Math.cos(t * 0.31) * 0.0022);
      this.camera.position.add(sway.sub(this.lastSway));
      this.lastSway.copy(new Vector3(Math.sin(t * 0.37) * 0.0025, Math.sin(t * 0.29 + 1.3) * 0.0018, Math.cos(t * 0.31) * 0.0022));
    }
    if (this.move) {
      const k = Math.min(1, (performance.now() - this.move.start) / this.move.ms);
      const e = ease(k);
      const { from, to } = this.move;
      // the eye travels a gentle arc (it rises a little mid-way), the aim straight
      const lift = Math.sin(Math.PI * e) * Math.min(0.35, from.eye.distanceTo(to.eye) * 0.12);
      this.camera.position.lerpVectors(from.eye, to.eye, e).add(new Vector3(0, lift, 0));
      this.controls.target.lerpVectors(from.at, to.at, e);
      const fov = (from.fov ?? 38) + ((to.fov ?? 38) - (from.fov ?? 38)) * e;
      if (Math.abs(fov - this.camera.fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      if (k >= 1) this.move = null;
    }
    this.controls.update();
    void this.touched;
  }

  dispose(): void {
    this.controls.dispose();
  }
}
