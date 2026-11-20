import {
  MANIPULATION_TECHNIQUE_IDS, type ManipulationMotionSettings, type ManipulationTechniqueId, type ResolvedManipulationMotion,
  type TechniqueModel,
} from "../schema/manipulation.js";
import {
  MANIPULATION_TECHNIQUES, MOTION_CURVES, SHARED_CONTROLS, manipulationTechnique, resolveManipulationMotion, resolveMotionFor, sampleTechnique, twistExcursion,
  type ManipulationControl, type ManipulationTechnique, type TechniqueMotionSample,
} from "./performance.js";
import { TECHNIQUE_CARDS, type TechniqueCard } from "./technique-cards.js";

/**
 * The operative catalogue: the 36 techniques as they are done, stage by stage — the level the tip stands at (天, 人,
 * 地: thirds of the depth the needle stands at, never deeper), how many times, at what tempo, turning which way —
 * and what each does to the needle in the simulated tissue. The illustrative catalogue (`performance.ts`) stays as
 * it was: an encounter recorded on it replays on it.
 *
 * Authored from classical and textbook accounts and NOT reviewed by a practitioner (`technique-cards.ts`). Forces
 * are not modelled. The tip never leaves the path the engine approved: levels are shallower positions on that path,
 * and every sway, lean, bow and "direction" is of the shaft outside the skin.
 */

export const OPERATIVE_CATALOGUE_VERSION = "acucraft/operative-techniques@2" as const;
export const OPERATIVE_SOURCE = "acucraft-operative-techniques-v2" as const;

const { clamp, smooth, pulse, rad } = MOTION_CURVES;

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

export type DepthLevel = "tian" | "ren" | "di";
export const DEPTH_LEVELS: Readonly<Record<DepthLevel, { zh: string; label: string; fraction: number }>> = {
  tian: { zh: "天部", label: "shallow level", fraction: 1 / 3 },
  ren: { zh: "人部", label: "middle level", fraction: 2 / 3 },
  di: { zh: "地部", label: "deep level", fraction: 1 },
};

export type StageMotif =
  | "hold" | "move" | "stroke" | "twirl" | "wind" | "sway" | "orbit" | "bow" | "tremble" | "flick" | "scrape" | "fly"
  | "rub" | "push" | "stir" | "lever" | "knead" | "nail" | "trace" | "nip" | "press";

export interface OperationStage {
  id: string;
  zh: string;
  label: string;
  motif: StageMotif;
  /** The illustrative primitive whose hand shape and contact the stage uses. */
  primitive: ManipulationTechniqueId;
  /** Where the tip stands at the start and the end of the stage, as a fraction of the depth the needle stands at. */
  from: number;
  to: number;
  level: DepthLevel | null;
  /** Repetitions within the stage; `counted` stages show "n/N". */
  count: number;
  counted: boolean;
  /** Fraction of one repetition spent on its outward (lifting) half. Above a half: the thrust is the quick one. */
  bias: number;
  /** 1: thumb forward (clockwise seen from the handle, 左转); -1: thumb backward (右转); 0: both ways. */
  turn: -1 | 0 | 1;
  /** Shares of the stroke, arc, lateral excursion and tilt the operator set. */
  stroke: number;
  rotation: number;
  lateral: number;
  tilt: number;
  /** A steady lean of the exposed shaft, as a share of the lateral excursion and tilt set (chart u, v). */
  leanFrom: { u: number; v: number };
  leanTo: { u: number; v: number };
  breath: "inhale" | "exhale" | null;
  /** Start and end of the stage as fractions of the whole performance. */
  start: number;
  end: number;
}

type Spec = Pick<OperationStage, "zh" | "label" | "motif"> & Partial<Omit<OperationStage, "id" | "start" | "end" | "leanFrom">> & {
  /** Nominal seconds for the whole stage at the tempo it is taught at. */
  seconds: number;
};

const UP = { u: 0, v: 1 }, DOWN = { u: 0, v: -1 }, LEFT = { u: -1, v: 0 }, RIGHT = { u: 1, v: 0 }, NONE = { u: 0, v: 0 };

const move = (zh: string, label: string, to: number, seconds: number, extra: Partial<Spec> = {}): Spec =>
  ({ zh, label, motif: "move", to, seconds, ...extra });
const hold = (zh: string, label: string, seconds: number, extra: Partial<Spec> = {}): Spec =>
  ({ zh, label, motif: "hold", seconds, ...extra });
/** A counted stage: `per` seconds each time. */
const work = (zh: string, label: string, motif: StageMotif, count: number, per: number, extra: Partial<Spec> = {}): Spec =>
  ({ zh, label, motif, count, counted: true, seconds: per * count, ...extra });

/** Quick thrust, slow lift (紧按慢提) and its opposite (紧提慢按). */
const THRUST_LED = 0.72, LIFT_LED = 0.28;

/* ------------------------------------------------------------------ */
/* The 36 programs                                                     */
/* ------------------------------------------------------------------ */

export type TechniqueReading = "reinforcing" | "reducing" | "mixed" | "even";

interface Authored {
  /** What `cycles` (one entry) or `phaseCycles` (several) count: the canonical numbers of the method. */
  counts: { zh: string; label: string; count: number }[];
  program: (c: number[], m: ResolvedManipulationMotion) => Spec[];
  defaults?: Partial<ResolvedManipulationMotion>;
  controls: ManipulationControl[];
  /** Stimulation one performance gives a retained needle at its canonical counts and default amplitude. */
  dose: number;
  /** The amplitude the dose scales with. */
  scalesWith?: "strokeMm" | "rotationDeg" | "lateralMm";
  reading: TechniqueReading | null;
  /** Depth the needle must stand at for the method's levels to exist (mm). */
  needsDepthMm?: number;
  /** One-way turning that stays on the needle. */
  winds?: boolean;
  /** Degrees of winding it lets go. */
  loosensDeg?: number;
  /** The sensation the method is done for. */
  seeks?: "warmth" | "coolness";
}

const GRIP = SHARED_CONTROLS.grip;
const AXIAL: ManipulationControl[] = [...GRIP, "strokeMm"];
const TURN: ManipulationControl[] = [...GRIP, "rotationDeg"];
const LEAN: ManipulationControl[] = [...GRIP, "lateralMm", "tiltDeg"];

