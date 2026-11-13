import { createRng, seedFrom } from "@clinicalcraft/core";
import type { NeedleResponseClaim, PointRef } from "../schema/actions.js";
import type { NeedleSensation } from "../schema/field.js";
import type { EncounterState, EvidenceItem, EvidenceKind, NeedleResponse, NeedleState } from "../schema/state.js";
import type { PathAssessment } from "./anatomy.js";
import { needleList, now, refKey, visitIndex } from "./queries.js";
import type { Scenario } from "./scenario.js";

/**
 * Evidence (docs/EVIDENCE.md). The rules are the ones ClinicalCraft and SurgeryCraft keep:
 *
 *  - what is obtained in an encounter enters a ledger under a stable id, once;
 *  - a conclusion — a pattern differentiation, a recorded needle response — names the ids it rests on, and an id that
 *    was never obtained is refused;
 *  - what a conclusion is worth is judged on the field, never on the claim: a pattern on what its cited findings show
 *    (the scenario's own reading of each finding, in the vocabulary's signs), a needle response on what the tissue
 *    did. The claim is kept beside that and the two are compared;
 *  - nothing obtained is nothing known: a needle nobody asked about has no response on record, not a normal one.
 */

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

const NUMBERED: Record<Exclude<EvidenceKind, "history" | "exam" | "record">, string> = { vitals: "vitals", observation: "obs", sensation: "sense", "needle-feel": "feel" };

/** Ids the ledger numbers itself: a case item must not look like one. */
export const RESERVED_EVIDENCE_ID = /^(vitals|obs|sense|feel)-\d+$/;

/** The evidence id of a record read: one per investigation and phase (a later visit's result is other evidence). */
export const recordEvidenceId = (investigationId: string, phase: string): string => `${investigationId}.${phase}`;

/**
 * Enter what was obtained. A case item (an answer, a finding, a record) is evidence once: obtained again, it is the
 * same item. Everything else is numbered in the order it came.
 */
export function addEvidence(s: EncounterState, item: Omit<EvidenceItem, "id" | "visit" | "at"> & { id?: string }): EvidenceItem {
  if (item.id !== undefined) {
    const known = s.evidence.find((e) => e.id === item.id);
    if (known) return known;
  }
  const { id: given, ...rest } = item;
  const id = given ?? `${NUMBERED[item.kind as keyof typeof NUMBERED]}-${s.evidence.filter((e) => e.kind === item.kind).length + 1}`;
  const entry: EvidenceItem = { id, ...rest, visit: visitIndex(s), at: now(s) };
  s.evidence.push(entry);
  return entry;
}

export const evidenceById = (s: EncounterState, id: string): EvidenceItem | null => s.evidence.find((e) => e.id === id) ?? null;

/* ------------------------------------------------------------------ */
/* Pattern differentiation                                             */
/* ------------------------------------------------------------------ */

export interface SignShown {
  sign: string;
  /** The evidence that shows it. */
  evidence: string[];
}

/** What a pattern differentiation rests on, read from the evidence it names. */
export interface PatternSupport {
  pattern: string;
  /** The vocabulary gives criteria for the pattern (false: it cannot be linked to evidence — for review). */
  hasCriteria: boolean;
  cited: string[];
  /** The pattern's key and supporting signs that the cited evidence shows. */
  key: SignShown[];
  supporting: SignShown[];
  /** Signs that speak against the pattern, shown by the evidence obtained — cited or not. */
  against: SignShown[];
  /** Cited evidence that shows none of the pattern's signs. */
  idle: string[];
  /** The examinations the cited signs were found by (inquiry, inspection, tongue, pulse, palpation …). */
  methods: string[];
  thresholds: { key: number; total: number; against: number };
  /** Enough key signs and enough signs in all. */
  sufficient: boolean;
  /** The evidence obtained speaks against the pattern. */
  contradicted: boolean;
  /** Sufficient and not contradicted: the differentiation rests on its evidence. */
  supported: boolean;
}

/** The signs a piece of evidence shows in this scenario (the hidden reading of the case's findings). */
export const signsOf = (sc: Scenario, evidenceId: string): readonly string[] => sc.field.evaluation.signs[evidenceId] ?? [];

/**
 * Read a differentiation from the evidence it names. `obtained` is everything known when it was made (default: the
 * cited evidence itself): contrary signs count wherever they were found, so leaving a finding out does not remove it.
 */
