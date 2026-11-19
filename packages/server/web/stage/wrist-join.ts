import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SkinnedMesh, Vector3 } from "three";
import type { PersonRig } from "@clinicalcraft/web/world/npc.js";

export interface HandWristSurface {
  palm: SkinnedMesh;
  ring: readonly number[];
  distalRing: readonly number[];
  material: MeshStandardMaterial;
}

/** The asset exposes body vertices, not the duplicate vertices of its hidden physics cap. */
export function handWristSurface(model: Group): HandWristSurface | undefined {
  const palm = model.getObjectByName("palm_surface");
  if (!(palm instanceof SkinnedMesh)) return undefined;
  const { ring, distalRing } = palm.userData.wristInterface ?? {};
  const count = palm.geometry.getAttribute("position")?.count ?? 0;
  const valid = (indices: unknown): indices is number[] => Array.isArray(indices) && indices.length === SIDES
    && new Set(indices).size === SIDES && indices.every((i) => Number.isInteger(i) && i >= 0 && i < count);
  const material = Array.isArray(palm.material) ? palm.material[0] : palm.material;
  if (!valid(ring) || !valid(distalRing) || !(material instanceof MeshStandardMaterial)
    || !palm.geometry.getAttribute("normal") || !palm.geometry.getAttribute("uv")) return undefined;
  return { palm, ring, distalRing, material };
}

export interface FigureWristPart {
  /** The entire explicitly tagged stock hand, including its proximal faces. */
  handVertices: ReadonlySet<number>;
  /** Hand-only original index offsets, usable when an older detail asset has no join interface. */
  handTriangles: ReadonlySet<number>;
  /** Original index-buffer offsets of whole hand, bare forearm and flat sleeve-cap triangles. */
  excludedTriangles: ReadonlySet<number>;
  /** Exact source vertices in cyclic order; the first bare-forearm station is under the coat. */
  forearmRing: readonly number[];
  forearmDistalRing: readonly number[];
  sleeveRing: readonly number[];
  sleeveCapVertices: ReadonlySet<number>;
  sleeveInsideColour: readonly [number, number, number];
  sleeveInsideFinish: readonly [number, number];
}

const SIDES = 48;
const COLUMNS = SIDES + 1; // duplicate only the cylindrical UV seam
const ROWS = 7;
const HEM_ROWS = 4;
const HEM_INSET = [0, 0.00045, 0.0015, 0.0015] as const;
const HEM_AXIAL = [0, 0.0006, 0.0004, -0.008] as const;
const HEM_INSIDE = [0, 0, 0.35, 1] as const;
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Ease only at the boundaries, so a large roll is spread evenly through the short loft. */
const frameBlend = (t: number): number => {
  const end = 0.075;
  if (t < end) return t * t / (2 * end * (1 - end));
  if (t > 1 - end) return 1 - (1 - t) * (1 - t) / (2 * end * (1 - end));
  return (t - end / 2) / (1 - end);
};
const positionAt = (attribute: BufferAttribute, i: number): Vector3 => new Vector3().fromBufferAttribute(attribute, i);

