import { Group, Matrix3, Matrix4, Mesh, Quaternion, Ray, SkinnedMesh, Triangle, Vector3, type Object3D } from "three";
import { fingerPostureReference, measureFingerMcp, smoothPositiveDistance } from "./hand-physiology.js";
import { needleHandleRadiusAt } from "./needle-shape.js";

type Rotations = [Quaternion, Quaternion, Quaternion];
interface Digit { base: Vector3; a: Vector3; b: Vector3; c: Vector3; h: Vector3; hb: Vector3; restA: number; restB: number }
interface Material { point: Vector3; normal: Vector3; definition: Record<string, unknown> }
interface Facet { index: number; normal: Vector3 }
interface SkinTriangle { triangle: Triangle; normals: [Vector3, Vector3, Vector3]; index: number; vertices: number[] }
export interface NailWorkContact extends Material {
  parent: string;
  surface: string;
  normalField: "skin-bary" | "keratin-edge-cone";
  engaged: boolean;
  engagedWith?: string;
}
export interface NailWorkRig {
  readonly index: Digit;
  readonly thumb: Digit;
  readonly palm: Matrix4;
  readonly wrist: Vector3;
  readonly indexFlat: Material;
  readonly thumbFlat: Material;
  readonly thumbTail: Material;
  readonly nailPoint: Vector3;
  readonly nailVertices: Vector3[];
  readonly nailFacets: Facet[];
  readonly front: Vector3;
  readonly top: Vector3;
  readonly tanPrepIndex: Rotations;
  readonly tanContactIndex: Rotations;
  readonly tanPrepareThumb: Rotations;
  readonly tanClearThumb: Rotations;
  readonly tanPoint: Vector3;
  readonly tanNormal: Vector3;
  readonly tanParentNormal: Vector3;
}
export interface NailWorkSettings {
  pose: "scrape" | "flick";
  wristElevationDeg?: number;
  phase: number;
  nailContact?: number;
  grip: number;
  apertureMm?: number;
}
export interface NailWorkSample {
  valid: boolean;
  modelPosition: Vector3;
  modelQuaternion: Quaternion;
  thumbRotations: Rotations;
  indexRotations: Rotations;
  principalContact: Vector3;
  contacts: Record<string, NailWorkContact>;
}

