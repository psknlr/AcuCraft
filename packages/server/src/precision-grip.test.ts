import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Box3, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Quaternion, Ray, Raycaster, Triangle, Vector3, type Object3D, type SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { THREE_FINGER_WRIST_BOUNDS, THREE_FINGER_WRIST_DEFAULT, sampleTechnique } from "@acucraft/core";
import { ArticulatedHand } from "../web/stage/hand.js";
import { sampleProcedure } from "../web/stage/choreography.js";
import { NEEDLE_HANDLE_RADIUS_M, exteriorGeometry, needleHandleRadiusAt, updateExteriorGeometry } from "../web/stage/needle-shape.js";

const asset = readFileSync(process.env.ACUCRAFT_HAND_GEOMETRY_FIXTURE ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const toleranceM = 0.000025;
const sourceFingerHinges = new WeakMap<ArticulatedHand, Map<string, [Vector3, Vector3]>>();

async function handRig() {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  gltf.scene.updateMatrixWorld(true);
  const palm = gltf.scene.getObjectByName("palm_frame")!;
  const dorsal = palm.localToWorld(new Vector3(0, 1, 0)).sub(palm.getWorldPosition(new Vector3())).normalize();
  const hinges = new Map<string, [Vector3, Vector3]>();
  for (const digit of ["index", "middle"]) {
    const points = ["MCP", "PIP", "DIP", "tip"].map((label) => gltf.scene.getObjectByName(`${digit}_${label}`)!.getWorldPosition(new Vector3()));
    const [a, b, c] = points.slice(1).map((point, i) => point.clone().sub(points[i]!)) as [Vector3, Vector3, Vector3];
    const first = a.clone().cross(b).normalize(), second = b.clone().cross(c).normalize();
    if (first.dot(dorsal.clone().cross(a)) < 0) first.negate();
    if (second.dot(first) < 0) second.negate();
    const proximal = gltf.scene.getObjectByName(`${digit}_proximal`)!, middle = gltf.scene.getObjectByName(`${digit}_middle`)!;
    hinges.set(digit, [first.transformDirection(proximal.matrixWorld.clone().invert()), second.transformDirection(middle.matrixWorld.clone().invert())]);
  }
  const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
  sourceFingerHinges.set(hand, hinges);
  return hand;
}

function node(hand: ArticulatedHand, name: string): Object3D {
  const found = hand.model.getObjectByName(name);
  expect(found, name).toBeDefined();
  return found!;
}

function expectedSideStagger(hand: ArticulatedHand): number {
  const branch = node(hand, "palm_frame").userData.contactFrameHorizontalBranch;
  // The refitted side hold shares one axial contact plane. Older source grips
  // retain their authored quarter-millimetre separation between the two pads.
  return branch === -1 || branch === 1 ? 0 : 0.00025;
}

function threeFingerLayout(model: Object3D): { primaryY: number; middleY: number } {
  const branch = model.getObjectByName("palm_frame")?.userData.contactFrameHorizontalBranch;
  const refitted = (branch === -1 || branch === 1) && !!model.getObjectByName("middle_volar_pulp_88_contact");
  return refitted ? { primaryY: -0.006, middleY: 0.011164059024878269 } : { primaryY: -0.012, middleY: 0.010 };
}

function hasRefittedNailRoles(hand: ArticulatedHand): boolean {
  const branch = node(hand, "palm_frame").userData.contactFrameHorizontalBranch;
  return (branch === -1 || branch === 1) && !!hand.model.getObjectByName("index_nail_edge_contact");
}

function expectTailBrace(hand: ArticulatedHand): Vector3 {
  expect(hand.contactValid, "actual thumb-tail brace solve").toBe(true);
  const frame = handleFrame(hand), contact = point(hand, "thumb_pad_contact");
  expect(contact.distanceTo(frame.origin.clone().addScaledVector(frame.axis, 0.0125)), "actual thumb tail contact").toBeLessThan(toleranceM);
  expect(normal(hand, "thumb_pad_contact").dot(frame.axis.clone().negate()), "thumb against the tail").toBeGreaterThan(0.999);
  expect(skinDistance(hand, "thumb", "thumb_pad_contact")).toBeLessThan(toleranceM);
  return contact;
}

function point(hand: ArticulatedHand, name: string): Vector3 {
  hand.root.updateWorldMatrix(true, true);
  return node(hand, name).getWorldPosition(new Vector3());
}

/** Use transformed vectors rather than getWorldQuaternion: mirrored hands have a negative determinant. */
function normal(hand: ArticulatedHand, name: string): Vector3 {
  const contact = node(hand, name), origin = point(hand, name);
  return contact.localToWorld(new Vector3(0, 1, 0)).sub(origin).normalize();
}

function handleFrame(hand: ArticulatedHand) {
  return {
    origin: hand.contactAt("handle"),
    axis: new Vector3(0, 1, 0).applyQuaternion(hand.root.quaternion),
  };
}

/** Each actual moving surface anchor must touch the handle; a correct midpoint alone is insufficient. */
function expectSurfaceContact(hand: ArticulatedHand, name: string, axialOffsetM?: number): Vector3 {
  expect(hand.contactValid, `${name} contact solution`).toBe(true);
  const frame = handleFrame(hand), contact = point(hand, name);
  const offset = contact.clone().sub(frame.origin), axial = offset.dot(frame.axis);
  const radial = offset.addScaledVector(frame.axis, -axial);
  expect(Math.abs(radial.length() - needleHandleRadiusAt(axial)), name).toBeLessThan(toleranceM);
  expect(normal(hand, name).dot(radial.normalize().negate()), `${name} inward normal`).toBeGreaterThan(0.999);
  if (axialOffsetM !== undefined) expect(Math.abs(axial - axialOffsetM), name).toBeLessThan(toleranceM);
  return contact;
}

function chainLengths(hand: ArticulatedHand): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
    const labels = digit === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
    const names = [...labels.map((label) => `${digit}_${label}`), `${digit}_tip`];
    for (let i = 0; i < names.length - 1; i++) lengths.set(`${digit}:${i}`, point(hand, names[i]!).distanceTo(point(hand, names[i + 1]!)));
  }
  return lengths;
}

function modelPoint(hand: ArticulatedHand, name: string): Vector3 {
  return hand.model.worldToLocal(point(hand, name));
}

function digitSegments(hand: ArticulatedHand, digit: string): Vector3[] {
  const labels = digit === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
  const points = [...labels.map((label) => modelPoint(hand, `${digit}_${label}`)), modelPoint(hand, `${digit}_tip`)];
  return points.slice(1).map((p, index) => p.clone().sub(points[index]!).normalize());
}

