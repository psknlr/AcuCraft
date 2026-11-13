#!/usr/bin/env -S npx tsx
/**
 * acucraft — validate the content pack, run and replay encounters, play one yourself, run the benchmark.
 * Run from the repository root: `npm run acu -- <command>` (see `npm run acu -- help`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { verifyCase } from "@clinicalcraft/core";
import {
  ACUCRAFT_VERSION,
  ActionSchema,
  clinicWorld,
  createEncounter,
  digest,
  floorPlan,
  freeSpot,
  observeAs,
  patientBody,
  modelledRegions,
  patientRegion,
  pointInstance,
  pointTargets,
  referenceLibrary,
  regionAccess,
  replayLog,
  step,
  type AgentView,
  type EncounterLog,
  type EncounterState,
  type Mode,
  type Position,
  type Side,
} from "@acucraft/core";
import {
  claudeAgent,
  CLINICALCRAFT_REV,
  encounterHtml,
  episodeMarkdown,
  evaluateEncounter,
  loadContentPack,
  loadScenario,
  lookup,
  protocolAgent,
  referenceAgent,
  requireScenario,
  runEpisode,
  runSuite,
  scenarioIds,
  suiteMarkdown,
  SuiteSchema,
  DEFAULT_CONTENT_DIR,
  type Agent,
  type Effort,
} from "@acucraft/bench";
import type { Scenario } from "@acucraft/core";

const HELP = `acucraft — acupuncture simulation and evaluation (Singapore edition)

usage: npm run acu -- <command> [options]

  validate [--verbose]                      check the pack: schemas, references, ClinicalCraft case verification,
                                            and that every reference trajectory reaches an acceptable pathway
  list                                      families, variants and splits
  points [CHANNEL|AREA|REGION|POINT]        the point library: counts by channel; the points of one channel (ST),
                                            body area (forearm) or region (knee-leg); or one point in full (ST36, SJ5)
  show <family/variant> [--mode teaching] [--library]
                                            the agent's opening view (and the public reference library)
  map <family/variant>                      the clinic's floor plan: rooms, doors, fixtures and where everyone starts
  vocabulary [PATTERN]                      the signs, what each pattern is recognised by, and what counts as deqi
  locate <family/variant> <position> [POINT:side ...]
                                            authoring: the hidden patient-specific landmarks and points
  run <family/variant> [--agent protocol|reference|claude] [--seed N] [--mode assessment|teaching]
      [--model ID] [--effort low|medium|high|xhigh|max] [--max-steps N] [--out DIR] [--verbose]
                                            run one encounter; writes log.json, report.json and report.md
  play <family/variant> [--mode teaching] [--seed N] [--out DIR]
                                            play the practitioner yourself (type help inside)
  replay <log.json>                         replay a log, check it reproduces the recorded state, re-evaluate
  evaluate <log.json> [--json]              evaluate a log
  view <log.json> [--out FILE]              an HTML view of the encounter: the floor plan with every walk, charts with
                                            landmarks, structures, reference locations and entries, the evidence
                                            links and the timeline (shows hidden truth)
  bench [--suite FILE] [--agent ...] [--split dev|held-out|all] [--out DIR] [--model ID] [--effort ...]
                                            run a benchmark suite; writes suite-result.json and report.md
  export-clinicalcraft --out DIR            write every instance's ClinicalCraft case (cases/<id>/case.json) for
                                            ClinicalCraft's contentDirs setting

  --content DIR                             another content pack (default: ./content)
`;

// a closed pipe (`acu points | head`) ends the command quietly
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", default: "protocol" },
    seed: { type: "string", default: "1" },
    mode: { type: "string", default: "assessment" },
    model: { type: "string" },
    effort: { type: "string" },
    "max-steps": { type: "string" },
    out: { type: "string" },
    suite: { type: "string" },
    split: { type: "string", default: "all" },
    content: { type: "string" },
    verbose: { type: "boolean", default: false },
    library: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...args] = positionals;
const pack = () => {
  const p = loadContentPack(values.content ? resolve(values.content) : DEFAULT_CONTENT_DIR);
  const errors = p.issues.filter((i) => i.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(`error ${e.path}: ${e.message}`);
    process.exit(1);
  }
  return p;
};
const write = (path: string, data: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
const mode = (): Mode => (values.mode === "teaching" ? "teaching" : "assessment");

const FIXTURE_GLYPH: Record<string, string> = { couch: "C", chair: "h", trolley: "T", supplies: "S", "hand-hygiene": "w", "sharps-container": "!", "records-terminal": "R", screen: "|" };

/**
 * The clinic's floor plan as text, one character for half a metre: `#` wall or furniture, `.` floor that can be
 * walked, a letter for each fixture; `@` the practitioner, `P` the patient, `a` the others — where they stand in `s`.
 */
