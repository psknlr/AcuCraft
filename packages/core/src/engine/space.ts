import { t } from "@clinicalcraft/core";
import { rotateXZ } from "@clinicalcraft/world";
import type { Position, Side } from "../schema/common.js";
import type { FixtureKind, FloorPoint } from "../schema/governance.js";
import type { EncounterState, Stance, WalkRecord } from "../schema/state.js";
import { now } from "./queries.js";
import { LOCALE, LYING } from "./runtime.js";
import { clinicWorld, type Scenario } from "./scenario.js";
import {
  ARM_REACH_M,
  areaCentre,
  CONTACT_RANGE_M,
  distanceToArea,
  facing,
  fixtureReach,
  fixturesOfKind,
  planWalk,
  roomAt,
  seesArea,
  SIGHT_RANGE_M,
  TALK_RANGE_M,
  walkMinutes,
  type Area,
  type ClinicWorld,
  type FixtureInfo,
  type WalkPlan,
  type WalkTarget,
} from "./world.js";

/**
 * Where people are in the clinic and what they can reach from there (docs/WORLD.md): the patient's body on the couch
 * or chair, each body site on the floor plan, and the spatial rule of every kind of act. A rule that fails says how
 * far away the thing is and which `move` brings it within reach — the practitioner walks; nothing walks for them.
 */

/** Where to walk, as a `move` action names it. */
export type MoveTarget = { room: string } | { fixture: string } | { person: string } | { region: string; side: Side } | { x: number; z: number };

/** Where a person "in the room" is not when in none of the clinic's rooms. */
export const OUTSIDE = "outside";

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const hintText = (to: MoveTarget) => `move ${JSON.stringify({ to })}`;

export interface PatientBody {
  /** The floor the body takes up: the couch or chair it is on, or where it stands. */
  area: Area;
  centre: FloorPoint;
  support: FixtureInfo | null;
  /** Lying on a couch (sites then lie along it). */
  lying: boolean;
}

const box = (p: FloorPoint, half: number): Area => ({ minX: p.x - half, maxX: p.x + half, minZ: p.z - half, maxZ: p.z + half });

/** The patient's body on the floor plan, as they are now. */
export function patientBody(sc: Scenario, s: EncounterState): PatientBody {
  const w = clinicWorld(sc);
  const support = s.patient.support ? (w.fixtures.get(s.patient.support) ?? null) : null;
  if (support) return { area: support.area, centre: areaCentre(support.area), support, lying: support.kind === "couch" && LYING.includes(s.patient.position) };
  const centre = { x: s.patient.at.x, z: s.patient.at.z };
  return { area: box(centre, 0.25), centre, support: null, lying: false };
}

/** The patient's height (m): the case's, else a nominal adult's. */
export function patientHeightM(sc: Scenario): number {
  const p = sc.case.patient as { heightCm?: number; sex?: string };
  return (p.heightCm ?? (p.sex === "female" ? 160 : 172)) / 100;
}

/** Gap between the head end of the couch and the top of the head (m). */
const HEAD_GAP_M = 0.08;

export interface Site {
  region: string;
  side: Side;
  /** Where the site is on the floor plan. */
  point: FloorPoint;
  /** What reach and sight are measured to: the point on a lying patient, the whole body of a seated or standing one. */
  area: Area;
  label: string;
}

/**
 * Where a body site is in the room. With the patient lying, the regional chart's place on the body (the body map)
 * is laid along the couch from its head end: the head is at the end with the breathing hole, the patient's right is
 * on one side of the couch supine and on the other prone, and a site on the far side is out of an arm's reach. Lying
 * on one side, the upper side is over the middle of the couch. Seated or standing, every site is at the body.
 */