/** Transport each actual source hinge with its phalanx; MCP opposition can pass 90 degrees. */
function fingerFlexion(hand: ArticulatedHand, digit: string): [number, number] {
  const [proximal, middle, distal] = digitSegments(hand, digit) as [Vector3, Vector3, Vector3];
  const source = sourceFingerHinges.get(hand)!.get(digit)!;
  const inverseModel = hand.model.matrixWorld.clone().invert();
  const hinges = source.map((hinge, i) => hinge.clone().transformDirection(node(hand, `${digit}_${i ? "middle" : "proximal"}`).matrixWorld).transformDirection(inverseModel));
  const angle = (a: Vector3, b: Vector3, hinge: Vector3) => Math.atan2(a.clone().cross(b).dot(hinge), a.dot(b)) * 180 / Math.PI;
  return [angle(proximal, middle, hinges[0]!), angle(middle, distal, hinges[1]!)];
}

/** Twist about a phalanx's long axis cannot be detected by checking its length or contact point. */
function axialJointTwistDegrees(hand: ArticulatedHand, digit: string, index: 0 | 1 | 2): number {
  const labels = digit === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
  const control = node(hand, `${digit}_${labels[index]}`);
  const legacy = node(hand, `${digit}_${["proximal", "middle", "distal"][index]}`);
  const restAxis = node(hand, index < 2 ? `${digit}_${labels[index + 1]}` : `${digit}_tip`).position.clone().normalize();
  const rotation = control.quaternion.clone().multiply(legacy.quaternion);
  const projection = new Vector3(rotation.x, rotation.y, rotation.z).dot(restAxis);
  const radians = Math.abs(2 * Math.atan2(projection, rotation.w));
  return Math.min(radians, 2 * Math.PI - radians) * 180 / Math.PI;
}

/** Compare the attachment with the actual deformed triangles, never an analytical capsule. */
function skinDistance(hand: ArticulatedHand, digit: string, attachment: string, part: "skin" | "nail" = "skin", targetWorld?: Vector3): number {
  const skin = node(hand, `${digit}_${part}`) as Mesh;
  if ((skin as SkinnedMesh).isSkinnedMesh) (skin as SkinnedMesh).skeleton.update();
  const target = skin.worldToLocal(targetWorld?.clone() ?? point(hand, attachment)), vertices = skin.geometry.getAttribute("position"), indices = skin.geometry.index!;
  const triangle = new Triangle(), nearest = new Vector3();
  let distance = Infinity;
  for (let index = 0; index < indices.count; index += 3) {
    triangle.set(...[0, 1, 2].map((offset) => skin.getVertexPosition(indices.getX(index + offset), new Vector3())) as [Vector3, Vector3, Vector3]);
    triangle.closestPointToPoint(target, nearest);
    distance = Math.min(distance, target.distanceTo(nearest));
  }
  expect(vertices.count).toBeGreaterThan(100);
  return distance;
}

function jointRotations(hand: ArticulatedHand): Quaternion[] {
  return ["thumb", "index"].flatMap((digit) => {
    const labels = digit === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
    return labels.map((label, index) => node(hand, `${digit}_${label}`).quaternion.clone().multiply(node(hand, `${digit}_${["proximal", "middle", "distal"][index]}`).quaternion));
  });
}

interface SurfaceTree { box: Box3; children?: [SurfaceTree, SurfaceTree]; triangles?: Triangle[] }

function surfaceTree(triangles: Triangle[]): SurfaceTree {
  const box = new Box3();
  for (const triangle of triangles) box.expandByPoint(triangle.a).expandByPoint(triangle.b).expandByPoint(triangle.c);
  if (triangles.length <= 12) return { box, triangles };
  const size = box.getSize(new Vector3()), axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  triangles.sort((a, b) => a.a[axis] + a.b[axis] + a.c[axis] - b.a[axis] - b.b[axis] - b.c[axis]);
  const middle = Math.floor(triangles.length / 2);
  return { box, children: [surfaceTree(triangles.slice(0, middle)), surfaceTree(triangles.slice(middle))] };
}

function posedSurface(hand: ArticulatedHand, name: string): { points: Vector3[]; tree: SurfaceTree } {
  const mesh = node(hand, name) as SkinnedMesh;
  mesh.skeleton.update();
  const points = Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, index) => mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld));
  const indices = mesh.geometry.index!, triangles: Triangle[] = [];
  for (let index = 0; index < indices.count; index += 3) triangles.push(new Triangle(points[indices.getX(index)]!, points[indices.getX(index + 1)]!, points[indices.getX(index + 2)]!));
  return { points, tree: surfaceTree(triangles) };
}

/** Three independent rays avoid edge-grazing parity errors on mirrored skin. Contact stays at 50µm. */
function insideSurface(point: Vector3, tree: SurfaceTree): boolean {
  if (!tree.box.containsPoint(point)) return false;
  const hit = new Vector3();
  let votes = 0;
  for (const direction of [[0.431, 0.293, 0.853], [0.853, 0.431, 0.293], [0.293, 0.853, 0.431]]) {
    const ray = new Ray(point, new Vector3(...direction).normalize()), distances: number[] = [];
    const visit = (node: SurfaceTree) => {
      if (!ray.intersectBox(node.box, hit)) return;
      if (node.children) { visit(node.children[0]); visit(node.children[1]); }
      else for (const triangle of node.triangles!) if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) {
        const distance = point.distanceTo(hit);
        if (distance > 1e-7 && !distances.some((existing) => Math.abs(existing - distance) < 1e-7)) distances.push(distance);
      }
    };
    visit(tree);
    if (distances.length % 2 !== 0) votes++;
  }
  if (votes < 2) return false;
  let nearest = Infinity;
  const distance = (node: SurfaceTree) => {
    if (node.box.distanceToPoint(point) >= nearest) return;
    if (node.children) { distance(node.children[0]); distance(node.children[1]); }
    else for (const triangle of node.triangles!) {
      triangle.closestPointToPoint(point, hit);
      nearest = Math.min(nearest, point.distanceTo(hit));
    }
  };
  distance(tree);
  return nearest > 0.00005;
}

/** The shaft radius comes from the same generated tube that the scene renders. */
function renderedShaftRadius(): number {
  const geometry = exteriorGeometry();
  updateExteriorGeometry(geometry, Array.from({ length: 17 }, (_, index) => new Vector3(0, index * 0.0025, 0)));
  const positions = geometry.getAttribute("position");
  let radius = 0;
  for (let vertex = 0; vertex < positions.count; vertex++) radius = Math.max(radius, Math.hypot(positions.getX(vertex), positions.getZ(vertex)));
  geometry.dispose();
  return radius;
}

