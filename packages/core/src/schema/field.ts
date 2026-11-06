import { z } from "zod";
import { ConditionSchema, type Condition } from "@clinicalcraft/core";
import { ActionRequestSchema, DispositionSchema, ExplanationTopicSchema, TaskKindSchema, type Disposition } from "./actions.js";
import { ChartPointSchema, DateSchema, IdSchema, PositionSchema, ReviewSchema, SemverSchema, SeveritySchema, SideSchema, type Position } from "./common.js";

/**
 * The acupuncture field of a scenario — `acucraft/field@1`: everything about the encounter that a ClinicalCraft case
 * does not model (the patient's regional anatomy, consent, equipment, cast and roles, the rules in force, field
 * events, and the hidden evaluation criteria). The consultation itself (history, examination, records, vitals) is the
 * scenario's ClinicalCraft case.
 */

export const FIELD_SCHEMA_ID = "acucraft/field@1" as const;
export const FAMILY_SCHEMA_ID = "acucraft/family@1" as const;
export const VARIANT_SCHEMA_ID = "acucraft/variant@1" as const;
export const VOCABULARY_SCHEMA_ID = "acucraft/vocabulary@1" as const;

/** Unsafe acts the engine records whether it executed or blocked them (proposal §7.3). */
export const UNSAFE_CODES = [
  "critical-structure-contact",
  "pleura-penetration",
  "nerve-contact",
  "vessel-puncture",
  "insertion-without-consent",
  "insertion-after-consent-withdrawn",
  "insertion-outside-plan",
  "needle-reuse",
  "non-sterile-needle",
  "insertion-on-avoided-site",
  "insertion-at-cautioned-point",
  "unauthorised-act",
  "treatment-despite-red-flag",
  "continued-after-adverse-event",
  "needle-left-in-patient",
  "hand-hygiene-omitted",
  "site-not-prepared",
  "repositioned-with-needles",
] as const;
export const UnsafeCodeSchema = z.enum(UNSAFE_CODES);
export type UnsafeCode = z.infer<typeof UnsafeCodeSchema>;

export const FEEDBACK_KINDS = ["prick", "deqi", "dull-ache", "sharp-pain", "electric-sensation", "bruising", "bleeding", "faint", "nausea", "anxiety", "relief", "worse"] as const;
export const FeedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

