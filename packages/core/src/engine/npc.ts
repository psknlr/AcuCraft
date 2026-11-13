import type { ActionInput } from "../schema/actions.js";
import type { EncounterState, TaskState } from "../schema/state.js";
import { now, retainedNeedles } from "./queries.js";
import { clinicWorld, type Scenario } from "./scenario.js";
import { atFixture, atFixtureOfKind, nearActor, patientContact, patientSight } from "./space.js";

/**
 * Scripted policies for non-tested cast members (proposal §7.1). They act only through the action interface, from
 * the state as it is, and are deterministic, so a replay regenerates their acts exactly. They take no simulated
 * time: they work alongside the practitioner. Delegation is observable: assignment → acknowledgement → execution →
 * report. They have bodies like everyone else: an act out of reach is refused, so a policy walks first — to the
 * shelf, to the patient's side, to whoever asked — and its walks are on the record.
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
  const patient = s.patient.id;
  const w = clinicWorld(sc);
  const toRoom = (room: string): ActionInput | null => (w.rooms.has(room) ? { type: "move", to: { room } } : null);
  const report = (task: TaskState, summary: string, findings?: string[]): ActionInput => ({ type: "report_task", taskId: task.id, summary, ...(findings ? { findings } : {}) });
  for (const task of myTasks(s, me, "acknowledged")) {
    const since = task.acknowledgedAt ?? task.assignedAt;
    switch (task.kind) {
      case "position-patient": {
        const position = String(task.params.position ?? "supine");
        if (s.patient.position === position) return report(task, `The patient is now ${position}.`);
        // the patient may refuse: then the honest report says so, and the task stays unmet
        const declined = s.attempts.some((a) => a.actor === me && a.at >= since && a.request.action.type === "position_patient" && a.executed?.detail.startsWith("the patient declined"));
        if (declined) return report(task, `The patient declined to be ${position}.`);
        if (!patientContact(sc, s, me).ok) return { type: "move", to: { person: patient } };
        return { type: "position_patient", position: position as never };
      }
      case "fetch": {
        const item = String(task.params.item ?? "");
        const pack = s.packs[item];
        const thing = s.items[item];
        if (!pack && !thing) return report(task, `There is no ${item} in this clinic.`);
        const holder = pack ? pack.holder : thing!.holder;
        if (holder === task.assignedBy) return report(task, `You already have ${item}.`);
        if (holder !== me) {
          if (pack && !pack.sealed) return report(task, `${item} has already been opened: its needles are on the tray.`);
          if (holder) return report(task, `${item} is already with ${holder}.`);
          const at = pack ? pack.at : thing!.at;
          if (!at || !w.fixtures.has(at)) return report(task, `I cannot find ${item}.`);
          if (!atFixture(sc, s, me, at).ok) return { type: "move", to: { fixture: at } };
          return { type: "fetch", item };
        }
        if (s.actors[task.assignedBy] && !nearActor(sc, s, me, task.assignedBy, task.assignedBy).ok) return { type: "move", to: { person: task.assignedBy } };
        return { type: "handover", object: item, to: task.assignedBy };
      }
      case "monitor-patient": {
        const interval = Number(task.params.intervalMinutes ?? 5);
        const abnormal = s.patient.feedback.filter((f) => f.abnormal && f.at >= since);
        const myLast = Math.max(-Infinity, ...s.monitorLog.filter((m) => m.by === me && m.at >= since).map((m) => m.at));
        const lastAlert = Math.max(-1, ...s.utterances.filter((u) => u.speaker === me && u.to === task.assignedBy).map((u) => u.at));
        const unreported = abnormal.filter((f) => f.at > lastAlert);
        const retained = retainedNeedles(s).length;
        const watching = retained > 0 || s.patient.fainted || unreported.length > 0;
        // watching means seeing: from the room's usual spot if it has the patient in view, else from their side
        if (watching && !patientSight(sc, s, me).ok) return self.location !== patientRoom ? (toRoom(patientRoom) ?? { type: "move", to: { person: patient } }) : { type: "move", to: { person: patient } };
        // something abnormal I have not looked at yet: look now, then pass it on at once
        if (unreported.length > 0 && myLast < unreported[unreported.length - 1]!.at) return { type: "monitor" };
        if (unreported.length > 0) {
          const what = [...new Set(unreported.map((f) => f.kind.replace(/-/g, " ")))].join(", ");
          return { type: "say", to: task.assignedBy, text: `The patient needs you now: ${what} — "${unreported[unreported.length - 1]!.text}"` };
        }
        const due = myLast === -Infinity || now(s) - myLast >= interval - 1e-9;
        if ((retained > 0 || s.patient.fainted) && due) return { type: "monitor" };
        const watched = s.monitorLog.some((m) => m.by === me && m.at >= since);
        if (retained === 0 && !s.patient.fainted && watched) {
          const findings = [...new Set(abnormal.map((f) => f.kind))];
          return report(task, findings.length > 0 ? `Monitored throughout; abnormal: ${findings.join(", ")}.` : "Monitored throughout; no concerns.", findings);
        }
        // nothing to do for this task right now: see to the next one
        continue;
      }
      case "count-needles": {
        if (self.location !== patientRoom && toRoom(patientRoom)) return toRoom(patientRoom);
        const counted = s.counts.some((c) => c.by === me && c.at >= since);
        if (!counted) return { type: "count_needles" };
        const last = [...s.counts].reverse().find((c) => c.by === me)!;
        return report(task, last.reconciled ? `Count reconciled: ${last.opened} opened, ${last.disposed} in sharps, ${last.retained} retained.` : `Count NOT reconciled: ${last.unaccounted} unaccounted for.`);
      }
      case "dispose-sharps": {
        const sharps = atFixtureOfKind(sc, s, me, "sharps-container", "sharps container");
        // needles already in my hand go into a sharps container first
        const inHand = self.holding.find((o) => s.needles[o]);
        if (inHand) {
          if (sharps.ok) return { type: "dispose", object: inHand };
          return sharps.hint ? { type: "move", to: sharps.hint } : report(task, "There is no sharps container in this clinic: I am still holding the needles.");
        }
        const onTray = (p: EncounterState["packs"][string]) => !p.sealed && p.needles.some((id) => s.needles[id]?.location.kind === "tray");
        const here = (p: EncounterState["packs"][string]) => Number(w.fixtures.get(p.at)?.room === self.location);
        const packs = Object.values(s.packs).filter(onTray).sort((a, b) => here(b) - here(a) || (a.id < b.id ? -1 : 1));
        const pack = packs[0];
        if (!pack) return report(task, "Opened, unused needles on the tray are in the sharps container.");
        if (!w.fixtures.has(pack.at)) return report(task, `I cannot find the tray of ${pack.id}.`);
        if (!atFixture(sc, s, me, pack.at).ok) return { type: "move", to: { fixture: pack.at } };
        // at the tray: straight into the sharps box when one is within reach, else carried to one, needle by needle
        if (sharps.ok) return { type: "dispose", object: pack.id };
        return { type: "pick_up", object: pack.needles.find((id) => s.needles[id]?.location.kind === "tray")! };
      }
      case "record-vitals": {
        if (!patientContact(sc, s, me).ok) return { type: "move", to: { person: patient } };
        const done = s.vitalsLog.find((v) => v.by === me && v.at >= since);
        if (!done) return { type: "check_vitals" };
        const text = Object.entries(done.vitals).map(([k, v]) => `${k} ${v}`).join(", ");
        return report(task, `Vitals: ${text}.`);
      }
      case "chaperone":
      case "prepare-couch": {
        if (self.location !== patientRoom && toRoom(patientRoom)) return toRoom(patientRoom);
        return report(task, task.kind === "chaperone" ? "I am in the room as chaperone." : "The couch is ready.");
      }
    }
  }
  return null;
}

/** A supervisor who approves the current plan once it exists and stays with the learner. */
function supervisorDefault(sc: Scenario, s: EncounterState, me: string): ActionInput | null {
  const self = s.actors[me];
  if (!self) return null;
  const plan = s.plans[s.plans.length - 1];
  if (plan && s.planApproved !== plan.version) return { type: "approve_plan" };
  const learner = Object.values(s.actors).find((a) => a.id !== me && a.role.includes("learner"));
  if (learner && learner.location !== self.location && clinicWorld(sc).rooms.has(learner.location)) return { type: "move", to: { room: learner.location } };
  return null;
}

export const NPC_POLICIES: Record<string, NpcPolicy> = {
  "support-default": supportDefault,
  "supervisor-default": supervisorDefault,
  /** Present but passive (does only what it is told, and nothing on its own). */
  idle: () => null,
};
