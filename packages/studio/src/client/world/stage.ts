import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { SceneFixture, Side, Snapshot, StudioScene } from "../types.js";
import { buildClinic, type ClinicView } from "./clinic.js";
import { Gfx, type Quality } from "./gfx.js";
import { MaterialLibrary } from "./materials.js";
import { NeedleModel } from "./needle.js";
import { Mannequin, Walker, type Outfit, type Pose } from "./people.js";

/**
 * The clinic with the people in it, live. Everyone stands where the engine has them and walks the paths it planned;
 * the patient sits or lies as it positioned them, on the couch it put them on; each needle the practitioner believes
 * to be in place is on the body where its chart point lies. A click is a request, never an effect: it asks the
 * session to walk there, and the engine answers.
 */

export type CameraMode = "overview" | "follow" | "shoulder" | "plan";

export interface StageEvents {
  floor(at: { x: number; z: number }): void;
  fixture(f: SceneFixture): void;
  person(id: string): void;
  site(region: string, side: Side): void;
  hover(text: string | null): void;
  quality(q: Quality, why: string): void;
}

interface Person {
  id: string;
  figure: Mannequin;
  walker: Walker;
  tag: CSS2DObject;
}

const OUTFIT: Record<string, Outfit> = { "tcm-physician": "physician", physician: "physician", "clinic-assistant": "assistant", assistant: "assistant", supervisor: "supervisor" };

function tag(text: string, cls: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = `tag ${cls}`;
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.center.set(0.5, 1.4);
  return o;
}

