import {
  MANIPULATION_TECHNIQUE_IDS, type ManipulationTechniqueId, type ManipulationMotionSettings,
  type ResolvedManipulationMotion,
} from "../schema/manipulation.js";

export type ManipulationContext = "skin" | "retained" | "removed";
export type ManipulationFamily = "contact" | "axial" | "rotation" | "orientation" | "handle" | "modulation" | "compound" | "bu-xie";
export type ManipulationControl = keyof ResolvedManipulationMotion;
export interface ManipulationPhase {
  id: string;
  label: string;
  primitive: ManipulationTechniqueId;
  weight: number;
}
export interface ManipulationTechnique {
  id: ManipulationTechniqueId;
  zh: string;
  label: string;
  family: ManipulationFamily;
  context: ManipulationContext;
  needsNeedle: boolean;
  description: string;
  evidence: "illustrative";
  primitives: ManipulationTechniqueId[];
  phases: ManipulationPhase[];
  controls: ManipulationControl[];
  defaults: ResolvedManipulationMotion;
  source: { id: "acucraft-authored-demonstration-v1"; review: "unreviewed"; note: string };
}

export const MANIPULATION_CATALOGUE_VERSION = "acucraft/manipulation-catalogue@1" as const;
const BASE: ResolvedManipulationMotion = {
  durationMs: 2400, cycles: 3, strokeMm: 1.5, rotationDeg: 90, lateralMm: 2, tiltDeg: 3,
  tempoBias: 0.5, direction: "alternating", grip: "two-finger", support: "stabilize", hand: "auto",
  gripApertureMm: 2, contactIntensity: 0.45,
};
const COMMON: ManipulationControl[] = ["durationMs", "cycles", "hand", "grip", "support", "gripApertureMm", "contactIntensity"];
const CONTROLS: Record<ManipulationFamily, ManipulationControl[]> = {
  contact: [...COMMON, "lateralMm", "tempoBias"],
  axial: [...COMMON, "strokeMm", "tempoBias"],
  rotation: [...COMMON, "rotationDeg", "direction", "tempoBias"],
  orientation: [...COMMON, "lateralMm", "tiltDeg", "direction", "tempoBias"],
  handle: [...COMMON, "lateralMm", "rotationDeg", "tiltDeg", "tempoBias"],
  modulation: [...COMMON, "strokeMm", "lateralMm", "tiltDeg", "tempoBias"],
  compound: [...COMMON, "strokeMm", "rotationDeg", "lateralMm", "tiltDeg", "direction", "tempoBias"],
  "bu-xie": [...COMMON, "strokeMm", "rotationDeg", "direction", "tempoBias"],
};
const SOURCE = {
  id: "acucraft-authored-demonstration-v1" as const,
  review: "unreviewed" as const,
  note: "Authored kinematic demonstration. Technique names organize the revised working vocabulary; motion and compound sequences are not a verified reproduction of GB/T definitions or clinical dosing.",
};

