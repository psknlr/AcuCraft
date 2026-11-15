import { AnimationMixer, Group, LoopOnce, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3, type AnimationAction } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { resolveNeedleMotion, type NeedleMotionSettings, type NeedleTechnique } from "@acucraft/core";
import type { Person } from "./cast.js";
import type { NeedleLayer } from "./needles.js";
import { sampleProcedure, type ProcedureKind } from "./choreography.js";

interface Gesture {
  id: string;
  kind: ProcedureKind;
  technique?: NeedleTechnique;
  motion?: NeedleMotionSettings;
}

/**
 * One continuous hand-to-handle performance at a time: approach, pinch, needle motion, release, retreat.
 * Blender supplies the articulated fingers; the figure's two-bone IK supplies the arm. All events come from
 * successful engine actions. Loading an existing record draws its final state without replaying an old gesture.
 */
export class NeedleProcedure {
  readonly group = new Group();
  private queue: Gesture[] = [];
  private active: (Gesture & { start: number; side: "left" | "right"; worked: boolean; finished: boolean; grip: Vector3; axis: Vector3 }) | null = null;
  private hand: Group | null = null;
  private open: AnimationAction | null = null;
  private mixer: AnimationMixer | null = null;
  private readonly wrist = new Vector3(0.162, 0.004, 0);
  private gone = false;
  private actor: Person | null = null;
  private readonly ownedMaterials: MeshStandardMaterial[] = [];

  constructor(private readonly needles: NeedleLayer, private readonly practitioner: () => Person | null, private readonly focus: (id: string) => void) {
    this.group.name = "precision-needling";
  }

  async load(url: string, skin: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (this.gone) {
      gltf.scene.traverse((o) => { if (o instanceof Mesh) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); } });
      return;
    }
    this.hand = gltf.scene;
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof MeshStandardMaterial) {
          if (m.name === "hand_skin") m.color.set(skin);
          this.ownedMaterials.push(m);
        }
      }
    });
    this.group.add(gltf.scene);
    this.group.visible = false;
    this.mixer = new AnimationMixer(gltf.scene);
    const clip = gltf.animations.find((a) => a.name === "hand_open");
    if (clip) {
      this.open = this.mixer.clipAction(clip);
      this.open.setLoop(LoopOnce, 1);
      this.open.clampWhenFinished = true;
      this.open.play();
      this.open.paused = true;
    }
  }

  /** Catch insertion/removal transitions, including compound removal and field events. */
  sync(): void {
    for (const transition of this.needles.transitions()) {
      if (this.active?.id === transition.id && this.active.kind === transition.kind) continue;
      if (!this.queue.some((g) => g.id === transition.id && g.kind === transition.kind)) this.queue.push(transition);
    }
  }

  work(id: string, technique: NeedleTechnique, motion?: NeedleMotionSettings): void {
    this.sync();
    this.queue.push({ id, kind: "work", technique, motion });
  }

  reset(): void {
    this.queue = [];
    this.active = null;
    this.actor?.reach("left", null);
    this.actor?.reach("right", null);
    this.actor = null;
    this.group.visible = false;
  }

  tick(now: number): void {
    const person = this.practitioner();
    if (this.actor && person !== this.actor) this.reset();
    if (!this.active && person && !person.isMoving) {
      let next: Gesture | undefined;
      while ((next = this.queue.shift())) {
        const grip = this.needles.grip(next.id);
        if (!grip) continue;
        const side = person.shoulderAt("left").distanceToSquared(grip.point) < person.shoulderAt("right").distanceToSquared(grip.point) ? "left" : "right";
        this.active = { ...next, start: now, side, worked: false, finished: false, grip: grip.point, axis: grip.axis };
        if (this.hand) this.hand.scale.z = side === "left" ? -1 : 1;
        this.actor = person;
        this.focus(next.id);
        break;
      }
    }
    const gesture = this.active;
    if (!gesture || !person) return;
    if (person.isMoving) {
      // A newer authoritative move cancels the reach; settle the visual needle before following that path.
      if (gesture.kind !== "work") this.needles.progress(gesture.id, gesture.kind, 1);
      person.reach(gesture.side, null);
      this.active = null;
      this.group.visible = false;
      return;
    }
    const duration = resolveNeedleMotion(gesture.technique ?? "none", gesture.motion).durationMs;
    const sample = sampleProcedure(gesture.kind, now - gesture.start, duration);
    if (sample.operation > 0 && !gesture.worked) {
      gesture.worked = true;
      if (gesture.kind === "work") this.needles.work(gesture.id, gesture.technique ?? "none", gesture.start + sample.operationStartMs, gesture.motion);
    }
    if (gesture.kind !== "work" && gesture.worked && !gesture.finished) {
      // Keep the full needle until the fingers open; removal has no shrinking or disappearance under the skin.
      this.needles.progress(gesture.id, gesture.kind, Math.min(0.99999, sample.operation));
      if (sample.operation === 1 && sample.grip < 0.01) {
        this.needles.progress(gesture.id, gesture.kind, 1);
        gesture.finished = true;
      }
    }
    const handle = this.needles.grip(gesture.id);
    if (handle && (gesture.worked || gesture.kind !== "insert")) { gesture.grip.copy(handle.point); gesture.axis.copy(handle.axis); }
    const y = gesture.axis.clone().normalize();
    const x = person.shoulderAt(gesture.side).sub(gesture.grip).addScaledVector(y, -person.shoulderAt(gesture.side).sub(gesture.grip).dot(y));
    if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(y, -y.x);
    x.normalize();
    const z = new Vector3().crossVectors(x, y).normalize();
    const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    // The fingers roll the spiral handle with a small accompanying wrist turn.
    orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (handle?.rotation ?? 0) * 0.22));
    const offset = this.wrist.clone().applyQuaternion(orientation);
    const desiredWrist = gesture.grip.clone().add(offset);
    const result = person.reach(gesture.side, desiredWrist, sample.reach, orientation);
    this.group.position.copy(result.wrist).sub(offset);
    this.group.quaternion.copy(orientation);
    // No detached hand when anatomy or a schematic site exceeds the figure's arm reach.
    this.group.visible = person.holder.visible && !!this.hand && sample.reach > 0.02 && (result.reachable || sample.reach < 0.99);
    if (gesture.kind === "insert" && !gesture.worked && this.group.visible) this.needles.carry(gesture.id, this.group.position, gesture.axis);
    if (this.open && this.mixer) {
      this.open.time = 1 - sample.grip;
      this.mixer.update(0);
    }
    if (sample.complete) {
      person.reach(gesture.side, null);
      this.active = null;
      this.group.visible = false;
    }
  }

  dispose(): void {
    this.gone = true;
    this.reset();
    this.mixer?.stopAllAction();
    this.hand?.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
    for (const material of new Set(this.ownedMaterials)) material.dispose();
    this.group.removeFromParent();
  }
}
