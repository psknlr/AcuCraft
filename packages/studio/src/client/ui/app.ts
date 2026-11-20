import { api, ApiError } from "../api.js";
import type { ActionSpec, FeedItem, Library, NeedleView, Probe, ScenarioInfo, SceneFixture, Side, Snapshot, StudioEvent, StudioScene, TeachingRegion } from "../types.js";
import { FieldView, type Gesture, type Ghost } from "../world/field.js";
import { QUALITIES, type Quality } from "../world/gfx.js";
import { ClinicStage, type CameraMode } from "../world/stage.js";
import { buildForm, type Form } from "./composer.js";
import { clock, debounce, fmt, h, replace, type Child } from "./dom.js";
import { depthPanel, feedPanel, needlesPanel, nowPanel, recordPanel, statusChip, summarise, talkPanel } from "./panels.js";

/**
 * The studio page: the clinic and the needling field in 3D, the forms that send actions, the record as it grows, and
 * the bar from which a model is attached, stepped, run and stopped. It holds no rule of its own: every button ends in
 * `act`, and what is shown is the snapshot the server sends back.
 */

const GROUP_TITLES: Record<string, string> = { consultation: "Consultation", decision: "Decision and consent", localisation: "Localisation", preparation: "Preparation", procedure: "Needling", completion: "Completion", team: "Team" };
/** Fields that belong to one act and are not carried to the next form of the same kind. */
const NOT_STICKY = new Set(["needleId", "mark", "target", "at", "text", "itemId", "findingId", "investigationId", "query", "object", "packId", "item", "taskId", "reason", "description", "summary", "rationale", "record", "plan", "note", "to", "patternEvidence", "diagnoses", "pattern", "redFlags", "region", "side", "landmark", "segment", "depthCm"]);

type Tab = "now" | "record" | "needles" | "talk" | "feed";

export class App {
  private snap!: Snapshot;
  private scene!: StudioScene;
  private actions: ActionSpec[] = [];
  private library!: Library;
  private scenarios: ScenarioInfo[] = [];
  private stage!: ClinicStage;
  private field!: FieldView;
  private form: Form | null = null;
  private formAction: Record<string, unknown> | null = null;
  private sticky: Record<string, Record<string, unknown>> = {};
  private chart: { region: string; side: Side } | null = null;
  private picked: { u: number; v: number } | null = null;
  private selected: string | null = null;
  private ghost: Ghost | null = null;
  private probe: Probe | null = null;
  private teaching = new Map<string, TeachingRegion>();
  private tab: Tab = "now";
  private layout: "clinic" | "field" = "clinic";
  private quality: Quality = "high";
  private live = false;
  private sendOnRelease = true;
  private followAction = true;
  private last = performance.now();
  private el!: Record<string, HTMLElement>;

  constructor(private root: HTMLElement) {}