export function siteOf(sc: Scenario, s: EncounterState, regionId: string, side: Side): Site {
  const body = patientBody(sc, s);
  const region = sc.bundle.regions.get(regionId);
  // the chart's title without its note in brackets: "right knee, leg and ankle"
  const label = `${side === "midline" ? "" : `${side} `}${(region?.title ?? regionId).replace(/\s*\(.*\)\s*$/, "")}`.toLowerCase();
  if (!body.lying || !body.support) return { region: regionId, side, point: body.centre, area: body.area, label };
  const map = sc.bundle.bodyMap?.regions[regionId] ?? { axial: 0.5, lateral: 0 };
  const entity = body.support.entity;
  const length = entity.equipmentType?.footprint.d ?? Math.max(entity.footprint?.w ?? 1.9, entity.footprint?.d ?? 1.9);
  // the head end is the couch's local −z
  const [hx, hz] = rotateXZ(0, -1, entity.rot);
  const along = length / 2 - HEAD_GAP_M - Math.min(map.axial * patientHeightM(sc), length - 2 * HEAD_GAP_M);
  const sideLying = s.patient.position === "side-lying-left" || s.patient.position === "side-lying-right";
  // the patient's right, seen from above: supine with the head towards −z it is towards −x; prone it is the other way
  const faceUp = s.patient.position !== "prone";
  const sign = side === "right" ? 1 : side === "left" ? -1 : 0;
  const lateral = sideLying ? 0 : sign * (faceUp ? 1 : -1) * map.lateral;
  const point = { x: body.centre.x + hx * along + hz * lateral, z: body.centre.z + hz * along - hx * lateral };
  // reach is measured to the point itself: a site on the far side of the couch is out of reach from every spot
  return { region: regionId, side, point, area: box(point, 0), label };
}

/* ------------------------------------------------------------------ */
/* Spatial rules                                                       */
/* ------------------------------------------------------------------ */

export type Spatial = { ok: true } | { ok: false; code: "not-at-patient" | "not-in-reach"; message: string; hint: MoveTarget | null };

const OK: Spatial = { ok: true };

const patientName = (sc: Scenario) => t(sc.case.patient.displayName, LOCALE);
const roomLabel = (w: ClinicWorld, id: string) => w.rooms.get(id)?.label ?? id;

function toPatient(sc: Scenario, s: EncounterState, actorId: string, range: number, purpose: string): Spatial {
  const w = clinicWorld(sc);
  const me = s.actors[actorId]!.at;
  const body = patientBody(sc, s);
  const distance = distanceToArea(me.x, me.z, body.area);
  const hint: MoveTarget = { person: s.patient.id };
  if (!seesArea(w, me, body.area)) {
    return { ok: false, code: "not-at-patient", message: `You cannot ${purpose} from here: ${patientName(sc)} is in the ${roomLabel(w, s.patient.location)}, out of sight. Go to them first: ${hintText(hint)}.`, hint };
  }
  if (distance > range + 1e-6) {
    return { ok: false, code: "not-at-patient", message: `You are ${fmt1(distance)} m from ${patientName(sc)}: too far to ${purpose} (within ${fmt1(range)} m). Go to them first: ${hintText(hint)}.`, hint };
  }
  return OK;
}

/** Near enough to speak with the patient and be answered. */
export const patientTalk = (sc: Scenario, s: EncounterState, actorId: string): Spatial => toPatient(sc, s, actorId, TALK_RANGE_M, "speak with them");
/** At the patient's side: near enough to examine, to take the pulse, to help them move. */
export const patientContact = (sc: Scenario, s: EncounterState, actorId: string, purpose = "do that"): Spatial => toPatient(sc, s, actorId, CONTACT_RANGE_M, purpose);
/** With the patient in view (observation). */
export const patientSight = (sc: Scenario, s: EncounterState, actorId: string): Spatial => toPatient(sc, s, actorId, SIGHT_RANGE_M, "watch over them");

/** Within an arm's reach of a body site, with the patient as they are now. */
export function siteReach(sc: Scenario, s: EncounterState, actorId: string, regionId: string, side: Side): Spatial & { distance?: number } {
  const w = clinicWorld(sc);
  const me = s.actors[actorId]!.at;
  const site = siteOf(sc, s, regionId, side);
  const distance = distanceToArea(me.x, me.z, site.area);
  if (distance <= ARM_REACH_M + 1e-6 && seesArea(w, me, site.area)) return { ok: true, distance };
  const hint: MoveTarget = { region: regionId, side };
  const body = patientBody(sc, s);
  const where = body.lying ? `on the ${body.support!.label}` : `where ${patientName(sc)} is`;
  return { ok: false, code: "not-in-reach", distance, message: `The ${site.label} ${where} is ${fmt1(distance)} m from where you stand: out of arm's reach (${ARM_REACH_M} m). Stand where you can reach it: ${hintText(hint)}.`, hint };
}

