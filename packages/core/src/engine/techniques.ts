import type { NeedleMotionSettings, NeedleTechnique } from "../schema/actions.js";

/** Existing simulation stimuli, shared by aliases; no special clinical effect is attributed to bu or xie. */
export function techniqueStimulus(technique: NeedleTechnique): "lift-thrust" | "rotate" | null {
  if (technique === "none") return null;
  return technique === "rotate" || technique === "twist" ? "rotate" : "lift-thrust";
}

const bounded = (value: number | undefined, fallback: number, lo: number, hi: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.min(hi, Math.max(lo, value));

/** Resolve a presentation profile. Millimetres, degrees, milliseconds; cycles apply over the whole duration. */
export function resolveNeedleMotion(_technique: NeedleTechnique, settings: NeedleMotionSettings = {}): Required<NeedleMotionSettings> {
  return {
    cycles: Math.round(bounded(settings.cycles, 3, 1, 8)),
    durationMs: bounded(settings.durationMs, 1800, 400, 8000),
    strokeMm: bounded(settings.strokeMm, 1.5, 0, 3),
    rotationDeg: bounded(settings.rotationDeg, 90, 0, 180),
  };
}

export interface NeedleMotionSample {
  /** Outward axial displacement from the engine-approved depth, in millimetres. Never negative. */
  withdrawalMm: number;
  /** Twist about the needle's own shaft, in radians. Returns to zero when complete. */
  rotationRad: number;
  durationMs: number;
  complete: boolean;
}

/** Quintic interpolation has zero velocity and acceleration at both ends of a phase. */
const smooth = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

/**
 * Sample a deterministic manipulation for a renderer or Blender animation. elapsedMs is measured from its start.
 * Clamp withdrawalMm to the retained depth before drawing: a stroke is never an invitation to extend the tip's
 * approved path. Depth changes use adjust_needle.depthCm and pass the engine's anatomy guard separately.
 *
 * Bu and xie use opposite asymmetric phase timing to make the two authored gestures distinguishable. This is a
 * visual convention for the simulator, not an expert-reviewed prescription or a claim of physiological effects.
 */
export function techniqueMotion(technique: NeedleTechnique, elapsedMs: number, settings?: NeedleMotionSettings): NeedleMotionSample {
  const motion = resolveNeedleMotion(technique, settings);
  const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs);
  const complete = technique === "none" || elapsed >= motion.durationMs;
  const out: NeedleMotionSample = { withdrawalMm: 0, rotationRad: 0, durationMs: motion.durationMs, complete };
  if (complete || elapsed === 0) return out;
  const phase = ((elapsed / motion.durationMs) * motion.cycles) % 1;
  const axial = technique !== "rotate" && technique !== "twist";
  // Distinguish a lift-led gesture and a thrust-led gesture while returning each to its starting depth.
  const split = technique === "lift" || technique === "xie" ? 0.3 : technique === "thrust" || technique === "bu" ? 0.7 : 0.5;
  if (axial) out.withdrawalMm = motion.strokeMm * (phase < split ? smooth(phase / split) : 1 - smooth((phase - split) / (1 - split)));
  if (!axial || technique === "bu" || technique === "xie") {
    const envelope = Math.sin(Math.PI * phase) ** 2;
    out.rotationRad = (motion.rotationDeg * Math.PI / 180) * Math.sin(2 * Math.PI * phase) * envelope;
  }
  return out;
}
