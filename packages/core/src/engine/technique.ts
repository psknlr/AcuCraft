import type { Action } from "../schema/actions.js";
import type { ManipulationRecord } from "../schema/state.js";

/**
 * Needling technique (docs/TECHNIQUE.md): what the operator's hands do with a needle once the point is found — how it
 * goes in, how it is worked, how it comes out — as parameters the engine can execute, record and compare with what was
 * planned. Everything here is public: it is what a practitioner knows and does, never what the patient's tissue is.
 *
 * The numbers are a teaching simplification of textbook technique (unreviewed): they make "how much stimulation" a
 * quantity, so that the lesson of the response model holds for every technique — depth, not force.
 */

type Adjust = Extract<Action, { type: "adjust_needle" }>;
export type NeedleTechnique = Exclude<Adjust["technique"], "none">;

interface Parameter {
  unit: string;
  min: number;
  max: number;
  default: number;
  label: string;
}

interface TechniqueDefinition {
  id: NeedleTechnique;
  label: string;
  zh: string;
  kind: "basic" | "auxiliary";
  /** What it is, as done at the needle. */
  description: string;
  /** Stimulation one act gives at its default parameters. */
  dose: number;
  parameters: Partial<Record<"amplitudeMm" | "frequencyPerMin" | "arcDeg" | "durationSec", Parameter>>;
}

const duration = (dflt: number): Parameter => ({ unit: "s", min: 2, max: 120, default: dflt, label: "how long the needle is worked" });

/** The techniques the engine executes: the two basic manipulations and four auxiliary ones. */
export const TECHNIQUES: readonly TechniqueDefinition[] = [
  {
    id: "lift-thrust",
    label: "Lifting and thrusting",
    zh: "提插",
    kind: "basic",
    description: "The needle is lifted and thrust back along its own path, between the depth it stands at and a little above it. The tip never goes deeper than the depth set.",
    dose: 0.35,
    parameters: {
      amplitudeMm: { unit: "mm", min: 0.5, max: 10, default: 3, label: "excursion of the tip" },
      frequencyPerMin: { unit: "/min", min: 20, max: 240, default: 60, label: "lifts and thrusts a minute" },
      durationSec: duration(10),
    },
  },
  {
    id: "rotate",
    label: "Twirling",
    zh: "捻转",
    kind: "basic",
    description: "The handle is rolled between thumb and finger. Back and forth (direction both) is the ordinary manipulation; turned one way only, the fibres wind round the shaft.",
    dose: 0.3,
    parameters: {
      arcDeg: { unit: "°", min: 30, max: 720, default: 180, label: "arc of one twirl (one way: the whole turn)" },
      frequencyPerMin: { unit: "/min", min: 20, max: 240, default: 80, label: "twirls a minute" },
      durationSec: duration(10),
    },
  },
  { id: "scrape", label: "Scraping the handle", zh: "刮法", kind: "auxiliary", description: "A fingernail is drawn up or down the handle while the needle is steadied: a fine vibration to hasten or spread the response.", dose: 0.1, parameters: { durationSec: duration(10) } },
  { id: "flick", label: "Flicking the handle", zh: "弹法", kind: "auxiliary", description: "The handle is flicked lightly so that the shaft quivers.", dose: 0.08, parameters: {} },
  { id: "shake", label: "Shaking the needle", zh: "摇法", kind: "auxiliary", description: "The needle is rocked gently about its entry.", dose: 0.15, parameters: { durationSec: duration(10) } },
  { id: "tremble", label: "Trembling", zh: "震颤法", kind: "auxiliary", description: "Tiny, quick lifts and thrusts: the needle trembles in place.", dose: 0.2, parameters: { durationSec: duration(10) } },
];

const BY_ID = new Map(TECHNIQUES.map((t) => [t.id, t]));

/** How the needle is put through the skin. Recorded with the insertion; `tube` and a swift hand spare the patient the prick. */
export const INSERTION_METHOD_NOTES: Record<Extract<Action, { type: "insert_needle" }>["method"], { label: string; zh: string; use: string }> = {
  "single-hand": { label: "Single-handed insertion", zh: "单手进针", use: "short needles; thumb and index hold the handle, the middle finger steadies the tip at the point" },
  "fingernail-press": { label: "Fingernail-pressing insertion", zh: "指切进针", use: "short needles: the nail of the pressing hand marks and fixes the point" },
  pinching: { label: "Pinching (holding) insertion", zh: "夹持进针", use: "long needles: the pressing hand holds the shaft near its tip with a sterile swab" },
  stretching: { label: "Skin-stretching insertion", zh: "舒张进针", use: "loose skin (the abdomen): the skin is stretched flat between two fingers" },
  "pinch-up": { label: "Pinching-up insertion", zh: "提捏进针", use: "thin tissue over bone (the face): the skin is lifted into a fold and the needle goes into the fold" },
  tube: { label: "Guide-tube insertion", zh: "管针进针", use: "the needle is tapped through the skin from a tube: quick, with little sensation" },
};

