import { buildClinic } from "./clinic.js";
import { Plane, Raycaster, Vector2, Vector3 } from "three";
import { Director, GRIP_VIEWS, gripShot, type Shot } from "./director.js";
import { Engine } from "./engine.js";
import { Hud, needleLabelUnderHand } from "./hud.js";
import { NeedleLayer, type NeedleSpec } from "./needles.js";
import { Person, patientAppearance, practitionerAppearance, practitionerPlacement, type Placement, type SetName } from "./cast.js";
import { CONSULT, TREATMENT, type ModelRef } from "./set.js";
import { SiteFinder, siteOfInsertion, type SkinSite } from "./sites.js";
import { refineSkin } from "./skin.js";
import { NeedleProcedure } from "./procedure.js";
import { patientFloorPlacement, practitionerFloorPlacement } from "./navigation.js";
import { PerformTechniqueSchema, manipulationTechnique, techniqueDefinition } from "@acucraft/core";
import type { TechniquePlayback, TechniquePreview } from "../manipulation.js";
import { previewSite } from "./performance-target.js";
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
  /** Shift-click a floor destination: the host submits it through the authoritative movement tool. */
  onMove?: (to: { x: number; z: number }) => void;
  onPlayback?: (state: TechniquePlayback) => void;
  /** The file of a model of the clinic's equipment, as a URL. */
  modelUrl?: (file: string) => string;
}

