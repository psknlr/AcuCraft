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
  ActionSchema,
  createEncounter,
  digest,
  observeAs,
  patientRegion,
  pointInstance,
  referenceLibrary,
  regionAccess,
  replayLog,
  step,
  type EncounterLog,
  type Mode,
  type Position,
  type Side,
} from "@acucraft/core";
import {
  claudeAgent,
  episodeMarkdown,
  evaluateEncounter,
  loadContentPack,
  loadScenario,
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

const HELP = `acucraft — acupuncture simulation and evaluation (Singapore edition)

usage: npm run acu -- <command> [options]

  validate [--verbose]                      check the pack: schemas, references, ClinicalCraft case verification,
                                            and that every reference trajectory reaches an acceptable pathway
  list                                      families, variants and splits
  show <family/variant> [--mode teaching] [--library]
                                            the agent's opening view (and the public reference library)
  locate <family/variant> <position> [POINT:side ...]
                                            authoring: the hidden patient-specific landmarks and points
  run <family/variant> [--agent protocol|reference|claude] [--seed N] [--mode assessment|teaching]
      [--model ID] [--effort low|medium|high|xhigh|max] [--max-steps N] [--out DIR] [--verbose]
                                            run one encounter; writes log.json, report.json and report.md
  play <family/variant> [--mode teaching] [--seed N] [--out DIR]
                                            play the practitioner yourself (type help inside)
  replay <log.json>                         replay a log, check it reproduces the recorded state, re-evaluate
  evaluate <log.json> [--json]              evaluate a log
  bench [--suite FILE] [--agent ...] [--split dev|held-out|all] [--out DIR] [--model ID] [--effort ...]
                                            run a benchmark suite; writes suite-result.json and report.md
  export-clinicalcraft --out DIR            write every instance's ClinicalCraft case (cases/<id>/case.json) for
                                            ClinicalCraft's contentDirs setting

  --content DIR                             another content pack (default: ./content)
`;

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
      console.log(`\n${p.families.size} families, ${scenarioIds(p).length} instances, ${p.bundle.acupoints.size} point definitions (${[...p.bundle.acupoints.values()].filter((x) => x.localisation).length} localised), ${p.bundle.regions.size} regions, ${p.bundle.ruleSets.length} rule sets.`);
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
    case "show": {
      const p = pack();
      const sc = requireScenario(p, args[0] ?? "");
      const s = createEncounter(sc, { seed: Number(values.seed), mode: mode() });
      const actor = sc.field.cast.find((m) => m.agent === "under-test")!.id;
      console.log(JSON.stringify(values.library ? { view: observeAs(sc, s, actor), library: referenceLibrary(sc) } : observeAs(sc, s, actor), null, 2));
      return;
    }
    case "locate": {
      const p = pack();
      const sc = requireScenario(p, args[0] ?? "");
      const position = (args[1] ?? sc.field.patient.position) as Position;
      for (const spec of args.slice(2)) {
        const [id, side] = spec.split(":");
        const def = p.bundle.acupoints.get(id!);
        if (!def?.region) {
          console.log(`${spec}: no localisation`);
          continue;
        }
        const region = p.bundle.regions.get(def.region)!;
        const s: Side = def.bilateral ? ((side ?? "right") as Side) : "midline";
        const access = regionAccess(region, s, position);
        const inst = pointInstance(sc, def, s, access.configuration);
        console.log(inst ? `${spec}  u=${inst.position.u.toFixed(2)} v=${inst.position.v.toFixed(2)}  tolerance ${inst.toleranceCm.toFixed(2)} cm  (${inst.configuration}${access.accessible ? "" : ", not reachable in this position"})` : `${spec}: no instance`);
      }
      if (args.length <= 2) {
        for (const r of sc.field.regions) {
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
      console.log(`${id}: ${e.report.primary.status} (${e.stopReason}, ${e.steps} actions)${e.error ? ` — error: ${e.error}` : ""}`);
      for (const reason of e.report.primary.reasons) console.log(`  ${reason}`);
      console.log(`  tracks: ${Object.entries(e.report.tracks).map(([k, t]) => `${k} ${t.score === null ? "—" : t.score.toFixed(2)}`).join(", ")}`);
      console.log(`  wrote ${out}/log.json, report.json, report.md`);
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
      for (;;) {
        const line = (await rl.question(`[min ${s.clinical.clock.toFixed(1)}] > `)).trim();
        if (!line) continue;
        if (line === "quit" || line === "exit") break;
        if (line === "help") {
          console.log("ask <question> | say <text> | exam <manoeuvre> | records <query> | view | lib <topic> [id] | actions | <JSON action> | quit");
          continue;
        }
        if (line === "view") {
          console.log(JSON.stringify(observeAs(sc, s, actor), null, 2));
          continue;
        }
        if (line === "actions") {
          console.log(ActionSchema.options.map((o) => (o.shape.type as { value: string }).value).join(", "));
          continue;
        }
        if (line.startsWith("lib")) {
          const [, topic, which] = line.split(/\s+/);
          const data = topic === "point" ? lib.points.find((x) => x.id === which) : topic === "region" ? lib.regions.find((x) => x.id === which) : (lib as Record<string, unknown>)[topic ?? ""];
          console.log(JSON.stringify(data ?? Object.keys(lib), null, 2));
          continue;
        }
        let action: unknown;
        const [verb, ...rest] = line.split(" ");
        const text = rest.join(" ");
        if (verb === "ask") action = { type: "ask", text };
        else if (verb === "say") action = { type: "say", to: "patient", text };
        else if (verb === "exam") action = { type: "examine", text };
        else if (verb === "records") action = { type: "review_result", query: text };
        else {
          try {
            action = JSON.parse(line);
          } catch {
            console.log("not understood: type help");
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
      }
      rl.close();
      const report = evaluateEncounter(sc, s);
      const out = values.out ?? join("runs", `${id.replace("/", "--")}--play`);
      const log: EncounterLog = { schema: "acucraft/log@1", scenarioId: sc.id, scenarioVersion: sc.family.version, engine: { acucraft: "0.1.0", clinicalcraft: "pinned" }, seed: Number(values.seed), mode: mode(), requests: requests as never, finalDigest: digest(s), meta: { agent: "human" } };
      write(join(out, "log.json"), `${JSON.stringify(log, null, 2)}\n`);
      write(join(out, "report.md"), episodeMarkdown(report));
      console.log(`\n${report.primary.status}: ${report.primary.reasons.join("; ") || report.primary.pathway}. Wrote ${out}/log.json and report.md`);
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
