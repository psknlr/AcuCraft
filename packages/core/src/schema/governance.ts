import { z } from "zod";
import { DateSchema, IdSchema, ReviewSchema, SemverSchema, SeveritySchema, SourceRefSchema } from "./common.js";

/**
 * Jurisdiction configuration (proposal §3): professional roles and their permissions, versioned rule sets with
 * effective dates, guideline evidence records and the simulated clinic.
 */

export const ROLES_SCHEMA_ID = "acucraft/roles@1" as const;
export const RULESET_SCHEMA_ID = "acucraft/ruleset@1" as const;
export const EVIDENCE_SCHEMA_ID = "acucraft/evidence@1" as const;
export const CLINIC_SCHEMA_ID = "acucraft/clinic@1" as const;

/** What an actor may do. Every action names the permission it needs (`ACTION_PERMISSIONS` in the engine). */
export const PERMISSIONS = [
  "communicate",
  "consult",
  "examine",
  "assess",
  "plan",
  "seek-consent",
  "review-records",
  "order-investigation",
  "refer",
  "position-patient",
  "move",
  "hand-hygiene",
  "fetch",
  "handle-equipment",
  "open-pack",
  "prepare-site",
  "localise",
  "insert-needle",
  "manipulate-needle",
  "remove-needle",
  "apply-pressure",
  "dispose-sharps",
  "count-needles",
  "search",
  "monitor",
  "record-vitals",
  "delegate",
  "accept-task",
  "supervise",
  "document",
  "report-incident",
  "end-visit",
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

export const GrantSchema = z.union([
  PermissionSchema,
  z
    .object({
      permission: PermissionSchema,
      /** `supervisor-present`: a supervisor actor is in the same room; `supervisor-approval`: and approved the plan. */
      requires: z.enum(["supervisor-present", "supervisor-approval"]),
    })
    .strict(),
]);
export type Grant = z.infer<typeof GrantSchema>;

export const RoleSchema = z
  .object({
    id: IdSchema,
    label: z.string(),
    kind: z.enum(["practitioner", "learner", "support", "supervisor", "patient"]),
    /** The registration or qualification the role stands for, in the jurisdiction's words. */
    registration: z.string().optional(),
    grants: z.array(GrantSchema).default([]),
    /** Task kinds this role may be assigned (delegation, §7.1). */
    acceptsTasks: z.array(IdSchema).default([]),
  })
  .strict();
export type Role = z.infer<typeof RoleSchema>;

export const RolesFileSchema = z
  .object({
    schema: z.literal(ROLES_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    jurisdiction: z.string().min(2),
    effectiveFrom: DateSchema,
    sources: z.array(SourceRefSchema).default([]),
    review: ReviewSchema,
    roles: z.array(RoleSchema).min(1),
  })
  .strict();
export type RolesFile = z.infer<typeof RolesFileSchema>;

/**
 * Machine-checkable rule kinds. The engine implements each (`engine/rules.ts`); a rule set encodes a source
 * document as a list of these with the paraphrase it was derived from.
 */
export const RuleCheckSchema = z.discriminatedUnion("kind", [
  /** A needle inserted must be single-use, sterile, from a sealed in-date pack, and never inserted before. */
  z.object({ kind: z.literal("single-use-sterile-needle") }).strict(),
  /** Hand hygiene after the actor last soiled their hands, before these actions. */
  z.object({ kind: z.literal("hand-hygiene-before"), actions: z.array(IdSchema).min(1) }).strict(),
  /** The needling site was prepared (skin cleaned) before insertion. */
  z.object({ kind: z.literal("site-preparation-before-insertion") }).strict(),
  /**
   * No needle in these regions while the patient has the risk factor (for pregnancy, from `fromGestationWeek`; an
   * unknown gestation counts as reached). Judged by where the needle goes: a named point, an Ashi point or a bare
   * chart position alike.
   */
  z.object({ kind: z.literal("avoid-regions"), riskFactor: IdSchema, regions: z.array(IdSchema).min(1), fromGestationWeek: z.number().min(0).optional() }).strict(),
  /** Consent to the current plan, given and not withdrawn, before insertion. */
  z.object({ kind: z.literal("consent-before-treatment") }).strict(),
  /** Withdrawn and unused opened needles go into a sharps container (never back to the tray), by the end of the visit. */
  z.object({ kind: z.literal("sharps-disposal") }).strict(),
  /** Needles are counted and reconciled before the visit ends. */
  z.object({ kind: z.literal("needle-count-before-completion") }).strict(),
  /** The treatment record holds these fields before the visit ends. */
  z.object({ kind: z.literal("treatment-record"), fields: z.array(IdSchema).min(1) }).strict(),
  /** The patient is observed at least every `maxGapMinutes` while needles are retained. */
  z.object({ kind: z.literal("patient-monitoring"), maxGapMinutes: z.number().positive() }).strict(),
]);
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const RuleSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    /** The paraphrase of the source provision the rule was derived from. */
    summary: z.string(),
    severity: SeveritySchema,
    /** `block`: the engine refuses the action (a protective intervention, recorded); `record`: executed and recorded. */
    enforcement: z.enum(["block", "record"]).default("record"),
    check: RuleCheckSchema,
    /** Roles the rule applies to (default: the rule set's). */
    appliesTo: z.array(IdSchema).optional(),
    locator: z.string().optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

export const RuleSetSchema = z
  .object({
    schema: z.literal(RULESET_SCHEMA_ID),
    id: IdSchema,
    /** Rule sets with the same `series` are versions of one obligation: the one in effect on the encounter date applies. */
    series: IdSchema,
    version: z.string().min(1),
    title: z.string(),
    jurisdiction: z.string().min(2),
    publisher: z.string(),
    publishedAt: DateSchema.optional(),
    effectiveFrom: DateSchema,
    effectiveUntil: DateSchema.optional(),
    appliesTo: z.array(IdSchema).min(1),
    source: SourceRefSchema,
    review: ReviewSchema,
    /** How much of the source is encoded as rules: `not-encoded` sets carry metadata only (no rule is checked). */
    encoding: z.enum(["encoded", "partial", "not-encoded"]),
    rules: z.array(RuleSchema).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.encoding === "not-encoded" && r.rules.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rules"], message: "a not-encoded rule set carries no rules" });
    if (r.effectiveUntil && r.effectiveUntil <= r.effectiveFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveUntil"], message: "effectiveUntil must follow effectiveFrom" });
  });
export type RuleSet = z.infer<typeof RuleSetSchema>;

export const EvidenceRecordSchema = z
  .object({
    id: IdSchema,
    guideline: z.string(),
    publisher: z.string(),
    version: z.string(),
    jurisdiction: z.string(),
    condition: IdSchema,
    intervention: z.string(),
    /** The recommendation's direction and strength, in the guideline's own terms. */
    direction: z.enum(["against", "conditional-against", "no-recommendation", "conditional-for", "consider", "for"]),
    statement: z.string(),
    source: SourceRefSchema,
  })
  .strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceFileSchema = z
  .object({ schema: z.literal(EVIDENCE_SCHEMA_ID), id: IdSchema, version: SemverSchema, review: ReviewSchema, records: z.array(EvidenceRecordSchema).min(1) })
  .strict();
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

/** What a fixture of the clinic is for: the engine's rules name kinds, never ids. */
export const FIXTURE_KINDS = ["couch", "chair", "hand-hygiene", "sharps-container", "supplies", "trolley", "records-terminal", "screen"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** A point on the clinic floor, in metres, in the facility's frame (+x east, +z south). */
export const FloorPointSchema = z.object({ x: z.number(), z: z.number() }).strict();
export type FloorPoint = z.infer<typeof FloorPointSchema>;

export const ClinicSchema = z
  .object({
    schema: z.literal(CLINIC_SCHEMA_ID),
    id: IdSchema,
    version: SemverSchema,
    title: z.string(),
    jurisdiction: z.string().min(2),
    languages: z.object({ primary: z.string(), secondary: z.array(z.string()).default([]) }).strict(),
    /**
     * The clinic's floor plan: a ClinicalCraft facility (`clinicalcraft/facility@1`) of the content pack. Every room
     * here is a room of that facility with the same id, and every fixture stands on one of its placements, so the
     * engine plans walks, reach and lines of sight on the building ClinicalCraft's front-ends draw (docs/WORLD.md).
     */
    facility: IdSchema,
    rooms: z
      .array(
        z
          .object({
            id: IdSchema,
            label: z.string(),
            kind: z.enum(["reception", "consult", "treatment", "preparation", "corridor"]),
            /** Where a member of staff who is "in the room" stands: a free spot of the floor plan. */
            home: FloorPointSchema,
            /** Fixtures in the room: couches, chairs, sinks, sharps containers, supply shelves, a records terminal. */
            fixtures: z
              .array(
                z
                  .object({
                    id: IdSchema,
                    kind: z.enum(FIXTURE_KINDS),
                    label: z.string(),
                    /** The facility placement the fixture is (two fixtures may share one: the sharps box on the trolley). */
                    placement: IdSchema,
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
    /** Items the clinic stocks, fetched from a supplies fixture. */
    supplies: z.array(z.object({ id: IdSchema, label: z.string(), at: IdSchema }).strict()).default([]),
    referralTargets: z.array(z.object({ id: IdSchema, label: z.string(), kind: z.enum(["emergency", "medical", "specialist", "allied-health", "tcm"]) }).strict()).default([]),
    notes: z.string().optional(),
  })
  .strict();
export type Clinic = z.infer<typeof ClinicSchema>;
