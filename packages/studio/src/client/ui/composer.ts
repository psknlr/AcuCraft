import type { ActionSpec, AgentView, FieldEntry, FieldSpec, Library, StudioScene } from "../types.js";
import { h, type Child } from "./dom.js";

/**
 * A form for any action, built from the action catalogue the server derives from the engine's schemas: every field
 * the engine accepts is there, with its range and default, and nothing the engine would refuse can be entered. Where
 * a field names something of the encounter — a needle, a pack, a mark, a landmark of the chart, a pattern, an item of
 * evidence — it is chosen from what the view lists, so an id is never typed from memory. The action as it will be
 * sent is shown as JSON under the form and can be edited there.
 */

export interface FormContext {
  view: AgentView;
  scene: StudioScene;
  library: Library;
}

export interface Form {
  el: HTMLElement;
  /** The action as it would be sent (throws with a message when a required field is empty). */
  value(): Record<string, unknown>;
  /** The action as far as it has been filled in, complete or not (what a rebuilt form starts from). */
  peek(): Record<string, unknown>;
  /** Set a field from outside (a click on the chart, a measured gesture). */
  set(name: string, value: unknown): void;
  type: string;
}

/** A form that still lacks something it needs: what it has so far is kept for display. */
class Incomplete extends Error {
  constructor(
    message: string,
    readonly partial: unknown,
  ) {
    super(message);
  }
}

interface Control {
  el: HTMLElement;
  get(): unknown;
  set(v: unknown): void;
}

const STEP: Record<string, number> = { angleDeg: 5, azimuthDeg: 5, arcDeg: 10, frequencyPerMin: 5, durationSec: 1, amplitudeMm: 0.5, depthCm: 0.1, minutes: 1, retentionMinutes: 1, u: 0.1, v: 0.1, x: 0.1, z: 0.1 };
const UNIT: Record<string, string> = { angleDeg: "° from the perpendicular", azimuthDeg: "° (0 towards the head, 90 towards +u)", arcDeg: "°", frequencyPerMin: "/min", durationSec: "s", amplitudeMm: "mm", depthCm: "cm along the shaft", minutes: "min", retentionMinutes: "min", u: "cm", v: "cm" };
const HELP: Record<string, string> = {
  patternEvidence: "The findings the differentiation rests on: only what has been obtained can be named.",
  mark: "A mark made with “Mark a point”: the needle goes in there.",
  at: "Chart centimetres: click the skin in the field view to fill these in.",
  emphasis: "The forceful stroke: thrust reads as reinforcing, lift as reducing.",
  direction: "One way only winds the tissue round the shaft: a bound needle must not be pulled.",
  expectedVersion: "",
};

const label = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Deg$| Deg$/, "").replace(/Cm$| Cm$|Mm$| Mm$|Sec$| Sec$|Per Min$| Per Min$/, "").replace(/^./, (c) => c.toUpperCase());

function select(options: { value: string; text: string }[], allowEmpty: boolean, onChange: () => void): Control {
  const el = h("select", { onchange: onChange }, allowEmpty ? h("option", { value: "" }, "—") : null, options.map((o) => h("option", { value: o.value }, o.text)));
  return { el, get: () => el.value || undefined, set: (v) => void (el.value = typeof v === "string" ? v : "") };
}

function checks(options: { value: string; text: string; title?: string }[], onChange: () => void, cls = "checks"): Control {
  const boxes = options.map((o) => ({ o, box: h("input", { type: "checkbox", value: o.value, onchange: onChange }) }));
  const el = h("div", { class: cls }, boxes.map(({ o, box }) => h("label", { title: o.title ?? o.text }, box, h("span", null, o.text))));
  return {
    el,
    get: () => {
      const v = boxes.filter((b) => b.box.checked).map((b) => b.o.value);
      return v.length ? v : undefined;
    },
    set: (v) => {
      const on = new Set(Array.isArray(v) ? (v as string[]) : []);
      for (const b of boxes) b.box.checked = on.has(b.o.value);
    },
  };
}