/** The angle of a needle to the skin, as textbooks name it. `angleDeg` in an action is measured from the perpendicular. */
export const ANGLE_CLASSES = [
  { id: "perpendicular", label: "Perpendicular", zh: "直刺", fromPerpendicular: [0, 30], use: "most points, where the tissue is thick" },
  { id: "oblique", label: "Oblique", zh: "斜刺", fromPerpendicular: [30, 65], use: "thin tissue, or over organs that must not be reached" },
  { id: "transverse", label: "Transverse", zh: "平刺", fromPerpendicular: [65, 90], use: "very thin tissue: the head and face, over the sternum" },
] as const;

export const angleClass = (angleDeg: number) => ANGLE_CLASSES.find((c) => angleDeg <= c.fromPerpendicular[1])!;

/** One-way twirling winds the tissue round the shaft: at a full turn the needle is stuck; under half a turn it is free again. */
export const STUCK_AT_DEG = 360;
export const RELEASED_BELOW_DEG = 180;
/** How much winding an auxiliary technique lets go of on a stuck needle (the tissue round it loosens). */
export const LOOSENED_BY_DEG = 90;

export type Manipulation = Omit<ManipulationRecord, "at" | "by" | "dose" | "character" | "depthCm" | "evidence">;

/** The manipulation an `adjust_needle` asks for, with the technique's defaults filled in (null: none — a move only). */
export function manipulationOf(a: Adjust): Manipulation | null {
  if (a.technique === "none") return null;
  const def = BY_ID.get(a.technique)!;
  const p = def.parameters;
  const oneWay = a.technique === "rotate" && a.direction !== "both";
  return {
    technique: a.technique,
    ...(p.amplitudeMm ? { amplitudeMm: a.amplitudeMm ?? p.amplitudeMm.default } : {}),
    ...(p.frequencyPerMin && !oneWay ? { frequencyPerMin: a.frequencyPerMin ?? p.frequencyPerMin.default } : {}),
    ...(p.arcDeg ? { arcDeg: a.arcDeg ?? p.arcDeg.default } : {}),
    durationSec: oneWay ? 5 : (a.durationSec ?? p.durationSec?.default ?? 5),
    ...(a.technique === "rotate" ? { direction: a.direction } : {}),
    ...(a.technique === "lift-thrust" ? { emphasis: a.emphasis } : {}),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The stimulation one manipulation gives: the technique's dose at its default parameters, scaled by the square root
 * of each parameter's ratio to its default (twice the amplitude is not twice the stimulus), at most 1 an act.
 */
export function stimulusDose(m: Manipulation): number {
  const def = BY_ID.get(m.technique)!;
  const p = def.parameters;
  const ratio = (value: number | undefined, param: Parameter | undefined) => (value !== undefined && param ? Math.sqrt(value / param.default) : 1);
  const oneWay = m.technique === "rotate" && m.direction !== undefined && m.direction !== "both";
  const dose = def.dose * ratio(m.amplitudeMm, p.amplitudeMm) * ratio(m.arcDeg, p.arcDeg) * (oneWay ? 1 : ratio(m.frequencyPerMin, p.frequencyPerMin) * ratio(m.durationSec, p.durationSec));
  return round3(Math.min(1, dose));
}

/** Degrees of winding a manipulation adds (signed: clockwise positive): only twirling one way winds. */
export function windingOf(m: Manipulation): number {
  if (m.technique !== "rotate" || m.direction === undefined || m.direction === "both") return 0;
  return (m.direction === "clockwise" ? 1 : -1) * (m.arcDeg ?? 0);
}

/** Simulated minutes a manipulation takes: the time it is worked, and taking hold of the needle. */
export const manipulationMinutes = (m: Manipulation): number => Math.round(((20 + m.durationSec) / 60) * 100) / 100;

/**
 * Reinforcing, reducing or even — read from how the needle was worked, by the textbook contrasts: small, slow, short
 * and forceful on the thrust reinforces; large, fast, long and forceful on the lift reduces. Two contrasts one way
 * (the forceful phase counts for two) make the character; anything else is even. Auxiliary techniques have none.
 */
export function manipulationCharacter(m: Manipulation): ManipulationRecord["character"] {
  if (m.technique !== "lift-thrust" && m.technique !== "rotate") return null;
  let reinforcing = 0;
  const vote = (value: number | undefined, small: number, large: number) => {
    if (value === undefined) return;
    if (value < small) reinforcing += 1;
    else if (value > large) reinforcing -= 1;
  };
  if (m.technique === "lift-thrust") {
    vote(m.amplitudeMm, 2.5, 4.5);
    vote(m.frequencyPerMin, 50, 100);
    if (m.emphasis === "thrust") reinforcing += 2;
    else if (m.emphasis === "lift") reinforcing -= 2;
  } else {
    vote(m.arcDeg, 150, 270);
    vote(m.frequencyPerMin, 60, 120);
  }
  vote(m.durationSec, 6, 30);
  return reinforcing >= 2 ? "reinforcing" : reinforcing <= -2 ? "reducing" : "even";
}

/** What the fingers on the handle feel of the tissue the tip lies in. Words for touch, not for anatomy. */
const FEEL: Record<string, string> = {
  skin: "the skin's own resistance",
  subcutaneous: "loose tissue",
  "fat-pad": "soft, yielding tissue",
  fascia: "a firm layer",
  muscle: "springy tissue",
  tendon: "tough, cord-like tissue",
  ligament: "tough, dense tissue",
  periosteum: "something hard",
  bone: "something hard",
  "joint-space": "a sudden give, then emptiness",
  pleura: "a sudden give, then emptiness",
  lung: "emptiness",
  organ: "a soft give",
  beyond: "nothing it can name",
};

export const tipFeel = (tissue: string): string => FEEL[tissue] ?? "tissue";

/** What the operator feels as the needle goes to its depth: the tissues passed, in order, and where the tip lies now. */
export function feelOfPath(traversed: readonly string[], tipTissue: string): string {
  const passed: string[] = [];
  for (const t of traversed) {
    const f = tipFeel(t);
    if (t !== "skin" && passed[passed.length - 1] !== f) passed.push(f);
  }
  const tip = tipFeel(tipTissue);
  const before = passed.filter((f) => f !== tip);
  return `${before.length > 0 ? `through ${before.join(", then ")}; ` : ""}the tip lies in ${tip}`;
}

/** How a manipulation reads in a record: "lifting and thrusting, 3 mm, 60/min, 10 s (even)". */
export function describeManipulation(m: Manipulation & { character?: ManipulationRecord["character"] }): string {
  const def = BY_ID.get(m.technique)!;
  const parts = [
    m.amplitudeMm !== undefined ? `${m.amplitudeMm} mm` : null,
    m.arcDeg !== undefined ? `${m.arcDeg}°${m.direction && m.direction !== "both" ? ` ${m.direction}` : ""}` : null,
    m.frequencyPerMin !== undefined ? `${m.frequencyPerMin}/min` : null,
    m.technique !== "flick" ? `${m.durationSec} s` : null,
    m.emphasis && m.emphasis !== "even" ? `forceful on the ${m.emphasis}` : null,
  ].filter(Boolean);
  return `${def.label.toLowerCase()}${parts.length ? `, ${parts.join(", ")}` : ""}${m.character ? ` (${m.character})` : ""}`;
}

/** The technique catalogue as reference knowledge (the library's `techniques`): what can be done, and how it is read. */
export function techniqueCatalogue() {
  return {
    insertion: {
      methods: Object.entries(INSERTION_METHOD_NOTES).map(([id, m]) => ({ id, ...m })),
      speed: { swift: "through the skin in one quick movement: little or no prick", slow: "slowly through the skin: the patient feels the prick unless a guide tube is used" },
      angles: ANGLE_CLASSES.map((c) => ({ ...c, angleDeg: `${c.fromPerpendicular[0]}–${c.fromPerpendicular[1]} (measured from the perpendicular)` })),
      note: "angleDeg 0 is perpendicular to the skin; azimuthDeg is the direction the tip travels across the chart (0 cranial, 90 towards +u). depthCm is along the shaft. As the needle goes in the fingers feel the tissue: the result says what was passed and where the tip lies.",
    },
    manipulation: {
      techniques: TECHNIQUES.map((t) => ({ id: t.id, label: t.label, zh: t.zh, kind: t.kind, description: t.description, parameters: t.parameters })),
      stimulation: "Each manipulation adds to the stimulation a needle has had; the tissue's response grows with it up to a point and no further, and past what the patient tolerates it only hurts. A tip that lies too shallow is not helped by working the needle harder. Auxiliary techniques add a little: they hasten a response that is nearly there.",
      character: "How a basic manipulation was done is read as reinforcing (补), reducing (泻) or even (平补平泻): small, slow, short, forceful on the thrust reinforces; large, fast, long, forceful on the lift reduces; two such contrasts one way make the character. What is done is compared with the stimulation the plan states.",
      stuck: `Twirling one way winds the tissue round the shaft: at ${STUCK_AT_DEG}° the needle is stuck (滞针) — it hurts, will not move, and must not be pulled. Turn it back the other way (below ${RELEASED_BELOW_DEG}° it is free), or loosen the tissue round it by flicking or scraping the handle.`,
    },
    withdrawal: {
      speed: { quick: "withdrawn in one movement", slow: "withdrawn slowly, in stages" },
      press: "pressing the hole with a dry swab as the needle leaves stops a site that bleeds",
    },
    review: "unreviewed: a teaching simplification of textbook technique",
  };
}
