import { checkCaseIntegrity, parseCase, type CaseDefinition, type Issue } from "@clinicalcraft/core";
import type { Region } from "../schema/anatomy.js";
import { FamilySchema, FieldSchema, VariantSchema, type Family, type FieldCondition, type FieldDefinition, type Variant, type Vocabulary } from "../schema/field.js";
import type { Clinic, EvidenceRecord, RolesFile, RuleSet } from "../schema/governance.js";
import type { AcupointDefinition, StandardsFile } from "../schema/knowledge.js";
import { ActionRequestSchema } from "../schema/actions.js";
import { applyPatch } from "./util.js";

/** Everything a content pack provides besides its scenario families (loaded by the Node loader in @acucraft/bench). */
export interface ContentBundle {
  standards: StandardsFile;
  acupoints: Map<string, AcupointDefinition>;
  regions: Map<string, Region>;
  roles: Map<string, RolesFile>;
  ruleSets: RuleSet[];
  evidence: EvidenceRecord[];
  clinics: Map<string, Clinic>;
  vocabulary: Vocabulary;
}

/** One playable scenario instance: a family's case and field with one variant laid over them. */
export interface Scenario {
  /** `<family>/<variant>` */
  id: string;
  family: Family;
  variant: Variant;
  case: CaseDefinition;
  field: FieldDefinition;
  bundle: ContentBundle;
  clinic: Clinic;
  roles: RolesFile;
  /** Rule sets in force per visit (by the visit's date). */
  rules: Map<number, RuleSet[]>;
}

export interface ScenarioSource {
  family: unknown;
  case: unknown;
  field: unknown;
  /** The variant files of the family, by id. */
  variants: Map<string, unknown>;
}

export type ResolveResult = { ok: true; scenario: Scenario; warnings: Issue[] } | { ok: false; issues: Issue[] };

const err = (path: string, message: string): Issue => ({ path, message, severity: "error" });
const warn = (path: string, message: string): Issue => ({ path, message, severity: "warning" });

function zodIssues(prefix: string, error: { issues: { path: (string | number)[]; message: string }[] }): Issue[] {
  return error.issues.map((i) => err([prefix, ...i.path].filter((p) => p !== "").join("."), i.message));
}

/** The rule set of `series` in effect on `date` (the latest effectiveFrom ≤ date, not past effectiveUntil). */
export function ruleSetInForce(ruleSets: readonly RuleSet[], series: string, date: string): RuleSet | null {
  const candidates = ruleSets.filter((r) => r.series === series && r.effectiveFrom <= date && (!r.effectiveUntil || date < r.effectiveUntil));
  candidates.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0] ?? null;
}

