import { afterEach, expect, it, vi } from "vitest";
import { Group, Quaternion, Vector3 } from "three";
import type { ArticulatedHand, FingerPose, HandContact } from "../web/stage/hand.js";
import type { Person } from "../web/stage/cast.js";
import type { PatientClearance } from "../web/stage/clearance.js";
import type { NeedleLayer } from "../web/stage/needles.js";
import { NeedleProcedure } from "../web/stage/procedure.js";

interface ClearancePlanningProbe {
  clearance: PatientClearance;
  clearancePlan: Map<ArticulatedHand, number>;
  clearanceRoll: Map<ArticulatedHand, number>;
  fingerPoses: Map<ArticulatedHand, FingerPose>;
  placements: { orientation: Quaternion }[];
  needleClearancePoses(hand: ArticulatedHand, current: FingerPose): FingerPose[];
  placeHand(hand: ArticulatedHand, person: Person, side: "left" | "right", contact: Vector3,
    axis: Vector3, reach: number, anchor: HandContact): void;
}

afterEach(() => vi.restoreAllMocks());

it("uses the replacement full-motion clearance plan after the initial patient pose invalidates the cached palm branch", () => {
  // Isolate branch selection with a controlled clearance oracle. The real
  // placeHand implementation still computes, caches and applies every frame.
  // Physical mesh clearance remains covered by the public scene tests.
  const current: FingerPose = { pose: "pinch", grip: 1, phase: 0 };
  const future: FingerPose = { ...current, phase: 1 };
  let posed = current;
  const root = new Group(), model = new Group(); root.add(model);
  const hand = {
    root, model, contactValid: true,
    contact: () => new Vector3(),
    wrist: () => new Vector3(0.1, 0.1, 0),
    wristOrientation: (orientation: Quaternion) => orientation.clone(),
    pose: (settings: FingerPose) => { posed = settings; },
  } as unknown as ArticulatedHand;
  const person = {
    shoulderAt: () => new Vector3(1, 0, 0),
    reach: () => ({}),
  } as unknown as Person;
  const patient = {} as Person;
  const procedure = new NeedleProcedure({} as NeedleLayer, () => person, () => {}, () => patient);
  const planning = procedure as unknown as ClearancePlanningProbe;
  planning.fingerPoses.set(hand, current);
  // Registration saw an earlier patient pose, so both caches still contain 0°.
  planning.clearancePlan.set(hand, 0);
  planning.clearanceRoll.set(hand, 0);
  vi.spyOn(planning, "needleClearancePoses").mockReturnValue([current, future]);
  const degrees = (orientation: Quaternion) => 2 * Math.atan2(orientation.y, orientation.w) * 180 / Math.PI;
  vi.spyOn(planning.clearance, "intersects").mockImplementation(() => {
    // The present open shape clears at -7°, but the later closed shape needs
    // -25°. A newly planned -30° branch clears the complete motion.
    return degrees(root.quaternion) > (posed.phase === 1 ? -25 : -7);
  });

  planning.placeHand(hand, person, "right", new Vector3(), new Vector3(0, 1, 0), 0, "handle");
  const approach = planning.placements.at(-1)!.orientation.clone();
  expect(posed, "planning restores the currently rendered finger pose").toBe(current);
  expect(degrees(approach), "a stale frame roll cannot override the replacement full-motion plan").toBeCloseTo(-30, 8);
  expect(planning.clearancePlan.get(hand)).toBeCloseTo(-Math.PI / 6, 8);

  // Advance normally, without a preview seek that would separately clear the
  // roll cache. The same branch must still clear the future finger geometry.
  hand.pose(future); planning.fingerPoses.set(hand, future);
  planning.placeHand(hand, person, "right", new Vector3(), new Vector3(0, 1, 0), 1, "handle");
  const working = planning.placements.at(-1)!.orientation;
  expect(working.angleTo(approach), "the visible hand retains the branch chosen while off screen").toBeLessThan(1e-8);
  expect(planning.clearance.intersects(model, patient), "the subsequent working pose remains clear").toBe(false);
});
