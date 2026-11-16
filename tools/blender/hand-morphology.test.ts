import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Matrix4, Object3D, Quaternion, Ray, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";

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
    palm = skinTriangles(rig, "palm_surface", inverse);
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
    // Find the actual terminal UV ring, regardless of its orientation. Inspect
    // skin rather than a raised nail plate or a marker placed beyond the mesh.
    const rim = skinRings(rig, "thumb_skin").at(-1)!.points;
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

  it("keeps the actual thumb-root skin bridge smooth when the thumb abducts, without a stretched triangular spur", () => {
    const source = skinRings(rig, "thumb_skin");
    const cmc = rig.getObjectByName("thumb_CMC")!, mcp = rig.getObjectByName("thumb_MCP")!, ip = rig.getObjectByName("thumb_IP")!;
    const tip = rig.getObjectByName("thumb_tip")!;
    const origin = cmc.getWorldPosition(new Vector3()), metacarpal = mcp.getWorldPosition(new Vector3()).sub(origin);
    const selected = source.flatMap((ring, index) => {
      const fraction = ring.centre.clone().sub(origin).dot(metacarpal) / metacarpal.lengthSq();
      return fraction >= 0.55 && fraction <= 0.95 ? [index] : [];
    });
    expect(selected.length, "real metacarpal material rings, excluding either pole cap").toBeGreaterThanOrEqual(4);
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
    try {
      controls.forEach((control, index) => control.quaternion.copy(rotations[index]!)
        .multiply(rig.getObjectByName(`thumb_${["proximal", "middle", "distal"][index]}`)!.quaternion.clone().invert()));
      rig.updateMatrixWorld(true);
      const posed = skinRings(rig, "thumb_skin");
      for (const index of selected) {
        // A connector designed as a tiny hidden tube can become an exposed
        // skin flap during opposition even after its weights are smoothed.
        // This adult asset needs an actual soft-tissue envelope at the root.
        const circumference = posed[index]!.points.reduce((sum, point, vertex, points) =>
          sum + point.distanceTo(points[(vertex + 1) % points.length]!), 0);
        expect(circumference, `thumb root tissue envelope ${source[index]!.v}`).toBeGreaterThan(0.020);
        if (selected.includes(index + 1)) {
          const before = source[index]!.centre.distanceTo(source[index + 1]!.centre);
          const after = posed[index]!.centre.distanceTo(posed[index + 1]!.centre);
          // Engineering smoothness bounds for this identified connector. The
          // previous abrupt weight transition stretched one band 4.65 times.
          expect(after / before, `thumb root band ${source[index]!.v}`).toBeLessThan(2);
        }
        if (index > 0 && index < posed.length - 1) {
          const before = posed[index]!.centre.clone().sub(posed[index - 1]!.centre);
          const after = posed[index + 1]!.centre.clone().sub(posed[index]!.centre);
          expect(before.angleTo(after) / radians, `thumb root turn ${source[index]!.v}`).toBeLessThan(35);
        }
      }
    } finally {
      controls.forEach((control, index) => control.quaternion.copy(saved[index]!));
      rig.updateMatrixWorld(true);
    }
  });
});
