/**
 * The operator's hand on a needle, read as a technique (docs/TECHNIQUE.md, docs/STUDIO.md).
 *
 * While a needle is held, its lift (cm above the depth it was set to) and its turn (radians) are sampled. What was
 * done is then measured, not assumed: lifting and thrusting by its mean stroke, its rate and which stroke was the
 * quicker; twirling by its arc and rate, or — turned one way — by the whole turn and its direction. A working shorter
 * than the engine's two seconds is not sent at all.
 */

/** What the operator's hand did on a needle, measured. */
export interface Gesture {
  needle: string;
  technique: "lift-thrust" | "rotate" | "tremble";
  amplitudeMm?: number;
  frequencyPerMin?: number;
  arcDeg?: number;
  durationSec: number;
  direction?: "both" | "clockwise" | "counter-clockwise";
  emphasis?: "even" | "thrust" | "lift";
}

export interface Sample {
  t: number;
  lift: number;
  turn: number;
}

/** Read a gesture: what kind of working it was, and its amplitude, rate, arc, direction and emphasis. */
export function readGesture(needle: string, samples: Sample[]): { gesture: Gesture | null; why?: string } {
  if (samples.length < 4) return { gesture: null, why: "the needle was not worked" };
  const seconds = (samples[samples.length - 1]!.t - samples[0]!.t) / 1000;
  const strokes = (key: "lift" | "turn", hysteresis: number) => {
    const out: { size: number; ms: number; dir: 1 | -1 }[] = [];
    let anchor = samples[0]!;
    let extreme = samples[0]!;
    let dir: 1 | -1 | 0 = 0;
    for (const s of samples) {
      const d = s[key] - extreme[key];
      if (dir === 0) {
        if (Math.abs(s[key] - anchor[key]) > hysteresis) {
          dir = s[key] > anchor[key] ? 1 : -1;
          extreme = s;
        }
      } else if (d * dir > 0) extreme = s;
      else if (-d * dir > hysteresis) {
        out.push({ size: Math.abs(extreme[key] - anchor[key]), ms: extreme.t - anchor.t, dir });
        anchor = extreme;
        extreme = s;
        dir = dir === 1 ? -1 : 1;
      }
    }
    if (dir !== 0 && Math.abs(extreme[key] - anchor[key]) > hysteresis) out.push({ size: Math.abs(extreme[key] - anchor[key]), ms: extreme.t - anchor.t, dir });
    return out;
  };
  const lifts = strokes("lift", 0.03);
  const turns = strokes("turn", 0.2);
  const liftTravel = lifts.reduce((s, k) => s + k.size, 0);
  const turnTravel = turns.reduce((s, k) => s + k.size, 0);
  if (liftTravel < 0.05 && turnTravel < 0.4) return { gesture: null, why: "the needle was held, not worked" };
  if (seconds < 2) return { gesture: null, why: `worked for ${seconds.toFixed(1)} s: a working lasts at least 2 s` };
  const durationSec = Math.min(120, Math.round(seconds * 10) / 10);
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  // lifting 3 mm and twirling 180° are of a kind: whichever was done more of is the technique
  if (liftTravel / 0.3 >= turnTravel / Math.PI) {
    const amplitudeMm = (liftTravel / lifts.length) * 10;
    const perMin = (lifts.length / 2 / seconds) * 60;
    if (amplitudeMm < 0.9 && perMin > 150) return { gesture: { needle, technique: "tremble", durationSec } };
    const speed = (dir: 1 | -1) => {
      const k = lifts.filter((s) => s.dir === dir && s.ms > 0);
      return k.length ? k.reduce((s, x) => s + x.size / x.ms, 0) / k.length : 0;
    };
    const down = speed(-1);
    const up = speed(1);
    const emphasis = down > up * 1.35 ? "thrust" : up > down * 1.35 ? "lift" : "even";
    return { gesture: { needle, technique: "lift-thrust", amplitudeMm: clamp(Math.round(amplitudeMm * 10) / 10, 0.5, 10), frequencyPerMin: clamp(Math.round(perMin), 20, 240), durationSec, emphasis } };
  }
  const net = samples[samples.length - 1]!.turn - samples[0]!.turn;
  if (Math.abs(net) > turnTravel * 0.6) {
    return { gesture: { needle, technique: "rotate", arcDeg: clamp(Math.round((Math.abs(net) * 180) / Math.PI / 5) * 5, 30, 720), direction: net < 0 ? "clockwise" : "counter-clockwise", durationSec } };
  }
  const arc = ((turnTravel / turns.length) * 180) / Math.PI;
  return { gesture: { needle, technique: "rotate", arcDeg: clamp(Math.round(arc / 5) * 5, 30, 720), frequencyPerMin: clamp(Math.round((turns.length / 2 / seconds) * 60), 20, 240), direction: "both", durationSec } };
}