const AUTHORED: Readonly<Record<ManipulationTechniqueId, Authored>> = {
  /* 揣爪循摄 */
  chuai: {
    counts: [{ zh: "揉", label: "kneading circles", count: 3 }],
    program: ([n]) => [
      hold("按定", "The thumb pad settles on the measured point", 0.5, { primitive: "chuai" }),
      work("揣揉", "Kneading in small circles", "knead", n!, 0.9, { lateral: 1 }),
      work("寻按", "Sliding to and fro for the hollow", "trace", 2, 0.8, { lateral: 1, counted: false }),
      hold("定穴", "Settling on the point found", 0.6, { primitive: "chuai" }),
    ],
    defaults: { support: "none", lateralMm: 2 }, controls: ["lateralMm"], dose: 0, reading: null,
  },
  zhua: {
    counts: [{ zh: "切", label: "nail presses", count: 2 }],
    program: ([n]) => [
      work("爪切", "Pressing in with the thumbnail: a line, then across it", "nail", n!, 1.5, { lateral: 1 }),
      hold("定穴", "The nail holds the point for the needle", 0.5, { primitive: "zhua" }),
    ],
    defaults: { support: "none", lateralMm: 1, contactIntensity: 0.6 }, controls: ["lateralMm"], dose: 0, reading: null,
  },
  xun: {
    counts: [{ zh: "循", label: "passes along the channel", count: 3 }],
    program: ([n]) => [work("循按", "Stroking along the channel, away and back", "trace", n!, 1.6, { lateral: 1 })],
    defaults: { support: "none", travelMm: 30, contactIntensity: 0.35 }, controls: ["travelMm"], dose: 0.05, reading: null, loosensDeg: 120,
  },
  she: {
    counts: [{ zh: "遍", label: "passes of four stations", count: 1 }],
    program: ([n]) => [work("摄切", "Nipping with the nail: two stations below the point, two above", "nip", 4 * n!, 0.9, { lateral: 1 })],
    defaults: { support: "none", travelMm: 24, contactIntensity: 0.7 }, controls: ["travelMm"], dose: 0.05, reading: null, loosensDeg: 240,
  },
  /* 摇盘捻搓 */
  yao: {
    counts: [{ zh: "摇", label: "sways", count: 6 }],
    program: ([n]) => [work("摇针", "Rocking the needle about its entry", "sway", n!, 0.7, { lateral: 1, tilt: 1 })],
    controls: LEAN, dose: 0.15, scalesWith: "lateralMm", reading: null,
  },
  pan: {
    counts: [{ zh: "盘", label: "circles", count: 5 }],
    program: ([n]) => [work("盘针", "Carrying the handle round in full circles", "orbit", n!, 1.1, { lateral: 1, tilt: 1, primitive: "pan" })],
    defaults: { direction: "clockwise", lateralMm: 3, tiltDeg: 6 }, controls: [...LEAN, "direction"], dose: 0.2, scalesWith: "lateralMm", reading: null,
  },
  nian: {
    counts: [{ zh: "捻", label: "twirls", count: 6 }],
    program: ([n], m) => [work("捻转", m.direction === "alternating" ? "Twirling to and fro" : m.direction === "clockwise" ? "Twirling thumb-forward, each let back" : "Twirling thumb-backward, each let back",
      "twirl", n!, 0.5, { rotation: 1, turn: m.direction === "alternating" ? 0 : m.direction === "clockwise" ? 1 : -1, bias: m.tempoBias })],
    controls: [...TURN, "direction", "tempoBias"], dose: 0.3, scalesWith: "rotationDeg", reading: "even", loosensDeg: 0,
  },
  cuo: {
    counts: [{ zh: "搓", label: "rolls one way", count: 3 }],
    program: ([n], m) => [
      work("搓针", `Rolling one way, ${m.direction === "counterclockwise" ? "thumb backward" : "thumb forward"}, like twisting a thread`, "wind", n!, 0.9, { rotation: 1, turn: m.direction === "counterclockwise" ? -1 : 1 }),
      hold("守气", "Holding: the fibres have taken the needle", 0.8, { primitive: "cuo" }),
    ],
    defaults: { direction: "clockwise", rotationDeg: 120 }, controls: [...TURN, "direction"], dose: 0.35, scalesWith: "rotationDeg", reading: null, winds: true,
  },
  /* 进退提插 */
  jin: {
    counts: [{ zh: "进", label: "advances", count: 2 }],
    program: () => [
      move("退至天部", "Back to the shallow level, to begin", 1 / 3, 1.0, { level: "tian" }),
      hold("候气", "Waiting at the shallow level", 0.5, { level: "tian" }),
      move("进至人部", "Advancing to the middle level with a small twirl", 2 / 3, 1.0, { level: "ren", rotation: 0.3, breath: "exhale" }),
      hold("候气", "Waiting at the middle level", 0.6, { level: "ren" }),
      move("进至地部", "Advancing to the deep level with a small twirl", 1, 1.0, { level: "di", rotation: 0.3, breath: "exhale" }),
      hold("候气", "Waiting at the deep level", 0.6, { level: "di" }),
    ],
    controls: [...GRIP, "rotationDeg"], dose: 0.2, reading: "reinforcing", needsDepthMm: 6,
  },
  "tui-withdraw": {
    counts: [{ zh: "退", label: "withdrawals", count: 2 }],
    program: () => [
      move("退至人部", "Drawing back to the middle level", 2 / 3, 1.0, { level: "ren", breath: "exhale" }),
      hold("少停", "Pausing at the middle level", 0.6, { level: "ren" }),
      move("退至天部", "Drawing back to the shallow level", 1 / 3, 1.0, { level: "tian", breath: "exhale" }),
      hold("少停", "Pausing at the shallow level", 0.6, { level: "tian" }),
      move("复原", "Returning to the depth the needle stood at", 1, 1.1, { level: "di" }),
    ],
    controls: [...GRIP], dose: 0.15, reading: "reducing", needsDepthMm: 6,
  },
  ti: {
    counts: [{ zh: "提", label: "lifts", count: 6 }],
    program: ([n], m) => [work("紧提慢按", "Quick lift, slow return", "stroke", n!, 0.9, { stroke: 1, bias: Math.min(0.45, m.tempoBias) })],
    defaults: { tempoBias: LIFT_LED, strokeMm: 2 }, controls: [...AXIAL, "tempoBias"], dose: 0.3, scalesWith: "strokeMm", reading: "reducing",
  },
  cha: {
    counts: [{ zh: "插", label: "thrusts", count: 6 }],
    program: ([n], m) => [work("紧按慢提", "Slow lift, quick thrust", "stroke", n!, 0.9, { stroke: 1, bias: Math.max(0.55, m.tempoBias) })],
    defaults: { tempoBias: THRUST_LED, strokeMm: 2 }, controls: [...AXIAL, "tempoBias"], dose: 0.3, scalesWith: "strokeMm", reading: "reinforcing",
  },
  /* 刮弹飞摩 */
  gua: {
    counts: [{ zh: "刮", label: "scrapes", count: 8 }],
    program: ([n]) => [work("刮柄", "The nail scrapes up the handle and returns", "scrape", n!, 0.55, { lateral: 0.15 })],
    defaults: { support: "none", lateralMm: 1 }, controls: ["gripApertureMm"], dose: 0.1, reading: null, loosensDeg: 60,
  },
  tan: {
    counts: [{ zh: "弹", label: "flicks", count: 6 }],
    program: ([n]) => [work("弹柄", "A light flick, and the shaft quivers", "flick", n!, 0.8, { lateral: 1, tilt: 1 })],
    defaults: { support: "none", lateralMm: 1.2 }, controls: ["lateralMm", "tiltDeg"], dose: 0.08, reading: null, loosensDeg: 60,
  },
  fei: {
    counts: [{ zh: "飞", label: "twirl-and-release", count: 3 }],
    program: ([n]) => [work("一捻一放", "Three small twirls, then the fingers spring open", "fly", n!, 1.5, { rotation: 0.5, lateral: 0.2, turn: 1 })],
    defaults: { support: "none", gripApertureMm: 9, rotationDeg: 90 }, controls: [...TURN], dose: 0.2, scalesWith: "rotationDeg", reading: null,
  },
  mo: {
    counts: [{ zh: "摩", label: "rubs", count: 6 }],
    program: ([n]) => [work("摩柄", "The pads rub the handle; the needle neither turns nor moves", "rub", n!, 0.6, { lateral: 0.5, rotation: 0.1 })],
    defaults: { lateralMm: 0.6, rotationDeg: 25 }, controls: [...GRIP, "lateralMm"], dose: 0.05, reading: null,
  },
  /* 动推颤弩 */
  dong: {
    counts: [{ zh: "动", label: "stirs", count: 4 }],
    program: ([n]) => [work("伸提动摇", "A small lift, moved a little as it is let back", "stir", n!, 0.8, { stroke: 0.5, lateral: 0.5 })],
    defaults: { strokeMm: 1.2, lateralMm: 1 }, controls: [...AXIAL, "lateralMm"], dose: 0.15, scalesWith: "strokeMm", reading: null,
  },
  "tui-push": {
    counts: [{ zh: "推", label: "pushes", count: 3 }],
    program: ([n]) => [work("推针", "The thumb pushes forward and holds; the tip goes no deeper", "push", n!, 1.4, { rotation: 1, turn: 1 })],
    defaults: { rotationDeg: 45, contactIntensity: 0.6 }, controls: [...TURN], dose: 0.15, scalesWith: "rotationDeg", reading: null,
  },
  chan: {
    counts: [{ zh: "颤", label: "tremors", count: 12 }],
    program: ([n]) => [
      work("震颤", "Very small, quick lifts and thrusts: the needle trembles", "tremble", n!, 0.17, { stroke: 1, lateral: 1, tilt: 1, rotation: 0.1 }),
      hold("少停", "A pause", 0.4, { primitive: "chan" }),
      work("震颤", "Trembling again", "tremble", n!, 0.17, { stroke: 1, lateral: 1, tilt: 1, rotation: 0.1 }),
    ],
    defaults: { strokeMm: 0.4, lateralMm: 0.4, tiltDeg: 1, rotationDeg: 60 }, controls: [...AXIAL, "lateralMm", "tiltDeg"], dose: 0.2, scalesWith: "strokeMm", reading: null,
  },
  nu: {
    counts: [{ zh: "弩", label: "bows", count: 2 }],
    program: ([n]) => [work("弩针", "The middle finger bows the shaft and holds it", "bow", n!, 2.4, { lateral: 1, tilt: 1 })],
    defaults: { grip: "three-finger", lateralMm: 2.5, tiltDeg: 4 }, controls: LEAN, dose: 0.2, scalesWith: "lateralMm", reading: null,
  },
  /* 按扪搜拨 */
  an: {
    counts: [{ zh: "按", label: "presses", count: 1 }],
    program: ([n]) => [work("按压", "A finger presses the channel beside the point and holds", "press", n!, 3, {})],
    defaults: { support: "press", lateralMm: 0, travelMm: 18, contactIntensity: 0.7 }, controls: ["travelMm"], dose: 0.03, reading: null, loosensDeg: 60,
  },
  men: {
    counts: [{ zh: "揉", label: "kneading circles", count: 3 }],
    program: ([n]) => [
      hold("扪闭", "Pressing on the hole at once", 0.9, { primitive: "men" }),
      work("轻揉", "Kneading lightly", "knead", n!, 0.7, { lateral: 1, primitive: "men" }),
      hold("按定", "Holding", 0.9, { primitive: "men" }),
    ],
    defaults: { support: "press", lateralMm: 1.5, contactIntensity: 0.6 }, controls: ["lateralMm"], dose: 0, reading: "reinforcing",
  },
  sou: {
    counts: [{ zh: "遍", label: "rounds of four directions", count: 1 }],
    program: ([n]) => [
      move("退至浅层", "Back to the shallow half", 0.5, 0.9, {}),
      ...Array.from({ length: Math.min(3, n!) }).flatMap(() => ([["前", "forward", UP], ["后", "back", DOWN], ["左", "left", LEFT], ["右", "right", RIGHT]] as const).flatMap(([zh, en, lean]) => [
        move(`向${zh}探`, `Leaning ${en} and advancing, feeling for the response`, 1, 0.8, { leanTo: lean, lateral: 1, tilt: 1, primitive: "sou" }),
        move("退回", "Back to the shallow half", 0.5, 0.6, { leanTo: NONE, lateral: 1, tilt: 1, primitive: "sou" }),
      ])),
      move("复原", "Returning to the depth the needle stood at", 1, 0.9, {}),
    ],
    defaults: { lateralMm: 1.5, tiltDeg: 2 }, controls: LEAN, dose: 0.25, reading: null, needsDepthMm: 4,
  },
  bo: {
    counts: [{ zh: "拨", label: "levers", count: 4 }],
    program: ([n]) => [work("拨针", "Levering the handle across the fibres, with a pause", "lever", n!, 1.1, { lateral: 1, tilt: 1 })],
    defaults: { lateralMm: 2, tiltDeg: 2 }, controls: LEAN, dose: 0.25, scalesWith: "lateralMm", reading: null,
  },
  /* 复式手法 */
  "shao-shan-huo": {
    counts: [{ zh: "天部", label: "strokes at the shallow level", count: 9 }, { zh: "人部", label: "strokes at the middle level", count: 9 }, { zh: "地部", label: "strokes at the deep level", count: 9 }],
    program: ([a, b, c]) => [
      move("退至天部", "Back to the shallow level, to begin", 1 / 3, 1.0, { level: "tian" }),
      work("天部 · 紧按慢提", "Shallow level: quick thrust, slow lift", "stroke", a!, 0.75, { stroke: 1, bias: THRUST_LED, rotation: 0.25, turn: 1, level: "tian" }),
      move("进至人部", "Advancing to the middle level on the out-breath", 2 / 3, 0.8, { level: "ren", breath: "exhale" }),
      work("人部 · 紧按慢提", "Middle level: quick thrust, slow lift", "stroke", b!, 0.75, { stroke: 1, bias: THRUST_LED, rotation: 0.25, turn: 1, level: "ren" }),
      move("进至地部", "Advancing to the deep level on the out-breath", 1, 0.8, { level: "di", breath: "exhale" }),
      work("地部 · 紧按慢提", "Deep level: quick thrust, slow lift", "stroke", c!, 0.75, { stroke: 1, bias: THRUST_LED, rotation: 0.25, turn: 1, level: "di" }),
      hold("紧闭插针", "Held pressed at the deep level", 0.7, { level: "di", primitive: "bu" }),
    ],
    defaults: { strokeMm: 2, rotationDeg: 60 }, controls: [...AXIAL, "rotationDeg"], dose: 0.7, scalesWith: "strokeMm", reading: "reinforcing", needsDepthMm: 6, seeks: "warmth",
  },
  "tou-tian-liang": {
    counts: [{ zh: "地部", label: "strokes at the deep level", count: 6 }, { zh: "人部", label: "strokes at the middle level", count: 6 }, { zh: "天部", label: "strokes at the shallow level", count: 6 }],
    program: ([a, b, c]) => [
      work("地部 · 紧提慢按", "Deep level: quick lift, slow thrust", "stroke", a!, 0.8, { stroke: 1, bias: LIFT_LED, rotation: 0.25, turn: -1, level: "di" }),
      move("退至人部", "Drawing back to the middle level on the out-breath", 2 / 3, 0.8, { level: "ren", breath: "exhale" }),
      work("人部 · 紧提慢按", "Middle level: quick lift, slow thrust", "stroke", b!, 0.8, { stroke: 1, bias: LIFT_LED, rotation: 0.25, turn: -1, level: "ren" }),
      move("退至天部", "Drawing back to the shallow level on the out-breath", 1 / 3, 0.8, { level: "tian", breath: "exhale" }),
      work("天部 · 紧提慢按", "Shallow level: quick lift, slow thrust", "stroke", c!, 0.8, { stroke: 1, bias: LIFT_LED, rotation: 0.25, turn: -1, level: "tian" }),
      move("一进", "One slow advance back to the depth the needle stood at", 1, 1.2, { level: "di", breath: "inhale" }),
    ],
    defaults: { strokeMm: 2.5, rotationDeg: 90 }, controls: [...AXIAL, "rotationDeg"], dose: 0.6, scalesWith: "strokeMm", reading: "reducing", needsDepthMm: 6, seeks: "coolness",
  },
  "qing-long-bai-wei": {
    counts: [{ zh: "摆", label: "sways", count: 9 }],
    program: ([n]) => [
      move("提至天部", "Lifting to the shallow level", 1 / 3, 1.0, { level: "tian" }),
      hold("扳倒针身", "Leaning the needle toward where the qi is to go", 0.7, { leanTo: { u: 0, v: 0.45 }, lateral: 1, tilt: 1, level: "tian", primitive: "yao" }),
      work("一左一右", "Swaying slowly left and right, like holding a tiller", "sway", n!, 1.0, { lateral: 0.55, tilt: 0.55, level: "tian" }),
      hold("扶正", "Standing the needle up again", 0.6, { leanTo: NONE, lateral: 1, tilt: 1, level: "tian", primitive: "yao" }),
      move("复原", "Returning to the depth the needle stood at", 1, 1.0, { level: "di" }),
    ],
    defaults: { lateralMm: 3, tiltDeg: 6 }, controls: LEAN, dose: 0.3, scalesWith: "lateralMm", reading: "reinforcing", needsDepthMm: 6,
  },
  "bai-hu-yao-tou": {
    counts: [{ zh: "摇", label: "shakes while lifting", count: 6 }],
    program: ([n]) => [0, 1].flatMap((round) => [
      work(round === 0 ? "边摇边提" : "再摇再提", "Shaking the shaft like a hand bell while lifting", "sway", n!, 0.5, { lateral: 1, tilt: 1, to: 2 / 3, level: "di" }),
      move("进圆", "Thrusting back with a turn", 1, 0.8, { rotation: 0.5, level: "di" }),
    ]),
    defaults: { lateralMm: 2.5, tiltDeg: 5, rotationDeg: 90 }, controls: [...LEAN, "rotationDeg"], dose: 0.4, scalesWith: "lateralMm", reading: "reducing", needsDepthMm: 6,
  },
  "cang-gui-tan-xue": {
    counts: [{ zh: "遍", label: "rounds of four directions", count: 1 }],
    program: ([n]) => [
      move("退至浅层", "Back to just under the skin", 0.25, 1.0, { level: "tian" }),
      ...Array.from({ length: Math.min(3, n!) }).flatMap(() => ([["上", "upward", UP], ["下", "downward", DOWN], ["左", "to the left", LEFT], ["右", "to the right", RIGHT]] as const).flatMap(([zh, en, lean]) => [
        move(`向${zh} · 一进`, `Leaning ${en}: first step in`, 0.5, 0.55, { leanTo: lean, lateral: 1, tilt: 1, primitive: "sou", level: "tian" }),
        move(`向${zh} · 二进`, `Leaning ${en}: second step in`, 0.75, 0.55, { primitive: "sou", lateral: 1, tilt: 1, level: "ren" }),
        move(`向${zh} · 三进`, `Leaning ${en}: third step in`, 1, 0.55, { primitive: "sou", lateral: 1, tilt: 1, level: "di" }),
        move("一退", "One withdrawal to just under the skin", 0.25, 0.75, { leanTo: NONE, lateral: 1, tilt: 1, primitive: "sou", level: "tian" }),
      ])),
      move("复原", "Returning to the depth the needle stood at", 1, 1.0, { level: "di" }),
    ],
    defaults: { lateralMm: 2.5, tiltDeg: 5 }, controls: LEAN, dose: 0.45, reading: "reinforcing", needsDepthMm: 8,
  },
  "chi-feng-ying-yuan": {
    counts: [{ zh: "飞", label: "twirl-and-release", count: 8 }],
    program: ([n]) => {
      const sides = [["上", "above", UP], ["下", "below", DOWN], ["左", "left", LEFT], ["右", "right", RIGHT]] as const;
      const each = Math.max(1, Math.round(n! / 4));
      return [
        move("提针至天", "Lifting to the shallow level", 1 / 3, 1.0, { level: "tian" }),
        hold("候针自摇", "Waiting for the needle to stir of itself", 0.9, { level: "tian", primitive: "fei" }),
        move("复进其原", "Advancing again, to the middle level", 2 / 3, 0.8, { level: "ren" }),
        ...sides.map(([zh, en, lean]) => work(`${zh} · 展翅飞旋`, `Twirl and release, ${en}: the fingers open like wings`, "fly", each, 1.4,
          { rotation: 0.5, lateral: 0.6, tilt: 0.6, turn: 1, leanTo: { u: lean.u * 0.4, v: lean.v * 0.4 }, level: "ren" })),
        move("复原", "Returning to the depth the needle stood at", 1, 0.9, { leanTo: NONE, lateral: 1, tilt: 1, level: "di" }),
      ];
    },
    defaults: { support: "none", gripApertureMm: 9, rotationDeg: 90, lateralMm: 2, tiltDeg: 3 }, controls: [...TURN, "lateralMm", "tiltDeg"], dose: 0.45, scalesWith: "rotationDeg", reading: "reducing", needsDepthMm: 6,
  },
  "long-hu-jiao-zhan": {
    counts: [{ zh: "龙 · 左转", label: "twirls thumb-forward", count: 9 }, { zh: "虎 · 右转", label: "twirls thumb-backward", count: 6 }],
    program: ([a, b]) => [0, 1].flatMap(() => [
      work("龙 · 左转九", "The dragon: twirling to the left, thumb forward", "twirl", a!, 0.5, { rotation: 1, turn: 1, bias: 0.35 }),
      work("虎 · 右转六", "The tiger: twirling to the right, thumb backward", "twirl", b!, 0.5, { rotation: 1, turn: -1, bias: 0.35 }),
    ]),
    defaults: { rotationDeg: 120 }, controls: [...TURN], dose: 0.5, scalesWith: "rotationDeg", reading: "mixed",
  },
  "zi-wu-dao-jiu": {
    counts: [{ zh: "度", label: "rounds of three in, two out", count: 3 }],
    program: ([n]) => [
      move("退至浅层", "Back to the shallow quarter, to begin", 0.25, 1.0, { level: "tian" }),
      ...Array.from({ length: Math.min(6, n!) }).flatMap((_, round) => [
        ...[0.5, 0.75, 1].map((to, i) => move(`${["一", "二", "三"][i]}进 · 左转`, `Round ${round + 1}: thrust ${i + 1} of 3, turning left`, to, 0.6, { rotation: 0.6, turn: 1 as const, primitive: "cha" as const, level: (["tian", "ren", "di"] as const)[i] })),
        ...[0.625, 0.25].map((to, i) => move(`${["一", "二"][i]}退 · 右转`, `Round ${round + 1}: lift ${i + 1} of 2, turning right`, to, 0.7, { rotation: 0.6, turn: -1 as const, primitive: "ti" as const, level: (["ren", "tian"] as const)[i] })),
      ]),
      move("复原", "Returning to the depth the needle stood at", 1, 0.9, { level: "di" }),
    ],
    defaults: { rotationDeg: 90 }, controls: [...TURN], dose: 0.6, scalesWith: "rotationDeg", reading: "mixed", needsDepthMm: 8,
  },
  "yang-zhong-yin-yin": {
    counts: [{ zh: "浅层 · 补", label: "thrust-led strokes at the shallow level", count: 9 }, { zh: "深层 · 泻", label: "lift-led strokes at the deep level", count: 6 }],
    program: ([a, b]) => [
      move("退至浅层", "Back to the shallow half, to begin", 0.5, 1.0, { level: "tian" }),
      work("浅层 · 紧按慢提", "Shallow: quick thrust, slow lift — reinforcing first", "stroke", a!, 0.75, { stroke: 1, bias: THRUST_LED, level: "tian" }),
      move("进至深层", "Advancing to the deep level", 1, 0.8, { level: "di" }),
      work("深层 · 紧提慢按", "Deep: quick lift, slow thrust — then reducing", "stroke", b!, 0.8, { stroke: 1, bias: LIFT_LED, level: "di" }),
    ],
    defaults: { strokeMm: 2 }, controls: AXIAL, dose: 0.55, scalesWith: "strokeMm", reading: "mixed", needsDepthMm: 4,
  },
  "yin-zhong-yin-yang": {
    counts: [{ zh: "深层 · 泻", label: "lift-led strokes at the deep level", count: 6 }, { zh: "浅层 · 补", label: "thrust-led strokes at the shallow level", count: 9 }],
    program: ([a, b]) => [
      work("深层 · 紧提慢按", "Deep: quick lift, slow thrust — reducing first", "stroke", a!, 0.8, { stroke: 1, bias: LIFT_LED, level: "di" }),
      move("退至浅层", "Drawing back to the shallow half", 0.5, 0.8, { level: "tian" }),
      work("浅层 · 紧按慢提", "Shallow: quick thrust, slow lift — then reinforcing", "stroke", b!, 0.75, { stroke: 1, bias: THRUST_LED, level: "tian" }),
      move("复原", "Returning to the depth the needle stood at", 1, 1.0, { level: "di" }),
    ],
    defaults: { strokeMm: 2 }, controls: AXIAL, dose: 0.55, scalesWith: "strokeMm", reading: "mixed", needsDepthMm: 4,
  },
  /* 补泻 */
  bu: {
    counts: [{ zh: "九阳", label: "thrust-led strokes", count: 9 }],
    program: ([n]) => [work("紧按慢提 · 拇指向前", "Quick thrust with the thumb going forward, slow lift", "stroke", n!, 0.9, { stroke: 1, bias: THRUST_LED, rotation: 1, turn: 1 })],
    defaults: { strokeMm: 1, rotationDeg: 60, tempoBias: THRUST_LED }, controls: [...AXIAL, "rotationDeg"], dose: 0.3, scalesWith: "strokeMm", reading: "reinforcing",
  },
  xie: {
    counts: [{ zh: "六阴", label: "lift-led strokes, twice", count: 6 }],
    program: ([n]) => [
      work("紧提慢按 · 拇指向后", "Quick lift with the thumb going back, slow thrust", "stroke", n!, 0.6, { stroke: 1, bias: LIFT_LED, rotation: 1, turn: -1 }),
      hold("少停", "A pause", 0.4, { primitive: "xie" }),
      work("紧提慢按 · 拇指向后", "And again", "stroke", n!, 0.6, { stroke: 1, bias: LIFT_LED, rotation: 1, turn: -1 }),
    ],
    defaults: { strokeMm: 2.5, rotationDeg: 120, tempoBias: LIFT_LED }, controls: [...AXIAL, "rotationDeg"], dose: 0.45, scalesWith: "strokeMm", reading: "reducing",
  },
};

