import { Box3, Matrix3, Mesh, Object3D, Ray, SkinnedMesh, Triangle, Vector3 } from "three";

export interface SkinInfluence { bone: string; weight: number }
export interface CompositeSkinMember {
  mesh: SkinnedMesh;
  index: number;
  /** Immutable geometry in the skin's global bind frame. */
  bindPosition: Vector3;
  influences: SkinInfluence[];
  /** Actual posed world-space values, refreshed in place by sampleCompositeSkin. */
  position: Vector3;
  normal: Vector3;
}
export interface CompositeSkinVertex {
  id: number;
  bindPosition: Vector3;
  influences: SkinInfluence[];
  /** The first actual member, never an average that could conceal an open seam. */
  position: Vector3;
  normal: Vector3;
  members: CompositeSkinMember[];
}
export interface CompositeSkinEdge {
  vertices: [number, number];
  faces: number[];
  /** +1 follows the ascending vertex IDs; -1 runs in the opposite direction. */
  directions: number[];
  bindLengthM: number;
  posedLengthM: number;
}
export interface CompositeSkinSeam {
  id: number;
  members: CompositeSkinMember[];
  meshNames: string[];
  maxPositionGapM: number;
  minNormalDot: number;
  maxNormalAngleRad: number;
  maxBindGapM: number;
  maxInfluenceDelta: number;
}
export interface CompositeSkinTopology {
  vertexCount: number;
  edgeCount: number;
  faceCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  windingConflictCount: number;
  connectedComponentCount: number;
  eulerCharacteristic: number;
  bindDegenerateFaceCount: number;
  posedDegenerateFaceCount: number;
  negativeWeightVertexCount: number;
  invalidWeightVertexCount: number;
  maxRawWeightSumError: number;
}
export interface CompositeSkin {
  root: Object3D;
  meshes: SkinnedMesh[];
  vertices: CompositeSkinVertex[];
  members: CompositeSkinMember[];
  /** Actual member coordinates are retained on every face, including both sides of a measured gap. */
  triangles: Triangle[];
  triangleMembers: [CompositeSkinMember, CompositeSkinMember, CompositeSkinMember][];
  triangleVertexIds: [number, number, number][];
  triangleSources: { meshName: string; sourceTriangle: number }[];
  edges: CompositeSkinEdge[];
  seamVertices: CompositeSkinSeam[];
  topology: CompositeSkinTopology;
  maxSeamPositionGapM: number;
  minSeamNormalDot: number;
  maxSeamNormalAngleRad: number;
  weldToleranceM: number;
  influenceTolerance: number;
}

const WELD_TOLERANCE_M = 1e-8;
const INFLUENCE_TOLERANCE = 1e-7;
const finiteVector = (value: Vector3) => Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
// This detects zero-area/near-zero numerical faces, not the stricter authored
// area bounds of any particular anatomical region or its tiny terminal cap.
const DEGENERATE_AREA_M2 = 1e-18;
const influenceDifference = (a: SkinInfluence[], b: SkinInfluence[]): number => {
  if (a.length !== b.length || a.some((entry, i) => entry.bone !== b[i]!.bone)) return Infinity;
  return Math.max(0, ...a.map((entry, i) => Math.abs(entry.weight - b[i]!.weight)));
};

export interface SkinVertexSampler {
  /** Call after changing the pose or morph weights, before sampling its vertices. */
  refresh(): void;
  /** Shader-equivalent world-space position and normal, written into the supplied vectors. */
  sample(index: number, position: Vector3, normal: Vector3): void;
}

/**
 * Sample the actual rendered POSITION/NORMAL morph fields, then skin them using
 * Three's real bone transform. Plain meshes (e.g. keratin) use the same morph
 * contract without a bone transform. Bind geometry is never changed.
 *
 * Morph attributes are checked in full on every refresh, including inactive
 * targets. This deliberately also detects direct CPU-array edits that did not
 * increment BufferAttribute.version. Finite negative/extrapolated influences
 * remain legal, as in Three; invalid counts, indices and fields are rejected.
 */
