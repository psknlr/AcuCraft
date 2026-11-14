/**
 * Skills: how things are done in this clinic, written down. A skill is a short Markdown text with a header — an id, a
 * title and *when to read it*. An agent is told only the index (id, title, when); it reads a skill in full with the
 * `read_skill` tool when the work calls for it, so the standing prompt stays small and the detail arrives when needed.
 *
 * Skills are public reference knowledge, like the point library: the same for every scenario, and they say nothing
 * of any case. They are data (`content/skills/*.md`), never code — a skill cannot act; only tools do.
 */

export const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
/** A skill is read in one go: longer than this it should be two skills. */
export const SKILL_MAX_CHARS = 6000;

export interface Skill {
  id: string;
  title: string;
  /** When to read it: the situation, in a sentence. */
  when: string;
  /** The text, in Markdown. */
  body: string;
}

export interface SkillIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

/**
 * A skill from its file text: a header between `---` lines (`id`, `title`, `when`, each on one line) and the body
 * after it. `path` names the file in the issues.
 */
export function parseSkill(text: string, path: string): { skill: Skill | null; issues: SkillIssue[] } {
  const issues: SkillIssue[] = [];
  const err = (message: string) => void issues.push({ path, message, severity: "error" });
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    err("a skill starts with a header between --- lines (id, title, when)");
    return { skill: null, issues };
  }
  const header: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) err(`header line not understood: ${line.slice(0, 60)}`);
    else if (kv[1]! in header) err(`header field given twice: ${kv[1]}`);
    else header[kv[1]!] = kv[2]!.trim();
  }
  for (const key of Object.keys(header)) if (!["id", "title", "when"].includes(key)) err(`unknown header field ${key}`);
  const { id = "", title = "", when = "" } = header;
  if (!SKILL_ID.test(id)) err(`id must be lower-case words joined by hyphens (got "${id}")`);
  if (!title) err("title is missing");
  if (!when) err("when is missing: say in a sentence when to read this skill");
  const body = m[2]!.trim();
  if (!body) err("the skill has no text");
  if (body.length > SKILL_MAX_CHARS) err(`the text is ${body.length} characters: keep a skill under ${SKILL_MAX_CHARS} (split it)`);
  return { skill: issues.length === 0 ? { id, title, when, body } : null, issues };
}

/** The index an agent is given: one line for each skill. */
export function skillIndex(skills: readonly Skill[]): string {
  return skills.map((s) => `- ${s.id}: ${s.title}. Read it ${lowerFirst(s.when)}`).join("\n");
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
