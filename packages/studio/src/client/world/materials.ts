import * as THREE from "three";

/**
 * Physically based materials for the clinic, made in the page: no image is downloaded. Each surface gets a colour map,
 * and where it matters a normal and a roughness map, drawn from seeded noise — wood with its grain and plank joints,
 * speckled vinyl, plaster, upholstery, skin with pores and fine lines. A catalog's material id (`steel`, `mattress`,
 * `glass` …) picks the recipe; an id nobody has a recipe for falls back to the colour its catalog gives it.
 */

export interface MaterialDefLike {
  id: string;
  color: string;
  pattern?: string;
  emissive?: string | undefined;
  emissiveIntensity?: number;
  opacity?: number;
  roughness?: number;
  metalness?: number;
  castShadow?: boolean;
}

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a lattice of `period` cells. */
function lattice(seed: number, period: number): (x: number, y: number) => number {
  const r = rng(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const at = (ix: number, iy: number) => grid[(((iy % period) + period) % period) * period + (((ix % period) + period) % period)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const a = at(ix, iy);
    const b = at(ix + 1, iy);
    const c = at(ix, iy + 1);
    const d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** Fractal noise in 0…1, tileable over the unit square. */
function fbm(seed: number, base: number, octaves: number): (u: number, v: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) => ({ n: lattice(seed + i * 101, base * 2 ** i), f: base * 2 ** i, a: 0.5 ** i }));
  const total = layers.reduce((s, l) => s + l.a, 0);
  return (u, v) => layers.reduce((s, l) => s + l.n(u * l.f, v * l.f) * l.a, 0) / total;
}

/* ------------------------------------------------------------------ */
/* Canvas textures                                                     */
/* ------------------------------------------------------------------ */

interface Maps {
  map: THREE.CanvasTexture;
  normalMap?: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

function canvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return { c, g: c.getContext("2d", { willReadFrequently: true })! };
}

function texture(c: HTMLCanvasElement, colour: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A tangent-space normal map from a height field (0…1), tileable. */
function normalsFrom(height: Float32Array, size: number, strength: number): THREE.CanvasTexture {
  const { c, g } = canvas(size);
  const img = g.createImageData(size, size);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx / len) * 127.5 + 127.5;
      img.data[i + 1] = (dy / len) * 127.5 + 127.5;
      img.data[i + 2] = (1 / len) * 127.5 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return texture(c, false);
}

function greyFrom(values: Float32Array, size: number): THREE.CanvasTexture {
  const { c, g } = canvas(size);
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(1, values[i]!)) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return texture(c, false);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Paint a colour map pixel by pixel from a function of (u, v) giving [r, g, b] in 0…1. */
function paint(size: number, f: (u: number, v: number, x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const { c, g } = canvas(size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, gr, b] = f(x / size, y / size, x, y);
      const i = (y * size + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, r * 255));
      img.data[i + 1] = Math.max(0, Math.min(255, gr * 255));
      img.data[i + 2] = Math.max(0, Math.min(255, b * 255));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

const rgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  // colour maps are painted in sRGB
  c.convertLinearToSRGB();
  return [c.r, c.g, c.b];
};

/** Floorboards: `rows` planks across the tile, joints staggered, each plank its own tone, grain along the length. */
function planks(seed: number, base: string, rows: number, size = 1024): Maps {
  const [br, bg, bb] = rgb(base);
  const r = rng(seed);
  const tone = Array.from({ length: rows }, () => [r() * 0.16 - 0.08, r(), 0.35 + r() * 0.5] as const);
  const grain = fbm(seed + 1, 3, 5);
  const fine = fbm(seed + 2, 48, 2);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const map = paint(size, (u, v, x, y) => {
    const row = Math.min(rows - 1, Math.floor(v * rows));
    const [dt, offset, length] = tone[row]!;
    const along = (u + offset) % 1;
    const inRow = v * rows - row;
    const seam = Math.min(inRow, 1 - inRow) * (size / rows);
    const joint = Math.min(along % length, length - (along % length)) * size;
    const gap = Math.min(1, Math.min(seam, joint) / 1.6);
    // grain: stretched noise along the plank, warped a little
    const g1 = grain(u * 0.35 + offset, v * rows * 0.9 + grain(u * 2, v * 2) * 0.35);
    const g2 = fine(u * 0.2 + offset, v * rows * 0.5);
    const k = 1 + dt + (g1 - 0.5) * 0.22 + (g2 - 0.5) * 0.08;
    const shade = k * mix(0.45, 1, gap);
    height[y * size + x] = gap * 0.8 + g1 * 0.2;
    rough[y * size + x] = mix(0.75, 0.42 + g1 * 0.18, gap);
    return [br * shade, bg * shade, bb * shade * (1 - (g1 - 0.5) * 0.08)];
  });
  return { map: texture(map, true), normalMap: normalsFrom(height, size, 2.2), roughnessMap: greyFrom(rough, size) };
}

/** Wood for furniture: grain without joints. */
function grainWood(seed: number, base: string, size = 512): Maps {
  const [br, bg, bb] = rgb(base);
  const grain = fbm(seed, 2, 5);
  const ring = fbm(seed + 7, 6, 3);
  const height = new Float32Array(size * size);
  const map = paint(size, (u, v, x, y) => {
    const w = grain(u * 0.3, v * 3 + ring(u, v) * 0.6);
    const streak = 0.5 + 0.5 * Math.sin((v * 34 + w * 9) * Math.PI);
    const k = 0.86 + w * 0.2 + streak * 0.08;
    height[y * size + x] = streak * 0.5 + w * 0.5;
    return [br * k, bg * k, bb * k * 0.98];
  });
  return { map: texture(map, true), normalMap: normalsFrom(height, size, 0.9) };
}

/** Sheet vinyl: a quiet speckle. */
function speckle(seed: number, base: string, size = 512): Maps {
  const [br, bg, bb] = rgb(base);
  const cloud = fbm(seed, 4, 4);
  const r = rng(seed + 3);
  const flecks = new Float32Array(size * size);
  for (let i = 0; i < size * size * 0.035; i++) {
    const x = Math.floor(r() * size);
    const y = Math.floor(r() * size);
    const v = r() < 0.5 ? -0.12 - r() * 0.1 : 0.1 + r() * 0.08;
    flecks[y * size + x] = v;
    flecks[y * size + ((x + 1) % size)] = v * 0.6;
    flecks[((y + 1) % size) * size + x] = v * 0.6;
  }
  const rough = new Float32Array(size * size);
  const map = paint(size, (u, v, x, y) => {
    const k = 0.95 + cloud(u, v) * 0.1 + flecks[y * size + x]!;
    rough[y * size + x] = 0.3 + cloud(u * 2, v * 2) * 0.22;
    return [br * k, bg * k, bb * k];
  });
  return { map: texture(map, true), roughnessMap: greyFrom(rough, size) };
}

/** A fine relief with no colour of its own: plaster, upholstery, moulded plastic. */
function relief(seed: number, base: number, strength: number, size = 256): THREE.CanvasTexture {
  const n = fbm(seed, base, 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) height[y * size + x] = n(x / size, y / size);
  return normalsFrom(height, size, strength);
}

/** Skin, close up: uneven tone, pores, and the fine lines that cross it. */
export function skinMaps(seed = 7, size = 1024): Maps {
  const tone = fbm(seed, 3, 5);
  const blotch = fbm(seed + 5, 7, 3);
  const r = rng(seed + 9);
  const height = new Float32Array(size * size).fill(0.5);
  // fine lines: two families of shallow furrows crossing at an angle, wavering
  const waver = fbm(seed + 11, 10, 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const w = waver(u, v) * 0.05;
      const a = Math.abs(Math.sin((u * 92 + v * 37 + w * 60) * Math.PI));
      const b = Math.abs(Math.sin((u * 31 - v * 88 + w * 60) * Math.PI));
      height[y * size + x] = 0.5 + Math.min(a, b) * 0.22 - 0.11;
    }
  }
  // pores: small pits
  for (let i = 0; i < size * size * 0.004; i++) {
    const cx = Math.floor(r() * size);
    const cy = Math.floor(r() * size);
    const rad = 1 + Math.floor(r() * 2);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy) / (rad + 0.5);
        if (d > 1) continue;
        const i2 = (((cy + dy + size) % size) * size + ((cx + dx + size) % size)) | 0;
        height[i2] = Math.min(height[i2]!, 0.5 - (1 - d) * 0.3);
      }
    }
  }
  const rough = new Float32Array(size * size);
  const map = paint(size, (u, v, x, y) => {
    const t = tone(u, v);
    const b = blotch(u, v);
    const hgt = height[y * size + x]!;
    rough[y * size + x] = 0.5 + (0.5 - hgt) * 0.5 + t * 0.12;
    // warm base, a little redder where the blotches are, a little yellower elsewhere
    const k = 0.94 + t * 0.1 - (0.5 - hgt) * 0.12;
    return [0.9 * k + (b - 0.5) * 0.09, 0.76 * k - (b - 0.5) * 0.04, 0.68 * k - (b - 0.5) * 0.06];
  });
  return { map: texture(map, true), normalMap: normalsFrom(height, size, 1.6), roughnessMap: greyFrom(rough, size) };
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Texture coordinates in metres, projected along each face's dominant axis: a texture keeps its size on every box. */
export function worldUV(geometry: THREE.BufferGeometry, offset = new THREE.Vector3()): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const nor = geometry.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else if (ax >= az) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

