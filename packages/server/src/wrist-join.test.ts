import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferAttribute, Group, Matrix3, Mesh, MeshStandardMaterial, Quaternion, Triangle, Vector3, type SkinnedMesh, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildPerson, disposeRig, type PersonRig } from "@clinicalcraft/web/world/npc.js";
import { AvatarRig, type HandSide } from "../web/stage/rig.js";
import { Person, practitionerPlacement } from "../web/stage/cast.js";
import { ArticulatedHand, type FingerPose } from "../web/stage/hand.js";
import { boneTurn } from "../web/stage/kinematics.js";
import { captureFigureWrist, handWristSurface, WristJoin, type FigureWristPart, type HandWristSurface } from "../web/stage/wrist-join.js";

const assetPath = process.env.ACUCRAFT_HAND_ASSET_FIXTURE
  ?? fileURLToPath(new URL("../../../content/world/assets/models/acu-practitioner-hand.glb", import.meta.url));
const point = (attribute: BufferAttribute, index: number) => new Vector3().fromBufferAttribute(attribute, index);
const figureMesh = (rig: PersonRig) => rig.body.children.find((object) => object instanceof Mesh && object.userData.figure && object !== rig.torso) as Mesh;

function sourceFixture() {
  const rig = buildPerson({}, practitionerPlacement("treatment", 1, 0, "wrist-source-topology").options);
  const mesh = figureMesh(rig), originalIndex = Array.from(mesh.geometry.index!.array);
  const positions = (mesh.geometry.getAttribute("position") as BufferAttribute).clone();
  const normals = (mesh.geometry.getAttribute("normal") as BufferAttribute).clone();
  const parts = Object.fromEntries((["left", "right"] as const).map((side) => {
    const part = captureFigureWrist(rig, mesh, side);
    expect(part, `${side} actual long-sleeve topology`).toBeDefined();
    return [side, part!];
  })) as Record<HandSide, FigureWristPart>;
  return { rig, mesh, originalIndex, positions, normals, parts };
}

function expectIndexOwnership(mesh: Mesh, original: readonly number[], excluded: ReadonlySet<number>): void {
  const wanted = original.filter((_, index) => !excluded.has(index - index % 3));
  const displayed = mesh.geometry.index!;
  const { start, count } = mesh.geometry.drawRange;
  const drawnCount = Math.min(displayed.count - start, count);
  expect(drawnCount, "only whole source triangles are removed from the displayed range").toBe(wanted.length);
  expect(wanted.every((vertex, index) => displayed.getX(start + index) === vertex), "retained topology keeps source vertex ownership and winding").toBe(true);
}

function union(...sets: ReadonlySet<number>[]): Set<number> { return new Set(sets.flatMap((set) => [...set])); }

async function detailHand() {
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(readFileSync(assetPath)).buffer, "");
  const hand = new ArticulatedHand(gltf.scene, gltf.animations, "#cba88a");
  const surface = handWristSurface(hand.model);
  expect(surface, "final asset declares its actual 48-vertex wrist interface").toBeDefined();
  return { hand, surface: surface! };
}

/** Independently skin an endpoint offset; subtract translation before inverse-transpose world transport. */
function posedNormal(palm: SkinnedMesh, vertex: number): Vector3 {
  const normal = point(palm.geometry.getAttribute("normal") as BufferAttribute, vertex);
  const endpoint = point(palm.geometry.getAttribute("position") as BufferAttribute, vertex).add(normal);
  palm.applyBoneTransform(vertex, endpoint);
  return endpoint.sub(palm.getVertexPosition(vertex, new Vector3()))
    .applyMatrix3(new Matrix3().getNormalMatrix(palm.matrixWorld)).normalize();
}

function visibleJoin(rig: PersonRig): Group {
  const matches: Group[] = [];
  rig.root.traverse((object) => { if (object instanceof Group && object.userData.figureWristJoin && object.visible) matches.push(object); });
  expect(matches, "exactly the visible detail hand owns a wrist join").toHaveLength(1);
  return matches[0]!;
}

