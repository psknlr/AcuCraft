import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createHandSkinCorrectives } from "../web/stage/hand-skin-correctives.js";

const q = (axis: Vector3, angle: number) => new Quaternion().setFromAxisAngle(axis, angle);
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0), Z = new Vector3(0, 0, 1);
const neutral = [new Quaternion(), new Quaternion()];
const tip = [q(Z, 0.4), q(X, 0.3)];
const tan = [q(Y, -0.5), q(Z, 0.2)];
const zero = [q(X, 0.7), q(Y, 0.6)];

function fixture() {
  const model = new Group(); model.name = "acu_practitioner_hand";
  const cmc = new Group(); cmc.name = "thumb_CMC";
  const proximal = new Bone(); proximal.name = "thumb_proximal";
  const mcp = new Group(); mcp.name = "thumb_MCP";
  const middle = new Bone(); middle.name = "thumb_middle";
  model.add(cmc); cmc.add(proximal); proximal.add(mcp); mcp.add(middle);
  const skeleton = new Skeleton([proximal, middle]);
  const meshes = ["palm_surface", "thumb_skin"].map((name, partition) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0.02, 0, 0, 0, 0.02, 0], 3));
    geometry.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute([partition, 0, 0, 0, partition, 0, 0, 0, partition, 0, 0, 0], 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geometry.setIndex([0, 1, 2]);
    const names = partition ? ["Tan", "Tip"] : ["Tip", "Tan"];
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = names.map((target) => {
      const attribute = new Float32BufferAttribute(target === "Tip" ? [0.002, 0, 0, 0, 0, 0, 0, 0, 0] : [0, 0.004, 0, 0, 0, 0, 0, 0, 0], 3);
      attribute.name = target; return attribute;
    });
    geometry.morphAttributes.normal = names.map((target) => new Float32BufferAttribute(target === "Tip" ? [0.1, 0, 0, 0, 0, 0, 0, 0, 0] : [0, 0.2, 0, 0, 0, 0, 0, 0, 0], 3));
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial()); mesh.name = name;
    model.add(mesh); mesh.bind(skeleton); return mesh;
  });
  const metadata = {
    schemaVersion: 1,
    method: "quaternion-gaussian-rbf",
    sigma: 0.65,
    joints: [{ bone: "thumb_proximal", control: "thumb_CMC" }, { bone: "thumb_middle", control: "thumb_MCP" }],
    centres: [{ name: null, rotations: neutral.map((r) => r.toArray()) }, { name: "Tip", rotations: tip.map((r) => r.toArray()) }, { name: "Tan", rotations: tan.map((r) => r.toArray()) }, { name: null, rotations: zero.map((r) => r.toArray()) }],
  };
  model.userData.thumbWebCorrectives = metadata;
  const set = (rotations: Quaternion[]) => { cmc.quaternion.copy(rotations[0]!); proximal.quaternion.identity(); mcp.quaternion.copy(rotations[1]!); middle.quaternion.identity(); };
  return { model, metadata, meshes, cmc, proximal, mcp, middle, set };
}

