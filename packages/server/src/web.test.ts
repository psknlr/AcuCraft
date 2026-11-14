import { describe, expect, it } from "vitest";
import type { AgentView } from "@acucraft/core";
import { EncounterSession } from "@acucraft/agent";
import { loadContentPack, requireScenario } from "@acucraft/bench";
import { conversationLines } from "../web/record.js";
import { noteDraft } from "../web/composer.js";
import { score } from "../web/palette.js";
import type { TimelineEntry } from "./hub.js";

/**
 * The browser app's own reasoning, where it has any (docs/WEB.md): what it draws of the record must come from the
 * record — the practitioner's questions from the timeline, a note's draft from facts on the record only.
 */

const pack = loadContentPack();
const sc = requireScenario(pack, "sg-knee-oa/base");
const view = (): AgentView => new EncounterSession(sc, { seed: 1 }).view();

const entry = (seq: number, tool: string, input: Record<string, unknown>, minute: number, status = "executed"): TimelineEntry => ({
  seq,
  at: "2026-11-14T00:00:00.000Z",
  by: { kind: "operator", name: "Ann Tan", id: "operator:tab-1" },
  requestId: `r-${seq}`,
  tool,
  input,
  status: status as TimelineEntry["status"],
  code: null,
  message: "",
  observations: [],
  minute,
  version: seq,
});

describe("the conversation as the record page draws it", () => {
  it("puts the practitioner's questions back in from the timeline, each just before what was said at its minute", () => {
    const v = view();
    v.conversation = [{ minute: 1, speaker: v.patient.name, to: v.you.name, text: "My knee aches." }];
    v.record.history = [{ id: "hx-onset", question: "When did it start?", answer: "Eight months ago." }];
    v.conversation.push({ minute: 2, speaker: v.patient.name, to: v.you.name, text: "Eight months ago." });
    const lines = conversationLines(v, [entry(1, "ask", { text: "What brings you in?" }, 1), entry(2, "ask", { itemId: "hx-onset" }, 2), entry(3, "ask", { text: "refused" }, 3, "rejected")]);
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["question:What brings you in?", "said:My knee aches.", "question:When did it start?", "said:Eight months ago."]);
    expect(lines[0]!.by?.name).toBe("Ann Tan");
  });
});

describe("the clinical note's first draft", () => {
  it("is made of what is on the record only: no needle, no response, no consent that was not given", () => {
    const v = view();
    const draft = noteDraft(v).record as Record<string, unknown>;
    expect(draft.presentingComplaint).toBe(v.patient.presenting);
    expect(draft).not.toHaveProperty("consent");
    expect(draft).not.toHaveProperty("pointsUsed");
    expect(JSON.stringify(draft)).not.toMatch(/deqi|response/i);
  });
});

describe("the command palette", () => {
  it("ranks a word found whole above letters found in order, and finds nothing for letters out of order", () => {
    expect(score("needle", "insert needle")).toBeGreaterThan(score("ndl", "insert needle"));
    expect(score("ndl", "insert needle")).toBeGreaterThan(0);
    expect(score("zq", "insert needle")).toBe(0);
    expect(score("", "anything")).toBe(1);
    expect(score("ask", "ask")).toBeGreaterThan(score("ask", "task the assistant"));
  });
});
