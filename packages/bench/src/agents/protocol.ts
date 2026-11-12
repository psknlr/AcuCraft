import type { ActionInput, AgentView, ChartPoint, PointRef } from "@acucraft/core";
import { constructPoint, medialAzimuth, requirements } from "./localise.js";
import type { Agent, AgentInit, AgentTurn } from "./types.js";

/**
 * A rule-based baseline practitioner. It knows only what a practitioner could: the agent view and the public reference
 * library. It screens with a fixed question list, recognises red flags by keyword, treats with a standard prescription
 * per complaint, localises every point from the landmarks it palpates and the segments it measures, needles at
 * textbook depths that do not adapt to the patient's build, delegates monitoring and accounts for every needle.
 *
 * It is deliberately ordinary: a reference for what knowledge applied without judgement achieves, so the benchmark
 * shows where adaptation (build, position, events) matters.
 */

type Complaint = "knee" | "back" | "headache" | "nausea" | "sleep" | "unknown";
type Side = "left" | "right" | "midline";

interface Protocol {
  points: { point: string; side: Side }[];
  position: string;
  diagnosis: string;
  region: string[];
}

const DEPTH: Record<string, { depth: number; angle?: number; az?: "medial" | "lateral" | number }> = {
  ST35: { depth: 1.5, angle: 30, az: "medial" },
  "EX-LE4": { depth: 1.5, angle: 30, az: "lateral" },
  "EX-LE2": { depth: 0.8 },
  ST36: { depth: 2.0 },
  ST40: { depth: 2.0 },
  GB34: { depth: 1.5 },
  SP9: { depth: 1.8 },
  SP6: { depth: 1.5 },
  BL23: { depth: 1.8 },
  BL25: { depth: 1.8 },
  BL52: { depth: 1.2 },
  GV3: { depth: 1.5, angle: 20, az: 0 },
  GV4: { depth: 1.5, angle: 20, az: 0 },
  GB20: { depth: 1.6, angle: 20, az: "medial" },
  GB21: { depth: 2.0 },
  GV14: { depth: 1.2, angle: 20, az: 0 },
  LI4: { depth: 1.5 },
  SI3: { depth: 1.0 },
  PC6: { depth: 1.0 },
  HT7: { depth: 0.5 },
  LU7: { depth: 0.8, angle: 75, az: 0 },
};

const NEGATOR = /\b(no|not|never|nothing|without|denies|none)\b|n't\b/;

/** Does `re` match a clause of `text` that is not negated? */
function positive(text: string, re: RegExp): boolean {
  for (const clause of text.toLowerCase().split(/[.;!?—]|, but /)) {
    const m = clause.match(re);
    if (!m || m.index === undefined) continue;
    const before = clause.slice(Math.max(0, m.index - 30), m.index);
    if (!NEGATOR.test(before) && !NEGATOR.test(m[0])) return true;
  }
  return false;
}