/** Capture before AvatarRig changes any vertices. Ownership comes from Sculpt's separate skin tags. */
export function captureFigureWrist(rig: PersonRig, mesh: Mesh, side: "left" | "right"): FigureWristPart | undefined {
  const skin = rig.skin.find((entry) => entry.mesh === mesh);
  const p = mesh.geometry.getAttribute("position") as BufferAttribute | undefined;
  const n = mesh.geometry.getAttribute("normal") as BufferAttribute | undefined;
  const colour = mesh.geometry.getAttribute("color") as BufferAttribute | undefined;
  const finish = mesh.geometry.getAttribute("finish") as BufferAttribute | undefined;
  const index = mesh.geometry.index;
  if (!skin || !p || !n || !colour || !finish || !index) return undefined;
  const armIndex = side === "left" ? 0 : 1, mirror = armIndex === 0 ? 1 : -1;
  const arm = rig.skeleton.arms[armIndex];
  const other = rig.skeleton.arms[1 - armIndex]!;
  const end = new Vector3(arm.end[0] * mirror, arm.end[1], arm.end[2]);
  const otherEnd = new Vector3(-other.end[0] * mirror, other.end[1], other.end[2]);
  const along = new Vector3(arm.along[0] * mirror, arm.along[1], arm.along[2]).normalize();
  let handRange = -1;
  for (let r = 1; r < skin.ranges.length; r++) {
    const [start, count] = skin.ranges[r]!;
    if (count < 500) continue;
    let distal = -Infinity, ownDistance = 0, otherDistance = 0;
    for (let i = start; i < start + count; i++) {
      const v = positionAt(p, i);
      distal = Math.max(distal, v.clone().sub(end).dot(along));
      ownDistance += v.distanceToSquared(end); otherDistance += v.distanceToSquared(otherEnd);
    }
    // The distal hand is its own Sculpt.tagged block, not a nearest-bone subset.
    if (distal > 0.05 && ownDistance < otherDistance && skin.ranges[r - 1]![1] === 48) { handRange = r; break; }
  }
  if (handRange < 0) return undefined;
  const [handStart, handCount] = skin.ranges[handRange]!;
  const [forearmStart, forearmCount] = skin.ranges[handRange - 1]!;
  const handVertices = new Set(Array.from({ length: handCount }, (_, i) => handStart + i));
  const forearmVertices = new Set(Array.from({ length: forearmCount }, (_, i) => forearmStart + i));
  const forearmRing = Array.from({ length: 16 }, (_, i) => forearmStart + i);
  const forearmDistalRing = forearmRing.map((i) => i + 16);
  const capCentre = new Vector3();
  for (const i of forearmDistalRing) capCentre.add(positionAt(p, i));
  capCentre.divideScalar(16);
  const capTriangles = new Set<number>(), capVertices = new Set<number>();
  let centre = -1;
  // The source long sleeve ends at this exact middle station. Its separate flat fan has one centre.
  for (let i = 0; i < p.count; i++) {
    if (!forearmVertices.has(i) && !handVertices.has(i) && positionAt(p, i).distanceToSquared(capCentre) < 1e-12
      && positionAt(n, i).dot(along) > 0.9) { centre = i; break; }
  }
  if (centre < 0) return undefined;
  const capNormal = positionAt(n, centre).normalize();
  const perimeterEdges: [number, number][] = [];
  for (let offset = 0; offset < index.count; offset += 3) {
    const tri = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    const k = tri.indexOf(centre);
    if (k < 0) continue;
    if (!tri.every((i) => positionAt(n, i).dot(capNormal) > 0.9999
      && Math.abs(positionAt(p, i).sub(capCentre).dot(capNormal)) < 1e-6)) return undefined;
    capTriangles.add(offset); tri.forEach((i) => capVertices.add(i));
    perimeterEdges.push([tri[(k + 2) % 3]!, tri[(k + 1) % 3]!]);
  }
  if (perimeterEdges.length !== 10 || capVertices.size !== 11) return undefined;
  const capRing = [perimeterEdges[0]![0]];
  while (capRing.length < 10) {
    const edge = perimeterEdges.find(([a]) => a === capRing[capRing.length - 1]);
    if (!edge || capRing.includes(edge[1])) return undefined;
    capRing.push(edge[1]);
  }
  const sleeveRing: number[] = [];
  for (const capIndex of capRing) {
    const v = positionAt(p, capIndex);
    let match = -1;
    for (let i = 0; i < p.count; i++) {
      if (!capVertices.has(i) && !forearmVertices.has(i) && !handVertices.has(i)
        && positionAt(p, i).distanceToSquared(v) < 1e-14 && Math.abs(positionAt(n, i).dot(capNormal)) < 0.7) { match = i; break; }
    }
    if (match < 0) return undefined;
    sleeveRing.push(match);
  }
  const excludedTriangles = new Set(capTriangles);
  const handTriangles = new Set<number>();
  for (let offset = 0; offset < index.count; offset += 3) {
    if ([0, 1, 2].some((j) => handVertices.has(index.getX(offset + j)))) handTriangles.add(offset);
    if (handTriangles.has(offset) || [0, 1, 2].some((j) => forearmVertices.has(index.getX(offset + j)))) excludedTriangles.add(offset);
  }
  return { handVertices, handTriangles, excludedTriangles, forearmRing, forearmDistalRing, sleeveRing, sleeveCapVertices: capVertices,
    sleeveInsideColour: [colour.getX(centre), colour.getY(centre), colour.getZ(centre)],
    sleeveInsideFinish: [finish.getX(centre), finish.getY(centre)] };
}