export function createSkinnedVertexSampler(mesh: Mesh): SkinVertexSampler {
  const sourcePoint = new Vector3(), sourceNormal = new Vector3();
  const basePoint = new Vector3(), baseNormal = new Vector3(), delta = new Vector3(), endpoint = new Vector3();
  const normalMatrix = new Matrix3();
  let positionTargets = mesh.geometry.morphAttributes.position ?? [];
  let normalTargets = mesh.geometry.morphAttributes.normal ?? [];
  let influences: number[] = [], relative = mesh.geometry.morphTargetsRelative;
  let ready = false;
  const sampler: SkinVertexSampler = {
    refresh() {
      ready = false;
      const position = mesh.geometry.getAttribute("position"), normal = mesh.geometry.getAttribute("normal");
      if (!position || !normal || position.itemSize !== 3 || normal.itemSize !== 3 || normal.count !== position.count) {
        throw new Error(`${mesh.name}: invalid physical position/normal attributes`);
      }
      positionTargets = mesh.geometry.morphAttributes.position ?? [];
      normalTargets = mesh.geometry.morphAttributes.normal ?? [];
      const count = Math.max(positionTargets.length, normalTargets.length);
      if (positionTargets.length && normalTargets.length && positionTargets.length !== normalTargets.length) {
        throw new Error(`${mesh.name}: position/normal morph target counts differ`);
      }
      const declared = mesh.morphTargetInfluences;
      if (count && (!declared || declared.length !== count) || !count && declared?.length) {
        throw new Error(`${mesh.name}: morph influence count does not match its targets`);
      }
      influences = declared ?? [];
      if (influences.some((weight) => !Number.isFinite(weight))) throw new Error(`${mesh.name}: non-finite morph influence`);
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
        if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`${mesh.name}: invalid morph dictionary index ${name}/${index}`);
      }
      for (const [kind, targets] of [["position", positionTargets], ["normal", normalTargets]] as const) {
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
          const target = targets[targetIndex]!;
          if (target.itemSize !== 3 || target.count !== position.count) throw new Error(`${mesh.name}: invalid ${kind} morph target ${targetIndex} dimensions`);
          for (let index = 0; index < target.count; index++) {
            delta.fromBufferAttribute(target, index);
            if (!finiteVector(delta)) throw new Error(`${mesh.name}/${index}: non-finite ${kind} morph target ${targetIndex}`);
          }
        }
      }
      relative = mesh.geometry.morphTargetsRelative;
      mesh.updateWorldMatrix(true, false);
      mesh.updateMatrixWorld(true);
      if (mesh instanceof SkinnedMesh) {
        for (const bone of mesh.skeleton.bones) bone.updateWorldMatrix(true, false);
        mesh.skeleton.update();
      }
      normalMatrix.getNormalMatrix(mesh.matrixWorld);
      ready = true;
    },
    sample(index, position, normal) {
      if (!ready) throw new Error(`${mesh.name}: refresh the skin vertex sampler before sampling`);
      const positions = mesh.geometry.getAttribute("position"), normals = mesh.geometry.getAttribute("normal");
      if (!Number.isInteger(index) || index < 0 || index >= positions.count) throw new Error(`${mesh.name}: invalid skin vertex index ${index}`);
      basePoint.fromBufferAttribute(positions, index); sourcePoint.copy(basePoint);
      baseNormal.fromBufferAttribute(normals, index); sourceNormal.copy(baseNormal);
      if (!finiteVector(basePoint) || !finiteVector(baseNormal)) throw new Error(`${mesh.name}/${index}: non-finite source skin field`);
      for (let targetIndex = 0; targetIndex < influences.length; targetIndex++) {
        const weight = influences[targetIndex]!;
        if (weight === 0) continue;
        const positionTarget = positionTargets[targetIndex], normalTarget = normalTargets[targetIndex];
        if (positionTarget) {
          delta.fromBufferAttribute(positionTarget, index);
          if (!relative) delta.sub(basePoint);
          sourcePoint.addScaledVector(delta, weight);
        }
        if (normalTarget) {
          delta.fromBufferAttribute(normalTarget, index);
          if (!relative) delta.sub(baseNormal);
          sourceNormal.addScaledVector(delta, weight);
        }
      }
      if (!finiteVector(sourcePoint) || !finiteVector(sourceNormal) || sourceNormal.lengthSq() <= 1e-24) throw new Error(`${mesh.name}/${index}: invalid morphed skin field`);
      // Transform two points through the exact same affine LBS map. Their
      // difference is the renderer's skinned object normal, including morphs.
      position.copy(sourcePoint); endpoint.copy(sourcePoint).add(sourceNormal);
      if (mesh instanceof SkinnedMesh) {
        mesh.applyBoneTransform(index, position);
        mesh.applyBoneTransform(index, endpoint);
      }
      normal.copy(endpoint.sub(position)).applyNormalMatrix(normalMatrix);
      if (!finiteVector(normal) || normal.lengthSq() <= 1e-24) throw new Error(`${mesh.name}/${index}: invalid posed normal field`);
      normal.normalize(); position.applyMatrix4(mesh.matrixWorld);
      if (!finiteVector(position)) throw new Error(`${mesh.name}/${index}: non-finite posed skin position`);
    },
  };
  return sampler;
}

