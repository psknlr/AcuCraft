import { z } from "zod";
import { ChartPointSchema, IdSchema, PositionSchema } from "./common.js";

/**
 * The action interface (proposal §7.3) — every actor (the practitioner or learner under test, the support agent,
 * the supervisor, the patient's scripted behaviour) acts through these requests, and only through them.
 *
 * A request names its actor, the patient, the action and its parameters, the state version it was decided on
 * (`expectedVersion`, optimistic concurrency) and a unique `requestId` (idempotency: a repeated id returns the first
 * outcome and changes nothing).
 */

export const SideArgSchema = z.enum(["left", "right", "midline"]);

/** A target on the patient: a standard point, or an Ashi (tender) location found on examination. */
export const PointRefSchema = z.union([
  z.object({ point: IdSchema, side: SideArgSchema }).strict(),
  z.object({ ashi: IdSchema }).strict(),
]);
export type PointRef = z.infer<typeof PointRefSchema>;

export const DISPOSITIONS = ["treat", "treat-modified", "further-assessment", "defer", "refer", "decline"] as const;
export const DispositionSchema = z.enum(DISPOSITIONS);
export type Disposition = z.infer<typeof DispositionSchema>;

export const EXPLANATION_TOPICS = ["procedure", "benefits", "risks", "alternatives", "evidence", "aftercare", "right-to-stop"] as const;
export const ExplanationTopicSchema = z.enum(EXPLANATION_TOPICS);

export const TASK_KINDS = ["monitor-patient", "position-patient", "fetch", "count-needles", "dispose-sharps", "record-vitals", "chaperone", "prepare-couch"] as const;
export const TaskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const PlanPointSchema = z.union([
  z.object({ point: IdSchema, side: SideArgSchema }).strict(),
  z.object({ ashi: IdSchema }).strict(),
]);

export const PlanSchema = z
  .object({
    points: z.array(PlanPointSchema).max(30),
    technique: z
      .object({
        method: z.enum(["manual-filiform"]).default("manual-filiform"),
        stimulation: z.enum(["none", "even", "reducing", "reinforcing"]).default("even"),
        retentionMinutes: z.number().min(0).max(60),
      })
      .strict(),
    rationale: z.string().max(4000).default(""),
    alternatives: z.array(z.string().max(500)).default([]),
    followUp: z.string().max(1000).optional(),
  })
  .strict();
export type PlanBody = z.infer<typeof PlanSchema>;