/** Every version of a series, oldest first (shown so a scenario names the versions around its date). */
export function ruleSeries(ruleSets: readonly RuleSet[], series: string): RuleSet[] {
  return ruleSets.filter((r) => r.series === series).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/** Resolve and validate a scenario instance. Nothing is loaded from disk here: the source is plain JSON. */
export function resolveScenario(bundle: ContentBundle, source: ScenarioSource, variantId: string): ResolveResult {
  const fam = FamilySchema.safeParse(source.family);
  if (!fam.success) return { ok: false, issues: zodIssues("family", fam.error) };
  const family = fam.data;
  if (!family.variants.some((v) => v.id === variantId)) return { ok: false, issues: [err("variant", `family ${family.id} has no variant ${variantId}`)] };
  const rawVariant = source.variants.get(variantId);
  const vr = VariantSchema.safeParse(rawVariant);
  if (!vr.success) return { ok: false, issues: zodIssues(`variants.${variantId}`, vr.error) };
  const variant = vr.data;
  if (variant.id !== variantId) return { ok: false, issues: [err(`variants.${variantId}.id`, `the variant file declares id ${variant.id}`)] };

  const caseJson = applyPatch(source.case, variant.case ?? {}) as Record<string, unknown>;
  // A ClinicalCraft case id cannot hold "/": the instance's case is `<family>.<variant>`.
  caseJson.id = `${family.id}.${variant.id}`;
  const parsedCase = parseCase(caseJson);
  if (!parsedCase.ok) return { ok: false, issues: parsedCase.issues.map((i) => ({ ...i, path: `case.${i.path}` })) };
  const caseDef = parsedCase.value;
  const warnings: Issue[] = parsedCase.warnings.map((i) => ({ ...i, path: `case.${i.path}` }));
  const integrity = checkCaseIntegrity(caseDef).map((i) => ({ ...i, path: `case.${i.path}` }));

  const fieldJson = applyPatch(source.field, variant.field ?? {});
  const fr = FieldSchema.safeParse(fieldJson);
  if (!fr.success) return { ok: false, issues: [...integrity.filter((i) => i.severity === "error"), ...zodIssues("field", fr.error)] };
  const field = fr.data;

  const clinic = bundle.clinics.get(field.clinic);
  const roles = bundle.roles.get(field.roles);
  const issues: Issue[] = [...integrity];
  if (!clinic) issues.push(err("field.clinic", `unknown clinic ${field.clinic}`));
  if (!roles) issues.push(err("field.roles", `unknown role configuration ${field.roles}`));
  const rules = new Map<number, RuleSet[]>();
  for (const visit of field.visits) {
    const inForce: RuleSet[] = [];
    for (const series of field.ruleSeries) {
      const rs = ruleSetInForce(bundle.ruleSets, series, visit.date);
      if (rs) inForce.push(rs);
      else if (ruleSeries(bundle.ruleSets, series).length === 0) issues.push(err("field.ruleSeries", `unknown rule series ${series}`));
      else issues.push(warn("field.ruleSeries", `no version of ${series} is in force on ${visit.date} (visit ${visit.index}): it does not apply yet`));
    }
    rules.set(visit.index, inForce);
  }
  if (clinic && roles) {
    const scenario: Scenario = { id: `${family.id}/${variant.id}`, family, variant, case: caseDef, field, bundle, clinic, roles, rules };
    issues.push(...checkField(scenario));
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) return { ok: false, issues };
    return { ok: true, scenario, warnings: [...warnings, ...issues] };
  }
  return { ok: false, issues };
}

