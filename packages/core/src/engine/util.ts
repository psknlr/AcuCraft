/**
 * Pure helpers: id-aware merge patches (scenario variants), stable serialisation and digests (replay checks).
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIdArray = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObject(x) && typeof x.id === "string");

/**
 * Apply a variant patch. Objects merge key by key (`null` deletes a key); an array of objects with `id` merges item
 * by item when the patch is such an array too (an item `{"id": …, "$remove": true}` deletes it; unknown ids append, in
 * patch order); any other value replaces. `"$replace": true` on an object (or `{"$replace": [...]}` for an array)
 * replaces instead of merging.
 */
export function applyPatch<T>(base: T, patch: unknown): T {
  return merge(base as unknown, patch) as T;
}

function merge(base: unknown, patch: unknown): unknown {
  if (isObject(patch) && "$replace" in patch) {
    const value = patch.$replace;
    if (value === true) {
      const { $replace: _drop, ...rest } = patch;
      return clone(rest);
    }
    return clone(value);
  }
  if (isObject(base) && isObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete out[key];
      else out[key] = key in base ? merge(base[key], value) : clone(value);
    }
    return out;
  }
  if (isIdArray(base) && isIdArray(patch)) {
    const out = base.map((item) => ({ ...item }));
    for (const p of patch) {
      const index = out.findIndex((item) => item.id === p.id);
      if (p.$remove === true) {
        if (index >= 0) out.splice(index, 1);
        continue;
      }
      if (index >= 0) out[index] = merge(out[index], p) as Record<string, unknown>;
      else out.push(clone(p) as Record<string, unknown>);
    }
    return out;
  }
  return clone(patch);
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** JSON with sorted keys (undefined members dropped): equal values serialise equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value as Json));
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, Json>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** cyrb53: a fast 53-bit string hash (hex), deterministic everywhere. */
export function hash53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

export function digest(value: unknown): string {
  return hash53(stableStringify(value));
}

export const round = (n: number, places = 2): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];
