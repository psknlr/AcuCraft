import { createRng, reduce, seedFrom, t, type ClinicalAction, type DomainEvent } from "@clinicalcraft/core";
import type { ActionRequest } from "../schema/actions.js";
import type { FeedbackKind, FieldEvent, UnsafeCode } from "../schema/field.js";
import type { ActorState, AttemptRecord, EncounterState, FeedbackRecord, Protection, Violation } from "../schema/state.js";
import { evaluateField } from "./conditions.js";
import { insertionOrder, now, retainedNeedles, visitIndex } from "./queries.js";
import type { Scenario } from "./scenario.js";

/** Shared machinery of the encounter engine: the action context, rejections, the clock and field events. */

export const LOCALE = "en";

export const ABNORMAL_FEEDBACK: readonly FeedbackKind[] = ["sharp-pain", "electric-sensation", "faint", "nausea", "bleeding", "worse"];

export const LYING: readonly string[] = ["supine", "supine-knee-flexed", "prone", "side-lying-left", "side-lying-right"];

export class Rejection extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: { unsafe?: UnsafeCode[]; protection?: Protection; violations?: Violation[] } = {},
  ) {
    super(message);
  }
}

export interface Outcome {
  status: "executed" | "partial";
  detail: string;
  steps: string[];
  observations: string[];
  violations: Violation[];
  unsafe: UnsafeCode[];
  protection: Protection | null;
  message: string;
  target: string | null;
  /** Simulated minutes the action takes (charged after it is applied). */
  cost: number;
  /** Interrupting events fired while the action's time passed. */
  interrupted: string[];
}

export interface Ctx {
  sc: Scenario;
  s: EncounterState;
  req: ActionRequest;
  /** The acting actor, read from the state each time (a nested rollback replaces the state's objects). */
  readonly actor: ActorState;
  out: Outcome;
  /** Run the scenario's NPC policies (between minutes of a wait and after the action). */
  npcTurn: () => void;
}

export const newOutcome = (): Outcome => ({ status: "executed", detail: "", steps: [], observations: [], violations: [], unsafe: [], protection: null, message: "", target: null, cost: 0, interrupted: [] });

export function observe(ctx: Ctx, text: string): void {
  ctx.out.observations.push(text);
}

export function addUnsafe(ctx: Ctx, code: UnsafeCode): void {
  if (!ctx.out.unsafe.includes(code)) ctx.out.unsafe.push(code);
}

/* ------------------------------------------------------------------ */
/* ClinicalCraft session                                               */
/* ------------------------------------------------------------------ */

export interface ClinicalOutcome {
  ok: boolean;
  events: DomainEvent[];
  code?: string;
  message?: string;
}

/** Apply a ClinicalCraft action to the encounter's clinical session (the engine of record for the consultation). */
export function clin(sc: Scenario, s: EncounterState, action: ClinicalAction): ClinicalOutcome {
  const r = reduce(sc.case, s.clinical, action);
  if (r.rejected) return { ok: false, events: r.events, code: r.rejected.code, message: r.rejected.message };
  s.clinical = r.state;
  s.clinicalEvents.push(...r.events);
  narrateClinical(sc, s, r.events);
  return { ok: true, events: r.events };
}

/** Physiology scenario events speak (the nurse, the monitor, the patient): their message joins the conversation. */
function narrateClinical(sc: Scenario, s: EncounterState, events: readonly DomainEvent[]): void {
  for (const e of events) {
    if (e.type !== "scenario.event") continue;
    const def = sc.case.physiology?.events.find((x) => x.id === e.eventId);
    if (def?.message) utter(s, def.speaker === "patient" ? s.patient.id : "narrator", null, t(def.message, LOCALE), "event");
  }
}

export function setClinicalFlag(sc: Scenario, s: EncounterState, flag: string, value: boolean): void {
  if (s.clinical.flags.includes(flag) === value) return;
  clin(sc, s, { type: "flag", flag, value, by: "system" });
}

