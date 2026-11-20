import { t, type MaterialDef, type VoxelPart } from "@clinicalcraft/core";
import { rotateXZ, wallSolidBoxes, type Aabb } from "@clinicalcraft/world";
import {
  ARM_REACH_M,
  CONTACT_RANGE_M,
  LOCALE,
  SIGHT_RANGE_M,
  TALK_RANGE_M,
  areaCentre,
  assessPath,
  clinicWorld,
  fellUnseen,
  modelledRegions,
  needleList,
  patientBody,
  patientHeightM,
  patientRegion,
  regionAccess,
  siteOf,
  type EncounterState,
  type Scenario,
  type Side,
} from "@acucraft/core";

/**
 * What a renderer needs to draw the clinic and the people in it, as plain data.
 *
 * `sceneOf` is the building: walls with their openings, floors, lights, and every piece of equipment as the boxes its
 * catalog entry is made of. It is public (the floor plan a practitioner who works there knows) and the same for every
 * scenario of a clinic. `stageOf` is who stands where now — what anyone in the room can see. `teachingOf` is the
 * anatomy under the skin, and is only ever built for an encounter in teaching mode: in assessment mode nothing
 * beneath the skin, and no reference location, leaves the server.
 */

export interface SceneFixture {
  /** The placement id on the facility. */
  id: string;
  type: string;
  label: string;
  room: string | null;
  x: number;
  z: number;
  /** Degrees about +y. */
  rot: number;
  footprint: { w: number; d: number; h: number };
  parts: VoxelPart[];
  category: string;
  /** The clinic fixtures standing on this placement (what actions name): a trolley is also where its sharps box is. */
  fixtures: { id: string; kind: string; label: string; reach: number }[];
}

export interface SceneOpening {
  kind: string;
  axis: "x" | "z";
  /** The wall's centre line (the fixed coordinate) and the opening's extent along the wall. */
  line: number;
  a: number;
  b: number;
  y0: number;
  y1: number;
  thickness: number;
  /** A partition between rooms (else an outside wall). */
  interior: boolean;
  /** Which way is out of the room (or building) whose wall this is: +1 or −1 on the other axis. */
  outward: 1 | -1;
  /** The extent of the wall the opening is in: a sliding leaf parks beside the opening, within it. */
  from: number;
  to: number;
}

export interface StudioScene {
  facility: string;
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  buildings: { id: string; rect: { minX: number; maxX: number; minZ: number; maxZ: number }; floor: string; wallHeight: number }[];
  rooms: { id: string; label: string; kind: string; rect: { minX: number; maxX: number; minZ: number; maxZ: number }; floor: string; home: { x: number; z: number } | null; lights: { x: number; z: number }[] }[];
  walls: { key: string; partition: boolean; height: number; thickness: number; materials: { base: string; body: string; top: string }; boxes: Aabb[] }[];
  openings: SceneOpening[];
  fixtures: SceneFixture[];
  materials: Record<string, MaterialDef>;
  ranges: { armReach: number; contact: number; talk: number; sight: number };
  /** Where each regional chart lies on the body: fraction of the height from the vertex, metres from the midline. */
  bodyMap: Record<string, { axial: number; lateral: number }>;
  /** The regional charts (no patient geometry): extent in centimetres, the landmarks and segments that can be found. */
  regions: { id: string; title: string; laterality: string; uRange: [number, number]; vRange: [number, number]; chart: string; landmarks: { id: string; label: string }[]; segments: { id: string; label: string; from: string; to: string; cun: number }[]; positions: string[] }[];
  patient: { name: string; age: number; sex: string; heightM: number };
  cast: { id: string; name: string; role: string; underTest: boolean }[];
}

const rectOf = (r: { x: number; z: number; w: number; d: number }) => ({ minX: r.x - r.w / 2, maxX: r.x + r.w / 2, minZ: r.z - r.d / 2, maxZ: r.z + r.d / 2 });
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const SCENES = new WeakMap<object, Omit<StudioScene, "patient" | "cast" | "regions" | "bodyMap">>();

