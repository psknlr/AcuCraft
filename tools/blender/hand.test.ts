import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationMixer, LoopOnce, Mesh, MeshStandardMaterial, Object3D, Quaternion, Ray, Raycaster, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand } from "../../packages/server/web/stage/hand.js";
import { needleHandleRadiusAt } from "../../packages/server/web/stage/needle-shape.js";
import { parseGlb } from "@clinicalcraft/core";
import { distalSkinIntrusion as measureDistalIntrusion } from "../test/hand-skin-region.js";
import { collectCompositeSkin, handSkinParts, createSkinnedVertexSampler, compositeFaceNormalAlignment, findCompositeCrossings, sampleCompositeSkin, type CompositeSkin } from "../test/hand-composite-skin.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const candidate = process.env.ACUCRAFT_HAND_ASSET_FIXTURE;
const bytes = readFileSync(candidate ?? here("../../content/world/assets/models/acu-practitioner-hand.glb"));
type MaterialDefinition = { parent: string; surface: string; normalField: string; definition: Record<string, unknown>; engaged?: boolean; engagedWith?: string };
type MaterialPose = MaterialDefinition & { position: number[]; quaternion: number[] };
const manifest = JSON.parse(readFileSync(candidate ? candidate.replace(/\.glb$/, ".json") : here("./hand.json"), "utf8")) as {
  sha256: string;
  bytes: number;
  builderSourceSha256: string;
  anatomySourceSha256: string;
  correctiveSourceSha256: string;
  triangles: number;
  license: string;
  wrist: number[];
  tips: Record<string, number[]>;
  animations: string[];
  clipFrames: Record<string, number[]>;
  baselineElevationDeg: number;
  palm: { surface: string; topology: string; skinParts?: string[] };
  thumbWebCorrectives?: Record<string, unknown>;
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

const correctiveSurfaces = ["palm_surface", "thumb_skin"] as const;
let declaredCorrectiveNames: string[] | undefined;
function sourceCorrectiveNames(): string[] {
  if (declaredCorrectiveNames) return declaredCorrectiveNames;
  const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as {
    nodes: { name?: string; extras?: { thumbWebCorrectives?: { centres?: { name: unknown }[] } } }[];
  };
  const metadata = document.nodes.find((node) => node.name === "acu_practitioner_hand")?.extras?.thumbWebCorrectives;
  expect(metadata, "the actual GLB declares its pose-space corrective driver").toBeDefined();
  expect(manifest.thumbWebCorrectives, "the manifest identifies the actual exported driver").toEqual(metadata);
  expect(Array.isArray(metadata?.centres), "actual quaternion-space centres").toBe(true);
  if (!Array.isArray(metadata?.centres)) throw new Error("Missing source corrective centres");
  const names = metadata.centres.flatMap(({ name }) => {
    if (name === null) return [];
    expect(typeof name === "string" && name.length > 0, "named actual morph target").toBe(true);
    if (typeof name !== "string") throw new Error("Invalid corrective name");
    return [name];
  });
  expect(names.length, "real POSITION/NORMAL correctives rather than a metadata-only declaration").toBeGreaterThan(0);
  expect(new Set(names).size).toBe(names.length);
  declaredCorrectiveNames = names;
  return names;
}

function expectCorrectiveMeshes(rig: Object3D): SkinnedMesh[] {
  const names = sourceCorrectiveNames();
  const parts = correctiveSurfaces.map((name) => {
    const mesh = rig.getObjectByName(name) as SkinnedMesh;
    expect(mesh?.isSkinnedMesh, `${name} actual skin`).toBe(true);
    expect(Object.keys(mesh.morphTargetDictionary ?? {}).sort(), `${name} actual named target dictionary`).toEqual([...names].sort());
    expect(mesh.geometry.morphAttributes.position, `${name} actual POSITION targets`).toHaveLength(names.length);
    expect(mesh.geometry.morphAttributes.normal, `${name} actual NORMAL targets`).toHaveLength(names.length);
    expect(mesh.morphTargetInfluences, `${name} actual target weights`).toHaveLength(names.length);
    expect(mesh.geometry.morphTargetsRelative, `${name} standard glTF target deltas`).toBe(true);
    expect(names.map((target) => mesh.morphTargetDictionary![target]).sort((a, b) => a! - b!), `${name} one index for every target`).toEqual(names.map((_, index) => index));
    return mesh;
  });
  rig.traverse((node) => {
    if (!(node instanceof Mesh) || parts.includes(node as SkinnedMesh)) return;
    expect(node.geometry.morphAttributes.position?.length ?? 0, `${node.name} no unrelated position corrective`).toBe(0);
    expect(node.geometry.morphAttributes.normal?.length ?? 0, `${node.name} no unrelated normal corrective`).toBe(0);
  });
  return parts;
}

function expectedCorrectiveSamples(clipName: string): { time: number; weights: Record<string, number> }[] {
  const source = JSON.parse(readFileSync(here("./hand_poses.json"), "utf8")) as {
    correctivePoses?: Record<string, Record<string, number>>;
    sequences?: Record<string, { correctiveFrames?: Record<string, [number, number][]> }>;
  };
  const names = sourceCorrectiveNames(), times = expectedClipTimes(clipName);
  const sequenceName = ({ hand_open: "open", hand_scrape: "scrape", hand_flick: "flick" } as Record<string, string>)[clipName];
  if (sequenceName) {
    const tracks = source.sequences?.[sequenceName]?.correctiveFrames;
    expect(tracks, `${clipName} actual runtime-sampled corrective frames`).toBeDefined();
    if (!tracks) throw new Error(`Missing corrective frames for ${clipName}`);
    expect(Object.keys(tracks).sort()).toEqual([...names].sort());
    for (const name of names) expect(tracks[name], `${clipName}/${name} complete authored clock`).toHaveLength(times.length);
    return times.map((time, frame) => ({ time, weights: Object.fromEntries(names.map((name) => {
      const key = tracks[name]![frame]!;
      expect(key[0], `${clipName}/${name}/${frame} actual source clock`).toBeCloseTo(1 + 30 * time, 7);
      expect(Number.isFinite(key[1]), `${clipName}/${name}/${frame} finite source weight`).toBe(true);
      return [name, key[1]];
    })) }));
  }
  const poseName = ({ hand_support: "support", hand_three_finger: "three_finger" } as Record<string, string>)[clipName];
  expect(poseName, `${clipName} declared static corrective pose`).toBeDefined();
  const weights = source.correctivePoses?.[poseName!];
  expect(weights, `${clipName} actual runtime-sampled corrective pose`).toBeDefined();
  if (!weights) throw new Error(`Missing corrective pose for ${clipName}`);
  expect(Object.keys(weights).sort()).toEqual([...names].sort());
  expect(Object.values(weights).every(Number.isFinite)).toBe(true);
  return times.map((time) => ({ time, weights }));
}

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
  const correctives = sourceCorrectiveNames();
  const weightTracks = correctiveSurfaces.map((name) => `${name}.morphTargetInfluences`);
  expect(clip.tracks.filter((track) => track.name.endsWith(".morphTargetInfluences")).map((track) => track.name).sort(),
    `${clip.name} both actual skin partitions carry their corrective weights`).toEqual([...weightTracks].sort());
  const rotations = new Set([...legacyBoneNames, "hand_pose_frame", ...declared]);
  const translations = new Set(["hand_pose_frame", ...declared]);
  expect(new Set(clip.tracks.map((track) => track.name)).size).toBe(clip.tracks.length);
  expect(clip.tracks.filter((track) => legacyBoneNames.some((name) => track.name === `${name}.quaternion`))).toHaveLength(15);
  expect(clip.tracks.length, `${clip.name} skeletal/frame/material track budget`).toBeLessThanOrEqual(15 + 2 + 2 * declared.length + weightTracks.length);
  for (const track of clip.tracks) {
    const split = track.name.lastIndexOf("."), name = track.name.slice(0, split), property = track.name.slice(split + 1);
    if (property === "quaternion") {
      expect(rotations.has(name), `${clip.name}/${track.name} declared rotation`).toBe(true);
      expect(track.getValueSize()).toBe(4);
    } else if (property === "morphTargetInfluences") {
      expect(weightTracks.includes(track.name), `${clip.name}/${track.name} actual declared skin corrective`).toBe(true);
      expect(track.getValueSize(), `${clip.name}/${track.name} exact target count`).toBe(correctives.length);
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
  const into = (rig.getObjectByName(intoDigit) ?? rig.getObjectByName(`${intoDigit}_skin`)) as SkinnedMesh;
  return measureDistalIntrusion(from, into);
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
  const positions = mesh.geometry.getAttribute("position"), indices = mesh.geometry.index!;
  const triangle = new Triangle(), closest = new Vector3(), barycentric = new Vector3();
  const vertices: Vector3[] = [], normals: Vector3[] = [];
  // Use the actual shader order: POSITION/NORMAL morphs, then the same affine
  // LBS map, then the object's world normal matrix. Base P + base N is wrong
  // when getVertexPosition already contains a position corrective.
  const sampler = createSkinnedVertexSampler(mesh); sampler.refresh();
  for (let i = 0; i < positions.count; i++) {
    const point = new Vector3(), normal = new Vector3(); sampler.sample(i, point, normal);
    vertices.push(point); normals.push(normal);
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

function expectClosedPalmSkin(skin: CompositeSkin): void {
  expect(skin.meshes.every((mesh) => mesh.visible), "both actual outer-skin partitions remain visible").toBe(true);
  expect(skin.topology.boundaryEdgeCount, "the actual assembly has no invented closure faces").toBe(0);
  expect(skin.topology.nonManifoldEdgeCount).toBe(0);
  expect(skin.topology.windingConflictCount).toBe(0);
  expect(skin.topology.connectedComponentCount, "palm and digits form one real connected outer surface").toBe(1);
  expect(skin.topology.eulerCharacteristic).toBe(2);
  expect(skin.topology.bindDegenerateFaceCount).toBe(0);
  expect(skin.topology.negativeWeightVertexCount).toBe(0);
  expect(skin.topology.invalidWeightVertexCount).toBe(0);
  expect(skin.topology.maxRawWeightSumError).toBeLessThan(1e-6);
  expect(skin.seamVertices.length, "bind positions AND named skin weights identify a physical shared boundary").toBeGreaterThanOrEqual(16);
  expect(Math.max(...skin.seamVertices.map((seam) => seam.maxBindGapM))).toBeLessThan(1e-8);
  expect(Math.max(...skin.seamVertices.map((seam) => seam.maxInfluenceDelta))).toBeLessThan(1e-7);
}

function insidePalmSkin(skin: CompositeSkin, point: Vector3): boolean {
  let votes = 0;
  const hit = new Vector3();
  for (const axis of [new Vector3(0.431, 0.293, 0.853), new Vector3(0.853, 0.431, 0.293), new Vector3(0.293, 0.853, 0.431)]) {
    const ray = new Ray(point, axis.normalize()), distances: number[] = [];
    for (const triangle of skin.triangles) {
      if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) continue;
      const distance = hit.distanceTo(point);
      if (distance > 1e-8 && !distances.some((previous) => Math.abs(previous - distance) < 1e-7)) distances.push(distance);
    }
    if (distances.length % 2) votes++;
  }
  return votes >= 2;
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

const compositeQualityFaces = new WeakMap<CompositeSkin, Set<number>>();
function expectPalmSurface(skin: CompositeSkin, context: string): void {
  sampleCompositeSkin(skin);
  expect(skin.topology.posedDegenerateFaceCount, `${context} all actual outer faces`).toBe(0);
  expect(skin.maxSeamPositionGapM, `${context} actual material seam gap`).toBeLessThan(0.000005);
  expect(skin.minSeamNormalDot, `${context} shared deformed outer-skin normal field`).toBeGreaterThan(0.99999);
  let checked = compositeQualityFaces.get(skin);
  if (!checked) {
    const seamIds = new Set(skin.seamVertices.map((seam) => seam.id));
    const rigidThumb = skin.vertices.map((vertex) => vertex.influences.reduce((sum, influence) => sum + (influence.bone === "thumb_distal" ? influence.weight : 0), 0) >= 0.9999);
    checked = new Set(skin.triangleVertexIds.flatMap((ids, index) => {
      const surface = skin.triangleSources[index]!.meshName;
      return surface === "palm_surface" || surface === "thumb_skin" && ids.some((id) => !rigidThumb[id])
        || ids.some((id) => seamIds.has(id)) ? [index] : [];
    }));
    compositeQualityFaces.set(skin, checked);
  }
  const checkedFaces = checked;
  const normals = skin.triangles.map((triangle) => triangle.getNormal(new Vector3()));
  let minimumArea = Infinity, minimumDot = 1, minimumFieldDot = 1, worstFace = -1, worstFieldFace = -1, worstEdge: number[] = [];
  for (const face of checkedFaces) {
    const area = skin.triangles[face]!.getArea();
    if (area < minimumArea) { minimumArea = area; worstFace = face; }
    // This helper uses each actual source corner's normal, including sharp UV
    // splits, and accounts for a left hand's negative world determinant.
    const fieldDot = compositeFaceNormalAlignment(skin, face);
    if (fieldDot < minimumFieldDot) { minimumFieldDot = fieldDot; worstFieldFace = face; }
  }
  for (const edge of skin.edges) {
    if (!edge.faces.some((face) => checkedFaces.has(face))) continue;
    const [a, b] = edge.faces;
    const dot = normals[a!]!.dot(normals[b!]!);
    if (dot < minimumDot) { minimumDot = dot; worstEdge = edge.vertices; }
  }
  // Retain the original palm quality bounds over the whole constructed collar
  // and every non-rigid proximal thumb face, including the transition to the
  // protected rigid distal skin. The tiny rigid terminal cap has its separate
  // morphology contract and cannot use a palm-scale minimum face area.
  expect(minimumArea, `${context} non-degenerate palm/junction face ${worstFace}`).toBeGreaterThan(1e-10);
  expect(minimumDot, `${context} continuous palm/junction edge ${worstEdge}`).toBeGreaterThan(-0.1);
  expect(minimumFieldDot, `${context} outward palm/junction facet vs actual deformed normal field ${worstFieldFace}`).toBeGreaterThan(0);
  // The working pads can meet during a flick. This test covers the complete
  // palm, thumb and the four digital junctions; the distal pad checks measure
  // contacts with the other finger and needle in their respective tests.
  const crossings = findCompositeCrossings(skin, { toleranceM: 0.00005 })
    .filter(({ faces }) => faces.some((face) => checkedFaces.has(face))
      || faces.every((face) => skin.triangleSources[face]!.meshName === "thumb_skin"));
  expect(crossings.map((crossing) => ({ faces: crossing.faces.map((face) => skin.triangleSources[face]), edge: crossing.edge,
    planeMarginM: crossing.planeMarginM })), `${context} non-adjacent actual outer-skin crossing beyond 50µm`).toEqual([]);
}


describe("the Blender precision hand", () => {
  it("retains regional skin colour under practitioner recolouring and across all skin joins", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#8d604c");
    const meshes = ["palm_surface", "thumb_skin", "index_skin", "middle_skin", "ring_skin", "little_skin"];
    for (const name of meshes) {
      const mesh = gltf.scene.getObjectByName(name) as SkinnedMesh;
      const colour = mesh.geometry.getAttribute("color");
      expect(colour, name).toBeDefined();
      expect(colour.count).toBe(mesh.geometry.getAttribute("position").count);
      const material = mesh.material as MeshStandardMaterial;
      expect(material.vertexColors).toBe(true);
      expect(material.color.getHexString()).toBe("8d604c");
      const green = Array.from({ length: colour.count }, (_, i) => colour.getY(i));
      expect(Math.max(...green) - Math.min(...green)).toBeGreaterThan(.10);
    }
    const palm = gltf.scene.getObjectByName("palm_surface") as SkinnedMesh;
    const colour = palm.geometry.getAttribute("color");
    const wrist = palm.userData.wristInterface as { ring: number[]; distalRing: number[] };
    for (const i of [...wrist.ring, ...wrist.distalRing]) {
      expect([colour.getX(i), colour.getY(i), colour.getZ(i)]).toEqual([1, 1, 1]);
    }
    const skin = collectCompositeSkin(gltf.scene, handSkinParts);
    const shared = skin.vertices.filter(({ members }) => new Set(members.map(({ mesh }) => mesh)).size > 1);
    expect(shared.length).toBeGreaterThan(0);
    for (const { members } of shared) {
      const colours = members.map(({ mesh, index }) => new Vector3().fromBufferAttribute(mesh.geometry.getAttribute("color"), index));
      expect(colours.every((value) => value.equals(colours[0]!))).toBe(true);
    }
    hand.dispose();
  });

  it("uses a raised compact C-shaped pinch with a short broad thumb on a single continuous palm", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
    const palm = rig.getObjectByName("palm_surface") as SkinnedMesh;
    expect(palm.isSkinnedMesh).toBe(true);
    expect(rig.getObjectByName("thenar")).toBeUndefined();
    expect(manifest.palm).toMatchObject({ surface: "palm_surface", topology: "closed palm and five-digit composite", skinParts: handSkinParts });
    const outerSkin = collectCompositeSkin(rig, handSkinParts); expectClosedPalmSkin(outerSkin);
    expectPalmSurface(outerSkin, "authored bind outer skin");
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
      sampleCompositeSkin(outerSkin); expect(insidePalmSkin(outerSkin, cmc)).toBe(true);
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

  it("joins all five digits to the closed skin and encloses their root joints through flexion", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene; rig.updateMatrixWorld(true);
    const outerSkin = collectCompositeSkin(rig, handSkinParts); expectClosedPalmSkin(outerSkin);
    // Each skin patch is open at its physical junction. The assembled mesh is closed.
    for (const mesh of outerSkin.meshes) expect(collectCompositeSkin(rig, [mesh.name]).topology.boundaryEdgeCount,
      `${mesh.name} has an actual open material boundary`).toBeGreaterThan(0);
    const hand = new ArticulatedHand(rig, gltf.animations, "#cba88a");
    for (const [pose, grip, gripStyle, rotationRad] of [["pinch", 1, "tip-pinch", 0], ["pinch", 0, "tip-pinch", 0], ["pinch", 1, "side-pinch", 0], ["pinch", 1, "tip-pinch", 1.4], ["pinch", 1, "tip-pinch", -1.4], ["palpate", 1, "tip-pinch", 0], ["stretch", 1, "tip-pinch", 0], ["press", 1, "tip-pinch", 0]] as const) {
      hand.pose({ pose, grip, gripStyle, rotationRad, phase: 0.35, apertureMm: 12,
        handleRadiusM: pose === "pinch" ? 0.0007 : undefined, wristElevationDeg: 55 });
      expectPalmSurface(outerSkin, `${pose}/${grip}/${gripStyle}/${rotationRad}`);
      const cmc = rig.getObjectByName("thumb_CMC")!.getWorldPosition(new Vector3());
      expect(insidePalmSkin(outerSkin, cmc), "the actual carpal CMC remains inside the real continuous skin").toBe(true);
      for (const digit of ["index", "middle", "ring", "little"]) {
        const joint = rig.getObjectByName(`${digit}_MCP`)!.getWorldPosition(new Vector3());
        expect(insidePalmSkin(outerSkin, joint), `${digit} MCP inside the joined skin during ${pose}/${grip}/${rotationRad}`).toBe(true);
      }
    }
    hand.dispose();
  });

  it("keeps the actual joined palm and digits closed and free of opposing adjacent facets", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, skin = collectCompositeSkin(rig, handSkinParts); expectClosedPalmSkin(skin);
    const mixer = new AnimationMixer(rig);
    for (const clip of gltf.animations) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).setLoop(LoopOnce, 1); action.clampWhenFinished = true;
      for (const t of [...new Set([0, 0.5, 1, ...(clip.name === "hand_flick" ? flickCriticalTimes : [])])]) {
        action.reset().play(); mixer.setTime(t); rig.updateMatrixWorld(true);
        expectPalmSurface(skin, `${clip.name}/${t}`);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(rig);
  });

  it.each(["left", "right"] as const)("keeps the runtime %s palm continuous in both grip styles, openings, wrist bounds and supporting poses", async (side) => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    const skin = collectCompositeSkin(hand.model, handSkinParts); expectClosedPalmSkin(skin);
    for (const gripStyle of ["tip-pinch", "side-pinch"] as const)
      for (const wristElevationDeg of [35, 55, 70]) for (const grip of [0, 1]) for (const rotationRad of [-1.4, 0, 1.4]) {
        hand.setSide(side);
        hand.pose({ pose: "pinch", gripStyle, wristElevationDeg, grip, rotationRad, phase: 0.3, apertureMm: 12, handleRadiusM: 0.0007 });
        expect(hand.contactValid).toBe(true);
        expectPalmSurface(skin, `${side}/${gripStyle}/${wristElevationDeg}/${grip}/${rotationRad}`);
      }
    for (const pose of ["palpate", "stretch", "press"] as const) {
      hand.setSide(side); hand.pose({ pose, grip: 1, phase: 0.25, intensity: 1 });
      expectPalmSurface(skin, `${side}/${pose}`);
    }
    for (const wristElevationDeg of [44, 48, 51])
      for (const grip of [0, 1]) for (const rotationRad of [-1.4, 0, 1.4]) {
        hand.setSide(side);
        hand.pose({ pose: "tripod", wristElevationDeg, grip, stabilizerGrip: 1, rotationRad, phase: 0.3, apertureMm: 12, handleRadiusM: 0.0007 });
        expect(hand.contactValid, `${side}/tripod/${wristElevationDeg}/${grip}/${rotationRad}`).toBe(true);
        expectPalmSurface(skin, `${side}/tripod/${wristElevationDeg}/${grip}/${rotationRad}`);
      }
    for (const pose of ["scrape", "flick"] as const)
      for (const wristElevationDeg of [50, 55, 60]) for (const grip of [0, 0.5, 1])
        for (const phase of pose === "scrape" ? [0, 0.5, 1] : [0, 0.04, 0.08, 0.18, 0.28, 0.39, 0.5, 0.54, 0.58, 1]) {
          hand.setSide(side);
          hand.pose({ pose, wristElevationDeg, grip, phase, nailContact: phase, apertureMm: 12, handleRadiusM: 0.0007 });
          expect(hand.contactValid, `${side}/${pose}/${wristElevationDeg}/${grip}/${phase} native nail work`).toBe(true);
          expectPalmSurface(skin, `${side}/${pose}/${wristElevationDeg}/${grip}/${phase}`);
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
      const outerSkin = collectCompositeSkin(rig, handSkinParts);
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
        expect(insidePalmSkin(sampleCompositeSkin(outerSkin), nodes[0]!)).toBe(true);
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
      const joint = left.getObjectByName(`${digit}_${digit === "thumb" ? "IP" : "DIP"}`)!;
      const distalBone = skin.skeleton.bones.findIndex((bone) => bone.name === `${digit}_distal`);
      const joints = skin.geometry.getAttribute("skinIndex");
      const origin = joint.getWorldPosition(new Vector3());
      const axis = new Vector3(0, 0, 1).transformDirection(joint.matrixWorld);
      // Choose a real distal material point clear of the rotation axis. Export
      // vertex order varies with the thumb collar, UV and normal splits.
      let vertex = -1, radiusSquared = 0;
      for (let i = 0; i < weights.count; i++) {
        let distalInfluence = 0;
        for (let channel = 0; channel < weights.itemSize; channel++) {
          if (joints.getComponent(i, channel) === distalBone) distalInfluence += weights.getComponent(i, channel);
        }
        if (distalInfluence < 0.9999) continue;
        const delta = skin.getVertexPosition(i, new Vector3()).applyMatrix4(skin.matrixWorld).sub(origin);
        const radius = delta.clone().cross(axis).lengthSq();
        if (radius > radiusSquared) { vertex = i; radiusSquared = radius; }
      }
      expect(vertex, `${digit} distal rigid surface`).toBeGreaterThanOrEqual(0);
      const original = skin.getVertexPosition(vertex, new Vector3());
      const originalCopy = copied.getVertexPosition(vertex, new Vector3());
      joint.rotateZ(0.25);
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

  it("keeps every corrective POSITION/NORMAL delta exactly zero on the true distal thumb and both wrist rings", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, ""), rig = gltf.scene;
    rig.updateMatrixWorld(true);
    const parts = expectCorrectiveMeshes(rig), thumb = parts.find((mesh) => mesh.name === "thumb_skin")!, palm = parts.find((mesh) => mesh.name === "palm_surface")!;
    const start = rig.getObjectByName("thumb_IP")!.getWorldPosition(new Vector3());
    const axis = rig.getObjectByName("thumb_tip")!.getWorldPosition(new Vector3()).sub(start).normalize();
    const indices = thumb.geometry.getAttribute("skinIndex"), weights = thumb.geometry.getAttribute("skinWeight"), positions = thumb.geometry.getAttribute("position");
    const distal = thumb.skeleton.bones.findIndex((bone) => bone.name === "thumb_distal"), protectedThumb: number[] = [];
    expect(distal).toBeGreaterThanOrEqual(0);
    for (let vertex = 0; vertex < positions.count; vertex++) {
      let influence = 0;
      for (let channel = 0; channel < 4; channel++) if (indices.getComponent(vertex, channel) === distal) influence += weights.getComponent(vertex, channel);
      const point = new Vector3().fromBufferAttribute(positions, vertex).applyMatrix4(thumb.matrixWorld);
      if (influence >= 0.9999 && point.sub(start).dot(axis) >= 0.0045 - 1e-7) protectedThumb.push(vertex);
    }
    expect(protectedThumb, "the actual preserved IP+4.5mm terminal source region").toHaveLength(666);
    const wrist = palm.userData.wristInterface as { ring?: number[]; distalRing?: number[] };
    expect(wrist?.ring).toHaveLength(48); expect(wrist?.distalRing).toHaveLength(48);
    const wristRows = [...wrist.ring!, ...wrist.distalRing!];
    expect(new Set(wristRows).size, "both actual source-interface rows").toBe(96);
    const protectedWrist = new Set(wristRows);
    const composite = collectCompositeSkin(rig);
    // Protect normal/UV splits of those same physical wrist points too; the
    // internal cap and visible lateral rim must not diverge under a morph.
    for (const vertex of composite.vertices) if (vertex.members.some((member) => member.mesh === palm && protectedWrist.has(member.index)))
      vertex.members.filter((member) => member.mesh === palm).forEach((member) => protectedWrist.add(member.index));
    for (const [mesh, protectedVertices] of [[thumb, protectedThumb], [palm, [...protectedWrist]]] as const) {
      createSkinnedVertexSampler(mesh).refresh();
      for (const kind of ["position", "normal"] as const) {
        let maximum = 0, worst = "";
        for (let target = 0; target < mesh.geometry.morphAttributes[kind]!.length; target++) {
          const field = mesh.geometry.morphAttributes[kind]![target]!, base = mesh.geometry.getAttribute(kind);
          for (const vertex of protectedVertices) for (let component = 0; component < 3; component++) {
            const delta = field.getComponent(vertex, component) - (mesh.geometry.morphTargetsRelative ? 0 : base.getComponent(vertex, component));
            expect(Number.isFinite(delta), `${mesh.name}/${kind}/${target}/${vertex}/${component} finite actual target`).toBe(true);
            if (Math.abs(delta) > maximum) { maximum = Math.abs(delta); worst = `${target}/${vertex}/${component}`; }
          }
        }
        expect(maximum, `${mesh.name} actual protected ${kind} morph delta ${worst}`).toBe(0);
      }
    }
  });

  it("replays the actual runtime-sampled corrective weights on both skin partitions in every authored clip", async () => {
    const targetNames = sourceCorrectiveNames();
    for (const clipName of manifest.animations) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, ""), rig = gltf.scene;
      const parts = expectCorrectiveMeshes(rig);
      for (const mesh of parts) expect(mesh.morphTargetInfluences!.every((weight) => weight === 0), "source bind has zero initial corrective weights").toBe(true);
      const clip = gltf.animations.find((animation) => animation.name === clipName)!;
      expectDeclaredClipTracks(clip);
      const samples = expectedCorrectiveSamples(clipName);
      const tracks = parts.map((mesh) => clip.tracks.find((track) => track.name === `${mesh.name}.morphTargetInfluences`)!);
      for (const track of tracks) {
        expect(Array.from(track.times), `${clipName} real corrective clock`).toHaveLength(samples.length);
        expect(track.values.length, `${clipName} SCALAR output is key count times target count`).toBe(samples.length * targetNames.length);
      }
      expect(Array.from(tracks[0]!.times), `${clipName} identical authored clocks on both partitions`).toEqual(Array.from(tracks[1]!.times));
      const mixer = new AnimationMixer(rig), action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      try {
        for (let frame = 0; frame < samples.length; frame++) {
          const sample = samples[frame]!;
          expect(tracks[0]!.times[frame], `${clipName}/${frame} sampled source time`).toBeCloseTo(sample.time, 7);
          action.reset().play(); mixer.setTime(tracks[0]!.times[frame]!); rig.updateMatrixWorld(true);
          for (let part = 0; part < parts.length; part++) for (const name of targetNames) {
            const mesh = parts[part]!, index = mesh.morphTargetDictionary![name]!;
            const expected = Math.fround(sample.weights[name]!);
            expect(tracks[part]!.values[frame * targetNames.length + index], `${clipName}/${frame}/${mesh.name}/${name} actual serialized source weight`).toBe(expected);
            expect(mesh.morphTargetInfluences![index], `${clipName}/${frame}/${mesh.name}/${name} actual mixer weight`).toBeCloseTo(expected, 12);
          }
        }
      } finally { mixer.stopAllAction(); mixer.uncacheRoot(rig); }
    }
  });

  it("records a material bake from the current hand controller, anatomy, builder and exporter", () => {
    const provenance = manifest.materialAnimation?.provenance;
    expect(manifest.materialAnimation?.baked, "stale calibration clips cannot certify the final asset").toBe(true);
    expect(provenance, "matching source hashes accompany every final bake").toBeDefined();
    if (!provenance) throw new Error("Missing material bake provenance");
    const paths = {
      hand: "packages/server/web/stage/hand.ts", physiology: "packages/server/web/stage/hand-physiology.ts",
      nailWork: "packages/server/web/stage/hand-nail-work.ts",
      anatomy: "tools/blender/hand_anatomy.json", builder: "tools/blender/build_hand.py",
      correctives: "tools/blender/hand_thumb_web_correctives.json", exporter: "tools/blender/export_hand_poses.ts",
    };
    const builderHash = createHash("sha256").update(readFileSync(here("./build_hand.py"))).digest("hex");
    expect(manifest.builderSourceSha256, "the production manifest identifies its actual geometry algorithm").toBe(builderHash);
    const anatomyHash = createHash("sha256").update(readFileSync(here("./hand_anatomy.json"))).digest("hex");
    expect(manifest.anatomySourceSha256, "the production manifest identifies its actual anatomical construction data").toBe(anatomyHash);
    const correctiveHash = createHash("sha256").update(readFileSync(here("./hand_thumb_web_correctives.json"))).digest("hex");
    expect(manifest.correctiveSourceSha256, "the production manifest identifies its actual authored corrective data").toBe(correctiveHash);
    const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as {
      nodes: { name?: string; extras?: { builderSourceSha256?: string; anatomySourceSha256?: string; correctiveSourceSha256?: string } }[];
    };
    expect(document.nodes.find((node) => node.name === "acu_practitioner_hand")?.extras?.builderSourceSha256,
      "the actual GLB identifies the builder that produced its source geometry").toBe(builderHash);
    expect(document.nodes.find((node) => node.name === "acu_practitioner_hand")?.extras?.anatomySourceSha256,
      "the actual GLB identifies the anatomy used for calibration and baking").toBe(anatomyHash);
    expect(document.nodes.find((node) => node.name === "acu_practitioner_hand")?.extras?.correctiveSourceSha256,
      "the actual GLB identifies the corrective source used for calibration and baking").toBe(correctiveHash);
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
