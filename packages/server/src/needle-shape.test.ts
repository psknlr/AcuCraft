import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTexture, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { MANIPULATION_TECHNIQUES } from "@acucraft/core";
import { exteriorGeometry, exteriorShape, updateExteriorGeometry } from "../web/stage/needle-shape.js";
import { NeedleLayer, type NeedleSpec } from "../web/stage/needles.js";
import { NeedleProcedure } from "../web/stage/procedure.js";
import type { Person } from "../web/stage/cast.js";

beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }) }) }));
afterEach(() => vi.unstubAllGlobals());

const spec = (): NeedleSpec => ({ id: "n1", target: "BL23:left", site: { p: new Vector3(0, 0.85, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, -1), bare: true }, angleDeg: 25, azimuthDeg: 75, depthCm: 2, length: 0.04 });

describe("exterior-only needle choreography", () => {
  it("advances the wire crown along the handle as it turns around the shaft", () => {
    const layer = new NeedleLayer();
    layer.sync([spec()], 0, false);
    const handle = layer.group.getObjectByName("needle-handle")!.children[0] as Mesh;
    const map = (handle.material as MeshStandardMaterial).normalMap;
    expect(map).toBeInstanceOf(DataTexture);
    const { data, width, height } = (map as DataTexture).image;
    const axial = (u: number, v: number) => data[4 * (v * height * width + u * width) + 1]!;
    // At a fixed height, opposite sides of the winding reflect in different directions.
    expect(Math.abs(axial(0, .25) - axial(.5, .25))).toBeGreaterThan(80);
    // A quarter revolution advances by a quarter pitch on the same wire flank.
    expect(axial(.25, .5)).toBe(axial(0, .25));
    expect(map!.generateMipmaps).toBe(true);
    layer.clear();
  });

  it("preserves shaft length at zero, tiny, and normal exposed lengths without moving the entry", () => {
    for (const length of [0, 1e-7, 0.002, 0.02, 0.1]) for (const lateral of [0, 0.004, -0.004]) {
      const shape = exteriorShape(length, { x: lateral, z: -lateral }, { x: 8 * Math.PI / 180, z: -8 * Math.PI / 180 });
      expect(shape.points[0]!.length()).toBe(0);
      const arc = shape.points.slice(1).reduce((sum, p, i) => sum + p.distanceTo(shape.points[i]!), 0);
      expect(arc).toBeCloseTo(length, 9);
      expect(shape.tangent.x / shape.tangent.y).toBeCloseTo(Math.tan(8 * Math.PI / 180), 10);
      expect(shape.tangent.z / shape.tangent.y).toBeCloseTo(-Math.tan(8 * Math.PI / 180), 10);
      expect([...shape.points.flatMap((p) => p.toArray()), ...shape.tangent.toArray()].every(Number.isFinite)).toBe(true);
      const geometry = exteriorGeometry();
      updateExteriorGeometry(geometry, shape.points);
      expect([...geometry.getAttribute("position").array].every(Number.isFinite)).toBe(true);
      geometry.dispose();
    }
  });

  it("keeps the tip on the approved centerline while catalogue gestures bend the exposed shaft", () => {
    const layer = new NeedleLayer();
    const s = spec();
    layer.sync([s], 0, false);
    layer.group.updateMatrixWorld(true);
    const root = layer.group.getObjectByName("needle:n1")!;
    const point = root.getObjectByName("needle-tip") as Mesh;
    const inwardAxis = new Vector3(0, -1, 0).applyQuaternion(root.quaternion);
    for (const entry of MANIPULATION_TECHNIQUES.filter((t) => t.context === "retained")) {
      for (const progress of [0, 0.11, 0.27, 0.45, 0.67, 0.91, 1]) {
        layer.poseTechnique("n1", entry.id, progress * 4000, { durationMs: 4000, cycles: 2, strokeMm: 3, lateralMm: 4, tiltDeg: 8, rotationDeg: 180 });
        root.updateMatrixWorld(true);
        const tip = point.getWorldPosition(new Vector3());
        const offset = tip.clone().sub(s.site.p);
        const axial = offset.dot(inwardAxis);
        expect(axial, entry.id).toBeGreaterThanOrEqual(0.017 - 1e-8);
        expect(axial, entry.id).toBeLessThanOrEqual(0.02 + 1e-8);
        expect(offset.addScaledVector(inwardAxis, -axial).length(), entry.id).toBeLessThan(1e-8);
        expect(layer.grip("n1")!.point.toArray().every(Number.isFinite)).toBe(true);
      }
    }
    // Cone vertices extend back up the shaft, never beyond the approved tip origin.
    const vertices = point.geometry.getAttribute("position");
    for (let i = 0; i < vertices.count; i++) expect(vertices.getY(i)).toBeGreaterThanOrEqual(-1e-9);
    layer.clearTechnique("n1");
    layer.tick(0, 5000);
    root.updateMatrixWorld(true);
    expect(point.getWorldPosition(new Vector3()).distanceTo(s.site.p.clone().addScaledVector(inwardAxis, 0.02))).toBeLessThan(1e-8);
    layer.clear();
  });

  it("uses the recorded diameter for both shaft sections and the pointed tip", () => {
    const layer = new NeedleLayer(), needle = { ...spec(), diameterMm: 0.2 };
    for (const diameterMm of [0.2, 0.4]) {
      needle.diameterMm = diameterMm;
      layer.sync([needle], 0, false);
      layer.tick(0, 0);
      layer.group.updateMatrixWorld(true);
      const root = layer.group.getObjectByName("needle:n1")!;
      const axis = new Vector3(0, 1, 0).applyQuaternion(root.quaternion), origin = root.getWorldPosition(new Vector3());
      for (const name of ["internal-shaft", "needle-tip", "external-shaft"]) {
        const group = root.getObjectByName(name)!;
        const mesh = (group instanceof Mesh ? group : group.children.find((child) => child instanceof Mesh)) as Mesh;
        let radius = 0;
        for (let vertex = 0; vertex < mesh.geometry.getAttribute("position").count; vertex++) {
          const offset = mesh.localToWorld(mesh.getVertexPosition(vertex, new Vector3())).sub(origin);
          radius = Math.max(radius, offset.addScaledVector(axis, -offset.dot(axis)).length());
        }
        expect(radius, `${name}/${diameterMm} mm`).toBeCloseTo(diameterMm / 2000, 8);
      }
    }
    layer.clear();
  });

  it("samples the accepted clinical stroke and one-way rotation parameters, and stops both motion paths", () => {
    const layer = new NeedleLayer(), needle = spec();
    layer.sync([needle], 0, false);
    const root = layer.group.getObjectByName("needle:n1")!, tip = root.getObjectByName("needle-tip")!;
    const inward = new Vector3(0, -1, 0).applyQuaternion(root.quaternion);
    const depth = () => { root.updateMatrixWorld(true); return tip.getWorldPosition(new Vector3()).sub(needle.site.p).dot(inward); };
    layer.work("n1", { technique: "lift-thrust", strokeMm: 2, frequencyHz: 2, durationSeconds: 4 }, 0);
    layer.tick(0, 125);
    expect(depth()).toBeCloseTo(0.021, 8);
    layer.tick(0, 375);
    expect(depth()).toBeCloseTo(0.019, 8);
    layer.work("n1", { technique: "rotate", rotationDeg: 90, rotationDirection: "clockwise", frequencyHz: 2, durationSeconds: 4 }, 1000);
    layer.tick(0, 1500);
    expect(root.children[0]!.rotation.y).toBeCloseTo(-Math.PI / 2, 8);
    layer.stopWork();
    expect(root.children[0]!.rotation.y).toBe(0);
    expect(depth()).toBeCloseTo(0.02, 8);
    layer.poseTechnique("n1", "yao", 450, { durationMs: 1800, lateralMm: 4, tiltDeg: 8 });
    layer.stopWork();
    expect(depth()).toBeCloseTo(0.02, 8);
    expect(layer.transitions()).toEqual([]);
    layer.clear();
  });

  it("keeps the complete clinical action queued until its recorded operation duration has elapsed", () => {
    const layer = new NeedleLayer();
    layer.sync([spec()], 0, false);
    const actor = { isMoving: false, holder: new Group(), shoulderAt: () => new Vector3(0.2, 1.3, 0),
      reach: (_side: string, wrist: Vector3 | null) => ({ wrist: wrist?.clone() ?? new Vector3(), elbow: new Vector3(), reachable: true }) };
    const procedure = new NeedleProcedure(layer, () => actor as unknown as Person, () => {});
    const work = vi.spyOn(layer, "work");
    const first = { technique: "rotate", frequencyHz: 2, rotationDeg: 45, durationSeconds: 4 };
    procedure.workAction("n1", first);
    procedure.workAction("n1", { technique: "lift-thrust", strokeMm: 2, frequencyHz: 1, durationSeconds: 2 });
    procedure.tick(0); procedure.tick(1071);
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenLastCalledWith("n1", expect.objectContaining(first), 1070);
    procedure.tick(4000); procedure.tick(4001); procedure.tick(5072);
    expect(work).toHaveBeenCalledTimes(1);
    procedure.tick(5921); procedure.tick(5930); procedure.tick(7001);
    expect(work).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenLastCalledWith("n1", expect.objectContaining({ technique: "lift-thrust", durationSeconds: 2 }), 7000);
    procedure.dispose(); layer.clear();
  });
});
