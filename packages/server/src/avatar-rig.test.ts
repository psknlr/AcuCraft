import { describe, expect, it } from "vitest";
import { Matrix4, Quaternion, Vector3 } from "three";
import { buildPerson, disposeRig, type AppearanceLike } from "@clinicalcraft/web/world/npc.js";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { solveTwoBone, turnTowards } from "../web/stage/kinematics.js";
import { AvatarRig, MAX_REACH_LEAN } from "../web/stage/rig.js";
import { Person, patientPlacement, practitionerPlacement } from "../web/stage/cast.js";
import { practitionerFloorPlacement } from "../web/stage/navigation.js";
import { SiteFinder } from "../web/stage/sites.js";

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
    const patient = new Person({ presentation: patientInfo.sex === "female" ? "feminine" : "neutral", ...patientInfo.appearance }, patientPlacement(view.patient.position, view.patient.location, patientInfo.heightCm ?? null, "reach-patient"));
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
    expect(person.rig.root.position.z).toBeCloseTo(0.11, 6);
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
    expect(person.rig.root.position.z).toBeCloseTo(0.22, 6);
    person.dispose();
  });
});