/** The illustrative primitive a motif's hand shape comes from, when a stage does not name one. */
const MOTIF_PRIMITIVE: Readonly<Record<StageMotif, ManipulationTechniqueId | null>> = {
  hold: null, move: null, stroke: "bu", twirl: "nian", wind: "cuo", sway: "yao", orbit: "pan", bow: "nu", tremble: "chan", flick: "tan",
  scrape: "gua", fly: "fei", rub: "mo", push: "tui-push", stir: "dong", lever: "bo", knead: "chuai", nail: "zhua", trace: "xun", nip: "she", press: "an",
};

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

export interface OperativeTechnique extends ManipulationTechnique {
  evidence: "operative";
  card: TechniqueCard;
  /** What `cycles` (one entry) or `phaseCycles` (several, in this order) count. */
  counts: { zh: string; label: string; count: number }[];
  /** The stages of one performance at the catalogue's defaults. */
  stages: OperationStage[];
  /** Done to a retained needle: what one performance at the defaults does. */
  effect: { dose: number; reading: TechniqueReading | null; winds: boolean; loosensDeg: number; needsDepthMm: number; seeks: "warmth" | "coolness" | null };
}

const SOURCE = {
  id: OPERATIVE_SOURCE,
  review: "unreviewed" as const,
  note: "Authored from classical and textbook accounts of each method (see the card of each technique). Not reviewed by a practitioner; counts, levels and directions follow one common reading where sources differ. Forces and tissue mechanics are not modelled.",
};