function loftGeometry(sides: number, rows: number, uvSeam = false): BufferGeometry {
  const columns = sides + (uvSeam ? 1 : 0), geometry = new BufferGeometry(), count = columns * rows;
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage));
  const indices: number[] = [];
  for (let row = 0; row < rows - 1; row++) for (let j = 0; j < sides; j++) {
    const a = row * columns + j, b = a + columns, d = row * columns + (uvSeam ? j + 1 : (j + 1) % sides), c = d + columns;
    indices.push(a, b, d, b, c, d);
  }
  geometry.setIndex(indices);
  return geometry;
}

/** Blend the actual figure finish into the detail hand's texture and normal-map finish. */
function bridgeMaterial(source: MeshStandardMaterial): MeshStandardMaterial {
  const material = source.clone();
  material.name = "wrist-skin-transition";
  material.vertexColors = false;
  const compile = source.onBeforeCompile, key = source.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 wristColour;\nattribute vec2 wristFinish;\nattribute float wristBlend;\nvarying vec3 vWristColour;\nvarying vec2 vWristFinish;\nvarying float vWristBlend;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWristColour = wristColour;\nvWristFinish = wristFinish;\nvWristBlend = wristBlend;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWristColour;\nvarying vec2 vWristFinish;\nvarying float vWristBlend;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(vWristColour, diffuseColor.rgb, vWristBlend);")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(clamp(0.82 - 0.66 * vWristFinish.x, 0.05, 1.0), roughnessFactor, vWristBlend);")
      .replace("#include <normal_fragment_maps>", "vec3 wristBaseNormal = normal;\n#include <normal_fragment_maps>\nnormal = normalize(mix(wristBaseNormal, normal, vWristBlend));")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance = totalEmissiveRadiance * vWristBlend + vWristColour * vec3(1.0, 0.66, 0.5) * vWristFinish.y * (1.0 - vWristBlend);")
      .replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\nmaterial.specularColor = mix(vec3(0.04), material.specularColor, vWristBlend);\nmaterial.specularF90 = mix(1.0, material.specularF90, vWristBlend);");
  };
  material.customProgramCacheKey = () => `wrist-join-v2:${key}`;
  return material;
}