export const DocumentRecordSchema = z
  .object({
    presentingComplaint: z.string().max(4000).optional(),
    history: z.string().max(8000).optional(),
    examination: z.string().max(8000).optional(),
    assessment: z.string().max(4000).optional(),
    pattern: z.string().max(1000).optional(),
    rationale: z.string().max(4000).optional(),
    consent: z.string().max(1000).optional(),
    pointsUsed: z.array(PlanPointSchema).optional(),
    needling: z
      .object({
        needleType: z.string().max(200).optional(),
        needleCount: z.number().int().min(0).optional(),
        depth: z.string().max(500).optional(),
        responseSought: z.string().max(500).optional(),
        stimulation: z.string().max(500).optional(),
        retentionMinutes: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    response: z.string().max(4000).optional(),
    adverseEvents: z.string().max(4000).optional(),
    advice: z.string().max(4000).optional(),
    followUp: z.string().max(2000).optional(),
  })
  .strict();
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

const Text = z.string().max(4000);

export const ActionSchema = z.discriminatedUnion("type", [
  /* communication & consultation */
  z.object({ type: z.literal("say"), text: Text, to: IdSchema.optional() }).strict(),
  /** One focused question: by history item id (button) or as free text (matched against the case). */
  z.object({ type: z.literal("ask"), itemId: IdSchema.optional(), text: Text.optional() }).strict(),
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("examine"), findingId: IdSchema.optional(), text: Text.optional() }).strict(),
  z.object({ type: z.literal("review_result"), investigationId: IdSchema.optional(), query: Text.optional() }).strict(),
  z.object({ type: z.literal("order_investigation"), investigationId: IdSchema.optional(), query: Text.optional() }).strict(),
  z.object({ type: z.literal("check_vitals") }).strict(),

  /* decision & consent */
  z
    .object({
      type: z.literal("assess"),
      diagnoses: z.array(IdSchema).max(6).default([]),
      pattern: IdSchema.optional(),
      redFlags: z.array(IdSchema).max(10).default([]),
      rationale: Text.optional(),
    })
    .strict(),
  z.object({ type: z.literal("decide"), disposition: z.enum(["treat", "treat-modified", "further-assessment", "defer", "refer", "decline"]), rationale: Text.optional() }).strict(),
  z.object({ type: z.literal("propose_plan"), plan: PlanSchema }).strict(),
  z.object({ type: z.literal("explain"), topics: z.array(ExplanationTopicSchema).max(7).default([]), text: Text.optional() }).strict(),
  z.object({ type: z.literal("seek_consent") }).strict(),
  z.object({ type: z.literal("refer"), to: IdSchema, urgency: z.enum(["routine", "soon", "urgent", "emergency"]), reason: Text }).strict(),

  /* localisation */
  z.object({ type: z.literal("position_patient"), position: PositionSchema }).strict(),
  z.object({ type: z.literal("identify_landmark"), region: IdSchema, side: SideArgSchema, landmark: IdSchema }).strict(),
  z.object({ type: z.literal("measure"), region: IdSchema, side: SideArgSchema, segment: IdSchema.optional(), fingerCun: z.boolean().optional() }).strict(),
  z
    .object({
      type: z.literal("mark_point"),
      target: PointRefSchema,
      region: IdSchema,
      side: SideArgSchema,
      at: ChartPointSchema,
      method: z.enum(["proportional", "finger-cun", "landmark", "palpation"]).default("proportional"),
    })
    .strict(),

  /* preparation */
  /** Walk to a room; `withPatient` escorts the patient (who must be able to walk). */
  z.object({ type: z.literal("move"), to: IdSchema, withPatient: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("hand_hygiene") }).strict(),
  z.object({ type: z.literal("fetch"), item: IdSchema }).strict(),
  z.object({ type: z.literal("handover"), object: IdSchema, to: IdSchema }).strict(),
  z.object({ type: z.literal("open_pack"), packId: IdSchema }).strict(),
  z.object({ type: z.literal("pick_up"), object: IdSchema }).strict(),
  z.object({ type: z.literal("prepare_site"), region: IdSchema, side: SideArgSchema }).strict(),
  /** Clean the couch surface and put on fresh linen, in the room the actor is in. */
  z.object({ type: z.literal("prepare_couch") }).strict(),

  /* procedure */
  z
    .object({
      type: z.literal("insert_needle"),
      needleId: IdSchema,
      /** Where: a mark made with `mark_point`, or explicit chart coordinates with the target they are meant for. */
      mark: IdSchema.optional(),
      target: PointRefSchema.optional(),
      region: IdSchema.optional(),
      side: SideArgSchema.optional(),
      at: ChartPointSchema.optional(),
      /** 0 = perpendicular to the skin; 45 ≈ oblique; 75–90 ≈ transverse. */
      angleDeg: z.number().min(0).max(90).default(0),
      /** Direction the needle tip travels across the chart: 0 = cranial (+v), 90 = +u, 180 = caudal, 270 = −u. */
      azimuthDeg: z.number().min(0).max(360).default(0),
      depthCm: z.number().positive().max(10),
    })
    .strict(),
  z.object({ type: z.literal("adjust_needle"), needleId: IdSchema, depthCm: z.number().positive().max(10).optional(), technique: z.enum(["none", "lift-thrust", "rotate"]).default("none") }).strict(),
  z.object({ type: z.literal("monitor") }).strict(),
  z.object({ type: z.literal("wait"), minutes: z.number().int().min(1).max(60) }).strict(),
  z.object({ type: z.literal("stop_treatment"), reason: Text }).strict(),

  /* completion */
  z.object({ type: z.literal("remove_needle"), needleId: IdSchema }).strict(),
  /** Compound: removes every retained needle in turn; an interruption leaves the removals already made. */
  z.object({ type: z.literal("remove_all_needles") }).strict(),
  z.object({ type: z.literal("apply_pressure"), needleId: IdSchema }).strict(),
  z.object({ type: z.literal("count_needles") }).strict(),
  z.object({ type: z.literal("dispose"), object: IdSchema }).strict(),
  z.object({ type: z.literal("search"), area: z.enum(["couch", "floor", "patient", "tray", "clothing"]) }).strict(),
  z.object({ type: z.literal("report_incident"), kind: z.enum(["lost-needle", "broken-needle", "needlestick", "adverse-event", "near-miss"]), needleId: IdSchema.optional(), description: Text }).strict(),
  z.object({ type: z.literal("document"), record: DocumentRecordSchema }).strict(),
  z.object({ type: z.literal("end_visit") }).strict(),
  z.object({ type: z.literal("begin_follow_up") }).strict(),
  z.object({ type: z.literal("finish_encounter") }).strict(),

  /* team */
  z.object({ type: z.literal("assign_task"), to: IdSchema, kind: TaskKindSchema, params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), note: Text.optional() }).strict(),
  z.object({ type: z.literal("acknowledge_task"), taskId: IdSchema }).strict(),
  z.object({ type: z.literal("decline_task"), taskId: IdSchema, reason: Text }).strict(),
  z.object({ type: z.literal("report_task"), taskId: IdSchema, summary: Text, findings: z.array(IdSchema).default([]) }).strict(),
  z.object({ type: z.literal("cancel_task"), taskId: IdSchema }).strict(),
  z.object({ type: z.literal("approve_plan") }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionInput = z.input<typeof ActionSchema>;
export type ActionType = Action["type"];

export const ActionRequestSchema = z
  .object({
    requestId: z.string().min(1).max(120),
    actor: IdSchema,
    patient: IdSchema.default("patient"),
    action: ActionSchema,
    /** The state version the actor decided on; a different current version rejects the request (`stale-version`). */
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type ActionRequestInput = z.input<typeof ActionRequestSchema>;
