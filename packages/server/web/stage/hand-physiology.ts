import { Matrix4, Quaternion, Vector3 } from "three";

export type RestingDigit = "middle" | "ring" | "little";
export type RestingFingerStyle = "curled" | "relaxed";

/** Closed-fist and relaxed idle postures for an adult visualization, rather than diagnostic ROM limits. */
export const RESTING_POSTURES = {
  curled: { middle: [85, 95, 55], ring: [85, 100, 60], little: [80, 100, 60] },
  relaxed: { middle: [42, 54, 31], ring: [46, 58, 34], little: [50, 62, 37] },
} as const;
/** The ulnar fingers fan outward progressively; deep flexion narrows the fan. */
export const RESTING_FINGER_SPREAD_AT_EXTENSION_DEG = { middle: 10, ring: 13, little: 17 } as const;
/** A lateral precision grip extends the IP joints while the MCP supplies the main bend. */
export const SIDE_INDEX_WORKING_POSTURE = { mcpDeg: 90, pipDeg: 35, dipDeg: 10 } as const;
/** The lateral grip acquires the thumb's real rounded pulp, rather than hyperextending its IP. */
export const SIDE_THUMB_ACQUISITION_M = 0.002;
/** Hold higher on the handle to clear the proximal index while preserving the three-contact layout. */
export const THREE_FINGER_WORKING_PROFILE = {
  index: { mcpDeg: 75, pipDeg: 90, dipDeg: 25 },
  thumbAcquisitionM: 0.00465,
  primaryY: -0.006,
  middleY: 0.011164059024878269,
  middleAzimuthRad: 87.35860616388027 * Math.PI / 180,
  middleContact: "middle_volar_pulp_88_contact",
} as const;

/** A tighter low-wrist precision grip returns smoothly to the source posture at 70°. */
export function ordinaryTipPosture(elevationDeg: number) {
  const u = Math.max(0, Math.min(1, (elevationDeg - 55) / 15));
  const blend = u * u * u * (10 - 15 * u + 6 * u * u);
  return { mcpDeg: 60 - 15 * blend, pipDeg: 100, dipDeg: 60 };
}

/** Large opening escapes the palm face; a 600 µm walking bite has no added excursion. */
export function tipReleasePalmarBlend(openingExtraM: number, referenceMcpDeg: number): number {
  const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * t * (10 - 15 * t + 6 * t * t); };
  return 0.5 * smooth((openingExtraM - 0.0006) / 0.0047) * smooth((referenceMcpDeg - 50) / 10);
}

/**
 * MCP collateral restraint rises with flexion. This authored envelope decreases smoothly from
 * extension to a small residual at 90 degrees; it is deliberately not a clinical range claim.
 * Working fingers retain independent PIP/DIP solutions for their real surface contacts.
 */
export function restingFingerPosture(digit: RestingDigit, style: RestingFingerStyle) {
  const [mcpDeg, pipDeg, dipDeg] = RESTING_POSTURES[style][digit];
  const flexion = Math.max(0, Math.min(90, mcpDeg)) * Math.PI / 180;
  const ulnarSpreadDeg = RESTING_FINGER_SPREAD_AT_EXTENSION_DEG[digit] * (0.2 + 0.8 * Math.cos(flexion) ** 2);
  return { mcpDeg, pipDeg, dipDeg, ulnarSpreadDeg };
}

/**
 * Align both the proximal direction and its flexion plane. A one-vector minimal swing leaves
 * the IP hinge drifting out of the volar plane when MCP flexion and abduction are combined.
 */
