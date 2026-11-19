import { Box3, BufferGeometry, Matrix4, Mesh, Ray, SkinnedMesh, Triangle, Vector3 } from "three";
import type { BufferAttribute, Group, InterleavedBufferAttribute } from "three";
import type { Person } from "./cast.js";

interface Node { box: Box3; children?: [Node, Node]; triangles?: Triangle[] }
interface Surface { root: Node; inverse: Matrix4; signature: number[]; revision: number; geometry: BufferGeometry; positions: object; indices: object | null }
interface HandSurface {
  signature: number[]; points: Vector3[]; box: Box3; revision: number;
  geometry: BufferGeometry; positions: object;
  indices: object | null; weights: object | null;
  topology: object | null;
  morphPositions: object[];
  results: WeakMap<Mesh, { hand: number; body: number; union?: HandPart[]; intersects: boolean }>;
}
interface HandPart { mesh: Mesh; surface: HandSurface; revision: number }
const thumbPalmParts = ["palm_surface", "thumb_skin"];
const handParts = [...thumbPalmParts, "index_skin", "middle_skin", "ring_skin", "little_skin"];
const tolerance = 0.00005;
const direction = new Vector3(0.431, 0.293, 0.853).normalize();
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-10);
const attributeVersion = (attribute: BufferAttribute | InterleavedBufferAttribute) => "version" in attribute ? attribute.version : attribute.data.version;

function build(triangles: Triangle[]): Node {
  const box = new Box3();
  for (const t of triangles) box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
  if (triangles.length <= 12) return { box, triangles };
  const size = box.getSize(new Vector3()), axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  triangles.sort((a, b) => a.a[axis] + a.b[axis] + a.c[axis] - b.a[axis] - b.b[axis] - b.c[axis]);
  const middle = Math.floor(triangles.length / 2);
  return { box, children: [build(triangles.slice(0, middle)), build(triangles.slice(middle))] };
}

/** Geometry-based guard for this schematic detail hand, independent of clinical needle decisions. */
export class PatientClearance {
  private readonly trees = new WeakMap<BufferGeometry, { version: string; root: Node; positions: object; indices: object | null }>();
  private readonly bodies = new WeakMap<Mesh, Surface>();
  private readonly hands = new WeakMap<Mesh, HandSurface>();
  private readonly skinUnions = new WeakMap<Group, HandPart[]>();
  private readonly usedBones = new WeakMap<BufferGeometry, { indices: object; weights: object; version: string; bones: number[] }>();
  private readonly localPoints: Vector3[] = [];

  intersects(model: Group, patient: Person | null): boolean {
    if (!patient) return false;
    patient.holder.updateWorldMatrix(true, true);
    model.updateWorldMatrix(true, false);
    // SkinnedMesh updates its attached bindMatrixInverse in updateMatrixWorld (not
    // updateWorldMatrix). Candidate wrist rotations must deform and transform skin exactly once.
    model.updateMatrixWorld(true);
    const bodies = [...new Set(patient.rig.skin.map((skin) => skin.mesh))];
    const joined = this.skinUnion(model);
    let intersects = false;
    model.traverse((object) => {
      if (intersects || !(object instanceof Mesh)) return;
      const part = joined?.find((entry) => entry.mesh === object);
      const hand = part?.surface ?? this.handSurface(object);
      const union = part ? joined : undefined;
      for (const mesh of bodies) {
        const body = this.bodySurface(mesh);
        const cached = hand.results.get(mesh);
        if (cached?.hand === hand.revision && cached.body === body.revision && cached.union === union) {
          if (cached.intersects) { intersects = true; break; }
          continue;
        }
        const worldBox = body.root.box.clone().applyMatrix4(mesh.matrixWorld);
        const local = new Vector3();
        const hit = hand.box.intersectsBox(worldBox) && (hand.points.some((point) => {
          if (!worldBox.containsPoint(point)) return false;
          local.copy(point).applyMatrix4(body.inverse);
          return this.inside(local, body.root, body.inverse.getMaxScaleOnAxis() * tolerance);
        }) || this.crossesSurface(object, hand, body, union));
        hand.results.set(mesh, { hand: hand.revision, body: body.revision, union, intersects: hit });
        if (hit) { intersects = true; break; }
      }
    });
    return intersects;
  }

  /** The visible charts bound a single skin. Parity at a shared edge depends on every chart. */
  private skinUnion(model: Group): HandPart[] | undefined {
    const palm = model.getObjectByName("palm_surface");
    const declaration = palm?.userData.skinUnion;
    if (!declaration) return;
    const names = declaration.schema === "acucraft.skin-union@2" && declaration.id === "hand" ? handParts
      : declaration.schema === "acucraft.skin-union@1" && declaration.id === "thumb-palm" ? thumbPalmParts : undefined;
    if (!names) return;
    const parts: HandPart[] = [];
    for (const name of names) {
      const mesh = model.getObjectByName(name);
      const union = mesh?.userData.skinUnion;
      if (!(mesh instanceof Mesh) || union?.schema !== declaration.schema || union.id !== declaration.id || union.individualClosed !== false
        || !Array.isArray(union.parts) || union.parts.length !== names.length || !names.every((part, i) => union.parts[i] === part)) return;
      const surface = this.handSurface(mesh);
      parts.push({ mesh, surface, revision: surface.revision });
    }
    const previous = this.skinUnions.get(model);
    if (previous?.length === parts.length && previous.every((part, i) => part.mesh === parts[i]!.mesh && part.revision === parts[i]!.revision)) return previous;
    this.skinUnions.set(model, parts);
    return parts;
  }