export function patternSupport(sc: Scenario, pattern: string, cited: readonly string[], obtained: readonly string[] = cited): PatternSupport {
  const vocab = sc.bundle.vocabulary;
  const def = vocab.patterns.find((p) => p.id === pattern);
  const criteria = def?.criteria;
  const thresholds = { key: vocab.differentiation.key, total: vocab.differentiation.total, against: vocab.differentiation.against };
  const citedIds = [...new Set(cited)];
  const shown = (signs: readonly string[], from: readonly string[]): SignShown[] =>
    signs.map((sign) => ({ sign, evidence: from.filter((id) => signsOf(sc, id).includes(sign)) })).filter((x) => x.evidence.length > 0);
  const key = shown(criteria?.key ?? [], citedIds);
  const supporting = shown(criteria?.supporting ?? [], citedIds);
  const against = shown(criteria?.against ?? [], [...new Set([...obtained, ...citedIds])]);
  const mine = new Set([...(criteria?.key ?? []), ...(criteria?.supporting ?? [])]);
  const idle = citedIds.filter((id) => !signsOf(sc, id).some((sign) => mine.has(sign)));
  const methodOf = (sign: string) => vocab.signs.find((x) => x.id === sign)?.method;
  const methods = [...new Set([...key, ...supporting].map((x) => methodOf(x.sign)).filter((m): m is NonNullable<typeof m> => m !== undefined))];
  const sufficient = criteria !== undefined && key.length >= thresholds.key && key.length + supporting.length >= thresholds.total;
  const contradicted = against.length >= thresholds.against;
  return { pattern, hasCriteria: criteria !== undefined, cited: citedIds, key, supporting, against, idle, methods, thresholds, sufficient, contradicted, supported: sufficient && !contradicted };
}

/** The support of an assessment's pattern, on the evidence obtained when it was made (null: it names no pattern). */
export function assessmentSupport(sc: Scenario, s: EncounterState, a: EncounterState["assessments"][number]): PatternSupport | null {
  if (a.pattern === null) return null;
  return patternSupport(sc, a.pattern, a.patternEvidence, s.evidence.filter((e) => e.at <= a.at + 1e-9).map((e) => e.id));
}

/** What the whole case could show for a pattern at a visit's phase: every finding it has, obtained and cited. */
export function caseSupport(sc: Scenario, pattern: string, phase: string): PatternSupport {
  const inPhase = (phases: readonly string[] | undefined) => phases === undefined || phases.includes(phase);
  const ids = [
    ...sc.case.history.filter((h) => inPhase(h.phases)).map((h) => h.id),
    ...sc.case.exam.filter((e) => inPhase(e.phases)).map((e) => e.id),
    ...sc.case.investigations.filter((i) => Object.prototype.hasOwnProperty.call(i.results, phase)).map((i) => recordEvidenceId(i.id, phase)),
  ];
  return patternSupport(sc, pattern, ids);
}

/* ------------------------------------------------------------------ */
/* Deqi: the needle's response in the tissue                           */
/* ------------------------------------------------------------------ */

/** Qi has arrived when the response reaches this; the patient speaks of it unasked from `STRONG_RESPONSE`. */
export const DEQI_THRESHOLD = 0.5;
export const STRONG_RESPONSE = 0.8;

/** What each act adds to the stimulation a needle has had. The response grows with it up to 1 and no further. */
export const STIMULATION = { insertion: 0.45, "lift-thrust": 0.35, rotate: 0.3 } as const;
export type Stimulus = keyof typeof STIMULATION;

/** Stimulation beyond this is more than a typical patient tolerates: it hurts, and it brings no more response. */
export const STIMULATION_TOLERANCE = 1.5;

/**
 * How readily a tissue answers a needle whose tip lies in it (1: a muscle belly). A tip still in the subcutaneous
 * layer does not reach it however the needle is worked: depth, not force, is what was missing.
 */
export const TISSUE_RESPONSE: Readonly<Record<string, number>> = { muscle: 1, fascia: 0.9, tendon: 0.7, ligament: 0.7, "fat-pad": 0.7, periosteum: 0.4, bone: 0.4, "joint-space": 0.3, subcutaneous: 0.3, skin: 0.1 };

const DEQI_QUALITIES: readonly NeedleSensation[] = ["aching", "numbness", "heaviness", "distension", "warmth", "spreading"];