type Entry = [id: ManipulationTechniqueId, zh: string, label: string, family: ManipulationFamily, context: ManipulationContext, description: string, defaults?: Partial<ResolvedManipulationMotion>];
const ENTRIES: Entry[] = [
  ["chuai", "揣", "Chuai · palpation", "contact", "skin", "Fingertip contact and a small palpation path; illustrative contact, without measured pressure.", { support: "none" }],
  ["zhua", "爪", "Zhua · nail contact", "contact", "skin", "Localized nail contact with a stabilized finger. Contact intensity is a visual fraction, not force.", { lateralMm: 0.5, support: "none" }],
  ["xun", "循", "Xun · tracing", "contact", "skin", "Sequential surface contact along the chart's longitudinal direction. Procedural timing is variant-dependent.", { support: "none", lateralMm: 4 }],
  ["she", "摄", "She · contact variant", "contact", "skin", "An illustrative nail-contact and pinch pattern. The source-dependent traditional definition remains unverified.", { support: "pinch", lateralMm: 1 }],
  ["yao", "摇", "Yao · oscillation", "orientation", "retained", "Lateral handle oscillation. Deflection affects only the visible external shaft; the approved internal path stays fixed."],
  ["pan", "盘", "Pan · circular motion", "orientation", "retained", "A circumferential handle trajectory about the fixed skin entry, without redirecting the internal needle tip."],
  ["nian", "捻", "Nian · twirling", "rotation", "retained", "Thumb-index rolling and alternating rotation about the needle's longitudinal axis."],
  ["cuo", "搓", "Cuo · rolling", "rotation", "retained", "Rolling contact with a direction choice. This authored variant is distinct from a universal traditional prescription.", { direction: "clockwise" }],
  ["jin", "进", "Jin · advancing gesture", "axial", "retained", "An advance-led visual stroke that returns to the approved depth. Actual depth changes require adjust_needle.", { tempoBias: 0.72 }],
  ["tui-withdraw", "退", "Tui · withdrawing gesture", "axial", "retained", "A withdrawal-led visual stroke followed by return to the approved depth. Complete removal remains remove_needle.", { tempoBias: 0.28 }],
  ["ti", "提", "Ti · lifting", "axial", "retained", "Outward axial phase followed by a controlled return, with finger stabilization and wrist participation.", { tempoBias: 0.3 }],
  ["cha", "插", "Cha · thrusting", "axial", "retained", "A return-led axial cycle bounded by the engine-approved insertion depth.", { tempoBias: 0.7 }],
  ["gua", "刮", "Gua · scraping", "handle", "retained", "Sliding nail contact along the external handle while the other digits stabilize it.", { grip: "three-finger", support: "none" }],
  ["tan", "弹", "Tan · flicking", "handle", "retained", "Brief finger contact and release followed by damped external-shaft motion; no force impulse is inferred.", { grip: "three-finger", lateralMm: 1.2, support: "none" }],
  ["fei", "飞", "Fei · pinch and release", "handle", "retained", "Intermittent thumb-index engagement with a stabilizing third finger; an authored contact-state sequence.", { grip: "three-finger", support: "none" }],
  ["mo", "摩", "Mo · rubbing", "handle", "retained", "Fine rubbing contact along the handle with limited external movement.", { lateralMm: 0.6, rotationDeg: 25 }],
  ["dong", "动", "Dong · mobilization", "modulation", "retained", "Small source-sensitive mobilization. The name alone does not specify an obligatory direction.", { strokeMm: 0.6, lateralMm: 0.5 }],
  ["tui-push", "推", "Tui · pushing gesture", "modulation", "retained", "An illustrative loading/contact pattern with no deeper tip travel and no prescribed force.", { strokeMm: 0.6, lateralMm: 0.5, tempoBias: 0.7 }],
  ["chan", "颤", "Chan · trembling", "modulation", "retained", "Small-amplitude, repeated external movement with distinct oscillatory timing.", { cycles: 8, strokeMm: 0.3, lateralMm: 0.4, tiltDeg: 1 }],
  ["nu", "弩", "Nu · shaft deflection", "modulation", "retained", "Illustrative deflection of the exposed shaft. Internal-tip movement and tissue shear are not simulated.", { grip: "three-finger", strokeMm: 0, lateralMm: 2.5, tiltDeg: 4 }],
  ["an", "按", "An · pressing", "contact", "skin", "Supporting contact at the selected surface site. Visual intensity is not a measured pressure.", { support: "press", lateralMm: 0 }],
  ["men", "扪", "Men · covering and compression", "contact", "removed", "Site covering/compression after withdrawal, anchored to a removed needle's recorded entry.", { support: "press", lateralMm: 0 }],
  ["sou", "搜", "Sou · direction pattern", "orientation", "retained", "A source-sensitive external direction-changing pattern. The internal path remains fixed rather than searching through tissue.", { lateralMm: 1.5, tiltDeg: 2 }],
  ["bo", "拨", "Bo · lateral manipulation", "orientation", "retained", "An illustrative lateral handle/shaft pattern; it is not automatically assigned to supporting-hand tissue displacement.", { lateralMm: 2, tiltDeg: 2 }],
  ["shao-shan-huo", "烧山火", "Shao Shan Huo", "compound", "retained", "Authored staged axial-and-rotational demonstration; not a canonical treatment sequence.", { durationMs: 7200, tempoBias: 0.7 }],
  ["tou-tian-liang", "透天凉", "Tou Tian Liang", "compound", "retained", "Authored staged withdrawal-and-rotation demonstration; no temperature or therapeutic effect is implied.", { durationMs: 7200, tempoBias: 0.3 }],
  ["qing-long-bai-wei", "青龙摆尾", "Qing Long Bai Wei", "compound", "retained", "An authored orientation sequence using alternating exposed-shaft oscillation and settling.", { durationMs: 5400 }],
  ["bai-hu-yao-tou", "白虎摇头", "Bai Hu Yao Tou", "compound", "retained", "An authored combination of external oscillation, outward travel, and small trembling.", { durationMs: 6000 }],
  ["cang-gui-tan-xue", "苍龟探穴", "Cang Gui Tan Xue", "compound", "retained", "An illustrative staged trajectory; apparent directional changes never redirect the internal tip.", { durationMs: 7200 }],
  ["chi-feng-ying-yuan", "赤凤迎源", "Chi Feng Ying Yuan", "compound", "retained", "An authored axial, rolling, and contact-transition sequence.", { durationMs: 7200, grip: "three-finger" }],
  ["long-hu-jiao-zhan", "龙虎交战", "Long Hu Jiao Zhan", "compound", "retained", "An authored alternation of rotational motifs with explicit phase transitions.", { durationMs: 6000 }],
  ["zi-wu-dao-jiu", "子午捣臼", "Zi Wu Dao Jiu", "compound", "retained", "An authored alternation of bounded axial and rotational primitives.", { durationMs: 6000 }],
  ["yang-zhong-yin-yin", "阳中隐阴", "Yang Zhong Yin Yin", "compound", "retained", "An authored bu-then-xie phase sequence. Traditional designation and simulated mechanics remain separate.", { durationMs: 6400 }],
  ["yin-zhong-yin-yang", "阴中隐阳", "Yin Zhong Yin Yang", "compound", "retained", "An authored xie-then-bu phase sequence, without a physiological efficacy model.", { durationMs: 6400 }],
  ["bu", "补", "Bu · tonification gesture", "bu-xie", "retained", "A source-labelled illustrative axial/rotational timing pattern, not a universal clinical dose.", { tempoBias: 0.7 }],
  ["xie", "泻", "Xie · reducing gesture", "bu-xie", "retained", "An illustrative timing counterpart to bu. Playback differences do not establish clinical effects.", { tempoBias: 0.3 }],
];
const RECIPES: Partial<Record<ManipulationTechniqueId, [primitive: ManipulationTechniqueId, label: string, weight?: number][]>> = {
  "shao-shan-huo": [["cha", "Axial stage A"], ["cha", "Axial stage B"], ["nian", "Rotational stage"], ["bu", "Combined settle"]],
  "tou-tian-liang": [["ti", "Outward stage A"], ["ti", "Outward stage B"], ["nian", "Rotational stage"], ["xie", "Combined settle"]],
  "qing-long-bai-wei": [["yao", "Oscillate"], ["pan", "Sweep"], ["yao", "Return"]],
  "bai-hu-yao-tou": [["yao", "Oscillate"], ["ti", "Outward cycle"], ["chan", "Tremble"]],
  "cang-gui-tan-xue": [["jin", "Axial stage"], ["sou", "External direction pattern"], ["tui-withdraw", "Outward stage"]],
  "chi-feng-ying-yuan": [["cha", "Axial stage"], ["nian", "Rotation"], ["fei", "Contact transition"]],
  "long-hu-jiao-zhan": [["nian", "Alternating rotation"], ["cuo", "Rolling"], ["nian", "Return rotation"]],
  "zi-wu-dao-jiu": [["ti", "Outward cycle"], ["nian", "Rotation"], ["cha", "Return cycle"], ["nian", "Rotation"]],
  "yang-zhong-yin-yin": [["bu", "Bu phase"], ["xie", "Xie phase"]],
  "yin-zhong-yin-yang": [["xie", "Xie phase"], ["bu", "Bu phase"]],
};