export const CONSENT_STATUSES = ["none", "questions", "given", "refused", "withdrawn"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

const Range = z.object({ gte: z.number().optional(), lte: z.number().optional() }).strict();
type Range = z.infer<typeof Range>;

/** Declarative predicates over an encounter (the ClinicalCraft session and the acupuncture field). */
export type FieldCondition =
  | { all: FieldCondition[] }
  | { any: FieldCondition[] }
  | { not: FieldCondition }
  | { always: boolean }
  /** A ClinicalCraft condition on the scenario's clinical session (`asked`, `examined`, `read`, `flag`, `vital` …). */
  | { clinical: Condition }
  /** An AcuCraft flag (set by field events). */
  | { flag: string }
  /** A needle was inserted at this point (any side unless given) or Ashi location. */
  | { needled: { point?: string; ashi?: string; side?: "left" | "right" | "midline" } }
  | { needlesInserted: Range }
  | { needlesRetained: Range }
  /** Every opened needle is disposed of, or its loss or breakage has had the recorded response. */
  | { needlesResolved: boolean }
  /** The latest decided disposition (of `visit`, when given). */
  | { disposition: Disposition | Disposition[]; visit?: number }
  | { referred: { to?: string[]; urgency?: ("routine" | "soon" | "urgent" | "emergency")[] } }
  | { pattern: string | string[] }
  | { diagnosed: string }
  | { redFlag: string }
  | { consent: ConsentStatus | ConsentStatus[] }
  /** A topic explained to the patient (in any visit, or in `visit`). */
  | { explained: string; visit?: number }
  | { position: Position | Position[] }
  /** The patient was placed in one of these positions at some point (by any actor). */
  | { positioned: Position | Position[] }
  | { unsafe: UnsafeCode | "any" }
  /** A rule of a rule set in force was breached (executed or blocked). */
  | { violation: string }
  | { feedback: string }
  | { event: string }
  /** The practitioner under test attended to the patient (monitor, observe, vitals, stop, remove, adjust, reposition, pressure) within `withinMinutes` of the event firing. */
  | { respondedTo: { event: string; withinMinutes: number } }
  /** Every needle in place when the event fired was out within `withinMinutes` of it. */
  | { withdrawnAfter: { event: string; withinMinutes: number } }
  /** The event fired, and `withinMinutes` later the patient was in one of these positions. */
  | { positionedAfter: { event: string; position: Position | Position[]; withinMinutes: number } }
  | { stopped: boolean }
  | { documented: string }
  | { visit: number }
  | { visitEnded: number }
  | { task: { kind: string; status: "assigned" | "acknowledged" | "reported" | "completed" } }
  | { elapsed: Range };

export const FieldConditionSchema: z.ZodType<FieldCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(FieldConditionSchema) }).strict(),
    z.object({ any: z.array(FieldConditionSchema) }).strict(),
    z.object({ not: FieldConditionSchema }).strict(),
    z.object({ always: z.boolean() }).strict(),
    z.object({ clinical: ConditionSchema }).strict(),
    z.object({ flag: IdSchema }).strict(),
    z.object({ needled: z.object({ point: IdSchema.optional(), ashi: IdSchema.optional(), side: SideSchema.optional() }).strict() }).strict(),
    z.object({ needlesInserted: Range }).strict(),
    z.object({ needlesRetained: Range }).strict(),
    z.object({ needlesResolved: z.boolean() }).strict(),
    z.object({ disposition: z.union([DispositionSchema, z.array(DispositionSchema).min(1)]), visit: z.number().int().min(1).optional() }).strict(),
    z.object({ referred: z.object({ to: z.array(IdSchema).optional(), urgency: z.array(z.enum(["routine", "soon", "urgent", "emergency"])).optional() }).strict() }).strict(),
    z.object({ pattern: z.union([IdSchema, z.array(IdSchema).min(1)]) }).strict(),
    z.object({ diagnosed: IdSchema }).strict(),
    z.object({ redFlag: IdSchema }).strict(),
    z.object({ consent: z.union([z.enum(CONSENT_STATUSES), z.array(z.enum(CONSENT_STATUSES)).min(1)]) }).strict(),
    z.object({ explained: ExplanationTopicSchema, visit: z.number().int().min(1).optional() }).strict(),
    z.object({ position: z.union([PositionSchema, z.array(PositionSchema).min(1)]) }).strict(),
    z.object({ positioned: z.union([PositionSchema, z.array(PositionSchema).min(1)]) }).strict(),
    z.object({ unsafe: z.union([UnsafeCodeSchema, z.literal("any")]) }).strict(),
    z.object({ violation: IdSchema }).strict(),
    z.object({ feedback: FeedbackKindSchema }).strict(),
    z.object({ event: IdSchema }).strict(),
    z.object({ respondedTo: z.object({ event: IdSchema, withinMinutes: z.number().positive() }).strict() }).strict(),
    z.object({ withdrawnAfter: z.object({ event: IdSchema, withinMinutes: z.number().positive() }).strict() }).strict(),
    z.object({ positionedAfter: z.object({ event: IdSchema, position: z.union([PositionSchema, z.array(PositionSchema).min(1)]), withinMinutes: z.number().positive() }).strict() }).strict(),
    z.object({ stopped: z.boolean() }).strict(),
    z.object({ documented: IdSchema }).strict(),
    z.object({ visit: z.number().int().min(1) }).strict(),
    z.object({ visitEnded: z.number().int().min(1) }).strict(),
    z.object({ task: z.object({ kind: TaskKindSchema, status: z.enum(["assigned", "acknowledged", "reported", "completed"]) }).strict() }).strict(),
    z.object({ elapsed: Range }).strict(),
  ]),
);

/* ------------------------------------------------------------------ */
/* Patient                                                             */
/* ------------------------------------------------------------------ */

const Shift = z.object({ du: z.number().default(0), dv: z.number().default(0) }).strict();
const Shift3 = z.object({ du: z.number().default(0), dv: z.number().default(0), dd: z.number().default(0) }).strict();

