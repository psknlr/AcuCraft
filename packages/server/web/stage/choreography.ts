/** Presentation time only. Engine actions have already executed; this clock never authorizes treatment. */
export type ProcedureKind = "insert" | "remove" | "work";

const clamp = (t: number) => Math.max(0, Math.min(1, t));
export const settle = (t: number) => { const x = clamp(t); return x * x * x * (x * (x * 6 - 15) + 10); };

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
    operation: settle((t - begin) / duration),
    operating: t >= begin && t < end,
    complete: t >= durationMs,
    durationMs,
    operationStartMs: begin,
  };
}
