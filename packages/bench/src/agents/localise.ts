import { fitSeam, lateralSignOf, orientSeam, type ChartPoint, type Distance, type Offset, type referenceLibrary } from "@acucraft/core";

type Library = ReturnType<typeof referenceLibrary>;
type Side = "left" | "right" | "midline";

/**
 * Locate a standard point from what an agent has observed on the patient — palpated landmark positions and measured
 * segment lengths — using the public construction of the point (proportional bone measurement). This is what a
 * practitioner does with a tape and their fingers; it never reads the engine's hidden reference.
 *
 * A point measured from another point (`point:ST30`) is constructed from that point; when it lies on a neighbouring
 * chart, the agent palpates the landmarks the two charts share at their seam and carries it across with the map
 * those palpations give.
 */

/** The construction of a point, or of one site of a group point (on the site's own chart). */
function targetOf(lib: Library, pointId: string, site?: string | null) {
  const p = lib.points.find((x) => x.id === pointId);
  if (!p?.region) return null;
  if (p.siteLocalisations) {
    const x = p.siteLocalisations.find((y) => y.id === site);
    return x ? { p, region: x.region, localisation: x.localisation } : null;
  }
  return p.localisation ? { p, region: p.region, localisation: p.localisation } : null;
}

export interface Requirements {
  region: string;
  side: Side;
  landmarks: string[];
  segments: string[];
}

/** What to palpate and measure, chart by chart, to construct a point; the point's own chart first. */
export function requirements(lib: Library, pointId: string, side: Side, site?: string | null): Requirements[] | null {
  const out = new Map<string, Requirements>();
  const need = (region: string, s: Side): Requirements => {
    const key = `${region}|${s}`;
    let r = out.get(key);
    if (!r) out.set(key, (r = { region, side: s, landmarks: [], segments: [] }));
    return r;
  };
  const visit = (id: string, depth: number, at?: string | null): boolean => {
    const t = targetOf(lib, id, at);
    if (!t || depth > 4) return false;
    const p = t.p;
    const region = lib.regions.find((r) => r.id === t.region);
    if (!region) return false;
    const s: Side = p.bilateral ? side : "midline";
    const here = need(region.id, s);
    const loc = t.localisation;
    for (const ref of anchorsOf(loc)) {
      if (!ref.startsWith("point:")) {
        here.landmarks.push(ref.replace("{side}", s));
        continue;
      }
      const other = lib.points.find((x) => x.id === ref.slice("point:".length));
      if (!other?.region || !visit(other.id, depth + 1)) return false;
      if (other.region === region.id) continue;
      const from = lib.regions.find((r) => r.id === other.region);
      const seam = from && orientSeam(from, region, s);
      if (!seam) return false;
      for (const pair of seam.pairs) {
        need(from.id, s).landmarks.push(pair.from);
        here.landmarks.push(pair.to);
      }
    }
    for (const d of distancesOf(loc)) if (d && "segment" in d) here.segments.push(d.segment);
    return true;
  };
  if (!visit(pointId, 0, site)) return null;
  return [...out.values()].map((r) => ({ ...r, landmarks: [...new Set(r.landmarks)], segments: [...new Set(r.segments)] }));
}

/** Observations on one chart and side. */
export interface Observed {
  landmarks: ReadonlyMap<string, ChartPoint>;
  segments: ReadonlyMap<string, number>;
}

/** Construct a point on its own chart from the observations (`observed(region, side)`). */
export function constructPoint(lib: Library, pointId: string, side: Side, observed: (region: string, side: Side) => Observed, depth = 0, site?: string | null): ChartPoint | null {
  const t = targetOf(lib, pointId, site);
  if (!t || depth > 4) return null;
  const p = t.p;
  const region = lib.regions.find((r) => r.id === t.region)!;
  const s: Side = p.bilateral ? side : "midline";
  const obs = observed(region.id, s);
  const dist = (d: Distance): number | null => {
    if ("cm" in d) return d.cm;
    const seg = region.segments.find((x) => x.id === d.segment);
    const cm = obs.segments.get(d.segment);
    return seg && cm !== undefined ? (d.cun * cm) / seg.cun : null;
  };
  const anchor = (ref: string): ChartPoint | null => {
    if (!ref.startsWith("point:")) return obs.landmarks.get(ref.replace("{side}", s)) ?? null;
    const other = lib.points.find((x) => x.id === ref.slice("point:".length));
    const at = other && constructPoint(lib, other.id, side, observed, depth + 1);
    if (!other?.region || !at) return null;
    if (other.region === region.id) return at;
    const from = lib.regions.find((r) => r.id === other.region)!;
    const seam = orientSeam(from, region, s);
    if (!seam) return null;
    const there = observed(from.id, s);
    const pairs = seam.pairs.map((pair) => ({ from: there.landmarks.get(pair.from), to: obs.landmarks.get(pair.to) }));
    if (pairs.some((pair) => !pair.from || !pair.to)) return null;
    const fit = fitSeam(pairs as { from: ChartPoint; to: ChartPoint }[], lateralSignOf(from.laterality, s), lateralSignOf(region.laterality, s), seam.reversed);
    return fit ? fit.map(at) : null;
  };
  const loc = t.localisation;
  let base: ChartPoint | null = null;
  if (loc.method === "landmark") base = anchor(loc.landmark);
  else if (loc.method === "between") {
    const a = anchor(loc.a);
    const b = anchor(loc.b);
    if (a && b) base = { u: a.u + loc.fraction * (b.u - a.u), v: a.v + loc.fraction * (b.v - a.v) };
  } else {
    const a = anchor(loc.from);
    const b = anchor(loc.toward);
    const d = dist(loc.distance);
    if (a && b && d !== null) {
      const len = Math.hypot(b.u - a.u, b.v - a.v) || 1;
      base = { u: a.u + ((b.u - a.u) / len) * d, v: a.v + ((b.v - a.v) / len) * d };
    }
  }
  if (!base) return null;
  const o: Offset | undefined = loc.offset;
  if (!o) return base;
  const sign = lateralSignOf(region.laterality, s);
  const get = (d: Distance | undefined) => (d ? dist(d) : 0);
  const [lat, med, cra, cau] = [get(o.lateral), get(o.medial), get(o.cranial), get(o.caudal)];
  if (lat === null || med === null || cra === null || cau === null) return null;
  return { u: base.u + sign * (lat - med), v: base.v + cra - cau };
}

type Loc = NonNullable<Library["points"][number]["localisation"]>;

function anchorsOf(loc: Loc): string[] {
  return loc.method === "landmark" ? [loc.landmark] : loc.method === "between" ? [loc.a, loc.b] : [loc.from, loc.toward];
}

function distancesOf(loc: Loc): (Distance | undefined)[] {
  return [loc.method === "along" ? loc.distance : undefined, loc.offset?.lateral, loc.offset?.medial, loc.offset?.cranial, loc.offset?.caudal];
}

/** Direction (azimuth) towards the midline on this chart and side. */
export function medialAzimuth(lib: Library, region: string, side: Side): number {
  const r = lib.regions.find((x) => x.id === region);
  if (!r) return 0;
  if (r.laterality === "bilateral") return 270; // −u is medial on a bilateral chart
  return side === "right" ? 90 : 270;
}