export function restingFingerBaseRotation(proximal: Vector3, hinge: Vector3, palm: Matrix4, flexionDeg: number, ulnarSpreadDeg: number): Quaternion {
  const flexion = flexionDeg * Math.PI / 180, spread = ulnarSpreadDeg * Math.PI / 180;
  // Abduction rotates in the MCP extension plane; flexion then follows that digit's
  // abducted radial hinge. Rotating the already-flexed phalanx sideways instead would
  // incorrectly preserve a large lateral excursion even near a tightly flexed MCP.
  const along = new Vector3(-Math.cos(flexion) * Math.cos(spread), -Math.sin(flexion), -Math.cos(flexion) * Math.sin(spread)).transformDirection(palm);
  const flexionAxis = new Vector3(-Math.sin(spread), 0, Math.cos(spread)).transformDirection(palm);
  const frame = (x: Vector3, z: Vector3) => new Matrix4().makeBasis(x.clone().normalize(), z.clone().cross(x).normalize(), z.clone().normalize());
  return new Quaternion().setFromRotationMatrix(frame(along, flexionAxis).multiply(frame(proximal.clone().normalize(), hinge).transpose()));
}

/** The actual distal attachment of a four-finger joint posture, without deforming any bone or skin. */
export function fingerPostureReference(base: Vector3, proximal: Vector3, middle: Vector3, distal: Vector3, palm: Matrix4,
  posture: { mcpDeg: number; pipDeg: number; dipDeg: number; ulnarSpreadDeg?: number }) {
  const hinge = proximal.clone().cross(middle).normalize();
  const palmUp = new Vector3(0, 1, 0).transformDirection(palm);
  if (hinge.dot(palmUp.cross(proximal)) < 0) hinge.negate();
  const distalHinge = middle.clone().cross(distal).normalize();
  if (distalHinge.dot(hinge) < 0) distalHinge.negate();
  const signed = (a: Vector3, b: Vector3, axis: Vector3) => Math.atan2(a.clone().cross(b).dot(axis), a.dot(b));
  const rotations = [restingFingerBaseRotation(proximal, hinge, palm, posture.mcpDeg, posture.ulnarSpreadDeg ?? 0),
    new Quaternion().setFromAxisAngle(hinge, posture.pipDeg * Math.PI / 180 - signed(proximal, middle, hinge)),
    new Quaternion().setFromAxisAngle(distalHinge, posture.dipDeg * Math.PI / 180 - signed(middle, distal, distalHinge))] as const;
  const translate = (point: Vector3) => new Matrix4().makeTranslation(point.x, point.y, point.z);
  const attachment = translate(base).multiply(new Matrix4().makeRotationFromQuaternion(rotations[0])).multiply(translate(proximal))
    .multiply(new Matrix4().makeRotationFromQuaternion(rotations[1])).multiply(translate(middle)).multiply(new Matrix4().makeRotationFromQuaternion(rotations[2]));
  return { attachment, rotations };
}

/** MCP angles from its complete phalanx/hinge frame; the hinge fixes spread even at 90° flexion. */
export function measureFingerMcp(proximal: Vector3, hinge: Vector3, palm: Matrix4) {
  const inverse = palm.clone().invert();
  const along = proximal.clone().transformDirection(inverse), axis = hinge.clone().transformDirection(inverse);
  const extendedForward = new Vector3(axis.x, 0, axis.z).cross(new Vector3(0, 1, 0));
  const valid = extendedForward.lengthSq() > 1e-20 && along.lengthSq() > 1e-20 && [...along.toArray(), ...axis.toArray()].every(Number.isFinite);
  extendedForward.normalize();
  return {
    valid,
    flexionDeg: valid ? Math.atan2(-along.y, along.dot(extendedForward)) * 180 / Math.PI : NaN,
    spreadDeg: valid ? Math.atan2(-axis.x, axis.z) * 180 / Math.PI : NaN,
    hingeTiltDeg: Math.asin(Math.max(-1, Math.min(1, axis.y))) * 180 / Math.PI,
  };
}

