import { z } from "zod";
import type { Mode } from "@acucraft/core";
import { requireScenario, scenarioIds, type ContentPack } from "./content.js";
import { runEpisode, type EpisodeResult, type RunOptions } from "./runner.js";
import { clusterBootstrap, mean, wilson, type Proportion } from "./stats.js";
import type { AgentFactory } from "./agents/types.js";
import { NOTICE, type EncounterReport } from "./evaluate.js";

export const SUITE_SCHEMA_ID = "acucraft/suite@1" as const;

export const SuiteSchema = z
  .object({
    schema: z.literal(SUITE_SCHEMA_ID),
    id: z.string().min(1),
    description: z.string(),
    /** Families to include (default: every family of the pack). */
    families: z.array(z.string()).optional(),
    seeds: z.array(z.number().int()).min(1).default([1]),
    mode: z.enum(["assessment", "teaching"]).default("assessment"),
    maxSteps: z.number().int().positive().default(250),
  })
  .strict();
export type Suite = z.infer<typeof SuiteSchema>;

export interface SplitSummary {
  families: number;
  instances: number;
  episodes: number;
  primary: Proportion & { clusterCi: [number, number] | null };
  adjudicate: number;
  criticalFailures: Proportion;
  unsafeAttemptsPerEpisode: number | null;
  blockedUnsafePerEpisode: number | null;
  appropriateReferral: Proportion;
  inappropriateRefusal: Proportion;
  redFlagsOnEvidence: Proportion;
  initialVisit: Proportion;
  fullCourse: Proportion;
  tracks: Record<keyof EncounterReport["tracks"], number | null>;
  minutes: number | null;
  actions: number | null;
  rejectedActions: number | null;
  documentation: number | null;
  assistance: { teachingMode: number };
}

export interface SuiteResult {
  schema: "acucraft/suite-result@1";
  suite: string;
  agent: string;
  createdFor: string;
  splits: Record<"dev" | "held-out" | "all", SplitSummary>;
  byFamily: { family: string; split: string; episodes: number; success: number; criticalFailures: number }[];
  byVariantKind: { kind: string; episodes: number; success: number }[];
  episodes: (Pick<EpisodeResult, "scenario" | "seed" | "stopReason" | "steps" | "error"> & { report: EncounterReport })[];
  notice: string;
}

export async function runSuite(pack: ContentPack, suite: Suite, factory: AgentFactory, opts: Omit<RunOptions, "seed" | "mode" | "maxSteps"> & { split?: "dev" | "held-out" | "all"; onEpisode?: (e: EpisodeResult) => void } = {}): Promise<SuiteResult> {
  const ids = scenarioIds(pack).filter((id) => {
    const fam = id.split("/")[0]!;
    if (suite.families && !suite.families.includes(fam)) return false;
    if (opts.split && opts.split !== "all" && pack.families.get(fam)!.split !== opts.split) return false;
    return true;
  });
  const episodes: EpisodeResult[] = [];
  for (const id of ids) {
    const sc = requireScenario(pack, id);
    for (const seed of suite.seeds) {
      const e = await runEpisode(sc, factory(id), { ...opts, seed, mode: suite.mode as Mode, maxSteps: suite.maxSteps });
      opts.onEpisode?.(e);
      episodes.push(e);
    }
  }
  return summarise(suite.id, episodes[0]?.agent ?? "none", episodes.map((e) => ({ scenario: e.scenario, seed: e.seed, stopReason: e.stopReason, steps: e.steps, ...(e.error ? { error: e.error } : {}), report: e.report })));
}

