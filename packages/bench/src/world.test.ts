import { describe, expect, it } from "vitest";
import {
  ARM_REACH_M,
  clinicWorld,
  createEncounter,
  fixtureReach,
  floorPlan,
  freeSpot,
  observeAs,
  planWalk,
  regionAccess,
  roomAt,
  siteOf,
  siteReach,
  step,
  walkMinutes,
  WALK_M_PER_MIN,
  type ActionInput,
  type ActionRequestInput,
  type EncounterState,
  type Position,
  type Scenario,
  type Side,
} from "@acucraft/core";
import { loadContentPack, requireScenario, scenarioIds } from "./content.js";

/**
 * The clinic as a walkable world (docs/WORLD.md): the floor plan is a ClinicalCraft facility; people stand somewhere,
 * walk along planned paths, and can only do what is within reach of where they stand.
 */

const pack = loadContentPack();
const knee = requireScenario(pack, "sg-knee-oa/base");
const w = clinicWorld(knee);

let n = 0;
const req = (action: ActionInput, actor = "practitioner"): ActionRequestInput => ({ requestId: `w-${++n}`, actor, patient: "patient", action });
const go = (to: Extract<ActionInput, { type: "move" }>["to"], withPatient = false) => req({ type: "move", to, ...(withPatient ? { withPatient } : {}) });
const act = (sc: Scenario, s: EncounterState, r: ActionRequestInput) => step(sc, s, r, { strict: true });
const upTo = (sc: Scenario, type: string, nth = 1): EncounterState => {
  let s = createEncounter(sc, { seed: 1 });
  let seen = 0;
  for (const r of sc.field.solution) {
    if (r.action.type === type && ++seen === nth) break;
    s = act(sc, s, r).state;
  }
  return s;
};
/** The walk a refusal names: `move {"to": …}` in its message. */
const hinted = (message: string): ActionInput => ({ type: "move", to: JSON.parse(message.match(/move (\{.*\})\./)![1]!).to });

describe("the clinic's floor plan", () => {
  it("is a ClinicalCraft facility that compiles and checks clean, with every room and fixture of the clinic on it", () => {
    expect(pack.issues).toEqual([]);
    expect(w.facility.id).toBe(knee.clinic.facility);
    expect([...w.rooms.keys()].sort()).toEqual(knee.clinic.rooms.map((r) => r.id).sort());
    for (const room of knee.clinic.rooms) {
      expect(freeSpot(w, room.home), `${room.id} home`).toBe(true);
      expect(roomAt(w, room.home)).toBe(room.id);
      for (const fx of room.fixtures) expect(w.fixtures.get(fx.id)?.room, fx.id).toBe(room.id);
    }
    // the needle trolley carries the sharps box: two fixtures, one placement
    expect(w.fixtures.get("sharps-1")!.entity.id).toBe(w.fixtures.get("trolley-1")!.entity.id);
  });

  it("can be walked: every fixture from every room, through the doors and round the furniture", () => {
    for (const room of w.rooms.values()) {
      for (const fx of w.fixtures.values()) {
        if (fx.kind === "screen") continue;
        const plan = planWalk(w, { ...room.home, yaw: 0 }, { kind: "fixture", id: fx.id });
        expect(plan.ok, `${room.id} → ${fx.id}`).toBe(true);
        if (!plan.ok) continue;
        expect(fixtureReach(w, plan.to, fx.id)?.ok, `${fx.id} from where the walk ends`).toBe(true);
        expect(freeSpot(w, plan.to)).toBe(true);
      }
    }
    // a wall is walked round: consultation room to the couch is further than the straight line through it
    const from = w.rooms.get("consult-room")!.home;
    const plan = planWalk(w, { ...from, yaw: 0 }, { kind: "fixture", id: "couch-1" });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.metres).toBeGreaterThan(Math.hypot(plan.to.x - from.x, plan.to.z - from.z) + 2);
    expect(plan.path.length).toBeGreaterThan(2);
    // and the same question has the same answer
    expect(planWalk(w, { ...from, yaw: 0 }, { kind: "fixture", id: "couch-1" })).toEqual(plan);
  });

  it("is public knowledge without anything about the patient", () => {
    const plan = floorPlan(knee);
    expect(plan.fixtures.map((f) => f.id)).toContain("couch-1");
    expect(plan.rooms.find((r) => r.id === "treatment-room")!.doors.length).toBe(1);
    expect(plan.ranges.armReach).toBe(ARM_REACH_M);
    expect(JSON.stringify(plan)).toBe(JSON.stringify(floorPlan(requireScenario(pack, "sg-knee-oa/hot-knee"))));
  });
});

