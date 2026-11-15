import { afterEach, describe, expect, it, vi } from "vitest";
import { MANIPULATION_TECHNIQUES, ManipulationMotionSettingsSchema, PerformTechniqueSchema, resolveManipulationMotion } from "@acucraft/core";
import { objectSchemaOf } from "../../agent/src/tools/schema.js";
import { answerMessage, motionErrors, previewParameterUpdates, techniqueDraft, techniqueInput, type TechniqueLibrary, type TechniquePlayback } from "../web/manipulation.js";

const library: TechniqueLibrary = {
  techniques: MANIPULATION_TECHNIQUES,
  defaults: Object.fromEntries(MANIPULATION_TECHNIQUES.map((entry) => [entry.id, resolveManipulationMotion(entry.id)])),
  motionSchema: objectSchemaOf(ManipulationMotionSettingsSchema),
  note: "Illustrative choreography.",
};

describe("the operator's shared technique parameters", () => {
  it("constructs valid tool input for every catalogue gesture using the same defaults and bounds as the engine", () => {
    for (const entry of library.techniques) {
      const draft = techniqueDraft(library, entry.id);
      draft.needleId = "pack-a.1";
      draft.mark = "mark-a";
      const input = techniqueInput(draft, entry);
      expect(motionErrors(input.motion!, library.motionSchema), entry.id).toEqual([]);
      expect(PerformTechniqueSchema.safeParse({ type: "perform_technique", ...input }).success, entry.id).toBe(true);
      expect(input).not.toHaveProperty("forceN");
      expect(input).not.toHaveProperty("depthCm");
    }
  });

  it("keeps operator changes separate from shared defaults and preserves target choices when a technique changes", () => {
    const draft = techniqueDraft(library, "nian");
    draft.motion.rotationDeg = 47;
    draft.needleId = "pack-a.4";
    draft.mark = "m4";
    draft.region = "lumbar";
    draft.side = "right";
    draft.u = "4.2";
    draft.v = "-3.1";
    expect(library.defaults.nian!.rotationDeg).toBe(90);
    const next = techniqueDraft(library, "gua", draft);
    expect(next).toMatchObject({ needleId: "pack-a.4", mark: "m4", region: "lumbar", side: "right", u: "4.2", v: "-3.1" });
    expect(next.motion).toEqual(library.defaults.gua);
    next.motion.rotationDeg = 13;
    expect(draft.motion.rotationDeg).toBe(47);
  });

  it("uses the marked site or complete explicit chart coordinates without selecting a hidden or arbitrary target", () => {
    const entry = library.techniques.find((e) => e.id === "chuai")!;
    const draft = techniqueDraft(library, entry.id);
    expect(() => techniqueInput(draft, entry)).toThrow(/Choose a mark/);
    draft.region = "lumbar"; draft.side = "left"; draft.u = "3.5"; draft.v = "-2.4";
    expect(techniqueInput(draft, entry)).toMatchObject({ region: "lumbar", side: "left", at: { u: 3.5, v: -2.4 } });
    draft.mark = "m1";
    const marked = techniqueInput(draft, entry);
    expect(marked.mark).toBe("m1");
    expect(marked).not.toHaveProperty("region");
    expect(marked).not.toHaveProperty("at");
    draft.mark = ""; draft.u = "";
    expect(() => techniqueInput(draft, entry)).toThrow(/Choose a mark/);
  });

  it("requires an explicit needle for retained and post-withdrawal gestures", () => {
    for (const id of ["nian", "men"]) {
      const entry = library.techniques.find((e) => e.id === id)!;
      const draft = techniqueDraft(library, id);
      expect(() => techniqueInput(draft, entry)).toThrow(/Choose a needle/);
      draft.needleId = "pack-a.1";
      expect(techniqueInput(draft, entry).needleId).toBe("pack-a.1");
    }
  });

  it("reports invalid values instead of silently clamping the operator's draft", () => {
    for (const motion of [{ strokeMm: 3.1 }, { tiltDeg: -1 }, { cycles: 1.5 }, { durationMs: 30001 }, { rotationDeg: NaN }, { tempoBias: Infinity }, { direction: "unknown" }, { forceN: 2 }]) {
      expect(motionErrors(motion, library.motionSchema).length, JSON.stringify(motion)).toBeGreaterThan(0);
    }
    expect(motionErrors({ durationMs: 400, cycles: 12, strokeMm: 0, rotationDeg: 180, contactIntensity: 1 }, library.motionSchema)).toEqual([]);
  });

  it("surfaces an engine refusal or validation error in the operator's status", () => {
    expect(answerMessage({ ok: false, output: { error: "The needle is not retained." } })).toBe("The needle is not retained.");
    expect(answerMessage({ ok: false, output: { message: "Consent was withdrawn." } })).toBe("Consent was withdrawn.");
    expect(answerMessage({ ok: true, output: {} })).toMatch(/Executed and recorded/);
  });
});

