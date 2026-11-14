import type { AgentView } from "@acucraft/core";
import type { Attribution } from "../src/hub.js";

/**
 * Words for the record: labels, tones, the evidence by id, and the ids a field of a form may take — from the
 * practitioner's own view and the public library, never anything hidden. Pure, and tested on its own.
 */

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

/** What a timeline entry's status means at a glance. */
export function statusTone(status: string): Tone {
  return status === "executed" ? "ok" : status === "partial" ? "warn" : status === "blocked" ? "bad" : "muted";
}

export function consentTone(consent: string): Tone {
  return consent === "given" ? "ok" : consent === "withdrawn" || consent === "refused" ? "bad" : consent === "not-sought" || consent === "none" ? "muted" : "warn";
}

export function appearanceTone(appearance: string): Tone {
  return /faint|clammy|pale/.test(appearance) ? "bad" : /anxious|tense/.test(appearance) ? "warn" : "ok";
}

/** Who acted, in a few words. */
export function byLabel(by: Attribution): string {
  return by.kind === "operator" ? by.name : by.kind === "llm" ? `LLM · ${by.name}` : `MCP · ${by.name}`;
}

/** An id or a key as words: `supine-knee-flexed` → "supine knee flexed". */
export function words(id: string): string {
  return id.replace(/[-_]+/g, " ");
}

/** A simulated minute. */
export function minute(n: number): string {
  return `min ${Number.isInteger(n) ? n : n.toFixed(1)}`;
}

/** A wall-clock time, as hours, minutes and seconds. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** How long ago, roughly. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** An action's input in one short line: `text: "What brings you…", to: patient`. */
export function inputSummary(input: Record<string, unknown>, max = 140): string {
  const part = (v: unknown): string => {
    if (typeof v === "string") return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);
    if (Array.isArray(v)) return `[${v.map(part).join(", ")}]`;
    if (v && typeof v === "object") return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${part(x)}`).join(", ")} }`;
    return String(v);
  };
  const line = Object.entries(input).map(([k, v]) => `${k}: ${part(v)}`).join(", ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Everything obtained in the encounter, by id: what each piece of evidence says. */
export function evidenceIndex(view: AgentView): Map<string, { kind: string; text: string }> {
  const out = new Map<string, { kind: string; text: string }>();
  for (const h of view.record.history) out.set(h.id, { kind: "history", text: `${h.question} — ${h.answer}` });
  for (const e of view.record.examination) out.set(e.id, { kind: "examination", text: `${e.manoeuvre}: ${e.finding}` });
  for (const r of view.record.results) out.set(r.id, { kind: "record", text: r.text });
  for (const v of view.record.vitals) out.set(v.id, { kind: "vital signs", text: Object.entries(v.vitals).map(([k, x]) => `${k} ${x}`).join(", ") });
  for (const o of view.record.observations) out.set(o.id, { kind: "observation", text: o.text });
  for (const n of view.needling) for (const e of n.evidence) out.set(e.id, { kind: `needle ${n.needle} (${e.from})`, text: e.text });
  return out;
}

/** The parts of a clinical note (`document`), in the order a note is read. */
export const NOTE_FIELDS: readonly [string, string][] = [
  ["presentingComplaint", "Presenting complaint"],
  ["history", "History"],
  ["examination", "Examination"],
  ["assessment", "Assessment"],
  ["pattern", "TCM pattern"],
  ["rationale", "Rationale"],
  ["consent", "Consent"],
  ["response", "Response to treatment"],
  ["adverseEvents", "Adverse events"],
  ["advice", "Advice given"],
  ["followUp", "Follow-up"],
];

/** The public library, cut to what the forms suggest. */
export interface LibraryLite {
  diagnoses: Option[];
  patterns: Option[];
  redFlags: Option[];
  referralTargets: Option[];
  rooms: Option[];
  supplies: Option[];
  points: Option[];
  regions: Option[];
  landmarks: Option[];
  segments: Option[];
}

export interface Option {
  value: string;
  label?: string;
}

const opts = (items: unknown, label = (x: Record<string, unknown>) => String(x.label ?? x.title ?? "")): Option[] =>
  Array.isArray(items) ? items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string").map((x) => ({ value: x.id as string, label: label(x) || undefined })) : [];

/** The library cut down, from the answers of `lookup` (vocabulary, clinic, points, regions, and each region). */
export function libraryLite(parts: { vocabulary?: unknown; clinic?: unknown; points?: unknown; regions?: unknown; region?: unknown[] }): LibraryLite {
  const v = (parts.vocabulary ?? {}) as Record<string, unknown>;
  const c = (parts.clinic ?? {}) as Record<string, unknown>;
  const byChannel = ((parts.points ?? {}) as { byChannel?: Record<string, string[]> }).byChannel ?? {};
  const regions = (parts.region ?? []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as Record<string, unknown>).id === "string");
  return {
    diagnoses: opts(v.diagnoses),
    patterns: opts(v.patterns, (x) => [x.label, x.zh].filter(Boolean).join(" ")),
    redFlags: opts(v.redFlags),
    referralTargets: opts(c.referralTargets),
    rooms: opts(c.rooms),
    supplies: opts(c.supplies),
    points: Object.values(byChannel).flat().map((id) => ({ value: id })),
    regions: opts(parts.regions),
    landmarks: regions.flatMap((r) => opts(r.landmarks, (x) => `${String(x.label ?? "")} (${String(r.id)})`)),
    segments: regions.flatMap((r) => opts(r.segments, (x) => `${String(x.label ?? "")} (${String(r.id)})`)),
  };
}

