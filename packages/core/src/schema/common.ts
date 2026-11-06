import { z } from "zod";
import { IdSchema, LocalizedTextSchema } from "@clinicalcraft/core";

/**
 * Shared vocabulary of the AcuCraft schemas. Ids and localised text are ClinicalCraft's own
 * (`IdSchema`, `LocalizedTextSchema`), so an AcuCraft file and a ClinicalCraft case read the same way.
 */
export { IdSchema, LocalizedTextSchema };

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "semver x.y.z");

/**
 * How far a piece of content has been checked. AcuCraft states it on every file that carries clinical,
 * anatomical or regulatory content, in ClinicalCraft's words (`provenance.review` of a case):
 * `unreviewed`; `editorial` (checked against the cited source by the content team, not by a licensed
 * practitioner); `expert-reviewed` (reviewed by a qualified acupuncture, anatomy or regulatory expert).
 */
export const ReviewSchema = z
  .object({
    status: z.enum(["unreviewed", "editorial", "expert-reviewed"]),
    reviewedAt: DateSchema.optional(),
    reviewers: z.array(z.string()).default([]),
    notes: z.string().optional(),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;

/** Where a statement comes from. `verified: false` — the citation could not be checked against the source yet. */
export const SourceRefSchema = z
  .object({
    title: z.string().min(1),
    publisher: z.string().optional(),
    edition: z.string().optional(),
    publishedAt: z.string().optional(),
    url: z.string().optional(),
    locator: z.string().optional(),
    verified: z.boolean().default(false),
    note: z.string().optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Sides of the body. `midline` points (GV, CV) have no side. */
export const SideSchema = z.enum(["left", "right", "midline"]);
export type Side = z.infer<typeof SideSchema>;

/**
 * Patient positions on the treatment couch or chair. A position decides which regions are reachable and
 * which configuration a region is in (`knee-flexed` with a bolster under the knees, `prone` …).
 */
export const POSITIONS = ["standing", "seated", "seated-forward", "supine", "supine-knee-flexed", "prone", "side-lying-left", "side-lying-right"] as const;
export const PositionSchema = z.enum(POSITIONS);
export type Position = z.infer<typeof PositionSchema>;

/** A distance on the body: in proportional (B-cun) units of a named segment, or in centimetres. */
export const DistanceSchema = z.union([
  z.object({ cun: z.number().min(0), segment: IdSchema }).strict(),
  z.object({ cm: z.number().min(0) }).strict(),
]);
export type Distance = z.infer<typeof DistanceSchema>;

/** A point on a region's surface chart, in centimetres (`u` across, `v` along: see docs/ANATOMY.md). */
export const ChartPointSchema = z.object({ u: z.number(), v: z.number() }).strict();
export type ChartPoint = z.infer<typeof ChartPointSchema>;

/** A point inside a region: chart position plus depth below the skin surface (cm). */
export const ChartPoint3Schema = z.object({ u: z.number(), v: z.number(), d: z.number().min(0) }).strict();
export type ChartPoint3 = z.infer<typeof ChartPoint3Schema>;

export const SeveritySchema = z.enum(["critical", "major", "minor"]);
export type Severity = z.infer<typeof SeveritySchema>;
