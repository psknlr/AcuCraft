import { Bone, Quaternion, SkinnedMesh, type Object3D } from "three";

export interface HandSkinCorrectives {
  apply(): void;
  reset(): void;
  /** A copy of the last applied weights, keyed by actual glTF morph target name. */
  weights(): Record<string, number>;
}

interface Joint { bone: Bone; control: Object3D }
interface Centre { name: string | null; feature: Float64Array }
interface Partition { mesh: SkinnedMesh; indices: number[] }

const invalid = (reason: string): never => { throw new Error(`Invalid thumb-web correctives: ${reason}`); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const named = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const unitScale = (node: Object3D): boolean => node.scale.x === 1 && node.scale.y === 1 && node.scale.z === 1;

function uniqueNode(model: Object3D, name: string): Object3D {
  const matches: Object3D[] = [];
  model.traverse((node) => { if (node.name === name) matches.push(node); });
  if (matches.length !== 1) return invalid(`expected exactly one node named ${name}`);
  return matches[0]!;
}

/** Column-major rotation matrix features make q and -q exactly equivalent. */
function rotationFeature(q: Quaternion, into: Float64Array, offset: number): void {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(length) || length === 0) invalid("nonfinite or zero joint quaternion");
  const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length;
  into.set([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ], offset);
}

function gaussian(a: Float64Array, b: Float64Array, sigma: number): number {
  let squared = 0;
  for (let i = 0; i < a.length; i++) squared += (a[i]! - b[i]!) ** 2;
  // Divide before squaring so a finite, very small/large sigma cannot create 0/0.
  return Math.exp(-0.5 * (Math.sqrt(squared) / sigma) ** 2);
}

/** Partial-pivoted LU is computed once; no regularization changes the authored interpolation. */
function factorKernel(centres: Centre[], sigma: number): (kernel: Float64Array) => Float64Array {
  const n = centres.length, lu = new Float64Array(n * n), permutation = Array.from({ length: n }, (_, i) => i);
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    lu[row * n + col] = gaussian(centres[row]!.feature, centres[col]!.feature, sigma);
  }
  // K has unit diagonal. This is a floating-point rank check, not a motion/geometry tolerance.
  const rankTolerance = 64 * n * Number.EPSILON;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(lu[row * n + col]!) > Math.abs(lu[pivot * n + col]!)) pivot = row;
    if (Math.abs(lu[pivot * n + col]!) <= rankTolerance) invalid("singular or numerically rank-deficient RBF centres");
    if (pivot !== col) {
      for (let j = 0; j < n; j++) [lu[col * n + j], lu[pivot * n + j]] = [lu[pivot * n + j]!, lu[col * n + j]!];
      [permutation[col], permutation[pivot]] = [permutation[pivot]!, permutation[col]!];
    }
    for (let row = col + 1; row < n; row++) {
      const multiplier = lu[row * n + col]! / lu[col * n + col]!;
      lu[row * n + col] = multiplier;
      for (let j = col + 1; j < n; j++) lu[row * n + j] -= multiplier * lu[col * n + j]!;
    }
  }
  return (kernel) => {
    const result = new Float64Array(n);
    for (let row = 0; row < n; row++) {
      let value = kernel[permutation[row]!]!;
      for (let col = 0; col < row; col++) value -= lu[row * n + col]! * result[col]!;
      result[row] = value;
    }
    for (let row = n - 1; row >= 0; row--) {
      let value = result[row]!;
      for (let col = row + 1; col < n; col++) value -= lu[row * n + col]! * result[col]!;
      result[row] = value / lu[row * n + row]!;
      if (!Number.isFinite(result[row])) invalid("nonfinite interpolated weight");
    }
    return result;
  };
}

function partition(model: Object3D, name: string, targets: string[]): Partition {
  const node = uniqueNode(model, name);
  if (!(node instanceof SkinnedMesh)) return invalid(`${name} is not an actual SkinnedMesh`);
  if (!node.geometry.morphTargetsRelative) return invalid(`${name} must use relative POSITION/NORMAL deltas`);
  const dictionary = node.morphTargetDictionary, influences = node.morphTargetInfluences;
  const positions = node.geometry.morphAttributes.position, normals = node.geometry.morphAttributes.normal;
  if (!dictionary || !influences || !positions || !normals
    || Object.keys(dictionary).length !== targets.length || influences.length !== targets.length
    || positions.length !== targets.length || normals.length !== targets.length
    || influences.some((influence) => !Number.isFinite(influence))) {
    return invalid(`${name} must have matching named POSITION/NORMAL morph targets and influences`);
  }
  const sourcePosition = node.geometry.getAttribute("position"), sourceNormal = node.geometry.getAttribute("normal");
  if (!sourcePosition || !sourceNormal || sourcePosition.itemSize !== 3 || sourceNormal.itemSize !== 3
    || sourcePosition.count === 0 || sourceNormal.count !== sourcePosition.count) invalid(`${name} lacks complete source POSITION/NORMAL attributes`);
  for (const attribute of [sourcePosition, sourceNormal]) for (let vertex = 0; vertex < attribute.count; vertex++) for (let component = 0; component < 3; component++) {
    if (!Number.isFinite(attribute.getComponent(vertex, component))) invalid(`${name} has nonfinite source POSITION/NORMAL data`);
  }
  const indices = targets.map((target) => {
    const index = dictionary[target];
    if (!Number.isInteger(index) || index! < 0 || index! >= targets.length) return invalid(`${name} has invalid morph target index for ${target}`);
    for (const attribute of [positions[index!], normals[index!]]) {
      if (!attribute || attribute.itemSize !== 3 || attribute.count !== sourcePosition.count) invalid(`${name}/${target} has incomplete POSITION/NORMAL data`);
      for (let vertex = 0; vertex < attribute.count; vertex++) for (let component = 0; component < 3; component++) {
        if (!Number.isFinite(attribute.getComponent(vertex, component))) invalid(`${name}/${target} has nonfinite POSITION/NORMAL data`);
      }
    }
    return index!;
  });
  if (new Set(indices).size !== targets.length) invalid(`${name} aliases different morph names to one index`);
  return { mesh: node, indices };
}

