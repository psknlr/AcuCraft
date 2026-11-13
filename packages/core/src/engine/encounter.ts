import {
  createRng,
  createSession,
  matchExam,
  matchHistory,
  matchOrders,
  MATCH_THRESHOLD,
  reduce,
  resultFor,
  resultKey,
  seedFrom,
  t,
  vitalsAt,
  type Result,
} from "@clinicalcraft/core";
import { ActionRequestSchema, type Action, type ActionRequest, type ActionRequestInput, type ActionType, type PointRef } from "../schema/actions.js";
import { PositionSchema, type ChartPoint, type Position, type Side } from "../schema/common.js";
import type { AcupointDefinition } from "../schema/knowledge.js";
import type { UnsafeCode } from "../schema/field.js";
import { ENCOUNTER_SCHEMA_ID, type AttemptRecord, type EncounterState, type Mode, type NeedleState, type Protection, type TaskState, type Violation } from "../schema/state.js";
import { assessPath, patientRegion, pointInstance, pointTargets, regionAccess, type PathAssessment, type PatientRegion } from "./anatomy.js";
import { addEvidence, describeGrasp, describeSensation, DEQI_THRESHOLD, evidenceById, needleEvidence, needleResponse, patternSupport, recordEvidenceId, showsDeqi, STRONG_RESPONSE } from "./evidence.js";
import { checkInvariants } from "./invariants.js";
import { NPC_POLICIES } from "./npc.js";
import {
  apparentlyRetained,
  consentCovers,
  currentPlan,
  currentVisit,
  explainedTopics,
  fellUnseen,
  fmt,
  insertionOrder,
  needleList,
  now,
  openedNeedles,
  parseRef,
  planIncludes,
  refKey,
  retainedNeedles,
  unresolvedNeedles,
  visitIndex,
} from "./queries.js";
import { checkPermission, CLINICAL_ACTS, roleAccepts, rulesInForce, rulesOfKind, type RuleInForce } from "./rules.js";
import {
  addUnsafe,
  clin,
  feedback,
  LOCALE,
  LYING,
  newOutcome,
  observe,
  placeholderAttempt,
  pushNeedleEvent,
  Rejection,
  settle,
  setClinicalFlag,
  spend,
  syncClinicalFlags,
  utter,
  type Ctx,
} from "./runtime.js";
import { clinicWorld, roleOf, type Scenario } from "./scenario.js";
import { atFixture, atFixtureOfKind, nearActor, patientBody, patientContact, patientSight, patientTalk, placeEveryone, placePatient, seatIn, siteOf, siteReach, walk, walkTarget, type MoveTarget, type Spatial } from "./space.js";
import { ARM_REACH_M, CONTACT_RANGE_M, distanceToArea, fixtureReach, planWalk, seesArea, spotsNear } from "./world.js";
import { detectClaims, detectCommitment, detectTopics, questionCount, type Claim } from "./text.js";
import { clone } from "./util.js";

/**
 * The encounter engine: `createEncounter` and `step`. Pure — `step` never mutates its input and returns a new state.
 *
 * Every request is checked (actor, patient, version, permission), then executed by its handler; its effects are
 * committed at their own execution events (a compound action that is interrupted keeps the removals it made). Every
 * request leaves an `AttemptRecord` with the four records the evaluator keeps: the request, what was executed, any
 * protective intervention, and the resulting state version.
 */

export interface EncounterOptions {
  seed?: number;
  mode?: Mode;
}

export function createEncounter(sc: Scenario, opts: EncounterOptions = {}): EncounterState {
  const seed = opts.seed ?? 1;
  let clinical = createSession(sc.case);
  const started = reduce(sc.case, clinical, { type: "start", by: "system" });
  if (started.rejected) throw new Error(`the scenario's case cannot start: ${started.rejected.message}`);
  clinical = started.state;
  const visit1 = sc.field.visits[0]!;
  const s: EncounterState = {
    schema: ENCOUNTER_SCHEMA_ID,
    scenarioId: sc.id,
    seed,
    mode: opts.mode ?? "assessment",
    version: 0,
    seq: 0,
    clinical,
    clinicalEvents: [...started.events],
    visits: [{ index: 1, phase: visit1.phase, date: visit1.date, startedAt: 0, ended: false, endedAt: null }],
    actors: Object.fromEntries(sc.field.cast.map((m) => [m.id, { id: m.id, role: m.role, location: m.location, at: { x: 0, z: 0, yaw: 0 }, hygieneSeq: null, soiledSeq: null, holding: [] }])),
    patient: {
      id: sc.field.patient.id,
      location: sc.field.patient.location,
      at: { x: 0, z: 0, yaw: 0 },
      support: null,
      position: sc.field.patient.position,
      anxiety: sc.field.patient.anxiety,
      consent: { status: "none", planVersion: null, at: null, topics: [] },
      feedback: [],
      fainted: false,
      recoverySince: null,
    },
    landmarks: [],
    measurements: [],
    marks: {},
    couches: Object.fromEntries(sc.clinic.rooms.filter((r) => r.fixtures.some((f) => f.kind === "couch")).map((r) => [r.id, { prepared: null }])),
    sitesPrepared: [],
    revealedConditions: [],
    revealedAshi: [],
    assessments: [],
    decisions: [],
    plans: [],
    planApproved: null,
    referrals: [],
    explanations: [],
    packs: {},
    needles: {},
    items: Object.fromEntries(sc.clinic.supplies.map((i) => [i.id, { id: i.id, holder: null, at: i.at }])),
    counts: [],
    tasks: {},
    utterances: [],
    monitorLog: [],
    vitalsLog: [],
    documents: [],
    incidents: [],
    claims: [],
    stopped: null,
    flags: [],
    events: {},
    walks: [],
    evidence: [],
    attempts: [],
    finished: false,
    finishedAt: null,
  };
  placeEveryone(sc, s);
  for (const p of sc.field.equipment.packs) {
    const ids = Array.from({ length: p.count }, (_, i) => `${p.id}.${i + 1}`);
    s.packs[p.id] = { id: p.id, at: p.at, holder: null, sealed: p.sealed, expired: p.expired, needles: ids, openedBy: null, openedAt: null };
    for (const id of ids) {
      s.needles[id] = {
        id,
        packId: p.id,
        spec: p.needle,
        location: { kind: "pack", packId: p.id },
        used: false,
        contaminated: false,
        contamination: [],
        insertedBy: null,
        removedBy: null,
        observer: null,
        resolution: null,
        bleeding: false,
        response: null,
        insertion: null,
        events: [],
      };
    }
  }
  if (clinical.phase !== visit1.phase) enterPhase(sc, s, visit1.phase, 1);
  settle(sc, s);
  return s;
}

export interface StepOptions {
  /** Check the needle invariants after the step and throw when one fails (tests, CI). */
  strict?: boolean;
  /** Run the scenario's NPC policies (default true). */
  npcs?: boolean;
}

export interface StepResult {
  state: EncounterState;
  /** The record of this request (for a duplicate request id: the first one's). */
  attempt: AttemptRecord;
  duplicate: boolean;
  /** Every record this step added: the request's, then those of NPC acts it triggered. */
  attempts: AttemptRecord[];
}

export function step(sc: Scenario, s: EncounterState, input: ActionRequestInput, opts: StepOptions = {}): StepResult {
  const parsed = ActionRequestSchema.safeParse(input);
  if (!parsed.success) {
    const raw = input as Partial<ActionRequest>;
    if (typeof raw?.requestId !== "string" || typeof raw?.actor !== "string") throw new TypeError(`invalid action request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const draft = clone(s);
    // keep the request on record, with an action every reader can handle
    const action = raw.action && typeof raw.action === "object" && typeof (raw.action as { type?: unknown }).type === "string" ? raw.action : ({ type: "invalid" } as unknown as ActionRequest["action"]);
    const safe = { ...raw, patient: typeof raw.patient === "string" ? raw.patient : "patient", action } as ActionRequest;
    const rec = placeholderAttempt(draft.attempts.length, safe, now(draft), draft.version);
    rec.code = "invalid-request";
    rec.message = parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    draft.attempts.push(rec);
    return { state: draft, attempt: rec, duplicate: false, attempts: [rec] };
  }
  const req = parsed.data;
  const prior = s.attempts.find((a) => a.requestId === req.requestId);
  if (prior) return { state: s, attempt: prior, duplicate: true, attempts: [] };
  const draft = clone(s);
  const produced = apply(sc, draft, req, "external", opts.npcs !== false).map((i) => draft.attempts[i]!);
  if (opts.strict) {
    const broken = checkInvariants(sc, draft);
    if (broken.length > 0) throw new Error(`invariant broken after ${req.action.type} (${req.requestId}): ${broken.join("; ")}`);
  }
  return { state: draft, attempt: produced[0]!, duplicate: false, attempts: produced };
}

/** Apply a request to a draft state in place. Returns the attempt records it produced (its own first). */
/**
 * Apply a request to a draft state in place. Returns the indices (in `s.attempts`) of the records it produced, its own
 * first. Nothing here keeps a reference into `s` across a nested request: an NPC request that is rejected restores the
 * state from its own snapshot, which replaces the objects an outer frame might hold, so records are found by index and
 * the actor through a getter.
 */
function apply(sc: Scenario, s: EncounterState, req: ActionRequest, origin: "external" | "npc", npcs: boolean): number[] {
  const snapshot = clone(s);
  const index = s.attempts.length;
  s.attempts.push(placeholderAttempt(index, req, now(s), s.version));
  const produced: number[] = [index];
  const type = req.action.type;
  const spoken = s.utterances.length;
  const npcTurn = () => {
    if (origin === "external" && npcs) runNpcs(sc, s, produced);
  };
  try {
    if (s.finished) throw new Rejection("finished", "The encounter has finished.");
    if (req.patient !== s.patient.id) throw new Rejection("unknown-patient", `There is no patient ${req.patient} in this encounter.`);
    if (!s.actors[req.actor]) throw new Rejection("unknown-actor", `${req.actor} is not part of this encounter.`);
    if (req.expectedVersion !== undefined && req.expectedVersion !== s.version) {
      throw new Rejection("stale-version", `The request was decided on state version ${req.expectedVersion}; the state is now at version ${s.version}. Observe again and decide on the current state.`);
    }
    const perm = checkPermission(sc, s, req.actor, type);
    if (!perm.ok) {
      throw new Rejection("not-authorised", perm.reason, CLINICAL_ACTS.includes(type) ? { unsafe: ["unauthorised-act"], protection: { by: sc.roles.id, kind: "rule", reason: perm.reason } } : {});
    }
    const ctx: Ctx = {
      sc,
      s,
      req,
      get actor() {
        return s.actors[req.actor]!;
      },
      out: newOutcome(),
      npcTurn,
    };
    HANDLERS[type](ctx, req.action as never);
    s.version += 1;
    const committed = s.version;
    // events arm at the minute their condition first holds — the action's own minute — before its time passes
    settle(sc, s);
    if (ctx.out.cost > 0 && origin === "external") {
      const r = spend(ctx, ctx.out.cost, { stopOnInterrupt: false });
      ctx.out.interrupted.push(...r.interrupted);
    }
    for (const u of s.utterances.slice(spoken)) if (u.speaker !== req.actor) ctx.out.observations.push(`${speakerLabel(sc, u.speaker)}: "${u.text}"`);
    for (const id of ctx.out.interrupted) ctx.out.steps.push(`interrupted by ${id}`);
    Object.assign(s.attempts[index]!, {
      status: ctx.out.status,
      target: ctx.out.target,
      executed: { type, detail: ctx.out.detail, steps: ctx.out.steps },
      protection: ctx.out.protection,
      resultVersion: committed,
      message: ctx.out.message,
      violations: ctx.out.violations,
      unsafe: ctx.out.unsafe,
      observations: ctx.out.observations,
    } satisfies Partial<AttemptRecord>);
    npcTurn();
  } catch (e) {
    if (!(e instanceof Rejection)) throw e;
    for (const key of Object.keys(s) as (keyof EncounterState)[]) (s as unknown as Record<string, unknown>)[key] = (snapshot as unknown as Record<string, unknown>)[key];
    const rec = placeholderAttempt(index, req, now(s), s.version);
    Object.assign(rec, {
      status: e.extra.protection ? "blocked" : "rejected",
      code: e.code,
      message: e.message,
      unsafe: e.extra.unsafe ?? [],
      protection: e.extra.protection ?? null,
      violations: e.extra.violations ?? [],
      resultVersion: s.version,
    } satisfies Partial<AttemptRecord>);
    s.attempts.push(rec);
    produced.length = 1;
  }
  return produced;
}

function runNpcs(sc: Scenario, s: EncounterState, produced: number[]): void {
  for (const member of sc.field.cast) {
    if (member.agent !== "npc" || s.finished) continue;
    const policy = NPC_POLICIES[member.policy ?? "idle"] ?? NPC_POLICIES.idle!;
    for (let i = 0; i < 6; i++) {
      const action = policy(sc, s, member.id);
      if (!action) break;
      const parsed = ActionRequestSchema.safeParse({ requestId: `npc:${member.id}:${s.attempts.length}`, actor: member.id, patient: s.patient.id, action });
      if (!parsed.success) break; // a policy never sends what the engine cannot parse; if it did, it waits
      const recs = apply(sc, s, parsed.data, "npc", false);
      produced.push(...recs);
      const status = s.attempts[recs[0]!]!.status;
      if (status === "rejected" || status === "blocked") break;
    }
  }
}

export function speakerLabel(sc: Scenario, id: string): string {
  if (id === sc.field.patient.id) return t(sc.case.patient.displayName, LOCALE);
  if (id === "narrator") return "Narrator";
  return sc.field.cast.find((m) => m.id === id)?.name ?? id;
}

/* ------------------------------------------------------------------ */
/* Shared checks                                                       */
/* ------------------------------------------------------------------ */

/** Refuse an act the actor is not placed for: the message says how far away it is and which walk makes it possible. */
function need(check: Spatial): void {
  if (!check.ok) throw new Rejection(check.code, check.message);
}

/** Near enough to speak with the patient (3 m, in sight). */
const inEarshot = (ctx: Ctx) => need(patientTalk(ctx.sc, ctx.s, ctx.actor.id));
/** At the patient's side (1.5 m of the couch or chair they are on). */
const atSide = (ctx: Ctx, purpose: string) => need(patientContact(ctx.sc, ctx.s, ctx.actor.id, purpose));
/** Within an arm's reach of a body site, where the patient lies or sits now. */
const atSite = (ctx: Ctx, region: string, side: Side) => need(siteReach(ctx.sc, ctx.s, ctx.actor.id, region, side));
/** With the patient in view. */
const inSight = (ctx: Ctx) => need(patientSight(ctx.sc, ctx.s, ctx.actor.id));

function regionFrame(ctx: Ctx, regionId: string, side: Side): PatientRegion {
  const { sc, s } = ctx;
  if (!sc.bundle.regions.has(regionId)) throw new Rejection("not-modelled", `There is no regional model ${regionId}.`);
  const region = sc.bundle.regions.get(regionId)!;
  if (region.laterality === "bilateral" && side === "midline") throw new Rejection("invalid", `The ${region.title} is bilateral: say left or right.`);
  const access = regionAccess(region, side, s.patient.position);
  if (!access.accessible) throw new Rejection("not-accessible", `${access.reason}: reposition the patient first.`);
  return patientRegion(sc, regionId, side, access.configuration);
}

const pointLabel = (sc: Scenario, r: PointRef): string => {
  if ("ashi" in r) return `Ashi point ${r.ashi}`;
  const p = sc.bundle.acupoints.get(r.point);
  const site = r.site ? p?.siteLocalisations?.find((x) => x.id === r.site)?.label ?? r.site : null;
  return `${r.point}${p ? ` ${p.names.pinyin}` : ""}${site ? `, ${site}` : ""}${r.side !== "midline" ? ` (${r.side})` : ""}`;
};

const at2 = (p: ChartPoint) => `u=${fmt(p.u)} cm, v=${fmt(p.v)} cm`;

function violation(r: RuleInForce, detail: string, unsafe: UnsafeCode | null): Violation {
  return { ruleSet: r.ruleSet.id, rule: r.rule.id, severity: r.rule.severity, unsafe, detail };
}

const handsClean = (a: { hygieneSeq: number | null; soiledSeq: number | null }) => a.hygieneSeq !== null && (a.soiledSeq === null || a.hygieneSeq > a.soiledSeq);

/** The patient takes a new position: skin marks made in another configuration of their region go stale. */
function setPatientPosition(ctx: Ctx, position: Position): void {
  const { s, sc } = ctx;
  s.patient.position = position;
  // skin marks made in another configuration of their region no longer lie over the points
  let stale = 0;
  for (const m of Object.values(s.marks)) {
    if (m.visit !== visitIndex(s) || m.stale) continue;
    const region = sc.bundle.regions.get(m.region)!;
    const access = regionAccess(region, m.side, position);
    if (access.configuration !== m.configuration) {
      m.stale = true;
      stale += 1;
      const nearest = [...region.landmarks].sort((x, y) => Math.hypot(x.at.u - m.position.u, x.at.v - m.position.v) - Math.hypot(y.at.u - m.position.u, y.at.v - m.position.v))[0];
      const from = nearest?.configurations[m.configuration] ?? { du: 0, dv: 0 };
      const to = nearest?.configurations[access.configuration] ?? { du: 0, dv: 0 };
      m.position = { u: m.position.u + (to.du - from.du), v: m.position.v + (to.dv - from.dv) };
    }
  }
  if (stale > 0) observe(ctx, `${stale} skin mark(s) were made in another position and have moved with the skin: re-localise before needling.`);
}

/** Handling cleaned skin again undoes its preparation (the skin is touched after cleaning). */
function touchSite(ctx: Ctx, region: string, side: Side, how: string): void {
  const { s } = ctx;
  let undone = false;
  for (const p of s.sitesPrepared) {
    if (p.visit !== visitIndex(s) || p.region !== region || p.side !== side || p.touched) continue;
    p.touched = { at: now(s), by: ctx.actor.id, how };
    undone = true;
  }
  if (undone) observe(ctx, `The cleaned skin (${side} ${region}) has been touched again: prepare it again before needling.`);
}

function soil(s: EncounterState, actor: { soiledSeq: number | null }): void {
  s.seq += 1;
  actor.soiledSeq = s.seq;
}

/** Hand-hygiene rules in force for this action: record or block. */
function handHygieneRules(ctx: Ctx, type: ActionType, blockers: Protection[]): void {
  for (const r of rulesOfKind(rulesInForce(ctx.sc, ctx.s, ctx.actor.id), "hand-hygiene-before")) {
    if (!r.rule.check.actions.includes(type)) continue;
    if (handsClean(ctx.actor)) continue;
    ctx.out.violations.push(violation(r, `${type} without hand hygiene since hands were last soiled`, "hand-hygiene-omitted"));
    addUnsafe(ctx, "hand-hygiene-omitted");
    if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: perform hand hygiene first` });
  }
}

