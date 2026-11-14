import type { AgentView, EncounterReport, TimelineEntry } from "./api.js";
import { h, s, type Child } from "./dom.js";
import { appearanceTone, byLabel, clock, consentTone, evidenceIndex, inputSummary, minute, NOTE_FIELDS, statusTone, words, type LibraryLite, type Tone } from "./text.js";

/**
 * The patient's record as the practitioner keeps it, built from their own view of the encounter (`AgentView`: an
 * allow-list of the engine's state — nothing hidden is in it) and the timeline of who did what. Every section is
 * drawn anew on each change; what is new since the last drawing is marked, so a person watching sees the record
 * being written.
 */

export interface RecordContext {
  view: AgentView;
  timeline: TimelineEntry[];
  lib: LibraryLite | null;
  /** Whether an item is new since the record was last drawn (false on the first drawing). */
  fresh(key: string): boolean;
}

export const pill = (text: Child, tone: Tone | "llm" | "mcp" = "muted", extra = "") => h("span", { class: ["pill", tone, extra] }, text);
const empty = (text: string) => h("p", { class: "empty" }, text);
const row = (ctx: RecordContext, key: string, ...cells: Child[]) => h("tr", { class: ctx.fresh(key) ? "fresh" : "" }, cells.map((c) => h("td", null, c)));
const table = (head: string[], rows: HTMLElement[], cls = "") => h("div", { class: "scroll" }, h("table", { class: cls }, h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))), h("tbody", null, rows)));
const sub = (title: string, ...children: Child[]) => h("div", { class: "subsection" }, h("h4", null, title), children);

function section(id: string, title: string, count: number | null, ...children: Child[]): HTMLElement {
  return h("section", { class: "card record-section", id: `sec-${id}` }, h("h3", null, title, count !== null ? h("span", { class: "count" }, String(count)) : null), children);
}

/** Evidence ids as chips: hovering one shows what it is. */
function evidenceChips(ids: string[], index: Map<string, { kind: string; text: string }>): HTMLElement {
  return h(
    "span",
    { class: "chips" },
    ids.map((id) => {
      const e = index.get(id);
      return h("span", { class: ["chip", e ? "" : "unknown"], title: e ? `${e.kind}: ${e.text}` : "not in the record" }, id);
    }),
  );
}

const labelled = (lib: LibraryLite | null, kind: "diagnoses" | "patterns" | "redFlags", id: string) => {
  const found = lib?.[kind].find((o) => o.value === id);
  return found?.label ? `${found.label} (${id})` : id;
};

/**
 * The conversation: what the practitioner's view heard, with the practitioner's own questions put back in from the
 * timeline (the engine keeps a question as the history item it answered, not as words said). A question goes just
 * before what was said at the same minute — its answer.
 */
export function conversationLines(view: AgentView, timeline: TimelineEntry[]): { minute: number; speaker: string; to: string | null; text: string; by: TimelineEntry["by"] | null; kind: "question" | "said" }[] {
  const firstShown = view.conversation.length >= 30 ? view.conversation[0]!.minute : -Infinity;
  // a question asked by its history item (`itemId`, as the reference trajectory does) is that item's question
  const itemQuestion = new Map(view.record.history.map((x) => [x.id, x.question]));
  const questions = timeline
    .filter((e) => e.tool === "ask" && (e.status === "executed" || e.status === "partial") && e.minute >= firstShown)
    .flatMap((e) => {
      const text = typeof e.input.text === "string" ? e.input.text : typeof e.input.itemId === "string" ? itemQuestion.get(e.input.itemId) : undefined;
      return text ? [{ minute: e.minute, speaker: view.you.name, to: view.patient.name, text, by: e.by, kind: "question" as const }] : [];
    });
  const said = view.conversation.map((u) => ({ ...u, by: null, kind: "said" as const }));
  const order = (x: { kind: string }) => (x.kind === "question" ? 0 : 1);
  return [...questions, ...said].map((x, i) => ({ x, i })).sort((a, b) => a.x.minute - b.x.minute || order(a.x) - order(b.x) || a.i - b.i).map(({ x }) => x);
}