const finite = (v: number | undefined, fallback: number, lo: number, hi: number): number => v === undefined || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, v));

function stagesOf(id: ManipulationTechniqueId, specs: Spec[]): OperationStage[] {
  const total = specs.reduce((sum, x) => sum + x.seconds, 0) || 1;
  let depth = 1, lean = NONE, at = 0;
  const base = manipulationTechnique(id)!;
  return specs.map((x, index) => {
    const from = x.from ?? depth, to = x.to ?? from, leanFrom = lean, leanTo = x.leanTo ?? lean;
    const start = at / total, end = (at + x.seconds) / total;
    depth = to; lean = leanTo; at += x.seconds;
    return {
      id: `${id}:${index + 1}`, zh: x.zh, label: x.label, motif: x.motif,
      primitive: x.primitive ?? MOTIF_PRIMITIVE[x.motif] ?? (base.context === "retained" ? (to >= from ? "jin" : "tui-withdraw") : id),
      from, to, level: x.level ?? null, count: Math.max(1, Math.round(x.count ?? 1)), counted: x.counted ?? false,
      bias: x.bias ?? 0.5, turn: x.turn ?? 0, stroke: x.stroke ?? 0, rotation: x.rotation ?? 0, lateral: x.lateral ?? 0, tilt: x.tilt ?? 0,
      leanFrom, leanTo, breath: x.breath ?? null, start, end,
    };
  });
}