  /* ---------------------------------------------------------------- */
  /* Start                                                             */
  /* ---------------------------------------------------------------- */

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const q = params.get("quality") as Quality | null;
    if (q && QUALITIES.includes(q)) this.quality = q;
    const [snap, scene, actions, library, scenarios] = await Promise.all([api.snapshot(), api.scene(), api.actions(), api.library(), api.scenarios()]);
    Object.assign(this, { snap, scene, actions, library, scenarios });
    this.shell();
    this.build();
    this.renderChartSelect();
    api.events(
      (e) => this.onEvent(e),
      (live) => {
        this.live = live;
        this.el.live!.className = `dot ${live ? "on" : "off"}`;
        this.el.live!.title = live ? "live" : "reconnecting…";
      },
    );
    this.apply(snap, []);
    // `?still`: frames are drawn on request only (a scripted check in a software renderer asks for the ones it needs)
    this.still = params.has("still");
    const loop = (t: number) => {
      // real time, so a walk takes as long on a slow machine as on a fast one (within reason)
      const dt = Math.min(0.25, (t - this.last) / 1000);
      this.last = t;
      if (this.still) {
        if (this.wanted > 0) {
          this.wanted--;
          this.stage.tick(this.stillDt);
          if (this.chart) this.field.tick(this.stillDt);
        }
      } else if (!document.hidden) {
        // the view that fills the page is drawn every frame; the inset every other one
        this.frame++;
        if (this.layout === "clinic" || this.frame % 2 === 0) this.stage.tick(this.layout === "clinic" ? dt : dt * 2);
        if (this.chart && (this.layout === "field" || this.frame % 2 === 1)) this.field.tick(this.layout === "field" ? dt : dt * 2);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new ResizeObserver(() => this.resize()).observe(this.el.views!);
    window.addEventListener("keydown", (e) => this.onKey(e));
    // a handle for scripted checks: the app, its views, and frames on request
    (window as unknown as { studio: unknown }).studio = {
      app: this,
      ready: true,
      frames: (n: number, dt = 0.25) => ((this.wanted = n), (this.stillDt = dt)),
      idle: () => this.wanted <= 0,
    };
  }
  private still = false;
  private wanted = 3;
  private stillDt = 0.25;
  private frame = 0;

  /** The 3D views, built for the scene in hand (a new clinic rebuilds them). */
  private build(): void {
    replace(this.el.clinic!);
    replace(this.el.field!, this.el.fieldHud!, this.el.fieldEmpty!);
    this.stage = new ClinicStage(
      this.el.clinic!,
      this.scene,
      {
        floor: (at) => this.popover([{ label: `Walk here (${fmt(at.x)}, ${fmt(at.z)})`, action: { type: "move", to: at }, primary: true }]),
        fixture: (f) => this.fixtureMenu(f),
        person: (id) => this.personMenu(id),
        site: (region, side) => this.siteMenu(region, side),
        hover: (text) => this.hover(text),
        quality: (q2, why) => this.qualityFell(q2, why),
      },
      this.quality,
    );
    this.field = new FieldView(
      this.el.field!,
      {
        hover: (at) => (this.el.cursor!.textContent = at ? `u ${fmt(at.u)} · v ${fmt(at.v)} cm` : ""),
        pick: (at) => this.pickOnChart(at),
        select: (id) => this.selectNeedle(id, false),
        working: (live) => (this.el.working!.textContent = live ? `lifting ${fmt(live.liftMm)} mm · turned ${Math.round(live.turnDeg)}° · ${fmt(live.seconds)} s` : ""),
        gesture: (g, why) => this.onGesture(g, why),
        quality: (q2, why) => this.qualityFell(q2, why),
      },
      this.quality,
    );
    if (new URLSearchParams(location.search).has("still")) this.stage.gfx.adaptive = this.field.gfx.adaptive = false;
    this.wanted = Math.max(this.wanted, 2);
    this.resize();
  }

  private shell(): void {
    const e: Record<string, HTMLElement> = {};
    const scenario = h("select", { title: "Scenario" });
    const families = new Map<string, ScenarioInfo[]>();
    for (const s of this.scenarios) families.set(s.family, [...(families.get(s.family) ?? []), s]);
    for (const [, list] of families) scenario.appendChild(h("optgroup", { label: list[0]!.title }, list.map((s) => h("option", { value: s.id }, `${s.variant}${s.split === "held-out" ? " (held out)" : ""}`))));
    const mode = h("select", { title: "Mode: teaching shows what lies beneath the skin and the reference locations" }, h("option", { value: "assessment" }, "assessment"), h("option", { value: "teaching" }, "teaching"));
    const seed = h("input", { type: "number", min: "1", value: "1", title: "Seed", class: "seed" });
    e.scenario = scenario;
    e.mode = mode;
    e.seed = seed;
    const cam = (m: CameraMode, text: string, title: string) => h("button", { title, onclick: () => (this.setLayout("clinic"), this.stage.setCamera(m)) }, text);
    const toggle = (text: string, title: string, on: boolean, f: (on: boolean) => void) => {
      const b = h("button", { class: `toggle${on ? " on" : ""}`, title });
      b.textContent = text;
      b.addEventListener("click", () => {
        const now = !b.classList.contains("on");
        b.classList.toggle("on", now);
        f(now);
      });
      return b;
    };
    e.xray = toggle("X-ray", "See through the skin (teaching mode)", false, (on) => this.field.setXray(on));
    const quality = h("select", { title: "Rendering quality", onchange: () => this.setQuality(quality.value as Quality) }, QUALITIES.map((x) => h("option", { value: x, selected: x === this.quality }, x)));
    e.quality = quality;
    e.top = h(
      "header",
      { id: "top" },
      h("div", { class: "brand" }, h("b", null, "AcuCraft"), " studio"),
      h("div", { class: "group" }, scenario, mode, seed, h("button", { onclick: () => this.newEncounter(), title: "Start this scenario from the beginning" }, "Start")),
      (e.status = h("div", { class: "status" })),
      h("div", { class: "spacer" }),
      (e.undo = h("button", { onclick: () => this.guard(() => api.undo()), title: "Take back the last action (teaching mode)" }, "Undo")),
      (e.report = h("button", { onclick: () => this.showReport() }, "Report")),
      (e.live = h("span", { class: "dot off" })),
    );
    e.viewbar = h(
      "div",
      { id: "viewbar" },
      h("div", { class: "group" }, cam("overview", "Overview", "The whole clinic, walls cut down"), cam("follow", "Follow", "Stay with the practitioner"), cam("shoulder", "Shoulder", "Over the practitioner's shoulder, in the room"), cam("plan", "Plan", "From straight above"), h("button", { title: "Look at the patient", onclick: () => (this.setLayout("clinic"), this.stage.lookAtPatient()) }, "Patient")),
      h(
        "div",
        { class: "group" },
        toggle("Sites", "Body sites on the patient: green within arm's reach", true, (on) => this.stage.setShow("sites", on)),
        toggle("Reach", "Rings round you: arm's reach, contact, earshot", false, (on) => this.stage.setShow("reach", on)),
        toggle("Labels", "Room names", true, (on) => this.stage.setShow("labels", on)),
        toggle("Grid", "The chart's centimetre grid", true, (on) => this.field.setGrid(on)),
        e.xray,
      ),
      quality,
    );
    e.palette = h("div", { id: "palette" });
    e.composer = h("div", { id: "composer" }, h("p", { class: "muted" }, "Choose an action, or click in the clinic: the floor, a fixture, a person, a body site."));
    e.left = h("aside", { id: "left" }, e.palette, e.composer);
    e.clinic = h("div", { id: "clinic", class: "view" });
    e.cursor = h("span", { class: "cursor" });
    e.working = h("span", { class: "working" });
    e.chartSelect = h("span", { class: "chartsel" });
    e.depth = h("div", { class: "depthslot" });
    e.fieldHud = h(
      "div",
      { class: "hud" },
      h("div", { class: "hudtop" }, e.chartSelect, e.cursor, h("label", { class: "check", title: "A needle worked by hand is sent as measured when it is let go" }, h("input", { type: "checkbox", checked: true, onchange: (ev: Event) => (this.sendOnRelease = (ev.target as HTMLInputElement).checked) }), "send on release")),
      e.depth,
      e.working,
      h("div", { class: "hint" }, "Click the skin to set a point · drag a needle along its line to lift and thrust, across it to twirl · drag elsewhere to orbit, wheel to zoom"),
    );
    e.fieldEmpty = h("div", { class: "empty" }, h("p", null, "The needling field"), h("small", null, "Click a body site on the patient, or choose a chart."));
    e.field = h("div", { id: "field", class: "view" });
    e.tip = h("div", { id: "tip" });
    e.pop = h("div", { id: "pop" });
    e.toast = h("div", { id: "toast" });
    e.swap = h("button", { id: "swap", title: "Swap the views (Tab)", onclick: () => this.setLayout(this.layout === "clinic" ? "field" : "clinic") }, "⇄");
    e.views = h("section", { id: "views", class: "clinic-main" }, e.clinic, e.field, e.viewbar, e.swap, e.tip, e.pop, e.toast);
    e.tabs = h("nav", { id: "tabs" });
    e.panel = h("div", { id: "panel" });
    e.right = h("aside", { id: "right" }, e.tabs, e.panel);
    e.agent = h("footer", { id: "agent" });
    e.modal = h("div", { id: "modal", onclick: (ev: Event) => ev.target === e.modal && e.modal!.classList.remove("open") });
    this.el = e;
    replace(this.root, e.top, h("main", null, e.left, e.views, e.right), e.agent, e.modal);
    e.views.addEventListener("pointerdown", (ev) => {
      if (!(ev.target as HTMLElement).closest("#pop")) this.closePopover();
    });
  }

  /* ---------------------------------------------------------------- */
  /* State in                                                          */
  /* ---------------------------------------------------------------- */

  private onEvent(e: StudioEvent): void {
    this.apply(e.snapshot, e.added);
  }

  private apply(s: Snapshot, added: FeedItem[]): void {
    const same = this.snap && s.session.id === this.snap.session.id;
    if (same && s.session.version < this.snap.session.version && added.length === 0 && s.feed.length >= this.snap.feed.length) return;
    const restarted = !this.snap || s.session.title !== this.snap.session.title || s.session.steps < this.snap.session.steps || s.session.mode !== this.snap.session.mode;
    this.snap = s;
    if (restarted && this.stage) {
      this.teaching.clear();
      this.chart = null;
      this.selected = null;
      this.ghost = null;
      this.field.setGhost(null);
      this.field.setXray(false);
      this.el.xray!.classList.remove("on");
      void this.refreshScene();
    }
    (this.el.scenario as HTMLSelectElement).value = this.scenarios.find((x) => x.family === s.session.family && (this.el.scenario as HTMLSelectElement).value === x.id)?.id ?? this.scenarios.find((x) => x.family === s.session.family)?.id ?? "";
    (this.el.mode as HTMLSelectElement).value = s.session.mode;
    (this.el.seed as HTMLInputElement).value = String(s.session.seed);
    this.stage.update(s);
    if (this.followAction) this.followChart(added);
    this.syncField();
    this.renderStatus();
    this.renderPalette();
    this.renderPanel();
    this.renderAgent();
    this.renderDepth();
    for (const f of added) if (f.actor === s.session.actor || s.session.mode === "teaching") this.toast(f);
    if (added.length && this.form) this.reopen();
  }

  /** A new scenario may be another clinic, another patient and other charts. */
  private async refreshScene(): Promise<void> {
    const [scene, library] = await Promise.all([api.scene(), api.library()]);
    const rebuilt = scene.facility !== this.scene.facility || scene.patient.name !== this.scene.patient.name || scene.cast.length !== this.scene.cast.length;
    this.scene = scene;
    this.library = library;
    if (rebuilt) {
      this.build();
      this.stage.update(this.snap);
    }
    this.renderChartSelect();
    this.syncField();
  }

  /** Show the chart the latest action was on. */
  private followChart(added: FeedItem[]): void {
    const v = this.snap.view;
    for (const f of added) {
      if (f.status === "rejected") continue;
      const a = f.action as Record<string, unknown>;
      let region = typeof a.region === "string" ? a.region : undefined;
      let side = typeof a.side === "string" ? (a.side as Side) : undefined;
      const needle = typeof a.needleId === "string" ? v.needling.find((n) => n.needle === a.needleId) : undefined;
      if (needle) [region, side] = [needle.site.region, needle.site.side as Side];
      const mark = typeof a.mark === "string" ? v.localisation.marks.find((m) => m.id === a.mark) : undefined;
      if (mark && !needle) [region, side] = [mark.region, mark.side as Side];
      if (region && side && ["identify_landmark", "measure", "mark_point", "prepare_site", "insert_needle", "adjust_needle", "check_sensation", "remove_needle", "apply_pressure"].includes(f.type)) {
        this.openChart(region, side, false);
        if (needle && needle.inPlace) this.selectNeedle(needle.needle, true);
      }
    }
  }

  private syncField(): void {
    const has = !!this.chart;
    this.el.fieldEmpty!.style.display = has ? "none" : "";
    if (!this.chart) return;
    const region = this.scene.regions.find((r) => r.id === this.chart!.region);
    if (!region) return;
    this.field.setChart(region, this.chart.side);
    this.field.update(this.snap.view, this.snap.teaching?.needles ?? []);
    this.field.select(this.selected);
    if (this.snap.session.mode === "teaching") void this.loadTeaching();
    else this.field.setTeachingRegion(null);
    this.el.xray!.style.display = this.snap.session.mode === "teaching" ? "" : "none";
  }

  private async loadTeaching(): Promise<void> {
    if (!this.chart) return;
    // the anatomy moves with the patient's position
    const key = `${this.chart.region}:${this.chart.side}:${this.snap.view.patient.position}`;
    let t = this.teaching.get(key);
    if (!t) {
      try {
        t = await api.teaching(this.chart.region, this.chart.side);
        this.teaching.set(key, t);
      } catch {
        return;
      }
    }
    if (this.chart && key.startsWith(`${this.chart.region}:${this.chart.side}:`)) this.field.setTeachingRegion(t);
  }

  openChart(region: string, side: Side, show = true): void {
    if (!this.scene.regions.some((r) => r.id === region)) return;
    const changed = !this.chart || this.chart.region !== region || this.chart.side !== side;
    this.chart = { region, side };
    if (changed) {
      this.selected = null;
      this.picked = null;
    }
    this.renderChartSelect();
    this.syncField();
    this.resize();
    if (show) this.setLayout("field");
  }

  /* ---------------------------------------------------------------- */
  /* Acting                                                            */
  /* ---------------------------------------------------------------- */

  private async guard<T>(f: () => Promise<T>): Promise<T | undefined> {
    try {
      return await f();
    } catch (e) {
      this.notice(e instanceof ApiError ? e.message : (e as Error).message, "bad");
      return undefined;
    }
  }

  /** Send an action. While the agent is acting this is a take-over: the agent is paused first. */
  async send(action: unknown): Promise<void> {
    this.closePopover();
    const running = this.snap.agent.running;
    try {
      const r = await api.act(action, { expectedVersion: this.snap.session.version, ...(running ? { takeover: true } : {}) });
      const a = action as Record<string, unknown>;
      if (typeof a.type === "string") this.sticky[a.type] = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "type" && !NOT_STICKY.has(k)));
      this.apply(r.snapshot, []);
    } catch (e) {
      this.notice(e instanceof ApiError ? e.message : (e as Error).message, "bad");
    }
  }

  private open(type: string, initial: Record<string, unknown> = {}): void {
    const spec = this.actions.find((a) => a.type === type);
    if (!spec) return;
    const start = { ...(this.sticky[type] ?? {}), ...initial };
    this.formAction = null;
    const error = h("p", { class: "error" });
    const go = h("button", { class: "primary", onclick: () => this.formAction && void this.send(this.formAction) }, "Do it");
    this.form = buildForm(spec, { view: this.snap.view, scene: this.scene, library: this.library }, start, (action, why) => {
      this.formAction = action;
      go.disabled = !action;
      error.textContent = action ? "" : (why ?? "");
      this.formChanged(action);
    });
    this.formInitial = initial;
    replace(
      this.el.composer!,
      h("div", { class: "formhead" }, h("h3", null, spec.title), h("code", null, spec.type), h("button", { class: "link", onclick: () => this.closeForm() }, "close")),
      this.form.el,
      error,
      h("div", { class: "row" }, go, this.snap.agent.running ? h("span", { class: "muted" }, "the agent is acting: this takes over") : null),
    );
    this.renderPalette();
    this.el.left!.classList.add("has-form");
    const first = this.form.el.querySelector<HTMLElement>("input[type=text], textarea:not(.raw)");
    if (first && ["say", "ask", "examine", "review_result", "order_investigation"].includes(type)) first.focus();
    if ((type === "mark_point" || type === "insert_needle" || type === "identify_landmark" || type === "measure" || type === "prepare_site") && typeof start.region === "string" && typeof start.side === "string") this.openChart(start.region, start.side as Side, false);
  }
  private formInitial: Record<string, unknown> = {};

  /** After a step the form is rebuilt on the new view, keeping what was being filled in. */
  private reopen(): void {
    if (!this.form) return;
    const keep = this.formAction ?? {};
    const type = this.form.type;
    const sent = this.snap.feed.at(-1);
    // what was just done is done: the same form opens clean, with its settings
    const fresh = sent && sent.type === type && sent.actor === this.snap.session.actor && sent.status !== "rejected";
    this.open(type, fresh ? Object.fromEntries(Object.entries(this.formInitial).filter(([k]) => ["region", "side"].includes(k))) : Object.fromEntries(Object.entries(keep).filter(([k]) => k !== "type")));
  }

  private closeForm(): void {
    this.form = null;
    this.formAction = null;
    this.setGhost(null);
    this.el.left!.classList.remove("has-form");
    replace(this.el.composer!, h("p", { class: "muted" }, "Choose an action, or click in the clinic: the floor, a fixture, a person, a body site."));
    this.renderPalette();
  }

  /** The form as it stands drives the ghost needle: where the insertion would go. */
  private formChanged(action: Record<string, unknown> | null): void {
    if (!action || action.type !== "insert_needle") return this.setGhost(null);
    const v = this.snap.view;
    const mark = typeof action.mark === "string" ? v.localisation.marks.find((m) => m.id === action.mark) : undefined;
    const at = (action.at as { u: number; v: number } | undefined) ?? (mark ? { u: mark.u, v: mark.v } : undefined);
    const region = mark?.region ?? (action.region as string | undefined);
    const side = (mark?.side ?? action.side) as Side | undefined;
    if (!at || !region || !side || typeof action.depthCm !== "number") return this.setGhost(null);
    if (!this.chart || this.chart.region !== region || this.chart.side !== side) this.openChart(region, side, false);
    this.setGhost({ u: at.u, v: at.v, angleDeg: (action.angleDeg as number | undefined) ?? 0, azimuthDeg: (action.azimuthDeg as number | undefined) ?? 0, depthCm: action.depthCm });
  }

  private setGhost(g: Ghost | null): void {
    this.ghost = g;
    this.probe = null;
    if (this.chart) {
      this.field.setGhost(g);
      this.field.setProbe(null, null);
      if (g) this.field.focus(g.u, g.v, 26);
    }
    this.renderDepth();
    if (g && this.snap.session.mode === "teaching") this.askProbe();
  }

  private askProbe = debounce(() => {
    const g = this.ghost;
    const c = this.chart;
    if (!g || !c) return;
    api
      .probe({ region: c.region, side: c.side, ...g })
      .then((p) => {
        if (this.ghost !== g) return;
        this.probe = p;
        this.field.setProbe(g, p);
        this.renderDepth();
      })
      .catch(() => undefined);
  }, 160);

  private pickOnChart(at: { u: number; v: number }): void {
    if (!this.chart) return;
    this.picked = at;
    if (this.form && (this.form.type === "mark_point" || this.form.type === "insert_needle")) {
      this.form.set("region", this.chart.region);
      this.form.set("side", this.chart.side);
      this.form.set("at", at);
      return;
    }
    const here = { region: this.chart.region, side: this.chart.side, at };
    this.popover([
      { label: `Mark a point here (u ${fmt(at.u)}, v ${fmt(at.v)})…`, run: () => this.open("mark_point", here), primary: true },
      { label: "Insert a needle here…", run: () => this.open("insert_needle", here) },
    ]);
  }

  private selectNeedle(id: string | null, fromPanel: boolean): void {
    this.selected = id;
    if (fromPanel && this.chart) this.field.select(id);
    const n = id ? this.snap.view.needling.find((x) => x.needle === id) : null;
    if (n && this.chart) this.field.focus(n.site.u, n.site.v, 22);
    if (this.tab === "needles") this.renderPanel();
    this.renderDepth();
  }

  private onGesture(g: Gesture | null, why?: string): void {
    if (!g) return this.notice(why ?? "the needle was not worked", "warn");
    const { needle, ...how } = g;
    const action = { type: "adjust_needle", needleId: needle, ...how };
    if (this.sendOnRelease) void this.send(action);
    else this.open("adjust_needle", { needleId: needle, ...how });
    this.notice(`${how.technique}${how.amplitudeMm ? ` ${how.amplitudeMm} mm` : ""}${how.arcDeg ? ` ${how.arcDeg}°` : ""}${how.frequencyPerMin ? ` at ${how.frequencyPerMin}/min` : ""} for ${how.durationSec} s${how.emphasis && how.emphasis !== "even" ? `, ${how.emphasis} emphasised` : ""}${how.direction && how.direction !== "both" ? `, ${how.direction}` : ""}`, "info");
  }

  /* ---------------------------------------------------------------- */
  /* Menus on the 3D views                                             */
  /* ---------------------------------------------------------------- */

  private pointer = { x: 0, y: 0 };

  private popover(items: { label: string; action?: unknown; run?: () => void; primary?: boolean }[]): void {
    const pop = this.el.pop!;
    replace(pop, items.map((i) => h("button", { class: i.primary ? "primary" : "", onclick: () => (this.closePopover(), i.run ? i.run() : void this.send(i.action)) }, i.label)));
    const r = this.el.views!.getBoundingClientRect();
    pop.style.left = `${Math.min(r.width - 250, Math.max(8, this.pointer.x - r.left + 10))}px`;
    pop.style.top = `${Math.min(r.height - 40 * items.length - 16, Math.max(8, this.pointer.y - r.top + 10))}px`;
    pop.classList.add("open");
  }

  private closePopover(): void {
    this.el.pop?.classList.remove("open");
  }

  private fixtureMenu(f: SceneFixture): void {
    if (!f.fixture) return;
    const fx = f.fixture;
    const reach = this.snap.view.space.fixtures.find((x) => x.id === fx.id);
    const items: Parameters<App["popover"]>[0] = [{ label: `Walk to the ${fx.label}`, action: { type: "move", to: { fixture: fx.id } }, primary: !reach?.inReach }];
    if (fx.kind === "hand-hygiene") items.push({ label: "Hand hygiene", action: { type: "hand_hygiene" }, primary: !!reach?.inReach });
    if (fx.kind === "supplies") items.push({ label: "Fetch…", run: () => this.open("fetch") });
    if (fx.kind === "trolley") items.push({ label: "Open a pack here…", run: () => this.open("open_pack") }, { label: "Pick up a needle…", run: () => this.open("pick_up") });
    if (fx.kind === "sharps-container") items.push({ label: "Dispose…", run: () => this.open("dispose") });
    if (fx.kind === "records-terminal") items.push({ label: "Review a result…", run: () => this.open("review_result") }, { label: "Write the record…", run: () => this.open("document") });
    if (fx.kind === "couch" || fx.kind === "chair") items.push({ label: "Position the patient…", run: () => this.open("position_patient") });
    this.popover(items);
  }

  private personMenu(id: string): void {
    if (id === this.snap.session.actor) return;
    if (id === "patient") {
      const sp = this.snap.view.space.patient;
      return this.popover([
        { label: "Walk to the patient", action: { type: "move", to: { person: "patient" } }, primary: !sp.atSide },
        { label: "Ask…", run: () => this.open("ask") },
        { label: "Observe", action: { type: "observe" } },
        { label: "Examine…", run: () => this.open("examine") },
        { label: "Vital signs", action: { type: "check_vitals" } },
        { label: "Position…", run: () => this.open("position_patient") },
        { label: "Monitor", action: { type: "monitor" } },
      ]);
    }
    const name = this.scene.cast.find((c) => c.id === id)?.name ?? id;
    this.popover([
      { label: `Walk to ${name}`, action: { type: "move", to: { person: id } }, primary: true },
      { label: "Say…", run: () => this.open("say", { to: id }) },
      { label: "Assign a task…", run: () => this.open("assign_task", { to: id }) },
    ]);
  }

  private siteMenu(region: string, side: Side): void {
    const key = `${region}:${side}`;
    const inReach = this.snap.view.space.patient.sites.inReach.includes(key);
    this.popover([
      ...(inReach ? [] : [{ label: "Walk to where it is within reach", action: { type: "move", to: { region, side } }, primary: true }]),
      { label: "Open its chart", run: () => this.openChart(region, side), primary: inReach },
      { label: "Palpate a landmark…", run: () => this.open("identify_landmark", { region, side }) },
      { label: "Measure…", run: () => this.open("measure", { region, side }) },
      { label: "Prepare the skin", action: { type: "prepare_site", region, side } },
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering the page                                                */
  /* ---------------------------------------------------------------- */

  private renderStatus(): void {
    const s = this.snap;
    const v = s.view;
    replace(
      this.el.status!,
      h("b", null, s.session.title),
      h("span", { class: `chip ${s.session.mode === "teaching" ? "info" : ""}` }, s.session.mode),
      h("span", null, `visit ${v.setting.visit}/${v.setting.visits} · ${v.setting.date}`),
      h("span", { class: "clock" }, `${clock(v.minute)}`),
      h("span", { class: "muted" }, `step ${s.session.steps} · v${s.session.version}`),
      s.session.finished ? h("span", { class: "chip ok" }, "finished") : null,
    );
    (this.el.undo as HTMLButtonElement).style.display = s.session.mode === "teaching" ? "" : "none";
    (this.el.undo as HTMLButtonElement).disabled = !s.session.canUndo;
    (this.el.report as HTMLButtonElement).disabled = !s.session.reportReady;
    this.el.report!.title = s.session.reportReady ? "The evaluator's report" : "The report is written when the encounter has finished";
  }

  private renderPalette(): void {
    const may = new Set(this.snap.view.you.may);
    const groups = new Map<string, ActionSpec[]>();
    for (const a of this.actions) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
    replace(
      this.el.palette!,
      [...groups].map(([g, list]) =>
        h(
          "div",
          { class: "pgroup" },
          h("h5", null, GROUP_TITLES[g] ?? g),
          h(
            "div",
            { class: "buttons" },
            list.map((a) => h("button", { class: this.form?.type === a.type ? "on" : "", disabled: !may.has(a.type) || this.snap.session.finished, title: `${a.summary}${may.has(a.type) ? "" : " — not within your role"}`, onclick: () => (a.fields.length === 0 ? void this.send({ type: a.type }) : this.open(a.type)) }, a.title)),
          ),
        ),
      ),
    );
  }

  private renderPanel(): void {
    const s = this.snap;
    const v = s.view;
    const tabs: [Tab, string][] = [
      ["now", "Now"],
      ["record", `Record ${v.record.history.length + v.record.examination.length + v.record.results.length + v.record.vitals.length + v.record.observations.length || ""}`],
      ["needles", `Needles ${v.needling.filter((n) => n.inPlace).length || ""}`],
      ["talk", "Talk"],
      ["feed", "Feed"],
    ];
    replace(this.el.tabs!, tabs.map(([id, text]) => h("button", { class: this.tab === id ? "on" : "", onclick: () => ((this.tab = id), this.renderPanel()) }, text.trim())));
    const scroll = this.el.panel!.scrollTop;
    let body: Child;
    if (this.tab === "now") body = nowPanel(s, (a) => void this.send(a));
    else if (this.tab === "record") body = recordPanel(v);
    else if (this.tab === "needles")
      body = needlesPanel(v, this.selected, {
        focus: (n) => this.focusNeedle(n),
        work: (n) => (this.focusNeedle(n), this.open("adjust_needle", { needleId: n.needle, technique: "lift-thrust" })),
        ask: (n) => void this.send({ type: "check_sensation", needleId: n.needle }),
        withdraw: (n) => this.open("remove_needle", { needleId: n.needle }),
      });
    else if (this.tab === "talk") body = talkPanel(v);
    else body = feedPanel(s.feed, (a) => this.open(String((a as { type: string }).type), Object.fromEntries(Object.entries(a as Record<string, unknown>).filter(([k]) => k !== "type"))));
    replace(this.el.panel!, body);
    this.el.panel!.scrollTop = this.tab === "talk" ? this.el.panel!.scrollHeight : scroll;
  }

  private focusNeedle(n: NeedleView): void {
    this.openChart(n.site.region, n.site.side as Side, true);
    this.selectNeedle(n.needle, true);
  }

  private renderChartSelect(): void {
    const region = h("select", { onchange: () => this.openChart(region.value, (side.value || "right") as Side, false) }, h("option", { value: "" }, "chart…"), this.scene.regions.map((r) => h("option", { value: r.id, selected: r.id === this.chart?.region }, r.title)));
    const def = this.scene.regions.find((r) => r.id === this.chart?.region);
    const sides = def?.laterality === "bilateral" ? ["left", "right"] : ["midline", "left", "right"];
    const side = h("select", { onchange: () => region.value && this.openChart(region.value, side.value as Side, false) }, sides.map((x) => h("option", { value: x, selected: x === this.chart?.side }, x)));
    replace(this.el.chartSelect!, region, side);
  }

  private renderDepth(): void {
    const slot = this.el.depth!;
    const teaching = this.snap.session.mode === "teaching";
    const length = 4;
    if (this.ghost) return replace(slot, depthPanel({ title: "The needle as the form has it", depthCm: this.ghost.depthCm, angleDeg: this.ghost.angleDeg, lengthCm: length }, teaching && this.probe ? this.probe.strata : null, teaching ? this.probe : null));
    const n = this.selected ? this.snap.view.needling.find((x) => x.needle === this.selected) : null;
    if (!n) return replace(slot);
    const t = this.snap.teaching?.needles.find((x) => x.needle === n.needle) ?? null;
    replace(slot, depthPanel({ title: `${n.needle} · ${n.target}`, depthCm: n.depthCm, angleDeg: n.angleDeg, lengthCm: length, feel: n.feel }, t ? t.strata : null, t));
  }

  private renderAgent(): void {
    const a = this.snap.agent;
    const pick = h("select", null, a.available.map((x) => h("option", { value: x.name, disabled: !x.ready, selected: x.name === a.name, title: x.why ?? "" }, `${x.label}${x.ready ? "" : ` — ${x.why}`}`)));
    const speed = h("input", { type: "range", min: "0", max: "3000", step: "100", value: String(a.stepDelayMs), title: "Pause between the agent's actions", onchange: () => void this.guard(() => api.agent({ stepDelayMs: Number(speed.value) })) });
    const attached = a.name !== null;
    const finished = this.snap.session.finished;
    replace(
      this.el.agent!,
      h("div", { class: "who" }, h("b", null, "Hands"), h("span", { class: `chip ${a.running ? "info" : "ok"}` }, a.running ? `agent: ${a.name}` : "you")),
      h(
        "div",
        { class: "group" },
        pick,
        attached ? h("button", { onclick: () => void this.guard(() => api.agent({ agent: null })) }, "Detach") : h("button", { class: "primary", onclick: () => void this.guard(() => api.agent({ agent: pick.value })) }, "Attach"),
      ),
      h(
        "div",
        { class: "group" },
        h("button", { disabled: !attached || a.running || a.busy || finished || !!a.pending, title: "Ask the agent what it would do next, without doing it", onclick: () => void this.guard(() => api.agentPropose()) }, "Propose"),
        h("button", { disabled: !attached || a.running || a.busy || finished, title: "One action of the agent", onclick: () => void this.guard(() => api.agentStep()) }, a.pending ? "Apply" : "Step"),
        a.running ? h("button", { class: "primary", onclick: () => void this.guard(() => api.agentPause()) }, "Pause") : h("button", { disabled: !attached || finished, onclick: () => void this.guard(() => api.agentRun()) }, "Run"),
        h("label", { class: "speed" }, "pace", speed),
      ),
      a.pending
        ? h(
            "div",
            { class: "pending" },
            h("span", { class: "muted" }, "proposes"),
            h("code", null, summarise(a.pending.action)),
            a.pending.note ? h("span", { class: "note" }, a.pending.note) : null,
            h("button", { class: "link", title: "Change it yourself: the proposal is dropped and the form opens with it", onclick: () => this.editProposal(a.pending!.action) }, "edit"),
            h("button", { class: "link", onclick: () => void this.guard(() => api.agentDiscard()) }, "discard"),
          )
        : h("div", { class: "pending" }, a.busy ? h("span", { class: "spin" }, "the agent is deciding…") : a.error ? h("span", { class: "error" }, a.error) : a.done ? h("span", null, a.note ?? "The agent has nothing more to do.") : attached ? h("span", { class: "muted" }, `${a.turns} action${a.turns === 1 ? "" : "s"} by ${a.name}${a.note ? ` · ${a.note}` : ""}`) : h("span", { class: "muted" }, "Attach an agent to let a model act here, or drive this session from outside: HTTP /api/session/act, or MCP with --attach.")),
    );
  }

  private editProposal(action: unknown): void {
    const a = action as Record<string, unknown>;
    void this.guard(() => api.agentDiscard());
    this.open(String(a.type), Object.fromEntries(Object.entries(a).filter(([k]) => k !== "type")));
  }

  /* ---------------------------------------------------------------- */
  /* Small things                                                      */
  /* ---------------------------------------------------------------- */

  private hover(text: string | null): void {
    this.el.tip!.textContent = text ?? "";
    this.el.tip!.classList.toggle("open", !!text);
  }

  private toast(f: FeedItem): void {
    const text = f.message || f.observations[0] || "";
    this.notice(h("span", null, statusChip(f.status), ` ${f.via === "agent" ? `${f.agent}: ` : ""}`, h("code", null, f.type), text ? ` — ${text.length > 220 ? `${text.slice(0, 217)}…` : text}` : ""), f.status === "executed" ? "ok" : f.status === "partial" ? "warn" : "bad");
  }

  private notice(content: Child, kind: string): void {
    const item = h("div", { class: `note ${kind}` }, content);
    this.el.toast!.appendChild(item);
    while (this.el.toast!.children.length > 3) this.el.toast!.firstChild!.remove();
    setTimeout(() => item.classList.add("gone"), 4200);
    setTimeout(() => item.remove(), 4800);
  }

  private qualityFell(q: Quality, why: string): void {
    (this.el.quality as HTMLSelectElement).value = q;
    this.quality = q;
    this.notice(`Rendering quality is now ${q}: ${why}.`, "warn");
  }

  private setQuality(q: Quality): void {
    this.quality = q;
    this.stage.gfx.setQuality(q);
    this.field.gfx.setQuality(q);
  }

  setLayout(layout: "clinic" | "field"): void {
    this.layout = layout;
    this.el.views!.className = `${layout}-main`;
    this.resize();
  }

  private resize(): void {
    this.stage?.resize();
    this.field?.resize();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      this.closePopover();
      this.el.modal!.classList.remove("open");
      return;
    }
    if (t.closest("input, textarea, select")) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && this.formAction) void this.send(this.formAction);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.setLayout(this.layout === "clinic" ? "field" : "clinic");
    }
  }

  private async newEncounter(): Promise<void> {
    const scenario = (this.el.scenario as HTMLSelectElement).value;
    if (this.snap.session.steps > 0 && !this.snap.session.finished && !confirm("Start again? The encounter in progress is dropped.")) return;
    const s = await this.guard(() => api.start({ scenario, mode: (this.el.mode as HTMLSelectElement).value, seed: Number((this.el.seed as HTMLInputElement).value) || 1 }));
    if (s) {
      this.closeForm();
      this.apply(s, []);
    }
  }

  private async showReport(): Promise<void> {
    const md = await this.guard(() => api.reportMarkdown());
    if (md === undefined) return;
    replace(
      this.el.modal!,
      h(
        "div",
        { class: "sheet" },
        h("div", { class: "row" }, h("h3", null, "Report"), h("div", { class: "spacer" }), h("a", { href: "/api/session/review", target: "_blank", rel: "noopener" }, "review page (floor plan, charts, evidence links)"), h("a", { href: "/api/session/log", target: "_blank", rel: "noopener" }, "log"), h("button", { onclick: () => this.el.modal!.classList.remove("open") }, "Close")),
        h("pre", null, md),
      ),
    );
    this.el.modal!.classList.add("open");
  }

  /** Where the pointer is, for menus opened from a click in a view. */
  track(): void {
    window.addEventListener("pointerdown", (e) => (this.pointer = { x: e.clientX, y: e.clientY }), true);
  }
}