/** Compare all real boundary samples, rather than the wrist landmark or a bounding box. */
function expectSurfaceEndpoints(join: Group, source: Mesh, part: FigureWristPart, surface: HandWristSurface): number[] {
  const bridge = join.getObjectByName("wrist-skin-bridge") as Mesh;
  const positions = bridge.geometry.getAttribute("position") as BufferAttribute;
  const normals = bridge.geometry.getAttribute("normal") as BufferAttribute;
  const uv = bridge.geometry.getAttribute("uv") as BufferAttribute;
  const sourcePosition = source.geometry.getAttribute("position") as BufferAttribute;
  const sourceNormal = source.geometry.getAttribute("normal") as BufferAttribute;
  join.updateWorldMatrix(true, true); source.updateWorldMatrix(true, false);
  surface.palm.updateWorldMatrix(true, false); surface.palm.skeleton.update();
  const columns = surface.ring.length + 1, rows = positions.count / columns;
  expect(Number.isInteger(rows)).toBe(true); expect(rows).toBeGreaterThan(2);
  const bridgeNormal = new Matrix3().getNormalMatrix(bridge.matrixWorld);
  const sourceNormalMatrix = new Matrix3().getNormalMatrix(source.matrixWorld);
  const targetPoints = surface.ring.map((vertex) => surface.palm.getVertexPosition(vertex, new Vector3()).applyMatrix4(surface.palm.matrixWorld));
  const mapping: number[] = [];
  for (let column = 0; column < columns; column++) {
    const along = column % surface.ring.length * part.forearmRing.length / surface.ring.length;
    const low = Math.floor(along), fraction = along - low;
    const a = part.forearmRing[low % part.forearmRing.length]!, b = part.forearmRing[(low + 1) % part.forearmRing.length]!;
    const expectedStart = point(sourcePosition, a).lerp(point(sourcePosition, b), fraction).applyMatrix4(source.matrixWorld);
    const expectedNormal = point(sourceNormal, a).lerp(point(sourceNormal, b), fraction).applyMatrix3(sourceNormalMatrix).normalize();
    expect(point(positions, column).applyMatrix4(bridge.matrixWorld).distanceTo(expectedStart), `source boundary ${column}`).toBeLessThan(0.000001);
    expect(point(normals, column).applyMatrix3(bridgeNormal).normalize().distanceTo(expectedNormal), `source smooth normal ${column}`).toBeLessThan(0.00001);
    const vertex = (rows - 1) * columns + column;
    const end = point(positions, vertex).applyMatrix4(bridge.matrixWorld);
    let nearest = 0;
    for (let index = 1; index < targetPoints.length; index++) if (end.distanceToSquared(targetPoints[index]!) < end.distanceToSquared(targetPoints[nearest]!)) nearest = index;
    expect(end.distanceTo(targetPoints[nearest]!), `actual posed hand boundary ${column}`).toBeLessThan(0.000001);
    const targetVertex = surface.ring[nearest]!;
    expect(point(normals, vertex).applyMatrix3(bridgeNormal).normalize().distanceTo(posedNormal(surface.palm, targetVertex)), `actual posed smooth hand normal ${column}`).toBeLessThan(0.00001);
    const targetUV = surface.palm.geometry.getAttribute("uv");
    const deltaU = uv.getX(vertex) - targetUV.getX(targetVertex);
    expect(Math.abs(deltaU - Math.round(deltaU)), `periodic material U ${column}`).toBeLessThan(0.000001);
    expect(Math.abs(uv.getY(vertex) - targetUV.getY(targetVertex)), `material V ${column}`).toBeLessThan(0.000001);
    mapping.push(nearest);
  }
  expect(new Set(mapping.slice(0, -1)).size, "all hand circumference samples are joined exactly once").toBe(surface.ring.length);
  expect(mapping.at(-1), "only the UV seam repeats a physical endpoint").toBe(mapping[0]);
  for (const attribute of [positions, normals, uv]) expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
  for (let row = 0; row < rows; row++) {
    const start = row * columns;
    const steps = Array.from({ length: columns - 1 }, (_, column) => Math.abs(uv.getX(start + column + 1) - uv.getX(start + column)));
    expect(Math.max(...steps), `row ${row} unwraps material U without an internal texture seam`).toBeLessThan(0.1);
    expect(Math.abs(uv.getX(start + columns - 1) - uv.getX(start)), `row ${row} closes one complete material circumference`).toBeCloseTo(1, 6);
  }
  const indices = bridge.geometry.index!, triangle = new Triangle();
  for (let offset = 0; offset < indices.count; offset += 3) {
    triangle.set(point(positions, indices.getX(offset)), point(positions, indices.getX(offset + 1)), point(positions, indices.getX(offset + 2)));
    expect(triangle.getArea(), `noncollapsed loft triangle ${offset / 3}`).toBeGreaterThan(1e-12);
  }
  const hem = join.getObjectByName("sleeve-annular-hem") as Mesh;
  const hemPosition = hem.geometry.getAttribute("position") as BufferAttribute;
  const hemNormal = hem.geometry.getAttribute("normal") as BufferAttribute;
  const hemNormalMatrix = new Matrix3().getNormalMatrix(hem.matrixWorld);
  for (const [sample, vertex] of part.sleeveRing.entries()) {
    expect(point(hemPosition, sample).applyMatrix4(hem.matrixWorld).distanceTo(point(sourcePosition, vertex).applyMatrix4(source.matrixWorld)), `unmodified sleeve hem ${sample}`).toBeLessThan(0.000001);
    expect(point(hemNormal, sample).applyMatrix3(hemNormalMatrix).normalize().distanceTo(point(sourceNormal, vertex).applyMatrix3(sourceNormalMatrix).normalize()), `sleeve hem normal ${sample}`).toBeLessThan(0.00001);
  }
  return mapping;
}

