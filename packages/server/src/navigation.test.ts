import { describe, expect, it } from "vitest";
import { clinicWorld, floorPlan, freeSpot, type AgentView } from "@acucraft/core";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { keyboardDestination } from "../web/navigation.js";
import { floorFrame, fromStageFloor, patientEscortArrival, patientRoomView, practitionerFloorPlacement, toStageFloor } from "../web/stage/navigation.js";
import { CONSULT, TREATMENT } from "../web/stage/set.js";
import { operator, RecordHub } from "./hub.js";

const pack = loadContentPack();
const sc = requireScenario(pack, "sg-knee-oa/base");

describe("avatar floor controls", () => {
  it("maps keyboard steps in metres without handling unrelated shortcuts", () => {
    expect(keyboardDestination({ x: 1.25, z: -3.5 }, "ArrowUp")).toEqual({ x: 1.25, z: -4 });
    expect(keyboardDestination({ x: 1.25, z: -3.5 }, "D")).toEqual({ x: 1.75, z: -3.5 });
    expect(keyboardDestination({ x: 1.25, z: -3.5 }, "Enter")).toBeNull();
  });

  it("sends coordinate destinations through the hub's checked action path, records the actor and plans around walls", () => {
    const hub = new RecordHub({ pack });
    const by = operator("Navigator", "tab-nav");
    const made = hub.create({ family: "sg-knee-oa", variant: 1, seed: 1 }, by);
    const id = (made.body as { id: string }).id;
    const before = hub.snapshot(id)!;
    const dest = floorPlan(sc).rooms.find((r) => r.id === "treatment-room")!.home;
    const answer = hub.act(id, "move", { to: dest }, by);
    expect(answer.body).toMatchObject({ ok: true, entry: { tool: "move", by: { name: "Navigator" }, status: "executed" } });
    const after = hub.snapshot(id)!;
    expect(after.view.space.you.room).toBe("treatment-room");
    expect(freeSpot(clinicWorld(sc), after.view.space.you)).toBe(true);
    expect(after.view.minute).toBeGreaterThan(before.view.minute);
    // The patient's body is moved only by an explicit escort/position action.
    expect(after.view.space.patient).toMatchObject({ room: before.view.space.patient.room, x: before.view.space.patient.x, z: before.view.space.patient.z });
    const priorPosition = { ...after.view.space.you };
    const rejected = hub.act(id, "move", { to: { x: 1e6, z: 1e6 } }, by);
    expect(rejected.body).toMatchObject({ ok: false, entry: { status: "rejected" } });
    expect(hub.snapshot(id)!.view.space.you).toEqual(priorPosition);
  });

  it("an escort cannot bypass retained needle guards", () => {
    const session = new EncounterSession(sc, { seed: 1 });
    for (const request of sc.field.solution) {
      const result = session.act(request.action);
      if (request.action.type === "insert_needle") {
        expect(result.attempt.status).toBe("executed");
        break;
      }
    }
    const where = { ...session.view().space.patient };
    const result = session.act({ type: "move", to: { room: "consult-room" }, withPatient: true });
    expect(result.attempt.code).toBe("needles-retained");
    expect(result.view.space.patient).toMatchObject({ room: where.room, x: where.x, z: where.z });
  });
});

describe("the engine floor and the presentation sets", () => {
  const initial = (): AgentView => new EncounterSession(sc).view();

  it("keeps coordinates invertible and anchors the real consultation chair to the drawn chair", () => {
    const view = initial();
    const fixture = view.space.fixtures.find((f) => f.id === "consult-chair")!;
    expect(toStageFloor(view, fixture)).toEqual({ x: CONSULT.patientChair.x, z: CONSULT.patientChair.z });
    const point = { x: view.space.you.x + 0.73, z: view.space.you.z - 0.42 };
    const returned = fromStageFloor(view, toStageFloor(view, point));
    expect(returned.x).toBeCloseTo(point.x, 12);
    expect(returned.z).toBeCloseTo(point.z, 12);
  });

  it("rotates a couch facing east onto the drawn north-facing couch without mirroring movement", () => {
    const view = initial();
    const fixture = view.space.fixtures.find((f) => f.id === "couch-1")!;
    view.space.you = { x: fixture.x + 1, z: fixture.z, room: fixture.room, facing: "east" };
    view.space.patient = { ...view.space.patient, room: fixture.room, on: fixture.id, x: fixture.x, z: fixture.z, lying: { head: "east", rightSide: "north" } };
    expect(floorFrame(view).set).toBe("treatment");
    const placement = practitionerFloorPlacement(view, "test");
    expect(placement.at.x).toBeCloseTo(TREATMENT.couch.x);
    expect(placement.at.z).toBeCloseTo(TREATMENT.couch.z - 1);
    expect(placement.at.rot).toBeCloseTo(180);
    const returned = fromStageFloor(view, placement.at);
    expect(returned.x).toBeCloseTo(view.space.you.x, 12);
    expect(returned.z).toBeCloseTo(view.space.you.z, 12);
  });

  it("places a standing patient in their own room even when the practitioner is elsewhere", () => {
    const view = initial();
    const chair = view.space.fixtures.find((f) => f.id === "consult-chair")!;
    view.space.you = { ...view.space.you, room: "treatment-room", x: 2.75, z: -2.75 };
    view.space.patient = { ...view.space.patient, room: "consult-room", on: null, x: chair.x + 0.75, z: chair.z - 0.25 };
    const patientView = patientRoomView(view);
    const at = toStageFloor(patientView, patientView.space.patient);
    expect(at.x).toBeCloseTo(CONSULT.patientChair.x + 0.75);
    expect(at.z).toBeCloseTo(CONSULT.patientChair.z - 0.25);
    expect(view.space.you.room).toBe("treatment-room");
  });

  it("reuses only an escort's contiguous arrival polyline, without fabricating patient offsets", () => {
    const view = initial();
    const chair = view.space.fixtures.find((f) => f.id === "treat-chair")!;
    view.space.you = { ...view.space.you, room: chair.room, x: chair.x + 0.5, z: chair.z };
    view.space.patient = { ...view.space.patient, room: chair.room, on: chair.id, x: chair.x, z: chair.z };
    const path = [{ x: chair.x - 20, z: chair.z }, { x: chair.x - 0.5, z: chair.z }, { x: chair.x + 0.5, z: chair.z }];
    view.space.lastWalk = { attempt: 4, from: path[0]!, to: path[2]!, path, withPatient: true };
    const patientView = patientRoomView(view);
    expect(patientEscortArrival(view)).toEqual(path.slice(1).map((p) => toStageFloor(patientView, p)));
    view.space.lastWalk.withPatient = false;
    expect(patientEscortArrival(view)).toEqual([]);
    expect(view.space.lastWalk.path).toEqual(path);
  });
});