describe("live local preview parameter editing", () => {
  afterEach(() => vi.useRealTimers());
  const playing = (): TechniquePlayback => ({ mode: "preview", playing: false, progress: 0.43, speed: 0.5, technique: "nian", phase: "rotation", durationMs: 2400 });

  it("coalesces slider edits and restores preview progress, pause and speed after replacing the clip", async () => {
    vi.useFakeTimers();
    let state = playing(), rotationDeg = 30;
    const restore = vi.fn();
    const preview = vi.fn(() => { state = { ...state, playing: true, progress: 0, speed: 1 }; });
    const updates = previewParameterUpdates({ read: () => ({ technique: "nian", needleId: "n1", motion: { rotationDeg } }), state: () => state, preview, restore, error: vi.fn() });
    updates.schedule();
    await vi.advanceTimersByTimeAsync(40);
    rotationDeg = 41; updates.schedule();
    await vi.advanceTimersByTimeAsync(40);
    rotationDeg = 47; updates.schedule();
    await vi.advanceTimersByTimeAsync(79);
    expect(preview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({ technique: "nian", needleId: "n1", motion: { rotationDeg: 47 } });
    expect(restore).toHaveBeenCalledWith({ progress: 0.43, paused: true, speed: 0.5 });
    updates.dispose();
  });

  it("keeps the last valid preview when a draft is outside the shared parameter bounds", async () => {
    vi.useFakeTimers();
    const preview = vi.fn(), error = vi.fn(), state = playing();
    const updates = previewParameterUpdates({
      read: () => { const errors = motionErrors({ rotationDeg: 181 }, library.motionSchema); if (errors.length) throw new Error(errors[0]); return { technique: "nian" }; },
      state: () => state, preview, restore: vi.fn(), error,
    });
    updates.schedule();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/rotationDeg/) }));
    await vi.runAllTimersAsync();
    expect(preview).not.toHaveBeenCalled();
    expect(state.mode).toBe("preview");
    updates.dispose();
  });

  it("does not restart a preview after a target change, new recorded playback, or disposal", async () => {
    vi.useFakeTimers();
    let state = playing();
    const preview = vi.fn(), restore = vi.fn();
    const updates = previewParameterUpdates({ read: () => ({ technique: "nian" }), state: () => state, preview, restore, error: vi.fn() });
    updates.schedule(); updates.cancel();
    await vi.runAllTimersAsync();
    expect(preview).not.toHaveBeenCalled();
    updates.schedule(); state = { ...state, mode: "record" };
    await vi.runAllTimersAsync();
    expect(preview).not.toHaveBeenCalled();
    state = playing(); updates.schedule(); updates.dispose();
    await vi.runAllTimersAsync();
    expect(preview).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not restore an asynchronous preview after its target was cancelled", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const restore = vi.fn(), preview = vi.fn(() => pending);
    const updates = previewParameterUpdates({ read: () => ({ technique: "nian" }), state: playing, preview, restore, error: vi.fn() });
    updates.schedule(); await vi.advanceTimersByTimeAsync(80);
    expect(updates.replacing()).toBe(true);
    updates.cancel(); complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(restore).not.toHaveBeenCalled();
    expect(updates.replacing()).toBe(false);
    updates.dispose();
  });
});
