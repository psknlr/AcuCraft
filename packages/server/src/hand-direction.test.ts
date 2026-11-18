import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mesh, Object3D, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand, type FingerPose } from "../web/stage/hand.js";
import { collectCompositeSkin, sampleCompositeSkin } from "../../../tools/test/hand-composite-skin.js";

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

  it("keeps the working thumb MCP palmar and the actual palm/thumb skin joined under reflection and a rotated scene", async () => {
    const hand = await detailHand();
    // The outer skin is one physical assembly split into material charts. A
    // thumb vertex is now on that assembly itself, so testing its occupancy
    // against a separately closed palm would no longer measure the junction.
    const skin = collectCompositeSkin(hand.model);
    try {
      expect(skin.topology.connectedComponentCount).toBe(1);
      expect(skin.topology.eulerCharacteristic).toBe(2);
      expect(skin.topology.boundaryEdgeCount).toBe(0);
      expect(skin.topology.nonManifoldEdgeCount).toBe(0);
      expect(skin.topology.windingConflictCount).toBe(0);
      expect(skin.seamVertices.length, "real shared palm/thumb vertices, rather than two overlapping closed shells").toBeGreaterThan(20);
      for (const side of ["left", "right"] as const) for (const role of roles) {
        pose(hand, side, role);
        const palm = node(hand, "palm_frame"), mcp = palm.worldToLocal(point(hand, "thumb_MCP"));
        expect(mcp.y, `${side}/${role.pose} working thumb knuckle stays in the palmar half`).toBeLessThan(-0.004);
        sampleCompositeSkin(skin);
        expect(skin.maxSeamPositionGapM, `${side}/${role.pose} actual skin position at the junction`).toBeLessThan(0.000005);
        expect(skin.minSeamNormalDot, `${side}/${role.pose} actual deformed normal field across the junction`).toBeGreaterThan(0.99999);
        expect(skin.topology.posedDegenerateFaceCount).toBe(0);
      }
    } finally { hand.dispose(); }
  });
});