function blockIf(ctx: Ctx, blockers: Protection[], message: string): void {
  if (blockers.length === 0) return;
  throw new Rejection("blocked", `${message}: ${blockers.map((b) => b.reason).join("; ")}`, { unsafe: ctx.out.unsafe, protection: blockers[0]!, violations: ctx.out.violations });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

type Handler<T extends ActionType> = (ctx: Ctx, a: Extract<Action, { type: T }>) => void;
type HandlerMap = { [T in ActionType]: Handler<T> };

/** "How does it feel now?", "Are you okay?": the patient answers from how they are, not from the history. */
const HOW_ARE_YOU = /\b(how (does|do|is|are) (it|that|the \w+|you|your \w+)( \w+)? (feel|feeling|doing)|how are you( feeling| doing)?|are you (ok|okay|alright|all right|comfortable)|(any|feel any) (pain|discomfort|sensation)|is (that|it|everything) (ok|okay|alright|all right))\b/;

function presentState(ctx: Ctx): void {
  const { s } = ctx;
  inEarshot(ctx);
  const recent = s.patient.feedback.filter((f) => f.abnormal && f.at >= now(s) - 3);
  const needleIds = new Set(retainedNeedles(s).map((n) => n.id));
  const ongoing = recent.filter((f) => !f.needleId || needleIds.has(f.needleId));
  let reply: string;
  if (s.patient.fainted) reply = "I feel dizzy and sick… everything is going grey.";
  else if (ongoing.length > 0) reply = ongoing[ongoing.length - 1]!.text;
  else if (recent.length > 0) reply = "That's better now, thank you.";
  else if (s.patient.anxiety >= 0.6) reply = "I'm all right, just a bit nervous.";
  else if (needleIds.size === 0) reply = "I'm fine, thank you.";
  else {
    // how the needles feel in general, from the field: it says nothing of any one needle, so it is evidence of none
    const felt = retainedNeedles(s).filter((n) => n.response?.deqi).length;
    reply = felt === 0 ? "It's okay — I can hardly feel the needles." : felt === needleIds.size ? "It's okay — a dull, heavy feeling around the needles." : "It's okay — a dull ache at some of them; the others I hardly feel.";
    observe(ctx, "(For what they feel at one needle, ask about that needle: check_sensation.)");
  }
  utter(s, s.patient.id, ctx.actor.id, reply, "answer");
  ctx.out.detail = "the patient said how they feel";
}

/** "What do you feel at ST36?": a question about the sensation at needles it names (by needle id or by their point). */
const ABOUT_SENSATION = /\b(feel|feeling|feels|sensation|ache|aching|heavy|heaviness|numb|tingl\w*|de ?qi)\b|得气/;

function needlesNamed(ctx: Ctx, text: string): NeedleState[] {
  const lower = text.toLowerCase();
  if (!ABOUT_SENSATION.test(lower)) return [];
  const mentions = (word: string) => new RegExp(`(^|[^a-z0-9.-])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}($|[^a-z0-9-])`).test(lower);
  // the needles the practitioner takes to be in place, by the target they named when they put each in
  return apparentlyRetained(ctx.s).filter((n) => {
    const placed = n.events.find((e) => e.what === "inserted")?.detail;
    const target = placed ? parseRef(placed) : null;
    return mentions(n.id) || (target !== null && "point" in target && mentions(target.point));
  });
}

/** The patient says what they feel at one needle: evidence of that needle's response, under its own id. */
function askSensation(ctx: Ctx, n: NeedleState): void {
  const { s, sc } = ctx;
  const r = n.response;
  if (!r) return;
  // a needle that fell out unseen is felt no more: the patient says so, and nobody is told why
  const said = fellUnseen(n) ? { text: "I hardly feel that one at all.", qualities: [] } : describeSensation(r);
  utter(s, s.patient.id, ctx.actor.id, said.text, "answer");
  const e = addEvidence(s, { kind: "sensation", ref: n.id, by: ctx.actor.id, text: said.text, needle: { id: n.id, qualities: said.qualities, grasp: null, volunteered: false } });
  const placed = n.events.find((x) => x.what === "inserted")?.detail;
  observe(ctx, `Asked about ${n.id}${placed ? ` (${pointLabel(sc, parseRef(placed))})` : ""} — evidence ${e.id}.`);
  ctx.out.steps.push(`${e.id}: ${n.id}`);
}

/** What the patient says of a needle unasked — pain, a shock, a strong response — is evidence of that needle too. */
function volunteer(ctx: Ctx, n: NeedleState, kind: Parameters<typeof feedback>[1], text: string, qualities: NonNullable<EncounterState["evidence"][number]["needle"]>["qualities"]): void {
  feedback(ctx.s, kind, text, "needle", n.id);
  addEvidence(ctx.s, { kind: "sensation", ref: n.id, by: ctx.actor.id, text, needle: { id: n.id, qualities, grasp: null, volunteered: true } });
}

function answerQuestion(ctx: Ctx, itemId: string | undefined, text: string | undefined, minScore: number = MATCH_THRESHOLD): void {
  const { sc, s } = ctx;
  inEarshot(ctx);
  if (s.patient.fainted) {
    observe(ctx, "The patient is too faint to answer.");
    return;
  }
  let ids: string[];
  const via = itemId ? "button" : "free-text";
  if (itemId) ids = [itemId];
  else {
    const hits = matchHistory(sc.case, text ?? "", LOCALE, { phase: s.clinical.phase });
    const best = hits[0]?.score ?? 0;
    ids = hits.filter((h) => h.score >= 0.55 && h.score >= best - 0.25).slice(0, 2).map((h) => h.id);
    if (ids.length === 0 && best >= minScore) ids = [hits[0]!.id];
  }
  if (text && questionCount(text) > 2) observe(ctx, "(The patient answers one or two questions at a time.)");
  const answers: string[] = [];
  for (const id of ids) {
    const item = sc.case.history.find((h) => h.id === id);
    if (!item) throw new Rejection("unknown-id", `There is no history item ${id}.`);
    const r = clin(sc, s, { type: "ask", itemId: id, via, by: "learner" });
    if (r.ok) {
      answers.push(t(item.answer, LOCALE));
      addEvidence(s, { id, kind: "history", ref: id, by: ctx.actor.id, text: t(item.answer, LOCALE) });
    }
  }
  const reply = answers.length > 0 ? answers.join(" ") : t(sc.case.patient.persona.fallbackUnknown, LOCALE);
  utter(s, s.patient.id, ctx.actor.id, reply, "answer");
  ctx.out.detail = ids.length > 0 ? `answered: ${ids.join(", ")}` : "no recorded answer";
  ctx.out.target = ids.join(",") || null;
}

/**
 * A free-text question: about the sensation at needles it names; else, in conversation (`say`), about how the patient
 * is; else about the history.
 */
function freeQuestion(ctx: Ctx, text: string, opts: { minScore?: number; howAreYou: boolean }): void {
  const named = needlesNamed(ctx, text);
  if (named.length > 0) {
    inEarshot(ctx);
    if (ctx.s.patient.fainted) {
      observe(ctx, "The patient is too faint to answer.");
      return;
    }
    for (const n of named.slice(0, 3)) askSensation(ctx, n);
    ctx.out.detail = `asked what they feel at ${named.slice(0, 3).map((n) => n.id).join(", ")}`;
    return;
  }
  if (opts.howAreYou && HOW_ARE_YOU.test(text.toLowerCase())) presentState(ctx);
  else answerQuestion(ctx, undefined, text, opts.minScore);
}

function formatResult(name: string, r: Result): string {
  const lines = [`${name}${r.date ? ` (${t(r.date, LOCALE)})` : ""}: ${t(r.text, LOCALE)}`];
  for (const v of r.values) {
    const value = typeof v.value === "number" ? String(v.value) : t(v.value, LOCALE);
    const ref = v.refLow !== undefined || v.refHigh !== undefined ? ` [ref ${v.refLow ?? ""}–${v.refHigh ?? ""}]` : v.refText ? ` [${t(v.refText, LOCALE)}]` : "";
    lines.push(`  ${t(v.analyte, LOCALE)}: ${value} ${v.unit}${ref}${v.flag && v.flag !== "N" ? ` ${v.flag}` : ""}`.trimEnd());
  }
  if (r.note) lines.push(`  Note: ${t(r.note, LOCALE)}`);
  return lines.join("\n");
}

function resolveInvestigation(ctx: Ctx, id: string | undefined, query: string | undefined): string | null {
  const { sc } = ctx;
  if (id) {
    if (!sc.case.investigations.some((i) => i.id === id)) return null;
    return id;
  }
  const hits = matchOrders(sc.case, query ?? "", LOCALE);
  return hits[0] ?? null;
}

const NOT_MODELLED = "Not provided or not modelled for this case.";

/** Words that say nothing about which examination is meant. */
const EXAM_STOPWORDS: ReadonlySet<string> = new Set(["the", "and", "for", "both", "with", "her", "his", "their", "your", "please", "including", "examine", "examination", "check", "look", "inspect", "inspection"]);

/** How far a palpated landmark may lie from the true one (cm), and the relative error of a tape measurement. */
export const PALPATION_ERROR_CM = 0.25;
export const MEASUREMENT_ERROR = 0.015;

function checkClaim(ctx: Ctx, claim: Claim): boolean {
  const { s } = ctx;
  const v = visitIndex(s);
  switch (claim) {
    case "all-needles-removed":
      return retainedNeedles(s).length === 0;
    case "count-correct": {
      const last = [...s.counts].reverse().find((c) => c.visit === v);
      const lastNeedleEvent = Math.max(-1, ...needleList(s).flatMap((n) => n.events.map((e) => e.at)));
      return last !== undefined && last.reconciled && last.at >= lastNeedleEvent;
    }
    case "needles-disposed":
      return openedNeedles(s).every((n) => !n.used || n.location.kind === "sharps" || n.resolution !== null);
    case "consent-obtained":
      return consentCovers(s);
    case "site-prepared":
      return s.sitesPrepared.some((p) => p.visit === v && p.touched === null);
    case "hands-clean":
      return handsClean(ctx.actor);
    case "deqi-obtained":
      // a claim of deqi rests on evidence of a needle of this visit that shows it
      return s.evidence.some((e) => e.visit === v && showsDeqi(ctx.sc, e));
  }
}

function makeTask(ctx: Ctx, assignee: string, kind: TaskState["kind"], params: TaskState["params"], source: TaskState["source"], note?: string): TaskState {
  const { s } = ctx;
  const id = `t${Object.keys(s.tasks).length + 1}`;
  const task: TaskState = {
    id,
    kind,
    params,
    assignedBy: ctx.actor.id,
    assignee,
    source,
    status: source === "statement" ? "acknowledged" : "assigned",
    assignedAt: now(s),
    acknowledgedAt: source === "statement" ? now(s) : null,
    reportedAt: null,
    report: null,
    unmet: [],
    ...(note ? { note } : {}),
  };
  s.tasks[id] = task;
  return task;
}

/** What a task still lacks before it can be called done (the engine checks the state, not the report). */
export function taskUnmet(sc: Scenario, s: EncounterState, task: TaskState, findings: readonly string[]): string[] {
  const since = task.acknowledgedAt ?? task.assignedAt;
  const me = task.assignee;
  const unmet: string[] = [];
  switch (task.kind) {
    case "monitor-patient": {
      const interval = Number(task.params.intervalMinutes ?? 5);
      const mine = s.monitorLog.filter((m) => m.by === me && m.at >= since).map((m) => m.at);
      if (mine.length === 0) unmet.push("no observation of the patient was made");
      const gap = longestUnobservedGap(s, since, now(s), mine);
      if (gap > interval + 1) unmet.push(`${fmt(gap)} min with needles in place and no observation (interval ${interval} min)`);
      const kinds = new Set(s.patient.feedback.filter((f) => f.abnormal && f.at >= since).map((f) => f.kind));
      for (const k of kinds) if (!findings.includes(k)) unmet.push(`did not report: ${k}`);
      break;
    }
    case "position-patient":
      if (s.patient.position !== task.params.position) unmet.push(`the patient is ${s.patient.position}, not ${String(task.params.position)}`);
      break;
    case "fetch": {
      const item = String(task.params.item ?? "");
      const holders = [s.packs[item]?.holder, s.items[item]?.holder];
      if (!holders.includes(task.assignedBy) && !holders.includes(me)) unmet.push(`${item} was not fetched`);
      break;
    }
    case "count-needles":
      if (!s.counts.some((c) => c.by === me && c.method === "observed" && c.at >= since)) unmet.push("no count was made at the bedside");
      break;
    case "dispose-sharps":
      if (needleList(s).some((n) => n.location.kind === "tray")) unmet.push("opened needles are still on the tray");
      break;
    case "record-vitals":
      if (!s.vitalsLog.some((v) => v.by === me && v.at >= since)) unmet.push("no vital signs were taken");
      break;
    case "chaperone":
      if (s.actors[me]?.location !== s.patient.location) unmet.push("not in the room with the patient");
      break;
    case "prepare-couch":
      // done when the assignee cleaned and made up a couch after taking the task, wherever they stand now
      if (!Object.values(s.couches).some((c) => c.prepared?.by === me && c.prepared.at >= since)) unmet.push("the couch was not cleaned and made up");
      break;
  }
  return unmet;
}

/** Longest stretch between `from` and `to` with needles retained and no observation in `observations`. */
export function longestUnobservedGap(s: EncounterState, from: number, to: number, observations: readonly number[]): number {
  // retention windows from the needle records
  const windows: [number, number][] = [];
  for (const n of needleList(s)) {
    let start: number | null = null;
    for (const e of n.events) {
      if (e.what === "inserted") start = e.at;
      if ((e.what === "withdrawn" || e.what === "dropped" || e.what === "broken") && start !== null) {
        windows.push([start, e.at]);
        start = null;
      }
    }
    if (start !== null) windows.push([start, to]);
  }
  // the union of the windows, clipped to [from, to]: time between two retentions needs no observation
  const merged: [number, number][] = [];
  for (const [a, b] of windows.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const sorted = [...observations].sort((a, b) => a - b);
  let gap = 0;
  for (const [lo, hi] of merged) {
    const marks = [lo, ...sorted.filter((o) => o > lo && o < hi), hi];
    for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i]! - marks[i - 1]!);
  }
  return gap;
}

