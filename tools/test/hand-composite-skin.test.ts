import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix3, Matrix4, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from "three";
import { expect, it } from "vitest";
import { collectCompositeSkin, findCompositeCrossings, findCompositeFoldedFaces, sampleCompositeSkin } from "./hand-composite-skin.js";

const points = [[0, 0, 0], [0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.02]];
const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

function assembly(split = true, offset = new Vector3()) {
  const root = new Group(), fixed = new Bone(), moving = new Bone();
  fixed.name = "palm_root"; moving.name = "thumb_proximal";
  root.add(fixed, moving); root.updateMatrixWorld(true);
  const skeleton = new Skeleton([fixed, moving]);
  const full = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points.flat(), 3)).setIndex(faces.flat());
  full.computeVertexNormals();
  const fullNormals = full.getAttribute("normal");
  const parts = [split ? [faces[0]!] : faces, split ? faces.slice(1) : faces];
  const meshes = parts.map((part, index) => {
    const ids = [...new Set(part.flat())], remap = new Map(ids.map((id, i) => [id, i]));
    const geometry = new BufferGeometry()
      .setAttribute("position", new Float32BufferAttribute(ids.flatMap((id) => points[id]!.map((v, axis) => v + (index ? offset.getComponent(axis) : 0))), 3))
      .setAttribute("normal", new Float32BufferAttribute(ids.flatMap((id) => [fullNormals.getX(id), fullNormals.getY(id), fullNormals.getZ(id)]), 3))
      .setAttribute("skinIndex", new Uint16BufferAttribute(ids.flatMap(() => [0, 0, 0, 0]), 4))
      .setAttribute("skinWeight", new Float32BufferAttribute(ids.flatMap(() => [1, 0, 0, 0]), 4))
      .setIndex(part.flatMap((face) => face.map((id) => remap.get(id)!)));
    const mesh = new SkinnedMesh(geometry);
    mesh.name = index ? "thumb_skin" : "palm_surface";
    root.add(mesh); mesh.bind(skeleton, new Matrix4());
    return mesh;
  });
  full.dispose(); root.updateMatrixWorld(true);
  return { root, meshes };
}

it("recognizes a genuinely closed skin split across two visible charts after a reflected world transform", () => {
  const { root } = assembly(), skin = collectCompositeSkin(root);
  expect(skin.topology).toMatchObject({ connectedComponentCount: 1, eulerCharacteristic: 2,
    boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, windingConflictCount: 0 });
  expect(skin.seamVertices).toHaveLength(3);
  root.position.set(0.4, 0.8, -0.6); root.scale.z = -1;
  root.quaternion.setFromAxisAngle(new Vector3(0.2, 0.8, -0.3).normalize(), 0.7);
  sampleCompositeSkin(skin);
  expect(skin.maxSeamPositionGapM).toBe(0);
  expect(skin.minSeamNormalDot).toBeGreaterThan(0.999999);
  expect(findCompositeCrossings(skin, { toleranceM: 0.00005 })).toEqual([]);
  expect(findCompositeFoldedFaces(skin)).toEqual([]);
});

it("does not weld equal bind positions with different bone ownership or conceal a later physical seam gap", () => {
  const mismatch = assembly(), attributes = mismatch.meshes[1]!.geometry.getAttribute("skinIndex");
  attributes.setX(0, 1);
  const separated = collectCompositeSkin(mismatch.root);
  expect(separated.topology.boundaryEdgeCount).toBeGreaterThan(0);
  expect(separated.seamVertices).toHaveLength(2);

  const differentSkeleton = assembly(), foreign = assembly();
  differentSkeleton.root.remove(differentSkeleton.meshes[1]!);
  differentSkeleton.root.add(foreign.meshes[1]!);
  expect(() => collectCompositeSkin(differentSkeleton.root), "equal bone names cannot join unrelated skeletons").toThrow();

  const current = assembly(), skin = collectCompositeSkin(current.root);
  const positions = current.meshes[1]!.geometry.getAttribute("position");
  positions.setZ(0, positions.getZ(0) + 0.0001);
  sampleCompositeSkin(skin);
  expect(skin.maxSeamPositionGapM).toBeCloseTo(0.0001, 9);
});