const rad = Math.PI / 180, Y = new Vector3(0, 1, 0);
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const ease = (v: number) => { const t = clamp(v); return t * t * t * (10 - 15 * t + 6 * t * t); };
const signed = (a: Vector3, b: Vector3, h: Vector3) => Math.atan2(a.clone().cross(b).dot(h), a.dot(b));
const node = (model: Group, name: string): Object3D => { const n = model.getObjectByName(name); if (!n) throw new Error(`Nail work source lacks ${name}`); return n; };
const frame = (point: Vector3, normal: Vector3) => {
  const x = point.clone().normalize(), y = normal.clone().addScaledVector(x, -normal.dot(x)).normalize();
  return new Matrix4().makeBasis(x, y, x.clone().cross(y).normalize());
};
const digit = (model: Group, name: "thumb" | "index", palm: Matrix4): Digit => {
  const labels = name === "thumb" ? ["CMC", "MCP", "IP"] : ["MCP", "PIP", "DIP"];
  const [base, a, b] = labels.map((label) => node(model, `${name}_${label}`).position.clone()) as [Vector3, Vector3, Vector3];
  const c = node(model, `${name}_tip`).position.clone(), h = a.clone().cross(b).normalize();
  if (name !== "thumb" && h.dot(Y.clone().transformDirection(palm).cross(a)) < 0) h.negate();
  const hb = b.clone().cross(c).normalize(); if (hb.dot(h) < 0) hb.negate();
  return { base, a, b, c, h, hb, restA: signed(a, b, h), restB: signed(b, c, hb) };
};
function shape(d: Digit, point: Vector3, normal: Vector3, alpha: number, beta: number) {
  const qa = new Quaternion().setFromAxisAngle(d.h, alpha * rad - d.restA), qb = new Quaternion().setFromAxisAngle(d.hb, beta * rad - d.restB);
  const vector = point.clone().applyQuaternion(qb).add(d.b).applyQuaternion(qa).add(d.a);
  const outward = normal.clone().applyQuaternion(qb).applyQuaternion(qa).normalize();
  return { qa, qb, vector, outward };
}
function transported(d: Digit, material: Material, rotations: Rotations) {
  return {
    point: material.point.clone().applyQuaternion(rotations[2]).add(d.b).applyQuaternion(rotations[1]).add(d.a).applyQuaternion(rotations[0]).add(d.base),
    normal: material.normal.clone().applyQuaternion(rotations[2]).applyQuaternion(rotations[1]).applyQuaternion(rotations[0]).normalize(),
  };
}
function skinTriangles(model: Group, name: "thumb" | "index"): SkinTriangle[] {
  const mesh = node(model, `${name}_skin`), parent = node(model, `${name}_distal`);
  if (!(mesh instanceof SkinnedMesh)) throw new Error("Nail work requires an actual skinned hand");
  const matrix = parent.matrixWorld.clone().invert().multiply(mesh.matrixWorld), normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const p = mesh.geometry.attributes.position!, n = mesh.geometry.attributes.normal!, ids = mesh.geometry.index, joints = mesh.geometry.attributes.skinIndex!, weights = mesh.geometry.attributes.skinWeight!;
  const rigid = (v: number) => { let w = 0; for (let j = 0; j < joints.itemSize; j++) if (mesh.skeleton.bones[joints.getComponent(v, j)]?.name === `${name}_distal`) w += weights.getComponent(v, j); return w > 0.9999; };
  const result: SkinTriangle[] = [];
  for (let i = 0, count = ids?.count ?? p.count; i < count; i += 3) {
    const vertices = [0, 1, 2].map((j) => ids ? ids.getX(i + j) : i + j);
    if (!vertices.every(rigid)) continue;
    const points = vertices.map((v) => new Vector3().fromBufferAttribute(p, v).applyMatrix4(matrix));
    result.push({ index: i / 3, vertices, triangle: new Triangle(points[0]!, points[1]!, points[2]!), normals: vertices.map((v) => new Vector3().fromBufferAttribute(n, v).applyNormalMatrix(normalMatrix)) as [Vector3, Vector3, Vector3] });
  }
  return result;
}
function projectSkin(triangles: SkinTriangle[], requested: Vector3, rayNormal?: Vector3): Material {
  const ray = rayNormal ? new Ray(requested.clone().addScaledVector(rayNormal, 0.02), rayNormal.clone().negate()) : undefined;
  let best: { distance: number; material: Material } | undefined;
  for (const surface of triangles) {
    const p = ray ? ray.intersectTriangle(surface.triangle.a, surface.triangle.b, surface.triangle.c, false, new Vector3()) : surface.triangle.closestPointToPoint(requested, new Vector3());
    if (!p) continue;
    const distance = p.distanceToSquared(ray?.origin ?? requested); if (best && distance >= best.distance) continue;
    const bary = surface.triangle.getBarycoord(p, new Vector3()); if (!bary) continue;
    const normal = surface.normals[0].clone().multiplyScalar(bary.x).addScaledVector(surface.normals[1], bary.y).addScaledVector(surface.normals[2], bary.z).normalize();
    best = { distance, material: { point: p, normal, definition: { primitive: 0, triangleIndex: surface.index, vertexIndices: surface.vertices, barycentric: bary.toArray(), acquisition: ray ? "outward-normal-ray" : "closest-surface" } } };
  }
  if (!best) throw new Error("Actual terminal skin does not support nail-work material");
  return best.material;
}
function balanced(facets: Facet[], first: number, second: number, hinge: Vector3): Vector3 {
  const a = facets.find((f) => f.index === first)?.normal, b = facets.find((f) => f.index === second)?.normal;
  if (!a || !b) throw new Error("Leading nail vertex lost its actual incident facets");
  const ah = a.dot(hinge), bh = b.dot(hinge), weight = -bh / (ah - bh);
  if (!(weight >= 0 && weight <= 1)) throw new Error("Nail contact is outside the actual positive normal cone");
  return a.clone().multiplyScalar(weight).addScaledVector(b, 1 - weight).normalize();
}
function coneDefinition(rig: NailWorkRig, normal: Vector3) {
  const f = rig.nailFacets; let coefficients: Record<number, number> | undefined;
  for (let i = 0; i < f.length && !coefficients; i++) for (let j = i + 1; j < f.length && !coefficients; j++) for (let k = j + 1; k < f.length; k++) {
    const fs = [f[i]!, f[j]!, f[k]!], m = new Matrix3().set(fs[0]!.normal.x, fs[1]!.normal.x, fs[2]!.normal.x, fs[0]!.normal.y, fs[1]!.normal.y, fs[2]!.normal.y, fs[0]!.normal.z, fs[1]!.normal.z, fs[2]!.normal.z);
    if (Math.abs(m.determinant()) < 1e-12) continue;
    const c = normal.clone().applyMatrix3(m.invert()).toArray();
    if (Math.min(...c) >= -1e-8) { coefficients = Object.fromEntries(fs.map((face, n) => [face.index, Math.max(0, c[n]!)])); break; }
  }
  const maximum = Math.max(...rig.nailVertices.map((v) => v.clone().sub(rig.nailPoint).dot(normal)));
  return { valid: !!coefficients && maximum <= 1e-9, definition: { role: "index-leading-keratin", vertexIndex: 97, incidentFaceIndices: f.map((face) => face.index), normalCone: { definition: "positive-combination-of-actual-incident-outward-facet-normals", faceCoefficients: coefficients ?? {} }, wholeNailSupportPlaneMaximumExcessM: maximum } };
}
function solveThumb(d: Digit, material: Material, target: Vector3, normal: Vector3): Rotations | undefined {
  const D = target.clone().sub(d.base), length = D.length(), dot = D.dot(normal);
  const errors = (a: number, b: number) => { const s = shape(d, material.point, material.normal, a, b); return [s.vector.length() - length, s.vector.dot(s.outward) - dot] as const; };
  let a = 32, b = 25;
  for (let iteration = 0; iteration < 35; iteration++) {
    const e = errors(a, b); if (Math.hypot(...e) < 1e-12) break;
    const step = 0.001, ea = errors(a + step, b), eb = errors(a, b + step), j = [(ea[0] - e[0]) / step, (eb[0] - e[0]) / step, (ea[1] - e[1]) / step, (eb[1] - e[1]) / step], determinant = j[0]! * j[3]! - j[1]! * j[2]!;
    if (Math.abs(determinant) < 1e-16) return undefined;
    let da = (-e[0] * j[3]! + j[1]! * e[1]) / determinant, db = (-j[0]! * e[1] + e[0] * j[2]!) / determinant;
    const scale = Math.max(1, Math.abs(da) / 10, Math.abs(db) / 10); da /= scale; db /= scale; a += da; b += db;
    if (a < -5 || a > 85 || b < -5 || b > 95) return undefined;
  }
  if (Math.hypot(...errors(a, b)) > 1e-7) return undefined;
  const s = shape(d, material.point, material.normal, a, b), opposition = new Quaternion().setFromRotationMatrix(frame(D, normal).multiply(frame(s.vector, s.outward).transpose()));
  const raw = Math.abs(2 * Math.atan2(new Vector3(opposition.x, opposition.y, opposition.z).dot(d.a.clone().normalize()), opposition.w)), twist = Math.min(raw, 2 * Math.PI - raw);
  if (opposition.angleTo(new Quaternion()) > 120 * rad || twist > 30 * rad) return undefined;
  return [opposition, s.qa, s.qb];
}