function text(spec: Extract<FieldSpec, { kind: "string" }>, onChange: () => void, placeholder = ""): Control {
  const long = (spec.max ?? 0) >= 1000;
  const el = long ? h("textarea", { rows: 2, placeholder, oninput: onChange }) : h("input", { type: "text", placeholder, oninput: onChange });
  return { el, get: () => (el.value.trim() ? el.value.trim() : undefined), set: (v) => void (el.value = v === undefined || v === null ? "" : String(v)) };
}

function number(name: string, spec: Extract<FieldSpec, { kind: "number" }>, def: unknown, onChange: () => void): Control {
  const step = spec.int ? 1 : (STEP[name] ?? 0.1);
  const input = h("input", { type: "number", step: String(step), ...(spec.min !== undefined ? { min: String(spec.min) } : {}), ...(spec.max !== undefined ? { max: String(spec.max) } : {}), placeholder: def !== undefined ? String(def) : "" });
  const ranged = spec.min !== undefined && spec.max !== undefined;
  const slider = ranged ? h("input", { type: "range", min: String(spec.min), max: String(spec.max), step: String(step), value: String(def ?? spec.min) }) : null;
  input.addEventListener("input", () => {
    if (slider && input.value !== "") slider.value = input.value;
    onChange();
  });
  slider?.addEventListener("input", () => {
    input.value = slider.value;
    onChange();
  });
  const el = h("div", { class: "num" }, slider, input, UNIT[name] ? h("span", { class: "unit" }, UNIT[name]) : null);
  return {
    el,
    get: () => (input.value === "" ? undefined : Number(input.value)),
    set: (v) => {
      input.value = v === undefined || v === null ? "" : String(v);
      if (slider && input.value !== "") slider.value = input.value;
    },
  };
}

function json(onChange: () => void, placeholder: string): Control {
  const el = h("textarea", { rows: 2, class: "mono", placeholder, oninput: onChange });
  return {
    el,
    get: () => {
      if (!el.value.trim()) return undefined;
      try {
        return JSON.parse(el.value) as unknown;
      } catch {
        throw new Error("not valid JSON");
      }
    },
    set: (v) => void (el.value = v === undefined ? "" : JSON.stringify(v)),
  };
}

/** `ST36:right, SP9:right, ashi:a1` ⇄ point references. A point id is given as the library spells it, however it was typed. */
const parseRef = (s: string, ctx: FormContext): unknown => {
  const t = s.trim();
  if (/^ashi:/i.test(t)) return { ashi: t.slice(5).trim() };
  const [typed = "", side] = t.split(":").map((x) => x.trim());
  const key = typed.toLowerCase();
  const known = ctx.library.points.find((p) => p.id.toLowerCase() === key) ?? ctx.library.points.find((p) => p.aliases.some((a) => a.toLowerCase() === key));
  return { point: known?.id ?? typed, side: (side || "right").toLowerCase() };
};
const showRef = (r: unknown): string => {
  const o = r as { ashi?: string; point?: string; side?: string };
  return o?.ashi ? `ashi:${o.ashi}` : `${o?.point ?? ""}:${o?.side ?? ""}`;
};

function refs(many: boolean, ctx: FormContext, onChange: () => void): Control {
  const el = h("input", { type: "text", placeholder: many ? "ST36:right, SP9:right, ashi:a1" : "ST36:right  or  ashi:a1", oninput: onChange });
  return {
    el,
    get: () => {
      const parts = el.value.split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length === 0) return undefined;
      return many ? parts.map((x) => parseRef(x, ctx)) : parseRef(parts[0]!, ctx);
    },
    set: (v) => void (el.value = v === undefined ? "" : Array.isArray(v) ? v.map(showRef).join(", ") : showRef(v)),
  };
}