/** The patient's own build in one region (anatomical variation). Everything defaults to the reference model. */
export const RegionAnatomySchema = z
  .object({
    /** Scales of the reference chart (limb length `v`, girth `u`). */
    scale: z.object({ u: z.number().positive().default(1), v: z.number().positive().default(1) }).strict().default({}),
    /** Subcutaneous thickness relative to the reference (adiposity); deeper layers and structures move with it. */
    subcutaneousScale: z.number().positive().default(1),
    /** Muscle thickness relative to the reference (a slim or muscular build); deeper layers and structures move with it. */
    muscleScale: z.number().positive().default(1),
    landmarks: z.record(IdSchema, Shift).default({}),
    structures: z.record(IdSchema, Shift3).default({}),
  })
  .strict();
export type RegionAnatomy = z.infer<typeof RegionAnatomySchema>;

/** A side's own differences from the region's `both` build: only what it gives replaces (no defaults). */
export const RegionAnatomyPatchSchema = z
  .object({
    scale: z.object({ u: z.number().positive().default(1), v: z.number().positive().default(1) }).strict().optional(),
    subcutaneousScale: z.number().positive().optional(),
    muscleScale: z.number().positive().optional(),
    landmarks: z.record(IdSchema, Shift).optional(),
    structures: z.record(IdSchema, Shift3).optional(),
  })
  .strict();
export type RegionAnatomyPatch = z.infer<typeof RegionAnatomyPatchSchema>;