export function protocolAgent(): Agent {
  let lib!: AgentInit["library"];
  let me = "practitioner";
  const queue: ActionInput[] = [];
  let stage = "consult";
  let complaint: Complaint = "unknown";
  let affected: Side = "right";
  let plan: PointRef[] = [];
  let protocol: Protocol | null = null;
  let needled: { needle: string; target: PointRef }[] = [];
  let packs: string[] = [];
  let retainedFor = 0;
  let retention = 20;
  let seenConversation = 0;
  let adverse: string[] = [];
  let fainted = false;
  let retried = new Set<string>();
  let discomfortHandled = false;
  let withdrawn = false;
  let lastIssued: ActionInput | null = null;
  let declined = false;
  let anticoagulated = false;
  let pregnant = false;
  let redFlags: string[] = [];
  let endTries = 0;

  const text = (v: AgentView) => [v.patient.presenting, ...v.record.history.map((h) => h.answer), ...v.record.examination.map((e) => e.finding), ...v.record.results].join(" ");
  const push = (...a: ActionInput[]) => queue.push(...a);

  function detect(v: AgentView): void {
    const classify = (t: string): Complaint => (/knee/.test(t) ? "knee" : /headache/.test(t) ? "headache" : /nause|chemo/.test(t) ? "nausea" : /sleep|insomnia/.test(t) ? "sleep" : /\bback\b/.test(t) ? "back" : "unknown");
    // the presenting complaint decides; the answers only when it says nothing recognisable
    complaint = classify(v.patient.presenting.toLowerCase());
    if (complaint === "unknown") complaint = classify(v.record.history.map((h) => h.answer).join(" ").toLowerCase());
    const p = `${v.patient.presenting} ${v.record.history.map((h) => h.answer).join(" ")}`.toLowerCase();
    affected = /left (knee|leg)/.test(p) ? "left" : "right";
  }

  function consultQuestions(v: AgentView): string[] {
    const q = ["What brings you in today?", "How did it start, and how has it changed?", "Where exactly is it, and does it spread anywhere?", "What makes it worse or better?", "Any fever, weight loss, pain at night, or feeling unwell?"];
    if (complaint === "knee") q.push("Has the knee been swollen, red or hot?", "Does the knee lock or give way?", "What treatment have you had so far?");
    if (complaint === "back") q.push("Does the pain go down your leg — any numbness or tingling?", "Any numbness around your groin or bottom, or trouble passing urine or opening your bowels?", "Any weakness in your legs?");
    if (complaint === "headache") q.push("How often do you get them, and how long do they last?", "Has any headache come on suddenly and severely, or with weakness, numbness, vision changes or confusion?", "Have you eaten today?");
    if (complaint === "sleep") q.push("Tell me about your sleep — falling asleep, waking, how many hours.", "How has your mood been — any low mood, or losing interest in things?", "Have you had any thoughts that life isn't worth living, or of harming yourself?", "How does it affect you in the day — do you get sleepy while driving?", "How much coffee, tea or alcohol do you have?");
    if (complaint === "nausea") q.push("Tell me about the nausea — when it comes and how bad it is.", "Does your oncology team know you'd like acupuncture?", "Any fever, chills or signs of infection?", "What surgery have you had — were any lymph nodes removed, and is there any arm swelling?");
    q.push("What other medical conditions do you have?", "What medicines do you take — including blood thinners or supplements?", "Do you bruise or bleed easily?");
    if (v.patient.sex === "female" && v.patient.age >= 14 && v.patient.age <= 50) q.push("Is there any chance you could be pregnant?");
    q.push("Have you had acupuncture before? How do you feel about needles?", "What worries you, and what would you like from today?");
    return q;
  }

  function exams(): string[] {
    switch (complaint) {
      case "knee":
        return ["Inspect both knees", "Palpate the right knee", "Check for an effusion", "Examine the skin of the legs, including for varicose veins", "Inspect the tongue"];
      case "back":
        return ["Inspect the back and posture", "Palpate the lumbar spine and paraspinal muscles", "Straight leg raise", "Examine leg power, reflexes and sensation, including the saddle area", "Inspect the tongue"];
      case "headache":
        return ["Brief neurological examination", "Palpate the neck and shoulders", "Inspect the tongue"];
      case "nausea":
        return ["Examine both arms and hands, including for swelling", "Examine the legs", "Inspect the tongue"];
      case "sleep":
        return ["General inspection", "Examine the skin of the arms and legs", "Inspect the tongue"];
      default:
        return ["General inspection"];
    }
  }

  function findRedFlags(v: AgentView): string[] {
    const t = text(v);
    const out: string[] = [];
    if (complaint === "knee" && positive(t, /fever|chills/) && positive(t, /\b(hot|red|swollen)\b/)) out.push("hot-swollen-joint-fever");
    if (positive(t, /hardly (put weight|walk)|barely bears weight|can'?t walk/)) out.push("unable-to-bear-weight");
    if (positive(t, /numb\w* around (my )?(bottom|groin)|saddle area|saddle anaesthesia/)) out.push("saddle-anaesthesia");
    if (/(haven't been able|unable|can't|cannot) to pass urine|incontinen|retention/.test(t.toLowerCase())) out.push("bladder-bowel-dysfunction");
    if (complaint === "back" && positive(t, /legs? (feel )?(heavy|weak)|reflexes reduced|weaker/)) out.push("progressive-neuro-deficit");
    if (complaint === "headache" && positive(t, /sudden\w* (and )?(severe|worst)|worst (headache )?ever|thunderclap/)) out.push("thunderclap-headache");
    if (positive(t, /better off without me|kill myself|harm(ing)? myself|end (my life|it all)|crashing the taxi|not worth living/)) out.push("suicidal-ideation");
    if (/neutrophils 0\.\d|neutrophils 1\.[0-4]|platelets [1-9]\d? ×|\(low\)/.test(t.toLowerCase()) || (complaint === "nausea" && positive(t, /\bfever\b/))) out.push("fever-on-chemotherapy");
    return out;
  }

  function buildProtocol(v: AgentView): Protocol {
    const lr = (p: string) => [{ point: p, side: "left" as Side }, { point: p, side: "right" as Side }];
    switch (complaint) {
      case "knee":
        return { points: ["ST35", "EX-LE4", "ST36", "SP9"].map((p) => ({ point: p, side: affected })), position: "supine-knee-flexed", diagnosis: "knee-osteoarthritis", region: ["knee-leg"] };
      case "back": {
        if (pregnant) return { points: [], position: "side-lying-left", diagnosis: "pregnancy-related-lbp", region: ["lumbar"] };
        return { points: [...lr("BL23"), ...lr("BL25"), { point: "GV3", side: "midline" }], position: "prone", diagnosis: "chronic-nonspecific-lbp", region: ["lumbar"] };
      }
      case "headache":
        return { points: [...lr("GB20"), ...lr("GB21"), ...lr("LI4")], position: "prone", diagnosis: "tension-type-headache", region: ["neck-shoulder", "hand-dorsum"] };
      case "nausea":
        return { points: [...lr("PC6"), ...lr("ST36")], position: "supine-knee-flexed", diagnosis: "chemotherapy-nausea", region: ["forearm", "knee-leg"] };
      case "sleep":
        return { points: [...lr("HT7"), ...lr("SP6")], position: "supine-knee-flexed", diagnosis: "insomnia", region: ["forearm", "knee-leg"] };
      default:
        void v;
        return { points: [], position: "seated", diagnosis: "", region: [] };
    }
  }

  function pattern(v: AgentView): string | undefined {
    const t = text(v).toLowerCase();
    if (complaint === "knee") return /cold|damp|rain|heavy|air-con/.test(t) ? "wind-cold-damp-bi" : "qi-blood-stagnation";
    if (complaint === "back") return /tired|weak/.test(t) ? "kidney-yang-deficiency" : "qi-blood-stagnation";
    if (complaint === "headache") return /irritable|stress/.test(t) ? "liver-qi-stagnation" : "liver-yang-rising";
    if (complaint === "nausea") return /appetite|tired|loose/.test(t) ? "spleen-stomach-deficiency" : "stomach-qi-rebellion";
    if (complaint === "sleep") return /appetite|tired|palpitation|heart races|dreams/.test(t) ? "heart-spleen-deficiency" : "liver-qi-stagnation";
    return undefined;
  }

  /** Whole-region site exclusions found on examination ("lymphoedema of the left arm (forearm, left)"). */
  function excluded(v: AgentView): { region: string; side: string; centre?: ChartPoint; r?: number }[] {
    const out: { region: string; side: string; centre?: ChartPoint; r?: number }[] = [];
    for (const site of v.record.sites) {
      const m = site.match(/\(([a-z-]+), (left|right|midline)(?:, around u=(-?[\d.]+), v=(-?[\d.]+), radius ([\d.]+) cm)?\)/);
      if (!m) continue;
      out.push({ region: m[1]!, side: m[2]!, ...(m[3] ? { centre: { u: Number(m[3]), v: Number(m[4]) }, r: Number(m[5]) } : {}) });
    }
    return out;
  }

  /** Regions an `avoid-regions` rule in force keeps needles out of, for this patient's known risk factors. */
  function avoidedRegions(v: AgentView): Set<string> {
    const out = new Set<string>();
    const weeks = Number(/(\d+)\s*weeks pregnant/i.exec(v.record.history.map((h) => h.answer).join(" "))?.[1] ?? Infinity);
    for (const set of lib.rules.find((r) => r.visit === 1)?.sets ?? []) {
      for (const r of set.rules) {
        if (r.check.kind !== "avoid-regions") continue;
        if (r.check.riskFactor === "pregnancy" && pregnant && weeks >= (r.check.fromGestationWeek ?? 0)) for (const g of r.check.regions) out.add(g);
      }
    }
    return out;
  }

  function explainText(): string {
    const ev = lib.evidence.map((e) => `${e.publisher} (${e.version}) — ${e.statement}`).join(" ");
    return [
      `I suggest a course of acupuncture: ${plan.length} fine single-use sterile needles, left in for about ${retention} minutes.`,
      ev ? `The evidence is mixed: ${ev}` : "The evidence for this use is limited.",
      "The risks are small: soreness, a little bleeding or bruising, feeling faint, and rarely infection.",
      "The alternatives include exercise and keeping active, physiotherapy, and treatment through your doctor.",
      "You can ask me to stop at any time.",
    ].join(" ");
  }

  function planAction(points: PointRef[]): ActionInput {
    return { type: "propose_plan", plan: { points, technique: { method: "manual-filiform", stimulation: "even", retentionMinutes: retention }, rationale: `Standard ${complaint} protocol.`, alternatives: ["Exercise and keeping active", "Physiotherapy", "Treatment through her doctor"], followUp: "Review in one week." } };
  }

  function stagePlan(v: AgentView): void {
    stage = "plan";
    protocol = buildProtocol(v);
    const ex = excluded(v);
    const pts: PointRef[] = protocol.points
      .filter((p) => !ex.some((e) => !e.centre && e.side === p.side && lib.points.find((x) => x.id === p.point)?.region === e.region))
      .filter((p) => !(pregnant && lib.points.find((x) => x.id === p.point)?.cautions.some((c) => c.when === "pregnancy")))
      .map((p) => ({ point: p.point, side: p.side }));
    for (const a of v.record.tenderPoints) pts.push({ ashi: a.id });
    // regions the rules in force keep needles out of for this patient (after the first trimester: the abdomen and the
    // lumbosacral region), whatever point lies there
    const avoided = avoidedRegions(v);
    const regionOf = (p: PointRef) => ("ashi" in p ? v.record.tenderPoints.find((a) => a.id === p.ashi)?.region : lib.points.find((x) => x.id === p.point)?.region);
    plan = pts.filter((p) => !avoided.has(regionOf(p) ?? ""));
    if (plan.length === 0 && pregnant) {
      push(
        { type: "assess", diagnoses: protocol.diagnosis ? [protocol.diagnosis] : [], redFlags: [], rationale: "No red flags on screening; pregnant." },
        { type: "decide", disposition: "defer", rationale: avoided.size ? `Pregnant: no needling of the ${[...avoided].join(", ")} under the rules in force.` : "Pregnant: no suitable points." },
        { type: "explain", topics: ["alternatives", "evidence"], text: "Because you are pregnant I won't needle these areas: our guidance is to avoid them at this stage. Antenatal physiotherapy, a support belt and advice from your obstetric team are better options for now." },
        { type: "refer", to: "obstetrics", urgency: "routine", reason: "Pregnancy-related symptoms; acupuncture deferred under the rules in force." },
      );
      stage = "document";
      return;
    }
    if (plan.length === 0) {
      push({ type: "decide", disposition: "defer", rationale: "No suitable points for this presentation." }, { type: "explain", topics: ["alternatives"], text: "I won't needle today; exercise, physiotherapy or your doctor are better options for now." }, { type: "refer", to: "gp", urgency: "routine", reason: "Review by her doctor." });
      stage = "document";
      return;
    }
    push(
      { type: "assess", diagnoses: protocol.diagnosis ? [protocol.diagnosis] : [], ...(pattern(v) ? { pattern: pattern(v)! } : {}), redFlags: [], rationale: "No red flags on screening." },
      { type: "decide", disposition: anticoagulated || pregnant || ex.length > 0 ? "treat-modified" : "treat", rationale: "No red flags; standard protocol." },
      planAction(plan),
      { type: "explain", topics: ["procedure", "benefits", "risks", "alternatives", "evidence", "right-to-stop"], text: explainText() },
      { type: "seek_consent" },
    );
    stage = "consent";
  }

  function stageLocalise(v: AgentView): void {
    // landmarks and segments for every planned standard point
    const lms = new Set<string>();
    const segs = new Set<string>();
    for (const p of plan) {
      if ("ashi" in p) continue;
      for (const req of requirements(lib, p.point, p.side) ?? []) {
        for (const l of req.landmarks) lms.add(`${req.region}|${req.side}|${l}`);
        for (const s of req.segments) segs.add(`${req.region}|${req.side}|${s}`);
      }
    }
    for (const key of lms) {
      const [region, side, landmark] = key.split("|");
      push({ type: "identify_landmark", region: region!, side: side as Side, landmark: landmark! });
    }
    for (const key of segs) {
      const [region, side, segment] = key.split("|");
      push({ type: "measure", region: region!, side: side as Side, segment: segment! });
    }
    void v;
    stage = "mark";
  }

  function stageMark(v: AgentView): void {
    const ex = excluded(v);
    const kept: PointRef[] = [];
    for (const p of plan) {
      if ("ashi" in p) {
        const a = v.record.tenderPoints.find((x) => x.id === p.ashi)!;
        push({ type: "mark_point", target: p, region: a.region, side: a.side as Side, at: a.centre, method: "palpation" });
        kept.push(p);
        continue;
      }
      const req = requirements(lib, p.point, p.side)![0]!;
      const observed = (region: string, side: Side) => ({
        landmarks: new Map(v.localisation.landmarks.filter((l) => l.region === region && l.side === side).map((l) => [l.landmark, { u: l.u, v: l.v }])),
        segments: new Map(v.localisation.measurements.filter((m) => m.region === region && m.side === side).map((m) => [m.what, m.cm])),
      });
      const at = constructPoint(lib, p.point, p.side, observed);
      if (!at) continue;
      if (ex.some((e) => e.centre && e.region === req.region && (e.side === p.side || e.side === "midline") && Math.hypot(e.centre.u - at.u, e.centre.v - at.v) <= (e.r ?? 0) + 0.5)) continue;
      push({ type: "mark_point", target: p, region: req.region, side: req.side, at: { u: Math.round(at.u * 100) / 100, v: Math.round(at.v * 100) / 100 }, method: "proportional" });
      kept.push(p);
    }
    if (kept.length < plan.length) {
      plan = kept;
      queue.unshift(planAction(plan)); // narrower plan: consent carries over
    }
    stage = "prepare";
  }

  function stagePrepare(v: AgentView): void {
    const n = plan.length;
    const sealed = v.equipment.packs.filter((p) => p.sealed);
    packs = [];
    let have = 0;
    for (const p of sealed) {
      if (have >= n) break;
      packs.push(p.id);
      have += p.needles;
    }
    push({ type: "move", to: "prep-area" }, { type: "hand_hygiene" }, ...packs.map((id) => ({ type: "fetch" as const, item: id })), { type: "move", to: v.patient.location });
    const sites = new Set<string>();
    for (const m of v.localisation.marks) sites.add(`${m.region}|${m.side}`);
    for (const s of sites) {
      const [region, side] = s.split("|");
      push({ type: "prepare_site", region: region!, side: side as Side });
    }
    for (const id of packs) push({ type: "open_pack", packId: id });
    stage = "insert";
  }

  function stageInsert(v: AgentView): void {
    const free = v.equipment.needles.filter((x) => x.where.startsWith("on the tray") && !x.used).map((x) => x.id);
    const marks = v.localisation.marks.filter((m) => !m.stale);
    marks.forEach((m, i) => {
      const id = free[i];
      if (!id) return;
      const target: PointRef = m.target.startsWith("ashi:") ? { ashi: m.target.slice(5) } : { point: m.target.split(":")[0]!, side: m.target.split(":")[1] as Side };
      const spec = "ashi" in target ? { depth: 1.0 } : (DEPTH[target.point] ?? { depth: 1.0 });
      const az = spec.az === "medial" ? medialAzimuth(lib, m.region, m.side as Side) : spec.az === "lateral" ? (medialAzimuth(lib, m.region, m.side as Side) + 180) % 360 : (spec.az ?? 0);
      push({ type: "pick_up", object: id }, { type: "insert_needle", needleId: id, mark: m.id, angleDeg: spec.angle ?? 0, azimuthDeg: az, depthCm: spec.depth });
      needled.push({ needle: id, target });
    });
    push({ type: "monitor" });
    stage = "retain";
  }

  function newPatientLines(v: AgentView): string[] {
    const lines = v.conversation.slice(seenConversation);
    seenConversation = v.conversation.length;
    return lines.filter((l) => l.speaker === v.patient.name || /needs you now/.test(l.text)).map((l) => l.text);
  }

  function handleBlocked(v: AgentView): void {
    // an insertion the guard stopped: retry once, shallower and oblique (the blocked attempt stays on record)
    if (v.last?.type !== "insert_needle" || v.last.status !== "blocked") return;
    const id = v.you.holding.find((h) => /\.\d+$/.test(h));
    const entry = needled.find((n) => n.needle === id);
    if (!id || !entry || retried.has(id)) return;
    retried.add(id);
    const mark = v.localisation.marks.find((m) => m.target === ("ashi" in entry.target ? `ashi:${entry.target.ashi}` : `${entry.target.point}:${entry.target.side}`));
    if (mark) queue.unshift({ type: "insert_needle", needleId: id, mark: mark.id, angleDeg: 45, azimuthDeg: 0, depthCm: 1.0 });
  }

  function faint(): void {
    fainted = true;
    adverse.push("Vasovagal reaction during retention: treatment stopped, needles removed, laid flat, observed.");
    queue.length = 0;
    push({ type: "stop_treatment", reason: "the patient feels faint" }, { type: "remove_all_needles" }, { type: "position_patient", position: "supine" }, { type: "monitor" }, { type: "check_vitals" }, { type: "wait", minutes: 3 }, { type: "monitor" });
    stage = "close";
  }

  function stageClose(v: AgentView): void {
    if (v.equipment.needles.some((n) => n.where.startsWith("in the patient"))) push({ type: "remove_all_needles" });
    for (const id of packs) push({ type: "dispose", object: id });
    push({ type: "hand_hygiene" }, { type: "count_needles" });
    stage = "reconcile";
  }

  function stageReconcile(v: AgentView): void {
    const bleeding = (v.last?.observations ?? []).flatMap((o) => [...o.matchAll(/site of ([\w.-]+) is bleeding/g)].map((m) => m[1]!));
    for (const id of bleeding) push({ type: "apply_pressure", needleId: id });
    const count = v.counts.at(-1);
    if (count && !count.reconciled) {
      push({ type: "search", area: "floor" }, { type: "search", area: "couch" });
      stage = "recover";
      return;
    }
    stage = "document";
  }

  function stageRecover(v: AgentView): void {
    const found = v.equipment.needles.filter((n) => /on the (floor|couch|clothing)/.test(n.where)).map((n) => n.id);
    for (const id of found) push({ type: "pick_up", object: id }, { type: "dispose", object: id });
    if (found.length === 0) push({ type: "report_incident", kind: "lost-needle", description: "A needle could not be found after searching the floor and the couch." });
    push({ type: "hand_hygiene" }, { type: "count_needles" });
    stage = "document";
  }

  function stageDocument(v: AgentView): void {
    const pts = needled.map((n) => n.target);
    if (pts.length > 0 || plan.length > 0) {
      push({ type: "explain", topics: ["aftercare"], text: "Afterwards rest for the day; a little soreness or a small bruise can happen." });
      push({
        type: "document",
        record: {
          presentingComplaint: v.patient.presenting,
          assessment: protocol?.diagnosis || "assessment recorded",
          rationale: `Standard ${complaint} protocol.`,
          consent: "Verbal consent after explanation.",
          pointsUsed: pts,
          needling: { needleType: "single-use sterile filiform", needleCount: pts.length, depth: "textbook depths", responseSought: "deqi", stimulation: "even", retentionMinutes: retention },
          response: fainted ? "Treatment stopped early." : "Tolerated.",
          adverseEvents: adverse.join(" ") || "None.",
          followUp: "Review in one week.",
        },
      });
    }
    push({ type: "end_visit" });
    stage = "ended";
  }

  return {
    name: "protocol (rule-based)",
    init(init) {
      lib = init.library;
      me = init.actorId;
      void me;
    },
    next(v: AgentView): AgentTurn {
      if (v.finished) return { done: true };
      // an insertion that did not go in is not a needle in the record (unless the retry below puts it in)
      if (lastIssued?.type === "insert_needle" && v.last && v.last.status !== "executed" && v.last.status !== "partial") {
        const failed = lastIssued.needleId;
        if (retried.has(failed) || v.last.status !== "blocked") needled = needled.filter((n) => n.needle !== failed);
      }
      // the patient's state comes first, whatever the stage
      const lines = newPatientLines(v);
      if (["insert", "retain"].includes(stage) || (stage === "plan" && needled.length > 0)) {
        if (!withdrawn && (v.patient.consent === "withdrawn" || lines.some((l) => /\bstop\b.*\b(take them out|don't want)|take (them|the needles) out|don'?t want any more/i.test(l)))) {
          // the patient withdraws consent: stop at once, every needle out, no more needling
          withdrawn = true;
          adverse.push("The patient withdrew consent during the procedure: stopped and every needle removed.");
          queue.length = 0;
          push({ type: "stop_treatment", reason: "the patient withdrew consent" }, { type: "remove_all_needles" }, { type: "say", to: "patient", text: "Of course — I'm taking them all out now. We'll stop here." }, { type: "monitor" });
          stage = "close";
        } else if (!fainted && (v.patient.appearance.includes("faint") || lines.some((l) => /faint|dizzy|grey|going to be sick/i.test(l)))) faint();
        else if (lines.some((l) => /sharp|burn|electric|shock|hurts/i.test(l)) && !discomfortHandled && needled.length > 0) {
          const last = needled[needled.length - 1]!;
          adverse.push(`Discomfort at ${last.needle}: withdrawn.`);
          queue.unshift({ type: "monitor" }, { type: "remove_needle", needleId: last.needle }, { type: "dispose", object: last.needle });
          discomfortHandled = true;
        }
      }
      if (stage === "insert" || stage === "retain") handleBlocked(v);
      if (v.last?.type === "position_patient" && /declined/.test(v.last.message) && !declined) {
        declined = true;
        queue.unshift({ type: "position_patient", position: complaint === "headache" ? "seated-forward" : "side-lying-left" });
      }
      if (v.last?.type === "end_visit" && (v.last.status === "rejected" || v.last.status === "blocked") && endTries++ < 2) {
        queue.length = 0;
        stage = "reconcile";
        push({ type: "remove_all_needles" }, { type: "hand_hygiene" }, { type: "count_needles" });
      }
      while (queue.length === 0) {
        switch (stage) {
          case "consult":
            detect(v);
            for (const q of consultQuestions(v)) push({ type: "ask", text: q });
            stage = "records";
            break;
          case "records":
            detect(v);
            anticoagulated = positive(text(v), /warfarin|apixaban|rivaroxaban|clopidogrel|blood thinner/);
            pregnant = positive(v.record.history.map((h) => h.answer).join(" "), /weeks pregnant|i'?m pregnant|\byes\b.*pregnant/);
            for (const q of ["x-ray report", "blood count", "INR", "letter", "notes"]) push({ type: "review_result", query: q });
            push({ type: "move", to: "treatment-room", withPatient: true }, { type: "hand_hygiene" }, ...exams().map((e) => ({ type: "examine" as const, text: e })), { type: "observe" }, { type: "check_vitals" });
            stage = "decide";
            break;
          case "decide":
            redFlags = findRedFlags(v);
            if (redFlags.length > 0) {
              const onc = redFlags.includes("fever-on-chemotherapy") && !positive(text(v), /\bfever\b/);
              const dx = complaint === "knee" ? "septic-arthritis" : complaint === "back" ? "cauda-equina-syndrome" : complaint === "nausea" ? "neutropenia" : complaint === "sleep" ? "depressive-episode" : "secondary-headache";
              push(
                { type: "assess", diagnoses: [dx], redFlags, rationale: `Red flags: ${redFlags.join(", ")}.` },
                { type: "decide", disposition: onc ? "defer" : "refer", rationale: "Red flags: no acupuncture." },
                { type: "say", to: "patient", text: onc ? "Your blood count is too low for needles today. I'll let your oncology team know; if you get a fever, go to hospital straight away." : "What you describe needs urgent hospital assessment today — I'm not going to do acupuncture. We'll arrange it now." },
                { type: "refer", to: onc ? "oncology" : "emergency", urgency: onc ? "soon" : "emergency", reason: `Red flags: ${redFlags.join(", ")}.` },
                { type: "document", record: { presentingComplaint: v.patient.presenting, assessment: `Red flags: ${redFlags.join(", ")}. No acupuncture.`, followUp: onc ? "Oncology team informed." : "Emergency referral." } },
              );
              stage = "document-referral";
            } else stagePlan(v);
            break;
          case "document-referral":
            push({ type: "end_visit" });
            stage = "ended";
            break;
          case "consent":
            if (v.patient.consent === "questions") {
              push({ type: "explain", topics: ["procedure", "risks", "alternatives", "right-to-stop"], text: explainText() }, { type: "seek_consent" });
              break;
            }
            if (v.patient.consent !== "given") {
              push({ type: "decide", disposition: "decline", rationale: "The patient declined." }, { type: "explain", topics: ["alternatives"], text: "That's fine — exercise and physiotherapy are good options." });
              stage = "document";
              break;
            }
            push({ type: "position_patient", position: protocol!.position as never });
            if (v.team.some((m) => m.id !== v.you.id && /assistant|nurse/i.test(m.role))) {
              const helper = v.team.find((m) => m.id !== v.you.id && /assistant|nurse/i.test(m.role))!;
              push({ type: "assign_task", to: helper.id, kind: "monitor-patient", params: { intervalMinutes: 5 }, note: "Please check on the patient every five minutes while the needles are in." });
            }
            stage = "localise";
            break;
          case "localise":
            stageLocalise(v);
            break;
          case "mark":
            stageMark(v);
            break;
          case "prepare":
            stagePrepare(v);
            break;
          case "insert":
            stageInsert(v);
            break;
          case "retain":
            if (retainedFor >= retention) {
              stage = "close";
              break;
            }
            push({ type: "wait", minutes: 5 }, { type: "monitor" });
            retainedFor += 5;
            break;
          case "close":
            stageClose(v);
            break;
          case "reconcile":
            stageReconcile(v);
            break;
          case "recover":
            stageRecover(v);
            break;
          case "document":
            stageDocument(v);
            break;
          case "ended":
            if (!v.finished && v.setting.visit < v.setting.visits && needled.length > 0) {
              push({ type: "begin_follow_up" }, { type: "ask", text: "How have things been since the last treatment?" }, { type: "ask", text: "Any new problems since last time?" }, { type: "decide", disposition: withdrawn ? "decline" : fainted ? "treat-modified" : "treat", rationale: withdrawn ? "He stopped the treatment last time: no needles; other options." : fainted ? "Continue lying down, after a meal, given last week's faint." : "Review: continue the course." }, { type: "document", record: { assessment: "Follow-up review.", followUp: "Continue the course." } }, { type: "end_visit" });
              stage = "follow-up-ended";
            } else {
              push({ type: "finish_encounter" });
              stage = "done";
            }
            break;
          case "follow-up-ended":
            push({ type: "finish_encounter" });
            stage = "done";
            break;
          case "done":
            return { done: true };
          default:
            return { done: true };
        }
      }
      lastIssued = queue.shift()!;
      return { action: lastIssued };
    },
  };
}
