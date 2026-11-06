import { t } from "@clinicalcraft/core";
import type { PointRef } from "../schema/actions.js";
import type { EncounterState } from "../schema/state.js";
import { pointInstance, regionAccess } from "./anatomy.js";
import { consentCovers, currentPlan, currentVisit, fmt, needleList, now, refKey, visitIndex } from "./queries.js";
import { ACTION_PERMISSIONS } from "./rules.js";
import { LOCALE } from "./runtime.js";
import { roleOf, type Scenario } from "./scenario.js";
import { hash53 } from "./util.js";
import { speakerLabel } from "./encounter.js";

/**
 * What an actor may see (proposal §2, §13). Built from an explicit allow-list of the state, never by deleting from it:
 * hidden diagnoses, reference pathways, the evaluation, future events, the variant, risk factors not yet disclosed,
 * findings not yet examined and patient-specific geometry are not in it. Teaching mode adds anatomical overlays.
 */

export const VIEW_SCHEMA_ID = "acucraft/view@1" as const;

export interface AgentView {
  schema: typeof VIEW_SCHEMA_ID;
  /** An opaque tag for this encounter (never the variant). */
  encounter: string;
  title: string;
  setting: { clinic: string; jurisdiction: string; date: string; visit: number; visits: number };
  mode: EncounterState["mode"];
  version: number;
  minute: number;
  finished: boolean;
  you: { id: string; name: string; role: string; roleLabel: string; location: string; holding: string[]; may: string[] };
  patient: {
    name: string;
    age: number;
    sex: string;
    presenting: string;
    location: string;
    position: string;
    appearance: string;
    consent: string;
    reachable: { region: string; sides: string[]; configuration: string }[];
  };
  conversation: { minute: number; speaker: string; to: string | null; text: string }[];
  record: {
    history: { question: string; answer: string }[];
    examination: { manoeuvre: string; finding: string }[];
    results: string[];
    vitals: { minute: number; vitals: Record<string, number | string> }[];
    sites: string[];
    tenderPoints: { id: string; label: string; region: string; side: string; centre: { u: number; v: number }; radiusCm: number }[];
  };
  localisation: {
    landmarks: { region: string; side: string; landmark: string; u: number; v: number; configuration: string }[];
    measurements: { region: string; side: string; what: string; cm: number }[];
    marks: { id: string; target: string; region: string; side: string; u: number; v: number; stale: boolean }[];
  };
  plan: { version: number; points: string[]; retentionMinutes: number; stimulation: string; approved: boolean } | null;
  equipment: {
    packs: { id: string; where: string; sealed: boolean; needles: number; spec: string; expiredLabel: boolean }[];
    needles: { id: string; where: string; used: boolean; contaminated: boolean }[];
    sharps: string[];
  };
  team: { id: string; name: string; role: string; location: string }[];
  tasks: { id: string; kind: string; from: string; to: string; status: string; params: Record<string, unknown>; unmet: string[] }[];
  counts: { minute: number; by: string; reconciled: boolean; unaccounted: number }[];
  rules: { id: string; title: string; version: string; effectiveFrom: string; encoding: string; rules: { id: string; title: string; enforcement: string }[] }[];
  last: { requestId: string; type: string; status: string; message: string; observations: string[] } | null;
  teaching?: { references: { target: string; region: string; side: string; u: number; v: number; toleranceCm: number }[]; notes: string[] };
}

