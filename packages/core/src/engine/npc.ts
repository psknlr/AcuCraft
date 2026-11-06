import type { ActionInput } from "../schema/actions.js";
import type { EncounterState, TaskState } from "../schema/state.js";
import { now, retainedNeedles } from "./queries.js";
import type { Scenario } from "./scenario.js";

/**
 * Scripted policies for non-tested cast members (proposal §7.1). They act only through the action interface, from
 * the state as it is, and are deterministic, so a replay regenerates their acts exactly. They take no simulated
 * time: they work alongside the practitioner. Delegation is observable: assignment → acknowledgement → execution →
 * report.
 */

export type NpcPolicy = (sc: Scenario, s: EncounterState, actorId: string) => ActionInput | null;

const myTasks = (s: EncounterState, actorId: string, status: TaskState["status"]) =>
  Object.values(s.tasks)
    .filter((t) => t.assignee === actorId && t.status === status && t.source === "assignment")
    .sort((a, b) => a.assignedAt - b.assignedAt || (a.id < b.id ? -1 : 1));

function supportDefault(sc: Scenario, s: EncounterState, me: string): ActionInput | null {
  const self = s.actors[me];
  if (!self) return null;
  const pending = myTasks(s, me, "assigned")[0];
  if (pending) return { type: "acknowledge_task", taskId: pending.id };
  const patientRoom = s.patient.location;
  for (const task of myTasks(s, me, "acknowledged")) {
    const since = task.acknowledgedAt ?? task.assignedAt;
    switch (task.kind) {
      case "position-patient": {
        const position = String(task.params.position ?? "supine");
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        if (s.patient.position !== position) return { type: "position_patient", position: position as never };
        return { type: "report_task", taskId: task.id, summary: `The patient is now ${position}.` };
      }
      case "fetch": {
        const item = String(task.params.item ?? "");
        const holding = self.holding.includes(item);
        const assigner = s.actors[task.assignedBy];
        if (!holding) {
          const pack = s.packs[item];
          const at = pack ? pack.at : s.items[item]?.at;
          const room = at ? sc.clinic.rooms.find((r) => r.fixtures.some((f) => f.id === at))?.id : undefined;
          if (pack?.holder && pack.holder !== me) return { type: "report_task", taskId: task.id, summary: `${item} is already with ${pack.holder}.` };
          if (room && room !== self.location) return { type: "move", to: room };
          return { type: "fetch", item };
        }
        if (assigner && assigner.location !== self.location) return { type: "move", to: assigner.location };
        return { type: "handover", object: item, to: task.assignedBy };
      }
      case "monitor-patient": {
        const interval = Number(task.params.intervalMinutes ?? 5);
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        // urgent alerts first: an abnormal sensation or a faint since the task began, not yet passed on
        const lastAlert = Math.max(-1, ...s.utterances.filter((u) => u.speaker === me && u.to === task.assignedBy).map((u) => u.at));
        const unreported = s.patient.feedback.filter((f) => f.abnormal && f.at >= since && f.at > lastAlert);
        const myLast = Math.max(-Infinity, ...s.monitorLog.filter((m) => m.by === me && m.at >= since).map((m) => m.at));
        if (unreported.length > 0 && myLast >= unreported[unreported.length - 1]!.at) {
          const what = unreported.map((f) => f.kind.replace(/-/g, " ")).join(", ");
          return { type: "say", to: task.assignedBy, text: `The patient needs you now: ${what} — "${unreported[unreported.length - 1]!.text}"` };
        }
        const retained = retainedNeedles(s).length;
        const due = myLast === -Infinity || now(s) - myLast >= interval - 1e-9;
        if ((retained > 0 || s.patient.fainted || unreported.length > 0) && due) return { type: "monitor" };
        const hadNeedles = s.monitorLog.some((m) => m.by === me && m.at >= since);
        if (retained === 0 && !s.patient.fainted && hadNeedles) {
          const findings = [...new Set(s.patient.feedback.filter((f) => f.abnormal && f.at >= since).map((f) => f.kind))];
          return { type: "report_task", taskId: task.id, summary: findings.length > 0 ? `Monitored throughout; abnormal: ${findings.join(", ")}.` : "Monitored throughout; no concerns.", findings };
        }
        return null;
      }
      case "count-needles": {
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        const counted = s.counts.some((c) => c.by === me && c.at >= since);
        if (!counted) return { type: "count_needles" };
        const last = [...s.counts].reverse().find((c) => c.by === me)!;
        return { type: "report_task", taskId: task.id, summary: last.reconciled ? `Count reconciled: ${last.opened} opened, ${last.disposed} in sharps, ${last.retained} retained.` : `Count NOT reconciled: ${last.unaccounted} unaccounted for.` };
      }
      case "dispose-sharps": {
        const tray = Object.values(s.needles).find((n) => n.location.kind === "tray" && s.actors[me]?.location === patientRoom);
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        if (tray) return { type: "dispose", object: tray.packId };
        return { type: "report_task", taskId: task.id, summary: "Opened, unused needles on the tray are in the sharps container." };
      }
      case "record-vitals": {
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        const done = s.vitalsLog.find((v) => v.by === me && v.at >= since);
        if (!done) return { type: "check_vitals" };
        const text = Object.entries(done.vitals).map(([k, v]) => `${k} ${v}`).join(", ");
        return { type: "report_task", taskId: task.id, summary: `Vitals: ${text}.` };
      }
      case "chaperone":
      case "prepare-couch": {
        if (self.location !== patientRoom) return { type: "move", to: patientRoom };
        return { type: "report_task", taskId: task.id, summary: task.kind === "chaperone" ? "I am in the room as chaperone." : "The couch is ready." };
      }
    }
  }
  return null;
}

/** A supervisor who approves the current plan once it exists and stays with the learner. */
function supervisorDefault(_sc: Scenario, s: EncounterState, me: string): ActionInput | null {
  const self = s.actors[me];
  if (!self) return null;
  const plan = s.plans[s.plans.length - 1];
  if (plan && s.planApproved !== plan.version) return { type: "approve_plan" };
  const learner = Object.values(s.actors).find((a) => a.id !== me && a.role.includes("learner"));
  if (learner && learner.location !== self.location) return { type: "move", to: learner.location };
  return null;
}

export const NPC_POLICIES: Record<string, NpcPolicy> = {
  "support-default": supportDefault,
  "supervisor-default": supervisorDefault,
  /** Present but passive (does only what it is told, and nothing on its own). */
  idle: () => null,
};