function needleSkinIntrusion(hand: ArticulatedHand, shaftRadius: number): number {
  let intrusion = 0;
  for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
    const skin = node(hand, `${digit}_skin`) as SkinnedMesh;
    skin.skeleton.update();
    for (let vertex = 0; vertex < skin.geometry.getAttribute("position").count; vertex++) {
      const point = hand.root.worldToLocal(skin.getVertexPosition(vertex, new Vector3()).applyMatrix4(skin.matrixWorld));
      const radius = Math.abs(point.y) <= 0.0125 ? needleHandleRadiusAt(point.y) : point.y < -0.0125 && point.y >= -0.0525 ? shaftRadius : 0;
      intrusion = Math.max(intrusion, radius - Math.hypot(point.x, point.z));
    }
  }
  return intrusion;
}

/** A correct nail anchor still permits solid fingers to intersect; check the actual deformed distal skin. */
function distalSkinIntrusion(hand: ArticulatedHand, fromDigit: string, intoDigit: string): number {
  const from = node(hand, `${fromDigit}_skin`) as SkinnedMesh;
  const into = node(hand, intoDigit === "palm_surface" ? intoDigit : `${intoDigit}_skin`) as SkinnedMesh;
  for (const skin of [from, into]) skin.skeleton?.update();
  const direction = new Vector3(0.431, 0.293, 0.853).normalize(), triangle = new Triangle(), nearest = new Vector3();
  const vertices = Array.from({ length: into.geometry.getAttribute("position").count }, (_, i) => into.localToWorld(into.getVertexPosition(i, new Vector3())));
  const indices = into.geometry.getIndex()!;
  // Bake the actual posed target once. Raycasting a SkinnedMesh would re-skin every target
  // triangle for every source vertex; this proxy uses the same vertices and topology in world space.
  const geometry = new BufferGeometry().setFromPoints(vertices).setIndex(indices.clone());
  const material = new MeshBasicMaterial({ side: DoubleSide }), proxy = new Mesh(geometry, material);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); proxy.updateMatrixWorld(true);
  const raycaster = new Raycaster(new Vector3(), direction, 0.000001, 1);
  try {
    let intrusion = 0;
    for (let vertex = 0; vertex < from.geometry.getAttribute("position").count; vertex++) {
      let distalWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        const boneIndex = from.geometry.getAttribute("skinIndex").array[vertex * 4 + influence]!;
        if (/(_distal|_DIP)$/.test(from.skeleton.bones[boneIndex]!.name)) distalWeight += from.geometry.getAttribute("skinWeight").array[vertex * 4 + influence]!;
      }
      if (distalWeight < 0.8) continue;
      const point = from.localToWorld(from.getVertexPosition(vertex, new Vector3()));
      const distances: number[] = [];
      raycaster.ray.origin.copy(point);
      for (const hit of raycaster.intersectObject(proxy, false)) {
        if (!distances.some((distance) => Math.abs(distance - hit.distance) < 1e-7)) distances.push(hit.distance);
      }
      if (distances.length % 2 === 0) continue;
      let surfaceDistance = Infinity;
      for (let index = 0; index < indices.count; index += 3) {
        triangle.set(vertices[indices.getX(index)]!, vertices[indices.getX(index + 1)]!, vertices[indices.getX(index + 2)]!);
        triangle.closestPointToPoint(point, nearest);
        surfaceDistance = Math.min(surfaceDistance, point.distanceTo(nearest));
      }
      intrusion = Math.max(intrusion, surfaceDistance);
      if (intrusion > 0.00005) break;
    }
    return intrusion;
  } finally {
    geometry.dispose(); material.dispose();
  }
}

