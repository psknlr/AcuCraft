/**
 * The tables of docs/TECHNIQUES.md §3, written from the operative catalogue (`@acucraft/core`): one table for each
 * group, a row for each technique — what it is for, the stages of one performance, its dose, how it reads.
 *
 *   npx tsx tools/technique-tables.ts            print the tables
 *   npx tsx tools/technique-tables.ts --check    fail when docs/TECHNIQUES.md does not have them
 *   npx tsx tools/technique-tables.ts --write    put them into docs/TECHNIQUES.md (§3, up to §4's heading)
 *
 * tools/test/technique-tables.test.ts holds the document to them: change the catalogue, and the page follows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPERATIVE_TECHNIQUES, TECHNIQUE_GROUPS } from "../packages/core/src/index.js";

export function techniqueTables(): string[] {
  const lines: string[] = [];
  for (const group of TECHNIQUE_GROUPS) {
    lines.push(`### ${group.zh} · ${group.label}`, "", group.note, "", "| | id | what it is for | one performance | dose | reads as |", "|---|---|---|---|---|---|");
    for (const t of OPERATIVE_TECHNIQUES.filter((x) => x.card.group === group.id)) {
      // a compound with many moves is told by its essentials; everything else by its stages in order
      const performance = group.id === "compound" && t.stages.filter((x) => x.counted || x.motif === "move").length > 6
        ? t.card.essentials.slice(0, 2).join(" ")
        : t.stages.map((x) => `${x.zh}${x.counted && x.count > 1 ? ` ×${x.count}` : ""}`).join(" → ");
      const extra = [t.effect.winds ? "winds the needle" : "", t.effect.loosensDeg ? `loosens ${t.effect.loosensDeg}°` : "", t.effect.needsDepthMm ? `needs ≥ ${t.effect.needsDepthMm} mm` : "", t.effect.seeks ? `seeks ${t.effect.seeks}` : ""].filter(Boolean).join("; ");
      lines.push(`| **${t.zh}** ${t.card.name} | \`${t.id}\` | ${t.card.aim} | ${performance} · ${(t.defaults.durationMs / 1000).toFixed(1)} s${extra ? ` · ${extra}` : ""} | ${t.effect.dose || "—"} | ${t.effect.reading ?? "—"} |`);
    }
    lines.push("");
  }
  return lines;
}

/** The lines of the tables the document does not have (none: it is up to date). */
export function missingFromDocument(): string[] {
  const document = readFileSync(fileURLToPath(new URL("../docs/TECHNIQUES.md", import.meta.url)), "utf8");
  return techniqueTables().filter((line) => line.trim() !== "" && !document.includes(line));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--write")) {
    const path = fileURLToPath(new URL("../docs/TECHNIQUES.md", import.meta.url));
    const document = readFileSync(path, "utf8"), tables = techniqueTables();
    const from = document.indexOf(tables[0]!), to = document.indexOf("## 4. ");
    if (from < 0 || to < from) throw new Error("docs/TECHNIQUES.md has no §3 tables to replace (the first group's heading, then '## 4. ')");
    writeFileSync(path, `${document.slice(0, from)}${tables.join("\n")}\n${document.slice(to)}`);
    console.log("docs/TECHNIQUES.md: §3's tables written from the catalogue");
  } else if (process.argv.includes("--check")) {
    const missing = missingFromDocument();
    if (missing.length > 0) {
      console.error(`docs/TECHNIQUES.md is not what the catalogue writes (${missing.length} lines differ): run npx tsx tools/technique-tables.ts and paste §3's tables`);
      for (const line of missing.slice(0, 5)) console.error(`  ${line.slice(0, 140)}`);
      process.exit(1);
    }
    console.log("docs/TECHNIQUES.md has the catalogue's tables");
  } else console.log(techniqueTables().join("\n"));
}
