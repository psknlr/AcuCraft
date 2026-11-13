import { describe, expect, it } from "vitest";
import { digest, replayLog } from "@acucraft/core";
import { loadContentPack, requireScenario, runEpisode, scenarioIds } from "@acucraft/bench";
import { EncounterSession, llmAgent, NUDGE, oracleProvider, referenceAgent, scriptedProvider, systemPrompt, systemSections, type ChatMessage, type ChatPart, type LlmEvent, type ScriptedTurn } from "./index.js";

/**
 * The loop of a language-model practitioner (docs/AGENT.md), with scripted turns in place of a model: no network.
 */

const pack = loadContentPack();
const hotKnee = requireScenario(pack, "sg-knee-oa/hot-knee");
const knee = requireScenario(pack, "sg-knee-oa/base");

const results = (m: ChatMessage | undefined) => (m?.parts ?? []).filter((p): p is Extract<ChatPart, { type: "tool_result" }> => p.type === "tool_result");
const json = (p: { content: string }) => JSON.parse(p.content) as Record<string, any>;

describe("the loop of a language-model practitioner", () => {
  it("reads without simulated time, acts once per step, answers every call of a turn in one message, and records outputs", async () => {
    const script: ScriptedTurn[] = [
      { calls: [{ name: "lookup", input: { topic: "vocabulary" } }, { name: "read_skill", input: { id: "red-flags-and-referral" } }] },
      { calls: [{ name: "ask", input: { text: "What brings you in today?" } }] },
      { text: "Let me think." },
      { calls: [{ name: "view", input: { section: "record" } }] },
      { calls: [{ name: "refer", input: { to: "emergency", urgency: "emergency", reason: "hot swollen knee with fever" } }, { name: "end_visit" }, { name: "finish_encounter" }] },
    ];
    const provider = scriptedProvider(script);
    const events: LlmEvent[] = [];
    const agent = llmAgent({ provider, skills: pack.skills, onEvent: (e) => events.push(e) });
    const e = await runEpisode(hotKnee, agent, { seed: 1 });
    expect(e.stopReason).toBe("finished");
    expect(e.log.requests.map((r) => r.action.type)).toEqual(["ask", "refer", "end_visit", "finish_encounter"]);
    expect(e.report.primary.pathway).toBe("p-emergency-referral");
    expect(provider.requests).toHaveLength(script.length);

    // the standing instructions and the tools never change within an encounter; the conversation is only appended to
    for (let k = 1; k < provider.requests.length; k++) {
      expect(provider.requests[k]!.system).toEqual(provider.requests[0]!.system);
      expect(provider.requests[k]!.tools).toEqual(provider.requests[0]!.tools);
      const prev = provider.requests[k - 1]!.messages;
      expect(provider.requests[k]!.messages.slice(0, prev.length)).toEqual(prev);
    }
    expect(provider.requests[0]!.system).toEqual(systemSections(pack.skills));
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["lookup", "view", "construct_point", "read_skill", "ask", "insert_needle", "finish_encounter"]));

    // the opening: who you are and the whole view, once
    const opening = provider.requests[0]!.messages[0]!.parts[0] as { text: string };
    expect(opening.text).toMatch(/^A new encounter: .*visit 1 of \d/);
    expect(opening.text).toContain('"schema":"acucraft/view@2"');

    // both reads of the first turn are answered together, and took no simulated time
    const afterReads = provider.requests[1]!.messages;
    const reads = results(afterReads.at(-1));
    expect(reads).toHaveLength(2);
    expect(json(reads[0]!)).toHaveProperty("redFlags");
    expect(reads[1]!.content).toMatch(/^# Red flags/);
    expect(e.state.attempts.filter((a) => a.actor === "practitioner")).toHaveLength(4);

    // an action's result: what the engine did and what it changed — the answer with its evidence id, once
    const asked = json(results(provider.requests[2]!.messages.at(-1))[0]!);
    expect(asked).toMatchObject({ status: "executed", changed: { record: { history: [{ id: "hx-chief" }] } } });
    expect(asked.changed.said.at(-1).text).toBe(asked.changed.record.history[0].answer);
    expect(asked.changed).not.toHaveProperty("space");

    // a turn without a tool call is nudged, not counted as an act
    const nudge = provider.requests[3]!.messages.at(-1)!;
    expect(nudge.parts).toEqual([{ type: "text", text: NUDGE }]);

    // one section of the view
    expect(Object.keys(json(results(provider.requests[4]!.messages.at(-1))[0]!))).toEqual(["minute", "record"]);

    // what the model wrote is kept for the log, with what it cost
    expect(agent.transcript!()).toHaveLength(script.length);
    expect(e.log.meta).toMatchObject({ agent: "scripted (scripted)", stopReason: "finished", usage: { modelCalls: 5, inputTokens: 5 } });
    expect(events.filter((x) => x.type === "model")).toHaveLength(5);
    // and the episode replays from its log without the model
    expect(digest(replayLog(hotKnee, e.log).state)).toBe(e.log.finalDigest);
  });

  it("an input the engine would not parse is answered as an error and never reaches the engine; the calls after it wait", async () => {
    const provider = scriptedProvider([
      { calls: [{ name: "ask", input: { question: "Where does it hurt?" } }, { name: "observe" }, { name: "lookup", input: { topic: "clinic" } }] },
      { calls: [{ name: "prescribe", input: { herb: "anything" } }] },
      { calls: [{ name: "finish_encounter" }] },
    ]);
    const e = await runEpisode(hotKnee, llmAgent({ provider }), { seed: 1, maxSteps: 3 });
    const first = results(provider.requests[1]!.messages.at(-1));
    expect(first.map((p) => p.isError)).toEqual([true, true, true]);
    expect(json(first[0]!).error).toMatch(/Not a valid ask: .*Unrecognized key.*Nothing was done/);
    expect(json(first[1]!)).toMatchObject({ skipped: true, reason: expect.stringMatching(/the input of ask was not valid/) });
    expect(json(first[2]!)).toMatchObject({ skipped: true });
    expect(json(results(provider.requests[2]!.messages.at(-1))[0]!).error).toMatch(/no tool prescribe/);
    // only the last call was an act (and the engine refused it: the visit is still open)
    expect(e.state.attempts.filter((a) => a.actor === "practitioner").map((a) => [a.request.action.type, a.status])).toEqual([["finish_encounter", "rejected"]]);
  });

  it("when an action does not go as asked, the rest of the turn's calls are not carried out", async () => {
    // three acts that all go as asked are all carried out, one engine step each
    const provider = scriptedProvider([
      { calls: [{ name: "examine", input: { text: "palpate the right knee" } }, { name: "check_vitals" }, { name: "ask", input: { text: "How long has it hurt?" } }] },
      { text: "" },
      { text: "" },
      { text: "" },
    ]);
    const e = await runEpisode(knee, llmAgent({ provider }), { seed: 1 });
    expect(e.state.attempts.filter((a) => a.actor === "practitioner").map((a) => [a.request.action.type, a.status])).toEqual([["examine", "executed"], ["check_vitals", "executed"], ["ask", "executed"]]);
    expect(results(provider.requests[1]!.messages.at(-1)).map((p) => json(p).status)).toEqual(["executed", "executed", "executed"]);
    // from reception the patient is out of reach: examining is refused, and the vital signs queued behind it wait
    const far = scriptedProvider([{ calls: [{ name: "move", input: { to: "reception" } }, { name: "examine", input: { text: "palpate the right knee" } }, { name: "check_vitals" }] }, { text: "" }, { text: "" }, { text: "" }]);
    const f = await runEpisode(knee, llmAgent({ provider: far }), { seed: 1 });
    expect(f.state.attempts.filter((a) => a.actor === "practitioner").map((a) => [a.request.action.type, a.status])).toEqual([["move", "executed"], ["examine", "rejected"]]);
    const answers = results(far.requests[1]!.messages.at(-1));
    expect(answers).toHaveLength(3);
    expect(json(answers[0]!)).toMatchObject({ status: "executed", changed: { you: { location: "reception" }, space: { patient: { inEarshot: false } } } });
    expect(json(answers[1]!)).toMatchObject({ status: "rejected", message: expect.stringMatching(/move \{"to":\{"person":"patient"\}\}/) });
    expect(answers[1]!.isError).toBe(true);
    expect(json(answers[2]!)).toMatchObject({ skipped: true, reason: expect.stringMatching(/examine was rejected/) });
    // a model that then says nothing is nudged twice, and the episode ends with the reason on the log
    expect(f.stopReason).toBe("agent-done");
    expect(f.note).toBe("the model stopped acting before the encounter was finished");
    expect(f.log.meta).toMatchObject({ note: f.note });
  });

  it("when the patient needs an answer, the calls queued behind an action wait", async () => {
    // the consent-withdrawal variant: the patient speaks up while needles are being put in
    const sc = requireScenario(pack, "sg-insomnia/withdraws-consent");
    const provider = oracleProvider(sc.field.solution, { batch: 6 });
    const e = await runEpisode(sc, llmAgent({ provider }), { seed: 1 });
    expect(e.report.primary.status).toBe("success");
    const skipped = provider.requests.flatMap((r) => results(r.messages.at(-1))).filter((p) => /"skipped":true/.test(p.content));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((p) => /said something|consent is now/.test(p.content))).toBe(true);
    // what was not carried out was asked for again: the engine saw the reference's acts, in order, once each
    expect(e.log.requests.map((r) => r.action)).toEqual(sc.field.solution.map((r) => r.action));
  });

  it("stops with a reason when the model declines, cannot be reached, or runs out of turns", async () => {
    const declined = await runEpisode(hotKnee, llmAgent({ provider: scriptedProvider([{ stop: "refusal" }]) }), { seed: 1 });
    expect(declined).toMatchObject({ stopReason: "agent-done", note: "the model declined (refusal)", steps: 0 });
    const down = await runEpisode(hotKnee, llmAgent({ provider: scriptedProvider([{ error: { kind: "overloaded", message: "Overloaded", retryable: true, status: 529 } }]) }), { seed: 1 });
    expect(down.note).toBe("the model could not be reached (overloaded 529): Overloaded");
    const reading = (): ScriptedTurn => ({ calls: [{ name: "lookup", input: { topic: "regions" } }] });
    const lost = await runEpisode(hotKnee, llmAgent({ provider: scriptedProvider(Array.from({ length: 12 }, reading)), maxCallsPerTurn: 4 }), { seed: 1 });
    expect(lost.note).toBe("too many model turns without an action");
    const spent = await runEpisode(hotKnee, llmAgent({ provider: scriptedProvider(Array.from({ length: 12 }, (): ScriptedTurn => ({ calls: [{ name: "observe" }] }))), maxModelCalls: 3 }), { seed: 1 });
    expect(spent.note).toBe("the budget of 3 model turns is spent");
    expect(spent.steps).toBe(3);
  });

  it("a reply cut off at the output limit is asked for again with more room, and its calls are never run", async () => {
    const provider = scriptedProvider([{ calls: [{ name: "finish_encounter" }], stop: "max_tokens" }, { calls: [{ name: "observe" }] }, { stop: "refusal" }]);
    const e = await runEpisode(hotKnee, llmAgent({ provider }), { seed: 1 });
    expect(e.log.requests.map((r) => r.action.type)).toEqual(["observe"]);
    expect(provider.requests[0]!.maxTokens).toBeUndefined();
    expect(provider.requests[1]!.maxTokens).toBe(64_000);
    // the cut-off turn was not kept: the second request is the first again
    expect(provider.requests[1]!.messages).toEqual(provider.requests[0]!.messages);
    const twice = await runEpisode(hotKnee, llmAgent({ provider: scriptedProvider([{ stop: "max_tokens" }, { stop: "max_tokens" }]) }), { seed: 1 });
    expect(twice.note).toBe("the model's reply was cut off at the output limit");
  });

  it("a supervisor can refuse an action before it reaches the engine", async () => {
    const provider = scriptedProvider([{ calls: [{ name: "refer", input: { to: "gp", urgency: "routine", reason: "knee pain" } }, { name: "observe" }] }, { stop: "refusal" }]);
    const e = await runEpisode(hotKnee, llmAgent({ provider, approve: (action) => (action.type === "refer" ? "the supervisor wants the knee examined first" : null) }), { seed: 1 });
    expect(e.steps).toBe(0);
    const answers = results(provider.requests[1]!.messages.at(-1));
    expect(json(answers[0]!).error).toBe("Not carried out: the supervisor wants the knee examined first");
    expect(json(answers[1]!)).toMatchObject({ skipped: true });
  });
});

