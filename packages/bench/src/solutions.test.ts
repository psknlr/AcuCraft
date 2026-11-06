import { describe, expect, it } from "vitest";
import { createEncounter, step, type EncounterState } from "@acucraft/core";
import { loadContentPack, loadScenario, scenarioIds } from "./content.js";

const pack = loadContentPack();

describe("content pack", () => {
  it("loads without errors", () => {
    expect(pack.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  for (const id of scenarioIds(pack)) {
    it(`${id} resolves and its reference trajectory replays cleanly`, () => {
      const r = loadScenario(pack, id);
      if (!r.ok) throw new Error(r.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
      const sc = r.scenario;
      let s: EncounterState = createEncounter(sc, { seed: 1 });
      const problems: string[] = [];
      for (const req of sc.field.solution) {
        const res = step(sc, s, req, { strict: true });
        s = res.state;
        for (const a of res.attempts) if (a.status === "rejected" || a.status === "blocked") problems.push(`${a.requestId} ${a.request.action.type}: ${a.code} ${a.message}`);
      }
      expect(problems).toEqual([]);
      expect(s.finished).toBe(true);
    });
  }
});

import { evaluateEncounter } from "./evaluate.js";

describe("variants change the outcome they are meant to", () => {
  for (const fam of pack.families.values()) {
    for (const v of fam.variantIds.filter((x) => x !== "base")) {
      it(`${fam.id}: the base reference course fails on ${v}`, () => {
        const base = loadScenario(pack, `${fam.id}/base`);
        const sc = loadScenario(pack, `${fam.id}/${v}`);
        if (!base.ok || !sc.ok) throw new Error("unresolved");
        let s = createEncounter(sc.scenario, { seed: 1 });
        for (const req of base.scenario.field.solution) s = step(sc.scenario, s, req, { strict: true }).state;
        expect(evaluateEncounter(sc.scenario, s).primary.success).toBe(false);
      });
    }
  }
});
