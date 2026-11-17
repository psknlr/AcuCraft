import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Matrix4, Mesh, Quaternion, SkinnedMesh, Vector3, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { ArticulatedHand } from "../web/stage/hand.js";
import { alignNormalAroundAxis, contactFrameAtElevation, fingerPostureReference, measureFingerMcp, minimumPlanarContactDistance, minimumPlanarContactRetreat, ordinaryTipPosture, tipReleasePalmarBlend } from "../web/stage/hand-physiology.js";

const asset = readFileSync(process.env.ACUCRAFT_HAND_GEOMETRY_FIXTURE ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url)));
const degrees = 180 / Math.PI;
const sourceNodes = JSON.parse(asset.subarray(20, 20 + asset.readUInt32LE(12)).toString("utf8")).nodes as { name?: string; extras?: Record<string, unknown> }[];
const hasNailRoles = sourceNodes.some((n) => n.name === "index_nail_edge_contact") && sourceNodes.some((n) => n.name === "palm_frame" && [-1, 1].includes(Number(n.extras?.contactFrameHorizontalBranch)));

async function handRig(sourceWrist?: Vector3, legacyPresentation = false) {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(asset).buffer, "");
  if (sourceWrist) gltf.scene.getObjectByName("wrist")!.position.copy(sourceWrist);
  if (legacyPresentation) delete gltf.scene.getObjectByName("palm_frame")!.userData.contactFrameHorizontalBranch;
  return new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
}

function node(hand: ArticulatedHand, name: string): Object3D {
  const result = hand.model.getObjectByName(name);
  expect(result, name).toBeDefined();
  return result!;
}

/** Measure actual phalanges in the unmirrored palm frame, independently of control quaternions. */
function finger(hand: ArticulatedHand, digit: string) {
  hand.root.updateWorldMatrix(true, true);
  const palm = node(hand, "palm_frame");
  const inversePalm = new Matrix4().copy(palm.matrixWorld).invert();
  const points = ["MCP", "PIP", "DIP", "tip"].map((name) => node(hand, `${digit}_${name}`).getWorldPosition(new Vector3()).applyMatrix4(inversePalm));
  const lengths = points.slice(1).map((point, index) => point.distanceTo(points[index]!));
  const [proximal, middle, distal] = points.slice(1).map((point, index) => point.clone().sub(points[index]!).normalize()) as [Vector3, Vector3, Vector3];
  // Bone translations are immutable. Transport their two actual source hinge
  // axes through the corresponding posed attachments, including baked children.
  // A palm-normal × proximal approximation loses the hinge near 90° MCP flexion.
  const a = node(hand, `${digit}_PIP`).position, b = node(hand, `${digit}_DIP`).position, c = node(hand, `${digit}_tip`).position;
  const sourceHinge = a.clone().cross(b).normalize(), distalHinge = b.clone().cross(c).normalize();
  const palmUp = new Vector3(0, 1, 0).applyQuaternion(palm.quaternion);
  if (sourceHinge.dot(palmUp.cross(a)) < 0) sourceHinge.negate();
  if (distalHinge.dot(sourceHinge) < 0) distalHinge.negate();
  const hinge = sourceHinge.transformDirection(inversePalm.clone().multiply(node(hand, `${digit}_proximal`).matrixWorld));
  const dipHinge = distalHinge.transformDirection(inversePalm.clone().multiply(node(hand, `${digit}_middle`).matrixWorld));
  const signed = (a: Vector3, b: Vector3, axis: Vector3) => Math.atan2(a.clone().cross(b).dot(axis), a.dot(b)) * degrees;
  const mcp = measureFingerMcp(proximal, hinge, new Matrix4());
  return {
    mcp: mcp.flexionDeg,
    spread: mcp.spreadDeg,
    pip: signed(proximal, middle, hinge), dip: signed(middle, distal, dipHinge), lengths,
    // Hinge-only flexion must leave the downstream segments in the same volar plane.
    planeDrift: Math.max(Math.abs(hinge.dot(middle)), Math.abs(hinge.dot(distal))),
  };
}

