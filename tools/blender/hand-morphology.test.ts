import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Matrix4, Mesh, Object3D, Quaternion, Ray, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";
import { ArticulatedHand } from "../../packages/server/web/stage/hand.js";
import { createHandSkinCorrectives } from "../../packages/server/web/stage/hand-skin-correctives.js";
import { collectCompositeSkin, handSkinParts, compositeFaceNormalAlignment, findCompositeCrossings, sampleCompositeSkin, type CompositeSkin, type CompositeSkinMember } from "../test/hand-composite-skin.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const asset = process.env.ACUCRAFT_HAND_ASSET_FIXTURE ?? here("../../content/world/assets/models/acu-practitioner-hand.glb");

/** Actual bound skin triangles in the authored metacarpal frame, independent of manifest claims. */
function skinTriangles(rig: Object3D, name: string, frameInverse: Matrix4): Triangle[] {
  const mesh = rig.getObjectByName(name) as SkinnedMesh;
  expect(mesh?.isSkinnedMesh).toBe(true);
  mesh.skeleton.update();
  const vertices = Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, index) =>
    mesh.localToWorld(mesh.getVertexPosition(index, new Vector3())).applyMatrix4(frameInverse));
  const indices = mesh.geometry.getIndex()!;
  return Array.from({ length: indices.count / 3 }, (_, index) => new Triangle(
    vertices[indices.getX(index * 3)]!, vertices[indices.getX(index * 3 + 1)]!, vertices[indices.getX(index * 3 + 2)]!,
  ));
}

function skinRings(rig: Object3D, name: string): { v: number; points: Vector3[]; centre: Vector3 }[] {
  const mesh = rig.getObjectByName(name) as SkinnedMesh, uv = mesh.geometry.getAttribute("uv");
  mesh.skeleton.update();
  const rings = new Map<number, { u: number; point: Vector3 }[]>();
  for (let index = 0; index < uv.count; index++) {
    // Blender's glTF exporter flips V; recover proximal-to-distal strip order.
    const v = 1 - uv.getY(index), point = mesh.localToWorld(mesh.getVertexPosition(index, new Vector3()));
    const ring = rings.get(v) ?? [];
    // UV seams/flat cap normals can duplicate exported vertices. Count physical
    // surface samples once, so those splits cannot bias the measured centre.
    if (!ring.some((sample) => sample.point.distanceToSquared(point) < 1e-18)) ring.push({ u: uv.getX(index) % 1, point });
    rings.set(v, ring);
  }
  return [...rings].map(([v, samples]) => {
    // glTF may reorder physical vertices. The authored angular UV supplies
    // the material circumference, independently of exported index order.
    const points = samples.sort((a, b) => a.u - b.u).map((sample) => sample.point);
    return { v, points, centre: points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length) };
  }).sort((a, b) => a.v - b.v);
}

/** The real rounded thumb end, independent of UVs added while remeshing the thenar junction. */
function thumbTerminalRim(rig: Object3D): Vector3[] {
  const mesh = rig.getObjectByName("thumb_skin") as SkinnedMesh;
  const start = rig.getObjectByName("thumb_IP")!.getWorldPosition(new Vector3());
  const tip = rig.getObjectByName("thumb_tip")!.getWorldPosition(new Vector3()), axis = tip.clone().sub(start).normalize();
  const distal = mesh.skeleton.bones.findIndex((bone) => bone.name === "thumb_distal");
  expect(distal, "actual thumb terminal skin influence").toBeGreaterThanOrEqual(0);
  const indices = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
  mesh.skeleton.update();
  const samples: { point: Vector3; along: number }[] = [];
  for (let vertex = 0; vertex < mesh.geometry.getAttribute("position").count; vertex++) {
    let influence = 0;
    for (let channel = 0; channel < 4; channel++) if (indices.getComponent(vertex, channel) === distal) influence += weights.getComponent(vertex, channel);
    if (influence < 0.9999) continue;
    const point = mesh.localToWorld(mesh.getVertexPosition(vertex, new Vector3()));
    if (point.distanceTo(tip) <= 0.005) samples.push({ point, along: point.clone().sub(start).dot(axis) });
  }
  expect(samples.length, "actual rigid terminal surface near the bone end").toBeGreaterThan(30);
  const end = Math.max(...samples.map((sample) => sample.along)), rim: Vector3[] = [];
  for (const { point, along } of samples) if (end - along < 1e-7 && !rim.some((previous) => previous.distanceToSquared(point) < 1e-18)) rim.push(point);
  expect(rim.length, "actual end-plane skin and its closing fan").toBeGreaterThanOrEqual(3);
  return rim;
}