/** A short visual skin loft and a hollow rolled cloth hem. No skeleton, physics or source-vertex edits. */
export class WristJoin {
  readonly group = new Group();
  private readonly skinGeometry = loftGeometry(SIDES, ROWS, true);
  private readonly hemGeometry: BufferGeometry;
  private readonly skinMesh: Mesh;
  private readonly hemMesh: Mesh;
  private target: HandWristSurface | null = null;
  private ownedMaterial: MeshStandardMaterial | null = null;
  private mapping: number[] | null = null;
  private readonly sourcePoints = Array.from({ length: SIDES }, () => new Vector3());
  private readonly sourceNext = Array.from({ length: SIDES }, () => new Vector3());
  private readonly sourceNormals = Array.from({ length: SIDES }, () => new Vector3());
  private readonly targetPoints = Array.from({ length: SIDES }, () => new Vector3());
  private readonly targetNext = Array.from({ length: SIDES }, () => new Vector3());
  private readonly targetNormals = Array.from({ length: SIDES }, () => new Vector3());
  private readonly sourceToGroup = new Matrix4();
  private readonly targetToGroup = new Matrix4();
  private readonly sourceNormalMatrix = new Matrix3();
  private readonly targetNormalMatrix = new Matrix3();
  private readonly inverseGroup = new Matrix4();
  private readonly sourceCentre = new Vector3();
  private readonly targetCentre = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();
  private readonly boneNormal = new Vector3();
  private readonly boneMatrix = new Matrix4();
  private readonly sourceFrame = new Quaternion();
  private readonly targetFrame = new Quaternion();
  private readonly sourceFrameInverse = new Quaternion();
  private readonly targetFrameInverse = new Quaternion();
  private readonly frameMatrix = new Matrix4();
  private readonly sourceStep = new Vector3();
  private readonly targetStep = new Vector3();
  private readonly localStart = new Vector3();
  private readonly localEnd = new Vector3();
  private readonly rowCentres = Array.from({ length: ROWS }, () => new Vector3());
  private readonly rowFrames = Array.from({ length: ROWS }, () => new Quaternion());
  private readonly unwrappedU = new Float64Array(COLUMNS);
  private skinOriented = false;
  private hemOriented = false;

  constructor(private readonly mesh: Mesh, private readonly part: FigureWristPart, parent: Group) {
    this.group.name = "wrist-join";
    this.group.visible = false;
    this.group.userData.figureWristJoin = true;
    this.skinMesh = new Mesh(this.skinGeometry, mesh.material);
    this.skinMesh.name = "wrist-skin-bridge";
    this.skinGeometry.setAttribute("uv", new BufferAttribute(new Float32Array(COLUMNS * ROWS * 2), 2));
    this.skinGeometry.setAttribute("wristColour", new BufferAttribute(new Float32Array(COLUMNS * ROWS * 3), 3).setUsage(DynamicDrawUsage));
    this.skinGeometry.setAttribute("wristFinish", new BufferAttribute(new Float32Array(COLUMNS * ROWS * 2), 2).setUsage(DynamicDrawUsage));
    this.skinGeometry.setAttribute("wristBlend", new BufferAttribute(Float32Array.from({ length: COLUMNS * ROWS }, (_, i) => smooth(Math.floor(i / COLUMNS) / (ROWS - 1))), 1));
    this.hemGeometry = loftGeometry(part.sleeveRing.length, HEM_ROWS);
    this.hemGeometry.setAttribute("color", new BufferAttribute(new Float32Array(part.sleeveRing.length * HEM_ROWS * 3), 3).setUsage(DynamicDrawUsage));
    this.hemGeometry.setAttribute("finish", new BufferAttribute(new Float32Array(part.sleeveRing.length * HEM_ROWS * 2), 2).setUsage(DynamicDrawUsage));
    this.hemMesh = new Mesh(this.hemGeometry, mesh.material);
    this.hemMesh.name = "sleeve-annular-hem";
    for (const child of [this.skinMesh, this.hemMesh]) {
      child.castShadow = child.receiveShadow = true; child.frustumCulled = false; child.raycast = () => {};
      this.group.add(child);
    }
    parent.add(this.group);
  }

  setTarget(surface: HandWristSurface | null): void {
    if (this.target?.palm === surface?.palm && (this.target !== null) === (surface !== null)) return;
    this.target = surface;
    this.group.visible = !!surface;
    this.mapping = null;
    this.ownedMaterial?.dispose(); this.ownedMaterial = null;
    if (surface) {
      this.ownedMaterial = bridgeMaterial(surface.material);
      this.skinMesh.material = this.ownedMaterial;
    }
  }