function consultation(ctx: RecordContext): HTMLElement {
  const v = ctx.view;
  const said = conversationLines(v, ctx.timeline).map((u, i) =>
    h(
      "li",
      { class: ["utterance", u.speaker === v.you.name ? "mine" : u.speaker === v.patient.name ? "patient" : "other", ctx.fresh(`u:${u.kind}:${u.minute}:${u.speaker}:${u.text}`) ? "fresh" : ""], "data-i": i },
      h("span", { class: "who" }, u.speaker, u.to ? h("span", { class: "to" }, ` → ${u.to}`) : null, h("span", { class: "when" }, minute(u.minute)), u.by ? h("span", { class: "by" }, byLabel(u.by)) : null),
      h("span", { class: "said" }, u.text),
    ),
  );
  return section(
    "consultation",
    "Consultation",
    v.record.history.length,
    sub("Conversation", said.length ? h("ol", { class: "conversation" }, said) : empty("Nothing has been said yet.")),
    sub("History taken", v.record.history.length ? table(["id", "question", "answer"], v.record.history.map((x) => row(ctx, `hx:${x.id}`, h("code", null, x.id), x.question, x.answer))) : empty("No history taken yet.")),
  );
}

function findings(ctx: RecordContext): HTMLElement {
  const r = ctx.view.record;
  const vitalsKeys = [...new Set(r.vitals.flatMap((x) => Object.keys(x.vitals)))];
  return section(
    "findings",
    "Examination and findings",
    r.examination.length + r.results.length + r.vitals.length + r.observations.length,
    sub("Examination", r.examination.length ? table(["id", "manoeuvre", "finding"], r.examination.map((x) => row(ctx, `ex:${x.id}`, h("code", null, x.id), x.manoeuvre, x.finding))) : empty("No examination yet.")),
    sub("Records and results reviewed", r.results.length ? table(["id", "report"], r.results.map((x) => row(ctx, `rs:${x.id}`, h("code", null, x.id), x.text))) : empty("None reviewed.")),
    sub(
      "Vital signs (the latest readings)",
      r.vitals.length ? table(["id", "minute", ...vitalsKeys], r.vitals.map((x) => row(ctx, `vs:${x.id}`, h("code", null, x.id), minute(x.minute), ...vitalsKeys.map((k) => String(x.vitals[k] ?? "—"))))) : empty("Not measured."),
    ),
    sub("Observations (the latest)", r.observations.length ? table(["id", "minute", "seen"], r.observations.map((x) => row(ctx, `ob:${x.id}`, h("code", null, x.id), minute(x.minute), x.text))) : empty("Nothing observed yet.")),
    r.sites.length ? sub("Conditions at sites", h("ul", null, r.sites.map((x) => h("li", { class: ctx.fresh(`site:${x}`) ? "fresh" : "" }, x)))) : null,
    r.tenderPoints.length ? sub("Tender (Ashi) points found", table(["id", "where", "centre (u, v)", "radius"], r.tenderPoints.map((t) => row(ctx, `ashi:${t.id}`, h("code", null, t.id), `${t.label} — ${t.region}, ${t.side}`, `${t.centre.u}, ${t.centre.v}`, `${t.radiusCm} cm`)))) : null,
  );
}