/** Within reach of a fixture. */
export function atFixture(sc: Scenario, s: EncounterState, actorId: string, fixtureId: string): Spatial {
  const w = clinicWorld(sc);
  const fx = w.fixtures.get(fixtureId);
  const r = fixtureReach(w, s.actors[actorId]!.at, fixtureId);
  if (!fx || !r) return { ok: false, code: "not-in-reach", message: `There is no ${fixtureId} in this clinic.`, hint: null };
  if (r.ok) return OK;
  const hint: MoveTarget = { fixture: fixtureId };
  return { ok: false, code: "not-in-reach", message: `The ${fx.label} (${roomLabel(w, fx.room)}) is ${fmt1(r.distance)} m from where you stand${r.sight ? "" : ", out of sight"}: it is used from within ${fmt1(r.reach)} m. Go to it first: ${hintText(hint)}.`, hint };
}

/** Within reach of a fixture of a kind: the one in reach, or how to get to the nearest. */
export function atFixtureOfKind(sc: Scenario, s: EncounterState, actorId: string, kind: FixtureKind, what: string): { ok: true; fixture: FixtureInfo } | (Extract<Spatial, { ok: false }> & { fixture: null }) {
  const w = clinicWorld(sc);
  const me = s.actors[actorId]!.at;
  const all = fixturesOfKind(w, kind, me);
  const inReach = all.find((f) => fixtureReach(w, me, f.id)?.ok);
  if (inReach) return { ok: true, fixture: inReach };
  if (all.length === 0) return { ok: false, fixture: null, code: "not-in-reach", message: `There is no ${what} in this clinic.`, hint: null };
  // the nearest by the walk, not through the wall
  const byWalk = all
    .map((f) => ({ f, plan: walkPlan(sc, s, actorId, { fixture: f.id }) }))
    .filter((x): x is { f: FixtureInfo; plan: Extract<WalkPlan, { ok: true }> } => x.plan.ok)
    .sort((a, b) => a.plan.metres - b.plan.metres || (a.f.id < b.f.id ? -1 : 1));
  const nearest = byWalk[0]?.f ?? all[0]!;
  const hint: MoveTarget = { fixture: nearest.id };
  return { ok: false, fixture: null, code: "not-in-reach", message: `No ${what} is within reach of where you stand. The nearest is the ${nearest.label} in the ${roomLabel(w, nearest.room)}${byWalk[0] ? `, ${fmt1(byWalk[0].plan.metres)} m away` : ""}: ${hintText(hint)}.`, hint };
}

/** Close enough to another member of the team to hand something over. */
export function nearActor(sc: Scenario, s: EncounterState, actorId: string, otherId: string, name: string): Spatial {
  const w = clinicWorld(sc);
  const me = s.actors[actorId]!.at;
  const other = s.actors[otherId]!.at;
  const distance = Math.hypot(me.x - other.x, me.z - other.z);
  if (distance <= CONTACT_RANGE_M + 1e-6 && seesArea(w, me, box(other, 0.25))) return OK;
  const hint: MoveTarget = { person: otherId };
  return { ok: false, code: "not-in-reach", message: `${name} is ${fmt1(distance)} m away in the ${roomLabel(w, s.actors[otherId]!.location)}: hand things over from within ${fmt1(CONTACT_RANGE_M)} m. Go to them first: ${hintText(hint)}.`, hint };
}

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

/** The walk target of a `move`, or why there is none. */
export function walkTarget(sc: Scenario, s: EncounterState, to: MoveTarget): { ok: true; target: WalkTarget; label: string } | { ok: false; code: string; message: string } {
  const w = clinicWorld(sc);
  if ("room" in to) {
    const room = w.rooms.get(to.room);
    return room ? { ok: true, target: { kind: "room", id: room.id }, label: `the ${room.label}` } : { ok: false, code: "unknown-id", message: `There is no room ${to.room}.` };
  }
  if ("fixture" in to) {
    const fx = w.fixtures.get(to.fixture);
    return fx ? { ok: true, target: { kind: "fixture", id: fx.id }, label: `the ${fx.label}` } : { ok: false, code: "unknown-id", message: `There is no fixture ${to.fixture}.` };
  }
  if ("person" in to) {
    if (to.person === s.patient.id) {
      const body = patientBody(sc, s);
      return { ok: true, target: { kind: "near", area: body.area, within: ARM_REACH_M, face: body.centre, what: "the patient" }, label: patientName(sc) };
    }
    const other = s.actors[to.person];
    if (!other) return { ok: false, code: "unknown-id", message: `There is no ${to.person} here.` };
    const name = sc.field.cast.find((m) => m.id === to.person)?.name ?? to.person;
    return { ok: true, target: { kind: "near", area: box(other.at, 0.25), within: 1, face: other.at, what: name }, label: name };
  }
  if ("region" in to) {
    if (!sc.bundle.regions.has(to.region)) return { ok: false, code: "not-modelled", message: `There is no regional model ${to.region}.` };
    const site = siteOf(sc, s, to.region, to.side);
    return { ok: true, target: { kind: "near", area: site.area, within: ARM_REACH_M, face: site.point, what: `the ${site.label}` }, label: `the ${site.label}` };
  }
  return { ok: true, target: { kind: "point", at: { x: to.x, z: to.z } }, label: `(${fmt1(to.x)}, ${fmt1(to.z)})` };
}