export function summarise(suite: string, agent: string, episodes: SuiteResult["episodes"]): SuiteResult {
  const split = (which: "dev" | "held-out" | "all"): SplitSummary => {
    const eps = episodes.filter((e) => which === "all" || e.report.split === which);
    const byFamily = new Map<string, boolean[]>();
    for (const e of eps) byFamily.set(e.report.family, [...(byFamily.get(e.report.family) ?? []), e.report.primary.success]);
    const success = eps.filter((e) => e.report.primary.success).length;
    const boot = clusterBootstrap(byFamily);
    const redFlag = eps.filter((e) => e.report.referral.appropriateReferral !== null);
    const noRedFlag = eps.filter((e) => e.report.referral.redFlagsPresent.length === 0);
    const unsafe = eps.map((e) => e.report.unsafe.total);
    const blocked = eps.map((e) => Object.values(e.report.unsafe.blocked).reduce((a, b) => a + b, 0));
    const track = (k: keyof EncounterReport["tracks"]) => mean(eps.map((e) => e.report.tracks[k].score).filter((x): x is number => x !== null));
    return {
      families: byFamily.size,
      instances: new Set(eps.map((e) => e.scenario)).size,
      episodes: eps.length,
      primary: { ...wilson(success, eps.length), clusterCi: boot.ci },
      adjudicate: eps.filter((e) => e.report.primary.status === "adjudicate").length,
      criticalFailures: wilson(eps.filter((e) => e.report.criticalErrors.length > 0).length, eps.length),
      unsafeAttemptsPerEpisode: mean(unsafe),
      blockedUnsafePerEpisode: mean(blocked),
      appropriateReferral: wilson(redFlag.filter((e) => e.report.referral.appropriateReferral).length, redFlag.length),
      inappropriateRefusal: wilson(noRedFlag.filter((e) => e.report.referral.inappropriateRefusal).length, noRedFlag.length),
      redFlagsOnEvidence: wilson(eps.filter((e) => e.report.outcomes.redFlagsOnEvidence === true).length, eps.filter((e) => e.report.outcomes.redFlagsOnEvidence !== null).length),
      initialVisit: wilson(eps.filter((e) => e.report.outcomes.initialVisit).length, eps.length),
      fullCourse: wilson(eps.filter((e) => e.report.outcomes.fullCourse === true).length, eps.filter((e) => e.report.outcomes.fullCourse !== null).length),
      tracks: { reasoning: track("reasoning"), localisation: track("localisation"), procedure: track("procedure"), collaboration: track("collaboration"), followUp: track("followUp") },
      minutes: mean(eps.map((e) => e.report.efficiency.minutes)),
      actions: mean(eps.map((e) => e.report.efficiency.agentActions)),
      rejectedActions: mean(eps.map((e) => e.report.efficiency.rejected)),
      documentation: mean(eps.map((e) => e.report.documentation.completeness).filter((x): x is number => x !== null)),
      assistance: { teachingMode: eps.filter((e) => e.report.assistance.teachingMode).length },
    };
  };
  const fams = [...new Set(episodes.map((e) => e.report.family))];
  const kinds = [...new Set(episodes.map((e) => e.report.variantKind))];
  return {
    schema: "acucraft/suite-result@1",
    suite,
    agent,
    createdFor: "AcuCraft benchmark report",
    splits: { dev: split("dev"), "held-out": split("held-out"), all: split("all") },
    byFamily: fams.map((f) => {
      const eps = episodes.filter((e) => e.report.family === f);
      return { family: f, split: eps[0]!.report.split, episodes: eps.length, success: eps.filter((e) => e.report.primary.success).length, criticalFailures: eps.filter((e) => e.report.criticalErrors.length > 0).length };
    }),
    byVariantKind: kinds.map((k) => {
      const eps = episodes.filter((e) => e.report.variantKind === k);
      return { kind: k, episodes: eps.length, success: eps.filter((e) => e.report.primary.success).length };
    }),
    episodes,
    notice: NOTICE,
  };
}

const pct = (p: Proportion | (Proportion & { clusterCi: [number, number] | null })) =>
  p.p === null ? "—" : `${p.k}/${p.n} (${Math.round(p.p * 100)}%${p.ci ? `, 95% CI ${Math.round(p.ci[0] * 100)}–${Math.round(p.ci[1] * 100)}%` : ""})`;
const num = (x: number | null, d = 2) => (x === null ? "—" : x.toFixed(d));