  /** Match the shader's LBS normal, then use an inverse-transpose for reflected/scaled world frames. */
  private skinNormal(palm: SkinnedMesh, vertex: number, out: Vector3): Vector3 {
    const geometry = palm.geometry, joints = geometry.getAttribute("skinIndex"), weights = geometry.getAttribute("skinWeight");
    this.boneNormal.fromBufferAttribute(geometry.getAttribute("normal"), vertex);
    this.linear(this.boneNormal, palm.bindMatrix);
    out.set(0, 0, 0);
    for (let k = 0; k < weights.itemSize; k++) {
      const weight = weights.getComponent(vertex, k);
      if (weight === 0) continue;
      this.boneMatrix.fromArray(palm.skeleton.boneMatrices, joints.getComponent(vertex, k) * 16);
      this.d.copy(this.boneNormal); this.linear(this.d, this.boneMatrix); out.addScaledVector(this.d, weight);
    }
    this.linear(out, palm.bindMatrixInverse);
    return out.applyMatrix3(this.targetNormalMatrix).normalize();
  }

  private linear(v: Vector3, m: Matrix4): void {
    const e = m.elements, x = v.x, y = v.y, z = v.z;
    v.set(e[0]! * x + e[4]! * y + e[8]! * z, e[1]! * x + e[5]! * y + e[9]! * z, e[2]! * x + e[6]! * y + e[10]! * z);
  }

  private sample(attribute: BufferAttribute, ring: readonly number[], j: number, out: Vector3): Vector3 {
    const t = j * ring.length / SIDES, i = Math.floor(t), f = t - i;
    out.fromBufferAttribute(attribute, ring[i % ring.length]!);
    this.a.fromBufferAttribute(attribute, ring[(i + 1) % ring.length]!);
    return out.lerp(this.a, f);
  }

  /** Choose once per attachment; material coordinates never jump to a new closest point during motion. */
  private matchRings(): number[] {
    let best = Infinity, shift = 0, direction = 1;
    for (const sign of [1, -1]) for (let offset = 0; offset < SIDES; offset++) {
      let score = 0;
      for (let j = 0; j < SIDES; j++) {
        this.a.copy(this.sourcePoints[j]!).sub(this.sourceCentre).normalize();
        this.b.copy(this.targetPoints[(offset + sign * j + SIDES) % SIDES]!).sub(this.targetCentre).normalize();
        score += this.a.distanceToSquared(this.b);
      }
      if (score < best) { best = score; shift = offset; direction = sign; }
    }
    return Array.from({ length: SIDES }, (_, j) => (shift + direction * j + SIDES) % SIDES);
  }

  update(): void {
    const target = this.target;
    if (!target || !this.group.visible) return;
    this.group.updateWorldMatrix(true, false); this.mesh.updateWorldMatrix(true, false);
    target.palm.updateWorldMatrix(true, false);
    // updateWorldMatrix alone does not run SkinnedMesh's attached-bind inverse update.
    target.palm.updateMatrixWorld(true);
    for (const bone of target.palm.skeleton.bones) bone.updateWorldMatrix(true, false);
    target.palm.skeleton.update();
    this.inverseGroup.copy(this.group.matrixWorld).invert();
    this.sourceToGroup.multiplyMatrices(this.inverseGroup, this.mesh.matrixWorld);
    this.targetToGroup.multiplyMatrices(this.inverseGroup, target.palm.matrixWorld);
    this.sourceNormalMatrix.getNormalMatrix(this.sourceToGroup); this.targetNormalMatrix.getNormalMatrix(this.targetToGroup);
    const position = this.mesh.geometry.getAttribute("position") as BufferAttribute;
    const normal = this.mesh.geometry.getAttribute("normal") as BufferAttribute;
    this.sourceCentre.set(0, 0, 0); this.targetCentre.set(0, 0, 0);
    for (let j = 0; j < SIDES; j++) {
      this.sample(position, this.part.forearmRing, j, this.sourcePoints[j]!).applyMatrix4(this.sourceToGroup);
      this.sample(position, this.part.forearmDistalRing, j, this.sourceNext[j]!).applyMatrix4(this.sourceToGroup);
      this.sample(normal, this.part.forearmRing, j, this.sourceNormals[j]!).applyMatrix3(this.sourceNormalMatrix).normalize();
      target.palm.getVertexPosition(target.ring[j]!, this.targetPoints[j]!).applyMatrix4(this.targetToGroup);
      target.palm.getVertexPosition(target.distalRing[j]!, this.targetNext[j]!).applyMatrix4(this.targetToGroup);
      this.skinNormal(target.palm, target.ring[j]!, this.targetNormals[j]!);
      this.sourceCentre.add(this.sourcePoints[j]!); this.targetCentre.add(this.targetPoints[j]!);
    }
    this.sourceCentre.divideScalar(SIDES); this.targetCentre.divideScalar(SIDES);
    this.mapping ??= this.matchRings();
    this.updateSkin(); this.updateHem();
  }