function asciiMap(sc: Scenario, s: EncounterState, actor: string): string {
  const w = clinicWorld(sc);
  const plan = floorPlan(sc);
  const step = 0.5;
  const minX = Math.min(...plan.rooms.map((r) => r.rect.minX)) - step;
  const maxX = Math.max(...plan.rooms.map((r) => r.rect.maxX)) + step;
  const minZ = Math.min(...plan.rooms.map((r) => r.rect.minZ)) - step;
  const maxZ = Math.max(...plan.rooms.map((r) => r.rect.maxZ)) + step;
  const cols = Math.round((maxX - minX) / step);
  const rows = Math.round((maxZ - minZ) / step);
  const cell = (x: number, z: number) => ({ c: Math.floor((x - minX) / step), r: Math.floor((z - minZ) / step) });
  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * step;
      const z = minZ + (r + 0.5) * step;
      const inRoom = plan.rooms.some((room) => x > room.rect.minX && x < room.rect.maxX && z > room.rect.minZ && z < room.rect.maxZ);
      row.push(freeSpot(w, { x, z }) ? "." : inRoom ? "#" : " ");
    }
    grid.push(row);
  }
  const put = (x: number, z: number, glyph: string) => {
    const { c, r } = cell(x, z);
    if (grid[r]?.[c] !== undefined) grid[r]![c] = glyph;
  };
  // a fixture covers the cells whose centre lies on its footprint (at least the one its own centre is in); where two
  // share a footprint — the sharps box on the trolley — the one listed first in the legend shows
  const order = Object.keys(FIXTURE_GLYPH);
  for (const f of [...plan.fixtures].sort((a, b) => order.indexOf(b.kind) - order.indexOf(a.kind))) {
    const glyph = FIXTURE_GLYPH[f.kind] ?? "f";
    let drawn = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = minX + (c + 0.5) * step;
        const z = minZ + (r + 0.5) * step;
        if (Math.abs(x - f.x) <= f.w / 2 && Math.abs(z - f.z) <= f.d / 2) {
          grid[r]![c] = glyph;
          drawn += 1;
        }
      }
    }
    if (drawn === 0) put(f.x - 1e-6, f.z - 1e-6, glyph);
  }
  const body = patientBody(sc, s);
  put(body.centre.x, body.centre.z, "P");
  for (const a of Object.values(s.actors)) put(a.at.x, a.at.z, a.id === actor ? "@" : "a");
  const lines = [`${sc.clinic.title} — north is up; one character is ${step} m (x ${minX}…${maxX} m east, z ${minZ}…${maxZ} m south)`, ""];
  lines.push(...grid.map((row, r) => `${(minZ + (r + 0.5) * step).toFixed(2).padStart(6)}  ${row.join("")}`));
  lines.push("", "  @ you   P patient   a the team   . floor   # wall or furniture   C couch  h chair  T trolley/worktop  S supplies  w hand hygiene  ! sharps  R records  | screen", "");
  lines.push("rooms");
  for (const room of plan.rooms) lines.push(`  ${room.id.padEnd(16)} ${room.label.padEnd(22)} x ${room.rect.minX}…${room.rect.maxX}, z ${room.rect.minZ}…${room.rect.maxZ}; door(s) ${room.doors.map((d) => `(${d.x}, ${d.z})${d.to ? ` to ${d.to}` : ""}`).join(", ") || "—"}`);
  lines.push("fixtures");
  for (const f of plan.fixtures) lines.push(`  ${f.id.padEnd(20)} ${f.kind.padEnd(17)} ${f.room.padEnd(15)} at (${f.x}, ${f.z}), ${f.w} × ${f.d} m; used from within ${f.reach} m`);
  lines.push("", `reach: a body site within ${plan.ranges.armReach} m; at the patient's side within ${plan.ranges.contact} m; earshot ${plan.ranges.talk} m; sight ${plan.ranges.sight} m. Walking ${plan.walking.metresPerMinute} m/min, ${plan.walking.withPatient} with the patient.`);
  return lines.join("\n");
}

