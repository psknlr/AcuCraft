import type { TaskKind } from "../schema/actions.js";

/**
 * Deterministic readings of free speech (English): a stated commitment creates a responsibility (proposal §7.1), a
 * claim of completion is checked against the state but changes nothing (§13), and explanation topics are credited
 * from what was said. Conservative by design: an utterance that is not clearly one of these is just speech.
 */

const COMMITMENTS: [RegExp, TaskKind][] = [
  [/\b(monitor|watch|keep an eye on|observe|stay with|check on)\b/, "monitor-patient"],
  [/\b(count|tally)\b.*\bneedles?\b|\bneedle count\b/, "count-needles"],
  [/\b(dispose|sharps)\b/, "dispose-sharps"],
  [/\b(blood pressure|pulse|vitals|vital signs)\b/, "record-vitals"],
  [/\b(lie|lay|position)\b.*\b(down|flat|supine|prone|on (your|his|her|their) (back|front|side))\b/, "position-patient"],
];

const COMMIT_LEAD = /\b(i'?ll|i will|i am going to|i'm going to|let me|i can)\b/;

export function detectCommitment(text: string): TaskKind | null {
  // the commitment is what follows "I'll / I will / let me …" in the same sentence
  for (const sentence of text.toLowerCase().split(/[.;!?\n]+/)) {
    const at = sentence.search(COMMIT_LEAD);
    if (at < 0) continue;
    const rest = sentence.slice(at);
    if (/\b(not|n't|won't|never)\b/.test(rest)) continue;
    for (const [re, kind] of COMMITMENTS) if (re.test(rest)) return kind;
  }
  return null;
}

export const CLAIMS = ["all-needles-removed", "count-correct", "needles-disposed", "consent-obtained", "site-prepared", "hands-clean", "deqi-obtained"] as const;
export type Claim = (typeof CLAIMS)[number];

const CLAIM_PATTERNS: [RegExp, Claim][] = [
  [/\ball (of )?(the )?needles (are |have been |were )?(out|removed|withdrawn|taken out)\b|\b(removed|withdrawn|taken out) all (of )?(the )?needles\b|\bno needles (are )?(left|remaining|retained)\b/, "all-needles-removed"],
  [/\b(needle )?count (is |was )?(correct|complete|reconciled|right|matches)\b|\ball (the )?needles (are )?accounted for\b/, "count-correct"],
  [/\b(needles|sharps) (are |have been |were )?(all )?disposed\b|\bdisposed (of )?(all )?(the )?(needles|sharps)\b/, "needles-disposed"],
  [/\bconsent (has been |was |is )?(obtained|given|signed)\b|\b(she|he|they|the patient) (has |have )?(consented|agreed to (the )?(treatment|acupuncture))\b/, "consent-obtained"],
  [/\b(skin|site|sites) (is |are |has been |have been )?(cleaned|prepared|swabbed|disinfected)\b/, "site-prepared"],
  [/\b(i('ve| have)|hands (are|have been)) (washed|cleaned|sanitised|sanitized)\b|\bhands are clean\b/, "hands-clean"],
];

/**
 * A claim that qi arrived — "deqi obtained at ST36", "got a clear de-qi", "得气" — read clause by clause, and only where
 * it is a report: what is planned, sought or conditional ("I will look for deqi", "when deqi is reached you will
 * feel …", "until deqi is obtained") is not, nor is its denial ("no deqi", "deqi not obtained", "deqi at 0 of 5").
 */
const DEQI_SAID = /\bde[ -]?qi (was |has been |is |were )?(obtained|achieved|elicited|felt|reached|arrived|present)\b|\b(obtained|achieved|elicited|got|felt) (a |an |the |good |strong |mild |clear |some )*de[ -]?qi\b|\bde[ -]?qi at\b|\bwith de[ -]?qi\b|得气/;
const DEQI_INTENT = /\b(will|would|shall|going to|until|when|whenever|if|once|unless|aim\w*|seek\w*|sought|look(ing)? for|try(ing)?|may|might|should|can|could|before|expect\w*|hop(e|es|ed|ing)|want\w*|plan\w*)\b/;
const DEQI_DENIED = /\b(no|not|without|never|none|nil|absent|didn'?t|wasn'?t|isn'?t|hasn'?t|couldn'?t)\b[^,]*\bde[ -]?qi\b|\bde[ -]?qi (was |is |has been |were )?(not|never|absent|none|nil)\b|\bde[ -]?qi at (0|no|none|zero)\b|未得气|不得气|没有得气/;

function claimsDeqi(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[.;!?\n]+|,\s*(?:but|and|though|while)\s+/)
    .some((clause) => DEQI_SAID.test(clause) && !DEQI_INTENT.test(clause) && !DEQI_DENIED.test(clause));
}

export function detectClaims(text: string): Claim[] {
  const t = text.toLowerCase();
  if (/\?\s*$/.test(t)) return []; // a question is not a claim
  const claims = CLAIM_PATTERNS.filter(([re]) => re.test(t)).map(([, c]) => c);
  if (claimsDeqi(text)) claims.push("deqi-obtained");
  return claims;
}

const TOPICS: [RegExp, string][] = [
  [/\b(needle|needles|insert|acupuncture points?|points|minutes|lie still|thin)\b/, "procedure"],
  [/\b(help|benefit|relieve|improve|aim|goal)\b/, "benefits"],
  [/\b(risk|risks|bruis\w*|bleed\w*|sore|soreness|faint\w*|dizz\w*|infection|side effects?|pneumothorax|rare)\b/, "risks"],
  [/\b(alternative|alternatives|instead|other options?|physiotherap\w*|exercise|medication|painkillers?|analgesi\w*)\b/, "alternatives"],
  [/\b(evidence|studies|research|guideline|guidelines|nice|trials?)\b/, "evidence"],
  [/\b(afterwards|after the treatment|aftercare|rest|drink water|avoid strenuous)\b/, "aftercare"],
  [/\b(stop at any time|tell me if|let me know if|you can stop|you can say stop|withdraw)\b/, "right-to-stop"],
];

export function detectTopics(text: string): string[] {
  const t = text.toLowerCase();
  return TOPICS.filter(([re]) => re.test(t)).map(([, topic]) => topic);
}

/** Count of questions in an utterance (the consultation asks one or two at a time). */
export const questionCount = (text: string): number => (text.match(/\?/g) ?? []).length;
