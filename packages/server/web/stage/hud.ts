import { Vector3, type PerspectiveCamera } from "three";
import type { CameraMode, Quality } from "./types.js";

/**
 * What is drawn over the 3D view, as in a game's heads-up display: where the patient is and how they are, the
 * encounter's clock, the language model at work, subtitles of what is said, a caption for each action with who
 * did it, a label on each needle, the retention timer, and the camera's controls. Plain DOM (text nodes only).
 */

type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "llm";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chip(text: string, tone: Tone = "muted"): HTMLElement {
  const c = el("span", `hud-chip ${tone}`);
  c.appendChild(el("i", "hud-dot"));
  c.appendChild(document.createTextNode(text));
  return c;
}

export interface HudControls {
  camera(mode: CameraMode): void;
  shot(name: "room" | "patient" | "needle"): void;
  quality(q: Quality | "auto"): void;
  picture(): void;
  fullscreen(): void;
  pick(needle: string | null): void;
}

export interface HudStatus {
  room: string;
  position: string;
  appearance: string;
  consent: string;
  minute: number;
  visit: string;
  agent: string | null;
  closed: boolean;
  needles: number;
  retention: { elapsed: number; total: number } | null;
}

export class Hud {
  readonly root = el("div", "stage-hud");
  private readonly tl = el("div", "hud-tl");
  private readonly tr = el("div", "hud-tr");
  private readonly sub = el("div", "hud-sub");
  private readonly caption = el("div", "hud-caption");
  private readonly labels = el("div", "hud-labels");
  private readonly timer = el("div", "hud-timer");
  private readonly tools = el("div", "hud-tools");
  private readonly loading = el("div", "stage-loading");
  private readonly fader = el("div", "stage-fade");
  private readonly note = el("div", "hud-note", "Schematic figure: positions on the body are drawn approximately");
  /** Seen from afar, the needles' labels give way to one badge: how many are in. */
  private readonly cluster = el("button", "hud-cluster");
  private readonly labelEls = new Map<string, HTMLElement>();
  private subTimer = 0;
  private capTimer = 0;
  private modeButton: HTMLButtonElement;
  private qualitySelect: HTMLSelectElement;
  private last = "";