describe("physiological presentation of free fingers", () => {
  it("keeps the precision reference stable across wrist elevation and preserves the walking-release onset", () => {
    for (const elevation of [35, 45, 55, 60, 65, 70]) {
      expect(ordinaryTipPosture(elevation)).toEqual({ mcpDeg: 50, pipDeg: 100, dipDeg: 60 });
    }
    expect(tipReleasePalmarBlend(0.0006, 60)).toBe(0);
    expect(tipReleasePalmarBlend(0.0053, 45)).toBeCloseTo(0.3, 10);
    expect(tipReleasePalmarBlend(0.0053, 60)).toBeCloseTo(0.3, 10);
  });

  it("builds a working distal frame from the actual serial MCP/PIP/DIP hinges", () => {
    const base = new Vector3(0.01, 0.02, 0.03), a = new Vector3(-0.04, 0, 0), b = new Vector3(-0.02, -0.015, 0), c = new Vector3(-0.01, -0.01, 0);
    const reference = fingerPostureReference(base, a, b, c, new Matrix4(), { mcpDeg: 60, pipDeg: 50, dipDeg: 30 });
    const [mcp, pip, dip] = reference.rotations;
    const proximal = a.clone().applyQuaternion(mcp), middle = b.clone().applyQuaternion(pip).applyQuaternion(mcp), distal = c.clone().applyQuaternion(dip).applyQuaternion(pip).applyQuaternion(mcp);
    expect(Math.atan2(-proximal.y, -proximal.x) * degrees).toBeCloseTo(60, 10);
    expect(proximal.angleTo(middle) * degrees).toBeCloseTo(50, 10);
    expect(middle.angleTo(distal) * degrees).toBeCloseTo(30, 10);
    for (const [posed, source] of [[proximal, a], [middle, b], [distal, c]]) expect(posed!.length()).toBeCloseTo(source!.length(), 12);
    const expectedTip = base.clone().add(proximal).add(middle).add(distal);
    expect(c.clone().applyMatrix4(reference.attachment).distanceTo(expectedTip)).toBeLessThan(1e-12);
  });

  it("measures the full MCP frame without losing its hinge at deep flexion", () => {
    const palm = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, -0.2).normalize(), 0.9));
    const source = new Vector3(-0.04, 0, 0).transformDirection(palm), hinge = new Vector3(0, 0, 1).transformDirection(palm);
    for (const flexionDeg of [45, 89.99999, 90, 95, 105]) {
      const rotation = fingerPostureReference(new Vector3(), source, new Vector3(-0.02, -0.015, 0).transformDirection(palm), new Vector3(-0.01, -0.01, 0).transformDirection(palm), palm,
        { mcpDeg: flexionDeg, pipDeg: 35, dipDeg: 10, ulnarSpreadDeg: 12 }).rotations[0];
      const actual = measureFingerMcp(source.clone().applyQuaternion(rotation), hinge.clone().applyQuaternion(rotation), palm);
      expect(actual.valid).toBe(true);
      expect(actual.flexionDeg).toBeCloseTo(flexionDeg, 7);
      expect(actual.spreadDeg).toBeCloseTo(12, 7);
      expect(actual.hingeTiltDeg).toBeCloseTo(0, 7);
    }
    const degenerate = measureFingerMcp(source, new Vector3(0, 1, 0).transformDirection(palm), palm);
    expect(degenerate.valid).toBe(false);
    expect(Number.isNaN(degenerate.flexionDeg)).toBe(true);
  });

  it("maps an immutable real contact frame to either fixed wrist-elevation branch", () => {
    const origin = new Vector3(0.004, -0.007, 0.003), sourceNormal = new Vector3(-0.92, 0.36, -0.13).normalize();
    const wrist = new Vector3(0.057, 0.084, 0.017), sourceVector = wrist.clone().sub(origin);
    const sourcePoint = origin.clone().addScaledVector(sourceNormal, -0.0007);
    for (const elevation of [35, 55, 70]) for (const branch of [-1, 1] as const) {
      const frame = contactFrameAtElevation(origin, sourceNormal, wrist, elevation, branch)!;
      expect(frame).not.toBeNull();
      expect(sourceNormal.clone().applyQuaternion(frame.rotation).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-12);
      const point = sourcePoint.clone().applyQuaternion(frame.rotation).add(frame.position);
      expect(point.distanceTo(new Vector3(0, 0, 0.0007))).toBeLessThan(1e-12);
      const direction = wrist.clone().applyQuaternion(frame.rotation).add(frame.position);
      expect(direction.length()).toBeCloseTo(sourceVector.length(), 12);
      expect(Math.atan2(direction.y, Math.hypot(direction.x, direction.z)) * degrees).toBeCloseTo(elevation, 10);
      expect(Math.sign(direction.x)).toBe(branch);
      expect(frame.wristDirection.distanceTo(sourceVector.clone().normalize())).toBeLessThan(1e-12);
    }
    // A wrist parallel to the required contact normal cannot acquire a high elevation.
    expect(contactFrameAtElevation(new Vector3(), new Vector3(0, 0, 1), new Vector3(0, 0, 0.1), 55, -1)).toBeNull();
    expect(origin.toArray()).toEqual([0.004, -0.007, 0.003]);
    expect(wrist.toArray()).toEqual([0.057, 0.084, 0.017]);
  });

  it("detects the rotation-invariant reach limit of a real planar hinge contact", () => {
    const hinge = new Vector3(0, 0, 1), contact = new Vector3(0.020, 0.010, 0.002), normal = new Vector3(0.6, 0, 0.8);
    const requiredDot = 0.010, minimum = minimumPlanarContactDistance(hinge, contact, normal, requiredDot);
    const axial = contact.dot(hinge), transverse = (requiredDot - axial * normal.z) / normal.x;
    expect(minimum).toBeCloseTo(Math.hypot(axial, transverse), 10);
    const attainable = new Vector3(transverse, 0, axial);
    expect(attainable.dot(normal)).toBeCloseTo(requiredDot, 10);
    expect(attainable.length()).toBeCloseTo(minimum, 10);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.7, -0.1).normalize(), 0.8);
    expect(minimumPlanarContactDistance(hinge.clone().applyQuaternion(rotation), contact.clone().applyQuaternion(rotation), normal.clone().applyQuaternion(rotation), requiredDot)).toBeCloseTo(minimum, 10);
    expect(minimumPlanarContactDistance(hinge, contact, hinge, requiredDot)).toBe(Infinity);
    expect(minimumPlanarContactDistance(hinge, contact, hinge, axial)).toBeCloseTo(axial, 10);
  });

  it("finds the first feasible nonorthogonal wrist retreat without crossing its finite interval", () => {
    const settings = { displacement: new Vector3(0.002, 0.001, 0), direction: new Vector3(1, 0, 0),
      targetNormal: new Vector3(1, 0, 0), hinge: new Vector3(0, 0, 1), contactVector: new Vector3(0.010, 0, 0),
      contactNormal: new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2) };
    const retreat = minimumPlanarContactRetreat(settings);
    expect(retreat).toBeCloseTo(0.001, 10);
    const slack = (distance: number) => {
      const point = settings.displacement.clone().addScaledVector(settings.direction, -distance);
      // Here k=0 and n²=1/2: the feasible ray segment is exactly 1..3 mm.
      return 0.5 * point.lengthSq() - point.dot(settings.targetNormal) ** 2;
    };
    expect(slack(0.0009)).toBeLessThan(0);
    expect(Math.abs(slack(retreat))).toBeLessThan(1e-18);
    expect(slack(0.002)).toBeGreaterThan(0);
    expect(slack(0.0031)).toBeLessThan(0);
    expect(minimumPlanarContactRetreat({ ...settings, maximum: 0.0009 })).toBe(Infinity);
    expect(minimumPlanarContactRetreat({ ...settings, maximum: 0.001 })).toBeCloseTo(0.001, 10);
    expect(minimumPlanarContactRetreat({ ...settings, direction: new Vector3(-1, 0, 0) })).toBe(Infinity);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0.3, -0.4, 0.8).normalize(), 0.7);
    const rotated = Object.fromEntries(Object.entries(settings).map(([name, vector]) => [name, vector.clone().applyQuaternion(rotation)])) as typeof settings;
    expect(minimumPlanarContactRetreat(rotated)).toBeCloseTo(retreat, 10);
  });

  it("handles linear, isolated-tangent and already-feasible wrist contact rays", () => {
    const sourceNormal = new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2), n = sourceNormal.clone().normalize().z;
    const transverse = 1 - n * n;
    const settings = { displacement: new Vector3(0.002, 0.001, 0), direction: new Vector3(Math.sqrt(transverse), Math.sqrt(1 - transverse), 0),
      targetNormal: new Vector3(1, 0, 0), hinge: new Vector3(0, 0, 1), contactVector: new Vector3(0.010, 0, 0), contactNormal: sourceNormal };
    const expectedLinear = 0.003 / Math.SQRT2;
    expect(minimumPlanarContactRetreat(settings)).toBeCloseTo(expectedLinear, 10);
    const nearLinearDirection = settings.direction.clone(); nearLinearDirection.x *= 1 + 1e-12; nearLinearDirection.normalize();
    expect(minimumPlanarContactRetreat({ ...settings, direction: nearLinearDirection })).toBeCloseTo(expectedLinear, 10);
    expect(minimumPlanarContactRetreat({ ...settings, displacement: new Vector3(0.001, 0.002, 0) })).toBe(0);
    const tangent = { ...settings, direction: new Vector3(1, 0, 0), contactNormal: new Vector3(0, 0, 1), contactVector: new Vector3(0.010, 0, 0.001) };
    expect(minimumPlanarContactRetreat(tangent)).toBeCloseTo(0.001, 10);
    expect(minimumPlanarContactRetreat({ ...tangent, direction: new Vector3(0, 1, 0) })).toBe(Infinity);
    expect(minimumPlanarContactRetreat({ ...tangent, maximum: 0.00099 })).toBe(Infinity);
  });

  it("aligns the controllable normal components while keeping the wrist direction fixed", () => {
    const wrist = new Vector3(0.3, 0.8, 0.4).normalize(), from = new Vector3(-0.9, 0.3, -0.1).normalize(), to = new Vector3(0, 0, -1);
    const rotation = alignNormalAroundAxis(from, to, wrist), aligned = from.clone().applyQuaternion(rotation);
    expect(wrist.clone().applyQuaternion(rotation).distanceTo(wrist)).toBeLessThan(1e-12);
    const sourceAlong = from.dot(wrist), targetAlong = to.dot(wrist);
    const bestDot = sourceAlong * targetAlong + Math.sqrt(1 - sourceAlong * sourceAlong) * Math.sqrt(1 - targetAlong * targetAlong);
    expect(aligned.dot(to)).toBeCloseTo(bestDot, 10);
    for (const offset of [-0.01, 0.01]) expect(aligned.clone().applyAxisAngle(wrist, offset).dot(to)).toBeLessThan(bestDot);
    expect(alignNormalAroundAxis(to, to, wrist).angleTo(new Quaternion())).toBeLessThan(1e-10);
    expect(alignNormalAroundAxis(wrist, to, wrist).angleTo(new Quaternion())).toBeLessThan(1e-10);
  });

  it("preserves legacy source azimuth while setting actual wrist elevation for either hand", async () => {
    // Relocating this diagnostic marker isolates presentation-frame geometry from the
    // generated asset's choice of carpal position; the ordinary asset is exercised below.
    const sourceWrist = new Vector3(0.080, 0.110, 0.045), hand = await handRig(sourceWrist, true);
    for (const side of ["right", "left"] as const) for (const elevation of [35, 55, 70]) {
      hand.setSide(side);
      hand.pose({ pose: "pinch", grip: 1, phase: 0, handleRadiusM: 0.0007, wristElevationDeg: elevation });
      const direction = hand.wrist().sub(hand.model.position);
      expect(Math.atan2(direction.y, Math.hypot(direction.x, direction.z)) * degrees).toBeCloseTo(elevation, 8);
      const azimuth = Math.atan2(sourceWrist.z * (side === "left" ? -1 : 1), sourceWrist.x);
      expect(Math.atan2(direction.z, direction.x)).toBeCloseTo(azimuth, 8);
    }
    hand.dispose();
  });

  it("mirrors the actual posed skin and wrist consistently across hand-side switching history", async () => {
    const hand = await handRig(), settings = { pose: "pinch" as const, grip: 1, phase: 0.5, handleRadiusM: 0.0007, wristElevationDeg: 55, rotationRad: -1.4 };
    hand.root.position.set(0.2, 0.8, -0.3);
    hand.root.quaternion.setFromAxisAngle(new Vector3(0.5, -0.2, 0.1).normalize(), 0.7);
    const snapshot = () => {
      hand.root.updateWorldMatrix(true, true);
      const points = new Map<string, Vector3>([["wrist", hand.wrist()]]);
      hand.model.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        if (object instanceof SkinnedMesh) object.skeleton.update();
        const count = object.geometry.getAttribute("position").count;
        for (const fraction of [0, 0.25, 0.5, 1]) {
          const vertex = Math.floor(fraction * (count - 1));
          points.set(`${object.name}:${vertex}`, hand.root.worldToLocal(object.localToWorld(object.getVertexPosition(vertex, new Vector3()))));
        }
      });
      return points;
    };
    hand.pose({ ...settings, rotationRad: -settings.rotationRad });
    const opposite = snapshot();
    hand.pose(settings);
    expect(hand.contactValid).toBe(true);
    const right = snapshot();
    const expectMirror = (mirror: number, reference = right) => {
      const current = snapshot();
      expect(current.size).toBe(reference.size);
      for (const [name, point] of reference) expect(current.get(name)!.distanceTo(new Vector3(point.x, point.y, point.z * mirror)), name).toBeLessThan(0.000001);
    };
    hand.setSide("left"); expectMirror(-1);
    const leftReference = node(hand, "palm_frame").userData.contactFrameHorizontalBranch === undefined ? right : opposite;
    hand.pose(settings); expect(hand.contactValid).toBe(true); expectMirror(-1, leftReference);
    hand.setSide("right"); expectMirror(1, leftReference);
    hand.setSide("left"); hand.pose({ ...settings, rotationRad: 0.2, wristElevationDeg: 35 });
    hand.setSide("right"); hand.pose(settings); expect(hand.contactValid).toBe(true); expectMirror(1);
    hand.dispose();
  });

  it("moves both hands' real pulp material in the physical needle-turn direction", async () => {
    const hand = await handRig();
    if (node(hand, "palm_frame").userData.contactFrameHorizontalBranch === undefined) { hand.dispose(); return; }
    for (const side of ["left", "right"] as const) for (const gripStyle of ["tip-pinch", "side-pinch"] as const) for (const wristElevationDeg of [35, 55, 70]) {
      hand.setSide(side);
      const settings = { pose: "pinch" as const, grip: 1, phase: 0.5, handleRadiusM: 0.0007, gripStyle, wristElevationDeg };
      hand.pose({ ...settings, rotationRad: 0 });
      const anchors = [node(hand, "thumb_pad_contact"), node(hand, gripStyle === "side-pinch" ? "index_side_contact" : "index_pad_contact")];
      const material = anchors.map((anchor) => anchor.position.clone());
      for (const rotationRad of [-0.1, 0.1]) {
        hand.pose({ ...settings, rotationRad });
        expect(hand.contactValid).toBe(true);
        hand.root.updateWorldMatrix(true, true);
        for (let index = 0; index < anchors.length; index++) {
          const anchor = anchors[index]!, contact = hand.root.worldToLocal(anchor.getWorldPosition(new Vector3()));
          // Track the same rigid terminal-skin material coordinate through the actual
          // distal attachment; the selected contact itself stays fixed on the handle.
          const tracked = hand.root.worldToLocal(anchor.parent!.localToWorld(material[index]!.clone()));
          const velocity = tracked.sub(contact);
          const tangent = new Vector3(0, 1, 0).cross(contact.clone().setY(0).normalize()).multiplyScalar(Math.sign(rotationRad));
          expect(velocity.length()).toBeGreaterThan(0.000002);
          expect(velocity.normalize().dot(tangent), `${side}/${gripStyle}/${wristElevationDeg}/${anchor.name}`).toBeGreaterThan(0.98);
        }
      }
    }
    hand.dispose();
  });

  it("replays the same actual skin and wrist after changing grip style, roll and hand side", async () => {
    const hand = await handRig();
    const requests = [
      { side: "right" as const, gripStyle: "tip-pinch" as const, wristElevationDeg: 35, rotationRad: 0, grip: 1 },
      { side: "left" as const, gripStyle: "side-pinch" as const, wristElevationDeg: 70, rotationRad: 0, grip: 0.5 },
      { side: "right" as const, gripStyle: "tip-pinch" as const, wristElevationDeg: 55, rotationRad: 1.2, grip: 1 },
    ];
    const snapshot = (rig: ArticulatedHand) => {
      rig.root.updateWorldMatrix(true, true);
      const points = [rig.wrist()];
      for (const digit of ["thumb", "index"]) {
        const skin = node(rig, `${digit}_skin`) as SkinnedMesh;
        skin.skeleton.update();
        for (let vertex = 0; vertex < skin.geometry.getAttribute("position").count; vertex++) {
          points.push(rig.root.worldToLocal(skin.localToWorld(skin.getVertexPosition(vertex, new Vector3()))));
        }
      }
      return points;
    };
    const settings = (request: typeof requests[number]) => ({ pose: "pinch" as const, phase: 0.5, handleRadiusM: 0.0007, ...request });
    const expected: Vector3[][] = [];
    for (const request of requests) {
      const fresh = await handRig();
      fresh.setSide(request.side); fresh.pose(settings(request));
      expect(fresh.contactValid).toBe(true);
      expected.push(snapshot(fresh)); fresh.dispose();
    }
    for (const index of [2, 0, 1, 0, 2, 1]) {
      const request = requests[index]!;
      hand.setSide(request.side); hand.pose(settings(request));
      expect(hand.contactValid).toBe(true);
      const current = snapshot(hand);
      expect(current.length).toBe(expected[index]!.length);
      for (let vertex = 0; vertex < current.length; vertex++) {
        expect(current[vertex]!.distanceTo(expected[index]![vertex]!), `${request.gripStyle}/${request.side}/${vertex}`).toBeLessThan(0.000001);
      }
    }
    hand.dispose();
  });

  it("restores raw material aliases through needle, surface-support and needle histories", async () => {
    const hand = await handRig(), names = ["thumb_pad_contact", "index_pad_contact", "middle_side_contact", "index_volar_contact"];
    const raw = new Map(names.map((name) => [name, { position: node(hand, name).position.clone(), quaternion: node(hand, name).quaternion.clone() }]));
    hand.pose({ pose: "tripod", grip: 1, stabilizerGrip: 1, phase: 0.2, handleRadiusM: 0.0007, wristElevationDeg: 48 });
    expect(hand.contactValid).toBe(true);
    hand.pose({ pose: "palpate", grip: 0.5, phase: 0.25 });
    expect(Object.keys(hand.materialContacts())).toEqual(["index_volar_contact"]);
    for (const name of names) {
      expect(node(hand, name).position.distanceTo(raw.get(name)!.position)).toBeLessThan(1e-12);
      // glTF float quaternions may be a few ulps short of unit length; angleTo(q,q)
      // then reports a nonzero angle. Restoring the raw components is the exact contract.
      expect(node(hand, name).quaternion.toArray(), name).toEqual(raw.get(name)!.quaternion.toArray());
    }
    const request = { pose: "tripod" as const, grip: 0.5, stabilizerGrip: 1, phase: 0.4, handleRadiusM: 0.0007, wristElevationDeg: 48 };
    const fresh = await handRig();
    for (const rig of [fresh, hand]) { rig.setSide("left"); rig.pose(request); expect(rig.contactValid).toBe(true); }
    expect(hand.materialContacts()).toEqual(fresh.materialContacts());
    expect(hand.principalContact().distanceTo(fresh.principalContact())).toBeLessThan(1e-12);
    for (const name of Object.keys(hand.materialContacts())) {
      expect(node(hand, name).getWorldPosition(new Vector3()).distanceTo(node(fresh, name).getWorldPosition(new Vector3()))).toBeLessThan(0.000001);
    }
    for (const digit of ["thumb", "index", "middle"]) {
      const a = node(hand, `${digit}_skin`) as SkinnedMesh, b = node(fresh, `${digit}_skin`) as SkinnedMesh;
      a.skeleton.update(); b.skeleton.update();
      for (let vertex = 0; vertex < a.geometry.getAttribute("position").count; vertex++) {
        expect(a.localToWorld(a.getVertexPosition(vertex, new Vector3())).distanceTo(b.localToWorld(b.getVertexPosition(vertex, new Vector3())))).toBeLessThan(0.000001);
      }
    }
    fresh.dispose(); hand.dispose();
  });

  it.skipIf(!hasNailRoles)("uses the actual single-hand nail roles, fixed principal and idle middle for both hands", async () => {
    const hand = await handRig();
    for (const side of ["right", "left"] as const) for (const pose of ["scrape", "flick"] as const) for (const grip of [0, 0.5, 1]) for (const phase of [0, 0.28, 0.58]) {
      hand.setSide(side);
      hand.pose({ pose, grip, phase, nailContact: 0.5, apertureMm: 12, handleRadiusM: 0.0007, wristElevationDeg: 55 });
      expect(hand.contactValid, `${side}/${pose}/${grip}/${phase}`).toBe(true);
      const materials = hand.materialContacts();
      expect(Object.keys(materials).sort()).toEqual((pose === "scrape" ? ["thumb_pad_contact", "index_nail_edge_contact"] : ["thumb_pad_contact", "index_pad_contact", "index_nail_edge_contact"]).sort());
      expect(materials.index_nail_edge_contact!.normalField).toBe("keratin-edge-cone");
      expect(materials.index_nail_edge_contact!.engagedWith).toBe("needle-handle");
      expect(materials.index_nail_edge_contact!.engaged).toBe(grip === 1 && (pose === "scrape" || phase === 0.28));
      expect(materials.thumb_pad_contact!.engagedWith).toBe(pose === "scrape" ? "needle-tail" : "index_pad_contact");
      const principal = hand.principalContact(), bearing = hand.wrist().sub(principal);
      expect(principal.y).toBe(pose === "scrape" ? 0.0125 : 0);
      if (pose === "flick") expect(Math.sign(principal.z)).toBe(side === "right" ? 1 : -1);
      expect(Math.atan2(bearing.y, Math.hypot(bearing.x, bearing.z)) * degrees).toBeCloseTo(55, 7);
      expect(hand.contactAt("handle").length()).toBeLessThan(1e-12);
      const nail = node(hand, "index_nail") as Mesh;
      expect(hand.contactAt("nail").distanceTo(nail.localToWorld(nail.getVertexPosition(97, new Vector3())))).toBeLessThan(0.000005);
      const middle = finger(hand, "middle");
      expect(middle.mcp).toBeCloseTo(85, 4); expect(middle.pip).toBeCloseTo(95, 4); expect(middle.dip).toBeCloseTo(55, 4);
    }
    hand.dispose();
  });

  it.skipIf(!hasNailRoles)("keeps real surfaces and copied role metadata independent of nail, support and needle seek histories", async () => {
    const hand = await handRig();
    const requests = [
      { pose: "scrape" as const, grip: 0.5, phase: 0.3, nailContact: 0.8, apertureMm: 12, handleRadiusM: 0.0007, wristElevationDeg: 55 },
      { pose: "flick" as const, grip: 1, phase: 0.28, handleRadiusM: 0.0007, wristElevationDeg: 55 },
      { pose: "pinch" as const, grip: 1, phase: 0.5, gripStyle: "side-pinch" as const, handleRadiusM: 0.0007, wristElevationDeg: 55 },
    ];
    for (const request of requests) {
      hand.setSide("right"); hand.pose({ pose: "tripod", grip: 1, phase: 0.3, handleRadiusM: 0.0007, wristElevationDeg: 48 });
      hand.pose({ pose: "scrape", grip: 0, phase: 1, nailContact: 1, apertureMm: 12, handleRadiusM: 0.0007, wristElevationDeg: 60 });
      hand.pose({ pose: "press", grip: 0.5, phase: 0.25 });
      expect(hand.materialContacts().palm_contact!.normalField).toBe("actual-triangle-facet");
      hand.setSide("left"); hand.pose({ pose: "flick", grip: 1, phase: 0.58, handleRadiusM: 0.0007, wristElevationDeg: 50 });
      hand.pose({ pose: "palpate", grip: 0.5, phase: 0.25 });
      expect(hand.materialContacts().index_volar_contact!.normalField).toBe("actual-triangle-facet");
      const fresh = await handRig();
      for (const rig of [hand, fresh]) { rig.setSide("left"); rig.pose(request); expect(rig.contactValid).toBe(true); }
      const materialSnapshot = hand.materialContacts();
      expect(materialSnapshot).toEqual(fresh.materialContacts());
      expect(hand.principalContact().distanceTo(fresh.principalContact())).toBeLessThan(1e-12);
      for (const name of Object.keys(materialSnapshot)) {
        expect(node(hand, name).position.toArray()).toEqual(node(fresh, name).position.toArray());
        expect(node(hand, name).quaternion.toArray()).toEqual(node(fresh, name).quaternion.toArray());
        // Exporter or inspector consumers cannot mutate the next request's source definitions.
        materialSnapshot[name]!.definition.role = "consumer-only";
        const reference = materialSnapshot[name]!.definition.reference;
        if (reference && typeof reference === "object") (reference as { mcpDeg: number }).mcpDeg = -999;
        const cone = materialSnapshot[name]!.definition.normalCone as { faceCoefficients?: Record<string, number> } | undefined;
        if (cone?.faceCoefficients) for (const key of Object.keys(cone.faceCoefficients)) cone.faceCoefficients[key] = -999;
      }
      expect(hand.materialContacts()).toEqual(fresh.materialContacts());
      for (const digit of ["thumb", "index", "middle", "ring", "little"]) {
        const a = node(hand, `${digit}_skin`) as SkinnedMesh, b = node(fresh, `${digit}_skin`) as SkinnedMesh;
        a.skeleton.update(); b.skeleton.update();
        for (let vertex = 0; vertex < a.geometry.getAttribute("position").count; vertex++) {
          expect(a.localToWorld(a.getVertexPosition(vertex, new Vector3())).distanceTo(b.localToWorld(b.getVertexPosition(vertex, new Vector3())))).toBeLessThan(0.000001);
        }
      }
      fresh.dispose();
    }
    hand.dispose();
  });

  it("uses a closed-fist idle pose and narrower MCP spread than the relaxed pose for both hands", async () => {
    const hand = await handRig();
    hand.root.position.set(0.25, 1.10, -0.2);
    hand.root.quaternion.setFromAxisAngle(new Vector3(0.2, 0.6, -0.1).normalize(), 0.8);
    const digits = ["middle", "ring", "little"];
    const lengths = new Map(digits.map((digit) => [digit, finger(hand, digit).lengths]));
    for (const side of ["left", "right"] as const) for (const wristElevationDeg of [35, 55, 70]) {
      hand.setSide(side);
      const measured = new Map<string, ReturnType<typeof finger>[]>();
      for (const idleFingerPose of ["relaxed", "curled"] as const) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.0007, idleFingerPose, wristElevationDeg });
        expect(hand.contactValid).toBe(true);
        const values = digits.map((digit) => finger(hand, digit));
        measured.set(idleFingerPose, values);
        for (let digit = 0; digit < values.length; digit++) {
          const value = values[digit]!;
          expect(value.mcp).toBeGreaterThanOrEqual(35);
          expect(value.mcp).toBeLessThanOrEqual(90);
          expect(value.pip).toBeGreaterThan(40);
          expect(value.pip).toBeLessThanOrEqual(105);
          expect(value.dip).toBeGreaterThan(24);
          expect(value.dip).toBeLessThanOrEqual(65);
          expect(value.spread).toBeGreaterThanOrEqual(0);
          expect(value.spread).toBeLessThan((idleFingerPose === "curled" ? [5, 5, 6] : [7, 8, 10])[digit]!);
          expect(value.planeDrift, `${side}/${idleFingerPose}/${digits[digit]} true IP flexion plane`).toBeLessThan(1e-6);
          for (let segment = 0; segment < 3; segment++) expect(value.lengths[segment]).toBeCloseTo(lengths.get(digits[digit]!)![segment]!, 7);
          if (digit > 0) {
            expect(value.pip).toBeGreaterThanOrEqual(values[digit - 1]!.pip - 1e-5);
            expect(value.dip).toBeGreaterThanOrEqual(values[digit - 1]!.dip - 1e-5);
            expect(value.spread).toBeGreaterThan(values[digit - 1]!.spread);
          }
        }
      }
      for (let digit = 0; digit < digits.length; digit++) {
        const relaxed = measured.get("relaxed")![digit]!, curled = measured.get("curled")![digit]!;
        expect(curled.mcp).toBeGreaterThan(relaxed.mcp);
        expect(curled.pip).toBeGreaterThan(relaxed.pip);
        expect(curled.dip).toBeGreaterThan(relaxed.dip);
        expect(curled.spread).toBeLessThan(relaxed.spread);
      }
    }
    hand.dispose();
  });

  it("retains contact-specific PIP and DIP flexion instead of imposing the free-curl coupling", async () => {
    const hand = await handRig();
    const ratios: number[] = [];
    for (const gripStyle of ["tip-pinch", "side-pinch"] as const) {
      hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.0007, gripStyle });
      expect(hand.contactValid).toBe(true);
      const index = finger(hand, "index");
      expect(index.pip).toBeGreaterThan(30);
      expect(index.pip).toBeLessThanOrEqual(115);
      expect(index.dip).toBeGreaterThanOrEqual(-5);
      expect(index.dip).toBeLessThanOrEqual(95);
      ratios.push(index.dip / index.pip);
    }
    // Contact constraints choose these hinge angles; neither grip is forced onto
    // the 0.7 free-curl prior, or onto an old source asset's particular ratio.
    for (const ratio of ratios) expect(Math.abs(ratio - 0.7)).toBeGreaterThan(0.05);
    hand.dispose();
  });

  it("keeps the real palm and wrist continuous through roll acquisition and finger-walking resets", async () => {
    const hand = await handRig();
    const checkBearing = (elevation: number) => {
      // The selected bearing starts at the authored holding plane. During a
      // staggered release the two pad positions no longer define that fixed point.
      const wrist = hand.wrist().sub(hand.principalContact());
      expect(Math.atan2(wrist.y, Math.hypot(wrist.x, wrist.z)) * degrees).toBeCloseTo(elevation, 2);
      expect(hand.contactAt("handle").length()).toBeLessThan(1e-10);
      expect(hand.contactValid).toBe(true);
    };
    for (const side of ["left", "right"] as const) for (const wristElevationDeg of [35, 55, 70]) for (const sign of [-1, 1]) {
      hand.setSide(side);
      let previous: Vector3 | undefined;
      for (let frame = 0; frame <= 30; frame++) {
        hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.0007, wristElevationDeg, rotationRad: sign * frame / 100 });
        checkBearing(wristElevationDeg);
        const position = hand.model.position.clone();
        if (previous) expect(position.distanceTo(previous), `${side}/${wristElevationDeg}/${sign} palm acquisition`).toBeLessThan(0.00035);
        previous = position;
      }
      // Include both fingers' staggered reset intervals, after several complete one-way turns.
      for (const boundary of [0, 0.02, 0.17, 0.35, 0.50, 0.52, 0.67, 0.85, 1]) {
        const positions: Vector3[] = [];
        for (const offset of [-0.00001, 0, 0.00001]) {
          hand.pose({ pose: "pinch", grip: 1, phase: 0.5, handleRadiusM: 0.0007, wristElevationDeg, rotationRad: sign * (2.4 * (3 + boundary) + offset), continuousRoll: true });
          checkBearing(wristElevationDeg);
          positions.push(hand.model.position.clone());
        }
        expect(positions[0]!.distanceTo(positions[2]!), `${side}/${wristElevationDeg}/${sign} palm reset ${boundary}`).toBeLessThan(0.00002);
      }
    }
    hand.dispose();
  });
});