/** The sensations that count as deqi: the vocabulary's, or the usual four with warmth and spreading. */
export function deqiQualities(sc: Scenario): ReadonlySet<NeedleSensation> {
  const listed = sc.bundle.vocabulary.sensations;
  return new Set(listed.length > 0 ? listed.filter((x) => x.deqi).map((x) => x.id) : DEQI_QUALITIES);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The tissue's response to a needle after a stimulus (`null`: the needle was only moved to another depth). Pure and
 * deterministic: tissue at the tip × stimulation (capped) × the patient's sensitivity × a seeded variation of the
 * site. A nerve or a tendon met by the shaft, or stimulation past what the patient tolerates, gives a sensation that
 * is not deqi.
 */
export function needleResponse(sc: Scenario, s: EncounterState, n: NeedleState, path: PathAssessment, stimulus: Stimulus | null): NeedleResponse {
  const prev = n.response;
  const stimulation = round3((prev?.stimulation ?? 0) + (stimulus ? STIMULATION[stimulus] : 0));
  const manipulations = (prev?.manipulations ?? 0) + (stimulus && stimulus !== "insertion" ? 1 : 0);
  const sensitivity = sc.field.patient.needleSensitivity;
  const site = n.insertion;
  const rng = createRng(seedFrom(s.seed, sc.id, "needle-response", site?.region ?? "", site?.side ?? "", Math.round((site?.entry.u ?? 0) * 2), Math.round((site?.entry.v ?? 0) * 2)));
  const variation = 0.8 + 0.4 * rng();
  const intensity = round3((TISSUE_RESPONSE[path.tipTissue] ?? 0) * Math.min(1, stimulation) * sensitivity * variation);
  const felt = stimulation * sensitivity * (s.patient.anxiety >= 0.6 ? 1.25 : 1);
  const overstimulated = (prev?.overstimulated ?? false) || felt > STIMULATION_TOLERANCE + 1e-9;
  const nerve = path.findings.some((f) => f.contact && f.kind === "nerve");
  const tendon = path.findings.some((f) => f.contact && f.consequence === "tendon-pain");
  const noxious: NeedleSensation | null = nerve ? "electric" : tendon || overstimulated ? "sharp-pain" : null;
  const deqi = noxious === null && intensity >= DEQI_THRESHOLD;
  // what the patient would call it: two of the three commonest, numbness beside a nerve, spreading when it is strong
  const order = (["aching", "heaviness", "distension"] as NeedleSensation[]).map((q) => ({ q, r: rng() })).sort((a, b) => a.r - b.r).map((x) => x.q);
  const qualities: NeedleSensation[] = !deqi
    ? []
    : [...order.slice(0, 2), ...(path.findings.some((f) => f.near && f.kind === "nerve") ? (["numbness"] as NeedleSensation[]) : []), ...(intensity >= STRONG_RESPONSE ? (["spreading"] as NeedleSensation[]) : [])];
  return { stimulation, manipulations, intensity, deqi, arrivedAt: prev?.arrivedAt ?? (deqi ? now(s) : null), qualities, noxious, overstimulated };
}

const PHRASE: Record<NeedleSensation, string> = {
  aching: "a dull ache",
  numbness: "a numb, tingling feeling",
  heaviness: "a heavy feeling",
  distension: "a tight, full feeling",
  warmth: "a warm feeling",
  spreading: "",
  "sharp-pain": "a sharp pain",
  burning: "a burning feeling",
  electric: "an electric shock",
};

/** What the patient says they feel at a needle, and the qualities they name. */
export function describeSensation(r: NeedleResponse): { text: string; qualities: NeedleSensation[] } {
  if (r.noxious === "electric") return { text: "It's like an electric shock shooting from that needle — it's horrible.", qualities: ["electric"] };
  if (r.overstimulated) return { text: "That one is too strong — it's painful now.", qualities: ["sharp-pain"] };
  if (r.noxious) return { text: "That one is sharp — it stings.", qualities: [r.noxious] };
  if (r.deqi) {
    const named = r.qualities.filter((q) => q !== "spreading").map((q) => PHRASE[q]);
    const body = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : (named[0] ?? "a dull ache");
    return { text: `${body.charAt(0).toUpperCase()}${body.slice(1)} around that needle${r.qualities.includes("spreading") ? ", spreading a little way from it" : ""}.`, qualities: [...r.qualities] };
  }
  if (r.intensity >= 0.3) return { text: "I can tell it's there, but nothing much — no ache.", qualities: [] };
  return { text: "I hardly feel that one at all.", qualities: [] };
}

/** What the operator feels in the needle on working it. */
export function describeGrasp(r: NeedleResponse, technique: "lift-thrust" | "rotate"): { text: string; grasp: boolean } {
  const act = technique === "rotate" ? "rotate" : "lift and thrust";
  if (r.noxious !== null) return { text: `The patient flinches as you ${act} the needle.`, grasp: false };
  if (r.deqi) return { text: `The needle is gripped as you ${act} it: it feels heavy and tight.`, grasp: true };
  if (r.intensity >= 0.3) return { text: `A slight drag on the needle as you ${act} it, no more.`, grasp: false };
  return { text: `The needle moves freely as you ${act} it: nothing takes hold of it.`, grasp: false };
}

/** Does a piece of needle evidence show deqi? A grip felt; or the patient naming its sensations and none that is not. */
export function showsDeqi(sc: Scenario, e: EvidenceItem): boolean {
  if (!e.needle) return false;
  if (e.kind === "needle-feel") return e.needle.grasp === true;
  const deqi = deqiQualities(sc);
  return e.needle.qualities.length > 0 && e.needle.qualities.every((q) => deqi.has(q));
}

export const needleEvidence = (s: EncounterState, needleId: string): EvidenceItem[] => s.evidence.filter((e) => e.needle?.id === needleId);

/* ------------------------------------------------------------------ */
/* Recorded needle responses against the field                         */
/* ------------------------------------------------------------------ */

/**
 * `supported` — the record rests on evidence of that needle that shows what it says; `overclaimed` — deqi recorded on
 * evidence that does not show it; `contradicted` — the practitioner's own evidence shows deqi and the record says
 * otherwise; `out-of-date` — recorded as none on a check made before the needle was worked or moved, and qi arrived
 * after it; `not-sought` — no response looked for, and said so; `unrecorded` — nothing on record for the needle.
 */
export type NeedleVerdict = "supported" | "overclaimed" | "contradicted" | "out-of-date" | "not-sought" | "unrecorded";

export interface NeedleAudit {
  needle: string;
  visit: number;
  target: string;
  /** The field: what the tissue did. */
  field: { arrived: boolean; deqi: boolean; intensity: number; tipTissue: string; manipulations: number; overstimulated: boolean; noxious: string | null };
  /** The evidence obtained at this needle and what each item shows. */
  evidence: { id: string; kind: EvidenceKind; at: number; deqi: boolean }[];
  /** The record: the last response recorded for this needle and what it cites. */
  claim: { response: NeedleResponseClaim["response"]; evidence: string[]; at: number } | null;
  verdict: NeedleVerdict;
  detail: string;
}

/** Every needle inserted, with what the field did, what was observed and what was recorded. */
export function needleAudit(sc: Scenario, s: EncounterState): NeedleAudit[] {
  const out: NeedleAudit[] = [];
  for (const n of needleList(s)) {
    const ins = n.insertion;
    if (!ins) continue;
    const r = n.response;
    const evidence = needleEvidence(s, n.id).map((e) => ({ id: e.id, kind: e.kind, at: e.at, deqi: showsDeqi(sc, e) }));
    let claim: NeedleAudit["claim"] = null;
    for (const d of s.documents) {
      const c = d.record.needling?.responses?.find((x) => x.needle === n.id);
      if (c) claim = { response: c.response, evidence: [...c.evidence], at: d.at };
    }
    const arrived = r?.arrivedAt != null;
    const known = evidence.filter((e) => claim === null || e.at <= claim.at + 1e-9);
    const positive = known.some((e) => e.deqi);
    let verdict: NeedleVerdict;
    let detail: string;
    if (!claim) {
      verdict = "unrecorded";
      detail = "no response recorded";
    } else if (claim.response === "deqi") {
      const cited = evidence.filter((e) => claim!.evidence.includes(e.id));
      if (cited.some((e) => e.deqi)) {
        verdict = "supported";
        detail = `deqi, on ${cited.filter((e) => e.deqi).map((e) => e.id).join(", ")}`;
      } else {
        verdict = "overclaimed";
        detail = `deqi recorded on ${cited.map((e) => e.id).join(", ") || "no evidence"}, which does not show it${arrived ? " (qi did arrive: it was not what the record cites)" : ""}`;
      }
    } else if (positive) {
      verdict = "contradicted";
      detail = `recorded as ${claim.response}, but ${known.filter((e) => e.deqi).map((e) => e.id).join(", ")} shows deqi`;
    } else if (claim.response === "none") {
      verdict = arrived ? "out-of-date" : "supported";
      detail = arrived ? "recorded as none on a check made before qi arrived" : `none, on ${claim.evidence.join(", ")}`;
    } else {
      verdict = "not-sought";
      detail = "no response sought";
    }
    out.push({
      needle: n.id,
      visit: ins.visit,
      target: ins.target ? refKey(ins.target as PointRef) : "untargeted",
      field: { arrived, deqi: r?.deqi ?? false, intensity: r?.intensity ?? 0, tipTissue: ins.tipTissue, manipulations: r?.manipulations ?? 0, overstimulated: r?.overstimulated ?? false, noxious: r?.noxious ?? null },
      evidence,
      claim,
      verdict,
      detail,
    });
  }
  return out;
}
