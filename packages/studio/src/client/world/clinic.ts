import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneFixture, SceneOpening, StudioScene } from "../types.js";
import { MaterialLibrary, worldUV } from "./materials.js";

/**
 * The clinic, built from the scene the server describes: the same walls, openings and fixtures the engine's
 * collision model and reach rules are computed from, so what is drawn is what can be walked round and reached.
 * Walls are painted plaster with a dado, a rail and a skirting; windows are glazed; doors slide and stand open;
 * furniture is each catalog entry's boxes, bevelled and given real materials.
 */

export interface ClinicView {
  group: THREE.Group;
  /** Fixture groups by placement id (`userData.fixture` is the scene fixture). */
  fixtures: Map<string, THREE.Group>;
  floors: THREE.Mesh[];
  /** Things a pointer can hit: floors and fixtures. */
  pickables: THREE.Object3D[];
  ceiling: THREE.Group;
  roomLights: THREE.PointLight[];
  sun: THREE.DirectionalLight;
  wallHeight: number;
  /** Cut the walls down to the dado so the rooms can be looked into (null: whole walls). */
  setCutaway(on: boolean): void;
}

const DADO = 0.95;
/** Where the walls are cut for the view from above: just over the dado rail, under the window sills. */
const CUT = 1.0;
const TRIM = "#6b4a33";

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return worldUV(g);
}

