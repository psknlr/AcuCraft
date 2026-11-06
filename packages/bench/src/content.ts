import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue } from "@clinicalcraft/core";
import {
  AcupointsFileSchema,
  ClinicSchema,
  EvidenceFileSchema,
  RegionSchema,
  RolesFileSchema,
  RuleSetSchema,
  StandardsFileSchema,
  VocabularySchema,
  resolveScenario,
  type ContentBundle,
  type Scenario,
  type ScenarioSource,
} from "@acucraft/core";
import type { ZodTypeAny } from "zod";

/**
 * Load an AcuCraft content pack from disk (Node). Every JSON file is identified by its `schema` field, wherever it
 * lies; families are the directories holding an `acucraft/family@1` file. Pure resolution happens in @acucraft/core.
 */

export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL("../../../content", import.meta.url));

export interface FamilyEntry {
  id: string;
  dir: string;
  source: ScenarioSource;
  variantIds: string[];
  split: "dev" | "held-out";
}

export interface ContentPack {
  dir: string;
  bundle: ContentBundle;
  families: Map<string, FamilyEntry>;
  /** Other files by schema id (benchmark suites …). */
  extra: Map<string, { path: string; json: unknown }[]>;
  issues: Issue[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "solutions") out.push(...walk(p));
    }
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadContentPack(dir: string = DEFAULT_CONTENT_DIR): ContentPack {
  const issues: Issue[] = [];
  const files = walk(dir);
  const bundle: ContentBundle = {
    standards: { schema: "acucraft/standards@1", version: "0.0.0", editions: [], differences: [] } as never,
    acupoints: new Map(),
    regions: new Map(),
    roles: new Map(),
    ruleSets: [],
    evidence: [],
    clinics: new Map(),
    vocabulary: null as never,
  };
  const families = new Map<string, FamilyEntry>();
  const extra = new Map<string, { path: string; json: unknown }[]>();
  const parse = <T>(schema: ZodTypeAny, path: string, json: unknown): T | null => {
    const r = schema.safeParse(json);
    if (r.success) return r.data as T;
    for (const i of r.error.issues) issues.push({ path: `${relative(dir, path)}:${i.path.join(".")}`, message: i.message, severity: "error" });
    return null;
  };
  for (const path of files) {
    let json: unknown;
    try {
      json = readJson(path);
    } catch (e) {
      issues.push({ path: relative(dir, path), message: `not valid JSON: ${(e as Error).message}`, severity: "error" });
      continue;
    }
    const schema = (json as { schema?: unknown })?.schema;
    switch (schema) {
      case "acucraft/standards@1": {
        const v = parse<ContentBundle["standards"]>(StandardsFileSchema, path, json);
        if (v) bundle.standards = v;
        break;
      }
      case "acucraft/acupoints@1": {
        const v = parse<{ points: ContentBundle["acupoints"] extends Map<string, infer P> ? P[] : never }>(AcupointsFileSchema, path, json);
        for (const p of v?.points ?? []) {
          if (bundle.acupoints.has(p.id)) issues.push({ path: relative(dir, path), message: `duplicate point ${p.id}`, severity: "error" });
          bundle.acupoints.set(p.id, p);
        }
        break;
      }
      case "acucraft/region@1": {
        const v = parse<ContentBundle["regions"] extends Map<string, infer R> ? R : never>(RegionSchema, path, json);
        if (v) bundle.regions.set(v.id, v);
        break;
      }
      case "acucraft/roles@1": {
        const v = parse<ContentBundle["roles"] extends Map<string, infer R> ? R : never>(RolesFileSchema, path, json);
        if (v) bundle.roles.set(v.id, v);
        break;
      }
      case "acucraft/ruleset@1": {
        const v = parse<ContentBundle["ruleSets"][number]>(RuleSetSchema, path, json);
        if (v) bundle.ruleSets.push(v);
        break;
      }
      case "acucraft/evidence@1": {
        const v = parse<{ records: ContentBundle["evidence"] }>(EvidenceFileSchema, path, json);
        if (v) bundle.evidence.push(...v.records);
        break;
      }
      case "acucraft/clinic@1": {
        const v = parse<ContentBundle["clinics"] extends Map<string, infer C> ? C : never>(ClinicSchema, path, json);
        if (v) bundle.clinics.set(v.id, v);
        break;
      }
      case "acucraft/vocabulary@1": {
        const v = parse<ContentBundle["vocabulary"]>(VocabularySchema, path, json);
        if (v) bundle.vocabulary = v;
        break;
      }
      case "acucraft/family@1": {
        const fam = json as { id: string; case?: string; field?: string; split?: "dev" | "held-out"; variants?: { id: string; file?: string }[] };
        const fdir = dirname(path);
        try {
          const variants = new Map<string, unknown>();
          for (const v of fam.variants ?? []) {
            const variant = readJson(join(fdir, v.file ?? `variants/${v.id}.json`)) as { field?: Record<string, unknown> };
            // a variant's reference trajectory lives in solutions/<variant>.json (kept apart: it is long and hidden)
            const sol = join(fdir, "solutions", `${v.id}.json`);
            if (existsSync(sol)) variant.field = { ...(variant.field ?? {}), solution: readJson(sol) };
            variants.set(v.id, variant);
          }
          families.set(fam.id, {
            id: fam.id,
            dir: fdir,
            source: { family: json, case: readJson(join(fdir, fam.case ?? "case.json")), field: readJson(join(fdir, fam.field ?? "field.json")), variants },
            variantIds: (fam.variants ?? []).map((v) => v.id),
            split: fam.split ?? "dev",
          });
        } catch (e) {
          issues.push({ path: relative(dir, path), message: `family files: ${(e as Error).message}`, severity: "error" });
        }
        break;
      }
      case "acucraft/variant@1":
      case "acucraft/field@1":
      case undefined:
        break; // read through their family (or a case.json: no schema of ours)
      default: {
        if (typeof schema === "string" && schema.startsWith("clinicalcraft/")) break;
        const list = extra.get(String(schema)) ?? [];
        list.push({ path, json });
        extra.set(String(schema), list);
      }
    }
  }
  if (!bundle.vocabulary) issues.push({ path: "", message: "no acucraft/vocabulary@1 file", severity: "error" });
  if (bundle.standards.editions.length === 0) issues.push({ path: "", message: "no acucraft/standards@1 file", severity: "error" });
  checkBundle(bundle, issues);
  return { dir, bundle, families, extra, issues };
}

