import type { AgentView, FeedItem, NeedleView, Probe, Snapshot, TeachingNeedle } from "../types.js";
import { tissueColor } from "../world/field.js";
import { clock, fmt, h, type Child } from "./dom.js";

/** The panels beside the clinic: what is going on now, the record as evidence, the needles, the talk and the feed. */

const chip = (text: string, cls = "") => h("span", { class: `chip ${cls}` }, text);
const row = (k: string, v: Child) => h("div", { class: "kv" }, h("span", null, k), h("b", null, v));

export function statusChip(status: string): HTMLElement {
  return chip(status, status === "executed" ? "ok" : status === "partial" ? "warn" : "bad");
}

export function nowPanel(s: Snapshot, onHint: (action: unknown) => void): HTMLElement {
  const v = s.view;
  const last = s.feed.filter((f) => f.actor === s.session.viewOf).at(-1);
  const plan = v.plan;
  return h(
    "div",
    { class: "panel" },
    h(
      "section",
      null,
      h("h4", null, v.patient.name, " ", chip(`${v.patient.age} · ${v.patient.sex}`)),
      h("p", { class: "lead" }, v.patient.presenting),
      row("Where", `${roomName(v, v.patient.location)} — ${v.patient.position}`),
      row("Appears", v.patient.appearance),
      row("Consent", v.patient.consent),
      row("From you", `${fmt(v.space.patient.distance)} m${v.space.patient.inEarshot ? " · in earshot" : ""}${v.space.patient.atSide ? " · at their side" : ""}${v.space.patient.inSight ? "" : " · out of sight"}`),
      v.space.patient.lying ? row("Lies", `head ${v.space.patient.lying.head}, right side ${v.space.patient.lying.rightSide}`) : null,
    ),
    h(
      "section",
      null,
      h("h4", null, "You"),
      row("Role", v.you.roleLabel),
      row("Room", `${roomName(v, v.you.location)} (${fmt(v.space.you.x)}, ${fmt(v.space.you.z)}), facing ${v.space.you.facing}`),
      row("Holding", v.you.holding.length ? v.you.holding.join(", ") : "nothing"),
      row("In reach", v.space.fixtures.filter((f) => f.inReach).map((f) => f.label).join(", ") || "no fixture"),
      row("Sites in reach", sitesText(v.space.patient.sites.inReach)),
    ),
    last
      ? h(
          "section",
          { class: `last ${last.status}` },
          h("h4", null, "Last action ", statusChip(last.status), last.code ? chip(last.code) : null),
          h("p", { class: "mono small" }, summarise(last.action)),
          last.message ? h("p", null, last.message) : null,
          last.observations.map((o) => h("p", { class: "obs" }, o)),
          last.hint ? h("button", { class: "primary", onclick: () => onHint(last.hint) }, `Do it: ${summarise(last.hint)}`) : null,
        )
      : null,
    plan
      ? h("section", null, h("h4", null, `Plan v${plan.version} `, plan.approved ? chip("approved", "ok") : null), row("Points", plan.points.join(", ") || "none"), row("Stimulation", plan.stimulation), row("Retention", `${plan.retentionMinutes} min`))
      : null,
    v.tasks.length ? h("section", null, h("h4", null, "Tasks"), v.tasks.map((t) => h("p", null, chip(t.status), ` ${t.id} · ${t.kind} → ${t.to}${t.unmet.length ? ` (unmet: ${t.unmet.join(", ")})` : ""}`))) : null,
    v.counts.length ? h("section", null, h("h4", null, "Needle counts"), v.counts.map((c) => h("p", null, `${clock(c.minute)} by ${c.by}: `, chip(c.reconciled ? "reconciled" : `${c.unaccounted} unaccounted`, c.reconciled ? "ok" : "bad")))) : null,
    h("section", null, h("h4", null, "Equipment"), v.equipment.packs.map((p) => h("p", { class: "small" }, `${p.id}: ${p.needles} × ${p.spec} — ${p.where}${p.expiredLabel ? " — EXPIRED LABEL" : ""}`)), v.equipment.needles.map((n) => h("p", { class: "small" }, `${n.id}: ${n.where}${n.used ? " · used" : ""}${n.contaminated ? " · contaminated" : ""}`))),
    h("section", null, h("h4", null, "Rules in force"), v.rules.map((r) => h("details", null, h("summary", null, `${r.title} (${r.version})`), r.rules.map((x) => h("p", { class: "small" }, chip(x.enforcement), ` ${x.title}`))))),
  );
}

