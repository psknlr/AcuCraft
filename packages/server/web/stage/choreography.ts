/** Presentation time only. Engine actions have already executed; this clock never authorizes treatment. */
export type ProcedureKind = "insert" | "remove" | "work";

const clamp = (t: number) => Math.max(0, Math.min(1, t));
export const settle = (t: number) => { const x = clamp(t); return x * x * x * (x * (x * 6 - 15) + 10); };

export const INSERTION_HOVER_M = 0.012;

/** Signed distance along the accepted shaft. Both quintics share velocity and zero acceleration at skin contact. */
export function insertionDepth(t: number, depth: number, contact: number, hover = INSERTION_HOVER_M): number {
  const approachRate = hover / contact, inwardRate = depth / (1 - contact);
  // At a grazing or very shallow registration, breathing may put both endpoints on one
  // side of the live skin. The path meets it at rest before settling at the fixed endpoint.
  const crossingRate = approachRate > 0 && inwardRate > 0 ? 2 * approachRate * inwardRate / (approachRate + inwardRate) : 0;
  // Quintic Hermite segment from rest to the given end velocity in local time.
  const travel = (u: number, distance: number, endVelocity: number) =>
    distance * settle(u) + endVelocity * u ** 3 * (-4 + u * (7 - 3 * u));
  if (t <= contact) return travel(clamp(t / contact), hover, crossingRate * contact) - hover;
  return depth - travel(clamp((1 - t) / (1 - contact)), depth, crossingRate * (1 - contact));
}

export function sampleProcedure(kind: ProcedureKind, elapsedMs: number, workMs = 1800, operationMs?: number): {
  reach: number; grip: number; operation: number; operating: boolean; complete: boolean; durationMs: number; operationStartMs: number;
} {
  const approach = 850, grasp = 220, release = 200, retreat = 650;
  const duration = operationMs !== undefined && Number.isFinite(operationMs) ? Math.max(1, operationMs) : kind === "insert" ? 1100 : kind === "remove" ? 850 : workMs;
  const begin = approach + grasp, end = begin + duration;
  const durationMs = end + release + retreat;
  const t = Math.max(0, elapsedMs);
  return {
    reach: t < approach ? settle(t / approach) : 1 - settle((t - end - release) / retreat),
    grip: t < begin ? settle((t - approach) / grasp) : 1 - settle((t - end) / release),
    operation: (kind === "insert" ? clamp : settle)((t - begin) / duration),
    operating: t >= begin && t < end,
    complete: t >= durationMs,
    durationMs,
    operationStartMs: begin,
  };
}
