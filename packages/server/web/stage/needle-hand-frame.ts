import { Quaternion, Vector3 } from "three";

/** Preserve the needle axis while accounting for an authored wrist outside the source XY plane. */
export function alignNeedleWristAzimuth(orientation: Quaternion, contact: Vector3, wrist: Vector3): Quaternion {
  const towardWrist = wrist.clone().sub(contact);
  if (towardWrist.x ** 2 + towardWrist.z ** 2 < 1e-12) return orientation.clone();
  return orientation.clone().multiply(new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0), Math.atan2(towardWrist.z, towardWrist.x),
  ));
}
