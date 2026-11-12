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

/** The reference body of a chart drawn without one, and the BMI assumed for a patient whose weight is not given. */
export const DEFAULT_REFERENCE_BODY = { heightCm: 170, bmi: 22.5 } as const;

/** A woman's muscle thickness relative to a man's of the same height and build (a schematic ratio). */
const FEMALE_MUSCLE = 0.85;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The build of a patient in a region their scenario does not author, scaled from the region's reference body:
 * length by height; girth by height and BMI; subcutaneous fat by BMI; muscle by height, BMI and — when the reference
 * body's sex is known and differs from the patient's — sex. A patient without a recorded weight is taken as BMI 22.5.
 */
export function derivedBuild(sc: Scenario, region: Region): RegionAnatomy {
  const p = sc.case.patient as { sex?: string; heightCm?: number; weightKg?: number };
  const ref = region.reference ?? DEFAULT_REFERENCE_BODY;
  const height = p.heightCm ?? (p.sex === "female" ? 160 : 172);
  const bmi = p.weightKg ? p.weightKg / (height / 100) ** 2 : DEFAULT_REFERENCE_BODY.bmi;
  const size = height / ref.heightCm;
  const relBmi = bmi / ref.bmi;
  const refSex = region.reference?.sex;
  const sex = refSex && (p.sex === "female" || p.sex === "male") && p.sex !== refSex ? (p.sex === "female" ? FEMALE_MUSCLE : 1 / FEMALE_MUSCLE) : 1;
  return {
    scale: { u: round3(size * Math.pow(relBmi, 0.25)), v: round3(size) },
    subcutaneousScale: round3(clamp(Math.pow(relBmi, 1.5), 0.4, 3)),
    muscleScale: round3(clamp(size * sex * Math.pow(relBmi, 0.25), 0.5, 1.6)),
    landmarks: {},
    structures: {},
  };
}

