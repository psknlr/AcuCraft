import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { handOrientation } from "../web/stage/hand.js";
import { alignNeedleWristAzimuth } from "../web/stage/needle-hand-frame.js";

describe("a hand authored outside the needle's XY plane", () => {
  it("aims the actual wrist toward the shoulder while preserving the needle axis, contact and authored roll", () => {
    const target = new Vector3(0.2, 0.8, -0.3), shoulder = new Vector3(-0.4, 1.4, 0.1);
    for (const normal of [new Vector3(0, 1, 0), new Vector3(0.3, 0.8, -0.2).normalize()]) {
      const towardShoulder = shoulder.clone().sub(target).projectOnPlane(normal).normalize();
      for (const mirrored of [-1, 1]) for (const x of [-0.065, 0, 0.065]) for (const roll of [0, -0.04, 0.04]) {
        const contact = new Vector3(0.004, 0.008, mirrored * 0.002);
        const wrist = contact.clone().add(new Vector3(x, 0.09, mirrored * 0.035));
        const orientation = alignNeedleWristAzimuth(handOrientation(target, normal, shoulder, roll), contact, wrist);
        expect(new Vector3(0, 1, 0).applyQuaternion(orientation).distanceTo(normal)).toBeLessThan(1e-10);
        const actualWrist = wrist.clone().sub(contact).applyQuaternion(orientation).projectOnPlane(normal).normalize();
        expect(actualWrist.distanceTo(towardShoulder.clone().applyAxisAngle(normal, roll))).toBeLessThan(1e-10);
        const translation = target.clone().sub(contact.clone().applyQuaternion(orientation));
        expect(contact.clone().applyQuaternion(orientation).add(translation).distanceTo(target)).toBeLessThan(1e-10);
      }
    }
  });

  it("preserves a planar source and leaves a purely axial wrist well-defined", () => {
    const orientation = new Quaternion().setFromAxisAngle(new Vector3(0.2, 0.7, 0.3).normalize(), 0.8);
    for (const wrist of [new Vector3(0.08, 0.11, 0), new Vector3(0, 0.11, 0)]) {
      const result = alignNeedleWristAzimuth(orientation, new Vector3(), wrist);
      expect(result.angleTo(orientation)).toBeLessThan(1e-7);
      expect(result).not.toBe(orientation);
    }
  });
});