/** Where you stand and what you can do from there, in a few lines (the `where` of play). */
function whereText(v: AgentView): string {
  const sp = v.space;
  const p = sp.patient;
  const lines = [`You are in the ${sp.you.room} at (${sp.you.x}, ${sp.you.z}), facing ${sp.you.facing}.`];
  lines.push(`The patient is ${v.patient.position}${p.on ? ` on ${p.on}` : ""} in the ${p.room}, ${p.distance} m away: ${p.inEarshot ? "in earshot" : "out of earshot"}, ${p.atSide ? "at your side" : "not at your side"}${p.lying ? `; head to the ${p.lying.head}, their right to the ${p.lying.rightSide}` : ""}.`);
  if (p.sites.inReach.length) lines.push(`Sites in reach: ${p.sites.inReach.join(", ")}.`);
  if (p.sites.outOfReach.length) lines.push(`Out of reach: ${p.sites.outOfReach.map((x) => `${x.site} (${x.distance} m)`).join(", ")}.`);
  const near = sp.fixtures.filter((f) => f.inReach);
  lines.push(`Fixtures in reach: ${near.map((f) => `${f.id} (${f.kind})`).join(", ") || "none"}.`);
  lines.push(`Elsewhere: ${sp.fixtures.filter((f) => !f.inReach).sort((a, b) => a.distance - b.distance).slice(0, 8).map((f) => `${f.id} ${f.distance} m`).join(", ")}.`);
  return lines.join("\n");
}

/** The evidence obtained so far, with the id of each item (the `evidence` of play). */
function evidenceText(v: AgentView): string {
  const lines: string[] = [];
  for (const h of v.record.history) lines.push(`  ${h.id.padEnd(22)} history   ${h.answer}`);
  for (const e of v.record.examination) lines.push(`  ${e.id.padEnd(22)} exam      ${e.manoeuvre}: ${e.finding}`);
  for (const r of v.record.results) lines.push(`  ${r.id.padEnd(22)} record    ${r.text}`);
  for (const x of v.record.vitals) lines.push(`  ${x.id.padEnd(22)} vitals    ${Object.entries(x.vitals).map(([k, val]) => `${k} ${val}`).join(", ")}`);
  for (const o of v.record.observations) lines.push(`  ${o.id.padEnd(22)} seen      ${o.text}`);
  for (const n of v.needling) {
    lines.push(`  needle ${n.needle} (${n.target})${n.inPlace ? "" : ", out"}, worked ${n.manipulations}×${n.recorded ? `, recorded ${n.recorded}` : ""}`);
    for (const e of n.evidence) lines.push(`    ${e.id.padEnd(20)} ${e.from.padEnd(9)} ${e.text}`);
  }
  if (v.assessment?.pattern) lines.push(`  pattern on record: ${v.assessment.pattern} on ${v.assessment.patternEvidence.join(", ")}`);
  return lines.length ? lines.join("\n") : "  nothing obtained yet";
}

