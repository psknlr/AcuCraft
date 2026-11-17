import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mesh, Object3D, Ray, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand, type FingerPose } from "../web/stage/hand.js";

const asset = process.env.ACUCRAFT_HAND_ASSET_FIXTURE
  ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url));
const fingers = ["index", "middle", "ring", "little"] as const;
const roles: FingerPose[] = [
  { pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.00035, wristElevationDeg: 55, gripStyle: "tip-pinch", idleFingerPose: "curled" },
  { pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.00035, wristElevationDeg: 55, gripStyle: "side-pinch", idleFingerPose: "relaxed" },
  { pose: "tripod", grip: 1, phase: 0.5, handleRadiusM: 0.00035, wristElevationDeg: 48, gripStyle: "tip-pinch", idleFingerPose: "curled" },
];

async function detailHand() {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
  const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
  // Proper scene rotations cannot change handedness. Reflection must be measured
  // from transformed points; getWorldQuaternion loses a negative determinant.
  hand.root.position.set(0.43, 0.87, -1.2);
  hand.root.quaternion.setFromAxisAngle(new Vector3(0.2, 0.7, -0.3).normalize(), 0.83);
  return hand;
}

function node(hand: ArticulatedHand, name: string): Object3D {
  const object = hand.model.getObjectByName(name);
  expect(object, `actual ${name}`).toBeDefined();
  return object!;
}

function point(hand: ArticulatedHand, name: string): Vector3 {
  return node(hand, name).getWorldPosition(new Vector3());
}

function direction(object: Object3D, local: Vector3): Vector3 {
  const origin = object.getWorldPosition(new Vector3());
  return object.localToWorld(local.clone()).sub(origin).normalize();
}

function pose(hand: ArticulatedHand, side: "left" | "right", role: FingerPose): void {
  hand.setSide(side); hand.pose(role); hand.root.updateMatrixWorld(true);
  expect(hand.contactValid, `${side}/${role.pose}/${role.gripStyle} real contact solve`).toBe(true);
}

/** Actual posed closed-palm triangles; no bounding-box or marker occupancy substitute. */
function palmSurface(hand: ArticulatedHand): Triangle[] {
  const mesh = node(hand, "palm_surface") as SkinnedMesh;
  expect(mesh.isSkinnedMesh).toBe(true);
  mesh.updateMatrixWorld(true); mesh.skeleton.update();
  const count = mesh.geometry.getAttribute("position").count, indices = mesh.geometry.index!;
  const points = Array.from({ length: count }, (_, index) => mesh.localToWorld(mesh.getVertexPosition(index, new Vector3())));
  return Array.from({ length: indices.count / 3 }, (_, index) => new Triangle(
    points[indices.getX(index * 3)]!, points[indices.getX(index * 3 + 1)]!, points[indices.getX(index * 3 + 2)]!,
  ));
}

/** Three-ray majority plus distance excludes contacts within the existing 50 µm surface tolerance. */
function insidePalmBeyondTolerance(point: Vector3, triangles: readonly Triangle[]): boolean {
  const hit = new Vector3(); let votes = 0;
  for (const direction of [new Vector3(0.431, 0.293, 0.853), new Vector3(0.853, 0.431, 0.293), new Vector3(0.293, 0.853, 0.431)]) {
    const ray = new Ray(point, direction.normalize()), distances: number[] = [];
    for (const triangle of triangles) {
      if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) continue;
      const distance = hit.distanceTo(point);
      if (distance > 1e-8 && !distances.some((previous) => Math.abs(previous - distance) < 1e-7)) distances.push(distance);
    }
    if (distances.length % 2) votes++;
  }
  if (votes < 2) return false;
  let nearest = Infinity;
  for (const triangle of triangles) nearest = Math.min(nearest, triangle.closestPointToPoint(point, hit).distanceTo(point));
  return nearest > 0.00005;
}

/** Whole real skin rings 2 mm past MCP to 2 mm before IP; the buried metacarpal is intentionally excluded. */
function proximalThumbSurface(hand: ArticulatedHand): Vector3[] {
  const skin = node(hand, "thumb_skin") as SkinnedMesh;
  expect(skin.isSkinnedMesh).toBe(true); expect(skin.visible).toBe(true);
  skin.updateMatrixWorld(true); skin.skeleton.update();
  const metacarpal = node(hand, "thumb_MCP").position.length();
  const proximal = node(hand, "thumb_IP").position.length(), distal = node(hand, "thumb_tip").position.length();
  const uv = skin.geometry.getAttribute("uv"), rings = new Map<number, Vector3[]>();
  for (let index = 0; index < uv.count; index++) {
    // The source strip uses along/(total+2.5 mm); glTF flips the V coordinate.
    const v = 1 - uv.getY(index), along = v * (metacarpal + proximal + distal + 0.0025) - metacarpal;
    if (along < 0.002 || along > proximal - 0.002) continue;
    const point = skin.localToWorld(skin.getVertexPosition(index, new Vector3())), ring = rings.get(v) ?? [];
    if (!ring.some((previous) => previous.distanceToSquared(point) < 1e-18)) ring.push(point);
    rings.set(v, ring);
  }
  expect(rings.size, "complete proximal skin sections rather than selected visible points").toBeGreaterThanOrEqual(5);
  const points = [...rings.values()].flat();
  expect(points.length, "full physical circumferences, deduplicating only UV seams").toBeGreaterThanOrEqual(160);
  return points;
}