describe("standing somewhere", () => {
  it("starts everyone where the visit starts: the practitioner at the desk beside the seated patient, the assistant in the treatment room", () => {
    const s = createEncounter(knee, { seed: 1 });
    expect(s.actors.practitioner!.location).toBe("consult-room");
    expect(s.patient).toMatchObject({ location: "consult-room", support: "consult-chair", position: "seated" });
    const view = observeAs(knee, s, "practitioner");
    expect(view.space.patient).toMatchObject({ inEarshot: true, atSide: true, inSight: true, on: "consult-chair", lying: null });
    expect(view.space.fixtures.find((f) => f.id === "consult-terminal")!.inReach).toBe(true);
    expect(view.space.fixtures.find((f) => f.id === "treat-sink")!.inReach).toBe(false);
    expect(view.space.team[0]).toMatchObject({ id: "assistant", room: "treatment-room", inReach: false });
  });

  it("a walk follows a planned path, takes the time it takes, and is on the record", () => {
    const s0 = createEncounter(knee, { seed: 1 });
    const r = act(knee, s0, go({ fixture: "treat-sink" }));
    expect(r.attempt.status).toBe("executed");
    const walk = r.state.walks.at(-1)!;
    expect(walk).toMatchObject({ actor: "practitioner", withPatient: false, attempt: r.attempt.index });
    expect(walk.metres).toBeGreaterThan(10);
    expect(walk.minutes).toBe(walkMinutes(walk.metres, false));
    expect(r.state.clinical.clock - s0.clinical.clock).toBeCloseTo(walk.metres / WALK_M_PER_MIN, 1);
    expect(r.state.actors.practitioner!.location).toBe("treatment-room");
    expect(observeAs(knee, r.state, "practitioner").space.fixtures.find((f) => f.id === "treat-sink")!.inReach).toBe(true);
    // walking the patient is slower, and seats them in the room
    const escorted = act(knee, s0, go("treatment-room", true));
    expect(escorted.state.patient).toMatchObject({ location: "treatment-room", support: "treat-chair", position: "seated" });
    expect(escorted.state.walks.at(-1)!.withPatient).toBe(true);
    expect(escorted.state.walks.at(-1)!.minutes).toBeGreaterThan(walkMinutes(escorted.state.walks.at(-1)!.metres, false));
    expect(observeAs(knee, escorted.state, "practitioner").space.patient.atSide).toBe(true);
  });

  it("refuses what is out of reach and names the walk that brings it within reach", () => {
    let s = act(knee, createEncounter(knee, { seed: 1 }), go("treatment-room", true)).state;
    const cases: ActionInput[] = [
      { type: "hand_hygiene" },
      { type: "fetch", item: "pack-a" },
      { type: "dispose", object: "pack-a" },
    ];
    for (const a of cases) {
      const refused = act(knee, s, req(a));
      expect(refused.attempt, a.type).toMatchObject({ status: "rejected", code: "not-in-reach" });
      const walked = act(knee, refused.state, req(hinted(refused.attempt.message)));
      expect(walked.attempt.status).toBe("executed");
      const again = act(knee, walked.state, req(a));
      expect(again.attempt.code, `${a.type} after the walk it named`).not.toBe("not-in-reach");
      s = again.state;
    }
    // the patient: out of earshot from the preparation area, out of sight behind its wall
    const far = act(knee, s, go({ fixture: "shelf" })).state;
    for (const a of [{ type: "ask", text: "How are you feeling?" }, { type: "examine", text: "Inspect the tongue" }, { type: "monitor" }] as ActionInput[]) {
      const refused = act(knee, far, req(a));
      expect(refused.attempt, a.type).toMatchObject({ status: "rejected", code: "not-at-patient" });
      expect(act(knee, act(knee, refused.state, req(hinted(refused.attempt.message))).state, req(a)).attempt.status, a.type).toBe("executed");
    }
    // speech is never refused, but nobody answers from the next room
    const said = act(knee, far, req({ type: "say", to: "patient", text: "What brings you in today?" }));
    expect(said.attempt.status).toBe("executed");
    expect(said.state.clinical.asked).toEqual(far.clinical.asked);
  });

  it("records are read at a terminal or with the patient, not in the corridor", () => {
    const s = act(knee, createEncounter(knee, { seed: 1 }), go({ room: "corridor" })).state;
    const refused = act(knee, s, req({ type: "review_result", investigationId: "inv-xray" }));
    expect(refused.attempt).toMatchObject({ status: "rejected", code: "not-in-reach" });
    expect(act(knee, act(knee, s, go({ fixture: "desk" })).state, req({ type: "review_result", investigationId: "inv-xray" })).attempt.status).toBe("executed");
  });
});

