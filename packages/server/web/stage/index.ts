import { Raycaster, Vector2, Vector3 } from "three";
import { Director, type Shot } from "./director.js";
import { Engine } from "./engine.js";
import { Hud } from "./hud.js";
import { NeedleLayer, type NeedleSpec } from "./needles.js";
import { Person, patientAppearance, patientPlacement, practitionerAppearance, practitionerPlacement, type Placement, type SetName } from "./cast.js";
import { buildSets, CONSULT, TREATMENT, type ModelRef } from "./set.js";
import { SiteFinder, siteOfInsertion, type SkinSite } from "./sites.js";
import { refineSkin } from "./skin.js";
import type { AgentView, CameraMode, ChartSite, Quality, StageInfo, StageState, TimelineEntry } from "./types.js";

/**
 * The 3D view of an encounter (docs/WEB.md "The 3D view"): the room, the patient as they are on the record —
 * where, in what position, with the practitioner's marks on their skin and the needles in them — and the
 * practitioner beside them, kept in step with the record as anyone (the operator, a language model, an MCP
 * client) acts on it. It draws only what the record says; how the people look comes from `StageInfo`.
 */

export interface StageOptions {
  quality?: Quality | "auto";
  /** A needle was picked in the view (null: none). */
  onPick?: (needle: string | null) => void;
  /** The file of a model of the clinic's equipment, as a URL. */
  modelUrl?: (file: string) => string;
}

export interface StageHandle {
  update(state: StageState): void;
  /** Highlight a needle (as when its row in the record is hovered). */
  highlight(needle: string | null): void;
  dispose(): void;
}

export type StageInfoWithModels = StageInfo & { models: Record<string, ModelRef> };

const POSITION_WORDS: Record<string, string> = {
  standing: "standing",
  seated: "seated",
  "seated-forward": "seated, leaning forward",
  supine: "lying on their back",
  "supine-knee-flexed": "on their back, knees bent",
  prone: "lying face down",
  "side-lying-left": "lying on the left side",
  "side-lying-right": "lying on the right side",
};

const byText = (by: TimelineEntry["by"]) => (by.kind === "operator" ? by.name : by.kind === "llm" ? `LLM · ${by.name}` : `MCP · ${by.name}`);
const sideWord = (t: string) => t.replace(/:left$/, " left").replace(/:right$/, " right").replace(/:midline$/, "");

/** What an action did, in a few words, for its caption (a question asked by its history item in its words). */
function describe(e: TimelineEntry, view: AgentView): string {
  const i = e.input;
  const s = (k: string) => (typeof i[k] === "string" ? String(i[k]) : "");
  switch (e.tool) {
    case "ask": {
      const words = s("text") || view.record.history.find((h) => h.id === s("itemId"))?.question;
      return words ? `asks: “${words}”` : `asks about ${s("itemId")}`;
    }
    case "say":
      return `says: “${s("text")}”`;
    case "examine":
      return s("text") ? `examines: ${s("text")}` : `examines ${s("findingId")}`;
    case "insert_needle":
      return `inserts ${s("needleId")} ${s("mark") ? `at ${s("mark")}` : s("target") ? `at ${sideWord(s("target"))}` : ""} · ${Number(i.depthCm ?? 0).toFixed(1)} cm`;
    case "adjust_needle":
      return `works ${s("needleId")}${s("technique") && s("technique") !== "none" ? ` (${s("technique")})` : ""}`;
    case "mark_point":
      return `marks ${sideWord(s("target") || s("point"))}`;
    case "position_patient":
      return `positions the patient: ${s("position").replace(/-/g, " ")}`;
    case "wait":
      return `waits ${String(i.minutes ?? "")} min`;
    default:
      return e.tool.replace(/_/g, " ");
  }
}

/** The needle plans of the record: each needle's latest insertion, with its later depth and how it was last worked. */
function needlePlans(timeline: TimelineEntry[], marks: AgentView["localisation"]["marks"]): Map<string, { site: ChartSite; angleDeg: number; azimuthDeg: number; depthCm: number; minute: number; target: string }> {
  const plans = new Map<string, { site: ChartSite; angleDeg: number; azimuthDeg: number; depthCm: number; minute: number; target: string }>();
  for (const e of timeline) {
    if (e.status !== "executed" && e.status !== "partial") continue;
    const id = typeof e.input.needleId === "string" ? e.input.needleId : null;
    if (!id) continue;
    if (e.tool === "insert_needle") {
      const site = siteOfInsertion(e.input, marks);
      if (!site) continue;
      const mark = typeof e.input.mark === "string" ? marks.find((m) => m.id === e.input.mark) : undefined;
      plans.set(id, { site, angleDeg: Number(e.input.angleDeg ?? 0), azimuthDeg: Number(e.input.azimuthDeg ?? 0), depthCm: Number(e.input.depthCm ?? 1), minute: e.minute, target: typeof e.input.target === "string" ? e.input.target : (mark?.target ?? "") });
    } else if (e.tool === "adjust_needle" && typeof e.input.depthCm === "number") {
      const p = plans.get(id);
      if (p) p.depthCm = e.input.depthCm;
    }
  }
  return plans;
}