function enterPhase(sc: Scenario, s: EncounterState, phase: string, visit: number): void {
  setClinicalFlag(sc, s, `acu.visit-${visit}`, true);
  if (s.clinical.phase !== phase) clin(sc, s, { type: "set-phase", phase, by: "system" });
}

/** A group point with sites is planned, marked and needled site by site; a single point has no sites. Returns the
 * named target (the site's own chart, construction and tolerance). */
function requireSite(def: AcupointDefinition, ref: { site?: string | undefined }) {
  const sites = def.siteLocalisations;
  if (sites && !ref.site) throw new Rejection("invalid", `${def.id} is a group of ${sites.length} sites: name one (${sites.map((x) => x.id).join(", ")}).`);
  if (!sites && ref.site) throw new Rejection("invalid", `${def.id} is a single point: it has no sites.`);
  const target = pointTargets(def).find((t) => t.site === (ref.site ?? null));
  if (sites && !target) throw new Rejection("unknown-id", `${def.id} has no site ${ref.site} (${sites.map((x) => x.id).join(", ")}).`);
  return target ?? null;
}

/** Does the named target lie under the entry (within twice its tolerance, or twice an Ashi point's radius)? */
function claimHolds(sc: Scenario, frame: PatientRegion, claimed: PointRef, region: string, side: Side, entry: ChartPoint): boolean {
  if ("ashi" in claimed) {
    const a = sc.field.patient.ashi.find((x) => x.id === claimed.ashi);
    return !!a && a.region === region && a.side === side && Math.hypot(a.centre.u - entry.u, a.centre.v - entry.v) <= 2 * a.radiusCm;
  }
  const def = sc.bundle.acupoints.get(claimed.point);
  const target = def && pointTargets(def).find((t) => t.site === (claimed.site ?? null));
  if (!def || !target || target.def.region !== region) return false;
  if (def.bilateral && frame.region.laterality === "bilateral" && claimed.side !== side) return false;
  const inst = pointInstance(sc, def, def.bilateral ? claimed.side : "midline", frame.configuration, claimed.site);
  return !!inst && Math.hypot(inst.position.u - entry.u, inst.position.v - entry.v) <= 2 * inst.toleranceCm;
}

/** The point (or Ashi point) the entry lies on: planned points first, then any modelled point, within twice its tolerance. */
function anatomicalTarget(sc: Scenario, frame: PatientRegion, region: string, side: Side, entry: ChartPoint, plan: ReturnType<typeof currentPlan>): PointRef | null {
  const found: { ref: PointRef; d: number; planned: boolean }[] = [];
  for (const point of sc.bundle.acupoints.values()) {
    for (const { site, def } of pointTargets(point)) {
      if (def.region !== region) continue;
      const sides: Side[] = !def.bilateral ? ["midline"] : frame.region.laterality === "bilateral" ? [side] : ["left", "right"];
      for (const ps of sides) {
        if (def.bilateral && side === "midline" && frame.region.laterality === "bilateral") continue;
        const inst = pointInstance(sc, point, ps, frame.configuration, site);
        if (!inst) continue;
        const d = Math.hypot(inst.position.u - entry.u, inst.position.v - entry.v) / inst.toleranceCm;
        const ref: PointRef = { point: point.id, side: ps, ...(site ? { site } : {}) };
        if (d <= 2) found.push({ ref, d, planned: planIncludes(plan, ref) });
      }
    }
  }
  for (const a of sc.field.patient.ashi) {
    if (a.region !== region || (frame.region.laterality === "bilateral" && a.side !== side)) continue;
    const d = Math.hypot(a.centre.u - entry.u, a.centre.v - entry.v) / a.radiusCm;
    const ref: PointRef = { ashi: a.id };
    if (d <= 2) found.push({ ref, d, planned: planIncludes(plan, ref) });
  }
  found.sort((x, y) => Number(y.planned) - Number(x.planned) || x.d - y.d);
  return found[0]?.ref ?? null;
}

/** Is the entry over a point cautioned for one of this patient's risk factors (within 1.5 times its tolerance)? */
function cautionedAt(sc: Scenario, frame: PatientRegion, region: string, side: Side, entry: ChartPoint): boolean {
  for (const point of sc.bundle.acupoints.values()) {
    if (!point.cautions.some((c) => sc.field.patient.riskFactors.includes(c.when))) continue;
    for (const { site, def } of pointTargets(point)) {
      if (def.region !== region) continue;
      const sides: Side[] = !def.bilateral ? ["midline"] : frame.region.laterality === "bilateral" ? [side] : ["left", "right"];
      for (const ps of sides) {
        const inst = pointInstance(sc, point, ps, frame.configuration, site);
        if (inst && Math.hypot(inst.position.u - entry.u, inst.position.v - entry.v) <= 1.5 * inst.toleranceCm) return true;
      }
    }
  }
  return false;
}

function doRemove(ctx: Ctx, needleId: string): void {
  const { s } = ctx;
  const n = s.needles[needleId];
  if (!n) throw new Rejection("unknown-id", `There is no needle ${needleId}.`);
  if (n.location.kind === "broken-in-patient") throw new Rejection("broken", `Needle ${needleId} has broken: the fragment cannot be withdrawn by hand. Report it and refer the patient.`);
  if (n.location.kind !== "patient") throw new Rejection("not-inserted", `Needle ${needleId} is not in the patient.`);
  const label = n.location.target ? pointLabel(ctx.sc, n.location.target) : `${n.location.region} ${n.location.side}`;
  n.location = { kind: "hand", actor: ctx.actor.id };
  n.removedBy = ctx.actor.id;
  if (!n.contaminated) {
    n.contaminated = true;
    n.contamination.push("used");
  }
  ctx.actor.holding.push(n.id);
  soil(s, ctx.actor);
  pushNeedleEvent(s, n.id, ctx.actor.id, "withdrawn");
  ctx.out.steps.push(`withdrew ${n.id} from ${label}`);
  if (n.bleeding) {
    feedback(s, "bleeding", "There's a little blood where that one came out.", "needle", n.id);
    observe(ctx, `The site of ${n.id} is bleeding: apply pressure.`);
  }
}

/** What the insertion record keeps of a path: the structures met or passed close by, and the hazardous layers the
 * tip reached (`layer:<label>`, a contact), so a reviewer and the evaluator see them whatever the mode. */
function insertionFindings(path: PathAssessment): { structure: string; contact: boolean; clearanceCm: number }[] {
  return [
    ...path.findings.map((f) => ({ structure: f.structure, contact: f.contact, clearanceCm: f.clearanceCm })),
    ...path.layersReached.map((l) => ({ structure: `layer:${l.label}`, contact: true, clearanceCm: 0 })),
  ];
}

function doInsertCheckPath(ctx: Ctx, n: NeedleState, frame: PatientRegion, entry: ChartPoint, angleDeg: number, azimuthDeg: number, depthCm: number, blockers: Protection[]): PathAssessment {
  const path = assessPath(frame, entry, angleDeg, azimuthDeg, depthCm, n.spec);
  if (path.pleuraPenetrated) addUnsafe(ctx, "pleura-penetration");
  if (path.layersReached.some((l) => l.hazard === "critical")) addUnsafe(ctx, "critical-structure-contact");
  for (const f of path.findings) {
    if (!f.contact) continue;
    if (f.hazard === "critical") addUnsafe(ctx, "critical-structure-contact");
    if (f.kind === "nerve") addUnsafe(ctx, "nerve-contact");
    if ((f.kind === "artery" || f.kind === "vein") && f.hazard === "critical") addUnsafe(ctx, "vessel-puncture");
  }
  if (path.critical && ctx.sc.field.safety.guard === "block-critical") {
    const what = path.pleuraPenetrated ? "the pleura" : [...path.layersReached.filter((l) => l.hazard === "critical").map((l) => l.label), ...path.findings.filter((f) => f.contact && f.hazard === "critical").map((f) => f.label)].join(", ");
    blockers.push({ by: "simulation-guard", kind: "guard", reason: `the path would reach ${what} (${fmt(path.verticalDepthCm)} cm below the skin)` });
  }
  return path;
}

function consequences(ctx: Ctx, n: NeedleState, path: PathAssessment): void {
  const { s, sc } = ctx;
  for (const f of path.findings.filter((x) => x.contact)) {
    if (f.consequence === "electric-sensation") volunteer(ctx, n, "electric-sensation", "Ah! That's like an electric shock shooting down — it's horrible.", ["electric"]);
    else if (f.consequence === "bleeding" || f.consequence === "haematoma") n.bleeding = true;
    else if (f.consequence === "tendon-pain") volunteer(ctx, n, "sharp-pain", "Ow, that one is sharp.", ["sharp-pain"]);
    else if (f.consequence === "joint-penetration") {
      if (!s.flags.includes("joint-penetration")) s.flags.push("joint-penetration");
    } else if (f.consequence === "pneumothorax-risk") {
      if (!s.flags.includes("pneumothorax-risk")) s.flags.push("pneumothorax-risk");
    }
  }
  if (path.pleuraPenetrated && !s.flags.includes("pneumothorax-risk")) s.flags.push("pneumothorax-risk");
  if (path.stoppedBy === "bone") {
    observe(ctx, `The tip of ${n.id} meets hard resistance at ${fmt(path.executedDepthCm)} cm (bone).`);
    // pressure on the bone is felt, and said: it is not one of the sensations of deqi
    volunteer(ctx, n, "dull-ache", "It feels like it's pressing on the bone.", []);
  }
  if (ctx.s.mode === "teaching") {
    observe(ctx, `Teaching: the shaft passes ${path.traversed.join(" → ")}; tip in ${path.tipTissue}.`);
    if (n.response) observe(ctx, `Teaching: the tissue's response at ${n.id} is ${fmt(n.response.intensity, 2)} (qi arrives from ${DEQI_THRESHOLD}; stimulation so far ${fmt(n.response.stimulation, 2)}).`);
    for (const f of path.findings) observe(ctx, `Teaching: ${f.label} ${f.contact ? "reached" : `${fmt(Math.max(0, f.clearanceCm))} cm away`}.`);
    for (const l of path.layersReached) observe(ctx, `Teaching: the tip reached ${l.label} (${fmt(l.depthCm)} cm below the skin).`);
  }
  void sc;
}