/**
 * Drives only authored POSITION/NORMAL morphs, after the final joint pose is applied.
 * Each query uses control * legacy-bone LOCAL quaternions, so scene rotation and left-hand
 * reflection cannot alter its weights. Gaussian cardinal interpolation preserves the
 * supplied nonzero centres and null zero anchors and fades away from them. Signed weights
 * are deliberate: there is no clamping, centre snapping or geometry-tolerance relaxation.
 */
export function createHandSkinCorrectives(model: Object3D): HandSkinCorrectives | undefined {
  const owner = model.getObjectByName("acu_practitioner_hand"), metadata: unknown = owner?.userData.thumbWebCorrectives;
  if (metadata === undefined) return undefined;
  if (!record(metadata) || metadata.schemaVersion !== 1 || metadata.method !== "quaternion-gaussian-rbf"
    || typeof metadata.sigma !== "number" || !Number.isFinite(metadata.sigma) || metadata.sigma <= 0
    || !Array.isArray(metadata.joints) || metadata.joints.length === 0
    || !Array.isArray(metadata.centres) || metadata.centres.length === 0) return invalid("unsupported schema, sigma, joints or centres");
  uniqueNode(model, "acu_practitioner_hand");
  const sigma = metadata.sigma, boneNames = new Set<string>(), controlNames = new Set<string>();
  const joints: Joint[] = metadata.joints.map((entry: unknown) => {
    if (!record(entry) || !named(entry.bone) || !named(entry.control) || entry.bone === entry.control
      || boneNames.has(entry.bone) || controlNames.has(entry.control)) return invalid("invalid or duplicate joint pair");
    boneNames.add(entry.bone); controlNames.add(entry.control);
    const bone = uniqueNode(model, entry.bone), control = uniqueNode(model, entry.control);
    if (!(bone instanceof Bone)) return invalid(`${entry.bone} is not an actual Bone`);
    if (bone.parent !== control) return invalid(`${entry.bone} is not a direct child of ${entry.control}`);
    if (!unitScale(bone) || !unitScale(control)) return invalid(`${entry.bone}/${entry.control} must retain unit local scales`);
    return { bone, control };
  });
  const targets: string[] = [];
  const centres: Centre[] = metadata.centres.map((entry: unknown) => {
    if (!record(entry) || !(entry.name === null || named(entry.name))
      || !Array.isArray(entry.rotations) || entry.rotations.length !== joints.length) return invalid("invalid centre name or joint rotation count");
    if (entry.name !== null) {
      if (targets.includes(entry.name)) return invalid(`duplicate morph centre name ${entry.name}`);
      targets.push(entry.name);
    }
    const feature = new Float64Array(joints.length * 9);
    entry.rotations.forEach((rotation: unknown, index: number) => {
      if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) return invalid("invalid centre quaternion");
      rotationFeature(new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]), feature, index * 9);
    });
    return { name: entry.name, feature };
  });
  if (targets.length === 0) return invalid("no named corrective targets");
  const solve = factorKernel(centres, sigma);
  const partitions = [partition(model, "palm_surface", targets), partition(model, "thumb_skin", targets)];
  for (const { bone } of joints) for (const { mesh } of partitions) {
    if (!mesh.skeleton?.bones.includes(bone)) invalid(`${bone.name} is not owned by the actual ${mesh.name} skeleton`);
  }
  const feature = new Float64Array(joints.length * 9), kernel = new Float64Array(centres.length), q = new Quaternion();
  let last = new Float64Array(targets.length);
  const reset = () => {
    last.fill(0);
    for (const part of partitions) for (const index of part.indices) part.mesh.morphTargetInfluences![index] = 0;
  };
  reset();
  return {
    reset,
    apply() {
      joints.forEach((joint, index) => {
        if (!unitScale(joint.bone) || !unitScale(joint.control)) invalid(`${joint.bone.name}/${joint.control.name} must retain unit local scales`);
        rotationFeature(q.copy(joint.control.quaternion).multiply(joint.bone.quaternion), feature, index * 9);
      });
      centres.forEach((centre, index) => { kernel[index] = gaussian(feature, centre.feature, sigma); });
      const cardinal = solve(kernel);
      last = Float64Array.from(centres.flatMap((centre, index) => centre.name === null ? [] : [cardinal[index]!]));
      for (const part of partitions) part.indices.forEach((index, target) => { part.mesh.morphTargetInfluences![index] = last[target]!; });
    },
    weights: () => Object.fromEntries(targets.map((name, index) => [name, last[index]!])),
  };
}