  private bodySurface(mesh: Mesh): Surface {
    let surface = this.bodies.get(mesh);
    const positions = mesh.geometry.getAttribute("position"), indices = mesh.geometry.index;
    const positionVersion = attributeVersion(positions);
    const signature = [...mesh.matrixWorld.elements, positionVersion, indices?.version ?? 0];
    if (surface && surface.geometry === mesh.geometry && surface.positions === positions && surface.indices === indices && same(surface.signature, signature)) return surface;
    const version = `${positionVersion}:${indices?.version ?? 0}`;
    let tree = this.trees.get(mesh.geometry);
    if (tree?.version !== version || tree.positions !== positions || tree.indices !== indices) {
      const triangles: Triangle[] = [];
      for (let i = 0, count = indices?.count ?? positions.count; i < count; i += 3) {
        const vertex = (offset: number) => new Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + offset) : i + offset);
        triangles.push(new Triangle(vertex(0), vertex(1), vertex(2)));
      }
      tree = { version, root: build(triangles), positions, indices }; this.trees.set(mesh.geometry, tree);
    }
    surface = { root: tree.root, inverse: mesh.matrixWorld.clone().invert(), signature, revision: (surface?.revision ?? 0) + 1, geometry: mesh.geometry, positions, indices };
    this.bodies.set(mesh, surface);
    return surface;
  }

  private handSurface(mesh: Mesh): HandSurface {
    if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
    const positions = mesh.geometry.getAttribute("position");
    const signature = [...mesh.matrixWorld.elements, attributeVersion(positions), mesh.geometry.index?.version ?? 0];
    const morphPositions = mesh.geometry.morphAttributes.position ?? [];
    signature.push(mesh.geometry.morphTargetsRelative ? 1 : 0, morphPositions.length,
      ...morphPositions.map(attributeVersion), ...(mesh.morphTargetInfluences ?? []));
    let skinIndices: object | null = null, skinWeights: object | null = null;
    if (mesh instanceof SkinnedMesh) {
      const indices = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
      skinIndices = indices; skinWeights = weights;
      const version = `${attributeVersion(indices)}:${attributeVersion(weights)}`;
      let mapping = this.usedBones.get(mesh.geometry);
      if (!mapping || mapping.indices !== indices || mapping.weights !== weights || mapping.version !== version) {
        const used = new Set<number>();
        for (let i = 0; i < indices.count; i++) for (let j = 0; j < indices.itemSize; j++) {
          if (weights.getComponent(i, j) > 0) used.add(indices.getComponent(i, j));
        }
        mapping = { indices, weights, version, bones: [...used] }; this.usedBones.set(mesh.geometry, mapping);
      }
      signature.push(attributeVersion(indices), attributeVersion(weights));
      for (const bone of mapping.bones) for (let i = 0; i < 16; i++) signature.push(mesh.skeleton.boneMatrices[bone * 16 + i]!);
    }
    let surface = this.hands.get(mesh);
    if (surface && surface.geometry === mesh.geometry && surface.positions === positions && surface.indices === skinIndices && surface.weights === skinWeights && surface.topology === mesh.geometry.index
      && surface.morphPositions.length === morphPositions.length && surface.morphPositions.every((attribute, i) => attribute === morphPositions[i])
      && same(surface.signature, signature)) return surface;
    const count = positions.count;
    surface ??= { signature: [], points: [], box: new Box3(), revision: 0, geometry: mesh.geometry, positions, indices: skinIndices, weights: skinWeights, topology: mesh.geometry.index, morphPositions: [], results: new WeakMap() };
    if (surface.points.length !== count) surface.points = Array.from({ length: count }, () => new Vector3());
    surface.geometry = mesh.geometry; surface.positions = positions;
    surface.indices = skinIndices; surface.weights = skinWeights;
    surface.topology = mesh.geometry.index;
    surface.morphPositions = [...morphPositions];
    surface.box.makeEmpty();
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, surface.points[i]!).applyMatrix4(mesh.matrixWorld);
      surface.box.expandByPoint(surface.points[i]!);
    }
    surface.signature = signature; surface.revision++;
    this.hands.set(mesh, surface);
    return surface;
  }

  private inside(point: Vector3, root: Node, epsilon: number): boolean {
    if (!root.box.containsPoint(point)) return false;
    const ray = new Ray(point, direction), target = new Vector3(), hits: number[] = [];
    const visit = (node: Node) => {
      if (!ray.intersectsBox(node.box)) return;
      if (node.children) { visit(node.children[0]); visit(node.children[1]); }
      else for (const triangle of node.triangles!) {
        // Both triangle orientations count, even though the renderer disables body picking.
        if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, target)) continue;
        const distance = point.distanceTo(target);
        if (distance > 1e-8 && !hits.some((d) => Math.abs(d - distance) < 1e-7)) hits.push(distance);
      }
    };
    visit(root);
    if (hits.length % 2 === 0) return false;
    // Treat the actual surface neighbourhood as contact, not penetration caused by numeric noise.
    const near = (node: Node): boolean => {
      if (node.box.distanceToPoint(point) > epsilon) return false;
      if (node.children) return near(node.children[0]) || near(node.children[1]);
      return node.triangles!.some((triangle) => triangle.closestPointToPoint(point, target).distanceTo(point) <= epsilon);
    };
    return !near(root);
  }

  /** A small body part can cross the interior of a skin triangle without containing its vertices. */
  private crossesSurface(mesh: Mesh, hand: HandSurface, body: Surface, volume?: HandPart[]): boolean {
    const epsilon = body.inverse.getMaxScaleOnAxis() * tolerance;
    for (let i = 0; i < hand.points.length; i++) {
      this.localPoints[i] ??= new Vector3();
      this.localPoints[i]!.copy(hand.points[i]!).applyMatrix4(body.inverse);
    }
    const triangle = new Triangle(), bounds = new Box3(), normal = new Vector3(), direction = new Vector3();
    const ray = new Ray(), hit = new Vector3(), barycentric = new Vector3(), sample = new Vector3();
    let handTree: Node | undefined;
    const overlapAtEdge = (point: Vector3): boolean => {
      if (!handTree) {
        const triangles: Triangle[] = [];
        for (const part of volume ?? [{ mesh, surface: hand }]) {
          const indices = part.mesh.geometry.index;
          for (let i = 0, count = indices?.count ?? part.surface.points.length; i < count; i += 3) {
            const vertex = (j: number) => part.surface.points[indices ? indices.getX(i + j) : i + j]!.clone().applyMatrix4(body.inverse);
            triangles.push(new Triangle(vertex(0), vertex(1), vertex(2)));
          }
        }
        handTree = build(triangles);
      }
      // Shared edges can also belong to overlapping closed volumes (for example equal-thickness
      // crossing shapes). Confirm material inside both bodies instead of rejecting every edge hit.
      const origin = point.clone(), probe = new Vector3();
      for (const step of [epsilon * 2, epsilon * 4]) for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        probe.copy(origin).add(sample.set(x * step, y * step, z * step));
        if (this.inside(probe, body.root, epsilon) && this.inside(probe, handTree, epsilon)) return true;
      }
      return false;
    };
    const crossing = (a: Vector3, b: Vector3, face: Triangle, checkBody: boolean): boolean => {
      face.getNormal(normal);
      const da = normal.dot(a) - normal.dot(face.a), db = normal.dot(b) - normal.dot(face.a);
      if (!(da > epsilon && db < -epsilon || db > epsilon && da < -epsilon)) return false;
      direction.subVectors(b, a);
      const length = direction.length(); direction.divideScalar(length);
      ray.set(a, direction);
      if (!ray.intersectTriangle(face.a, face.b, face.c, false, hit) || hit.distanceTo(a) >= length) return false;
      face.getBarycoord(hit, barycentric);
      if (Math.min(barycentric.x, barycentric.y, barycentric.z) < 1e-8) return overlapAtEdge(hit);
      if (!checkBody) return true;
      const step = epsilon * 2 / Math.max(1e-8, Math.abs(direction.dot(normal))), distance = hit.distanceTo(a);
      for (const sign of [-1, 1]) {
        const at = distance + sign * step;
        if (at <= 0 || at >= length) continue;
        sample.copy(a).addScaledVector(direction, at);
        if (this.inside(sample, body.root, epsilon)) return true;
      }
      return false;
    };
    const visit = (node: Node): boolean => {
      if (!node.box.intersectsBox(bounds)) return false;
      if (node.children) return visit(node.children[0]) || visit(node.children[1]);
      for (const face of node.triangles!) {
        if (crossing(face.a, face.b, triangle, false) || crossing(face.b, face.c, triangle, false) || crossing(face.c, face.a, triangle, false)
          || crossing(triangle.a, triangle.b, face, true) || crossing(triangle.b, triangle.c, face, true) || crossing(triangle.c, triangle.a, face, true)) return true;
      }
      return false;
    };
    const indices = mesh.geometry.index;
    for (let i = 0, count = indices?.count ?? hand.points.length; i < count; i += 3) {
      triangle.set(this.localPoints[indices ? indices.getX(i) : i]!, this.localPoints[indices ? indices.getX(i + 1) : i + 1]!, this.localPoints[indices ? indices.getX(i + 2) : i + 2]!);
      bounds.makeEmpty().expandByPoint(triangle.a).expandByPoint(triangle.b).expandByPoint(triangle.c);
      if (visit(body.root)) return true;
    }
    return false;
  }
}
