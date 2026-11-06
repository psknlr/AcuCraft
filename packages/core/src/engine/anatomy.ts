import type { Layer, Region, Structure } from "../schema/anatomy.js";
import type { ChartPoint, ChartPoint3, Distance, Position, Side } from "../schema/common.js";
import type { RegionAnatomy } from "../schema/field.js";
import type { AcupointDefinition, Offset } from "../schema/knowledge.js";
import type { Scenario } from "./scenario.js";

/**
 * Patient-specific anatomy (proposal §5.2–5.3): a region's reference chart, scaled and shifted to this patient,
 * in the configuration their current position puts the region in. Landmarks, segment lengths (hence the cun),
 * structures and tissue depths all follow; nothing here is a universal centimetre value.
 */

export interface PatientRegion {
  region: Region;
  side: Side;
  configuration: string;
  /** +1 when the chart's `u` points lateral on this side; −1 when it points medial; 0 on the midline. */
  lateralSign: 1 | -1 | 0;
  landmark(id: string): ChartPoint | null;
  /** Length of one cun of this segment, for this patient (cm). */
  cunCm(segment: string): number | null;
  segmentCm(segment: string): number | null;
  structures: (Structure & { path: ChartPoint3[] })[];
  layersAt(at: ChartPoint): Layer[];
  /** Is `at` inside the chart's extent (with a small margin)? */
  inChart(at: ChartPoint): boolean;
}

export interface AccessResult {
  accessible: boolean;
  configuration: string;
  reason?: string;
}

/** Can this region and side be reached with the patient in `position`, and in which configuration is it then? */
export function regionAccess(region: Region, side: Side, position: Position): AccessResult {
  const entry = region.access.find((a) => a.position === position && a.sides.includes(side));
  if (entry) return { accessible: true, configuration: entry.configuration };
  const other = region.access.find((a) => a.position === position);
  const reason = other
    ? `the ${side} side of the ${region.title} cannot be reached with the patient ${position}`
    : `the ${region.title} cannot be reached with the patient ${position}`;
  return { accessible: false, configuration: region.defaultConfiguration, reason };
}

function patientAnatomy(sc: Scenario, regionId: string, side: Side): RegionAnatomy {
  const entry = sc.field.patient.anatomy.regions[regionId];
  const base: RegionAnatomy = { scale: { u: 1, v: 1 }, subcutaneousScale: 1, muscleScale: 1, landmarks: {}, structures: {} };
  if (!entry) return base;
  const both = entry.both ?? base;
  const specific = side === "left" ? entry.left : side === "right" ? entry.right : undefined;
  if (!specific) return { ...base, ...both };
  return {
    scale: specific.scale ?? both.scale,
    subcutaneousScale: specific.subcutaneousScale ?? both.subcutaneousScale,
    muscleScale: specific.muscleScale ?? both.muscleScale,
    landmarks: { ...both.landmarks, ...(specific.landmarks ?? {}) },
    structures: { ...both.structures, ...(specific.structures ?? {}) },
  };
}

const thicknessOf = (layers: readonly Layer[], tissue: Layer["tissue"]) => layers.filter((l) => l.tissue === tissue).reduce((n, l) => n + l.thicknessCm, 0);