/** The length of the pack's needles (its spec, e.g. "0.25 × 40 mm"), in metres. */
function needleLength(view: AgentView): number {
  for (const p of view.equipment.packs) {
    const m = /(\d+(?:\.\d+)?)\s*mm\b/.exec(String(p.spec));
    if (m) return Math.min(0.1, Math.max(0.013, Number(m[1]) / 1000));
  }
  return 0.04;
}

export async function mountStage(host: HTMLElement, info: StageInfoWithModels, options: StageOptions = {}): Promise<StageHandle> {
  refineSkin();
  const engine = new Engine(host, options.quality ?? "auto");
  const director = new Director(engine.camera, engine.renderer.domElement);
  const needles = new NeedleLayer();
  const hud = new Hud({
    camera: (mode: CameraMode) => director.setMode(mode),
    shot: (name) => {
      const shot = name === "room" ? roomShot() : name === "patient" ? patientShot() : needleShot();
      if (shot) director.cut(shot, 1100, true);
    },
    quality: (q) => engine.setQuality(q),
    picture: () => void savePicture(),
    fullscreen: () => void (document.fullscreenElement ? document.exitFullscreen() : host.requestFullscreen?.()),
    pick: (id) => pick(id),
  });
  host.appendChild(hud.root);
  director.onMode = (m) => hud.setMode(m);
  engine.onQuality = (q) => hud.setQuality(q, true);
  hud.setQuality(engine.currentQuality, (options.quality ?? "auto") === "auto");

  const modelUrl = options.modelUrl ?? ((file: string) => `/app/models/${file.split("/").pop()}`);
  const sets = buildSets(info.models, modelUrl);
  engine.scene.add(sets.root, needles.group);

  let patient: Person | null = null;
  let practitioner: Person | null = null;
  let finder: SiteFinder | null = null;
  let placed = "";
  let staffKey = "";
  let set: SetName = "consult";
  let state: StageState | null = null;
  let seenEntries = 0;
  let seenLines = 0;
  let seenRecorded = new Map<string, string | null>();
  let lastNeedle: string | null = null;
  let picked: string | null = null;
  const subtitles: { who: string; text: string; patient: boolean }[] = [];
  let speakingUntil = 0;

  const setCentre = () => (set === "treatment" ? new Vector3(TREATMENT.couch.x, 0, TREATMENT.couch.z) : new Vector3(CONSULT.desk.x, 0, CONSULT.desk.z));
  function roomShot(): Shot {
    const c = setCentre();
    return set === "treatment"
      ? { eye: c.clone().add(new Vector3(2.05, 2.0, 2.45)), at: c.clone().add(new Vector3(-0.15, 0.55, -0.35)), ms: 1500, fov: 40 }
      : { eye: c.clone().add(new Vector3(1.9, 1.75, 2.35)), at: c.clone().add(new Vector3(-0.1, 0.75, 0.2)), ms: 1500, fov: 40 };
  }
  function patientShot(): Shot {
    if (!patient) return roomShot();
    const lying = ["prone", "lying", "lateral"].includes(patient.placement.options.posture);
    if (lying) {
      const c = setCentre();
      const side = practitioner ? Math.sign(practitioner.placement.at.x - c.x) || 1 : 1;
      return { eye: c.clone().add(new Vector3(-side * 1.15, 1.55, 1.25)), at: c.clone().add(new Vector3(0, 0.66, -0.12)), ms: 1300, fov: 36 };
    }
    const head = patient.headAt();
    return { eye: head.clone().add(new Vector3(0.95, 0.12, -1.25)), at: head.clone().add(new Vector3(0, -0.28, 0)), ms: 1300, fov: 34 };
  }
  function faceShot(): Shot | null {
    if (!patient) return null;
    const head = patient.headAt();
    const posture = patient.placement.options.posture;
    // face down, the face is in the couch's breathing hole: the head and shoulders from the side, not the crown
    if (posture === "prone") {
      const side = practitioner ? Math.sign(practitioner.placement.at.x - head.x) || 1 : 1;
      return { eye: head.clone().add(new Vector3(-side * 1.05, 0.62, 0.55)), at: head.clone().add(new Vector3(0, -0.05, 0.28)), ms: 1100, hold: 2600, fov: 32 };
    }
    if (posture === "lying" || posture === "lateral") return { eye: head.clone().add(new Vector3(0.62, 0.62, -0.35)), at: head.clone(), ms: 1100, hold: 2600, fov: 30 };
    const toward = patient.placement.at.rot === 180 ? -1 : 1;
    return { eye: head.clone().add(new Vector3(0.55, 0.06, toward * 0.85)), at: head.clone().add(new Vector3(0, -0.04, 0)), ms: 1100, hold: 2600, fov: 30 };
  }
  function needleShot(): Shot | null {
    const site = lastNeedle ? needles.siteOf(lastNeedle) : null;
    return site ? director.closeOn(site.p, site.n) : null;
  }
  director.setHome(() => patientShot());
  // what a shot must see past: the room and its furniture, and the practitioner (never the patient: the subject)
  director.obstacles = () => [sets.root, ...(practitioner ? [practitioner.holder] : [])];

  function pick(id: string | null): void {
    picked = id;
    needles.highlight(id);
    options.onPick?.(id);
    const site = id ? needles.siteOf(id) : null;
    if (site) director.cut(director.closeOn(site.p, site.n, 0.36), 900, true);
  }

  // picking a needle in the view
  const ray = new Raycaster();
  const mouse = new Vector2();
  const canvas = engine.renderer.domElement;
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, engine.camera);
    pick(needles.pick(ray));
  });

  async function savePicture(): Promise<void> {
    const blob = await engine.picture();
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `acucraft-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** The patient as the record has them now: rebuilt (and every site found again) when their position or room changes. */
  function castPatient(view: AgentView, animate: boolean): boolean {
    const placement: Placement = patientPlacement(view.patient.position, view.patient.location, info.patient.heightCm, info.patient.seed);
    const key = `${placement.set}|${placement.position}`;
    if (key === placed) return false;
    placed = key;
    if (animate) hud.dip();
    patient?.dispose();
    patient = new Person(patientAppearance(info), placement);
    engine.scene.add(patient.holder);
    finder = new SiteFinder(patient.rig);
    needles.clear();
    seenRecorded = new Map();
    if (set !== placement.set) {
      set = placement.set;
      const c = setCentre();
      engine.lightSet(c.x, c.z);
    }
    return true;
  }

  /** The practitioner, beside the couch on the side being worked (or at the desk). */
  function castPractitioner(site: SkinSite | null): void {
    const c = setCentre();
    const side: 1 | -1 = site ? (site.p.x - c.x >= -0.03 ? 1 : -1) : practitioner && practitioner.placement.set === set ? (Math.sign(practitioner.placement.at.x - c.x) as 1 | -1) || 1 : 1;
    const along = site ? site.p.z - c.z + 0.1 : 0.05;
    const placement = practitionerPlacement(set, side, Math.round(along * 4) / 4, info.practitioner.seed);
    const key = `${placement.set}|${placement.at.x.toFixed(2)}|${placement.at.z.toFixed(2)}`;
    if (key === staffKey) return;
    staffKey = key;
    practitioner?.dispose();
    practitioner = new Person(practitionerAppearance(info), placement);
    engine.scene.add(practitioner.holder);
  }

  function sync(next: StageState, animate: boolean): void {
    const view = next.view;
    engine.invalidate(45);
    const moved = castPatient(view, animate);
    const plans = needlePlans(next.timeline, view.localisation.marks);
    const length = needleLength(view);
    const specs: NeedleSpec[] = [];
    for (const n of view.needling) {
      if (!n.inPlace) continue;
      const plan = plans.get(n.needle);
      const site = plan && finder ? finder.find(plan.site) : null;
      if (!plan || !site) continue;
      specs.push({ id: n.needle, target: plan.target || n.target, site, angleDeg: plan.angleDeg, azimuthDeg: plan.azimuthDeg, depthCm: plan.depthCm, length });
    }
    needles.sync(specs, performance.now(), animate && !moved);
    const marks: { id: string; site: SkinSite; stale: boolean }[] = [];
    for (const m of view.localisation.marks) {
      const site = finder?.find({ region: m.region, side: m.side, u: m.u, v: m.v });
      if (site) marks.push({ id: m.id, site, stale: m.stale });
    }
    needles.syncMarks(marks);
    patient?.distress(/faint|clammy|grey/.test(view.patient.appearance));

    // what is new on the record: captions, the camera, the needles' movements, what is said
    const fresh = next.timeline.slice(animate ? seenEntries : next.timeline.length);
    seenEntries = next.timeline.length;
    let focus: SkinSite | null = null;
    for (const e of fresh) {
      hud.action(byText(e.by), e.by.kind, describe(e, view), e.status);
      const id = typeof e.input.needleId === "string" ? e.input.needleId : null;
      if (e.tool === "insert_needle" && id && (e.status === "executed" || e.status === "partial")) {
        lastNeedle = id;
        focus = needles.siteOf(id) ?? focus;
      }
      if (e.tool === "adjust_needle" && id && typeof e.input.technique === "string" && e.input.technique !== "none") needles.work(id, e.input.technique as "lift-thrust" | "rotate", performance.now());
      if (e.tool === "mark_point" && (e.status === "executed" || e.status === "partial")) {
        const last = view.localisation.marks[view.localisation.marks.length - 1];
        const site = last && finder ? finder.find({ region: last.region, side: last.side, u: last.u, v: last.v }) : null;
        if (site) focus = site;
      }
      if (e.tool === "ask" && (e.status === "executed" || e.status === "partial")) {
        const text = typeof e.input.text === "string" ? e.input.text : (view.record.history.find((h) => h.id === e.input.itemId)?.question ?? "");
        if (text) subtitles.push({ who: view.you.name.replace(/ \(you\)$/, ""), text, patient: false });
      }
    }
    for (const n of view.needling) {
      const was = seenRecorded.get(n.needle);
      if (animate && was !== undefined && n.recorded === "deqi" && was !== "deqi") needles.respond(n.needle, performance.now());
      seenRecorded.set(n.needle, n.recorded);
    }
    // the lines said since: the patient's (and others') words
    const lines = view.conversation;
    if (animate && lines.length > seenLines) {
      for (const u of lines.slice(seenLines)) if (u.speaker !== view.you.name) subtitles.push({ who: u.speaker, text: u.text, patient: u.speaker === view.patient.name });
    }
    seenLines = lines.length;

    castPractitioner(lastNeedle ? needles.siteOf(lastNeedle) : focus);
    if (moved && animate) director.cut(patientShot(), 1500);
    else if (focus && animate) director.cut(director.closeOn(focus.p, focus.n), 1200);
    hud.status({
      room: set === "treatment" ? "Treatment room" : "Consultation room",
      position: `${POSITION_WORDS[view.patient.position] ?? view.patient.position}${["prone", "supine", "supine-knee-flexed"].includes(view.patient.position) ? " · towels" : ""}`,
      appearance: view.patient.appearance,
      consent: view.patient.consent,
      minute: view.minute,
      visit: `visit ${view.setting.visit} of ${view.setting.visits}`,
      agent: next.agent,
      closed: next.closed,
      needles: specs.length,
      retention: specs.length && view.plan ? { elapsed: Math.max(0, view.minute - Math.max(...specs.map((s) => plans.get(s.id)?.minute ?? view.minute))), total: view.plan.retentionMinutes } : null,
    });
  }

  function nextSubtitle(now: number): void {
    // what is said now, not a backlog: when many lines arrive at once (a model acting quickly), the latest are said
    if (subtitles.length > 2) subtitles.splice(0, subtitles.length - 2);
    if (now < speakingUntil || !subtitles.length) return;
    const line = subtitles.shift()!;
    const ms = Math.min(7000, Math.max(1100, line.text.length * 52));
    hud.say(line.who, line.text, ms);
    speakingUntil = now + ms + 250;
    if (line.patient) {
      patient?.speak(ms, now);
      const shot = faceShot();
      if (shot && !lastNeedle) director.cut(shot, 1100);
    } else practitioner?.speak(ms, now);
  }

  // the first frame: the room, then the people as soon as the record is known
  engine.lightSet(CONSULT.desk.x, CONSULT.desk.z);
  director.place(roomShot());
  engine.start((dt, now) => {
    nextSubtitle(now);
    patient?.tick(now, dt);
    practitioner?.tick(now, dt);
    needles.tick(dt, now);
    director.update();
    // (the labels are placed with this frame's camera, not the last one's: no swimming while it moves)
    engine.camera.updateMatrixWorld();
    engine.focus(director.focusDistance);
    const r = host.getBoundingClientRect();
    hud.place(needles.anchors(), engine.camera, r.width, r.height);
  });
  sets.ready.then(
    () => {
      engine.invalidate(3);
      hud.ready();
    },
    () => hud.failed("The room's models did not load."),
  );

  return {
    update(next: StageState) {
      const first = state === null;
      state = next;
      sync(next, !first);
      if (first) {
        // an establishing shot: the room, then a slow move in to the patient
        const wide = roomShot();
        director.place({ ...wide, eye: wide.eye.clone().multiplyScalar(1).add(new Vector3(0.6, 0.35, 0.8)) });
        director.cut({ ...patientShot(), ms: 2800 });
      }
    },
    highlight(id) {
      if (id === picked) return;
      picked = id;
      needles.highlight(id);
    },
    dispose() {
      engine.dispose();
      director.dispose();
      patient?.dispose();
      practitioner?.dispose();
      hud.root.remove();
    },
  };
}
