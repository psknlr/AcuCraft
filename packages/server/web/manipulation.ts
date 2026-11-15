import { api, type ActAnswer, type EncounterSnapshot } from "./api.js";
import { h, replace } from "./dom.js";
import type { JsonSchema } from "./schema.js";

export interface TechniqueDefinition {
  id: string;
  zh: string;
  label: string;
  family: string;
  context: "skin" | "retained" | "removed";
  needsNeedle: boolean;
  description: string;
  evidence: string;
  controls?: readonly string[];
  source?: { id: string; review: string; note: string };
}
export interface TechniqueLibrary {
  techniques: readonly TechniqueDefinition[];
  defaults: Record<string, Record<string, string | number>>;
  motionSchema: JsonSchema;
  note: string;
}
export interface TechniquePreview {
  technique: string;
  needleId?: string;
  mark?: string;
  region?: string;
  side?: string;
  at?: { u: number; v: number };
  motion?: Record<string, string | number>;
}
export interface TechniquePlayback {
  mode: "record" | "preview" | "idle";
  playing: boolean;
  progress: number;
  speed: number;
  technique: string | null;
  phase: string | null;
  durationMs: number;
  reachWarning?: string | null;
}
export interface TechniqueDraft {
  technique: string;
  motion: Record<string, string | number>;
  needleId: string;
  mark: string;
  region: string;
  side: string;
  u: string;
  v: string;
}

/** A new selection copies shared defaults; live snapshots never replace this operator-owned draft. */
export function techniqueDraft(library: TechniqueLibrary, id: string, previous?: TechniqueDraft): TechniqueDraft {
  return {
    technique: id, motion: { ...library.defaults[id] },
    needleId: previous?.needleId ?? "", mark: previous?.mark ?? "", region: previous?.region ?? "", side: previous?.side ?? "left",
    u: previous?.u ?? "0", v: previous?.v ?? "0",
  };
}

