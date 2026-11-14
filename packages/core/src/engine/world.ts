import type { EquipmentCatalog, FacilityDefinition, Issue, RoomTemplate } from "@clinicalcraft/core";
import {
  buildCollisionModel,
  buildRegistry,
  cellIndex,
  cellPoint,
  distanceToArea,
  footprintArea,
  GridAStarBackend,
  inFrame,
  yawTowards,
  type Area,
  type CollisionModel,
  type NavGoal,
  type NavLevelGrid,
  type SemanticEntity,
  type SemanticRegistry,
} from "@clinicalcraft/world";
import type { Clinic, FixtureKind, FloorPoint } from "../schema/governance.js";
import type { Stance } from "../schema/state.js";

/**
 * The clinic as a walkable world (docs/WORLD.md).
 *
 * The clinic's floor plan is a ClinicalCraft facility; this module derives ClinicalCraft's own collision model,
 * semantic registry, navigation grid and occlusion from it (`@clinicalcraft/world`, pure and headless) and answers
 * the three questions the encounter engine asks of a building: can I walk there and how far is it, is that within
 * reach from where I stand, and can I see it. Nothing here depends on an encounter: people are not obstacles (staff
 * walk round each other), so the same world serves every state and a replay plans the same walks.
 */

/** How far a practitioner reaches from where they stand to a point on the patient (m). */
export const ARM_REACH_M = 0.85;
/** Close enough to examine, position or hand something over (m, to the body or the other person). */
export const CONTACT_RANGE_M = 1.5;
/** Close enough to speak with the patient and be answered (m, with a line of sight). */
export const TALK_RANGE_M = 3;
/** How far an observer can keep an eye on the patient (m, with a line of sight). */
export const SIGHT_RANGE_M = 8;
/** Walking pace in the clinic, alone and at a patient's side (metres per simulated minute). */
export const WALK_M_PER_MIN = 72;
export const ESCORT_M_PER_MIN = 48;

/** The clinic content a pack provides in ClinicalCraft's formats: compiled facilities and every catalog loaded. */
export interface WorldContent {
  facilities: Map<string, FacilityDefinition>;
  catalogs: EquipmentCatalog[];
  templates: RoomTemplate[];
}

export interface FixtureInfo {
  id: string;
  kind: FixtureKind;
  label: string;
  room: string;
  /** The registry entity of the placement the fixture stands on (`eq:<placement>`). */
  entity: SemanticEntity;
  /** Its footprint on the floor. */
  area: Area;
  /** How close one must stand to use it (m from the footprint; ClinicalCraft's reach for its kind). */
  reach: number;
}

export interface RoomInfo {
  id: string;
  label: string;
  kind: Clinic["rooms"][number]["kind"];
  home: FloorPoint;
  rect: Area;
}