describe("joint-driven thumb-web skin correctives", () => {
  it("interpolates actual POSITION/NORMAL targets in both partitions and preserves neutral/zero anchors", () => {
    const f = fixture(), controller = createHandSkinCorrectives(f.model)!;
    for (const [rotations, expected] of [[neutral, { Tip: 0, Tan: 0 }], [tip, { Tip: 1, Tan: 0 }], [tan, { Tip: 0, Tan: 1 }], [zero, { Tip: 0, Tan: 0 }]] as const) {
      f.set([...rotations]); controller.apply();
      expect(controller.weights().Tip).toBeCloseTo(expected.Tip, 12);
      expect(controller.weights().Tan).toBeCloseTo(expected.Tan, 12);
      f.model.updateMatrixWorld(true);
      for (const mesh of f.meshes) {
        mesh.skeleton.update();
        expect(mesh.morphTargetInfluences![mesh.morphTargetDictionary!.Tip!]).toBeCloseTo(expected.Tip, 12);
        expect(mesh.morphTargetInfluences![mesh.morphTargetDictionary!.Tan!]).toBeCloseTo(expected.Tan, 12);
        // Real SkinnedMesh vertex sampling includes the morph before bone skinning.
        const delta = new Vector3(0.002 * expected.Tip, 0.004 * expected.Tan, 0);
        const skinRotation = mesh === f.meshes[0] ? rotations[0]! : rotations[0]!.clone().multiply(rotations[1]!);
        expect(mesh.getVertexPosition(0, new Vector3()).distanceTo(delta.applyQuaternion(skinRotation))).toBeLessThan(1e-9);
      }
    }
    f.set(tip); controller.apply();
    const copy = controller.weights(); copy.Tip = 9;
    expect(controller.weights().Tip).toBeCloseTo(1, 12);
    // AnimationMixer may have restored baked weights; reset must clear both actual dictionaries.
    f.meshes.forEach((mesh) => mesh.morphTargetInfluences!.fill(0.73)); controller.reset();
    expect(controller.weights()).toEqual({ Tip: 0, Tan: 0 });
    f.meshes.forEach((mesh) => expect(mesh.morphTargetInfluences).toEqual([0, 0]));
  });

  it("uses control times legacy local rotations, independently of antipodal signs and scene reflection", () => {
    const f = fixture(), controller = createHandSkinCorrectives(f.model)!;
    const overlay = q(Y, 0.21);
    f.cmc.quaternion.copy(overlay); f.proximal.quaternion.copy(overlay.clone().invert().multiply(tip[0]!));
    f.mcp.quaternion.copy(tip[1]!); f.middle.quaternion.identity();
    const rotationsBefore = [f.cmc, f.proximal, f.mcp, f.middle].map((n) => n.quaternion.toArray());
    controller.apply(); expect(controller.weights().Tip).toBeCloseTo(1, 12);
    expect(controller.weights().Tan).toBeCloseTo(0, 12);
    expect([f.cmc, f.proximal, f.mcp, f.middle].map((n) => n.quaternion.toArray())).toEqual(rotationsBefore);
    for (const node of [f.cmc, f.proximal, f.mcp, f.middle]) node.quaternion.set(-node.quaternion.x, -node.quaternion.y, -node.quaternion.z, -node.quaternion.w);
    f.model.position.set(8, -4, 2); f.model.quaternion.copy(q(X, 1.3)); f.model.scale.z = -1;
    f.model.updateMatrixWorld(true); controller.apply();
    expect(controller.weights().Tip).toBeCloseTo(1, 12); expect(controller.weights().Tan).toBeCloseTo(0, 12);
  });

  it("varies continuously, retains signed cardinal weights and fades away from the authored poses", () => {
    const f = fixture(); f.metadata.sigma = 0.5;
    const controller = createHandSkinCorrectives(f.model)!;
    f.set([q(Z, 0.2), q(X, 0.15)]); controller.apply();
    const halfway = controller.weights();
    expect(halfway.Tip).toBeGreaterThan(0); expect(halfway.Tip).toBeLessThan(1);
    expect(halfway.Tan).toBeLessThan(0); // Clamping would change the authored RBF interpolation.
    f.set([q(Z, 0.2 + 1e-6), q(X, 0.15)]); controller.apply();
    expect(Math.abs(controller.weights().Tip - halfway.Tip)).toBeLessThan(0.00001);
    f.set([q(Z, Math.PI), q(X, Math.PI)]); controller.apply();
    expect(Math.abs(controller.weights().Tip)).toBeLessThan(1e-8);
    expect(Math.abs(controller.weights().Tan)).toBeLessThan(1e-8);
    f.meshes.forEach((mesh) => mesh.morphTargetInfluences!.fill(0.8));
    f.set(neutral); controller.apply();
    f.meshes.forEach((mesh) => mesh.morphTargetInfluences!.forEach((weight) => expect(Math.abs(weight)).toBeLessThan(1e-12)));
  });

  it("leaves legacy assets without metadata alone", () => {
    const f = fixture(); delete f.model.userData.thumbWebCorrectives;
    f.meshes.forEach((mesh) => mesh.morphTargetInfluences!.fill(0.4));
    expect(createHandSkinCorrectives(f.model)).toBeUndefined();
    f.meshes.forEach((mesh) => expect(mesh.morphTargetInfluences).toEqual([0.4, 0.4]));
  });

  it("accepts reordered palettes that share the real Bone objects and rejects invalid runtime rotations atomically", () => {
    const f = fixture();
    f.meshes[1]!.bind(new Skeleton([f.middle, f.proximal]));
    const indices = f.meshes[1]!.geometry.getAttribute("skinIndex");
    for (let i = 0; i < indices.count; i++) indices.setX(i, 0);
    const controller = createHandSkinCorrectives(f.model)!;
    f.set(tip); controller.apply(); expect(controller.weights().Tip).toBeCloseTo(1, 12);
    const before = f.meshes.map((mesh) => [...mesh.morphTargetInfluences!]);
    f.cmc.quaternion.x = NaN;
    expect(() => controller.apply()).toThrow(/nonfinite or zero joint quaternion/);
    expect(f.meshes.map((mesh) => mesh.morphTargetInfluences)).toEqual(before);
  });

  it.each([
    ["schema", (f: ReturnType<typeof fixture>) => { f.metadata.schemaVersion = 2; }],
    ["sigma", (f: ReturnType<typeof fixture>) => { f.metadata.sigma = NaN; }],
    ["rotation count", (f: ReturnType<typeof fixture>) => { f.metadata.centres[1]!.rotations.pop(); }],
    ["zero quaternion", (f: ReturnType<typeof fixture>) => { f.metadata.centres[1]!.rotations[0] = [0, 0, 0, 0]; }],
    ["duplicate target name", (f: ReturnType<typeof fixture>) => { f.metadata.centres[2]!.name = "Tip"; }],
    ["antipodal duplicate centre", (f: ReturnType<typeof fixture>) => { f.metadata.centres.push({ name: null, rotations: tip.map((r) => new Quaternion(-r.x, -r.y, -r.z, -r.w).toArray()) }); }],
    ["missing joint", (f: ReturnType<typeof fixture>) => { f.metadata.joints[0]!.bone = "absent"; }],
    ["joint Group posing as a Bone", (f: ReturnType<typeof fixture>) => { const fake = new Group(); fake.name = f.proximal.name; f.cmc.remove(f.proximal); f.cmc.add(fake); fake.add(f.mcp); }],
    ["foreign skeleton Bone", (f: ReturnType<typeof fixture>) => { f.meshes[1]!.skeleton = new Skeleton([new Bone(), new Bone()]); }],
    ["source Bone scale", (f: ReturnType<typeof fixture>) => { f.proximal.scale.x = 1.01; }],
    ["control scale", (f: ReturnType<typeof fixture>) => { f.cmc.scale.z = -1; }],
    ["absolute morph targets", (f: ReturnType<typeof fixture>) => { f.meshes[0]!.geometry.morphTargetsRelative = false; }],
    ["extra target name", (f: ReturnType<typeof fixture>) => { f.meshes[0]!.morphTargetDictionary!.extra = 0; }],
    ["out of range index", (f: ReturnType<typeof fixture>) => { f.meshes[0]!.morphTargetDictionary!.Tip = 20; }],
    ["aliased target index", (f: ReturnType<typeof fixture>) => { f.meshes[0]!.morphTargetDictionary!.Tan = f.meshes[0]!.morphTargetDictionary!.Tip!; }],
    ["missing NORMAL target", (f: ReturnType<typeof fixture>) => { f.meshes[1]!.geometry.morphAttributes.normal!.pop(); }],
    ["incomplete POSITION target", (f: ReturnType<typeof fixture>) => { f.meshes[1]!.geometry.morphAttributes.position![0] = new Float32BufferAttribute([0, 0, 0], 3); }],
    ["nonfinite NORMAL target", (f: ReturnType<typeof fixture>) => { f.meshes[1]!.geometry.morphAttributes.normal![0]!.setX(0, NaN); }],
  ])("rejects malformed %s without partially changing morph weights", (_name, corrupt) => {
    const f = fixture(); f.meshes.forEach((mesh) => mesh.morphTargetInfluences!.fill(0.4)); corrupt(f);
    expect(() => createHandSkinCorrectives(f.model)).toThrow(/Invalid thumb-web correctives/);
    f.meshes.forEach((mesh) => expect(mesh.morphTargetInfluences).toEqual([0.4, 0.4]));
  });
});