const uniq = (options: Option[]): Option[] => {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
};

/**
 * The values a field of a form may take, from the practitioner's view and the library: the needles, marks and packs
 * in front of them, the evidence they obtained, the points, regions and landmarks of the library, the people of the
 * team. Hints only — the engine still decides.
 */
export function suggestions(tool: string, path: string, view: AgentView, lib: LibraryLite | null): Option[] {
  const key = (path.split(".").pop() ?? path).replace(/\[\]$/, "");
  const needles = (): Option[] => uniq([...view.needling.map((n) => ({ value: n.needle, label: `${n.target}${n.inPlace ? ", in place" : ", out"}` })), ...view.equipment.needles.map((n) => ({ value: n.id, label: n.where }))]);
  const packs = (): Option[] => view.equipment.packs.map((p) => ({ value: p.id, label: `${p.sealed ? "sealed" : "opened"}, ${p.needles} needles, ${p.spec}` }));
  const team = (): Option[] => view.team.filter((m) => m.id !== view.you.id).map((m) => ({ value: m.id, label: `${m.name} (${m.role})` }));
  const evidence = (): Option[] => [...evidenceIndex(view)].filter(([, e]) => !e.kind.startsWith("needle")).map(([id, e]) => ({ value: id, label: `${e.kind}: ${e.text.slice(0, 80)}` }));
  switch (key) {
    case "needleId":
    case "needle":
      return needles();
    case "evidence":
      return view.needling.flatMap((n) => n.evidence.map((e) => ({ value: e.id, label: `${n.needle}, ${e.from}: ${e.text.slice(0, 70)}` })));
    case "mark":
      return view.localisation.marks.map((m) => ({ value: m.id, label: `${m.target}${m.stale ? " (stale)" : ""}` }));
    case "packId":
      return packs();
    case "object":
      return uniq([...needles(), ...packs(), ...(lib?.supplies ?? [])]);
    case "item":
      return uniq([...(lib?.supplies ?? []), ...packs()]);
    case "region":
      return uniq([...view.patient.reachable.map((r) => ({ value: r.region, label: `reachable: ${r.sides.join(", ")}` })), ...(lib?.regions ?? [])]);
    case "landmark":
      return lib?.landmarks ?? [];
    case "segment":
      return lib?.segments ?? [];
    case "point":
      return lib?.points ?? [];
    case "ashi":
      return view.record.tenderPoints.map((t) => ({ value: t.id, label: `${t.label} (${t.region}, ${t.side})` }));
    case "taskId":
      return view.tasks.map((t) => ({ value: t.id, label: `${t.kind} → ${t.to}: ${t.status}` }));
    case "to":
      return tool === "refer" ? (lib?.referralTargets ?? []) : tool === "say" ? [{ value: "patient", label: "the patient" }, ...team()] : team();
    case "room":
      return lib?.rooms ?? [];
    case "fixture":
      return view.space.fixtures.map((f) => ({ value: f.id, label: `${f.label} (${f.room}${f.inReach ? ", in reach" : `, ${f.distance} m`})` }));
    case "person":
      return [{ value: "patient", label: "the patient" }, ...team()];
    case "diagnoses":
      return lib?.diagnoses ?? [];
    case "pattern":
      return tool === "assess" ? (lib?.patterns ?? []) : [];
    case "redFlags":
      return lib?.redFlags ?? [];
    case "patternEvidence":
    case "findings":
      return evidence();
    default:
      return [];
  }
}
