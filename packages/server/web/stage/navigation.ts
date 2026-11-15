import type { AgentView } from "@acucraft/core";
import type { Placement, SetName } from "./cast.js";
import { CONSULT, TREATMENT } from "./set.js";

export interface FloorPoint { x: number; z: number }
export interface FloorFrame {
  set: SetName;
  /** The same anchor on the engine's floor and on the drawn set. */
  origin: FloorPoint;
  anchor: FloorPoint;
  /** Rotation from engine coordinates into set coordinates, in radians. */
  rotation: number;
}

const HEADINGS: Record<string, number> = {
  north: 0, "north-east": Math.PI / 4, east: Math.PI / 2, "south-east": 3 * Math.PI / 4,
  south: Math.PI, "south-west": -3 * Math.PI / 4, west: -Math.PI / 2, "north-west": -Math.PI / 4,
};

/**
 * The workspace's rooms are presentation sets. Keep movement tied to the engine's floor by using a real fixture
 * as the common anchor; when lying down, rotate the couch's head direction onto the drawn couch's -z end.
 */
export function floorFrame(view: AgentView): FloorFrame {
  const room = view.space.you.room;
  const set: SetName = /treat|couch|bay/.test(room) ? "treatment" : "consult";
  const here = view.space.fixtures.filter((f) => f.room === room);
  const patientHere = view.space.patient.room === room;
  const support = patientHere ? here.find((f) => f.id === view.space.patient.on) : undefined;
  const fixture = support ?? here.find((f) => f.kind === (set === "treatment" ? "couch" : "chair")) ?? here[0];
  const onCouch = fixture?.kind === "couch";
  const anchor = set === "treatment" ? onCouch ? TREATMENT.couch : TREATMENT.chair : CONSULT.patientChair;
  const rotation = onCouch && patientHere && view.space.patient.lying ? -(HEADINGS[view.space.patient.lying.head] ?? 0) : 0;
  return { set, origin: fixture ? { x: fixture.x, z: fixture.z } : { x: view.space.you.x, z: view.space.you.z }, anchor: { x: anchor.x, z: anchor.z }, rotation };
}

export function toStageFloor(view: AgentView, point: FloorPoint): FloorPoint {
  const frame = floorFrame(view);
  const dx = point.x - frame.origin.x, dz = point.z - frame.origin.z;
  const c = Math.cos(frame.rotation), s = Math.sin(frame.rotation);
  return { x: frame.anchor.x + c * dx - s * dz, z: frame.anchor.z + s * dx + c * dz };
}

export function fromStageFloor(view: AgentView, point: FloorPoint): FloorPoint {
  const frame = floorFrame(view);
  const dx = point.x - frame.anchor.x, dz = point.z - frame.anchor.z;
  const c = Math.cos(frame.rotation), s = Math.sin(frame.rotation);
  return { x: frame.origin.x + c * dx + s * dz, z: frame.origin.z - s * dx + c * dz };
}

/** The practitioner's real floor position, never a position chosen from the last needle. */
export function practitionerFloorPlacement(view: AgentView, seed: string): Placement {
  const frame = floorFrame(view);
  const at = toStageFloor(view, view.space.you);
  // Figure kit faces +z at rotation zero; the engine's compass faces -z at north.
  const heading = HEADINGS[view.space.you.facing] ?? 0;
  return { set: frame.set, position: "standing", options: { posture: "standing", seed }, at: { ...at, y: 0, rot: 180 - heading * 180 / Math.PI - frame.rotation * 180 / Math.PI } };
}

/** Select the patient's room frame even when the practitioner has walked somewhere else. */
export function patientRoomView(view: AgentView): AgentView {
  return { ...view, space: { ...view.space, you: { ...view.space.you, x: view.space.patient.x, z: view.space.patient.z, room: view.space.patient.room } } };
}

/**
 * Only the escorting actor's route is recorded. Reuse its destination-room arrival segment exactly; do not invent
 * a separate patient path through corridors that the workspace's two disconnected presentation sets do not draw.
 * Seating is a subsequent pose transition at the actual support fixture, not an offset added to this polyline.
 */
export function patientEscortArrival(view: AgentView): FloorPoint[] {
  const walk = view.space.lastWalk;
  if (!walk?.withPatient || walk.path.length < 2 || view.space.you.room !== view.space.patient.room) return [];
  const patientView = patientRoomView(view);
  const frame = floorFrame(patientView);
  const room = (frame.set === "treatment" ? TREATMENT : CONSULT).room;
  const points = walk.path.map((p) => toStageFloor(patientView, p));
  const inside = (p: FloorPoint) => p.x >= room.x0 && p.x <= room.x1 && p.z >= room.z0 && p.z <= room.z1;
  if (!inside(points[points.length - 1]!)) return [];
  let start = points.length - 1;
  while (start > 0 && inside(points[start - 1]!)) start--;
  return points.slice(start);
}
