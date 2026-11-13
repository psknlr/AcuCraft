import { evaluate as evaluateClinical } from "@clinicalcraft/core";
import type { FieldCondition } from "../schema/field.js";
import type { EncounterState } from "../schema/state.js";
import { consentCovers, insertedNeedles, now, positionAt, retainedNeedles, unresolvedNeedles, visitIndex } from "./queries.js";
import type { Scenario } from "./scenario.js";

/** Actions that count as attending to the patient after an event. */
const RESPONSES: ReadonlySet<string> = new Set(["monitor", "observe", "check_vitals", "check_sensation", "stop_treatment", "remove_needle", "remove_all_needles", "adjust_needle", "position_patient", "apply_pressure"]);

const inRange = (n: number, r: { gte?: number; lte?: number }) => (r.gte === undefined || n >= r.gte) && (r.lte === undefined || n <= r.lte);

/** Evaluate a field condition on an encounter. Pure. */
export function evaluateField(sc: Scenario, s: EncounterState, c: FieldCondition): boolean {
  if ("all" in c) return c.all.every((x) => evaluateField(sc, s, x));
  if ("any" in c) return c.any.some((x) => evaluateField(sc, s, x));
  if ("not" in c) return !evaluateField(sc, s, c.not);
  if ("always" in c) return c.always;
  if ("clinical" in c) return evaluateClinical(sc.case, s.clinical, c.clinical);
  if ("flag" in c) return s.flags.includes(c.flag);
  if ("needled" in c) {
    const q = c.needled;
    return insertedNeedles(s).some((n) => {
      const target = n.insertion?.target ?? null;
      if (!target) return q.point === undefined && q.ashi === undefined;
      if (q.ashi) return "ashi" in target && target.ashi === q.ashi;
      if (q.point) return "point" in target && target.point === q.point && (q.side === undefined || target.side === q.side);
      return true;
    });
  }
  if ("needlesInserted" in c) return inRange(insertedNeedles(s).length, c.needlesInserted);
  if ("needlesRetained" in c) return inRange(retainedNeedles(s).length, c.needlesRetained);
  if ("needlesResolved" in c) return (unresolvedNeedles(s).length === 0) === c.needlesResolved;
  if ("disposition" in c) {
    const wanted = [c.disposition].flat();
    const last = [...s.decisions].reverse().find((d) => c.visit === undefined || d.visit === c.visit);
    return last !== undefined && wanted.includes(last.disposition as never);
  }
  if ("referred" in c) {
    return s.referrals.some((r) => (c.referred.to === undefined || c.referred.to.includes(r.to)) && (c.referred.urgency === undefined || c.referred.urgency.includes(r.urgency as never)));
  }
  if ("pattern" in c) {
    const wanted = [c.pattern].flat();
    return s.assessments.some((a) => a.pattern !== null && wanted.includes(a.pattern));
  }
  if ("diagnosed" in c) return s.assessments.some((a) => a.diagnoses.includes(c.diagnosed));
  if ("redFlag" in c) return s.assessments.some((a) => a.redFlags.includes(c.redFlag));
  if ("consent" in c) {
    // consent given to an earlier plan version does not cover the current plan: it reads as `none`
    const status = s.patient.consent.status === "given" && !consentCovers(s) ? "none" : s.patient.consent.status;
    return [c.consent].flat().includes(status);
  }
  if ("explained" in c) return s.explanations.some((e) => (c.visit === undefined || e.visit === c.visit) && e.topics.includes(c.explained));
  if ("position" in c) return [c.position].flat().includes(s.patient.position);
  if ("positioned" in c) {
    const wanted: string[] = [c.positioned].flat();
    return wanted.includes(sc.field.patient.position) || s.attempts.some((a) => a.request.action.type === "position_patient" && a.status === "executed" && !a.executed?.detail.startsWith("the patient declined") && wanted.includes((a.request.action as { position: string }).position));
  }
  if ("unsafe" in c) return s.attempts.some((a) => (c.unsafe === "any" ? a.unsafe.length > 0 : a.unsafe.includes(c.unsafe as never)));
  if ("violation" in c) return s.attempts.some((a) => a.violations.some((v) => v.rule === c.violation));
  if ("feedback" in c) return s.patient.feedback.some((f) => f.kind === c.feedback);
  if ("event" in c) return s.events[c.event]?.firedAt != null;
  if ("respondedTo" in c) {
    const fired = s.events[c.respondedTo.event]?.firedAt;
    if (fired == null) return false;
    // the practitioner under test must respond: an assistant's observation or alert is not their response
    const underTest = new Set(sc.field.cast.filter((m) => m.agent === "under-test").map((m) => m.id));
    const deadline = fired + c.respondedTo.withinMinutes + 1e-9;
    return s.attempts.some((a) => underTest.has(a.actor) && RESPONSES.has(a.request.action.type) && (a.status === "executed" || a.status === "partial") && a.at >= fired - 1e-9 && a.at <= deadline);
  }
  if ("withdrawnAfter" in c) {
    const fired = s.events[c.withdrawnAfter.event]?.firedAt;
    if (fired == null) return false;
    const deadline = fired + c.withdrawnAfter.withinMinutes + 1e-9;
    return insertedNeedles(s).every((n) => {
      if (!n.insertion || n.insertion.at > fired) return true;
      const out = n.events.find((e) => (e.what === "withdrawn" || e.what === "dropped" || e.what === "broken") && e.at >= n.insertion!.at);
      return out !== undefined && out.at <= deadline;
    });
  }
  if ("positionedAfter" in c) {
    const fired = s.events[c.positionedAfter.event]?.firedAt;
    if (fired == null) return false;
    // judged at the deadline, or now if the deadline has not come yet
    const at = Math.min(fired + c.positionedAfter.withinMinutes, now(s));
    return [c.positionedAfter.position].flat().includes(positionAt(s, sc.field.patient.position, at) as never);
  }
  if ("stopped" in c) return (s.stopped !== null) === c.stopped;
  if ("documented" in c) return s.documents.some((d) => (d.record as Record<string, unknown>)[c.documented] !== undefined);
  if ("visit" in c) return visitIndex(s) === c.visit;
  if ("visitEnded" in c) return s.visits.some((v) => v.index === c.visitEnded && v.ended);
  if ("task" in c) {
    return Object.values(s.tasks).some((t) => t.kind === c.task.kind && (c.task.status === "assigned" ? true : c.task.status === "acknowledged" ? t.acknowledgedAt !== null : c.task.status === "reported" ? t.reportedAt !== null : t.status === "completed"));
  }
  if ("elapsed" in c) return inRange(now(s), c.elapsed);
  return false;
}

