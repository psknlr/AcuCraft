import type { ActionType } from "../schema/actions.js";
import type { Permission, Role, Rule, RuleSet } from "../schema/governance.js";
import type { EncounterState } from "../schema/state.js";
import { visitIndex } from "./queries.js";
import { roleOf, type Scenario } from "./scenario.js";

/** The permission every action needs (null: anyone in the cast may do it). */
export const ACTION_PERMISSIONS: Record<ActionType, Permission | null> = {
  say: "communicate",
  ask: "consult",
  observe: "examine",
  examine: "examine",
  review_result: "review-records",
  order_investigation: "order-investigation",
  check_vitals: "record-vitals",
  assess: "assess",
  decide: "assess",
  propose_plan: "plan",
  explain: "seek-consent",
  seek_consent: "seek-consent",
  refer: "refer",
  position_patient: "position-patient",
  identify_landmark: "localise",
  measure: "localise",
  mark_point: "localise",
  move: "move",
  hand_hygiene: "hand-hygiene",
  fetch: "fetch",
  handover: "handle-equipment",
  open_pack: "open-pack",
  pick_up: "handle-equipment",
  prepare_site: "prepare-site",
  insert_needle: "insert-needle",
  adjust_needle: "manipulate-needle",
  monitor: "monitor",
  wait: null,
  stop_treatment: "monitor",
  remove_needle: "remove-needle",
  remove_all_needles: "remove-needle",
  apply_pressure: "apply-pressure",
  count_needles: "count-needles",
  dispose: "dispose-sharps",
  search: "search",
  report_incident: "report-incident",
  document: "document",
  end_visit: "end-visit",
  begin_follow_up: "end-visit",
  finish_encounter: "end-visit",
  assign_task: "delegate",
  acknowledge_task: "accept-task",
  decline_task: "accept-task",
  report_task: "accept-task",
  cancel_task: "delegate",
  approve_plan: "supervise",
};

/** Acts whose unauthorised attempt is itself unsafe (recorded as `unauthorised-act`, never executed). */
export const CLINICAL_ACTS: readonly ActionType[] = ["insert_needle", "adjust_needle", "remove_needle", "remove_all_needles", "open_pack", "prepare_site"];

export type PermissionVerdict = { ok: true } | { ok: false; reason: string };

/** Does the actor's role grant the permission an action needs, with its conditions met? */
export function checkPermission(sc: Scenario, s: EncounterState, actorId: string, type: ActionType): PermissionVerdict {
  const needed = ACTION_PERMISSIONS[type];
  if (needed === null) return { ok: true };
  const role = roleOf(sc, actorId);
  if (!role) return { ok: false, reason: `${actorId} has no role in this scenario` };
  const grant = role.grants.find((g) => (typeof g === "string" ? g : g.permission) === needed);
  if (!grant) return { ok: false, reason: `${role.label} is not authorised to ${needed.replace(/-/g, " ")} (${sc.roles.id})` };
  if (typeof grant !== "string") {
    const supervisors = sc.field.cast.filter((m) => roleOf(sc, m.id)?.kind === "supervisor").map((m) => m.id);
    const room = s.actors[actorId]?.location;
    const present = supervisors.some((id) => s.actors[id]?.location === room);
    if (!present) return { ok: false, reason: `${role.label}: ${needed.replace(/-/g, " ")} only with a supervisor present` };
    if (grant.requires === "supervisor-approval") {
      const plan = s.plans[s.plans.length - 1];
      if (!plan || s.planApproved !== plan.version) return { ok: false, reason: `${role.label}: ${needed.replace(/-/g, " ")} only once the supervisor has approved the current plan` };
    }
  }
  return { ok: true };
}

export function roleAccepts(role: Role | null, kind: string): boolean {
  return role !== null && role.acceptsTasks.includes(kind);
}

export interface RuleInForce {
  ruleSet: RuleSet;
  rule: Rule;
}

/** The encoded rules in force for this visit that apply to the actor's role. */
export function rulesInForce(sc: Scenario, s: EncounterState, actorId: string): RuleInForce[] {
  const sets = sc.rules.get(visitIndex(s)) ?? [];
  const role = roleOf(sc, actorId);
  const out: RuleInForce[] = [];
  for (const ruleSet of sets) {
    for (const rule of ruleSet.rules) {
      const applies = rule.appliesTo ?? ruleSet.appliesTo;
      if (role && applies.includes(role.id)) out.push({ ruleSet, rule });
    }
  }
  return out;
}

export function rulesOfKind<K extends Rule["check"]["kind"]>(rules: readonly RuleInForce[], kind: K): (RuleInForce & { rule: Rule & { check: Extract<Rule["check"], { kind: K }> } })[] {
  return rules.filter((r) => r.rule.check.kind === kind) as never;
}
