import type { ChartPoint, Distance, Offset, referenceLibrary } from "@acucraft/core";

type Library = ReturnType<typeof referenceLibrary>;
type Side = "left" | "right" | "midline";

/**
 * Locate a standard point from what an agent has observed on the patient — palpated landmark positions and measured
 * segment lengths — using the public construction of the point (proportional bone measurement). This is what a
 * practitioner does with a tape and their fingers; it never reads the engine's hidden reference.
 */

export interface Requirements {
  region: string;
  side: Side;
  landmarks: string[];
  segments: string[];
}

export function requirements(lib: Library, pointId: string, side: Side): Requirements | null {
  const p = lib.points.find((x) => x.id === pointId);
  if (!p?.region || !p.localisation) return null;
  const region = lib.regions.find((r) => r.id === p.region);
  if (!region) return null;
  const s: Side = p.bilateral ? side : "midline";
  const sided = (id: string) => id.replace("{side}", s);
  const loc = p.localisation;
  const landmarks = loc.method === "landmark" ? [sided(loc.landmark)] : loc.method === "between" ? [sided(loc.a), sided(loc.b)] : [sided(loc.from), sided(loc.toward)];
  const dists: (Distance | undefined)[] = [loc.method === "along" ? loc.distance : undefined, loc.offset?.lateral, loc.offset?.medial, loc.offset?.cranial, loc.offset?.caudal];
  const segments = [...new Set(dists.filter((d): d is { cun: number; segment: string } => !!d && "segment" in d).map((d) => d.segment))];
  return { region: region.id, side: region.laterality === "midline" ? s : s, landmarks, segments };
}

export function constructPoint(lib: Library, pointId: string, side: Side, landmarks: ReadonlyMap<string, ChartPoint>, segmentCm: ReadonlyMap<string, number>): ChartPoint | null {
  const p = lib.points.find((x) => x.id === pointId);
  if (!p?.region || !p.localisation) return null;
  const region = lib.regions.find((r) => r.id === p.region)!;
  const s: Side = p.bilateral ? side : "midline";
  const sided = (id: string) => id.replace("{side}", s);
  const lm = (id: string) => landmarks.get(sided(id)) ?? null;
  const dist = (d: Distance): number | null => {
    if ("cm" in d) return d.cm;
    const seg = region.segments.find((x) => x.id === d.segment);
    const cm = segmentCm.get(d.segment);
    return seg && cm !== undefined ? (d.cun * cm) / seg.cun : null;
  };
  const loc = p.localisation;
  let base: ChartPoint | null = null;
  if (loc.method === "landmark") base = lm(loc.landmark);
  else if (loc.method === "between") {
    const a = lm(loc.a);
    const b = lm(loc.b);
    if (a && b) base = { u: a.u + loc.fraction * (b.u - a.u), v: a.v + loc.fraction * (b.v - a.v) };
  } else {
    const a = lm(loc.from);
    const b = lm(loc.toward);
    const d = dist(loc.distance);
    if (a && b && d !== null) {
      const len = Math.hypot(b.u - a.u, b.v - a.v) || 1;
      base = { u: a.u + ((b.u - a.u) / len) * d, v: a.v + ((b.v - a.v) / len) * d };
    }
  }
  if (!base) return null;
  const o: Offset | undefined = loc.offset;
  if (!o) return base;
  const sign = region.laterality === "bilateral" ? 1 : s === "right" ? -1 : 1;
  const get = (d: Distance | undefined) => (d ? dist(d) : 0);
  const [lat, med, cra, cau] = [get(o.lateral), get(o.medial), get(o.cranial), get(o.caudal)];
  if (lat === null || med === null || cra === null || cau === null) return null;
  return { u: base.u + sign * (lat - med), v: base.v + cra - cau };
}

/** Direction (azimuth) towards the midline on this chart and side. */
export function medialAzimuth(lib: Library, region: string, side: Side): number {
  const r = lib.regions.find((x) => x.id === region);
  if (!r) return 0;
  if (r.laterality === "bilateral") return 270; // −u is medial on a bilateral chart
  return side === "right" ? 90 : 270;
}
