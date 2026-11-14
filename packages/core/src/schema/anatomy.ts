import { z } from "zod";
import { ChartPoint3Schema, ChartPointSchema, IdSchema, PositionSchema, ReviewSchema, SemverSchema, SourceRefSchema } from "./common.js";

/**
 * Regional anatomical models (proposal §5.3) — `acucraft/region@1`.
 *
 * A region is a surface **chart** with depth: `u` runs across the body surface and `v` along it (cranial positive),
 * both in centimetres on a reference adult; `d` is the depth below the skin along the inward normal. In a
 * `bilateral` region `u` is positive towards lateral on either side (the chart is mirrored per side); in a
 * `midline` region `u` is positive towards the patient's left. docs/ANATOMY.md has the full contract.
 *
 * Two assessments stay separate: **localisation accuracy** (the marked surface point against the patient-specific
 * reference) and **needle-path assessment** (the virtual path against the region's structures and layers). A
 * point's location standard never sets a safe depth by itself: depth hazards come from this model, the patient's
 * own build and their uncertainty.
 */

export const REGION_SCHEMA_ID = "acucraft/region@1" as const;
export const BODY_MAP_SCHEMA_ID = "acucraft/body-map@1" as const;

/** A landmark id, optionally with one `{side}` placeholder (read as the side in a midline region). */
export const LANDMARK_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(\{side\}[A-Za-z0-9._-]*)?$/;

export const TISSUES = ["skin", "subcutaneous", "fascia", "muscle", "tendon", "ligament", "fat-pad", "joint-space", "periosteum", "bone", "pleura", "lung", "organ"] as const;
export const TissueSchema = z.enum(TISSUES);
export type Tissue = z.infer<typeof TissueSchema>;

/** Tissues a needle cannot pass: the insertion stops at their surface. */
export const STOPPING_TISSUES: readonly Tissue[] = ["bone"];

export const LayerSchema = z
  .object({
    tissue: TissueSchema,
    thicknessCm: z.number().positive(),
    label: z.string().optional(),
    /**
     * A needle tip reaching this layer is a `critical` event (heart, liver, kidney, spinal canal …) or a recorded
     * `caution` (peritoneum …). The pleura is always critical.
     */
    hazard: z.enum(["critical", "caution"]).optional(),
  })
  .strict();
export type Layer = z.infer<typeof LayerSchema>;

export const ConfigurationShiftSchema = z.object({ du: z.number().default(0), dv: z.number().default(0), dd: z.number().default(0) }).strict();

export const LandmarkSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    at: ChartPointSchema,
    /** How it is found by palpation or inspection (public). */
    palpation: z.string().optional(),
    /** Where it moves in another region configuration (knee flexed …), relative to `at`. */
    configurations: z.record(IdSchema, ConfigurationShiftSchema).default({}),
  })
  .strict();
export type Landmark = z.infer<typeof LandmarkSchema>;

export const SegmentSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    from: IdSchema,
    to: IdSchema,
    /** Its length in proportional bone units (B-cun) of the standard. */
    cun: z.number().positive(),
    source: SourceRefSchema.optional(),
  })
  .strict();
export type Segment = z.infer<typeof SegmentSchema>;

export const STRUCTURE_KINDS = ["artery", "vein", "nerve", "tendon", "joint-capsule", "pleura", "organ", "bone", "bursa"] as const;

export const StructureSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    kind: z.enum(STRUCTURE_KINDS),
    /** `critical` — a needle path must not reach it; `caution` — contact is recorded and may cause a consequence. */
    hazard: z.enum(["critical", "caution"]),
    /** Centreline (or a single point) inside the region; a tube of `radiusCm` around it. */
    path: z.array(ChartPoint3Schema).min(1),
    radiusCm: z.number().positive(),
    /** Positional uncertainty of the schematic geometry (cm): added to the radius as a margin for `near` findings. */
    uncertaintyCm: z.number().min(0).default(0.3),
    configurations: z.record(IdSchema, ConfigurationShiftSchema).default({}),
    /** What reaching it does in the simulation (patient feedback / adverse event); see docs/ANATOMY.md §4. */
    consequence: z.enum(["electric-sensation", "bleeding", "haematoma", "pneumothorax-risk", "joint-penetration", "tendon-pain", "none"]).default("none"),
  })
  .strict();