const HANDLERS: HandlerMap = {
  say(ctx, a) {
    const { s, sc } = ctx;
    if (a.to && !s.actors[a.to] && a.to !== s.patient.id) throw new Rejection("unknown-id", `There is no ${a.to} here.`);
    utter(s, ctx.actor.id, a.to ?? null, a.text, "speech");
    ctx.out.cost = 0.25;
    ctx.out.detail = "spoke";
    const kind = detectCommitment(a.text);
    if (kind) {
      const task = makeTask(ctx, ctx.actor.id, kind, {}, "statement");
      ctx.out.steps.push(`commitment recorded: ${task.id} ${kind}`);
    }
    for (const claim of detectClaims(a.text)) {
      const supported = checkClaim(ctx, claim);
      s.claims.push({ at: now(s), by: ctx.actor.id, text: a.text, claim, supported });
      ctx.out.steps.push(`claim ${claim}: ${supported ? "matches the state" : "not supported by the state"}`);
    }
    const toPatient = a.to === undefined || a.to === s.patient.id;
    // speech is never refused; the patient hears, and answers, only from within earshot
    if (toPatient && patientTalk(sc, s, ctx.actor.id).ok) {
      const topics = detectTopics(a.text);
      if (topics.length > 0) s.explanations.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, topics, text: a.text, tagged: [] });
      if (questionCount(a.text) > 0 && roleOf(sc, ctx.actor.id)?.grants.some((g) => (typeof g === "string" ? g : g.permission) === "consult")) freeQuestion(ctx, a.text, { minScore: 0.55, howAreYou: true });
    }
  },
  ask(ctx, a) {
    if (!a.itemId && !a.text) throw new Rejection("invalid", "Ask by history item id or as free text.");
    if (a.itemId || !a.text) answerQuestion(ctx, a.itemId, a.text);
    else freeQuestion(ctx, a.text, { howAreYou: false });
  },
  observe(ctx) {
    const { s, sc } = ctx;
    inSight(ctx);
    const name = t(sc.case.patient.displayName, LOCALE);
    observe(ctx, `${name} is ${s.patient.position} in the ${sc.clinic.rooms.find((r) => r.id === s.patient.location)?.label ?? s.patient.location}.`);
    const build = sc.case.patient.appearance.build;
    const bmi = sc.case.patient.weightKg && sc.case.patient.heightCm ? sc.case.patient.weightKg / (sc.case.patient.heightCm / 100) ** 2 : null;
    observe(ctx, `Build: ${build}${bmi ? ` (${sc.case.patient.weightKg} kg, ${sc.case.patient.heightCm} cm; BMI ${fmt(bmi)})` : ""}.`);
    if (s.patient.fainted) observe(ctx, "Looks pale, clammy and sweaty, and says they feel faint.");
    else if (s.patient.anxiety >= 0.6) observe(ctx, "Looks tense and anxious.");
    else observe(ctx, "Looks comfortable.");
    for (const c of sc.field.patient.siteConditions.filter((c) => !c.revealedBy)) {
      observe(ctx, `Visible: ${c.label} (${c.region}, ${c.side}).`);
      if (!s.revealedConditions.includes(c.id)) s.revealedConditions.push(c.id);
    }
    const retained = retainedNeedles(s);
    if (retained.length > 0) observe(ctx, `${retained.length} needle(s) in place.`);
    const seen = addEvidence(s, { kind: "observation", ref: null, by: ctx.actor.id, text: ctx.out.observations.join(" ") });
    ctx.out.steps.push(`evidence ${seen.id}`);
    ctx.out.cost = 0.5;
  },
  examine(ctx, a) {
    const { s, sc } = ctx;
    atSide(ctx, "examine them");
    let id = a.findingId;
    if (!id) {
      if (!a.text) throw new Rejection("invalid", "Examine by finding id or describe the manoeuvre.");
      // several findings can match a request equally ("Inspect the tongue" and "General inspection"): the one whose
      // manoeuvre shares most words with what was asked is meant, then one not examined yet
      const hits = matchExam(sc.case, a.text, LOCALE, { phase: s.clinical.phase });
      const best = hits[0]?.score ?? 0;
      const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !EXAM_STOPWORDS.has(w)));
      const asked = words(a.text);
      const shared = (hitId: string) => [...words(t(sc.case.exam.find((f) => f.id === hitId)?.maneuver ?? "", LOCALE))].filter((w) => asked.has(w)).length;
      id = hits
        .filter((h) => h.score >= best - 1e-9)
        .map((h, i) => ({ id: h.id, i, shared: shared(h.id), seen: s.clinical.examined.includes(h.id) }))
        .sort((x, y) => y.shared - x.shared || Number(x.seen) - Number(y.seen) || x.i - y.i)[0]?.id;
    }
    if (!id) {
      observe(ctx, sc.case.examNotRecorded ? t(sc.case.examNotRecorded, LOCALE) : "That examination is not recorded for this case.");
      ctx.out.detail = "not recorded";
      return;
    }
    const finding = sc.case.exam.find((f) => f.id === id);
    if (!finding) throw new Rejection("unknown-id", `There is no exam finding ${id}.`);
    const r = clin(sc, s, { type: "examine", findingId: id, by: "learner" });
    if (!r.ok) throw new Rejection(r.code ?? "rejected", r.message ?? "Not possible now.");
    observe(ctx, `${t(finding.maneuver, LOCALE)}: ${t(finding.finding, LOCALE)}`);
    addEvidence(s, { id, kind: "exam", ref: id, by: ctx.actor.id, text: `${t(finding.maneuver, LOCALE)}: ${t(finding.finding, LOCALE)}` });
    for (const c of sc.field.patient.siteConditions.filter((c) => c.revealedBy === id)) {
      if (!s.revealedConditions.includes(c.id)) s.revealedConditions.push(c.id);
      observe(ctx, `Site: ${c.label} (${c.region}, ${c.side}${c.centre ? `, around ${at2(c.centre)}, radius ${fmt(c.radiusCm ?? 0)} cm` : ", the whole region"}).`);
    }
    for (const ashi of sc.field.patient.ashi.filter((x) => x.revealedBy === id)) {
      if (!s.revealedAshi.includes(ashi.id)) s.revealedAshi.push(ashi.id);
      observe(ctx, `Tender point ${ashi.id} (${ashi.label}): maximal tenderness on the ${ashi.side} ${ashi.region} chart at ${at2(ashi.centre)}, over about ${fmt(ashi.radiusCm)} cm.`);
    }
    ctx.out.target = id;
    ctx.out.detail = `examined ${id}`;
  },
  review_result(ctx, a) {
    const { s, sc } = ctx;
    const id = resolveInvestigation(ctx, a.investigationId, a.query);
    if (!id) {
      observe(ctx, NOT_MODELLED);
      ctx.out.detail = "not modelled";
      return;
    }
    const inv = sc.case.investigations.find((i) => i.id === id)!;
    const terminal = atFixtureOfKind(sc, s, ctx.actor.id, "records-terminal", "records terminal");
    if (!terminal.ok && !patientContact(sc, s, ctx.actor.id).ok) throw new Rejection(terminal.code, `Records are read at a records terminal, or with the patient (the reports they brought). ${terminal.message}`);
    const phase = s.clinical.phase;
    const ordered = s.clinical.orders.some((o) => o.investigationId === id);
    if (!ordered && inv.performedAt !== "records") {
      throw new Rejection("not-a-record", `${t(inv.name, LOCALE)} is not an existing report: it would have to be ordered${checkPermission(sc, s, ctx.actor.id, "order_investigation").ok ? "" : " — in this setting, through a medical referral"}.`);
    }
    const result = resultFor(sc.case, id, phase);
    if (!result) {
      observe(ctx, `No record of ${t(inv.name, LOCALE)} for this visit.`);
      ctx.out.detail = "no record";
      return;
    }
    if (!s.clinical.orders.some((o) => o.key === resultKey(id, phase))) {
      const o = clin(sc, s, { type: "order", investigationId: id, by: "learner" });
      if (!o.ok) throw new Rejection(o.code ?? "rejected", o.message ?? "The record cannot be retrieved now.");
    }
    const r = clin(sc, s, { type: "read", investigationId: id, phase, by: "learner" });
    if (!r.ok) {
      if (r.code === "not-ready") {
        observe(ctx, `${t(inv.name, LOCALE)}: the result is not available yet.`);
        ctx.out.detail = "not ready";
        return;
      }
      throw new Rejection(r.code ?? "rejected", r.message ?? "The record cannot be read now.");
    }
    const read = result.available ? formatResult(t(inv.name, LOCALE), result) : `${t(inv.name, LOCALE)}: ${t(result.text, LOCALE)}`;
    observe(ctx, read);
    const e = addEvidence(s, { id: recordEvidenceId(id, phase), kind: "record", ref: id, by: ctx.actor.id, text: read });
    ctx.out.target = id;
    ctx.out.detail = `read ${id}@${phase} (evidence ${e.id})`;
  },
  order_investigation(ctx, a) {
    const { s, sc } = ctx;
    const id = resolveInvestigation(ctx, a.investigationId, a.query);
    if (!id) {
      observe(ctx, NOT_MODELLED);
      ctx.out.detail = "not modelled";
      return;
    }
    const inv = sc.case.investigations.find((i) => i.id === id)!;
    const r = clin(sc, s, { type: "order", investigationId: id, by: "learner" });
    if (!r.ok) throw new Rejection(r.code ?? "rejected", r.message ?? "Cannot be ordered now.");
    observe(ctx, `${t(inv.name, LOCALE)} ordered${inv.turnaroundMinutes > 0 ? `; expected in about ${inv.turnaroundMinutes} min` : ""}.`);
    ctx.out.target = id;
  },
  check_vitals(ctx) {
    const { s, sc } = ctx;
    atSide(ctx, "take their vital signs");
    const snap = vitalsAt(sc.case, s.clinical);
    if (snap.baselineOnly) {
      observe(ctx, "No vital signs are modelled for this case.");
      return;
    }
    const v = snap.vitals;
    const vitals: Record<string, number | string> = {};
    for (const [k, value] of Object.entries(v)) if (value !== undefined && k !== "ecg") vitals[k] = value as number | string;
    const parts = [v.hr !== undefined ? `pulse ${v.hr}/min` : null, v.sbp !== undefined ? `BP ${v.sbp}/${v.dbp} mmHg` : null, v.rr !== undefined ? `RR ${v.rr}/min` : null, v.spo2 !== undefined ? `SpO₂ ${v.spo2}%` : null, v.temp !== undefined ? `T ${v.temp} °C` : null].filter(Boolean);
    const e = addEvidence(s, { kind: "vitals", ref: null, by: ctx.actor.id, text: `Vital signs: ${parts.join(", ")}.` });
    s.vitalsLog.push({ id: e.id, visit: visitIndex(s), at: now(s), by: ctx.actor.id, vitals });
    observe(ctx, `Vital signs: ${parts.join(", ")}.`);
    ctx.out.cost = 1;
  },
  assess(ctx, a) {
    const { s, sc } = ctx;
    const vocab = sc.bundle.vocabulary;
    for (const d of a.diagnoses) if (!vocab.diagnoses.some((x) => x.id === d)) throw new Rejection("invalid", `Unknown diagnosis id ${d}: use the vocabulary.`);
    if (a.pattern && !vocab.patterns.some((x) => x.id === a.pattern)) throw new Rejection("invalid", `Unknown pattern id ${a.pattern}: use the vocabulary.`);
    for (const r of a.redFlags) if (!vocab.redFlags.some((x) => x.id === r)) throw new Rejection("invalid", `Unknown red flag id ${r}: use the vocabulary.`);
    // a pattern differentiation is a conclusion: it names the findings it rests on, and only findings that were obtained
    const cited = [...new Set(a.patternEvidence)];
    if (a.pattern && cited.length === 0) {
      throw new Rejection("no-evidence", `A pattern differentiation names the findings it rests on: give patternEvidence — the ids of answers, examination findings and records you have obtained (record in your view)${s.evidence.length === 0 ? "; nothing has been obtained yet" : ""}.`);
    }
    if (!a.pattern && cited.length > 0) throw new Rejection("invalid", "patternEvidence is the evidence of a pattern: name the pattern it supports.");
    const missing = cited.filter((id) => !evidenceById(s, id));
    if (missing.length > 0) {
      throw new Rejection("evidence-not-obtained", `Not in the evidence obtained in this encounter: ${missing.join(", ")}. A differentiation rests only on what was asked, examined or read — ask or examine first, and cite its id.`);
    }
    s.assessments.push({ at: now(s), by: ctx.actor.id, visit: visitIndex(s), diagnoses: a.diagnoses, pattern: a.pattern ?? null, patternEvidence: cited, redFlags: a.redFlags, rationale: a.rationale ?? "" });
    ctx.out.detail = `assessment recorded${a.pattern ? ` (pattern ${a.pattern}, on ${cited.length} finding(s))` : ""}`;
    if (a.pattern && s.mode === "teaching") {
      const sup = patternSupport(sc, a.pattern, cited, s.evidence.map((e) => e.id));
      const list = (xs: { sign: string; evidence: string[] }[]) => xs.map((x) => `${x.sign} (${x.evidence.join(", ")})`).join("; ") || "none";
      if (!sup.hasCriteria) observe(ctx, `Teaching: the vocabulary gives no criteria for ${a.pattern}; it cannot be linked to evidence.`);
      else {
        observe(ctx, `Teaching: the findings you cite show ${sup.key.length} key sign(s) of ${a.pattern} — ${list(sup.key)} — and ${sup.supporting.length} supporting — ${list(sup.supporting)}.`);
        if (sup.against.length > 0) observe(ctx, `Teaching: what you have found also speaks against it: ${list(sup.against)}.`);
        if (sup.idle.length > 0) observe(ctx, `Teaching: cited, but showing none of its signs: ${sup.idle.join(", ")}.`);
        observe(ctx, `Teaching: a differentiation rests on its evidence with ${sup.thresholds.key} key sign(s) and ${sup.thresholds.total} in all, and fewer than ${sup.thresholds.against} against — this one ${sup.supported ? "does" : "does not"}.`);
      }
    }
  },
  decide(ctx, a) {
    const { s } = ctx;
    s.decisions.push({ at: now(s), by: ctx.actor.id, disposition: a.disposition, rationale: a.rationale ?? "", visit: visitIndex(s) });
    ctx.out.detail = `disposition: ${a.disposition}`;
    ctx.out.target = a.disposition;
  },
  propose_plan(ctx, a) {
    const { s, sc } = ctx;
    for (const p of a.plan.points) {
      if ("ashi" in p) {
        if (!s.revealedAshi.includes(p.ashi)) throw new Rejection("unknown-ashi", `No tender point ${p.ashi} has been found on examination.`);
        continue;
      }
      const def = sc.bundle.acupoints.get(p.point);
      if (!def) throw new Rejection("unknown-id", `Unknown point ${p.point}.`);
      if (def.bilateral && p.side === "midline") throw new Rejection("invalid", `${p.point} is bilateral: plan it left or right.`);
      if (!def.bilateral && p.side !== "midline") throw new Rejection("invalid", `${p.point} is a midline point: its side is midline.`);
      const target = requireSite(def, p);
      if (!target || !sc.bundle.regions.has(target.def.region!)) observe(ctx, `${p.point} has no localisation model: it cannot be needled here.`);
    }
    const before = currentPlan(s);
    const coveredBefore = consentCovers(s);
    const version = s.plans.length + 1;
    s.plans.push({ version, at: now(s), by: ctx.actor.id, plan: a.plan });
    if (coveredBefore && before) {
      const old = new Set(before.plan.points.map((p) => refKey(p as PointRef)));
      const t0 = before.plan.technique;
      const t1 = a.plan.technique;
      // a material change needs a further discussion: new points, a longer retention, another method, or another
      // stimulation (reducing it to none is not a change the patient needs to agree to)
      const within =
        a.plan.points.every((p) => old.has(refKey(p as PointRef))) &&
        t1.retentionMinutes <= t0.retentionMinutes &&
        t1.method === t0.method &&
        (t1.stimulation === t0.stimulation || t1.stimulation === "none");
      if (within) s.patient.consent.planVersion = version;
      else observe(ctx, "The plan goes beyond what the patient agreed to (points, retention, method or stimulation): their consent covers the previous plan only. Explain the change and ask again.");
    }
    ctx.out.detail = `plan v${version}: ${a.plan.points.map((p) => refKey(p as PointRef)).join(", ") || "no points"}`;
    ctx.out.cost = 1;
  },
  explain(ctx, a) {
    const { s } = ctx;
    inEarshot(ctx);
    // the patient learns only what is said: topic tags index the words, they do not replace them
    const topics = a.text ? [...new Set([...a.topics, ...detectTopics(a.text)])] : [];
    if (a.text) utter(s, ctx.actor.id, s.patient.id, a.text, "speech");
    else if (a.topics.length) observe(ctx, "Nothing was said to the patient: name the topics in words to explain them.");
    s.explanations.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, topics, text: a.text ?? null, tagged: [...a.topics] });
    ctx.out.detail = `explained: ${topics.join(", ") || "nothing specific"}`;
    ctx.out.cost = 1;
  },
  seek_consent(ctx) {
    const { s, sc } = ctx;
    inEarshot(ctx);
    const plan = currentPlan(s);
    if (!plan) throw new Rejection("no-plan", "There is no treatment plan to consent to: propose one first.");
    if (s.patient.fainted) {
      observe(ctx, "The patient is unwell and cannot consider consent now.");
      return;
    }
    const pc = sc.field.patient.consent;
    const answer = (status: EncounterState["patient"]["consent"]["status"], text: string) => {
      s.patient.consent = { status, planVersion: status === "given" ? plan.version : s.patient.consent.planVersion, at: now(s), topics: [...explainedTopics(s)] };
      utter(s, s.patient.id, ctx.actor.id, text, "answer");
    };
    if (s.patient.consent.status === "withdrawn" && s.patient.consent.at !== null && s.patient.consent.at >= currentVisit(s).startedAt) {
      utter(s, s.patient.id, ctx.actor.id, "No — I've said I want to stop today.", "answer");
      ctx.out.detail = "consent withdrawn earlier this visit";
    } else if (pc.declines) {
      answer("refused", pc.decline ?? "I'd rather not have the needles, thank you.");
      ctx.out.detail = "patient declined";
    } else {
      const missing = pc.requiredTopics.filter((tp) => !explainedTopics(s).has(tp));
      if (missing.length > 0) {
        answer("questions", pc.questions);
        ctx.out.detail = `patient has questions (${missing.length} topic(s) not yet explained)`;
      } else {
        answer("given", pc.agree);
        ctx.out.detail = `consent given to plan v${plan.version}`;
      }
    }
    ctx.out.cost = 0.5;
  },
  refer(ctx, a) {
    const { s, sc } = ctx;
    const target = sc.clinic.referralTargets.find((r) => r.id === a.to);
    if (!target) throw new Rejection("unknown-id", `Unknown referral target ${a.to}.`);
    s.referrals.push({ at: now(s), by: ctx.actor.id, to: a.to, urgency: a.urgency, reason: a.reason });
    resolveBroken(s);
    observe(ctx, `Referral to ${target.label} (${a.urgency}) recorded.`);
    ctx.out.target = a.to;
    ctx.out.detail = `referred to ${a.to} (${a.urgency})`;
    ctx.out.cost = 2;
  },
  position_patient(ctx, a) {
    const { s, sc } = ctx;
    atSide(ctx, "help them move");
    if (a.position === s.patient.position) {
      observe(ctx, `The patient is already ${a.position}.`);
      return;
    }
    if (sc.field.patient.declinesPositions.includes(a.position) && !s.patient.fainted) {
      utter(s, s.patient.id, ctx.actor.id, sc.field.patient.declinesPositionText, "answer");
      ctx.out.detail = `the patient declined to be ${a.position}`;
      ctx.out.target = a.position;
      return;
    }
    const w = clinicWorld(sc);
    const room = w.rooms.get(s.patient.location);
    // where they will be: lying, on the room's couch; sitting, where they already are (else the room's chair); standing, beside it
    const current = s.patient.support ? (w.fixtures.get(s.patient.support) ?? null) : null;
    const seat = LYING.includes(a.position) ? (current?.kind === "couch" ? current : seatIn(sc, s.patient.location, a.position)) : a.position === "standing" ? null : (current ?? seatIn(sc, s.patient.location, a.position));
    if (LYING.includes(a.position) && !seat) throw new Rejection("no-couch", `There is no treatment couch in the ${room?.label ?? s.patient.location}.`);
    if (a.position === "standing" && (s.patient.fainted || retainedNeedles(s).length > 0)) throw new Rejection("unsafe-position", "The patient cannot stand up now.");
    const retained = retainedNeedles(s);
    if (retained.length > 0) {
      if (!s.patient.fainted) {
        addUnsafe(ctx, "repositioned-with-needles");
        feedback(s, "sharp-pain", "Ow — the needles pull when I move.", "needle");
      } else observe(ctx, "Repositioned in an emergency with needles still in place: remove them as soon as possible.");
    }
    const before = s.patient.position;
    const body = patientBody(sc, s);
    if (seat?.id !== s.patient.support) {
      placePatient(sc, s, s.patient.location, seat, seat ? undefined : (spotsNear(w, body.area, 0.6, body.centre)[0] ?? body.centre));
      if (seat) observe(ctx, `The patient is now on the ${seat.label}.`);
    }
    setPatientPosition(ctx, a.position);
    ctx.out.detail = `${before} → ${a.position}`;
    ctx.out.cost = 1;
  },
  identify_landmark(ctx, a) {
    const { s, sc } = ctx;
    const frame = regionFrame(ctx, a.region, a.side);
    atSite(ctx, a.region, a.side);
    const lm = frame.region.landmarks.find((l) => l.id === a.landmark);
    if (!lm) throw new Rejection("unknown-id", `The ${frame.region.title} has no landmark ${a.landmark}.`);
    // palpation is precise to a few millimetres, never exact: a seeded error per patient, landmark and position
    const truth = frame.landmark(a.landmark)!;
    const rng = createRng(seedFrom(s.seed, sc.id, a.region, a.side, a.landmark, frame.configuration));
    const angle = rng() * 2 * Math.PI;
    const r = PALPATION_ERROR_CM * Math.sqrt(rng());
    const p = { u: truth.u + r * Math.cos(angle), v: truth.v + r * Math.sin(angle) };
    s.landmarks.push({ visit: visitIndex(s), by: ctx.actor.id, at: now(s), region: a.region, side: a.side, landmark: a.landmark, position: p, configuration: frame.configuration });
    touchSite(ctx, a.region, a.side, `palpated ${a.landmark}`);
    observe(ctx, `${lm.label} (${a.side} ${frame.region.title}, ${frame.configuration}): ${at2(p)}.`);
    ctx.out.target = `${a.region}:${a.side}:${a.landmark}`;
    ctx.out.cost = 0.5;
  },
  measure(ctx, a) {
    const { s, sc } = ctx;
    const frame = regionFrame(ctx, a.region, a.side);
    atSite(ctx, a.region, a.side);
    if (a.fingerCun) {
      const cm = sc.field.patient.anatomy.fingerCunCm;
      s.measurements.push({ visit: visitIndex(s), by: ctx.actor.id, at: now(s), region: a.region, side: a.side, what: "finger-cun", cm });
      observe(ctx, `The patient's middle-finger cun measures ${fmt(cm)} cm (finger method — not the bone-proportional cun).`);
    } else {
      if (!a.segment) throw new Rejection("invalid", "Name the segment to measure, or ask for the finger cun.");
      const seg = frame.region.segments.find((x) => x.id === a.segment);
      if (!seg) throw new Rejection("unknown-id", `The ${frame.region.title} has no segment ${a.segment}.`);
      const cm = frame.cunCm(seg.id)! * seg.cun * (1 + (createRng(seedFrom(s.seed, sc.id, a.region, a.side, seg.id))() - 0.5) * 2 * MEASUREMENT_ERROR);
      s.measurements.push({ visit: visitIndex(s), by: ctx.actor.id, at: now(s), region: a.region, side: a.side, what: seg.id, cm });
      touchSite(ctx, a.region, a.side, `measured ${seg.id}`);
      observe(ctx, `${seg.label}: ${fmt(cm)} cm, which the standard divides into ${seg.cun} B-cun.`);
    }
    ctx.out.cost = 0.5;
  },
  mark_point(ctx, a) {
    const { s, sc } = ctx;
    const frame = regionFrame(ctx, a.region, a.side);
    atSite(ctx, a.region, a.side);
    if ("point" in a.target) {
      const def = sc.bundle.acupoints.get(a.target.point);
      if (!def) throw new Rejection("unknown-id", `Unknown point ${a.target.point}.`);
      const target = requireSite(def, a.target);
      if ((target?.def.region ?? def.region) !== a.region) throw new Rejection("wrong-region", `${pointLabel(sc, a.target)} is not in the ${frame.region.title}.`);
      const expected: Side = def.bilateral ? a.side : "midline";
      if (a.target.side !== expected) throw new Rejection("invalid", `${def.id} on this chart is ${expected === "midline" ? "a midline point" : `the ${expected} one`}.`);
      if (frame.region.laterality === "midline" && def.bilateral && a.side === "midline") throw new Rejection("invalid", `${def.id} is bilateral: mark it left or right.`);
    } else {
      const ashi = sc.field.patient.ashi.find((x) => x.id === (a.target as { ashi: string }).ashi);
      if (!ashi || !s.revealedAshi.includes(ashi.id)) throw new Rejection("unknown-ashi", "No such tender point has been found on examination.");
      if (ashi.region !== a.region || ashi.side !== a.side) throw new Rejection("wrong-region", `${ashi.id} is on the ${ashi.side} ${ashi.region}.`);
    }
    if (!frame.inChart(a.at)) throw new Rejection("off-chart", `${at2(a.at)} is outside the ${frame.region.title} chart.`);
    const id = `m${Object.keys(s.marks).length + 1}`;
    s.marks[id] = { id, visit: visitIndex(s), by: ctx.actor.id, at: now(s), target: a.target, region: a.region, side: a.side, position: a.at, method: a.method, patientPosition: s.patient.position, configuration: frame.configuration, stale: false };
    observe(ctx, `Marked ${pointLabel(sc, a.target)} at ${at2(a.at)} (mark ${id}).`);
    touchSite(ctx, a.region, a.side, `marked ${id}`);
    if (s.mode === "teaching" && "point" in a.target) {
      const ref = pointInstance(sc, sc.bundle.acupoints.get(a.target.point)!, a.side, frame.configuration, a.target.site);
      if (ref) observe(ctx, `Teaching: ${fmt(Math.hypot(ref.position.u - a.at.u, ref.position.v - a.at.v))} cm from the reference location (tolerance ${fmt(ref.toleranceCm)} cm).`);
    }
    ctx.out.target = id;
    ctx.out.cost = 0.5;
  },
  move(ctx, a) {
    const { s, sc } = ctx;
    const w = clinicWorld(sc);
    const to: MoveTarget = typeof a.to === "string" ? { room: a.to } : a.to;
    const index = s.attempts.length - 1;
    if (a.withPatient) {
      // the patient walks at the actor's side to a room and takes its seat (the chair, else the couch)
      if (!("room" in to)) throw new Rejection("invalid", "Walk the patient to a room (`to` a room id): once there they take a seat, and `position_patient` gets them onto the couch.");
      const room = w.rooms.get(to.room);
      if (!room) throw new Rejection("unknown-id", `There is no room ${to.room}.`);
      need(patientTalk(sc, s, ctx.actor.id));
      if (s.patient.fainted) throw new Rejection("unsafe-position", "The patient is not well enough to walk.");
      if (retainedNeedles(s).length > 0) throw new Rejection("needles-retained", "The patient cannot walk with needles in place.");
      const seat = seatIn(sc, room.id, "seated");
      const dest = seat ? { area: seat.area, face: { x: (seat.area.minX + seat.area.maxX) / 2, z: (seat.area.minZ + seat.area.maxZ) / 2 } } : null;
      const plan = dest ? planWalk(w, ctx.actor.at, { kind: "near", area: dest.area, within: ARM_REACH_M, face: dest.face, what: `the ${seat!.label}` }) : planWalk(w, ctx.actor.at, { kind: "room", id: room.id });
      if (!plan.ok) throw new Rejection("no-route", `There is no way to the ${room.label}: ${plan.message}`);
      ctx.out.cost = walk(sc, s, ctx.actor.id, plan, { withPatient: true, attempt: index });
      placePatient(sc, s, room.id, seat, { x: plan.to.x, z: plan.to.z });
      ctx.out.target = room.id;
      ctx.out.detail = `to ${room.id} with the patient (${fmt(plan.metres)} m)`;
      observe(ctx, `You walk ${t(sc.case.patient.displayName, LOCALE)} to the ${room.label} (${fmt(plan.metres)} m)${seat ? `; they sit on the ${seat.label}` : ""}.`);
      // the patient walked and sat down: marks made lying down move with the skin, as for any change of position
      const arrived: Position = seat ? "seated" : "standing";
      if (s.patient.position !== arrived) setPatientPosition(ctx, arrived);
      return;
    }
    const target = walkTarget(sc, s, to);
    if (!target.ok) throw new Rejection(target.code, target.message);
    if ("region" in to) {
      // a body site: the region must be one the patient's position lets you reach at all
      const region = sc.bundle.regions.get(to.region)!;
      if (region.laterality === "bilateral" && to.side === "midline") throw new Rejection("invalid", `The ${region.title} is bilateral: say left or right.`);
      const access = regionAccess(region, to.side, s.patient.position);
      if (!access.accessible) throw new Rejection("not-accessible", `${access.reason}: reposition the patient first.`);
    }
    const plan = planWalk(w, ctx.actor.at, target.target);
    if (!plan.ok) throw new Rejection(plan.code === "unknown-target" ? "unknown-id" : "no-route", `You cannot get to ${target.label}: ${plan.message}`);
    ctx.out.cost = walk(sc, s, ctx.actor.id, plan, { attempt: index });
    const room = w.rooms.get(ctx.actor.location);
    ctx.out.target = "room" in to ? to.room : "fixture" in to ? to.fixture : "person" in to ? to.person : "region" in to ? `${to.region}:${to.side}` : null;
    ctx.out.detail = plan.metres > 0 ? `to ${target.label} (${fmt(plan.metres)} m)` : `already at ${target.label}`;
    observe(ctx, plan.metres > 0 ? `You walk ${fmt(plan.metres)} m to ${target.label}${room && !("room" in to) ? ` (${room.label})` : ""}.` : `You are already at ${target.label}.`);
  },
  hand_hygiene(ctx) {
    const { s, sc } = ctx;
    const station = atFixtureOfKind(sc, s, ctx.actor.id, "hand-hygiene", "hand-wash sink or hand-rub dispenser");
    if (!station.ok) throw new Rejection(station.code, station.message);
    if (ctx.actor.holding.some((o) => s.needles[o])) throw new Rejection("hands-full", "Put the needles down (dispose of them or leave them on the tray) first.");
    ctx.out.target = station.fixture.id;
    ctx.out.detail = `at the ${station.fixture.label}`;
    s.seq += 1;
    ctx.actor.hygieneSeq = s.seq;
    ctx.out.cost = 0.5;
  },
  fetch(ctx, a) {
    const { s, sc } = ctx;
    const pack = s.packs[a.item];
    const item = s.items[a.item];
    const at = pack ? pack.at : item?.at;
    if (!pack && !item) throw new Rejection("unknown-id", `There is no ${a.item} in this clinic.`);
    if (pack && !pack.sealed) throw new Rejection("already-open", `Pack ${a.item} has been opened: its needles are on the tray.`);
    const holder = pack ? pack.holder : item!.holder;
    if (holder === ctx.actor.id) {
      observe(ctx, `You already have ${a.item}.`);
      return;
    }
    if (holder) throw new Rejection("held", `${a.item} is with ${speakerLabel(sc, holder)}.`);
    need(atFixture(sc, s, ctx.actor.id, at ?? ""));
    if (pack) pack.holder = ctx.actor.id;
    else item!.holder = ctx.actor.id;
    ctx.actor.holding.push(a.item);
    if (pack?.expired) observe(ctx, `The label on ${a.item} shows its expiry date has passed.`);
    ctx.out.target = a.item;
    ctx.out.cost = 0.5;
  },
  pick_up(ctx, a) {
    const { s } = ctx;
    const n = s.needles[a.object];
    if (!n) {
      HANDLERS.fetch(ctx, { type: "fetch", item: a.object });
      return;
    }
    const loc = n.location;
    if (loc.kind === "tray") {
      // the tray is on the trolley or worktop the pack was opened at
      need(atFixture(ctx.sc, s, ctx.actor.id, s.packs[loc.packId]!.at));
    } else if (loc.kind === "floor") {
      if (loc.hidden) throw new Rejection("not-found", `You cannot see ${n.id}.`);
      // it lies where it fell: by the couch or chair the patient was on
      const w = clinicWorld(ctx.sc);
      const by = loc.near ? w.fixtures.get(loc.near) : undefined;
      const me = ctx.actor.at;
      const reachable = by ? distanceToArea(me.x, me.z, by.area) <= CONTACT_RANGE_M + 1e-6 && seesArea(w, me, by.area) : ctx.actor.location === s.patient.location;
      if (!reachable) throw new Rejection("not-in-reach", `${n.id} lies on the ${loc.area}${by ? ` by the ${by.label}` : ""}: go there to pick it up${by ? ` (move ${JSON.stringify({ to: { fixture: by.id } })})` : ""}.`);
    } else throw new Rejection("not-available", `${n.id} cannot be picked up (${loc.kind}).`);
    n.location = { kind: "hand", actor: ctx.actor.id };
    ctx.actor.holding.push(n.id);
    pushNeedleEvent(s, n.id, ctx.actor.id, "picked-up");
    ctx.out.target = n.id;
  },
  handover(ctx, a) {
    const { s, sc } = ctx;
    if (!ctx.actor.holding.includes(a.object)) throw new Rejection("not-holding", `You are not holding ${a.object}.`);
    const to = s.actors[a.to];
    if (!to) throw new Rejection("unknown-id", `${a.to} cannot take it.`);
    need(nearActor(sc, s, ctx.actor.id, a.to, speakerLabel(sc, a.to)));
    if (!checkPermission(sc, s, a.to, "handover").ok) throw new Rejection("not-authorised", `${speakerLabel(sc, a.to)} may not handle equipment.`);
    ctx.actor.holding = ctx.actor.holding.filter((o) => o !== a.object);
    to.holding.push(a.object);
    const n = s.needles[a.object];
    if (n) {
      n.location = { kind: "hand", actor: a.to };
      pushNeedleEvent(s, n.id, ctx.actor.id, "handed-over", `to ${a.to}`);
    }
    if (s.packs[a.object]) s.packs[a.object]!.holder = a.to;
    if (s.items[a.object]) s.items[a.object]!.holder = a.to;
    ctx.out.target = a.object;
    ctx.out.detail = `${a.object} → ${a.to}`;
  },
  open_pack(ctx, a) {
    const { s } = ctx;
    const pack = s.packs[a.packId];
    if (!pack) throw new Rejection("unknown-id", `There is no pack ${a.packId}.`);
    if (!pack.sealed) throw new Rejection("already-open", `Pack ${a.packId} is already open.`);
    const onShelf = pack.holder === null && fixtureReach(clinicWorld(ctx.sc), ctx.actor.at, pack.at)?.ok === true;
    if (pack.holder !== ctx.actor.id && !onShelf) throw new Rejection("not-holding", `Fetch pack ${a.packId} first.`);
    // a pack is opened onto a clean surface: the needle trolley by the couch, or a worktop
    const surface = atFixtureOfKind(ctx.sc, s, ctx.actor.id, "trolley", "needle trolley or worktop to open a pack onto");
    if (!surface.ok) throw new Rejection(surface.code, surface.message);
    const blockers: Protection[] = [];
    handHygieneRules(ctx, "open_pack", blockers);
    blockIf(ctx, blockers, "Pack not opened");
    pack.sealed = false;
    pack.openedBy = ctx.actor.id;
    pack.openedAt = now(s);
    pack.holder = null;
    pack.at = surface.fixture.id;
    ctx.actor.holding = ctx.actor.holding.filter((o) => o !== a.packId);
    for (const id of pack.needles) {
      const n = s.needles[id]!;
      n.location = { kind: "tray", packId: pack.id };
      if (pack.expired) {
        n.contaminated = true;
        n.contamination.push("expired pack: sterility not assured");
      }
      pushNeedleEvent(s, id, ctx.actor.id, "pack-opened");
    }
    const spec = s.needles[pack.needles[0]!]!.spec;
    observe(ctx, `Opened ${pack.id} onto the ${surface.fixture.label}: ${pack.needles.length} needle(s) ${spec.diameterMm} × ${spec.lengthMm} mm, ${spec.singleUse ? "single-use" : "reusable"}, ${spec.sterile ? "sterile" : "non-sterile"}${pack.expired ? " — past its expiry date" : ""}: ${pack.needles.join(", ")}.`);
    ctx.out.target = pack.id;
    ctx.out.cost = 0.5;
  },
  prepare_couch(ctx) {
    const { s, sc } = ctx;
    // a couch is made up from beside it: the one within reach
    const at = atFixtureOfKind(sc, s, ctx.actor.id, "couch", "treatment couch");
    if (!at.ok) throw new Rejection(at.hint ? at.code : "no-couch", at.message);
    const room = sc.clinic.rooms.find((r) => r.id === at.fixture.room)!;
    const couch = s.couches[room.id];
    if (!couch) throw new Rejection("no-couch", `There is no treatment couch in the ${room.label}.`);
    if (s.patient.location === room.id && !["standing", "seated", "seated-forward"].includes(s.patient.position)) throw new Rejection("occupied", "The patient is lying on the couch.");
    couch.prepared = { at: now(s), by: ctx.actor.id, done: ["surface-cleaned", "linen-changed"] };
    soil(s, ctx.actor);
    observe(ctx, `Couch in the ${room.label}: surface cleaned and fresh linen on.`);
    ctx.out.target = `couch:${room.id}`;
    ctx.out.cost = 2;
  },
  prepare_site(ctx, a) {
    const { s } = ctx;
    regionFrame(ctx, a.region, a.side);
    atSite(ctx, a.region, a.side);
    const blockers: Protection[] = [];
    handHygieneRules(ctx, "prepare_site", blockers);
    blockIf(ctx, blockers, "Site not prepared");
    s.sitesPrepared.push({ visit: visitIndex(s), region: a.region, side: a.side, at: now(s), by: ctx.actor.id, touched: null });
    ctx.out.target = `${a.region}:${a.side}`;
    ctx.out.cost = 0.5;
  },
  insert_needle(ctx, a) {
    const { s, sc } = ctx;
    const n = s.needles[a.needleId];
    if (!n) throw new Rejection("unknown-id", `There is no needle ${a.needleId}.`);
    if (n.location.kind !== "hand" || n.location.actor !== ctx.actor.id) throw new Rejection("not-holding", `You are not holding ${a.needleId}: pick it up from the tray first.`);
    let region: string;
    let side: Side;
    let entry: ChartPoint;
    let target: PointRef | null = a.target ?? null;
    if (target && "point" in target) {
      const def = sc.bundle.acupoints.get(target.point);
      if (!def) throw new Rejection("unknown-id", `Unknown point ${target.point}.`);
      requireSite(def, target);
    }
    let markId: string | null = null;
    let markStale = false;
    if (a.mark) {
      const m = s.marks[a.mark];
      if (!m || m.visit !== visitIndex(s)) throw new Rejection("unknown-id", `There is no mark ${a.mark} in this visit.`);
      ({ region, side } = m);
      entry = m.position;
      target = m.target;
      markId = m.id;
      markStale = m.stale;
      if (m.stale) observe(ctx, `Mark ${m.id} was made with the patient in another position.`);
    } else {
      if (!a.region || !a.side || !a.at) throw new Rejection("invalid", "Give a mark, or the region, side and chart position.");
      region = a.region;
      side = a.side;
      entry = a.at;
    }
    const frame = regionFrame(ctx, region, side);
    if (!frame.inChart(entry)) throw new Rejection("off-chart", `${at2(entry)} is outside the ${frame.region.title} chart.`);
    atSite(ctx, region, side);
    const blockers: Protection[] = [];
    if (s.patient.fainted) {
      addUnsafe(ctx, "continued-after-adverse-event");
      blockers.push({ by: "simulation-guard", kind: "guard", reason: "the patient is unwell: attend to them" });
    }
    // what the needle is for: the target the operator named (or marked) — shown back to them — and the point the entry
    // actually lies on, judged against this patient's hidden anatomy, which the evaluator and the rules use
    const plan = currentPlan(s);
    const claimed = target;
    const nearest = anatomicalTarget(sc, frame, region, side, entry, plan);
    target = claimed && claimHolds(sc, frame, claimed, region, side, entry) ? claimed : nearest;
    const rules = rulesInForce(sc, s, ctx.actor.id);
    // consent
    if (s.patient.consent.status === "withdrawn") {
      addUnsafe(ctx, "insertion-after-consent-withdrawn");
      blockers.push({ by: "simulation-guard", kind: "guard", reason: "the patient has withdrawn consent" });
    } else if (!consentCovers(s)) {
      addUnsafe(ctx, "insertion-without-consent");
      for (const r of rulesOfKind(rules, "consent-before-treatment")) {
        ctx.out.violations.push(violation(r, "needle inserted without consent to the current plan", "insertion-without-consent"));
        if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: obtain consent first` });
      }
    }
    if (!target || !planIncludes(plan, target)) addUnsafe(ctx, "insertion-outside-plan");
    if (s.stopped && s.stopped.visit === visitIndex(s)) addUnsafe(ctx, "continued-after-adverse-event");
    // the needle itself
    if (n.used) {
      addUnsafe(ctx, "needle-reuse");
      blockers.push({ by: "simulation-guard", kind: "guard", reason: `${n.id} has been used: a single-use needle is never reinserted` });
    }
    const nonSterile = n.contaminated || !n.spec.sterile || !n.spec.singleUse;
    if (nonSterile) {
      addUnsafe(ctx, "non-sterile-needle");
      for (const r of rulesOfKind(rules, "single-use-sterile-needle")) {
        ctx.out.violations.push(violation(r, `${n.id}: ${n.contamination.join("; ") || "not a sterile single-use needle"}`, "non-sterile-needle"));
        if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: ${n.id} is not sterile` });
      }
    }
    handHygieneRules(ctx, "insert_needle", blockers);
    for (const r of rulesOfKind(rules, "site-preparation-before-insertion")) {
      const prepared = s.sitesPrepared.filter((p) => p.visit === visitIndex(s) && p.region === region && p.side === side);
      if (prepared.some((p) => p.touched === null)) continue;
      const touched = prepared.find((p) => p.touched);
      ctx.out.violations.push(violation(r, touched ? `${region} (${side}) touched after cleaning (${touched.touched!.how}): not prepared` : `${region} (${side}) not prepared`, "site-not-prepared"));
      addUnsafe(ctx, "site-not-prepared");
      if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: prepare the site first` });
    }
    // the site and the point
    for (const c of sc.field.patient.siteConditions) {
      if (c.region !== region || c.kind !== "avoid") continue;
      if (frame.region.laterality === "bilateral" && c.side !== side) continue;
      if (c.centre && Math.hypot(c.centre.u - entry.u, c.centre.v - entry.v) > (c.radiusCm ?? 0)) continue;
      addUnsafe(ctx, "insertion-on-avoided-site");
    }
    // a cautioned point is cautioned wherever the needle went for it: judged by where the entry is, not by its name
    if (cautionedAt(sc, frame, region, side, entry) || (target && "point" in target && sc.bundle.acupoints.get(target.point)?.cautions.some((cv) => sc.field.patient.riskFactors.includes(cv.when)))) {
      addUnsafe(ctx, "insertion-at-cautioned-point");
    }
    for (const r of rulesOfKind(rules, "avoid-regions")) {
      const { riskFactor, regions, fromGestationWeek } = r.rule.check;
      const pt = sc.field.patient;
      if (!regions.includes(region) || !pt.riskFactors.includes(riskFactor)) continue;
      if (fromGestationWeek !== undefined && (pt.gestationWeeks ?? Infinity) < fromGestationWeek) continue;
      ctx.out.violations.push(violation(r, `needle in the ${frame.region.title} (${riskFactor})`, "insertion-in-avoided-region"));
      addUnsafe(ctx, "insertion-in-avoided-region");
      if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}` });
    }
    const path = doInsertCheckPath(ctx, n, frame, entry, a.angleDeg, a.azimuthDeg, a.depthCm, blockers);
    blockIf(ctx, blockers, `Insertion of ${n.id} stopped`);
    // execute
    const monitorTask = Object.values(s.tasks).find((tk) => tk.kind === "monitor-patient" && tk.status === "acknowledged");
    n.location = { kind: "patient", region, side, entry, depthCm: path.executedDepthCm, angleDeg: a.angleDeg, azimuthDeg: a.azimuthDeg, target: claimed, mark: markId };
    n.used = true;
    n.insertedBy = ctx.actor.id;
    n.observer = monitorTask?.assignee ?? ctx.actor.id;
    n.insertion = {
      at: now(s),
      visit: visitIndex(s),
      region,
      side,
      configuration: frame.configuration,
      patientPosition: s.patient.position,
      entry,
      intended: claimed ?? null,
      nearest,
      target,
      mark: markId,
      markStale,
      requestedDepthCm: a.depthCm,
      depthCm: path.executedDepthCm,
      angleDeg: a.angleDeg,
      azimuthDeg: a.azimuthDeg,
      tipTissue: path.tipTissue,
      findings: insertionFindings(path),
    };
    ctx.actor.holding = ctx.actor.holding.filter((o) => o !== n.id);
    pushNeedleEvent(s, n.id, ctx.actor.id, "inserted", claimed ? refKey(claimed) : undefined);
    // the field's own account of how the tissue answers: nobody is told until they ask the patient or work the needle
    n.response = needleResponse(sc, s, n, path, "insertion");
    consequences(ctx, n, path);
    ctx.out.target = `needle:${n.id}`;
    ctx.out.detail = `${n.id} at ${claimed ? pointLabel(sc, claimed) : `${region} ${side}`} (${at2(entry)}), ${fmt(path.executedDepthCm)} cm${path.executedDepthCm + 1e-9 < a.depthCm ? ` of ${fmt(a.depthCm)} cm requested (${path.stoppedBy})` : ""}`;
    observe(ctx, `Inserted ${ctx.out.detail}.`);
    ctx.out.cost = 0.5;
  },
  adjust_needle(ctx, a) {
    const { s, sc } = ctx;
    const n = s.needles[a.needleId];
    if (!n || n.location.kind !== "patient") throw new Rejection("not-inserted", `${a.needleId} is not in the patient.`);
    const loc = n.location;
    atSite(ctx, loc.region, loc.side);
    const blockers: Protection[] = [];
    if (s.patient.fainted) {
      addUnsafe(ctx, "continued-after-adverse-event");
      blockers.push({ by: "simulation-guard", kind: "guard", reason: "the patient is unwell: attend to them" });
    }
    if (s.patient.consent.status === "withdrawn") {
      addUnsafe(ctx, "insertion-after-consent-withdrawn");
      blockers.push({ by: "simulation-guard", kind: "guard", reason: "the patient has withdrawn consent: remove the needles" });
    }
    if (s.stopped && s.stopped.visit === visitIndex(s)) addUnsafe(ctx, "continued-after-adverse-event");
    const frame = regionFrame(ctx, loc.region, loc.side);
    const depth = a.depthCm ?? loc.depthCm;
    const path = doInsertCheckPath(ctx, n, frame, loc.entry, loc.angleDeg, loc.azimuthDeg, depth, blockers);
    blockIf(ctx, blockers, `Adjustment of ${n.id} stopped`);
    loc.depthCm = path.executedDepthCm;
    if (n.insertion) {
      n.insertion.depthCm = path.executedDepthCm;
      n.insertion.tipTissue = path.tipTissue;
      n.insertion.findings = insertionFindings(path);
    }
    pushNeedleEvent(s, n.id, ctx.actor.id, "adjusted", `${fmt(path.executedDepthCm)} cm, ${a.technique}`);
    const before = n.response;
    n.response = needleResponse(sc, s, n, path, a.technique === "none" ? null : a.technique);
    consequences(ctx, n, path);
    if (a.technique !== "none") {
      // working the needle tells the operator how the tissue holds it: evidence of this needle's response
      const feel = describeGrasp(n.response, a.technique);
      const e = addEvidence(s, { kind: "needle-feel", ref: n.id, by: ctx.actor.id, text: feel.text, needle: { id: n.id, qualities: [], grasp: feel.grasp, volunteered: false } });
      observe(ctx, `${feel.text} (evidence ${e.id})`);
      if (n.response.overstimulated && !before?.overstimulated) volunteer(ctx, n, "too-strong", "That's too strong now — it's getting painful.", ["sharp-pain"]);
      else if (n.response.deqi && n.response.intensity >= STRONG_RESPONSE) {
        // a strong response is spoken of unasked
        const said = describeSensation(n.response);
        volunteer(ctx, n, "deqi", `Oh — ${said.text.charAt(0).toLowerCase()}${said.text.slice(1)}`, said.qualities);
      }
    }
    ctx.out.target = `needle:${n.id}`;
    ctx.out.detail = `${n.id} to ${fmt(path.executedDepthCm)} cm (${a.technique})`;
    ctx.out.cost = 0.5;
  },
  check_sensation(ctx, a) {
    const { s } = ctx;
    const n = s.needles[a.needleId];
    if (!n) throw new Rejection("unknown-id", `There is no needle ${a.needleId}.`);
    // a needle that fell out unseen can still be asked about: the patient feels nothing there
    if (n.location.kind !== "patient" && !fellUnseen(n)) throw new Rejection("not-inserted", `${a.needleId} is not in the patient: there is nothing to feel at it.`);
    inEarshot(ctx);
    ctx.out.target = `needle:${n.id}`;
    ctx.out.cost = 0.25;
    if (s.patient.fainted) {
      observe(ctx, "The patient is too faint to answer.");
      ctx.out.detail = "no answer";
      return;
    }
    askSensation(ctx, n);
    ctx.out.detail = `asked what they feel at ${n.id}`;
  },
  monitor(ctx) {
    const { s, sc } = ctx;
    inSight(ctx);
    const mine = Object.values(s.tasks).find((tk) => tk.assignee === ctx.actor.id && tk.kind === "monitor-patient" && tk.status === "acknowledged");
    const last = Math.max(-Infinity, ...s.monitorLog.filter((m) => m.by === ctx.actor.id).map((m) => m.at));
    s.monitorLog.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, taskId: mine?.id ?? null });
    const retained = retainedNeedles(s);
    observe(ctx, retained.length > 0 ? `${retained.length} needle(s) in place: ${retained.map((n) => (n.location.kind === "patient" && n.location.target ? `${n.id} ${pointLabel(sc, n.location.target)}` : n.id)).join("; ")}.` : "No needles in place.");
    if (s.patient.fainted) observe(ctx, "The patient is pale, clammy and sweaty, and says they feel faint.");
    else if (s.patient.anxiety >= 0.6) observe(ctx, "The patient looks tense.");
    else observe(ctx, "The patient looks comfortable.");
    const recent = s.patient.feedback.filter((f) => f.at > last);
    for (const f of recent) observe(ctx, `Reported (${fmt(f.at)} min): ${f.kind.replace(/-/g, " ")} — "${f.text}"`);
    for (const n of needleList(s).filter((x) => x.bleeding)) observe(ctx, `Bleeding at the site of ${n.id}.`);
    ctx.out.cost = 0.5;
  },
  wait(ctx, a) {
    const r = spend(ctx, a.minutes, { stopOnInterrupt: true });
    ctx.out.interrupted.push(...r.interrupted);
    if (r.interrupted.length > 0) {
      ctx.out.status = "partial";
      ctx.out.detail = `waited ${fmt(r.spent)} of ${a.minutes} min: interrupted`;
    } else ctx.out.detail = `waited ${a.minutes} min`;
  },
  stop_treatment(ctx, a) {
    const { s } = ctx;
    s.stopped = { visit: visitIndex(s), at: now(s), by: ctx.actor.id, reason: a.reason };
    observe(ctx, `Treatment stopped: ${a.reason}. ${retainedNeedles(s).length} needle(s) still to remove.`);
  },
  remove_needle(ctx, a) {
    const loc = ctx.s.needles[a.needleId]?.location;
    if (loc?.kind === "patient") atSite(ctx, loc.region, loc.side);
    doRemove(ctx, a.needleId);
    ctx.out.target = `needle:${a.needleId}`;
    ctx.out.cost = 0.25;
  },
  remove_all_needles(ctx) {
    const { s, sc } = ctx;
    atSide(ctx, "take the needles out");
    const order = insertionOrder(s).filter((o) => o.needle.location.kind === "patient").map((o) => o.needle.id);
    if (order.length === 0) {
      observe(ctx, "No needles in place.");
      return;
    }
    const w = clinicWorld(sc);
    for (const id of order) {
      const loc = s.needles[id]!.location;
      if (loc.kind !== "patient") continue; // it fell out or broke while the others came out
      // the compound action walks round the couch as it goes: a needle on the far side is out of reach from here
      let steps = 0;
      if (!siteReach(sc, s, ctx.actor.id, loc.region, loc.side).ok) {
        const site = siteOf(sc, s, loc.region, loc.side);
        const plan = planWalk(w, ctx.actor.at, { kind: "near", area: site.area, within: ARM_REACH_M, face: site.point, what: `the ${site.label}` });
        if (!plan.ok) throw new Rejection("no-route", `You cannot get to the ${site.label}: ${plan.message}`);
        steps = walk(sc, s, ctx.actor.id, plan, { attempt: s.attempts.length - 1 });
      }
      doRemove(ctx, id);
      const r = spend(ctx, 0.25 + steps, { stopOnInterrupt: true });
      if (r.interrupted.length > 0) {
        ctx.out.interrupted.push(...r.interrupted);
        if (retainedNeedles(s).length > 0) {
          ctx.out.status = "partial";
          observe(ctx, `Interrupted after ${ctx.out.steps.length} of ${order.length} removals; ${retainedNeedles(s).length} still in place.`);
          break;
        }
      }
    }
    ctx.out.detail = `${ctx.out.steps.length} of ${order.length} withdrawn`;
  },
  apply_pressure(ctx, a) {
    const { s } = ctx;
    const n = s.needles[a.needleId];
    if (!n) throw new Rejection("unknown-id", `There is no needle ${a.needleId}.`);
    if (n.location.kind === "patient") throw new Rejection("not-withdrawn", `${n.id} is still in place.`);
    if (n.insertion) atSite(ctx, n.insertion.region, n.insertion.side);
    else atSide(ctx, "apply pressure");
    if (!n.bleeding) observe(ctx, `No bleeding at the site of ${n.id}.`);
    else {
      n.bleeding = false;
      pushNeedleEvent(s, n.id, ctx.actor.id, "pressure");
      observe(ctx, `Pressure applied at the site of ${n.id}: the bleeding has stopped.`);
    }
    soil(s, ctx.actor);
    ctx.out.target = `needle:${n.id}`;
    ctx.out.cost = 1;
  },
  count_needles(ctx) {
    const { s } = ctx;
    const opened = openedNeedles(s);
    const by = (k: string) => opened.filter((n) => n.location.kind === k).length;
    const found = opened.filter((n) => n.location.kind === "floor" && !n.location.hidden);
    const visibleFloor = found.length;
    const foundAreas = [...new Set(found.map((n) => (n.location.kind === "floor" ? n.location.area : "")))].join(" and ");
    const reported = opened.filter((n) => (n.location.kind === "broken-in-patient" || (n.location.kind === "floor" && n.location.hidden)) && n.resolution !== null).length;
    const retained = by("patient");
    const inHand = by("hand");
    const onTray = by("tray");
    const disposed = by("sharps");
    const unaccounted = opened.length - retained - inHand - onTray - disposed - visibleFloor - reported;
    // a count is made where the needles are: in the patient's room with them in sight while any are in place, and in
    // the room of every tray holding some (a pack lies on a fixture: its room is the fixture's)
    const w = clinicWorld(ctx.sc);
    const here = ctx.actor.location;
    const trayHere = (p: EncounterState["packs"][string]) => (w.fixtures.get(p.at)?.room ?? p.at) === here;
    const withPatient = s.patient.location === here && patientSight(ctx.sc, s, ctx.actor.id).ok;
    const present = (retained === 0 || withPatient) && Object.values(s.packs).every((p) => p.sealed || trayHere(p) || !p.needles.some((id) => s.needles[id]?.location.kind === "tray"));
    s.counts.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, opened: opened.length, retained, inHand, onTray, disposed, unaccounted, reconciled: present && unaccounted === 0, method: present ? "observed" : "read", reportedBy: null });
    if (!present) {
      observe(ctx, `You are not where the needles are: this is the record (${retained} in the patient, ${onTray} on the tray, ${disposed} in the sharps container), not a count. Count at the bedside, or ask a colleague who is there.`);
      ctx.out.detail = "record read, not verified";
      ctx.out.cost = 0.5;
      return;
    }
    observe(ctx, `Needle count: ${opened.length} opened — ${retained} in the patient, ${inHand} in hand, ${onTray} on the tray, ${visibleFloor > 0 ? `${visibleFloor} found on the ${foundAreas} (to dispose of), ` : ""}${reported > 0 ? `${reported} lost or broken and reported, ` : ""}${disposed} in the sharps container${unaccounted > 0 ? `; ${unaccounted} NOT ACCOUNTED FOR` : "; all accounted for"}.`);
    ctx.out.detail = unaccounted > 0 ? `${unaccounted} unaccounted` : "reconciled";
    ctx.out.cost = 0.5;
  },
  dispose(ctx, a) {
    const { s, sc } = ctx;
    const sharps = atFixtureOfKind(sc, s, ctx.actor.id, "sharps-container", "sharps container");
    if (!sharps.ok) throw new Rejection(sharps.code, sharps.message);
    const container = sharps.fixture;
    const w = clinicWorld(sc);
    const targets: NeedleState[] = [];
    const n = s.needles[a.object];
    if (n) {
      if (n.location.kind !== "hand" || n.location.actor !== ctx.actor.id) throw new Rejection("not-holding", `You are not holding ${n.id}.`);
      targets.push(n);
    } else if (s.packs[a.object]) {
      for (const id of s.packs[a.object]!.needles) {
        const x = s.needles[id]!;
        if ((x.location.kind === "tray" && fixtureReach(w, ctx.actor.at, s.packs[a.object]!.at)?.ok === true) || (x.location.kind === "hand" && x.location.actor === ctx.actor.id)) targets.push(x);
      }
      if (targets.length === 0) throw new Rejection("nothing-to-dispose", `Nothing from ${a.object} to dispose of here.`);
    } else throw new Rejection("unknown-id", `There is no ${a.object}.`);
    for (const x of targets) {
      x.location = { kind: "sharps", container: container.id };
      ctx.actor.holding = ctx.actor.holding.filter((o) => o !== x.id);
      pushNeedleEvent(s, x.id, ctx.actor.id, "disposed", container.id);
      ctx.out.steps.push(`${x.id} → ${container.id}`);
    }
    soil(s, ctx.actor);
    ctx.out.target = a.object;
    ctx.out.cost = 0.25;
  },
  search(ctx, a) {
    const { s, sc } = ctx;
    atSide(ctx, "search there");
    const found: string[] = [];
    for (const n of needleList(s)) {
      if (n.location.kind === "floor" && n.location.hidden && (n.location.area === a.area || (a.area === "floor" && n.location.area === "couch"))) {
        n.location = { ...n.location, hidden: false };
        pushNeedleEvent(s, n.id, ctx.actor.id, "found", a.area);
        found.push(n.id);
        observe(ctx, `Found ${n.id} (${n.location.area}): it fell out and is contaminated.`);
      }
      if (a.area === "patient" && n.location.kind === "broken-in-patient") observe(ctx, `A broken needle fragment (${n.id}) is at the ${n.location.side} ${n.location.region}, ${at2(n.location.entry)}.`);
    }
    if (a.area === "patient") for (const n of retainedNeedles(s)) observe(ctx, `${n.id} is in place${n.location.kind === "patient" && n.location.target ? ` at ${pointLabel(sc, n.location.target)}` : ""}.`);
    if (found.length === 0 && a.area !== "patient") observe(ctx, `Nothing found (${a.area}).`);
    ctx.out.detail = `searched ${a.area}${found.length ? `: found ${found.join(", ")}` : ""}`;
    ctx.out.cost = 1;
  },
  report_incident(ctx, a) {
    const { s } = ctx;
    s.incidents.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, kind: a.kind, needleId: a.needleId ?? null, description: a.description });
    if (a.kind === "lost-needle") {
      for (const n of needleList(s)) {
        if (n.location.kind === "floor" && n.location.hidden && (a.needleId === undefined || a.needleId === n.id)) {
          const lostAt = [...n.events].reverse().find((e) => e.what === "dropped")?.at ?? 0;
          const searched = s.attempts.some((x) => x.request.action.type === "search" && x.status === "executed" && x.at >= lostAt && ["floor", "couch"].includes((x.request.action as { area: string }).area));
          n.resolution = searched ? "searched for, not found: reported as lost" : null;
          if (!searched) observe(ctx, `Reported — but no search has been made for ${n.id} yet.`);
        }
      }
    }
    resolveBroken(s);
    observe(ctx, `Incident recorded (${a.kind}).`);
    ctx.out.cost = 2;
  },
  document(ctx, a) {
    const { s, sc } = ctx;
    // a recorded needle response is a conclusion about one needle: it names evidence, of that needle, that was obtained
    const seenNeedles = new Set<string>();
    for (const r of a.record.needling?.responses ?? []) {
      const n = s.needles[r.needle];
      if (!n?.insertion || n.insertion.visit !== visitIndex(s)) throw new Rejection("unknown-id", `No needle ${r.needle} was inserted in this visit.`);
      if (seenNeedles.has(r.needle)) throw new Rejection("invalid", `${r.needle} is recorded twice: one response for each needle.`);
      seenNeedles.add(r.needle);
      for (const id of r.evidence) {
        const e = evidenceById(s, id);
        if (!e) throw new Rejection("evidence-not-obtained", `Not in the evidence obtained in this encounter: ${id}. A needle's response rests on what the patient said they felt there (check_sensation) or on what you felt on working it.`);
        if (e.needle?.id !== r.needle) throw new Rejection("evidence-mismatch", `${id} is not evidence of ${r.needle}${e.needle ? `: it is about ${e.needle.id}` : ""}. Each needle's response rests on evidence of that needle.`);
      }
      if (r.response === "not-sought") {
        if (r.evidence.length > 0) throw new Rejection("invalid", `${r.needle}: a response that was not sought cites no evidence — record deqi or none on what you observed.`);
      } else if (r.evidence.length === 0) {
        const have = needleEvidence(s, r.needle).map((e) => e.id);
        throw new Rejection("no-evidence", `${r.needle}: a recorded response (${r.response}) names the evidence it rests on${have.length > 0 ? ` — of this needle you have ${have.join(", ")}` : " — nothing has been observed at this needle: ask the patient (check_sensation), or record not-sought"}.`);
      }
    }
    // what a record says was obtained is a claim like any spoken one: kept, and checked against the evidence
    if (a.record.response) {
      for (const claim of detectClaims(a.record.response).filter((c) => c === "deqi-obtained")) {
        const supported = checkClaim(ctx, claim);
        s.claims.push({ at: now(s), by: ctx.actor.id, text: a.record.response, claim, supported });
        ctx.out.steps.push(`claim ${claim}: ${supported ? "matches the evidence" : "not supported by the evidence"}`);
      }
    }
    void sc;
    s.documents.push({ visit: visitIndex(s), at: now(s), by: ctx.actor.id, record: a.record });
    ctx.out.detail = `documented: ${Object.keys(a.record).join(", ")}`;
    ctx.out.cost = 2;
  },
  end_visit(ctx) {
    const { s, sc } = ctx;
    const visit = currentVisit(s);
    if (visit.ended) throw new Rejection("visit-ended", "This visit has already ended.");
    const retained = retainedNeedles(s);
    if (retained.length > 0) throw new Rejection("needles-retained", `${retained.length} needle(s) are still in the patient: ${retained.map((n) => n.id).join(", ")}.`);
    const unresolved = unresolvedNeedles(s);
    if (unresolved.length > 0) {
      const state = (n: NeedleState) => (n.location.kind === "floor" ? (n.location.hidden ? "unaccounted" : `found on the ${n.location.area}: pick it up and dispose of it`) : n.location.kind);
      throw new Rejection("needles-unresolved", `Not resolved: ${unresolved.map((n) => `${n.id} (${state(n)})`).join(", ")}. Count, search, dispose of, or report every opened needle.`);
    }
    const rules = rulesInForce(sc, s, ctx.actor.id);
    const blockers: Protection[] = [];
    const opened = openedNeedles(s).some((n) => n.events.some((e) => e.at >= visit.startedAt));
    if (opened) {
      const lastNeedle = Math.max(-1, ...needleList(s).flatMap((n) => n.events.filter((e) => e.what !== "found").map((e) => e.at)));
      const counted = s.counts.some((c) => c.visit === visit.index && c.reconciled && c.at >= lastNeedle);
      for (const r of rulesOfKind(rules, "needle-count-before-completion")) {
        if (counted) continue;
        ctx.out.violations.push(violation(r, "no reconciled needle count after the last needle was handled", null));
        if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: count the needles` });
      }
      for (const r of rulesOfKind(rules, "patient-monitoring")) {
        const gap = longestUnobservedGap(s, visit.startedAt, now(s), s.monitorLog.filter((m) => m.visit === visit.index).map((m) => m.at));
        if (gap > r.rule.check.maxGapMinutes) ctx.out.violations.push(violation(r, `${fmt(gap)} min with needles in place and nobody observing the patient`, null));
      }
    }
    const treated = needleList(s).some((n) => n.insertion !== null && n.insertion.visit === visit.index);
    for (const r of rulesOfKind(rules, "treatment-record")) {
      if (!treated) continue;
      const docs = s.documents.filter((d) => d.visit === visit.index).map((d) => d.record as Record<string, unknown>);
      const missing = r.rule.check.fields.filter((f) => !docs.some((d) => d[f] !== undefined && d[f] !== ""));
      if (missing.length > 0) {
        ctx.out.violations.push(violation(r, `treatment record lacks: ${missing.join(", ")}`, null));
        if (r.rule.enforcement === "block") blockers.push({ by: r.ruleSet.id, kind: "rule", reason: `${r.rule.title}: record ${missing.join(", ")}` });
      }
    }
    blockIf(ctx, blockers, "The visit cannot end yet");
    for (const task of Object.values(s.tasks)) {
      if (task.status !== "acknowledged" && task.status !== "assigned") continue;
      if (task.source === "statement") {
        task.unmet = taskUnmet(sc, s, task, s.patient.feedback.filter((f) => f.abnormal).map((f) => f.kind));
        task.status = task.unmet.length === 0 ? "completed" : "incomplete";
      } else task.status = "cancelled";
    }
    visit.ended = true;
    visit.endedAt = now(s);
    setClinicalFlag(sc, s, `acu.visit-${visit.index}-ended`, true);
    observe(ctx, `Visit ${visit.index} ended${ctx.out.violations.length ? ` with ${ctx.out.violations.length} rule finding(s)` : ""}.`);
  },
  begin_follow_up(ctx) {
    const { s, sc } = ctx;
    const visit = currentVisit(s);
    if (!visit.ended) throw new Rejection("visit-open", "End the current visit first.");
    const next = sc.field.visits.find((v) => v.index === visit.index + 1);
    if (!next) throw new Rejection("no-follow-up", "No follow-up visit is scheduled in this scenario.");
    s.visits.push({ index: next.index, phase: next.phase, date: next.date, startedAt: now(s), ended: false, endedAt: null });
    enterPhase(sc, s, next.phase, next.index);
    s.patient.position = sc.field.patient.position;
    s.patient.consent = { status: "none", planVersion: null, at: null, topics: [] };
    s.patient.fainted = false;
    s.patient.recoverySince = null;
    placeEveryone(sc, s);
    for (const m of sc.field.cast) {
      const a = s.actors[m.id]!;
      a.hygieneSeq = null;
      a.soiledSeq = null;
      a.holding = a.holding.filter((o) => s.needles[o] || s.packs[o]);
    }
    for (const item of Object.values(s.items)) {
      if (item.holder) item.holder = null;
    }
    const phase = sc.case.phases.find((p) => p.id === next.phase);
    observe(ctx, `${next.label} (${next.date}).${phase?.description ? ` ${t(phase.description, LOCALE)}` : ""}`);
  },
  finish_encounter(ctx) {
    const { s, sc } = ctx;
    if (!currentVisit(s).ended) throw new Rejection("visit-open", "End the visit first (end_visit): it checks that every needle is accounted for.");
    s.finished = true;
    s.finishedAt = now(s);
    setClinicalFlag(sc, s, "acu.finished", true);
    clin(sc, s, { type: "finish", by: "system" });
    observe(ctx, "Encounter finished.");
  },
  assign_task(ctx, a) {
    const { s, sc } = ctx;
    const to = s.actors[a.to];
    if (!to || a.to === ctx.actor.id) throw new Rejection("unknown-id", `${a.to} cannot be assigned a task.`);
    if (!roleAccepts(roleOf(sc, a.to), a.kind)) throw new Rejection("not-within-role", `${speakerLabel(sc, a.to)} (${roleOf(sc, a.to)?.label}) cannot be asked to ${a.kind.replace(/-/g, " ")}.`);
    if (a.kind === "position-patient" && !PositionSchema.safeParse(a.params.position).success) throw new Rejection("invalid", `Say which position (params.position): one of ${PositionSchema.options.join(", ")}.`);
    if (a.kind === "monitor-patient" && a.params.intervalMinutes !== undefined && !(Number(a.params.intervalMinutes) > 0)) throw new Rejection("invalid", "params.intervalMinutes must be a positive number of minutes.");
    if (a.kind === "fetch" && typeof a.params.item !== "string") throw new Rejection("invalid", "Say what to fetch (params.item).");
    const task = makeTask(ctx, a.to, a.kind, a.params, "assignment", a.note);
    utter(s, ctx.actor.id, a.to, a.note ?? `Please ${a.kind.replace(/-/g, " ")}${Object.keys(a.params).length ? ` (${Object.entries(a.params).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}.`, "speech");
    ctx.out.target = task.id;
    ctx.out.detail = `${task.id}: ${a.kind} → ${a.to}`;
    ctx.out.cost = 0.25;
  },
  acknowledge_task(ctx, a) {
    const { s } = ctx;
    const task = s.tasks[a.taskId];
    if (!task || task.assignee !== ctx.actor.id) throw new Rejection("unknown-id", `No task ${a.taskId} for you.`);
    if (task.status !== "assigned") throw new Rejection("invalid", `Task ${a.taskId} is ${task.status}.`);
    task.status = "acknowledged";
    task.acknowledgedAt = now(s);
    utter(s, ctx.actor.id, task.assignedBy, "Okay, will do.", "speech");
    ctx.out.target = task.id;
  },
  decline_task(ctx, a) {
    const { s } = ctx;
    const task = s.tasks[a.taskId];
    if (!task || task.assignee !== ctx.actor.id || task.status !== "assigned") throw new Rejection("invalid", `Task ${a.taskId} cannot be declined.`);
    task.status = "declined";
    utter(s, ctx.actor.id, task.assignedBy, `I can't do that: ${a.reason}`, "speech");
    ctx.out.target = task.id;
  },
  report_task(ctx, a) {
    const { s, sc } = ctx;
    const task = s.tasks[a.taskId];
    if (!task || task.assignee !== ctx.actor.id) throw new Rejection("unknown-id", `No task ${a.taskId} for you.`);
    if (task.status !== "acknowledged") throw new Rejection("invalid", `Task ${a.taskId} is ${task.status}${task.status === "assigned" ? ": acknowledge it first" : ""}.`);
    task.unmet = taskUnmet(sc, s, task, a.findings);
    task.status = task.unmet.length === 0 ? "completed" : "incomplete";
    task.reportedAt = now(s);
    task.report = { summary: a.summary, findings: a.findings };
    utter(s, ctx.actor.id, task.assignedBy, a.summary, "speech");
    // a colleague's count, made at the bedside, is received as theirs
    const counted = task.kind === "count-needles" ? [...s.counts].reverse().find((c) => c.by === ctx.actor.id && c.method === "observed" && c.at >= (task.acknowledgedAt ?? task.assignedAt)) : undefined;
    if (counted) s.counts.push({ ...counted, at: now(s), by: task.assignedBy, method: "reported", reportedBy: ctx.actor.id });
    ctx.out.target = task.id;
    ctx.out.detail = task.status === "completed" ? "reported: complete" : `reported, but: ${task.unmet.join("; ")}`;
  },
  cancel_task(ctx, a) {
    const { s } = ctx;
    const task = s.tasks[a.taskId];
    if (!task || task.assignedBy !== ctx.actor.id || !["assigned", "acknowledged"].includes(task.status)) throw new Rejection("invalid", `Task ${a.taskId} cannot be cancelled.`);
    task.status = "cancelled";
    ctx.out.target = task.id;
  },
  approve_plan(ctx) {
    const { s } = ctx;
    const plan = currentPlan(s);
    if (!plan) throw new Rejection("no-plan", "There is no plan to approve.");
    s.planApproved = plan.version;
    ctx.out.target = `plan:v${plan.version}`;
  },
};

/** A broken needle's response: an incident report and a referral. */
function resolveBroken(s: EncounterState): void {
  for (const n of needleList(s)) {
    if (n.location.kind !== "broken-in-patient" || n.resolution) continue;
    const reported = s.incidents.some((i) => i.kind === "broken-needle" && (i.needleId === null || i.needleId === n.id));
    const referred = s.referrals.some((r) => r.urgency === "urgent" || r.urgency === "emergency");
    if (reported && referred) n.resolution = "reported and referred for removal";
  }
}

/* ------------------------------------------------------------------ */
/* Logs and replay                                                     */
/* ------------------------------------------------------------------ */

export const LOG_SCHEMA_ID = "acucraft/log@1" as const;

/** Everything needed to reproduce an encounter: the external requests, in order, with the seed and mode. */
export interface EncounterLog {
  schema: typeof LOG_SCHEMA_ID;
  scenarioId: string;
  scenarioVersion: string;
  engine: { acucraft: string; clinicalcraft: string };
  seed: number;
  mode: Mode;
  requests: ActionRequest[];
  /** Digest of the final state when the log was written (replay must reproduce it). */
  finalDigest?: string;
  meta?: Record<string, unknown>;
}

export function replayLog(sc: Scenario, log: EncounterLog, opts: StepOptions = {}): { state: EncounterState; attempts: AttemptRecord[] } {
  let s = createEncounter(sc, { seed: log.seed, mode: log.mode });
  const attempts: AttemptRecord[] = [];
  for (const r of log.requests) {
    const res = step(sc, s, r, opts);
    s = res.state;
    attempts.push(...res.attempts);
  }
  return { state: s, attempts };
}

export { syncClinicalFlags };
