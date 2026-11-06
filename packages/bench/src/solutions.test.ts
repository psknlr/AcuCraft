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