describe("needle-handle surface grip regression", () => {
  it("raises the real wrist and supports distinct tip and side grips on actual skin", async () => {
    const hand = await handRig(), lengths = chainLengths(hand);
    expect(hand.model.getObjectByName("thenar")).toBeUndefined();
    expect(node(hand, "palm_surface").type).toBe("SkinnedMesh");
    for (const side of ["left", "right"] as const) for (const wristElevationDeg of [35, 55, 70]) {
      hand.setSide(side);
      let tipDirection: Vector3 | undefined;
      for (const gripStyle of ["tip-pinch", "side-pinch"] as const) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, wristElevationDeg, gripStyle });
        const indexName = gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact";
        const stagger = gripStyle === "side-pinch" ? expectedSideStagger(hand) : 0;
        expectSurfaceContact(hand, "thumb_pad_contact", stagger);
        expectSurfaceContact(hand, indexName, -stagger);
        expect(skinDistance(hand, "thumb", "thumb_pad_contact")).toBeLessThan(toleranceM);
        expect(skinDistance(hand, "index", indexName)).toBeLessThan(toleranceM);
        const wrist = hand.wrist().sub(hand.contact("pinch"));
        expect(Math.atan2(wrist.y, Math.hypot(wrist.x, wrist.z)) * 180 / Math.PI).toBeCloseTo(wristElevationDeg, 2);
        const cuff = hand.wristOrientation(new Quaternion());
        const palm = node(hand, "palm_frame"), dorsal = palm.localToWorld(new Vector3(0, 1, 0)).sub(palm.getWorldPosition(new Vector3())).normalize();
        expect(new Vector3(0, 1, 0).applyQuaternion(cuff).dot(dorsal)).toBeGreaterThan(0.9999);
        const direction = point(hand, "index_tip").sub(point(hand, indexName));
        if (gripStyle === "tip-pinch") tipDirection = direction;
        else expect(direction.distanceTo(tipDirection!)).toBeGreaterThan(0.004);
        for (const [name, length] of chainLengths(hand)) expect(length, name).toBeCloseTo(lengths.get(name)!, 7);
      }
    }
    hand.dispose();
  });

  it("rolls real opposing pulp material and preserves the refitted grip during a wrist-supplied axial stroke", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) for (const gripStyle of ["tip-pinch", "side-pinch"] as const) {
      hand.setSide(side);
      const indexName = gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact";
      const stagger = gripStyle === "side-pinch" ? expectedSideStagger(hand) : 0;
      const poses: { thumb: Vector3; index: Vector3; material: Vector3[] }[] = [];
      for (const rotationRad of [-1.4, 1.4]) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, gripStyle, rotationRad });
        expectSurfaceContact(hand, "thumb_pad_contact", stagger); expectSurfaceContact(hand, indexName, -stagger);
        expect(skinDistance(hand, "thumb", "thumb_pad_contact")).toBeLessThan(toleranceM);
        expect(skinDistance(hand, "index", indexName)).toBeLessThan(toleranceM);
        poses.push({ thumb: point(hand, "thumb_tip"), index: point(hand, "index_tip"), material: [node(hand, "thumb_pad_contact").position.clone(), node(hand, indexName).position.clone()] });
      }
      // This fixture uses the needle frame: shaft +Y, opposed pads at ±Z.
      // Circumferential opposition is therefore along ±X, independently of
      // each distal phalanx's longitudinal axis in its own skin geometry.
      expect((poses[1]!.thumb.x - poses[0]!.thumb.x) * (poses[1]!.index.x - poses[0]!.index.x)).toBeLessThan(0);
      for (let index = 0; index < 2; index++) expect(poses[0]!.material[index]!.distanceTo(poses[1]!.material[index]!)).toBeGreaterThan(0.0002);
      const axial: Quaternion[][] = [], palmPositions: Vector3[] = [];
      for (const axialDisplacementMm of [-3, 3]) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, gripStyle, axialDisplacementMm });
        expectSurfaceContact(hand, "thumb_pad_contact", stagger); expectSurfaceContact(hand, indexName, -stagger);
        axial.push(jointRotations(hand));
        palmPositions.push(hand.model.position.clone());
      }
      // Exact glTF keyframes can retain float32 norm error. Measure rotation,
      // so comparing an unchanged quaternion with itself still gives zero.
      const changed = Math.max(...axial[0]!.map((rotation, index) => rotation.clone().normalize().angleTo(axial[1]![index]!.clone().normalize())));
      const branch = node(hand, "palm_frame").userData.contactFrameHorizontalBranch;
      if (branch === -1 || branch === 1) {
        // The exact source keeps its local grasp fixed. The real procedure
        // carries both the needle and whole hand through the clinical stroke;
        // an extra local Y shift would count that displacement twice.
        expect(changed).toBeLessThan(1e-6);
        expect(palmPositions[0]!.distanceTo(palmPositions[1]!)).toBeLessThan(1e-10);
      } else expect(changed).toBeGreaterThan(0.01);
    }
    hand.dispose();
  });

  it("settles the thumb onto its real bearing continuously before either bounded turn", async () => {
    const hand = await handRig();
    for (const wristElevationDeg of [35, 55, 70]) for (const axialDisplacementMm of [-3, 3]) for (const sign of [-1, 1]) {
      let previous: Quaternion[] | undefined;
      for (let frame = 0; frame <= 30; frame++) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.3, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, wristElevationDeg, axialDisplacementMm, rotationRad: sign * frame / 100 });
        expectSurfaceContact(hand, "thumb_pad_contact", 0); expectSurfaceContact(hand, "index_pad_contact", 0);
        const rotations = jointRotations(hand);
        if (previous) for (let joint = 0; joint < rotations.length; joint++) expect(rotations[joint]!.angleTo(previous[joint]!) * 180 / Math.PI).toBeLessThan(1);
        previous = rotations;
        if (frame % 15 === 0) expect(skinDistance(hand, "thumb", "thumb_pad_contact")).toBeLessThan(toleranceM);
      }
    }
    hand.dispose();
  });

  it("continues bounded finger walking after several one-way needle turns with one pad always engaged", async () => {
    const hand = await handRig();
    for (const gripStyle of ["tip-pinch", "side-pinch"] as const) for (const sign of [-1, 1]) {
      const indexName = gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact";
      let previous: Quaternion[] | undefined;
      const lateTips: Vector3[] = [];
      for (let frame = 0; frame <= 260; frame++) {
        const rotationRad = frame * 0.04 * sign;
        hand.pose({ pose: "pinch", grip: 1, phase: 0.3, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, gripStyle, rotationRad, continuousRoll: true });
        expect(hand.contactValid, `${gripStyle}/${rotationRad}`).toBe(true);
        let engaged = 0;
        for (const name of ["thumb_pad_contact", indexName]) {
          const offset = point(hand, name).sub(hand.contactAt("handle")), axial = offset.y;
          const radius = Math.hypot(offset.x, offset.z), surface = needleHandleRadiusAt(axial);
          expect(radius).toBeGreaterThanOrEqual(surface - toleranceM);
          expect(radius).toBeLessThanOrEqual(surface + 0.0006 + toleranceM);
          if (Math.abs(radius - surface) < toleranceM) engaged++;
        }
        expect(engaged).toBeGreaterThanOrEqual(1);
        const rotations = jointRotations(hand);
        if (previous) for (let index = 0; index < rotations.length; index++) expect(rotations[index]!.angleTo(previous[index]!) * 180 / Math.PI).toBeLessThan(4);
        previous = rotations;
        if (Math.abs(rotationRad) >= 8 && frame % 10 === 0) lateTips.push(point(hand, "thumb_tip"));
      }
      expect(Math.max(...lateTips.map((tip) => tip.distanceTo(lateTips[0]!)))).toBeGreaterThan(0.0005);
    }
    hand.dispose();
  });

  it("keeps complete exposed finger skin clear in both idle poses, including open side grips", async () => {
    const hand = await handRig(), digits = ["thumb", "index", "middle", "ring", "little"];
    for (const side of ["left", "right"] as const) for (const gripStyle of ["tip-pinch", "side-pinch"] as const) {
      hand.setSide(side);
      for (const idleFingerPose of ["curled", "relaxed"] as const) for (const grip of [0, 1])
        for (const motion of grip === 0 ? [{ rotationRad: 0 }] : [{ rotationRad: -6 }, { rotationRad: 0 }, { rotationRad: 0.05 }, { rotationRad: 0.15 }, { rotationRad: 0.3 }, { rotationRad: 6 }, { rotationRad: 8, continuousRoll: true }]) {
        hand.pose({ pose: "pinch", grip, phase: 0.3, apertureMm: 12, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, gripStyle, idleFingerPose, ...motion });
        expect(hand.contactValid).toBe(true);
        const surfaces = new Map([...digits.map((digit) => `${digit}_skin`), "palm_surface"].map((name) => [name, posedSurface(hand, name)]));
        const palm = surfaces.get("palm_surface")!.tree;
        for (const digit of digits) {
          const skin = node(hand, `${digit}_skin`) as SkinnedMesh, points = surfaces.get(`${digit}_skin`)!.points;
          const external = points.filter((p) => !insideSurface(p, palm));
          for (const other of digits.filter((other) => other !== digit)) {
            const collision = external.find((p) => insideSurface(p, surfaces.get(`${other}_skin`)!.tree));
            expect(collision?.toArray(), `${side}/${gripStyle}/${idleFingerPose}/${grip}/${motion.rotationRad} exposed ${digit} into ${other}`).toBeUndefined();
          }
          const joints = skin.geometry.getAttribute("skinIndex"), weights = skin.geometry.getAttribute("skinWeight");
          for (let vertex = 0; vertex < points.length; vertex++) {
            let distalWeight = 0;
            for (let influence = 0; influence < joints.itemSize; influence++) if (skin.skeleton.bones[joints.getComponent(vertex, influence)]?.name === `${digit}_distal`) distalWeight += weights.getComponent(vertex, influence);
            if (distalWeight < 0.8) continue;
            expect(insideSurface(points[vertex]!, palm), `${side}/${gripStyle}/${idleFingerPose}/${grip} ${digit} distal ${vertex} into palm`).toBe(false);
          }
        }
      }
    }
    hand.dispose();
  });

  it("uses the bounded low-twist oblique middle-pulp support for the optional three-finger grip", async () => {
    const hand = await handRig(), shaftRadius = renderedShaftRadius();
    for (const side of ["left", "right"] as const) for (const wristElevationDeg of [THREE_FINGER_WRIST_BOUNDS.min, THREE_FINGER_WRIST_DEFAULT, THREE_FINGER_WRIST_BOUNDS.max]) {
      hand.setSide(side);
      for (const grip of [0, 0.5, 1]) for (const axialDisplacementMm of [-3, 0, 3]) for (const rotationRad of [-Math.PI / 2, 0, Math.PI / 2]) {
        hand.pose({ pose: "tripod", grip, stabilizerGrip: 1, phase: 0.3, apertureMm: 12, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, wristElevationDeg, axialDisplacementMm, rotationRad });
        expectSurfaceContact(hand, "middle_side_contact", threeFingerLayout(hand.model).middleY);
        expect(axialJointTwistDegrees(hand, "middle", 0)).toBeLessThan(20);
        if (grip === 1) {
          expectSurfaceContact(hand, "thumb_pad_contact", threeFingerLayout(hand.model).primaryY);
          expectSurfaceContact(hand, "index_pad_contact", threeFingerLayout(hand.model).primaryY);
        }
        expect(needleSkinIntrusion(hand, shaftRadius), `${side}/${wristElevationDeg}/${grip}/${axialDisplacementMm}/${rotationRad} real handle and shaft`).toBeLessThan(0.00005);
      }
    }
    expect(skinDistance(hand, "middle", "middle_side_contact")).toBeLessThan(toleranceM);
    hand.pose({ pose: "tripod", grip: 1, phase: 0, gripStyle: "side-pinch", handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
    expect(hand.contactValid).toBe(false);
    hand.dispose();
  });

  it("supports skin with the real volar index pulp and keeps the opposed thumb clear of adjacent fingers", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["palpate", "press", "stretch"] as const) {
        for (const phase of [0, 0.25, 0.5, 0.75, 1]) {
          hand.pose({ pose, grip: phase, phase, intensity: 1 });
          expect(hand.contactAt("index").distanceTo(point(hand, "index_volar_contact")), `${side}/${pose}/${phase} volar surface support`).toBeLessThan(1e-8);
          // The refitted distal tip is a nearby, separately oriented real
          // surface, rather than the old distant world-Y-facing attachment.
          expect(hand.contactAt("index").distanceTo(point(hand, "index_pad_contact")), `${side}/${pose}/${phase} separate needle pad`).toBeGreaterThan(0.0015);
          expect(normal(hand, "index_volar_contact").dot(normal(hand, "index_pad_contact")), `${side}/${pose}/${phase} distinct supporting surface normal`).toBeLessThan(0.95);
          for (const [from, into] of [["thumb", "index"], ["index", "thumb"], ["thumb", "middle"], ["middle", "thumb"], ["index", "middle"], ["middle", "index"]]) {
            expect(distalSkinIntrusion(hand, from!, into!), `${side}/${pose}/${phase}/${from} into ${into}`).toBeLessThan(0.00005);
          }
          const [proximal, middle, distal] = digitSegments(hand, "thumb") as [Vector3, Vector3, Vector3];
          expect(proximal.angleTo(middle) * 180 / Math.PI, `${pose} supporting thumb MCP flexion`).toBeCloseTo(20, 3);
          expect(middle.angleTo(distal) * 180 / Math.PI, `${pose} supporting thumb IP flexion`).toBeCloseTo(20, 3);
          for (const joint of [0, 1, 2] as const) expect(axialJointTwistDegrees(hand, "thumb", joint), `${pose}/${phase} support thumb twist`).toBeLessThanOrEqual(20);
        }
      }
    }
    hand.dispose();
  });

  it("keeps the supporting thumb clear of complete adjacent finger surfaces, including their proximal skin", async () => {
    const hand = await handRig(), digits = ["thumb", "index", "middle", "ring", "little"];
    for (const side of ["left", "right"] as const) for (const pose of ["palpate", "stretch", "press"] as const) for (const phase of [0, 0.5, 1]) {
      hand.setSide(side);
      hand.pose({ pose, grip: phase, phase, intensity: 1 });
      const surfaces = new Map([...digits.map((digit) => `${digit}_skin`), "palm_surface"].map((name) => [name, posedSurface(hand, name)]));
      const palm = surfaces.get("palm_surface")!.tree;
      for (const digit of digits) {
        for (const other of digits.filter((other) => other !== digit && (digit === "thumb" || other === "thumb"))) {
          const external = surfaces.get(`${digit}_skin`)!.points.filter((point) => !insideSurface(point, palm));
          const collision = external.find((point) => insideSurface(point, surfaces.get(`${other}_skin`)!.tree));
          expect(collision?.toArray(), `${side}/${pose}/${phase} complete exposed ${digit} into ${other}`).toBeUndefined();
        }
      }
    }
    hand.dispose();
  });

  it("keeps opposing pads on the actual handle for both hands, either grip, all openings and rolling directions", async () => {
    const hand = await handRig();
    hand.root.position.set(0.27, 0.94, -0.18);
    hand.root.quaternion.setFromAxisAngle(new Vector3(1, 0.2, -0.3).normalize(), 0.71);
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["pinch", "tripod"] as const) {
        for (const apertureMm of [0, 2, 12]) {
          for (const rotationRad of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
            hand.pose({ pose, apertureMm, rotationRad, grip: 1, phase: 0.35, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
            const holdingY = pose === "tripod" ? threeFingerLayout(hand.model).primaryY : 0;
            const thumb = expectSurfaceContact(hand, "thumb_pad_contact", holdingY);
            const index = expectSurfaceContact(hand, "index_pad_contact", holdingY);
            const line = index.clone().sub(thumb);
            expect(Math.abs(line.dot(handleFrame(hand).axis))).toBeLessThan(toleranceM);
            expect(line.length()).toBeCloseTo(2 * needleHandleRadiusAt(holdingY), 5);
            expect(normal(hand, "thumb_pad_contact").dot(normal(hand, "index_pad_contact"))).toBeLessThan(-0.999);
            if (pose === "tripod") expectSurfaceContact(hand, "middle_side_contact", threeFingerLayout(hand.model).middleY);
          }
        }
      }
    }
    hand.dispose();
  });

  it("scrapes with the index free edge against a stable thumb tail brace", async () => {
    const hand = await handRig();
    if (hasRefittedNailRoles(hand)) {
      for (const side of ["left", "right"] as const) for (const wristElevationDeg of [50, 55, 60]) {
        hand.setSide(side); let thumb: Vector3 | undefined;
        const nails: Vector3[] = [];
        for (const phase of [0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
          const sample = sampleTechnique("gua", phase * 2400, { durationMs: 2400, cycles: 1 });
          hand.pose({ pose: "scrape", grip: 1, stabilizerGrip: 1, apertureMm: 12, phase, nailContact: sample.nailContact, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, wristElevationDeg });
          const nextThumb = expectTailBrace(hand), nail = expectSurfaceContact(hand, "index_nail_edge_contact", -0.008 + 0.006 * sample.nailContact);
          if (thumb) expect(nextThumb.distanceTo(thumb), "stable actual tail brace").toBeLessThan(toleranceM);
          thumb = nextThumb; nails.push(nail);
          expect(skinDistance(hand, "index", "index_nail_edge_contact", "nail")).toBeLessThan(0.000005);
          expect(Object.keys(hand.materialContacts()).sort()).toEqual(["index_nail_edge_contact", "thumb_pad_contact"]);
          expect(hand.materialContacts().thumb_pad_contact!.engagedWith).toBe("needle-tail");
          expect(hand.materialContacts().index_nail_edge_contact!.engagedWith).toBe("needle-handle");
          expect(hand.principalContact().distanceTo(new Vector3(0, 0.0125, 0))).toBeLessThan(1e-10);
        }
        expect(Math.max(...nails.map((a) => Math.max(...nails.map((b) => a.distanceTo(b)))))).toBeGreaterThan(0.005);
      }
      hand.dispose(); return;
    }

    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      let thumb: Vector3 | undefined, index: Vector3 | undefined;
      const nails: Vector3[] = [];
      for (const phase of [0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
        const sample = sampleTechnique("gua", phase * 2400, { durationMs: 2400, cycles: 1 });
        hand.pose({ pose: "scrape", grip: 1, stabilizerGrip: 1, apertureMm: 12, phase, nailContact: sample.nailContact, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        const nextThumb = expectSurfaceContact(hand, "thumb_pad_contact", -0.012);
        const nextIndex = expectSurfaceContact(hand, "index_pad_contact", -0.012);
        nails.push(expectSurfaceContact(hand, "middle_nail_edge_contact"));
        if (thumb) expect(nextThumb.distanceTo(thumb)).toBeLessThan(toleranceM);
        if (index) expect(nextIndex.distanceTo(index)).toBeLessThan(toleranceM);
        thumb = nextThumb; index = nextIndex;
      }
      expect(Math.max(...nails.map((a) => Math.max(...nails.map((b) => a.distanceTo(b)))))).toBeGreaterThan(0.005);
    }
    hand.dispose();
  });

  it("prepares thumb-to-index skin contact then flicks and releases the index free edge", async () => {
    const hand = await handRig();
    if (hasRefittedNailRoles(hand)) {
      for (const side of ["left", "right"] as const) for (const wristElevationDeg of [50, 55, 60]) {
        hand.setSide(side);
        for (const phase of [0, 0.08, 0.2, 0.28, 0.5, 0.58, 0.85, 1]) {
          hand.pose({ pose: "flick", grip: 1, stabilizerGrip: 1, phase, handleRadiusM: NEEDLE_HANDLE_RADIUS_M, wristElevationDeg });
          expect(hand.contactValid, `${side}/${wristElevationDeg}/${phase} real index flick`).toBe(true);
          const roles = hand.materialContacts(), thumb = point(hand, "thumb_pad_contact"), index = point(hand, "index_pad_contact"), edge = point(hand, "index_nail_edge_contact");
          expect(Object.keys(roles).sort()).toEqual(["index_nail_edge_contact", "index_pad_contact", "thumb_pad_contact"]);
          expect(skinDistance(hand, "thumb", "thumb_pad_contact")).toBeLessThan(0.000005);
          expect(skinDistance(hand, "index", "index_pad_contact")).toBeLessThan(0.000005);
          expect(skinDistance(hand, "index", "index_nail_edge_contact", "nail")).toBeLessThan(0.000005);
          if ([0, 0.58, 0.85, 1].includes(phase)) {
            expect(thumb.distanceTo(index), `${phase} true skin preparation`).toBeLessThan(toleranceM);
            expect(normal(hand, "thumb_pad_contact").dot(normal(hand, "index_pad_contact"))).toBeLessThan(-0.999);
            expect(roles.thumb_pad_contact!.engaged).toBe(true); expect(roles.index_pad_contact!.engaged).toBe(true);
            expect(roles.thumb_pad_contact!.engagedWith).toBe("index_pad_contact");
            expect(roles.index_pad_contact!.engagedWith).toBe("thumb_pad_contact");
          }
          if (phase === 0.28) {
            expect(edge.distanceTo(hand.root.localToWorld(hand.principalContact())), "actual core impulse contact").toBeLessThan(toleranceM);
            expectSurfaceContact(hand, "index_nail_edge_contact", 0);
            expect(roles.index_nail_edge_contact!.engaged).toBe(true);
            expect(roles.index_nail_edge_contact!.engagedWith).toBe("needle-handle");
          } else expect(roles.index_nail_edge_contact!.engaged).toBe(false);
          if (phase === 0.08 || phase === 0.5) {
            expect(Math.abs(thumb.distanceTo(index) - 0.003), "actual thumb clearance").toBeLessThan(toleranceM);
            const frame = handleFrame(hand), delta = edge.sub(frame.origin), axial = delta.dot(frame.axis);
            expect(delta.addScaledVector(frame.axis, -axial).length() - needleHandleRadiusAt(axial)).toBeGreaterThan(0.0014);
          }
        }
      }
      hand.dispose(); return;
    }

    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      let thumb: Vector3 | undefined, index: Vector3 | undefined;
      for (const phase of [0.1, 0.2, 0.27, 0.5, 0.6, 0.85, 1]) {
        hand.pose({ pose: "flick", grip: 1, stabilizerGrip: 1, apertureMm: 12, phase, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        const nextThumb = expectSurfaceContact(hand, "thumb_pad_contact", -0.012);
        const nextIndex = expectSurfaceContact(hand, "index_pad_contact", -0.012);
        if (thumb) expect(nextThumb.distanceTo(thumb)).toBeLessThan(toleranceM);
        if (index) expect(nextIndex.distanceTo(index)).toBeLessThan(toleranceM);
        thumb = nextThumb; index = nextIndex;
        if (phase < 0.28 || phase === 1) expectSurfaceContact(hand, "middle_nail_edge_contact");
        if (phase === 0.5 || phase === 0.6) {
          const frame = handleFrame(hand), offset = point(hand, "middle_nail_edge_contact").sub(frame.origin);
          const axial = offset.dot(frame.axis);
          expect(offset.addScaledVector(frame.axis, -axial).length()).toBeGreaterThan(needleHandleRadiusAt(axial) + 0.00012);
        }
      }
    }
    hand.dispose();
  });

  it("allows an intentional active-pair release while retaining the third-finger contact", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      let middle: Vector3 | undefined;
      for (const grip of [1, 0.5, 0, 0.5, 1]) {
        hand.pose({ pose: "tripod", grip, stabilizerGrip: 1, apertureMm: 12, phase: 0.4, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        const nextMiddle = expectSurfaceContact(hand, "middle_side_contact", threeFingerLayout(hand.model).middleY);
        if (middle) expect(nextMiddle.distanceTo(middle)).toBeLessThan(toleranceM);
        middle = nextMiddle;
        if (grip === 0) expect(hand.gapMm()).toBeCloseTo(12, 3);
        if (grip === 1) {
          expectSurfaceContact(hand, "thumb_pad_contact", threeFingerLayout(hand.model).primaryY);
          expectSurfaceContact(hand, "index_pad_contact", threeFingerLayout(hand.model).primaryY);
        }
      }
    }
    hand.dispose();
  });

  it("uses only the thumb/index pair for default Fei and keeps unused fingers relaxed and still", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      let unused: Vector3[] | undefined;
      for (const elapsedMs of [350, 1000, 1350, 2000, 2350]) {
        const sample = sampleTechnique("fei", elapsedMs, { durationMs: 3000, cycles: 3, gripApertureMm: 12 });
        expect(sample.handPose).toBe("pinch");
        hand.pose({ pose: sample.handPose, grip: sample.gripEngagement, stabilizerGrip: 1, apertureMm: 12,
          phase: sample.phase.progress * 3 % 1, rotationRad: sample.rotationRad, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        expect(hand.contactValid).toBe(true);
        const points = ["middle", "ring", "little"].flatMap((digit) => ["MCP", "PIP", "DIP"].map((joint) => point(hand, `${digit}_${joint}`)));
        if (unused) points.forEach((p, index) => expect(p.distanceTo(unused![index]!)).toBeLessThan(1e-8));
        unused = points;
        expect(point(hand, "middle_side_contact").distanceTo(hand.contactAt("handle"))).toBeGreaterThan(0.01);
        if (sample.gripEngagement === 1) {
          expectSurfaceContact(hand, "thumb_pad_contact", 0);
          expectSurfaceContact(hand, "index_pad_contact", 0);
        }
        if (sample.gripEngagement === 0) expect(hand.gapMm()).toBeCloseTo(12, 3);
      }
    }
    hand.dispose();
  });

  it("keeps supporting and active middle-finger skin outside both primary gripping fingers", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["pinch", "tripod", "scrape", "flick"] as const) {
        for (const phase of [0, 0.5, 1]) {
          hand.pose({ pose, grip: 1, stabilizerGrip: 1, apertureMm: 12, phase, nailContact: phase, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
          expect(hand.contactValid).toBe(true);
          for (const [from, into] of [["middle", "index"], ["index", "middle"], ["middle", "thumb"], ["thumb", "middle"]]) {
            expect(distalSkinIntrusion(hand, from!, into!), `${side}/${pose}/${phase} ${from} into ${into}`).toBeLessThan(0.00005);
          }
        }
      }
    }
    hand.dispose();
  });

  it("keeps the unused fingers clear of an opened thumb/index pair", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const grip of [0, 0.5, 1]) {
        hand.pose({ pose: "pinch", grip, stabilizerGrip: grip, apertureMm: 12, phase: 0, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        expect(hand.contactValid).toBe(true);
        for (const digit of ["middle", "ring", "little"]) {
          for (const primary of ["thumb", "index"]) {
            expect(distalSkinIntrusion(hand, digit, primary), `${side}/${grip}/${digit} into ${primary}`).toBeLessThan(0.00005);
            expect(distalSkinIntrusion(hand, primary, digit), `${side}/${grip}/${primary} into ${digit}`).toBeLessThan(0.00005);
          }
        }
        for (const surface of ["palm_surface"]) {
          expect(distalSkinIntrusion(hand, "middle", surface), `${side}/${grip} unused middle into ${surface}`).toBeLessThan(0.00005);
        }
      }
    }
    hand.dispose();
  });

  it.each(["pinch", "tripod", "scrape", "flick"] as const)("preserves every phalanx length throughout %s approach, grasp, work, release and retreat", async (pose) => {
    const hand = await handRig();
    const baseline = chainLengths(hand);
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (let elapsedMs = 0; elapsedMs <= 4320; elapsedMs += 90) {
        const envelope = sampleProcedure("work", elapsedMs, 2400);
        hand.pose({ pose, grip: envelope.grip, stabilizerGrip: envelope.grip, apertureMm: 12,
          phase: Math.max(0, (elapsedMs - envelope.operationStartMs) / 2400) % 1,
          rotationRad: Math.sin(elapsedMs / 300), handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
        expect(hand.contactValid, `${side}/${pose}/${elapsedMs} contact solve`).toBe(true);
        for (const [name, value] of chainLengths(hand)) expect(value, `${side}/${pose}/${elapsedMs}/${name}`).toBeCloseTo(baseline.get(name)!, 7);
        hand.root.traverse((object) => expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true));
        if (envelope.grip === 1 && hasRefittedNailRoles(hand) && pose === "scrape") {
          expectTailBrace(hand);
          const phase = Math.max(0, (elapsedMs - envelope.operationStartMs) / 2400) % 1;
          expectSurfaceContact(hand, "index_nail_edge_contact", -0.008 + 0.006 * phase);
        } else if (envelope.grip === 1 && hasRefittedNailRoles(hand) && pose === "flick") {
          expect(skinDistance(hand, "index", "index_nail_edge_contact", "nail")).toBeLessThan(0.000005);
          if (hand.materialContacts().index_nail_edge_contact!.engaged) expectSurfaceContact(hand, "index_nail_edge_contact", 0);
        } else if (envelope.grip === 1) {
          const holdingY = pose === "pinch" ? 0 : pose === "tripod" ? threeFingerLayout(hand.model).primaryY : -0.012;
          expectSurfaceContact(hand, "thumb_pad_contact", holdingY);
          expectSurfaceContact(hand, "index_pad_contact", holdingY);
        }
      }
    }
    hand.dispose();
  });

  it.each(["pinch", "tripod", "scrape", "flick"] as const)("keeps %s interphalangeal bends palmar and avoids twisting a fingertip around its own bone", async (pose) => {
    const hand = await handRig();
    // Broad animation plausibility bounds, not clinical joint-range prescriptions.
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const apertureMm of [0, 2, 12]) {
        for (const phase of [0.1, 0.25, 0.5, 0.75, 0.9]) {
          const sample = sampleTechnique(pose === "scrape" ? "gua" : pose === "flick" ? "tan" : "nian", phase * 2400, { durationMs: 2400, cycles: 1 });
          hand.pose({ pose, grip: 1, stabilizerGrip: 1, apertureMm, phase, nailContact: sample.nailContact, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
          for (const digit of ["index", "middle"]) {
            const context = `${side}/${pose}/${apertureMm}/${phase}/${digit}`;
            const [pip, dip] = fingerFlexion(hand, digit);
            expect(pip, `${context} PIP palmar flexion`).toBeGreaterThanOrEqual(-5);
            expect(pip, `${context} PIP flexion limit`).toBeLessThanOrEqual(115);
            expect(dip, `${context} DIP palmar flexion`).toBeGreaterThanOrEqual(-10);
            expect(dip, `${context} DIP flexion limit`).toBeLessThanOrEqual(95);
            expect(dip, `${context} coupled flexion`).toBeLessThanOrEqual(Math.max(0, pip) * 1.5 + 15);
          }
          for (const digit of ["thumb", "index", "middle"]) {
            for (const joint of [1, 2] as const) expect(axialJointTwistDegrees(hand, digit, joint), `${side}/${pose}/${phase}/${digit}/${joint} axial twist`).toBeLessThanOrEqual(20);
            expect(axialJointTwistDegrees(hand, digit, 0), `${side}/${pose}/${phase}/${digit} CMC/MCP opposition twist`).toBeLessThanOrEqual(digit === "thumb" ? 30 : 20);
          }
        }
      }
    }
    hand.dispose();
  });

  it("changes finger directions continuously through full sampled scraping and flicking cycles", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const technique of ["gua", "tan"] as const) {
        let previous: Map<string, Vector3[]> | undefined;
        for (let frame = 0; frame <= 600; frame++) {
          const sample = sampleTechnique(technique, frame * 4, { durationMs: 2400, cycles: 3 });
          hand.pose({ pose: technique === "gua" ? "scrape" : "flick", grip: 1, stabilizerGrip: 1,
            apertureMm: 12, phase: sample.phase.progress * 3 % 1, nailContact: sample.nailContact, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
          expect(hand.contactValid, `${side}/${technique}/${frame} continuous real contact solve`).toBe(true);
          const current = new Map(["thumb", "index", "middle"].map((digit) => [digit, digitSegments(hand, digit)]));
          if (previous) for (const [digit, directions] of current) {
            for (let segment = 0; segment < 3; segment++) {
              const delta = previous.get(digit)![segment]!.angleTo(directions[segment]!) * 180 / Math.PI;
              expect(delta, `${side}/${technique}/${frame}/${digit}/${segment} frame jump`).toBeLessThan(4);
            }
          }
          previous = current;
        }
      }
    }
    hand.dispose();
  });

  it.each(["pinch", "tripod", "scrape", "flick"] as const)("opens %s naturally before retreat even at zero aperture, without losing the contact solve", async (pose) => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const apertureMm of [0, 2, 12]) {
        let previous: Map<string, Vector3[]> | undefined;
        for (let frame = 0; frame <= 40; frame++) {
          const grip = frame <= 20 ? frame / 20 : (40 - frame) / 20;
          hand.pose({ pose, grip, stabilizerGrip: grip, apertureMm, phase: 0.2, nailContact: 0.5, handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
          expect(hand.contactValid, `${side}/${pose}/${apertureMm}/${grip} solved`).toBe(true);
          const current = new Map(["thumb", "index", "middle"].map((digit) => [digit, digitSegments(hand, digit)]));
          if (previous) for (const [digit, directions] of current) {
            for (let segment = 0; segment < 3; segment++) {
              expect(previous.get(digit)![segment]!.angleTo(directions[segment]!) * 180 / Math.PI,
                `${side}/${pose}/${apertureMm}/${grip}/${digit}/${segment} opening jump`).toBeLessThan(8);
            }
          }
          previous = current;
          for (const digit of ["index", "middle"]) {
            const [pip, dip] = fingerFlexion(hand, digit);
            expect(pip, `${pose}/${grip}/${digit} PIP`).toBeGreaterThanOrEqual(-5);
            expect(pip, `${pose}/${grip}/${digit} PIP`).toBeLessThanOrEqual(115);
            expect(dip, `${pose}/${grip}/${digit} DIP`).toBeGreaterThanOrEqual(-10);
            expect(dip, `${pose}/${grip}/${digit} DIP`).toBeLessThanOrEqual(95);
          }
          for (const digit of ["thumb", "index", "middle"]) {
            expect(axialJointTwistDegrees(hand, digit, 0), `${pose}/${grip}/${digit} released opposition twist`).toBeLessThanOrEqual(digit === "thumb" ? 30 : 20);
            for (const joint of [1, 2] as const) expect(axialJointTwistDegrees(hand, digit, joint), `${pose}/${grip}/${digit} released hinge twist`).toBeLessThanOrEqual(20);
          }
          if (grip === 0 && hasRefittedNailRoles(hand) && pose === "scrape") {
            const { origin, axis } = handleFrame(hand), tail = origin.clone().addScaledVector(axis, 0.0125);
            expect(Math.abs(point(hand, "thumb_pad_contact").sub(tail).dot(axis) - 0.0015), "actual tail-brace release").toBeLessThan(toleranceM);
            expect(skinDistance(hand, "thumb", "thumb_pad_contact", "skin", tail), "entire thumb skin clear of tail").toBeGreaterThan(0.0015);
            const edge = point(hand, "index_nail_edge_contact").sub(origin), axial = edge.dot(axis), gap = edge.addScaledVector(axis, -axial).length() - needleHandleRadiusAt(axial);
            expect(Math.abs(gap - Math.max(1.5, apertureMm) / 1000), "actual working-index aperture").toBeLessThan(toleranceM);
          } else if (grip === 0 && hasRefittedNailRoles(hand) && pose === "flick") {
            expect(Math.abs(point(hand, "thumb_pad_contact").distanceTo(point(hand, "index_pad_contact")) - 0.003), "released Tan skin pair").toBeLessThan(toleranceM);
            const { origin, axis } = handleFrame(hand), edge = point(hand, "index_nail_edge_contact").sub(origin), axial = edge.dot(axis);
            expect(edge.addScaledVector(axis, -axial).length() - needleHandleRadiusAt(axial), "released actual keratin edge").toBeGreaterThan(0.0014);
          } else if (grip === 0) {
            const { origin, axis } = handleFrame(hand);
            const offset = point(hand, "thumb_pad_contact").sub(origin), axial = offset.dot(axis);
            expect(offset.addScaledVector(axis, -axial).length() - needleHandleRadiusAt(axial), `${pose}/${apertureMm} release clearance`).toBeGreaterThan(0.0014);
          }
        }
      }
    }
    hand.dispose();
  });
});
