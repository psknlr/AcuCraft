import type { DomainEvent, SessionState } from "@clinicalcraft/core";
import type { Action, ActionRequest, ActionType, DocumentRecord, PlanBody, PointRef, TaskKind } from "./actions.js";
import type { ChartPoint, Position, Side } from "./common.js";
import type { ConsentStatus, FeedbackKind, NeedleSensation, NeedleSpec, UnsafeCode } from "./field.js";

/**
 * Encounter state — `acucraft/encounter@1`: the authoritative simulation state human learners and AI agents share.
 * It holds the ClinicalCraft session (consultation, records, vitals, clock) and the acupuncture field. Every change
 * goes through `step`; `version` counts committed requests.
 */

export const ENCOUNTER_SCHEMA_ID = "acucraft/encounter@2" as const;

export type Mode = "assessment" | "teaching";

/** Where someone stands on the clinic floor (m, the facility's frame) and which way they face (radians; 0 looks north). */
export interface Stance {
  x: number;
  z: number;
  yaw: number;
}

/** A walk an actor made: for the record, the viewer and the evaluator's measure of distance covered. */
export interface WalkRecord {
  /** Index of the attempt that made it. */
  attempt: number;
  at: number;
  actor: string;
  from: { x: number; z: number };
  to: { x: number; z: number };
  /** The path walked, corner by corner (empty: a turn on the spot). */
  path: { x: number; z: number }[];
  metres: number;
  minutes: number;
  /** The patient walked alongside. */
  withPatient: boolean;
}

/**
 * What an evidence item is: an answer the patient gave, an examination finding, a record read, a set of vital signs,
 * what was seen of the patient, what the patient said they feel at a needle, what the operator felt on manipulating one.
 */
export type EvidenceKind = "history" | "exam" | "record" | "vitals" | "observation" | "sensation" | "needle-feel";

/**
 * One piece of evidence obtained in the encounter (docs/EVIDENCE.md). Its id is stable — a history item's or an
 * examination finding's own id, `<investigation>.<phase>` for a record, `vitals-1`, `obs-1`, `sense-1`, `feel-1` … for
 * the rest — and a conclusion (a pattern differentiation, a recorded needle response) names the ids it rests on.
 * An item holds what was seen or heard, never what it means.
 */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** The case item, the investigation or the needle it is about. */
  ref: string | null;
  visit: number;
  at: number;
  /** Who obtained it. */
  by: string;
  text: string;
  /** Needle evidence: the needle, the qualities the patient named, the grip the operator felt (null: none sought). */
  needle?: { id: string; qualities: NeedleSensation[]; grasp: boolean | null; volunteered: boolean };
}

/**
 * How the tissue answers a needle — the field's own truth, never shown (docs/EVIDENCE.md). The patient's reports and
 * the operator's feel are read from it; a recorded response is compared with it afterwards.
 */
export interface NeedleResponse {
  /** Stimulation given: the insertion, then each manipulation. */
  stimulation: number;
  manipulations: number;
  /** How strongly the tissue answers at this depth, for this patient (deqi from `DEQI_THRESHOLD`). */
  intensity: number;
  deqi: boolean;
  /** When deqi first arrived (null: it has not). */
  arrivedAt: number | null;
  qualities: NeedleSensation[];
  /** A sensation that is not deqi and wants the needle adjusted or out (a nerve, a tendon, too strong). */
  noxious: NeedleSensation | null;
  /** Stimulated beyond what the patient tolerates. */
  overstimulated: boolean;
}

export interface ActorState {
  id: string;
  role: string;
  /** The room the actor stands in (`outside`: in none of the clinic's rooms). Always the room of `at`. */
  location: string;
  /** Where the actor stands. Every change goes through a walk the world planned. */
  at: Stance;
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
  /** `near`: the couch or chair it fell by (where the patient was), if any. */
  | { kind: "floor"; area: string; hidden: boolean; near?: string }
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
  /** The tissue's response while the needle is, or was, in place (null: never inserted). */
  response: NeedleResponse | null;
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
    /** Where the patient is: on `support` (a couch or chair fixture), or standing at this spot. */
    at: Stance;
    /** The fixture the patient sits or lies on (null: standing). */
    support: string | null;
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
  /** `patternEvidence`: the evidence ids the pattern differentiation names (each was in `evidence` when it was made). */
  assessments: { at: number; by: string; visit: number; diagnoses: string[]; pattern: string | null; patternEvidence: string[]; redFlags: string[]; rationale: string }[];
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
  /** `id`: the reading's id in the evidence ledger. */
  vitalsLog: { id: string; visit: number; at: number; by: string; vitals: Record<string, number | string> }[];
  documents: { visit: number; at: number; by: string; record: DocumentRecord }[];
  incidents: { visit: number; at: number; by: string; kind: string; needleId: string | null; description: string }[];
  claims: { at: number; by: string; text: string; claim: string; supported: boolean }[];
  stopped: { visit: number; at: number; by: string; reason: string } | null;
  flags: string[];
  /** Field events: when their condition first held, whether the seeded draw let them fire, when they fired. */
  events: Record<string, { armedAt: number; draw: boolean; firedAt: number | null }>;
  /** Every walk made, in order. */
  walks: WalkRecord[];
  /** The evidence ledger: everything obtained, in order, each item once. */
  evidence: EvidenceItem[];
  attempts: AttemptRecord[];
  finished: boolean;
  finishedAt: number | null;
}

export type { Action, ActionRequest, PointRef };
