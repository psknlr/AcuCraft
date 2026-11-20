import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { AgentView, NeedleView, Probe, Side, StudioScene, TeachingNeedle, TeachingRegion } from "../types.js";
import { discard, Gfx, type Quality } from "./gfx.js";
import { skinMaps, worldUV } from "./materials.js";
import { readGesture, type Gesture, type Sample } from "./gesture.js";
import { NeedleModel } from "./needle.js";

export type { Gesture };

/**
 * The needling field: one regional chart of this patient, close up, in centimetres. The skin is the chart — `u`
 * across, `v` towards the head, depth straight down — so a mark, a needle's entry, its angle, its direction and its
 * depth are drawn exactly where the engine has them. Landmarks appear when they have been palpated, marks when they
 * have been made, a needle's response as the evidence obtained of it. What lies beneath the skin (strata, vessels,
 * nerves, reference locations) is drawn in teaching mode only: in assessment mode the page is never sent it.
 */

export interface Ghost {
  u: number;
  v: number;
  angleDeg: number;
  azimuthDeg: number;
  depthCm: number;
}

export interface FieldEvents {
  /** The pointer over the chart (null: off it). */
  hover(at: { u: number; v: number } | null): void;
  /** A click on the skin. */
  pick(at: { u: number; v: number }): void;
  select(needle: string | null): void;
  /** The needle is being worked by hand: live reading, then the measured gesture on release (null: too short). */
  working(live: { needle: string; liftMm: number; turnDeg: number; seconds: number } | null): void;
  gesture(g: Gesture | null, why?: string): void;
  quality(q: Quality, why: string): void;
}

const TISSUE: Record<string, string> = {
  skin: "#dba98b",
  subcutaneous: "#e9c86e",
  fascia: "#e9e4dc",
  muscle: "#a9453e",
  tendon: "#efe9da",
  ligament: "#e6dfcc",
  "fat-pad": "#f0d586",
  "joint-space": "#9cc3d6",
  periosteum: "#f3eedd",
  bone: "#e6dcc3",
  pleura: "#8fa9c4",
  lung: "#e3a5a8",
  organ: "#7c3636",
};
export const tissueColor = (t: string): string => TISSUE[t] ?? "#b9b9b9";
const STRUCTURE: Record<string, string> = { artery: "#c9342b", vein: "#3a5fb0", nerve: "#e6cb4c", tendon: "#efe9da", "joint-capsule": "#8fb7c9", pleura: "#9fb4c8", organ: "#7a3b3b", bone: "#e6dcc3", bursa: "#a8c9d8" };

const INK = new THREE.MeshBasicMaterial({ color: "#3b2f8f", transparent: true, opacity: 0.85, depthWrite: false });
const PEN = new THREE.MeshBasicMaterial({ color: "#1f4fa8", transparent: true, opacity: 0.85, depthWrite: false });
// the pen and the ink are the same for every mark: a mark that is redrawn leaves them be
INK.userData.shared = PEN.userData.shared = true;
const flat = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, side: THREE.DoubleSide });

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = `tag ${cls}`;
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.center.set(0, 1.25);
  return o;
}