export type Structure = z.infer<typeof StructureSchema>;

export const TissueZoneSchema = z
  .object({
    id: IdSchema,
    centre: ChartPointSchema,
    radiusCm: z.number().positive(),
    layers: z.array(LayerSchema).min(1),
  })
  .strict();

/**
 * Where a chart meets a neighbouring one. `pairs` are the same skin points on both charts (`here` on this chart,
 * `there` on the other; `{side}` is read as the side). A point on one chart is carried to the other by the
 * similarity (scale, rotation, translation) that best maps the pairs' positions on this patient, so a point measured
 * from a point of the neighbouring chart (`point:ST30`) is placed where that chart puts it. `configurations` gives the
 * other chart's configuration for each of this chart's (default: its default configuration).
 */
export const SeamSchema = z
  .object({
    region: IdSchema,
    pairs: z
      .array(z.object({ here: z.string().regex(LANDMARK_REF), there: z.string().regex(LANDMARK_REF), label: z.string().optional() }).strict())
      .min(2),
    configurations: z.record(IdSchema, IdSchema).default({}),
  })
  .strict();
export type Seam = z.infer<typeof SeamSchema>;

export const RegionSchema = z
  .object({
    schema: z.literal(REGION_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    title: z.string(),
    laterality: z.enum(["bilateral", "midline"]),
    chart: z
      .object({
        description: z.string(),
        uRange: z.tuple([z.number(), z.number()]),
        vRange: z.tuple([z.number(), z.number()]),
      })
      .strict(),
    /**
     * The body the chart is drawn on. A patient whose build the scenario does not author for this region is scaled
     * from it by height and BMI (`derivedBuild`). Default: 170 cm, BMI 22.5.
     */
    reference: z.object({ heightCm: z.number().positive(), bmi: z.number().positive(), sex: z.enum(["male", "female"]).optional(), body: z.string().optional() }).strict().optional(),
    configurations: z.array(z.object({ id: IdSchema, label: z.string() }).strict()).min(1),
    defaultConfiguration: IdSchema,
    /** Positions in which the region is reachable, and the configuration it is then in. */
    access: z
      .array(
        z
          .object({
            position: PositionSchema,
            configuration: IdSchema,
            /** Sides reachable in that position (side-lying: the upper side only). */
            sides: z.array(z.enum(["left", "right", "midline"])).min(1),
          })
          .strict(),
      )
      .min(1),
    landmarks: z.array(LandmarkSchema).min(2),
    segments: z.array(SegmentSchema).default([]),
    tissue: z.object({ layers: z.array(LayerSchema).min(1), zones: z.array(TissueZoneSchema).default([]) }).strict(),
    structures: z.array(StructureSchema).default([]),
    seams: z.array(SeamSchema).default([]),
    /** Public anatomical summary a practitioner may know (no patient-specific coordinates). */
    description: z.string(),
    provenance: z
      .object({
        kind: z.enum(["schematic", "atlas-derived", "imaging-derived"]),
        sources: z.array(SourceRefSchema).default([]),
        licence: z.string(),
        review: ReviewSchema,
        notes: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type Region = z.infer<typeof RegionSchema>;

/**
 * Where each regional chart lies on the body (`acucraft/body-map@1`): what a practitioner standing beside the couch
 * can reach. `axial` is the fraction of the patient's height from the vertex (0) to the soles (1) at which the region
 * is centred; `lateral` the distance (m) of its left or right site from the body's midline with the patient lying
 * (a midline site is on the midline). The engine places a site on the couch from the patient's height and position;
 * a point further than an arm's reach from where the practitioner stands cannot be palpated, marked or needled.
 */
export const BodyMapSchema = z
  .object({
    schema: z.literal(BODY_MAP_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    review: ReviewSchema,
    regions: z.record(IdSchema, z.object({ axial: z.number().min(0).max(1), lateral: z.number().min(0).max(0.6) }).strict()),
    notes: z.string().optional(),
  })
  .strict();
export type BodyMap = z.infer<typeof BodyMapSchema>;
