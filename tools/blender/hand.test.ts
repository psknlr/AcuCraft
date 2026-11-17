import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationMixer, BufferAttribute, BufferGeometry, DoubleSide, LoopOnce, Matrix3, Mesh, MeshBasicMaterial, Object3D, Quaternion, Raycaster, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand } from "../../packages/server/web/stage/hand.js";
import { needleHandleRadiusAt } from "../../packages/server/web/stage/needle-shape.js";
import { parseGlb } from "@clinicalcraft/core";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const candidate = process.env.ACUCRAFT_HAND_ASSET_FIXTURE;
const bytes = readFileSync(candidate ?? here("../../content/world/assets/models/acu-practitioner-hand.glb"));
type MaterialDefinition = { parent: string; surface: string; normalField: string; definition: Record<string, unknown>; engaged?: boolean; engagedWith?: string };
type MaterialPose = MaterialDefinition & { position: number[]; quaternion: number[] };
const manifest = JSON.parse(readFileSync(candidate ? candidate.replace(/\.glb$/, ".json") : here("./hand.json"), "utf8")) as {
  sha256: string;
  bytes: number;
  triangles: number;
  license: string;
  wrist: number[];
  tips: Record<string, number[]>;
  animations: string[];
  clipFrames: Record<string, number[]>;
  baselineElevationDeg: number;
  palm: { surface: string; topology: string };
  rollingPatches: Record<string, { samples: { node: string; offsetMm: number }[] }>;
  anatomicalJoints: Record<string, string[]>;
  anatomicalMapping: Record<string, string>;
  contactAnchors: Record<string, { follows: string; normalAxis: string; surface?: string; feature?: string }>;
  poseContacts: Record<string, Record<string, number[]>>;
  materialAnimation?: {
    baked: boolean;
    bindFrame: string;
    activeContacts: Record<string, string[]>;
    poseMaterials: Record<string, Record<string, MaterialPose>>;
    clipContacts: Record<string, string[]>;
    clipMaterialFrames: Record<string, Record<string, { time: number; position: number[]; rotation: number[] }[]>>;
    materialDefinitions: Record<string, Record<string, Omit<MaterialDefinition, "definition"> & {
      keys: { frame: number; definition: Record<string, unknown>; engaged?: boolean; engagedWith?: string }[];
    }>>;
    sourceBindings: Record<string, { position: number[]; rotation: number[]; surface: string; normalField: string }>;
    provenance?: {
      calibrationInputAsset: { path: string; sha256: string; role: string };
      sources: Record<string, { path: string; sha256: string }>;
      runtimeModules: Record<string, string>;
      animationsRead: boolean;
      runtimeContactsValidAtEveryExportedFrame: boolean;
    };
  };
};

const legacyBoneNames = ["thumb", "index", "middle", "ring", "little"].flatMap((digit) =>
  ["proximal", "middle", "distal"].map((joint) => `${digit}_${joint}`));
const flickCriticalTimes = [0.08, 0.28, 0.5, 0.58];
const expectedClipTimes = (clip: string): number[] => ["hand_support", "hand_three_finger"].includes(clip) ? [0, 1]
  : [...new Set([...Array.from({ length: 31 }, (_, i) => i / 30), ...(clip === "hand_flick" ? flickCriticalTimes : [])])].sort((a, b) => a - b);

function expectDeclaredClipTracks(clip: { name: string; tracks: { name: string; getValueSize(): number }[] }): string[] {
  const declared = manifest.materialAnimation?.clipContacts[clip.name] ?? [];
  expect(new Set(declared).size, `${clip.name} unique material declarations`).toBe(declared.length);
  for (const name of declared) {
    expect(name.endsWith("_contact"), `${clip.name}/${name} surface alias`).toBe(true);
    expect(manifest.contactAnchors[name]?.surface, `${clip.name}/${name} registered real surface`).toBeTruthy();
    for (const property of ["position", "quaternion"]) {
      expect(clip.tracks.some((track) => track.name === `${name}.${property}`), `${clip.name}/${name} baked material ${property}`).toBe(true);
    }
  }
  const rotations = new Set([...legacyBoneNames, "hand_pose_frame", ...declared]);
  const translations = new Set(["hand_pose_frame", ...declared]);
  expect(new Set(clip.tracks.map((track) => track.name)).size).toBe(clip.tracks.length);
  expect(clip.tracks.filter((track) => legacyBoneNames.some((name) => track.name === `${name}.quaternion`))).toHaveLength(15);
  expect(clip.tracks.length, `${clip.name} skeletal/frame/material track budget`).toBeLessThanOrEqual(15 + 2 + 2 * declared.length);
  for (const track of clip.tracks) {
    const split = track.name.lastIndexOf("."), name = track.name.slice(0, split), property = track.name.slice(split + 1);
    if (property === "quaternion") {
      expect(rotations.has(name), `${clip.name}/${track.name} declared rotation`).toBe(true);
      expect(track.getValueSize()).toBe(4);
    } else {
      expect(property, `${clip.name}/${track.name} no scale or other object animation`).toBe("position");
      expect(translations.has(name), `${clip.name}/${track.name} cannot translate a bone`).toBe(true);
      expect(track.getValueSize()).toBe(3);
    }
  }
  return declared;
}

function distalSkinIntrusion(rig: Object3D, fromDigit: string, intoDigit: string): number {
  const from = rig.getObjectByName(`${fromDigit}_skin`) as SkinnedMesh;
  const into = (rig.getObjectByName(intoDigit) ?? rig.getObjectByName(`${intoDigit}_skin`)) as Mesh;
  for (const surface of [from, into]) if (surface instanceof SkinnedMesh) surface.skeleton.update();
  const direction = new Vector3(0.431, 0.293, 0.853).normalize(), triangle = new Triangle(), nearest = new Vector3();
  const vertices = Array.from({ length: into.geometry.getAttribute("position").count }, (_, i) => into.localToWorld(into.getVertexPosition(i, new Vector3())));
  const indices = into.geometry.getIndex()!;
  // Snapshot the actual posed skin once. Raycasting the live SkinnedMesh would
  // reapply its bone matrices to every target triangle for every source vertex.
  // This CPU-only proxy retains the world vertices' double precision.
  const positions = new Float64Array(vertices.length * 3);
  vertices.forEach((point, i) => point.toArray(positions, i * 3));
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(indices.clone());
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const material = new MeshBasicMaterial({ side: DoubleSide }), proxy = new Mesh(geometry, material);
  proxy.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(), direction, 0.000001, 1), point = new Vector3();
  const distalBones = new Set(from.skeleton.bones.flatMap((bone, i) => /(_distal|_DIP)$/.test(bone.name) ? [i] : []));
  const skinIndices = from.geometry.getAttribute("skinIndex"), skinWeights = from.geometry.getAttribute("skinWeight");
  let intrusion = 0;
  try {
    for (let vertex = 0; vertex < from.geometry.getAttribute("position").count; vertex++) {
      let distalWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        if (distalBones.has(skinIndices.array[vertex * 4 + influence]!)) distalWeight += skinWeights.array[vertex * 4 + influence]!;
      }
      if (distalWeight < 0.8) continue;
      from.localToWorld(from.getVertexPosition(vertex, point));
      ray.ray.origin.copy(point);
      const distances: number[] = [];
      for (const hit of ray.intersectObject(proxy, false)) {
        if (!distances.some((distance) => Math.abs(distance - hit.distance) < 1e-7)) distances.push(hit.distance);
      }
      if (distances.length % 2 === 0) continue;
      let distance = Infinity;
      for (let index = 0; index < indices.count; index += 3) {
        triangle.set(vertices[indices.getX(index)]!, vertices[indices.getX(index + 1)]!, vertices[indices.getX(index + 2)]!);
        triangle.closestPointToPoint(point, nearest);
        distance = Math.min(distance, point.distanceTo(nearest));
      }
      intrusion = Math.max(intrusion, distance);
    }
    return intrusion;
  } finally {
    geometry.dispose(); material.dispose();
  }
}

function inside(mesh: Mesh, point: Vector3): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const sides = materials.map((material) => material.side);
  for (const material of materials) material.side = DoubleSide;
  const axis = new Vector3(0.431, 0.293, 0.853).normalize();
  const distances: number[] = [];
  for (const hit of new Raycaster(point, axis, 0.00000001, 1).intersectObject(mesh, false)) {
    if (!distances.some((distance) => Math.abs(distance - hit.distance) < 1e-7)) distances.push(hit.distance);
  }
  const result = distances.length % 2 === 1;
  materials.forEach((material, i) => { material.side = sides[i]!; });
  return result;
}

function surfaceDistance(mesh: Mesh, point: Vector3): number {
  if (mesh instanceof SkinnedMesh) { mesh.skeleton.update(); mesh.computeBoundingBox(); mesh.computeBoundingSphere(); }
  const vertices = Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, i) => mesh.localToWorld(mesh.getVertexPosition(i, new Vector3())));
  const indices = mesh.geometry.index!, triangle = new Triangle(), closest = new Vector3();
  let distance = Infinity;
  for (let i = 0; i < indices.count; i += 3) {
    triangle.set(vertices[indices.getX(i)]!, vertices[indices.getX(i + 1)]!, vertices[indices.getX(i + 2)]!);
    distance = Math.min(distance, triangle.closestPointToPoint(point, closest).distanceTo(point));
  }
  return distance;
}

