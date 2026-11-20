import { floorPlan, patientBody, patientRegion, pointInstance, type EncounterState, type Scenario, type Side } from "@acucraft/core";
import type { EncounterReport } from "./evaluate.js";

/**
 * A self-contained HTML view of one encounter (procedural visualisation): the clinic's floor plan with every walk
 * made on it; for every region and side that was needled or marked, the patient's chart in its configuration at the
 * time — landmarks, structures (by hazard and depth), the hidden reference location of each needled point with its
 * tolerance, the marks and the actual entries; the evidence links — what the pattern differentiation names and what
 * those findings show, and for each needle what the tissue did, what was observed and what was recorded; the evidence
 * ledger; then the attempt timeline with the four records. For reviewers and debriefs: it shows hidden truth.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function encounterHtml(sc: Scenario, s: EncounterState, report: EncounterReport): string {
  const panels: string[] = [];
  const groups = new Map<string, { region: string; side: Side; configuration: string }>();
  for (const n of Object.values(s.needles)) if (n.insertion) groups.set(`${n.insertion.region}|${n.insertion.side}|${n.insertion.configuration}`, { region: n.insertion.region, side: n.insertion.side, configuration: n.insertion.configuration });
  for (const m of Object.values(s.marks)) groups.set(`${m.region}|${m.side}|${m.configuration}`, { region: m.region, side: m.side, configuration: m.configuration });
  for (const g of groups.values()) panels.push(chart(sc, s, report, g.region, g.side, g.configuration));
  const rows = s.attempts.map((a) => {
    const cls = a.status === "blocked" ? "blocked" : a.status === "rejected" ? "rejected" : a.unsafe.length ? "unsafe" : "";
    return `<tr class="${cls}"><td>${a.at.toFixed(1)}</td><td>${esc(a.actor)}</td><td><code>${esc(a.request.action.type)}</code></td><td>${a.status}</td><td>${esc(a.message || a.executed?.detail || "")}${a.protection ? `<br><small>protected by ${esc(a.protection.by)}: ${esc(a.protection.reason)}</small>` : ""}${a.unsafe.length ? `<br><small>unsafe: ${a.unsafe.join(", ")}</small>` : ""}${a.violations.length ? `<br><small>rules: ${a.violations.map((v) => esc(v.rule)).join(", ")}</small>` : ""}</td><td>v${a.resultVersion}</td></tr>`;
  });
  const track = Object.entries(report.tracks).map(([k, t]) => `<li>${k}: <b>${t.score === null ? "—" : `${Math.round(t.score * 100)}%`}</b></li>`).join("");
  const eff = report.efficiency;
  const ledger = s.evidence.map((e) => `<tr><td><code>${esc(e.id)}</code></td><td>${e.kind}</td><td>${e.at.toFixed(1)}</td><td>${esc(e.by)}</td><td>${esc(e.text.length > 220 ? `${e.text.slice(0, 220)}…` : e.text)}</td></tr>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encounter viewer</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#6b6a65; --line:#d8d5cc; --card:#ffffff; --ok:#1f7a4d; --bad:#b3261e; --warn:#a15c00; --accent:#2b5c9e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161614; --fg:#ecebe6; --muted:#a3a19a; --line:#3a3935; --card:#201f1d; --ok:#5cc191; --bad:#f2786d; --warn:#e8a54a; --accent:#7fa8e8; } }
:root[data-theme="dark"] { --bg:#161614; --fg:#ecebe6; --muted:#a3a19a; --line:#3a3935; --card:#201f1d; --ok:#5cc191; --bad:#f2786d; --warn:#e8a54a; --accent:#7fa8e8; }
body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; margin:0; padding:24px 16px; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:1.4rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:28px 0 8px; }
.notice { color:var(--muted); font-size:.85rem; }
.status { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; border:1px solid currentColor; }
.success { color:var(--ok); } .failure { color:var(--bad); } .adjudicate { color:var(--warn); }
.panels { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
svg { width:100%; height:auto; display:block; }
.legend { font-size:.8rem; color:var(--muted); }
table { width:100%; border-collapse:collapse; font-size:.85rem; }
td, th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; vertical-align:top; }
tr.blocked td { color:var(--bad); } tr.rejected td { color:var(--muted); } tr.unsafe td { color:var(--warn); }
.scroll { overflow-x:auto; }
td code { white-space:nowrap; }
.floor { max-width:760px; }
.pill { display:inline-block; padding:0 8px; border-radius:999px; border:1px solid currentColor; font-size:.8rem; font-weight:600; }
.good { color:var(--ok); } .poor { color:var(--bad); } .open { color:var(--muted); }
</style></head><body><main>
<h1>${esc(sc.family.title)} — <code>${esc(sc.id)}</code></h1>
<p><span class="status ${report.primary.status}">${report.primary.status}</span> ${report.primary.pathway ? `pathway <code>${esc(report.primary.pathway)}</code>` : ""} ${report.primary.reasons.map((r) => `· ${esc(r)}`).join(" ")}</p>
<p class="notice">${esc(report.notice)} This view shows hidden reference geometry: never show it to an agent under test.</p>
<ul>${track}</ul>
<h2>Floor plan and walks</h2>
<p class="legend">${esc(sc.clinic.title)}: rooms, doors (gaps marked in blue) and fixtures in metres, north up. Lines: every walk made — the practitioner's solid, the support team's dotted, dashed where the patient walked alongside. Discs: where everyone stood at the end. The practitioner made ${eff.walks} walk(s) over ${eff.walkedMetres} m; ${eff.outOfReach} act(s) were refused for where they stood.</p>
<div class="card floor">${floor(sc, s)}</div>
<h2>Charts</h2>
<p class="legend">Dots: palpable landmarks (patient-specific). Lines: structures — red critical, amber caution; fainter when deeper. Rings: reference location of each needled point with its tolerance. ✕: actual entry; ○: mark. Chart axes in cm (u across, v cranial).</p>
<div class="panels">${panels.join("") || "<p>No needling or marking in this encounter.</p>"}</div>
<h2>Evidence links</h2>
<p class="legend">A conclusion names the evidence it rests on; what that evidence shows is read from the field — the case's own findings, the tissue's response — never from the claim.</p>
${evidenceLinks(report)}
<h2>Evidence ledger</h2>
<div class="scroll"><table><thead><tr><th>id</th><th>kind</th><th>min</th><th>by</th><th>what was obtained</th></tr></thead><tbody>${ledger.join("") || `<tr><td colspan="5">Nothing was obtained.</td></tr>`}</tbody></table></div>
<h2>Timeline</h2>
<div class="scroll"><table><thead><tr><th>min</th><th>actor</th><th>action</th><th>status</th><th>executed · protection · unsafe</th><th>state</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
</main></body></html>
`;
}

function chart(sc: Scenario, s: EncounterState, report: EncounterReport, regionId: string, side: Side, configuration: string): string {
  const frame = patientRegion(sc, regionId, side, configuration);
  const r = frame.region;
  const [u0, u1] = r.chart.uRange;
  const [v0, v1] = r.chart.vRange;
  const W = 360;
  const scale = W / (u1 - u0);
  const H = Math.max(160, (v1 - v0) * scale);
  const x = (u: number) => ((u - u0) * scale).toFixed(1);
  const y = (v: number) => ((v1 - v) * scale).toFixed(1);
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H.toFixed(0)}" fill="none" stroke="var(--line)"/>`];
  if (u0 < 0 && u1 > 0) parts.push(`<line x1="${x(0)}" y1="0" x2="${x(0)}" y2="${H}" stroke="var(--line)" stroke-dasharray="3 3"/>`);
  for (const st of frame.structures) {
    const pts = st.path.map((p) => `${x(p.u)},${y(p.v)}`).join(" ");
    const depth = st.path.reduce((a, p) => a + p.d, 0) / st.path.length;
    const colour = st.hazard === "critical" ? "var(--bad)" : "var(--warn)";
    parts.push(st.path.length === 1 ? `<circle cx="${x(st.path[0]!.u)}" cy="${y(st.path[0]!.v)}" r="${Math.max(2, st.radiusCm * scale)}" fill="none" stroke="${colour}" opacity="${Math.max(0.25, 1 - depth / 8)}"><title>${esc(st.label)} (${depth.toFixed(1)} cm deep)</title></circle>` : `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="${Math.max(1, st.radiusCm * scale)}" opacity="${Math.max(0.25, 1 - depth / 8)}"><title>${esc(st.label)} (about ${depth.toFixed(1)} cm deep)</title></polyline>`);
  }
  for (const lm of r.landmarks) {
    const p = frame.landmark(lm.id);
    if (!p || p.u < u0 - 1 || p.u > u1 + 1) continue;
    parts.push(`<circle cx="${x(p.u)}" cy="${y(p.v)}" r="2.5" fill="var(--muted)"><title>${esc(lm.label)}</title></circle>`);
  }
  for (const n of Object.values(s.needles)) {
    const ins = n.insertion;
    if (!ins || ins.region !== regionId || ins.side !== side || ins.configuration !== configuration) continue;
    if (ins.target && "point" in ins.target) {
      const def = sc.bundle.acupoints.get(ins.target.point);
      const inst = def ? pointInstance(sc, def, ins.target.side, configuration, ins.target.site) : null;
      if (inst) parts.push(`<circle cx="${x(inst.position.u)}" cy="${y(inst.position.v)}" r="${(inst.toleranceCm * scale).toFixed(1)}" fill="var(--accent)" fill-opacity="0.12" stroke="var(--accent)"><title>${esc(ins.target.point)} reference (tolerance ${inst.toleranceCm.toFixed(2)} cm)</title></circle>`);
    }
    const res = report.points.find((p) => p.needle === n.id);
    const colour = res?.classification === "avoid" || res?.contacts.length ? "var(--bad)" : res?.withinTolerance === false ? "var(--warn)" : "var(--ok)";
    const ex = Number(x(ins.entry.u));
    const ey = Number(y(ins.entry.v));
    parts.push(`<g stroke="${colour}" stroke-width="2"><line x1="${ex - 4}" y1="${ey - 4}" x2="${ex + 4}" y2="${ey + 4}"/><line x1="${ex - 4}" y1="${ey + 4}" x2="${ex + 4}" y2="${ey - 4}"/><title>${esc(n.id)} → ${esc(res?.target ?? "")}: ${res?.errorCm ?? "—"} cm off, ${ins.depthCm.toFixed(1)} cm deep, tip in ${esc(ins.tipTissue)}</title></g>`);
    const label = ins.target ? ("point" in ins.target ? ins.target.point : `Ashi`) : "?";
    parts.push(`<text x="${ex + 6}" y="${ey - 6}" font-size="10" fill="var(--fg)">${esc(label)}</text>`);
  }
  for (const m of Object.values(s.marks)) {
    if (m.region !== regionId || m.side !== side || m.configuration !== configuration) continue;
    parts.push(`<circle cx="${x(m.position.u)}" cy="${y(m.position.v)}" r="3.5" fill="none" stroke="var(--fg)"${m.stale ? ' stroke-dasharray="2 2"' : ""}><title>mark ${esc(m.id)}${m.stale ? " (stale)" : ""}</title></circle>`);
  }
  return `<div class="card"><b>${esc(r.title)}</b> — ${side} · ${esc(configuration)}<svg viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="${esc(r.title)} chart">${parts.join("")}</svg><div class="legend">${r.laterality === "midline" ? "← patient's right · patient's left →" : "← medial · lateral →"} (u ${u0}…${u1} cm) · ↑ cranial (v ${v0}…${v1} cm) · ${esc(r.provenance.review.status)} schematic model</div></div>`;
}

/** The clinic's floor plan with every walk made on it and where everyone ended. */
function floor(sc: Scenario, s: EncounterState): string {
  const plan = floorPlan(sc);
  const minX = Math.min(...plan.rooms.map((r) => r.rect.minX)) - 0.6;
  const maxX = Math.max(...plan.rooms.map((r) => r.rect.maxX)) + 0.6;
  const minZ = Math.min(...plan.rooms.map((r) => r.rect.minZ)) - 0.6;
  const maxZ = Math.max(...plan.rooms.map((r) => r.rect.maxZ)) + 0.6;
  const k = 42; // pixels per metre
  const x = (m: number) => ((m - minX) * k).toFixed(1);
  const y = (m: number) => ((m - minZ) * k).toFixed(1);
  const parts: string[] = [];
  for (const r of plan.rooms) {
    parts.push(`<rect x="${x(r.rect.minX)}" y="${y(r.rect.minZ)}" width="${((r.rect.maxX - r.rect.minX) * k).toFixed(1)}" height="${((r.rect.maxZ - r.rect.minZ) * k).toFixed(1)}" fill="var(--card)" stroke="var(--fg)" stroke-width="2"><title>${esc(r.label)}</title></rect>`);
  }
  // a door is a gap in the wall it stands in: marked where it is, as wide as it is
  const seen = new Set<string>();
  for (const r of plan.rooms) {
    for (const d of r.doors) {
      const key = `${d.x},${d.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const onVertical = [r.rect.minX, r.rect.maxX].some((edge) => Math.abs(edge - d.x) < 0.3);
      const h = d.width / 2;
      parts.push(onVertical ? `<line x1="${x(d.x)}" y1="${y(d.z - h)}" x2="${x(d.x)}" y2="${y(d.z + h)}" stroke="var(--accent)" stroke-width="5"><title>door</title></line>` : `<line x1="${x(d.x - h)}" y1="${y(d.z)}" x2="${x(d.x + h)}" y2="${y(d.z)}" stroke="var(--accent)" stroke-width="5"><title>door</title></line>`);
    }
  }
  for (const f of plan.fixtures) {
    parts.push(`<rect x="${x(f.x - f.w / 2)}" y="${y(f.z - f.d / 2)}" width="${(f.w * k).toFixed(1)}" height="${(f.d * k).toFixed(1)}" fill="var(--line)" stroke="var(--muted)" rx="2"><title>${esc(f.label)} (${esc(f.id)}, ${f.kind})</title></rect>`);
    if (f.kind === "couch" || f.kind === "trolley" || f.kind === "supplies") parts.push(`<text x="${x(f.x)}" y="${(Number(y(f.z)) + 3).toFixed(1)}" font-size="8" text-anchor="middle" fill="var(--fg)">${esc(f.kind)}</text>`);
  }
  const underTest = new Set(sc.field.cast.filter((m) => m.agent === "under-test").map((m) => m.id));
  for (const w of s.walks) {
    const pts = [w.from, ...w.path, w.to].filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.z !== all[i - 1]!.z);
    parts.push(`<polyline points="${pts.map((p) => `${x(p.x)},${y(p.z)}`).join(" ")}" fill="none" stroke="${underTest.has(w.actor) ? "var(--accent)" : "var(--warn)"}" stroke-width="1.5" stroke-opacity="0.55" stroke-linejoin="round"${w.withPatient ? ' stroke-dasharray="6 4"' : underTest.has(w.actor) ? "" : ' stroke-dasharray="1 4"'}><title>${esc(w.actor)}: ${w.metres.toFixed(1)} m at minute ${w.at.toFixed(1)}${w.withPatient ? ", with the patient" : ""}</title></polyline>`);
  }
  // room names last, at the foot of each room (clear of the furniture along the far wall), over everything else
  for (const r of plan.rooms) parts.push(`<text x="${(Number(x(r.rect.minX)) + 6).toFixed(1)}" y="${(Number(y(r.rect.maxZ)) - 7).toFixed(1)}" font-size="11" fill="var(--muted)" paint-order="stroke" stroke="var(--card)" stroke-width="3">${esc(r.label)}</text>`);
  const body = patientBody(sc, s);
  parts.push(`<circle cx="${x(body.centre.x)}" cy="${y(body.centre.z)}" r="6" fill="var(--ok)"><title>the patient (${esc(s.patient.position)}${s.patient.support ? ` on ${esc(s.patient.support)}` : ""})</title></circle>`);
  for (const a of Object.values(s.actors)) {
    parts.push(`<circle cx="${x(a.at.x)}" cy="${y(a.at.z)}" r="5" fill="${underTest.has(a.id) ? "var(--accent)" : "var(--warn)"}" stroke="var(--card)"><title>${esc(a.id)} (${esc(a.location)})</title></circle>`);
  }
  const W = (maxX - minX) * k;
  const H = (maxZ - minZ) * k;
  return `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Floor plan of the clinic with the walks made">${parts.join("")}</svg><div class="legend">● patient (green) · practitioner (blue) · support team (amber). 1 m = ${k} px. ${esc(plan.units)}.</div>`;
}

/** What the two TCM conclusions rest on: the pattern's named findings and their signs; each needle's field, evidence and record. */
function evidenceLinks(report: EncounterReport): string {
  const ev = report.evidence;
  const out: string[] = [];
  const p = ev.pattern;
  if (!p) out.push(`<p>No pattern differentiation on record.</p>`);
  else {
    const verdict = !p.hasCriteria ? `<span class="pill open">no criteria</span>` : p.supported ? `<span class="pill good">rests on its evidence</span>` : `<span class="pill poor">${p.contradicted ? "contradicted by the findings obtained" : "does not rest on its evidence"}</span>`;
    const rows = (xs: { sign: string; evidence: string[] }[], role: string) => xs.map((x) => `<tr><td>${esc(x.sign)}</td><td>${role}</td><td>${x.evidence.map((e) => `<code>${esc(e)}</code>`).join(" ")}</td></tr>`).join("");
    out.push(`<div class="card"><p><b>Pattern differentiation:</b> <code>${esc(p.pattern)}</code> at minute ${p.minute} ${verdict}<br><span class="legend">Named: ${p.cited.map((e) => `<code>${esc(e)}</code>`).join(" ") || "nothing"}. Needs ${p.thresholds.key} key sign(s) and ${p.thresholds.total} in all, and fewer than ${p.thresholds.against} against. Examinations drawn on: ${esc(p.methods.join(", ") || "none")}.${p.idle.length ? ` Named without showing a sign of it: ${p.idle.map((e) => `<code>${esc(e)}</code>`).join(" ")}.` : ""}</span></p>
<div class="scroll"><table><thead><tr><th>sign the findings show</th><th>role</th><th>shown by</th></tr></thead><tbody>${rows(p.key, "key") + rows(p.supporting, "supporting") + rows(p.against, "against") || `<tr><td colspan="3">The named findings show none of its signs.</td></tr>`}</tbody></table></div></div>`);
  }
  if (ev.needles.length > 0) {
    const cls = (v: string) => (v === "supported" || v === "not-sought" ? "good" : v === "unrecorded" ? "open" : "poor");
    const rows = ev.needles.map((n) => `<tr><td><code>${esc(n.needle)}</code></td><td>${esc(n.target)}</td><td>${n.field.arrived ? "qi arrived" : "no deqi"} · ${n.field.intensity.toFixed(2)} · tip in ${esc(n.field.tipTissue)} · worked ${n.field.manipulations}×${n.field.overstimulated ? " · too strong" : ""}${n.field.noxious ? ` · ${esc(n.field.noxious)}` : ""}</td><td>${n.evidence.map((e) => `<code>${esc(e.id)}</code>${e.deqi ? "✓" : "✗"}`).join(" ") || "nothing"}</td><td>${n.claim ? `${n.claim.response}${n.claim.evidence.length ? ` on ${n.claim.evidence.map((e) => `<code>${esc(e)}</code>`).join(" ")}` : ""}` : "—"}</td><td><span class="pill ${cls(n.verdict)}">${n.verdict}</span>${cls(n.verdict) === "poor" ? `<br><small>${esc(n.detail)}</small>` : ""}</td></tr>`);
    out.push(`<div class="card" style="margin-top:16px"><p><b>Needle responses</b> <span class="legend">— ✓ shows deqi, ✗ does not; qi arrives from a response of 0.5. Deqi is never required: a needle that was not worked, and recorded so, loses nothing.</span></p>
<div class="scroll"><table><thead><tr><th>needle</th><th>target</th><th>the tissue (hidden)</th><th>observed</th><th>recorded</th><th>verdict</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></div>`);
  }
  return out.join("");
}