function assessment(ctx: RecordContext, index: Map<string, { kind: string; text: string }>): HTMLElement {
  const v = ctx.view;
  const a = v.assessment;
  const d = v.documentation;
  return section(
    "assessment",
    "Assessment and decisions",
    (a ? 1 : 0) + d.decisions.length + d.referrals.length,
    sub(
      "Assessment on record",
      a
        ? h(
            "dl",
            { class: ["facts", ctx.fresh(`as:${a.minute}:${a.pattern}:${a.diagnoses.join()}`) ? "fresh" : ""] },
            h("dt", null, "Diagnoses"),
            h("dd", null, a.diagnoses.length ? a.diagnoses.map((x) => labelled(ctx.lib, "diagnoses", x)).join("; ") : "—"),
            h("dt", null, "TCM pattern"),
            h("dd", null, a.pattern ? labelled(ctx.lib, "patterns", a.pattern) : "—"),
            h("dt", null, "Rests on"),
            h("dd", null, a.patternEvidence.length ? evidenceChips(a.patternEvidence, index) : "—"),
            h("dt", null, "Red flags"),
            h("dd", null, a.redFlags.length ? a.redFlags.map((x) => pill(labelled(ctx.lib, "redFlags", x), "bad")) : "none recognised"),
            h("dt", null, "Recorded"),
            h("dd", null, minute(a.minute)),
          )
        : empty("No assessment yet."),
    ),
    sub("Decisions", d.decisions.length ? table(["visit", "minute", "by", "decision", "rationale"], d.decisions.map((x) => row(ctx, `dc:${x.minute}:${x.disposition}`, String(x.visit), minute(x.minute), x.by, pill(words(x.disposition), x.disposition === "refer" || x.disposition === "defer" ? "warn" : "info"), x.rationale || "—"))) : empty("No decision yet.")),
    d.referrals.length ? sub("Referrals", table(["minute", "by", "to", "urgency", "reason"], d.referrals.map((x) => row(ctx, `rf:${x.minute}:${x.to}`, minute(x.minute), x.by, x.to, pill(x.urgency, x.urgency === "emergency" || x.urgency === "urgent" ? "bad" : "warn"), x.reason)))) : null,
  );
}

function plan(ctx: RecordContext): HTMLElement {
  const v = ctx.view;
  const p = v.plan;
  const c = v.documentation.consent;
  return section(
    "plan",
    "Plan and consent",
    null,
    sub(
      "Treatment plan",
      p
        ? h(
            "dl",
            { class: ["facts", ctx.fresh(`pl:${p.version}`) ? "fresh" : ""] },
            h("dt", null, "Version"),
            h("dd", null, `${p.version} (${minute(p.minute)})`, p.approved ? pill("approved", "ok") : null),
            h("dt", null, "Points"),
            h("dd", null, p.points.length ? h("span", { class: "chips" }, p.points.map((x) => h("span", { class: "chip" }, x))) : "—"),
            h("dt", null, "Technique"),
            h("dd", null, `${words(p.method)}, ${p.stimulation} stimulation, retained ${p.retentionMinutes} min`),
            h("dt", null, "Rationale"),
            h("dd", null, p.rationale || "—"),
            h("dt", null, "Alternatives"),
            h("dd", null, p.alternatives.length ? p.alternatives.join("; ") : "—"),
            h("dt", null, "Follow-up"),
            h("dd", null, p.followUp ?? "—"),
          )
        : empty("No plan yet."),
    ),
    sub(
      "Consent",
      h(
        "dl",
        { class: ["facts", ctx.fresh(`cs:${c.status}:${c.planVersion}`) ? "fresh" : ""] },
        h("dt", null, "Status"),
        h("dd", null, pill(v.patient.consent, consentTone(c.status))),
        h("dt", null, "Covers plan"),
        h("dd", null, c.planVersion === null ? "—" : `version ${c.planVersion}${c.minute !== null ? ` (${minute(c.minute)})` : ""}`),
        h("dt", null, "Topics explained"),
        h("dd", null, c.topics.length ? h("span", { class: "chips" }, c.topics.map((x) => h("span", { class: "chip" }, x))) : "—"),
      ),
    ),
    v.documentation.explanations.length ? sub("What the patient was told", table(["minute", "by", "topics", "words"], v.documentation.explanations.map((x) => row(ctx, `xp:${x.minute}:${x.topics.join()}`, minute(x.minute), x.by, x.topics.join(", ") || "—", x.text ?? "—")))) : null,
  );
}

