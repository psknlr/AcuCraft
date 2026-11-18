import { Matrix4, SkinnedMesh, Vector3, type Object3D } from "three";
import type { ArticulatedHand } from "./hand.js";
import { NEEDLE_HANDLE_RADIUS_M } from "./needle-shape.js";

interface Digit {
  skin: SkinnedMesh;
  distal: Object3D;
  tip: Object3D;
  vertex: number;
}

export interface SupportPinchFrame {
  thumb: Vector3;
  index: Vector3;
  point: Vector3;
  normal: Vector3;
}

const materials = new WeakMap<ArticulatedHand, [Digit, Digit]>();
const rootPosition = (node: Object3D, inverse: Matrix4) => node.getWorldPosition(new Vector3()).applyMatrix4(inverse);
const tangent = (forward: Vector3, span: Vector3) => forward.clone().addScaledVector(span, -forward.dot(span)).normalize();
const direction = (digit: Digit, inverse: Matrix4) => rootPosition(digit.tip, inverse).sub(rootPosition(digit.distal, inverse)).normalize();
const approach = (thumb: Digit, index: Digit, inverse: Matrix4) =>
  direction(index, inverse).multiplyScalar(0.76).addScaledVector(direction(thumb, inverse), 0.24).normalize();

function digitOf(hand: ArticulatedHand, name: string): Digit | null {
  const skin = hand.model.getObjectByName(name + "_skin");
  const distal = hand.model.getObjectByName(name + "_distal"), tip = hand.model.getObjectByName(name + "_tip");
  return skin instanceof SkinnedMesh && distal && tip ? { skin, distal, tip, vertex: 0 } : null;
}

function distalSurface(digit: Digit, inverse: Matrix4) {
  const transform = inverse.clone().multiply(digit.skin.matrixWorld);
  const tip = rootPosition(digit.tip, inverse);
  const points: { point: Vector3; vertex: number }[] = [];
  const vertexPoint = new Vector3();
  digit.skin.skeleton.update();
  for (let vertex = 0; vertex < digit.skin.geometry.getAttribute("position").count; vertex++) {
    digit.skin.getVertexPosition(vertex, vertexPoint).applyMatrix4(transform);
    if (vertexPoint.distanceToSquared(tip) <= 0.012 ** 2) points.push({ point: vertexPoint.clone(), vertex });
  }
  return points;
}

/** Acquire two real points on distal skin in the open posture. Follow the same material through closure. */
function acquire(thumb: Digit, index: Digit, inverse: Matrix4): boolean {
  const pulp = distalSurface(thumb, inverse), fingertip = distalSurface(index, inverse);
  if (!pulp.length || !fingertip.length) return false;
  const forward = approach(thumb, index, inverse);
  let normal = tangent(forward, rootPosition(index.tip, inverse).sub(rootPosition(thumb.tip, inverse)).normalize());
  // The hand approaches along the two distal phalanges. Both bearing points
  // must lie on the same tangent plane, including when the thumb is oblique.
  for (let i = 0; i < 6; i++) {
    const leading = (points: typeof pulp) => points.reduce((a, b) => a.point.dot(normal) > b.point.dot(normal) ? a : b);
    const a = leading(pulp), b = leading(fingertip);
    thumb.vertex = a.vertex; index.vertex = b.vertex;
    normal = tangent(forward, b.point.clone().sub(a.point).normalize());
  }
  return true;
}

function pose(hand: ArticulatedHand, grip: number): void {
  // Reuse the side-pinch rig's anatomical thumb opposition, finger flexion and
  // aperture trajectory. The two outer skin contacts drive the supporting hand.
  hand.pose({ pose: "pinch", grip, phase: 0, gripStyle: "side-pinch", handleRadiusM: NEEDLE_HANDLE_RADIUS_M,
    wristElevationDeg: 45, apertureMm: 12, idleFingerPose: "curled" });
  hand.root.updateMatrixWorld(true);
}

export function poseSupportPinch(hand: ArticulatedHand, grip: number): SupportPinchFrame | null {
  let pair = materials.get(hand);
  if (!pair) {
    const thumb = digitOf(hand, "thumb"), index = digitOf(hand, "index");
    if (!thumb || !index) return null;
    pose(hand, 0);
    if (!acquire(thumb, index, hand.root.matrixWorld.clone().invert())) return null;
    pair = [thumb, index];
    materials.set(hand, pair);
  }
  pose(hand, grip);
  const inverse = hand.root.matrixWorld.clone().invert();
  const pointAt = (digit: Digit) => {
    digit.skin.skeleton.update();
    return digit.skin.getVertexPosition(digit.vertex, new Vector3()).applyMatrix4(digit.skin.matrixWorld).applyMatrix4(inverse);
  };
  const [thumbDigit, indexDigit] = pair, thumb = pointAt(thumbDigit), index = pointAt(indexDigit);
  return { thumb, index, point: thumb.clone().lerp(index, 0.5), normal: tangent(approach(thumbDigit, indexDigit, inverse), index.clone().sub(thumb).normalize()) };
}