/** Best normal alignment achievable without moving the source wrist or changing its elevation. */
export function alignNormalAroundAxis(sourceNormal: Vector3, targetNormal: Vector3, wristDirection: Vector3): Quaternion {
  const axis = wristDirection.clone().normalize();
  const source = sourceNormal.clone().addScaledVector(axis, -sourceNormal.dot(axis));
  const target = targetNormal.clone().addScaledVector(axis, -targetNormal.dot(axis));
  if (axis.lengthSq() < 1e-12 || source.lengthSq() < 1e-12 || target.lengthSq() < 1e-12) return new Quaternion();
  source.normalize(); target.normalize();
  const angle = Math.atan2(axis.dot(source.clone().cross(target)), Math.max(-1, Math.min(1, source.dot(target))));
  return new Quaternion().setFromAxisAngle(axis, angle);
}

/**
 * A real contact normal and a wrist elevation determine two possible palm azimuths.
 * Keep one branch throughout a motion, instead of overconstraining azimuth and making
 * the fingers stretch to compensate. All inputs are immutable bind-frame quantities.
 */
export function contactFrameAtElevation(origin: Vector3, sourceNormal: Vector3, sourceWrist: Vector3, elevationDeg: number, horizontalBranch: -1 | 1) {
  if (![...origin.toArray(), ...sourceNormal.toArray(), ...sourceWrist.toArray(), elevationDeg].every(Number.isFinite) || sourceNormal.lengthSq() < 1e-24) return null;
  const wrist = sourceWrist.clone().sub(origin), length = wrist.length();
  if (length < 1e-12) return null;
  const align = new Quaternion().setFromUnitVectors(sourceNormal.clone().normalize(), new Vector3(0, 0, -1));
  const alignedWrist = wrist.clone().applyQuaternion(align);
  const y = length * Math.sin(elevationDeg * Math.PI / 180);
  const xSquared = length * length - y * y - alignedWrist.z * alignedWrist.z;
  const tolerance = 64 * Number.EPSILON * length * length;
  if (xSquared < -tolerance) return null;
  const x = horizontalBranch * Math.sqrt(Math.max(0, xSquared));
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.atan2(y, x) - Math.atan2(alignedWrist.y, alignedWrist.x)).multiply(align);
  return { rotation, position: origin.clone().applyQuaternion(rotation).negate(), wristDirection: wrist.normalize() };
}

/**
 * A pair of parallel IP hinges preserves the axial components of both the contact vector
 * and its surface normal. Cauchy–Schwarz therefore gives a necessary distance for a real
 * surface point/normal pair. Retraction can recover reach; extra Newton iterations cannot.
 */
export function minimumPlanarContactDistance(hinge: Vector3, contactVector: Vector3, contactNormal: Vector3, requiredDot: number): number {
  const axis = hinge.clone().normalize(), normal = contactNormal.clone().normalize();
  const along = contactVector.dot(axis), normalAlong = normal.dot(axis);
  const transverseNormalSquared = Math.max(0, 1 - normalAlong * normalAlong);
  const transverseDot = requiredDot - along * normalAlong;
  if (transverseNormalSquared < 1e-12) return Math.abs(transverseDot) < 1e-9 ? Math.abs(along) : Infinity;
  return Math.sqrt(along * along + transverseDot * transverseDot / transverseNormalSquared);
}