/** A Markdown report of a suite result. */
export function suiteMarkdown(r: SuiteResult): string {
  const lines: string[] = [`# AcuCraft benchmark — ${r.suite}`, "", `Agent: **${r.agent}**`, "", `> ${r.notice}`, ""];
  lines.push("## Primary endpoint", "", "Encounters that complete an acceptable clinical pathway without a predefined critical behavioural error.", "");
  lines.push("| split | families | instances | episodes | success (Wilson 95% CI) | family-cluster bootstrap 95% CI | adjudicate |", "|---|---|---|---|---|---|---|");
  for (const k of ["dev", "held-out", "all"] as const) {
    const s = r.splits[k];
    lines.push(`| ${k} | ${s.families} | ${s.instances} | ${s.episodes} | ${pct(s.primary)} | ${s.primary.clusterCi ? `${Math.round(s.primary.clusterCi[0] * 100)}–${Math.round(s.primary.clusterCi[1] * 100)}%` : "—"} | ${s.adjudicate} |`);
  }
  lines.push("", "The held-out sample is a handful of independent case families: a feasibility-scale result, not a ranking.", "");
  lines.push("## Reported separately", "", "| measure | dev | held-out | all |", "|---|---|---|---|");
  const row = (label: string, f: (s: SplitSummary) => string) => lines.push(`| ${label} | ${f(r.splits.dev)} | ${f(r.splits["held-out"])} | ${f(r.splits.all)} |`);
  row("critical failures", (s) => pct(s.criticalFailures));
  row("unsafe attempts per episode (executed + blocked)", (s) => num(s.unsafeAttemptsPerEpisode));
  row("blocked unsafe attempts per episode", (s) => num(s.blockedUnsafePerEpisode));
  row("appropriate referral (red-flag scenarios)", (s) => pct(s.appropriateReferral));
  row("inappropriate refusal (no red flag)", (s) => pct(s.inappropriateRefusal));
  row("red flags recognised on evidence the learner had (red-flag scenarios)", (s) => pct(s.redFlagsOnEvidence));
  row("first visit managed acceptably and safely", (s) => pct(s.initialVisit));
  row("planned course completed (only where the pathway calls for another visit)", (s) => pct(s.fullCourse));
  row("simulated minutes", (s) => num(s.minutes, 1));
  row("agent actions", (s) => num(s.actions, 1));
  row("rejected or blocked actions", (s) => num(s.rejectedActions, 1));
  row("documentation completeness (STRICTA-informed)", (s) => num(s.documentation));
  row("teaching-mode assistance (episodes)", (s) => String(s.assistance.teachingMode));
  lines.push("", "## Tracks (mean item score)", "", "| track | dev | held-out | all |", "|---|---|---|---|");
  for (const t of ["reasoning", "localisation", "procedure", "collaboration", "followUp"] as const) row(t, (s) => num(s.tracks[t]));
  lines.push("", "## By family", "", "| family | split | episodes | success | critical failures |", "|---|---|---|---|---|");
  for (const f of r.byFamily) lines.push(`| ${f.family} | ${f.split} | ${f.episodes} | ${f.success} | ${f.criticalFailures} |`);
  lines.push("", "## By variant kind", "", "| kind | episodes | success |", "|---|---|---|");
  for (const k of r.byVariantKind) lines.push(`| ${k.kind} | ${k.episodes} | ${k.success} |`);
  lines.push("", "## Episodes", "", "| scenario | seed | stop | status | pathway | critical errors | unsafe | reasoning | localisation | procedure | collaboration | follow-up |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const e of r.episodes) {
    const t = e.report.tracks;
    lines.push(`| ${e.scenario} | ${e.seed} | ${e.stopReason} | ${e.report.primary.status} | ${e.report.primary.pathway ?? "—"} | ${e.report.criticalErrors.map((c) => c.id).join(", ") || "—"} | ${e.report.unsafe.total} | ${num(t.reasoning.score)} | ${num(t.localisation.score)} | ${num(t.procedure.score)} | ${num(t.collaboration.score)} | ${num(t.followUp.score)} |`);
  }
  return `${lines.join("\n")}\n`;
}
