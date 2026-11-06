import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { replayLog, digest } from "@acucraft/core";
import { loadContentPack, requireScenario, scenarioIds } from "./content.js";
import { runEpisode } from "./runner.js";
import { protocolAgent } from "./agents/protocol.js";
import { referenceAgent } from "./agents/reference.js";
import { claudeAgent } from "./agents/claude.js";
import { actionCatalogue } from "./agents/catalogue.js";
import { clusterBootstrap, wilson } from "./stats.js";
import { runSuite, SuiteSchema, suiteMarkdown } from "./suite.js";
import { encounterHtml } from "./viewer.js";

const pack = loadContentPack();

describe("baseline agents", () => {
  it("the rule-based protocol agent succeeds except where adaptation to the patient's build is needed", async () => {
    const outcomes: Record<string, string> = {};
    for (const id of scenarioIds(pack)) {
      const e = await runEpisode(requireScenario(pack, id), protocolAgent(), { seed: 1 });
      outcomes[id] = `${e.report.primary.status}${e.report.criticalErrors.length ? `:${e.report.criticalErrors.map((c) => c.id).join(",")}` : ""}`;
      // every episode replays to the same state from its log
      expect(digest(replayLog(requireScenario(pack, id), e.log).state)).toBe(e.log.finalDigest);
    }
    // its textbook GB21 depth reaches the apical pleura of a very slim patient: blocked, recorded, critical
    expect(outcomes["sg-tension-headache/slim"]).toBe("failure:pleura-penetration");
    for (const [id, o] of Object.entries(outcomes)) if (id !== "sg-tension-headache/slim") expect(o, id).toBe("success");
  }, 60000);

  it("the reference agent reaches an acceptable pathway everywhere", async () => {
    for (const id of scenarioIds(pack)) {
      const e = await runEpisode(requireScenario(pack, id), referenceAgent(requireScenario(pack, id)), { seed: 1 });
      expect(e.report.primary.status, id).toBe("success");
    }
  }, 60000);

  it("runs a suite and reports by split, with family-clustered intervals", async () => {
    const suite = SuiteSchema.parse({ schema: "acucraft/suite@1", id: "t", description: "test", families: ["sg-knee-oa", "sg-chemo-nausea"], seeds: [1] });
    const r = await runSuite(pack, suite, () => protocolAgent());
    expect(r.splits.dev.families).toBe(1);
    expect(r.splits["held-out"].families).toBe(1);
    expect(r.splits.all.episodes).toBe(6);
    expect(r.splits.all.primary.k).toBe(6);
    expect(suiteMarkdown(r)).toMatch(/Primary endpoint/);
  }, 60000);
});

describe("encounter viewer", () => {
  it("draws a chart per needled region and side, and the timeline", async () => {
    const sc = requireScenario(pack, "sg-chemo-nausea/base");
    const e = await runEpisode(sc, referenceAgent(sc), { seed: 1 });
    const html = encounterHtml(sc, e.state, e.report);
    expect(html.match(/<svg /g)?.length).toBe(4); // forearm and leg, left and right
    expect(html).toMatch(/<title>Encounter viewer<\/title>/);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html.match(/<tr class=/g)!.length).toBe(e.state.attempts.length);
  });
});

describe("statistics", () => {
  it("Wilson intervals", () => {
    const w = wilson(8, 10);
    expect(w.p).toBe(0.8);
    expect(w.ci![0]).toBeCloseTo(0.49, 2);
    expect(w.ci![1]).toBeCloseTo(0.943, 2);
    expect(wilson(0, 0).ci).toBeNull();
  });
  it("cluster bootstrap resamples families and is seeded", () => {
    const fams = new Map([
      ["a", [true, true, true]],
      ["b", [false, false, true]],
      ["c", [true, false, true]],
    ]);
    const a = clusterBootstrap(fams);
    expect(a).toEqual(clusterBootstrap(fams));
    expect(a.families).toBe(3);
    expect(a.ci![0]).toBeLessThan(a.p!);
    expect(a.ci![1]).toBeGreaterThan(a.p!);
  });
});

describe("Claude agent loop (mock client: no network)", () => {
  it("uses lookup and view without simulated time, acts once per step, pairs every tool result, and records outputs", async () => {
    const sc = requireScenario(pack, "sg-knee-oa/hot-knee");
    const script: Anthropic.Beta.BetaContentBlock[][] = [
      [{ type: "tool_use", id: "u1", name: "lookup", input: { topic: "vocabulary" }, caller: { type: "direct" } } as never],
      [{ type: "tool_use", id: "u2", name: "act", input: { action: { type: "ask", text: "What brings you in today?" } }, caller: { type: "direct" } } as never],
      [{ type: "text", text: "Let me think.", citations: null } as never],
      [{ type: "tool_use", id: "u3", name: "view", input: {}, caller: { type: "direct" } } as never],
      [{ type: "tool_use", id: "u4", name: "act", input: { action: { type: "refer", to: "emergency", urgency: "emergency", reason: "hot swollen knee with fever" } }, caller: { type: "direct" } } as never],
      [{ type: "tool_use", id: "u5", name: "act", input: { action: { type: "end_visit" } }, caller: { type: "direct" } } as never],
      [{ type: "tool_use", id: "u6", name: "act", input: { action: { type: "finish_encounter" } }, caller: { type: "direct" } } as never],
    ];
    const seen: Anthropic.Beta.MessageCreateParams[] = [];
    let i = 0;
    const client = {
      beta: {
        messages: {
          create: async (params: Anthropic.Beta.MessageCreateParams) => {
            seen.push(JSON.parse(JSON.stringify(params)));
            const content = script[i++]!;
            return { id: `m${i}`, type: "message", role: "assistant", model: params.model, content, stop_reason: content[0]!.type === "tool_use" ? "tool_use" : "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    } as unknown as Anthropic;
    const agent = claudeAgent({ client });
    const e = await runEpisode(sc, agent, { seed: 1 });
    expect(e.stopReason).toBe("finished");
    expect(e.log.requests.map((r) => r.action.type)).toEqual(["ask", "refer", "end_visit", "finish_encounter"]);
    // defaults: current model, adaptive thinking (omitted), explicit effort, refusal fallback, no forced tool choice
    expect(seen[0]!.model).toBe("claude-opus-5-5");
    expect(seen[0]!.thinking).toBeUndefined();
    expect(seen[0]!.output_config?.effort).toBe("high");
    expect(seen[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect((seen[0] as { fallbacks?: unknown }).fallbacks).toBe("default");
    // every tool_use is answered by a tool_result in the next request, and history is only appended to
    for (let k = 1; k < seen.length; k++) {
      const prev = seen[k - 1]!.messages;
      expect(seen[k]!.messages.slice(0, prev.length)).toEqual(prev);
      const assistant = seen[k]!.messages[prev.length]!;
      const reply = seen[k]!.messages[prev.length + 1]!;
      const use = (assistant.content as { type: string; id?: string }[]).find((b) => b.type === "tool_use");
      if (use) expect((reply.content as { type: string; tool_use_id?: string }[])[0]!.tool_use_id).toBe(use.id);
    }
    expect((agent.transcript!() as unknown[]).length).toBe(script.length);
    expect(e.log.meta?.transcript).toBeDefined();
    expect(e.report.primary.pathway).toBe("p-emergency-referral");
  });

  it("the action catalogue lists every action type", () => {
    const text = actionCatalogue();
    for (const t of ["ask", "insert_needle", "assign_task", "count_needles", "finish_encounter"]) expect(text).toMatch(new RegExp(`^- ${t}\\b`, "m"));
  });
});