/** Cross-file checks of the knowledge base: point regions, landmarks and segments, editions. */
function checkBundle(b: ContentBundle, issues: Issue[]): void {
  const editions = new Set(b.standards.editions.map((e) => e.id));
  for (const p of b.acupoints.values()) {
    const at = `acupoints.${p.id}`;
    for (const c of p.codes) if (!editions.has(c.edition)) issues.push({ path: at, message: `unknown edition ${c.edition}`, severity: "error" });
    if (!editions.has(p.location.edition)) issues.push({ path: at, message: `unknown edition ${p.location.edition}`, severity: "error" });
    if (!p.region) continue;
    const r = b.regions.get(p.region);
    if (!r) {
      issues.push({ path: at, message: `unknown region ${p.region}`, severity: "error" });
      continue;
    }
    const lms = new Set(r.landmarks.map((l) => l.id));
    const segs = new Set(r.segments.map((s) => s.id));
    const sides = r.laterality === "midline" && p.bilateral ? ["left", "right"] : ["x"];
    const lmOk = (id: string) => sides.every((side) => lms.has(id.replace("{side}", side)));
    const loc = p.localisation;
    const used = !loc ? [] : loc.method === "landmark" ? [loc.landmark] : loc.method === "between" ? [loc.a, loc.b] : [loc.from, loc.toward];
    for (const id of used) if (!lmOk(id)) issues.push({ path: at, message: `region ${r.id} has no landmark ${id}`, severity: "error" });
    const dists = [loc && loc.method === "along" ? loc.distance : undefined, loc?.offset?.lateral, loc?.offset?.medial, loc?.offset?.cranial, loc?.offset?.caudal, p.tolerance];
    for (const d of dists) if (d && "segment" in d && !segs.has(d.segment)) issues.push({ path: at, message: `region ${r.id} has no segment ${d.segment}`, severity: "error" });
    if (p.configuration && !r.configurations.some((c) => c.id === p.configuration)) issues.push({ path: at, message: `region ${r.id} has no configuration ${p.configuration}`, severity: "error" });
  }
  for (const r of b.regions.values()) {
    const lms = new Set(r.landmarks.map((l) => l.id));
    const cfgs = new Set(r.configurations.map((c) => c.id));
    for (const s of r.segments) for (const id of [s.from, s.to]) if (!lms.has(id)) issues.push({ path: `regions.${r.id}.segments.${s.id}`, message: `no landmark ${id}`, severity: "error" });
    for (const a of r.access) if (!cfgs.has(a.configuration)) issues.push({ path: `regions.${r.id}.access`, message: `no configuration ${a.configuration}`, severity: "error" });
    if (!cfgs.has(r.defaultConfiguration)) issues.push({ path: `regions.${r.id}.defaultConfiguration`, message: `no configuration ${r.defaultConfiguration}`, severity: "error" });
  }
}

export type ScenarioResult = { ok: true; scenario: Scenario; warnings: Issue[] } | { ok: false; issues: Issue[] };

/** Resolve one scenario instance (`family/variant`). */
export function loadScenario(pack: ContentPack, id: string): ScenarioResult {
  const [familyId, variantId] = id.split("/");
  const fam = pack.families.get(familyId ?? "");
  if (!fam) return { ok: false, issues: [{ path: "", message: `unknown family ${familyId}`, severity: "error" }] };
  return resolveScenario(pack.bundle, fam.source, variantId ?? fam.variantIds[0]!);
}

/** Every scenario instance id of the pack, family by family. */
export function scenarioIds(pack: ContentPack, split?: "dev" | "held-out"): string[] {
  return [...pack.families.values()].filter((f) => !split || f.split === split).flatMap((f) => f.variantIds.map((v) => `${f.id}/${v}`));
}

export function requireScenario(pack: ContentPack, id: string): Scenario {
  const r = loadScenario(pack, id);
  if (!r.ok) throw new Error(`scenario ${id}: ${r.issues.filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return r.scenario;
}