export interface ClinicWorld {
  clinic: Clinic;
  facility: FacilityDefinition;
  level: string;
  collision: CollisionModel;
  registry: SemanticRegistry;
  backend: GridAStarBackend;
  grid: NavLevelGrid;
  fixtures: Map<string, FixtureInfo>;
  rooms: Map<string, RoomInfo>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const err = (path: string, message: string): Issue => ({ path, message, severity: "error" });

/** Build the world of a clinic from its facility. Pure; `issues` names what does not fit together. */
export function buildClinicWorld(clinic: Clinic, content: WorldContent): { world: ClinicWorld | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const facility = content.facilities.get(clinic.facility);
  if (!facility) return { world: null, issues: [err("clinic.facility", `the content pack has no facility ${clinic.facility}`)] };
  const collision = buildCollisionModel(facility, content.catalogs, { patients: [], staff: false });
  const registry = buildRegistry(facility, content.catalogs, null, collision);
  // no clock: the planner's only budget is its expansion count, so a plan never depends on the machine
  const backend = new GridAStarBackend({ facility, collision, registry, locale: "en" });
  const level = facility.levels[0]?.id ?? "L0";
  const grid = backend.grids.grid(level);
  if (!grid) return { world: null, issues: [err("clinic.facility", `facility ${facility.id} has no level ${level}`)] };
  const world: ClinicWorld = { clinic, facility, level, collision, registry, backend, grid, fixtures: new Map(), rooms: new Map() };
  for (const [i, room] of clinic.rooms.entries()) {
    const def = facility.rooms.find((r) => r.id === room.id);
    if (!def) {
      issues.push(err(`clinic.rooms.${i}.id`, `facility ${facility.id} has no room ${room.id}`));
      continue;
    }
    const rect: Area = { minX: def.rect.x - def.rect.w / 2, maxX: def.rect.x + def.rect.w / 2, minZ: def.rect.z - def.rect.d / 2, maxZ: def.rect.z + def.rect.d / 2 };
    world.rooms.set(room.id, { id: room.id, label: room.label, kind: room.kind, home: room.home, rect });
    if (!freeSpot(world, room.home)) issues.push(err(`clinic.rooms.${i}.home`, `(${room.home.x}, ${room.home.z}) is not a free spot of the floor plan`));
    else if (roomAt(world, room.home) !== room.id) issues.push(err(`clinic.rooms.${i}.home`, `(${room.home.x}, ${room.home.z}) lies in ${roomAt(world, room.home) ?? "no room"}, not in ${room.id}`));
    for (const [k, fx] of room.fixtures.entries()) {
      const at = `clinic.rooms.${i}.fixtures.${k}`;
      if (world.fixtures.has(fx.id)) issues.push(err(`${at}.id`, `duplicate fixture id ${fx.id}`));
      const entity = registry.entity(`eq:${fx.placement}`);
      if (!entity) {
        issues.push(err(`${at}.placement`, `facility ${facility.id} has no placement ${fx.placement} (or its equipment type is unknown)`));
        continue;
      }
      if (entity.room !== room.id) issues.push(err(`${at}.placement`, `placement ${fx.placement} stands in ${entity.room ?? "no room"}, not in ${room.id}`));
      world.fixtures.set(fx.id, { id: fx.id, kind: fx.kind, label: fx.label, room: room.id, entity, area: footprintArea(entity), reach: entity.reach });
    }
  }
  // every fixture can be walked to from every room's home (one connected clinic)
  const start = clinic.rooms[0]?.home;
  if (start && issues.length === 0) {
    for (const fx of world.fixtures.values()) {
      if (fx.kind === "screen") continue;
      const plan = planWalk(world, { ...start, yaw: 0 }, { kind: "fixture", id: fx.id });
      if (!plan.ok) issues.push(err(`clinic.fixtures.${fx.id}`, `cannot be walked to: ${plan.message}`));
    }
    for (const room of world.rooms.values()) {
      const plan = planWalk(world, { ...start, yaw: 0 }, { kind: "point", at: room.home });
      if (!plan.ok) issues.push(err(`clinic.rooms.${room.id}.home`, `cannot be walked to: ${plan.message}`));
    }
  }
  return { world: issues.length === 0 ? world : null, issues };
}

const BUILT = new WeakMap<Clinic, { world: ClinicWorld | null; issues: Issue[] }>();

/** The world of a clinic and what is wrong with it, built once per clinic object (a memo: nothing depends on it). */
export function clinicWorldResult(clinic: Clinic, content: WorldContent): { world: ClinicWorld | null; issues: Issue[] } {
  let r = BUILT.get(clinic);
  if (!r) {
    r = buildClinicWorld(clinic, content);
    BUILT.set(clinic, r);
  }
  return r;
}

/** The world of a clinic (throws when it does not fit together: `resolveScenario` reports that as issues first). */
export function worldOf(clinic: Clinic, content: WorldContent): ClinicWorld {
  const r = clinicWorldResult(clinic, content);
  if (!r.world) throw new Error(`clinic ${clinic.id}: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return r.world;
}

/* ------------------------------------------------------------------ */
/* Where things are                                                    */
/* ------------------------------------------------------------------ */

/** The clinic room a floor point lies in (null: outside every room of the clinic). */
export function roomAt(w: ClinicWorld, p: FloorPoint): string | null {
  const id = w.registry.roomAt(w.level, p.x, p.z);
  return id !== null && w.rooms.has(id) ? id : null;
}

/** Can a person stand here (a free cell of the navigation grid: 0.38 m clear of every wall and solid footprint)? */
export function freeSpot(w: ClinicWorld, p: FloorPoint): boolean {
  return inFrame(w.grid, p.x, p.z) && w.grid.base[cellIndex(w.grid, p.x, p.z)] === 0;
}

/** Is there a line of sight at eye height from a floor point to a target (walls and closed doors hide)? */
export function sees(w: ClinicWorld, from: FloorPoint, target: { x: number; z: number; footprint?: { w: number; d: number } }): boolean {
  return w.backend.visibility.visibleFrom(w.level, from, { level: w.level, position: { x: target.x, z: target.z }, ...(target.footprint ? { footprint: target.footprint } : {}) });
}

const centreOf = (a: Area): FloorPoint => ({ x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2 });
const sizeOf = (a: Area) => ({ w: a.maxX - a.minX, d: a.maxZ - a.minZ });

/** Line of sight to any part of an area. */
export function seesArea(w: ClinicWorld, from: FloorPoint, area: Area): boolean {
  return sees(w, from, { ...centreOf(area), footprint: sizeOf(area) });
}

export interface ReachCheck {
  ok: boolean;
  /** Metres from where the actor stands to the footprint. */
  distance: number;
  reach: number;
  sight: boolean;
}

/** Is a fixture within reach from a floor point (ClinicalCraft's rule: within its reach of the footprint, in sight)? */
export function fixtureReach(w: ClinicWorld, at: FloorPoint, fixtureId: string): ReachCheck | null {
  const fx = w.fixtures.get(fixtureId);
  if (!fx) return null;
  const distance = distanceToArea(at.x, at.z, fx.area);
  const sight = seesArea(w, at, fx.area);
  return { ok: distance <= fx.reach + 1e-6 && sight, distance, reach: fx.reach, sight };
}

/** Fixtures of a kind, nearest first from a floor point (straight line to the footprint). */
export function fixturesOfKind(w: ClinicWorld, kind: FixtureKind, from?: FloorPoint): FixtureInfo[] {
  const list = [...w.fixtures.values()].filter((f) => f.kind === kind);
  if (!from) return list;
  return list.sort((a, b) => distanceToArea(from.x, from.z, a.area) - distanceToArea(from.x, from.z, b.area) || (a.id < b.id ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

export type WalkTarget =
  /** To where a fixture can be used (ClinicalCraft's interaction spot: within reach, in sight, facing it). */
  | { kind: "fixture"; id: string }
  /** To a room: its home spot. */
  | { kind: "room"; id: string }
  /** To a floor point (the nearest free spot if nobody can stand exactly there). */
  | { kind: "point"; at: FloorPoint }
  /** To a free spot within `within` metres of an area and in sight of it, facing `face` (a person, a body site). */
  | { kind: "near"; area: Area; within: number; face: FloorPoint; what: string };

export type WalkPlan =
  | { ok: true; to: Stance; path: FloorPoint[]; metres: number }
  | { ok: false; code: "no-route" | "no-spot" | "unknown-target"; message: string };

/**
 * Where to stand for something within `within` metres: the free cells that see the area and are as near to it as any
 * (squarely beside a body site, not at the edge of reach — within 3 cm of the nearest), the closest to `from` first.
 * The planner then takes the one that is the shortest walk.
 */
export function spotsNear(w: ClinicWorld, area: Area, within: number, from: FloorPoint): FloorPoint[] {
  const g = w.grid;
  const out: { p: FloorPoint; reach: number; d: number; i: number }[] = [];
  const x0 = Math.max(0, Math.floor((area.minX - within - g.minX) / g.cell));
  const x1 = Math.min(g.cols - 1, Math.floor((area.maxX + within - g.minX) / g.cell));
  const z0 = Math.max(0, Math.floor((area.minZ - within - g.minZ) / g.cell));
  const z1 = Math.min(g.rows - 1, Math.floor((area.maxZ + within - g.minZ) / g.cell));
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const i = iz * g.cols + ix;
      if (g.base[i]) continue;
      const p = cellPoint(g, i);
      const reach = distanceToArea(p.x, p.z, area);
      // a spot inside the area itself is nobody's standing place
      if (reach > within + 1e-6 || reach <= 0) continue;
      if (!seesArea(w, p, area)) continue;
      out.push({ p, reach, d: Math.hypot(p.x - from.x, p.z - from.z), i });
    }
  }
  const nearest = Math.min(...out.map((o) => o.reach));
  return out
    .filter((o) => o.reach <= nearest + 0.03)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((o) => o.p);
}

const stance = (x: number, z: number, yaw: number): Stance => ({ x: round3(x), z: round3(z), yaw: round4(yaw) });

/** Plan a walk. Pure and deterministic: the same world, start and target give the same path. */
export function planWalk(w: ClinicWorld, from: Stance, target: WalkTarget): WalkPlan {
  let goal: NavGoal;
  let face: FloorPoint | null = null;
  if (target.kind === "fixture") {
    const fx = w.fixtures.get(target.id);
    if (!fx) return { ok: false, code: "unknown-target", message: `there is no fixture ${target.id} in this clinic` };
    face = centreOf(fx.area);
    // already where it can be used: turn to it, do not shuffle to another spot
    if (fixtureReach(w, from, fx.id)?.ok) return { ok: true, to: stance(from.x, from.z, yawTowards(from, face)), path: [], metres: 0 };
    goal = { kind: "interact", id: fx.entity.id };
  } else if (target.kind === "room") {
    const room = w.rooms.get(target.id);
    if (!room) return { ok: false, code: "unknown-target", message: `there is no room ${target.id} in this clinic` };
    if (roomAt(w, from) === room.id) return { ok: true, to: from, path: [], metres: 0 };
    goal = { kind: "point", x: room.home.x, z: room.home.z, level: w.level };
  } else if (target.kind === "point") {
    goal = { kind: "point", x: target.at.x, z: target.at.z, level: w.level };
  } else {
    face = target.face;
    const here = distanceToArea(from.x, from.z, target.area);
    if (here <= target.within + 1e-6 && here > 0 && seesArea(w, from, target.area)) return { ok: true, to: stance(from.x, from.z, yawTowards(from, face)), path: [], metres: 0 };
    const spots = spotsNear(w, target.area, target.within, from).slice(0, 16);
    if (spots.length === 0) return { ok: false, code: "no-spot", message: `there is nowhere to stand within ${target.within} m of ${target.what}` };
    goal = spots.length === 1 ? { kind: "point", x: spots[0]!.x, z: spots[0]!.z, level: w.level } : { kind: "any", goals: spots.map((p) => ({ kind: "point", x: p.x, z: p.z, level: w.level })) };
  }
  const plan = w.backend.plan({ actorId: "actor:walker", from: { x: from.x, y: 0, z: from.z, yaw: from.yaw, pitch: 0, level: w.level }, goal, role: "clinician" });
  if (!plan.ok) return { ok: false, code: "no-route", message: plan.message };
  const end = { x: plan.target.x, z: plan.target.z };
  const yaw = face ? yawTowards(end, face) : plan.path.length >= 2 ? yawTowards(plan.path[plan.path.length - 2]!, end) : from.yaw;
  return { ok: true, to: stance(end.x, end.z, yaw), path: plan.path.map((p) => ({ x: round3(p.x), z: round3(p.z) })), metres: round3(plan.length) };
}

/** Simulated minutes a walk takes (hundredths of a minute; any walk at all takes at least one). */
export function walkMinutes(metres: number, withPatient: boolean): number {
  if (metres <= 0) return 0;
  return Math.max(0.01, Math.ceil((metres / (withPatient ? ESCORT_M_PER_MIN : WALK_M_PER_MIN)) * 100) / 100);
}

/** A stance at a floor point facing another. */
export function facing(at: FloorPoint, towards: FloorPoint): Stance {
  return stance(at.x, at.z, Math.hypot(towards.x - at.x, towards.z - at.z) < 1e-9 ? 0 : yawTowards(at, towards));
}

/** Compass word for a yaw (0 looks north, towards −z). */
export function compass(yaw: number): string {
  const names = ["north", "north-west", "west", "south-west", "south", "south-east", "east", "north-east"];
  const turn = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return names[Math.round(turn / (Math.PI / 4)) % 8]!;
}

export { centreOf as areaCentre, distanceToArea, type Area };