function makeAgent(id: string, p: ReturnType<typeof pack>): Agent {
  switch (values.agent) {
    case "reference":
      return referenceAgent(requireScenario(p, id));
    case "claude":
      return claudeAgent({ ...(values.model ? { model: values.model } : {}), ...(values.effort ? { effort: values.effort as Effort } : {}) });
    case "protocol":
      return protocolAgent();
    default:
      console.error(`unknown agent ${values.agent} (protocol, reference, claude)`);
      process.exit(2);
  }
}

async function main(): Promise<void> {
  if (!command || values.help || command === "help") {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "validate": {
      const p = pack();
      let failed = 0;
      for (const id of scenarioIds(p)) {
        const r = loadScenario(p, id);
        if (!r.ok) {
          failed++;
          console.log(`✗ ${id}`);
          for (const i of r.issues.filter((x) => x.severity === "error")) console.log(`    ${i.path}: ${i.message}`);
          continue;
        }
        const sc = r.scenario;
        const problems: string[] = [];
        const cc = verifyCase(sc.case);
        for (const i of cc.issues.filter((x) => x.severity === "error")) problems.push(`ClinicalCraft verifyCase: ${i.path}: ${i.message}`);
        let s = createEncounter(sc, { seed: 1 });
        try {
          for (const req of sc.field.solution) {
            const res = step(sc, s, req, { strict: true });
            s = res.state;
            for (const a of res.attempts) if (a.status === "rejected" || a.status === "blocked") problems.push(`reference ${a.requestId} ${a.request.action.type}: ${a.code} ${a.message}`);
          }
        } catch (e) {
          problems.push(`reference trajectory: ${(e as Error).message}`);
        }
        const report = evaluateEncounter(sc, s);
        if (!report.primary.success) problems.push(`reference trajectory does not succeed: ${report.primary.reasons.join("; ")}`);
        if (problems.length) failed++;
        console.log(`${problems.length ? "✗" : "✓"} ${id}  (${sc.family.split}; ${sc.field.solution.length} reference steps → ${report.primary.pathway ?? "—"})`);
        for (const pr of problems) console.log(`    ${pr}`);
        if (values.verbose) for (const w of r.warnings) console.log(`    warning ${w.path}: ${w.message}`);
      }
      console.log(`\n${p.families.size} families, ${scenarioIds(p).length} instances, ${p.bundle.acupoints.size} point definitions (${[...p.bundle.acupoints.values()].filter((x) => pointTargets(x).length > 0).length} localised; ${[...p.bundle.acupoints.values()].filter((x) => x.siteLocalisations).length} groups by site), ${p.bundle.regions.size} regions, ${p.bundle.ruleSets.length} rule sets.`);
      if (failed) {
        console.log(`${failed} instance(s) failed.`);
        process.exit(1);
      }
      return;
    }
    case "list": {
      const p = pack();
      for (const f of p.families.values()) {
        const fam = f.source.family as { title: string; version: string };
        console.log(`${f.id}  [${f.split}]  ${fam.title}  v${fam.version}`);
        for (const v of f.variantIds) {
          const vj = f.source.variants.get(v) as { title: string; kind: string };
          console.log(`    ${f.id}/${v}  (${vj.kind})  ${vj.title}`);
        }
      }
      return;
    }
    case "points": {
      const p = pack();
      const ORDER = ["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR", "GV", "CV", "EX"];
      const rank = (c: string) => (ORDER.indexOf(c) + 1 || ORDER.length + 1);
      const all = [...p.bundle.acupoints.values()].sort((a, b) => rank(a.channel) - rank(b.channel) || a.id.localeCompare(b.id, "en", { numeric: true }));
      const key = args[0];
      const line = (d: (typeof all)[number]) => `${d.id.padEnd(8)} ${`${d.names.pinyin} ${d.names.hanzi}`.padEnd(22)} ${(d.names.en ?? "").padEnd(28)} ${(d.area ?? "").padEnd(14)} ${d.region ? `[${d.region}]` : ""}${d.cautions.length ? ` caution: ${d.cautions.map((c) => c.when).join(", ")}` : ""}`;
      if (!key) {
        const by = new Map<string, number>();
        for (const d of all) by.set(d.channel, (by.get(d.channel) ?? 0) + 1);
        console.log([...by].map(([c, k]) => `${c} ${k}`).join(" · "));
        console.log(`${all.length} points, ${all.filter((d) => pointTargets(d).length > 0).length} localised on the modelled regions (${[...p.bundle.regions.keys()].join(", ")}).`);
        const groups = all.filter((d) => d.sites);
        console.log(`Group points: ${groups.length}, ${groups.filter((d) => d.siteLocalisations).length} located site by site (${groups.filter((d) => d.siteLocalisations).map((d) => `${d.id} ${d.siteLocalisations!.length}`).join(", ")}); the others at one canonical site.`);
        console.log(`Review: ${all.filter((d) => d.provenance.review.status !== "unreviewed").length} of ${all.length} points reviewed by an expert; none is suitable for assessment until reviewed.`);
        return;
      }
      const one = all.find((d) => d.id.toUpperCase() === key.toUpperCase() || d.aliases.some((a) => a.toUpperCase() === key.toUpperCase()));
      if (one) {
        const { provenance, ...rest } = one;
        console.log(JSON.stringify({ ...rest, review: provenance.review.status }, null, 2));
        return;
      }
      const k = key.toLowerCase();
      const list = all.filter((d) => d.channel.toLowerCase() === k || d.area === k || d.region === k);
      if (list.length === 0) throw new Error(`no point, channel, body area or region ${key}`);
      for (const d of list) console.log(line(d));
      return;
    }
    case "show": {
      const p = pack();
      const sc = requireScenario(p, args[0] ?? "");
      const s = createEncounter(sc, { seed: Number(values.seed), mode: mode() });
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      console.log(JSON.stringify(values.library ? { view: observeAs(sc, s, actor), library: referenceLibrary(sc) } : observeAs(sc, s, actor), null, 2));
      return;
    }
    case "map": {
      const p = pack();
      const sc = requireScenario(p, args[0] ?? "");
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      console.log(asciiMap(sc, createEncounter(sc, { seed: Number(values.seed) }), actor));
      return;
    }
    case "vocabulary": {
      const p = pack();
      const sc = requireScenario(p, scenarioIds(p)[0]!);
      const lib = referenceLibrary(sc);
      if (args[0]) {
        console.log(JSON.stringify(lookup(lib, { topic: "pattern", id: args[0] }), null, 2));
        return;
      }
      const v = lib.vocabulary;
      console.log(`${v.signs.length} signs, ${v.patterns.length} patterns. A differentiation rests on the findings it names when they show ${v.differentiation.key} key sign(s) and ${v.differentiation.total} in all, with fewer than ${v.differentiation.against} against.\n`);
      const label = (id: string) => v.signs.find((x) => x.id === id)?.label ?? id;
      for (const pt of v.patterns) {
        console.log(`${pt.id}  ${pt.label}${pt.zh ? `  ${pt.zh}` : ""}`);
        console.log(`    key         ${(pt.criteria?.key ?? []).map(label).join("; ") || "—"}`);
        console.log(`    supporting  ${(pt.criteria?.supporting ?? []).map(label).join("; ") || "—"}`);
        if (pt.criteria?.against.length) console.log(`    against     ${pt.criteria.against.map(label).join("; ")}`);
      }
      console.log(`\nNeedle sensations: ${v.sensations.map((x) => `${x.label}${x.zh ? ` ${x.zh}` : ""} (${x.deqi ? "deqi" : "not deqi"})`).join("; ")}.`);
      if (v.deqi) {
        console.log(`\nDeqi: ${v.deqi.definition}\nEvidence: ${v.deqi.evidence}`);
        for (const src of [...v.deqi.sources, ...v.differentiation.sources.filter((x) => !v.deqi!.sources.some((y) => y.title === x.title))]) console.log(`  source${src.verified ? "" : " (not verified)"}: ${src.title}${src.publishedAt ? `, ${src.publishedAt}` : ""}${src.locator ? ` — ${src.locator}` : ""}`);
      }
      return;
    }
    case "locate": {
      const p = pack();
      const sc = requireScenario(p, args[0] ?? "");
      const position = (args[1] ?? sc.field.patient.position) as Position;
      for (const spec of args.slice(2)) {
        const [id, side, site] = spec.split(":");
        const def = p.bundle.acupoints.get(id!);
        const target = def && pointTargets(def).find((t) => t.site === (site ?? null));
        if (!def || !target?.def.region) {
          console.log(`${spec}: no localisation${def?.siteLocalisations ? ` (a group: name a site, ${def.siteLocalisations.map((x) => x.id).join(", ")})` : ""}`);
          continue;
        }
        const region = p.bundle.regions.get(target.def.region)!;
        const s: Side = def.bilateral ? ((side ?? "right") as Side) : "midline";
        const access = regionAccess(region, s, position);
        const inst = pointInstance(sc, def, s, access.configuration, site);
        console.log(inst ? `${spec}  u=${inst.position.u.toFixed(2)} v=${inst.position.v.toFixed(2)}  tolerance ${inst.toleranceCm.toFixed(2)} cm  (${inst.configuration}${access.accessible ? "" : ", not reachable in this position"})` : `${spec}: no instance`);
      }
      if (args.length <= 2) {
        for (const r of modelledRegions(sc)) {
          const region = p.bundle.regions.get(r)!;
          for (const side of (region.laterality === "bilateral" ? ["left", "right"] : ["midline"]) as Side[]) {
            const access = regionAccess(region, side, position);
            const frame = patientRegion(sc, r, side, access.configuration);
            console.log(`${r} ${side} (${access.configuration})`);
            for (const lm of region.landmarks) {
              const at = frame.landmark(lm.id)!;
              console.log(`  ${lm.id.padEnd(30)} u=${at.u.toFixed(2)} v=${at.v.toFixed(2)}`);
            }
          }
        }
      }
      return;
    }
    case "run": {
      const p = pack();
      const id = args[0] ?? "";
      const sc = requireScenario(p, id);
      const agent = makeAgent(id, p);
      const e = await runEpisode(sc, agent, {
        seed: Number(values.seed),
        mode: mode(),
        ...(values["max-steps"] ? { maxSteps: Number(values["max-steps"]) } : {}),
        onStep: (i) => {
          if (values.verbose) console.log(`  ${String(i.index + 1).padStart(3)} ${i.request.action.type.padEnd(18)} ${i.status.padEnd(9)} ${i.message.slice(0, 110)}`);
        },
      });
      const out = values.out ?? join("runs", `${id.replace("/", "--")}--${values.agent}--s${values.seed}`);
      write(join(out, "log.json"), `${JSON.stringify(e.log, null, 2)}\n`);
      write(join(out, "report.json"), `${JSON.stringify(e.report, null, 2)}\n`);
      write(join(out, "report.md"), episodeMarkdown(e.report));
      write(join(out, "viewer.html"), encounterHtml(sc, e.state, e.report));
      console.log(`${id}: ${e.report.primary.status} (${e.stopReason}, ${e.steps} actions)${e.error ? ` — error: ${e.error}` : ""}`);
      for (const reason of e.report.primary.reasons) console.log(`  ${reason}`);
      console.log(`  tracks: ${Object.entries(e.report.tracks).map(([k, t]) => `${k} ${t.score === null ? "—" : t.score.toFixed(2)}`).join(", ")}`);
      console.log(`  wrote ${out}/log.json, report.json, report.md, viewer.html`);
      return;
    }
    case "play": {
      const p = pack();
      const id = args[0] ?? "";
      const sc = requireScenario(p, id);
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      let s = createEncounter(sc, { seed: Number(values.seed), mode: mode() });
      const lib = referenceLibrary(sc);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let n = 0;
      const requests: unknown[] = [];
      console.log(`${sc.family.title} — ${sc.clinic.title}. You are the ${observeAs(sc, s, actor).you.roleLabel}.`);
      console.log(`Opening: "${(sc.case.patient.persona.openingLine as string) ?? ""}"  (type help)`);
      const prompt = () => process.stdout.write(`[min ${s.clinical.clock.toFixed(1)}] > `);
      prompt();
      // the async iterator keeps lines that arrive while a step runs (piped input), unlike rl.question
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) {
          prompt();
          continue;
        }
        if (line === "quit" || line === "exit") break;
        if (line === "help") {
          console.log("ask <question> | say <text> | exam <manoeuvre> | records <query> | go <room|fixture|patient|region:side> | where | map | feel <needle> | evidence");
          console.log("view | lib <points|point|region|regions|vocabulary|pattern|deqi|clinic|floorplan|roles|rules|evidence|actions> [id] | actions | <JSON action> | quit");
          prompt();
          continue;
        }
        if (line === "where" || line === "map" || line === "evidence") {
          const v = observeAs(sc, s, actor);
          console.log(line === "where" ? whereText(v) : line === "map" ? asciiMap(sc, s, actor) : evidenceText(v));
          prompt();
          continue;
        }
        if (line === "view") {
          console.log(JSON.stringify(observeAs(sc, s, actor), null, 2));
          prompt();
          continue;
        }
        if (line === "actions") {
          console.log(ActionSchema.options.map((o) => (o.shape.type as { value: string }).value).join(", "));
          prompt();
          continue;
        }
        if (line === "lib" || line.startsWith("lib ")) {
          // the same reference library, by the same topics, as an agent under test looks up
          const [, topic, which] = line.split(/\s+/);
          console.log(JSON.stringify(lookup(lib, { ...(topic ? { topic } : {}), ...(which ? { id: which } : {}) }), null, 2));
          prompt();
          continue;
        }
        let action: unknown;
        const [verb, ...rest] = line.split(" ");
        const text = rest.join(" ");
        if (verb === "ask") action = { type: "ask", text };
        else if (verb === "say") action = { type: "say", to: "patient", text };
        else if (verb === "exam") action = { type: "examine", text };
        else if (verb === "records") action = { type: "review_result", query: text };
        else if (verb === "feel") action = { type: "check_sensation", needleId: text };
        else if (verb === "go") {
          // a room, a fixture, a person, or a body site as region:side
          const view = observeAs(sc, s, actor);
          const [region, side] = text.split(":");
          action = { type: "move", to: side ? { region, side } : view.space.fixtures.some((f) => f.id === text) ? { fixture: text } : text === "patient" || view.team.some((m) => m.id === text) ? { person: text } : { room: text } };
        } else {
          try {
            action = JSON.parse(line);
          } catch {
            console.log("not understood: type help");
            prompt();
            continue;
          }
        }
        const req = { requestId: `play-${++n}`, actor, patient: sc.field.patient.id, action: action as never, expectedVersion: s.version };
        const res = step(sc, s, req, { strict: true });
        s = res.state;
        requests.push(res.attempt.request);
        for (const a of res.attempts) {
          const who = a.actor === actor ? "" : `[${a.actor}] `;
          console.log(`${who}${a.request.action.type}: ${a.status}${a.code ? ` (${a.code})` : ""} ${a.message || a.executed?.detail || ""}`);
          for (const o of a.observations) console.log(`  ${o}`);
        }
        if (s.finished) break;
        prompt();
      }
      rl.close();
      const report = evaluateEncounter(sc, s);
      const out = values.out ?? join("runs", `${id.replace("/", "--")}--play`);
      const log: EncounterLog = { schema: "acucraft/log@1", scenarioId: sc.id, scenarioVersion: sc.family.version, engine: { acucraft: ACUCRAFT_VERSION, clinicalcraft: CLINICALCRAFT_REV }, seed: Number(values.seed), mode: mode(), requests: requests as never, finalDigest: digest(s), meta: { agent: "human" } };
      write(join(out, "log.json"), `${JSON.stringify(log, null, 2)}\n`);
      write(join(out, "report.md"), episodeMarkdown(report));
      console.log(`\n${report.primary.status}: ${report.primary.reasons.join("; ") || report.primary.pathway}. Wrote ${out}/log.json and report.md`);
      return;
    }
    case "view": {
      const p = pack();
      const log = JSON.parse(readFileSync(args[0] ?? "", "utf8")) as EncounterLog;
      const sc = requireScenario(p, log.scenarioId);
      const { state } = replayLog(sc, log, { strict: true });
      const out = values.out ?? join(dirname(args[0]!), "viewer.html");
      write(out, encounterHtml(sc, state, evaluateEncounter(sc, state)));
      console.log(`wrote ${out}`);
      return;
    }
    case "replay":
    case "evaluate": {
      const p = pack();
      const log = JSON.parse(readFileSync(args[0] ?? "", "utf8")) as EncounterLog;
      const sc = requireScenario(p, log.scenarioId);
      const { state } = replayLog(sc, log, { strict: true });
      const report = evaluateEncounter(sc, state);
      if (command === "replay") {
        const same = log.finalDigest === undefined || log.finalDigest === digest(state);
        console.log(`${log.scenarioId}: ${log.requests.length} requests replayed; final state ${same ? "matches the recorded digest" : "DIFFERS from the recorded digest"} (${digest(state)}).`);
        if (!same) process.exitCode = 1;
      }
      console.log(values.json ? JSON.stringify(report, null, 2) : episodeMarkdown(report));
      return;
    }
    case "bench": {
      const p = pack();
      const suite = SuiteSchema.parse(JSON.parse(readFileSync(values.suite ?? join(DEFAULT_CONTENT_DIR, "bench", "pilot-v1.json"), "utf8")));
      const split = (values.split ?? "all") as "dev" | "held-out" | "all";
      const result = await runSuite(p, suite, (id) => makeAgent(id, p), {
        split,
        onEpisode: (e) => console.log(`${e.report.primary.status.padEnd(10)} ${e.scenario}  seed ${e.seed}  (${e.stopReason}, ${e.steps} actions)${e.report.criticalErrors.length ? `  critical: ${e.report.criticalErrors.map((c) => c.id).join(", ")}` : ""}`),
      });
      const out = values.out ?? join("runs", `bench--${suite.id}--${values.agent}--${split}`);
      write(join(out, "suite-result.json"), `${JSON.stringify(result, null, 2)}\n`);
      write(join(out, "report.md"), suiteMarkdown(result));
      const all = result.splits.all;
      console.log(`\nprimary endpoint ${all.primary.k}/${all.primary.n}${all.primary.ci ? ` (Wilson 95% CI ${all.primary.ci.join("–")})` : ""} over ${all.families} families; wrote ${out}/report.md`);
      return;
    }
    case "export-clinicalcraft": {
      const p = pack();
      const out = values.out;
      if (!out) {
        console.error("export-clinicalcraft needs --out DIR");
        process.exit(2);
      }
      for (const id of scenarioIds(p)) {
        const sc = requireScenario(p, id);
        write(join(out, "cases", sc.case.id, "case.json"), `${JSON.stringify({ ...sc.case, extensions: { ...sc.case.extensions, acucraft: { scenario: sc.id, note: "Exported by acucraft export-clinicalcraft: the consultation runs in ClinicalCraft; the acupuncture field runs in AcuCraft." } } }, null, 2)}\n`);
      }
      write(join(out, "README.md"), `# AcuCraft cases for ClinicalCraft\n\nExported ClinicalCraft cases, one per AcuCraft scenario instance. Add this directory to ClinicalCraft's \`contentDirs\` setting to play the consultation part in ClinicalCraft's front-ends; needling, roles, consent and the evaluation run in AcuCraft.\n`);
      console.log(`wrote ${scenarioIds(p).length} cases to ${out}/cases`);
      return;
    }
    default:
      console.error(`unknown command ${command}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