/** Working vocabulary and authored choreography; deliberately not labelled clinically validated. */
export const MANIPULATION_TECHNIQUES: readonly ManipulationTechnique[] = ENTRIES.map(([id, zh, label, family, context, description, defaults]) => {
  const phases = (RECIPES[id] ?? [[id, label]]).map(([primitive, name, weight], index) => ({ id: `${id}:${index + 1}`, label: name, primitive, weight: weight ?? 1 }));
  return {
    id, zh, label, family, context, needsNeedle: context !== "skin", description, evidence: "illustrative",
    primitives: phases.map((p) => p.primitive), phases, controls: CONTROLS[family], defaults: { ...BASE, ...defaults }, source: SOURCE,
  };
});
const BY_ID = new Map(MANIPULATION_TECHNIQUES.map((t) => [t.id, t]));
export function manipulationTechnique(id: string): ManipulationTechnique | null {
  return BY_ID.get(id as ManipulationTechniqueId) ?? null;
}

const finite = (v: number | undefined, fallback: number, lo: number, hi: number): number => v === undefined || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, v));
const enumValue = <T extends string>(v: T | undefined, allowed: readonly T[], fallback: T): T => v !== undefined && allowed.includes(v) ? v : fallback;
/** Defensive resolution also protects direct previews, which do not necessarily pass through an action parser. */
export function resolveManipulationMotion(id: ManipulationTechniqueId, settings: ManipulationMotionSettings = {}): ResolvedManipulationMotion {
  const base = manipulationTechnique(id)?.defaults ?? BASE;
  return {
    durationMs: Math.round(finite(settings.durationMs, base.durationMs, 400, 30_000)),
    cycles: Math.round(finite(settings.cycles, base.cycles, 1, 12)),
    strokeMm: finite(settings.strokeMm, base.strokeMm, 0, 3),
    rotationDeg: finite(settings.rotationDeg, base.rotationDeg, 0, 180),
    lateralMm: finite(settings.lateralMm, base.lateralMm, 0, 4),
    tiltDeg: finite(settings.tiltDeg, base.tiltDeg, 0, 8),
    tempoBias: finite(settings.tempoBias, base.tempoBias, 0.2, 0.8),
    direction: enumValue(settings.direction, ["alternating", "clockwise", "counterclockwise"], base.direction),
    grip: enumValue(settings.grip, ["two-finger", "three-finger"], base.grip),
    support: enumValue(settings.support, ["none", "stabilize", "stretch", "pinch", "press"], base.support),
    hand: enumValue(settings.hand, ["auto", "left", "right"], base.hand),
    gripApertureMm: finite(settings.gripApertureMm, base.gripApertureMm, 0, 12),
    contactIntensity: finite(settings.contactIntensity, base.contactIntensity, 0, 1),
  };
}