/** `knee-leg:left, knee-leg:right` reads better as `knee-leg (left, right)`. */
function sitesText(sites: string[]): string {
  if (sites.length === 0) return "none: stand where the site is within arm's reach";
  const by = new Map<string, string[]>();
  for (const s of sites) {
    const [region, side] = s.split(":") as [string, string];
    by.set(region, [...(by.get(region) ?? []), side]);
  }
  return [...by].map(([r, sides]) => `${r} (${sides.join(", ")})`).join(" · ");
}

const roomName = (_v: AgentView, id: string) => id.replace(/-/g, " ");

export function summarise(action: unknown): string {
  const a = (action ?? {}) as Record<string, unknown>;
  const { type, ...rest } = a;
  const body = JSON.stringify(rest);
  return `${String(type)}${body === "{}" ? "" : ` ${body.length > 140 ? `${body.slice(0, 137)}…` : body}`}`;
}

export function recordPanel(v: AgentView): HTMLElement {
  const r = v.record;
  const item = (id: string, a: Child, b: Child) => h("div", { class: "evidence" }, h("code", null, id), h("div", null, h("div", { class: "muted" }, a), h("div", null, b)));
  const empty = r.history.length + r.examination.length + r.results.length + r.vitals.length + r.observations.length === 0;
  return h(
    "div",
    { class: "panel" },
    h("p", { class: "muted" }, "Everything obtained in this encounter, each item with its id. A conclusion names the ids it rests on; what was not asked or examined is unknown, not normal."),
    empty ? h("p", { class: "lead" }, "Nothing has been obtained yet.") : null,
    r.history.length ? h("section", null, h("h4", null, "History"), r.history.map((x) => item(x.id, x.question, x.answer))) : null,
    r.examination.length ? h("section", null, h("h4", null, "Examination"), r.examination.map((x) => item(x.id, x.manoeuvre, x.finding))) : null,
    r.results.length ? h("section", null, h("h4", null, "Results"), r.results.map((x) => item(x.id, "", x.text))) : null,
    r.vitals.length ? h("section", null, h("h4", null, "Vital signs"), r.vitals.map((x) => item(x.id, clock(x.minute), Object.entries(x.vitals).map(([k, val]) => `${k} ${val}`).join(" · ")))) : null,
    r.observations.length ? h("section", null, h("h4", null, "Observations"), r.observations.map((x) => item(x.id, clock(x.minute), x.text))) : null,
    r.sites.length || r.tenderPoints.length ? h("section", null, h("h4", null, "Sites"), r.sites.map((x) => h("p", null, x)), r.tenderPoints.map((a) => h("p", null, `${a.id}: ${a.label} (${a.region} ${a.side}, u ${a.centre.u}, v ${a.centre.v})`))) : null,
    v.assessment
      ? h(
          "section",
          { class: "assessment" },
          h("h4", null, "Assessment ", chip(clock(v.assessment.minute))),
          row("Diagnoses", v.assessment.diagnoses.join(", ") || "none"),
          row("Pattern", v.assessment.pattern ?? "none"),
          row("Rests on", v.assessment.patternEvidence.length ? v.assessment.patternEvidence.map((id) => h("code", null, id, " ")) : "nothing named"),
          row("Red flags", v.assessment.redFlags.join(", ") || "none"),
        )
      : null,
    v.localisation.landmarks.length + v.localisation.measurements.length + v.localisation.marks.length
      ? h(
          "section",
          null,
          h("h4", null, "Localisation"),
          v.localisation.landmarks.map((l) => h("p", { class: "small" }, `${l.landmark} (${l.region} ${l.side}): u ${l.u}, v ${l.v} · ${l.configuration}`)),
          v.localisation.measurements.map((m) => h("p", { class: "small" }, `${m.what} (${m.region} ${m.side}): ${m.cm} cm`)),
          v.localisation.marks.map((m) => h("p", { class: "small" }, `${m.id} → ${m.target}: u ${m.u}, v ${m.v}${m.stale ? " · moved with the skin" : ""}`)),
        )
      : null,
  );
}

export interface NeedleHandlers {
  focus(n: NeedleView): void;
  work(n: NeedleView): void;
  ask(n: NeedleView): void;
  withdraw(n: NeedleView): void;
}