/** Plan the walk a `move` would make, from where the actor stands. */
export function walkPlan(sc: Scenario, s: EncounterState, actorId: string, to: MoveTarget): WalkPlan {
  const target = walkTarget(sc, s, to);
  if (!target.ok) return { ok: false, code: "unknown-target", message: target.message };
  return planWalkFrom(sc, s.actors[actorId]!.at, target.target);
}

function planWalkFrom(sc: Scenario, from: Stance, target: WalkTarget): WalkPlan {
  return planWalk(clinicWorld(sc), from, target);
}

/** Put an actor where a planned walk ends and keep the record of it. Returns the minutes it took. */
export function walk(sc: Scenario, s: EncounterState, actorId: string, plan: Extract<WalkPlan, { ok: true }>, opts: { withPatient?: boolean; attempt: number }): number {
  const w = clinicWorld(sc);
  const actor = s.actors[actorId]!;
  const from = { x: actor.at.x, z: actor.at.z };
  const minutes = walkMinutes(plan.metres, opts.withPatient === true);
  actor.at = plan.to;
  actor.location = roomAt(w, plan.to) ?? OUTSIDE;
  if (plan.metres > 0) {
    const record: WalkRecord = { attempt: opts.attempt, at: now(s), actor: actorId, from, to: { x: plan.to.x, z: plan.to.z }, path: plan.path, metres: plan.metres, minutes, withPatient: opts.withPatient === true };
    s.walks.push(record);
  }
  return minutes;
}

/** The seat a patient takes in a room: its chair, else its couch (null: they stand). */
export function seatIn(sc: Scenario, roomId: string, position: Position): FixtureInfo | null {
  const w = clinicWorld(sc);
  const inRoom = [...w.fixtures.values()].filter((f) => f.room === roomId);
  const couch = inRoom.find((f) => f.kind === "couch") ?? null;
  if (LYING.includes(position)) return couch;
  if (position === "standing") return null;
  return inRoom.find((f) => f.kind === "chair") ?? couch;
}

/** Put the patient on a fixture (or standing at a spot) in a room. */
export function placePatient(sc: Scenario, s: EncounterState, roomId: string, seat: FixtureInfo | null, standAt?: FloorPoint): void {
  const w = clinicWorld(sc);
  s.patient.location = roomId;
  s.patient.support = seat?.id ?? null;
  const at = seat ? areaCentre(seat.area) : (standAt ?? w.rooms.get(roomId)?.home ?? { x: s.patient.at.x, z: s.patient.at.z });
  // a seated patient faces the way the seat does (its front is local +z); a standing one keeps their facing
  const [fx, fz] = seat ? rotateXZ(0, 1, seat.entity.rot) : [0, 0];
  s.patient.at = seat ? facing(at, { x: at.x + fx, z: at.z + fz }) : { x: at.x, z: at.z, yaw: s.patient.at?.yaw ?? 0 };
}

/** Where the cast and the patient are when a visit starts: staff at their room's home spot, the patient seated. */
export function placeEveryone(sc: Scenario, s: EncounterState): void {
  const w = clinicWorld(sc);
  placePatient(sc, s, sc.field.patient.location, seatIn(sc, sc.field.patient.location, sc.field.patient.position));
  const body = patientBody(sc, s);
  for (const m of sc.field.cast) {
    const actor = s.actors[m.id]!;
    const home = w.rooms.get(m.location)!.home;
    actor.location = m.location;
    actor.at = m.location === s.patient.location ? facing(home, body.centre) : { x: home.x, z: home.z, yaw: 0 };
  }
}
