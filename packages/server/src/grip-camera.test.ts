import { BoxGeometry, BufferGeometry, Float32BufferAttribute, FrontSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Quaternion, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { GRIP_VIEWS, clearGripShot, gripShot, type HandInspectionFrame } from "../web/stage/director.js";

const frame = (): HandInspectionFrame => ({
  contact: new Vector3(0.1, 0.83, -0.2), wrist: new Vector3(0.18, 0.94, -0.2),
  palmNormal: new Vector3(0.8, -0.6, 0), radial: new Vector3(0, 0, 1),
  surfaceNormal: new Vector3(0, 1, 0), center: new Vector3(0.14, 0.885, -0.2), radius: 0.09,
});

describe("whole-hand inspection views", () => {
  it("keeps the actual hand bounds, wrist and needle entry in frame across landscape and portrait views", () => {
    const input = frame(), center = input.center!;
    const points = [input.contact, input.wrist, input.contact.clone().addScaledVector(input.surfaceNormal!, -0.04)];
    for (let latitude = 0; latitude <= 12; latitude++) for (let longitude = 0; longitude < 24; longitude++) {
      const a = latitude / 12 * Math.PI, b = longitude / 24 * Math.PI * 2;
      points.push(center.clone().add(new Vector3(Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)).multiplyScalar(input.radius)));
    }
    for (const aspect of [16 / 9, 4 / 3, 3 / 4]) for (const view of GRIP_VIEWS) {
      const shot = gripShot(input, view, aspect), camera = new PerspectiveCamera(shot.fov, aspect, 0.02, 10);
      camera.position.copy(shot.eye); camera.lookAt(shot.at); camera.updateMatrixWorld(true);
      for (const point of points) {
        const ndc = point.clone().project(camera);
        expect(Math.abs(ndc.x), `${view}/${aspect} horizontal crop`).toBeLessThan(0.91);
        expect(Math.abs(ndc.y), `${view}/${aspect} vertical crop`).toBeLessThan(0.91);
        expect(ndc.z).toBeGreaterThan(-1); expect(ndc.z).toBeLessThan(1);
      }
    }
  });

  it("provides distinct radial, three-quarter and palmar views while keeping the camera outside the patient", () => {
    const input = frame();
    for (const rotation of [new Quaternion(), new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.7, 0.2).normalize(), 1.1)]) {
      const transformed: HandInspectionFrame = {
        contact: input.contact.clone().applyQuaternion(rotation), wrist: input.wrist.clone().applyQuaternion(rotation),
        palmNormal: input.palmNormal.clone().applyQuaternion(rotation), radial: input.radial.clone().applyQuaternion(rotation),
        surfaceNormal: input.surfaceNormal!.clone().applyQuaternion(rotation), center: input.center!.clone().applyQuaternion(rotation), radius: input.radius,
      };
      const directions = GRIP_VIEWS.map((view) => {
        const shot = gripShot(transformed, view);
        expect(shot.eye.clone().sub(transformed.contact).dot(transformed.surfaceNormal!)).toBeGreaterThan(0.03);
        const direction = shot.eye.clone().sub(shot.at).normalize();
        expect(direction.dot(transformed.surfaceNormal!)).toBeGreaterThanOrEqual(0.33999);
        return direction;
      });
      for (let i = 0; i < directions.length; i++) for (let j = i + 1; j < directions.length; j++) expect(directions[i]!.angleTo(directions[j]!)).toBeGreaterThan(0.08);
    }
  });

  it("follows the mirrored thumb side and leaves the articulated landmarks unchanged", () => {
    const right = frame(), left = frame(); left.radial.negate();
    for (const view of GRIP_VIEWS) {
      const a = gripShot(right, view), b = gripShot(left, view);
      expect(a.eye.x).toBeCloseTo(b.eye.x, 10);
      expect(a.eye.y).toBeCloseTo(b.eye.y, 10);
      expect(a.eye.z - a.at.z).toBeCloseTo(-(b.eye.z - b.at.z), 10);
    }
    expect(right).toEqual(frame());
  });

  it("keeps finite views for coincident landmarks and absent directions", () => {
    const input = { contact: new Vector3(), wrist: new Vector3(), palmNormal: new Vector3(), radial: new Vector3(), surfaceNormal: new Vector3(), radius: 0 };
    for (const view of GRIP_VIEWS) {
      const shot = gripShot(input, view);
      expect([...shot.eye.toArray(), ...shot.at.toArray()]).toSatisfy((values: number[]) => values.every(Number.isFinite));
    }
  });

  it("sees the real moved sleeve triangles despite disabled picking and stale rest bounds", () => {
    const input = frame(); input.visibilityPoints = [input.contact, input.wrist];
    const original = gripShot(input, "palmar"), geometry = new BoxGeometry(0.12, 0.12, 0.12, 6, 6, 6);
    geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    const midpoint = original.eye.clone().lerp(original.at, 0.5), position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) position.setXYZ(i, position.getX(i) + midpoint.x, position.getY(i) + midpoint.y, position.getZ(i) + midpoint.z);
    position.needsUpdate = true;
    const sleeve = new Mesh(geometry, new MeshBasicMaterial({ side: FrontSide }));
    const disabledPicking = () => {}; sleeve.raycast = disabledPicking;
    const aim = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial({ visible: false }));
    const clear = clearGripShot(original, [sleeve, aim]);
    expect(clear.inspectionBlocked).toBe(0);
    expect(clear.eye.distanceTo(original.eye)).toBeGreaterThan(0.02);
    expect(clear.eye.clone().sub(input.contact).dot(input.surfaceNormal!)).toBeGreaterThan(0.03);
    expect(sleeve.raycast).toBe(disabledPicking); expect(sleeve.material.side).toBe(FrontSide);
    for (const point of clear.inspectionPoints!) {
      const ray = new Raycaster(clear.eye, point.clone().sub(clear.eye).normalize(), 0.002, clear.eye.distanceTo(point) - 0.001), hits: never[] = [];
      Mesh.prototype.raycast.call(sleeve, ray, hits);
      expect(hits).toHaveLength(0);
    }
    geometry.dispose(); sleeve.material.dispose(); aim.geometry.dispose(); aim.material.dispose();
  });

  it("sees the posed holding fingers past an idle finger even when the external contact rays are clear", () => {
    const shot = gripShot(frame(), "three-quarter"), hand = new Group();
    const material = new MeshBasicMaterial(), skin = new BoxGeometry(0.01, 0.01, 0.01);
    const sideways = new Vector3().crossVectors(shot.eye.clone().sub(shot.at), new Vector3(0, 1, 0)).normalize();
    const digits = ["thumb", "index"].map((digit, i) => {
      const mesh = new Mesh(skin, material);
      mesh.name = `${digit}_skin`; mesh.position.copy(shot.at).addScaledVector(sideways, i ? 0.009 : -0.009);
      hand.add(mesh);
      return { digit, points: [mesh.position.clone()] };
    });
    const ring = new Mesh(new BoxGeometry(0.045, 0.045, 0.045), material);
    ring.name = "ring_skin"; ring.position.copy(shot.at).lerp(shot.eye, 0.3); hand.add(ring);
    try {
      const clear = clearGripShot({ ...shot, gripSubjects: { hand, digits, handlePoints: [shot.at] } }, []);
      expect(clear.inspectionBlocked).toBe(0);
      expect(clear.eye.distanceTo(shot.eye)).toBeGreaterThan(0.03);
      expect(clear.inspectionDetails?.visibleParts).toEqual([
        { part: "thumb", seen: 1, total: 1 }, { part: "index", seen: 1, total: 1 }, { part: "handle", seen: 1, total: 1 },
      ]);
    } finally { skin.dispose(); ring.geometry.dispose(); material.dispose(); }
  });

  it("moves an eye out of a sleeve instead of missing the sleeve's back-facing exit wall", () => {
    const original = gripShot(frame(), "side"), sleeve = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), new MeshBasicMaterial({ side: FrontSide }));
    sleeve.position.copy(original.eye); sleeve.updateMatrixWorld(true);
    const clear = clearGripShot(original, [sleeve]);
    expect(clear.inspectionBlocked).toBe(0);
    expect(clear.eye.distanceTo(original.eye)).toBeGreaterThan(0.07);
    expect(sleeve.material.side).toBe(FrontSide);
    sleeve.geometry.dispose(); sleeve.material.dispose();
  });

  it.each([true, false])("ignores undrawn prefix and tail triangles while respecting drawn occluders (indexed=%s)", (indexed) => {
    const base = gripShot(frame(), "palmar");
    const original = { ...base, inspectionPoints: [base.at], inspectionOptionalPoints: [] };
    const along = original.at.clone().sub(original.eye).normalize();
    const across = new Vector3().crossVectors(along, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(across, along).normalize();
    const triangle = (fraction: number, sideways = 0) => {
      const center = original.eye.clone().lerp(original.at, fraction).addScaledVector(across, sideways);
      return [center.clone().addScaledVector(across, -0.09).addScaledVector(up, -0.09),
        center.clone().addScaledVector(across, 0.09).addScaledVector(up, -0.09), center.clone().addScaledVector(up, 0.09)];
    };
    // One fixed-capacity buffer: both ends obstruct the requested sightline; the middle is far away.
    const vertices = [...triangle(0.4), ...triangle(0.5, 2), ...triangle(0.65)];
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(vertices.flatMap((point) => point.toArray()), 3));
    if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const material = new MeshBasicMaterial(), mesh = new Mesh(geometry, material);
    mesh.name = "masked-figure-source";
    try {
      geometry.setDrawRange(3, 3);
      const clear = clearGripShot(original, [mesh]);
      expect(clear.inspectionBlocked).toBe(0);
      expect(clear.eye.distanceTo(original.eye), "neither hidden prefix nor hidden tail may redirect the camera").toBeLessThan(1e-10);
      for (const start of [0, 6]) {
        geometry.setDrawRange(start, 3);
        const avoided = clearGripShot(original, [mesh]);
        expect(avoided.inspectionBlocked).toBe(0);
        expect(avoided.eye.distanceTo(original.eye), `drawn triangle at ${start} still obstructs the requested sightline`).toBeGreaterThan(0.02);
      }
      geometry.setDrawRange(0, 0);
      const empty = clearGripShot(original, [mesh]);
      expect(empty.inspectionBlocked).toBe(0);
      expect(empty.eye.distanceTo(original.eye), "zero drawn triangles cannot obstruct the camera").toBeLessThan(1e-10);
      expect(geometry.drawRange).toEqual({ start: 0, count: 0 });
      expect(geometry.getAttribute("position").count).toBe(9);
      expect(geometry.index?.count ?? 9).toBe(9);
    } finally { geometry.dispose(); material.dispose(); }
  });

  it("includes an ordinary PBR wrist join in camera clearance even when its picking is disabled", () => {
    const original = gripShot(frame(), "side"), join = new Group(); join.name = "wrist-join";
    const bridge = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), new MeshStandardMaterial({ roughness: 0.7 }));
    bridge.name = "wrist-skin-bridge";
    bridge.position.copy(original.eye);
    const disabledPicking = () => {}; bridge.raycast = disabledPicking;
    join.add(bridge); join.updateMatrixWorld(true);
    try {
      const clear = clearGripShot(original, [join]);
      expect(clear.inspectionBlocked).toBe(0);
      expect(clear.eye.distanceTo(original.eye), "the displayed bridge's real exit wall must affect clearance").toBeGreaterThan(0.07);
      expect(bridge.raycast).toBe(disabledPicking);
      expect(bridge.visible).toBe(true); expect(bridge.material.visible).toBe(true);
    } finally { bridge.geometry.dispose(); bridge.material.dispose(); }
  });

  it("keeps the needle visibly oblique instead of looking down its shaft", () => {
    const input = frame(), base = gripShot(input, "palmar");
    const shot = clearGripShot({ ...base, eye: input.contact.clone().add(new Vector3(0, 0.5, 0)), needleAxis: new Vector3(0, 1, 0) }, []);
    expect(Math.abs(shot.eye.clone().sub(input.contact).normalize().y)).toBeLessThanOrEqual(0.8);
    expect(shot.eye.clone().sub(input.contact).dot(input.surfaceNormal!)).toBeGreaterThan(0.03);
    expect(shot.inspectionBlocked).toBe(0);
  });

  it("uses a distinct clear inspection angle when the previous angle is already occupied", () => {
    const base = gripShot(frame(), "three-quarter"), first = clearGripShot(base, []);
    const previous = first.eye.clone().sub(first.at).normalize();
    const second = clearGripShot({ ...base, inspectionAvoidDirections: [previous] }, []);
    expect(second.eye.clone().sub(second.at).angleTo(previous)).toBeGreaterThanOrEqual(15 * Math.PI / 180);
    expect(second.inspectionBlocked).toBe(0);
  });
});
