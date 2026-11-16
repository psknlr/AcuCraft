import { describe, expect, it } from "vitest";
import { Matrix4, Mesh, Quaternion, Vector3, type BufferAttribute } from "three";
import { buildPerson, disposeRig, type AppearanceLike } from "@clinicalcraft/web/world/npc.js";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { boneTurn, solveTwoBone, turnTowards } from "../web/stage/kinematics.js";
import { AvatarRig, MAX_REACH_LEAN } from "../web/stage/rig.js";
import { Person, patientPlacement, practitionerPlacement } from "../web/stage/cast.js";
import { patientFloorPlacement, practitionerFloorPlacement } from "../web/stage/navigation.js";
import { SiteFinder } from "../web/stage/sites.js";

function armFixture(rotated = false) {
  const rig = buildPerson({}, practitionerPlacement("treatment", 1, 0, "wrist-frame-test").options);
  if (rotated) { rig.root.position.set(0.5, 0, 1.2); rig.root.rotation.y = 0.7; }
  const mesh = rig.body.children.find((object) => object instanceof Mesh && object.userData.figure && object !== rig.torso) as Mesh;
  const positions = mesh.geometry.getAttribute("position") as BufferAttribute;
  const normals = mesh.geometry.getAttribute("normal") as BufferAttribute;
  const original = Array.from(positions.array), originalNormals = Array.from(normals.array);
  const animation = new AvatarRig(rig);
  const point = (array: ArrayLike<number>, i: number) => new Vector3(array[i * 3]!, array[i * 3 + 1]!, array[i * 3 + 2]!);
  const limb = (side: "left" | "right") => {
    const source = rig.skeleton.arms[side === "left" ? 0 : 1], sign = side === "left" ? 1 : -1;
    const bodyPoint = (p: readonly number[]) => new Vector3(p[0]! * sign, p[1]!, p[2]!);
    return { root: bodyPoint(source.root), mid: bodyPoint(source.mid), end: bodyPoint(source.end), face: bodyPoint(source.face) };
  };
  const section = (side: "left" | "right", from: number, to: number, upper = false) => {
    const l = limb(side), a = upper ? l.root : l.mid, b = upper ? l.mid : l.end;
    const d = b.clone().sub(a), lengthSq = d.lengthSq(), result: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      const p = point(original, i), t = p.clone().sub(a).dot(d) / lengthSq;
      if (t >= from && t <= to && p.distanceTo(a.clone().addScaledVector(d, t)) < (upper ? 0.085 : 0.055)) result.push(i);
    }
    return result;
  };
  const dorsal = (side: "left" | "right", elbowWorld: Vector3, wristWorld: Vector3) => {
    rig.body.updateWorldMatrix(true, false);
    const l = limb(side), lower = rig.body.worldToLocal(wristWorld.clone()).sub(rig.body.worldToLocal(elbowWorld.clone()));
    const normal = l.face.clone().negate().applyQuaternion(boneTurn(l.end.clone().sub(l.mid), lower));
    return normal.transformDirection(rig.body.matrixWorld);
  };
  return { rig, positions, normals, original, originalNormals, animation, point, limb, section, dorsal };
}