/** Client feedback uses exactly the bounds supplied by the engine's schema; the engine validates again on Execute. */
export function motionErrors(motion: Record<string, unknown>, schema: JsonSchema): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(motion)) {
    const rule = schema.properties?.[key];
    if (!rule) { errors.push(`Unknown parameter: ${key}`); continue; }
    if (rule.enum) {
      if (!rule.enum.includes(value as string)) errors.push(`${key}: choose one of ${rule.enum.join(", ")}`);
    } else if (rule.type === "number" || rule.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${key}: enter a finite number`);
      else if (rule.type === "integer" && !Number.isInteger(value)) errors.push(`${key}: enter a whole number`);
      else if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) errors.push(`${key}: use ${rule.minimum ?? "−∞"} to ${rule.maximum ?? "∞"}`);
    }
  }
  return errors;
}

/** Build one action from the visible draft without supplying a hidden patient location or choosing a different needle. */
export function techniqueInput(draft: TechniqueDraft, definition: TechniqueDefinition): TechniquePreview {
  const input: TechniquePreview = { technique: draft.technique, motion: { ...draft.motion } };
  if (definition.context !== "skin" || definition.needsNeedle) {
    if (!draft.needleId) throw new Error("请选择针具 · Choose a needle.");
    input.needleId = draft.needleId;
  }
  if (definition.context === "skin") {
    if (draft.mark) input.mark = draft.mark;
    else {
      const u = Number(draft.u), v = Number(draft.v);
      if (!draft.region || !draft.side || !draft.u.trim() || !draft.v.trim() || !Number.isFinite(u) || !Number.isFinite(v)) throw new Error("请选择标记，或填写区域、侧别和坐标 · Choose a mark or enter a complete chart site.");
      input.region = draft.region;
      input.side = draft.side;
      input.at = { u, v };
    }
  }
  return input;
}

export function answerMessage(answer: ActAnswer): string {
  const output = answer.output as { message?: unknown; error?: unknown } | null;
  return answer.entry?.message || (typeof output?.message === "string" ? output.message : typeof output?.error === "string" ? output.error : answer.ok ? "已执行并记录 · Executed and recorded." : "执行被拒绝 · The action was refused.");
}

const LABELS: Record<string, [string, string?]> = {
  durationMs: ["总时长 Total duration", "ms"], cycles: ["每阶段循环 Cycles per phase"], strokeMm: ["轴向幅度 Axial stroke", "mm"],
  rotationDeg: ["旋转幅度 Rotation", "°"], lateralMm: ["外露针身位移 Lateral motion", "mm"], tiltDeg: ["外露针身倾角 Tilt", "°"],
  tempoBias: ["提插时相比 Phase balance"], direction: ["旋转方向 Direction"], grip: ["持针方式 Grip"], support: ["辅助手 Support"],
  hand: ["主操作手 Main hand"], gripApertureMm: ["接近与释放开口 Opening", "mm"], contactIntensity: ["接触表现 Contact intensity"],
};
const VALUES: Record<string, string> = {
  alternating: "往返 Alternating", clockwise: "顺时针 Clockwise", counterclockwise: "逆时针 Counterclockwise",
  "two-finger": "二指 Two fingers", "three-finger": "三指 Three fingers", none: "无 None", stabilize: "稳定 Stabilize",
  stretch: "牵张 Stretch", pinch: "捏持 Pinch", press: "按压 Press", auto: "自动 Auto", left: "左 Left", right: "右 Right",
};
const CONTEXT: Record<string, string> = { skin: "皮肤接触 Skin contact", retained: "留针操作 Retained needle", removed: "出针后 Post-withdrawal" };
const FAMILIES: Record<string, string> = {
  contact: "接触与触诊 · Contact", axial: "提插与进退 · Axial", rotation: "捻转与搓摩 · Rotation", orientation: "摇盘与方向 · Orientation",
  handle: "针柄接触 · Handle", modulation: "微动与形变 · Modulation", compound: "复式手法 · Compound", "bu-xie": "补泻 · Bu / Xie",
};
const REGIONS: Record<string, string> = {
  lumbar: "腰部 Lumbar", "upper-back": "上背 Upper back", "sacrum-buttock": "骶臀 Sacrum / buttock", chest: "胸部 Chest", abdomen: "腹部 Abdomen",
  "neck-anterior": "颈前 Anterior neck", "neck-shoulder": "颈肩 Neck / shoulder", face: "面部 Face", scalp: "头顶部 Scalp", "head-lateral": "头侧 Lateral head",
  "upper-arm": "上臂 Upper arm", forearm: "前臂 Forearm", "hand-palm": "手掌 Palm", "hand-dorsum": "手背 Hand dorsum", thigh: "大腿 Thigh",
  "knee-leg": "膝腿 Knee / leg", foot: "足部 Foot", sole: "足底 Sole",
};

export interface ManipulationControls {
  el: HTMLElement;
  update(snapshot: EncounterSnapshot): void;
  playback(state: TechniquePlayback): void;
  dispose(): void;
}
interface Hooks {
  preview(request: TechniquePreview): void | Promise<void>;
  playback(state: { paused?: boolean; speed?: number; progress?: number }): void;
  cancelPreview(): void;
}

/** Debounced local-only edits. It has no action API and cannot execute or record a treatment. */
export function previewParameterUpdates(hooks: {
  read(): TechniquePreview;
  state(): TechniquePlayback;
  preview(request: TechniquePreview): void | Promise<void>;
  restore(state: { paused: boolean; speed: number; progress: number }): void;
  error(error: unknown): void;
  applied?(): void;
}, delayMs = 80): { schedule(): void; cancel(): void; replacing(): boolean; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0, applying = 0, disposed = false;
  const cancel = () => {
    generation++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule() {
      cancel();
      if (disposed || hooks.state().mode !== "preview") return;
      let request: TechniquePreview;
      try { request = hooks.read(); }
      catch (error) { hooks.error(error); return; }
      const scheduled = generation;
      timer = setTimeout(() => {
        timer = null;
        if (disposed || generation !== scheduled || hooks.state().mode !== "preview") return;
        const before = { ...hooks.state() };
        applying++;
        let attempted = false;
        // Replacing a preview can briefly publish idle before the new clip is installed. Keep that internal
        // transition separate from a user cancellation or a newly authoritative recorded animation.
        void Promise.resolve().then(() => {
          if (disposed || generation !== scheduled || hooks.state().mode !== "preview") return;
          attempted = true;
          return hooks.preview(request);
        }).then(() => {
          if (!attempted) return;
          if (disposed || generation !== scheduled || hooks.state().mode !== "preview") return;
          hooks.restore({ progress: before.progress, paused: !before.playing, speed: before.speed });
          hooks.applied?.();
        }).catch((error: unknown) => {
          if (!disposed && generation === scheduled) hooks.error(error);
        }).finally(() => { applying--; });
      }, delayMs);
    },
    cancel,
    replacing: () => applying > 0,
    dispose() { disposed = true; cancel(); },
  };
}

/** Shared-schema parameter studio. Preview stays local; Execute is the same attributed action used by an LLM. */
export function manipulationControls(id: string, hooks: Hooks): ManipulationControls {
  const badge = h("span", { class: "manipulation-mode", role: "status" }, "记录场景 · Record");
  const summary = h("summary", null, h("span", null, "精细手法控制 · Technique studio"), badge);
  const el = h("details", { class: "manipulation-studio", open: true }, summary);
  const introduction = h("p", { class: "manipulation-intro" }, "预览不会改变病历；执行和移动由模拟引擎核验并记录。操作者与 LLM 使用相同参数。", h("br"), "Preview stays local. Execute and Move closer validate and record actions.");
  const mode = h("select", { "aria-label": "操作类别 Action category" }, h("option", { value: "technique" }, "手法 Manipulation"), h("option", { value: "insertion" }, "进针 Insertion"));
  const technique = h("select", { "aria-label": "针刺手法 Acupuncture technique" });
  const description = h("p", { class: "manipulation-description" });
  const provenance = h("p", { class: "manipulation-provenance" }, "示意动画 · Illustrative choreography");
  const context = h("span", { class: "manipulation-context" });
  const needle = h("select", { "aria-label": "操作针具 Needle" });
  const mark = h("select", { "aria-label": "定位标记 Mark" });
  const region = h("select", { "aria-label": "身体区域 Region" });
  const side = h("select", { "aria-label": "侧别 Side" }, ["left", "right", "midline"].map((s) => h("option", { value: s }, VALUES[s] ?? "中线 Midline")));
  const u = h("input", { type: "number", step: "0.1", value: "0", "aria-label": "区域坐标 u cm" });
  const v = h("input", { type: "number", step: "0.1", value: "0", "aria-label": "区域坐标 v cm" });
  const needleField = field("针具 Needle", needle);
  const markField = field("标记 Mark", mark);
  const explicitSite = h("div", { class: "manipulation-site-grid" }, field("区域 Region", region), field("侧别 Side", side), field("u (cm)", u), field("v (cm)", v));
  const targets = h("div", { class: "manipulation-targets" }, needleField, markField, explicitSite);
  const parameters = h("div", { class: "manipulation-parameters" });
  const insertion = h("div", { class: "manipulation-insertion" });
  const insertionNumbers = {
    depthCm: numberPair("进针深度 Depth", "cm", 0.01, 10, 0.01, 1),
    angleDeg: numberPair("与皮肤法线夹角 Angle", "°", 0, 90, 1, 0),
    azimuthDeg: numberPair("区域方向 Azimuth", "°", 0, 360, 1, 0),
    durationMs: numberPair("插入动画时长 Duration", "ms", 400, 8000, 100, 1100),
    gripApertureMm: numberPair("进针接近与释放开口 Insertion opening", "mm", 0, 12, 0.1, 2),
  };
  const insertionChoices = {
    grip: choice("进针持针方式 Insertion grip", ["two-finger", "three-finger"], "two-finger"),
    support: choice("进针辅助手 Insertion support", ["none", "stabilize", "stretch", "pinch", "press"], "stabilize"),
    hand: choice("进针主操作手 Insertion main hand", ["auto", "left", "right"], "auto"),
  };
  insertion.append(...Object.values(insertionNumbers).map((p) => p.el), ...Object.values(insertionChoices).map((p) => p.el));
  const status = h("p", { class: "manipulation-status", role: "status", "aria-live": "polite" }, "正在读取手法目录 · Loading techniques…");
  const preview = h("button", { type: "button", class: "manipulation-preview" }, "本地预览 Preview");
  const execute = h("button", { type: "button", class: "manipulation-execute" }, "执行并记录 Execute");
  const approach = h("button", { type: "button", class: "manipulation-approach", title: "沿碰撞规划路径移动至目标部位附近 · Plan a walk within 0.75 m of the target region" }, "移动靠近 Move closer");
  const reset = h("button", { type: "button" }, "恢复默认 Reset");
  const stopPreview = h("button", { type: "button" }, "返回记录 Return to record");
  const play = h("button", { type: "button", "aria-label": "暂停或继续动画 Pause or play animation" }, "暂停 Pause");
  const speed = h("select", { "aria-label": "播放速度 Playback speed" }, [0.25, 0.5, 1, 1.5, 2].map((n) => h("option", { value: String(n), selected: n === 1 }, `${n}×`)));
  const seek = h("input", { type: "range", min: "0", max: "1", step: "0.001", value: "0", "aria-label": "播放进度 Playback progress" });
  const phase = h("output", { class: "manipulation-phase" }, "等待播放 · Ready");
  const transport = h("div", { class: "manipulation-transport" }, play, speed, seek, phase, stopPreview);
  const recorded = h("div", { class: "manipulation-recorded" });
  el.append(introduction, h("div", { class: "manipulation-selection" }, field("操作 Action", mode), field("手法 Technique", technique), context), description, provenance, targets, parameters, insertion,
    h("p", { class: "manipulation-intro" }, "持针时指腹自动贴合针柄；开口控制接近与释放，松手保留必要间隙。", h("br"), "Held fingers fit the handle. Opening controls approach/release, with clearance when letting go."),
    h("div", { class: "manipulation-actions" }, preview, execute, approach, reset), transport, status, recorded);

  let library: TechniqueLibrary | null = null;
  let draft: TechniqueDraft | null = null;
  let snapshot: EncounterSnapshot | null = null;
  let closed = false, busy = false, gone = false, scrubbing = false;
  let lastPlayback: TechniquePlayback = { mode: "idle", playing: false, progress: 0, speed: 1, technique: "", phase: "", durationMs: 0 };
  let targetSignature = "", recordSignature = "";
  const parameterFields = new Map<string, { el: HTMLElement; inputs: (HTMLInputElement | HTMLSelectElement)[] }>();
  const previewUpdates = previewParameterUpdates({
    read: () => input(),
    state: () => lastPlayback,
    preview: (request) => hooks.preview(request),
    restore: (state) => hooks.playback(state),
    error: showError,
    applied: () => {
      if (!gone) { status.textContent = "预览参数已更新；播放位置保持不变 · Preview updated at the current playback position."; status.classList.remove("refused"); }
    },
  });

  function field(label: string, control: HTMLElement): HTMLLabelElement {
    return h("label", { class: "manipulation-field" }, h("span", null, label), control);
  }
  function choice(label: string, values: string[], initial: string) {
    const select = h("select", { "aria-label": label }, values.map((value) => h("option", { value }, VALUES[value] ?? value)));
    select.value = initial;
    return { el: field(label, select), input: select };
  }
  function numberPair(label: string, unit: string, minimum: number, maximum: number, step: number, initial: number) {
    const range = h("input", { type: "range", min: minimum, max: maximum, step, value: initial, "aria-label": `${label} slider` });
    const number = h("input", { type: "number", min: minimum, max: maximum, step, value: initial, "aria-label": `${label}${unit ? ` (${unit})` : ""}` });
    const output = h("span", { class: "manipulation-unit" }, unit);
    const el = field(label, h("span", { class: "manipulation-number-pair" }, range, number, output));
    range.addEventListener("input", () => { number.value = range.value; number.dispatchEvent(new Event("change", { bubbles: true })); });
    number.addEventListener("input", () => { if (Number.isFinite(number.valueAsNumber)) range.value = number.value; });
    return { el, range, number };
  }
  const definition = () => library?.techniques.find((t) => t.id === draft?.technique);
  function cancelLocalPreview(): void {
    previewUpdates.cancel();
    if (lastPlayback.mode === "preview") hooks.cancelPreview();
  }
  function changed(): void {
    if (!draft) return;
    draft.needleId = needle.value; draft.mark = mark.value; draft.region = region.value; draft.side = side.value; draft.u = u.value; draft.v = v.value;
    cancelLocalPreview();
    availability();
  }
  function motionChanged(): void {
    if (!draft) return;
    // Parameter edits preserve the local inspection point. Target and technique changes still cancel it.
    if (lastPlayback.mode === "preview") previewUpdates.schedule();
    availability();
  }
  function availability(): void {
    const entry = definition(), insertionMode = mode.value === "insertion";
    const disabled = busy || closed || !library;
    for (const control of Array.from(el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"))) control.disabled = disabled;
    // Playback remains local and may inspect a closed record; it never reopens the encounter.
    for (const control of [play, speed, seek, stopPreview]) control.disabled = busy || lastPlayback.mode === "idle";
    seek.disabled = busy || lastPlayback.mode !== "preview";
    stopPreview.disabled = busy || lastPlayback.mode !== "preview";
    preview.disabled = busy || !library || insertionMode || lastPlayback.mode === "record";
    execute.disabled = disabled || !snapshot;
    needleField.hidden = !insertionMode && entry?.context === "skin" && !entry.needsNeedle;
    markField.hidden = !insertionMode && entry?.context !== "skin";
    explicitSite.hidden = insertionMode || entry?.context !== "skin" || !!mark.value;
    insertion.hidden = !insertionMode;
    parameters.hidden = insertionMode;
    technique.disabled = disabled || insertionMode;
    context.textContent = insertionMode ? "建立针路 · Insertion path" : CONTEXT[entry?.context ?? ""] ?? "";
    description.textContent = insertionMode ? "深度与方向由模拟引擎核验；持针和辅助手参数控制插入动画。Depth and direction are checked by the encounter engine." : entry?.description ?? "";
    provenance.textContent = insertionMode ? "动画参数不改变核准针路 · Animation settings do not change the approved path." : "示意动作，尚未实测校准 · Illustrative choreography, not measurement-calibrated.";
    const controls = entry?.controls;
    for (const [key, field] of parameterFields) field.el.hidden = !!controls?.length && !controls.includes(key);
  }
  function drawParameters(): void {
    if (!library || !draft) return;
    parameterFields.clear(); replace(parameters);
    for (const [key, schema] of Object.entries(library.motionSchema.properties ?? {})) {
      const [label, unit = ""] = LABELS[key] ?? [key];
      if (schema.enum) {
        const control = choice(label, schema.enum.map(String), String(draft.motion[key] ?? schema.default ?? schema.enum[0]));
        control.input.addEventListener("change", () => { if (draft) draft.motion[key] = control.input.value; motionChanged(); });
        parameters.append(control.el); parameterFields.set(key, { el: control.el, inputs: [control.input] });
      } else if (schema.type === "number" || schema.type === "integer") {
        const step = schema.type === "integer" ? key === "durationMs" ? 100 : 1 : key === "tempoBias" || key === "contactIntensity" ? 0.01 : key.endsWith("Deg") ? 1 : 0.1;
        const control = numberPair(label, unit, schema.minimum ?? 0, schema.maximum ?? 1, step, Number(draft.motion[key] ?? schema.default ?? schema.minimum ?? 0));
        const update = () => { if (draft) draft.motion[key] = control.number.value.trim() ? control.number.valueAsNumber : NaN; motionChanged(); };
        control.number.addEventListener("change", update);
        control.number.addEventListener("input", update);
        parameters.append(control.el); parameterFields.set(key, { el: control.el, inputs: [control.range, control.number] });
      }
    }
    availability();
  }
  function preserveOptions(select: HTMLSelectElement, options: { value: string; label: string; disabled?: boolean }[], initial = ""): void {
    const selected = select.value || initial;
    replace(select, h("option", { value: "" }, "— 请选择 Choose —"), options.map((o) => h("option", { value: o.value, disabled: o.disabled }, o.label)));
    if (selected && !options.some((o) => o.value === selected)) select.append(h("option", { value: selected }, `${selected} · 已不可用 / Unavailable`));
    select.value = selected;
  }
  function drawTargets(): void {
    if (!snapshot || !draft) return;
    const view = snapshot.view, entry = definition(), insertionMode = mode.value === "insertion";
    const needles = insertionMode ? view.equipment.needles.filter((n) => !n.used && !n.contaminated && view.you.holding.includes(n.id)).map((n) => ({ value: n.id, label: `${n.id} · ${n.where}` }))
      : view.needling.filter((n) => entry?.context === "removed" ? !n.inPlace && n.withdrawn === true : n.inPlace).map((n) => ({ value: n.needle, label: `${n.needle} · ${n.target}${n.inPlace ? " · 留针 In place" : " · 已出针 Removed"}` }));
    const marks = view.localisation.marks.map((m) => ({ value: m.id, label: `${m.id} · ${m.target}${m.stale ? " · 需重新定位 Stale" : ""}`, disabled: m.stale }));
    const regions = view.patient.reachable.map((r) => ({ value: r.region, label: REGIONS[r.region] ?? r.region }));
    const signature = JSON.stringify([mode.value, entry?.context, needles, marks, regions]);
    if (signature === targetSignature) return;
    targetSignature = signature;
    preserveOptions(needle, needles, draft.needleId); preserveOptions(mark, marks, draft.mark); preserveOptions(region, regions, draft.region);
    draft.needleId = needle.value; draft.mark = mark.value; draft.region = region.value;
  }
  function input(): TechniquePreview {
    if (!draft || !library || !definition()) throw new Error("手法目录尚未就绪 · Techniques are not ready.");
    const errors = motionErrors(draft.motion, library.motionSchema);
    if (errors.length) throw new Error(errors[0]);
    return techniqueInput(draft, definition()!);
  }
  function insertionInput(): Record<string, unknown> {
    if (!needle.value || !mark.value) throw new Error("请选择手中未使用针具和有效定位标记 · Choose a held unused needle and a valid mark.");
    const values = Object.fromEntries(Object.entries(insertionNumbers).map(([key, pair]) => [key, pair.number.valueAsNumber]));
    for (const pair of Object.values(insertionNumbers)) if (!pair.number.checkValidity() || !Number.isFinite(pair.number.valueAsNumber)) throw new Error("请检查进针参数范围 · Check the insertion parameter bounds.");
    return { needleId: needle.value, mark: mark.value, depthCm: values.depthCm, angleDeg: values.angleDeg, azimuthDeg: values.azimuthDeg, presentation: {
      durationMs: values.durationMs, gripApertureMm: values.gripApertureMm, ...Object.fromEntries(Object.entries(insertionChoices).map(([key, c]) => [key, c.input.value])),
    } };
  }
  function showError(error: unknown): void {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("refused");
  }
  for (const control of [needle, mark, region, side, u, v]) control.addEventListener("change", changed);
  mode.addEventListener("change", () => { cancelLocalPreview(); targetSignature = ""; drawTargets(); availability(); });
  technique.addEventListener("change", () => {
    if (!library) return;
    cancelLocalPreview(); draft = techniqueDraft(library, technique.value, draft ?? undefined); targetSignature = ""; drawParameters(); drawTargets(); availability();
  });
  reset.addEventListener("click", () => {
    if (!library || !draft) return;
    cancelLocalPreview(); draft = techniqueDraft(library, draft.technique, draft); drawParameters();
    for (const [key, value] of Object.entries({ depthCm: 1, angleDeg: 0, azimuthDeg: 0, durationMs: 1100, gripApertureMm: 2 })) {
      const pair = insertionNumbers[key as keyof typeof insertionNumbers]; pair.number.value = pair.range.value = String(value);
    }
    insertionChoices.grip.input.value = "two-finger"; insertionChoices.support.input.value = "stabilize"; insertionChoices.hand.input.value = "auto";
    status.textContent = "已恢复当前手法默认参数 · Shared defaults restored."; status.classList.remove("refused");
  });
  preview.addEventListener("click", () => {
    if (busy || !library) return;
    previewUpdates.cancel();
    try {
      const request = input();
      Promise.resolve(hooks.preview(request)).then(() => { if (!gone) { status.textContent = "本地预览中；病历未改变 · Local preview; record unchanged."; status.classList.remove("refused"); } }, showError);
    } catch (error) { showError(error); }
  });
  execute.addEventListener("click", () => {
    if (busy || closed || !snapshot) return;
    let body: Record<string, unknown>;
    try { body = mode.value === "insertion" ? insertionInput() : input() as unknown as Record<string, unknown>; }
    catch (error) { showError(error); return; }
    cancelLocalPreview(); busy = true; availability(); status.textContent = "正在核验并执行 · Validating and executing…";
    void api.act(id, mode.value === "insertion" ? "insert_needle" : "perform_technique", body).then((answer) => {
      if (!gone) { status.textContent = answerMessage(answer); status.classList.toggle("refused", !answer.ok); }
    }).catch(showError).finally(() => { busy = false; if (!gone) availability(); });
  });
  approach.addEventListener("click", () => {
    if (busy || closed || !snapshot || !draft) return;
    const view = snapshot.view;
    const entry = definition();
    const onNeedle = mode.value !== "insertion" && entry?.context !== "skin";
    const needleSite = onNeedle ? view.needling.find((n) => n.needle === needle.value)?.placement : null;
    const markSite = !onNeedle ? view.localisation.marks.find((m) => m.id === mark.value && !m.stale) : null;
    const target = needleSite ?? markSite ?? (!onNeedle && region.value ? { region: region.value, side: side.value } : null);
    if (!target) { showError(new Error("请先选择针具或定位部位 · Choose a needle or body site first.")); return; }
    cancelLocalPreview(); busy = true; availability();
    status.textContent = "正在规划靠近路径 · Planning a closer stance…";
    void api.act(id, "move", { to: { region: target.region, side: target.side, within: 0.75 } }).then((answer) => {
      if (!gone) { status.textContent = answerMessage(answer); status.classList.toggle("refused", !answer.ok); }
    }).catch(showError).finally(() => { busy = false; if (!gone) availability(); });
  });
  play.addEventListener("click", () => hooks.playback({ paused: lastPlayback.playing }));
  speed.addEventListener("change", () => hooks.playback({ speed: Number(speed.value) }));
  seek.addEventListener("pointerdown", () => { scrubbing = true; });
  seek.addEventListener("pointerup", () => { scrubbing = false; });
  seek.addEventListener("input", () => hooks.playback({ progress: Number(seek.value) }));
  stopPreview.addEventListener("click", () => { cancelLocalPreview(); status.textContent = "已返回记录场景 · Returned to the record."; });
  availability();

  void api.act(id, "lookup", { topic: "techniques" }).then((answer) => {
    if (gone) return;
    if (!answer.ok) throw new Error(answerMessage(answer));
    const value = answer.output as TechniqueLibrary;
    if (!Array.isArray(value?.techniques) || !value.motionSchema?.properties || !value.defaults) throw new Error("无法读取手法参数目录 · Technique parameters could not be read.");
    library = value;
    const families = new Map<string, HTMLOptGroupElement>();
    for (const entry of library.techniques) {
      let group = families.get(entry.family);
      if (!group) { group = h("optgroup", { label: FAMILIES[entry.family] ?? entry.family }); families.set(entry.family, group); technique.append(group); }
      group.append(h("option", { value: entry.id }, `${entry.zh} · ${entry.label}`));
    }
    technique.value = library.techniques.some((t) => t.id === "nian") ? "nian" : library.techniques[0]?.id ?? "";
    draft = techniqueDraft(library, technique.value);
    drawParameters(); drawTargets(); availability();
    status.textContent = `${library.techniques.length} 种手法可调 · ${library.techniques.length} parameterized gestures. ${library.note ?? ""}`;
  }).catch((error) => { if (!gone) showError(error); });

  return {
    el,
    update(next) {
      snapshot = next; closed = next.summary.status !== "open";
      drawTargets(); availability();
      const latest = [...next.timeline].reverse().find((e) => e.tool === "perform_technique" && (e.status === "executed" || e.status === "partial"));
      const signature = latest ? `${latest.seq}|${latest.requestId}` : "";
      if (signature !== recordSignature) {
        recordSignature = signature; replace(recorded);
        if (latest) {
          const record = latest;
          const load = h("button", { type: "button", class: "small" }, "载入参数 Load parameters");
          load.addEventListener("click", () => {
            if (!library || typeof record.input.technique !== "string") return;
            mode.value = "technique"; technique.value = record.input.technique;
            draft = techniqueDraft(library, technique.value, draft ?? undefined);
            if (record.input.motion && typeof record.input.motion === "object") Object.assign(draft.motion, record.input.motion);
            draft.needleId = typeof record.input.needleId === "string" ? record.input.needleId : "";
            draft.mark = typeof record.input.mark === "string" ? record.input.mark : "";
            draft.region = typeof record.input.region === "string" ? record.input.region : "";
            draft.side = typeof record.input.side === "string" ? record.input.side : draft.side;
            const at = record.input.at as { u?: unknown; v?: unknown } | undefined;
            if (typeof at?.u === "number") draft.u = String(at.u);
            if (typeof at?.v === "number") draft.v = String(at.v);
            needle.value = draft.needleId; mark.value = draft.mark;
            region.value = draft.region; side.value = draft.side; u.value = draft.u; v.value = draft.v;
            cancelLocalPreview(); targetSignature = ""; drawParameters(); drawTargets(); availability();
          });
          recorded.append(h("span", null, `最近记录 Last recorded · ${record.by.name} · ${String(record.input.technique)}`), load);
        }
      }
    },
    playback(next) {
      if (next.mode === "record" || next.mode !== "preview" && !previewUpdates.replacing()) previewUpdates.cancel();
      lastPlayback = next;
      badge.textContent = next.mode === "preview" ? "仅预览 · Preview" : "记录场景 · Record";
      badge.classList.toggle("preview", next.mode === "preview");
      play.textContent = next.playing ? "暂停 Pause" : "继续 Play";
      if (!scrubbing) seek.value = String(Math.max(0, Math.min(1, next.progress)));
      if (document.activeElement !== speed) speed.value = String(next.speed);
      phase.textContent = `${next.phase || "等待播放 Ready"} · ${Math.round(next.progress * 100)}%${next.reachWarning ? ` · ${next.reachWarning}` : ""}`;
      availability();
    },
    dispose() { gone = true; previewUpdates.dispose(); hooks.cancelPreview(); },
  };
}