afterEach(() => vi.restoreAllMocks());

describe("detail wrist ownership and joined surfaces", () => {
  it("captures complete tagged stock hands, separate forearm stations and only their own sleeve caps", () => {
    const f = sourceFixture();
    try {
      const skin = f.rig.skin.find((entry) => entry.mesh === f.mesh)!;
      for (const side of ["left", "right"] as const) {
        const part = f.parts[side], other = f.parts[side === "left" ? "right" : "left"];
        const range = skin.ranges.find(([start, count]) => start === Math.min(...part.handVertices) && count === part.handVertices.size);
        expect(range, `${side} entire source hand tag, including its proximal faces`).toBeDefined();
        expect(part.handVertices.size).toBeGreaterThan(500);
        expect(part.forearmRing).toHaveLength(16); expect(part.forearmDistalRing).toHaveLength(16);
        expect(part.sleeveRing).toHaveLength(10); expect(part.sleeveCapVertices.size).toBe(11);
        expect([...part.handVertices].some((vertex) => other.handVertices.has(vertex))).toBe(false);
        const forearmRange = skin.ranges.find(([start, count]) => start === part.forearmRing[0] && count === 48)!;
        expect(forearmRange, `${side} full three-station source forearm`).toBeDefined();
        const capTriangles: number[] = [];
        for (let offset = 0; offset < f.originalIndex.length; offset += 3) {
          const tri = f.originalIndex.slice(offset, offset + 3);
          const handOwned = tri.some((vertex) => part.handVertices.has(vertex));
          expect(part.handTriangles.has(offset), `${side}/${offset} complete stock-hand face ownership`).toBe(handOwned);
          if (tri.every((vertex) => part.sleeveCapVertices.has(vertex))) capTriangles.push(offset);
          const forearmOwned = tri.some((vertex) => vertex >= forearmRange[0] && vertex < forearmRange[0] + forearmRange[1]);
          expect(part.excludedTriangles.has(offset), `${side}/${offset} exact replacement face ownership`).toBe(handOwned || forearmOwned || capTriangles.includes(offset));
        }
        expect(capTriangles, `${side} whole flat sleeve fan`).toHaveLength(10);
      }
    } finally { disposeRig(f.rig); }
  });

  it("keeps every source forearm vertex at its rigid bone transform during full reach instead of collapsing tissue at the wrist", () => {
    const f = sourceFixture(), animation = new AvatarRig(f.rig);
    f.rig.root.position.set(0.4, 0.05, -0.7); f.rig.root.rotation.y = 0.9;
    try {
      for (const side of ["left", "right"] as const) {
        const armIndex = side === "left" ? 0 : 1, mirror = side === "left" ? 1 : -1;
        const arm = f.rig.skeleton.arms[armIndex];
        const mid = new Vector3(arm.mid[0] * mirror, arm.mid[1], arm.mid[2]);
        const end = new Vector3(arm.end[0] * mirror, arm.end[1], arm.end[2]);
        const target = animation.shoulderAt(side).add(new Vector3(mirror * 0.08, -0.32, 0.16));
        const result = animation.reach(side, target, 1);
        animation.setDetailHand(side, true); animation.tick(16, 0, false);
        const posedMid = f.rig.body.worldToLocal(result.elbow.clone()), posedEnd = f.rig.body.worldToLocal(result.wrist.clone());
        const turn = boneTurn(end.clone().sub(mid), posedEnd.clone().sub(posedMid));
        const start = f.parts[side].forearmRing[0]!;
        const actual = f.mesh.geometry.getAttribute("position") as BufferAttribute;
        for (let vertex = start; vertex < start + 48; vertex++) {
          const expected = point(f.positions, vertex).sub(mid).applyQuaternion(turn).add(posedMid);
          expect(point(actual, vertex).distanceTo(expected), `${side}/${vertex} actual forearm tissue`).toBeLessThan(0.0000003);
        }
        expect(result.wrist.distanceTo(target)).toBeLessThan(1e-7);
        animation.reach(side, null); animation.tick(16, 0, false);
      }
    } finally { animation.dispose(); disposeRig(f.rig); }
  });

  it("hands off whole stock-hand faces immediately and restores either side independently on hiding or ending reach", () => {
    const f = sourceFixture(), animation = new AvatarRig(f.rig);
    const liveIndex = f.mesh.geometry.index!, allocation = liveIndex.array;
    try {
      animation.setDetailHand("left", true);
      expectIndexOwnership(f.mesh, f.originalIndex, f.parts.left.handTriangles);
      animation.setDetailHand("right", true);
      expectIndexOwnership(f.mesh, f.originalIndex, union(f.parts.left.handTriangles, f.parts.right.handTriangles));
      animation.setDetailHand("left", false);
      expectIndexOwnership(f.mesh, f.originalIndex, f.parts.right.handTriangles);
      animation.setDetailHand("left", true);
      animation.reach("right", null);
      expectIndexOwnership(f.mesh, f.originalIndex, f.parts.left.handTriangles);
      animation.reach("left", null);
      expectIndexOwnership(f.mesh, f.originalIndex, new Set());
      expect(f.mesh.geometry.index, "masking retains the GPU index attribute").toBe(liveIndex);
      expect(liveIndex.array, "masking retains its fixed GPU allocation").toBe(allocation);
      expect(Array.from(f.mesh.geometry.getAttribute("position").array)).toEqual(Array.from(f.positions.array));
    } finally { animation.dispose(); disposeRig(f.rig); }
  });

  it("joins actual mirrored posed wrist positions, smooth normals and material UVs to the moving sleeve without changing the source vertices", async () => {
    const f = sourceFixture(), animation = new AvatarRig(f.rig), { hand, surface } = await detailHand();
    const liveIndex = f.mesh.geometry.index!, allocation = liveIndex.array;
    const scene = new Group(); scene.add(f.rig.root, hand.root);
    f.rig.root.position.set(-0.3, 0.1, 0.7); f.rig.root.rotation.y = 0.7;
    const poses: FingerPose[] = [
      { pose: "pinch", gripStyle: "tip-pinch", wristElevationDeg: 35, grip: 1, phase: 0.3, handleRadiusM: 0.0007 },
      { pose: "pinch", gripStyle: "side-pinch", wristElevationDeg: 70, grip: 1, phase: 0.3, handleRadiusM: 0.0007 },
      { pose: "tripod", wristElevationDeg: 48, grip: 1, stabilizerGrip: 1, phase: 0.3, handleRadiusM: 0.0007 },
      { pose: "scrape", wristElevationDeg: 55, grip: 1, phase: 0.3, handleRadiusM: 0.0007 },
      { pose: "flick", wristElevationDeg: 55, grip: 1, phase: 0.28, handleRadiusM: 0.0007 },
    ];
    try {
      for (const side of ["left", "right"] as const) {
        hand.setSide(side);
        const target = animation.shoulderAt(side).add(new Vector3(side === "left" ? 0.08 : -0.08, -0.32, 0.16));
        const initial = animation.reach(side, target, 1);
        const axis = initial.wrist.clone().sub(initial.elbow).normalize();
        const arm = f.rig.skeleton.arms[side === "left" ? 0 : 1], mirror = side === "left" ? 1 : -1;
        const sourceLower = new Vector3((arm.end[0] - arm.mid[0]) * mirror, arm.end[1] - arm.mid[1], arm.end[2] - arm.mid[2]);
        const lower = f.rig.body.worldToLocal(initial.wrist.clone()).sub(f.rig.body.worldToLocal(initial.elbow.clone()));
        const lowerTurn = boneTurn(sourceLower, lower);
        const dorsal = new Vector3(-arm.face[0] * mirror, -arm.face[1], -arm.face[2]).applyQuaternion(lowerTurn).transformDirection(f.rig.body.matrixWorld);
        const baseline = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dorsal);
        for (const pose of poses) {
          hand.pose(pose); expect(hand.contactValid, `${side}/${pose.pose} real hand pose`).toBe(true);
          const localWrist = hand.wristOrientation(new Quaternion()).invert();
          let mapping: number[] | undefined;
          let previousVertices: Vector3[] | undefined, previousDegrees: number | undefined;
          for (const degrees of [84, 85, 86, 179, 180, 181, 182]) {
            const orientation = new Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180).multiply(baseline).multiply(localWrist);
            hand.root.quaternion.copy(orientation);
            hand.root.position.copy(target).sub(hand.wrist().applyQuaternion(orientation));
            animation.reach(side, target, 1, hand.wristOrientation(orientation));
            animation.setDetailHand(side, true, surface); animation.tick(16, 0, false);
            expectIndexOwnership(f.mesh, f.originalIndex, f.parts[side].excludedTriangles);
            const join = visibleJoin(f.rig), current = expectSurfaceEndpoints(join, f.mesh, f.parts[side], surface);
            if (mapping) expect(current, "material correspondence remains fixed across motion and angle wrap").toEqual(mapping);
            mapping = current;
            const bridge = join.getObjectByName("wrist-skin-bridge") as Mesh;
            const bridgePosition = bridge.geometry.getAttribute("position") as BufferAttribute;
            const currentVertices = Array.from({ length: bridgePosition.count }, (_, vertex) => point(bridgePosition, vertex).applyMatrix4(bridge.matrixWorld));
            if (previousVertices && degrees - previousDegrees! === 1) {
              expect(Math.max(...currentVertices.map((value, vertex) => value.distanceTo(previousVertices![vertex]!))), `${side}/${degrees} no loft flip across a one-degree orientation step`).toBeLessThan(0.001);
            }
            previousVertices = currentVertices; previousDegrees = degrees;
            const actualNormals = f.mesh.geometry.getAttribute("normal") as BufferAttribute;
            const wristStation = f.parts[side].forearmRing.map((vertex) => vertex + 32);
            const rolls = wristStation.map((vertex) => {
              const a = point(f.normals, vertex).applyQuaternion(lowerTurn).transformDirection(f.mesh.matrixWorld);
              const b = point(actualNormals, vertex).transformDirection(f.mesh.matrixWorld);
              a.addScaledVector(axis, -a.dot(axis)).normalize(); b.addScaledVector(axis, -b.dot(axis)).normalize();
              return Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b)) * 180 / Math.PI;
            });
            for (const roll of rolls) expect(Math.abs(roll), `${side}/${degrees} source forearm remains within its authored cap`).toBeLessThanOrEqual(85.001);
            expect(Math.max(...rolls), `${side}/${degrees} actual distal roll reaches the requested value or cap`).toBeGreaterThan(Math.min(degrees, 85) - 0.01);
          }
          animation.setDetailHand(side, false);
          expectIndexOwnership(f.mesh, f.originalIndex, new Set());
        }
        animation.reach(side, null); animation.tick(16, 0, false);
      }
      for (const leftMode of [0, 1, 2]) for (const rightMode of [0, 1, 2]) {
        animation.setDetailHand("left", leftMode > 0, leftMode === 2 ? surface : undefined);
        animation.setDetailHand("right", rightMode > 0, rightMode === 2 ? surface : undefined);
        const selected = (part: FigureWristPart, mode: number) => mode === 2 ? part.excludedTriangles : mode === 1 ? part.handTriangles : new Set<number>();
        expectIndexOwnership(f.mesh, f.originalIndex, union(selected(f.parts.left, leftMode), selected(f.parts.right, rightMode)));
        expect(f.mesh.geometry.index, "all nine ownership modes share one GPU index attribute").toBe(liveIndex);
        expect(liveIndex.array, "all nine ownership modes retain its fixed GPU allocation").toBe(allocation);
      }
      animation.reach("right", null); animation.reach("left", null);
      expectIndexOwnership(f.mesh, f.originalIndex, new Set());
    } finally { animation.dispose(); hand.dispose(); disposeRig(f.rig); }
  });

  it("disposes owned join geometry and transition materials while preserving borrowed figure materials and hand textures", async () => {
    const f = sourceFixture(), { hand, surface } = await detailHand();
    const join = new WristJoin(f.mesh, f.parts.left, f.rig.body);
    const borrowedFigure = Array.isArray(f.mesh.material) ? f.mesh.material : [f.mesh.material];
    const borrowedMaterials = [...borrowedFigure, surface.material].map((material) => vi.spyOn(material, "dispose"));
    const borrowedTextures = [...new Set(Object.values(surface.material).filter((value): value is Texture => !!value?.isTexture))].map((texture) => vi.spyOn(texture, "dispose"));
    join.setTarget(surface);
    const skin = join.group.getObjectByName("wrist-skin-bridge") as Mesh, hem = join.group.getObjectByName("sleeve-annular-hem") as Mesh;
    expect(skin.material).toBeInstanceOf(MeshStandardMaterial); expect(skin.material).not.toBe(surface.material);
    expect(hem.material).toBe(f.mesh.material);
    const ownedGeometry = [skin.geometry, hem.geometry].map((geometry) => vi.spyOn(geometry, "dispose"));
    const transition = vi.spyOn(skin.material as MeshStandardMaterial, "dispose");
    try {
      join.setTarget(null);
      expect(join.group.visible).toBe(false); expect(transition).toHaveBeenCalledTimes(1);
      join.dispose();
      expect(join.group.parent).toBeNull();
      for (const spy of ownedGeometry) expect(spy).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledTimes(1);
      for (const spy of [...borrowedMaterials, ...borrowedTextures]) expect(spy).not.toHaveBeenCalled();
    } finally { hand.dispose(); disposeRig(f.rig); }
  });

  it("delegates stock-hand restoration and join cleanup through the production Person lifecycle", () => {
    const person = new Person({}, practitionerPlacement("treatment", 1, 0, "wrist-person-lifecycle"));
    const mesh = figureMesh(person.rig), original = Array.from(mesh.geometry.index!.array);
    const part = captureFigureWrist(person.rig, mesh, "left")!;
    person.setDetailHand("left", true);
    expectIndexOwnership(mesh, original, part.handTriangles);
    person.reach("left", null);
    expectIndexOwnership(mesh, original, new Set());
    const joins: Group[] = [];
    person.rig.root.traverse((object) => { if (object instanceof Group && object.userData.figureWristJoin) joins.push(object); });
    expect(joins).toHaveLength(2);
    const geometryDisposals = joins.flatMap((join) => join.children.map((child) => vi.spyOn((child as Mesh).geometry, "dispose")));
    person.dispose();
    for (const join of joins) expect(join.parent).toBeNull();
    for (const spy of geometryDisposals) expect(spy).toHaveBeenCalledTimes(1);
  });
});
