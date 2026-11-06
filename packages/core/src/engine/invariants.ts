import type { EncounterState } from "../schema/state.js";
import { needleList, retainedNeedles } from "./queries.js";
import type { Scenario } from "./scenario.js";

/**
 * The needle invariants (proposal §6), checked from the records themselves. A non-empty result is an engine defect:
 * `step(..., { strict: true })` throws on one, and the test-suite runs strict.
 */
export function checkInvariants(_sc: Scenario, s: EncounterState): string[] {
  const broken: string[] = [];
  // one holder per object
  const holders = new Map<string, string[]>();
  for (const a of Object.values(s.actors)) for (const o of a.holding) holders.set(o, [...(holders.get(o) ?? []), a.id]);
  for (const [o, hs] of holders) if (hs.length > 1) broken.push(`${o} is held by ${hs.join(" and ")} at once`);
  for (const n of needleList(s)) {
    const inHand = n.location.kind === "hand" ? n.location.actor : null;
    const held = holders.get(n.id) ?? [];
    if (inHand && !held.includes(inHand)) broken.push(`${n.id} is in ${inHand}'s hand but not in their holding`);
    if (!inHand && held.length > 0) broken.push(`${n.id} is listed in ${held.join(", ")}'s hands but lies ${n.location.kind}`);
    // a single-use needle never returns to an unused state
    const inserted = n.events.filter((e) => e.what === "inserted").length;
    if (inserted > 0 && !n.used) broken.push(`${n.id} was inserted but is not marked used`);
    if (inserted > 1) broken.push(`${n.id} was inserted ${inserted} times`);
    if (n.used && (n.location.kind === "pack" || n.location.kind === "tray")) broken.push(`${n.id} is used but back in ${n.location.kind}`);
    if (n.used && !n.contaminated && n.events.some((e) => e.what === "withdrawn")) broken.push(`${n.id} was withdrawn but is not contaminated`);
    // retained ⇔ inserted and not withdrawn (or lost or broken)
    const out = n.events.filter((e) => e.what === "withdrawn" || e.what === "dropped" || e.what === "broken").length;
    const retained = n.location.kind === "patient";
    if (retained !== (inserted - out === 1)) broken.push(`${n.id}: location ${n.location.kind} disagrees with its insertion history`);
    // withdrawal and disposal are separate events, in that order
    const disposed = n.events.findIndex((e) => e.what === "disposed");
    if (disposed >= 0 && n.used) {
      const withdrawn = n.events.findIndex((e) => e.what === "withdrawn" || e.what === "dropped");
      if (withdrawn < 0 || withdrawn > disposed) broken.push(`${n.id} was disposed of without a withdrawal first`);
    }
    if (n.location.kind === "sharps" && disposed < 0) broken.push(`${n.id} is in sharps without a disposal event`);
    // event order is the commit order
    for (let i = 1; i < n.events.length; i++) if (n.events[i]!.seq <= n.events[i - 1]!.seq) broken.push(`${n.id}: events out of order`);
  }
  for (const p of Object.values(s.packs)) {
    if (p.holder && !(holders.get(p.id) ?? []).includes(p.holder)) broken.push(`pack ${p.id} names ${p.holder} as holder, who does not hold it`);
  }
  if (s.finished && retainedNeedles(s).length > 0) broken.push("the encounter finished with needles in the patient");
  for (const v of s.visits) if (v.ended && v.endedAt === null) broken.push(`visit ${v.index} ended without a time`);
  return broken;
}
