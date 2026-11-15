import type { AgentView } from "@acucraft/core";

/**
 * What a practitioner is told: the opening of an encounter, and after each action its outcome with *what that
 * action changed* — new words, new evidence, a new position, a needle's new state — instead of the whole view again.
 * Everything here comes from the practitioner's own view: this module cannot show what the view does not hold.
 */

/** The opening of an encounter: who and where you are, and your whole view once. */
export function openingText(view: AgentView): string {
  return `A new encounter: ${view.title}. ${view.setting.clinic}, ${view.setting.date}; visit ${view.setting.visit} of ${view.setting.visits}. You are ${view.you.name} (${view.you.roleLabel}).\n\nYour view as the encounter begins (JSON):\n${JSON.stringify(view)}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The entries of `next` that are new or differ from the entry of `prev` with the same key. */
function changed<T>(prev: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const before = new Map(prev.map((item) => [key(item), item]));
  return next.filter((item) => !same(before.get(key(item)), item));
}

/** Where you stand and what can be done from there without walking. */
function spaceOf(v: AgentView) {
  const p = v.space.patient;
  return {
    you: { room: v.space.you.room, facing: v.space.you.facing },
    patient: { room: p.room, on: p.on, distance: p.distance, inEarshot: p.inEarshot, atSide: p.atSide, inSight: p.inSight, lying: p.lying, sitesInReach: p.sites.inReach, sitesOutOfReach: p.sites.outOfReach },
    fixturesInReach: v.space.fixtures.filter((f) => f.inReach).map((f) => `${f.id} (${f.kind})`),
    colleaguesInReach: v.space.team.filter((m) => m.inReach).map((m) => m.id),
  };
}

/**
 * What differs between two views of the same actor, section by section (absent when nothing in it changed). The
 * evidence obtained comes with its content, once: it is the only time the practitioner is handed it unasked.
 */
export function viewChanges(prev: AgentView, next: AgentView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown, when: boolean) => {
    if (when) out[key] = value;
  };
  put("visit", `${next.setting.visit} of ${next.setting.visits} (${next.setting.date})`, prev.setting.visit !== next.setting.visit);
  put("you", { location: next.you.location, holding: next.you.holding }, prev.you.location !== next.you.location || !same(prev.you.holding, next.you.holding));

  const said = changed(prev.conversation, next.conversation, (u) => `${u.minute}|${u.speaker}|${u.text}`);
  put("said", said.map((u) => ({ speaker: u.speaker, ...(u.to ? { to: u.to } : {}), text: u.text })), said.length > 0);

  const patient = { location: next.patient.location, position: next.patient.position, appearance: next.patient.appearance, consent: next.patient.consent };
  const patientBefore = { location: prev.patient.location, position: prev.patient.position, appearance: prev.patient.appearance, consent: prev.patient.consent };
  const repositioned = prev.patient.position !== next.patient.position;
  put("patient", { ...patient, ...(repositioned ? { reachable: next.patient.reachable } : {}) }, !same(patient, patientBefore));
  put("space", spaceOf(next), !same(spaceOf(prev), spaceOf(next)));

  const record: Record<string, unknown> = {};
  const history = changed(prev.record.history, next.record.history, (h) => h.id);
  const examination = changed(prev.record.examination, next.record.examination, (e) => e.id);
  const results = changed(prev.record.results, next.record.results, (r) => r.id);
  const vitals = changed(prev.record.vitals, next.record.vitals, (x) => x.id);
  const observations = changed(prev.record.observations, next.record.observations, (o) => o.id);
  const sites = next.record.sites.filter((s) => !prev.record.sites.includes(s));
  const tender = changed(prev.record.tenderPoints, next.record.tenderPoints, (t) => t.id);
  if (history.length) record.history = history;
  if (examination.length) record.examination = examination;
  if (results.length) record.results = results;
  if (vitals.length) record.vitals = vitals;
  if (observations.length) record.observations = observations;
  if (sites.length) record.sites = sites;
  if (tender.length) record.tenderPoints = tender;
  put("record", record, Object.keys(record).length > 0);

  put("assessment", next.assessment, !same(prev.assessment, next.assessment));
  put("plan", next.plan, !same(prev.plan, next.plan));

  // the written record: what is new in it (a note, a decision, a referral …), and the consent as it now stands
  const documentation: Record<string, unknown> = {};
  const pd = prev.documentation, nd = next.documentation;
  const at = (x: { visit?: number; minute: number; by: string }) => `${x.visit ?? ""}|${x.minute}|${x.by}`;
  const notes = changed(pd.notes, nd.notes, (n) => `${at(n)}|${JSON.stringify(n.record)}`);
  const decisions = changed(pd.decisions, nd.decisions, (d) => `${at(d)}|${d.disposition}`);
  const explanations = changed(pd.explanations, nd.explanations, (e) => `${at(e)}|${e.topics.join(",")}`);
  const referrals = changed(pd.referrals, nd.referrals, (r) => `${at(r)}|${r.to}`);
  const incidents = changed(pd.incidents, nd.incidents, (x) => `${at(x)}|${x.kind}`);
  if (notes.length) documentation.notes = notes;
  if (decisions.length) documentation.decisions = decisions;
  if (explanations.length) documentation.explanations = explanations;
  if (referrals.length) documentation.referrals = referrals;
  if (incidents.length) documentation.incidents = incidents;
  if (!same(pd.consent, nd.consent)) documentation.consent = nd.consent;
  if (!same(pd.stopped, nd.stopped)) documentation.stopped = nd.stopped;
  if (pd.visits.length !== nd.visits.length) documentation.visits = nd.visits;
  put("documentation", documentation, Object.keys(documentation).length > 0);

  const needling = changed(prev.needling, next.needling, (n) => n.needle);
  put("needling", needling, needling.length > 0);

  const localisation: Record<string, unknown> = {};
  const landmarks = changed(prev.localisation.landmarks, next.localisation.landmarks, (l) => `${l.region}|${l.side}|${l.landmark}|${l.configuration}`);
  const measurements = changed(prev.localisation.measurements, next.localisation.measurements, (m) => `${m.region}|${m.side}|${m.what}`);
  const marks = changed(prev.localisation.marks, next.localisation.marks, (m) => m.id);
  if (landmarks.length) localisation.landmarks = landmarks;
  if (measurements.length) localisation.measurements = measurements;
  if (marks.length) localisation.marks = marks;
  put("localisation", localisation, Object.keys(localisation).length > 0);

  const equipment: Record<string, unknown> = {};
  const packs = changed(prev.equipment.packs, next.equipment.packs, (p) => p.id);
  const needles = changed(prev.equipment.needles, next.equipment.needles, (n) => n.id);
  if (packs.length) equipment.packs = packs;
  if (needles.length) equipment.needles = needles;
  put("equipment", equipment, Object.keys(equipment).length > 0);

  const team = changed(prev.team, next.team, (m) => m.id);
  put("team", team.map((m) => ({ id: m.id, location: m.location })), team.length > 0);
  const tasks = changed(prev.tasks, next.tasks, (t) => t.id);
  put("tasks", tasks, tasks.length > 0);
  const counts = changed(prev.counts, next.counts, (c) => `${c.minute}|${c.by}|${c.method}`);
  put("counts", counts, counts.length > 0);
  const couches = changed(prev.couches, next.couches, (c) => c.room);
  put("couches", couches, couches.length > 0);
  put("rules", next.rules.map((r) => `${r.id} (${r.version})`), !same(prev.rules.map((r) => r.id), next.rules.map((r) => r.id)));
  put("teaching", next.teaching, !same(prev.teaching, next.teaching));
  put("finished", true, next.finished && !prev.finished);
  return out;
}

/** The result of an action: what the engine did with it, and what it changed in your view. */
export function outcomeOf(prev: AgentView, next: AgentView): { status: string; result: Record<string, unknown> } {
  const last = next.last;
  const status = last?.status ?? "unknown";
  return {
    status,
    result: {
      status,
      ...(last?.message ? { message: last.message } : {}),
      ...(last && last.observations.length > 0 ? { observations: last.observations } : {}),
      minute: next.minute,
      changed: viewChanges(prev, next),
    },
  };
}

/**
 * Why the rest of a turn's calls should wait after an action: it did not go as asked, or the patient or a colleague
 * now needs an answer — whoever asked for several things in a row decides again once they know. `null`: carry on.
 */
export function interruption(actionType: string, prev: AgentView, next: AgentView): string | null {
  const status = next.last?.status ?? "unknown";
  if (status !== "executed") return `${actionType} was ${status}`;
  if (next.finished) return null;
  if (prev.patient.appearance !== next.patient.appearance) return `the patient now looks: ${next.patient.appearance}`;
  if (prev.patient.consent !== next.patient.consent && next.patient.consent !== "given") return `the patient's consent is now: ${next.patient.consent}`;
  // someone spoke who was not being spoken to: an unprompted word from the patient or a colleague comes first
  const talk = ["ask", "say", "explain", "seek_consent", "check_sensation", "assign_task", "monitor", "observe", "examine"].includes(actionType);
  if (!talk) {
    const heard = changed(prev.conversation, next.conversation, (u) => `${u.minute}|${u.speaker}|${u.text}`).filter((u) => u.speaker !== next.you.name);
    if (heard.length > 0) return `${heard[heard.length - 1]!.speaker} said something`;
  }
  return null;
}
