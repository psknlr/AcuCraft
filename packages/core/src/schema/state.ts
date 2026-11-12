import type { DomainEvent, SessionState } from "@clinicalcraft/core";
import type { Action, ActionRequest, ActionType, DocumentRecord, PlanBody, PointRef, TaskKind } from "./actions.js";
import type { ChartPoint, Position, Side } from "./common.js";
import type { ConsentStatus, FeedbackKind, NeedleSpec, UnsafeCode } from "./field.js";

/**
 * Encounter state — `acucraft/encounter@1`: the authoritative simulation state human learners and AI agents share.
 * It holds the ClinicalCraft session (consultation, records, vitals, clock) and the acupuncture field. Every change
 * goes through `step`; `version` counts committed requests.
 */

export const ENCOUNTER_SCHEMA_ID = "acucraft/encounter@1" as const;

export type Mode = "assessment" | "teaching";

export interface ActorState {
  id: string;
  role: string;
  location: string;
  /** Event sequence (`EncounterState.seq`) of the last hand hygiene / of the last soiling (needle removal, blood, sharps). */
  hygieneSeq: number | null;
  soiledSeq: number | null;
  /** Objects in this actor's hands (needle ids, item ids). One holder per object, always. */
  holding: string[];
}

export type NeedleLocation =
  | { kind: "pack"; packId: string }
  | { kind: "tray"; packId: string }
  | { kind: "hand"; actor: string }
  | { kind: "patient"; region: string; side: Side; entry: ChartPoint; depthCm: number; angleDeg: number; azimuthDeg: number; target: PointRef | null; mark: string | null }
  | { kind: "sharps"; container: string }
  | { kind: "floor"; area: string; hidden: boolean }
  | { kind: "broken-in-patient"; region: string; side: Side; entry: ChartPoint };

export interface NeedleEvent {
  seq: number;
  at: number;
  version: number;
  actor: string;
  what: "pack-opened" | "picked-up" | "handed-over" | "inserted" | "adjusted" | "withdrawn" | "disposed" | "dropped" | "found" | "broken" | "contaminated" | "pressure";
  detail?: string;
}

export interface NeedleState {
  id: string;
  packId: string;
  spec: NeedleSpec;
  location: NeedleLocation;
  /** Ever inserted: a single-use needle never becomes unused again. */
  used: boolean;
  contaminated: boolean;
  contamination: string[];
  insertedBy: string | null;
  removedBy: string | null;
  /** The insertion as executed (kept after withdrawal): where, for what, how deep. */
  insertion: {
    at: number;
    visit: number;
    region: string;
    side: Side;
    /** The region configuration (patient position) the needle went in under. */
    configuration: string;
    patientPosition: Position;
    entry: ChartPoint;
    /** The point the operator named or marked for this needle (null: none named). */
    intended: PointRef | null;
    /** The point the entry actually lies on, judged against this patient's anatomy (planned points first). */
    nearest: PointRef | null;
    /** What the rules treat the needle as: the intended point when the entry lies on it, otherwise the nearest. */
    target: PointRef | null;
    mark: string | null;
    /** The mark had moved with the skin (made in another position) when the needle went in. */
    markStale: boolean;
    requestedDepthCm: number;
    depthCm: number;
    angleDeg: number;
    azimuthDeg: number;
    tipTissue: string;
    findings: { structure: string; contact: boolean; clearanceCm: number }[];
  } | null;
  /** Responsible observer while retained (the actor holding a monitoring task, else the operator). */
  observer: string | null;
  /** Incident response recorded for a lost or broken needle. */
  resolution: string | null;
  bleeding: boolean;
  events: NeedleEvent[];
}

export interface PackState {
  id: string;
  at: string;
  holder: string | null;
  sealed: boolean;
  expired: boolean;
  needles: string[];
  openedBy: string | null;
  openedAt: number | null;
}

export interface MarkRecord {
  id: string;
  visit: number;
  by: string;
  at: number;
  target: PointRef;
  region: string;
  side: Side;
  position: ChartPoint;
  method: "proportional" | "finger-cun" | "landmark" | "palpation";
  patientPosition: Position;
  configuration: string;
  /** Becomes stale when the patient moves into another region configuration (the skin mark moves with the skin). */
  stale: boolean;
}

export interface FeedbackRecord {
  visit: number;
  at: number;
  kind: FeedbackKind;
  text: string;
  needleId?: string;
  abnormal: boolean;
  source: "needle" | "event" | "patient";
}

export interface PlanVersion {
  version: number;
  at: number;
  by: string;
  plan: PlanBody;
}

export interface TaskState {
  id: string;
  kind: TaskKind;
  params: Record<string, string | number | boolean>;
  assignedBy: string;
  assignee: string;
  source: "assignment" | "statement";
  status: "assigned" | "acknowledged" | "declined" | "reported" | "completed" | "incomplete" | "cancelled";
  assignedAt: number;
  acknowledgedAt: number | null;
  reportedAt: number | null;
  report: { summary: string; findings: string[] } | null;
  /** Why a report did not complete the task (the criteria the engine checked). */
  unmet: string[];
  note?: string;
}