interface MaterialSection {
  id: string;
  physicalIds: number[];
  points: Vector3[];
  sourceCentre: Vector3;
  sourceMetacarpalFraction: number;
}

/** Validate real complete material bands; metadata identifies vertices, never supplies measurements. */
function thumbRootMaterialSections(rig: Object3D, skin: CompositeSkin): MaterialSection[] {
  const declaration = rig.getObjectByName("palm_surface")!.userData.skinUnion as {
    materialSections?: { id: string; vertices: { surface: string; index: number }[] }[];
  } | undefined;
  expect(declaration && typeof declaration === "object", "actual continuous-skin material chart").toBeTruthy();
  expect(Array.isArray(declaration?.materialSections), "registered complete material sections, not partial UV rows").toBe(true);
  if (!Array.isArray(declaration?.materialSections)) throw new Error("Missing actual thumb-root material sections");
  const references = new Map<string, { id: number; member: CompositeSkinMember }>();
  for (const vertex of skin.vertices) for (const member of vertex.members) references.set(`${member.mesh.name}/${member.index}`, { id: vertex.id, member });
  const edgeKey = (a: number, b: number) => `${Math.min(a, b)}/${Math.max(a, b)}`;
  const physicalEdges = new Set(skin.edges.map((edge) => edgeKey(...edge.vertices)));
  const cmc = rig.getObjectByName("thumb_CMC")!.getWorldPosition(new Vector3());
  const metacarpal = rig.getObjectByName("thumb_MCP")!.getWorldPosition(new Vector3()).sub(cmc);
  const sections = declaration.materialSections.map((section) => {
    expect(typeof section.id === "string" && section.id.length > 0, "named actual material section").toBe(true);
    expect(Array.isArray(section.vertices), `${section.id} actual vertex references`).toBe(true);
    if (!Array.isArray(section.vertices)) throw new Error(`Missing material vertices in ${section.id}`);
    const samples = section.vertices.map(({ surface, index }) => {
      expect(skin.meshes.some((mesh) => mesh.name === surface), `${section.id} real outer-skin partition`).toBe(true);
      expect(Number.isInteger(index) && index >= 0, `${section.id} actual exported vertex index`).toBe(true);
      const sample = references.get(`${surface}/${index}`);
      expect(sample, `${section.id}/${surface}/${index} actual skin vertex`).toBeDefined();
      if (!sample) throw new Error(`Unknown material vertex ${surface}/${index}`);
      return sample;
    });
    const physicalIds = samples.map((sample) => sample.id);
    expect(new Set(physicalIds).size, `${section.id} one sample per physical point, excluding UV/normal duplicates`).toBe(physicalIds.length);
    expect(physicalIds.length, `${section.id} complete tissue circumference`).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < physicalIds.length; i++) expect(physicalEdges.has(edgeKey(physicalIds[i]!, physicalIds[(i + 1) % physicalIds.length]!)),
      `${section.id} ordered closed cycle follows actual skin edges`).toBe(true);
    const points = samples.map((sample) => sample.member.position);
    const sourceCentre = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
    return { id: section.id, physicalIds, points, sourceCentre,
      sourceMetacarpalFraction: sourceCentre.clone().sub(cmc).dot(metacarpal) / metacarpal.lengthSq() };
  });
  expect(new Set(sections.map((section) => section.id)).size, "unique material section identities").toBe(sections.length);
  expect(sections.length).toBeGreaterThanOrEqual(6);
  // Every consecutive pair must bound the actual triangulated annulus. Omitting
  // an intermediate construction ring leaves missing strip faces/boundaries.
  for (let index = 0; index + 1 < sections.length; index++) {
    const a = sections[index]!, b = sections[index + 1]!, ids = new Set([...a.physicalIds, ...b.physicalIds]);
    expect(ids.size, `${a.id}/${b.id} distinct material sections`).toBe(a.physicalIds.length + b.physicalIds.length);
    const faces = skin.triangleVertexIds.filter((face) => face.every((id) => ids.has(id)));
    const edges = new Map<string, number>();
    for (const face of faces) for (const [from, to] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
      const key = edgeKey(from!, to!); edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    expect(faces.length, `${a.id}/${b.id} real annular skin faces`).toBeGreaterThan(0);
    expect(ids.size - edges.size + faces.length, `${a.id}/${b.id} actual annulus Euler characteristic`).toBe(0);
    expect([...edges.values()].every((count) => count === 1 || count === 2), `${a.id}/${b.id} manifold skin strip`).toBe(true);
    const boundary = [...edges].filter(([, count]) => count === 1).map(([key]) => key).sort();
    const expected = [a, b].flatMap((section) => section.physicalIds.map((id, i) => edgeKey(id, section.physicalIds[(i + 1) % section.physicalIds.length]!))).sort();
    expect(boundary, `${a.id}/${b.id} only the two declared material cycles bound this real strip`).toEqual(expected);
  }
  expect(sections[0]!.sourceMetacarpalFraction, "material chart starts before the measured root region").toBeLessThan(0.55);
  expect(sections.at(-1)!.sourceMetacarpalFraction, "material chart continues beyond the measured root region").toBeGreaterThan(0.95);
  const selected = sections.flatMap((section, index) => section.sourceMetacarpalFraction >= 0.55 && section.sourceMetacarpalFraction <= 0.95 ? [index] : []);
  expect(selected.length, "all actual material bands in the original anatomical 55–95% metacarpal region").toBeGreaterThanOrEqual(4);
  const first = selected[0]!, last = selected.at(-1)!;
  expect(first).toBeGreaterThan(0); expect(last).toBeLessThan(sections.length - 1);
  expect(selected).toEqual(Array.from({ length: last - first + 1 }, (_, index) => first + index));
  // A proximal flare can project back slightly before the 55% region. Only the
  // measured anatomical bands and their immediate neighbors must be ordered.
  for (let index = first; index <= last + 1; index++) expect(sections[index]!.sourceMetacarpalFraction,
    `${sections[index - 1]!.id}/${sections[index]!.id} anatomical longitudinal order`).toBeGreaterThan(sections[index - 1]!.sourceMetacarpalFraction);
  return sections;
}