/** Earliest nonnegative point in a quadratic's feasible set, with stable near-linear roots. */
function firstFeasibleQuadratic(a: number, b: number, c: number, maximum: number): number {
  if (![a, b, c].every(Number.isFinite) || Number.isNaN(maximum) || maximum < 0) return Infinity;
  if (c >= 0) return 0;
  if (maximum === 0) return Infinity;
  let roots: number[];
  if (a === 0) {
    if (b <= 0) return Infinity;
    roots = [-c / b];
  } else {
    let discriminant = b * b - 4 * a * c;
    const tolerance = 64 * Number.EPSILON * (b * b + Math.abs(4 * a * c));
    if (discriminant < -tolerance) return Infinity;
    discriminant = Math.max(0, discriminant);
    const squareRoot = Math.sqrt(discriminant);
    const q = -0.5 * (b + (b >= 0 ? squareRoot : -squareRoot));
    roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
  }
  let earliest = Infinity;
  for (let root of roots) {
    if (!Number.isFinite(root) || root < 0) continue;
    if (root > maximum) {
      const distanceTolerance = 64 * Number.EPSILON * Math.max(1, maximum);
      const boundaryValue = (a * maximum + b) * maximum + c;
      const boundaryTolerance = 64 * Number.EPSILON * (Math.abs(a * maximum * maximum) + Math.abs(b * maximum) + Math.abs(c));
      if (root - maximum > distanceTolerance || boundaryValue < -boundaryTolerance) continue;
      root = maximum;
    }
    earliest = Math.min(earliest, root);
  }
  return earliest;
}

/**
 * Minimal retreat along a real wrist direction, including its component along the target normal.
 * Unlike a distance-only bound, this can have a finite feasible interval or no feasible ray.
 * squaredClearance reserves a small interior margin in the squared Cauchy–Schwarz inequality.
 */
export function minimumPlanarContactRetreat(settings: {
  displacement: Vector3;
  direction: Vector3;
  targetNormal: Vector3;
  hinge: Vector3;
  contactVector: Vector3;
  contactNormal: Vector3;
  squaredClearance?: number;
  maximum?: number;
}): number {
  const { displacement, contactVector } = settings;
  const vectors = [displacement, contactVector, settings.direction, settings.targetNormal, settings.hinge, settings.contactNormal];
  if (vectors.some((vector) => !vector.toArray().every(Number.isFinite))) return Infinity;
  if (settings.targetNormal.lengthSq() < 1e-24 || settings.hinge.lengthSq() < 1e-24 || settings.contactNormal.lengthSq() < 1e-24) return Infinity;
  const axis = settings.hinge.clone().normalize(), normal = settings.contactNormal.clone().normalize();
  const targetNormal = settings.targetNormal.clone().normalize();
  const k = contactVector.dot(axis), n = Math.max(-1, Math.min(1, normal.dot(axis))), A = Math.max(0, 1 - n * n);
  const d0 = displacement.dot(targetNormal), transverseDot = d0 - k * n;
  const reserve = settings.squaredClearance ?? 0;
  const maximum = settings.maximum ?? Infinity;
  if (!Number.isFinite(reserve) || reserve < 0 || Number.isNaN(maximum) || maximum < 0) return Infinity;
  const c0 = A * (displacement.lengthSq() - k * k) - transverseDot * transverseDot - reserve;
  if (c0 >= 0) return 0;
  if (settings.direction.lengthSq() < 1e-24) return Infinity;
  const direction = settings.direction.clone().normalize(), c = Math.max(-1, Math.min(1, direction.dot(targetNormal)));
  return firstFeasibleQuadratic(A - c * c, -2 * A * displacement.dot(direction) + 2 * c * transverseDot, c0, maximum);
}

/** A compact C2 upper approximation of max(distance, 0), measured in metres. */
export function smoothPositiveDistance(distance: number, halfWidth = 0.0001): number {
  if (distance <= -halfWidth) return 0;
  if (distance >= halfWidth) return distance;
  const t = (distance + halfWidth) / (2 * halfWidth);
  return halfWidth * (2 * t ** 3 - t ** 4);
}

/** C2 hand-off with a steady middle speed, rather than a sharp peak during regripping. */
export function handOffProgress(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  if (progress > 0.5) return 1 - handOffProgress(1 - progress);
  const ramp = 0.2, speed = 1 / (1 - ramp);
  if (progress < ramp) {
    const t = progress / ramp;
    return ramp * speed * (t ** 6 - 3 * t ** 5 + 2.5 * t ** 4);
  }
  return speed * (progress - ramp / 2);
}
