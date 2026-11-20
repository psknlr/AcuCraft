/**
 * The client's types are the server's: imported as types only (the bundler refuses a value import from the engine),
 * so the page and the server can never disagree about a field, and nothing of the engine is compiled into the page.
 */
import type { AgentView, referenceLibrary } from "@acucraft/core";
import type { ActionSpec, FieldEntry, FieldSpec } from "../catalogue.js";
import type { SceneFixture, SceneOpening, StudioScene, StudioStage, TeachingNeedle, TeachingRegion } from "../scene.js";
import type { ActResult, AgentStatus, FeedItem, Snapshot, StudioEvent } from "../session.js";

export type { ActionSpec, ActResult, AgentStatus, AgentView, FeedItem, FieldEntry, FieldSpec, SceneFixture, SceneOpening, Snapshot, StudioEvent, StudioScene, StudioStage, TeachingNeedle, TeachingRegion };
export type Library = ReturnType<typeof referenceLibrary>;
export type Side = "left" | "right" | "midline";
export type NeedleView = AgentView["needling"][number];
/** A scenario family and the ids of its variants. */
export interface ScenarioInfo {
  id: string;
  title: string;
  condition: string | null;
  split: string;
  variants: string[];
}
export interface Probe {
  inChart: boolean;
  strata: { tissue: string; label: string; from: number; to: number; hazard: string | null }[];
  tipTissue: string;
  traversed: string[];
  executedDepthCm: number;
  verticalDepthCm: number;
  stoppedBy: string | null;
  critical: boolean;
  pleuraPenetrated: boolean;
  near: { label: string; kind: string; hazard: string; clearanceCm: number; contact: boolean }[];
}