it("detects real nonadjacent crossings while retaining the 50 micrometre surface margin", () => {
  const overlapping = assembly(false, new Vector3(0.005, 0.005, 0.005));
  const skin = collectCompositeSkin(overlapping.root);
  const crossings = findCompositeCrossings(skin, { toleranceM: 0.00005, maxCrossings: 1 });
  expect(crossings).toHaveLength(1);
  expect(crossings[0]!.planeMarginM).toBeGreaterThan(0.00005);

  // The second tetrahedron's nearest corner reaches less than 30 micrometres
  // through the first one's inclined face. Contact tolerance must not become
  // a strict zero-intersection rule through a different topology oracle.
  const contact = assembly(false, new Vector3(0.00665, 0.00665, 0.00665));
  expect(findCompositeCrossings(collectCompositeSkin(contact.root), { toleranceM: 0.00005 })).toEqual([]);
});

it("checks actual corner normals separately from positional closure", () => {
  const { root, meshes } = assembly(), normals = meshes[1]!.geometry.getAttribute("normal");
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i));
  const skin = collectCompositeSkin(root);
  expect(skin.topology.boundaryEdgeCount).toBe(0);
  expect(skin.maxSeamPositionGapM).toBe(0);
  expect(findCompositeFoldedFaces(skin).length).toBeGreaterThan(0);
});

it.each([true, false])("samples actual morph positions and normals before skinning (relative=%s)", (relative) => {
  const { root, meshes } = assembly(), translation = new Vector3(0.001, 0.002, -0.0005);
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3), weight = 0.4;
  for (const mesh of meshes) {
    const geometry = mesh.geometry, positions = geometry.getAttribute("position"), normals = geometry.getAttribute("normal");
    geometry.morphTargetsRelative = relative;
    geometry.morphAttributes.position = [new Float32BufferAttribute(Array.from({ length: positions.count }, (_, i) => {
      const p = relative ? new Vector3() : new Vector3().fromBufferAttribute(positions, i);
      return p.add(translation).toArray();
    }).flat(), 3)];
    geometry.morphAttributes.normal = [new Float32BufferAttribute(Array.from({ length: normals.count }, (_, i) => {
      const n = new Vector3().fromBufferAttribute(normals, i), target = n.clone().applyQuaternion(rotation);
      return (relative ? target.sub(n) : target).toArray();
    }).flat(), 3)];
    geometry.morphAttributes.position[0]!.name = geometry.morphAttributes.normal[0]!.name = "web";
    mesh.updateMorphTargets(); mesh.morphTargetInfluences![0] = weight;
  }
  root.scale.z = -1; root.rotation.set(0.2, 0.4, -0.3); root.position.set(0.3, -0.4, 0.8);
  const skin = collectCompositeSkin(root), normalMatrix = new Matrix3().getNormalMatrix(meshes[0]!.matrixWorld);
  for (const member of skin.members) {
    const geometry = member.mesh.geometry;
    const p = new Vector3().fromBufferAttribute(geometry.getAttribute("position"), member.index).addScaledVector(translation, weight).applyMatrix4(member.mesh.matrixWorld);
    const n = new Vector3().fromBufferAttribute(geometry.getAttribute("normal"), member.index);
    const expectedNormal = n.clone().multiplyScalar(1 - weight).addScaledVector(n.clone().applyQuaternion(rotation), weight).applyNormalMatrix(normalMatrix).normalize();
    expect(member.position.distanceTo(p)).toBeLessThan(1e-8);
    expect(member.normal.dot(expectedNormal)).toBeGreaterThan(1 - 1e-12);
  }
  expect(skin.maxSeamPositionGapM).toBeLessThan(1e-9);
  expect(skin.minSeamNormalDot).toBeGreaterThan(1 - 1e-12);
  expect(findCompositeCrossings(skin, { toleranceM: 0.00005 })).toEqual([]);
  meshes[0]!.geometry.morphAttributes.normal![0]!.setX(0, NaN);
  meshes[0]!.geometry.morphAttributes.normal![0]!.needsUpdate = true;
  expect(() => sampleCompositeSkin(skin)).toThrow();
});

it("rejects invalid physical attributes instead of allowing NaNs to bypass geometric checks", () => {
  const invalidPosition = assembly();
  invalidPosition.meshes[0]!.geometry.getAttribute("position").setX(0, NaN);
  expect(() => collectCompositeSkin(invalidPosition.root)).toThrow();
  const invalidNormal = assembly();
  invalidNormal.meshes[1]!.geometry.getAttribute("normal").setXYZ(0, 0, 0, 0);
  expect(() => collectCompositeSkin(invalidNormal.root)).toThrow();
});