function list(onChange: () => void, placeholder: string, lines = false): Control {
  const el = lines ? h("textarea", { rows: 2, placeholder, oninput: onChange }) : h("input", { type: "text", placeholder, oninput: onChange });
  return {
    el,
    get: () => {
      const parts = el.value.split(lines ? "\n" : ",").map((x) => x.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    },
    set: (v) => void (el.value = Array.isArray(v) ? (v as string[]).join(lines ? "\n" : ", ") : ""),
  };
}

/** Where to walk: a room, a fixture, a person, a body site or a spot. */
function moveTarget(ctx: FormContext, onChange: () => void): Control {
  const kind = h("select", null, ...["room", "fixture", "person", "site", "spot"].map((k) => h("option", { value: k }, k)));
  const slot = h("span", { class: "row" });
  let current: Control = select([], false, onChange);
  const sites = [...ctx.view.space.patient.sites.inReach.map((s) => ({ value: s, text: `${s} (in reach)` })), ...ctx.view.space.patient.sites.outOfReach.map((s) => ({ value: s.site, text: `${s.site} (${s.distance} m)` }))];
  const build = () => {
    const k = kind.value;
    if (k === "room") current = select(ctx.scene.rooms.map((r) => ({ value: r.id, text: r.label })), false, onChange);
    else if (k === "fixture") current = select(ctx.view.space.fixtures.map((f) => ({ value: f.id, text: `${f.label} (${f.inReach ? "in reach" : `${f.distance} m`})` })), false, onChange);
    else if (k === "person") current = select([{ value: "patient", text: `${ctx.view.patient.name} (patient)` }, ...ctx.view.team.filter((t) => t.id !== ctx.view.you.id).map((t) => ({ value: t.id, text: t.name }))], false, onChange);
    else if (k === "site") current = select(sites, false, onChange);
    else {
      const x = h("input", { type: "number", step: "0.1", placeholder: "x", oninput: onChange });
      const z = h("input", { type: "number", step: "0.1", placeholder: "z", oninput: onChange });
      current = { el: h("span", { class: "row" }, x, z), get: () => (x.value === "" || z.value === "" ? undefined : { x: Number(x.value), z: Number(z.value) }), set: (v) => ((x.value = String((v as { x: number }).x)), (z.value = String((v as { z: number }).z))) };
    }
    slot.replaceChildren(current.el);
  };
  kind.addEventListener("change", () => {
    build();
    onChange();
  });
  build();
  return {
    el: h("div", { class: "row" }, kind, slot),
    get: () => {
      const v = current.get();
      if (v === undefined) return undefined;
      const k = kind.value;
      if (k === "room") return { room: v };
      if (k === "fixture") return { fixture: v };
      if (k === "person") return { person: v };
      if (k === "site") {
        const [region, side] = String(v).split(":");
        return { region, side };
      }
      return v;
    },
    set: (v) => {
      const o = (typeof v === "string" ? { room: v } : v) as Record<string, unknown>;
      kind.value = "room" in o ? "room" : "fixture" in o ? "fixture" : "person" in o ? "person" : "region" in o ? "site" : "spot";
      build();
      current.set("room" in o ? o.room : "fixture" in o ? o.fixture : "person" in o ? o.person : "region" in o ? `${String(o.region)}:${String(o.side)}` : o);
    },
  };
}

/** The response at each needle, with the evidence of that needle it rests on. */
function responses(ctx: FormContext, onChange: () => void): Control {
  const rows = ctx.view.needling.map((n) => {
    const which = h("select", { onchange: onChange }, h("option", { value: "" }, "— not recorded"), h("option", { value: "deqi" }, "deqi"), h("option", { value: "none" }, "none"), h("option", { value: "not-sought" }, "not sought"));
    const ev = checks(n.evidence.map((e) => ({ value: e.id, text: `${e.id}: ${e.text}`, title: e.text })), onChange, "checks evidence");
    return { n, which, ev, el: h("div", { class: "response" }, h("div", { class: "row" }, h("b", null, `${n.needle} · ${n.target}`), which), n.evidence.length ? ev.el : h("div", { class: "muted" }, "no evidence obtained of this needle")) };
  });
  return {
    el: h("div", { class: "responses" }, rows.length ? rows.map((r) => r.el) : h("div", { class: "muted" }, "no needles this visit")),
    get: () => {
      const out = rows.filter((r) => r.which.value).map((r) => ({ needle: r.n.needle, response: r.which.value, evidence: (r.ev.get() as string[] | undefined) ?? [] }));
      return out.length ? out : undefined;
    },
    set: (v) => {
      for (const x of (Array.isArray(v) ? v : []) as { needle: string; response: string; evidence?: string[] }[]) {
        const row = rows.find((r) => r.n.needle === x.needle);
        if (!row) continue;
        row.which.value = x.response;
        row.ev.set(x.evidence ?? []);
      }
    },
  };
}

/** The evidence obtained so far, as things to tick. */
function evidence(ctx: FormContext, onChange: () => void): Control {
  const r = ctx.view.record;
  const items = [
    ...r.history.map((x) => ({ value: x.id, text: `${x.id} — ${x.answer}`, title: `${x.question} → ${x.answer}` })),
    ...r.examination.map((x) => ({ value: x.id, text: `${x.id} — ${x.finding}`, title: `${x.manoeuvre}: ${x.finding}` })),
    ...r.results.map((x) => ({ value: x.id, text: `${x.id} — ${x.text}` })),
    ...r.vitals.map((x) => ({ value: x.id, text: `${x.id} — ${Object.entries(x.vitals).map(([k, v]) => `${k} ${v}`).join(", ")}` })),
    ...r.observations.map((x) => ({ value: x.id, text: `${x.id} — ${x.text}` })),
  ];
  if (items.length === 0) return { el: h("div", { class: "muted" }, "nothing obtained yet: ask, examine, review"), get: () => undefined, set: () => undefined };
  return checks(items, onChange, "checks evidence");
}

function control(type: string, f: FieldEntry, ctx: FormContext, onChange: () => void, siblings: () => Record<string, Control>): Control {
  const s = f.spec;
  const v = ctx.view;
  const named = (opts: { value: string; text: string }[]) => select(opts, f.optional, onChange);
  switch (f.name) {
    case "needleId": {
      // the needles the act is about come first: one in the hand to insert, those in the patient to work or withdraw
      const first = type === "insert_needle" ? /hand/ : /in the patient/;
      const needles = [...v.equipment.needles].sort((a, b) => Number(first.test(b.where)) - Number(first.test(a.where)));
      return named(needles.map((n) => ({ value: n.id, text: `${n.id} — ${n.where}` })));
    }
    case "packId":
      return named(v.equipment.packs.map((p) => ({ value: p.id, text: `${p.id} — ${p.where}${p.sealed ? "" : " (opened)"}` })));
    case "object":
      return named([...v.equipment.needles.map((n) => ({ value: n.id, text: `${n.id} — ${n.where}` })), ...v.equipment.packs.map((p) => ({ value: p.id, text: `${p.id} (pack) — ${p.where}` }))]);
    case "item":
      return named([...v.equipment.packs.map((p) => ({ value: p.id, text: `${p.id} — ${p.spec}` })), ...ctx.library.clinic.supplies.map((x) => ({ value: x.id, text: x.label }))]);
    case "mark":
      return named(v.localisation.marks.map((m) => ({ value: m.id, text: `${m.id} — ${m.target} (${m.region} ${m.side}, u ${m.u}, v ${m.v})${m.stale ? " — moved" : ""}` })));
    case "taskId":
      return named(v.tasks.map((t) => ({ value: t.id, text: `${t.id} — ${t.kind} (${t.status})` })));
    case "region": {
      const c = named(ctx.scene.regions.map((r) => ({ value: r.id, text: r.title })));
      c.el.addEventListener("change", () => {
        for (const k of ["landmark", "segment"]) siblings()[k]?.set(undefined);
        (siblings().landmark?.el as HTMLElement & { refill?: () => void })?.refill?.();
        (siblings().segment?.el as HTMLElement & { refill?: () => void })?.refill?.();
      });
      return c;
    }
    case "landmark":
    case "segment": {
      const el = h("select", { onchange: onChange }) as HTMLSelectElement & { refill?: () => void };
      const refill = () => {
        const region = ctx.scene.regions.find((r) => r.id === siblings().region?.get());
        const side = String(siblings().side?.get() ?? "right");
        const items = f.name === "landmark" ? (region?.landmarks ?? []).map((l) => ({ id: l.id.replace("{side}", side), label: l.label })) : (region?.segments ?? []).map((g) => ({ id: g.id, label: `${g.label} (${g.cun} cun)` }));
        const keep = el.value;
        el.replaceChildren(...(f.optional ? [h("option", { value: "" }, "—")] : []), ...items.map((i) => h("option", { value: i.id }, i.label)));
        if (items.some((i) => i.id === keep)) el.value = keep;
      };
      el.refill = refill;
      // once its siblings exist: the list as the chart and the side stand now, and again when the side changes
      queueMicrotask(() => {
        refill();
        siblings().side?.el.addEventListener("change", () => {
          refill();
          onChange();
        });
      });
      return {
        el,
        get: () => el.value || undefined,
        // the chart and the side are set before this (the schema's order): the list is theirs before a value is chosen
        set: (x) => {
          refill();
          el.value = typeof x === "string" ? x : "";
        },
      };
    }
    case "pattern":
      return named(ctx.library.vocabulary.patterns.map((p) => ({ value: p.id, text: `${p.label}${p.zh ? ` ${p.zh}` : ""}` })));
    case "diagnoses":
      return checks(ctx.library.vocabulary.diagnoses.map((d) => ({ value: d.id, text: d.label })), onChange);
    case "redFlags":
      return checks(ctx.library.vocabulary.redFlags.map((d) => ({ value: d.id, text: d.label })), onChange);
    case "patternEvidence":
      return evidence(ctx, onChange);
    case "responses":
      return responses(ctx, onChange);
    case "points":
    case "pointsUsed":
      return refs(true, ctx, onChange);
    case "target":
      return refs(false, ctx, onChange);
    case "to":
      if (type === "move") return moveTarget(ctx, onChange);
      if (type === "refer") return named(ctx.library.clinic.referralTargets.map((r) => ({ value: r.id, text: r.label })));
      return named([...(type === "say" ? [] : []), ...v.team.filter((t) => t.id !== v.you.id).map((t) => ({ value: t.id, text: t.name }))]);
    case "findings":
      return list(onChange, "finding ids, comma separated");
    case "alternatives":
      return list(onChange, "one alternative a line", true);
    default:
      break;
  }
  switch (s.kind) {
    case "enum":
      return select(s.options.map((o) => ({ value: o, text: o })), f.optional && f.default === undefined, onChange);
    case "boolean": {
      const el = h("input", { type: "checkbox", onchange: onChange });
      return { el, get: () => (el.checked ? true : f.default !== undefined ? false : undefined), set: (x) => void (el.checked = x === true) };
    }
    case "number":
      return number(f.name, s, f.default, onChange);
    case "string":
      return text(s, onChange, f.name === "text" ? "in your own words" : "");
    case "array":
      if (s.of.kind === "enum") return checks(s.of.options.map((o) => ({ value: o, text: o })), onChange);
      if (s.of.kind === "string") return list(onChange, "comma separated");
      return json(onChange, "[ … ]");
    case "object":
      return group(type, s.fields, ctx, onChange);
    default:
      return json(onChange, "JSON");
  }
}

function group(type: string, fields: FieldEntry[], ctx: FormContext, onChange: () => void): Control & { controls: Record<string, Control> } {
  const controls: Record<string, Control> = {};
  const rows: Child[] = [];
  for (const f of fields) {
    const c = control(type, f, ctx, onChange, () => controls);
    controls[f.name] = c;
    if (f.default !== undefined && typeof f.default !== "object") c.set(f.default);
    const nested = f.spec.kind === "object";
    rows.push(
      h(
        nested ? "fieldset" : "div",
        { class: nested ? "nested" : `field${f.optional ? " optional" : ""}`, dataset: { field: f.name } },
        nested ? h("legend", null, label(f.name)) : h("label", { title: HELP[f.name] ?? "" }, label(f.name), f.optional ? null : h("i", null, " *")),
        c.el,
        HELP[f.name] ? h("small", null, HELP[f.name]) : null,
      ),
    );
  }
  return {
    el: h("div", { class: "fields" }, rows),
    controls,
    get: () => {
      const out: Record<string, unknown> = {};
      let missing: string | null = null;
      for (const f of fields) {
        let v: unknown;
        try {
          v = controls[f.name]!.get();
        } catch (e) {
          if (!(e instanceof Incomplete)) throw e;
          // an optional part left wholly empty (`at`, when the needle goes in at a mark) is simply not there
          if (!(f.optional && e.partial === undefined)) missing ??= e.message;
          v = e.partial;
        }
        if (v === undefined || (f.default !== undefined && typeof f.default !== "object" && v === f.default)) {
          if (!f.optional) missing ??= `${label(f.name)} is needed`;
          continue;
        }
        out[f.name] = v;
      }
      const value = Object.keys(out).length ? out : undefined;
      if (missing) throw new Incomplete(missing, value);
      return value;
    },
    set: (v) => {
      for (const [k, x] of Object.entries((v ?? {}) as Record<string, unknown>)) controls[k]?.set(x);
    },
  };
}

/** A form for one action. `changed` runs on every edit with the action as it stands (or the reason it is incomplete). */
export function buildForm(spec: ActionSpec, ctx: FormContext, initial: Record<string, unknown> = {}, changed: (action: Record<string, unknown> | null, why?: string) => void = () => undefined): Form {
  let raw: HTMLTextAreaElement | null = null;
  let edited = false;
  const read = (): Record<string, unknown> => {
    if (edited && raw) {
      const parsed = JSON.parse(raw.value) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || parsed.type !== spec.type) throw new Error(`the JSON must be a ${spec.type} action`);
      return parsed;
    }
    return { type: spec.type, ...((fields.get() as Record<string, unknown> | undefined) ?? {}) };
  };
  const onChange = () => {
    edited = false;
    try {
      const action = read();
      if (raw) raw.value = JSON.stringify(action, null, 1);
      raw?.classList.remove("bad");
      changed(action);
    } catch (e) {
      if (raw && e instanceof Incomplete) raw.value = JSON.stringify({ type: spec.type, ...((e.partial as Record<string, unknown> | undefined) ?? {}) }, null, 1);
      changed(null, (e as Error).message);
    }
  };
  const fields = group(spec.type, spec.fields, ctx, onChange);
  fields.set(initial);
  raw = h("textarea", {
    class: "mono raw",
    rows: 3,
    spellcheck: false,
    oninput: () => {
      edited = true;
      try {
        changed(read());
        raw!.classList.remove("bad");
      } catch (e) {
        raw!.classList.add("bad");
        changed(null, (e as Error).message);
      }
    },
  });
  const el = h("div", { class: "form" }, h("p", { class: "summary" }, spec.summary), fields.el, h("details", { class: "json" }, h("summary", null, "as it will be sent"), raw));
  queueMicrotask(onChange);
  return {
    el,
    type: spec.type,
    value: read,
    peek: () => {
      try {
        return read();
      } catch (e) {
        return { type: spec.type, ...((e instanceof Incomplete ? (e.partial as Record<string, unknown> | undefined) : undefined) ?? {}) };
      }
    },
    set: (name, value) => {
      const path = name.split(".");
      let c: Control | undefined = fields.controls[path[0]!];
      for (const p of path.slice(1)) c = (c as Control & { controls?: Record<string, Control> } | undefined)?.controls?.[p];
      c?.set(value);
      onChange();
    },
  };
}