/** One region's chart: landmarks found, marks made and (teaching mode) the reference locations, u across and v along (cranial up). */
function chart(region: string, side: string, items: { kind: "landmark" | "mark" | "reference"; u: number; v: number; label: string; r?: number }[]): SVGSVGElement {
  const us = items.map((i) => i.u), vs = items.map((i) => i.v);
  const pad = 2;
  const minU = Math.min(...us) - pad, maxU = Math.max(...us) + pad, minV = Math.min(...vs) - pad, maxV = Math.max(...vs) + pad;
  const w = Math.max(6, maxU - minU), hgt = Math.max(6, maxV - minV);
  const scale = 220 / Math.max(w, hgt);
  const x = (u: number) => 20 + (u - minU) * scale, y = (v: number) => 20 + (maxV - v) * scale;
  return s(
    "svg",
    { viewBox: `0 0 ${w * scale + 40} ${hgt * scale + 40}`, role: "img", "aria-label": `${region} ${side}: landmarks and marks` },
    s("rect", { x: 1, y: 1, width: w * scale + 38, height: hgt * scale + 38, class: "frame", rx: 6 }),
    s("text", { x: 10, y: 14, class: "axis" }, `${region} · ${side} · cm (u across, v up)`),
    items.map((i) =>
      i.kind === "landmark"
        ? s("g", { class: "lm" }, s("circle", { cx: x(i.u), cy: y(i.v), r: 3 }), s("text", { x: x(i.u) + 5, y: y(i.v) - 4 }, i.label))
        : i.kind === "mark"
          ? s("g", { class: "mk" }, s("path", { d: `M${x(i.u) - 4},${y(i.v) - 4}L${x(i.u) + 4},${y(i.v) + 4}M${x(i.u) - 4},${y(i.v) + 4}L${x(i.u) + 4},${y(i.v) - 4}` }), s("text", { x: x(i.u) + 6, y: y(i.v) + 12 }, i.label))
          : s("g", { class: "ref" }, s("circle", { cx: x(i.u), cy: y(i.v), r: Math.max(3, (i.r ?? 0.5) * scale) }), s("text", { x: x(i.u) + 6, y: y(i.v) - 6 }, i.label)),
    ),
  );
}