describe("round the couch", () => {
  it("lays each regional chart along the couch from its head end, the patient's right on the other side when they turn over", () => {
    const s = upTo(knee, "identify_landmark");
    expect(s.patient).toMatchObject({ support: "couch-1", position: "supine-knee-flexed" });
    const couch = w.fixtures.get("couch-1")!.area;
    const at = (region: string, side: Side, position: Position) => siteOf(knee, { ...s, patient: { ...s.patient, position } }, region, side).point;
    // head to the north (−z): the scalp near the head end, the foot near the other
    expect(at("scalp", "midline", "supine").z).toBeLessThan(at("abdomen", "midline", "supine").z);
    expect(at("abdomen", "midline", "supine").z).toBeLessThan(at("foot", "right", "supine").z);
    for (const region of knee.bundle.regions.keys()) {
      for (const side of ["left", "right", "midline"] as Side[]) {
        const p = at(region, side, "supine");
        expect(p.x >= couch.minX && p.x <= couch.maxX && p.z >= couch.minZ && p.z <= couch.maxZ, `${region} ${side} on the couch`).toBe(true);
      }
    }
    // supine, the right hand is to the west; prone, to the east; on the side, over the middle
    const mid = (couch.minX + couch.maxX) / 2;
    expect(at("hand-dorsum", "right", "supine").x).toBeLessThan(mid);
    expect(at("hand-dorsum", "right", "prone").x).toBeGreaterThan(mid);
    expect(at("hand-dorsum", "right", "prone").x).toBeCloseTo(at("hand-dorsum", "left", "supine").x, 6);
    expect(at("hand-dorsum", "right", "side-lying-left").x).toBeCloseTo(mid, 6);
    expect(observeAs(knee, s, "practitioner").space.patient.lying).toEqual({ head: "north", rightSide: "west" });
  });

  it("a site on the far side is out of arm's reach: the practitioner walks round", () => {
    const s = upTo(knee, "identify_landmark");
    expect(siteReach(knee, s, "practitioner", "knee-leg", "right").ok).toBe(true);
    const far = act(knee, s, req({ type: "identify_landmark", region: "knee-leg", side: "left", landmark: "st35-depression" }));
    expect(far.attempt).toMatchObject({ status: "rejected", code: "not-in-reach" });
    const view = observeAs(knee, s, "practitioner");
    expect(view.space.patient.sites.inReach).toContain("knee-leg:right");
    expect(view.space.patient.sites.outOfReach.map((x) => x.site)).toContain("knee-leg:left");
    const round = act(knee, far.state, req(hinted(far.attempt.message)));
    // round the head end or the foot of the couch: further than the width of the couch
    expect(round.state.walks.at(-1)!.metres).toBeGreaterThan(3);
    expect(act(knee, round.state, req({ type: "identify_landmark", region: "knee-leg", side: "left", landmark: "st35-depression" })).attempt.status).toBe("executed");
    expect(siteReach(knee, round.state, "practitioner", "knee-leg", "right").ok).toBe(false);
  });

  it("for every patient and position, every site the position gives access to can be stood beside", () => {
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      if (!sc.field.solution.some((r) => r.action.type === "insert_needle")) continue;
      const lying = upTo(sc, "mark_point");
      for (const position of ["supine", "prone", "side-lying-left"] as Position[]) {
        const s: EncounterState = { ...lying, patient: { ...lying.patient, position } };
        for (const [regionId, region] of sc.bundle.regions) {
          for (const side of (region.laterality === "bilateral" ? ["left", "right"] : ["left", "right", "midline"]) as Side[]) {
            if (!regionAccess(region, side, position).accessible) continue;
            const r = act(sc, s, go({ region: regionId, side }));
            expect(r.attempt.status, `${id} ${position} ${regionId} ${side}: ${r.attempt.message}`).toBe("executed");
            expect(siteReach(sc, r.state, "practitioner", regionId, side).ok, `${id} ${position} ${regionId} ${side}`).toBe(true);
          }
        }
      }
    }
  });

  it("taking every needle out walks from needle to needle", () => {
    const sc = requireScenario(pack, "sg-insomnia/base");
    const s = upTo(sc, "remove_all_needles");
    const before = s.walks.length;
    const r = act(sc, s, req({ type: "remove_all_needles" }));
    expect(r.attempt.status).toBe("executed");
    expect(Object.values(r.state.needles).filter((x) => x.location.kind === "patient")).toEqual([]);
    // wrists and legs on both sides: at least one walk round the couch, charged to the clock
    const walked = r.state.walks.slice(before).reduce((m, x) => m + x.metres, 0);
    expect(walked).toBeGreaterThan(3);
    expect(r.state.clinical.clock - s.clinical.clock).toBeGreaterThan(4 * 0.25 + walked / WALK_M_PER_MIN - 0.05);
  });
});

