/**
 * Authoring: finish the reference trajectories on the engine.
 *
 * The family scripts (tools/content/) write what the reference practitioner does; two things only the engine knows:
 *
 *  - where they stand. The scripts walk the practitioner to where each act is done without seeing the floor plan,
 *    so some of their `move`s lead nowhere: this drops every `move` that covered no ground;
 *  - how the tissue answered each needle. A treatment record states the response at every needle and the evidence it
 *    rests on (docs/EVIDENCE.md): this writes `needling.responses` of each such record from the evidence the
 *    trajectory had obtained when it was written — `deqi` on the items that show it, `none` on the latest check that
 *    did not, `not-sought` for a needle nothing was looked for at. The reference records what it observed, no more.
 *
 * It replays each trajectory, rewrites `content/families/<family>/solutions/<variant>.json` with request ids
 * renumbered, and replays the result strictly. The scripts run it after writing a family.
 *
 *   npx tsx tools/finish-solutions.ts [family ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEncounter, needleEvidence, needleList, showsDeqi, step, visitIndex, type ActionRequest, type NeedleResponseClaim, type Scenario } from "@acucraft/core";
import { DEFAULT_CONTENT_DIR, loadContentPack, requireScenario } from "@acucraft/bench";

const only = process.argv.slice(2);

function load() {
  const pack = loadContentPack();
  const errors = pack.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return pack;
}

/** The walks that covered no ground. */
function idleMoves(sc: Scenario, steps: ActionRequest[]): Set<string> {
  let s = createEncounter(sc, { seed: 1 });
  const idle = new Set<string>();
  for (const req of steps) {
    const before = s.walks.length;
    const r = step(sc, s, req);
    s = r.state;
    const a = r.attempt;
    if (a.request.action.type === "move" && !a.request.action.withPatient && a.status === "executed" && !s.walks.slice(before).some((w) => w.attempt === a.index)) idle.add(req.requestId);
  }
  return idle;
}

/** Each treatment record's needle responses, as the evidence obtained by then shows them. Returns how many it wrote. */
function recordResponses(sc: Scenario, steps: ActionRequest[]): number {
  let s = createEncounter(sc, { seed: 1 });
  let written = 0;
  for (const req of steps) {
    const a = req.action;
    if (a.type === "document" && a.record.needling) {
      const responses: NeedleResponseClaim[] = needleList(s)
        .filter((n) => n.insertion?.visit === visitIndex(s))
        .map((n) => {
          const evidence = needleEvidence(s, n.id);
          const shows = evidence.filter((e) => showsDeqi(sc, e));
          if (shows.length > 0) return { needle: n.id, response: "deqi" as const, evidence: shows.map((e) => e.id) };
          if (evidence.length > 0) return { needle: n.id, response: "none" as const, evidence: [evidence[evidence.length - 1]!.id] };
          return { needle: n.id, response: "not-sought" as const, evidence: [] };
        });
      if (JSON.stringify(a.record.needling.responses ?? null) !== JSON.stringify(responses)) written += 1;
      a.record.needling.responses = responses;
    }
    s = step(sc, s, req).state;
  }
  return written;
}

let pack = load();
for (const fam of [...pack.families.values()]) {
  if (only.length && !only.includes(fam.id)) continue;
  for (const variant of fam.variantIds) {
    const file = join(DEFAULT_CONTENT_DIR, "families", fam.id, "solutions", `${variant}.json`);
    const save = (steps: ActionRequest[]) => {
      writeFileSync(file, `${JSON.stringify(steps, null, 2)}\n`);
      pack = load();
    };
    // a removed walk can leave the next one starting elsewhere: repeat until nothing more goes
    for (let pass = 0; pass < 5; pass++) {
      const steps = JSON.parse(readFileSync(file, "utf8")) as ActionRequest[];
      const idle = idleMoves(requireScenario(pack, `${fam.id}/${variant}`), steps);
      if (idle.size === 0) break;
      const prefix = steps[0]!.requestId.replace(/-\d+$/, "");
      const kept = steps.filter((r) => !idle.has(r.requestId)).map((r, i) => ({ ...r, requestId: `${prefix}-${String(i + 1).padStart(3, "0")}` }));
      save(kept);
      console.log(`${fam.id}/${variant}: dropped ${idle.size} walk(s) that covered no ground (${kept.length} steps)`);
    }
    const steps = JSON.parse(readFileSync(file, "utf8")) as ActionRequest[];
    const written = recordResponses(requireScenario(pack, `${fam.id}/${variant}`), steps);
    if (written > 0) {
      save(steps);
      console.log(`${fam.id}/${variant}: wrote the needle responses of ${written} treatment record(s) from the evidence`);
    }
    // the finished trajectory replays: every request executes, and the invariants hold after each
    const sc = requireScenario(pack, `${fam.id}/${variant}`);
    let s = createEncounter(sc, { seed: 1 });
    for (const req of JSON.parse(readFileSync(file, "utf8")) as ActionRequest[]) {
      const r = step(sc, s, req, { strict: true });
      s = r.state;
      if (r.attempt.status !== "executed" && r.attempt.status !== "partial") throw new Error(`${sc.id}: ${req.requestId} (${req.action.type}) was ${r.attempt.status}: ${r.attempt.message}`);
    }
  }
}