describe("the whole pilot through the loop (the reference trajectory spoken as tool calls)", () => {
  it.each([1, 4])("every scenario reaches its reference pathway, %i call(s) a turn", async (batch) => {
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      const expected = await runEpisode(sc, referenceAgent(sc), { seed: 1 });
      const e = await runEpisode(sc, llmAgent({ provider: oracleProvider(sc.field.solution, { batch }), skills: pack.skills }), { seed: 1 });
      expect(e.stopReason, id).toBe("finished");
      expect(e.report.primary, id).toEqual(expected.report.primary);
      expect(e.log.requests.map((r) => r.action), id).toEqual(sc.field.solution.map((r) => r.action));
      expect(e.log.finalDigest, id).toBe(expected.log.finalDigest);
    }
  }, 120_000);
});

describe("the standing instructions", () => {
  it("describe the environment and name only tools that exist", () => {
    const text = systemPrompt(pack.skills);
    for (const phrase of ["the environment, which is the only authority", "You have a body in it", "move first", "names the ids of the findings it rests on", "never a fixed number of centimetres", "Stronger stimulation is never the aim", "Never record a response you did not observe", "finish_encounter"]) expect(text).toContain(phrase);
    for (const s of pack.skills) expect(text).toContain(`- ${s.id}: `);
    expect(systemPrompt()).not.toContain("read_skill when you reach");
    // nothing of any case
    for (const family of pack.families.values()) expect(text).not.toContain(family.id);
    expect(text).not.toMatch(/knee|headache|insomnia|nausea|back pain/i);
  });
});

describe("a session", () => {
  it("is the one way a request gets its id and its version, and gives the replayable log", () => {
    const session = new EncounterSession(knee, { seed: 3 });
    expect(session.actor).toBe("practitioner");
    const asked = session.act({ type: "ask", text: "What brings you in today?" });
    expect(asked.attempt).toMatchObject({ requestId: "practitioner-0001", status: "executed" });
    expect(asked.result).toMatchObject({ status: "executed", changed: { record: { history: [{ id: "hx-chief" }] } } });
    const refused = session.act({ type: "finish_encounter" });
    expect(refused.attempt).toMatchObject({ requestId: "practitioner-0002", status: "rejected" });
    const log = session.log({ clinicalcraft: "test" }, { agent: "test" });
    expect(log).toMatchObject({ scenarioId: "sg-knee-oa/base", seed: 3, mode: "assessment", engine: { clinicalcraft: "test" }, meta: { agent: "test" } });
    expect(log.requests).toHaveLength(2);
    expect(digest(replayLog(knee, log).state)).toBe(log.finalDigest);
  });
});
