import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, Vector3 } from "three";
import { MANIPULATION_TECHNIQUES } from "@acucraft/core";
import { exteriorGeometry, exteriorShape, updateExteriorGeometry } from "../web/stage/needle-shape.js";
import { NeedleLayer, type NeedleSpec } from "../web/stage/needles.js";

beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }) }) }));
afterEach(() => vi.unstubAllGlobals());

const spec = (): NeedleSpec => ({ id: "n1", target: "BL23:left", site: { p: new Vector3(0, 0.85, 0), n: new Vector3(0, 1, 0), uDir: new Vector3(1, 0, 0), vDir: new Vector3(0, 0, -1), bare: true }, angleDeg: 25, azimuthDeg: 75, depthCm: 2, length: 0.04 });

describe("exterior-only needle choreography", () => {
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
});