describe("avatar arm kinematics", () => {
  it("holds both bone lengths for reachable, overextended and folded targets", () => {
    const root = new Vector3(0.172, 1.386, 0);
    const upper = 0.295, lower = 0.25;
    for (const target of [new Vector3(0.36, 1.04, 0.22), new Vector3(5, -5, 0), root.clone()]) {
      const pose = solveTwoBone(root, target, upper, lower, new Vector3(1, -0.2, 0.5));
      expect(pose.root.distanceTo(pose.mid)).toBeCloseTo(upper, 9);
      expect(pose.mid.distanceTo(pose.end)).toBeCloseTo(lower, 9);
      expect([...pose.mid.toArray(), ...pose.end.toArray()].every(Number.isFinite)).toBe(true);
    }
    expect(solveTwoBone(root, new Vector3(5, 5, 5), upper, lower, new Vector3(0, 1, 0)).reachable).toBe(false);
  });

  it("solves collinear pole vectors without NaNs and chooses the shortest turn over pi", () => {
    const pose = solveTwoBone(new Vector3(), new Vector3(0, -0.4, 0), 0.295, 0.25, new Vector3(0, -1, 0));
    expect(pose.mid.length()).toBeCloseTo(0.295, 8);
    expect(turnTowards(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 8);
  });

  it("deforms the figure's own arm and returns the displayed world wrist, without extending its bones", () => {
    const rig = buildPerson({}, { posture: "standing" });
    rig.root.position.set(1, 0, 2);
    rig.root.rotation.y = Math.PI / 3;
    const animation = new AvatarRig(rig);
    const original = animation.wristAt("left");
    const target = animation.shoulderAt("left").add(new Vector3(0.1, -0.35, 0.1));
    const result = animation.reach("left", target, 1);
    animation.tick(16, 0, false);
    expect(result.reachable).toBe(true);
    expect(result.wrist.distanceTo(target)).toBeLessThan(1e-7);
    expect(animation.wristAt("left").distanceTo(result.wrist)).toBeLessThan(1e-7);
    expect(result.wrist.distanceTo(original)).toBeGreaterThan(0.1);
    const l = rig.skeleton.arms[0];
    const upper = new Vector3(...l.root).distanceTo(new Vector3(...l.mid));
    const lower = new Vector3(...l.mid).distanceTo(new Vector3(...l.end));
    expect(animation.shoulderAt("left").distanceTo(result.elbow)).toBeCloseTo(upper * rig.scale, 6);
    expect(result.elbow.distanceTo(result.wrist)).toBeCloseTo(lower * rig.scale, 6);
    animation.reach("left", null);
    animation.tick(16, 0, false);
    expect(animation.wristAt("left").distanceTo(original)).toBeLessThan(1e-7);
    disposeRig(rig);
  });

  it("reaches the low-back reference grip on the actual patient's figure with a bounded hip hinge", () => {
    const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
    const session = new EncounterSession(scenario, { seed: 1, mode: "teaching" });
    const insertion = scenario.field.solution.find((r) => r.action.type === "insert_needle")!.action;
    if (insertion.type !== "insert_needle") throw new Error("the reference needs an insertion");
    for (const request of scenario.field.solution) {
      if (request.action.type === "insert_needle") break;
      session.act(request.action);
    }
    const view = session.view();
    const patientInfo = scenario.case.patient as { heightCm?: number; sex?: string; appearance?: AppearanceLike };
    const patient = new Person({ presentation: patientInfo.sex === "female" ? "feminine" : "neutral", ...patientInfo.appearance }, patientFloorPlacement(view, patientInfo.heightCm ?? null, "reach-patient"));
    const placement = practitionerFloorPlacement(view, "reach-practitioner");
    placement.options.wear = practitionerPlacement("treatment", 1, 0, "reach-practitioner").options.wear;
    const staff = new Person({}, placement);
    const mark = view.localisation.marks.find((m) => m.id === insertion.mark)!;
    const site = new SiteFinder(patient.rig).find(mark)!;
    expect(site).not.toBeNull();
    const grip = site.p.clone().addScaledVector(site.n, 0.04 + 0.0125 - insertion.depthCm / 100);
    const side = staff.shoulderAt("left").distanceToSquared(grip) < staff.shoulderAt("right").distanceToSquared(grip) ? "left" : "right";
    const shoulder = staff.shoulderAt(side);
    const y = site.n.clone().normalize();
    const x = shoulder.clone().sub(grip).addScaledVector(y, -shoulder.clone().sub(grip).dot(y)).normalize();
    const z = new Vector3().crossVectors(x, y).normalize();
    const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    const wrist = grip.clone().add(new Vector3(0.162, 0.004, 0).applyQuaternion(orientation));
    const feet = staff.rig.root.position.clone();
    const result = staff.reach(side, wrist, 1, orientation);
    staff.tick(16, 16);
    expect(result.reachable).toBe(true);
    expect(result.wrist.distanceTo(wrist)).toBeLessThan(1e-6);
    const hinge = staff.shoulderAt(side).sub(shoulder);
    expect(Math.hypot(hinge.x, hinge.z)).toBeLessThanOrEqual(MAX_REACH_LEAN.forward * staff.rig.scale + 1e-6);
    expect(-hinge.y).toBeLessThanOrEqual(MAX_REACH_LEAN.down * staff.rig.scale + 1e-6);
    expect(staff.rig.root.position.distanceTo(feet)).toBe(0);
    const arm = staff.rig.skeleton.arms[side === "left" ? 0 : 1];
    expect(result.elbow.distanceTo(result.wrist)).toBeCloseTo(new Vector3(...arm.mid).distanceTo(new Vector3(...arm.end)) * staff.rig.scale, 6);
    staff.dispose();
    patient.dispose();
  });

  it("uses the actual wrist frame to turn the distal forearm and cuff while preserving its bone ends and cross sections", () => {
    const f = armFixture(true), target = f.animation.shoulderAt("left").add(new Vector3(0.08, -0.32, 0.16));
    const first = f.animation.reach("left", target, 1);
    const baselineDorsal = f.dorsal("left", first.elbow, first.wrist);
    const base = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), baselineDorsal);
    f.animation.reach("left", target, 1, base); f.animation.tick(16, 0, false);
    const before = Array.from(f.positions.array), beforeNormals = Array.from(f.normals.array);
    const axis = first.wrist.clone().sub(first.elbow).normalize();
    const next = new Quaternion().setFromAxisAngle(axis, Math.PI / 3).multiply(base);
    const result = f.animation.reach("left", target, 1, next); f.animation.tick(16, 0, false);
    expect(result.wrist.distanceTo(first.wrist)).toBeLessThan(1e-8);
    expect(result.elbow.distanceTo(first.elbow)).toBeLessThan(1e-8);
    const cuff = f.section("left", 0.80, 0.99), upper = f.section("left", 0.25, 0.65, true);
    expect(cuff.length).toBeGreaterThan(15); expect(upper.length).toBeGreaterThan(15);
    expect(Math.max(...cuff.map((i) => f.point(before, i).distanceTo(f.point(f.positions.array, i))))).toBeGreaterThan(0.008);
    expect(Math.max(...cuff.map((i) => f.point(beforeNormals, i).distanceTo(f.point(f.normals.array, i))))).toBeGreaterThan(0.3);
    expect(Math.max(...upper.map((i) => f.point(before, i).distanceTo(f.point(f.positions.array, i))))).toBeLessThan(1e-7);
    const elbow = f.rig.body.worldToLocal(first.elbow.clone()), wrist = f.rig.body.worldToLocal(first.wrist.clone()), along = wrist.sub(elbow).normalize();
    for (const i of cuff) {
      const a = f.point(before, i).sub(elbow), b = f.point(f.positions.array, i).sub(elbow);
      expect(a.dot(along)).toBeCloseTo(b.dot(along), 6);
      expect(a.clone().addScaledVector(along, -a.dot(along)).length()).toBeCloseTo(b.clone().addScaledVector(along, -b.dot(along)).length(), 6);
    }
    f.animation.reach("left", null); f.animation.tick(16, 0, false);
    for (let i = 0; i < f.positions.count; i++) {
      expect(f.point(f.positions.array, i).distanceTo(f.point(f.original, i))).toBeLessThan(2e-7);
      expect(f.point(f.normals.array, i).distanceTo(f.point(f.originalNormals, i))).toBeLessThan(2e-7);
    }
    disposeRig(f.rig);
  });

  it("turns mirrored cuffs consistently for mirrored palm frames", () => {
    const f = armFixture(), targets = { left: f.animation.shoulderAt("left").add(new Vector3(0.08, -0.32, 0.16)), right: f.animation.shoulderAt("right").add(new Vector3(-0.08, -0.32, 0.16)) };
    const left = f.animation.reach("left", targets.left, 1), right = f.animation.reach("right", targets.right, 1);
    const axis = left.wrist.clone().sub(left.elbow).normalize();
    const dorsal = f.dorsal("left", left.elbow, left.wrist).applyAxisAngle(axis, 0.7);
    const reflected = new Vector3(-dorsal.x, dorsal.y, dorsal.z);
    f.animation.reach("left", targets.left, 1, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dorsal));
    f.animation.reach("right", targets.right, 1, new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), reflected));
    f.animation.tick(16, 0, false);
    const key = (point: Vector3) => point.toArray().map((v) => v.toFixed(6)).join(",");
    const lookup = new Map(Array.from({ length: f.positions.count }, (_, i) => [key(f.point(f.original, i)), i]));
    let checked = 0;
    for (const i of f.section("left", 0.75, 0.99)) {
      const original = f.point(f.original, i); original.x *= -1;
      const j = lookup.get(key(original));
      if (j === undefined) continue;
      const p = f.point(f.positions.array, i); p.x *= -1;
      expect(p.distanceTo(f.point(f.positions.array, j))).toBeLessThan(2e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
    expect(left.wrist.distanceTo(targets.left)).toBeLessThan(1e-7);
    expect(right.wrist.distanceTo(targets.right)).toBeLessThan(1e-7);
    disposeRig(f.rig);
  });

  it("does not flip the sleeve when a wrist orientation passes the quaternion angle wrap", () => {
    const f = armFixture(), target = f.animation.shoulderAt("left").add(new Vector3(0.08, -0.32, 0.16));
    const result = f.animation.reach("left", target, 1), axis = result.wrist.clone().sub(result.elbow).normalize();
    const base = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), f.dorsal("left", result.elbow, result.wrist));
    let previous: number[] | undefined;
    for (const degrees of [179, 180, 181, 182]) {
      const orientation = new Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180).multiply(base);
      f.animation.reach("left", target, 1, orientation); f.animation.tick(16, 0, false);
      const current = Array.from(f.positions.array);
      if (previous) expect(Math.max(...f.section("left", 0.75, 0.99).map((i) => f.point(previous!, i).distanceTo(f.point(current, i))))).toBeLessThan(0.001);
      previous = current;
    }
    expect(Array.from(f.positions.array).every(Number.isFinite)).toBe(true);
    disposeRig(f.rig);
  });
});