/** Capture immutable source geometry once, before any role moves its material aliases. */
export function createNailWorkRig(model: Group): NailWorkRig | undefined {
  const palmNode = model.getObjectByName("palm_frame");
  if (!palmNode || ![-1, 1].includes(Number(palmNode.userData.contactFrameHorizontalBranch)) || !model.getObjectByName("index_nail_edge_contact")) return undefined;
  model.updateMatrixWorld(true);
  const inverseModel = model.matrixWorld.clone().invert(), palm = inverseModel.clone().multiply(palmNode.matrixWorld), index = digit(model, "index", palm), thumb = digit(model, "thumb", palm);
  const indexFlat = projectSkin(skinTriangles(model, "index"), node(model, "index_pad_contact").position);
  const thumbTriangles = skinTriangles(model, "thumb"), thumbAlias = node(model, "thumb_pad_contact");
  const rawThumbNormal = Y.clone().applyQuaternion(thumbAlias.quaternion).normalize(), along = thumb.c.clone().addScaledVector(rawThumbNormal, -thumb.c.dot(rawThumbNormal)).normalize();
  // Tan prepares on the rounded volar pulp, so opposition keeps the thumb knuckle palmward.
  const across = rawThumbNormal.clone().cross(along).normalize();
  const thumbFlat = projectSkin(thumbTriangles, thumbAlias.position.clone().addScaledVector(along, -0.002).addScaledVector(across, -0.0032), rawThumbNormal);
  if (thumbFlat.normal.dot(rawThumbNormal) < 0.5) throw new Error("Tan preparation must stay on the volar thumb pulp");
  const thumbTail = projectSkin(thumbTriangles, thumbAlias.position.clone().addScaledVector(along, 0.00465), rawThumbNormal);
  const nail = node(model, "index_nail"); if (!(nail instanceof Mesh) || !nail.geometry.index || nail.geometry.attributes.position!.count <= 97) throw new Error("Nail work requires an exported closed keratin mesh");
  const local = node(model, "index_distal").matrixWorld.clone().invert().multiply(nail.matrixWorld), vertices = Array.from({ length: nail.geometry.attributes.position!.count }, (_, i) => nail.getVertexPosition(i, new Vector3()).applyMatrix4(local)), point = vertices[97]!.clone(), facets: Facet[] = [];
  for (let i = 0; i < nail.geometry.index.count; i += 3) { const ids = [0, 1, 2].map((j) => nail.geometry.index!.getX(i + j)); if (ids.includes(97)) facets.push({ index: i / 3, normal: new Triangle(vertices[ids[0]!]!, vertices[ids[1]!]!, vertices[ids[2]!]!).getNormal(new Vector3()) }); }
  const front = balanced(facets, 432, 479, index.h), top = balanced(facets, 168, 214, index.h);
  const tanPrepIndex = [...fingerPostureReference(index.base, index.a, index.b, index.c, palm, { mcpDeg: 50, pipDeg: 95, dipDeg: 55 }).rotations] as Rotations;
  const tanContactIndex = [...fingerPostureReference(index.base, index.a, index.b, index.c, palm, { mcpDeg: 60, pipDeg: 85, dipDeg: 45 }).rotations] as Rotations;
  const prep = transported(index, indexFlat, tanPrepIndex), tanPrepareThumb = solveThumb(thumb, thumbFlat, prep.point, prep.normal.clone().negate()), tanClearThumb = solveThumb(thumb, thumbFlat, prep.point.clone().addScaledVector(prep.normal, 0.003), prep.normal.clone().negate());
  if (!tanPrepareThumb || !tanClearThumb) throw new Error("True skin-to-skin Tan preparation is outside the fixed hand workspace");
  const wrist = node(model, "wrist").getWorldPosition(new Vector3()).applyMatrix4(inverseModel), at = transported(index, { point, normal: front, definition: {} }, tanContactIndex), t = transported(index, { point, normal: top, definition: {} }, tanContactIndex), V = wrist.clone().sub(at.point);
  let lambda = Math.atan2(-V.dot(at.normal), V.dot(t.normal)); while (lambda < 0) lambda += Math.PI;
  lambda = clamp(lambda, 22 * rad, Math.PI / 2);
  const tanParentNormal = front.clone().multiplyScalar(Math.cos(lambda)).addScaledVector(top, Math.sin(lambda)).normalize(), tanNormal = transported(index, { point, normal: tanParentNormal, definition: {} }, tanContactIndex).normal;
  return { index, thumb, palm, wrist, indexFlat, thumbFlat, thumbTail, nailPoint: point, nailVertices: vertices, nailFacets: facets, front, top, tanPrepIndex, tanContactIndex, tanPrepareThumb, tanClearThumb, tanPoint: at.point, tanNormal, tanParentNormal };
}

