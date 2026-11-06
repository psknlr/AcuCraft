import { z } from "zod";
import { DistanceSchema, IdSchema, LocalizedTextSchema, ReviewSchema, SemverSchema, SeveritySchema, SourceRefSchema } from "./common.js";

/**
 * Point-location standards and versioned acupoint definitions (proposal §5.1).
 *
 * Three entities stay apart: the **definition** (this file: standard name, code, aliases, location text, edition,
 * provenance), the **patient-specific instance** (computed by `pointInstance` from the definition's localisation and
 * the patient's anatomy in their current position) and the **actual entry point** (what the operator marked and
 * needled, recorded in the encounter).
 */

export const STANDARDS_SCHEMA_ID = "acucraft/standards@1" as const;
export const ACUPOINTS_SCHEMA_ID = "acucraft/acupoints@1" as const;

export const StandardEditionSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    publisher: z.string().min(1),
    year: z.number().int(),
    kind: z.enum(["location-standard", "nomenclature-standard", "national-standard"]),
    /** Number of meridian (channel) points the edition specifies. */
    meridianPointCount: z.number().int().positive().optional(),
    source: SourceRefSchema,
    /** Scope: what the edition is used for in AcuCraft (anatomical and terminology reference, never local practice rules). */
    use: z.string(),
  })
  .strict();
export type StandardEdition = z.infer<typeof StandardEditionSchema>;

export const StandardsFileSchema = z
  .object({
    schema: z.literal(STANDARDS_SCHEMA_ID),
    version: SemverSchema,
    editions: z.array(StandardEditionSchema).min(1),
    /** Known differences between editions that affect point identity or count. */
    differences: z
      .array(z.object({ id: IdSchema, editions: z.array(IdSchema).min(2), summary: z.string(), points: z.array(IdSchema).default([]), verified: z.boolean().default(false) }).strict())
      .default([]),
  })
  .strict();
export type StandardsFile = z.infer<typeof StandardsFileSchema>;

/** Offsets applied after the base construction, in anatomical directions (sign resolved per region and side). */
export const OffsetSchema = z
  .object({
    lateral: DistanceSchema.optional(),
    medial: DistanceSchema.optional(),
    cranial: DistanceSchema.optional(),
    caudal: DistanceSchema.optional(),
  })
  .strict()
  .refine((o) => !(o.lateral && o.medial) && !(o.cranial && o.caudal), "an offset cannot be lateral and medial (or cranial and caudal) at once");
export type Offset = z.infer<typeof OffsetSchema>;

/**
 * How a point is constructed on the patient from regional landmarks (proportional bone measurement, B-cun).
 * In a midline region a landmark id may hold `{side}` (`acromion-lateral-{side}`): it is read as the point's side.
 * Distances in cun are converted with the patient's own segment length (`cunScale`), never with a fixed number
 * of centimetres.
 */
/** A landmark id, which in a midline region may hold the `{side}` placeholder. */
export const LandmarkRefSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\{side\}[A-Za-z0-9._-]*)?$/, "a landmark id, optionally with one {side} placeholder");

export const LocalisationSchema = z.discriminatedUnion("method", [
  /** At a landmark (a depression, a crease, a bony prominence), optionally offset. */
  z.object({ method: z.literal("landmark"), landmark: LandmarkRefSchema, offset: OffsetSchema.optional() }).strict(),
  /** A fraction of the way from landmark `a` to landmark `b` (0.5 = the midpoint). */
  z.object({ method: z.literal("between"), a: LandmarkRefSchema, b: LandmarkRefSchema, fraction: z.number().min(0).max(1), offset: OffsetSchema.optional() }).strict(),
  /** A distance from one landmark towards another, along the line joining them. */
  z.object({ method: z.literal("along"), from: LandmarkRefSchema, toward: LandmarkRefSchema, distance: DistanceSchema, offset: OffsetSchema.optional() }).strict(),
]);
export type Localisation = z.infer<typeof LocalisationSchema>;

export const PointCautionSchema = z
  .object({
    id: IdSchema,
    /** The circumstance (a scenario risk factor id: `pregnancy`, `anticoagulation`, `lymphoedema` …). */
    when: IdSchema,
    text: z.string(),
    severity: SeveritySchema,
    source: SourceRefSchema.optional(),
  })
  .strict();

export const AcupointDefinitionSchema = z
  .object({
    /** AcuCraft id: the WHO alphanumeric code (ST36), or the edition's code for extra points (EX-LE4). */
    id: IdSchema,
    names: z.object({ pinyin: z.string(), hanzi: z.string(), en: z.string().optional() }).strict(),
    /** Channel abbreviation (ST, SP, LI …), or `EX` for extra points. */
    channel: z.string().min(1).max(4),
    /** Codes per edition (the same point may carry different codes, or be absent, in another edition). */
    codes: z.array(z.object({ edition: IdSchema, code: z.string().min(1), relation: z.enum(["same", "reclassified", "absent"]).default("same"), note: z.string().optional() }).strict()).min(1),
    aliases: z.array(z.string()).default([]),
    location: z.object({ edition: IdSchema, text: LocalizedTextSchema, paraphrased: z.boolean().default(true) }).strict(),
    /** The reviewed regional model this point is localised in; absent = definition only (no procedural chain yet). */
    region: IdSchema.optional(),
    localisation: LocalisationSchema.optional(),
    /** Region configuration the standard locates the point in (e.g. ST35 with the knee flexed). */
    configuration: IdSchema.optional(),
    /** Localisation tolerance around the patient-specific reference (cun of the point's segment, or cm). */
    tolerance: DistanceSchema.default({ cm: 1 }),
    /** Laterality: bilateral points are needled on a side; midline points have none. */
    bilateral: z.boolean().default(true),
    cautions: z.array(PointCautionSchema).default([]),
    /** Public teaching notes (what the practitioner may know): never patient-specific geometry. */
    notes: z.string().optional(),
    provenance: z.object({ sources: z.array(SourceRefSchema).min(1), review: ReviewSchema }).strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.localisation && !p.region) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["region"], message: "a point with a localisation needs its region" });
  });
export type AcupointDefinition = z.infer<typeof AcupointDefinitionSchema>;

export const AcupointsFileSchema = z
  .object({
    schema: z.literal(ACUPOINTS_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    points: z.array(AcupointDefinitionSchema).min(1),
  })
  .strict();
export type AcupointsFile = z.infer<typeof AcupointsFileSchema>;