type Recipe = (def: MaterialDefLike, lib: MaterialLibrary) => THREE.Material;

const scaled = (t: THREE.Texture | undefined, metres: number): THREE.Texture | undefined => {
  if (!t) return undefined;
  const c = t.clone();
  c.repeat.set(1 / metres, 1 / metres);
  c.needsUpdate = true;
  return c;
};

const withMaps = (maps: Maps, metres: number) => ({
  map: scaled(maps.map, metres)!,
  ...(maps.normalMap ? { normalMap: scaled(maps.normalMap, metres)! } : {}),
  ...(maps.roughnessMap ? { roughnessMap: scaled(maps.roughnessMap, metres)! } : {}),
});

const metal = (color: string, roughness: number): Recipe => () => new THREE.MeshStandardMaterial({ color, metalness: 1, roughness, envMapIntensity: 1.25 });
const moulded = (roughness: number, clearcoat = 0.25): Recipe => (def) => new THREE.MeshPhysicalMaterial({ color: def.color, roughness, metalness: 0, clearcoat, clearcoatRoughness: 0.35 });
const matte = (roughness: number): Recipe => (def) => new THREE.MeshStandardMaterial({ color: def.color, roughness, metalness: 0 });
const cloth = (seed: number): Recipe => (def, lib) =>
  new THREE.MeshPhysicalMaterial({ color: def.color, roughness: 0.92, metalness: 0, sheen: 0.7, sheenRoughness: 0.5, sheenColor: new THREE.Color(def.color).lerp(new THREE.Color("#ffffff"), 0.5), normalMap: scaled(lib.relief(seed, 40, 1.4), 0.12)!, normalScale: new THREE.Vector2(0.5, 0.5), side: THREE.DoubleSide });