  constructor(private readonly controls: HudControls) {
    this.root.append(this.labels, this.cluster, this.tl, this.tr, this.caption, this.sub, this.timer, this.tools, this.note, this.fader, this.loading);
    this.cluster.type = "button";
    this.cluster.title = "the needles: a closer look";
    this.cluster.addEventListener("click", () => this.controls.shot("needle"));
    const spin = el("div", "stage-spinner");
    this.loading.append(spin, el("p", "", "Setting up the room…"));
    this.labels.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-needle]") as HTMLElement | null;
      this.controls.pick(t?.dataset.needle ?? null);
    });
    const button = (label: string, title: string, on: () => void) => {
      const b = el("button", "hud-btn", label);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", on);
      return b;
    };
    this.modeButton = button("Auto camera", "the camera follows what happens (drag to take it)", () => this.controls.camera(this.modeButton.dataset.mode === "auto" ? "free" : "auto"));
    this.modeButton.dataset.mode = "auto";
    this.qualitySelect = el("select", "hud-select");
    this.qualitySelect.setAttribute("aria-label", "rendering quality");
    for (const [v, t] of [["auto", "Quality: auto"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]] as const) {
      const o = el("option", "", t);
      o.value = v;
      this.qualitySelect.appendChild(o);
    }
    this.qualitySelect.addEventListener("change", () => this.controls.quality(this.qualitySelect.value as Quality | "auto"));
    this.tools.append(
      this.modeButton,
      button("Room", "the whole room", () => this.controls.shot("room")),
      button("Patient", "the patient", () => this.controls.shot("patient")),
      button("Needle", "the latest needle", () => this.controls.shot("needle")),
      button("⤓", "save a picture of the view", () => this.controls.picture()),
      button("⛶", "full screen", () => this.controls.fullscreen()),
      this.qualitySelect,
    );
  }

  ready(): void {
    this.loading.classList.add("done");
    window.setTimeout(() => this.loading.remove(), 900);
  }

  failed(message: string): void {
    this.loading.replaceChildren(el("p", "", message));
    this.loading.classList.add("failed");
  }

  setMode(mode: CameraMode): void {
    this.modeButton.dataset.mode = mode;
    this.modeButton.textContent = mode === "auto" ? "Auto camera" : "Free camera";
    this.modeButton.classList.toggle("on", mode === "auto");
  }

  setQuality(q: Quality, auto: boolean): void {
    this.qualitySelect.value = auto ? "auto" : q;
    this.qualitySelect.options[0]!.textContent = auto ? `Quality: auto (${q})` : "Quality: auto";
  }

  /** A quick fade through white (a cut to another room or position). */
  dip(): void {
    this.fader.classList.remove("on");
    void this.fader.offsetWidth;
    this.fader.classList.add("on");
  }

  status(s: HudStatus): void {
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    const faint = /faint|grey|dizzy/.test(s.appearance);
    const appearanceTone: Tone = faint ? "bad" : /anxious|tense/.test(s.appearance) ? "warn" : "ok";
    this.tl.replaceChildren(
      chip(s.room, "info"),
      chip(s.position, "muted"),
      chip(s.appearance, appearanceTone),
      chip(`consent: ${s.consent}`, s.consent === "given" ? "ok" : s.consent === "none" ? "muted" : "warn"),
    );
    const clock = el("span", "hud-clock");
    clock.append(el("i", s.closed ? "hud-live off" : "hud-live"), document.createTextNode(`min ${s.minute.toFixed(s.minute % 1 ? 1 : 0)}`));
    const items: HTMLElement[] = [clock, chip(s.visit, "muted")];
    if (s.agent && ["thinking", "awaiting-approval", "paused"].includes(s.agent)) {
      const a = chip(s.agent === "thinking" ? "LLM working" : s.agent === "awaiting-approval" ? "LLM awaits approval" : "LLM paused", "llm");
      if (s.agent === "thinking") a.classList.add("pulse");
      items.push(a);
    }
    if (s.closed) items.push(chip("closed", "muted"));
    this.tr.replaceChildren(...items);
    if (s.needles > 0) {
      const ring = el("span", "hud-ring");
      const frac = s.retention ? Math.min(1, s.retention.elapsed / Math.max(1, s.retention.total)) : 0;
      ring.style.setProperty("--p", String(Math.round(frac * 100)));
      ring.classList.toggle("due", frac >= 1);
      const text = s.retention ? `${s.needles} needle${s.needles === 1 ? "" : "s"} in · ${Math.floor(s.retention.elapsed)} of ${s.retention.total} min` : `${s.needles} needle${s.needles === 1 ? "" : "s"} in`;
      this.timer.replaceChildren(ring, el("span", "", text));
      this.timer.classList.add("on");
    } else this.timer.classList.remove("on");
  }

  /** A line said, as a subtitle for as long as it takes to say it. */
  say(who: string, text: string, ms: number): void {
    window.clearTimeout(this.subTimer);
    this.sub.replaceChildren(el("b", "", `${who}: `), document.createTextNode(text.length > 260 ? `${text.slice(0, 260)}…` : text));
    this.sub.classList.add("on");
    this.subTimer = window.setTimeout(() => this.sub.classList.remove("on"), ms + 1200);
  }

  /** What was just done, by whom (the record's timeline, as it grows). */
  action(by: string, kind: "operator" | "llm" | "mcp", text: string, status: string): void {
    window.clearTimeout(this.capTimer);
    const who = el("span", `hud-by ${kind}`, by);
    const st = el("span", `hud-status ${status === "executed" ? "ok" : status === "partial" ? "warn" : "bad"}`, status);
    this.caption.replaceChildren(who, el("span", "hud-what", text), st);
    this.caption.classList.remove("on");
    void this.caption.offsetWidth;
    this.caption.classList.add("on");
    this.capTimer = window.setTimeout(() => this.caption.classList.remove("on"), 5200);
  }

  /** Put each needle's label where its handle is on the screen. */
  place(anchors: { id: string; target: string; at: Vector3; inserted: number; highlight: boolean }[], camera: PerspectiveCamera, w: number, h: number): void {
    const keep = new Set(anchors.map((a) => a.id));
    for (const [id, e] of this.labelEls) {
      if (keep.has(id)) continue;
      e.remove();
      this.labelEls.delete(id);
    }
    const v = new Vector3();
    const seen: { x: number; y: number; far: number }[] = [];
    const shown: { e: HTMLElement; x: number; y: number; w: number; fade: number; a: (typeof anchors)[number] }[] = [];
    for (const a of anchors) {
      let e = this.labelEls.get(a.id);
      if (!e) {
        e = el("button", "hud-label");
        (e as HTMLButtonElement).type = "button";
        e.dataset.needle = a.id;
        const { name, side } = labelOf(a.target);
        e.append(el("b", "", name));
        if (side) e.append(document.createTextNode(` ${side}`));
        this.labels.appendChild(e);
        this.labelEls.set(a.id, e);
      }
      v.copy(a.at).project(camera);
      const dist = camera.position.distanceTo(a.at);
      // each needle's own label close to; from further off, the badge
      const fade = Math.max(0, Math.min(1, (1.75 - dist) / 0.45)) * Math.min(1, a.inserted * 1.5);
      if (v.z <= 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) seen.push({ x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, far: 1 - fade });
      if (v.z > 1 || fade <= 0.02) {
        e.style.opacity = "0";
        e.style.pointerEvents = "none";
        continue;
      }
      if (!e.dataset.w) e.dataset.w = String(e.offsetWidth || 56);
      shown.push({ e, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, w: Number(e.dataset.w), fade, a });
    }
    // the badge: where the needles are on screen, as they fade from their own labels
    const farOff = seen.length ? seen.reduce((t, s) => t + s.far, 0) / seen.length : 0;
    if (seen.length && farOff > 0.35) {
      const cx = seen.reduce((t, s) => t + s.x, 0) / seen.length, top = Math.min(...seen.map((s) => s.y));
      this.cluster.textContent = `${anchors.length} needle${anchors.length === 1 ? "" : "s"} in`;
      this.cluster.style.transform = `translate(${cx.toFixed(1)}px, ${(top - 10).toFixed(1)}px) translate(-50%, -100%)`;
      this.cluster.style.opacity = String(Math.min(1, (farOff - 0.35) / 0.3));
      this.cluster.style.pointerEvents = "auto";
    } else {
      this.cluster.style.opacity = "0";
      this.cluster.style.pointerEvents = "none";
    }
    // labels that would cover one another are lifted, each on a longer leader back to its needle
    shown.sort((p, q) => q.y - p.y);
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const H = 22;
    for (const s of shown) {
      let lift = 6;
      for (let tries = 0; tries < 12; tries++) {
        const box = { x0: s.x - s.w / 2 - 3, x1: s.x + s.w / 2 + 3, y0: s.y - lift - H, y1: s.y - lift };
        const hit = placed.find((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
        if (!hit) break;
        lift = s.y - hit.y0 + 3;
      }
      placed.push({ x0: s.x - s.w / 2 - 3, x1: s.x + s.w / 2 + 3, y0: s.y - lift - H, y1: s.y - lift });
      s.e.style.transform = `translate(${s.x.toFixed(1)}px, ${(s.y - lift).toFixed(1)}px) translate(-50%, -100%)`;
      s.e.style.setProperty("--lead", `${Math.round(lift)}px`);
      s.e.style.opacity = String(s.a.highlight ? 1 : s.fade);
      s.e.style.pointerEvents = "auto";
      s.e.classList.toggle("hl", s.a.highlight);
    }
  }
}

/** A needle's label: its point and side (`ST36:left` → ST36 L; an ashi point by its own name). */
export function labelOf(target: string): { name: string; side: string } {
  if (target.startsWith("ashi:")) {
    const id = target.slice(5);
    return { name: "ashi", side: /left/.test(id) ? "L" : /right/.test(id) ? "R" : "" };
  }
  const [point, side] = target.split(":");
  return { name: point || target, side: side === "left" ? "L" : side === "right" ? "R" : "" };
}