describe("the team has bodies too", () => {
  it("the assistant walks to the shelf and back to hand a pack over, and watches the patient from where she can see them", () => {
    let s = act(knee, createEncounter(knee, { seed: 1 }), go("treatment-room", true)).state;
    s = act(knee, s, req({ type: "assign_task", to: "assistant", kind: "fetch", params: { item: "pack-a" } })).state;
    expect(Object.values(s.tasks)[0]!.status).toBe("completed");
    expect(s.packs["pack-a"]!.holder).toBe("practitioner");
    const hers = s.walks.filter((x) => x.actor === "assistant");
    expect(hers.length).toBe(2);
    expect(s.attempts.filter((a) => a.actor === "assistant").map((a) => a.request.action.type)).toEqual(["acknowledge_task", "move", "fetch", "move", "handover", "report_task"]);
    // an assistant who cannot see the patient cannot observe them
    const away = act(knee, s, go({ fixture: "shelf" }, false)).state;
    const blind = step(knee, { ...away, actors: { ...away.actors, assistant: { ...away.actors.assistant!, at: away.actors.practitioner!.at, location: "prep-area" } } }, req({ type: "monitor" }, "assistant"), { strict: true });
    expect(blind.attempt).toMatchObject({ status: "rejected", code: "not-at-patient" });
  });

  it("a patient with needles in, or one who has fainted, is not walked anywhere", () => {
    const s = upTo(knee, "wait");
    const r = act(knee, s, go("consult-room", true));
    expect(r.attempt).toMatchObject({ status: "rejected", code: "needles-retained" });
    // and only a room is somewhere to walk a patient to
    expect(act(knee, createEncounter(knee, { seed: 1 }), go({ fixture: "couch-1" }, true)).attempt.code).toBe("invalid");
  });
});