function mesh(geometries: THREE.BufferGeometry[], material: THREE.Material, cast = true, receive = true): THREE.Mesh | null {
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  if (!merged) return null;
  const m = new THREE.Mesh(merged, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

/** A point on a wall: `along` its axis and `across` it (towards +z for an x wall, +x for a z wall). */
function onWall(o: Pick<SceneOpening, "axis" | "line">, along: number, across: number): { x: number; z: number } {
  return o.axis === "x" ? { x: along, z: o.line + across } : { x: o.line + across, z: along };
}

function alongBox(o: Pick<SceneOpening, "axis" | "line">, a: number, b: number, y0: number, y1: number, depth: number, across = 0): THREE.BufferGeometry {
  const c = onWall(o, (a + b) / 2, across);
  const len = Math.abs(b - a);
  return o.axis === "x" ? box(len, y1 - y0, depth, c.x, (y0 + y1) / 2, c.z) : box(depth, y1 - y0, len, c.x, (y0 + y1) / 2, c.z);
}

function buildFixture(f: SceneFixture, lib: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = `fixture:${f.id}`;
  group.position.set(f.x, 0, f.z);
  group.rotation.y = (f.rot * Math.PI) / 180;
  const byMaterial = new Map<string, THREE.BufferGeometry[]>();
  for (const part of f.parts) {
    const [sx, sy, sz] = part.s;
    const thin = Math.min(sx, sy, sz);
    const g: THREE.BufferGeometry = thin < 0.012 ? new THREE.BoxGeometry(sx, sy, sz) : new RoundedBoxGeometry(sx, sy, sz, 2, Math.min(0.014, thin * 0.3));
    if (part.r) g.rotateY((part.r * Math.PI) / 180);
    g.translate(part.p[0], part.p[1], part.p[2]);
    worldUV(g);
    // the two box kinds differ in whether they are indexed: merge needs them alike
    const flat = g.index ? g.toNonIndexed() : g;
    const list = byMaterial.get(part.m) ?? [];
    list.push(flat);
    byMaterial.set(part.m, list);
  }
  for (const [id, geometries] of byMaterial) {
    const m = mesh(geometries, lib.get(id), lib.casts(id));
    if (m) group.add(m);
  }
  group.userData.fixture = f;
  return group;
}

/** A window: frame, mullion, glass and an inner sill. */
function buildWindow(o: SceneOpening, frames: THREE.BufferGeometry[], glass: THREE.BufferGeometry[], sills: THREE.BufferGeometry[]): void {
  const bar = 0.055;
  const depth = 0.09;
  frames.push(alongBox(o, o.a, o.b, o.y0, o.y0 + bar, depth), alongBox(o, o.a, o.b, o.y1 - bar, o.y1, depth), alongBox(o, o.a, o.a + bar, o.y0, o.y1, depth), alongBox(o, o.b - bar, o.b, o.y0, o.y1, depth));
  const width = o.b - o.a;
  const panes = Math.max(1, Math.round(width / 1.1));
  for (let i = 1; i < panes; i++) {
    const at = o.a + (width * i) / panes;
    frames.push(alongBox(o, at - bar / 2, at + bar / 2, o.y0, o.y1, depth * 0.8));
  }
  glass.push(alongBox(o, o.a + bar, o.b - bar, o.y0 + bar, o.y1 - bar, 0.012));
  // the sill sits inside the room
  sills.push(alongBox(o, o.a - 0.04, o.b + 0.04, o.y0 - 0.035, o.y0, o.thickness + 0.1, -o.outward * 0.05));
}

/** A door that slides: its leaf parked beside the opening on the far side of the room, under a rail. */
function buildDoor(o: SceneOpening, out: { frames: THREE.BufferGeometry[]; leaves: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[]; rails: THREE.BufferGeometry[]; handles: THREE.BufferGeometry[] }): void {
  const width = o.b - o.a;
  const jamb = 0.05;
  // the lining of the opening
  out.frames.push(alongBox(o, o.a - jamb, o.a, o.y0, o.y1 + jamb, o.thickness + 0.04), alongBox(o, o.b, o.b + jamb, o.y0, o.y1 + jamb, o.thickness + 0.04), alongBox(o, o.a - jamb, o.b + jamb, o.y1, o.y1 + jamb, o.thickness + 0.04));
  if (o.kind === "opening") return;
  const across = o.outward * (o.thickness / 2 + 0.035);
  const glazed = !o.interior;
  const leaf = (from: number, to: number) => {
    if (glazed) {
      const s = 0.06;
      out.frames.push(alongBox(o, from, to, o.y0 + 0.01, o.y0 + s, 0.04, across), alongBox(o, from, to, o.y1 - s, o.y1, 0.04, across), alongBox(o, from, from + s, o.y0, o.y1, 0.04, across), alongBox(o, to - s, to, o.y0, o.y1, 0.04, across));
      out.glass.push(alongBox(o, from + s, to - s, o.y0 + s, o.y1 - s, 0.012, across));
    } else {
      out.leaves.push(alongBox(o, from, to, o.y0 + 0.01, o.y1, 0.042, across));
      // a vision panel and a pull handle
      out.glass.push(alongBox(o, (from + to) / 2 - 0.09, (from + to) / 2 + 0.09, 1.25, 1.85, 0.046, across));
    }
    const pull = Math.abs(from - o.a) < Math.abs(to - o.b) ? to - 0.09 : from + 0.09;
    out.handles.push(alongBox(o, pull - 0.012, pull + 0.012, 0.9, 1.25, 0.03, across + o.outward * 0.035));
  };
  if (o.kind === "double-door" || o.kind === "sliding-door") {
    const half = width / 2;
    leaf(Math.max(o.from, o.a - half + 0.08), Math.max(o.from, o.a - half + 0.08) + half);
    leaf(Math.min(o.to, o.b + half - 0.08) - half, Math.min(o.to, o.b + half - 0.08));
    out.rails.push(alongBox(o, o.a - half, o.b + half, o.y1 + 0.02, o.y1 + 0.09, 0.07, across));
  } else {
    // park on the side with more wall
    const left = o.a - o.from >= o.to - o.b;
    const start = left ? Math.max(o.from, o.a - width + 0.06) : Math.min(o.to - width, o.b - 0.06);
    leaf(start, start + width);
    out.rails.push(alongBox(o, Math.min(start, o.a) - 0.05, Math.max(start + width, o.b) + 0.05, o.y1 + 0.02, o.y1 + 0.09, 0.07, across));
  }
}

export function buildClinic(scene: StudioScene, lib: MaterialLibrary): ClinicView {
  const group = new THREE.Group();
  group.name = "clinic";
  const wallHeight = Math.max(...scene.buildings.map((b) => b.wallHeight), 2.8);
  const b = scene.bounds;

  // the ground outside
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: "#9aa094", roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((b.minX + b.maxX) / 2, -0.06, (b.minZ + b.maxZ) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // slabs and floors
  const floors: THREE.Mesh[] = [];
  for (const bd of scene.buildings) {
    const slab = new THREE.Mesh(box(bd.rect.maxX - bd.rect.minX + 0.5, 0.06, bd.rect.maxZ - bd.rect.minZ + 0.5, (bd.rect.minX + bd.rect.maxX) / 2, -0.031, (bd.rect.minZ + bd.rect.maxZ) / 2), new THREE.MeshStandardMaterial({ color: "#8f8f88", roughness: 0.95 }));
    slab.receiveShadow = true;
    group.add(slab);
  }
  for (const room of scene.rooms) {
    const w = room.rect.maxX - room.rect.minX;
    const d = room.rect.maxZ - room.rect.minZ;
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate((room.rect.minX + room.rect.maxX) / 2, 0, (room.rect.minZ + room.rect.maxZ) / 2);
    worldUV(g);
    const floor = new THREE.Mesh(g, lib.floor(room.kind, room.floor));
    floor.receiveShadow = true;
    floor.name = `floor:${room.id}`;
    floor.userData.room = room;
    floors.push(floor);
    group.add(floor);
  }

  // walls: a dado, the body above it, a rail and a skirting, and a dark cap where the section is cut
  const body = new Map<string, THREE.BufferGeometry[]>();
  const dado = new Map<string, THREE.BufferGeometry[]>();
  const trims: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  const cutCaps: THREE.BufferGeometry[] = [];
  // everything that is building is cut by one plane; furniture and people never are
  const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1000);
  const arch = <M extends THREE.Material>(material: M): M => {
    const m = material.clone() as M;
    m.clippingPlanes = [cut];
    m.clipShadows = true;
    return m;
  };
  const push = (map: Map<string, THREE.BufferGeometry[]>, key: string, g: THREE.BufferGeometry) => {
    const list = map.get(key) ?? [];
    list.push(g);
    map.set(key, list);
  };
  for (const wall of scene.walls) {
    const bodyColor = lib.colorOf(wall.materials.body, "#e6e2d2");
    const dadoColor = lib.colorOf(wall.materials.base, "#3f7f74");
    for (const bx of wall.boxes) {
      const y0 = bx.minY;
      const y1 = Math.min(bx.maxY, wallHeight);
      if (y1 - y0 < 0.01) continue;
      const w = bx.maxX - bx.minX;
      const d = bx.maxZ - bx.minZ;
      const cx = (bx.minX + bx.maxX) / 2;
      const cz = (bx.minZ + bx.maxZ) / 2;
      const alongX = w >= d;
      if (y0 < DADO) push(dado, dadoColor, box(w, Math.min(y1, DADO) - y0, d, cx, (y0 + Math.min(y1, DADO)) / 2, cz));
      if (y1 > DADO) push(body, bodyColor, box(w, y1 - Math.max(y0, DADO), d, cx, (y1 + Math.max(y0, DADO)) / 2, cz));
      const grow = 0.035;
      if (y0 < 0.01) trims.push(box(alongX ? w : w + grow, 0.09, alongX ? d + grow : d, cx, 0.045, cz));
      if (y0 < DADO && y1 > DADO) trims.push(box(alongX ? w : w + grow, 0.045, alongX ? d + grow : d, cx, DADO, cz));
      if (y1 >= wallHeight - 0.01) caps.push(box(w + 0.002, 0.02, d + 0.002, cx, wallHeight + 0.01, cz));
      if (y0 < CUT && y1 > CUT) cutCaps.push(box(w + 0.002, 0.012, d + 0.002, cx, CUT + 0.006, cz));
    }
  }
  for (const [color, gs] of body) {
    const m = mesh(gs, arch(lib.wall(color)));
    if (m) group.add(m);
  }
  for (const [color, gs] of dado) {
    const m = mesh(gs, arch(lib.wall(color, true)));
    if (m) group.add(m);
  }
  const trimMesh = mesh(trims, arch(lib.trim(TRIM)));
  if (trimMesh) group.add(trimMesh);
  const capMaterial = new THREE.MeshStandardMaterial({ color: "#2f3437", roughness: 0.9 });
  const capMesh = mesh(caps, capMaterial, false, false);
  if (capMesh) group.add(capMesh);
  const cutCapMesh = mesh(cutCaps, capMaterial, false, false);
  if (cutCapMesh) {
    cutCapMesh.visible = false;
    group.add(cutCapMesh);
  }

  // windows and doors
  const frames: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const sills: THREE.BufferGeometry[] = [];
  const doors = { frames: [] as THREE.BufferGeometry[], leaves: [] as THREE.BufferGeometry[], glass, rails: [] as THREE.BufferGeometry[], handles: [] as THREE.BufferGeometry[] };
  for (const o of scene.openings) {
    if (o.kind === "window") buildWindow(o, frames, glass, sills);
    else buildDoor(o, doors);
  }
  const white = new THREE.MeshPhysicalMaterial({ color: "#f3f2ec", roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  for (const m of [
    mesh(frames, arch(white)),
    mesh(sills, arch(lib.trim("#a87948"))),
    mesh(doors.frames, arch(lib.trim(TRIM))),
    mesh(doors.leaves, arch(lib.trim("#b58a5c"))),
    mesh(doors.rails, arch(lib.get("steel"))),
    mesh(doors.handles, arch(lib.get("chrome"))),
    mesh(glass, arch(lib.get("glass")), false, false),
  ]) {
    if (m) group.add(m);
  }

  // the ceiling: seen from inside the rooms only, so the clinic can be looked into from above
  const ceiling = new THREE.Group();
  ceiling.name = "ceiling";
  const panels: THREE.BufferGeometry[] = [];
  const roomLights: THREE.PointLight[] = [];
  for (const bd of scene.buildings) {
    const g = new THREE.PlaneGeometry(bd.rect.maxX - bd.rect.minX, bd.rect.maxZ - bd.rect.minZ);
    g.rotateX(Math.PI / 2);
    g.translate((bd.rect.minX + bd.rect.maxX) / 2, bd.wallHeight, (bd.rect.minZ + bd.rect.maxZ) / 2);
    const plane = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#f4f3ee", roughness: 0.95, side: THREE.FrontSide }));
    plane.receiveShadow = false;
    ceiling.add(plane);
  }
  for (const room of scene.rooms) {
    for (const l of room.lights) {
      const g = new THREE.PlaneGeometry(1.2, 0.3);
      g.rotateX(Math.PI / 2);
      g.translate(l.x, wallHeight - 0.012, l.z);
      panels.push(g);
      const light = new THREE.PointLight("#fff1dc", 9, 9, 2);
      light.position.set(l.x, wallHeight - 0.35, l.z);
      light.castShadow = false;
      roomLights.push(light);
      group.add(light);
    }
  }
  const panelMesh = mesh(panels, new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#fff3df", emissiveIntensity: 3.5, side: THREE.FrontSide }), false, false);
  if (panelMesh) ceiling.add(panelMesh);
  group.add(ceiling);

  // daylight from the south-east, through the windows
  const sun = new THREE.DirectionalLight("#fff1dc", 2.1);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  sun.position.set(cx + 9, 16, cz + 11);
  sun.target.position.set(cx, 0, cz - 1);
  sun.castShadow = true;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 1;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 50 });
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 5;
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight("#dfe9f2", "#8f8a7c", 0.32));

  // furniture
  const fixtures = new Map<string, THREE.Group>();
  for (const f of scene.fixtures) {
    const g = buildFixture(f, lib);
    fixtures.set(f.id, g);
    group.add(g);
  }

  const setCutaway = (on: boolean) => {
    cut.constant = on ? CUT : 1000;
    if (capMesh) capMesh.visible = !on;
    if (cutCapMesh) cutCapMesh.visible = on;
    ceiling.visible = !on;
  };
  return { group, fixtures, floors, pickables: [...floors, ...fixtures.values()], ceiling, roomLights, sun, wallHeight, setCutaway };
}