describe("avatar walks", () => {
  it("keeps the same figure and follows corners instead of cutting across the path", () => {
    const placement = practitionerPlacement("treatment", 1, 0, "walking-test");
    placement.at = { x: 0, y: 0, z: 0, rot: 0 };
    const person = new Person({}, placement);
    const rig = person.rig;
    person.moveTo({ x: 1, y: 0, z: 1, rot: 90 }, [{ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }]);
    person.tick(100, 100);
    expect(person.rig).toBe(rig);
    expect(person.rig.root.position.x).toBe(0);
    expect(person.rig.root.position.z).toBeCloseTo(0.12, 6);
    expect(person.isMoving).toBe(true);
    for (let now = 200; now <= 2200; now += 100) person.tick(now, 100);
    expect(person.rig.root.position.x).toBeCloseTo(1, 6);
    expect(person.rig.root.position.z).toBeCloseTo(1, 6);
    expect(person.isMoving).toBe(false);
    person.dispose();
  });

  it("joins consecutive approved paths when actions arrive faster than frames", () => {
    const placement = practitionerPlacement("treatment", 1, 0, "queued-walk-test");
    placement.at = { x: 0, y: 0, z: 0, rot: 0 };
    const person = new Person({}, placement);
    person.moveTo({ x: 0, y: 0, z: 1, rot: 0 }, [{ x: 0, z: 0 }, { x: 0, z: 1 }]);
    person.tick(100, 100);
    person.moveTo({ x: 1, y: 0, z: 1, rot: 90 }, [{ x: 0, z: 1 }, { x: 1, z: 1 }]);
    person.tick(200, 100);
    expect(person.rig.root.position.x).toBe(0);
    expect(person.rig.root.position.z).toBeCloseTo(0.24, 6);
    person.dispose();
  });
});
