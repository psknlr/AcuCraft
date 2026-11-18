import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bone, Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, SphereGeometry, Uint16BufferAttribute, Vector3, type BufferAttribute } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Person } from "../web/stage/cast.js";
import { PatientClearance } from "../web/stage/clearance.js";
import { ArticulatedHand } from "../web/stage/hand.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function geometry<T extends BufferGeometry>(value: T): T {
  cleanups.push(() => value.dispose());
  return value;
}

function mesh(shape: BufferGeometry): Mesh {
  const material = new MeshBasicMaterial();
  cleanups.push(() => material.dispose());
  return new Mesh(geometry(shape), material);
}

function patient(body: Mesh): Person {
  const holder = new Group();
  holder.add(body);
  return { holder, rig: { skin: [{ mesh: body }] } } as unknown as Person;
}

function probe(size = 0.05) {
  const model = new Group(), surface = mesh(new BoxGeometry(size, size, size));
  model.add(surface);
  return { model, surface };
}

describe("actual patient surface clearance", () => {
  it("does not reject intersecting bounding boxes when every hand point is outside the real closed surface", () => {
    const body = mesh(new SphereGeometry(1, 32, 24)), subject = patient(body);
    const { model, surface } = probe();
    surface.position.set(0.8, 0.8, 0);
    const guard = new PatientClearance();
    expect(new Box3().setFromObject(model).intersectsBox(new Box3().setFromObject(subject.holder))).toBe(true);
    expect(guard.intersects(model, subject)).toBe(false);
    surface.position.set(0.6, 0.6, 0);
    expect(guard.intersects(model, subject)).toBe(true);
  });

  it("allows true surface contact but detects a small, real penetration", () => {
    const subject = patient(mesh(new BoxGeometry(2, 2, 2)));
    const { model, surface } = probe(0.002), guard = new PatientClearance();
    surface.position.y = 1.001;
    expect(guard.intersects(model, subject)).toBe(false);
    surface.position.y -= 0.0002;
    expect(guard.intersects(model, subject)).toBe(true);
    surface.position.y = 1.01;
    expect(guard.intersects(model, subject)).toBe(false);
  });

  it("invalidates a cached result when the patient's whole group moves", () => {
    const subject = patient(mesh(new BoxGeometry(2, 2, 2)));
    const { model, surface } = probe(), guard = new PatientClearance();
    surface.position.x = 0.6;
    expect(guard.intersects(model, subject)).toBe(true);
    subject.holder.position.set(3, 1, -2);
    subject.holder.quaternion.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.6);
    expect(guard.intersects(model, subject)).toBe(false);
    subject.holder.position.set(0, 0, 0); subject.holder.quaternion.identity();
    expect(guard.intersects(model, subject)).toBe(true);
  });

  it("detects equal-thickness crossing solids whose vertices and face intersections lie on shared boundaries", () => {
    const subject = patient(mesh(new BoxGeometry(0.02, 0.2, 0.02)));
    const model = new Group(); model.add(mesh(new BoxGeometry(0.2, 0.02, 0.02)));
    const guard = new PatientClearance();
    expect(guard.intersects(model, subject)).toBe(true);
    subject.holder.position.x = 0.11;
    expect(guard.intersects(model, subject)).toBe(false);
    subject.holder.position.x -= 0.0002;
    expect(guard.intersects(model, subject)).toBe(true);
  });

  it("uses both real skin charts as one volume at a shared-edge patient crossing", () => {
    const subject = patient(mesh(new BoxGeometry(0.02, 0.2, 0.02))), model = new Group();
    const source = geometry(new BoxGeometry(0.2, 0.02, 0.02)), indices = Array.from(source.index!.array);
    for (const [index, name] of ["palm_surface", "thumb_skin"].entries()) {
      // Separate the two crossing Y faces from the rest of the closed surface.
      const chart = source.clone(); chart.setIndex(index ? [...indices.slice(0, 12), ...indices.slice(24)] : indices.slice(12, 24));
      const part = mesh(chart); part.name = name;
      part.userData.skinUnion = { schema: "acucraft.skin-union@1", id: "thumb-palm", individualClosed: false, parts: ["palm_surface", "thumb_skin"] };
      model.add(part);
    }
    const guard = new PatientClearance();
    expect(guard.intersects(model, subject)).toBe(true);
    subject.holder.position.x = 0.11;
    expect(guard.intersects(model, subject)).toBe(false);
    subject.holder.position.x -= 0.0002;
    expect(guard.intersects(model, subject)).toBe(true);
    model.scale.z = -1; model.rotation.x = Math.PI;
    expect(guard.intersects(model, subject)).toBe(true);
  });

  it("rebuilds the patient surface after position data changes in the same attribute", () => {
    const body = mesh(new BoxGeometry(2, 2, 2)), subject = patient(body);
    const { model, surface } = probe(), guard = new PatientClearance();
    surface.position.x = 0.6;
    expect(guard.intersects(model, subject)).toBe(true);
    const positions = body.geometry.getAttribute("position"), original = Array.from(positions.array);
    for (let i = 0; i < positions.count; i++) positions.setXYZ(i, positions.getX(i) * 0.1, positions.getY(i) * 0.1, positions.getZ(i) * 0.1);
    positions.needsUpdate = true;
    expect(guard.intersects(model, subject)).toBe(false);
    positions.array.set(original); positions.needsUpdate = true;
    expect(guard.intersects(model, subject)).toBe(true);
  });

  it.each(["geometry", "position attribute"] as const)("rebuilds after replacing patient %s even when both revision counters are zero", (replacement) => {
    const body = mesh(new BoxGeometry(2, 2, 2)), subject = patient(body);
    const { model, surface } = probe(), guard = new PatientClearance();
    surface.position.x = 0.6;
    expect(guard.intersects(model, subject)).toBe(true);
    const smaller = geometry(new BoxGeometry(0.2, 0.2, 0.2));
    expect((body.geometry.getAttribute("position") as BufferAttribute).version).toBe((smaller.getAttribute("position") as BufferAttribute).version);
    if (replacement === "geometry") body.geometry = smaller;
    else body.geometry.setAttribute("position", smaller.getAttribute("position").clone());
    expect(guard.intersects(model, subject)).toBe(false);
  });

  it("uses changed index data rather than an obsolete closed patient surface", () => {
    const first = geometry(new BoxGeometry(2, 2, 2)), second = geometry(new BoxGeometry(2, 2, 2));
    second.translate(4, 0, 0);
    const combined = new BufferGeometry();
    const firstPositions = first.getAttribute("position"), secondPositions = second.getAttribute("position");
    combined.setAttribute("position", new Float32BufferAttribute([...firstPositions.array, ...secondPositions.array], 3));
    combined.setIndex(Array.from(first.index!.array));
    const subject = patient(mesh(combined));
    const { model, surface } = probe(), guard = new PatientClearance();
    surface.position.x = 0.6;
    expect(guard.intersects(model, subject)).toBe(true);
    for (let i = 0; i < combined.index!.count; i++) combined.index!.setX(i, first.index!.getX(i) + firstPositions.count);
    combined.index!.needsUpdate = true;
    expect(guard.intersects(model, subject)).toBe(false);
  });

  it("refreshes hand points when geometry changes, including a replacement with a different vertex count", () => {
    const subject = patient(mesh(new BoxGeometry(2, 2, 2)));
    const { model, surface } = probe(), guard = new PatientClearance();
    surface.position.x = 0.6;
    expect(guard.intersects(model, subject)).toBe(true);
    surface.geometry.translate(3, 0, 0);
    expect(guard.intersects(model, subject)).toBe(false);
    surface.geometry = geometry(new SphereGeometry(0.03, 12, 8));
    expect(guard.intersects(model, subject)).toBe(true);
    surface.geometry.translate(3, 0, 0);
    expect(guard.intersects(model, subject)).toBe(false);
  });

  it("refreshes clearance for morph-only skin changes while the mesh and bones stay fixed", () => {
    const subject = patient(mesh(new BoxGeometry(2, 2, 2))), model = new Group(), bone = new Bone();
    const shape = geometry(new BoxGeometry(0.01, 0.01, 0.01)); shape.translate(1.02, 0, 0);
    const count = shape.getAttribute("position").count;
    shape.setAttribute("skinIndex", new Uint16BufferAttribute(Array(count * 4).fill(0), 4));
    shape.setAttribute("skinWeight", new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    const target = (x: number) => new Float32BufferAttribute(Array.from({ length: count }, () => [x, 0, 0]).flat(), 3);
    shape.morphTargetsRelative = true; shape.morphAttributes.position = [target(-0.04)];
    const surface = new SkinnedMesh(shape), guard = new PatientClearance();
    cleanups.push(() => { for (const material of Array.isArray(surface.material) ? surface.material : [surface.material]) material.dispose(); surface.skeleton.dispose(); });
    model.add(bone, surface); model.updateMatrixWorld(true); surface.bind(new Skeleton([bone]));
    const fixedBone = bone.matrixWorld.clone(), fixedMesh = surface.matrixWorld.clone();
    surface.morphTargetInfluences![0] = 0;
    expect(guard.intersects(model, subject)).toBe(false);
    surface.morphTargetInfluences![0] = 1;
    expect(guard.intersects(model, subject)).toBe(true);
    surface.morphTargetInfluences![0] = 0;
    expect(guard.intersects(model, subject)).toBe(false);
    surface.morphTargetInfluences![0] = 1;
    expect(guard.intersects(model, subject)).toBe(true);
    const first = shape.morphAttributes.position[0]!;
    for (let i = 0; i < count; i++) first.setX(i, 0.04);
    first.needsUpdate = true;
    expect(guard.intersects(model, subject)).toBe(false);
    // Replacing a target with the same version must also invalidate cached points.
    shape.morphAttributes.position = [target(0.04)];
    expect(guard.intersects(model, subject)).toBe(false);
    shape.morphAttributes.position = [target(-0.04)];
    expect(guard.intersects(model, subject)).toBe(true);
    expect(bone.matrixWorld.equals(fixedBone)).toBe(true);
    expect(surface.matrixWorld.equals(fixedMesh)).toBe(true);
  });

  it("keeps the actual skinned hand in the same space as its contacts after group and wrist transforms", async () => {
    const bytes = readFileSync(fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
    const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
    const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
    cleanups.push(() => hand.dispose());
    const world = new Group(); world.add(hand.root);
    hand.pose({ pose: "pinch", grip: 1, stabilizerGrip: 1, phase: 0.4, handleRadiusM: 0.0007 });
    expect(hand.contactValid).toBe(true);
    const body = mesh(new BoxGeometry(0.001, 0.001, 0.001)), subject = patient(body), guard = new PatientClearance();
    body.position.copy(hand.contactAt("index"));
    expect(guard.intersects(hand.model, subject)).toBe(true);
    // Contact queries update the bone/world matrices without manually refreshing
    // SkinnedMesh.bindMatrixInverse. The guard must support candidate wrist poses.
    world.position.set(1.7, 2.1, -0.8);
    world.quaternion.setFromAxisAngle(new Vector3(1, 0.3, 0.2).normalize(), 0.7);
    hand.root.quaternion.setFromAxisAngle(new Vector3(0.2, 1, -0.1).normalize(), 0.4);
    expect(guard.intersects(hand.model, subject)).toBe(false);
    body.position.copy(hand.contactAt("index"));
    expect(guard.intersects(hand.model, subject)).toBe(true);
    hand.root.position.set(0.3, 0.1, -0.2);
    hand.root.rotateX(0.63);
    expect(guard.intersects(hand.model, subject)).toBe(false);
    body.position.copy(hand.contactAt("index"));
    expect(guard.intersects(hand.model, subject)).toBe(true);
    hand.pose({ pose: "tripod", grip: 1, stabilizerGrip: 1, phase: 0.4, handleRadiusM: 0.0007 });
    expect(hand.contactValid).toBe(true);
    body.position.copy(hand.contactAt("index"));
    expect(guard.intersects(hand.model, subject)).toBe(true);
  });
});