/** Mirror field facts into ClinicalCraft flags, so a case's physiology events and conditions can follow them. */
export function syncClinicalFlags(sc: Scenario, s: EncounterState): void {
  setClinicalFlag(sc, s, "acu.needles-in", retainedNeedles(s).length > 0);
  setClinicalFlag(sc, s, "acu.lying", LYING.includes(s.patient.position));
  setClinicalFlag(sc, s, "acu.fainted", s.patient.fainted);
  setClinicalFlag(sc, s, "acu.referred", s.referrals.length > 0);
  setClinicalFlag(sc, s, "acu.stopped", s.stopped !== null && s.stopped.visit === visitIndex(s));
  for (const f of s.flags) setClinicalFlag(sc, s, `acu.${f}`, true);
}

/* ------------------------------------------------------------------ */
/* Speech and patient feedback                                         */
/* ------------------------------------------------------------------ */

export function utter(s: EncounterState, speaker: string, to: string | null, text: string, kind: "speech" | "answer" | "narration" | "event"): void {
  s.utterances.push({ seq: s.utterances.length, at: now(s), speaker, to, text, kind });
}

export function feedback(s: EncounterState, kind: FeedbackKind, text: string, source: FeedbackRecord["source"], needleId?: string): FeedbackRecord {
  const rec: FeedbackRecord = { visit: visitIndex(s), at: now(s), kind, text, abnormal: ABNORMAL_FEEDBACK.includes(kind), source, ...(needleId ? { needleId } : {}) };
  s.patient.feedback.push(rec);
  if (kind === "faint") {
    s.patient.fainted = true;
    s.patient.recoverySince = null;
  }
  if (rec.abnormal) s.patient.anxiety = Math.min(1, s.patient.anxiety + 0.15);
  utter(s, s.patient.id, null, text, "speech");
  return rec;
}

/* ------------------------------------------------------------------ */
/* Clock and field events                                              */
/* ------------------------------------------------------------------ */

/** Advance simulated time, minute by minute, settling events and giving NPCs their turn at each minute. */
export function spend(ctx: Ctx, minutes: number, opts: { stopOnInterrupt: boolean }): { spent: number; interrupted: string[] } {
  const { sc, s } = ctx;
  let remaining = minutes;
  let spent = 0;
  const interrupted: string[] = [];
  const firedIds = () => sc.field.events.filter((e) => e.interrupts && s.events[e.id]?.firedAt != null).map((e) => e.id);
  const before = new Set(firedIds());
  while (remaining > 1e-9) {
    const t0 = now(s);
    const boundary = Math.floor(t0 + 1e-9) + 1;
    const chunk = Math.min(remaining, boundary - t0);
    clin(sc, s, { type: "advance-time", minutes: chunk, reason: "procedure", by: "system" });
    remaining -= chunk;
    spent += chunk;
    settle(sc, s);
    ctx.npcTurn();
    // an interrupting event may fire here or inside an NPC's act: either way it stops what is under way
    const stops = firedIds().filter((id) => !before.has(id));
    for (const id of stops) before.add(id);
    interrupted.push(...stops);
    if (stops.length > 0 && opts.stopOnInterrupt) break;
  }
  return { spent, interrupted };
}

/** Arm, draw and fire field events whose time has come; recovery from a faint. Returns the ids fired now. */
export function settle(sc: Scenario, s: EncounterState): string[] {
  const fired: string[] = [];
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const ev of sc.field.events) {
      const rec = s.events[ev.id];
      if (rec?.firedAt != null) continue;
      if (!rec) {
        if (!evaluateField(sc, s, ev.when)) continue;
        const draw = ev.probability >= 1 ? true : createRng(seedFrom(s.seed, sc.id, ev.id))() < ev.probability;
        s.events[ev.id] = { armedAt: now(s), draw, firedAt: null };
        changed = true;
      }
      const armed = s.events[ev.id]!;
      if (armed.firedAt != null) continue;
      if (rec && !evaluateField(sc, s, ev.when)) {
        // the condition no longer holds (the needles came out first): the event waits until it holds again
        delete s.events[ev.id];
        changed = true;
        continue;
      }
      if (!armed.draw) continue;
      if (now(s) + 1e-9 < armed.armedAt + ev.afterMinutes) continue;
      armed.firedAt = now(s);
      fire(sc, s, ev);
      fired.push(ev.id);
      changed = true;
    }
    if (!changed) break;
  }
  recover(s);
  syncClinicalFlags(sc, s);
  return fired;
}