export function needlesPanel(v: AgentView, selected: string | null, on: NeedleHandlers): HTMLElement {
  if (v.needling.length === 0) return h("div", { class: "panel" }, h("p", { class: "lead" }, "No needle has been placed this visit."), h("p", { class: "muted" }, "Hand hygiene, fetch a pack, open it onto a trolley, pick up a needle, mark the point, then insert at the mark."));
  return h(
    "div",
    { class: "panel" },
    v.needling.map((n) => {
      const dose = Math.min(1, n.stimulation / 1.5);
      return h(
        "section",
        { class: `needle${n.needle === selected ? " selected" : ""}${n.stuck ? " stuck" : ""}`, onclick: () => on.focus(n) },
        h("h4", null, `${n.needle} · ${n.target} `, n.inPlace ? chip("in place", "ok") : chip("withdrawn"), n.stuck ? chip("bound: do not pull", "bad") : null, n.recorded ? chip(`recorded: ${n.recorded}`) : null),
        h("p", { class: "small" }, `${n.site.region} ${n.site.side} · u ${n.site.u}, v ${n.site.v} · ${n.depthCm} cm at ${n.angleDeg}° towards ${n.azimuthDeg}° · ${n.method}`),
        row("Feel", n.feel),
        h("div", { class: "meter", title: "The stimulation it has had: the insertion counts 0.45; past 1.5 a typical patient no longer tolerates it" }, h("i", { class: n.stimulation >= 1.5 ? "bad" : n.stimulation >= 1 ? "warn" : "", style: `width:${dose * 100}%` }), h("span", null, `stimulation ${fmt(n.stimulation, 2)} of 1.5`)),
        n.worked.length ? h("div", { class: "worked" }, n.worked.map((w) => h("p", { class: "small" }, chip(clock(w.minute)), ` ${w.summary} `, w.character ? chip(w.character, w.character === "even" ? "" : "info") : null, ` dose ${fmt(w.dose, 2)}`))) : null,
        n.evidence.length ? h("div", { class: "ev" }, n.evidence.map((e) => h("div", { class: "evidence" }, h("code", null, e.id), h("div", null, h("div", { class: "muted" }, `${e.from}${e.unasked ? ", unasked" : ""} · ${clock(e.minute)}`), h("div", null, e.text))))) : h("p", { class: "muted small" }, "No evidence of its response yet: work it and feel, or ask the patient."),
        n.inPlace
          ? h(
              "div",
              { class: "row" },
              h("button", { onclick: (e: Event) => (e.stopPropagation(), on.work(n)) }, "Work…"),
              h("button", { onclick: (e: Event) => (e.stopPropagation(), on.ask(n)) }, "Ask what they feel"),
              h("button", { onclick: (e: Event) => (e.stopPropagation(), on.withdraw(n)) }, "Withdraw…"),
            )
          : null,
      );
    }),
  );
}

export function talkPanel(v: AgentView): HTMLElement {
  return h("div", { class: "panel talk" }, v.conversation.length === 0 ? h("p", { class: "lead" }, "Nothing has been said yet.") : v.conversation.map((u) => h("div", { class: `say${/you\)?$/i.test(u.speaker) || u.speaker === v.you.name ? " me" : ""}` }, h("span", { class: "who" }, `${u.speaker}${u.to ? ` → ${u.to}` : ""} · ${clock(u.minute)}`), h("p", null, u.text))));
}

export function feedPanel(feed: FeedItem[], onReuse: (action: unknown) => void): HTMLElement {
  return h(
    "div",
    { class: "panel feed" },
    feed.length === 0 ? h("p", { class: "lead" }, "No action yet.") : null,
    [...feed].reverse().map((f) =>
      h(
        "div",
        { class: `entry ${f.status}` },
        h("div", { class: "head" }, chip(clock(f.minute)), chip(f.via === "agent" ? `agent: ${f.agent ?? ""}` : f.via, f.via === "operator" ? "" : "info"), statusChip(f.status), f.code ? chip(f.code) : null, h("button", { class: "link", title: "Load this action into the form", onclick: () => onReuse(f.action) }, "reuse")),
        h("p", { class: "mono small" }, `${f.actorName}: ${summarise(f.action)}`),
        f.note ? h("p", { class: "note" }, f.note) : null,
        f.message ? h("p", null, f.message) : null,
        f.observations.map((o) => h("p", { class: "obs" }, o)),
      ),
    ),
  );
}

