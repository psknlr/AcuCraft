import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationMixer, BufferAttribute, BufferGeometry, DoubleSide, LoopOnce, Mesh, MeshBasicMaterial, Object3D, Quaternion, Raycaster, SkinnedMesh, Triangle, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand } from "../../packages/server/web/stage/hand.js";
import { needleHandleRadiusAt } from "../../packages/server/web/stage/needle-shape.js";
import { parseGlb } from "@clinicalcraft/core";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const candidate = process.env.ACUCRAFT_HAND_ASSET_FIXTURE;
const bytes = readFileSync(candidate ?? here("../../content/world/assets/models/acu-practitioner-hand.glb"));
const manifest = JSON.parse(readFileSync(candidate ? candidate.replace(/\.glb$/, ".json") : here("./hand.json"), "utf8")) as {
  sha256: string;
  bytes: number;
  triangles: number;
  license: string;
  wrist: number[];
  tips: Record<string, number[]>;
  animations: string[];
  baselineElevationDeg: number;
  palm: { surface: string; topology: string };
  rollingPatches: Record<string, { samples: { node: string; offsetMm: number }[] }>;
  anatomicalJoints: Record<string, string[]>;
  anatomicalMapping: Record<string, string>;
  contactAnchors: Record<string, { follows: string; normalAxis: string; surface?: string; feature?: string }>;
  poseContacts: Record<string, Record<string, number[]>>;
};

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
      const radial = new Vector3(0, 0, mirror), index = point("index_MCP"), cmc = point("thumb_CMC");
      for (const [a, b] of [["index", "middle"], ["middle", "ring"], ["ring", "little"]])
        expect(point(`${a}_MCP`).sub(point(`${b}_MCP`)).dot(radial)).toBeGreaterThan(0.015);
      expect(cmc.clone().sub(index).dot(radial)).toBeGreaterThan(0.001);
      expect(inside(palm, cmc)).toBe(true);
      const wrist = point("wrist"), elevation = Math.atan2(wrist.y, wrist.x) * 180 / Math.PI;
      expect(elevation).toBeGreaterThan(50); expect(elevation).toBeLessThan(60);
      expect(elevation).toBeCloseTo(manifest.baselineElevationDeg, 5);
      const exposedThumb = point("thumb_MCP").distanceTo(point("thumb_IP")) + point("thumb_IP").distanceTo(point("thumb_tip"));
      const exposedIndex = index.distanceTo(point("index_PIP")) + point("index_PIP").distanceTo(point("index_DIP")) + point("index_DIP").distanceTo(point("index_tip"));
      expect(exposedThumb).toBeGreaterThan(0.050); expect(exposedThumb).toBeLessThan(0.056);
      expect(exposedIndex).toBeGreaterThan(0.075); expect(exposedIndex).toBeLessThan(0.088);
      expect(exposedThumb / exposedIndex).toBeLessThan(0.70);
      expect(point("index_tip").x - point("thumb_tip").x).toBeGreaterThan(0.007);
      const a = point("index_PIP").sub(index), b = point("index_DIP").sub(point("index_PIP")), c = point("index_tip").sub(point("index_DIP"));
      expect(a.angleTo(b) * 180 / Math.PI).toBeGreaterThan(55);
      expect(a.angleTo(b) * 180 / Math.PI).toBeLessThan(75);
      expect(b.angleTo(c) * 180 / Math.PI).toBeGreaterThan(25);
      expect(b.angleTo(c) * 180 / Math.PI).toBeLessThan(40);
    }
  });

  it("buries the entire CMC cap and proximal metacarpal surface inside the real deformed palm", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene; rig.updateMatrixWorld(true);
    const skin = rig.getObjectByName("thumb_skin") as SkinnedMesh, palm = rig.getObjectByName("palm_surface") as SkinnedMesh;
    const cmc = rig.getObjectByName("thumb_CMC")!.getWorldPosition(new Vector3());
    const mcp = rig.getObjectByName("thumb_MCP")!.getWorldPosition(new Vector3()), axis = mcp.clone().sub(cmc).normalize(), length = cmc.distanceTo(mcp);
    const positions = skin.geometry.getAttribute("position"), cap: number[] = [], buried: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      const along = new Vector3().fromBufferAttribute(positions, i).sub(cmc).dot(axis);
      if (Math.abs(along) < 0.0001) cap.push(i);
      if (along > -0.0001 && along < length * 0.701) buried.push(i);
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
    for (const [grip, gripStyle, rotationRad] of [[1, "tip-pinch", 0], [0, "tip-pinch", 0], [1, "side-pinch", 0], [1, "tip-pinch", 1.4], [1, "tip-pinch", -1.4]] as const) {
      hand.pose({ pose: "pinch", grip, gripStyle, rotationRad, phase: 0.35, apertureMm: 12, handleRadiusM: 0.0007, wristElevationDeg: 55 });
      hand.model.updateMatrixWorld(true); skin.skeleton.update(); palm.skeleton.update(); palm.computeBoundingBox(); palm.computeBoundingSphere();
      for (const vertex of buried) {
        const point = skin.localToWorld(skin.getVertexPosition(vertex, new Vector3()));
        expect(inside(palm, point), `grip=${grip}/${gripStyle}/${rotationRad} vertex ${vertex}${cap.includes(vertex) ? " CMC cap" : " proximal metacarpal"}`).toBe(true);
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
    const positions = skin.geometry.getAttribute("position"), indices = skin.geometry.index!;
    const unique = new Map<string, number>(), welded: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      const key = [positions.getX(i), positions.getY(i), positions.getZ(i)].map((n) => n.toFixed(7)).join(",");
      if (!unique.has(key)) unique.set(key, unique.size);
      welded.push(unique.get(key)!);
    }
    const edges = new Map<string, number[]>();
    for (let i = 0; i < indices.count; i += 3) {
      const row = [welded[indices.getX(i)]!, welded[indices.getX(i + 1)]!, welded[indices.getX(i + 2)]!];
      expect(new Set(row).size).toBe(3);
      for (const [a, b] of [[row[0]!, row[1]!], [row[1]!, row[2]!], [row[2]!, row[0]!]]) {
        const key = `${Math.min(a, b)},${Math.max(a, b)}`;
        const faces = edges.get(key) ?? []; faces.push(i / 3); edges.set(key, faces);
      }
    }
    for (const faces of edges.values()) expect(faces).toHaveLength(2);
    const mixer = new AnimationMixer(rig), triangle = new Triangle();
    for (const clip of gltf.animations) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).setLoop(LoopOnce, 1); action.clampWhenFinished = true;
      for (const t of [0, 0.5, 1]) {
        action.reset().play(); mixer.setTime(t); rig.updateMatrixWorld(true); skin.skeleton.update();
        const vertices = Array.from({ length: positions.count }, (_, i) => skin.localToWorld(skin.getVertexPosition(i, new Vector3()))), normals: Vector3[] = [];
        for (let i = 0; i < indices.count; i += 3) {
          triangle.set(vertices[indices.getX(i)]!, vertices[indices.getX(i + 1)]!, vertices[indices.getX(i + 2)]!);
          expect(triangle.getArea(), `${clip.name}/${t} non-degenerate palm face`).toBeGreaterThan(1e-10);
          normals.push(triangle.getNormal(new Vector3()));
        }
        for (const [a, b] of edges.values()) expect(normals[a!]!.dot(normals[b!]!), `${clip.name}/${t} continuous palm fold`).toBeGreaterThan(-0.1);
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(rig);
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
    expect(manifest.contactAnchors.index_volar_contact).toMatchObject({ follows: "index_distal", surface: "index_skin", feature: "volar-tip" });
    const normal = new Vector3(0, 1, 0).applyQuaternion(contact.getWorldQuaternion(new Quaternion())).normalize();
    expect(Math.abs(normal.x)).toBeLessThan(0.25);
    expect(normal.y).toBeLessThan(-0.85);
    const point = contact.getWorldPosition(new Vector3());
    expect(point.distanceTo(rig.getObjectByName("index_pad_contact")!.getWorldPosition(new Vector3()))).toBeGreaterThan(0.005);
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
    expect(side.quaternion.angleTo(bearing.quaternion)).toBeLessThan(1e-7);
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
      if (digit === "thumb") expect(nail.z * sign).toBeGreaterThan(0.01);
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
        expect(signed, `${digit} joint ${i} natural rest flexion`).toBeLessThan((digit === "index" ? 80 : 60) * Math.PI / 180);
      }
    }
  });

  it("keeps unused fingers naturally curled while releasing the active thumb/index pair", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, mixer = new AnimationMixer(rig);
    const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === "hand_open")!).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    for (let frame = 0; frame <= 20; frame++) {
      action.reset().play(); mixer.setTime(frame / 20); rig.updateMatrixWorld(true);
      for (const digit of ["middle", "ring", "little"]) {
        const nodes = ["proximal", "middle", "distal", "tip"].map((name) => rig.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3()));
        const bones = [nodes[1]!.clone().sub(nodes[0]!), nodes[2]!.clone().sub(nodes[1]!), nodes[3]!.clone().sub(nodes[2]!)];
        const hinge = new Vector3(0, 0, 1).applyQuaternion(rig.getObjectByName(`${digit}_proximal`)!.getWorldQuaternion(new Quaternion()));
        for (let joint = 0; joint < 2; joint++) {
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

  it("keeps the thumb and index as the stable primary hold during optional middle support and nail work", async () => {
    for (const clipName of ["hand_three_finger", "hand_scrape", "hand_flick"]) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene, mixer = new AnimationMixer(rig);
      const point = (name: string) => rig.getObjectByName(name)!.getWorldPosition(new Vector3());
      const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === clipName)!).setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      const edges: Vector3[] = [];
      let unused: Quaternion[] | undefined;
      for (let frame = 0; frame <= 30; frame++) {
        action.reset().play(); mixer.setTime(frame / 30); rig.updateMatrixWorld(true);
        for (const [digit, sign] of [["thumb", -1], ["index", 1]] as const) {
          expect(point(`${digit}_pad_contact`).distanceTo(new Vector3(0, -0.012, sign * 0.0006808)), `${clipName} ${digit}/${frame}`).toBeLessThan(0.00001);
        }
        const nextUnused = ["ring", "little"].flatMap((digit) => ["proximal", "middle", "distal"].map((joint) => rig.getObjectByName(`${digit}_${joint}`)!.quaternion.clone().normalize()));
        if (unused) nextUnused.forEach((q, i) => expect(q.angleTo(unused![i]!)).toBeLessThan(0.00001));
        unused = nextUnused;
        const edge = point(clipName === "hand_three_finger" ? "middle_side_contact" : "middle_nail_edge_contact");
        if (clipName !== "hand_flick") expect(Math.abs(Math.hypot(edge.x, edge.z) - needleHandleRadiusAt(edge.y))).toBeLessThan(0.000025);
        if (frame % 5 === 0) for (const [from, into] of [["middle", "thumb"], ["thumb", "middle"], ["middle", "index"], ["index", "middle"]]) {
          expect(distalSkinIntrusion(rig, from!, into!), `${clipName} frame ${frame} ${from} into ${into}`).toBeLessThan(0.00005);
        }
        if (frame % 5 === 0) for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
          const skin = rig.getObjectByName(`${digit}_skin`) as SkinnedMesh;
          skin.skeleton.update();
          for (let vertex = 0; vertex < skin.geometry.getAttribute("position").count; vertex++) {
            const point = skin.localToWorld(skin.getVertexPosition(vertex, new Vector3()));
            if (Math.abs(point.y) > 0.0125) continue;
            expect(needleHandleRadiusAt(point.y) - Math.hypot(point.x, point.z), `${clipName}/${frame} actual ${digit} skin vertex ${vertex} inside handle`).toBeLessThan(0.00005);
          }
        }
        edges.push(edge);
      }
      expect(edges[0]!.y).toBeCloseTo(clipName === "hand_three_finger" ? 0.010 : 0.006, 5);
      if (clipName === "hand_scrape") expect(edges[30]!.y - edges[0]!.y).toBeCloseTo(0.006, 5);
      else if (clipName === "hand_flick") {
        expect(Math.max(...edges.map((edge) => Math.hypot(edge.x, edge.z) - needleHandleRadiusAt(edge.y)))).toBeGreaterThan(0.00012);
        expect(edges[30]!.distanceTo(edges[0]!)).toBeLessThan(0.00001);
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
      expect(clip.tracks.length, clipName).toBeLessThanOrEqual(17);
      for (const track of clip.tracks) if (track.name.endsWith(".position")) expect(track.name).toBe("hand_pose_frame.position");
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
    expect(tripod[1]).toBeCloseTo(0.010, 5);
    expect(Math.hypot(tripod[0]!, tripod[2]!)).toBeCloseTo(needleHandleRadiusAt(tripod[1]!), 5);
    const nail = manifest.poseContacts.scrape!.middle_nail_edge_contact!;
    expect(nail[1]).toBeCloseTo(0.012, 5);
    expect(Math.hypot(nail[0]!, nail[2]!)).toBeCloseTo(needleHandleRadiusAt(nail[1]!), 5);
  });
});