export function observeAs(sc: Scenario, s: EncounterState, actorId: string): AgentView {
  const actor = s.actors[actorId];
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  const role = roleOf(sc, actorId);
  const member = sc.field.cast.find((m) => m.id === actorId)!;
  const visit = currentVisit(s);
  const room = (id: string) => sc.clinic.rooms.find((r) => r.id === id)?.label ?? id;
  const label = (r: PointRef) => ("ashi" in r ? `ashi:${r.ashi}` : `${r.point}:${r.side}`);

  const reachable = sc.field.regions.flatMap((regionId) => {
    const region = sc.bundle.regions.get(regionId)!;
    const sides = (region.laterality === "bilateral" ? ["left", "right"] : ["midline", "left", "right"]) as ("left" | "right" | "midline")[];
    const ok = sides.filter((side) => regionAccess(region, side, s.patient.position).accessible);
    return ok.length > 0 ? [{ region: regionId, sides: ok, configuration: regionAccess(region, ok[0]!, s.patient.position).configuration }] : [];
  });

  const results: string[] = [];
  for (const key of s.clinical.seen) {
    const [id, phase] = key.split("@");
    const inv = sc.case.investigations.find((i) => i.id === id);
    const r = inv?.results[phase ?? ""];
    if (inv && r) results.push(`${t(inv.name, LOCALE)}${r.date ? ` (${t(r.date, LOCALE)})` : ""}: ${t(r.text, LOCALE)}`);
  }

  const where = (n: (typeof s.needles)[string]): string => {
    const l = n.location;
    switch (l.kind) {
      case "pack":
        return `sealed in ${l.packId}`;
      case "tray":
        return `on the tray (${room(s.packs[l.packId]?.at ?? "")})`;
      case "hand":
        return `in ${speakerLabel(sc, l.actor)}'s hand`;
      case "patient":
        return `in the patient: ${l.target ? label(l.target) : `${l.region} ${l.side}`} at u=${fmt(l.entry.u)}, v=${fmt(l.entry.v)}, ${fmt(l.depthCm)} cm`;
      case "sharps":
        return "in the sharps container";
      case "floor":
        return l.hidden ? "unknown" : `on the ${l.area}`;
      case "broken-in-patient":
        return "broken";
    }
  };

  const view: AgentView = {
    schema: VIEW_SCHEMA_ID,
    encounter: hash53(`${sc.id}#${s.seed}`),
    title: sc.family.title,
    setting: { clinic: sc.clinic.title, jurisdiction: sc.clinic.jurisdiction, date: visit.date, visit: visit.index, visits: sc.field.visits.length },
    mode: s.mode,
    version: s.version,
    minute: Math.round(now(s) * 100) / 100,
    finished: s.finished,
    you: {
      id: actorId,
      name: member.name,
      role: actor.role,
      roleLabel: role?.label ?? actor.role,
      location: actor.location,
      holding: [...actor.holding],
      may: Object.entries(ACTION_PERMISSIONS)
        .filter(([, p]) => p === null || role?.grants.some((g) => (typeof g === "string" ? g : g.permission) === p))
        .map(([type]) => type),
    },
    patient: {
      name: t(sc.case.patient.displayName, LOCALE),
      age: sc.case.patient.age,
      sex: sc.case.patient.sex,
      presenting: t(sc.case.patient.chiefComplaint, LOCALE),
      location: s.patient.location,
      position: s.patient.position,
      appearance: s.patient.fainted ? "pale, clammy, says they feel faint" : s.patient.anxiety >= 0.6 ? "tense and anxious" : "comfortable",
      consent: s.patient.consent.status === "given" && !consentCovers(s) ? "given to an earlier plan" : s.patient.consent.status,
      reachable,
    },
    conversation: s.utterances
      .filter((u) => u.speaker === actorId || u.to === null || u.to === actorId || s.actors[u.speaker]?.location === actor.location || u.speaker === s.patient.id)
      .slice(-30)
      .map((u) => ({ minute: Math.round(u.at * 100) / 100, speaker: speakerLabel(sc, u.speaker), to: u.to ? speakerLabel(sc, u.to) : null, text: u.text })),
    record: {
      history: s.clinical.asked.map((id) => sc.case.history.find((h) => h.id === id)).filter((h) => h !== undefined).map((h) => ({ question: t(h.question, LOCALE), answer: t(h.answer, LOCALE) })),
      examination: s.clinical.examined.map((id) => sc.case.exam.find((e) => e.id === id)).filter((e) => e !== undefined).map((e) => ({ manoeuvre: t(e.maneuver, LOCALE), finding: t(e.finding, LOCALE) })),
      results,
      vitals: s.vitalsLog.slice(-3).map((v) => ({ minute: v.at, vitals: v.vitals })),
      sites: sc.field.patient.siteConditions.filter((c) => s.revealedConditions.includes(c.id)).map((c) => `${c.label} (${c.region}, ${c.side}${c.centre ? `, around u=${fmt(c.centre.u)}, v=${fmt(c.centre.v)}, radius ${fmt(c.radiusCm ?? 0)} cm` : ""})`),
      tenderPoints: sc.field.patient.ashi.filter((a) => s.revealedAshi.includes(a.id)).map((a) => ({ id: a.id, label: a.label, region: a.region, side: a.side, centre: a.centre, radiusCm: a.radiusCm })),
    },
    localisation: {
      landmarks: s.landmarks.filter((l) => l.visit === visit.index).map((l) => ({ region: l.region, side: l.side, landmark: l.landmark, u: round2(l.position.u), v: round2(l.position.v), configuration: l.configuration })),
      measurements: s.measurements.filter((m) => m.visit === visit.index).map((m) => ({ region: m.region, side: m.side, what: m.what, cm: round2(m.cm) })),
      marks: Object.values(s.marks).filter((m) => m.visit === visit.index).map((m) => ({ id: m.id, target: label(m.target), region: m.region, side: m.side, u: round2(m.position.u), v: round2(m.position.v), stale: m.stale })),
    },
    plan: (() => {
      const p = currentPlan(s);
      return p ? { version: p.version, points: p.plan.points.map((x) => refKey(x as PointRef)), retentionMinutes: p.plan.technique.retentionMinutes, stimulation: p.plan.technique.stimulation, approved: s.planApproved === p.version } : null;
    })(),
    equipment: {
      packs: Object.values(s.packs).map((p) => {
        const spec = s.needles[p.needles[0]!]!.spec;
        const visible = p.holder === actorId || sc.clinic.rooms.find((r) => r.fixtures.some((f) => f.id === p.at))?.id === actor.location || p.at === actor.location;
        return { id: p.id, where: p.holder ? `with ${speakerLabel(sc, p.holder)}` : room(sc.clinic.rooms.find((r) => r.fixtures.some((f) => f.id === p.at))?.id ?? p.at), sealed: p.sealed, needles: p.needles.length, spec: `${spec.diameterMm} × ${spec.lengthMm} mm, ${spec.singleUse ? "single-use" : "reusable"}, ${spec.sterile ? "sterile" : "non-sterile"}`, expiredLabel: visible && p.expired };
      }),
      needles: needleList(s)
        .filter((n) => n.location.kind !== "pack")
        .map((n) => ({ id: n.id, where: where(n), used: n.used, contaminated: n.contaminated && n.location.kind !== "patient" })),
      sharps: sc.clinic.rooms.flatMap((r) => r.fixtures.filter((f) => f.kind === "sharps-container").map((f) => `${f.id} (${r.label})`)),
    },
    team: sc.field.cast.map((m) => ({ id: m.id, name: m.name, role: roleOf(sc, m.id)?.label ?? m.role, location: s.actors[m.id]!.location })),
    tasks: Object.values(s.tasks)
      .filter((tk) => tk.assignee === actorId || tk.assignedBy === actorId)
      .map((tk) => ({ id: tk.id, kind: tk.kind, from: tk.assignedBy, to: tk.assignee, status: tk.status, params: tk.params, unmet: tk.unmet })),
    counts: s.counts.filter((c) => c.visit === visit.index).map((c) => ({ minute: c.at, by: c.by, reconciled: c.reconciled, unaccounted: c.unaccounted })),
    rules: (sc.rules.get(visitIndex(s)) ?? []).map((r) => ({ id: r.id, title: r.title, version: r.version, effectiveFrom: r.effectiveFrom, encoding: r.encoding, rules: r.rules.map((x) => ({ id: x.id, title: x.title, enforcement: x.enforcement })) })),
    last: (() => {
      const a = [...s.attempts].reverse().find((x) => x.actor === actorId);
      return a ? { requestId: a.requestId, type: a.request.action.type, status: a.status, message: a.message || a.executed?.detail || "", observations: a.observations } : null;
    })(),
  };
  if (s.mode === "teaching") {
    const plan = currentPlan(s);
    const refs: NonNullable<AgentView["teaching"]>["references"] = [];
    for (const p of plan?.plan.points ?? []) {
      if ("ashi" in p) continue;
      const def = sc.bundle.acupoints.get(p.point);
      if (!def?.region || !sc.field.regions.includes(def.region)) continue;
      const region = sc.bundle.regions.get(def.region)!;
      const access = regionAccess(region, p.side, s.patient.position);
      const inst = pointInstance(sc, def, p.side, access.configuration);
      if (inst) refs.push({ target: `${p.point}:${p.side}`, region: def.region, side: inst.side, u: round2(inst.position.u), v: round2(inst.position.v), toleranceCm: round2(inst.toleranceCm) });
    }
    view.teaching = { references: refs, notes: ["Teaching mode: reference locations are shown; assessment mode shows none of them."] };
  }
  return view;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Public reference knowledge a practitioner may consult: the point library (standard locations and constructions),
 * the regional models without patient geometry, the vocabulary, the clinic, the roles, the rules in force and the
 * evidence records. Identical for every variant of a family.
 */
export function referenceLibrary(sc: Scenario) {
  const regions = sc.field.regions.map((id) => {
    const r = sc.bundle.regions.get(id)!;
    return {
      id: r.id,
      title: r.title,
      laterality: r.laterality,
      chart: r.chart,
      configurations: r.configurations,
      access: r.access,
      landmarks: r.landmarks.map((l) => ({ id: l.id, label: l.label, palpation: l.palpation })),
      segments: r.segments.map((g) => ({ id: g.id, label: g.label, from: g.from, to: g.to, cun: g.cun })),
      description: r.description,
      review: r.provenance.review.status,
    };
  });
  const points = [...sc.bundle.acupoints.values()].map((p) => ({
    id: p.id,
    names: p.names,
    channel: p.channel,
    codes: p.codes,
    location: t(p.location.text, LOCALE),
    region: p.region && sc.field.regions.includes(p.region) ? p.region : null,
    localisation: p.region && sc.field.regions.includes(p.region) ? (p.localisation ?? null) : null,
    configuration: p.configuration ?? null,
    bilateral: p.bilateral,
    cautions: p.cautions.map((c) => ({ when: c.when, text: c.text, severity: c.severity })),
    notes: p.notes ?? null,
  }));
  return {
    points,
    regions,
    vocabulary: { diagnoses: sc.bundle.vocabulary.diagnoses, patterns: sc.bundle.vocabulary.patterns, redFlags: sc.bundle.vocabulary.redFlags },
    clinic: { rooms: sc.clinic.rooms, supplies: sc.clinic.supplies, referralTargets: sc.clinic.referralTargets },
    roles: sc.roles.roles.map((r) => ({ id: r.id, label: r.label, kind: r.kind, registration: r.registration, grants: r.grants, acceptsTasks: r.acceptsTasks })),
    rules: [...sc.rules.entries()].map(([visit, sets]) => ({ visit, sets: sets.map((r) => ({ id: r.id, title: r.title, version: r.version, effectiveFrom: r.effectiveFrom, encoding: r.encoding, source: r.source, rules: r.rules.map((x) => ({ id: x.id, title: x.title, summary: x.summary, severity: x.severity, enforcement: x.enforcement })) })) })),
    evidence: sc.bundle.evidence.filter((e) => e.condition === sc.family.condition),
  };
}
