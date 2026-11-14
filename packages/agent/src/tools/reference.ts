import type { AgentView } from "@acucraft/core";
import { constructPoint, requirements, type Observed } from "../localise.js";
import type { Library, ReadTool, ToolContext } from "./types.js";

/**
 * The read-only tools: the public reference library (`lookup`), the practitioner's own view (`view`), the
 * arithmetic of proportional localisation on what they have palpated and measured (`construct_point`) and the
 * clinic's written skills (`read_skill`). None takes simulated time, none changes anything, and none can see what
 * the practitioner could not: they read the library and the view, never the scenario.
 */

type Side = "left" | "right" | "midline";

export const LOOKUP_TOPICS = ["points", "point", "region", "regions", "vocabulary", "pattern", "deqi", "clinic", "floorplan", "roles", "rules", "evidence"] as const;

/** Point ids grouped by channel: the whole library in a few kilobytes. */
const idsByChannel = (lib: Library) => {
  const out: Record<string, string[]> = {};
  for (const p of lib.points) (out[p.channel] ??= []).push(p.id);
  return out;
};

/** One entry of the reference library. */
export function lookup(lib: Library, input: { topic?: string; id?: string }): unknown {
  switch (input.topic) {
    case "points": {
      const summary = (p: Library["points"][number]) => ({ id: p.id, name: `${p.names.pinyin} ${p.names.hanzi}`, channel: p.channel, area: p.area, region: p.region });
      if (input.id) {
        const key = input.id.toLowerCase();
        const found = lib.points.filter((p) => p.channel.toLowerCase() === key || p.area === key || p.region === key);
        return found.length > 0 ? found.map((p) => ({ ...summary(p), location: p.location })) : { error: `no points for ${input.id}: give a channel (ST), a body area (forearm) or a region (knee-leg)` };
      }
      const needleable: Record<string, string[]> = {};
      for (const p of lib.points) {
        // a group point is needled site by site, under each region its sites lie on
        const regions = p.siteLocalisations ? [...new Set(p.siteLocalisations.map((x) => x.region))] : p.localisation && p.region ? [p.region] : [];
        for (const r of regions) (needleable[r] ??= []).push(p.id);
      }
      return {
        total: lib.points.length,
        needleable,
        byChannel: idsByChannel(lib),
        note: "needleable: the points localised on a regional model, by region (ids only: use topic points with a region, channel or body area for names and locations). A group point with siteLocalisations (Sishencong, Jiaji, Shixuan …) is planned, marked and needled site by site: name the site in the target. The others can be looked up, planned and discussed but not needled.",
      };
    }
    case "point": {
      const key = (input.id ?? "").toUpperCase();
      return lib.points.find((p) => p.id.toUpperCase() === key || p.aliases.some((a) => a.toUpperCase() === key)) ?? { error: `no point ${input.id}`, byChannel: idsByChannel(lib) };
    }
    case "region":
      return lib.regions.find((r) => r.id === input.id) ?? { error: `no region ${input.id} in this encounter`, available: lib.regions.map((r) => r.id) };
    case "regions":
      return lib.regions.map((r) => ({ id: r.id, title: r.title, laterality: r.laterality, chart: r.chart.description }));
    case "vocabulary":
      // the ids to assess with; what links a pattern and deqi to evidence is under "pattern" and "deqi"
      return { diagnoses: lib.vocabulary.diagnoses, patterns: lib.vocabulary.patterns.map((p) => ({ id: p.id, label: p.label, zh: p.zh })), redFlags: lib.vocabulary.redFlags, note: "lookup pattern for what each pattern is recognised by, and deqi for the needle sensations." };
    case "pattern": {
      const v = lib.vocabulary;
      const sign = (id: string) => {
        const x = v.signs.find((y) => y.id === id);
        return x ? `${x.label} [${x.method}]` : id;
      };
      const full = (p: (typeof v.patterns)[number]) => ({ id: p.id, label: p.label, zh: p.zh, key: (p.criteria?.key ?? []).map(sign), supporting: (p.criteria?.supporting ?? []).map(sign), against: (p.criteria?.against ?? []).map(sign) });
      const rule = { rule: `A differentiation names the findings it rests on (assess.patternEvidence). It rests on them when they show at least ${v.differentiation.key} key sign(s) of the pattern and ${v.differentiation.total} of its signs in all, and what you have found does not show ${v.differentiation.against} signs that speak against it.`, note: v.differentiation.note ?? null, sources: v.differentiation.sources };
      if (input.id) {
        const p = v.patterns.find((x) => x.id === input.id);
        return p ? { ...full(p), ...rule } : { error: `no pattern ${input.id}`, available: v.patterns.map((x) => x.id) };
      }
      return { ...rule, patterns: v.patterns.map(full) };
    }
    case "deqi":
      return { ...(lib.vocabulary.deqi ?? { definition: "not described in this pack" }), sensations: lib.vocabulary.sensations, record: "document → needling.responses: one entry for each needle — { needle, response: deqi | none | not-sought, evidence: [ids of that needle's evidence] }." };
    case "clinic":
      return lib.clinic;
    case "floorplan":
      return lib.clinic.floorPlan;
    case "roles":
      return lib.roles;
    case "rules":
      return lib.rules;
    case "evidence":
      return lib.evidence;
    default:
      return { error: `unknown topic ${input.topic}`, topics: LOOKUP_TOPICS };
  }
}