  private updateSkin(): void {
    const target = this.target!, map = this.mapping!, geometry = this.skinGeometry;
    const positions = geometry.getAttribute("position") as BufferAttribute, colours = geometry.getAttribute("wristColour") as BufferAttribute;
    const finishes = geometry.getAttribute("wristFinish") as BufferAttribute, uv = geometry.getAttribute("uv") as BufferAttribute;
    const sourceColour = this.mesh.geometry.getAttribute("color") as BufferAttribute, sourceFinish = this.mesh.geometry.getAttribute("finish") as BufferAttribute;
    const targetUV = target.palm.geometry.getAttribute("uv");
    for (let column = 0; column < COLUMNS; column++) {
      const u = targetUV.getX(target.ring[map[column % SIDES]!]!);
      this.unwrappedU[column] = column === 0 ? u : u + Math.round(this.unwrappedU[column - 1]! - u);
    }
    const length = Math.max(0.001, this.sourceCentre.distanceTo(this.targetCentre));
    this.sourceStep.set(0, 0, 0); this.targetStep.set(0, 0, 0);
    for (let j = 0; j < SIDES; j++) {
      this.sourceStep.add(this.sourceNext[j]!).sub(this.sourcePoints[j]!);
      this.targetStep.add(this.targetNext[j]!).sub(this.targetPoints[j]!);
    }
    this.sourceStep.divideScalar(SIDES); this.targetStep.divideScalar(SIDES);
    const sourceStepLength = Math.max(1e-6, this.sourceStep.length()), targetStepLength = Math.max(1e-6, this.targetStep.length());
    this.frame(this.sourceStep, this.sourcePoints[0]!, this.sourceCentre, this.sourceFrame);
    this.frame(this.targetStep, this.targetPoints[map[0]!]!, this.targetCentre, this.targetFrame);
    this.sourceFrameInverse.copy(this.sourceFrame).invert(); this.targetFrameInverse.copy(this.targetFrame).invert();
    // A common magnitude preserves both real tangent planes without overshooting the short span.
    const tangentLength = length * 0.7;
    this.sourceStep.multiplyScalar(tangentLength / sourceStepLength); this.targetStep.multiplyScalar(tangentLength / targetStepLength);
    for (let row = 0; row < ROWS; row++) {
      const t = row / (ROWS - 1), t2 = t * t, t3 = t2 * t;
      this.rowCentres[row]!.copy(this.sourceCentre).multiplyScalar(2 * t3 - 3 * t2 + 1)
        .addScaledVector(this.sourceStep, t3 - 2 * t2 + t).addScaledVector(this.targetCentre, -2 * t3 + 3 * t2)
        .addScaledVector(this.targetStep, t3 - t2);
      // Zero angular derivative at both ends lets the real surface tangents own the seams.
      this.rowFrames[row]!.copy(this.sourceFrame).slerp(this.targetFrame, frameBlend(t));
    }
    for (let column = 0; column < COLUMNS; column++) {
      const j = column % SIDES, k = map[j]!, start = this.sourcePoints[j]!, end = this.targetPoints[k]!;
      this.sample(sourceColour, this.part.forearmRing, j, this.d);
      const cr = this.d.x, cg = this.d.y, cb = this.d.z;
      const ringT = j * this.part.forearmRing.length / SIDES, ringI = Math.floor(ringT), f = ringT - ringI;
      const x = this.part.forearmRing[ringI % this.part.forearmRing.length]!, y = this.part.forearmRing[(ringI + 1) % this.part.forearmRing.length]!;
      const gloss = sourceFinish.getX(x) * (1 - f) + sourceFinish.getX(y) * f, glow = sourceFinish.getY(x) * (1 - f) + sourceFinish.getY(y) * f;
      const ringVertex = target.ring[k]!, nextVertex = target.distalRing[k]!;
      const rawU = targetUV.getX(ringVertex), u = this.unwrappedU[column]!, v = targetUV.getY(ringVertex);
      const uvScale = tangentLength / targetStepLength, rawDU = targetUV.getX(nextVertex) - rawU;
      const du = (rawDU - Math.round(rawDU)) * uvScale, dv = (targetUV.getY(nextVertex) - v) * uvScale;
      this.localStart.copy(start).sub(this.sourceCentre).applyQuaternion(this.sourceFrameInverse);
      this.localEnd.copy(end).sub(this.targetCentre).applyQuaternion(this.targetFrameInverse);
      this.b.copy(this.sourceNext[j]!).sub(start).multiplyScalar(tangentLength / sourceStepLength).sub(this.sourceStep).applyQuaternion(this.sourceFrameInverse);
      this.c.copy(this.targetNext[k]!).sub(end).multiplyScalar(tangentLength / targetStepLength).sub(this.targetStep).applyQuaternion(this.targetFrameInverse);
      for (let row = 0; row < ROWS; row++) {
        const t = row / (ROWS - 1), t2 = t * t, t3 = t2 * t, vertex = row * COLUMNS + column;
        this.a.copy(this.localStart).multiplyScalar(2 * t3 - 3 * t2 + 1).addScaledVector(this.b, t3 - 2 * t2 + t)
          .addScaledVector(this.localEnd, -2 * t3 + 3 * t2).addScaledVector(this.c, t3 - t2)
          .applyQuaternion(this.rowFrames[row]!).add(this.rowCentres[row]!);
        positions.setXYZ(vertex, this.a.x, this.a.y, this.a.z); colours.setXYZ(vertex, cr, cg, cb); finishes.setXY(vertex, gloss, glow);
        uv.setXY(vertex, u + (t - 1) * du, v + (t - 1) * dv);
      }
    }
    if (!this.skinOriented) { this.orient(geometry, this.sourceCentre); this.skinOriented = true; }
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute("normal") as BufferAttribute;
    for (let row = 1; row < ROWS - 1; row++) {
      const a = row * COLUMNS, b = a + SIDES;
      this.a.fromBufferAttribute(normals, a); this.b.fromBufferAttribute(normals, b); this.a.add(this.b).normalize();
      normals.setXYZ(a, this.a.x, this.a.y, this.a.z); normals.setXYZ(b, this.a.x, this.a.y, this.a.z);
    }
    for (let column = 0; column < COLUMNS; column++) {
      const j = column % SIDES, a = this.sourceNormals[j]!, b = this.targetNormals[map[j]!]!;
      normals.setXYZ(column, a.x, a.y, a.z); normals.setXYZ((ROWS - 1) * COLUMNS + column, b.x, b.y, b.z);
    }
    for (const attribute of [positions, normals, colours, finishes, uv]) attribute.needsUpdate = true;
  }

