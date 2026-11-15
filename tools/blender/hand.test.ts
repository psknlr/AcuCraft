import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnimationMixer, LoopOnce, Mesh, Quaternion, Raycaster, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
    expect(info.counts.triangles).toBeLessThan(5_000);
    expect(info.counts.animations).toBe(5);
    expect(bytes.length).toBeLessThan(160_000);
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
    expect(thumb.clone().add(index).length()).toBeCloseTo(0, 7);
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
    expect(thumb.distanceTo(index)).toBeCloseTo(0.002, 6);
    // The anatomical parent can add motion without overwriting the legacy clip's local rotation.
    const tip = rig.getObjectByName("index_pad_contact")!;
    const before = tip.getWorldPosition(new Vector3());
    rig.getObjectByName("index_PIP")!.rotateZ(0.2);
    rig.updateMatrixWorld(true);
    expect(tip.getWorldPosition(new Vector3()).distanceTo(before)).toBeGreaterThan(0.004);
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
      }
      mixer.stopAllAction();
      mixer.uncacheRoot(rig);
    }
    expect([...names].sort()).toEqual([...manifest.animations].sort());
    const tripod = manifest.poseContacts.three_finger!.middle_pad_contact!;
    expect(new Vector3(...tripod as [number, number, number]).distanceTo(new Vector3(0, -0.010, 0.001))).toBeLessThan(0.00001);
    const nail = manifest.poseContacts.scrape!.index_nail_contact!;
    expect(new Vector3(...nail as [number, number, number]).distanceTo(new Vector3(0.012, 0.005, 0.001))).toBeLessThan(0.00001);
  });
});