/** Build the patient's region frame. `configuration` defaults to the one their current position gives. */
export function patientRegion(sc: Scenario, regionId: string, side: Side, configuration: string): PatientRegion {
  const region = sc.bundle.regions.get(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const a = patientAnatomy(sc, regionId, region.laterality === "midline" ? "midline" : side);
  const su = a.scale.u;
  const sv = a.scale.v;
  const lateralSign: 1 | -1 | 0 = region.laterality === "bilateral" ? 1 : side === "left" ? 1 : side === "right" ? -1 : 0;

  const refLayersAt = (at: ChartPoint): Layer[] => {
    const zone = region.tissue.zones
      .filter((z) => Math.hypot(at.u - z.centre.u * su, at.v - z.centre.v * sv) <= z.radiusCm * Math.max(su, sv))
      .sort((x, y) => x.radiusCm - y.radiusCm)[0];
    return zone ? zone.layers : region.tissue.layers;
  };
  const layersAt = (at: ChartPoint): Layer[] =>
    refLayersAt(at).map((l) => (l.tissue === "subcutaneous" ? { ...l, thicknessCm: l.thicknessCm * a.subcutaneousScale } : l.tissue === "muscle" ? { ...l, thicknessCm: l.thicknessCm * a.muscleScale } : l));
  // structures below the soft tissues move with the patient's build
  const adiposityShift = (at: ChartPoint) => {
    const ref = refLayersAt(at);
    return (a.subcutaneousScale - 1) * thicknessOf(ref, "subcutaneous") + (a.muscleScale - 1) * thicknessOf(ref, "muscle");
  };

  const landmarkIn = (id: string, cfg: string): ChartPoint | null => {
    const lm = region.landmarks.find((l) => l.id === id);
    if (!lm) return null;
    const shift = lm.configurations[cfg] ?? { du: 0, dv: 0, dd: 0 };
    const own = a.landmarks[id] ?? { du: 0, dv: 0 };
    return { u: (lm.at.u + shift.du) * su + own.du, v: (lm.at.v + shift.dv) * sv + own.dv };
  };
  const segmentIn = (segId: string, cfg: string): number | null => {
    const seg = region.segments.find((s) => s.id === segId);
    if (!seg) return null;
    const p = landmarkIn(seg.from, cfg);
    const q = landmarkIn(seg.to, cfg);
    if (!p || !q) return null;
    return Math.hypot(q.u - p.u, q.v - p.v);
  };

  const structures = region.structures.map((s) => {
    const shift = s.configurations[configuration] ?? { du: 0, dv: 0, dd: 0 };
    const own = a.structures[s.id] ?? { du: 0, dv: 0, dd: 0 };
    const path = s.path.map((p) => {
      const at = { u: (p.u + shift.du) * su + own.du, v: (p.v + shift.dv) * sv + own.dv };
      return { ...at, d: Math.max(0, p.d + shift.dd + own.dd + adiposityShift(at)) };
    });
    return { ...s, path };
  });

  const [u0, u1] = region.chart.uRange;
  const [v0, v1] = region.chart.vRange;
  return {
    region,
    side,
    configuration,
    lateralSign,
    landmark: (id) => landmarkIn(id, configuration),
    // the cun is a property of the patient's skeleton: measured in the region's reference configuration
    cunCm: (segId) => {
      const seg = region.segments.find((s) => s.id === segId);
      const len = segmentIn(segId, region.defaultConfiguration);
      return seg && len !== null ? len / seg.cun : null;
    },
    segmentCm: (segId) => segmentIn(segId, configuration),
    structures,
    layersAt,
    inChart: (at) => at.u >= Math.min(u0, u1) * su - 1 && at.u <= Math.max(u0, u1) * su + 1 && at.v >= Math.min(v0, v1) * sv - 1 && at.v <= Math.max(v0, v1) * sv + 1,
  };
}

export function distanceCm(frame: PatientRegion, d: Distance): number | null {
  if ("cm" in d) return d.cm;
  const cun = frame.cunCm(d.segment);
  return cun === null ? null : d.cun * cun;
}

function applyOffset(frame: PatientRegion, p: ChartPoint, offset: Offset | undefined): ChartPoint | null {
  if (!offset) return p;
  let { u, v } = p;
  const dist = (d: Distance | undefined) => (d ? distanceCm(frame, d) : 0);
  const lat = dist(offset.lateral);
  const med = dist(offset.medial);
  const cra = dist(offset.cranial);
  const cau = dist(offset.caudal);
  if (lat === null || med === null || cra === null || cau === null) return null;
  const sign = frame.lateralSign === 0 ? 1 : frame.lateralSign;
  u += sign * (lat - med);
  v += cra - cau;
  return { u, v };
}

export interface PointInstance {
  pointId: string;
  side: Side;
  region: string;
  configuration: string;
  /** The patient-specific reference location (the hidden truth the evaluator compares a mark to). */
  position: ChartPoint;
  toleranceCm: number;
  anchors: string[];
  /** The standard locates the point in another configuration than the one the region is in now. */
  configurationMismatch: boolean;
}

/** Locate a standard point on this patient, in the region's current configuration (null: not modelled). */
export function pointInstance(sc: Scenario, point: AcupointDefinition, side: Side, configuration: string): PointInstance | null {
  if (!point.region || !point.localisation) return null;
  if (!sc.field.regions.includes(point.region)) return null;
  const effectiveSide: Side = point.bilateral ? side : "midline";
  const frame = patientRegion(sc, point.region, effectiveSide, configuration);
  const sided = (id: string) => id.replace("{side}", effectiveSide);
  const loc = point.localisation;
  let base: ChartPoint | null = null;
  let anchors: string[] = [];
  if (loc.method === "landmark") {
    base = frame.landmark(sided(loc.landmark));
    anchors = [sided(loc.landmark)];
  } else if (loc.method === "between") {
    const a = frame.landmark(sided(loc.a));
    const b = frame.landmark(sided(loc.b));
    if (a && b) base = { u: a.u + loc.fraction * (b.u - a.u), v: a.v + loc.fraction * (b.v - a.v) };
    anchors = [sided(loc.a), sided(loc.b)];
  } else {
    const from = frame.landmark(sided(loc.from));
    const toward = frame.landmark(sided(loc.toward));
    const dist = distanceCm(frame, loc.distance);
    if (from && toward && dist !== null) {
      const len = Math.hypot(toward.u - from.u, toward.v - from.v) || 1;
      base = { u: from.u + ((toward.u - from.u) / len) * dist, v: from.v + ((toward.v - from.v) / len) * dist };
    }
    anchors = [sided(loc.from), sided(loc.toward)];
  }
  if (!base) return null;
  const position = applyOffset(frame, base, loc.offset);
  if (!position) return null;
  const tol = distanceCm(frame, point.tolerance) ?? 1;
  return {
    pointId: point.id,
    side: effectiveSide,
    region: point.region,
    configuration,
    position,
    toleranceCm: tol,
    anchors,
    configurationMismatch: point.configuration !== undefined && point.configuration !== configuration,
  };
}

/* ------------------------------------------------------------------ */
/* Needle path                                                          */
/* ------------------------------------------------------------------ */

export interface StructureFinding {
  structure: string;
  label: string;
  kind: Structure["kind"];
  hazard: Structure["hazard"];
  consequence: Structure["consequence"];
  /** Closest distance between the needle shaft and the structure's surface (cm; ≤ 0 = contact). */
  clearanceCm: number;
  contact: boolean;
  near: boolean;
}

export interface PathAssessment {
  requestedDepthCm: number;
  /** Depth actually reached along the shaft (shorter when the tip meets bone or the needle runs out). */
  executedDepthCm: number;
  verticalDepthCm: number;
  stoppedBy: "bone" | "needle-length" | null;
  tipTissue: Layer["tissue"] | "beyond";
  /** Tissues the shaft passes through, from the skin down. */
  traversed: Layer["tissue"][];
  pleuraPenetrated: boolean;
  findings: StructureFinding[];
  critical: boolean;
}

const sub = (a: ChartPoint3, b: ChartPoint3) => ({ u: a.u - b.u, v: a.v - b.v, d: a.d - b.d });
const dot = (a: ChartPoint3, b: ChartPoint3) => a.u * b.u + a.v * b.v + a.d * b.d;

/** Shortest distance between segments PQ and RS in 3D. */
export function segmentDistance(p: ChartPoint3, q: ChartPoint3, r: ChartPoint3, s: ChartPoint3): number {
  const d1 = sub(q, p);
  const d2 = sub(s, r);
  const w = sub(p, r);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, w);
  let t: number;
  let u: number;
  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) return Math.sqrt(dot(w, w));
  if (a <= EPS) {
    t = 0;
    u = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, w);
    if (e <= EPS) {
      u = 0;
      t = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      t = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      u = (b * t + f) / e;
      if (u < 0) {
        u = 0;
        t = Math.min(1, Math.max(0, -c / a));
      } else if (u > 1) {
        u = 1;
        t = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const cp = { u: p.u + d1.u * t, v: p.v + d1.v * t, d: p.d + d1.d * t };
  const cq = { u: r.u + d2.u * u, v: r.v + d2.v * u, d: r.d + d2.d * u };
  const diff = sub(cp, cq);
  return Math.sqrt(dot(diff, diff));
}

/** Where the tip of a needle inserted at `entry` ends after `depthCm` along the shaft. */
export function tipOf(entry: ChartPoint, angleDeg: number, azimuthDeg: number, depthCm: number): ChartPoint3 {
  const theta = (angleDeg * Math.PI) / 180;
  const phi = (azimuthDeg * Math.PI) / 180;
  const h = Math.sin(theta) * depthCm;
  return { u: entry.u + h * Math.sin(phi), v: entry.v + h * Math.cos(phi), d: Math.cos(theta) * depthCm };
}

/**
 * Assess a virtual needle path against the patient's region. Layers are read at the entry (the region is
 * locally flat); structures are tubes. A pure function: the caller decides what to block or record.
 */
export function assessPath(frame: PatientRegion, entry: ChartPoint, angleDeg: number, azimuthDeg: number, requestedDepthCm: number, needle: { diameterMm: number; lengthMm: number }): PathAssessment {
  const layers = frame.layersAt(entry);
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const maxShaft = (needle.lengthMm / 10) * 0.9; // a needle is never inserted to its hilt
  let depth = Math.min(requestedDepthCm, maxShaft);
  let stoppedBy: PathAssessment["stoppedBy"] = depth < requestedDepthCm ? "needle-length" : null;
  // walk the layers to find bone and pleura along the vertical
  let top = 0;
  let boneTop: number | null = null;
  let pleuraTop: number | null = null;
  for (const l of layers) {
    if (l.tissue === "bone" && boneTop === null) boneTop = top;
    if (l.tissue === "pleura" && pleuraTop === null) pleuraTop = top;
    top += l.thicknessCm;
  }
  if (boneTop !== null && cos > 0.05 && depth * cos > boneTop) {
    depth = boneTop / cos;
    stoppedBy = "bone";
  }
  const vertical = depth * cos;
  const traversed: Layer["tissue"][] = [];
  let tipTissue: Layer["tissue"] | "beyond" = "beyond";
  top = 0;
  for (const l of layers) {
    if (vertical > top) traversed.push(l.tissue);
    if (vertical > top && vertical <= top + l.thicknessCm) tipTissue = l.tissue;
    top += l.thicknessCm;
  }
  if (stoppedBy === "bone") tipTissue = "bone";
  const pleuraPenetrated = pleuraTop !== null && vertical > pleuraTop;
  const p0: ChartPoint3 = { u: entry.u, v: entry.v, d: 0 };
  const p1 = tipOf(entry, angleDeg, azimuthDeg, depth);
  const needleRadius = needle.diameterMm / 20;
  const findings: StructureFinding[] = [];
  for (const s of frame.structures) {
    let best = Infinity;
    if (s.path.length === 1) best = segmentDistance(p0, p1, s.path[0]!, s.path[0]!);
    for (let i = 0; i + 1 < s.path.length; i++) best = Math.min(best, segmentDistance(p0, p1, s.path[i]!, s.path[i + 1]!));
    const clearance = best - s.radiusCm - needleRadius;
    const contact = clearance <= 0;
    const near = !contact && clearance <= s.uncertaintyCm;
    if (contact || near) findings.push({ structure: s.id, label: s.label, kind: s.kind, hazard: s.hazard, consequence: s.consequence, clearanceCm: clearance, contact, near });
  }
  findings.sort((a, b) => a.clearanceCm - b.clearanceCm);
  const critical = pleuraPenetrated || findings.some((f) => f.contact && f.hazard === "critical");
  return { requestedDepthCm, executedDepthCm: depth, verticalDepthCm: vertical, stoppedBy, tipTissue, traversed, pleuraPenetrated, findings, critical };
}