/** The clinic of a scenario as a renderer draws it. */
export function sceneOf(sc: Scenario): StudioScene {
  const w = clinicWorld(sc);
  let building = SCENES.get(w);
  if (!building) {
    const f = w.facility;
    const materials: Record<string, MaterialDef> = {};
    for (const c of sc.bundle.world.catalogs) for (const m of c.materials) materials[m.id] = m;
    for (const m of f.materials ?? []) materials[m.id] = m;
    const byPlacement = new Map<string, { id: string; kind: string; label: string; reach: number }[]>();
    for (const fx of w.fixtures.values()) byPlacement.set(fx.entity.id, [...(byPlacement.get(fx.entity.id) ?? []), { id: fx.id, kind: fx.kind, label: fx.label, reach: fx.reach }]);
    const fixtures: SceneFixture[] = [];
    for (const p of f.placements) {
      const entity = w.registry.entity(`eq:${p.id}`);
      const type = entity?.equipmentType;
      if (!entity || !type) continue;
      const here = byPlacement.get(entity.id) ?? [];
      const skip = new Set(p.hideParts ?? []);
      fixtures.push({
        id: p.id,
        type: type.id,
        label: here[0]?.label ?? t(p.label ?? type.name, LOCALE),
        room: entity.room,
        x: p.x,
        z: p.z,
        rot: p.rot ?? 0,
        footprint: type.footprint,
        parts: [...type.parts.filter((_, i) => !skip.has(i)), ...(p.extraParts ?? [])],
        category: type.category,
        fixtures: here,
      });
    }
    const openings: SceneOpening[] = [];
    for (const wall of w.collision.walls) {
      for (const o of wall.openings) openings.push({ kind: o.kind, axis: wall.wall.axis, line: wall.wall.line, a: round3(o.a), b: round3(o.b), y0: o.y0, y1: o.y1, thickness: wall.thickness, interior: wall.partition, outward: wall.wall.outward, from: round3(wall.wall.from), to: round3(wall.wall.to) });
    }
    building = {
      facility: f.id,
      name: t(f.name, LOCALE),
      bounds: f.bounds,
      buildings: f.buildings.map((b) => ({ id: b.id, rect: rectOf(b.rect), floor: b.floor, wallHeight: b.walls.height })),
      rooms: f.rooms.map((r) => {
        const info = w.rooms.get(r.id);
        return { id: r.id, label: info?.label ?? t(r.name, LOCALE), kind: r.kind, rect: rectOf(r.rect), floor: r.floor ?? f.buildings.find((b) => b.id === r.building)?.floor ?? "floor", home: info?.home ?? null, lights: r.lights ?? [] };
      }),
      walls: w.collision.walls.map((wall) => ({
        key: wall.key,
        partition: wall.partition,
        height: wall.height,
        thickness: wall.thickness,
        materials: { base: wall.materials.base, body: wall.materials.body, top: wall.materials.top },
        boxes: wallSolidBoxes(wall),
      })),
      openings,
      fixtures,
      materials,
      ranges: { armReach: ARM_REACH_M, contact: CONTACT_RANGE_M, talk: TALK_RANGE_M, sight: SIGHT_RANGE_M },
    };
    SCENES.set(w, building);
  }
  return {
    ...building,
    bodyMap: sc.bundle.bodyMap?.regions ?? {},
    regions: modelledRegions(sc).map((id) => {
      const r = sc.bundle.regions.get(id)!;
      return {
        id: r.id,
        title: r.title,
        laterality: r.laterality,
        uRange: r.chart.uRange,
        vRange: r.chart.vRange,
        chart: r.chart.description,
        landmarks: r.landmarks.map((l) => ({ id: l.id, label: l.label })),
        segments: r.segments.map((g) => ({ id: g.id, label: g.label, from: g.from, to: g.to, cun: g.cun })),
        positions: [...new Set(r.access.map((a) => a.position))],
      };
    }),
    patient: { name: t(sc.case.patient.displayName, LOCALE), age: sc.case.patient.age, sex: sc.case.patient.sex, heightM: patientHeightM(sc) },
    cast: sc.field.cast.map((m) => ({ id: m.id, name: m.name, role: m.role, underTest: m.agent === "under-test" })),
  };
}

export interface StudioStage {
  actors: { id: string; x: number; z: number; yaw: number; room: string; holding: string[] }[];
  patient: {
    x: number;
    z: number;
    yaw: number;
    room: string;
    /** The placement the patient sits or lies on (null: standing). */
    on: string | null;
    position: string;
    lying: boolean;
    /** Lying: the unit vector on the floor from the body's centre towards the head. */
    head: { x: number; z: number } | null;
    fainted: boolean;
  };
  /** Where each accessible body site (`region:side`) is on the floor plan as the patient is now. */
  sites: Record<string, { x: number; z: number }>;
  /** The walks of the latest step, for a renderer to play. */
  walks: { actor: string; path: { x: number; z: number }[]; from: { x: number; z: number }; to: { x: number; z: number }; metres: number; withPatient: boolean }[];
}