function fire(sc: Scenario, s: EncounterState, ev: FieldEvent): void {
  const fx = ev.effects;
  for (const f of fx.flags) if (!s.flags.includes(f)) s.flags.push(f);
  for (const f of fx.clinicalFlags) setClinicalFlag(sc, s, f, true);
  if (fx.say) {
    const speaker = fx.say.speaker === "patient" ? s.patient.id : fx.say.speaker === "assistant" ? (sc.field.cast.find((m) => m.agent === "npc")?.id ?? "narrator") : "narrator";
    utter(s, speaker, null, fx.say.text, "event");
  }
  if (fx.feedback) feedback(s, fx.feedback.kind, fx.feedback.text, "event");
  if (fx.consent === "withdrawn" && (s.patient.consent.status === "given" || s.patient.consent.status === "questions")) {
    s.patient.consent = { ...s.patient.consent, status: "withdrawn", at: now(s) };
  }
  if (fx.anxiety !== undefined) s.patient.anxiety = Math.max(0, Math.min(1, s.patient.anxiety + fx.anxiety));
  if (fx.needle) {
    const order = insertionOrder(s).filter((o) => o.needle.location.kind === "patient");
    const pick = fx.needle.select === "last-inserted" ? order[order.length - 1] : order[0];
    if (pick) {
      const n = s.needles[pick.needle.id]!;
      const loc = n.location;
      if (fx.needle.becomes === "dropped-hidden") {
        n.location = { kind: "floor", area: fx.needle.area, hidden: true };
        n.contaminated = true;
        n.contamination.push("fell out of the patient");
        pushNeedleEvent(s, n.id, "system", "dropped", `fell out unseen (${fx.needle.area})`);
      } else if (loc.kind === "patient") {
        n.location = { kind: "broken-in-patient", region: loc.region, side: loc.side, entry: loc.entry };
        pushNeedleEvent(s, n.id, "system", "broken", "the shaft broke: a fragment is retained");
      }
    }
  }
}

function recover(s: EncounterState): void {
  if (!s.patient.fainted) return;
  const ok = LYING.includes(s.patient.position) && retainedNeedles(s).length === 0;
  if (!ok) {
    s.patient.recoverySince = null;
    return;
  }
  if (s.patient.recoverySince === null) s.patient.recoverySince = now(s);
  else if (now(s) - s.patient.recoverySince >= 2) {
    s.patient.fainted = false;
    s.patient.recoverySince = null;
    feedback(s, "relief", "I'm feeling a bit better now, lying down.", "patient");
  }
}

export function pushNeedleEvent(s: EncounterState, needleId: string, actor: string, what: EncounterState["needles"][string]["events"][number]["what"], detail?: string): void {
  const n = s.needles[needleId]!;
  s.seq += 1;
  n.events.push({ seq: s.seq, at: now(s), version: s.version, actor, what, ...(detail ? { detail } : {}) });
}

export const placeholderAttempt = (index: number, req: ActionRequest, at: number, version: number): AttemptRecord => ({
  index,
  requestId: req.requestId,
  actor: req.actor,
  at,
  request: req,
  target: null,
  status: "rejected",
  executed: null,
  protection: null,
  resultVersion: version,
  code: null,
  message: "",
  violations: [],
  unsafe: [],
  observations: [],
});