const record = (input: unknown): Record<string, unknown> => (input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export const lookupTool: ReadTool = {
  kind: "read",
  name: "lookup",
  description:
    "Read the public reference library. Topics: points (the index: every point that can be needled, by regional model, and every point id by channel; with id, the points of one channel, body area or region), point (one point in full by id or alias: location, construction, cautions), region (one regional chart by id: landmarks and how each is found, segments and their cun, seams with neighbouring charts), regions, vocabulary (the diagnosis, pattern and red-flag ids to assess with), pattern (what each pattern is recognised by and what speaks against it; with id, one pattern), deqi (the needle sensations, which of them are deqi, what counts as evidence), clinic (rooms, where supplies are kept, referral targets), floorplan (rooms, doors, fixtures and reach distances in metres), roles, rules (the rule sets in force on each visit's date), evidence (guideline records for the condition). Call it whenever a decision rests on a definition, an id or a rule you have not read in this encounter.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", enum: [...LOOKUP_TOPICS] },
      id: { type: "string", description: "point: a point id or alias (ST36, SJ5). region: a region id (knee-leg). points: a channel (ST), a body area (forearm) or a region (knee-leg). pattern: a pattern id (wind-cold-damp-bi)." },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const { topic, id } = record(input);
    const output = lookup(ctx.library, { topic: text(topic), id: text(id) });
    return { ok: !(output && typeof output === "object" && "error" in output), output };
  },
};

/** The sections of the view a caller may ask for one at a time. */
export const VIEW_SECTIONS = ["you", "space", "patient", "conversation", "record", "assessment", "needling", "localisation", "plan", "equipment", "team", "tasks", "counts", "couches", "rules", "last", "teaching"] as const satisfies readonly (keyof AgentView)[];

export const viewTool: ReadTool = {
  kind: "read",
  name: "view",
  description:
    "Read your current view of the encounter: where you stand and what is within reach (space), the patient, the conversation, the record of everything obtained with its evidence ids (record), your latest assessment, each needle and its evidence (needling), the landmarks, measurements and marks of this visit (localisation), the plan and consent, packs and needles (equipment), the team, tasks, counts, couches and the rules in force. Give `section` for one part, or nothing for the whole view. Each action's result already tells you what that action changed: read the view when you need the whole of something, or after a long stretch of work.",
  inputSchema: {
    type: "object",
    properties: { section: { type: "string", enum: [...VIEW_SECTIONS], description: "One part of the view; leave out for all of it." } },
    required: [],
    additionalProperties: false,
  },
  run(input, ctx) {
    const section = text(record(input).section);
    if (!section) return { ok: true, output: ctx.view };
    if (!(VIEW_SECTIONS as readonly string[]).includes(section)) return { ok: false, output: { error: `no section ${section}`, sections: VIEW_SECTIONS } };
    const value = ctx.view[section as keyof AgentView];
    return { ok: true, output: { minute: ctx.view.minute, [section]: value ?? null } };
  },
};

/** The practitioner's own palpations and measurements of this visit on one chart and side, in its current configuration. */
function observedBy(view: AgentView): (region: string, side: Side) => Observed {
  return (region, side) => {
    const now = view.patient.reachable.find((r) => r.region === region)?.configuration;
    return {
      landmarks: new Map(view.localisation.landmarks.filter((l) => l.region === region && l.side === side && (now === undefined || l.configuration === now)).map((l) => [l.landmark, { u: l.u, v: l.v }])),
      segments: new Map(view.localisation.measurements.filter((m) => m.region === region && m.side === side).map((m) => [m.what, m.cm])),
    };
  };
}

/**
 * Where a point lies on this patient, worked out from what the practitioner has palpated and measured — the public
 * construction of the point applied to their own observations. When something is still needed it says what.
 */