const nominalMs = (specs: Spec[]) => Math.min(30_000, Math.max(400, Math.round(specs.reduce((sum, x) => sum + x.seconds, 0) * 10) * 100));

function build(id: ManipulationTechniqueId): OperativeTechnique {
  const base = manipulationTechnique(id)!, authored = AUTHORED[id], card = TECHNIQUE_CARDS[id];
  const counts = authored.counts.map((c) => c.count);
  const several = counts.length > 1;
  const controls = [...new Set<ManipulationControl>([
    ...SHARED_CONTROLS.common, ...(several ? ["phaseCycles" as const] : []), ...(base.context === "retained" ? SHARED_CONTROLS.referenceHand : []), ...authored.controls,
  ])];
  // the illustrative defaults are the starting point: a control this catalogue does not touch keeps its value
  // and the pressing hand stays off the skin unless the method is its work: touching a prepared site undoes it
  const seed: ResolvedManipulationMotion = { ...base.defaults, ...(base.context === "retained" ? { support: "none" as const } : {}), ...authored.defaults, cycles: several ? base.defaults.cycles : counts[0]!, ...(several ? { phaseCycles: counts } : {}) };
  const specs = authored.program(counts, seed);
  const defaults: ResolvedManipulationMotion = { ...seed, durationMs: nominalMs(specs) };
  const stages = stagesOf(id, specs);
  return {
    id, zh: base.zh, label: `${card.name} · ${base.zh} ${card.pinyin}`, family: base.family, context: base.context, needsNeedle: base.needsNeedle,
    description: card.aim, evidence: "operative",
    primitives: [...new Set(stages.map((x) => x.primitive))],
    // the count parameters, in the shape the illustrative catalogue calls phases: one repeat count each
    phases: authored.counts.map((c, index) => ({ id: `${id}:count:${index + 1}`, label: `${c.zh} · ${c.label}`, primitive: id, weight: 1 })),
    controls, ...(base.parameterBounds ? { parameterBounds: base.parameterBounds } : {}), defaults, source: SOURCE,
    card, counts: authored.counts.map((c) => ({ ...c })), stages,
    effect: { dose: authored.dose, reading: authored.reading, winds: authored.winds ?? false, loosensDeg: authored.loosensDeg ?? 0, needsDepthMm: authored.needsDepthMm ?? 0, seeks: authored.seeks ?? null },
  };
}

/** The 36 techniques as done. Same ids, contexts and families as the illustrative catalogue. */
export const OPERATIVE_TECHNIQUES: readonly OperativeTechnique[] = MANIPULATION_TECHNIQUE_IDS.map(build);
const BY_ID = new Map(OPERATIVE_TECHNIQUES.map((x) => [x.id, x]));
export function operativeTechnique(id: string): OperativeTechnique | null {
  return BY_ID.get(id as ManipulationTechniqueId) ?? null;
}

