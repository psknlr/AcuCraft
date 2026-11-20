import type { PointRef } from "../schema/actions.js";
import type { EncounterState, NeedleState, PlanVersion, VisitState } from "../schema/state.js";

/** Read-only helpers over an encounter state. */

export const now = (s: EncounterState): number => s.clinical.clock;

export function currentVisit(s: EncounterState): VisitState {
  return s.visits[s.visits.length - 1]!;
}

export const visitIndex = (s: EncounterState): number => currentVisit(s).index;

export const needleList = (s: EncounterState): NeedleState[] => Object.values(s.needles).sort((a, b) => (a.id < b.id ? -1 : 1));

export const retainedNeedles = (s: EncounterState): NeedleState[] => needleList(s).filter((n) => n.location.kind === "patient");

/** Acts that show whoever does them which needles are in the patient. */
const LOOKS: ReadonlySet<string> = new Set(["monitor", "observe", "count_needles", "search", "remove_all_needles"]);
/** Acts on one needle: reaching for a needle that is gone finds it gone. */
const TOUCHES: ReadonlySet<string> = new Set(["adjust_needle", "remove_needle", "apply_pressure"]);

/**
 * A needle that fell out of the patient unseen and that nobody has missed yet. Everyone takes it to be where it was
 * placed until someone looks at the needles (monitoring, observing, a count, a search, taking them all out), reaches
 * for that needle, reports it, or the visit is over.
 */
export function fellUnseen(s: EncounterState, n: NeedleState): boolean {
  if (n.location.kind !== "floor" || !n.location.hidden || n.insertion === null) return false;
  if (n.resolution !== null || n.insertion.visit !== visitIndex(s)) return false;
  const fell = [...n.events].reverse().find((e) => e.what === "dropped");
  if (!fell) return false;
  // an act committed after the fall (the state version it fell at is that of the act under way then)
  return !s.attempts.some((a) => {
    if ((a.status !== "executed" && a.status !== "partial") || a.resultVersion <= fell.version) return false;
    const type = a.request.action.type;
    return LOOKS.has(type) || (TOUCHES.has(type) && (a.request.action as { needleId?: string }).needleId === n.id);
  });
}

/** Needles the team takes to be in the patient: those that are, and any that fell out unseen and are not yet missed. */
export const apparentlyRetained = (s: EncounterState): NeedleState[] => needleList(s).filter((n) => n.location.kind === "patient" || fellUnseen(s, n));

/** Needles taken out of their sealed pack (opened onto a tray): each must end disposed or with a recorded response. */
export const openedNeedles = (s: EncounterState): NeedleState[] => needleList(s).filter((n) => n.location.kind !== "pack");

export const insertedNeedles = (s: EncounterState): NeedleState[] => needleList(s).filter((n) => n.used);

/** Insertion events in order (a needle is inserted once: reuse is refused). */
export function insertionOrder(s: EncounterState): { needle: NeedleState; at: number; seq: number }[] {
  const out: { needle: NeedleState; at: number; seq: number }[] = [];
  for (const n of needleList(s)) for (const e of n.events) if (e.what === "inserted") out.push({ needle: n, at: e.at, seq: e.seq });
  return out.sort((a, b) => a.seq - b.seq);
}

/** Is a needle accounted for at the end of a visit? */
export function needleResolved(n: NeedleState): boolean {
  if (n.location.kind === "sharps") return true;
  if (n.location.kind === "pack") return true;
  if ((n.location.kind === "floor" && n.location.hidden) || n.location.kind === "broken-in-patient") return n.resolution !== null;
  return false;
}

export const unresolvedNeedles = (s: EncounterState): NeedleState[] => needleList(s).filter((n) => !needleResolved(n));

export function currentPlan(s: EncounterState): PlanVersion | null {
  return s.plans[s.plans.length - 1] ?? null;
}

export const refKey = (r: PointRef): string => ("ashi" in r ? `ashi:${r.ashi}` : `${r.point}:${r.side}`);

/** The inverse of `refKey`. */
export function parseRef(key: string): PointRef {
  const [head, tail] = key.split(":") as [string, string | undefined];
  return head === "ashi" ? { ashi: tail ?? "" } : ({ point: head, side: tail ?? "midline" } as PointRef);
}

export function planIncludes(plan: PlanVersion | null, r: PointRef): boolean {
  if (!plan) return false;
  const key = refKey(r);
  return plan.plan.points.some((p) => refKey(p as PointRef) === key);
}

/** Consent covers the current plan: given, for this visit, on this plan version. */
export function consentCovers(s: EncounterState): boolean {
  const plan = currentPlan(s);
  return s.patient.consent.status === "given" && plan !== null && s.patient.consent.planVersion === plan.version;
}

/** Explanation topics given to the patient in this visit. */
export function explainedTopics(s: EncounterState): Set<string> {
  const v = visitIndex(s);
  return new Set(s.explanations.filter((e) => e.visit === v).flatMap((e) => e.topics));
}

/** The latest assessment of the visit. */
export const latestAssessment = (s: EncounterState) => s.assessments[s.assessments.length - 1] ?? null;
export const latestDecision = (s: EncounterState) => s.decisions[s.decisions.length - 1] ?? null;

export function supervisorPresent(s: EncounterState, room: string, supervisorIds: readonly string[]): boolean {
  return supervisorIds.some((id) => s.actors[id]?.location === room);
}

export const fmt = (n: number, places = 1): string => (Math.round(n * 10 ** places) / 10 ** places).toFixed(places);

/** The patient's position at time `t`: the initial position, then each executed repositioning (refusals excluded). */
export function positionAt(s: EncounterState, initial: string, t: number): string {
  let position = initial;
  for (const a of s.attempts) {
    if (a.at > t + 1e-9) break;
    if (a.request.action.type !== "position_patient" || (a.status !== "executed" && a.status !== "partial")) continue;
    if (a.executed?.detail.startsWith("the patient declined")) continue;
    position = (a.request.action as { position: string }).position;
  }
  return position;
}