/** Referential integrity of the field against the case, the clinic, the roles and the bundle. */
export function checkField(sc: Scenario): Issue[] {
  const { field, bundle, clinic, roles } = sc;
  const c = sc.case;
  const issues: Issue[] = [];
  const rooms = new Set(clinic.rooms.map((r) => r.id));
  const fixtures = new Set(clinic.rooms.flatMap((r) => r.fixtures.map((f) => f.id)));
  const roleIds = new Set(roles.roles.map((r) => r.id));
  const phases = new Set(c.phases.map((p) => p.id));
  const exam = new Set(c.exam.map((e) => e.id));
  const history = new Set(c.history.map((h) => h.id));
  const investigations = new Set(c.investigations.map((i) => i.id));
  const vocab = bundle.vocabulary;
  const diagnoses = new Set(vocab.diagnoses.map((d) => d.id));
  const patterns = new Set(vocab.patterns.map((p) => p.id));
  const redFlags = new Set(vocab.redFlags.map((r) => r.id));
  const referral = new Set(clinic.referralTargets.map((r) => r.id));

  field.visits.forEach((v, i) => {
    if (!phases.has(v.phase)) issues.push(err(`field.visits.${i}.phase`, `the case has no phase ${v.phase}`));
    if (v.index !== i + 1) issues.push(err(`field.visits.${i}.index`, "visits are numbered 1, 2, … in order"));
  });
  const castIds = new Set<string>();
  field.cast.forEach((m, i) => {
    if (castIds.has(m.id)) issues.push(err(`field.cast.${i}.id`, `duplicate cast id ${m.id}`));
    castIds.add(m.id);
    if (!roleIds.has(m.role)) issues.push(err(`field.cast.${i}.role`, `unknown role ${m.role} in ${roles.id}`));
    if (!rooms.has(m.location)) issues.push(err(`field.cast.${i}.location`, `unknown room ${m.location}`));
    if (m.agent === "npc" && !m.policy) issues.push(err(`field.cast.${i}.policy`, "an npc needs a policy"));
  });
  if (!field.cast.some((m) => m.agent === "under-test")) issues.push(err("field.cast", "no cast member is under test"));
  if (castIds.has(field.patient.id)) issues.push(err("field.patient.id", "the patient id collides with a cast id"));
  if (!rooms.has(field.patient.location)) issues.push(err("field.patient.location", `unknown room ${field.patient.location}`));
  field.equipment.packs.forEach((p, i) => {
    if (!fixtures.has(p.at)) issues.push(err(`field.equipment.packs.${i}.at`, `unknown fixture ${p.at}`));
  });
  field.regions.forEach((r, i) => {
    if (!bundle.regions.has(r)) issues.push(err(`field.regions.${i}`, `unknown region ${r}`));
  });
  for (const [regionId, sides] of Object.entries(field.patient.anatomy.regions)) {
    const region = bundle.regions.get(regionId);
    if (!region) {
      issues.push(err(`field.patient.anatomy.regions.${regionId}`, `unknown region ${regionId}`));
      continue;
    }
    const lms = new Set(region.landmarks.map((l) => l.id));
    const sts = new Set(region.structures.map((s) => s.id));
    for (const [side, a] of Object.entries(sides)) {
      if (!a) continue;
      for (const id of Object.keys(a.landmarks ?? {})) if (!lms.has(id)) issues.push(err(`field.patient.anatomy.regions.${regionId}.${side}.landmarks.${id}`, `region ${regionId} has no landmark ${id}`));
      for (const id of Object.keys(a.structures ?? {})) if (!sts.has(id)) issues.push(err(`field.patient.anatomy.regions.${regionId}.${side}.structures.${id}`, `region ${regionId} has no structure ${id}`));
    }
  }
  const checkRevealed = (path: string, id: string | undefined) => {
    if (id && !exam.has(id)) issues.push(err(path, `the case has no exam finding ${id}`));
  };
  field.patient.siteConditions.forEach((s, i) => {
    if (!field.regions.includes(s.region)) issues.push(err(`field.patient.siteConditions.${i}.region`, `region ${s.region} is not modelled in this scenario`));
    checkRevealed(`field.patient.siteConditions.${i}.revealedBy`, s.revealedBy);
    if ((s.centre === undefined) !== (s.radiusCm === undefined)) issues.push(err(`field.patient.siteConditions.${i}`, "give both centre and radiusCm, or neither (the whole region)"));
  });
  const ashi = new Set(field.patient.ashi.map((a) => a.id));
  field.patient.ashi.forEach((a, i) => {
    if (!field.regions.includes(a.region)) issues.push(err(`field.patient.ashi.${i}.region`, `region ${a.region} is not modelled in this scenario`));
    checkRevealed(`field.patient.ashi.${i}.revealedBy`, a.revealedBy);
  });

  const ev = field.evaluation;
  ev.diagnoses.expected.concat(ev.diagnoses.acceptable).forEach((d) => {
    if (!diagnoses.has(d)) issues.push(err("field.evaluation.diagnoses", `unknown diagnosis ${d}`));
  });
  ev.patterns.defensible.concat(ev.patterns.implausible).forEach((p) => {
    if (!patterns.has(p)) issues.push(err("field.evaluation.patterns", `unknown pattern ${p}`));
  });
  ev.redFlags.forEach((r, i) => {
    if (!redFlags.has(r.id)) issues.push(err(`field.evaluation.redFlags.${i}`, `unknown red flag ${r.id}`));
  });
  const pointKeys = [...ev.points.recommended, ...ev.points.acceptable];
  pointKeys.forEach((k) => {
    if (k.point && !bundle.acupoints.has(k.point)) issues.push(err("field.evaluation.points", `unknown point ${k.point}`));
    if (k.ashi && !ashi.has(k.ashi)) issues.push(err("field.evaluation.points", `unknown Ashi location ${k.ashi}`));
  });
  ev.points.avoid.forEach((a, i) => {
    if (a.point && !bundle.acupoints.has(a.point)) issues.push(err(`field.evaluation.points.avoid.${i}`, `unknown point ${a.point}`));
    if (a.region && !bundle.regions.has(a.region)) issues.push(err(`field.evaluation.points.avoid.${i}`, `unknown region ${a.region}`));
  });
  ev.required.history.forEach((h) => history.has(h) || issues.push(err("field.evaluation.required.history", `the case has no history item ${h}`)));
  ev.required.exam.forEach((h) => exam.has(h) || issues.push(err("field.evaluation.required.exam", `the case has no exam finding ${h}`)));
  ev.required.records.forEach((h) => investigations.has(h) || issues.push(err("field.evaluation.required.records", `the case has no investigation ${h}`)));

  const eventIds = new Set(field.events.map((e) => e.id));
  const conds: [string, FieldCondition][] = [
    ...field.events.map((e, i) => [`field.events.${i}.when`, e.when] as [string, FieldCondition]),
    ...ev.pathways.map((p, i) => [`field.evaluation.pathways.${i}.when`, p.when] as [string, FieldCondition]),
    ...ev.criticalErrors.map((p, i) => [`field.evaluation.criticalErrors.${i}.when`, p.when] as [string, FieldCondition]),
    ...(ev.followUp?.pathways ?? []).map((p, i) => [`field.evaluation.followUp.pathways.${i}.when`, p.when] as [string, FieldCondition]),
  ];
  for (const [path, cond] of conds) {
    walkCondition(cond, (leaf) => {
      if ("needled" in leaf) {
        if (leaf.needled.point && !bundle.acupoints.has(leaf.needled.point)) issues.push(err(path, `unknown point ${leaf.needled.point}`));
        if (leaf.needled.ashi && !ashi.has(leaf.needled.ashi)) issues.push(err(path, `unknown Ashi location ${leaf.needled.ashi}`));
      }
      if ("pattern" in leaf) for (const p of [leaf.pattern].flat()) if (!patterns.has(p)) issues.push(err(path, `unknown pattern ${p}`));
      if ("diagnosed" in leaf && !diagnoses.has(leaf.diagnosed)) issues.push(err(path, `unknown diagnosis ${leaf.diagnosed}`));
      if ("redFlag" in leaf && !redFlags.has(leaf.redFlag)) issues.push(err(path, `unknown red flag ${leaf.redFlag}`));
      if ("event" in leaf && !eventIds.has(leaf.event)) issues.push(err(path, `unknown field event ${leaf.event}`));
      if ("withdrawnAfter" in leaf && !eventIds.has(leaf.withdrawnAfter.event)) issues.push(err(path, `unknown field event ${leaf.withdrawnAfter.event}`));
      if ("respondedTo" in leaf && !eventIds.has(leaf.respondedTo.event)) issues.push(err(path, `unknown field event ${leaf.respondedTo.event}`));
      if ("referred" in leaf) for (const t of leaf.referred.to ?? []) if (!referral.has(t)) issues.push(err(path, `unknown referral target ${t}`));
    });
  }
  const checkSteps = (path: string, steps: readonly unknown[]) => {
    steps.forEach((s, i) => {
      const r = ActionRequestSchema.safeParse(s);
      if (!r.success) {
        issues.push(...zodIssues(`${path}.${i}`, r.error));
        return;
      }
      if (!castIds.has(r.data.actor)) issues.push(err(`${path}.${i}.actor`, `unknown actor ${r.data.actor}`));
    });
  };
  checkSteps("field.solution", field.solution);
  field.alternatives.forEach((a, i) => checkSteps(`field.alternatives.${i}.steps`, a.steps));
  if (field.solution.length === 0) issues.push(warn("field.solution", "no reference trajectory: the scenario cannot be verified"));
  return issues;
}

export function walkCondition(cond: FieldCondition, visit: (leaf: FieldCondition) => void): void {
  visit(cond);
  if ("all" in cond) cond.all.forEach((c) => walkCondition(c, visit));
  else if ("any" in cond) cond.any.forEach((c) => walkCondition(c, visit));
  else if ("not" in cond) walkCondition(cond.not, visit);
}

/** The role of a cast member (or `patient`). */
export function roleOf(sc: Scenario, actorId: string) {
  if (actorId === sc.field.patient.id) return sc.roles.roles.find((r) => r.kind === "patient") ?? null;
  const member = sc.field.cast.find((m) => m.id === actorId);
  return member ? (sc.roles.roles.find((r) => r.id === member.role) ?? null) : null;
}