export interface StageHandle {
  update(state: StageState): void;
  /** Highlight a needle (as when its row in the record is hovered). */
  highlight(needle: string | null): void;
  /** A local, clearly labelled preview; it never submits an encounter action. */
  previewTechnique(request: TechniquePreview): void;
  setPlayback(state: { paused?: boolean; speed?: number; progress?: number }): void;
  cancelPreview(): void;
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
const workStopped = (state: StageState) => state.closed || state.view.patient.consent === "withdrawn" || /faint|clammy|grey/.test(state.view.patient.appearance) || !!state.view.documentation.stopped;
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
    case "perform_technique": {
      const technique = techniqueDefinition(view.techniques, s("technique"));
      return `${technique?.zh ?? s("technique")} · ${technique?.label ?? "technique"}`;
    }
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

export async function mountStage(host: HTMLElement, info: StageInfoWithModels, options: StageOptions = {}): Promise<StageHandle> {
  refineSkin();
  const engine = new Engine(host, options.quality ?? "auto");
  const director = new Director(engine.camera, engine.renderer.domElement);
  const needles = new NeedleLayer();
  let gripViewIndex = 0;
  let inspectingGrip = false;
  const gripDirections: Vector3[] = [];
  let activeInspectionNeedle: string | null = null;
  const leaveGrip = () => { inspectingGrip = false; gripDirections.length = 0; delete engine.renderer.domElement.dataset.gripBlocked; delete engine.renderer.domElement.dataset.gripDetails; };
  const hud = new Hud({
    camera: (mode: CameraMode) => { leaveGrip(); director.setMode(mode); },
    shot: (name) => {
      leaveGrip();
      const shot = name === "room" ? roomShot() : name === "patient" ? patientShot() : needleShot();
      if (shot) director.cut(shot, 1100, true);
    },
    grip: () => {
      const frame = procedure.inspectionFrame(true);
      if (!frame) return;
      const view = GRIP_VIEWS[gripViewIndex++ % GRIP_VIEWS.length]!;
      director.setMode("free");
      director.cut({ ...gripShot(frame, view, engine.camera.aspect), inspectionAvoidDirections: gripDirections.map(direction => direction.clone()) }, 650, true);
      inspectingGrip = true;
      engine.renderer.domElement.dataset.gripBlocked = String(director.inspectionBlocked ?? 0);
      engine.renderer.domElement.dataset.gripDetails = JSON.stringify(director.inspectionDetails);
      const details = director.inspectionDetails;
      if (Array.isArray(details?.direction)) { gripDirections.push(new Vector3().fromArray(details.direction)); if (gripDirections.length > 2) gripDirections.shift(); }
      hud.gripView(view, Number(details?.requestedAngleDifferenceDeg ?? 0) > 30);
      engine.invalidate(3);
    },
    quality: (q) => engine.setQuality(q),
    picture: () => void savePicture(),
    fullscreen: () => void (document.fullscreenElement ? document.exitFullscreen() : host.requestFullscreen?.()),
    pick: (id) => pick(id),
  });
  host.appendChild(hud.root);
  director.onMode = (m) => { if (m !== "free") leaveGrip(); hud.setMode(m); };
  director.controls.addEventListener("start", leaveGrip);
  engine.onQuality = (q) => hud.setQuality(q, engine.automaticQuality);
  hud.setQuality(engine.currentQuality, (options.quality ?? "auto") === "auto");

  const modelUrl = options.modelUrl ?? ((file: string) => `/app/models/${file.split("/").pop()}`);
  const sets = buildClinic(info, modelUrl);
  engine.scene.add(sets.root, needles.group);

  let patient: Person | null = null;
  let practitioner: Person | null = null;
  const colleagues = new Map<string, Person>();
  let finder: SiteFinder | null = null;
  let placed = "";
  let set: SetName = "consult";
  let state: StageState | null = null;
  let seenEntries = 0;
  let seenLines = 0;
  let seenRecorded = new Map<string, string | null>();
  let lastNeedle: string | null = null;
  let picked: string | null = null;
  const seenPerformances = new Set<string>();
  let previewSequence = 0;
  const subtitles: { who: string; text: string; patient: boolean }[] = [];
  let speakingUntil = 0;

  const procedure = new NeedleProcedure(needles, () => practitioner, (id) => {
    activeInspectionNeedle = id;
    const site = needles.siteOf(id);
    if (site) director.cut({ ...director.closeOn(site.p, site.n, 0.46), hold: 4000 }, 650);
  }, () => patient);
  procedure.onPlayback = (playback) => {
    hud.performance(playback);
    options.onPlayback?.(playback);
  };
  engine.scene.add(procedure.group);
  void procedure.load(modelUrl("acu-practitioner-hand.glb"), String(info.practitioner.appearance.skin ?? "#cba88a")).catch(() => {
    // Needles remain visible when the optional hand detail asset is unavailable.
  });

  const setCentre = () => state ? new Vector3(state.view.space.patient.x, 0, state.view.space.patient.z) : new Vector3();
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
    const away = practitioner ? head.clone().sub(practitioner.headAt()).setY(0) : new Vector3(0.95, 0, -1.25);
    if (away.lengthSq() < 0.01) away.set(0.95, 0, -1.25);
    away.normalize().multiplyScalar(1.55).setY(0.12);
    return { eye: head.clone().add(away), at: head.clone().add(new Vector3(0, -0.28, 0)), ms: 1300, fov: 34 };
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
  director.inspectionObstacles = () => {
    const support = procedure.group.getObjectByName("support-hand");
    const palm = procedure.group.getObjectByName("needle-hand")?.getObjectByName("palm_surface");
    return [sets.root, ...(practitioner ? [practitioner.holder] : []), ...(patient ? [patient.holder] : []),
      ...[...colleagues.values()].filter(person => person !== practitioner).map(person => person.holder), ...(support ? [support] : []), ...(palm ? [palm] : [])];
  };

  function pick(id: string | null): void {
    leaveGrip();
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
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "3D clinic. Shift-click the floor to walk; drag to orbit.");
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, engine.camera);
    if (e.shiftKey && state && !state.closed && options.onMove) {
      const point = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
      if (point) options.onMove({ x: point.x, z: point.z });
      return;
    }
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

