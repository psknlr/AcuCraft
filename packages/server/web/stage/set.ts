import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * The rooms the encounter happens in, as a set: the treatment room (the couch with its breathing hole, the needle
 * trolley, the heat lamp, the herb cabinet, the meridian chart and the bronze meridian figure — the pack's own
 * models, built in Blender, as the 3D world draws them) and the consultation room (a desk with the pulse cushion,
 * two chairs). Floors, walls, the window with its blinds and the privacy curtain are made here.
 */

export interface ModelRef {
  file: string;
  offset: [number, number, number];
  scale: number;
}

/** Top of the couch's padding (the needling stations' bodies lie at this height: tools/blender/fit). */
export const COUCH_TOP = 0.67;
/** Top of the patient chair's seat. */
export const SEAT_TOP = 0.46;

export const TREATMENT = {
  origin: { x: 0, z: 0 },
  couch: { x: 0, z: 0.1, rot: 0 },
  trolley: { x: 0.98, z: 1.12, rot: -90 },
  lamp: { x: -0.95, z: 1.05, rot: 90 },
  cabinet: { x: 0.75, z: -2.02, rot: 0 },
  chart: { x: -2.36, z: -0.55, rot: 90 },
  statue: { x: -1.75, z: -1.7, rot: 35 },
  shelf: { x: 2.17, z: -0.75, rot: -90 },
  chair: { x: -1.35, z: 1.45, rot: 135 },
  room: { x0: -2.4, x1: 2.4, z0: -2.3, z1: 2.8 },
};

export const CONSULT = {
  origin: { x: 9, z: 0 },
  desk: { x: 9, z: -0.25 },
  patientChair: { x: 9.05, z: 0.6, rot: 180 },
  practitionerChair: { x: 8.95, z: -1.05, rot: 0 },
  cushion: { x: 9.05, z: 0.0 },
  cabinet: { x: 10.05, z: -2.02, rot: 0 },
  chart: { x: 11.36, z: -0.5, rot: -90 },
  statue: { x: 7.0, z: -1.75, rot: 20 },
  room: { x0: 6.6, x1: 11.4, z0: -2.3, z1: 2.8 },
};

/* ------------------------------------------------------------------ */
/* surfaces                                                            */
/* ------------------------------------------------------------------ */

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A seeded random number in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Sheet vinyl, a little mottled and flecked. */
function floorTexture(): CanvasTexture {
  return canvas(512, 512, (g) => {
    const r = rng(7);
    g.fillStyle = "#d9d6cf";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 220; i++) {
      const x = r() * 512, y = r() * 512, rad = 20 + r() * 70;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const tone = r() > 0.5 ? "255,255,250" : "190,186,178";
      grad.addColorStop(0, `rgba(${tone},0.07)`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    for (let i = 0; i < 2600; i++) {
      const x = r() * 512, y = r() * 512;
      const k = r();
      g.fillStyle = k < 0.33 ? "rgba(120,116,108,0.14)" : k < 0.66 ? "rgba(250,248,240,0.3)" : "rgba(150,160,155,0.12)";
      g.fillRect(x, y, 1 + r(), 1 + r());
    }
  });
}

/** Painted plaster: almost flat. */
function paintTexture(base: string): CanvasTexture {
  return canvas(256, 256, (g) => {
    const r = rng(base.length * 97);
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = r() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
      g.fillRect(r() * 256, r() * 256, 2, 2);
    }
  });
}

/** Light oak, with its grain along the board. */
function woodTexture(): CanvasTexture {
  return canvas(512, 128, (g) => {
    const r = rng(11);
    g.fillStyle = "#b98d5f";
    g.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 90; i++) {
      const y = r() * 128;
      g.strokeStyle = `rgba(${r() > 0.5 ? "120,80,45" : "215,180,140"},${0.12 + r() * 0.18})`;
      g.lineWidth = 0.6 + r() * 1.8;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / (40 + r() * 30) + i) * (1 + r() * 2.5));
      g.stroke();
    }
  });
}

const mat = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]) => new MeshStandardMaterial(o);

