import { Box3, Mesh, Ray, SkinnedMesh, Triangle, Vector3 } from "three";

interface FaceTree {
  box: Box3;
  faces?: Triangle[];
  children?: [FaceTree, FaceTree];
}

function faceTree(faces: Triangle[]): FaceTree {
  const box = new Box3();
  for (const face of faces) { box.expandByPoint(face.a); box.expandByPoint(face.b); box.expandByPoint(face.c); }
  if (faces.length <= 12) return { box, faces };
  const size = box.getSize(new Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  faces.sort((a, b) => a.a[axis] + a.b[axis] + a.c[axis] - b.a[axis] - b.b[axis] - b.c[axis]);
  const middle = Math.floor(faces.length / 2);
  return { box, children: [faceTree(faces.slice(0, middle)), faceTree(faces.slice(middle))] };
}

const probeDirections = [new Vector3(.431, .293, .853), new Vector3(.853, .431, .293),
  new Vector3(.293, .853, .431)].map((axis) => axis.normalize());

/** Real regional surface, sampled once in the current pose. No closure triangles across webs. */
export function posedSkinRegion(mesh: Mesh) {
  mesh.updateWorldMatrix(true, false);
  // Attached skins refresh bindMatrixInverse in updateMatrixWorld.
  mesh.updateMatrixWorld(true);
  if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
  const points = Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, vertex) =>
    mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld));
  const indices = mesh.geometry.getIndex()!, faces: Triangle[] = [];
  for (let i = 0; i < indices.count; i += 3) {
    faces.push(new Triangle(points[indices.getX(i)]!, points[indices.getX(i + 1)]!, points[indices.getX(i + 2)]!));
  }
  const root = faceTree(faces), orientation = Math.sign(mesh.matrixWorld.determinant());
  const ray = new Ray(), hit = new Vector3(), normal = new Vector3(), backward = new Vector3();

  // Finger patches have an open proximal material ring. A positive observation
  // requires *two* facing-away skin hits on opposite rays. A ray escaping via
  // an open ring cannot qualify, even when one-sided parity looks odd.
  function exitsSkin(point: Vector3, direction: Vector3) {
    ray.set(point, direction);
    let closest = Infinity, outward = false;
    function visit(node: FaceTree) {
      if (!ray.intersectBox(node.box, hit)) return;
      if (node.children) { visit(node.children[0]); visit(node.children[1]); }
      else for (const face of node.faces!) {
        if (!ray.intersectTriangle(face.a, face.b, face.c, false, hit)) continue;
        const distance = point.distanceToSquared(hit);
        if (distance < closest) {
          closest = distance;
          outward = orientation * face.getNormal(normal).dot(direction) > 1e-8;
        }
      }
    }
    visit(root);
    return outward;
  }

  function intrusion(point: Vector3) {
    if (!root.box.containsPoint(point)) return 0;
    if (!probeDirections.some((axis) => exitsSkin(point, axis) && exitsSkin(point, backward.copy(axis).negate()))) return 0;
    let squared = Infinity;
    function closest(node: FaceTree) {
      if (node.box.distanceToPoint(point) ** 2 >= squared) return;
      if (node.children) { closest(node.children[0]); closest(node.children[1]); }
      else for (const face of node.faces!) {
        squared = Math.min(squared, face.closestPointToPoint(point, hit).distanceToSquared(point));
      }
    }
    closest(root);
    return Math.sqrt(squared);
  }
  return { points, intrusion };
}

export function distalSkinIntrusion(from: SkinnedMesh, into: SkinnedMesh) {
  const target = posedSkinRegion(into);
  from.skeleton.update();
  const joints = from.geometry.getAttribute("skinIndex"), weights = from.geometry.getAttribute("skinWeight");
  let maximum = 0;
  const point = new Vector3();
  for (let vertex = 0; vertex < joints.count; vertex++) {
    let distalWeight = 0;
    for (let i = 0; i < joints.itemSize; i++) {
      if (from.skeleton.bones[joints.getComponent(vertex, i)]!.name.endsWith("_distal")) distalWeight += weights.getComponent(vertex, i);
    }
    if (distalWeight >= .8) maximum = Math.max(maximum,
      target.intrusion(from.getVertexPosition(vertex, point).applyMatrix4(from.matrixWorld)));
  }
  return maximum;
}