/** A label short enough to sit on the chart: the first clause of a description. */
const brief = (text: string): string => {
  const first = text.split(/[,(:]/)[0]!.trim();
  return first.length > 34 ? `${first.slice(0, 32)}…` : first;
};

function ring(inner: number, outer: number, material: THREE.Material, segments = 48): THREE.Mesh {
  const g = new THREE.RingGeometry(inner, outer, segments);
  g.rotateX(-Math.PI / 2);
  return new THREE.Mesh(g, material);
}

export class FieldView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 0.5, 600);
  readonly gfx: Gfx;
  readonly controls: OrbitControls;
  private labels: CSS2DRenderer;
  private skin: THREE.Mesh | null = null;
  private skinMaterial: THREE.MeshPhysicalMaterial;
  private drape: THREE.Mesh;
  private key: THREE.DirectionalLight;
  private chart = new THREE.Group();
  private marks = new THREE.Group();
  private teach = new THREE.Group();
  private needleGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private ghostModel: NeedleModel | null = null;
  private ghostMarks = new THREE.Group();
  private cursor: THREE.Mesh;
  private selection: THREE.Mesh;
  private needles = new Map<string, { model: NeedleModel; view: NeedleView; tag: CSS2DObject; dose: THREE.Mesh; gone: boolean }>();
  private holes = new THREE.Group();
  private holed = new Set<string>();
  region: StudioScene["regions"][number] | null = null;
  side: Side = "midline";
  selected: string | null = null;
  xray = false;
  grid = true;
  private spec = { diameterMm: 0.25, lengthMm: 40 };
  private clock = 0;
  private grab: { needle: string; x: number; y: number; samples: Sample[]; axis: THREE.Vector2; pxPerCm: number; start: number; moved: boolean } | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private seen = false;
  private byHand: string | null = null;

  constructor(
    readonly host: HTMLElement,
    private events: FieldEvents,
    quality: Quality,
  ) {
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    host.appendChild(this.labels.domElement);
    this.scene.background = new THREE.Color("#101316");
    this.scene.fog = new THREE.Fog("#101316", 160, 420);
    this.controls = new OrbitControls(this.camera, canvas);
    this.gfx = new Gfx(canvas, this.scene, this.camera, {
      quality,
      aoRadius: 0.9,
      bloom: 0.06,
      focus: () => this.camera.position.distanceTo(this.controls.target),
      dofAtHigh: true,
      aperture: 0.00045,
      exposure: 0.82,
      environment: 0.3,
      onQuality: (q, why) => this.events.quality(q, why),
    });
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.09, minDistance: 5, maxDistance: 190, maxPolarAngle: Math.PI * 0.485, zoomSpeed: 0.9, panSpeed: 0.8, screenSpacePanning: false });

    // a lamp over the field, the room's light, and a cool edge from behind
    this.key = new THREE.DirectionalLight("#fff6ec", 1.7);
    this.key.castShadow = true;
    Object.assign(this.key.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 220 });
    this.key.shadow.mapSize.set(4096, 4096);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);
    this.scene.add(new THREE.HemisphereLight("#e8eef5", "#59544c", 0.22));
    const rim = new THREE.DirectionalLight("#b7d2ff", 0.55);
    rim.position.set(-30, 26, -50);
    this.scene.add(rim);

    const maps = skinMaps();
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) if (t) t.repeat.set(1 / 5.5, 1 / 5.5);
    this.skinMaterial = new THREE.MeshPhysicalMaterial({ map: maps.map, normalMap: maps.normalMap!, roughnessMap: maps.roughnessMap!, roughness: 1, normalScale: new THREE.Vector2(0.8, 0.8), sheen: 0.3, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffc9b0"), clearcoat: 0.1, clearcoatRoughness: 0.55 });
    const cloth = new THREE.MeshPhysicalMaterial({ color: "#2f6f79", roughness: 0.9, sheen: 0.8, sheenRoughness: 0.5, sheenColor: new THREE.Color("#9fd3da") });
    this.drape = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), cloth);
    this.drape.rotation.x = -Math.PI / 2;
    this.drape.position.y = -0.55;
    this.drape.receiveShadow = true;
    this.teach.visible = false;
    this.scene.add(this.drape, this.chart, this.marks, this.teach, this.needleGroup, this.ghostGroup, this.holes);

    this.cursor = ring(0.32, 0.37, flat("#ffffff", 0.9));
    this.cursor.visible = false;
    this.selection = ring(0.82, 0.9, flat("#ffc861", 0.95));
    this.selection.visible = false;
    this.scene.add(this.cursor, this.selection);

    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.cursor.visible = false;
      this.events.hover(null);
    });
    this.camera.position.set(0, 30, 34);
  }

  /* ---------------------------------------------------------------- */
  /* The chart                                                         */
  /* ---------------------------------------------------------------- */

  private at(u: number, v: number, y = 0): THREE.Vector3 {
    return new THREE.Vector3(u, y, -v);
  }

  /** Show a regional chart (a different one rebuilds the skin). */
  setChart(region: StudioScene["regions"][number], side: Side): void {
    if (this.region?.id === region.id && this.side === side) return;
    this.region = region;
    this.side = side;
    this.selected = null;
    discard(this.chart, false);
    for (const n of this.needles.values()) n.tag.removeFromParent();
    this.needles.clear();
    discard(this.needleGroup);
    discard(this.holes);
    this.holed.clear();
    const [u0, u1] = region.uRange;
    const [v0, v1] = region.vRange;
    const w = u1 - u0;
    const d = v1 - v0;
    const g = new RoundedBoxGeometry(w, 1.1, d, 4, 0.5);
    g.translate((u0 + u1) / 2, -0.55, -(v0 + v1) / 2);
    worldUV(g);
    this.skin = new THREE.Mesh(g, this.skinMaterial);
    this.skin.receiveShadow = true;
    this.skin.castShadow = true;
    this.chart.add(this.skin);
    // the chart's graticule: every centimetre faintly, every five more firmly, the axes through its origin
    const lines = (step: number, opacity: number, color: string) => {
      const pts: number[] = [];
      for (let u = Math.ceil(u0 / step) * step; u <= u1; u += step) pts.push(u, 0.012, -v0, u, 0.012, -v1);
      for (let v = Math.ceil(v0 / step) * step; v <= v1; v += step) pts.push(u0, 0.012, -v, u1, 0.012, -v);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      l.name = "grid";
      return l;
    };
    this.chart.add(lines(1, 0.07, "#40302a"), lines(5, 0.17, "#40302a"));
    for (let v = Math.ceil(v0 / 10) * 10; v <= v1; v += 10) {
      const t = label(`v ${v}`, "axis");
      t.position.copy(this.at(u0 - 0.6, v, 0));
      t.name = "grid";
      this.chart.add(t);
    }
    for (let u = Math.ceil(u0 / 10) * 10; u <= u1; u += 10) {
      const t = label(`u ${u}`, "axis");
      t.position.copy(this.at(u, v0 - 0.6, 0));
      t.name = "grid";
      this.chart.add(t);
    }
    const head = label("towards the head ↑", "axis strong");
    head.position.copy(this.at((u0 + u1) / 2, v1 + 1.4, 0));
    head.name = "grid";
    this.chart.add(head);
    this.applyGrid();
    this.focus((u0 + u1) / 2, (v0 + v1) / 2, Math.min(150, Math.max(w, d) * 1.5), true);
  }

  private applyGrid(): void {
    this.chart.traverse((o) => {
      if (o.name === "grid") o.visible = this.grid;
    });
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.applyGrid();
  }

  /** Look at a point of the chart from `distance` centimetres. */
  focus(u: number, v: number, distance?: number, instant = false): void {
    const target = this.at(u, v, 0);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = distance ?? offset.length();
    offset.setLength(dist);
    // never from below the horizon of the skin, nor edge on
    if (!Number.isFinite(offset.y) || offset.y < dist * 0.35) offset.set(0, dist * 0.72, dist * 0.7);
    if (instant || !this.seen) {
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(offset);
      this.seen = true;
      this.pending = null;
    } else this.pending = { target, position: target.clone().add(offset) };
  }
  private pending: { target: THREE.Vector3; position: THREE.Vector3 } | null = null;

  /** See through the skin (teaching mode). */
  setXray(on: boolean): void {
    this.xray = on;
    this.skinMaterial.transparent = on;
    this.skinMaterial.opacity = on ? 0.32 : 1;
    this.skinMaterial.depthWrite = !on;
    this.skinMaterial.needsUpdate = true;
    this.teach.visible = on;
    this.drape.position.y = on ? -14 : -0.55;
    (this.drape.material as THREE.MeshPhysicalMaterial).color.set(on ? "#16252b" : "#2f6f79");
  }

  /* ---------------------------------------------------------------- */
  /* What has been found, marked and placed                            */
  /* ---------------------------------------------------------------- */

  /** Redraw from the view: the engine's state of this chart, and nothing else. */
  update(view: AgentView, teachingNeedles: TeachingNeedle[] = []): void {
    const region = this.region;
    if (!region) return;
    const spec = /([\d.]+)\s*×\s*([\d.]+)\s*mm/.exec(view.equipment.packs[0]?.spec ?? "");
    if (spec) this.spec = { diameterMm: Number(spec[1]), lengthMm: Number(spec[2]) };
    const here = (r: string, s: string) => r === region.id && s === this.side;
    discard(this.marks);
    const lm = new Map(region.landmarks.map((l) => [l.id, l.label]));
    for (const l of view.localisation.landmarks) {
      if (!here(l.region, l.side)) continue;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20).rotateX(-Math.PI / 2), PEN);
      dot.position.copy(this.at(l.u, l.v, 0.02));
      const t = label(brief(lm.get(l.landmark) ?? l.landmark), "landmark");
      t.position.copy(dot.position);
      this.marks.add(dot, t);
    }
    for (const m of view.localisation.marks) {
      if (!here(m.region, m.side)) continue;
      const cross = new THREE.Group();
      for (const turn of [Math.PI / 4, -Math.PI / 4]) {
        const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.07).rotateX(-Math.PI / 2), INK);
        bar.rotation.y = turn;
        cross.add(bar);
      }
      cross.position.copy(this.at(m.u, m.v, 0.025));
      this.marks.add(cross);
      if (view.needling.some((n) => n.inPlace && here(n.site.region, n.site.side) && Math.hypot(n.site.u - m.u, n.site.v - m.v) < 0.4)) continue;
      const t = label(`${m.target}${m.stale ? " (moved with the skin)" : ""}`, m.stale ? "mark stale" : "mark");
      t.position.copy(cross.position);
      this.marks.add(t);
    }
    for (const a of view.record.tenderPoints) {
      if (!here(a.region, a.side)) continue;
      const r = ring(a.radiusCm - 0.05, a.radiusCm, flat("#c2543f", 0.75), 64);
      r.position.copy(this.at(a.centre.u, a.centre.v, 0.02));
      const t = label(a.label, "tender");
      t.position.copy(r.position);
      this.marks.add(r, t);
    }
    for (const ref of view.teaching?.references ?? []) {
      if (!here(ref.region, ref.side)) continue;
      const r = ring(Math.max(0.05, ref.toleranceCm - 0.04), ref.toleranceCm, flat("#3fbf7f", 0.8), 64);
      r.position.copy(this.at(ref.u, ref.v, 0.03));
      const c = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12).rotateX(-Math.PI / 2), flat("#3fbf7f", 0.9));
      c.position.copy(r.position);
      const t = label(`${ref.target.split(":")[0]} ref`, "reference");
      t.center.set(1.1, 0.5);
      t.position.copy(r.position);
      this.marks.add(r, c, t);
    }

    // needles: those in place on this chart
    const now = new Set<string>();
    for (const n of view.needling) {
      if (!here(n.site.region, n.site.side)) continue;
      const existing = this.needles.get(n.needle);
      if (!n.inPlace) {
        if (existing && !existing.gone) {
          existing.gone = true;
          const last = view.last?.type === "remove_needle" || view.last?.type === "remove_all_needles";
          const done = () => this.dropNeedle(n.needle, n);
          if (last) existing.model.playWithdraw("quick", false, done);
          else done();
        } else if (!existing) this.hole(n);
        continue;
      }
      now.add(n.needle);
      let entry = existing;
      if (!entry) {
        const model = new NeedleModel(this.spec, 1, 2.2);
        model.group.position.copy(this.at(n.site.u, n.site.v, 0));
        const tag = label("", "needle");
        tag.center.set(-0.15, 0.5);
        model.group.add(tag);
        const dose = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.56, 48, 1, 0, 0.01).rotateX(-Math.PI / 2), flat("#46c2a5", 0.9));
        dose.position.copy(this.at(n.site.u, n.site.v, 0.03));
        this.needleGroup.add(model.group, dose);
        entry = { model, view: n, tag, dose, gone: false };
        this.needles.set(n.needle, entry);
        model.aim(n.angleDeg, n.azimuthDeg);
        model.setDepth(n.depthCm);
        if (view.last?.type === "insert_needle" && view.last.status !== "rejected") model.playInsert(view.last.message.includes("slowly") ? "slow" : "swift", n.method);
      } else {
        // a new working of the needle is played as it was done
        const before = entry.view.worked.length;
        if (n.worked.length > before && this.byHand === n.needle) this.byHand = null;
        else if (n.worked.length > before) {
          const w = n.worked[n.worked.length - 1]!;
          entry.model.play({ technique: w.technique, amplitudeMm: w.amplitudeMm, frequencyPerMin: w.frequencyPerMin, arcDeg: w.arcDeg, durationSec: w.durationSec, direction: w.direction, emphasis: w.emphasis });
        }
      }
      entry.view = n;
      entry.model.aim(n.angleDeg, n.azimuthDeg);
      entry.model.setDepth(n.depthCm);
      entry.model.setStuck(n.stuck);
      // the stimulation it has had, as an arc: full circle at what a typical patient tolerates
      const frac = Math.min(1, n.stimulation / 1.5);
      entry.dose.geometry.dispose();
      entry.dose.geometry = new THREE.RingGeometry(0.46, 0.56, 48, 1, Math.PI / 2, -Math.PI * 2 * Math.max(0.02, frac)).rotateX(-Math.PI / 2);
      (entry.dose.material as THREE.MeshBasicMaterial).color.set(n.stimulation >= 1.5 ? "#e2503c" : n.stimulation >= 1 ? "#e6a23c" : "#46c2a5");
      const latest = n.evidence[n.evidence.length - 1];
      const said = latest ? (latest.from === "patient" ? (latest.qualities.length ? latest.qualities.join(", ") : "nothing felt") : latest.grasp ? "grasps the needle" : latest.grasp === false ? "slack" : "") : "";
      entry.tag.element.textContent = `${n.target}${n.stuck ? " · bound: do not pull" : ""}${said ? ` · ${said}` : ""}`;
      entry.tag.element.className = `tag needle${n.stuck ? " stuck" : ""}${n.needle === this.selected ? " selected" : ""}`;
    }
    for (const [id, entry] of this.needles) {
      if (now.has(id) || entry.gone) continue;
      // no longer listed on this chart (a new visit): gone without ceremony
      this.release(id, entry);
    }
    if (this.selected && !this.needles.has(this.selected)) this.select(null);
    this.setTeachingNeedles(teachingNeedles);
  }

  /** The mark a withdrawn needle leaves: one for each needle, however often the chart is redrawn. */
  private hole(n: NeedleView): void {
    if (this.holed.has(n.needle)) return;
    this.holed.add(n.needle);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12).rotateX(-Math.PI / 2), flat("#8c2f2a", 0.75));
    dot.position.copy(this.at(n.site.u, n.site.v, 0.022));
    this.holes.add(dot);
  }

  private release(id: string, entry: { model: NeedleModel; tag: CSS2DObject; dose: THREE.Mesh }): void {
    entry.tag.removeFromParent();
    this.needleGroup.remove(entry.model.group, entry.dose);
    discard(entry.model.group);
    entry.dose.geometry.dispose();
    (entry.dose.material as THREE.Material).dispose();
    this.needles.delete(id);
  }

  private dropNeedle(id: string, n: NeedleView): void {
    const entry = this.needles.get(id);
    if (!entry) return;
    this.release(id, entry);
    this.hole(n);
  }

  select(needle: string | null): void {
    this.selected = needle && this.needles.has(needle) ? needle : null;
    for (const [id, e] of this.needles) {
      e.model.setHighlight(id === this.selected);
      e.tag.element.classList.toggle("selected", id === this.selected);
    }
    const e = this.selected ? this.needles.get(this.selected) : null;
    this.selection.visible = !!e;
    if (e) this.selection.position.copy(this.at(e.view.site.u, e.view.site.v, 0.028));
  }

  has(needle: string): boolean {
    return this.needles.has(needle);
  }

  /** A needle that is not there yet: where the form would put it. One model, moved as the form changes. */
  setGhost(g: Ghost | null): void {
    discard(this.ghostMarks);
    if (!g) {
      this.ghostGroup.visible = false;
      return;
    }
    if (!this.ghostModel) {
      const model = new NeedleModel(this.spec, 1, 2.2);
      const glow = new THREE.MeshStandardMaterial({ color: "#7fe3ff", emissive: "#2aa7d6", emissiveIntensity: 0.7, transparent: true, opacity: 0.55, depthWrite: false });
      model.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = glow;
      });
      this.ghostGroup.add(model.group, this.ghostMarks);
      this.ghostModel = model;
    }
    this.ghostGroup.visible = true;
    this.ghostModel.group.position.copy(this.at(g.u, g.v, 0));
    this.ghostModel.aim(g.angleDeg, g.azimuthDeg);
    this.ghostModel.setDepth(g.depthCm);
    const spot = ring(0.12, 0.2, flat("#7fe3ff", 0.95), 32);
    spot.position.copy(this.at(g.u, g.v, 0.035));
    this.ghostMarks.add(spot);
    // where the tip travels across the chart
    const theta = (g.angleDeg * Math.PI) / 180;
    const phi = (g.azimuthDeg * Math.PI) / 180;
    const reach = Math.sin(theta) * g.depthCm;
    if (reach > 0.05) {
      const lg = new THREE.BufferGeometry().setFromPoints([this.at(g.u, g.v, 0.03), this.at(g.u + reach * Math.sin(phi), g.v + reach * Math.cos(phi), 0.03)]);
      this.ghostMarks.add(new THREE.Line(lg, new THREE.LineDashedMaterial({ color: "#7fe3ff", dashSize: 0.18, gapSize: 0.12 })).computeLineDistances());
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teaching: under the skin                                          */
  /* ---------------------------------------------------------------- */

  private cores = new THREE.Group();
  private anatomy = new THREE.Group();
  private probeCore = new THREE.Group();

  private core(group: THREE.Group, u: number, v: number, strata: { tissue: string; from: number; to: number }[], radius = 0.75): void {
    // the strata as deep as a needle can go, and a little more: an organ's whole depth is not a core's business
    strata = strata.filter((x) => x.from < 9).map((x) => ({ ...x, to: Math.min(x.to, 9) }));
    for (const s of strata) {
      const h = Math.max(0.02, s.to - s.from);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 28), new THREE.MeshStandardMaterial({ color: tissueColor(s.tissue), roughness: 0.7, transparent: true, opacity: 0.62, depthWrite: false }));
      m.position.copy(this.at(u, v, -(s.from + s.to) / 2));
      group.add(m);
    }
  }

  /** The anatomy of the chart (teaching mode): structures, tissue zones and the landmarks' true places. */
  setTeachingRegion(t: TeachingRegion | null): void {
    discard(this.anatomy);
    if (!this.teach.children.includes(this.anatomy)) this.teach.add(this.anatomy, this.cores, this.probeCore);
    if (!t || !this.region || t.region !== this.region.id || t.side !== this.side) return;
    for (const s of t.structures) {
      const color = STRUCTURE[s.kind] ?? "#bbbbbb";
      const material = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.4, transparent: true, opacity: 0.88, emissive: color, emissiveIntensity: s.hazard === "critical" ? 0.25 : 0.08 });
      const pts = s.path.map((p) => this.at(p.u, p.v, -p.d));
      const m = pts.length === 1 ? new THREE.Mesh(new THREE.SphereGeometry(s.radiusCm, 20, 14), material) : new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.3), Math.max(12, pts.length * 10), s.radiusCm, 12, false), material);
      if (pts.length === 1) m.position.copy(pts[0]!);
      this.anatomy.add(m);
      const tag = label(brief(s.label), `structure ${s.hazard}`);
      tag.position.copy(pts[Math.floor(pts.length / 2)]!);
      this.anatomy.add(tag);
    }
    for (const z of t.zones) {
      const r = ring(z.radiusCm - 0.04, z.radiusCm, flat("#9aa7b3", 0.6), 72);
      r.position.copy(this.at(z.u, z.v, 0.018));
      this.anatomy.add(r);
    }
    for (const l of t.landmarks) {
      const r = ring(0.2, 0.26, flat("#5aa8ff", 0.7), 24);
      r.position.copy(this.at(l.u, l.v, 0.016));
      this.anatomy.add(r);
    }
  }

  private setTeachingNeedles(list: TeachingNeedle[]): void {
    discard(this.cores);
    for (const t of list) {
      const e = this.needles.get(t.needle);
      if (e) this.core(this.cores, e.view.site.u, e.view.site.v, t.strata);
    }
  }

  /** The strata under the ghost needle (teaching mode). */
  setProbe(g: Ghost | null, probe: Probe | null): void {
    discard(this.probeCore);
    if (g && probe) this.core(this.probeCore, g.u, g.v, probe.strata, 0.6);
  }

  /* ---------------------------------------------------------------- */
  /* The pointer                                                       */
  /* ---------------------------------------------------------------- */

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.gfx.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onChart(e: PointerEvent): { u: number; v: number } | null {
    if (!this.region) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.ndc(e), this.camera);
    const p = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!p) return null;
    const u = p.x;
    const v = -p.z;
    const [u0, u1] = this.region.uRange;
    const [v0, v1] = this.region.vRange;
    return u >= u0 && u <= u1 && v >= v0 && v <= v1 ? { u: Math.round(u * 10) / 10, v: Math.round(v * 10) / 10 } : null;
  }

  /** The needle whose handle is under the pointer. */
  private needleAt(e: PointerEvent): string | null {
    const r = this.gfx.canvas.getBoundingClientRect();
    let best: string | null = null;
    let bestD = 22;
    for (const [id, n] of this.needles) {
      if (n.gone) continue;
      for (const along of [n.model.lengthCm - n.view.depthCm + 1.2, n.model.lengthCm - n.view.depthCm, (n.model.lengthCm - n.view.depthCm) * 0.5]) {
        const p = n.model.group.localToWorld(new THREE.Vector3(0, along, 0)).project(this.camera);
        const d = Math.hypot(((p.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - p.y) / 2) * r.height - (e.clientY - r.top));
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
    return best;
  }

  private onDown(e: PointerEvent): void {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (e.button !== 0) return;
    const id = this.needleAt(e);
    if (!id) return;
    const n = this.needles.get(id)!;
    if (n.model.travelling) return;
    n.model.still();
    // the needle's own line on the screen: a drag along it lifts and thrusts, a drag across it twirls
    const r = this.gfx.canvas.getBoundingClientRect();
    const a = n.model.group.localToWorld(new THREE.Vector3(0, 0, 0)).project(this.camera);
    const b = n.model.group.localToWorld(new THREE.Vector3(0, 1, 0)).project(this.camera);
    const axis = new THREE.Vector2(((b.x - a.x) / 2) * r.width, (-(b.y - a.y) / 2) * r.height);
    const pxPerCm = Math.max(6, axis.length());
    this.grab = { needle: id, x: e.clientX, y: e.clientY, samples: [{ t: performance.now(), lift: 0, turn: 0 }], axis: axis.normalize(), pxPerCm, start: performance.now(), moved: false };
    this.controls.enabled = false;
    this.gfx.canvas.setPointerCapture(e.pointerId);
    this.select(id);
    this.events.select(id);
  }

  private onMove(e: PointerEvent): void {
    if (this.grab) {
      const g = this.grab;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      const alongPx = dx * g.axis.x + dy * g.axis.y;
      const acrossPx = dx * -g.axis.y + dy * g.axis.x;
      // lifted, never pushed past the depth it was set to
      const lift = THREE.MathUtils.clamp(alongPx / g.pxPerCm, 0, 1);
      const turn = (acrossPx * 1.6 * Math.PI) / 180;
      if (Math.abs(alongPx) > 3 || Math.abs(acrossPx) > 3) g.moved = true;
      const n = this.needles.get(g.needle);
      if (n) n.model.manual = { lift, turn };
      const now = performance.now();
      g.samples.push({ t: now, lift, turn });
      this.events.working({ needle: g.needle, liftMm: lift * 10, turnDeg: (turn * 180) / Math.PI, seconds: (now - g.start) / 1000 });
      return;
    }
    const at = this.onChart(e);
    this.cursor.visible = !!at;
    if (at) this.cursor.position.copy(this.at(at.u, at.v, 0.03));
    this.events.hover(at);
    this.gfx.canvas.style.cursor = this.needleAt(e) ? "grab" : at ? "crosshair" : "default";
  }

  private onUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (this.grab) {
      const g = this.grab;
      this.grab = null;
      this.controls.enabled = true;
      const n = this.needles.get(g.needle);
      if (n) n.model.manual = null;
      this.events.working(null);
      if (g.moved) {
        const r = readGesture(g.needle, g.samples);
        // what the hand has just done is not played back at it
        if (r.gesture) this.byHand = g.needle;
        this.events.gesture(r.gesture, r.why);
      }
      return;
    }
    if (!down || e.button !== 0) return;
    // a click, not the end of an orbit
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 500) return;
    const at = this.onChart(e);
    if (at) this.events.pick(at);
    else {
      this.select(null);
      this.events.select(null);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frames                                                            */
  /* ---------------------------------------------------------------- */

  resize(): void {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.gfx.resize(r.width, r.height);
    this.labels.setSize(r.width, r.height);
  }

  /** Let go of the view (another patient's charts are about to be built in its place). */
  dispose(): void {
    this.controls.dispose();
    this.gfx.dispose();
  }

  tick(dt: number, watch = true): void {
    this.clock += dt;
    if (this.pending) {
      const k = Math.min(1, dt * 5);
      this.controls.target.lerp(this.pending.target, k);
      this.camera.position.lerp(this.pending.position, k);
      if (this.controls.target.distanceTo(this.pending.target) < 0.05) this.pending = null;
    }
    this.controls.update();
    const t = this.controls.target;
    this.key.position.set(t.x - 26, 58, t.z + 30);
    this.key.target.position.copy(t);
    for (const n of this.needles.values()) n.model.update(dt, this.clock);
    this.ghostModel?.update(dt, this.clock);
    this.selection.rotation.y += dt * 0.6;
    this.gfx.render(dt, watch);
    this.labels.render(this.scene, this.camera);
  }
}