const lamp = (intensity: number): Recipe => (def) => new THREE.MeshStandardMaterial({ color: def.color, emissive: def.emissive ?? def.color, emissiveIntensity: intensity, roughness: 0.4 });

const RECIPES: Record<string, Recipe> = {
  chrome: metal("#e3e8ea", 0.12),
  steel: metal("#b9c0c3", 0.36),
  gold: metal("#dcb45c", 0.3),
  wood: (def, lib) => new THREE.MeshPhysicalMaterial({ ...withMaps(lib.wood(def.color), 0.9), roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4, normalScale: new THREE.Vector2(0.6, 0.6) }),
  darkwood: (def, lib) => new THREE.MeshPhysicalMaterial({ ...withMaps(lib.wood(def.color), 0.9), roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.35, normalScale: new THREE.Vector2(0.6, 0.6) }),
  mattress: (def, lib) => new THREE.MeshPhysicalMaterial({ color: def.color, roughness: 0.6, metalness: 0, sheen: 0.35, sheenRoughness: 0.4, clearcoat: 0.12, clearcoatRoughness: 0.6, normalMap: scaled(lib.relief(31, 64, 1.1), 0.1)!, normalScale: new THREE.Vector2(0.35, 0.35) }),
  paper: matte(0.95),
  curtain: cloth(41),
  scrubs: cloth(43),
  rubber: matte(0.88),
  coal: moulded(0.62, 0.1),
  black: moulded(0.5, 0.2),
  plastic: moulded(0.42, 0.4),
  white: moulded(0.45, 0.35),
  "tile-white": moulded(0.18, 0.8),
  cream: matte(0.85),
  beige: moulded(0.55, 0.15),
  teal: moulded(0.55, 0.2),
  blue: moulded(0.5, 0.25),
  mint: moulded(0.5, 0.25),
  navy: moulded(0.5, 0.25),
  green: moulded(0.5, 0.25),
  yellow: moulded(0.45, 0.3),
  red: moulded(0.5, 0.25),
  purple: moulded(0.5, 0.25),
  biohazard: moulded(0.45, 0.3),
  "ambulance-red": moulded(0.45, 0.3),
  leaf: (def) => new THREE.MeshPhysicalMaterial({ color: def.color, roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color("#cfe8b0"), clearcoat: 0.2, clearcoatRoughness: 0.5 }),
  leaflight: (def) => new THREE.MeshPhysicalMaterial({ color: def.color, roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color("#e3f3c0"), clearcoat: 0.2, clearcoatRoughness: 0.5 }),
  dirt: matte(1),
  skin: (def) => new THREE.MeshPhysicalMaterial({ color: def.color, roughness: 0.58, sheen: 0.3, sheenColor: new THREE.Color("#ffd9c4") }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: "#eaf6f6", roughness: 0.04, metalness: 0, transmission: 0.94, thickness: 0.02, ior: 1.5, transparent: true, opacity: 1, envMapIntensity: 1.4 }),
  water: () => new THREE.MeshPhysicalMaterial({ color: "#bfe3ea", roughness: 0.03, transmission: 0.9, thickness: 0.2, ior: 1.33, transparent: true }),
  screen: (def) => new THREE.MeshStandardMaterial({ color: "#0c1716", emissive: def.emissive ?? "#3fa493", emissiveIntensity: 0.9, roughness: 0.2 }),
  "led-green": lamp(3.2),
  "led-red": lamp(3.2),
  lamp: lamp(2.2),
};

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>();
  private woods = new Map<string, Maps>();
  private reliefs = new Map<string, THREE.CanvasTexture>();
  private shared = new Map<string, Maps>();
  constructor(private defs: Record<string, MaterialDefLike>) {}

  wood(color: string): Maps {
    let m = this.woods.get(color);
    if (!m) this.woods.set(color, (m = grainWood(17 + this.woods.size * 13, color)));
    return m;
  }

  relief(seed: number, base: number, strength: number): THREE.CanvasTexture {
    const key = `${seed}:${base}:${strength}`;
    let t = this.reliefs.get(key);
    if (!t) this.reliefs.set(key, (t = relief(seed, base, strength)));
    return t;
  }

  private maps(key: string, make: () => Maps): Maps {
    let m = this.shared.get(key);
    if (!m) this.shared.set(key, (m = make()));
    return m;
  }

  /** Does a part of this material throw a shadow? */
  casts(id: string): boolean {
    return this.defs[id]?.castShadow !== false && id !== "glass" && id !== "water";
  }

  /** The material of a catalog id. */
  get(id: string): THREE.Material {
    let m = this.cache.get(id);
    if (m) return m;
    const def = this.defs[id] ?? { id, color: "#b0b6b8" };
    const recipe = RECIPES[id];
    if (recipe) m = recipe(def, this);
    else {
      const transparent = (def.opacity ?? 1) < 1;
      m = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: Math.min(0.85, def.roughness ?? 0.7),
        metalness: def.metalness ?? 0,
        ...(def.emissive ? { emissive: def.emissive, emissiveIntensity: (def.emissiveIntensity ?? 0.3) * 4 } : {}),
        ...(transparent ? { transparent: true, opacity: def.opacity! } : {}),
      });
    }
    m.name = id;
    this.cache.set(id, m);
    return m;
  }

  /** Floors by what the room is for: boards where people sit and talk, sheet vinyl where they are treated. */
  floor(kind: string, id: string): THREE.Material {
    const key = `floor:${kind}:${id}`;
    let m = this.cache.get(key);
    if (m) return m;
    if (kind === "reception" || (kind === "consult" && id === "floor")) {
      const maps = this.maps("planks", () => planks(5, "#9c7350", 12));
      m = new THREE.MeshPhysicalMaterial({ ...withMaps(maps, 2.4), roughness: 1, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.45, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 0.9 });
    } else {
      const base = kind === "corridor" ? "#9aa8a2" : kind === "storage" ? "#939fa8" : "#a3b1ab";
      const maps = this.maps(`vinyl:${base}`, () => speckle(11 + this.shared.size, base));
      m = new THREE.MeshPhysicalMaterial({ ...withMaps(maps, 1.5), roughness: 1, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.4, envMapIntensity: 0.7 });
    }
    m.name = key;
    this.cache.set(key, m);
    return m;
  }

  /** Painted plaster. */
  wall(color: string, satin = false): THREE.Material {
    const key = `wall:${color}:${satin}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: satin ? 0.55 : 0.92, metalness: 0, normalMap: scaled(this.relief(3, 24, 0.7), 1.2)!, normalScale: new THREE.Vector2(0.25, 0.25) });
      m.name = key;
      this.cache.set(key, m);
    }
    return m;
  }

  trim(color: string): THREE.Material {
    const key = `trim:${color}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ ...withMaps(this.wood(color), 1.1), roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4 });
      m.name = key;
      this.cache.set(key, m);
    }
    return m;
  }

  colorOf(id: string, fallback = "#cccccc"): string {
    return this.defs[id]?.color ?? fallback;
  }
}
