import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationMixer, LoopOnce, Mesh, Quaternion, Raycaster, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import { parseGlb } from "@clinicalcraft/core";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const bytes = readFileSync(here("../../content/world/assets/models/acu-practitioner-hand.glb"));
const manifest = JSON.parse(readFileSync(here("./hand.json"), "utf8")) as {
  sha256: string;
  bytes: number;
  triangles: number;
  license: string;
  wrist: number[];
  tips: Record<string, number[]>;
  animations: string[];
  anatomicalJoints: Record<string, string[]>;
  anatomicalMapping: Record<string, string>;
  contactAnchors: Record<string, { follows: string; normalAxis: string; surface?: string }>;
  poseContacts: Record<string, Record<string, number[]>>;
};

describe("the Blender precision hand", () => {
  it("is the licensed, pinned model within the real-time triangle budget", () => {
    const info = parseGlb(new Uint8Array(bytes));
    expect(manifest.license).toBe("CC0-1.0");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
    expect(bytes.length).toBe(manifest.bytes);
    expect(info.counts.triangles).toBe(manifest.triangles);
    expect(info.counts.triangles).toBeLessThan(10_000);
    expect(info.counts.animations).toBe(5);
    expect(bytes.length).toBeLessThan(300_000);
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
    expect(thumb.clone().add(index).multiplyScalar(0.5).distanceTo(new Vector3(-0.004, 0, 0))).toBeLessThan(1e-7);
    const clip = gltf.animations.find((a) => a.name === "hand_open");
    expect(clip).toBeDefined();
    expect(clip!.tracks).toHaveLength(15);
    expect(clip!.duration).toBeCloseTo(1, 5);
    const mixer = new AnimationMixer(rig);
    const action = mixer.clipAction(clip!).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(0.95);
    rig.updateMatrixWorld(true);
    expect(point("thumb_tip").distanceTo(thumb)).toBeGreaterThan(0.01);
    expect(point("index_tip").distanceTo(index)).toBeGreaterThan(0.01);
    mixer.setTime(0);
    rig.updateMatrixWorld(true);
    expect(point("thumb_tip").distanceTo(thumb)).toBeLessThan(1e-7);
    expect(point("index_tip").distanceTo(index)).toBeLessThan(1e-7);
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
        expect(hits[0]!.point.distanceTo(point), name).toBeLessThan(0.00005);
      }
    }
    const thumb = rig.getObjectByName("thumb_pad_contact")!.getWorldPosition(new Vector3());
    const index = rig.getObjectByName("index_pad_contact")!.getWorldPosition(new Vector3());
    expect(thumb.distanceTo(index)).toBeCloseTo(0.0014, 6);
    const side = rig.getObjectByName("middle_side_contact")!;
    expect(side.parent?.name).toBe("middle_distal");
    expect(side.getWorldPosition(new Vector3()).z).toBeCloseTo(0.0006904, 7);
    expect(new Vector3(0, 1, 0).applyQuaternion(side.getWorldQuaternion(new Quaternion())).dot(new Vector3(0, 0, -1))).toBeCloseTo(1, 7);
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
      const dorsal = digit === "thumb" ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
      dorsal.addScaledVector(axis, -dorsal.dot(axis)).normalize();
      expect(nailNormal.dot(dorsal), `${digit} anatomical nail dorsal`).toBeGreaterThan(0.99);
      const distal = rig.getObjectByName(`${digit}_distal`)!.getWorldPosition(new Vector3());
      const length = rig.getObjectByName(`${digit}_tip`)!.getWorldPosition(new Vector3()).distanceTo(distal);
      const fraction = nail.clone().sub(distal).dot(axis) / length;
      expect(fraction, `${digit} distal nail edge`).toBeGreaterThan(0.90);
      expect(fraction, `${digit} distal nail edge`).toBeLessThan(0.97);
      if (digit === "thumb") expect(nail.z * sign).toBeGreaterThan(0.01);
      else expect(nail.y).toBeGreaterThan(0.001);
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
        const towardPalm = new Vector3(0, -1, 0);
        const hinge = bones[i]!.clone().cross(towardPalm).normalize();
        const signed = Math.atan2(bones[i]!.clone().cross(bones[i + 1]!).dot(hinge), bones[i]!.dot(bones[i + 1]!));
        expect(signed, `${digit} joint ${i} flexes toward palm`).toBeGreaterThan(0);
        expect(signed, `${digit} joint ${i} natural rest flexion`).toBeLessThan(Math.PI / 3);
      }
    }
  });

  it("releases idle fingers through natural palmar hinges without reversing their PIP or DIP joints", async () => {
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const rig = gltf.scene, mixer = new AnimationMixer(rig);
    const action = mixer.clipAction(gltf.animations.find((clip) => clip.name === "hand_open")!).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    for (let frame = 0; frame <= 20; frame++) {
      action.reset().play(); mixer.setTime(frame / 20); rig.updateMatrixWorld(true);
      for (const digit of ["middle", "ring", "little"]) {
        const nodes = ["proximal", "middle", "distal", "tip"].map((name) => rig.getObjectByName(`${digit}_${name}`)!.getWorldPosition(new Vector3()));
        const bones = [nodes[1]!.clone().sub(nodes[0]!), nodes[2]!.clone().sub(nodes[1]!), nodes[3]!.clone().sub(nodes[2]!)];
        for (let joint = 0; joint < 2; joint++) {
          const angle = Math.atan2(bones[joint]!.clone().cross(bones[joint + 1]!).z, bones[joint]!.dot(bones[joint + 1]!));
          expect(angle, `${digit} joint ${joint} frame ${frame}`).toBeGreaterThan(0);
          if (frame === 20) expect(angle * 180 / Math.PI).toBeCloseTo(joint === 0 ? 10 : 7, 3);
        }
      }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(rig);
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
      expect(skin.skeleton.bones).toHaveLength(15);
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
      ["hand_flick", 0.4, "flick_loaded"], ["hand_flick", 16 / 30, "flick_release"],
      ["hand_flick", 1, "pinch"],
    ];
    const names = new Set<string>();
    for (const [clipName, time, poseName] of cases) {
      const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
      const rig = gltf.scene;
      const clip = gltf.animations.find((a) => a.name === clipName)!;
      names.add(clipName);
      expect(clip.duration, clipName).toBeCloseTo(1, 5);
      // Blender omits unchanged neutral channels (the tripod moves the middle finger only).
      expect(clip.tracks.length, clipName).toBeGreaterThanOrEqual(3);
      expect(clip.tracks.length, clipName).toBeLessThanOrEqual(15);
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
          const normal = new Vector3(0, 1, 0).applyQuaternion(rig.getObjectByName(name)!.getWorldQuaternion(new Quaternion())).normalize();
          const hits = new Raycaster(point.clone().addScaledVector(normal, 0.002), normal.negate(), 0, 0.004).intersectObject(surface, false);
          expect(hits.length, `${clipName}/${name} real posed skin`).toBeGreaterThan(0);
          expect(hits[0]!.point.distanceTo(point), `${clipName}/${name} real posed skin`).toBeLessThan(0.00005);
        }
      }
      mixer.stopAllAction();
      mixer.uncacheRoot(rig);
    }
    expect([...names].sort()).toEqual([...manifest.animations].sort());
    const tripod = manifest.poseContacts.three_finger!.middle_side_contact!;
    expect(new Vector3(...tripod as [number, number, number]).distanceTo(new Vector3(0, -0.006, 0.0006904))).toBeLessThan(0.00001);
    const nail = manifest.poseContacts.scrape!.index_nail_contact!;
    expect(new Vector3(...nail as [number, number, number]).distanceTo(new Vector3(0.012, 0.005, 0.001))).toBeLessThan(0.00001);
  });
});
