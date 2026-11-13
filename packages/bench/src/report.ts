import type { EncounterReport } from "./evaluate.js";

const score = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const mark = (m: boolean | null) => (m === null ? "◌ (review)" : m ? "✓" : "✗");

/** A Markdown report of one encounter: the endpoint, the critical errors, every scored item, points and records. */
export function episodeMarkdown(r: EncounterReport): string {
  const out: string[] = [`# ${r.scenario} — encounter report`, "", `> ${r.notice}`, ""];
  out.push(`**Primary endpoint: ${r.primary.status.toUpperCase()}**${r.primary.pathway ? ` — pathway \`${r.primary.pathway}\`` : ""}`);
  for (const reason of r.primary.reasons) out.push(`- ${reason}`);
  out.push("", `Family \`${r.family}\` (${r.split}), variant \`${r.variant}\` (${r.variantKind}), seed ${r.seed}, ${r.mode} mode; ${r.finished ? "finished" : "not finished"} after ${r.efficiency.minutes} simulated minutes and ${r.efficiency.agentActions} actions (${r.efficiency.rejected} rejected or blocked, ${r.efficiency.outOfReach} of them for where the practitioner stood; ${r.efficiency.npcActions} by the support team). The practitioner walked ${r.efficiency.walkedMetres} m in ${r.efficiency.walks} walks.`, "");
  if (r.criticalErrors.length) {
    out.push("## Critical errors", "");
    for (const c of r.criticalErrors) out.push(`- **${c.label}** (${c.source}${c.executed ? "" : ", attempted and blocked"}${c.at !== null ? `, minute ${c.at}` : ""})`);
    out.push("");
  }
  const unsafe = [...Object.entries(r.unsafe.executed).map(([k, n]) => `${k} ×${n} (executed)`), ...Object.entries(r.unsafe.blocked).map(([k, n]) => `${k} ×${n} (blocked)`)];
  if (unsafe.length) out.push("## Unsafe attempts", "", ...unsafe.map((u) => `- ${u}`), "");
  out.push("## Pathways", "", "| pathway | acceptable | holds |", "|---|---|---|", ...r.pathways.map((p) => `| ${p.label} (\`${p.id}\`) | ${p.acceptable ? "yes" : "no"} | ${p.holds ? "✓" : ""} |`), "");
  if (r.followUp) out.push(`Follow-up: ${r.followUp.expected ? "expected" : "not expected"}, ${r.followUp.started ? "held" : "not held"}${r.followUp.pathway ? `, pathway \`${r.followUp.pathway}\`` : ""}.`, "");
  out.push("## Tracks", "");
  for (const [name, t] of Object.entries(r.tracks)) {
    out.push(`### ${name} — ${score(t.score)}`, "");
    if (t.items.length === 0) out.push("_not scored in this encounter_", "");
    else out.push(...t.items.map((i) => `- ${mark(i.met)} ${i.label}${i.detail ? ` — ${i.detail}` : ""}`), "");
  }
  if (r.points.length) {
    out.push("## Needles", "", "| needle | target | class | error (cm) | tolerance | depth | tip | contacts |", "|---|---|---|---|---|---|---|---|");
    for (const p of r.points) out.push(`| ${p.needle} | ${p.target} | ${p.classification} | ${p.errorCm ?? "—"} | ${p.toleranceCm ?? "—"} | ${p.depthCm} | ${p.tipTissue} | ${p.contacts.join(", ") || "—"} |`);
    out.push("");
  }
  const ev = r.evidence;
  out.push("## Evidence links", "", `The evidence ledger holds ${Object.values(ev.ledger).reduce((a, b) => a + b, 0)} item(s)${Object.keys(ev.ledger).length ? ` (${Object.entries(ev.ledger).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}. A conclusion names the items it rests on; what they show is read from the field, not from the claim.`, "");
  if (ev.pattern) {
    const p = ev.pattern;
    const rows = (xs: { sign: string; evidence: string[] }[], role: string) => xs.map((x) => `| ${x.sign} | ${role} | ${x.evidence.join(", ")} |`);
    out.push(`**Pattern differentiation: \`${p.pattern}\`** (minute ${p.minute}) — ${!p.hasCriteria ? "the vocabulary gives no criteria for it" : p.supported ? "rests on its evidence" : p.contradicted ? "contradicted by the findings obtained" : "does not rest on its evidence"}. Named: ${p.cited.join(", ") || "nothing"}.`, "");
    if (p.key.length + p.supporting.length + p.against.length > 0) out.push("| sign | role | shown by |", "|---|---|---|", ...rows(p.key, "key"), ...rows(p.supporting, "supporting"), ...rows(p.against, "against"), "");
    out.push(`Needs ${p.thresholds.key} key sign(s) and ${p.thresholds.total} in all, and fewer than ${p.thresholds.against} against; examinations drawn on: ${p.methods.join(", ") || "none"}.${p.idle.length ? ` Named without showing a sign of it: ${p.idle.join(", ")}.` : ""}`, "");
  } else out.push("No pattern differentiation on record.", "");
  if (ev.needles.length) {
    out.push("**Needle responses** — the tissue, what was observed, what was recorded:", "", "| needle | target | tissue's response | observed | recorded | verdict |", "|---|---|---|---|---|---|");
    for (const n of ev.needles) {
      const field = `${n.field.arrived ? "qi arrived" : "no deqi"} (${n.field.intensity.toFixed(2)}, tip in ${n.field.tipTissue}, worked ${n.field.manipulations}×${n.field.overstimulated ? ", too strong" : ""}${n.field.noxious ? `, ${n.field.noxious}` : ""})`;
      out.push(`| ${n.needle} | ${n.target} | ${field} | ${n.evidence.map((e) => `${e.id}${e.deqi ? " ✓" : " ✗"}`).join(", ") || "nothing"} | ${n.claim ? `${n.claim.response}${n.claim.evidence.length ? ` on ${n.claim.evidence.join(", ")}` : ""}` : "—"} | ${n.verdict}${n.verdict === "supported" || n.verdict === "not-sought" || n.verdict === "unrecorded" ? "" : `: ${n.detail}`} |`);
    }
    out.push("", "✓ shows deqi, ✗ does not. Deqi is never required: a needle that was not worked, and recorded so, loses nothing.", "");
  }
  out.push("## Documentation (STRICTA-informed, scored apart)", "", `Completeness ${score(r.documentation.completeness)}; consistent with the actions: ${r.documentation.consistent === null ? "—" : r.documentation.consistent ? "yes" : "no"}.`, ...r.documentation.issues.map((i) => `- ${i}`), "");
  out.push(`Claims of completion: ${r.claims.total} (${r.claims.unsupported} not supported by the state).`, "");
  if (r.referral.redFlagsPresent.length) out.push(`Red flags present: ${r.referral.redFlagsPresent.join(", ")}; appropriate referral: ${r.referral.appropriateReferral ? "yes" : "no"}.`, "");
  if (r.adjudication.length) out.push("## For independent adjudication", "", ...r.adjudication.map((a) => `- (${a.kind}) ${a.detail}`), "");
  return `${out.join("\n")}\n`;
}