export interface TechniqueMotionSample {
  /** OUTWARD only; a renderer must additionally clamp this to retained depth. */
  withdrawalMm: number;
  rotationRad: number;
  /** External handle/shaft presentation only. Never apply these to the entry or internal needle tip. */
  lateralMm: { u: number; v: number };
  tiltRad: { u: number; v: number };
  grip: number;
  contact: "none" | "skin" | "handle" | "nail-handle";
  nailContact: number;
  supportContact: number;
  handPose: "pinch" | "tripod" | "palpate" | "press" | "stretch" | "scrape" | "flick" | "release";
  phase: { index: number; id: string; label: string; primitive: ManipulationTechniqueId; progress: number };
  complete: boolean;
  durationMs: number;
}
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * t * (t * (t * 6 - 15) + 10); };
const pulse = (t: number, split: number) => t < split ? smooth(t / split) : 1 - smooth((t - split) / (1 - split));
const rad = (deg: number) => deg * Math.PI / 180;

/**
 * Pure, deterministic presentation sampler. Return values contain no clinical force estimate, tissue reaction,
 * or permission to move a tip. All movement returns to the resting pose at phase and performance boundaries.
 */
export function sampleTechnique(id: ManipulationTechniqueId, elapsedMs: number, settings?: ManipulationMotionSettings): TechniqueMotionSample {
  const entry = manipulationTechnique(id) ?? MANIPULATION_TECHNIQUES[0]!;
  const motion = resolveManipulationMotion(id, settings);
  const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs);
  const progress = clamp(elapsed / motion.durationMs);
  const complete = elapsed >= motion.durationMs;
  const totalWeight = entry.phases.reduce((sum, p) => sum + p.weight, 0);
  let index = entry.phases.length - 1, start = 0, span = 1;
  for (let i = 0, edge = 0; i < entry.phases.length; i++) {
    const width = entry.phases[i]!.weight / totalWeight;
    if (progress < edge + width || i === entry.phases.length - 1) { index = i; start = edge; span = width; break; }
    edge += width;
  }
  const phase = entry.phases[index]!;
  const local = clamp((progress - start) / span);
  const primitive = phase.primitive;
  const out: TechniqueMotionSample = {
    withdrawalMm: 0, rotationRad: 0, lateralMm: { u: 0, v: 0 }, tiltRad: { u: 0, v: 0 },
    grip: 0, contact: "none", nailContact: 0, supportContact: 0, handPose: "release",
    phase: { index, id: phase.id, label: phase.label, primitive, progress: local }, complete, durationMs: motion.durationMs,
  };
  if (complete || elapsed === 0 || !Number.isFinite(progress)) return out;
  const cycles = motion.cycles;
  const cycle = (local * cycles) % 1;
  // Edges bring each primitive to rest at compound phase transitions.
  const phaseEnvelope = smooth(Math.min(1, local * 10)) * smooth(Math.min(1, (1 - local) * 10));
  const gripEnvelope = smooth(Math.min(1, progress * 12)) * smooth(Math.min(1, (1 - progress) * 12));
  let bias = motion.tempoBias;
  if (entry.family === "compound" && (primitive === "bu" || primitive === "xie" || primitive === "ti" || primitive === "cha")) bias = primitive === "bu" || primitive === "cha" ? Math.max(0.55, bias) : Math.min(0.45, bias);
  const rhythmicPhase = cycle < bias ? smooth(cycle / bias) * 0.5 : 0.5 + smooth((cycle - bias) / (1 - bias)) * 0.5;
  const wave = Math.sin(rhythmicPhase * Math.PI * 2);
  const envelope = Math.sin(Math.PI * rhythmicPhase) ** 2;
  const axialPulse = pulse(cycle, bias) * phaseEnvelope;
  const swing = wave * envelope * phaseEnvelope;
  const rotation = motion.direction === "alternating" ? swing : envelope * phaseEnvelope * (motion.direction === "clockwise" ? 1 : -1);
  out.grip = gripEnvelope;
  out.contact = entry.context === "skin" || entry.context === "removed" ? "skin" : "handle";
  out.handPose = motion.grip === "three-finger" ? "tripod" : "pinch";
  out.supportContact = motion.support === "none" ? 0 : gripEnvelope;

  switch (primitive) {
    case "chuai":
      out.handPose = "palpate";
      out.lateralMm.u = motion.lateralMm * swing;
      out.lateralMm.v = motion.lateralMm * 0.4 * envelope * phaseEnvelope;
      break;
    case "zhua": case "she":
      out.handPose = primitive === "she" ? "pinch" : "press";
      out.nailContact = axialPulse * motion.contactIntensity;
      out.lateralMm.v = primitive === "she" ? motion.lateralMm * swing : 0;
      break;
    case "xun":
      out.handPose = "palpate";
      out.lateralMm.v = motion.lateralMm * swing;
      break;
    case "an": case "men":
      out.handPose = "press";
      out.supportContact = gripEnvelope * motion.contactIntensity;
      break;
    case "jin": case "tui-withdraw": case "ti": case "cha":
      out.withdrawalMm = motion.strokeMm * axialPulse;
      break;
    case "nian": case "cuo":
      out.rotationRad = rad(motion.rotationDeg) * (primitive === "cuo" && motion.direction === "alternating" ? envelope * phaseEnvelope : rotation);
      break;
    case "yao":
      out.lateralMm.u = motion.lateralMm * swing;
      out.tiltRad.u = rad(motion.tiltDeg) * swing;
      break;
    case "pan": {
      const direction = motion.direction === "counterclockwise" ? -1 : 1;
      out.lateralMm.u = motion.lateralMm * Math.cos(cycle * Math.PI * 2) * envelope * phaseEnvelope;
      out.lateralMm.v = motion.lateralMm * Math.sin(cycle * Math.PI * 2) * envelope * phaseEnvelope * direction;
      out.tiltRad.u = rad(motion.tiltDeg) * Math.cos(cycle * Math.PI * 2) * envelope * phaseEnvelope;
      out.tiltRad.v = rad(motion.tiltDeg) * Math.sin(cycle * Math.PI * 2) * envelope * phaseEnvelope * direction;
      break;
    }
    case "gua":
      out.contact = "nail-handle";
      out.handPose = "scrape";
      out.nailContact = envelope * phaseEnvelope;
      out.lateralMm.v = motion.lateralMm * swing;
      break;
    case "tan": {
      const t = clamp((cycle - 0.28) / 0.72);
      const impulse = cycle < 0.28 ? 0 : Math.sin(t * Math.PI * 8) * Math.exp(-5 * t) * Math.sin(Math.PI * t);
      out.contact = "nail-handle";
      out.handPose = "flick";
      out.nailContact = cycle < 0.28 ? smooth(cycle / 0.28) * phaseEnvelope : 0;
      out.lateralMm.u = motion.lateralMm * impulse * phaseEnvelope;
      out.tiltRad.u = rad(motion.tiltDeg) * impulse * phaseEnvelope;
      break;
    }
    case "fei":
      out.handPose = "tripod";
      out.grip *= 1 - 0.55 * phaseEnvelope * (1 - pulse(cycle, 0.35));
      out.rotationRad = rad(motion.rotationDeg) * swing * 0.5;
      break;
    case "mo":
      out.lateralMm.v = motion.lateralMm * swing;
      out.rotationRad = rad(motion.rotationDeg) * swing * 0.3;
      break;
    case "dong":
      out.withdrawalMm = motion.strokeMm * axialPulse * 0.5;
      out.lateralMm.u = motion.lateralMm * swing * 0.5;
      break;
    case "tui-push":
      out.withdrawalMm = motion.strokeMm * axialPulse * 0.4;
      out.supportContact = motion.support === "none" ? 0 : gripEnvelope * motion.contactIntensity;
      break;
    case "chan":
      out.withdrawalMm = motion.strokeMm * envelope * phaseEnvelope;
      out.lateralMm.u = motion.lateralMm * swing;
      out.tiltRad.u = rad(motion.tiltDeg) * swing;
      break;
    case "nu":
      out.handPose = motion.grip === "three-finger" ? "tripod" : "pinch";
      out.lateralMm.u = motion.lateralMm * axialPulse;
      out.tiltRad.u = rad(motion.tiltDeg) * axialPulse;
      break;
    case "sou":
      out.lateralMm.u = motion.lateralMm * swing;
      out.lateralMm.v = motion.lateralMm * Math.sin(cycle * Math.PI * 4) * envelope * phaseEnvelope * 0.5;
      out.tiltRad.u = rad(motion.tiltDeg) * swing;
      out.tiltRad.v = rad(motion.tiltDeg) * Math.sin(cycle * Math.PI * 4) * envelope * phaseEnvelope * 0.5;
      break;
    case "bo":
      out.lateralMm.u = motion.lateralMm * swing;
      out.tiltRad.u = rad(motion.tiltDeg) * swing;
      out.handPose = motion.grip === "three-finger" ? "tripod" : "pinch";
      break;
    case "bu": case "xie":
      out.withdrawalMm = motion.strokeMm * axialPulse;
      out.rotationRad = rad(motion.rotationDeg) * rotation;
      break;
  }
  if (motion.support === "stretch" && out.contact === "skin") out.handPose = "stretch";
  return out;
}

/** Catch a catalogue/schema mismatch during authoring, without side effects or I/O. */
export function manipulationCatalogueComplete(): boolean {
  return MANIPULATION_TECHNIQUE_IDS.length === MANIPULATION_TECHNIQUES.length && MANIPULATION_TECHNIQUE_IDS.every((id) => BY_ID.has(id));
}
