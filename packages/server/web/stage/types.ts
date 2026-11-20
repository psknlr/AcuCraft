import type { AgentView } from "@acucraft/core";
import type { StageInfo, TimelineEntry } from "../../src/hub.js";

/**
 * What the 3D view of an encounter is drawn from: the record's own view and timeline (everything on the record —
 * where the patient is and how they lie, the marks, the needles — and nothing hidden) and how the people look
 * (`StageInfo`: what anyone in the room sees of them).
 */
export interface StageState {
  view: AgentView;
  timeline: TimelineEntry[];
  /** The language model's state when one works on the record ("thinking", "awaiting-approval" …), else null. */
  agent: string | null;
  /** The record is closed: it can be looked at, not changed. */
  closed: boolean;
}

export type { StageInfo, TimelineEntry, AgentView };

/** A place on the body as the record gives it: a chart of a region, the side, and (u, v) on it in cm. */
export interface ChartSite {
  region: string;
  side: string;
  u: number;
  v: number;
}

/** How a needle went in (`insert_needle`): where, and at what angle and depth. */
export interface NeedlePlan {
  needle: string;
  target: string;
  site: ChartSite;
  angleDeg: number;
  azimuthDeg: number;
  depthCm: number;
  /** The simulated minute it went in. */
  minute: number;
  by: TimelineEntry["by"];
}

/** Camera behaviour: shots chosen as the record changes, or the viewer's own. */
export type CameraMode = "auto" | "free";

/** Rendering quality: chosen from how fast frames are drawn, or set by the viewer. */
export type Quality = "high" | "medium" | "low";