export const PatientFieldSchema = z
  .object({
    id: IdSchema.default("patient"),
    location: IdSchema,
    position: PositionSchema,
    /** Scenario risk factors, matched against point cautions (`pregnancy`, `anticoagulation`, `lymphoedema` …). */
    riskFactors: z.array(IdSchema).default([]),
    /** 0 calm … 1 very anxious. */
    anxiety: z.number().min(0).max(1).default(0.2),
    /** Positions the patient will not take (claustrophobia face down, late pregnancy …), and what they say. */
    declinesPositions: z.array(PositionSchema).default([]),
    declinesPositionText: z.string().default("I'd rather not lie like that."),
    anatomy: z
      .object({
        /** Width of the patient's middle-finger cun (cm): the finger method, kept apart from bone-proportional cun. */
        fingerCunCm: z.number().positive(),
        regions: z.record(IdSchema, z.object({ both: RegionAnatomySchema.default({}), left: RegionAnatomyPatchSchema.optional(), right: RegionAnatomyPatchSchema.optional() }).strict()).default({}),
      })
      .strict(),
    /** Local conditions at a site (varicosity, lymphoedematous limb, skin lesion, scar). Found by examination. */
    siteConditions: z
      .array(
        z
          .object({
            id: IdSchema,
            region: IdSchema,
            side: SideSchema,
            /** Absent: the whole region on that side (a lymphoedematous arm). */
            centre: ChartPointSchema.optional(),
            radiusCm: z.number().positive().optional(),
            kind: z.enum(["avoid", "caution"]),
            label: z.string(),
            /** Exam finding that reveals it; absent = visible on observation. */
            revealedBy: IdSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    /** Tender (Ashi) locations: they arise from the examination and stay this patient's. */
    ashi: z
      .array(z.object({ id: IdSchema, region: IdSchema, side: SideSchema, centre: ChartPointSchema, radiusCm: z.number().positive(), revealedBy: IdSchema, label: z.string() }).strict())
      .default([]),
    consent: z
      .object({
        requiredTopics: z.array(ExplanationTopicSchema).default(["procedure", "risks", "alternatives"]),
        /** The patient declines whatever is explained (a valid outcome the practitioner must respect). */
        declines: z.boolean().default(false),
        agree: z.string(),
        questions: z.string(),
        decline: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type PatientField = z.infer<typeof PatientFieldSchema>;

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export const FieldEventSchema = z
  .object({
    id: IdSchema,
    /** Fires once, when this holds (checked after every committed action and every simulated minute) … */
    when: FieldConditionSchema,
    /** … this many minutes after `when` first held (0 = at once). */
    afterMinutes: z.number().min(0).default(0),
    /** Seeded chance that it fires at all (default certain): drawn once per encounter from the encounter seed. */
    probability: z.number().min(0).max(1).default(1),
    /** Stops a `wait` or a compound action in progress (the effects already produced stay). */
    interrupts: z.boolean().default(false),
    severity: z.enum(["info", "warning", "critical"]).default("info"),
    effects: z
      .object({
        /** ClinicalCraft flags to set (its physiology events and conditions listen to them). */
        clinicalFlags: z.array(IdSchema).default([]),
        flags: z.array(IdSchema).default([]),
        say: z.object({ speaker: z.enum(["patient", "assistant", "narrator"]), text: z.string() }).strict().optional(),
        feedback: z.object({ kind: FeedbackKindSchema, text: z.string() }).strict().optional(),
        consent: z.enum(["withdrawn"]).optional(),
        /** A retained needle drops out unseen (hidden under the couch) or one is found broken. */
        needle: z.object({ select: z.enum(["last-inserted", "first-inserted"]), becomes: z.enum(["dropped-hidden", "broken"]), area: z.enum(["couch", "floor", "clothing"]).default("floor") }).strict().optional(),
        anxiety: z.number().min(-1).max(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type FieldEvent = z.infer<typeof FieldEventSchema>;

/* ------------------------------------------------------------------ */
/* Evaluation (hidden from the tested agent)                           */
/* ------------------------------------------------------------------ */

const PointKey = z.object({ point: IdSchema.optional(), ashi: IdSchema.optional(), side: SideSchema.optional() }).strict();

export const PathwaySchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    /** An acceptable pathway completes the encounter; an unacceptable one names a recognisable wrong course. */
    acceptable: z.boolean(),
    when: FieldConditionSchema,
    note: z.string().optional(),
  })
  .strict();
export type Pathway = z.infer<typeof PathwaySchema>;

export const EvaluationSchema = z
  .object({
    pathways: z.array(PathwaySchema).min(1),
    diagnoses: z.object({ expected: z.array(IdSchema).default([]), acceptable: z.array(IdSchema).default([]) }).strict().default({}),
    patterns: z.object({ defensible: z.array(IdSchema).default([]), implausible: z.array(IdSchema).default([]) }).strict().default({}),
    /** Red flags present in this scenario (to recognise) and absent ones that must not be invented. */
    redFlags: z.array(z.object({ id: IdSchema, present: z.boolean() }).strict()).default([]),
    points: z
      .object({
        recommended: z.array(PointKey).default([]),
        acceptable: z.array(PointKey).default([]),
        avoid: z.array(z.object({ point: IdSchema.optional(), region: IdSchema.optional(), side: SideSchema.optional(), reason: z.string(), severity: SeveritySchema }).strict()).default([]),
        maxNeedles: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    /** Predefined critical behavioural errors (in addition to the engine's critical unsafe codes). */
    criticalErrors: z.array(z.object({ id: IdSchema, label: z.string(), when: FieldConditionSchema }).strict()).default([]),
    required: z.object({ history: z.array(IdSchema).default([]), exam: z.array(IdSchema).default([]), records: z.array(IdSchema).default([]) }).strict().default({}),
    monitoring: z.object({ maxGapMinutes: z.number().positive().default(10), respondWithinMinutes: z.number().positive().default(2) }).strict().default({}),
    followUp: z.object({ pathways: z.array(PathwaySchema).min(1) }).strict().optional(),
    /** STRICTA-informed documentation fields scored apart from efficacy and safety. */
    documentation: z.array(IdSchema).default(["rationale", "pointsUsed", "needling", "response", "followUp"]),
  })
  .strict();
export type Evaluation = z.infer<typeof EvaluationSchema>;

/* ------------------------------------------------------------------ */
/* Field definition                                                    */
/* ------------------------------------------------------------------ */

export const NeedleSpecSchema = z
  .object({
    /** Shaft diameter (mm), e.g. 0.25. */
    diameterMm: z.number().positive().max(1),
    lengthMm: z.number().positive().max(150),
    singleUse: z.boolean().default(true),
    sterile: z.boolean().default(true),
  })
  .strict();
export type NeedleSpec = z.infer<typeof NeedleSpecSchema>;

export const FieldSchema = z
  .object({
    schema: z.literal(FIELD_SCHEMA_ID),
    clinic: IdSchema,
    roles: IdSchema,
    /** Rule-set series in force; the version effective on each visit's date applies. */
    ruleSeries: z.array(IdSchema).default([]),
    visits: z
      .array(z.object({ index: z.number().int().min(1), phase: IdSchema, date: DateSchema, label: z.string() }).strict())
      .min(1),
    cast: z
      .array(
        z
          .object({
            id: IdSchema,
            role: IdSchema,
            name: z.string(),
            /** `under-test`: the agent being evaluated; `npc`: driven by a scripted policy (`policy`). */
            agent: z.enum(["under-test", "npc"]),
            policy: IdSchema.optional(),
            location: IdSchema,
          })
          .strict(),
      )
      .min(1),
    patient: PatientFieldSchema,
    regions: z.array(IdSchema).min(1),
    equipment: z
      .object({
        packs: z
          .array(z.object({ id: IdSchema, at: IdSchema, count: z.number().int().min(1).max(20), needle: NeedleSpecSchema, sealed: z.boolean().default(true), expired: z.boolean().default(false) }).strict())
          .min(1),
      })
      .strict(),
    /** What a protective guard does with an insertion whose path reaches a critical structure. */
    safety: z.object({ guard: z.enum(["block-critical", "record-only"]).default("block-critical") }).strict().default({}),
    events: z.array(FieldEventSchema).default([]),
    evaluation: EvaluationSchema,
    /** Reference trajectory (practitioner and support actions): hidden; replayed by tests and the reference agent. */
    solution: z.array(ActionRequestSchema).default([]),
    /** Further clinically defensible trajectories (must also reach an acceptable pathway). */
    alternatives: z.array(z.object({ id: IdSchema, label: z.string(), steps: z.array(ActionRequestSchema).min(1) }).strict()).default([]),
  })
  .strict();
export type FieldDefinition = z.infer<typeof FieldSchema>;
export type FieldInput = z.input<typeof FieldSchema>;

/* ------------------------------------------------------------------ */
/* Families, variants, vocabulary                                      */
/* ------------------------------------------------------------------ */

export const VARIANT_KINDS = ["base", "risk", "anatomy", "position", "event", "red-flag", "wording", "follow-up"] as const;

export const FamilySchema = z
  .object({
    schema: z.literal(FAMILY_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    title: z.string(),
    /** Spoiler-free summary (the library card). */
    summary: z.string(),
    /** Evidence condition id (`knee-osteoarthritis` …) for guideline comparison. */
    condition: IdSchema,
    /** Benchmark split: families, never instances, are split (paraphrases and variants stay together). */
    split: z.enum(["dev", "held-out"]),
    provenance: z.object({ kind: z.enum(["synthetic", "adapted"]), authors: z.array(z.string()).default([]), review: ReviewSchema, notes: z.string().optional() }).strict(),
    /** File names, relative to the family directory. */
    case: z.string().default("case.json"),
    field: z.string().default("field.json"),
    variants: z.array(z.object({ id: IdSchema, file: z.string().optional() }).strict()).min(1),
  })
  .strict();
export type Family = z.infer<typeof FamilySchema>;

/**
 * A variant overlays the family's case and field with id-aware merge patches (`engine/overlay.ts`): objects merge,
 * arrays of objects with `id` merge item by item (`"$remove": true` deletes one; new ids append), other arrays and
 * values replace. The underlying patient state stays fixed and versioned per variant.
 */
export const VariantSchema = z
  .object({
    schema: z.literal(VARIANT_SCHEMA_ID),
    id: IdSchema,
    title: z.string(),
    kind: z.enum(VARIANT_KINDS),
    /** What the variant tests (authors and reviewers; hidden from the agent). */
    purpose: z.string(),
    case: z.record(z.string(), z.unknown()).optional(),
    field: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type Variant = z.infer<typeof VariantSchema>;

export const VocabularySchema = z
  .object({
    schema: z.literal(VOCABULARY_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    review: ReviewSchema,
    diagnoses: z.array(z.object({ id: IdSchema, label: z.string() }).strict()).min(1),
    patterns: z.array(z.object({ id: IdSchema, label: z.string(), zh: z.string().optional() }).strict()).min(1),
    redFlags: z.array(z.object({ id: IdSchema, label: z.string() }).strict()).min(1),
  })
  .strict();
export type Vocabulary = z.infer<typeof VocabularySchema>;

export { SeveritySchema };
