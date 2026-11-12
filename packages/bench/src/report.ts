import type { EncounterReport } from "./evaluate.js";

const score = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const mark = (m: boolean | null) => (m === null ? "◌ (review)" : m ? "✓" : "✗");

/** A Markdown report of one encounter: the endpoint, the critical errors, every scored item, points and records. */
export function episodeMarkdown(r: EncounterReport): string {
  const out: string[] = [`# ${r.scenario} — encounter report`, "", `> ${r.notice}`, ""];
  out.push(`**Primary endpoint: ${r.primary.status.toUpperCase()}**${r.primary.pathway ? ` — pathway \`${r.primary.pathway}\`` : ""}`);
  for (const reason of r.primary.reasons) out.push(`- ${reason}`);
  out.push("", `Family \`${r.family}\` (${r.split}), variant \`${r.variant}\` (${r.variantKind}), seed ${r.seed}, ${r.mode} mode; ${r.finished ? "finished" : "not finished"} after ${r.efficiency.minutes} simulated minutes and ${r.efficiency.agentActions} actions (${r.efficiency.rejected} rejected or blocked; ${r.efficiency.npcActions} by the support team).`, "");
  if (r.criticalErrors.length) {
    out.push("## Critical errors", "");
    for (const c of r.criticalErrors) out.push(`- **${c.label}** (${c.source}${c.executed ? "" : ", attempted and blocked"}${c.at !== null ? `, minute ${c.at}` : ""})`);
    out.push("");
  }
  const unsafe = [...Object.entries(r.unsafe.executed).map(([k, n]) => `${k} ×${n} (executed)`), ...Object.entries(r.unsafe.blocked).map(([k, n]) => `${k} ×${n} (blocked)`)];
  if (unsafe.length) out.push("## Unsafe attempts", "", ...unsafe.map((u) => `- ${u}`), "");
  out.push("## Pathways", "", "| pathway | acceptable | holds |", "|---|---|---|", ...r.pathways.map((p) => `| ${p.label} (\`${p.id}\`) | ${p.acceptable ? "yes" : "no"} | ${p.holds ? "✓" : ""} |`), "");
  const yn = (x: boolean | null) => (x === null ? "n/a" : x ? "yes" : "no");
  out.push(`Outcomes: disposition ${yn(r.outcomes.disposition)}; red flags recognised on evidence ${yn(r.outcomes.redFlagsOnEvidence)}; first visit ${yn(r.outcomes.initialVisit)}; planned course ${yn(r.outcomes.fullCourse)}.`, "");
  if (r.followUp) out.push(`Follow-up: ${r.followUp.expected ? "expected" : "not expected"}, ${r.followUp.started ? "held" : "not held"}${r.followUp.pathway ? `, pathway \`${r.followUp.pathway}\`` : ""}.`, "");
  out.push("## Tracks", "");
  for (const [name, t] of Object.entries(r.tracks)) {
    out.push(`### ${name} — ${score(t.score)}`, "");
    if (t.items.length === 0) out.push("_not scored in this encounter_", "");
    else out.push(...t.items.map((i) => `- ${mark(i.met)} ${i.label}${i.detail ? ` — ${i.detail}` : ""}`), "");
  }
  if (r.points.length) {
    out.push("## Needles", "", "| needle | target | class | error (cm) | tolerance | depth | tip | contacts |", "|---|---|---|---|---|---|---|---|");
    for (const p of r.points) out.push(`| ${p.needle} | ${p.target}${p.entered !== p.target ? ` (entered ${p.entered})` : ""} | ${p.classification} | ${p.errorCm ?? "—"} | ${p.toleranceCm ?? "—"} | ${p.depthCm} | ${p.tipTissue} | ${p.contacts.join(", ") || "—"} |`);
    out.push("");
  }
  out.push("## Documentation (STRICTA-informed, scored apart)", "", `Completeness ${score(r.documentation.completeness)}; consistent with the actions: ${r.documentation.consistent === null ? "—" : r.documentation.consistent ? "yes" : "no"}.`, ...r.documentation.issues.map((i) => `- ${i}`), "");
  out.push(`Claims of completion: ${r.claims.total} (${r.claims.unsupported} not supported by the state).`, "");
  if (r.referral.redFlagsPresent.length) out.push(`Red flags present: ${r.referral.redFlagsPresent.join(", ")}; appropriate referral: ${r.referral.appropriateReferral ? "yes" : "no"}.`, "");
  if (r.adjudication.length) out.push("## For independent adjudication", "", ...r.adjudication.map((a) => `- (${a.kind}) ${a.detail}`), "");
  return `${out.join("\n")}\n`;
}