/** The catalogue an encounter runs on. */
export function techniqueCatalogue(model: TechniqueModel | undefined): readonly ManipulationTechnique[] {
  return model === "operative" ? OPERATIVE_TECHNIQUES : MANIPULATION_TECHNIQUES;
}
export function techniqueDefinition(model: TechniqueModel | undefined, id: string): ManipulationTechnique | null {
  return model === "operative" ? operativeTechnique(id) : manipulationTechnique(id);
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/** What is wrong with the counts a request gives for a technique of this catalogue (null: nothing). */
export function operationCountsError(definition: OperativeTechnique, settings: ManipulationMotionSettings = {}): string | null {
  if (settings.phaseCycles === undefined) return null;
  if (definition.counts.length < 2) return `phaseCycles does not apply to ${definition.id}: it has one count (${definition.counts[0]!.zh}, ${definition.counts[0]!.label}) — set cycles.`;
  return settings.phaseCycles.length === definition.counts.length ? null
    : `phaseCycles needs ${definition.counts.length} counts for ${definition.id}: ${definition.counts.map((c) => `${c.zh} (${c.label})`).join(", ")}.`;
}

function countsOf(definition: OperativeTechnique, settings: ManipulationMotionSettings): number[] {
  const canonical = definition.counts.map((c) => c.count);
  if (canonical.length === 1) return [Math.round(finite(settings.cycles, canonical[0]!, 1, 12))];
  if (Array.isArray(settings.phaseCycles) && settings.phaseCycles.length === canonical.length) return settings.phaseCycles.map((n, i) => Math.round(finite(n, canonical[i]!, 1, 12)));
  return settings.cycles === undefined ? canonical : canonical.map(() => Math.round(finite(settings.cycles, 3, 1, 12)));
}

/**
 * The settings a performance on the operative catalogue runs with: the catalogue's defaults under what was asked,
 * the method's own counts (九, 六 …) unless others were given, and — unless a duration was given — the time those
 * counts take at the tempo the method is taught at.
 */
export function resolveOperationMotion(id: ManipulationTechniqueId, settings: ManipulationMotionSettings = {}): ResolvedManipulationMotion {
  const definition = operativeTechnique(id) ?? OPERATIVE_TECHNIQUES[0]!;
  const { phaseCycles: _counts, travelMm: _travel, ...plain } = settings;
  const base = resolveMotionFor(definition, id, plain);
  const counts = countsOf(definition, settings);
  const motion: ResolvedManipulationMotion = {
    ...base, cycles: counts.length === 1 ? counts[0]! : base.cycles, ...(counts.length > 1 ? { phaseCycles: counts } : {}),
    ...(definition.controls.includes("travelMm") ? { travelMm: finite(settings.travelMm, definition.defaults.travelMm ?? 0, 0, 60) } : {}),
  };
  if (settings.durationMs === undefined || !Number.isFinite(settings.durationMs)) motion.durationMs = nominalMs(AUTHORED[id].program(counts, motion));
  return motion;
}

/** The stages of one performance with these settings. */
export function operationStages(id: ManipulationTechniqueId, settings?: ManipulationMotionSettings): OperationStage[] {
  const definition = operativeTechnique(id) ?? OPERATIVE_TECHNIQUES[0]!;
  const motion = resolveOperationMotion(definition.id, settings);
  return stagesOf(definition.id, AUTHORED[definition.id].program(countsOf(definition, motion), motion));
}

/* ------------------------------------------------------------------ */
/* What a performance does to the needle                               */
/* ------------------------------------------------------------------ */

/** One-way turning winds the tissue round the shaft (degrees): held from here, stuck from there, and never more than the cap. */
export const WINDING = { heldFromDeg: 180, stuckFromDeg: 540, capDeg: 1080 } as const;
export type NeedleHold = "free" | "held" | "stuck";
export const needleHold = (windingDeg: number | undefined): NeedleHold => {
  const w = Math.abs(windingDeg ?? 0);
  return w >= WINDING.stuckFromDeg ? "stuck" : w >= WINDING.heldFromDeg ? "held" : "free";
};

export interface OperationEffect {
  /** Simulated minutes the performance takes. */
  minutes: number;
  /** Stimulation it gives the needle it is done to. */
  dose: number;
  reading: TechniqueReading | null;
  /** Winding it adds: clockwise from the handle (thumb forward) positive. */
  windingDeg: number;
  /** Winding it lets go, whichever way the needle was wound. */
  loosensDeg: number;
  seeks: "warmth" | "coolness" | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What one performance with these settings does. The dose is the method's own at its canonical counts and default
 * amplitude, scaled by the square root of each ratio (twice the count is not twice the stimulus), at most 1.
 */
export function operationEffect(id: ManipulationTechniqueId, settings?: ManipulationMotionSettings): OperationEffect {
  const definition = operativeTechnique(id) ?? OPERATIVE_TECHNIQUES[0]!, authored = AUTHORED[definition.id];
  const motion = resolveOperationMotion(definition.id, settings);
  const counts = countsOf(definition, motion);
  const ratio = (value: number, canonical: number) => canonical > 0 ? Math.sqrt(Math.max(0, value) / canonical) : 1;
  const total = counts.reduce((a, b) => a + b, 0), canonical = definition.counts.reduce((a, c) => a + c.count, 0);
  const amplitude = authored.scalesWith ? ratio(motion[authored.scalesWith], definition.defaults[authored.scalesWith]) : 1;
  const dose = round3(Math.min(1, authored.dose * ratio(total, canonical) * amplitude));
  const turn = motion.direction === "counterclockwise" ? -1 : 1;
  return {
    minutes: Math.round((motion.durationMs / 60_000) * 100) / 100,
    dose, reading: authored.reading,
    windingDeg: authored.winds ? turn * counts[0]! * motion.rotationDeg : 0,
    loosensDeg: authored.loosensDeg ?? 0, seeks: authored.seeks ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* The sampler                                                         */
/* ------------------------------------------------------------------ */

export interface OperationSample extends TechniqueMotionSample {
  /** Where the tip stands, as a fraction of the depth the needle stands at (1: at that depth; never more). */
  depthFraction: number;
  stage: {
    index: number; id: string; zh: string; label: string; motif: StageMotif; level: DepthLevel | null;
    /** The repetition under way (1-based) of how many; 0 of 0 for a stage that is not counted. */
    count: number; of: number;
    breath: "inhale" | "exhale" | null;
    progress: number;
  };
  /** One-way turning that has stayed on the needle so far in this performance (radians, signed like rotationRad). */
  windingRad: number;
  /** How far along the channel the working hand is from the point (mm, along chart v): tracing and nipping. */
  travelMm: number;
  /** How far to the side of the point the working hand keeps (mm, along chart u): clear of a retained needle. */
  offsetMm: number;
}

/** A hand that strokes or nips along the channel of a retained needle keeps this far to the side of its entry. */
export const NEEDLE_CLEARANCE_MM = 12;

/** What a sampler is told of where the technique is done. */
export interface OperationContext {
  /** The depth the needle stands at (mm). Without one, a nominal 15 mm. */
  depthMm?: number;
  /** A surface technique done beside a retained needle: the pressing finger keeps clear of its entry. */
  besideNeedle?: boolean;
}

/** Clockwise seen from the handle is negative about the outward shaft axis (the renderer's convention). */
const CLOCKWISE = -1;
/** A stroke never takes the tip nearer the skin than this share of the depth the needle stands at, nor than 2 mm. */
const KEEP_IN = { fraction: 0.25, mm: 2 };
/** Rise, hold, fall — the shape of a press, a bow or a held push. */
const plateau = (t: number, rise = 0.25, fall = 0.25) => t < rise ? smooth(t / rise) : t > 1 - fall ? smooth((1 - t) / fall) : 1;
const programs = new Map<string, { motion: ResolvedManipulationMotion; stages: OperationStage[] }>();

function programFor(id: ManipulationTechniqueId, settings?: ManipulationMotionSettings): { motion: ResolvedManipulationMotion; stages: OperationStage[] } {
  const key = `${id}|${JSON.stringify(settings ?? {})}`;
  let hit = programs.get(key);
  if (!hit) {
    const definition = operativeTechnique(id) ?? OPERATIVE_TECHNIQUES[0]!;
    const motion = resolveOperationMotion(definition.id, settings);
    hit = { motion, stages: stagesOf(definition.id, AUTHORED[definition.id].program(countsOf(definition, motion), motion)) };
    if (programs.size > 256) programs.clear();
    programs.set(key, hit);
  }
  return hit;
}

/**
 * Where the needle and the hands are `elapsedMs` into a performance on the operative catalogue. Pure and
 * deterministic. `depthMm` is the depth the needle stands at: `withdrawalMm` is outward from it and includes the
 * level the stage is at, so a renderer that clamps it to the retained depth draws the levels with nothing else to
 * know. Lateral excursion and tilt are of the shaft outside the skin, and never exceed what the settings give.
 */
export function sampleOperation(id: ManipulationTechniqueId, elapsedMs: number, settings?: ManipulationMotionSettings, context: OperationContext = {}): OperationSample {
  const definition = operativeTechnique(id) ?? OPERATIVE_TECHNIQUES[0]!;
  const { motion, stages } = programFor(definition.id, settings);
  const depthMm = Math.max(0, Number.isFinite(context.depthMm) ? context.depthMm! : 15);
  const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs);
  const progress = clamp(elapsed / motion.durationMs);
  const complete = elapsed >= motion.durationMs;
  let index = stages.findIndex((x) => progress < x.end);
  if (index < 0) index = stages.length - 1;
  const stage = stages[index]!;
  const t = clamp((progress - stage.start) / Math.max(1e-9, stage.end - stage.start));
  const of = stage.count, turns = t * of, k = Math.min(of - 1, Math.floor(turns)), c = t >= 1 ? 1 : turns - Math.floor(turns);
  // winding already on the needle from the stages before this one
  let wound = 0;
  for (let i = 0; i < index; i++) if (stages[i]!.motif === "wind") wound += CLOCKWISE * stages[i]!.turn * rad(motion.rotationDeg * stages[i]!.rotation) * stages[i]!.count;
  const retained = definition.context === "retained";
  const out: OperationSample = {
    withdrawalMm: 0, rotationRad: 0, lateralMm: { u: 0, v: 0 }, tiltRad: { u: 0, v: 0 },
    grip: 0, gripEngagement: 1, contact: "none", nailContact: 0, supportContact: 0, handPose: "release",
    phase: { index, id: stage.id, label: stage.counted && of > 1 ? `${stage.zh} ${k + 1}/${of} · ${stage.label}` : `${stage.zh} · ${stage.label}`, primitive: stage.primitive, progress: t, cycleProgress: c },
    complete, durationMs: motion.durationMs,
    depthFraction: 1, windingRad: wound, travelMm: 0, offsetMm: 0,
    stage: { index, id: stage.id, zh: stage.zh, label: stage.label, motif: stage.motif, level: stage.level, count: stage.counted ? k + 1 : 0, of: stage.counted ? of : 0, breath: stage.breath, progress: t },
  };
  if (complete) {
    // a performance ends where it began — except for what one-way turning left on the needle
    out.windingRad = stages.reduce((sum, x) => sum + (x.motif === "wind" ? CLOCKWISE * x.turn * rad(motion.rotationDeg * x.rotation) * x.count : 0), 0);
    out.rotationRad = out.windingRad;
    return out;
  }
  if (elapsed === 0 || !Number.isFinite(progress)) return out;

  const stroke = motion.strokeMm * stage.stroke, arc = rad(motion.rotationDeg * stage.rotation);
  const lateral = motion.lateralMm * stage.lateral, tilt = rad(motion.tiltDeg * stage.tilt);
  // each stage comes to rest at its edges, so one stage hands the needle to the next without a jump
  const edge = smooth(Math.min(1, t * 10)) * smooth(Math.min(1, (1 - t) * 10));
  const gripEnvelope = smooth(Math.min(1, progress * 12)) * smooth(Math.min(1, (1 - progress) * 12));
  const sine = Math.sin(2 * Math.PI * c);
  out.grip = gripEnvelope;
  out.contact = retained ? "handle" : "skin";
  out.handPose = motion.grip === "three-finger" ? "tripod" : "pinch";
  out.supportContact = motion.support === "none" ? 0 : gripEnvelope;

  // the level, then a steady lean of the exposed shaft
  const fraction = stage.from + (stage.to - stage.from) * (stage.motif === "move" ? smooth(t) : t);
  out.depthFraction = clamp(fraction);
  const lean = { u: stage.leanFrom.u + (stage.leanTo.u - stage.leanFrom.u) * smooth(t), v: stage.leanFrom.v + (stage.leanTo.v - stage.leanFrom.v) * smooth(t) };
  const leans = stage.leanFrom.u !== 0 || stage.leanFrom.v !== 0 || stage.leanTo.u !== 0 || stage.leanTo.v !== 0;
  if (leans) {
    out.lateralMm.u = motion.lateralMm * lean.u; out.lateralMm.v = motion.lateralMm * lean.v;
    out.tiltRad.u = rad(motion.tiltDeg) * lean.u; out.tiltRad.v = rad(motion.tiltDeg) * lean.v;
  }
  let strokeOut = 0;

  switch (stage.motif) {
    case "hold":
      if (stage.primitive === "chuai") out.handPose = "palpate";
      else if (stage.primitive === "zhua") { out.handPose = "skin-nail"; out.nailContact = motion.contactIntensity * edge; }
      else if (stage.primitive === "men" || stage.primitive === "an") { out.handPose = "press"; out.supportContact *= motion.contactIntensity; }
      break;
    case "move":
      // a small twirl carries the needle from one level to the next; a turning thrust or lift turns one way and is let back
      if (arc > 0) out.rotationRad = stage.turn === 0 ? arc * Math.sin(4 * Math.PI * t) * edge : CLOCKWISE * stage.turn * arc * pulse(t, 0.6);
      break;
    case "stroke":
      strokeOut = stroke * pulse(c, stage.bias);
      // the thumb goes with the forceful half and is let back on the gentle one
      if (arc > 0 && stage.turn !== 0) out.rotationRad = CLOCKWISE * stage.turn * arc * (stage.bias >= 0.5 ? 1 - pulse(c, stage.bias) : pulse(c, stage.bias)) * edge;
      break;
    case "twirl":
      out.rotationRad = stage.turn === 0 ? arc * twistExcursion(c, stage.bias, "alternating") : CLOCKWISE * stage.turn * arc * pulse(c, 0.35);
      break;
    case "wind": {
      // roll, let go a little, take a fresh hold: what was rolled stays on the needle
      const rolled = k + smooth(c / 0.62);
      out.rotationRad = CLOCKWISE * stage.turn * arc * Math.min(of, rolled);
      out.gripEngagement = c > 0.62 && k < of - 1 ? 1 - 0.6 * Math.sin(Math.PI * (c - 0.62) / 0.38) : 1;
      break;
    }
    case "sway":
      out.lateralMm.u += lateral * sine * edge;
      out.tiltRad.u += tilt * sine * edge;
      break;
    case "orbit": {
      const way = motion.direction === "counterclockwise" ? -1 : 1, angle = 2 * Math.PI * (k + c) * way;
      out.lateralMm.u += lateral * Math.cos(angle) * edge; out.lateralMm.v += lateral * Math.sin(angle) * edge;
      out.tiltRad.u += tilt * Math.cos(angle) * edge; out.tiltRad.v += tilt * Math.sin(angle) * edge;
      break;
    }
    case "bow": {
      const held = plateau(c, 0.22, 0.22);
      out.lateralMm.u += lateral * held; out.tiltRad.u += tilt * held;
      break;
    }
    case "tremble":
      strokeOut = stroke * (0.5 - 0.5 * Math.cos(2 * Math.PI * c)) * edge;
      out.lateralMm.u += lateral * sine * edge; out.tiltRad.u += tilt * sine * edge;
      out.rotationRad = arc * sine * edge;
      break;
    case "flick": {
      // the finger is loaded behind the thumb, let go, and the shaft quivers and dies away
      const load = 0.28, after = clamp((c - load) / (1 - load));
      const quiver = c < load ? 0 : Math.sin(after * Math.PI * 8) * Math.exp(-5 * after) * Math.sin(Math.PI * after);
      out.contact = "nail-handle"; out.handPose = "flick";
      out.nailContact = c < load ? smooth(c / load) * edge : 0;
      out.lateralMm.u += lateral * quiver * edge; out.tiltRad.u += tilt * quiver * edge;
      break;
    }
    case "scrape": {
      // up the handle in contact, off, and back down
      const up = 0.7;
      out.contact = "nail-handle"; out.handPose = "scrape";
      out.nailContact = (c < up ? smooth(c / up) : 1 - smooth((c - up) / (1 - up))) * edge;
      out.lateralMm.v += lateral * (c < up ? Math.sin(c / up * Math.PI * 9) * Math.sin(Math.PI * c / up) : 0) * edge;
      break;
    }
    case "fly": {
      // three small twirls in the fingers, then they spring open and the needle quivers
      const take = 0.1, twirlEnd = 0.58, open = 0.7;
      const closed = smooth(c / take) * (1 - smooth((c - twirlEnd) / (open - twirlEnd)));
      out.gripEngagement = 1 - edge * (1 - closed);
      out.grip *= out.gripEngagement;
      const twirling = clamp((c - take) / (twirlEnd - take));
      out.rotationRad = CLOCKWISE * stage.turn * arc * pulse((twirling * 3) % 1, 0.4) * (twirling < 1 ? 1 : 0);
      const after = clamp((c - twirlEnd) / (1 - twirlEnd));
      const quiver = Math.sin(after * Math.PI * 7) * Math.exp(-4 * after) * Math.sin(Math.PI * after);
      out.lateralMm.u += motion.lateralMm * 0.2 * quiver * edge; out.tiltRad.u += rad(motion.tiltDeg) * 0.2 * quiver * edge;
      break;
    }
    case "rub":
      out.lateralMm.v += lateral * sine * edge;
      out.rotationRad = arc * sine * edge;
      break;
    case "push": {
      const held = plateau(c, 0.25, 0.25);
      out.rotationRad = CLOCKWISE * stage.turn * arc * held;
      out.supportContact = motion.support === "none" ? 0 : gripEnvelope * motion.contactIntensity;
      break;
    }
    case "stir":
      strokeOut = stroke * pulse(c, 0.4);
      out.lateralMm.u += lateral * sine * edge;
      break;
    case "lever": {
      // to one side, a pause, to the other
      const side = k % 2 === 0 ? 1 : -1, held = plateau(c, 0.3, 0.3);
      out.lateralMm.u += lateral * side * held; out.tiltRad.u += tilt * side * held;
      break;
    }
    case "knead":
      out.handPose = stage.primitive === "men" ? "press" : "palpate";
      if (stage.primitive === "men") out.supportContact *= motion.contactIntensity;
      // a small circle that starts and ends on the point
      out.lateralMm.u += lateral * 0.5 * sine * edge;
      out.lateralMm.v += lateral * 0.5 * (1 - Math.cos(2 * Math.PI * c)) * edge;
      break;
    case "nail": {
      // a line with the nail, then one across it: the cross
      const along = (2 * smooth(c) - 1) * lateral, held = plateau(c, 0.2, 0.2);
      out.handPose = "skin-nail";
      out.nailContact = held * motion.contactIntensity;
      if (k % 2 === 0) out.lateralMm.u += along * held; else out.lateralMm.v += along * held;
      break;
    }
    case "trace":
      out.handPose = "palpate";
      if (motion.travelMm !== undefined && stage.primitive === "xun") {
        out.travelMm = motion.travelMm * sine * edge;
        out.offsetMm = context.besideNeedle ? NEEDLE_CLEARANCE_MM : 0;
      } else out.lateralMm.v += lateral * sine * edge;
      break;
    case "nip": {
      // four stations along the channel: two below the point, two above
      const stations = [-1, -0.5, 0.5, 1], reach = motion.travelMm ?? 0;
      const here = stations[k % 4]! * reach, before = k === 0 ? here : stations[(k - 1) % 4]! * reach;
      const arrive = 0.3;
      out.handPose = "skin-nail";
      out.offsetMm = context.besideNeedle ? NEEDLE_CLEARANCE_MM : 0;
      out.travelMm = before + (here - before) * smooth(c / arrive);
      out.nailContact = c < arrive ? 0 : plateau((c - arrive) / (1 - arrive), 0.25, 0.3) * motion.contactIntensity;
      break;
    }
    case "press": {
      out.handPose = "press";
      out.supportContact = (motion.support === "none" ? 0 : gripEnvelope) * motion.contactIntensity * plateau(t, 0.15, 0.15);
      // beside the needle, on its channel, when there is a needle to keep clear of
      out.travelMm = context.besideNeedle ? motion.travelMm ?? 0 : 0;
      break;
    }
  }

  // the level and the stroke together, kept inside the patient and never deeper than the needle stands
  if (retained) {
    const keep = Math.min(KEEP_IN.mm, depthMm * KEEP_IN.fraction);
    const staged = stages.some((x) => x.from < 1 || x.to < 1);
    const room = staged ? Math.min(stroke, depthMm * 0.8 / 3) : stroke;
    const scaled = stroke > 0 ? strokeOut * room / stroke : 0;
    out.withdrawalMm = Math.min(Math.max(0, depthMm - keep), (1 - out.depthFraction) * depthMm + scaled);
  }
  out.rotationRad += wound;
  out.windingRad = stage.motif === "wind" ? out.rotationRad : wound;
  // shares of a whole, whatever the arithmetic above left in the last bit
  out.gripEngagement = clamp(out.gripEngagement); out.grip = clamp(out.grip);
  out.nailContact = clamp(out.nailContact); out.supportContact = clamp(out.supportContact);
  return out;
}

/* ------------------------------------------------------------------ */
/* Either catalogue                                                    */
/* ------------------------------------------------------------------ */

/** The settings a performance runs with, on the catalogue the encounter uses. */
export function resolveTechniqueMotion(model: TechniqueModel | undefined, id: ManipulationTechniqueId, settings?: ManipulationMotionSettings): ResolvedManipulationMotion {
  return model === "operative" ? resolveOperationMotion(id, settings) : resolveManipulationMotion(id, settings);
}

/** Where the needle and hands are, on the catalogue the encounter uses. Illustrative samples carry no level or stage. */
export function sampleManipulation(model: TechniqueModel | undefined, id: ManipulationTechniqueId, elapsedMs: number, settings?: ManipulationMotionSettings, context?: OperationContext): TechniqueMotionSample & Partial<Pick<OperationSample, "depthFraction" | "stage" | "windingRad" | "travelMm" | "offsetMm">> {
  return model === "operative" ? sampleOperation(id, elapsedMs, settings, context) : sampleTechnique(id, elapsedMs, settings);
}

/** Every technique of the schema has a card, a program and an entry: a mismatch is caught without I/O. */
export function operativeCatalogueComplete(): boolean {
  return OPERATIVE_TECHNIQUES.length === MANIPULATION_TECHNIQUE_IDS.length
    && MANIPULATION_TECHNIQUE_IDS.every((id) => BY_ID.has(id) && TECHNIQUE_CARDS[id] !== undefined && BY_ID.get(id)!.stages.length > 0);
}