export interface Utterance {
  seq: number;
  at: number;
  speaker: string;
  to: string | null;
  text: string;
  kind: "speech" | "answer" | "narration" | "event";
}

export interface Violation {
  ruleSet: string | null;
  rule: string;
  severity: "critical" | "major" | "minor";
  unsafe: UnsafeCode | null;
  detail: string;
}

export interface Protection {
  by: string;
  kind: "guard" | "rule" | "supervisor";
  reason: string;
}

/** The four records the evaluator keeps for every request (proposal §7.3). */
export interface AttemptRecord {
  index: number;
  requestId: string;
  actor: string;
  at: number;
  /** 1. The request as submitted. */
  request: ActionRequest;
  target: string | null;
  status: "executed" | "partial" | "blocked" | "rejected";
  /** 2. What the engine actually did (may differ: a needle stopped at bone, a compound action interrupted). */
  executed: { type: ActionType; detail: string; steps: string[] } | null;
  /** 3. A protective intervention, if any (a blocked unsafe attempt stays here). */
  protection: Protection | null;
  /** 4. The resulting state version (unchanged for a rejection). */
  resultVersion: number;
  code: string | null;
  message: string;
  violations: Violation[];
  unsafe: UnsafeCode[];
  observations: string[];
}

export interface CountRecord {
  visit: number;
  at: number;
  by: string;
  opened: number;
  retained: number;
  inHand: number;
  onTray: number;
  disposed: number;
  unaccounted: number;
  /** Only a count made where the needles are (`observed`), or a colleague's such count received (`reported`), reconciles. */
  reconciled: boolean;
  /** `observed`: counted at the bedside and the tray; `read`: the record read from elsewhere (verifies nothing);
   * `reported`: a colleague's observed count, received through a delegated task. */
  method: "observed" | "read" | "reported";
  /** For `reported`: who counted. */
  reportedBy: string | null;
}

export interface VisitState {
  index: number;
  phase: string;
  date: string;
  startedAt: number;
  ended: boolean;
  endedAt: number | null;
}

export interface EncounterState {
  schema: typeof ENCOUNTER_SCHEMA_ID;
  scenarioId: string;
  seed: number;
  mode: Mode;
  version: number;
  seq: number;
  clinical: SessionState;
  clinicalEvents: DomainEvent[];
  visits: VisitState[];
  actors: Record<string, ActorState>;
  patient: {
    id: string;
    location: string;
    position: Position;
    anxiety: number;
    consent: { status: ConsentStatus; planVersion: number | null; at: number | null; topics: string[] };
    feedback: FeedbackRecord[];
    fainted: boolean;
    /** Since when the conditions for recovering from a faint have held (lying flat, no needles retained). */
    recoverySince: number | null;
  };
  landmarks: { visit: number; by: string; at: number; region: string; side: Side; landmark: string; position: ChartPoint; configuration: string }[];
  measurements: { visit: number; by: string; at: number; region: string; side: Side; what: string; cm: number }[];
  marks: Record<string, MarkRecord>;
  /** Each treatment couch, by room: when it was last cleaned and made up, by whom, and what was done. */
  couches: Record<string, { prepared: { at: number; by: string; done: string[] } | null }>;
  /** Skin cleaned before needling; `touched`: the cleaned skin was handled again afterwards (it needs cleaning again). */
  sitesPrepared: { visit: number; region: string; side: Side; at: number; by: string; touched: { at: number; by: string; how: string } | null }[];
  revealedConditions: string[];
  revealedAshi: string[];
  assessments: { at: number; by: string; diagnoses: string[]; pattern: string | null; redFlags: string[]; rationale: string }[];
  decisions: { at: number; by: string; disposition: string; rationale: string; visit: number }[];
  plans: PlanVersion[];
  planApproved: number | null;
  referrals: { at: number; by: string; to: string; urgency: string; reason: string }[];
  /** What the patient was told (`text`), and the topics it covered; tags without words cover nothing (`tagged`). */
  explanations: { visit: number; at: number; by: string; topics: string[]; text: string | null; tagged: string[] }[];
  packs: Record<string, PackState>;
  needles: Record<string, NeedleState>;
  items: Record<string, { id: string; holder: string | null; at: string | null }>;
  counts: CountRecord[];
  tasks: Record<string, TaskState>;
  utterances: Utterance[];
  monitorLog: { visit: number; at: number; by: string; taskId: string | null }[];
  vitalsLog: { visit: number; at: number; by: string; vitals: Record<string, number | string> }[];
  documents: { visit: number; at: number; by: string; record: DocumentRecord }[];
  incidents: { visit: number; at: number; by: string; kind: string; needleId: string | null; description: string }[];
  claims: { at: number; by: string; text: string; claim: string; supported: boolean }[];
  stopped: { visit: number; at: number; by: string; reason: string } | null;
  flags: string[];
  /** Field events: when their condition first held, whether the seeded draw let them fire, when they fired. */
  events: Record<string, { armedAt: number; draw: boolean; firedAt: number | null }>;
  attempts: AttemptRecord[];
  finished: boolean;
  finishedAt: number | null;
}

export type { Action, ActionRequest, PointRef };