  /** Standing movement follows the patient's real floor position; sanctioned changes of pose rebuild the figure. */
  function castPatient(view: AgentView, animate: boolean): boolean {
    const placement = patientFloorPlacement(view, info.patient.heightCm, info.patient.seed);
    const key = placement.set + "|" + placement.position + "|" + view.space.patient.on;
    if (key === placed && patient) { patient.moveTo(placement.at, view.space.walks.filter(w => w.actor === view.space.patient.id).at(-1), animate); return false; }
    placed = key;
    procedure.reset();
    patient?.dispose();
    patient = new Person(patientAppearance(info), placement);
    engine.scene.add(patient.holder);
    patient.moveTo(placement.at, view.space.walks.filter(w => w.actor === view.space.patient.id).at(-1), animate && state?.timeline.at(-1)?.tool === "move");
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
  function castPractitioner(view: AgentView, animate: boolean): void {
    const placement = practitionerFloorPlacement(view, info.practitioner.seed);
    placement.options.wear = practitionerPlacement("treatment", 1, 0, info.practitioner.seed).options.wear;
    if (!practitioner) { practitioner = new Person(practitionerAppearance(info), placement); engine.scene.add(practitioner.holder); }
    practitioner.moveTo(placement.at, view.space.walks.filter(w => w.actor === view.you.id).at(-1), animate);
    practitioner.lookAt(patient?.headAt() ?? new Vector3());
    for (const member of view.space.team) {
      let person = colleagues.get(member.id);
      const at = { x: member.x, y: 0, z: member.z, rot: 180 + member.yaw * 180 / Math.PI };
      if (!person) {
        person = new Person({ ...practitionerAppearance(info), shirt: "#81a9ad" }, { ...placement, at, options: { ...placement.options, seed: member.id } });
        colleagues.set(member.id, person); engine.scene.add(person.holder);
      }
      person.moveTo(at, view.space.walks.filter(w => w.actor === member.id).at(-1), animate);
    }
  }

  function sync(next: StageState, animate: boolean): void {
    const view = next.view;
    const stopped = workStopped(next);
    engine.invalidate(45);
    engine.lightSet(view.space.patient.x, view.space.patient.z);
    const moved = castPatient(view, animate);
    castPractitioner(view, animate && !moved);
    const plans = needlePlans(next.timeline, view.localisation.marks);
    const specs: NeedleSpec[] = [];
    for (const n of view.needling) {
      if (!n.inPlace) continue;
      const g = n.geometry;
      const site = finder ? finder.find(g) : null;
      if (!site) continue;
      specs.push({ id: n.needle, target: n.target, site, angleDeg: g.angleDeg, azimuthDeg: g.azimuthDeg, depthCm: g.depthCm, length: g.lengthMm / 1000, diameterMm: g.diameterMm });
    }
    needles.sync(specs, performance.now(), animate && !moved);
    // A stop settles already accepted insertions; it must not start a new insertion gesture from a coalesced update.
    if (stopped) for (const spec of specs) needles.progress(spec.id, "insert", 1);
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
        if (e.input.presentation && typeof e.input.presentation === "object") procedure.setInsertionPresentation(id, e.input.presentation);
        lastNeedle = id;
        focus = needles.siteOf(id) ?? focus;
      }
      if (!stopped && e.tool === "adjust_needle" && id && (e.status === "executed" || e.status === "partial")) procedure.workAction(id, e.input);
      if (e.tool === "perform_technique" && e.status === "executed") {
        const performance = view.performances?.find((p) => p.requestId === e.requestId);
        if (performance && !seenPerformances.has(performance.id)) {
          seenPerformances.add(performance.id);
          const site = performance.patientPosition === view.patient.position && performance.visit === view.setting.visit && performance.actor === view.you.id ? finder?.find(performance.site) : null;
          if (site && (!stopped || performance.context === "removed")) {
            procedure.perform({ id: performance.id, technique: performance.technique, needleId: performance.needleId ?? undefined, site, motion: performance.motion,
              ...(performance.provenance.kind === "operative" ? { model: "operative" as const } : {}) });
            focus = site;
          }
        }
      }
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
    if (stopped) needles.stopWork();
    // the lines said since: the patient's (and others') words
    const lines = view.conversation;
    if (animate && lines.length > seenLines) {
      for (const u of lines.slice(seenLines)) if (u.speaker !== view.you.name) subtitles.push({ who: u.speaker, text: u.text, patient: u.speaker === view.patient.name });
    }
    seenLines = lines.length;
    for (const performance of view.performances ?? []) seenPerformances.add(performance.id);

    procedure.sync();
    if (moved && animate) director.cut(patientShot(), 1500);
    else if (focus && animate) director.cut(director.closeOn(focus.p, focus.n), 1200);
    hud.status({
      room: view.space.rooms.find(r => r.id === view.patient.location)?.label ?? view.patient.location,
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
    for (const person of colleagues.values()) person.tick(now, dt);
    if (patient?.isMoving || [...colleagues.values()].some(person => person.isMoving)) engine.invalidate(2);
    needles.tick(dt, now);
    procedure.tick(now);
    practitioner?.tick(now, dt);
    const playback = procedure.playback;
    if (practitioner?.isMoving || procedure.group.visible && (playback.mode === "idle" || playback.playing)) engine.invalidate(2);
    director.update();
    // (the labels are placed with this frame's camera, not the last one's: no swimming while it moves)
    engine.camera.updateMatrixWorld();
    const inspection = procedure.inspectionFrame();
    if (!inspection) leaveGrip();
    hud.gripAvailable(!!inspection);
    engine.focus(director.focusDistance, director.focusPoint, inspection ? { point: inspection.contact, normal: inspection.surfaceNormal ?? new Vector3(0, 1, 0) } : undefined);
    const r = host.getBoundingClientRect();
    const anchors = needles.anchors();
    const workingContact = inspectingGrip || inspection?.needleAxis ? inspection?.contact : undefined;
    const coveredLabel = needleLabelUnderHand(anchors, workingContact, engine.camera.position, activeInspectionNeedle, inspectingGrip);
    hud.place(anchors, engine.camera, r.width, r.height, procedure.group.visible, coveredLabel);
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
      if (workStopped(next) && (!state || !workStopped(state)) || state && state.view.setting.visit !== next.view.setting.visit) procedure.reset();
      else if (state && state.view.version !== next.view.version) procedure.stopPreview();
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
    previewTechnique(request) {
      if (!state || !finder || !practitioner) throw new Error("3D 场景尚未就绪 · The 3D scene is not ready.");
      const parsed = PerformTechniqueSchema.safeParse({ ...request, type: "perform_technique" });
      if (!parsed.success) throw new Error(`参数无效 · Invalid technique parameters: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
      activeInspectionNeedle = parsed.data.needleId ?? null;
      const target = previewSite(state.view, parsed.data);
      const site = finder.find(target);
      if (!site || !site.bare) throw new Error("当前图形未显示此处裸露皮肤，请选择可见标记 · Choose a site on the visible skin.");
      if (!procedure.preview({ id: `preview-${++previewSequence}`, technique: parsed.data.technique, needleId: parsed.data.needleId, site, motion: parsed.data.motion,
        ...(state.view.techniques ? { model: state.view.techniques } : {}) })) throw new Error("请等待当前动作完成，再开始预览 · Wait for the current recorded action or walk to finish.");
      director.cut({ ...director.closeOn(site.p, site.n, 0.5), hold: 60_000 }, 650);
      engine.invalidate(45);
    },
    setPlayback(playback) { procedure.setPlayback(playback); engine.invalidate(3); },
    cancelPreview() { procedure.stopPreview(); engine.invalidate(3); },
    dispose() {
      director.controls.removeEventListener("start", leaveGrip);
      engine.dispose();
      director.dispose();
      patient?.dispose();
      practitioner?.dispose();
      for (const person of colleagues.values()) person.dispose();
      procedure.dispose();
      hud.root.remove();
    },
  };
}
