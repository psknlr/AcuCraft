/**
 * Authoring: drop the walks a reference trajectory does not need.
 *
 * The family scripts (tools/content/) walk the practitioner to where each act is done without knowing the floor
 * plan, so some of their `move`s lead nowhere: the practitioner already stands within reach. This replays each
 * reference trajectory on the engine, removes every `move` that covered no ground, renumbers the request ids and
 * rewrites `content/families/<family>/solutions/<variant>.json`. The scripts run it after writing a family.
 *
 *   npx tsx tools/prune-moves.ts [family ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEncounter, step, type ActionRequest } from "@acucraft/core";
import { DEFAULT_CONTENT_DIR, loadContentPack, requireScenario } from "@acucraft/bench";

const only = process.argv.slice(2);
let pack = loadContentPack();
const errors = pack.issues.filter((i) => i.severity === "error");
if (errors.length) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("\n"));

for (const fam of [...pack.families.values()]) {
  if (only.length && !only.includes(fam.id)) continue;
  for (const variant of fam.variantIds) {
    const file = join(DEFAULT_CONTENT_DIR, "families", fam.id, "solutions", `${variant}.json`);
    // a removed walk can leave the next one starting elsewhere: repeat until nothing more goes
    for (let pass = 0; pass < 5; pass++) {
      const steps = JSON.parse(readFileSync(file, "utf8")) as ActionRequest[];
      const sc = requireScenario(pack, `${fam.id}/${variant}`);
      let s = createEncounter(sc, { seed: 1 });
      const idle = new Set<string>();
      for (const req of steps) {
        const before = s.walks.length;
        const r = step(sc, s, req, { strict: true });
        s = r.state;
        const a = r.attempt;
        if (a.request.action.type === "move" && !a.request.action.withPatient && a.status === "executed" && !s.walks.slice(before).some((w) => w.attempt === a.index)) idle.add(req.requestId);
      }
      if (idle.size === 0) break;
      const prefix = steps[0]!.requestId.replace(/-\d+$/, "");
      const kept = steps.filter((r) => !idle.has(r.requestId)).map((r, i) => ({ ...r, requestId: `${prefix}-${String(i + 1).padStart(3, "0")}` }));
      writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
      console.log(`${fam.id}/${variant}: dropped ${idle.size} walk(s) that covered no ground (${kept.length} steps)`);
      pack = loadContentPack();
    }
  }
}