/** Intersect the surface itself, rather than treating its world bounding box as palm thickness. */
function palmarSection(triangles: Triangle[], xMm: number, zMm: number): { volar: number; dorsal: number; thickness: number } {
  const ray = new Ray(new Vector3(xMm / 1000, -0.15, zMm / 1000), new Vector3(0, 1, 0));
  const point = new Vector3(), hits: number[] = [];
  for (const triangle of triangles) {
    if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, point)) continue;
    if (!hits.some((y) => Math.abs(y - point.y) < 1e-7)) hits.push(point.y);
  }
  expect(hits.length, `palm must enclose the section x=${xMm}, z=${zMm} mm`).toBeGreaterThanOrEqual(2);
  hits.sort((a, b) => a - b);
  const volar = hits[0]!, dorsal = hits.at(-1)!;
  return { volar, dorsal, thickness: dorsal - volar };
}

describe("the authored hand's soft-tissue morphology", () => {
  let palm: Triangle[], thumb: Triangle[];
  let rig: Object3D;
  let wristU: number, knuckleU: number, centralZ: number;
  const longitudinalSection = (fraction: number) => (wristU + (knuckleU - wristU) * fraction) * 1000;
  beforeAll(async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    rig = gltf.scene;
    rig.updateMatrixWorld(true);
    const frame = rig.getObjectByName("palm_frame")!;
    const inverse = frame.matrixWorld.clone().invert();
    palm = [...skinTriangles(rig, "palm_surface", inverse), ...skinTriangles(rig, "thumb_skin", inverse)];
    const point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3()).applyMatrix4(inverse);
    wristU = point("wrist").x;
    knuckleU = (point("middle_MCP").x + point("ring_MCP").x) / 2;
    centralZ = (point("middle_MCP").z + point("ring_MCP").z) / 2;
    thumb = skinTriangles(rig, "thumb_skin", new Matrix4());
  });

  it("keeps central metacarpal sections slender instead of inflating the whole palm to bury the thumb", () => {
    // Deliberately broad authored-model bounds, not population ROM/anatomical claims.
    // Locate sections from real landmarks, so a changed carpal frame cannot
    // move the probes beyond the palm or make them miss the central tissue.
    for (const fraction of [0.35, 0.65, 0.85]) for (const offsetMm of [-5, 0, 5]) {
      const x = longitudinalSection(fraction), z = centralZ * 1000 + offsetMm;
      const section = palmarSection(palm, x, z);
      expect(section.thickness * 1000, `central palm x=${x}, z=${z} mm`).toBeGreaterThan(18);
      expect(section.thickness * 1000, `central palm x=${x}, z=${z} mm`).toBeLessThan(38);
    }
  });

  it("confines the larger thenar volume to the radial side without a 69 mm palm bulge", () => {
    const thicknesses: number[] = [];
    for (const fraction of [0.25, 0.4, 0.55, 0.7, 0.85]) {
      const x = longitudinalSection(fraction), planeX = x / 1000, radial: number[] = [];
      for (const { a, b, c } of palm) for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        if (Math.abs(to!.x - from!.x) < 1e-10) continue;
        const t = (planeX - from!.x) / (to!.x - from!.x);
        if (t >= 0 && t <= 1) radial.push(from!.z + (to!.z - from!.z) * t);
      }
      expect(radial.length).toBeGreaterThan(0);
      const boundary = Math.max(...radial);
      for (const across of [0.4, 0.55, 0.7, 0.85]) {
        const z = (centralZ + (boundary - centralZ) * across) * 1000;
        thicknesses.push(palmarSection(palm, x, z).thickness * 1000);
      }
    }
    // The fixed CMC root needs a local envelope; the central-palm test separately
    // forbids using that allowance to make every section uniformly thick.
    expect(Math.max(...thicknesses)).toBeLessThan(55);
  });

  it("closes the thumb's rounded terminal surface without a broad flat cut face", () => {
    // Find the actual rigid terminal end plane. Newly filleted junction faces
    // may have unrelated UV maxima, so UV row order cannot identify this cap.
    // Inspect real skin rather than a raised nail or a marker beyond the mesh.
    const rim = thumbTerminalRim(rig);
    const onEnd = (point: Vector3) => rim.some((sample) => sample.distanceToSquared(point) < 1e-18);
    const diameter = Math.max(...rim.flatMap((a) => rim.map((b) => a.distanceTo(b))));
    const flatArea = thumb.filter((triangle) => [triangle.a, triangle.b, triangle.c].every(onEnd))
      .reduce((sum, triangle) => sum + triangle.getArea(), 0);
    // An engineering tessellation bound: leave a tiny closure after the dome,
    // rather than the previous 1.37 mm-wide, 1.13 mm² planar end disk.
    expect(diameter * 1000).toBeLessThan(0.5);
    expect(flatArea, "the terminal rim must have a real closing cap").toBeGreaterThan(0);
    expect(flatArea * 1e6).toBeLessThan(0.1);
  });

  it("keeps the proximal nail plate visible over the curved bed in a working grip", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
    hand.pose({ pose: "pinch", grip: 1, phase: 0, gripStyle: "tip-pinch", idleFingerPose: "curled" });
    hand.root.updateWorldMatrix(true, true);
    for (const digit of ["middle", "ring", "little"]) {
      const plate = hand.model.getObjectByName(`${digit}_nail`) as Mesh;
      const anchor = hand.model.getObjectByName(`${digit}_nail_contact`)!;
      const dorsal = new Vector3(0, 1, 0).transformDirection(anchor.matrixWorld);
      const skin = skinTriangles(hand.model, `${digit}_skin`, new Matrix4());
      const uv = plate.geometry.getAttribute("uv"), index = plate.geometry.getIndex()!;
      const ray = new Ray(), hit = new Vector3(), probe = new Vector3();
      let samples = 0, buried = 0;
      for (let face = 0; face < index.count; face += 3) {
        const ids = [index.getX(face), index.getX(face + 1), index.getX(face + 2)];
        if (ids.some(i => uv.getX(i) > .50)) continue;
        const [a, b, c] = ids.map(i => plate.localToWorld(plate.getVertexPosition(i, new Vector3()))) as [Vector3, Vector3, Vector3];
        if (new Triangle(a, b, c).getNormal(new Vector3()).dot(dorsal) < .55) continue;
        // Skin can emerge through the interior of a keratin triangle even
        // when its three corners sit above the bed.
        for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6 - i; j++) {
          probe.copy(a).multiplyScalar(i / 6).addScaledVector(b, j / 6).addScaledVector(c, (6 - i - j) / 6);
          ray.origin.copy(probe).addScaledVector(dorsal, .001);
          ray.direction.copy(dorsal).negate();
          if (skin.some(t => ray.intersectTriangle(t.a, t.b, t.c, true, hit) && hit.distanceTo(ray.origin) < .001 - 1e-8)) buried++;
          samples++;
        }
      }
      expect(samples, `${digit} actual cuticle and bed samples`).toBeGreaterThan(1000);
      expect(buried, `${digit} keratin hidden by overlying dorsal skin`).toBe(0);
    }
    hand.dispose();
  });

  it("retains the knuckle contour between the narrower phalanges during a working pinch", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
    for (const gripStyle of ["tip-pinch", "side-pinch"] as const) {
      hand.pose({ pose: "pinch", grip: 1, phase: 0, wristElevationDeg: 55, idleFingerPose: "curled", gripStyle });
      hand.root.updateWorldMatrix(true, true);
      expect(hand.contactValid).toBe(true);
      for (const digit of ["index", "middle", "ring", "little"]) {
        const position = (name: string) => hand.model.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3());
        const mcp = position("MCP"), pip = position("PIP"), dip = position("DIP");
        const hinge = pip.clone().sub(mcp).cross(dip.clone().sub(pip)).normalize();
        const rings = skinRings(hand.model, `${digit}_skin`);
        const breadth = (point: Vector3) => {
          const ring = rings.reduce((nearest, next) =>
            nearest.centre.distanceToSquared(point) <= next.centre.distanceToSquared(point) ? nearest : next);
          const transverse = ring.points.map(sample => sample.dot(hinge));
          return Math.max(...transverse) - Math.min(...transverse);
        };
        // Measure joint heads and neighbouring shafts on the actual posed skin.
        const proximal = breadth(mcp.clone().lerp(pip, 0.5)), middle = breadth(pip.clone().lerp(dip, 0.5));
        for (const [label, ratio] of [["PIP", breadth(pip) / proximal], ["DIP", breadth(dip) / middle]] as const) {
          expect(ratio, `${gripStyle}/${digit} ${label} to shaft width`).toBeGreaterThan(1.03);
          expect(ratio).toBeLessThan(1.25);
        }
      }
    }
    hand.dispose();
  });

  it("continues the index's terminal bearing and rounded tip along its distal axis instead of turning into a transverse cap", () => {
    // Recover each section's centre from its opposite lateral skin points.
    // A fleshy volar pad is thicker than its nail side, so its arithmetic
    // perimeter mean legitimately moves while the rounded cap narrows.
    const mcp = rig.getObjectByName("index_MCP")!.getWorldPosition(new Vector3());
    const pip = rig.getObjectByName("index_PIP")!.getWorldPosition(new Vector3());
    const dip = rig.getObjectByName("index_DIP")!.getWorldPosition(new Vector3());
    const hinge = pip.clone().sub(mcp).cross(dip.clone().sub(pip)).normalize();
    const tip = rig.getObjectByName("index_tip")!.getWorldPosition(new Vector3());
    const distal = tip.sub(dip).normalize();
    const sections = skinRings(rig, "index_skin").map((ring) => {
      const low = ring.points.reduce((a, b) => a.dot(hinge) < b.dot(hinge) ? a : b);
      const high = ring.points.reduce((a, b) => a.dot(hinge) > b.dot(hinge) ? a : b);
      return { ...ring, centre: low.clone().add(high).multiplyScalar(0.5) };
    });
    const dipSection = sections.reduce((best, ring, index) => ring.centre.distanceToSquared(dip) < sections[best]!.centre.distanceToSquared(dip) ? index : best, 0);
    const distalSections = sections.slice(dipSection);
    const terminal = Math.max(...distalSections.map((ring) => ring.centre.clone().sub(dip).dot(distal)));
    // Select a measured length, not a UV percentage: alternate valid exports
    // can assign different strip lengths to the phalanges and cap.
    const rings = distalSections.filter((ring) => terminal - ring.centre.clone().sub(dip).dot(distal) <= 0.0075);
    expect(rings.length).toBeGreaterThanOrEqual(6);
    const meanV = rings.reduce((sum, ring) => sum + ring.v, 0) / rings.length;
    const mean = rings.reduce((sum, ring) => sum.add(ring.centre), new Vector3()).divideScalar(rings.length);
    const tangent = rings.reduce((sum, ring) => sum.addScaledVector(ring.centre.clone().sub(mean), ring.v - meanV), new Vector3());
    tangent.normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, tangent.dot(distal)))) * 180 / Math.PI;
    expect(angle, "surface terminal tangent vs the actual three-dimensional distal bone").toBeLessThan(8);
    expect(rings[0]!.centre.distanceTo(rings.at(-1)!.centre)).toBeGreaterThan(0.006);
    for (const ring of rings) {
      const offset = ring.centre.clone().sub(mean);
      const error = offset.addScaledVector(tangent, -offset.dot(tangent)).length();
      expect(error, "terminal surface centreline must not kink inside the bearing/dome").toBeLessThan(0.0005);
    }
  });

  it("connects each digit to the palm through one continuous material ring in the posed mesh", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
    try {
      const skin = collectCompositeSkin(hand.model, handSkinParts);
      expect(skin.topology).toMatchObject({ connectedComponentCount: 1, boundaryEdgeCount: 0,
        nonManifoldEdgeCount: 0, windingConflictCount: 0, eulerCharacteristic: 2 });

      const rings = handSkinParts.slice(1).map((name) => {
        const edges = skin.edges.filter(({ faces }) => {
          const regions = faces.map((id) => skin.triangleSources[id]!.meshName);
          return regions.includes(name) && regions.includes("palm_surface");
        });
        const neighbours = new Map<number, number[]>();
        for (const { vertices: [a, b] } of edges) {
          for (const [from, to] of [[a, b], [b, a]] as const) {
            const ring = neighbours.get(from) ?? [];
            ring.push(to); neighbours.set(from, ring);
          }
        }
        expect(neighbours.size, `${name} actual welded circumference`).toBeGreaterThanOrEqual(16);
        expect([...neighbours.values()].every((next) => next.length === 2), `${name} unbranched circumference`).toBe(true);
        const reached = new Set<number>();
        const pending = [edges[0]!.vertices[0]];
        while (pending.length) {
          const vertex = pending.pop()!;
          if (reached.has(vertex)) continue;
          reached.add(vertex); pending.push(...neighbours.get(vertex)!);
        }
        expect(reached.size, `${name} single closed loop`).toBe(neighbours.size);
        return { name, edges };
      });

      for (const side of ["left", "right"] as const) {
        hand.setSide(side);
        for (const role of ["release", "pinch", "tripod", "skin-nail", "press"] as const) {
          hand.pose({ pose: role, phase: .3, grip: role === "release" ? 0 : 1, apertureMm: 8,
            wristElevationDeg: role === "tripod" ? 48 : 55, gripStyle: "tip-pinch", handleRadiusM: .0007 });
          sampleCompositeSkin(skin);
          expect(skin.maxSeamPositionGapM, `${side}/${role} positioned seam`).toBeLessThan(.000005);
          expect(skin.minSeamNormalDot, `${side}/${role} rendered normal on either side`).toBeGreaterThan(.99999);
          for (const { name, edges } of rings) {
            const maxTurn = Math.max(...edges.map(({ faces: [a, b] }) =>
              skin.triangles[a!]!.getNormal(new Vector3()).angleTo(skin.triangles[b!]!.getNormal(new Vector3()))));
            expect(maxTurn, `${side}/${role}/${name} uninterrupted silhouette across sewn ring`).toBeLessThan(Math.PI / 3);
          }
        }
      }
    } finally { hand.dispose(); }
  });

  it("continues the three interdigital webs beyond the row of MCP joints in a tip pinch", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
    try {
      for (const side of ["left", "right"] as const) {
        hand.setSide(side);
        hand.pose({ pose: "pinch", grip: 1, phase: .3 });
        hand.root.updateWorldMatrix(true, true);
        const triangles = skinTriangles(hand.model, "palm_surface", new Matrix4());
        const point = (digit: string, joint: string) => hand.model.getObjectByName(`${digit}_${joint}`)!.getWorldPosition(new Vector3());
        const palm = hand.model.getObjectByName("palm_frame")!;
        const dorsal = palm.localToWorld(new Vector3(0, 1, 0)).sub(palm.getWorldPosition(new Vector3())).normalize();
        for (const [a, b] of [["index", "middle"], ["middle", "ring"], ["ring", "little"]] as const) {
          const mcpA = point(a, "MCP"), mcpB = point(b, "MCP"), centre = mcpA.clone().lerp(mcpB, .5);
          const lateral = mcpB.clone().sub(mcpA).normalize();
          const proximalA = point(a, "PIP").sub(mcpA), proximalB = point(b, "PIP").sub(mcpB);
          const digitLength = (proximalA.length() + proximalB.length()) / 2;
          const distal = proximalA.normalize().add(proximalB.normalize());
          distal.addScaledVector(lateral, -distal.dot(lateral)).normalize();
          const transverse = lateral.clone().cross(distal).normalize();
          if (transverse.dot(dorsal) < 0) transverse.negate();
          // Intersect the free edge of the palm at the midpoint between these
          // two phalanges. The old overlapping tubes ended on a common palm
          // shelf 24–26% of the proximal phalanx length from the MCPs.
          // Normalize by that length because the ulnar fingers are shorter.
          const from = centre.clone().addScaledVector(transverse, -.003).addScaledVector(distal, .06);
          const ray = new Ray(from, distal.clone().negate()), hit = new Vector3();
          let extension = -Infinity;
          for (const face of triangles) if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) {
            extension = Math.max(extension, hit.sub(centre).dot(distal));
          }
          expect(extension / digitLength, `${side}/${a}–${b} actual web material`).toBeGreaterThan(.27);
          expect(extension / digitLength, `${side}/${a}–${b} free finger length`).toBeLessThan(.5);
        }
      }
    } finally { hand.dispose(); }
  });

  it("keeps a rounded, full first web in a loaded lateral pinch on either hand", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(asset)).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#d9b48f");
    const skin = collectCompositeSkin(hand.model);
    const sections = thumbRootMaterialSections(hand.model, skin);
    const web = new Set(sections.flatMap((section) => section.physicalIds));
    const edges = skin.edges.filter((edge) => edge.vertices.every((id) => web.has(id)));
    const middle = sections[Math.floor(sections.length / 2)]!;
    for (const side of ["right", "left"] as const) {
      hand.setSide(side);
      hand.pose({ pose: "pinch", gripStyle: "side-pinch", grip: 1, phase: 0.3, handleRadiusM: 0.0007, wristElevationDeg: 55 });
      sampleCompositeSkin(skin);
      const faceNormals = skin.triangles.map((triangle) => triangle.getNormal(new Vector3()));
      const maxBend = Math.max(...edges.map(({ faces: [a, b] }) => faceNormals[a!]!.angleTo(faceNormals[b!]!)));
      const width = Math.max(...middle.points.flatMap((p) => middle.points.map((q) => p.distanceTo(q))));
      // Geometry regression against the former 86° blade-like crease and
      // 14.2 mm constriction, measured on the posed skin under the same grip.
      expect(maxBend * 180 / Math.PI, `${side} adjacent facets throughout the first web`).toBeLessThan(40);
      expect(width, `${side} actual mid-web tissue span`).toBeGreaterThan(0.016);
    }
    hand.dispose();
  });

  it("keeps the actual shared thumb-palm junction smooth when the thumb abducts, without a stretched triangular spur", () => {
    const skin = collectCompositeSkin(rig, handSkinParts);
    expect(skin.topology.boundaryEdgeCount).toBe(0); expect(skin.topology.nonManifoldEdgeCount).toBe(0);
    expect(skin.topology.windingConflictCount).toBe(0); expect(skin.topology.connectedComponentCount).toBe(1);
    expect(skin.topology.eulerCharacteristic).toBe(2);
    const sections = thumbRootMaterialSections(rig, skin);
    const selected = sections.flatMap((section, index) => section.sourceMetacarpalFraction >= 0.55 && section.sourceMetacarpalFraction <= 0.95 ? [index] : []);
    const junction = new Set(skin.seamVertices.map((vertex) => vertex.id));
    const rigidThumb = skin.vertices.map((vertex) => vertex.influences.reduce((sum, influence) => sum + (influence.bone === "thumb_distal" ? influence.weight : 0), 0) >= 0.9999);
    const faces = new Set(skin.triangleVertexIds.flatMap((ids, face) => {
      const surface = skin.triangleSources[face]!.meshName;
      return surface === "palm_surface" || surface === "thumb_skin" && ids.some((id) => !rigidThumb[id])
        || ids.some((id) => junction.has(id)) ? [face] : [];
    }));
    const cmc = rig.getObjectByName("thumb_CMC")!, mcp = rig.getObjectByName("thumb_MCP")!, ip = rig.getObjectByName("thumb_IP")!;
    const tip = rig.getObjectByName("thumb_tip")!;
    const a = mcp.position.clone(), b = ip.position.clone(), c = tip.position.clone();
    const hingeA = a.clone().cross(b).normalize(), hingeB = b.clone().cross(c).normalize();
    if (hingeB.dot(hingeA) < 0) hingeB.negate();
    const signed = (from: Vector3, to: Vector3, hinge: Vector3) => Math.atan2(from.clone().cross(to).dot(hinge), from.dot(to));
    const radians = Math.PI / 180, radial = 40 * radians, palmar = 35 * radians;
    const along = new Vector3(-Math.cos(palmar) * Math.cos(radial), -Math.sin(palmar), Math.cos(palmar) * Math.sin(radial))
      .transformDirection(rig.getObjectByName("palm_frame")!.matrixWorld);
    // A named free-hand inspection, not a claim about clinical CMC limits.
    const rotations = [new Quaternion().setFromUnitVectors(a.clone().normalize(), along),
      new Quaternion().setFromAxisAngle(hingeA, 5 * radians - signed(a, b, hingeA)),
      new Quaternion().setFromAxisAngle(hingeB, 5 * radians - signed(b, c, hingeB))];
    const controls = [cmc, mcp, ip], saved = controls.map((control) => control.quaternion.clone());
    const correctives = createHandSkinCorrectives(rig);
    if (skin.meshes.some((mesh) => mesh.geometry.morphAttributes.position?.length))
      expect(correctives, "an actual morph asset needs its registered pose-space driver").toBeDefined();
    try {
      controls.forEach((control, index) => control.quaternion.copy(rotations[index]!)
        .multiply(rig.getObjectByName(`thumb_${["proximal", "middle", "distal"][index]}`)!.quaternion.clone().invert()));
      correctives?.apply();
      rig.updateMatrixWorld(true);
      sampleCompositeSkin(skin);
      expect(skin.topology.posedDegenerateFaceCount).toBe(0);
      expect(skin.maxSeamPositionGapM, "shared material boundary does not open under opposition").toBeLessThan(0.000005);
      expect(skin.minSeamNormalDot, "both actual partitions retain the same deformed normal field").toBeGreaterThan(0.99999);
      const centres = sections.map((section) => section.points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(section.points.length));
      for (const index of selected) {
        const section = sections[index]!;
        const circumference = section.points.reduce((sum, point, vertex, points) => sum + point.distanceTo(points[(vertex + 1) % points.length]!), 0);
        expect(circumference, `actual root material envelope ${section.id}`).toBeGreaterThan(0.020);
        if (selected.includes(index + 1)) {
          const before = section.sourceCentre.distanceTo(sections[index + 1]!.sourceCentre);
          const after = centres[index]!.distanceTo(centres[index + 1]!);
          expect(after / before, `actual longitudinal material-band centre strain ${section.id}`).toBeLessThan(2);
        }
        const before = centres[index]!.clone().sub(centres[index - 1]!);
        const after = centres[index + 1]!.clone().sub(centres[index]!);
        expect(before.angleTo(after) / radians, `actual material centreline turn ${section.id}`).toBeLessThan(35);
      }
      for (const face of faces) {
        expect(skin.triangles[face]!.getArea(), `actual junction face ${face} tissue envelope`).toBeGreaterThan(1e-10);
        expect(compositeFaceNormalAlignment(skin, face), `actual junction face ${face} outward normal field`).toBeGreaterThan(0);
      }
      const normals = skin.triangles.map((triangle) => triangle.getNormal(new Vector3()));
      let minimumAdjacentDot = 1, worstAdjacentEdge: number[] = [];
      for (const edge of skin.edges) {
        if (!edge.faces.some((face) => faces.has(face))) continue;
        const [a, b] = edge.faces, dot = normals[a!]!.dot(normals[b!]!);
        if (dot < minimumAdjacentDot) { minimumAdjacentDot = dot; worstAdjacentEdge = edge.vertices; }
      }
      expect(minimumAdjacentDot, `free-thumb palm/junction adjacent facet continuity ${worstAdjacentEdge}`).toBeGreaterThan(-0.1);
      expect(findCompositeCrossings(skin, { toleranceM: 0.00005, maxCrossings: 1 }).map((crossing) => crossing.faces),
        "the real free-thumb inspection has no non-adjacent skin crossing beyond 50µm").toEqual([]);
    } finally {
      controls.forEach((control, index) => control.quaternion.copy(saved[index]!));
      correctives?.reset();
      rig.updateMatrixWorld(true);
    }
  });
});