describe("anatomical thumb and four-finger directions", () => {
  it("keeps left/right chirality and the thumb on the index side through real mirror and presentation transforms", async () => {
    const hand = await detailHand();
    // The pinned figure's independently authored LEFT reference is distal+Y,
    // radial+X, dorsal+Z. (Y cross X) dot Z is negative; RIGHT is its mirror.
    const stockLeft = new Vector3(0, 1, 0).cross(new Vector3(1, 0, 0)).dot(new Vector3(0, 0, 1));
    expect(stockLeft).toBe(-1);
    try {
      for (const side of ["left", "right"] as const) for (const role of roles) {
        pose(hand, side, role);
        const palm = node(hand, "palm_frame"), dorsal = direction(palm, new Vector3(0, 1, 0));
        const distal = fingers.reduce((sum, digit) => sum.add(point(hand, `${digit}_MCP`)), new Vector3())
          .multiplyScalar(0.25).sub(point(hand, "wrist")).normalize();
        const radial = point(hand, "index_MCP").sub(point(hand, "little_MCP")).normalize();
        const chirality = distal.clone().cross(radial).dot(dorsal);
        expect(chirality * (side === "left" ? stockLeft : -stockLeft), `${side} actual hand chirality`).toBeGreaterThan(0.8);
        const thumbSide = point(hand, "thumb_CMC").sub(point(hand, "little_MCP")).dot(radial);
        expect(thumbSide, `${side} thumb grows on the index/radial side`).toBeGreaterThan(0.025);
      }
    } finally { hand.dispose(); }
  });

  it("bends the four fingers toward the actual palm while retaining forward PIP/DIP curls on both hands", async () => {
    const hand = await detailHand();
    try {
      for (const side of ["left", "right"] as const) for (const role of roles) {
        pose(hand, side, role);
        const palm = node(hand, "palm_frame"), volar = direction(palm, new Vector3(0, -1, 0));
        const radial = direction(palm, new Vector3(0, 0, 1));
        const reflection = Math.sign(palm.matrixWorld.determinant());
        for (const digit of fingers) {
          const joints = ["MCP", "PIP", "DIP", "tip"].map((joint) => point(hand, `${digit}_${joint}`));
          const bones = joints.slice(1).map((p, index) => p.clone().sub(joints[index]!).normalize());
          expect(bones[0]!.dot(volar), `${side}/${digit} MCP folds into the palm`).toBeGreaterThan(0.1);
          for (let index = 0; index < 2; index++) {
            const curl = bones[index]!.clone().cross(bones[index + 1]!).dot(radial) * reflection;
            expect(curl, `${side}/${digit}/${index === 0 ? "PIP" : "DIP"} curls rather than reversing`).toBeGreaterThan(0.04);
          }
        }
      }
    } finally { hand.dispose(); }
  });

  it("places every actual nail on the side opposite its distal volar pulp after mirroring", async () => {
    const hand = await detailHand();
    try {
      for (const side of ["left", "right"] as const) for (const role of roles) {
        pose(hand, side, role);
        for (const digit of ["thumb", ...fingers]) {
          const nail = node(hand, `${digit}_nail`) as Mesh;
          expect(nail.isMesh).toBe(true);
          if (nail instanceof SkinnedMesh) nail.skeleton.update();
          const centre = new Vector3(), vertex = new Vector3(), positions = nail.geometry.getAttribute("position");
          for (let index = 0; index < positions.count; index++) centre.add(nail.localToWorld(nail.getVertexPosition(index, vertex)));
          centre.divideScalar(positions.count);
          const start = point(hand, `${digit}_${digit === "thumb" ? "IP" : "DIP"}`);
          const along = point(hand, `${digit}_tip`).sub(start).normalize();
          const transverse = centre.sub(start); transverse.addScaledVector(along, -transverse.dot(along));
          expect(transverse.length(), `${digit} nail is on the physical skin surface, away from the bone axis`).toBeGreaterThan(0.002);
          // A working acquisition may move onto the rounded distal crest. Use
          // its fixed anatomical volar centre rather than treating that tilted
          // contact normal as the entire phalanx's volar direction.
          const centreName = digit === "thumb" || digit === "index" ? `${digit}_pad_roll_c0_contact` : `${digit}_pad_contact`;
          const pulp = direction(node(hand, centreName), new Vector3(0, 1, 0));
          pulp.addScaledVector(along, -pulp.dot(along)).normalize();
          expect(transverse.normalize().dot(pulp), `${side}/${role.pose}/${digit} nail and volar pulp face opposite sides`).toBeLessThan(-0.95);
        }
      }
    } finally { hand.dispose(); }
  });

  it("keeps the working thumb MCP palmar and exposes its proximal phalanx in the authored default needle grips", async () => {
    const hand = await detailHand();
    // These depict the authored needle holds. They are not population ROM limits
    // or a demand that the carpal/metacarpal thumb root sit outside its thenar tissue.
    const working = [
      { role: roles[0]!, maximumBuriedFraction: 0.4 },
      { role: roles[2]!, maximumBuriedFraction: 0.15 },
    ];
    try {
      for (const side of ["left", "right"] as const) for (const { role, maximumBuriedFraction } of working) {
        pose(hand, side, role);
        const palm = node(hand, "palm_frame"), mcp = palm.worldToLocal(point(hand, "thumb_MCP"));
        expect(mcp.y, `${side}/${role.pose} working thumb knuckle stays in the palmar half`).toBeLessThan(-0.004);
        const triangles = palmSurface(hand), surface = proximalThumbSurface(hand);
        const buried = surface.filter((point) => insidePalmBeyondTolerance(point, triangles)).length;
        expect(buried / surface.length, `${side}/${role.pose} actual proximal skin swallowed by the palm: ${buried}/${surface.length}`)
          .toBeLessThan(maximumBuriedFraction);
      }
    } finally { hand.dispose(); }
  });
});
