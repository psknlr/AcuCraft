import type { Action } from "../schema/actions.js";

export interface NeedleMotion {
  technique: "none" | "lift-thrust" | "rotate";
  depthCm: number;
  /** Total peak-to-peak axial excursion, in millimetres. */
  strokeMm: number;
  /** Peak angular displacement for alternating turns, or degrees per cycle for one-way turns. */
  rotationDeg: number;
  rotationDirection: "alternating" | "clockwise" | "counterclockwise";
  frequencyHz: number;
  durationSeconds: number;
}

/** Bounds are simulation input limits, never patient-specific clinical recommendations. */
export function needleMotion(action: Extract<Action, { type: "adjust_needle" }>, depthCm: number): NeedleMotion {
  return { technique: action.technique, depthCm, strokeMm: action.technique === "lift-thrust" ? (action.strokeMm ?? 2) : 0,
    rotationDeg: action.technique === "rotate" ? (action.rotationDeg ?? 90) : 0, rotationDirection: action.rotationDirection ?? "alternating",
    frequencyHz: action.frequencyHz ?? 1, durationSeconds: action.durationSeconds ?? 30 };
}

export function motionEnvelope(motion: NeedleMotion): { minDepthCm: number; maxDepthCm: number } {
  return { minDepthCm: motion.depthCm - motion.strokeMm / 20, maxDepthCm: motion.depthCm + motion.strokeMm / 20 };
}

/** Shared rendering/measurement function. t is seconds since this manipulation started. */
export function sampleNeedleMotion(motion: NeedleMotion, seconds: number): { depthCm: number; rotationRad: number } {
  if (seconds < 0 || seconds >= motion.durationSeconds) return { depthCm: motion.depthCm, rotationRad: 0 };
  const phase = seconds * motion.frequencyHz * Math.PI * 2;
  // Right-handed rotation about the outward shaft axis: clockwise looking handle-to-tip is negative.
  const rotation = motion.rotationDirection === "alternating" ? Math.sin(phase) : seconds * motion.frequencyHz * (motion.rotationDirection === "clockwise" ? -1 : 1);
  return { depthCm: motion.depthCm + Math.sin(phase) * motion.strokeMm / 20, rotationRad: rotation * motion.rotationDeg * Math.PI / 180 };
}