/** Compare with the rendered normal field rather than trusting an attachment's own quaternion. */
function surfaceNormalAgreement(mesh: Mesh, point: Vector3, normal: Vector3, field: string, definition: Record<string, unknown>): number {
  if (mesh instanceof SkinnedMesh) mesh.skeleton.update();
  const positions = mesh.geometry.getAttribute("position"), sourceNormals = mesh.geometry.getAttribute("normal"), indices = mesh.geometry.index!;
  const worldNormal = new Matrix3().getNormalMatrix(mesh.matrixWorld), triangle = new Triangle(), closest = new Vector3(), barycentric = new Vector3();
  const vertices: Vector3[] = [], normals: Vector3[] = [];
  for (let i = 0; i < positions.count; i++) {
    const posed = mesh.getVertexPosition(i, new Vector3()), sourceNormal = new Vector3().fromBufferAttribute(sourceNormals, i);
    if (mesh instanceof SkinnedMesh) {
      const endpoint = new Vector3().fromBufferAttribute(positions, i).add(sourceNormal);
      mesh.applyBoneTransform(i, endpoint);
      sourceNormal.copy(endpoint.sub(posed));
    }
    vertices.push(posed.applyMatrix4(mesh.matrixWorld));
    normals.push(sourceNormal.applyMatrix3(worldNormal).normalize());
  }
  const samples: { distance: number; smooth: number; facet: number }[] = [];
  let distance = Infinity;
  for (let i = 0; i < indices.count; i += 3) {
    const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)] as const;
    triangle.set(vertices[ids[0]]!, vertices[ids[1]]!, vertices[ids[2]]!);
    triangle.closestPointToPoint(point, closest); const separation = closest.distanceTo(point);
    if (separation > 0.000005) continue;
    triangle.getBarycoord(closest, barycentric);
    const smooth = normals[ids[0]]!.clone().multiplyScalar(barycentric.x)
      .addScaledVector(normals[ids[1]]!, barycentric.y).addScaledVector(normals[ids[2]]!, barycentric.z).normalize();
    const facet = triangle.getNormal(new Vector3());
    if (mesh.matrixWorld.determinant() < 0) facet.negate();
    samples.push({ distance: separation, smooth: smooth.dot(normal), facet: facet.dot(normal) });
    distance = Math.min(distance, separation);
  }
  // A shared edge may have two equally near triangles. Smooth normals agree
  // across it; a genuine facet attachment may use either incident face.
  const nearest = samples.filter((sample) => sample.distance <= distance + 1e-9);
  if (field === "skin-bary" || field === "barycentric-exported-smooth-vertex-normals") return Math.max(-1, ...nearest.map((sample) => sample.smooth));
  if (field === "actual-triangle-facet" || field === "triangle-facet") return Math.max(-1, ...nearest.map((sample) => sample.facet));
  if (field === "keratin-edge-cone") {
    const vertex = definition.vertexIndex as number, declaredFaces = definition.incidentFaceIndices as number[];
    expect(Number.isInteger(vertex) && vertex >= 0 && vertex < positions.count, `${mesh.name} actual keratin vertex`).toBe(true);
    expect(Array.isArray(declaredFaces), `${mesh.name} explicit incident-face provenance`).toBe(true);
    expect(definition.normalCone, `${mesh.name} explicit cone provenance`).toBeDefined();
    expect(vertices[vertex]!.distanceTo(point), `${mesh.name}/${vertex} actual sharp-vertex attachment`).toBeLessThan(0.000005);
    const actualFaces: number[] = [], facets: Vector3[] = [];
    for (let i = 0; i < indices.count; i += 3) {
      const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
      if (!ids.includes(vertex)) continue;
      triangle.set(vertices[ids[0]!]!, vertices[ids[1]!]!, vertices[ids[2]!]!);
      expect(triangle.getArea(), `${mesh.name}/${i / 3} non-degenerate cone facet`).toBeGreaterThan(1e-14);
      const facet = triangle.getNormal(new Vector3());
      if (mesh.matrixWorld.determinant() < 0) facet.negate();
      actualFaces.push(i / 3); facets.push(facet);
    }
    expect([...declaredFaces].sort((a, b) => a - b), `${mesh.name}/${vertex} actual incident facets`).toEqual(actualFaces);
    expect(facets.length).toBeGreaterThanOrEqual(3);
    // In three dimensions any member of a finitely generated positive cone
    // has a representation using at most three generators. Solve those real
    // facet combinations independently of the provider's authored weights.
    let residual = Infinity;
    const consider = (generators: Vector3[], weights: number[]) => {
      if (weights.some((weight) => !Number.isFinite(weight) || weight < -1e-8)) return;
      const reconstructed = new Vector3();
      generators.forEach((generator, i) => reconstructed.addScaledVector(generator, Math.max(0, weights[i]!)));
      residual = Math.min(residual, reconstructed.distanceTo(normal));
    };
    for (let a = 0; a < facets.length; a++) {
      const first = facets[a]!; consider([first], [first.dot(normal)]);
      for (let b = a + 1; b < facets.length; b++) {
        const second = facets[b]!, dot = first.dot(second), determinant = 1 - dot * dot;
        if (determinant > 1e-12) consider([first, second], [(first.dot(normal) - dot * second.dot(normal)) / determinant, (second.dot(normal) - dot * first.dot(normal)) / determinant]);
        for (let c = b + 1; c < facets.length; c++) {
          const third = facets[c]!, cross = second.clone().cross(third), det = first.dot(cross);
          if (Math.abs(det) < 1e-12) continue;
          consider([first, second, third], [normal.dot(cross) / det,
            first.dot(normal.clone().cross(third)) / det, first.dot(second.clone().cross(normal)) / det]);
        }
      }
    }
    expect(residual, `${mesh.name}/${vertex} normal lies in actual outward facet positive cone`).toBeLessThan(1e-5);
    return 1;
  }
  throw new Error(`Unsupported material normal provenance: ${field}`);
}

function closedPalmEdges(skin: SkinnedMesh): Map<string, number[]> {
  const positions = skin.geometry.getAttribute("position"), indices = skin.geometry.index!;
  const unique = new Map<string, number>(), welded: number[] = [], edges = new Map<string, number[]>();
  for (let i = 0; i < positions.count; i++) {
    const key = [positions.getX(i), positions.getY(i), positions.getZ(i)].map((value) => value.toFixed(7)).join(",");
    if (!unique.has(key)) unique.set(key, unique.size);
    welded.push(unique.get(key)!);
  }
  for (let i = 0; i < indices.count; i += 3) {
    const row = [welded[indices.getX(i)]!, welded[indices.getX(i + 1)]!, welded[indices.getX(i + 2)]!];
    expect(new Set(row).size).toBe(3);
    for (const [a, b] of [[row[0]!, row[1]!], [row[1]!, row[2]!], [row[2]!, row[0]!]]) {
      const key = `${Math.min(a, b)},${Math.max(a, b)}`, faces = edges.get(key) ?? [];
      faces.push(i / 3); edges.set(key, faces);
    }
  }
  for (const faces of edges.values()) expect(faces).toHaveLength(2);
  return edges;
}

/** A convex triangle crosses a finite needle frustum after an inward erosion. */
function triangleEntersNeedle(vertices: Vector3[], part: { lo: number; hi: number; r0: number; slope: number }, depth: number): boolean {
  const maximumRadius = Math.max(part.r0 + part.slope * part.lo, part.r0 + part.slope * part.hi);
  const minX = Math.min(...vertices.map((p) => p.x)), maxX = Math.max(...vertices.map((p) => p.x));
  const minZ = Math.min(...vertices.map((p) => p.z)), maxZ = Math.max(...vertices.map((p) => p.z));
  const x = minX > 0 ? minX : maxX < 0 ? -maxX : 0, z = minZ > 0 ? minZ : maxZ < 0 ? -maxZ : 0;
  if (Math.hypot(x, z) > maximumRadius) return false;
  const clip = (polygon: Vector3[], limit: number, above: boolean): Vector3[] => {
    const result: Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, da = a.y - limit, db = b.y - limit;
      const aInside = above ? da >= 0 : da <= 0, bInside = above ? db >= 0 : db <= 0;
      if (aInside) result.push(a);
      if (aInside !== bInside) result.push(a.clone().lerp(b, da / (da - db)));
    }
    return result;
  };
  const polygon = clip(clip(vertices, part.lo + depth, true), part.hi - depth, false);
  if (polygon.length < 3) return false;
  // The only isolated interior minimum of radial distance is on the axis.
  // A smooth interior minimum on a cone generator extends to an edge.
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!, bx = b.x - a.x, bz = b.z - a.z, cx = c.x - a.x, cz = c.z - a.z, determinant = bx * cz - bz * cx;
    if (Math.abs(determinant) < 1e-24) continue;
    const u = (-a.x * cz + a.z * cx) / determinant, v = (-bx * a.z + bz * a.x) / determinant;
    if (u >= 0 && v >= 0 && u + v <= 1) return true;
  }
  const erosion = depth * Math.sqrt(1 + part.slope * part.slope);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    const gap = (t: number) => Math.hypot(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) - part.r0 - part.slope * (a.y + (b.y - a.y) * t) + erosion;
    if (gap(0) < 0 || gap(1) < 0) return true;
    let low = 0, high = 1;
    for (let step = 0; step < 40; step++) {
      const left = (2 * low + high) / 3, right = (low + 2 * high) / 3;
      if (gap(left) <= gap(right)) high = right; else low = left;
    }
    if (gap((low + high) / 2) < 0) return true;
  }
  return false;
}

function expectPalmSurface(skin: SkinnedMesh, edges: Map<string, number[]>, context: string): void {
  skin.skeleton.update();
  const positions = skin.geometry.getAttribute("position"), indices = skin.geometry.index!, triangle = new Triangle();
  const vertices = Array.from({ length: positions.count }, (_, i) => skin.localToWorld(skin.getVertexPosition(i, new Vector3()))), normals: Vector3[] = [];
  let minimumArea = Infinity, minimumDot = 1, worstFace = -1, worstEdge = "";
  for (let i = 0; i < indices.count; i += 3) {
    triangle.set(vertices[indices.getX(i)]!, vertices[indices.getX(i + 1)]!, vertices[indices.getX(i + 2)]!);
    const area = triangle.getArea();
    if (area < minimumArea) { minimumArea = area; worstFace = i / 3; }
    normals.push(triangle.getNormal(new Vector3()));
  }
  for (const [edge, [a, b]] of edges) {
    const dot = normals[a!]!.dot(normals[b!]!);
    if (dot < minimumDot) { minimumDot = dot; worstEdge = edge; }
  }
  // Every face and adjacency contributes to these minima; aggregation preserves
  // the physical bounds while avoiding hundreds of thousands of matcher calls.
  expect(minimumArea, `${context} non-degenerate palm face ${worstFace}`).toBeGreaterThan(1e-10);
  expect(minimumDot, `${context} continuous palm edge ${worstEdge}`).toBeGreaterThan(-0.1);
}