function patientAnatomy(sc: Scenario, regionId: string, side: Side): RegionAnatomy {
  const entry = sc.field.patient.anatomy.regions[regionId];
  const base: RegionAnatomy = { scale: { u: 1, v: 1 }, subcutaneousScale: 1, muscleScale: 1, landmarks: {}, structures: {} };
  if (!entry) {
    const region = sc.bundle.regions.get(regionId);
    return region ? derivedBuild(sc, region) : base;
  }
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


/** Build the patient's region frame. `configuration` defaults to the one their current position gives. */
export function patientRegion(sc: Scenario, regionId: string, side: Side, configuration: string): PatientRegion {
  const region = sc.bundle.regions.get(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const a = patientAnatomy(sc, regionId, region.laterality === "midline" ? "midline" : side);
  const su = a.scale.u;
  const sv = a.scale.v;
  const lateralSign: 1 | -1 | 0 = region.laterality === "bilateral" ? 1 : side === "left" ? 1 : side === "right" ? -1 : 0;

  const refLayersAt = (at: ChartPoint): Layer[] => {
    // the smallest zone containing the point; among equal ones (a depth grid) the nearest centre
    const dist = (z: (typeof region.tissue.zones)[number]) => Math.hypot(at.u - z.centre.u * su, at.v - z.centre.v * sv);
    const zone = region.tissue.zones
      .filter((z) => dist(z) <= z.radiusCm * Math.max(su, sv))
      .sort((x, y) => x.radiusCm - y.radiusCm || dist(x) - dist(y))[0];
    return zone ? zone.layers : region.tissue.layers;
  };
  const layersAt = (at: ChartPoint): Layer[] =>
    refLayersAt(at).map((l) => (l.tissue === "subcutaneous" ? { ...l, thicknessCm: l.thicknessCm * a.subcutaneousScale } : l.tissue === "muscle" ? { ...l, thicknessCm: l.thicknessCm * a.muscleScale } : l));
  // a structure moves with the patient's build: by the change in the fat and muscle above it (not below it)
  const adiposityShift = (at: ChartPoint, depthCm: number) => {
    let top = 0;
    let shift = 0;
    for (const l of refLayersAt(at)) {
      if (top >= depthCm) break;
      const above = Math.min(l.thicknessCm, depthCm - top);
      if (l.tissue === "subcutaneous") shift += (a.subcutaneousScale - 1) * above;
      else if (l.tissue === "muscle") shift += (a.muscleScale - 1) * above;
      top += l.thicknessCm;
    }
    return shift;
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
      const d = p.d + shift.dd + own.dd;
      return { ...at, d: Math.max(0, d + adiposityShift(at, d)) };
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
  /** The site of a group point, or null. */
  site: string | null;
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

/**
 * The targets a point offers, each as a single-site definition: the point itself, or — for a group point with sites
 * (Sishencong, Jiaji, Shixuan …) — each of its sites, on its own chart, with its own construction and tolerance.
 * A point without a localisation offers none.
 */
export function pointTargets(point: AcupointDefinition): { site: string | null; label: string | null; def: AcupointDefinition }[] {
  if (point.siteLocalisations) {
    return point.siteLocalisations.map((x) => ({
      site: x.id,
      label: x.label,
      def: { ...point, region: x.region ?? point.region, localisation: x.localisation, tolerance: x.tolerance ?? point.tolerance, configuration: x.configuration ?? point.configuration, siteLocalisations: undefined },
    }));
  }
  return point.localisation && point.region ? [{ site: null, label: null, def: point }] : [];
}

/** Locate a standard point (one site of a group point) on this patient, in its region's current configuration (null:
 * not modelled, or a group point without a site named). */
export function pointInstance(sc: Scenario, point: AcupointDefinition, side: Side, configuration: string, site?: string | null): PointInstance | null {
  const target = pointTargets(point).find((t) => t.site === (point.siteLocalisations ? (site ?? undefined) : null));
  if (!target) return null;
  const inst = locate(sc, target.def, side, configuration, 0);
  return inst && { ...inst, site: target.site };
}

/** How many `point:` anchors may be followed from one point (a chain, never a cycle). */
const MAX_ANCHOR_DEPTH = 4;

function locate(sc: Scenario, point: AcupointDefinition, side: Side, configuration: string, depth: number): PointInstance | null {
  if (!point.region || !point.localisation) return null;
  if (!sc.bundle.regions.has(point.region)) return null;
  const region = point.region;
  const effectiveSide: Side = point.bilateral ? side : "midline";
  const frame = patientRegion(sc, region, effectiveSide, configuration);
  const sided = (id: string) => id.replace("{side}", effectiveSide);
  // a landmark of this chart, or another point where it is placed on this patient (across a seam if need be)
  const anchor = (ref: string): ChartPoint | null => {
    if (!ref.startsWith("point:")) return frame.landmark(sided(ref));
    const other = sc.bundle.acupoints.get(ref.slice("point:".length));
    if (!other?.region || other.siteLocalisations || depth >= MAX_ANCHOR_DEPTH) return null;
    if (other.region === region) return locate(sc, other, side, configuration, depth + 1)?.position ?? null;
    const seam = seamMap(sc, other.region, region, side, configuration);
    const at = seam && locate(sc, other, side, seam.fromConfiguration, depth + 1);
    return seam && at ? seam.map(at.position) : null;
  };
  const loc = point.localisation;
  let base: ChartPoint | null = null;
  let anchors: string[] = [];
  if (loc.method === "landmark") {
    base = anchor(loc.landmark);
    anchors = [sided(loc.landmark)];
  } else if (loc.method === "between") {
    const a = anchor(loc.a);
    const b = anchor(loc.b);
    if (a && b) base = { u: a.u + loc.fraction * (b.u - a.u), v: a.v + loc.fraction * (b.v - a.v) };
    anchors = [sided(loc.a), sided(loc.b)];
  } else {
    const from = anchor(loc.from);
    const toward = anchor(loc.toward);
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
    site: null,
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
/* Seams between charts                                                 */
/* ------------------------------------------------------------------ */

export interface SeamMap {
  from: string;
  to: string;
  /** The configuration of `from` that matches `to` in the configuration asked for. */
  fromConfiguration: string;
  /** Carry a chart point of `from` to `to`, on this patient. */
  map(p: ChartPoint): ChartPoint;
  /** Scale of the fitted map (cm on `to` per cm on `from`). */
  scale: number;
  /** The pairs: where `to` has them, where the map puts `from`'s, and the distance between the two (cm). */
  pairs: { here: string; there: string; at: ChartPoint; mapped: ChartPoint; residualCm: number }[];
}

type SeamRegion = { id: string; laterality: Region["laterality"]; defaultConfiguration: string; seams: Region["seams"] };

/**
 * The seam joining two charts, oriented from `from` to `to` (null: they do not meet): its pairs as the landmark on
 * `from` and the landmark on `to` (`{side}` read as `side`), and the configuration of `from` that goes with a
 * configuration of `to`. Works on regions or on the reference library's public view of them.
 */
export function orientSeam(from: SeamRegion, to: SeamRegion, side: Side): { pairs: { from: string; to: string }[]; reversed: boolean; fromConfiguration(toConfiguration: string): string } | null {
  const own = to.seams.find((m) => m.region === from.id);
  const theirs = own ? undefined : from.seams.find((m) => m.region === to.id);
  if (!own && !theirs) return null;
  const sided = (id: string) => id.replace("{side}", side);
  return {
    pairs: own ? own.pairs.map((p) => ({ from: sided(p.there), to: sided(p.here) })) : theirs!.pairs.map((p) => ({ from: sided(p.here), to: sided(p.there) })),
    // declared on `from`: the map is fitted the way the seam is declared and inverted, so the two directions agree
    reversed: !own,
    fromConfiguration: (cfg) =>
      own ? (own.configurations[cfg] ?? from.defaultConfiguration) : (Object.entries(theirs!.configurations).find(([, there]) => there === cfg)?.[0] ?? from.defaultConfiguration),
  };
}

/** +1 when `u` points lateral on this side of a chart of this laterality, −1 when it points medial. */
export function lateralSignOf(laterality: Region["laterality"], side: Side): 1 | -1 {
  return laterality === "midline" && side === "right" ? -1 : 1;
}

/**
 * The similarity (scale, rotation, translation; no reflection) that best carries the `from` positions of a seam's
 * pairs onto their `to` positions, by least squares — after turning each chart so that `u` points lateral on this
 * side (`lateralFrom`, `lateralTo`: see `lateralSignOf`). `reversed` (from `orientSeam`): fit `to` onto `from`, as
 * the seam is declared, and invert it. Null when the pairs do not span any distance.
 */
export function fitSeam(pairs: readonly { from: ChartPoint; to: ChartPoint }[], lateralFrom: 1 | -1, lateralTo: 1 | -1, reversed = false): { map(p: ChartPoint): ChartPoint; scale: number } | null {
  if (reversed) {
    const back = fitSeamOnce(pairs.map((p) => ({ from: p.to, to: p.from })), lateralTo, lateralFrom);
    return back && { map: back.inverse, scale: 1 / back.scale };
  }
  const fit = fitSeamOnce(pairs, lateralFrom, lateralTo);
  return fit && { map: fit.map, scale: fit.scale };
}

function fitSeamOnce(pairs: readonly { from: ChartPoint; to: ChartPoint }[], lateralFrom: 1 | -1, lateralTo: 1 | -1): { map(p: ChartPoint): ChartPoint; inverse(p: ChartPoint): ChartPoint; scale: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  // complex numbers z = u·lateral + i·v on each chart
  const f = pairs.map((p) => ({ u: p.from.u * lateralFrom, v: p.from.v }));
  const t = pairs.map((p) => ({ u: p.to.u * lateralTo, v: p.to.v }));
  const mean = (xs: ChartPoint[]) => ({ u: xs.reduce((a, x) => a + x.u, 0) / n, v: xs.reduce((a, x) => a + x.v, 0) / n });
  const mf = mean(f);
  const mt = mean(t);
  // a = Σ (t − mt)·conj(f − mf) / Σ |f − mf|²
  let re = 0;
  let im = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const fu = f[i]!.u - mf.u;
    const fv = f[i]!.v - mf.v;
    const tu = t[i]!.u - mt.u;
    const tv = t[i]!.v - mt.v;
    re += tu * fu + tv * fv;
    im += tv * fu - tu * fv;
    norm += fu * fu + fv * fv;
  }
  if (norm < 1e-9) return null;
  const ar = re / norm;
  const ai = im / norm;
  const a2 = ar * ar + ai * ai;
  return {
    scale: Math.sqrt(a2),
    map: (p) => {
      const fu = p.u * lateralFrom - mf.u;
      const fv = p.v - mf.v;
      return { u: (mt.u + ar * fu - ai * fv) / lateralTo, v: mt.v + ai * fu + ar * fv };
    },
    // z = (z' − mt) / a + mf
    inverse: (p) => {
      const tu = p.u * lateralTo - mt.u;
      const tv = p.v - mt.v;
      return { u: (mf.u + (ar * tu + ai * tv) / a2) / lateralFrom, v: mf.v + (ar * tv - ai * tu) / a2 };
    },
  };
}

/** The map that carries points of region `from` to region `to` across their seam, for this patient, side and `to`
 * configuration (null: the charts do not meet). */
export function seamMap(sc: Scenario, from: string, to: string, side: Side, toConfiguration: string): SeamMap | null {
  const rf = sc.bundle.regions.get(from);
  const rt = sc.bundle.regions.get(to);
  if (!rf || !rt) return null;
  const seam = orientSeam(rf, rt, side);
  if (!seam) return null;
  const fromConfiguration = seam.fromConfiguration(toConfiguration);
  const ff = patientRegion(sc, from, side, fromConfiguration);
  const ft = patientRegion(sc, to, side, toConfiguration);
  const pairs: { here: string; there: string; from: ChartPoint; to: ChartPoint }[] = [];
  for (const p of seam.pairs) {
    const a = ff.landmark(p.from);
    const b = ft.landmark(p.to);
    if (!a || !b) return null;
    pairs.push({ here: p.to, there: p.from, from: a, to: b });
  }
  const fit = fitSeam(pairs, lateralSignOf(rf.laterality, side), lateralSignOf(rt.laterality, side), seam.reversed);
  if (!fit) return null;
  return {
    from,
    to,
    fromConfiguration,
    map: fit.map,
    scale: fit.scale,
    pairs: pairs.map((p) => {
      const mapped = fit.map(p.from);
      return { here: p.here, there: p.there, at: p.to, mapped, residualCm: Math.hypot(mapped.u - p.to.u, mapped.v - p.to.v) };
    }),
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
  /** Hazardous layers the tip reached (an organ, the spinal canal, the peritoneum …), from the skin down. */
  layersReached: { tissue: Layer["tissue"]; label: string; hazard: "critical" | "caution"; depthCm: number }[];
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
  const layersReached: PathAssessment["layersReached"] = [];
  top = 0;
  for (const l of layers) {
    if (l.hazard && vertical > top) layersReached.push({ tissue: l.tissue, label: l.label ?? l.tissue, hazard: l.hazard, depthCm: top });
    top += l.thicknessCm;
  }
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
  const critical = pleuraPenetrated || layersReached.some((l) => l.hazard === "critical") || findings.some((f) => f.contact && f.hazard === "critical");
  return { requestedDepthCm, executedDepthCm: depth, verticalDepthCm: vertical, stoppedBy, tipTissue, traversed, pleuraPenetrated, layersReached, findings, critical };
}
