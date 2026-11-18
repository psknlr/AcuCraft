import { BufferAttribute, BufferGeometry, Quaternion, Vector3 } from "three";

const SEGMENTS = 16;
const SIDES = 8;
const RADIUS = 0.00024;
/** Shared by the rendered handle and the articulated surface-contact solver. */
export const NEEDLE_HANDLE_LENGTH_M = 0.025;
export const NEEDLE_HANDLE_GRIP_Y_M = NEEDLE_HANDLE_LENGTH_M / 2;
export const NEEDLE_HANDLE_RADIUS_M = 0.0007;
export const needleHandleRadiusAt = (offsetM: number) => NEEDLE_HANDLE_RADIUS_M + Math.max(-0.0125, Math.min(0.0125, offsetM)) * (0.00004 / NEEDLE_HANDLE_LENGTH_M);

/**
 * An exterior-only, length-preserving drawing aid. The entry point stays at the origin; the interior needle
 * remains on its engine-approved centerline. This geometry does not estimate tissue loading or internal bending.
 */
export function exteriorShape(lengthM: number, lateral: { x: number; z: number }, tilt: { x: number; z: number }): { points: Vector3[]; end: Vector3; tangent: Vector3 } {
  const length = Number.isFinite(lengthM) ? Math.max(0, lengthM) : 0;
  const finite = (value: number, limit: number) => Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0;
  const dx = finite(lateral.x, Math.min(0.004, length * 0.25));
  const dz = finite(lateral.z, Math.min(0.004, length * 0.25));
  const tx = finite(tilt.x, Math.PI / 22.5), tz = finite(tilt.z, Math.PI / 22.5);
  const points: Vector3[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    // A bent shaft emerges without a sideways jump at the skin. Its end tangent follows the displayed tilt.
    const displacement = 3 * t * t - 2 * t * t * t;
    const endSlope = t * t * t - t * t;
    points.push(new Vector3(dx * displacement + length * Math.tan(tx) * endSlope, length * t, dz * displacement + length * Math.tan(tz) * endSlope));
  }
  const arc = points.slice(1).reduce((sum, p, i) => sum + p.distanceTo(points[i]!), 0);
  const ratio = arc > 1e-12 ? length / arc : 0;
  for (const p of points) p.multiplyScalar(ratio);
  const end = points[points.length - 1]!.clone();
  const tangent = new Vector3(Math.tan(tx), 1, Math.tan(tz)).normalize();
  return { points, end, tangent };
}

/** A small reusable tube: updating a pose changes buffers, rather than allocating geometry every frame. */
export function exteriorGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const count = (SEGMENTS + 1) * (SIDES + 1);
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("shaftAxisRadius", new BufferAttribute(new Float32Array(count * 3), 3));
  const indices: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) for (let side = 0; side < SIDES; side++) {
    const a = i * (SIDES + 1) + side, b = a + SIDES + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  geometry.setIndex(indices);
  return geometry;
}

export function updateExteriorGeometry(geometry: BufferGeometry, points: Vector3[], radiusM = RADIUS): void {
  const positions = geometry.getAttribute("position") as BufferAttribute;
  const normals = geometry.getAttribute("normal") as BufferAttribute;
  const axes = geometry.getAttribute("shaftAxisRadius") as BufferAttribute;
  const tangent = new Vector3(), normal = new Vector3(), turn = new Quaternion();
  const radius = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : RADIUS;
  for (let i = 0; i <= SEGMENTS; i++) {
    const centre = points[i]!;
    tangent.copy(points[Math.min(SEGMENTS, i + 1)]!).sub(points[Math.max(0, i - 1)]!);
    if (tangent.lengthSq() < 1e-12) tangent.set(0, 1, 0);
    else tangent.normalize();
    turn.setFromUnitVectors(new Vector3(0, 1, 0), tangent);
    for (let side = 0; side <= SIDES; side++) {
      const angle = side / SIDES * Math.PI * 2;
      normal.set(Math.cos(angle), 0, Math.sin(angle)).applyQuaternion(turn);
      const index = i * (SIDES + 1) + side;
      positions.setXYZ(index, centre.x + normal.x * radius, centre.y + normal.y * radius, centre.z + normal.z * radius);
      normals.setXYZ(index, normal.x, normal.y, normal.z);
      axes.setXYZ(index, tangent.x * radius, tangent.y * radius, tangent.z * radius);
    }
  }
  positions.needsUpdate = normals.needsUpdate = axes.needsUpdate = true;
}