describe("the Blender precision hand", () => {
  it("uses a raised compact C-shaped pinch with a short broad thumb on a single continuous palm", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
    const palm = rig.getObjectByName("palm_surface") as SkinnedMesh;
    expect(palm.isSkinnedMesh).toBe(true);
    expect(rig.getObjectByName("thenar")).toBeUndefined();
    expect(manifest.palm).toMatchObject({ surface: "palm_surface", topology: "single closed connected skin including thenar" });
    expect(rig.getObjectByName("palm_frame")).toBeDefined();
    expect(rig.getObjectByName("wrist_frame")).toBeDefined();
    for (const mirror of [1, -1]) {
      rig.scale.z = mirror; rig.updateMatrixWorld(true); palm.skeleton.update(); palm.computeBoundingBox(); palm.computeBoundingSphere();
      // Landmarks belong to the baked anatomical palm basis, which need not
      // coincide with the needle frame's world axes (including after mirroring).
      const frame = rig.getObjectByName("palm_frame")!;
      const radial = frame.localToWorld(new Vector3(0, 0, 1)).sub(frame.getWorldPosition(new Vector3())).normalize();
      const index = point("index_MCP"), cmc = point("thumb_CMC");
      for (const [a, b] of [["index", "middle"], ["middle", "ring"], ["ring", "little"]])
        expect(point(`${a}_MCP`).sub(point(`${b}_MCP`)).dot(radial)).toBeGreaterThan(0.015);
      expect(cmc.clone().sub(point("middle_MCP")).dot(radial), "CMC lies on the radial carpal side").toBeGreaterThan(0.015);
      expect(inside(palm, cmc)).toBe(true);
      const wrist = point("wrist"), elevation = Math.atan2(wrist.y, Math.hypot(wrist.x, wrist.z)) * 180 / Math.PI;
      expect(cmc.distanceTo(wrist), "CMC belongs at the carpal end of the palm").toBeGreaterThan(0.015);
      expect(cmc.distanceTo(wrist)).toBeLessThan(0.045);
      expect(elevation).toBeGreaterThan(50); expect(elevation).toBeLessThan(60);
      expect(elevation).toBeCloseTo(manifest.baselineElevationDeg, 5);
      const exposedThumb = point("thumb_MCP").distanceTo(point("thumb_IP")) + point("thumb_IP").distanceTo(point("thumb_tip"));
      const exposedIndex = index.distanceTo(point("index_PIP")) + point("index_PIP").distanceTo(point("index_DIP")) + point("index_DIP").distanceTo(point("index_tip"));
      expect(exposedThumb).toBeGreaterThan(0.050); expect(exposedThumb).toBeLessThan(0.056);
      expect(exposedIndex).toBeGreaterThan(0.075); expect(exposedIndex).toBeLessThan(0.088);
      expect(exposedThumb / exposedIndex).toBeLessThan(0.70);
      expect(point("index_tip").distanceTo(point("thumb_tip"))).toBeGreaterThan(0.007);
      expect(point("index_tip").distanceTo(point("thumb_tip"))).toBeLessThan(0.020);
      const a = point("index_PIP").sub(index), b = point("index_DIP").sub(point("index_PIP")), c = point("index_tip").sub(point("index_DIP"));
      // This is the authored active crest grasp, not a neutral resting hand.
      expect(a.angleTo(b) * 180 / Math.PI).toBeCloseTo(100, 3);
      expect(b.angleTo(c) * 180 / Math.PI).toBeCloseTo(60, 3);
    }
  });

  it("buries the entire CMC cap and proximal metacarpal surface inside the real deformed palm", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene; rig.updateMatrixWorld(true);
    const skin = rig.getObjectByName("thumb_skin") as SkinnedMesh, palm = rig.getObjectByName("palm_surface") as SkinnedMesh;
    const cmc = rig.getObjectByName("thumb_CMC")!.getWorldPosition(new Vector3());
    const mcp = rig.getObjectByName("thumb_MCP")!.getWorldPosition(new Vector3());
    const positions = skin.geometry.getAttribute("position"), uv = skin.geometry.getAttribute("uv"), cap: number[] = [], buried: number[] = [];
    // The embedded skin connector can curve away from its straight metacarpal
    // bone. Identify complete longitudinal rings using the actual surface UVs,
    // then locate the MCP ring by the strip's authored arc-length parameter.
    // A bone-axis projection would omit part of that curved circumference;
    // a flesh ring's geometric centre need not coincide with its bone pivot.
    const rings = new Map<number, Map<string, Vector3>>();
    for (let i = 0; i < positions.count; i++) {
      const v = Math.round(uv.getY(i) * 1e7), point = new Vector3().fromBufferAttribute(positions, i);
      if (!rings.has(v)) rings.set(v, new Map());
      rings.get(v)!.set(point.toArray().map((value) => value.toFixed(8)).join(","), point);
    }
    const centres = [...rings].map(([v, points]) => ({ v, centre: [...points.values()].reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.size) }));
    const endpoints = [centres.reduce((a, b) => a.v < b.v ? a : b), centres.reduce((a, b) => a.v > b.v ? a : b)];
    const base = endpoints.reduce((a, b) => a.centre.distanceTo(cmc) < b.centre.distanceTo(cmc) ? a : b);
    const ip = rig.getObjectByName("thumb_IP")!.getWorldPosition(new Vector3()), tip = rig.getObjectByName("thumb_tip")!.getWorldPosition(new Vector3());
    const chainLength = cmc.distanceTo(mcp) + mcp.distanceTo(ip) + ip.distanceTo(tip);
    // The generated strip stores along/(full bone chain + 2.5 mm cap extension)
    // before glTF's V flip. This selects the complete actual MCP ring even when
    // asymmetric pulp/crest shaping offsets its skin centre from the bone.
    const distal = endpoints.find((endpoint) => endpoint !== base)!;
    const mcpV = base.v + Math.sign(distal.v - base.v) * 1e7 * cmc.distanceTo(mcp) / (chainLength + 0.0025);
    const metacarpal = centres.reduce((a, b) => Math.abs(a.v - mcpV) < Math.abs(b.v - mcpV) ? a : b);
    expect(Math.abs(metacarpal.v - mcpV), "complete longitudinal MCP ring").toBeLessThan(3);
    for (let i = 0; i < positions.count; i++) {
      const v = Math.round(uv.getY(i) * 1e7), fraction = (v - base.v) / (metacarpal.v - base.v);
      if (v === base.v) cap.push(i);
      if (fraction >= -0.00001 && fraction < 0.701) buried.push(i);
    }
    expect(cap.length).toBeGreaterThanOrEqual(20); expect(buried.length).toBeGreaterThan(cap.length * 3);
    const otherCaps = ["index", "middle", "ring", "little"].map((digit) => {
      const mesh = rig.getObjectByName(`${digit}_skin`) as SkinnedMesh;
      const start = rig.getObjectByName(`${digit}_proximal`)!.getWorldPosition(new Vector3());
      const toward = rig.getObjectByName(`${digit}_middle`)!.getWorldPosition(new Vector3()).sub(start).normalize();
      const positions = mesh.geometry.getAttribute("position"), vertices: number[] = [];
      for (let i = 0; i < positions.count; i++) if (Math.abs(new Vector3().fromBufferAttribute(positions, i).sub(start).dot(toward)) < 0.0001) vertices.push(i);
      expect(vertices.length, `${digit} actual base cap`).toBeGreaterThanOrEqual(20);
      return { digit, mesh, vertices };
    });
    const hand = new ArticulatedHand(rig, gltf.animations, "#cba88a");
    for (const [pose, grip, gripStyle, rotationRad] of [["pinch", 1, "tip-pinch", 0], ["pinch", 0, "tip-pinch", 0], ["pinch", 1, "side-pinch", 0], ["pinch", 1, "tip-pinch", 1.4], ["pinch", 1, "tip-pinch", -1.4], ["palpate", 1, "tip-pinch", 0], ["stretch", 1, "tip-pinch", 0], ["press", 1, "tip-pinch", 0]] as const) {
      hand.pose({ pose, grip, gripStyle, rotationRad, phase: 0.35, apertureMm: 12,
        handleRadiusM: pose === "pinch" ? 0.0007 : undefined, wristElevationDeg: 55 });
      hand.model.updateMatrixWorld(true); skin.skeleton.update(); palm.skeleton.update(); palm.computeBoundingBox(); palm.computeBoundingSphere();
      for (const vertex of buried) {
        const point = skin.localToWorld(skin.getVertexPosition(vertex, new Vector3()));
        expect(inside(palm, point), `${pose}/grip=${grip}/${gripStyle}/${rotationRad} vertex ${vertex}${cap.includes(vertex) ? " CMC cap" : " proximal metacarpal"}`).toBe(true);
      }
      for (const { digit, mesh, vertices } of otherCaps) {
        mesh.skeleton.update();
        for (const vertex of vertices) expect(inside(palm, mesh.localToWorld(mesh.getVertexPosition(vertex, new Vector3()))), `${digit} whole MCP cap ${vertex}/${grip}/${gripStyle}/${rotationRad}`).toBe(true);
      }
    }
    hand.dispose();
  });

  it("keeps the actual UV-welded palm closed and free of paper-like opposing adjacent faces", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, skin = rig.getObjectByName("palm_surface") as SkinnedMesh;
    const edges = closedPalmEdges(skin), mixer = new AnimationMixer(rig);
    for (const clip of gltf.animations) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).setLoop(LoopOnce, 1); action.clampWhenFinished = true;
      for (const t of [...new Set([0, 0.5, 1, ...(clip.name === "hand_flick" ? flickCriticalTimes : [])])]) {
        action.reset().play(); mixer.setTime(t); rig.updateMatrixWorld(true);
        expectPalmSurface(skin, edges, `${clip.name}/${t}`);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(rig);
  });

  it("keeps the runtime palm continuous in both grip styles, openings, wrist bounds and supporting poses", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    const skin = hand.model.getObjectByName("palm_surface") as SkinnedMesh, edges = closedPalmEdges(skin);
    for (const side of ["left", "right"] as const) for (const gripStyle of ["tip-pinch", "side-pinch"] as const)
      for (const wristElevationDeg of [35, 55, 70]) for (const grip of [0, 1]) for (const rotationRad of [-1.4, 0, 1.4]) {
        hand.setSide(side);
        hand.pose({ pose: "pinch", gripStyle, wristElevationDeg, grip, rotationRad, phase: 0.3, apertureMm: 12, handleRadiusM: 0.0007 });
        expect(hand.contactValid).toBe(true);
        expectPalmSurface(skin, edges, `${side}/${gripStyle}/${wristElevationDeg}/${grip}/${rotationRad}`);
      }
    for (const side of ["left", "right"] as const) for (const pose of ["palpate", "stretch", "press"] as const) {
      hand.setSide(side); hand.pose({ pose, grip: 1, phase: 0.25, intensity: 1 });
      expectPalmSurface(skin, edges, `${side}/${pose}`);
    }
    for (const side of ["left", "right"] as const) for (const wristElevationDeg of [44, 48, 51])
      for (const grip of [0, 1]) for (const rotationRad of [-1.4, 0, 1.4]) {
        hand.setSide(side);
        hand.pose({ pose: "tripod", wristElevationDeg, grip, stabilizerGrip: 1, rotationRad, phase: 0.3, apertureMm: 12, handleRadiusM: 0.0007 });
        expect(hand.contactValid, `${side}/tripod/${wristElevationDeg}/${grip}/${rotationRad}`).toBe(true);
        expectPalmSurface(skin, edges, `${side}/tripod/${wristElevationDeg}/${grip}/${rotationRad}`);
      }
    for (const side of ["left", "right"] as const) for (const pose of ["scrape", "flick"] as const)
      for (const wristElevationDeg of [50, 55, 60]) for (const grip of [0, 0.5, 1])
        for (const phase of pose === "scrape" ? [0, 0.5, 1] : [0, 0.04, 0.08, 0.18, 0.28, 0.39, 0.5, 0.54, 0.58, 1]) {
          hand.setSide(side);
          hand.pose({ pose, wristElevationDeg, grip, phase, nailContact: phase, apertureMm: 12, handleRadiusM: 0.0007 });
          expect(hand.contactValid, `${side}/${pose}/${wristElevationDeg}/${grip}/${phase} native nail work`).toBe(true);
          expectPalmSurface(skin, edges, `${side}/${pose}/${wristElevationDeg}/${grip}/${phase}`);
        }
    hand.dispose();
  });

  it("uses a true distal nail free edge instead of the middle nail-bed side rim", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    const edge = rig.getObjectByName("middle_nail_edge_contact")!;
    expect(edge.parent?.name).toBe("middle_distal");
    expect(manifest.contactAnchors.middle_nail_edge_contact).toMatchObject({ follows: "middle_distal", surface: "middle_nail", feature: "distal-free-edge" });
    const outward = new Vector3(0, 1, 0).applyQuaternion(edge.quaternion).normalize();
    const along = rig.getObjectByName("middle_tip")!.position.clone().normalize();
    expect(outward.dot(along)).toBeGreaterThan(0.95);
    const fraction = edge.position.dot(rig.getObjectByName("middle_tip")!.position) / rig.getObjectByName("middle_tip")!.position.lengthSq();
    expect(fraction).toBeGreaterThan(0.90); expect(fraction).toBeLessThan(1.05);
    expect(edge.position.distanceTo(rig.getObjectByName("middle_nail_lateral_contact")!.position)).toBeGreaterThan(0.005);
    const point = edge.getWorldPosition(new Vector3());
    const normal = new Vector3(0, 1, 0).applyQuaternion(edge.getWorldQuaternion(new Quaternion()));
    const mesh = rig.getObjectByName("middle_nail") as Mesh;
    const hits = new Raycaster(point.clone().addScaledVector(normal, 0.001), normal.negate(), 0, 0.002).intersectObject(mesh, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.point.distanceTo(point)).toBeLessThan(0.000001);
  });

  it("provides a true volar index fingertip contact independently of the handle pinch pad", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    const contact = rig.getObjectByName("index_volar_contact")!;
    expect(contact.parent?.name).toBe("index_distal");
    expect(manifest.contactAnchors.index_volar_contact).toMatchObject({ follows: "index_distal", surface: "index_skin", feature: "true-volar-distal-tip" });
    const normal = new Vector3(0, 1, 0).applyQuaternion(contact.getWorldQuaternion(new Quaternion())).normalize();
    const pad = rig.getObjectByName("index_pad_contact")!;
    const volar = new Vector3(0, 1, 0).applyQuaternion(pad.getWorldQuaternion(new Quaternion())).normalize();
    const forward = rig.getObjectByName("index_tip")!.getWorldPosition(new Vector3()).sub(rig.getObjectByName("index_distal")!.getWorldPosition(new Vector3())).normalize();
    expect(normal.dot(volar), "support surface faces the real volar side").toBeGreaterThan(0.5);
    expect(normal.dot(forward), "support surface rounds into the distal tip").toBeGreaterThan(0.5);
    const point = contact.getWorldPosition(new Vector3());
    expect(point.distanceTo(pad.getWorldPosition(new Vector3()))).toBeGreaterThan(0.0015);
    const skin = rig.getObjectByName("index_skin") as SkinnedMesh;
    skin.skeleton.update(); skin.computeBoundingBox(); skin.computeBoundingSphere();
    const hits = new Raycaster(point.clone().addScaledVector(normal, 0.001), normal.clone().negate(), 0, 0.002).intersectObject(skin, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.point.distanceTo(point)).toBeLessThan(0.000001);
  });

  it("is the licensed, pinned model within the real-time triangle budget", () => {
    const info = parseGlb(new Uint8Array(bytes));
    expect(manifest.license).toBe("CC0-1.0");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
    expect(bytes.length).toBe(manifest.bytes);
    expect(info.counts.triangles).toBe(manifest.triangles);
    expect(info.counts.triangles).toBeLessThan(24_000);
    expect(info.counts.animations).toBe(5);
    expect(bytes.length).toBeLessThan(1_600_000);
  });

  it("loads in Three.js with a precise pinch and fifteen joints whose release clip moves the fingertips", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    const point = (name: string) => {
      const node = rig.getObjectByName(name);
      expect(node, name).toBeDefined();
      return node!.getWorldPosition(new Vector3());
    };
    expect(rig.getObjectByName("acu_practitioner_hand")).toBeDefined();
    expect(point("pinch").length()).toBeCloseTo(0, 7);
    manifest.wrist.forEach((coordinate, i) => expect(point("wrist").getComponent(i)).toBeCloseTo(coordinate, 7));
    for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
      for (const joint of ["proximal", "middle", "distal"]) expect(rig.getObjectByName(`${digit}_${joint}`)).toBeDefined();
      manifest.tips[digit]!.forEach((coordinate, i) => expect(point(`${digit}_tip`).getComponent(i)).toBeCloseTo(coordinate, 7));
    }
    const thumb = point("thumb_tip");
    const index = point("index_tip");
    expect(thumb.clone().add(index).multiplyScalar(0.5).length()).toBeLessThan(0.000001);
    const clip = gltf.animations.find((a) => a.name === "hand_open");
    expect(clip).toBeDefined();
    expect(clip!.tracks.filter((track) => /_(proximal|middle|distal)\.quaternion$/.test(track.name))).toHaveLength(15);
    expect(clip!.tracks.some((track) => track.name === "hand_pose_frame.position")).toBe(true);
    expect(clip!.duration).toBeCloseTo(1, 5);
    const mixer = new AnimationMixer(rig);
    const action = mixer.clipAction(clip!).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(0); rig.updateMatrixWorld(true);
    const closedThumb = point("thumb_tip"), closedIndex = point("index_tip");
    mixer.setTime(0.95);
    rig.updateMatrixWorld(true);
    expect(point("thumb_tip").distanceTo(thumb)).toBeGreaterThan(0.004);
    expect(point("index_tip").distanceTo(index)).toBeGreaterThan(0.004);
    expect(point("thumb_pad_contact").distanceTo(point("index_pad_contact"))).toBeGreaterThan(0.011);
    mixer.setTime(0);
    rig.updateMatrixWorld(true);
    expect(point("thumb_tip").distanceTo(closedThumb)).toBeLessThan(1e-7);
    expect(point("index_tip").distanceTo(closedIndex)).toBeLessThan(1e-7);
    mixer.stopAllAction();
    mixer.uncacheRoot(rig);
  });

  it("keeps anatomical controls at the actual legacy pivots and contacts on the moving pad/nail meshes", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    for (const [oldName, anatomyName] of Object.entries(manifest.anatomicalMapping)) {
      const old = rig.getObjectByName(oldName)!;
      const anatomy = rig.getObjectByName(anatomyName)!;
      expect(old.parent).toBe(anatomy);
      expect(old.position.length()).toBeCloseTo(0, 8);
      expect(old.getWorldPosition(new Vector3()).distanceTo(anatomy.getWorldPosition(new Vector3()))).toBeLessThan(1e-8);
    }
    expect(manifest.anatomicalJoints.thumb).toEqual(["thumb_CMC", "thumb_MCP", "thumb_IP"]);
    for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
      for (const kind of ["pad", "nail"]) {
        const name = `${digit}_${kind}_contact`;
        const anchor = rig.getObjectByName(name)!;
        expect(anchor.parent?.name).toBe(`${digit}_distal`);
        expect(manifest.contactAnchors[name]).toMatchObject({ follows: `${digit}_distal`, normalAxis: "+Y" });
        const point = anchor.getWorldPosition(new Vector3());
        const normal = new Vector3(0, 1, 0).applyQuaternion(anchor.getWorldQuaternion(new Quaternion())).normalize();
        const mesh = rig.getObjectByName(manifest.contactAnchors[name]!.surface!) as Mesh;
        const ray = new Raycaster(point.clone().addScaledVector(normal, 0.002), normal.clone().negate(), 0, 0.004);
        const hits = ray.intersectObject(mesh, false);
        expect(hits.length, name).toBeGreaterThan(0);
        expect(surfaceDistance(mesh, point), name).toBeLessThan(0.00005);
      }
    }
    const thumb = rig.getObjectByName("thumb_pad_contact")!.getWorldPosition(new Vector3());
    const index = rig.getObjectByName("index_pad_contact")!.getWorldPosition(new Vector3());
    expect(thumb.distanceTo(index)).toBeCloseTo(0.0014, 6);
    const side = rig.getObjectByName("middle_side_contact")!;
    expect(side.parent?.name).toBe("middle_distal");
    expect(surfaceDistance(rig.getObjectByName("middle_skin") as SkinnedMesh, side.getWorldPosition(new Vector3()))).toBeLessThan(0.00005);
    const bearing = rig.getObjectByName("middle_radial_pulp_78_contact")!;
    expect(side.position.distanceTo(bearing.position)).toBeLessThan(1e-8);
    expect(side.quaternion.clone().normalize().angleTo(bearing.quaternion.clone().normalize())).toBeLessThan(1e-7);
    // The anatomical parent can add motion without overwriting the legacy clip's local rotation.
    const tip = rig.getObjectByName("index_pad_contact")!;
    const before = tip.getWorldPosition(new Vector3());
    rig.getObjectByName("index_PIP")!.rotateZ(0.2);
    rig.updateMatrixWorld(true);
    expect(tip.getWorldPosition(new Vector3()).distanceTo(before)).toBeGreaterThan(0.004);
  });

  it("opposes real broad finger pads around the handle with the nails on their outside surfaces", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    for (const [digit, sign] of [["thumb", -1], ["index", 1]] as const) {
      const pad = rig.getObjectByName(`${digit}_pad_contact`)!;
      const point = pad.getWorldPosition(new Vector3());
      expect(point.distanceTo(new Vector3(0, 0, sign * 0.0007))).toBeLessThan(1e-7);
      const normal = new Vector3(0, 1, 0).applyQuaternion(pad.getWorldQuaternion(new Quaternion()));
      expect(normal.dot(new Vector3(0, 0, -sign))).toBeCloseTo(1, 7);
      // The bearing pulp must face outward from its distal phalanx. Putting
      // the IP on the needle-facing side makes the authored thumb double back
      // across the other fingers before reaching its visible contact patch.
      for (const joint of [digit === "thumb" ? "IP" : "DIP", "tip"]) {
        const bone = rig.getObjectByName(`${digit}_${joint}`)!.getWorldPosition(new Vector3());
        expect(bone.sub(point).dot(normal), `${digit} ${joint} behind bearing pulp`).toBeLessThan(-0.001);
      }
      // The pad is part of the distal skin, not a detached fingertip sphere.
      expect(manifest.contactAnchors[pad.name]!.surface).toBe(`${digit}_skin`);
      expect(rig.getObjectByName(`${digit}_pad_skin`)).toBeUndefined();
      const skin = rig.getObjectByName(`${digit}_skin`) as Mesh;
      // Probe a patch around the contact to catch a point-like or paper-thin pad.
      for (const x of [-0.001, 0, 0.001]) for (const y of [-0.001, 0, 0.001]) {
        const ray = new Raycaster(new Vector3(x, y, 0), new Vector3(0, 0, sign), 0, 0.004);
        const hits = ray.intersectObject(skin, false);
        expect(hits.length, `${digit} pad patch ${x}/${y}`).toBeGreaterThan(0);
      }
      const nailNode = rig.getObjectByName(`${digit}_nail_contact`)!;
      const nail = nailNode.getWorldPosition(new Vector3());
      const nailNormal = new Vector3(0, 1, 0).applyQuaternion(nailNode.getWorldQuaternion(new Quaternion()));
      const axis = rig.getObjectByName(`${digit}_tip`)!.getWorldPosition(new Vector3()).sub(rig.getObjectByName(`${digit}_distal`)!.getWorldPosition(new Vector3())).normalize();
      const dorsal = digit === "thumb" ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0).applyQuaternion(rig.getObjectByName("palm_frame")!.getWorldQuaternion(new Quaternion()));
      if (digit === "index") {
        const chain = ["MCP", "PIP", "DIP", "tip"].map((name) => rig.getObjectByName(`index_${name}`)!.getWorldPosition(new Vector3()));
        const directions = chain.slice(1).map((p, i) => p.clone().sub(chain[i]!).normalize());
        dorsal.addScaledVector(directions[0]!, -dorsal.dot(directions[0]!)).normalize();
        for (let i = 0; i < 2; i++) dorsal.applyQuaternion(new Quaternion().setFromUnitVectors(directions[i]!, directions[i + 1]!));
      }
      dorsal.addScaledVector(axis, -dorsal.dot(axis)).normalize();
      expect(nailNormal.dot(dorsal), `${digit} anatomical nail dorsal`).toBeGreaterThan(0.99);
      const distal = rig.getObjectByName(`${digit}_distal`)!.getWorldPosition(new Vector3());
      const length = rig.getObjectByName(`${digit}_tip`)!.getWorldPosition(new Vector3()).distanceTo(distal);
      const fraction = nail.clone().sub(distal).dot(axis) / length;
      expect(fraction, `${digit} distal nail edge`).toBeGreaterThan(0.90);
      expect(fraction, `${digit} distal nail edge`).toBeLessThan(0.97);
      // An authored tissue-thickness floor in the contact's own frame, not
      // the old absolute Z of a differently oriented distal phalanx.
      if (digit === "thumb") expect(nail.clone().sub(point).dot(normal)).toBeLessThan(-0.005);
      else expect(Math.hypot(nail.x, nail.z)).toBeGreaterThan(0.002);
    }
  });

  it("starts the thumb and index in a consistent palmar flexion plane without reverse-bent distal joints", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene;
    rig.updateMatrixWorld(true);
    for (const digit of ["thumb", "index"]) {
      const nodes = ["proximal", "middle", "distal", "tip"].map((name) => rig.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3()));
      const bones = [nodes[1]!.clone().sub(nodes[0]!), nodes[2]!.clone().sub(nodes[1]!), nodes[3]!.clone().sub(nodes[2]!)];
      const first = bones[0]!.clone().cross(bones[1]!).normalize();
      const second = bones[1]!.clone().cross(bones[2]!).normalize();
      expect(first.dot(second), `${digit} common hinge plane`).toBeGreaterThan(0.999);
      for (let i = 0; i < 2; i++) {
        // Each opposed digit keeps its own source flexion plane through both
        // joints; a global palmar sign reverses once the index curls past vertical.
        const signed = Math.atan2(bones[i]!.clone().cross(bones[i + 1]!).dot(first), bones[i]!.dot(bones[i + 1]!));
        expect(signed, `${digit} joint ${i} consistent source flexion`).toBeGreaterThan(0);
        const maximum = digit === "index" ? (i === 0 ? 115 : 95) : 60;
        expect(signed, `${digit} joint ${i} authored active-grasp flexion`).toBeLessThan(maximum * Math.PI / 180);
      }
    }
  });

  it("keeps unused fingers naturally curled while releasing the active thumb/index pair", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, mixer = new AnimationMixer(rig);
    rig.updateMatrixWorld(true);
    const hinges = new Map<string, Vector3[]>();
    for (const digit of ["middle", "ring", "little"]) {
      const points = ["proximal", "middle", "distal", "tip"].map((name) => rig.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3()));
      const bones = points.slice(1).map((point, i) => point.clone().sub(points[i]!));
      const first = bones[0]!.clone().cross(bones[1]!).normalize(), second = bones[1]!.clone().cross(bones[2]!).normalize();
      if (second.dot(first) < 0) second.negate();
      hinges.set(digit, [first.transformDirection(rig.getObjectByName(`${digit}_proximal`)!.matrixWorld.clone().invert()), second.transformDirection(rig.getObjectByName(`${digit}_middle`)!.matrixWorld.clone().invert())]);
    }
    const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === "hand_open")!).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    for (let frame = 0; frame <= 20; frame++) {
      action.reset().play(); mixer.setTime(frame / 20); rig.updateMatrixWorld(true);
      for (const digit of ["middle", "ring", "little"]) {
        const nodes = ["proximal", "middle", "distal", "tip"].map((name) => rig.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3()));
        const bones = [nodes[1]!.clone().sub(nodes[0]!), nodes[2]!.clone().sub(nodes[1]!), nodes[3]!.clone().sub(nodes[2]!)];
        for (let joint = 0; joint < 2; joint++) {
          const hinge = hinges.get(digit)![joint]!.clone().transformDirection(rig.getObjectByName(`${digit}_${joint ? "middle" : "proximal"}`)!.matrixWorld);
          const angle = Math.atan2(bones[joint]!.clone().cross(bones[joint + 1]!).dot(hinge), bones[joint]!.dot(bones[joint + 1]!));
          expect(angle, `${digit} joint ${joint} frame ${frame}`).toBeGreaterThan(0);
          expect(angle * 180 / Math.PI).toBeGreaterThan(joint === 0 ? 30 : 15);
          expect(angle * 180 / Math.PI).toBeLessThan(joint === 0 ? 115 : 85);
        }
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(rig);
  });

  it("opens and supports with the thumb on its radial side and its own volar hinge", async () => {
    for (const clipName of ["hand_open", "hand_support"]) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene, mixer = new AnimationMixer(rig);
      const point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
      const source = ["CMC", "MCP", "IP", "tip"].map((name) => point(`thumb_${name}`));
      const sourceHinge = source[1]!.clone().sub(source[0]!).cross(source[2]!.clone().sub(source[1]!)).normalize();
      const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === clipName)!).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      for (let frame = 0; frame <= 20; frame++) {
        action.reset().play(); mixer.setTime(frame / 20); rig.updateMatrixWorld(true);
        const nodes = ["CMC", "MCP", "IP", "tip"].map((name) => point(`thumb_${name}`));
        const bones = nodes.slice(1).map((node, i) => node.clone().sub(nodes[i]!));
        const hinge = sourceHinge.clone().applyQuaternion(rig.getObjectByName("thumb_proximal")!.quaternion);
        for (let joint = 0; joint < 2; joint++) {
          const angle = Math.atan2(bones[joint]!.clone().cross(bones[joint + 1]!).dot(hinge), bones[joint]!.dot(bones[joint + 1]!));
          expect(angle, `${clipName} thumb ${joint}/${frame}`).toBeGreaterThan(0);
          expect(angle, `${clipName} thumb ${joint}/${frame}`).toBeLessThan(Math.PI / 3);

        }
        if (frame % 5 === 0) for (const [from, into] of [["thumb", "index"], ["index", "thumb"], ["thumb", "middle"], ["middle", "thumb"]]) {
          expect(distalSkinIntrusion(rig, from!, into!), `${clipName} frame ${frame} ${from} into ${into}`).toBeLessThan(0.00005);
        }
        if (frame % 5 === 0) for (const digit of ["middle", "ring", "little"]) for (const surface of ["palm_surface"]) {
          expect(distalSkinIntrusion(rig, digit, surface), `${clipName} frame ${frame} ${digit} into ${surface}`).toBeLessThan(0.00005);
        }
        const palm = rig.getObjectByName("palm_surface") as SkinnedMesh;
        palm.skeleton.update(); palm.computeBoundingBox(); palm.computeBoundingSphere();
        expect(inside(palm, nodes[0]!)).toBe(true);
      }
      if (clipName === "hand_support") {
        expect(rig.getObjectByName("thumb_proximal")!.quaternion.angleTo(new Quaternion())).toBeLessThan(100 * Math.PI / 180);
        expect(distalSkinIntrusion(rig, "thumb", "index")).toBeLessThan(0.00005);
        expect(distalSkinIntrusion(rig, "index", "thumb")).toBeLessThan(0.00005);
      }
      mixer.stopAllAction(); mixer.uncacheRoot(rig);
    }
  });

  it("preserves real primary support, index nail work and complete physical surfaces throughout the authored clips", async () => {
    const cylinder = { lo: -0.01, hi: 0.01, r0: 0.001, slope: 0 };
    const plane = (z: number) => [new Vector3(-0.002, -0.003, z), new Vector3(0.002, -0.003, z), new Vector3(0, 0.003, z)];
    expect(triangleEntersNeedle(plane(0.001), cylinder, 0.000025), "a tangent triangle stays outside").toBe(false);
    expect(triangleEntersNeedle(plane(0.0008), cylinder, 0.000199), "detects 200 micrometres of true side penetration").toBe(true);
    expect(triangleEntersNeedle(plane(0.0008), cylinder, 0.000201), "does not overestimate side penetration").toBe(false);
    const cap = [new Vector3(-0.002, 0.00999, -0.002), new Vector3(0.002, 0.00999, -0.002), new Vector3(0, 0.00999, 0.002)];
    expect(triangleEntersNeedle(cap, cylinder, 0.000005), "detects ten micrometres at the finite end cap").toBe(true);
    expect(triangleEntersNeedle(cap, cylinder, 0.000025), "radial overlap cannot turn a ten-micrometre cap contact into deep penetration").toBe(false);
    for (const clipName of ["hand_three_finger", "hand_scrape", "hand_flick"]) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene, mixer = new AnimationMixer(rig);
      const point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
      const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === clipName)!).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      const times = [...new Set([...Array.from({ length: 31 }, (_, i) => i / 30), ...(clipName === "hand_flick" ? flickCriticalTimes : [])])].sort((a, b) => a - b);
      const edges: Vector3[] = [];
      let unused: Quaternion[] | undefined;
      for (let frame = 0; frame < times.length; frame++) {
        const time = times[frame]!;
        action.reset().play(); mixer.setTime(time); rig.updateMatrixWorld(true);
        if (clipName === "hand_three_finger") {
          for (const [digit, sign] of [["thumb", -1], ["index", 1]] as const) {
            expect(point(`${digit}_pad_contact`).distanceTo(new Vector3(0, -0.005, sign * needleHandleRadiusAt(-0.005))), `${clipName} ${digit}/${frame}`).toBeLessThan(0.00001);
          }
        } else if (clipName === "hand_scrape") {
          expect(point("thumb_pad_contact").distanceTo(new Vector3(0, 0.0125, 0)), `${frame} true thumb tail brace`).toBeLessThan(0.00001);
          expect(point("index_nail_edge_contact").y, `${frame} true index scraping stroke`).toBeCloseTo(-0.008 + time * 0.006, 5);
        } else {
          const definitions = manifest.materialAnimation!.materialDefinitions.flick!;
          const engaged = (name: string) => definitions[name]!.keys.filter((key) => key.frame <= 1 + 30 * time + 1e-7).at(-1)!.engaged;
          if (engaged("thumb_pad_contact")) expect(point("thumb_pad_contact").distanceTo(point("index_pad_contact")), `${frame} actual skin preparation`).toBeLessThan(0.00001);
          if (engaged("index_nail_edge_contact")) expect(point("index_nail_edge_contact").distanceTo(new Vector3(0, 0, needleHandleRadiusAt(0))), `${frame} actual nail strike`).toBeLessThan(0.000025);
        }
        const unusedDigits = clipName === "hand_three_finger" ? ["ring", "little"] : ["middle", "ring", "little"];
        const nextUnused = unusedDigits.flatMap((digit) => ["proximal", "middle", "distal"].map((joint) => rig.getObjectByName(`${digit}_${joint}`)!.quaternion.clone().normalize()));
        if (unused) nextUnused.forEach((q, i) => expect(q.angleTo(unused![i]!)).toBeLessThan(0.00001));
        unused = nextUnused;
        const edge = point(clipName === "hand_three_finger" ? "middle_side_contact" : "index_nail_edge_contact");
        if (clipName !== "hand_flick") expect(Math.abs(Math.hypot(edge.x, edge.z) - needleHandleRadiusAt(edge.y))).toBeLessThan(0.000025);
        const checkPhysical = frame % 5 === 0 || clipName === "hand_flick" && flickCriticalTimes.includes(time);
        if (checkPhysical) for (const [from, into] of [["middle", "thumb"], ["thumb", "middle"], ["middle", "index"], ["index", "middle"]]) {
          expect(distalSkinIntrusion(rig, from!, into!), `${clipName} frame ${frame} ${from} into ${into}`).toBeLessThan(0.00005);
        }
        if (checkPhysical) for (const digit of ["thumb", "index", "middle", "ring", "little"]) for (const part of ["skin", "nail"]) {
          const skin = rig.getObjectByName(`${digit}_${part}`) as Mesh;
          if (skin instanceof SkinnedMesh) skin.skeleton.update();
          const vertices = Array.from({ length: skin.geometry.getAttribute("position").count }, (_, i) => skin.localToWorld(skin.getVertexPosition(i, new Vector3())));
          let maximumDepth = -Infinity, worstVertex = -1;
          for (let vertex = 0; vertex < vertices.length; vertex++) {
            const point = vertices[vertex]!;
            if (Math.abs(point.y) > 0.0125) continue;
            const depth = Math.min((needleHandleRadiusAt(point.y) - Math.hypot(point.x, point.z)) / Math.sqrt(1 + 0.0016 ** 2), 0.0125 - Math.abs(point.y));
            if (depth > maximumDepth) { maximumDepth = depth; worstVertex = vertex; }
          }
          expect(maximumDepth, `${clipName}/${frame} actual ${digit}/${part} vertex ${worstVertex} inside finite handle`).toBeLessThan(0.00005);
          const indices = skin.geometry.index!;
          let penetration: { triangle: number; part: string } | undefined;
          for (let triangle = 0; triangle < indices.count; triangle += 3) {
            const corners = [vertices[indices.getX(triangle)]!, vertices[indices.getX(triangle + 1)]!, vertices[indices.getX(triangle + 2)]!];
            for (const frustum of [{ name: "handle", lo: -0.0125, hi: 0.0125, r0: 0.0007, slope: 0.0016 }, { name: "shaft", lo: -0.0525, hi: -0.0125, r0: 0.00024, slope: 0 }]) {
              if (triangleEntersNeedle(corners, frustum, 0.000025)) { penetration = { triangle: triangle / 3, part: frustum.name }; break; }
            }
            if (penetration) break;
          }
          expect(penetration, `${clipName}/${time}/${digit}/${part} all triangles clear of finite needle beyond 25µm`).toBeUndefined();
        }
        edges.push(edge);
      }
      if (clipName !== "hand_flick") expect(edges[0]!.y).toBeCloseTo(clipName === "hand_three_finger" ? 0.012 : -0.008, 5);
      if (clipName === "hand_scrape") expect(edges.at(-1)!.y - edges[0]!.y).toBeCloseTo(0.006, 5);
      else if (clipName === "hand_flick") {
        expect(Math.max(...edges.map((edge) => Math.hypot(edge.x, edge.z) - needleHandleRadiusAt(edge.y)))).toBeGreaterThan(0.00012);
        expect(edges.at(-1)!.distanceTo(edges[0]!)).toBeLessThan(0.00001);
      } else expect(edges.every((edge) => edge.distanceTo(edges[0]!) < 0.00001)).toBe(true);
      mixer.stopAllAction(); mixer.uncacheRoot(rig);
    }
  });

  it("deforms continuous finger surfaces with shared skin joints and independent mirrored clones", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const left = gltf.scene;
    const right = clone(left);
    left.updateMatrixWorld(true); right.updateMatrixWorld(true);
    for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
      const skin = left.getObjectByName(`${digit}_skin`) as SkinnedMesh;
      const copied = right.getObjectByName(`${digit}_skin`) as SkinnedMesh;
      expect(skin.isSkinnedMesh, digit).toBe(true);
      expect(skin.skeleton).not.toBe(copied.skeleton);
      expect(skin.skeleton.bones).toHaveLength(16);
      // A single connected surface spans all three controls: there is no
      // independent cap at each joint that can open into a visible seam.
      const indices = skin.geometry.index!;
      const neighbours = new Map<number, Set<number>>();
      for (let i = 0; i < indices.count; i += 3) {
        const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          if (!neighbours.has(u!)) neighbours.set(u!, new Set());
          if (!neighbours.has(v!)) neighbours.set(v!, new Set());
          neighbours.get(u!)!.add(v!); neighbours.get(v!)!.add(u!);
        }
      }
      const visited = new Set<number>(), pending = [0];
      while (pending.length) {
        const vertex = pending.pop()!;
        if (visited.has(vertex)) continue;
        visited.add(vertex);
        for (const neighbour of neighbours.get(vertex) ?? []) pending.push(neighbour);
      }
      expect(visited.size, `${digit} connected skin`).toBe(skin.geometry.getAttribute("position").count);
      const weights = skin.geometry.getAttribute("skinWeight");
      let blended = 0;
      for (let i = 0; i < weights.count; i++) {
        const w = [weights.getX(i), weights.getY(i), weights.getZ(i), weights.getW(i)];
        expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(w.every((v) => v >= 0 && v <= 1)).toBe(true);
        if (w.filter((v) => v > 0.05).length > 1) blended++;
      }
      expect(blended, digit).toBeGreaterThan(20);
      expect(left.getObjectByName(`${digit}_middle_knuckle`)).toBeUndefined();
      const vertex = skin.geometry.getAttribute("position").count - 1;
      const original = skin.getVertexPosition(vertex, new Vector3());
      const originalCopy = copied.getVertexPosition(vertex, new Vector3());
      left.getObjectByName(`${digit}_${digit === "thumb" ? "IP" : "DIP"}`)!.rotateZ(0.25);
      left.updateMatrixWorld(true); skin.skeleton.update();
      expect(skin.getVertexPosition(vertex, new Vector3()).distanceTo(original)).toBeGreaterThan(0.001);
      expect(copied.getVertexPosition(vertex, new Vector3()).distanceTo(originalCopy)).toBeLessThan(1e-8);
    }
  });

  it("retains immutable source bindings and bakes declared material frames onto the actual posed surfaces", async () => {
    const animation = manifest.materialAnimation;
    expect(animation?.baked, "the full asset needs a matching runtime material export").toBe(true);
    if (!animation) throw new Error("Missing baked material animation");
    expect(animation.bindFrame).toContain("frame 0");
    expect(Object.keys(animation.clipContacts).sort()).toEqual([...manifest.animations].sort());
    expect(Object.keys(animation.clipMaterialFrames).sort()).toEqual([...manifest.animations].sort());
    const materialNames = [...new Set(Object.values(animation.clipContacts).flat())].sort();
    expect(Object.keys(animation.sourceBindings).sort()).toEqual(materialNames);
    expect(Object.keys(animation.activeContacts).sort()).toEqual(Object.keys(animation.poseMaterials).sort());
    for (const [pose, names] of Object.entries(animation.activeContacts)) {
      expect(new Set(names).size, `${pose} unique active materials`).toBe(names.length);
      expect(Object.keys(animation.poseMaterials[pose]!).sort()).toEqual([...names].sort());
      for (const name of names) {
        const material = animation.poseMaterials[pose]![name]!;
        expect(material.parent, `${pose}/${name} fixed source parent`).toBe(manifest.contactAnchors[name]?.follows);
        expect(material.surface, `${pose}/${name} real declared surface`).toBe(manifest.contactAnchors[name]?.surface);
        expect(material.normalField, `${pose}/${name} explicit material normal`).toBeTruthy();
        expect(material.definition, `${pose}/${name} explicit role definition`).toBeTypeOf("object");
        expect(material.position).toHaveLength(3); expect(material.quaternion).toHaveLength(4);
        expect([...material.position, ...material.quaternion].every(Number.isFinite)).toBe(true);
        expect(new Quaternion().fromArray(material.quaternion).length()).toBeCloseTo(1, 6);
        if (material.engaged !== undefined) expect(material.engaged).toBeTypeOf("boolean");
        if (material.engagedWith !== undefined) {
          expect(material.engagedWith).toBeTypeOf("string"); expect(material.engagedWith.length).toBeGreaterThan(0);
        }
      }
    }
    const clipRoles: Record<string, { first: string; sequence?: string }> = {
      hand_open: { first: "pinch", sequence: "open" }, hand_support: { first: "support" },
      hand_three_finger: { first: "three_finger" }, hand_scrape: { first: "scrape_start", sequence: "scrape" },
      hand_flick: { first: "flick_loaded", sequence: "flick" },
    };
    for (const [clip, roles] of Object.entries(clipRoles)) {
      expect([...animation.clipContacts[clip]!].sort()).toEqual([...animation.activeContacts[roles.first]!].sort());
      if (!roles.sequence) continue;
      const definitions = animation.materialDefinitions[roles.sequence]!;
      expect(Object.keys(definitions).sort()).toEqual([...animation.clipContacts[clip]!].sort());
      for (const [name, definition] of Object.entries(definitions)) {
        expect(definition.parent, `${clip}/${name} stable material parent`).toBe(manifest.contactAnchors[name]?.follows);
        expect(definition.surface, `${clip}/${name} stable real surface`).toBe(manifest.contactAnchors[name]?.surface);
        expect(definition.normalField, `${clip}/${name} explicit frame normal`).toBeTruthy();
        expect(definition.keys.length, `${clip}/${name} material provenance keys`).toBeGreaterThan(0);
        expect(definition.keys[0]!.frame).toBe(1);
        definition.keys.forEach((key, index) => {
          expect(Number.isFinite(key.frame) && key.frame >= 1 && key.frame <= 31).toBe(true);
          expect(expectedClipTimes(clip).some((time) => Math.abs(1 + 30 * time - key.frame) < 1e-7), `${clip}/${name}/${key.frame} actual authored sample time`).toBe(true);
          if (index) expect(key.frame).toBeGreaterThan(definition.keys[index - 1]!.frame);
          expect(key.definition, `${clip}/${name}/${key.frame} explicit material definition`).toBeTypeOf("object");
          if (key.engaged !== undefined) expect(key.engaged).toBeTypeOf("boolean");
          if (key.engagedWith !== undefined) {
            expect(key.engagedWith).toBeTypeOf("string"); expect(key.engagedWith.length).toBeGreaterThan(0);
          }
        });
      }
    }

    // Clip time zero is an authored pose. The scene's unplayed defaults must
    // remain the source calibration, including after the runtime captures it.
    const raw = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    raw.scene.updateMatrixWorld(true);
    for (const name of materialNames) {
      const binding = animation.sourceBindings[name]!, node = raw.scene.getObjectByName(name)!;
      const surface = raw.scene.getObjectByName(binding.surface) as Mesh, point = node.getWorldPosition(new Vector3());
      expect(node.position.distanceTo(new Vector3().fromArray(binding.position)), `${name} raw source position`).toBeLessThan(1e-9);
      expect(node.quaternion.clone().normalize().angleTo(new Quaternion().fromArray(binding.rotation).normalize()), `${name} raw source orientation`).toBeLessThan(1e-6);
      expect(surfaceDistance(surface, point), `${name} actual unplayed source surface`).toBeLessThan(0.000005);
      expect(surfaceNormalAgreement(surface, point, new Vector3(0, 1, 0).transformDirection(node.matrixWorld), binding.normalField, {}), `${name} actual unplayed source normal field`).toBeGreaterThan(0.9999);
    }
    const runtime = new ArticulatedHand(raw.scene, raw.animations, "#d2a389");
    try {
      for (const name of materialNames) {
        const binding = animation.sourceBindings[name]!;
        expect(binding.surface, `${name} registered source surface`).toBe(manifest.contactAnchors[name]?.surface);
        expect(binding.normalField, `${name} explicit source normal field`).toBeTruthy();
        const node = runtime.model.getObjectByName(name)!;
        expect(node, `${name} real source attachment`).toBeDefined();
        expect(node.parent?.name, `${name} source parent`).toBe(manifest.contactAnchors[name]!.follows);
        expect(runtime.model.getObjectByName(binding.surface), `${name} source mesh`).toBeInstanceOf(Mesh);
        expect(node.position.distanceTo(new Vector3().fromArray(binding.position)), `${name} immutable source position`).toBeLessThan(1e-9);
        expect(node.quaternion.clone().normalize().angleTo(new Quaternion().fromArray(binding.rotation).normalize()), `${name} immutable source orientation`).toBeLessThan(1e-6);
      }
    } finally { runtime.dispose(); }

    for (const clipName of manifest.animations) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene, clip = gltf.animations.find((value) => value.name === clipName)!;
      const declared = expectDeclaredClipTracks(clip), frames = animation.clipMaterialFrames[clipName]!;
      expect(declared.length, `${clipName} explicit active material roles`).toBeGreaterThan(0);
      expect(Object.keys(frames).sort()).toEqual([...declared].sort());
      const controls = [...new Set([...legacyBoneNames, ...Object.values(manifest.anatomicalJoints).flat()])].map((name) => {
        const node = rig.getObjectByName(name)!;
        return { node, position: node.position.clone(), scale: node.scale.clone() };
      });
      const mixer = new AnimationMixer(rig), action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      try {
        const expectedTimes = expectedClipTimes(clipName), authoredTimes = manifest.clipFrames[clipName]!;
        expect(authoredTimes, `${clipName} explicit common skeletal/material clock`).toHaveLength(expectedTimes.length);
        authoredTimes.forEach((time, i) => expect(time).toBeCloseTo(expectedTimes[i]!, 8));
        if (clipName === "hand_flick") for (const track of clip.tracks) {
          const size = track.getValueSize();
          const varies = Array.from(track.values).some((value, i) => i >= size && Math.abs(value - track.values[i % size]!) > 1e-7);
          if (!varies) continue;
          for (const critical of flickCriticalTimes) {
            expect(Array.from(track.times).some((time) => Math.abs(time - critical) < 1e-6), `${track.name} preserves actual glTF sampler event ${critical}`).toBe(true);
          }
        }
        for (const name of declared) {
          expect(frames[name], `${clipName}/${name} all material samples`).toHaveLength(expectedTimes.length);
          frames[name]!.forEach((frame, i) => expect(frame.time).toBeCloseTo(expectedTimes[i]!, 8));
        }
        for (let sample = 0; sample < expectedTimes.length; sample++) {
          action.reset().play(); mixer.setTime(expectedTimes[sample]!); rig.updateMatrixWorld(true);
          for (const control of controls) {
            expect(control.node.position.distanceTo(control.position), `${clipName}/${sample}/${control.node.name} fixed pivot`).toBeLessThan(1e-12);
            expect(control.node.scale.distanceTo(control.scale), `${clipName}/${sample}/${control.node.name} fixed scale`).toBeLessThan(1e-12);
          }
          for (const name of declared) {
            const node = rig.getObjectByName(name)!, frame = frames[name]![sample]!;
            const surface = rig.getObjectByName(animation.sourceBindings[name]!.surface) as Mesh;
            expect(node.position.distanceTo(new Vector3().fromArray(frame.position)), `${clipName}/${sample}/${name} actual material translation`).toBeLessThan(5e-8);
            expect(node.quaternion.clone().normalize().angleTo(new Quaternion().fromArray(frame.rotation).normalize()), `${clipName}/${sample}/${name} actual material orientation`).toBeLessThan(1e-6);
            expect(surfaceDistance(surface, node.getWorldPosition(new Vector3())), `${clipName}/${sample}/${name} actual material surface`).toBeLessThan(0.000005);
            const roles = clipRoles[clipName]!, definition = roles.sequence
              ? animation.materialDefinitions[roles.sequence]![name]! : animation.poseMaterials[roles.first]![name]!;
            const materialDefinition = roles.sequence
              ? animation.materialDefinitions[roles.sequence]![name]!.keys.filter((key) => key.frame <= 1 + 30 * expectedTimes[sample]! + 1e-7).at(-1)!.definition
              : animation.poseMaterials[roles.first]![name]!.definition;
            const normal = new Vector3(0, 1, 0).transformDirection(node.matrixWorld);
            expect(surfaceNormalAgreement(surface, node.getWorldPosition(new Vector3()), normal, definition.normalField, materialDefinition), `${clipName}/${sample}/${name} actual surface normal field`).toBeGreaterThan(0.9999);
          }
        }
        // The glTF quaternion interpolator also has to preserve real contact
        // surfaces and the full three-dimensional facet cone between keys.
        for (let sample = 0; sample + 1 < expectedTimes.length; sample++) {
          const time = (expectedTimes[sample]! + expectedTimes[sample + 1]!) / 2;
          action.reset().play(); mixer.setTime(time); rig.updateMatrixWorld(true);
          for (const name of declared) {
            const node = rig.getObjectByName(name)!, surface = rig.getObjectByName(animation.sourceBindings[name]!.surface) as Mesh;
            const roles = clipRoles[clipName]!, definition = roles.sequence
              ? animation.materialDefinitions[roles.sequence]![name]! : animation.poseMaterials[roles.first]![name]!;
            const materialDefinition = roles.sequence
              ? animation.materialDefinitions[roles.sequence]![name]!.keys.filter((key) => key.frame <= 1 + 30 * time + 1e-7).at(-1)!.definition
              : animation.poseMaterials[roles.first]![name]!.definition;
            const point = node.getWorldPosition(new Vector3()), normal = new Vector3(0, 1, 0).transformDirection(node.matrixWorld);
            expect(surfaceDistance(surface, point), `${clipName}/${time}/${name} actual interpolated surface`).toBeLessThan(0.000005);
            expect(surfaceNormalAgreement(surface, point, normal, definition.normalField, materialDefinition), `${clipName}/${time}/${name} actual interpolated normal field`).toBeGreaterThan(0.9999);
          }
        }
      } finally { mixer.stopAllAction(); mixer.uncacheRoot(rig); }
    }
  });

  it("preserves the actual flick contact and skin preparation at their critical authored times", async () => {
    expect(manifest.materialAnimation?.baked).toBe(true);
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, ""), rig = gltf.scene;
    const clip = gltf.animations.find((value) => value.name === "hand_flick")!;
    expectDeclaredClipTracks(clip);
    const mixer = new AnimationMixer(rig), action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    const point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
    const normal = (name: string) => new Vector3(0, 1, 0).transformDirection(rig.getObjectByName(name)!.matrixWorld);
    try {
      for (const time of [0, ...flickCriticalTimes, 1]) {
        action.reset().play(); mixer.setTime(time); rig.updateMatrixWorld(true);
        const thumb = point("thumb_pad_contact"), index = point("index_pad_contact"), edge = point("index_nail_edge_contact");
        if (time === 0 || time === 0.58 || time === 1) {
          expect(thumb.distanceTo(index), `${time} true pulp-to-pulp preparation`).toBeLessThan(0.000025);
          expect(normal("thumb_pad_contact").dot(normal("index_pad_contact")), `${time} opposed real preparation normals`).toBeLessThan(-0.999);
        }
        if (time === 0.08 || time === 0.5) {
          expect(Math.abs(thumb.distanceTo(index) - 0.003), `${time} actual three-millimetre thumb clearance`).toBeLessThan(0.000025);
          expect(Math.hypot(edge.x, edge.z) - needleHandleRadiusAt(edge.y), `${time} actual cocked nail clearance`).toBeGreaterThan(0.0014);
        }
        if (time === 0.28) {
          expect(edge.distanceTo(new Vector3(0, 0, needleHandleRadiusAt(0))), "the real glTF reaches the index contact at the core impulse phase").toBeLessThan(0.000025);
          expect(normal("index_nail_edge_contact").dot(new Vector3(0, 0.0016, -1).normalize()), "actual keratin contact normal").toBeGreaterThan(0.999);
        }
      }
    } finally { mixer.stopAllAction(); mixer.uncacheRoot(rig); }
  });

  it("records a material bake from the current hand controller, anatomy and exporter", () => {
    const provenance = manifest.materialAnimation?.provenance;
    expect(manifest.materialAnimation?.baked, "stale calibration clips cannot certify the final asset").toBe(true);
    expect(provenance, "matching source hashes accompany every final bake").toBeDefined();
    if (!provenance) throw new Error("Missing material bake provenance");
    const paths = {
      hand: "packages/server/web/stage/hand.ts", physiology: "packages/server/web/stage/hand-physiology.ts",
      nailWork: "packages/server/web/stage/hand-nail-work.ts",
      anatomy: "tools/blender/hand_anatomy.json", exporter: "tools/blender/export_hand_poses.ts",
    };
    expect(Object.keys(provenance.sources).sort()).toEqual(Object.keys(paths).sort());
    for (const [name, path] of Object.entries(paths)) {
      expect(provenance.sources[name]?.path, `${name} exact source path`).toBe(path);
      expect(provenance.sources[name]?.sha256, `${name} current source hash`).toBe(createHash("sha256").update(readFileSync(here(`../../${path}`))).digest("hex"));
    }
    expect(provenance.runtimeModules, "transitive controller source hashes").toBeDefined();
    for (const name of ["hand", "physiology", "nailWork"] as const) {
      const path = paths[name];
      expect(provenance.runtimeModules[path], `${path} actual runtime dependency`).toBe(provenance.sources[name]!.sha256);
    }
    for (const [path, sha256] of Object.entries(provenance.runtimeModules)) {
      expect(path.startsWith("/") || path.startsWith("../"), `${path} repository-relative source`).toBe(false);
      expect(sha256, `${path} current transitive source hash`).toBe(createHash("sha256").update(readFileSync(here(`../../${path}`))).digest("hex"));
    }
    // The immutable input precedes rebuilding the output GLB; equating these
    // hashes would create a circular contract and discard the actual source.
    expect(provenance.calibrationInputAsset.path).toBeTruthy();
    expect(provenance.calibrationInputAsset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.calibrationInputAsset.role).toContain("input");
    expect(provenance.animationsRead).toBe(false);
    expect(provenance.runtimeContactsValidAtEveryExportedFrame).toBe(true);
  });

  it("samples all authored contact clips with fixed bone lengths, finite transforms and accurate attachment poses", async () => {
    const cases: [string, number, string][] = [
      ["hand_open", 1, "open"], ["hand_support", 1, "support"],
      ["hand_three_finger", 1, "three_finger"], ["hand_scrape", 1, "scrape"],
      ["hand_flick", 0.2, "flick_loaded"], ["hand_flick", 0.5, "flick_release"],
      ["hand_flick", 1, "flick_return"],
    ];
    const names = new Set<string>();
    for (const [clipName, time, poseName] of cases) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene;
      const clip = gltf.animations.find((a) => a.name === clipName)!;
      names.add(clipName);
      expect(clip.duration, clipName).toBeCloseTo(1, 5);
      // Stable primary contact rotations must remain present even when constant.
      expect(clip.tracks.length, clipName).toBeGreaterThanOrEqual(3);
      expectDeclaredClipTracks(clip);
      const lengths = Object.values(manifest.anatomicalJoints).flatMap((joints) => joints.slice(1).map((name) => rig.getObjectByName(name)!.position.length()));
      const mixer = new AnimationMixer(rig);
      const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      for (let frame = 0; frame <= 20; frame++) {
        action.reset().play();
        mixer.setTime(frame / 20);
        rig.updateMatrixWorld(true);
        rig.traverse((node) => expect([...node.matrixWorld.elements].every(Number.isFinite), `${clipName}/${frame}/${node.name}`).toBe(true));
        const current = Object.values(manifest.anatomicalJoints).flatMap((joints) => joints.slice(1).map((name) => rig.getObjectByName(name)!.position.length()));
        current.forEach((length, i) => expect(length).toBeCloseTo(lengths[i]!, 8));
      }
      action.reset().play();
      mixer.setTime(time);
      rig.updateMatrixWorld(true);
      for (const [name, coordinates] of Object.entries(manifest.poseContacts[poseName]!)) {
        const point = rig.getObjectByName(name)!.getWorldPosition(new Vector3());
        coordinates.forEach((coordinate, axis) => expect(point.getComponent(axis), `${clipName}/${name}/${axis}`).toBeCloseTo(coordinate, 5));
        const info = manifest.contactAnchors[name];
        if (info?.surface) {
          const surface = rig.getObjectByName(info.surface) as Mesh;
          if (surface instanceof SkinnedMesh) {
            surface.skeleton.update();
            surface.computeBoundingBox(); surface.computeBoundingSphere();
          }
          // A material sample may lie on a shared triangle edge, where a
          // floating-point ray can miss both facets. Measure its true nearest
          // deformed surface instead; five micrometres also covers the small
          // diagonal difference when the exporter triangulates a curved quad.
          expect(surfaceDistance(surface, point), `${clipName}/${name} real posed skin`).toBeLessThan(0.000005);
        }
      }
      mixer.stopAllAction();
      mixer.uncacheRoot(rig);
    }
    expect([...names].sort()).toEqual([...manifest.animations].sort());
    const tripod = manifest.poseContacts.three_finger!.middle_side_contact!;
    expect(tripod[1]).toBeCloseTo(0.012, 5);
    expect(Math.hypot(tripod[0]!, tripod[2]!)).toBeCloseTo(needleHandleRadiusAt(tripod[1]!), 5);
    const nail = manifest.poseContacts.scrape!.index_nail_edge_contact!;
    expect(nail[1]).toBeCloseTo(-0.002, 5);
    expect(Math.hypot(nail[0]!, nail[2]!)).toBeCloseTo(needleHandleRadiusAt(nail[1]!), 5);
  });
});
