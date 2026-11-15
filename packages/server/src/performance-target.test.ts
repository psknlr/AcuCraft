import { describe, expect, it } from "vitest";
import { PerformTechniqueSchema, type AgentView, type PerformTechniqueAction } from "@acucraft/core";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { previewSite } from "../web/stage/performance-target.js";

const scenario = requireScenario(loadContentPack(), "sg-low-back-pain/base");
function views() {
  const session = new EncounterSession(scenario, { seed: 1 });
  let skin: AgentView | null = null;
  let needleId = "", mark = "";
  for (const request of scenario.field.solution) {
    if (request.action.type === "insert_needle") {
      skin = session.view(); needleId = request.action.needleId; mark = request.action.mark!;
      expect(session.act(request.action).attempt.status).toBe("executed");
      break;
    }
    const result = session.act(request.action);
    expect(["executed", "partial"]).toContain(result.attempt.status);
  }
  if (!skin) throw new Error("Reference skin target missing");
  const retained = session.view();
  expect(session.act({ type: "remove_needle", needleId }).attempt.status).toBe("executed");
  const removed = session.view();
  return { skin, retained, removed, needleId, mark };
}
const prepared = views();
const parse = (request: Omit<PerformTechniqueAction, "type">) => PerformTechniqueSchema.parse({ type: "perform_technique", ...request });
const site = (() => {
  const placement = prepared.retained.needling.find((needle) => needle.needle === prepared.needleId)!.placement!;
  return { region: placement.region, side: placement.side, u: placement.u, v: placement.v };
})();

describe("local preview targets from the practitioner's public view", () => {
  it("resolves a retained needle from its executed placement rather than guessed mark coordinates", () => {
    const view = structuredClone(prepared.retained);
    const before = structuredClone(view);
    expect(previewSite(view, parse({ technique: "nian", needleId: prepared.needleId }))).toEqual(site);
    expect(previewSite(view, parse({ technique: "gua", needleId: prepared.needleId, mark: prepared.mark }))).toEqual(site);
    expect(view).toEqual(before);
  });

  it("uses the same mark, explicit chart site, and needle-site precedence as a skin action", () => {
    const fromMark = previewSite(prepared.skin, parse({ technique: "chuai", mark: prepared.mark }));
    expect(fromMark).toEqual(site);
    expect(previewSite(prepared.skin, parse({ technique: "an", region: site.region, side: site.side as "left", at: { u: site.u, v: site.v } }))).toEqual(site);
    expect(previewSite(prepared.retained, parse({ technique: "she", needleId: prepared.needleId }))).toEqual(site);
    expect(previewSite(prepared.removed, parse({ technique: "chuai", needleId: prepared.needleId, mark: prepared.mark }))).toEqual(site);
  });

  it("requires a recorded withdrawal for Men, and distinguishes it from a missing, dropped, or broken needle", () => {
    expect(prepared.retained.needling[0]!.withdrawn).toBe(false);
    expect(prepared.removed.needling[0]!.withdrawn).toBe(true);
    expect(() => previewSite(prepared.retained, parse({ technique: "men", needleId: prepared.needleId }))).toThrow(/Withdraw/);
    expect(previewSite(prepared.removed, parse({ technique: "men", needleId: prepared.needleId }))).toEqual(site);
    for (const withdrawn of [false, undefined]) {
      const missing = structuredClone(prepared.removed);
      missing.needling[0]!.withdrawn = withdrawn;
      missing.needling[0]!.inPlace = false;
      expect(() => previewSite(missing, parse({ technique: "men", needleId: prepared.needleId }))).toThrow(/Withdraw/);
    }
  });

  it("rejects removed needles for retained techniques and unknown or placement-free needle identifiers", () => {
    expect(() => previewSite(prepared.removed, parse({ technique: "nian", needleId: prepared.needleId }))).toThrow(/retained needle/);
    expect(() => previewSite(prepared.retained, parse({ technique: "nian", needleId: "other-visit-needle" }))).toThrow(/recorded site/);
    const missing = structuredClone(prepared.retained);
    delete missing.needling[0]!.placement;
    expect(() => previewSite(missing, parse({ technique: "nian", needleId: prepared.needleId }))).toThrow(/recorded site/);
  });

  it("rejects stale, conflicting and incomplete targets without modifying the view", () => {
    const stale = structuredClone(prepared.retained);
    stale.localisation.marks.find((mark) => mark.id === prepared.mark)!.stale = true;
    const before = structuredClone(stale);
    expect(() => previewSite(stale, parse({ technique: "chuai", mark: prepared.mark }))).toThrow(/non-stale/);
    expect(() => previewSite(stale, parse({ technique: "nian", needleId: prepared.needleId, mark: prepared.mark }))).toThrow(/Mark and needle/);
    expect(stale).toEqual(before);
    const other = prepared.retained.localisation.marks.find((mark) => mark.id !== prepared.mark && (mark.side !== site.side || Math.hypot(mark.u - site.u, mark.v - site.v) > 1e-6))!;
    expect(() => previewSite(prepared.retained, parse({ technique: "chuai", needleId: prepared.needleId, mark: other.id }))).toThrow(/Mark and needle/);
    for (const request of [
      { technique: "nian", needleId: prepared.needleId, region: "forearm" },
      { technique: "nian", needleId: prepared.needleId, at: { u: site.u + 1, v: site.v } },
      { technique: "chuai", mark: prepared.mark, side: "right" },
      { technique: "chuai", needleId: prepared.needleId, at: { u: site.u, v: site.v + 2 } },
    ] satisfies Omit<PerformTechniqueAction, "type">[]) {
      expect(() => previewSite(prepared.retained, parse(request))).toThrow(/conflict/);
    }
    expect(() => previewSite(prepared.retained, parse({ technique: "chuai" }))).toThrow(/complete chart site/);
  });

  it("requires the currently accessible body side, a shared room, and the engine's public reach result", () => {
    for (const mutate of [
      (view: AgentView) => { view.patient.reachable = []; },
      (view: AgentView) => { view.space.you.room = "consult-room"; },
      (view: AgentView) => { view.space.patient.sites.inReach = []; },
    ]) {
      const view = structuredClone(prepared.retained); mutate(view);
      const before = structuredClone(view);
      expect(() => previewSite(view, parse({ technique: "nian", needleId: prepared.needleId }))).toThrow(/accessible|reach/);
      expect(view).toEqual(before);
    }
  });

  it("rejects non-finite coordinates at the shared schema and guards raw explicit-site callers too", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const input = { type: "perform_technique", technique: "chuai", region: site.region, side: site.side, at: { u: value, v: site.v } };
      expect(PerformTechniqueSchema.safeParse(input).success).toBe(false);
      expect(() => previewSite(prepared.retained, input as PerformTechniqueAction)).toThrow(/finite/);
    }
    expect(prepared.retained.needling[0]!.placement).toMatchObject(site);
  });
});
