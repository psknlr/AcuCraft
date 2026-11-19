import type { AgentView } from "@acucraft/core";
import { patientPlacement, type Placement, type SetName } from "./cast.js";
import { CONSULT, TREATMENT } from "./set.js";

export interface FloorPoint { x: number; z: number }
export interface FloorFrame {
  set: SetName;
  origin: FloorPoint;
  anchor: FloorPoint;
  rotation: number;
}

/** The complete clinic and every actor now share the engine's floor coordinates, in metres. */
export function floorFrame(view: AgentView): FloorFrame {
  return { set: /treat|couch|bay/.test(view.space.you.room) ? "treatment" : "consult", origin: { x: 0, z: 0 }, anchor: { x: 0, z: 0 }, rotation: 0 };
}

export function toStageFloor(_view: AgentView, point: FloorPoint): FloorPoint { return { x: point.x, z: point.z }; }
export function fromStageFloor(_view: AgentView, point: FloorPoint): FloorPoint { return { x: point.x, z: point.z }; }

/** Standing figures face +z at zero rotation; the engine's zero yaw faces north (-z) and positive yaw turns west. */
export function practitionerFloorPlacement(view: AgentView, seed: string): Placement {
  return { set: floorFrame(view).set, position: "standing", options: { posture: "standing", seed }, at: { x: view.space.you.x, y: 0, z: view.space.you.z, rot: 180 + view.space.you.yaw * 180 / Math.PI } };
}

/** The patient follows their actual support fixture, even when the practitioner is in another room. */
export function patientFloorPlacement(view: AgentView, heightCm: number | null, seed: string): Placement {
  const placement = patientPlacement(view.patient.position, view.patient.location, heightCm, seed);
  const support = view.space.fixtures.find(f => f.id === view.space.patient.on);
  if (support && placement.position !== "standing") {
    const couch = placement.set === "treatment" ? TREATMENT.couch : CONSULT.patientChair;
    const lying = ["prone", "lying", "lateral"].includes(placement.options.posture);
    const dz = lying ? placement.at.z - couch.z : 0;
    const angle = support.rot * Math.PI / 180;
    placement.at = { x: support.x + dz * Math.sin(angle), y: 0, z: support.z + dz * Math.cos(angle), rot: support.rot };
  } else placement.at = { x: view.space.patient.x, y: 0, z: view.space.patient.z, rot: 180 + view.space.patient.yaw * 180 / Math.PI };
  return placement;
}

export function patientRoomView(view: AgentView): AgentView {
  return { ...view, space: { ...view.space, you: { ...view.space.you, x: view.space.patient.x, z: view.space.patient.z, room: view.space.patient.room } } };
}

/** Reuse the accepted escort's destination-room segment; do not invent patient offsets or routes. */
export function patientEscortArrival(view: AgentView): FloorPoint[] {
  const walk = view.space.walks.filter(w => w.actor === view.you.id).at(-1);
  if (!walk?.withPatient || walk.path.length < 2 || view.space.you.room !== view.space.patient.room) return [];
  const room = view.space.rooms.find(r => r.id === view.space.patient.room);
  if (!room) return [];
  const points = walk.path.map(p => ({ x: p.x, z: p.z }));
  const inside = (p: FloorPoint) => p.x >= room.minX && p.x <= room.maxX && p.z >= room.minZ && p.z <= room.maxZ;
  if (!inside(points[points.length - 1]!)) return [];
  let start = points.length - 1;
  while (start > 0 && inside(points[start - 1]!)) start--;
  return points.slice(start);
}