function box(w: number, h: number, d: number, m: Material, x: number, y: number, z: number, opts: { cast?: boolean; receive?: boolean } = {}): Mesh {
  const mesh = new Mesh(new BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = opts.cast ?? true;
  mesh.receiveShadow = opts.receive ?? true;
  return mesh;
}

/** A curtain hanging in folds from `y` down to just above the floor, `width` wide along +X. */
function curtain(width: number, height: number, m: Material): Mesh {
  const folds = Math.round(width / 0.11);
  const g = new PlaneGeometry(width, height, folds * 8, 6);
  const pos = g.attributes.position as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const down = (height / 2 - y) / height;
    pos.setZ(i, Math.sin((x / width) * folds * Math.PI * 2) * (0.035 + 0.012 * down));
  }
  g.computeVertexNormals();
  const mesh = new Mesh(g, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* the rooms                                                           */
/* ------------------------------------------------------------------ */

/** The window: from the chair rail up. */
const WIN_Y0 = 1.02;
const WIN_Y1 = 2.3;

interface Room {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function shell(room: Room, surfaces: Surfaces, window: { wall: "left"; z: number; width: number }): Group {
  const g = new Group();
  const w = room.x1 - room.x0, d = room.z1 - room.z0, cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2;
  const floor = new Mesh(new PlaneGeometry(w, d), surfaces.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  g.add(floor);
  const ceiling = new Mesh(new PlaneGeometry(w, d), surfaces.ceiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, 2.75, cz);
  g.add(ceiling);
  // walls: a mint dado to the chair rail, warm white above (they take shadows, they cast none: the window's light comes in)
  const wall = (len: number, x: number, z: number, rot: number, holes?: { from: number; to: number; y0: number; y1: number }) => {
    const add = (wl: number, hl: number, ox: number, oy: number, m: Material) => {
      if (wl <= 0 || hl <= 0) return;
      const p = new Mesh(new PlaneGeometry(wl, hl), m);
      p.position.set(ox, oy, 0);
      p.receiveShadow = true;
      wallGroup.add(p);
    };
    const wallGroup = new Group();
    wallGroup.position.set(x, 0, z);
    wallGroup.rotation.y = rot;
    const rail = 1.02;
    if (!holes) {
      add(len, rail, 0, rail / 2, surfaces.dado);
      add(len, 2.75 - rail, 0, rail + (2.75 - rail) / 2, surfaces.wall);
    } else {
      const a = holes.from + len / 2, b = holes.to + len / 2;
      add(a, rail, -len / 2 + a / 2, rail / 2, surfaces.dado);
      add(len - b, rail, len / 2 - (len - b) / 2, rail / 2, surfaces.dado);
      add(b - a, holes.y0 - rail, holes.from + (b - a) / 2, rail + (holes.y0 - rail) / 2, surfaces.wall);
      add(b - a, rail, holes.from + (b - a) / 2, rail / 2, surfaces.dado);
      add(a, 2.75 - rail, -len / 2 + a / 2, rail + (2.75 - rail) / 2, surfaces.wall);
      add(len - b, 2.75 - rail, len / 2 - (len - b) / 2, rail + (2.75 - rail) / 2, surfaces.wall);
      add(b - a, 2.75 - holes.y1, holes.from + (b - a) / 2, holes.y1 + (2.75 - holes.y1) / 2, surfaces.wall);
    }
    const railMesh = box(len, 0.035, 0.022, surfaces.trim, 0, rail, 0.011, { cast: false });
    const skirt = box(len, 0.1, 0.018, surfaces.skirting, 0, 0.05, 0.009, { cast: false });
    wallGroup.add(railMesh, skirt);
    g.add(wallGroup);
    return wallGroup;
  };
  // (along the left wall its own +x runs towards −z)
  const along = -(window.z - cz);
  wall(d, room.x0, cz, Math.PI / 2, { from: along - window.width / 2, to: along + window.width / 2, y0: WIN_Y0, y1: WIN_Y1 });
  wall(w, cx, room.z0, 0);
  wall(d, room.x1, cz, -Math.PI / 2);
  // the window: daylight beyond, a white frame and blinds half down (their shadow falls in stripes)
  const win = new Group();
  win.position.set(room.x0 - 0.04, 0, window.z);
  win.rotation.y = Math.PI / 2;
  const mid = (WIN_Y0 + WIN_Y1) / 2, tall = WIN_Y1 - WIN_Y0;
  const sky = new Mesh(new PlaneGeometry(window.width, tall), surfaces.sky);
  sky.position.set(0, mid, -0.08);
  win.add(sky);
  const frame = (wv: number, hv: number, x: number, y: number) => win.add(box(wv, hv, 0.06, surfaces.trim, x, y, 0, { cast: true }));
  frame(window.width + 0.08, 0.05, 0, WIN_Y0);
  frame(window.width + 0.08, 0.05, 0, WIN_Y1);
  frame(0.05, tall + 0.05, -window.width / 2, mid);
  frame(0.05, tall + 0.05, window.width / 2, mid);
  frame(0.04, tall, 0, mid);
  const sill = box(window.width + 0.16, 0.03, 0.18, surfaces.trim, 0, WIN_Y0 - 0.02, 0.07);
  win.add(sill);
  for (let i = 0; i < 15; i++) {
    const slat = box(window.width - 0.04, 0.004, 0.05, surfaces.blind, 0, WIN_Y1 - 0.06 - i * 0.042, 0.06, { cast: true, receive: false });
    slat.rotation.x = 0.55;
    win.add(slat);
  }
  g.add(win);
  // the light on the ceiling
  const panel = box(1.2, 0.03, 0.6, surfaces.lightPanel, cx, 2.735, cz - 0.2, { cast: false, receive: false });
  g.add(panel);
  return g;
}

interface Surfaces {
  floor: MeshStandardMaterial;
  ceiling: MeshStandardMaterial;
  wall: MeshStandardMaterial;
  dado: MeshStandardMaterial;
  trim: MeshStandardMaterial;
  skirting: MeshStandardMaterial;
  sky: MeshStandardMaterial;
  blind: MeshStandardMaterial;
  lightPanel: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  curtain: MeshStandardMaterial;
  steel: MeshStandardMaterial;
  screen: MeshStandardMaterial;
  plastic: MeshStandardMaterial;
}

function surfaces(): Surfaces {
  const floorMap = floorTexture();
  floorMap.repeat.set(5, 5);
  const wallMap = paintTexture("#f3efe6");
  wallMap.repeat.set(3, 2);
  const dadoMap = paintTexture("#c9dfd3");
  dadoMap.repeat.set(3, 1);
  const wood = woodTexture();
  wood.repeat.set(1.5, 1);
  return {
    floor: mat({ map: floorMap, roughness: 0.62, metalness: 0 }),
    ceiling: mat({ color: 0xf6f4ef, roughness: 0.95 }),
    wall: mat({ map: wallMap, roughness: 0.92 }),
    dado: mat({ map: dadoMap, roughness: 0.75 }),
    trim: mat({ color: 0xf7f6f2, roughness: 0.45 }),
    skirting: mat({ color: 0x8e9b95, roughness: 0.5 }),
    sky: mat({ color: 0xffffff, emissive: new Color(0xeaf3ff), emissiveIntensity: 1.6, roughness: 1 }),
    blind: mat({ color: 0xf2f0ea, roughness: 0.5, side: DoubleSide }),
    lightPanel: mat({ color: 0xffffff, emissive: new Color(0xfff8ee), emissiveIntensity: 2.2 }),
    wood: mat({ map: wood, roughness: 0.48, metalness: 0 }),
    curtain: mat({ color: 0xb9d6cc, roughness: 0.88, side: DoubleSide }),
    steel: mat({ color: 0xc9ced3, metalness: 1, roughness: 0.28 }),
    screen: mat({ color: 0x0d1418, roughness: 0.18, metalness: 0.2, emissive: new Color(0x1a3a46), emissiveIntensity: 0.6 }),
    plastic: mat({ color: 0x2b2f33, roughness: 0.55 }),
  };
}

/** A desk of light oak on steel legs, with a screen and a keyboard. */
function desk(s: Surfaces): Group {
  const g = new Group();
  g.add(box(1.35, 0.035, 0.72, s.wood, 0, 0.745, 0));
  for (const [x, z] of [[-0.62, -0.31], [0.62, -0.31], [-0.62, 0.31], [0.62, 0.31]] as const) {
    const leg = new Mesh(new CylinderGeometry(0.018, 0.018, 0.73, 12), s.steel);
    leg.position.set(x, 0.365, z);
    leg.castShadow = true;
    g.add(leg);
  }
  g.add(box(1.2, 0.3, 0.02, s.wood, 0, 0.55, -0.33));
  const stand = box(0.06, 0.22, 0.04, s.plastic, -0.35, 0.87, -0.2);
  const screen = box(0.56, 0.34, 0.025, s.plastic, -0.35, 1.08, -0.2);
  const glass = new Mesh(new PlaneGeometry(0.53, 0.31), s.screen);
  glass.position.set(-0.35, 1.08, -0.187);
  g.add(stand, screen, glass, box(0.42, 0.015, 0.14, s.plastic, -0.3, 0.77, 0.05));
  return g;
}

/* ------------------------------------------------------------------ */
/* the set                                                             */
/* ------------------------------------------------------------------ */

export interface Sets {
  root: Group;
  /** The couch's model, once loaded (what a body lies on). */
  ready: Promise<void>;
}

/** The two rooms, their furniture loading in the background (`ready`). */
export function buildSets(models: Record<string, ModelRef>, modelUrl: (file: string) => string): Sets {
  const s = surfaces();
  const root = new Group();
  root.name = "set";
  root.add(shell(TREATMENT.room, s, { wall: "left", z: 1.15, width: 1.7 }));
  const consult = shell(CONSULT.room, s, { wall: "left", z: 0.2, width: 1.5 });
  root.add(consult);
  const d = desk(s);
  d.position.set(CONSULT.desk.x, 0, CONSULT.desk.z);
  root.add(d);
  // the privacy curtain on its track, drawn back along the far side of the couch
  const track = new Mesh(new CylinderGeometry(0.012, 0.012, 2.6, 8), s.steel);
  track.rotation.x = Math.PI / 2;
  track.position.set(-1.95, 2.55, -0.3);
  const drape = curtain(1.0, 2.3, s.curtain);
  drape.rotation.y = Math.PI / 2;
  drape.position.set(-1.95, 1.4, -1.55);
  root.add(track, drape);

  const loader = new GLTFLoader();
  const place = async (type: string, at: { x: number; z: number; rot?: number }, y = 0) => {
    const ref = models[type];
    if (!ref) return;
    const gltf = await loader.loadAsync(modelUrl(ref.file));
    const obj: Object3D = gltf.scene;
    obj.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      const mm = m.material as MeshStandardMaterial;
      if (mm && "envMapIntensity" in mm) mm.envMapIntensity = 0.9;
    });
    const holder = new Group();
    obj.scale.setScalar(ref.scale || 1);
    obj.position.set(...ref.offset);
    holder.add(obj);
    holder.position.set(at.x, y, at.z);
    holder.rotation.y = ((at.rot ?? 0) * Math.PI) / 180;
    holder.name = type;
    root.add(holder);
  };
  const ready = Promise.allSettled([
    place("acu-treatment-couch", TREATMENT.couch),
    place("acu-needle-trolley", TREATMENT.trolley),
    place("acu-heat-lamp", TREATMENT.lamp),
    place("acu-herb-cabinet", TREATMENT.cabinet),
    place("acu-meridian-chart", TREATMENT.chart),
    place("acu-meridian-model", TREATMENT.statue),
    place("acu-supply-shelf", TREATMENT.shelf),
    place("acu-patient-chair", TREATMENT.chair),
    place("acu-patient-chair", CONSULT.patientChair),
    place("acu-patient-chair", CONSULT.practitionerChair),
    place("acu-pulse-cushion", CONSULT.cushion, 0.762),
    place("acu-herb-cabinet", CONSULT.cabinet),
    place("acu-meridian-chart", CONSULT.chart),
    place("acu-meridian-model", CONSULT.statue),
  ]).then(() => undefined);
  return { root, ready };
}