/** A needle in section: how deep it lies, at what angle — and, in teaching mode, through what. */
export function depthPanel(n: { title: string; depthCm: number; angleDeg: number; lengthCm: number; feel?: string }, strata: { tissue: string; label: string; from: number; to: number; hazard: string | null }[] | null, extra: Probe | TeachingNeedle | null): HTMLElement {
  const W = 232;
  const pad = 30;
  const deepest = Math.max(n.depthCm * Math.cos((n.angleDeg * Math.PI) / 180) + 1, strata ? Math.min(8, strata[strata.length - 1]?.to ?? 0) : 0, 3);
  const scale = Math.min(46, 178 / deepest);
  const H = Math.round(deepest * scale) + 44;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "depth");
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, String(val));
    if (text !== undefined) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  const y0 = 30;
  if (strata) {
    for (const s of strata) {
      const top = y0 + s.from * scale;
      const height = Math.max(1.5, (Math.min(s.to, deepest) - s.from) * scale);
      if (s.from >= deepest) break;
      el("rect", { x: pad, y: top, width: W - pad - 4, height, fill: tissueColor(s.tissue), opacity: 0.9, stroke: s.hazard ? "#e2503c" : "none", "stroke-width": s.hazard ? 1.5 : 0 });
      if (height > 9) el("text", { x: W - 8, y: top + Math.min(height, 14) - 2, "text-anchor": "end", class: "stratum" }, s.label);
    }
  } else el("rect", { x: pad, y: y0, width: W - pad - 4, height: deepest * scale, fill: "#2a2f35", opacity: 0.55 });
  el("line", { x1: pad - 4, y1: y0, x2: W - 4, y2: y0, class: "skinline" });
  el("text", { x: W - 8, y: y0 - 5, "text-anchor": "end", class: "tick" }, "skin");
  for (let d = 0; d <= deepest; d += 0.5) {
    const whole = Math.abs(d - Math.round(d)) < 1e-6;
    el("line", { x1: pad - (whole ? 7 : 4), y1: y0 + d * scale, x2: pad, y2: y0 + d * scale, class: "tickline" });
    if (whole) el("text", { x: pad - 9, y: y0 + d * scale + 3.5, "text-anchor": "end", class: "tick" }, `${d}`);
  }
  // the needle: what is above the skin, and what is in
  const theta = (n.angleDeg * Math.PI) / 180;
  const cx = pad + 46;
  const tip = { x: cx + Math.sin(theta) * n.depthCm * scale, y: y0 + Math.cos(theta) * n.depthCm * scale };
  const out = Math.max(0.3, n.lengthCm - n.depthCm);
  const top = { x: cx - Math.sin(theta) * Math.min(out, 0.55) * scale, y: y0 - Math.cos(theta) * Math.min(out, 0.55) * scale };
  el("line", { x1: top.x, y1: top.y, x2: tip.x, y2: tip.y, class: "shaft" });
  el("circle", { cx: tip.x, cy: tip.y, r: 2.6, class: "tip" });
  el("circle", { cx, cy: y0, r: 2, class: "entry" });
  const vertical = n.depthCm * Math.cos(theta);
  const klass = n.angleDeg <= 30 ? "perpendicular" : n.angleDeg <= 65 ? "oblique" : "transverse";
  const near = extra && "near" in extra ? extra.near : [];
  return h(
    "div",
    { class: "depthpanel" },
    h("h5", null, n.title),
    svg,
    h("p", { class: "small" }, `${fmt(n.depthCm)} cm along the shaft · tip ${fmt(vertical)} cm under the skin · ${klass} (${n.angleDeg}°)`),
    n.feel ? h("p", { class: "small" }, h("b", null, "Feel: "), n.feel) : null,
    extra && "tipTissue" in extra ? h("p", { class: "small teach" }, h("b", null, "Tip in: "), extra.tipTissue, extra.traversed?.length ? ` · through ${extra.traversed.join(", ")}` : "") : null,
    extra && "stoppedBy" in extra && extra.stoppedBy ? h("p", { class: "small teach" }, `Stops at ${fmt(extra.executedDepthCm)} cm: ${extra.stoppedBy}`) : null,
    extra && "critical" in extra && extra.critical ? h("p", { class: "small danger" }, "This path reaches a structure that must not be reached.") : null,
    near.map((x) => h("p", { class: `small ${x.contact ? "danger" : "teach"}` }, `${x.contact ? "Touches" : "Near"} ${x.label} (${x.kind})${x.contact ? "" : `: ${fmt(Math.max(0, x.clearanceCm), 2)} cm clear`}`)),
    strata ? null : h("p", { class: "muted small" }, "What lies beneath is not shown in assessment mode."),
  );
}
