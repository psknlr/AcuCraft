import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DoubleSide, Raycaster, Triangle, Vector3, type Object3D, type SkinnedMesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { sampleTechnique } from "@acucraft/core";
import { ArticulatedHand, type HandPose } from "../web/stage/hand.js";
import { sampleProcedure } from "../web/stage/choreography.js";
import { NEEDLE_HANDLE_RADIUS_M, needleHandleRadiusAt } from "../web/stage/needle-shape.js";

const asset = readFileSync(fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const toleranceM = 0.000025;

async function handRig() {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  return new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
}

function node(hand: ArticulatedHand, name: string): Object3D {
  const found = hand.model.getObjectByName(name);
  expect(found, name).toBeDefined();
  return found!;
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

/** Signed palmar flexion in the unmirrored model frame, so left and right use the same convention. */
function fingerFlexion(hand: ArticulatedHand, digit: string): [number, number] {
  const [proximal, middle, distal] = digitSegments(hand, digit) as [Vector3, Vector3, Vector3];
  const hinge = new Vector3(0, 1, 0).cross(proximal).normalize();
  const angle = (a: Vector3, b: Vector3) => Math.atan2(a.clone().cross(b).dot(hinge), a.dot(b)) * 180 / Math.PI;
  return [angle(proximal, middle), angle(middle, distal)];
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

/** A correct nail anchor still permits solid fingers to intersect; check the actual deformed distal skin. */
function distalSkinIntrusion(hand: ArticulatedHand, fromDigit: string, intoDigit: string): number {
  const from = node(hand, `${fromDigit}_skin`) as SkinnedMesh;
  const into = node(hand, ["thenar", "palm_surface"].includes(intoDigit) ? intoDigit : `${intoDigit}_skin`) as SkinnedMesh;
  for (const skin of [from, into]) {
    if (skin.skeleton) { skin.skeleton.update(); skin.computeBoundingBox(); skin.computeBoundingSphere(); }
    else { skin.geometry.computeBoundingBox(); skin.geometry.computeBoundingSphere(); }
  }
  const material = Array.isArray(into.material) ? into.material[0]! : into.material;
  const originalSide = material.side;
  material.side = DoubleSide;
  const direction = new Vector3(0.431, 0.293, 0.853).normalize(), triangle = new Triangle(), nearest = new Vector3();
  const vertices = Array.from({ length: into.geometry.getAttribute("position").count }, (_, i) => into.localToWorld(into.getVertexPosition(i, new Vector3())));
  const indices = into.geometry.getIndex()!;
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
    for (const hit of new Raycaster(point, direction, 0.000001, 1).intersectObject(into, false)) {
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
  material.side = originalSide;
  return intrusion;
}

describe("needle-handle surface grip regression", () => {
  it("supports skin with the real volar index pulp and keeps the opposed thumb clear of adjacent fingers", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["palpate", "press", "stretch"] as const) {
        for (const phase of [0, 0.25, 0.5, 0.75, 1]) {
          hand.pose({ pose, grip: phase, phase, intensity: 1 });
          expect(hand.contactAt("index").distanceTo(point(hand, "index_volar_contact")), `${side}/${pose}/${phase} volar surface support`).toBeLessThan(1e-8);
          expect(hand.contactAt("index").distanceTo(point(hand, "index_pad_contact")), `${side}/${pose}/${phase} separate radial needle pad`).toBeGreaterThan(0.005);
          for (const [from, into] of [["thumb", "index"], ["index", "thumb"], ["thumb", "middle"], ["middle", "thumb"], ["index", "middle"], ["middle", "index"]]) {
            expect(distalSkinIntrusion(hand, from!, into!), `${side}/${pose}/${phase}/${from} into ${into}`).toBeLessThan(0.00005);
          }
          const [proximal, middle, distal] = digitSegments(hand, "thumb") as [Vector3, Vector3, Vector3];
          expect(proximal.angleTo(middle) * 180 / Math.PI, `${pose} supporting thumb MCP flexion`).toBeCloseTo(40, 3);
          expect(middle.angleTo(distal) * 180 / Math.PI, `${pose} supporting thumb IP flexion`).toBeCloseTo(20, 3);
          for (const joint of [0, 1, 2] as const) expect(axialJointTwistDegrees(hand, "thumb", joint), `${pose}/${phase} support thumb twist`).toBeLessThanOrEqual(20);
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
            const holdingY = pose === "tripod" ? -0.012 : 0;
            const thumb = expectSurfaceContact(hand, "thumb_pad_contact", holdingY);
            const index = expectSurfaceContact(hand, "index_pad_contact", holdingY);
            const line = index.clone().sub(thumb);
            expect(Math.abs(line.dot(handleFrame(hand).axis))).toBeLessThan(toleranceM);
            expect(line.length()).toBeCloseTo(2 * needleHandleRadiusAt(holdingY), 5);
            expect(normal(hand, "thumb_pad_contact").dot(normal(hand, "index_pad_contact"))).toBeLessThan(-0.999);
            if (pose === "tripod") expectSurfaceContact(hand, "middle_side_contact", 0.006);
          }
        }
      }
    }
    hand.dispose();
  });

  it("scrapes with the middle nail while the thumb and index retain their primary grip", async () => {
    const hand = await handRig();
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

  it("flicks and releases the middle nail without moving the thumb/index primary grip", async () => {
    const hand = await handRig();
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
          expect(offset.addScaledVector(frame.axis, -offset.dot(frame.axis)).length()).toBeGreaterThan(0.005);
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
        const nextMiddle = expectSurfaceContact(hand, "middle_side_contact", 0.006);
        if (middle) expect(nextMiddle.distanceTo(middle)).toBeLessThan(toleranceM);
        middle = nextMiddle;
        if (grip === 0) expect(hand.gapMm()).toBeCloseTo(12, 3);
        if (grip === 1) {
          expectSurfaceContact(hand, "thumb_pad_contact", -0.012);
          expectSurfaceContact(hand, "index_pad_contact", -0.012);
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
        for (const surface of ["thenar", "palm_surface"]) {
          expect(distalSkinIntrusion(hand, "middle", surface), `${side}/${grip} unused middle into ${surface}`).toBeLessThan(0.00005);
        }
      }
    }
    hand.dispose();
  });

  it("preserves every phalanx length throughout approach, grasp, work, release and retreat", async () => {
    const hand = await handRig();
    const baseline = chainLengths(hand);
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["pinch", "tripod", "scrape", "flick"] satisfies HandPose[]) {
        for (let elapsedMs = 0; elapsedMs <= 4320; elapsedMs += 90) {
          const envelope = sampleProcedure("work", elapsedMs, 2400);
          hand.pose({ pose, grip: envelope.grip, stabilizerGrip: envelope.grip, apertureMm: 12,
            phase: Math.max(0, (elapsedMs - envelope.operationStartMs) / 2400) % 1,
            rotationRad: Math.sin(elapsedMs / 300), handleRadiusM: NEEDLE_HANDLE_RADIUS_M });
          expect(hand.contactValid, `${side}/${pose}/${elapsedMs} contact solve`).toBe(true);
          for (const [name, value] of chainLengths(hand)) expect(value, `${side}/${pose}/${elapsedMs}/${name}`).toBeCloseTo(baseline.get(name)!, 7);
          hand.root.traverse((object) => expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true));
          if (envelope.grip === 1) {
            const holdingY = pose === "pinch" ? 0 : -0.012;
            expectSurfaceContact(hand, "thumb_pad_contact", holdingY);
            expectSurfaceContact(hand, "index_pad_contact", holdingY);
          }
        }
      }
    }
    hand.dispose();
  });

  it("keeps interphalangeal bends palmar and avoids twisting a fingertip around its own bone", async () => {
    const hand = await handRig();
    // Broad animation plausibility bounds, not clinical joint-range prescriptions.
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["pinch", "tripod", "scrape", "flick"] as const) {
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
          const current = new Map(["thumb", "index", "middle"].map((digit) => [digit, digitSegments(hand, digit)]));
          if (previous) for (const [digit, directions] of current) {
            for (let segment = 0; segment < 3; segment++) {
              const delta = previous.get(digit)![segment]!.angleTo(directions[segment]!) * 180 / Math.PI;
              expect(delta, `${side}/${technique}/${frame}/${digit}/${segment} frame jump`).toBeLessThan(8);
            }
          }
          previous = current;
        }
      }
    }
    hand.dispose();
  });

  it("opens naturally before retreat even at zero aperture, without losing the contact solve", async () => {
    const hand = await handRig();
    for (const side of ["left", "right"] as const) {
      hand.setSide(side);
      for (const pose of ["pinch", "tripod", "scrape", "flick"] as const) {
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
            if (grip === 0) {
              const { origin, axis } = handleFrame(hand);
              const offset = point(hand, "thumb_pad_contact").sub(origin), axial = offset.dot(axis);
              expect(offset.addScaledVector(axis, -axial).length() - needleHandleRadiusAt(axial), `${pose}/${apertureMm} release clearance`).toBeGreaterThan(0.0014);
            }
          }
        }
      }
    }
    hand.dispose();
  });
});
