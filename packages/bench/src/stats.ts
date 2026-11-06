import { createRng } from "@clinicalcraft/core";

/**
 * Statistics for feasibility-scale evaluation (proposal §9): Wilson score intervals over instances, and a cluster
 * bootstrap over independent case families — variants and repeated runs of one family are not independent cases.
 */

export interface Proportion {
  k: number;
  n: number;
  p: number | null;
  ci: [number, number] | null;
}

export function wilson(k: number, n: number, z = 1.96): Proportion {
  if (n === 0) return { k, n, p: null, ci: null };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, p: round(p), ci: [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))] };
}

/**
 * Percentile bootstrap of a proportion with families as the resampling unit: families are drawn with replacement and
 * all their episodes come with them. Seeded, so a report is reproducible.
 */
export function clusterBootstrap(byFamily: ReadonlyMap<string, boolean[]>, iterations = 2000, seed = 20261106): { p: number | null; ci: [number, number] | null; families: number } {
  const families = [...byFamily.values()].filter((v) => v.length > 0);
  if (families.length === 0) return { p: null, ci: null, families: 0 };
  const total = families.flat();
  const p = total.filter(Boolean).length / total.length;
  if (families.length < 2) return { p: round(p), ci: null, families: families.length };
  const rng = createRng(seed);
  const stats: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let k = 0;
    let n = 0;
    for (let i = 0; i < families.length; i++) {
      const f = families[Math.floor(rng() * families.length)]!;
      k += f.filter(Boolean).length;
      n += f.length;
    }
    stats.push(k / n);
  }
  stats.sort((a, b) => a - b);
  return { p: round(p), ci: [round(stats[Math.floor(0.025 * iterations)]!), round(stats[Math.min(iterations - 1, Math.floor(0.975 * iterations))]!)], families: families.length };
}

export const mean = (xs: readonly number[]): number | null => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

const round = (x: number) => Math.round(x * 1000) / 1000;
