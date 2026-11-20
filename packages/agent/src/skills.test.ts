import { describe, expect, it } from "vitest";
import { t } from "@clinicalcraft/core";
import { loadContentPack, requireScenario, scenarioIds } from "@acucraft/bench";
import { ACTION_TYPES, LOOKUP_TOPICS, parseSkill, SKILL_MAX_CHARS, skillIndex, VIEW_SECTIONS } from "./index.js";

/**
 * Skills (docs/AGENT.md): the clinic's ways of working as short texts an agent reads when it needs them. They are
 * data, they are public, and what they say about the tools has to be true of the tools.
 */

const pack = loadContentPack();

describe("a skill file", () => {
  const text = "---\nid: closing-a-visit\ntitle: Closing a visit\nwhen: When the retention time is up.\n---\nRemove, dispose, count.\n";

  it("has a header (id, title, when) and a text", () => {
    expect(parseSkill(text, "skills/closing-a-visit.md")).toEqual({ skill: { id: "closing-a-visit", title: "Closing a visit", when: "When the retention time is up.", body: "Remove, dispose, count." }, issues: [] });
  });

  it("is refused with a reason when the header or the text is wrong", () => {
    const bad = (t: string) => parseSkill(t, "skills/x.md").issues.map((i) => i.message).join(" | ");
    expect(bad("Just text.")).toMatch(/starts with a header/);
    expect(bad(text.replace("id: closing-a-visit", "id: Closing A Visit"))).toMatch(/id must be lower-case words joined by hyphens/);
    expect(bad(text.replace("when: When the retention time is up.\n", ""))).toMatch(/when is missing/);
    expect(bad(text.replace("title: Closing a visit", "title: Closing a visit\nauthor: someone"))).toMatch(/unknown header field author/);
    expect(bad(text.replace("Remove, dispose, count.", ""))).toMatch(/has no text/);
    expect(bad(text.replace("Remove, dispose, count.", "x".repeat(SKILL_MAX_CHARS + 1)))).toMatch(/keep a skill under/);
    expect(parseSkill("Just text.", "skills/x.md").skill).toBeNull();
  });
});

describe("the clinic's skills", () => {
  it("load without a complaint, each in a file named after it", () => {
    expect(pack.issues.filter((i) => i.path.startsWith("skills/"))).toEqual([]);
    expect(pack.skills.map((s) => s.id)).toEqual(["clean-needle-technique", "closing-a-visit", "depth-and-direction", "needle-response", "observation-and-events", "pattern-differentiation", "point-location", "red-flags-and-referral", "visit-arc"]);
    const index = skillIndex(pack.skills);
    expect(index.split("\n")).toHaveLength(pack.skills.length);
    expect(index).toMatch(/^- clean-needle-technique: Clean needle technique.*\. Read it before the first needle of a visit/);
  });

  it("name only tools, lookup topics, view sections and skills that exist", () => {
    const tools = new Set<string>([...ACTION_TYPES, "lookup", "view", "construct_point", "read_skill"]);
    const ids = new Set(pack.skills.map((s) => s.id));
    for (const skill of pack.skills) {
      const quoted = [...skill.body.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      for (const q of quoted) {
        const [head, ...rest] = q.split(" ");
        // `lookup pattern`, `view needling`: a tool with what to ask it for
        if (head === "lookup" && rest.length > 0) expect(LOOKUP_TOPICS as readonly string[], `${skill.id}: ${q}`).toContain(rest[0]);
        else if (head === "view" && rest.length > 0) expect(VIEW_SECTIONS as readonly string[], `${skill.id}: ${q}`).toContain(rest[0]);
        // anything written like a tool (words joined by underscores) is one
        else if (/^[a-z]+(_[a-z]+)+$/.test(q)) expect([...tools], `${skill.id}: ${q}`).toContain(q);
        // another skill
        else if (/^[a-z]+(-[a-z]+)+$/.test(q) && !["not-sought", "monitor-patient", "count-needles", "lost-needle", "broken-needle", "treat-modified"].includes(q)) expect([...ids], `${skill.id}: ${q}`).toContain(q);
      }
      // every action it tells the reader to take is one a practitioner has
      for (const m of skill.body.matchAll(/`([a-z_]+)`/g)) if (!m[1]!.includes("_") && ["ask", "say", "explain", "assess", "decide", "refer", "examine", "observe", "monitor", "wait", "move", "fetch", "dispose", "search", "document", "measure"].includes(m[1]!)) expect(tools.has(m[1]!)).toBe(true);
    }
  });

  it("say nothing of any case: no family, no variant, no pathway, no point prescription", () => {
    const all = pack.skills.map((s) => `${s.title}\n${s.when}\n${s.body}`).join("\n");
    for (const id of scenarioIds(pack)) {
      const sc = requireScenario(pack, id);
      expect(all, id).not.toContain(sc.family.id);
      // what only the scenario knows: its pathways, its critical errors, the patient by name
      for (const hidden of [...sc.field.evaluation.pathways.map((x) => x.id), ...sc.field.evaluation.criticalErrors.map((x) => x.id), t(sc.case.patient.displayName, "en")]) expect(all, `${id}: ${hidden}`).not.toContain(hidden);
    }
    // a skill says how to work, not which points to choose: no point id appears in any of them
    expect(all).not.toMatch(/\b(LU|LI|ST|SP|HT|SI|BL|KI|PC|TE|GB|LR|GV|CV)\d{1,2}\b/);
  });
});