/** Who stands where: what anyone in the clinic can see. `sinceAttempt`: walks made by attempts from this index on. */
export function stageOf(sc: Scenario, s: EncounterState, sinceAttempt = s.attempts.length): StudioStage {
  const body = patientBody(sc, s);
  const sites: StudioStage["sites"] = {};
  for (const id of modelledRegions(sc)) {
    const region = sc.bundle.regions.get(id)!;
    const sides = (region.laterality === "bilateral" ? ["left", "right"] : ["midline", "left", "right"]) as Side[];
    for (const side of sides) {
      if (!regionAccess(region, side, s.patient.position).accessible) continue;
      const p = siteOf(sc, s, id, side).point;
      sites[`${id}:${side}`] = { x: round3(p.x), z: round3(p.z) };
    }
  }
  let head: StudioStage["patient"]["head"] = null;
  if (body.lying && body.support) {
    // the head end is the couch's local −z (as `siteOf` lays the body along it)
    const [hx, hz] = rotateXZ(0, -1, body.support.entity.rot);
    head = { x: round3(hx), z: round3(hz) };
  }
  const supportPlacement = body.support ? body.support.entity.id.replace(/^eq:/, "") : null;
  return {
    actors: sc.field.cast.map((m) => {
      const a = s.actors[m.id]!;
      return { id: m.id, x: a.at.x, z: a.at.z, yaw: a.at.yaw, room: a.location, holding: [...a.holding] };
    }),
    patient: {
      x: round3(body.support ? areaCentre(body.support.area).x : s.patient.at.x),
      z: round3(body.support ? areaCentre(body.support.area).z : s.patient.at.z),
      yaw: s.patient.at.yaw ?? 0,
      room: s.patient.location,
      on: supportPlacement,
      position: s.patient.position,
      lying: body.lying,
      head,
      fainted: s.patient.fainted,
    },
    sites,
    walks: s.walks
      .filter((k) => k.attempt >= sinceAttempt)
      .map((k) => ({ actor: k.actor, path: k.path, from: k.from, to: k.to, metres: k.metres, withPatient: k.withPatient })),
  };
}

export interface TeachingRegion {
  region: string;
  side: Side;
  configuration: string;
  landmarks: { id: string; label: string; u: number; v: number }[];
  structures: { id: string; label: string; kind: string; hazard: string; radiusCm: number; path: { u: number; v: number; d: number }[] }[];
  layers: { tissue: string; label: string; thicknessCm: number; hazard: string | null }[];
  zones: { id: string; u: number; v: number; radiusCm: number; layers: { tissue: string; label: string; thicknessCm: number; hazard: string | null }[] }[];
}

export interface TeachingNeedle {
  needle: string;
  region: string;
  side: string;
  /** The strata at the entry, from the skin down (cm). */
  strata: { tissue: string; label: string; from: number; to: number; hazard: string | null }[];
  tipTissue: string;
  traversed: string[];
  verticalDepthCm: number;
  near: { label: string; kind: string; hazard: string; clearanceCm: number; contact: boolean }[];
  response: { deqi: boolean; intensity: number; stimulation: number; winding: number; stuck: boolean; overstimulated: boolean; noxious: string | null } | null;
}

const layersOut = (layers: readonly { tissue: string; label?: string | undefined; thicknessCm: number; hazard?: string | undefined }[]) =>
  layers.map((l) => ({ tissue: l.tissue, label: l.label ?? l.tissue, thicknessCm: round3(l.thicknessCm), hazard: l.hazard ?? null }));

const strataOf = (layers: readonly { tissue: string; label?: string | undefined; thicknessCm: number; hazard?: string | undefined }[]) => {
  let top = 0;
  return layers.map((l) => {
    const from = top;
    top += l.thicknessCm;
    return { tissue: l.tissue, label: l.label ?? l.tissue, from: round3(from), to: round3(top), hazard: l.hazard ?? null };
  });
};

/**
 * The anatomy of one regional chart on this patient, as they lie now. Teaching mode only: the caller refuses it in
 * assessment mode (`StudioSession.teaching`).
 */
export function teachingRegion(sc: Scenario, s: EncounterState, regionId: string, side: Side): TeachingRegion | null {
  const region = sc.bundle.regions.get(regionId);
  if (!region) return null;
  const access = regionAccess(region, side, s.patient.position);
  const frame = patientRegion(sc, regionId, side, access.configuration);
  const landmarks: TeachingRegion["landmarks"] = [];
  for (const l of region.landmarks) {
    const id = l.id.replace("{side}", side);
    const at = frame.landmark(l.id) ?? frame.landmark(id);
    if (at) landmarks.push({ id: l.id, label: l.label, u: round3(at.u), v: round3(at.v) });
  }
  const mid = { u: (region.chart.uRange[0] + region.chart.uRange[1]) / 2, v: (region.chart.vRange[0] + region.chart.vRange[1]) / 2 };
  return {
    region: regionId,
    side,
    configuration: access.configuration,
    landmarks,
    structures: frame.structures.map((x) => ({ id: x.id, label: x.label, kind: x.kind, hazard: x.hazard, radiusCm: x.radiusCm, path: x.path.map((p) => ({ u: round3(p.u), v: round3(p.v), d: round3(p.d) })) })),
    // the general strata: those well away from every zone, else the model's own
    layers: layersOut(frame.layersAt(farFromZones(region, mid, frame.scale))),
    // a zone is where the engine has it on this patient: its centre and radius scale with the patient's build
    zones: region.tissue.zones.map((z) => {
      const at = { u: z.centre.u * frame.scale.u, v: z.centre.v * frame.scale.v };
      return { id: z.id, u: round3(at.u), v: round3(at.v), radiusCm: round3(z.radiusCm * Math.max(frame.scale.u, frame.scale.v)), layers: layersOut(frame.layersAt(at)) };
    }),
  };
}

