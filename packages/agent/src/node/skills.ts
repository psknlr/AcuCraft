import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkill, type Skill, type SkillIssue } from "../skills.js";

/**
 * The skills of a content pack: every `*.md` of its `skills/` folder, in file-name order. A file that does not parse
 * is reported and left out; two skills may not share an id.
 */
export function loadSkills(contentDir: string): { skills: Skill[]; issues: SkillIssue[] } {
  const dir = join(contentDir, "skills");
  const skills: Skill[] = [];
  const issues: SkillIssue[] = [];
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return { skills, issues };
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return { skills, issues };
  }
  for (const name of names) {
    const path = `skills/${name}`;
    const parsed = parseSkill(readFileSync(join(dir, name), "utf8"), path);
    issues.push(...parsed.issues);
    if (!parsed.skill) continue;
    if (`${parsed.skill.id}.md` !== name) issues.push({ path, message: `the file of skill ${parsed.skill.id} is named ${parsed.skill.id}.md`, severity: "error" });
    else if (skills.some((s) => s.id === parsed.skill!.id)) issues.push({ path, message: `skill id ${parsed.skill.id} is used twice`, severity: "error" });
    else skills.push(parsed.skill);
  }
  return { skills, issues };
}
