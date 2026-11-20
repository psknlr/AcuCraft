import { z } from "zod";
import { ChartPointSchema, RequestIdSchema as IdSchema, SideSchema } from "./common.js";

/** Stable catalogue IDs. Chinese names are metadata, so identically romanized terms remain unambiguous. */
export const MANIPULATION_TECHNIQUE_IDS = [
  "chuai", "zhua", "xun", "she", "yao", "pan", "nian", "cuo", "jin", "tui-withdraw", "ti", "cha",
  "gua", "tan", "fei", "mo", "dong", "tui-push", "chan", "nu", "an", "men", "sou", "bo",
  "shao-shan-huo", "tou-tian-liang", "qing-long-bai-wei", "bai-hu-yao-tou", "cang-gui-tan-xue",
  "chi-feng-ying-yuan", "long-hu-jiao-zhan", "zi-wu-dao-jiu", "yang-zhong-yin-yin", "yin-zhong-yin-yang",
  "bu", "xie",
] as const;
export const ManipulationTechniqueSchema = z.enum(MANIPULATION_TECHNIQUE_IDS);
export type ManipulationTechniqueId = z.infer<typeof ManipulationTechniqueSchema>;

/** Shared hand-presentation controls for insertion and retained-needle choreography. */
export const HandPresentationSettingsShape = {
  /** Hand/wrist elevation in the authored needle frame; does not change the clinical needle angle. */
  wristElevationDeg: z.number().min(35).max(70).optional(),
  gripStyle: z.enum(["tip-pinch", "side-pinch"]).optional(),
  idleFingerPose: z.enum(["curled", "relaxed"]).optional(),
};

/**
 * Bounded presentation parameters shared by operator controls and model tools. These are animation controls,
 * not clinical doses: they do not authorize deeper insertion, anatomical redirection, or force application.
 */
export const ManipulationMotionSettingsSchema = z.object({
  durationMs: z.number().int().min(400).max(30_000).optional(),
  /** Each primitive phase repeats this many times; durationMs is the complete performance duration. */
  cycles: z.number().int().min(1).max(12).optional(),
  /** For a compound, one repeat count per catalogue phase, in order. Omission uses cycles throughout. */
  phaseCycles: z.array(z.number().int().min(1).max(12)).min(2).max(4).optional(),
  strokeMm: z.number().min(0).max(3).optional(),
  rotationDeg: z.number().min(0).max(180).optional(),
  lateralMm: z.number().min(0).max(4).optional(),
  tiltDeg: z.number().min(0).max(8).optional(),
  tempoBias: z.number().min(0.2).max(0.8).optional(),
  direction: z.enum(["alternating", "clockwise", "counterclockwise"]).optional(),
  grip: z.enum(["two-finger", "three-finger"]).optional(),
  ...HandPresentationSettingsShape,
  support: z.enum(["none", "stabilize", "stretch", "pinch", "press"]).optional(),
  hand: z.enum(["auto", "left", "right"]).optional(),
  /** Approach/release opening; retained-needle contact fits the actual handle diameter independently. */
  gripApertureMm: z.number().min(0).max(12).optional(),
  /** Normalized visual contact intensity; never a measured or prescribed force. */
  contactIntensity: z.number().min(0).max(1).optional(),
  /**
   * How far along the channel a tracing or nipping hand travels each way from the point (循, 摄, 按). Used by the
   * operative catalogue only: an encounter on the illustrative catalogue refuses it.
   */
  travelMm: z.number().min(0).max(60).optional(),
}).strict();
export type ManipulationMotionSettings = z.infer<typeof ManipulationMotionSettingsSchema>;
/** Settings the illustrative catalogue never resolves, so its records keep the fields they were made with. */
type OperativeOnlySettings = "phaseCycles" | "travelMm";
export type ResolvedManipulationMotion = Required<Omit<ManipulationMotionSettings, OperativeOnlySettings>>
  & Pick<ManipulationMotionSettings, OperativeOnlySettings>;
/** Historical records keep their original 13 resolved fields unless the request uses new hand controls. */
export type RecordedManipulationMotion = Omit<ResolvedManipulationMotion, keyof typeof HandPresentationSettingsShape>
  & Pick<ManipulationMotionSettings, keyof typeof HandPresentationSettingsShape>;

/**
 * Which account of the 36 techniques an encounter runs on. `illustrative` (the default, and every record made before
 * the choice existed): a performance is shown and recorded, and changes nothing else. `operative`: a technique is
 * done to the needle — it takes its time, stimulates, reads as reinforcing or reducing, and can wind the tissue.
 */
export const TECHNIQUE_MODELS = ["illustrative", "operative"] as const;
export const TechniqueModelSchema = z.enum(TECHNIQUE_MODELS);
export type TechniqueModel = z.infer<typeof TechniqueModelSchema>;

/** The engine resolves the optional target against the technique's skin/retained/removed context. */
export const PerformTechniqueSchema = z.object({
  type: z.literal("perform_technique"),
  technique: ManipulationTechniqueSchema,
  needleId: IdSchema.optional(),
  mark: IdSchema.optional(),
  region: IdSchema.optional(),
  side: SideSchema.optional(),
  at: ChartPointSchema.extend({ u: z.number().finite(), v: z.number().finite() }).optional(),
  motion: ManipulationMotionSettingsSchema.optional(),
}).strict();
export type PerformTechniqueAction = z.infer<typeof PerformTechniqueSchema>;