  /** Construct a proper local rotation after all reflected world transforms have been applied. */
  private frame(step: Vector3, rim: Vector3, centre: Vector3, out: Quaternion): void {
    this.a.copy(step).normalize();
    this.b.copy(rim).sub(centre);
    this.b.addScaledVector(this.a, -this.b.dot(this.a)).normalize();
    this.c.crossVectors(this.a, this.b).normalize();
    this.frameMatrix.makeBasis(this.b, this.c, this.a);
    out.setFromRotationMatrix(this.frameMatrix);
  }

  private updateHem(): void {
    const geometry = this.hemGeometry, sides = this.part.sleeveRing.length;
    const positions = geometry.getAttribute("position") as BufferAttribute, colours = geometry.getAttribute("color") as BufferAttribute;
    const finishes = geometry.getAttribute("finish") as BufferAttribute, normals = geometry.getAttribute("normal") as BufferAttribute;
    const sourcePosition = this.mesh.geometry.getAttribute("position"), sourceColour = this.mesh.geometry.getAttribute("color");
    const sourceFinish = this.mesh.geometry.getAttribute("finish"), sourceNormal = this.mesh.geometry.getAttribute("normal");
    const centre = this.a.set(0, 0, 0);
    for (const i of this.part.sleeveRing) { this.b.fromBufferAttribute(sourcePosition, i).applyMatrix4(this.sourceToGroup); centre.add(this.b); }
    centre.divideScalar(sides);
    this.c.set(0, 0, 0);
    for (let j = 0; j < SIDES; j++) this.c.add(this.sourceNext[j]!).sub(this.sourcePoints[j]!);
    this.c.normalize();
    // The outer row stays on the authored sleeve. The thickness is entirely inward.
    for (let j = 0; j < sides; j++) {
      const source = this.part.sleeveRing[j]!;
      this.b.fromBufferAttribute(sourcePosition, source).applyMatrix4(this.sourceToGroup);
      this.d.copy(this.b).sub(centre).normalize();
      for (let row = 0; row < HEM_ROWS; row++) {
        const inset = HEM_INSET[row]!, axial = HEM_AXIAL[row]!;
        const vertex = row * sides + j, inside = HEM_INSIDE[row]!;
        positions.setXYZ(vertex, this.b.x - this.d.x * inset + this.c.x * axial, this.b.y - this.d.y * inset + this.c.y * axial, this.b.z - this.d.z * inset + this.c.z * axial);
        colours.setXYZ(vertex, sourceColour.getX(source) * (1 - inside) + this.part.sleeveInsideColour[0] * inside,
          sourceColour.getY(source) * (1 - inside) + this.part.sleeveInsideColour[1] * inside,
          sourceColour.getZ(source) * (1 - inside) + this.part.sleeveInsideColour[2] * inside);
        finishes.setXY(vertex, sourceFinish.getX(source) * (1 - inside) + this.part.sleeveInsideFinish[0] * inside,
          sourceFinish.getY(source) * (1 - inside) + this.part.sleeveInsideFinish[1] * inside);
      }
    }
    if (!this.hemOriented) { this.orient(geometry, centre); this.hemOriented = true; }
    geometry.computeVertexNormals();
    for (let j = 0; j < sides; j++) {
      this.b.fromBufferAttribute(sourceNormal, this.part.sleeveRing[j]!).applyMatrix3(this.sourceNormalMatrix).normalize();
      normals.setXYZ(j, this.b.x, this.b.y, this.b.z);
    }
    for (const attribute of [positions, normals, colours, finishes]) attribute.needsUpdate = true;
  }

  private orient(geometry: BufferGeometry, centre: Vector3): void {
    const p = geometry.getAttribute("position"), index = geometry.index!;
    const a = positionAt(p as BufferAttribute, index.getX(0)), b = positionAt(p as BufferAttribute, index.getX(1)), c = positionAt(p as BufferAttribute, index.getX(2));
    const expected = a.clone().sub(centre), outward = b.sub(a).cross(c.sub(a));
    if (outward.dot(expected) < 0) {
      for (let i = 0; i < index.count; i += 3) { const value = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, value); }
      index.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent(); this.skinGeometry.dispose(); this.hemGeometry.dispose(); this.ownedMaterial?.dispose();
    this.target = null; this.ownedMaterial = null;
  }
}