function localisation(ctx: RecordContext): HTMLElement {
  const l = ctx.view.localisation;
  const groups = new Map<string, { kind: "landmark" | "mark" | "reference"; u: number; v: number; label: string; r?: number }[]>();
  const put = (key: string, item: { kind: "landmark" | "mark" | "reference"; u: number; v: number; label: string; r?: number }) => (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
  for (const m of l.landmarks) put(`${m.region}|${m.side}`, { kind: "landmark", u: m.u, v: m.v, label: m.landmark });
  for (const m of l.marks) put(`${m.region}|${m.side}`, { kind: "mark", u: m.u, v: m.v, label: m.target });
  for (const r of ctx.view.teaching?.references ?? []) put(`${r.region}|${r.side}`, { kind: "reference", u: r.u, v: r.v, label: `ref ${r.target}`, r: r.toleranceCm });
  return section(
    "localisation",
    "Localisation",
    l.marks.length,
    groups.size ? h("div", { class: "charts" }, [...groups].map(([key, items]) => h("figure", { class: "chart" }, chart(key.split("|")[0]!, key.split("|")[1]!, items)))) : null,
    sub("Marks", l.marks.length ? table(["id", "target", "site", "u, v", ""], l.marks.map((m) => row(ctx, `mk:${m.id}:${m.u}:${m.v}`, h("code", null, m.id), m.target, `${m.region}, ${m.side}`, `${m.u}, ${m.v}`, m.stale ? pill("stale: the position changed", "warn") : ""))) : empty("No point marked yet.")),
    sub("Landmarks identified", l.landmarks.length ? table(["site", "landmark", "u, v", "as the patient lay"], l.landmarks.map((m) => row(ctx, `lm:${m.region}:${m.side}:${m.landmark}:${m.configuration}`, `${m.region}, ${m.side}`, m.landmark, `${m.u}, ${m.v}`, words(m.configuration)))) : empty("None yet.")),
    l.measurements.length ? sub("Measurements", table(["site", "what", "cm"], l.measurements.map((m) => row(ctx, `ms:${m.region}:${m.side}:${m.what}`, `${m.region}, ${m.side}`, m.what, String(m.cm))))) : null,
    ctx.view.teaching ? h("p", { class: "teaching" }, ctx.view.teaching.notes.join(" ")) : null,
  );
}

function needling(ctx: RecordContext): HTMLElement {
  const v = ctx.view;
  const responseTone = (r: string | null): Tone => (r === "deqi" ? "ok" : r === "none" ? "warn" : r ? "muted" : "muted");
  return section(
    "needling",
    "Needling",
    v.needling.length,
    sub(
      "Needles of this visit",
      v.needling.length
        ? table(
            ["needle", "target", "", "worked", "evidence of its response", "recorded"],
            v.needling.map((n) =>
              row(
                ctx,
                `nd:${n.needle}:${n.inPlace}:${n.manipulations}:${n.evidence.length}:${n.recorded}`,
                h("code", null, n.needle),
                n.target,
                pill(n.inPlace ? "in place" : "out", n.inPlace ? "info" : "muted"),
                `${n.manipulations}×`,
                n.evidence.length ? h("ul", { class: "plain" }, n.evidence.map((e) => h("li", null, h("code", null, e.id), ` ${e.from}${e.unasked ? " (unasked)" : ""}: ${e.text}`))) : "—",
                n.recorded ? pill(n.recorded, responseTone(n.recorded)) : "—",
              ),
            ),
          )
        : empty("No needle inserted in this visit."),
    ),
    sub("Needle counts", v.counts.length ? table(["minute", "by", "method", "reconciled", "unaccounted"], v.counts.map((c) => row(ctx, `ct:${c.minute}:${c.by}:${c.method}`, minute(c.minute), c.by, c.method, pill(c.reconciled ? "yes" : "no", c.reconciled ? "ok" : "bad"), String(c.unaccounted)))) : empty("No count yet.")),
    sub(
      "Packs and needles out of their packs",
      table(["", "where", "state"], [
        ...v.equipment.packs.map((p) => row(ctx, `pk:${p.id}:${p.sealed}:${p.where}`, h("code", null, p.id), p.where, h("span", null, `${p.sealed ? "sealed" : "opened"}, ${p.needles} needles, ${p.spec}`, p.expiredLabel ? pill("expired label", "bad") : null))),
        ...v.equipment.needles.map((n) => row(ctx, `nl:${n.id}:${n.where}:${n.used}:${n.contaminated}`, h("code", null, n.id), n.where, h("span", null, n.used ? "used" : "unused", n.contaminated ? pill("contaminated", "bad") : null))),
      ]),
      h("p", { class: "muted" }, `Sharps containers: ${v.equipment.sharps.join("; ") || "—"}`),
    ),
  );
}

function notes(ctx: RecordContext): HTMLElement {
  const d = ctx.view.documentation;
  const note = (n: AgentView["documentation"]["notes"][number], i: number) => {
    const r = n.record;
    const nd = r.needling;
    return h(
      "article",
      { class: ["note", ctx.fresh(`nt:${i}:${n.minute}`) ? "fresh" : ""] },
      h("header", null, h("strong", null, `Visit ${n.visit} · ${minute(n.minute)}`), ` — ${n.by}`),
      h(
        "dl",
        { class: "facts" },
        NOTE_FIELDS.filter(([k]) => typeof (r as Record<string, unknown>)[k] === "string" && (r as Record<string, unknown>)[k]).map(([k, label]) => [h("dt", null, label), h("dd", { class: "prose" }, String((r as Record<string, unknown>)[k]))]),
        r.pointsUsed?.length ? [h("dt", null, "Points used"), h("dd", null, h("span", { class: "chips" }, r.pointsUsed.map((p) => h("span", { class: "chip" }, "ashi" in p ? `ashi:${p.ashi}` : `${p.point}:${p.side}${p.site ? `:${p.site}` : ""}`))))] : null,
        nd
          ? [
              h("dt", null, "Needling"),
              h(
                "dd",
                null,
                [nd.needleType, nd.needleCount !== undefined ? `${nd.needleCount} needles` : null, nd.depth, nd.stimulation, nd.retentionMinutes !== undefined ? `retained ${nd.retentionMinutes} min` : null, nd.responseSought].filter(Boolean).join("; ") || "—",
                nd.responses?.length ? h("ul", { class: "plain" }, nd.responses.map((x) => h("li", null, h("code", null, x.needle), " ", pill(x.response, x.response === "deqi" ? "ok" : "muted"), x.evidence.length ? ` on ${x.evidence.join(", ")}` : ""))) : null,
              ),
            ]
          : null,
      ),
    );
  };
  return section(
    "notes",
    "Clinical notes",
    d.notes.length,
    d.notes.length ? d.notes.map(note) : empty("No note written yet — the record of a visit is written with “Write the clinical note”."),
    d.incidents.length ? sub("Incidents reported", table(["visit", "minute", "by", "kind", "needle", "description"], d.incidents.map((x) => row(ctx, `in:${x.minute}:${x.kind}`, String(x.visit), minute(x.minute), x.by, pill(words(x.kind), "bad"), x.needle ?? "—", x.description)))) : null,
    d.stopped ? sub("Treatment stopped", h("p", { class: ["stopped", ctx.fresh("stopped") ? "fresh" : ""] }, `Visit ${d.stopped.visit}, ${minute(d.stopped.minute)}, by ${d.stopped.by}: ${d.stopped.reason}`)) : null,
  );
}

function clinic(ctx: RecordContext): HTMLElement {
  const v = ctx.view;
  const p = v.space.patient;
  return section(
    "clinic",
    "In the clinic",
    null,
    h(
      "dl",
      { class: "facts" },
      h("dt", null, "You"),
      h("dd", null, `${v.you.name} (${v.you.roleLabel}) in the ${v.space.you.room}, facing ${v.space.you.facing}${v.you.holding.length ? `, holding ${v.you.holding.join(", ")}` : ""}`),
      h("dt", null, "The patient"),
      h("dd", null, `${words(v.patient.position)}${p.on ? ` on ${p.on}` : ""} in the ${p.room}, ${p.distance} m away — `, pill(p.inEarshot ? "in earshot" : "out of earshot", p.inEarshot ? "ok" : "muted"), " ", pill(p.atSide ? "at your side" : "not at your side", p.atSide ? "ok" : "muted")),
      h("dt", null, "Sites in reach"),
      h("dd", null, p.sites.inReach.length ? p.sites.inReach.join(", ") : "—"),
      h("dt", null, "Out of reach"),
      h("dd", null, p.sites.outOfReach.length ? p.sites.outOfReach.map((x) => `${x.site} (${x.distance} m)`).join(", ") : "—"),
      h("dt", null, "Fixtures in reach"),
      h("dd", null, v.space.fixtures.filter((f) => f.inReach).map((f) => f.label).join(", ") || "—"),
    ),
    sub("The team", table(["who", "role", "where"], v.team.map((m) => row(ctx, `tm:${m.id}:${m.location}`, m.name, m.role, m.location)))),
    v.tasks.length ? sub("Tasks", table(["task", "from → to", "status", "unmet"], v.tasks.map((t) => row(ctx, `tk:${t.id}:${t.status}`, `${t.kind} (${t.id})`, `${t.from} → ${t.to}`, pill(t.status, t.status === "done" ? "ok" : t.status === "declined" ? "bad" : "info"), t.unmet.join("; ") || "—")))) : null,
    sub("Couches", table(["room", "last prepared"], v.couches.map((c) => row(ctx, `co:${c.room}:${c.prepared?.minute ?? ""}`, c.room, c.prepared ? `${minute(c.prepared.minute)} by ${c.prepared.by}: ${c.prepared.done.join(", ")}` : "—")))),
    sub("Rules in force", h("ul", { class: "plain" }, v.rules.map((r) => h("li", null, `${r.title} — ${r.version} (from ${r.effectiveFrom}, ${r.encoding})`)))),
  );
}

function timeline(ctx: RecordContext): HTMLElement {
  const entries = [...ctx.timeline].reverse();
  return section(
    "timeline",
    "Timeline",
    ctx.timeline.length,
    entries.length
      ? table(
          ["#", "time", "minute", "who", "action", "result"],
          entries.map((e) =>
            row(
              ctx,
              `tl:${e.seq}`,
              String(e.seq),
              clock(e.at),
              minute(e.minute),
              pill(byLabel(e.by), e.by.kind === "operator" ? "info" : e.by.kind === "llm" ? "llm" : "mcp"),
              h("span", null, h("code", null, e.tool), " ", h("span", { class: "muted" }, inputSummary(e.input))),
              h("span", null, pill(e.status, statusTone(e.status)), e.message ? ` ${e.message}` : "", e.observations.length ? h("ul", { class: "plain obs" }, e.observations.map((o) => h("li", null, o))) : null),
            ),
          ),
          "timeline",
        )
      : empty("Nothing done yet. Act from the panel on the right — or let a language model work the encounter."),
  );
}

/** The sections of the record, in reading order, and a navigation bar over them. */
export function renderRecord(ctx: RecordContext): HTMLElement {
  const index = evidenceIndex(ctx.view);
  const sections = [consultation(ctx), findings(ctx), assessment(ctx, index), plan(ctx), localisation(ctx), needling(ctx), notes(ctx), clinic(ctx), timeline(ctx)];
  const nav = h(
    "nav",
    { class: "sections", "aria-label": "record sections" },
    sections.map((sec) => {
      const head = sec.querySelector("h3");
      const count = head?.querySelector(".count")?.textContent;
      const name = head?.firstChild?.textContent ?? sec.id;
      return h("a", { href: `#${sec.id}`, on: { click: (e: Event) => (e.preventDefault(), sec.scrollIntoView({ behavior: "smooth", block: "start" })) } }, name, count ? h("span", { class: "count" }, count) : null);
    }),
  );
  return h("div", { class: "record" }, nav, sections);
}

/** The patient at a glance: who, where, how they look, and the state of the encounter. */
export function banner(view: AgentView, extra: Child[]): HTMLElement {
  const p = view.patient;
  return h(
    "header",
    { class: "banner card" },
    h("div", { class: "who" }, h("h2", null, p.name), h("p", null, `${p.age} · ${p.sex} · ${p.presenting}`), h("p", { class: "muted" }, `${view.title} — ${view.setting.clinic}`)),
    h(
      "div",
      { class: "chips" },
      pill(`visit ${view.setting.visit} of ${view.setting.visits} · ${view.setting.date}`, "info"),
      pill(minute(view.minute), "info"),
      pill(`consent: ${p.consent}`, consentTone(view.documentation.consent.status)),
      pill(`${words(p.position)} · ${p.location}`, "muted"),
      pill(p.appearance, appearanceTone(p.appearance)),
      view.mode === "teaching" ? pill("teaching mode", "warn") : null,
      view.finished ? pill("finished", "ok") : null,
      extra,
    ),
  );
}

/** The independent evaluation, once the encounter is finished or closed. */
export function reportCard(report: EncounterReport, links: Child[]): HTMLElement {
  const tone: Tone = report.primary.status === "success" ? "ok" : report.primary.status === "adjudicate" ? "warn" : "bad";
  return h(
    "section",
    { class: "card report", id: "sec-report" },
    h("h3", null, "Evaluation"),
    h("p", null, pill(report.primary.status, tone, "big"), report.primary.pathway ? h("span", null, " pathway ", h("code", null, report.primary.pathway)) : null),
    report.primary.reasons.length ? h("ul", null, report.primary.reasons.map((r) => h("li", null, r))) : null,
    h(
      "div",
      { class: "tracks" },
      Object.entries(report.tracks).map(([k, t]) => {
        const bar = h("span", { class: "fill" });
        bar.style.setProperty("width", `${Math.round((t.score ?? 0) * 100)}%`);
        return h("div", { class: "track" }, h("span", { class: "name" }, words(k)), h("span", { class: "bar" }, bar), h("span", { class: "score" }, t.score === null ? "—" : `${Math.round(t.score * 100)}%`));
      }),
    ),
    report.criticalErrors.length ? h("p", null, "Critical errors: ", report.criticalErrors.map((c) => pill(c.id, "bad"))) : h("p", null, pill("no critical error", "ok")),
    h("p", { class: "muted" }, `Unsafe attempts: ${report.unsafe.total} (executed ${Object.values(report.unsafe.executed).reduce((a, b) => a + b, 0)}, blocked ${Object.values(report.unsafe.blocked).reduce((a, b) => a + b, 0)}).`),
    h("p", { class: "notice" }, report.notice),
    h("div", { class: "row" }, links),
  );
}
