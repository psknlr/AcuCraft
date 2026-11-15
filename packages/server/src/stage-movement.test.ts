import { describe, expect, it } from "vitest";
import { Person, patientPlacement } from "../web/stage/cast.js";

describe("moving figures", () => {
  it.each(["supine", "prone", "side-lying-left"])("preserves the resting transform while animating a %s patient", posture => {
    const person = new Person({}, patientPlacement(posture, "treatment-room", 165, "pose-test"));
    const position = person.rig.body.position.clone();
    const rotation = person.rig.body.quaternion.clone();
    person.tick(1000, 16);
    expect(person.rig.body.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(person.rig.body.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
    person.dispose();
  });
  it("keeps the same mesh and follows corners when walking", () => {
    const person = new Person({}, patientPlacement("standing", "consult-room", 165, "walk-test"));
    const body = person.rig.body;
    person.moveTo({ x: 1, y: 0, z: 1, rot: 0 }, { attempt: 1, actor: "patient", from: { x: 0, z: 0 }, path: [{ x: 1, z: 0 }], to: { x: 1, z: 1 } } as import("@acucraft/core").WalkRecord, true);
    person.tick(100, 100);
    expect(person.rig.body).toBe(body);
    expect(person.rig.root.position.x).toBeCloseTo(0.12);
    expect(person.rig.root.position.z).toBe(0);
    for (let t = 200; t < 2500; t += 100) person.tick(t, 100);
    expect(person.rig.root.position.x).toBeCloseTo(1);
    expect(person.rig.root.position.z).toBeCloseTo(1);
    person.dispose();
  });
  it("does not restart an accepted walk when an unchanged snapshot arrives", () => {
    const placement = patientPlacement("standing", "consult-room", 165, "walk-repeat");
    placement.at = { x: 0, y: 0, z: 0, rot: 0 };
    const person = new Person({}, placement);
    const walk = { attempt: 1, actor: "patient", from: { x: 0, z: 0 }, path: [{ x: 1, z: 0 }], to: { x: 1, z: 1 } } as import("@acucraft/core").WalkRecord;
    const destination = { x: 1, y: 0, z: 1, rot: 90 };
    person.moveTo(destination, walk, true);
    person.tick(100, 100);
    person.moveTo(destination, walk, true);
    person.tick(200, 100);
    expect(person.rig.root.position.x).toBeCloseTo(0.24);
    expect(person.rig.root.position.z).toBe(0);
    person.dispose();
  });

});