/** A point of the patient's chart outside every tissue zone (the model's general strata hold there). */
function farFromZones(region: { tissue: { zones: { centre: { u: number; v: number }; radiusCm: number }[] }; chart: { uRange: [number, number]; vRange: [number, number] } }, start: { u: number; v: number }, scale: { u: number; v: number }) {
  const reach = Math.max(scale.u, scale.v);
  const free = (p: { u: number; v: number }) => region.tissue.zones.every((z) => Math.hypot(p.u - z.centre.u * scale.u, p.v - z.centre.v * scale.v) > z.radiusCm * reach);
  const at = (u: number, v: number) => ({ u: u * scale.u, v: v * scale.v });
  const first = at(start.u, start.v);
  if (free(first)) return first;
  for (let i = 1; i <= 8; i++) {
    for (let k = 0; k <= 8; k++) {
      const p = at(region.chart.uRange[0] + ((region.chart.uRange[1] - region.chart.uRange[0]) * i) / 9, region.chart.vRange[0] + ((region.chart.vRange[1] - region.chart.vRange[0]) * k) / 8);
      if (free(p)) return p;
    }
  }
  return first;
}

/** What lies under each needle in place this visit. Teaching mode only. */
export function teachingNeedles(sc: Scenario, s: EncounterState): TeachingNeedle[] {
  const out: TeachingNeedle[] = [];
  for (const n of needleList(s)) {
    const ins = n.insertion;
    if (!ins || (n.location.kind !== "patient" && !fellUnseen(s, n))) continue;
    const region = sc.bundle.regions.get(ins.region);
    if (!region) continue;
    const frame = patientRegion(sc, ins.region, ins.side, ins.configuration);
    const path = assessPath(frame, ins.entry, ins.angleDeg, ins.azimuthDeg, ins.depthCm, n.spec);
    out.push({
      needle: n.id,
      region: ins.region,
      side: ins.side,
      strata: strataOf(frame.layersAt(ins.entry)),
      tipTissue: path.tipTissue,
      traversed: path.traversed,
      verticalDepthCm: round3(path.verticalDepthCm),
      near: path.findings.map((f) => ({ label: f.label, kind: f.kind, hazard: f.hazard, clearanceCm: round3(f.clearanceCm), contact: f.contact })),
      response: n.response
        ? { deqi: n.response.deqi, intensity: round3(n.response.intensity), stimulation: round3(n.response.stimulation), winding: n.response.winding, stuck: n.response.stuck, overstimulated: n.response.overstimulated, noxious: n.response.noxious ?? null }
        : null,
    });
  }
  return out;
}

/** What a needle put in here, like this, would pass and reach. Teaching mode only. */
export function teachingProbe(sc: Scenario, s: EncounterState, q: { region: string; side: Side; u: number; v: number; angleDeg: number; azimuthDeg: number; depthCm: number }) {
  const region = sc.bundle.regions.get(q.region);
  if (!region) return null;
  const frame = patientRegion(sc, q.region, q.side, regionAccess(region, q.side, s.patient.position).configuration);
  const entry = { u: q.u, v: q.v };
  const path = assessPath(frame, entry, q.angleDeg, q.azimuthDeg, q.depthCm, { diameterMm: 0.25, lengthMm: 75 });
  return {
    inChart: frame.inChart(entry),
    strata: strataOf(frame.layersAt(entry)),
    tipTissue: path.tipTissue,
    traversed: path.traversed,
    executedDepthCm: round3(path.executedDepthCm),
    verticalDepthCm: round3(path.verticalDepthCm),
    stoppedBy: path.stoppedBy,
    critical: path.critical,
    pleuraPenetrated: path.pleuraPenetrated,
    layersReached: path.layersReached,
    near: path.findings.map((f) => ({ label: f.label, kind: f.kind, hazard: f.hazard, clearanceCm: round3(f.clearanceCm), contact: f.contact })),
  };
}