function backdrop(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#c9d6e2");
  grad.addColorStop(0.55, "#e2e6e6");
  grad.addColorStop(1, "#b9bfb6");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/** The top of the surface one lies or sits on: the highest broad part under `below`. */
function surfaceTop(f: SceneFixture, below: number): number {
  let top = 0;
  const area = f.footprint.w * f.footprint.d;
  for (const p of f.parts) {
    const y = p.p[1] + p.s[1] / 2;
    if (p.s[0] * p.s[2] >= area * 0.3 && y <= below && y > top) top = y;
  }
  return top || Math.min(below, f.footprint.h);
}

export class ClinicStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 260);
  readonly gfx: Gfx;
  readonly controls: OrbitControls;
  readonly clinic: ClinicView;
  private labels: CSS2DRenderer;
  private people = new Map<string, Person>();
  private patient: Person;
  private needles = new Map<string, NeedleModel>();
  private needleGroup = new THREE.Group();
  private dots = new THREE.Group();
  private rings = new THREE.Group();
  private trail = new THREE.Group();
  private outline: THREE.LineLoop;
  private roomTags: CSS2DObject[] = [];
  private snapshot: Snapshot | null = null;
  private version = -1;
  private session = "";
  private clock = 0;
  mode: CameraMode = "overview";
  cutaway = true;
  showSites = true;
  showReach = false;
  private follow = new THREE.Vector3();
  private down: { x: number; y: number; t: number } | null = null;
  private fly: { target: THREE.Vector3; position: THREE.Vector3 } | null = null;

  constructor(
    readonly host: HTMLElement,
    readonly def: StudioScene,
    private events: StageEvents,
    quality: Quality,
  ) {
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    host.appendChild(this.labels.domElement);
    this.scene.background = backdrop();
    this.scene.fog = new THREE.Fog("#d5dbdc", 40, 120);
    this.clinic = buildClinic(def, new MaterialLibrary(def.materials));
    this.scene.add(this.clinic.group, this.needleGroup, this.dots, this.rings, this.trail);
    this.gfx = new Gfx(canvas, this.scene, this.camera, { quality, aoRadius: 0.55, bloom: 0.1, exposure: 0.8, environment: 0.38, onQuality: (q, why) => this.events.quality(q, why) });
    this.gfx.renderer.localClippingEnabled = true;
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 0.8, maxDistance: 60, maxPolarAngle: Math.PI * 0.495, zoomSpeed: 0.9, screenSpacePanning: false });

    for (const m of def.cast) {
      const figure = new Mannequin(m.underTest ? 1.72 : 1.66, OUTFIT[m.role] ?? (m.underTest ? "physician" : "assistant"), m.underTest ? "male" : "female");
      figure.root.userData.person = m.id;
      const t = tag(m.underTest ? "you" : m.name.replace(/\s*\(.*\)\s*$/, ""), m.underTest ? "person you" : "person");
      this.scene.add(figure.root, t);
      this.people.set(m.id, { id: m.id, figure, walker: new Walker(figure), tag: t });
    }
    const pf = new Mannequin(def.patient.heightM, "patient", def.patient.sex);
    pf.root.userData.person = "patient";
    const pt = tag(def.patient.name, "person patient");
    this.scene.add(pf.root, pt);
    this.patient = { id: "patient", figure: pf, walker: new Walker(pf, 1.9), tag: pt };

    for (const room of def.rooms) {
      const t = tag(room.label, "room");
      t.position.set((room.rect.minX + room.rect.maxX) / 2, 0.05, (room.rect.minZ + room.rect.maxZ) / 2);
      t.center.set(0.5, 0.5);
      this.roomTags.push(t);
      this.scene.add(t);
    }
    this.outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0.95, depthTest: false }));
    this.outline.visible = false;
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);

    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.outline.visible = false;
      this.events.hover(null);
    });
    this.setCamera("overview", true);
    this.clinic.setCutaway(true);
  }

  /* ---------------------------------------------------------------- */
  /* From the snapshot                                                 */
  /* ---------------------------------------------------------------- */

  private fixtureOf(placement: string | null): SceneFixture | null {
    return placement ? (this.def.fixtures.find((f) => f.id === placement) ?? null) : null;
  }

  private placePatient(s: Snapshot): void {
    const p = s.stage.patient;
    const figure = this.patient.figure;
    const seat = this.fixtureOf(p.on);
    const pose = p.position as Pose;
    if (p.lying && p.head && seat) {
      figure.setPose(pose);
      const half = seat.footprint.d / 2 - 0.08;
      figure.placeLying({ x: p.x + p.head.x * half, z: p.z + p.head.z * half }, p.head, surfaceTop(seat, 1.1));
    } else if (seat && pose !== "standing") {
      figure.setPose(pose === "seated-forward" ? "seated-forward" : "seated");
      const rot = (seat.rot * Math.PI) / 180;
      figure.placeSeated(p.x, p.z, { x: Math.sin(rot), z: Math.cos(rot) }, seat.fixture?.kind === "couch" ? surfaceTop(seat, 1.1) : surfaceTop(seat, 0.62));
    } else {
      figure.setPose("standing");
      this.patient.walker.set(p.x, p.z, p.yaw);
    }
  }

  /** Bring the stage to a snapshot: walks are played once, everything else is simply where it is. */
  update(s: Snapshot): void {
    const fresh = s.session.id !== this.session || s.session.version < this.version;
    const advanced = s.session.version !== this.version || fresh;
    this.session = s.session.id;
    this.version = s.session.version;
    this.snapshot = s;
    const walked = new Set<string>();
    let escorted: Snapshot["stage"]["walks"][number] | null = null;
    if (advanced && !fresh) {
      this.trail.clear();
      for (const w of s.stage.walks) {
        const person = this.people.get(w.actor);
        if (!person || w.metres <= 0) continue;
        const path = [w.from, ...w.path, w.to].filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1]!.x, p.z - a[i - 1]!.z) > 0.01);
        const final = s.stage.actors.find((a) => a.id === w.actor)!.yaw;
        if (!person.walker.walking) person.walker.set(w.from.x, w.from.z, person.walker.yaw);
        person.walker.walk(path, final);
        walked.add(w.actor);
        if (w.withPatient) escorted = w;
        const pts = path.map((p) => new THREE.Vector3(p.x, 0.015, p.z));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: "#2f8f83", dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.7 }));
        line.computeLineDistances();
        this.trail.add(line);
      }
    }
    for (const a of s.stage.actors) {
      const person = this.people.get(a.id);
      if (!person || walked.has(a.id)) continue;
      if (fresh || !person.walker.walking) person.walker.set(a.x, a.z, a.yaw);
    }
    if (escorted) {
      // the patient walks alongside, a pace behind, and then takes their seat
      const path = [escorted.from, ...escorted.path, escorted.to];
      this.patient.figure.setPose("standing");
      this.patient.walker.set(path[0]!.x + 0.5, path[0]!.z + 0.3, 0);
      this.patient.walker.walk(path.map((p) => ({ x: p.x + 0.35, z: p.z + 0.25 })), 0);
    } else if (!this.patient.walker.walking) this.placePatient(s);
    this.placeNeedles(s);
    this.placeSites(s);
    this.placeRings(s);
    // the practitioner's hand goes to the needle being placed or worked
    const me = this.people.get(s.session.actor);
    const last = s.view.last;
    const handed = last && last.status !== "rejected" && ["insert_needle", "adjust_needle", "remove_needle", "check_sensation", "apply_pressure"].includes(last.type);
    const latest = handed ? [...this.needles.entries()].find(([id]) => s.feed.at(-1) && JSON.stringify(s.feed.at(-1)!.action).includes(`"${id}"`)) : undefined;
    if (me && !me.walker.walking) me.figure.reachTo(latest ? latest[1].group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.03, 0)) : null);
  }

  private placeNeedles(s: Snapshot): void {
    const seen = new Set<string>();
    const figure = this.patient.figure;
    for (const n of s.view.needling) {
      if (!n.inPlace) continue;
      const map = this.def.bodyMap[n.site.region];
      const region = this.def.regions.find((r) => r.id === n.site.region);
      if (!map || !region) continue;
      seen.add(n.needle);
      let model = this.needles.get(n.needle);
      if (!model) {
        // drawn several times its true width, with a bright head: a needle has to be findable from across the room
        model = new NeedleModel({ diameterMm: 0.25, lengthMm: 40 }, 0.01, 9);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), new THREE.MeshStandardMaterial({ color: "#ffd9a0", emissive: "#ffb24a", emissiveIntensity: 2.2 }));
        head.position.y = 4 + 2.6;
        head.name = "head";
        model.group.add(head);
        this.needles.set(n.needle, model);
        this.needleGroup.add(model.group);
      }
      const du = n.site.u - (region.uRange[0] + region.uRange[1]) / 2;
      const dv = n.site.v - (region.vRange[0] + region.vRange[1]) / 2;
      const at = figure.surface(n.site.region, n.site.side as Side, map.axial, map.lateral, du * 0.5, dv * 0.5);
      model.group.position.copy(at.position);
      // perpendicular to the skin, leaned by the angle it was given
      const lean = new THREE.Vector3().crossVectors(at.normal, new THREE.Vector3(0, 1, 0.01)).normalize();
      const travel = at.normal.clone().negate().applyAxisAngle(lean, (n.angleDeg * Math.PI) / 180);
      model.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), travel);
      model.setDepth(n.depthCm);
      model.setStuck(n.stuck);
      const head = model.group.getObjectByName("head");
      if (head) head.position.y = 4 - n.depthCm + 2.7;
    }
    for (const [id, model] of this.needles) {
      if (seen.has(id)) continue;
      this.needleGroup.remove(model.group);
      this.needles.delete(id);
    }
  }

  private placeSites(s: Snapshot): void {
    this.dots.clear();
    if (!this.showSites || this.patient.walker.walking) return;
    const sites = s.view.space.patient.sites;
    const add = (key: string, inReach: boolean) => {
      const [regionId, side] = key.split(":") as [string, Side];
      const map = this.def.bodyMap[regionId];
      if (!map) return;
      const at = this.patient.figure.surface(regionId, side, map.axial, map.lateral);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(inReach ? 0.013 : 0.009, 12, 10), new THREE.MeshBasicMaterial({ color: inReach ? "#3fd3a8" : "#c9d2d6", transparent: true, opacity: inReach ? 0.9 : 0.4, depthTest: true }));
      dot.position.copy(at.position).addScaledVector(at.normal, 0.008);
      dot.userData.site = { region: regionId, side, inReach, title: this.def.regions.find((r) => r.id === regionId)?.title ?? regionId };
      this.dots.add(dot);
    };
    for (const k of sites.inReach) add(k, true);
    for (const k of sites.outOfReach) add(k.site, false);
  }

  private placeRings(s: Snapshot): void {
    this.rings.clear();
    if (!this.showReach) return;
    const me = s.stage.actors.find((a) => a.id === s.session.actor);
    if (!me) return;
    const ring = (radius: number, color: string, opacity: number) => {
      const g = new THREE.RingGeometry(radius - 0.012, radius + 0.012, 96);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.position.set(me.x, 0.02, me.z);
      this.rings.add(m);
    };
    ring(this.def.ranges.armReach, "#3fd3a8", 0.9);
    ring(this.def.ranges.contact, "#e6a23c", 0.7);
    ring(this.def.ranges.talk, "#6aa6ff", 0.45);
  }

  setShow(what: "sites" | "reach" | "labels", on: boolean): void {
    if (what === "sites") this.showSites = on;
    else if (what === "reach") this.showReach = on;
    else for (const t of this.roomTags) t.visible = on;
    if (this.snapshot) {
      this.placeSites(this.snapshot);
      this.placeRings(this.snapshot);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Cameras                                                           */
  /* ---------------------------------------------------------------- */

  private me(): Person | null {
    return this.snapshot ? (this.people.get(this.snapshot.session.actor) ?? null) : ([...this.people.values()][0] ?? null);
  }

  setCamera(mode: CameraMode, instant = false): void {
    this.mode = mode;
    const b = this.def.bounds;
    const centre = new THREE.Vector3((b.minX + b.maxX) / 2, 0.6, (b.minZ + b.maxZ) / 2 - 1);
    const me = this.me();
    const at = me ? new THREE.Vector3(me.walker.x, 1.1, me.walker.z) : centre.clone();
    let target = centre;
    let position = new THREE.Vector3(centre.x + 6.5, 14, centre.z + 15.5);
    if (mode === "overview") target = centre.clone().add(new THREE.Vector3(1.2, -0.6, 1.4));
    if (mode === "plan") position = new THREE.Vector3(centre.x, 34, centre.z + 0.01);
    else if (mode === "follow") {
      target = at;
      position = at.clone().add(new THREE.Vector3(3.2, 5.4, 5.6));
    } else if (mode === "shoulder" && me) {
      const yaw = me.walker.yaw;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      target = at.clone().addScaledVector(fwd, 1.1).setY(0.95);
      position = at.clone().addScaledVector(fwd, -1.5).add(new THREE.Vector3(fwd.z * 0.55, 0.95, -fwd.x * 0.55));
    }
    this.setCutaway(mode !== "shoulder");
    this.follow.copy(at);
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.fly = null;
    } else this.fly = { target, position };
  }

  setCutaway(on: boolean): void {
    this.cutaway = on;
    this.clinic.setCutaway(on);
  }

  /** Look at the patient from where a practitioner would stand back to see them whole. */
  lookAtPatient(): void {
    if (!this.snapshot) return;
    const p = this.snapshot.stage.patient;
    const target = new THREE.Vector3(p.x, 0.85, p.z);
    this.mode = "overview";
    this.fly = { target, position: target.clone().add(new THREE.Vector3(1.9, 2.5, 2.9)) };
  }

  /* ---------------------------------------------------------------- */
  /* The pointer                                                       */
  /* ---------------------------------------------------------------- */

  private hit(e: PointerEvent): { kind: "site"; site: { region: string; side: Side; inReach: boolean; title: string } } | { kind: "person"; id: string } | { kind: "fixture"; fixture: SceneFixture; object: THREE.Object3D } | { kind: "floor"; at: THREE.Vector3; room: string } | null {
    const r = this.gfx.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    // a site is a small target: it wins when the pointer is near it
    let best: { d: number; site: THREE.Object3D } | null = null;
    for (const dot of this.dots.children) {
      const p = dot.getWorldPosition(new THREE.Vector3()).project(this.camera);
      const d = Math.hypot(((p.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - p.y) / 2) * r.height - (e.clientY - r.top));
      if (d < 11 && (!best || d < best.d)) best = { d, site: dot };
    }
    if (best) return { kind: "site", site: best.site.userData.site };
    const figures = [...this.people.values(), this.patient].map((p) => p.figure.root);
    const hits = ray.intersectObjects([...figures, ...this.clinic.pickables], true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData.person) return { kind: "person", id: o.userData.person as string };
        if (o.userData.fixture) return { kind: "fixture", fixture: o.userData.fixture as SceneFixture, object: o };
        if (o.userData.room) return { kind: "floor", at: h.point, room: (o.userData.room as { label: string }).label };
        o = o.parent;
      }
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (e.buttons) return;
    const h = this.hit(e);
    this.outline.visible = false;
    let text: string | null = null;
    const view = this.snapshot?.view;
    if (h?.kind === "fixture") {
      const f = h.fixture;
      const hw = f.footprint.w / 2 + 0.03;
      const hd = f.footprint.d / 2 + 0.03;
      const pts = [new THREE.Vector3(-hw, 0.02, -hd), new THREE.Vector3(hw, 0.02, -hd), new THREE.Vector3(hw, 0.02, hd), new THREE.Vector3(-hw, 0.02, hd)].map((p) => h.object.localToWorld(p));
      this.outline.geometry.dispose();
      this.outline.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.outline.visible = true;
      const reach = f.fixture ? view?.space.fixtures.find((x) => x.id === f.fixture!.id) : null;
      text = f.fixture ? `${f.fixture.label} — ${reach ? (reach.inReach ? "within reach" : `${reach.distance.toFixed(1)} m away`) : ""} · click to walk to it` : f.label;
    } else if (h?.kind === "person") {
      const name = h.id === "patient" ? this.def.patient.name : (this.def.cast.find((c) => c.id === h.id)?.name ?? h.id);
      const d = h.id === "patient" ? view?.space.patient.distance : view?.space.team.find((t) => t.id === h.id)?.distance;
      text = `${name}${d !== undefined ? ` — ${d.toFixed(1)} m away` : ""}${h.id === this.snapshot?.session.actor ? "" : " · click to walk to them"}`;
    } else if (h?.kind === "site") text = `${h.site.side === "midline" ? "" : `${h.site.side} `}${h.site.title} — ${h.site.inReach ? "within arm's reach · click to open its chart" : "out of reach · click to walk to it"}`;
    else if (h?.kind === "floor") text = `${h.room} (${h.at.x.toFixed(1)}, ${h.at.z.toFixed(1)}) · click to walk here`;
    this.gfx.canvas.style.cursor = h && h.kind !== "floor" ? "pointer" : "default";
    this.events.hover(text);
  }

  private onUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 500) return;
    const h = this.hit(e);
    if (!h) return;
    if (h.kind === "site") this.events.site(h.site.region, h.site.side);
    else if (h.kind === "person") this.events.person(h.id);
    else if (h.kind === "fixture") this.events.fixture(h.fixture);
    else this.events.floor({ x: Math.round(h.at.x * 100) / 100, z: Math.round(h.at.z * 100) / 100 });
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

  tick(dt: number): void {
    this.clock += dt;
    let moving = false;
    for (const p of this.people.values()) {
      moving = p.walker.update(dt) || moving;
      p.tag.position.copy(p.figure.headTop()).add(new THREE.Vector3(0, 0.16, 0));
    }
    const wasWalking = this.patient.walker.walking;
    this.patient.walker.update(dt);
    if (wasWalking && !this.patient.walker.walking && this.snapshot) {
      this.placePatient(this.snapshot);
      this.placeNeedles(this.snapshot);
      this.placeSites(this.snapshot);
    }
    this.patient.tag.position.copy(this.patient.figure.headTop()).add(new THREE.Vector3(0, 0.2, 0));
    for (const n of this.needles.values()) n.update(dt, this.clock);
    if (!moving && this.trail.children.length) {
      for (const l of this.trail.children) {
        const m = (l as THREE.Line).material as THREE.Material;
        m.opacity = Math.max(0, m.opacity - dt * 0.35);
      }
      if (((this.trail.children[0] as THREE.Line).material as THREE.Material).opacity <= 0) this.trail.clear();
    }
    const me = this.me();
    if (this.fly) {
      const k = Math.min(1, dt * 4.5);
      this.controls.target.lerp(this.fly.target, k);
      this.camera.position.lerp(this.fly.position, k);
      if (this.camera.position.distanceTo(this.fly.position) < 0.03) this.fly = null;
    } else if (me && (this.mode === "follow" || this.mode === "shoulder")) {
      // the camera keeps its place relative to the practitioner
      const now = new THREE.Vector3(me.walker.x, this.mode === "follow" ? 1.1 : 0.95, me.walker.z);
      const delta = now.clone().sub(this.follow).setY(0);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    if (me) this.follow.set(me.walker.x, 1.1, me.walker.z);
    this.controls.update();
    // the ceiling is there for whoever stands under it
    this.clinic.ceiling.visible = !this.cutaway && this.camera.position.y < this.clinic.wallHeight;
    this.gfx.render(dt);
    this.labels.render(this.scene, this.camera);
  }
}
