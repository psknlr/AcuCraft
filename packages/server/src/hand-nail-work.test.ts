import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Group, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { createNailWorkRig, sampleNailWork, type NailWorkRig, type NailWorkSample, type NailWorkSettings } from "../web/stage/hand-nail-work.js";
import { needleHandleRadiusAt } from "../web/stage/needle-shape.js";

const bytes = readFileSync(process.env.ACUCRAFT_HAND_GEOMETRY_FIXTURE ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const source = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as { nodes: { name?: string; extras?: Record<string, unknown> }[] };
const refitted = source.nodes.some((n) => n.name === "index_nail_edge_contact") && source.nodes.some((n) => n.name === "palm_frame" && [-1, 1].includes(Number(n.extras?.contactFrameHorizontalBranch)));
const degrees = 180 / Math.PI;

async function fixture() {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
  const frame = gltf.scene.getObjectByName("hand_pose_frame");
  if (frame) { frame.position.set(0, 0, 0); frame.quaternion.identity(); }
  return gltf.scene;
}
function sample(rig: NailWorkRig, settings: NailWorkSettings): NailWorkSample {
  const result = sampleNailWork(rig, settings);
  expect(result, JSON.stringify(settings)).toBeDefined();
  expect(result!.valid, JSON.stringify(settings)).toBe(true);
  return result!;
}
function apply(model: Group, s: NailWorkSample) {
  model.position.copy(s.modelPosition); model.quaternion.copy(s.modelQuaternion);
  for (const [digit, labels, rotations] of [["thumb", ["CMC", "MCP", "IP"], s.thumbRotations], ["index", ["MCP", "PIP", "DIP"], s.indexRotations]] as const) {
    labels.forEach((label, i) => model.getObjectByName(`${digit}_${label}`)!.quaternion.copy(rotations[i]!).multiply(model.getObjectByName(`${digit}_${["proximal", "middle", "distal"][i]}`)!.quaternion.clone().invert()));
  }
  model.updateMatrixWorld(true);
}
function contact(model: Group, s: NailWorkSample, name: string) {
  const c = s.contacts[name]!, attachment = model.getObjectByName(c.parent)!;
  return { point: c.point.clone().applyMatrix4(attachment.matrixWorld), normal: c.normal.clone().transformDirection(attachment.matrixWorld) };
}
function elevation(rig: NailWorkRig, s: NailWorkSample) {
  const v = rig.wrist.clone().applyQuaternion(s.modelQuaternion).add(s.modelPosition).sub(s.principalContact);
  return Math.atan2(v.y, Math.hypot(v.x, v.z)) * degrees;
}

it("keeps legacy assets on their explicit capability path", async () => {
  const model = await fixture(), palm = model.getObjectByName("palm_frame");
  if (palm) delete palm.userData.contactFrameHorizontalBranch;
  expect(createNailWorkRig(model)).toBeUndefined();
});

describe.skipIf(!refitted)("actual single-hand Gua and Tan material roles", () => {
  it("uses a real leading vertex and positive incident-facet cone without changing the source", async () => {
    const model = await fixture(), before = JSON.stringify(model.toJSON()), rig = createNailWorkRig(model)!;
    for (const pose of ["scrape", "flick"] as const) for (const E of [50, 55, 60]) {
      const s = sample(rig, { pose, grip: 1, phase: 0.28, nailContact: 0.5, wristElevationDeg: E });
      const nail = s.contacts.index_nail_edge_contact!;
      expect(nail.surface).toBe("index_nail"); expect(nail.normalField).toBe("keratin-edge-cone");
      expect(nail.definition.vertexIndex).toBe(97);
      expect(nail.definition.incidentFaceIndices).toEqual(rig.nailFacets.map((f) => f.index));
      const coefficients = (nail.definition.normalCone as { faceCoefficients: Record<string, number> }).faceCoefficients;
      const n = new Vector3();
      for (const [id, coefficient] of Object.entries(coefficients)) { expect(coefficient).toBeGreaterThanOrEqual(0); n.addScaledVector(rig.nailFacets.find((f) => f.index === Number(id))!.normal, coefficient); }
      expect(n.normalize().dot(nail.normal)).toBeGreaterThan(1 - 1e-10);
      expect(Math.max(...rig.nailVertices.map((v) => v.clone().sub(nail.point).dot(nail.normal)))).toBeLessThanOrEqual(1e-9);
    }
    // Creation and sampling capture immutable geometry; only the caller applies poses.
    expect(JSON.stringify(model.toJSON())).toBe(before);
  });

  it("scrapes six millimetres with the thumb on the tail and an exact brace wrist reference", async () => {
    const model = await fixture(), rig = createNailWorkRig(model)!, lengths = [rig.index.a, rig.index.b, rig.index.c, rig.thumb.a, rig.thumb.b, rig.thumb.c].map((v) => v.length());
    for (const E of [50, 55, 60]) for (const travel of [0, 0.5, 1]) {
      const s = sample(rig, { pose: "scrape", grip: 1, phase: travel, nailContact: travel, wristElevationDeg: E }); apply(model, s);
      const thumb = contact(model, s, "thumb_pad_contact"), nail = contact(model, s, "index_nail_edge_contact");
      expect(thumb.point.distanceTo(new Vector3(0, 0.0125, 0))).toBeLessThan(1e-8);
      expect(thumb.normal.dot(new Vector3(0, -1, 0))).toBeGreaterThan(1 - 1e-10);
      expect(nail.point.y).toBeCloseTo((-8 + 6 * travel) / 1000, 8);
      expect(Math.hypot(nail.point.x, nail.point.z)).toBeCloseTo(needleHandleRadiusAt(nail.point.y), 8);
      expect(elevation(rig, s)).toBeCloseTo(E, 8);
      expect(s.contacts.thumb_pad_contact!.engagedWith).toBe("needle-tail");
      expect(s.contacts.index_nail_edge_contact!.engagedWith).toBe("needle-handle");
      expect([rig.index.a, rig.index.b, rig.index.c, rig.thumb.a, rig.thumb.b, rig.thumb.c].map((v) => v.length())).toEqual(lengths);
    }
  });

  it("really releases both Gua contacts across the allowed aperture while preserving the nominal wrist", async () => {
    const model = await fixture(), rig = createNailWorkRig(model)!;
    for (const E of [50, 55, 60]) for (const travel of [0, 1]) for (const aperture of [0, 12]) for (const grip of [0, 0.5, 1]) {
      const s = sample(rig, { pose: "scrape", grip, phase: 0, nailContact: travel, apertureMm: aperture, wristElevationDeg: E }); apply(model, s);
      const thumb = contact(model, s, "thumb_pad_contact"), nail = contact(model, s, "index_nail_edge_contact");
      expect(thumb.point.y - 0.0125).toBeCloseTo((1 - grip) * 0.0015, 8);
      expect(Math.hypot(nail.point.x, nail.point.z) - needleHandleRadiusAt(nail.point.y)).toBeCloseTo((1 - grip) * Math.max(1.5, aperture) / 1000, 7);
      expect(elevation(rig, s)).toBeCloseTo(E, 8);
      expect(s.contacts.thumb_pad_contact!.engaged).toBe(grip === 1);
      expect(s.contacts.index_nail_edge_contact!.engaged).toBe(grip === 1);
    }
  });

  it("prepares skin-to-skin then flicks with the index nail at the core impulse phase 0.28", async () => {
    const model = await fixture(), rig = createNailWorkRig(model)!;
    for (const E of [50, 55, 60]) for (const phase of [0, 0.08, 0.28, 0.5, 0.58]) {
      const s = sample(rig, { pose: "flick", grip: 1, phase, wristElevationDeg: E }); apply(model, s);
      expect(elevation(rig, s)).toBeCloseTo(E, 8);
      const thumb = contact(model, s, "thumb_pad_contact"), index = contact(model, s, "index_pad_contact"), nail = contact(model, s, "index_nail_edge_contact");
      if (phase === 0 || phase === 0.58) {
        expect(thumb.point.distanceTo(index.point)).toBeLessThan(1e-7);
        expect(thumb.normal.dot(index.normal)).toBeLessThan(-1 + 1e-9);
        expect(s.contacts.thumb_pad_contact!.engaged).toBe(true);
      } else expect(s.contacts.thumb_pad_contact!.engaged).toBe(false);
      expect(s.contacts.index_nail_edge_contact!.engaged).toBe(phase === 0.28);
      if (phase === 0.28) expect(nail.point.distanceTo(s.principalContact)).toBeLessThan(1e-8);
      expect(Object.keys(s.contacts).sort()).toEqual(["index_nail_edge_contact", "index_pad_contact", "thumb_pad_contact"]);
    }
  });

  it("has a continuous nominal-DIP handoff and stays below four degrees per frame over a flick", async () => {
    const rig = createNailWorkRig(await fixture())!;
    const beta = (travel: number) => {
      const q = sample(rig, { pose: "scrape", grip: 1, phase: travel, nailContact: travel, wristElevationDeg: 55 }).indexRotations[2];
      return (rig.index.restB + 2 * Math.atan2(new Vector3(q.x, q.y, q.z).dot(rig.index.hb), q.w)) * degrees;
    };
    let low = 0, high = 1;
    for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (beta(mid) > 60.09) low = mid; else high = mid; }
    const center = (low + high) / 2, epsilon = 1e-6;
    expect(Math.abs(beta(center - epsilon) - beta(center + epsilon))).toBeLessThan(0.002);
    const slopeLeft = (beta(center) - beta(center - epsilon)) / epsilon, slopeRight = (beta(center + epsilon) - beta(center)) / epsilon;
    expect(Math.abs(slopeLeft - slopeRight)).toBeLessThan(0.1);
    for (const E of [50, 55, 60]) {
      let previous: { thumb: Quaternion; index: Quaternion; joints: Quaternion[] } | undefined;
      for (let step = 0; step <= 80; step++) {
        const s = sample(rig, { pose: "flick", grip: 1, phase: step / 80, wristElevationDeg: E });
        const thumb = s.thumbRotations.reduce((q, part) => q.multiply(part), new Quaternion()), index = s.indexRotations.reduce((q, part) => q.multiply(part), new Quaternion());
        const joints = [...s.thumbRotations, ...s.indexRotations];
        if (previous) {
          expect(thumb.angleTo(previous.thumb) * degrees).toBeLessThan(4); expect(index.angleTo(previous.index) * degrees).toBeLessThan(4);
          joints.forEach((q, i) => expect(q.angleTo(previous!.joints[i]!) * degrees).toBeLessThan(4));
        }
        previous = { thumb, index, joints };
      }
    }
  });
});