export function locate(ctx: Pick<ToolContext, "library" | "view">, input: { point?: string; side?: string; site?: string }): { ok: boolean; output: unknown } {
  const lib = ctx.library;
  const key = (input.point ?? "").toUpperCase();
  const p = lib.points.find((x) => x.id.toUpperCase() === key || x.aliases.some((a) => a.toUpperCase() === key));
  if (!p) return { ok: false, output: { error: `no point ${input.point ?? ""}: lookup points for the ids` } };
  const side = (p.bilateral ? input.side : "midline") as Side | undefined;
  if (side !== "left" && side !== "right" && side !== "midline") return { ok: false, output: { error: `${p.id} is bilateral: give side left or right` } };
  if (p.bilateral && side === "midline") return { ok: false, output: { error: `${p.id} is bilateral: give side left or right` } };
  if (p.siteLocalisations && !input.site) return { ok: false, output: { error: `${p.id} is a group of sites: give one site`, sites: p.siteLocalisations.map((s) => ({ id: s.id, label: s.label, region: s.region })) } };
  if (!p.siteLocalisations && input.site) return { ok: false, output: { error: `${p.id} is a single point: it has no sites` } };
  const needs = requirements(lib, p.id, side, input.site);
  if (!needs) return { ok: false, output: { error: `${p.id}${input.site ? ` (${input.site})` : ""} has no construction on a regional model of this encounter: it can be looked up and discussed, not located or needled here` } };
  const own = needs[0]!;
  const reachable = ctx.view.patient.reachable.find((r) => r.region === own.region);
  const observed = observedBy(ctx.view);
  const missing = needs
    .map((n) => {
      const have = observed(n.region, n.side);
      return { region: n.region, side: n.side, landmarks: n.landmarks.filter((l) => !have.landmarks.has(l)), segments: n.segments.filter((s) => !have.segments.has(s)) };
    })
    .filter((n) => n.landmarks.length > 0 || n.segments.length > 0);
  const access = reachable?.sides.includes(own.side) ? null : `The ${own.region} chart (${own.side}) cannot be reached with the patient ${ctx.view.patient.position}: lookup region ${own.region} for the positions that give access to it.`;
  if (missing.length > 0 || access) {
    return {
      ok: true,
      output: {
        point: p.id,
        located: false,
        ...(access ? { position: access } : {}),
        // what to palpate (identify_landmark) and measure (measure; "finger-cun": measure with fingerCun) first, chart by chart
        stillNeeded: missing,
        note: "Palpate and measure with the patient in the position you will needle in: a landmark palpated in another configuration of its chart no longer counts.",
      },
    };
  }
  const at = constructPoint(lib, p.id, side, observed, 0, input.site);
  if (!at) return { ok: false, output: { error: `${p.id} could not be constructed from the observations on record` } };
  const round = (n: number) => Math.round(n * 100) / 100;
  const used = needs.map((n) => {
    const have = observed(n.region, n.side);
    return { region: n.region, side: n.side, landmarks: Object.fromEntries(n.landmarks.map((l) => [l, have.landmarks.get(l)])), segmentsCm: Object.fromEntries(n.segments.map((s) => [s, have.segments.get(s)])) };
  });
  return {
    ok: true,
    output: {
      point: p.id,
      located: true,
      region: own.region,
      side: own.side,
      configuration: reachable?.configuration ?? null,
      at: { u: round(at.u), v: round(at.v) },
      from: used,
      // ready for mark_point: the target, the chart and the position
      mark: { target: { point: p.id, side, ...(input.site ? { site: input.site } : {}) }, region: own.region, side: own.side, at: { u: round(at.u), v: round(at.v) }, method: needs.some((n) => n.segments.includes("finger-cun")) ? "finger-cun" : own.segments.length > 0 ? "proportional" : "landmark" },
      note: "The standard location on this patient, from your own palpation and measurement. It is as good as they are; palpate at the spot before you mark, and place Ashi points by palpation.",
    },
  };
}

export const constructPointTool: ReadTool = {
  kind: "read",
  name: "construct_point",
  description:
    "Work out where a standard point lies on this patient's chart from the landmarks you have palpated and the segments you have measured in this visit: the point's public construction (proportional bone measurement, carried across a seam where a point is measured from one on a neighbouring chart) applied to your own observations. Call it before marking a point. If something is still needed it lists what to palpate and measure; once located it returns the chart position and an input ready for mark_point. It does the arithmetic only: it knows nothing you have not observed.",
  inputSchema: {
    type: "object",
    properties: {
      point: { type: "string", description: "A point id or alias (ST36, GB21, EX-LE4)." },
      side: { type: "string", enum: ["left", "right", "midline"], description: "left or right for a bilateral point; midline points need none." },
      site: { type: "string", description: "For a group point (Sishencong, Jiaji, Shixuan …): the one site meant." },
    },
    required: ["point"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const { point, side, site } = record(input);
    return locate(ctx, { point: text(point), side: text(side), site: text(site) });
  },
};

export const readSkillTool: ReadTool = {
  kind: "read",
  name: "read_skill",
  description: "Read one of the clinic's written skills in full, by id: how a part of the work is done here, step by step (the index of skills, with when to read each, is in your instructions). Read a skill when you reach the work it covers and have not read it in this encounter.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "A skill id from the index." } },
    required: ["id"],
    additionalProperties: false,
  },
  run(input, ctx) {
    const id = text(record(input).id);
    const skill = ctx.skills.find((s) => s.id === id);
    if (!skill) return { ok: false, output: { error: `no skill ${id ?? ""}`, skills: ctx.skills.map((s) => ({ id: s.id, title: s.title })) } };
    return { ok: true, output: `# ${skill.title}\n\n${skill.body}` };
  },
};