const compositeSamplers = new WeakMap<CompositeSkin, Map<SkinnedMesh, SkinVertexSampler>>();

export const handSkinParts = ["palm_surface", "thumb_skin", "index_skin", "middle_skin", "ring_skin", "little_skin"];

/**
 * Collect the actual skin assembly without closing its partitions
 * with invented faces. Stable weld IDs come from immutable bind positions AND
 * named bone influences, never from coincident coordinates in a curled pose.
 * UV/normal splits are physical duplicates only when both tests agree.
 */
export function collectCompositeSkin(root: Object3D, names = ["palm_surface", "thumb_skin"]): CompositeSkin {
  root.updateWorldMatrix(true, true);
  root.updateMatrixWorld(true);
  const meshes = names.map((name) => {
    const mesh = root.getObjectByName(name);
    if (!(mesh instanceof SkinnedMesh)) throw new Error(`Composite skin requires the actual SkinnedMesh ${name}`);
    return mesh;
  });
  const vertices: CompositeSkinVertex[] = [], members: CompositeSkinMember[] = [];
  const meshMembers = new Map<SkinnedMesh, CompositeSkinMember[]>();
  const meshVertexIds = new Map<SkinnedMesh, number[]>();
  // Bone names distinguish equivalent global influences from unrelated local
  // skin palettes. The 27 neighboring position buckets avoid quantization-edge
  // misses; an explicit Euclidean/weight test proves every accepted weld.
  const buckets = new Map<string, number[]>();
  const globalPalette = new Map<string, { bone: Object3D; inverseBind: number[] }>();
  let negativeWeightVertexCount = 0, invalidWeightVertexCount = 0, maxRawWeightSumError = 0;
  for (const mesh of meshes) {
    for (let slot = 0; slot < mesh.skeleton.bones.length; slot++) {
      const bone = mesh.skeleton.bones[slot]!, inverse = mesh.skeleton.boneInverses[slot];
      if (!inverse) throw new Error(`${mesh.name}: missing inverse bind for ${bone.name}`);
      const previous = globalPalette.get(bone.name);
      if (previous && (previous.bone !== bone || previous.inverseBind.some((value, i) => Math.abs(value - inverse.elements[i]!) > 1e-10))) {
        throw new Error(`${mesh.name}: ${bone.name} does not identify one shared global bone/bind frame`);
      }
      globalPalette.set(bone.name, { bone, inverseBind: [...inverse.elements] });
    }
    const positions = mesh.geometry.getAttribute("position"), indices = mesh.geometry.getAttribute("skinIndex");
    const weights = mesh.geometry.getAttribute("skinWeight"), normals = mesh.geometry.getAttribute("normal");
    if (!indices || !weights || !normals) throw new Error(`${mesh.name}: missing physical skin attributes`);
    const localMembers: CompositeSkinMember[] = [], localIds: number[] = [];
    for (let index = 0; index < positions.count; index++) {
      const named = new Map<string, number>();
      let rawSum = 0, negative = false, invalid = false;
      for (let channel = 0; channel < weights.itemSize; channel++) {
        const weight = weights.getComponent(index, channel), boneId = indices.getComponent(index, channel);
        if (!Number.isFinite(weight)) { invalid = true; continue; }
        rawSum += weight;
        if (weight < 0) negative = true;
        if (Math.abs(weight) <= 1e-12) continue;
        const bone = mesh.skeleton.bones[boneId];
        if (!bone) throw new Error(`${mesh.name}/${index}: skin influence ${boneId} has no real bone`);
        named.set(bone.name, (named.get(bone.name) ?? 0) + weight);
      }
      if (negative) negativeWeightVertexCount++;
      if (invalid || !Number.isFinite(rawSum) || rawSum <= 0) invalidWeightVertexCount++;
      maxRawWeightSumError = Math.max(maxRawWeightSumError, Number.isFinite(rawSum) ? Math.abs(rawSum - 1) : Infinity);
      const influences = [...named].map(([bone, weight]) => ({ bone, weight: weight / (rawSum > 0 ? rawSum : 1) }))
        .sort((a, b) => a.bone.localeCompare(b.bone));
      const bindPosition = new Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.bindMatrix);
      if (!finiteVector(bindPosition)) throw new Error(`${mesh.name}/${index}: non-finite bind skin position`);
      const member: CompositeSkinMember = { mesh, index, bindPosition, influences, position: new Vector3(), normal: new Vector3() };
      const cell = bindPosition.toArray().map((value) => Math.floor(value / WELD_TOLERANCE_M));
      const palette = influences.map((entry) => entry.bone).join("\u0000");
      const key = (x: number, y: number, z: number) => `${palette}:${x},${y},${z}`;
      let match: CompositeSkinVertex | undefined;
      for (let x = -1; x <= 1 && !match; x++) for (let y = -1; y <= 1 && !match; y++) for (let z = -1; z <= 1 && !match; z++) {
        for (const id of buckets.get(key(cell[0]! + x, cell[1]! + y, cell[2]! + z)) ?? []) {
          const candidate = vertices[id]!;
          if (candidate.bindPosition.distanceTo(bindPosition) <= WELD_TOLERANCE_M
            && influenceDifference(candidate.influences, influences) <= INFLUENCE_TOLERANCE) { match = candidate; break; }
        }
      }
      if (!match) {
        match = { id: vertices.length, bindPosition: bindPosition.clone(), influences,
          position: member.position, normal: member.normal, members: [] };
        vertices.push(match);
        const ownKey = key(cell[0]!, cell[1]!, cell[2]!), own = buckets.get(ownKey) ?? [];
        own.push(match.id); buckets.set(ownKey, own);
      }
      match.members.push(member); members.push(member); localMembers.push(member); localIds.push(match.id);
    }
    meshMembers.set(mesh, localMembers); meshVertexIds.set(mesh, localIds);
  }
  const triangles: Triangle[] = [], triangleMembers: CompositeSkin["triangleMembers"] = [], triangleVertexIds: [number, number, number][] = [];
  const triangleSources: CompositeSkin["triangleSources"] = [];
  for (const mesh of meshes) {
    const indices = mesh.geometry.index, positions = mesh.geometry.getAttribute("position"), local = meshMembers.get(mesh)!;
    const welded = meshVertexIds.get(mesh)!;
    for (let offset = 0, count = indices?.count ?? positions.count; offset < count; offset += 3) {
      const ids = [0, 1, 2].map((corner) => indices ? indices.getX(offset + corner) : offset + corner);
      const corners = ids.map((id) => local[id]!) as [CompositeSkinMember, CompositeSkinMember, CompositeSkinMember];
      triangleMembers.push(corners);
      triangles.push(new Triangle(corners[0].position, corners[1].position, corners[2].position));
      triangleVertexIds.push(ids.map((id) => welded[id]!) as [number, number, number]);
      triangleSources.push({ meshName: mesh.name, sourceTriangle: offset / 3 });
    }
  }
  const edgeMap = new Map<string, CompositeSkinEdge>();
  const neighbors = Array.from({ length: vertices.length }, () => new Set<number>());
  let bindDegenerateFaceCount = 0;
  const face = new Triangle();
  for (let index = 0; index < triangleVertexIds.length; index++) {
    const ids = triangleVertexIds[index]!;
    if (new Set(ids).size < 3 || face.set(...ids.map((id) => vertices[id]!.bindPosition) as [Vector3, Vector3, Vector3]).getArea() <= DEGENERATE_AREA_M2) bindDegenerateFaceCount++;
    for (const [from, to] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]] as const) {
      const lo = Math.min(from, to), hi = Math.max(from, to), key = `${lo}/${hi}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { vertices: [lo, hi], faces: [], directions: [], bindLengthM: vertices[lo]!.bindPosition.distanceTo(vertices[hi]!.bindPosition), posedLengthM: 0 };
        edgeMap.set(key, edge);
      }
      edge.faces.push(index); edge.directions.push(from === lo ? 1 : -1);
      neighbors[from]!.add(to); neighbors[to]!.add(from);
    }
  }
  const edges = [...edgeMap.values()], visited = new Set<number>();
  let connectedComponentCount = 0;
  for (const vertex of vertices) {
    if (visited.has(vertex.id)) continue;
    connectedComponentCount++;
    const pending = [vertex.id]; visited.add(vertex.id);
    while (pending.length) for (const neighbor of neighbors[pending.pop()!]!) if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
  }
  const seamVertices = vertices.filter((vertex) => new Set(vertex.members.map((member) => member.mesh)).size > 1).map((vertex) => {
    let maxBindGapM = 0, maxInfluenceDelta = 0;
    for (const a of vertex.members) for (const b of vertex.members) {
      maxBindGapM = Math.max(maxBindGapM, a.bindPosition.distanceTo(b.bindPosition));
      maxInfluenceDelta = Math.max(maxInfluenceDelta, influenceDifference(a.influences, b.influences));
    }
    return { id: vertex.id, members: vertex.members, meshNames: [...new Set(vertex.members.map((member) => member.mesh.name))],
      maxBindGapM, maxInfluenceDelta, maxPositionGapM: 0, minNormalDot: 1, maxNormalAngleRad: 0 };
  });
  const composite: CompositeSkin = {
    root, meshes, vertices, members, triangles, triangleMembers, triangleVertexIds, triangleSources, edges, seamVertices,
    topology: { vertexCount: vertices.length, edgeCount: edges.length, faceCount: triangles.length,
      boundaryEdgeCount: edges.filter((edge) => edge.faces.length === 1).length,
      nonManifoldEdgeCount: edges.filter((edge) => edge.faces.length !== 1 && edge.faces.length !== 2).length,
      windingConflictCount: edges.filter((edge) => edge.faces.length === 2 && edge.directions[0] === edge.directions[1]).length,
      connectedComponentCount, eulerCharacteristic: vertices.length - edges.length + triangles.length,
      bindDegenerateFaceCount, posedDegenerateFaceCount: 0,
      negativeWeightVertexCount, invalidWeightVertexCount, maxRawWeightSumError },
    maxSeamPositionGapM: 0, minSeamNormalDot: 1, maxSeamNormalAngleRad: 0,
    weldToleranceM: WELD_TOLERANCE_M, influenceTolerance: INFLUENCE_TOLERANCE,
  };
  compositeSamplers.set(composite, new Map(meshes.map((mesh) => [mesh, createSkinnedVertexSampler(mesh)])));
  return sampleCompositeSkin(composite);
}

/** Refresh actual world geometry/normal fields in place; stable weld topology is reused across poses. */
export function sampleCompositeSkin(composite: CompositeSkin): CompositeSkin {
  composite.root.updateWorldMatrix(true, true);
  // SkinnedMesh's attached bindMatrixInverse is maintained by this method,
  // not by the inherited updateWorldMatrix implementation alone.
  composite.root.updateMatrixWorld(true);
  let samplers = compositeSamplers.get(composite);
  if (!samplers) {
    samplers = new Map(composite.meshes.map((mesh) => [mesh, createSkinnedVertexSampler(mesh)]));
    compositeSamplers.set(composite, samplers);
  }
  for (const mesh of composite.meshes) {
    const sampler = samplers.get(mesh)!;
    sampler.refresh();
    for (const member of composite.members) {
      if (member.mesh !== mesh) continue;
      sampler.sample(member.index, member.position, member.normal);
    }
  }
  for (const edge of composite.edges) edge.posedLengthM = composite.vertices[edge.vertices[0]]!.position.distanceTo(composite.vertices[edge.vertices[1]]!.position);
  composite.topology.posedDegenerateFaceCount = composite.triangles.filter((triangle) => triangle.getArea() <= DEGENERATE_AREA_M2).length;
  composite.maxSeamPositionGapM = 0; composite.minSeamNormalDot = 1; composite.maxSeamNormalAngleRad = 0;
  for (const seam of composite.seamVertices) {
    seam.maxPositionGapM = 0; seam.minNormalDot = 1;
    // Cross-partition pairs measure the newly joined boundary. Intentional
    // sharp edges inside one mesh (e.g. its hidden wrist cap) remain separate.
    for (const a of seam.members) for (const b of seam.members) {
      if (a.mesh === b.mesh) continue;
      seam.maxPositionGapM = Math.max(seam.maxPositionGapM, a.position.distanceTo(b.position));
      seam.minNormalDot = Math.min(seam.minNormalDot, Math.max(-1, Math.min(1, a.normal.dot(b.normal))));
    }
    seam.maxNormalAngleRad = Math.acos(seam.minNormalDot);
    composite.maxSeamPositionGapM = Math.max(composite.maxSeamPositionGapM, seam.maxPositionGapM);
    composite.minSeamNormalDot = Math.min(composite.minSeamNormalDot, seam.minNormalDot);
    composite.maxSeamNormalAngleRad = Math.max(composite.maxSeamNormalAngleRad, seam.maxNormalAngleRad);
  }
  return composite;
}

export interface CompositeSkinCrossing {
  faces: [number, number];
  edge: [number, number];
  point: Vector3;
  barycentric: Vector3;
  /**
   * Min absolute signed distance of the two edge endpoints to the crossed
   * face's plane. This proves an interior crossing with the chosen margin;
   * it is not a measurement of penetration depth into a solid volume.
   */
  planeMarginM: number;
}
interface CrossingTree { box: Box3; faces?: number[]; children?: [CrossingTree, CrossingTree] }
interface CrossingSurface { tree: CrossingTree; normals: Vector3[]; constants: Float64Array }
const crossingTrees = new WeakMap<CompositeSkin, CrossingSurface>();
function buildCrossingTree(composite: CompositeSkin, faces: number[]): CrossingTree {
  const box = new Box3();
  for (const id of faces) {
    const face = composite.triangles[id]!;
    box.expandByPoint(face.a); box.expandByPoint(face.b); box.expandByPoint(face.c);
  }
  if (faces.length <= 12) return { box, faces };
  const size = box.getSize(new Vector3()), axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  faces.sort((a, b) => {
    const x = composite.triangles[a]!, y = composite.triangles[b]!;
    return x.a[axis] + x.b[axis] + x.c[axis] - y.a[axis] - y.b[axis] - y.c[axis];
  });
  const middle = Math.floor(faces.length / 2);
  return { box, children: [buildCrossingTree(composite, faces.slice(0, middle)), buildCrossingTree(composite, faces.slice(middle))] };
}
function refitCrossingTree(composite: CompositeSkin, node: CrossingTree): void {
  node.box.makeEmpty();
  if (node.children) for (const child of node.children) { refitCrossingTree(composite, child); node.box.union(child.box); }
  else for (const id of node.faces!) {
    const face = composite.triangles[id]!;
    node.box.expandByPoint(face.a); node.box.expandByPoint(face.b); node.box.expandByPoint(face.c);
  }
}

/**
 * Actual non-adjacent triangle intersections in the sampled skin assembly.
 * Each crossing must pass through a face interior while its edge endpoints
 * lie on opposite sides of the face plane beyond toleranceM. Shared bind-ID
 * vertices define adjacency; coincident posed points never redefine topology.
 * Coplanar overlap and adjacent fan foldovers need separate area/orientation
 * checks; absence of these finite crossings is not a swept-volume proof.
 */
export function findCompositeCrossings(composite: CompositeSkin,
  options: { toleranceM?: number; maxCrossings?: number } = {}): CompositeSkinCrossing[] {
  const tolerance = options.toleranceM ?? 0.00005, limit = options.maxCrossings ?? Infinity;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError("Crossing tolerance must be a finite nonnegative distance");
  if (!(limit === Infinity || Number.isInteger(limit) && limit > 0)) throw new RangeError("maxCrossings must be a positive integer or Infinity");
  let surface = crossingTrees.get(composite);
  if (!surface) {
    surface = { tree: buildCrossingTree(composite, composite.triangles.map((_, id) => id)),
      normals: composite.triangles.map(() => new Vector3()), constants: new Float64Array(composite.triangles.length) };
    crossingTrees.set(composite, surface);
  } else refitCrossingTree(composite, surface.tree);
  // Each face plane is shared by many edge queries. Recompute it once per
  // sampled pose, rather than repeatedly normalizing it in neighboring leaves.
  for (let face = 0; face < composite.triangles.length; face++) {
    const triangle = composite.triangles[face]!, normal = surface.normals[face]!;
    triangle.getNormal(normal); surface.constants[face] = normal.dot(triangle.a);
  }
  const tree = surface.tree;
  const results: CompositeSkinCrossing[] = [], pairs = new Set<string>();
  const ray = new Ray(), direction = new Vector3(), point = new Vector3(), barycentric = new Vector3();
  const bounds = new Box3();
  for (const edge of composite.edges) {
    if (results.length >= limit) break;
    // Retain both actual rendered edge locations if an invalid seam has opened.
    // A welded representative must never quietly heal that geometric failure.
    const variants: { a: Vector3; b: Vector3; faces: number[] }[] = [];
    for (const source of edge.faces) {
      const ids = composite.triangleVertexIds[source]!, triangle = composite.triangles[source]!;
      const corners = [triangle.a, triangle.b, triangle.c];
      const a = corners[ids.indexOf(edge.vertices[0])]!, b = corners[ids.indexOf(edge.vertices[1])]!;
      const same = variants.find((variant) => variant.a.distanceToSquared(a) <= 1e-24 && variant.b.distanceToSquared(b) <= 1e-24);
      if (same) same.faces.push(source); else variants.push({ a, b, faces: [source] });
    }
    for (const variant of variants) {
      if (results.length >= limit) break;
      const { a, b } = variant, length = direction.subVectors(b, a).length();
      if (length <= tolerance * 2) continue;
      direction.divideScalar(length); ray.set(a, direction); bounds.setFromPoints([a, b]);
      const visit = (node: CrossingTree): void => {
        if (results.length >= limit || !bounds.intersectsBox(node.box)) return;
        if (node.children) { visit(node.children[0]); visit(node.children[1]); return; }
        for (const id of node.faces!) {
          if (results.length >= limit) return;
          const targetIds = composite.triangleVertexIds[id]!;
          if (edge.vertices.some((vertex) => targetIds.includes(vertex))) continue;
          const sources = variant.faces.filter((face) => !composite.triangleVertexIds[face]!.some((vertex) => targetIds.includes(vertex)));
          if (!sources.length) continue;
          const triangle = composite.triangles[id]!, normal = surface.normals[id]!, constant = surface.constants[id]!;
          const da = normal.dot(a) - constant, db = normal.dot(b) - constant;
          if (!(da > tolerance && db < -tolerance || db > tolerance && da < -tolerance)) continue;
          if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, point)) continue;
          const distance = point.distanceTo(a);
          if (distance <= tolerance || distance >= length - tolerance) continue;
          triangle.getBarycoord(point, barycentric);
          if (Math.min(barycentric.x, barycentric.y, barycentric.z) <= 1e-7) continue;
          for (const source of sources) {
            const key = source < id ? `${source}/${id}` : `${id}/${source}`;
            if (pairs.has(key)) continue;
            pairs.add(key);
            results.push({ faces: [source, id], edge: edge.vertices, point: point.clone(), barycentric: barycentric.clone(),
              planeMarginM: Math.min(Math.abs(da), Math.abs(db)) });
            if (results.length >= limit) return;
          }
        }
      };
      visit(tree);
    }
  }
  return results;
}

export interface CompositeSkinFoldedFace {
  face: number;
  meshName: string;
  sourceTriangle: number;
  areaM2: number;
  normalDot: number;
}

/**
 * Compare actual face geometry to its actual three rendered corner normals.
 * The geometric cross product changes sign under a reflected hand, while the
 * shader's inverse-transpose normal still points outward; account for that
 * determinant explicitly. Welded representative normals cannot substitute for
 * a real UV split or an intentionally sharp wrist-cap corner.
 */
export function compositeFaceNormalAlignment(composite: CompositeSkin, face: number): number {
  const corners = composite.triangleMembers[face];
  if (!corners) throw new RangeError(`Composite skin has no face ${face}`);
  const geometric = composite.triangles[face]!.getNormal(new Vector3());
  const rendered = corners.reduce((sum, corner) => sum.add(corner.normal), new Vector3()).normalize();
  const reflection = Math.sign(corners[0].mesh.matrixWorld.determinant());
  return geometric.dot(rendered) * reflection;
}

/** Finite face fold/normal disagreement; it complements the non-adjacent crossing test. */
export function findCompositeFoldedFaces(composite: CompositeSkin,
  options: { minimumDot?: number; minimumAreaM2?: number } = {}): CompositeSkinFoldedFace[] {
  const minimumDot = options.minimumDot ?? 0, minimumArea = options.minimumAreaM2 ?? 0;
  if (!Number.isFinite(minimumDot) || minimumDot < -1 || minimumDot > 1
    || !Number.isFinite(minimumArea) || minimumArea < 0) throw new RangeError("Invalid composite face alignment bounds");
  const results: CompositeSkinFoldedFace[] = [];
  for (let face = 0; face < composite.triangles.length; face++) {
    const areaM2 = composite.triangles[face]!.getArea();
    if (areaM2 < minimumArea) continue;
    const normalDot = compositeFaceNormalAlignment(composite, face);
    if (normalDot < minimumDot) results.push({ face, ...composite.triangleSources[face]!, areaM2, normalDot });
  }
  return results;
}