function arbitraryContactFrame(point: Vector3, normal: Vector3, wrist: Vector3, target: Vector3, targetNormal: Vector3, elevation: number) {
  const V = wrist.clone().sub(point), align = new Quaternion().setFromUnitVectors(normal, targetNormal), v = V.clone().applyQuaternion(align), offset = Y.dot(targetNormal) * targetNormal.dot(v), c = Y.dot(v) - offset, s = Y.dot(targetNormal.clone().cross(v)), ratio = (V.length() * Math.sin(elevation * rad) - offset) / Math.hypot(c, s);
  if (Math.abs(ratio) > 1 + 1e-10) return undefined;
  const Q = new Quaternion().setFromAxisAngle(targetNormal, Math.atan2(s, c) + Math.acos(clamp(ratio, -1, 1))).multiply(align);
  return { Q, T: target.clone().sub(point.clone().applyQuaternion(Q)) };
}
function indexAt(rig: NailWorkRig, Q: Quaternion, T: Vector3, target: Vector3, normal: Vector3, beta: number) {
  const d = rig.index, inverse = Q.clone().invert(), D = target.clone().sub(T).applyQuaternion(inverse).sub(d.base), qb = new Quaternion().setFromAxisAngle(d.hb, beta * rad - d.restB), K = rig.nailPoint.clone().applyQuaternion(qb).add(d.b), ah = d.a.dot(d.h), kh = K.dot(d.h), a = d.a.dot(K) - ah * kh, b = d.a.dot(d.h.clone().cross(K)), rhs = (D.lengthSq() - d.a.lengthSq() - K.lengthSq()) / 2 - ah * kh, ratio = rhs / Math.hypot(a, b);
  if (Math.abs(ratio) > 1 + 1e-10) return undefined;
  const center = Math.atan2(b, a), offset = Math.acos(clamp(ratio, -1, 1));
  for (const sign of [-1, 1]) {
    let angle = center + sign * offset, alpha = (d.restA + angle) / rad;
    while (alpha > 180) { alpha -= 360; angle -= Math.PI * 2; } while (alpha < -180) { alpha += 360; angle += Math.PI * 2; }
    if (alpha < -5 || alpha > 115) continue;
    const qa = new Quaternion().setFromAxisAngle(d.h, angle), S = K.clone().applyQuaternion(qa).add(d.a), qm = new Quaternion().setFromAxisAngle(d.h, signed(S, D, d.h)), N = normal.clone().applyQuaternion(inverse).applyQuaternion(qm.clone().invert()).applyQuaternion(qa.clone().invert()).applyQuaternion(qb.clone().invert()).normalize(), c = rig.front.dot(rig.top), u = (N.dot(rig.front) - c * N.dot(rig.top)) / (1 - c * c), v = (N.dot(rig.top) - c * N.dot(rig.front)) / (1 - c * c), mcp = measureFingerMcp(d.a.clone().applyQuaternion(qm), d.h.clone().applyQuaternion(qm), rig.palm);
    return { rotations: [qm, qa, qb] as Rotations, normal: N, lambda: Math.atan2(v, u), valid: mcp.valid && mcp.flexionDeg >= -20 && mcp.flexionDeg <= 90 && Math.abs(mcp.spreadDeg) <= 20 && Math.abs(mcp.hingeTiltDeg) <= 5 };
  }
  return undefined;
}
function sampleGua(rig: NailWorkRig, settings: NailWorkSettings): NailWorkSample | undefined {
  const E = clamp(settings.wristElevationDeg ?? 55, 50, 60), ip = 70 - E, d = rig.thumb, elevation = (mcp: number) => { const s = shape(d, rig.thumbTail.point, rig.thumbTail.normal, mcp, ip), p = s.vector.clone().add(d.base), V = rig.wrist.clone().sub(p); return { ...s, p, V, E: Math.asin(clamp(-V.dot(s.outward) / V.length(), -1, 1)) / rad }; };
  let lo = 0, hi = 55, left = elevation(lo); if ((left.E - E) * (elevation(hi).E - E) > 0) return undefined;
  for (let i = 0; i < 45; i++) { const mid = (lo + hi) / 2, value = elevation(mid); if ((left.E - E) * (value.E - E) <= 0) hi = mid; else { lo = mid; left = value; } }
  const s = elevation((lo + hi) / 2), align = new Quaternion().setFromUnitVectors(s.outward, new Vector3(0, -1, 0)), v = s.V.clone().applyQuaternion(align), Q = new Quaternion().setFromAxisAngle(Y, Math.atan2(v.z, v.x)).multiply(align), principalContact = new Vector3(0, 0.0125, 0), T = principalContact.clone().sub(s.p.clone().applyQuaternion(Q)), B = rig.index.base.clone().applyQuaternion(Q).add(T), radial = new Vector3(B.x, 0, B.z).normalize(), y = (-8 + 6 * clamp(settings.nailContact ?? settings.phase)) / 1000, target = radial.clone().multiplyScalar(needleHandleRadiusAt(y)).setY(y), normal = radial.clone().negate().setY(0.0016).normalize();
  let index = indexAt(rig, Q, T, target, normal, 60);
  if (!index) return undefined;
  {
    let low = 30, high = 95, a = indexAt(rig, Q, T, target, normal, low), b = indexAt(rig, Q, T, target, normal, high);
    if (!a || !b) return undefined;
    if (a.lambda > 22 * rad) return undefined;
    if ((a.lambda - 22 * rad) * (b.lambda - 22 * rad) > 0) return undefined;
    for (let i = 0; i < 35; i++) { const mid = (low + high) / 2, value = indexAt(rig, Q, T, target, normal, mid); if (!value) return undefined; if ((a.lambda - 22 * rad) * (value.lambda - 22 * rad) <= 0) high = mid; else { low = mid; a = value; } }
    // C2 upper max keeps the actual leading normal inside its legal half-space.
    const root = (low + high) / 2, beta = 60 + smoothPositiveDistance(root - 60, 0.5);
    index = indexAt(rig, Q, T, target, normal, beta); if (!index) return undefined;
  }
  const cone = coneDefinition(rig, index.normal), engaged = clamp(settings.grip) >= 0.999999, opening = (1 - clamp(settings.grip)) * Math.max(0.0015, clamp(settings.apertureMm ?? 2, 0, 12) / 1000), indexRotations = index.rotations.map((q) => q.clone()) as Rotations;
  if (opening > 0) {
    const source = transported(rig.index, { point: rig.nailPoint, normal: index.normal, definition: {} }, indexRotations).point.sub(rig.index.base), axis = rig.index.h.clone();
    // Choose the actual outward arc. The opposite hinge direction also eventually
    // increases radial distance, after sweeping through the needle axis.
    if (axis.clone().cross(source).applyQuaternion(Q).dot(radial) < 0) axis.negate();
    const distance = (angle: number) => {
      const p = source.clone().applyAxisAngle(axis, angle).add(rig.index.base).applyQuaternion(Q).add(T);
      return Math.hypot(p.x, p.z) - needleHandleRadiusAt(p.y);
    };
    const heldMcp = measureFingerMcp(rig.index.a.clone().applyQuaternion(indexRotations[0]), rig.index.h.clone().applyQuaternion(indexRotations[0]), rig.palm);
    const probe = indexRotations[0].clone().premultiply(new Quaternion().setFromAxisAngle(axis, rad));
    const flexes = measureFingerMcp(rig.index.a.clone().applyQuaternion(probe), rig.index.h.clone().applyQuaternion(probe), rig.palm).flexionDeg > heldMcp.flexionDeg;
    let a = 0, b = Math.min(35, flexes ? 90 - heldMcp.flexionDeg : heldMcp.flexionDeg + 20) * rad;
    if (!(b > 0) || distance(b) < opening) return undefined;
    for (let i = 0; i < 30; i++) { const m = (a + b) / 2; if (distance(m) < opening) a = m; else b = m; }
    indexRotations[0].premultiply(new Quaternion().setFromAxisAngle(axis, (a + b) / 2));
  }
  // A tail brace releases by a small CMC swing. The aperture belongs to the working
  // index nail; the thumb only needs a genuine 1.5 mm escape from the needle tail.
  const thumbRotation = new Quaternion();
  if (!engaged) {
    const S = s.p.clone().sub(d.base), sourceUp = Y.clone().applyQuaternion(Q.clone().invert()), axis = S.clone().cross(sourceUp).normalize(), advance = (angle: number) => S.clone().applyAxisAngle(axis, angle).sub(S).dot(sourceUp), required = (1 - clamp(settings.grip)) * 0.0015;
    let a = 0, b = 15 * rad; if (advance(b) < required) return undefined;
    for (let i = 0; i < 30; i++) { const mid = (a + b) / 2; if (advance(mid) < required) a = mid; else b = mid; }
    thumbRotation.setFromAxisAngle(axis, (a + b) / 2);
  }
  const actualMcp = measureFingerMcp(rig.index.a.clone().applyQuaternion(indexRotations[0]), rig.index.h.clone().applyQuaternion(indexRotations[0]), rig.palm);
  const validMcp = actualMcp.valid && actualMcp.flexionDeg >= -20 && actualMcp.flexionDeg <= 90 && Math.abs(actualMcp.spreadDeg) <= 20 && Math.abs(actualMcp.hingeTiltDeg) <= 5;
  return { valid: index.valid && validMcp && cone.valid, modelPosition: T, modelQuaternion: Q, thumbRotations: [thumbRotation, s.qa, s.qb], indexRotations, principalContact, contacts: {
    thumb_pad_contact: { ...rig.thumbTail, point: rig.thumbTail.point.clone(), normal: rig.thumbTail.normal.clone(), parent: "thumb_distal", surface: "thumb_skin", normalField: "skin-bary", definition: { ...rig.thumbTail.definition, role: "thumb-tail-brace", tipwardMm: 4.65, releaseClearanceM: 0.0015 }, engaged, engagedWith: "needle-tail" },
    index_nail_edge_contact: { point: rig.nailPoint.clone(), normal: index.normal, definition: cone.definition, parent: "index_distal", surface: "index_nail", normalField: "keratin-edge-cone", engaged, engagedWith: "needle-handle" },
  } };
}
function sampleTan(rig: NailWorkRig, settings: NailWorkSettings): NailWorkSample | undefined {
  const E = clamp(settings.wristElevationDeg ?? 55, 50, 60), p = clamp(settings.phase), grip = clamp(settings.grip), principalContact = new Vector3(0, 0, needleHandleRadiusAt(0)), outward = new Vector3(0, 0.0016, -1).normalize(), presentation = arbitraryContactFrame(rig.tanPoint, rig.tanNormal, rig.wrist, principalContact, outward, E);
  if (!presentation) return undefined;
  const extend = p <= 0.08 ? 0 : p <= 0.28 ? ease((p - 0.08) / 0.2) : p <= 0.5 ? 1 - ease((p - 0.28) / 0.22) : 0;
  const clear = p <= 0.08 ? ease(p / 0.08) : p <= 0.5 ? 1 : p <= 0.58 ? 1 - ease((p - 0.5) / 0.08) : 0;
  const indexRotations = rig.tanPrepIndex.map((q, i) => q.clone().slerp(rig.tanContactIndex[i]!, extend * grip)) as Rotations;
  const thumbRotations = rig.tanPrepareThumb.map((q, i) => q.clone().slerp(rig.tanClearThumb[i]!, 1 - (1 - clear) * grip)) as Rotations;
  const cone = coneDefinition(rig, rig.tanParentNormal), prepare = clear < 1e-8 && grip >= 0.999999, contact = extend >= 0.999999 && grip >= 0.999999;
  return { valid: cone.valid, modelPosition: presentation.T, modelQuaternion: presentation.Q, thumbRotations, indexRotations, principalContact, contacts: {
    thumb_pad_contact: { ...rig.thumbFlat, point: rig.thumbFlat.point.clone(), normal: rig.thumbFlat.normal.clone(), parent: "thumb_distal", surface: "thumb_skin", normalField: "skin-bary", definition: { ...rig.thumbFlat.definition, role: "thumb-index-prepare" }, engaged: prepare, engagedWith: "index_pad_contact" },
    index_pad_contact: { ...rig.indexFlat, point: rig.indexFlat.point.clone(), normal: rig.indexFlat.normal.clone(), parent: "index_distal", surface: "index_skin", normalField: "skin-bary", definition: { ...rig.indexFlat.definition, role: "index-thumb-prepare" }, engaged: prepare, engagedWith: "thumb_pad_contact" },
    index_nail_edge_contact: { point: rig.nailPoint.clone(), normal: rig.tanParentNormal.clone(), parent: "index_distal", surface: "index_nail", normalField: "keratin-edge-cone", definition: cone.definition, engaged: contact, engagedWith: "needle-handle" },
  } };
}

/** Return real joint and material poses; callers apply legacy-child cancellation and mirroring. */
export function sampleNailWork(rig: NailWorkRig, settings: NailWorkSettings): NailWorkSample | undefined {
  return settings.pose === "scrape" ? sampleGua(rig, settings) : sampleTan(rig, settings);
}
