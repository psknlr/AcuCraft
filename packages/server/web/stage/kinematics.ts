import { Quaternion, Vector3 } from "three";

export interface TwoBonePose {
  root: Vector3;
  mid: Vector3;
  end: Vector3;
  reachable: boolean;
}

/** A length-preserving, pole-guided two-bone solve. Unreachable targets are clamped, never stretched. */
export function solveTwoBone(root: Vector3, target: Vector3, upper: number, lower: number, pole: Vector3): TwoBonePose {
  const dir = target.clone().sub(root);
  const requested = dir.length();
  if (requested < 1e-8) dir.set(0, -1, 0);
  else dir.divideScalar(requested);
  const minimum = Math.abs(upper - lower) + 1e-5;
  const maximum = upper + lower - 1e-5;
  const distance = Math.max(minimum, Math.min(maximum, requested));
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const bend = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-10) {
    bend.set(Math.abs(dir.x) < 0.8 ? 1 : 0, Math.abs(dir.x) < 0.8 ? 0 : 1, 0);
    bend.addScaledVector(dir, -bend.dot(dir));
  }
  bend.normalize();
  return {
    root: root.clone(),
    mid: root.clone().addScaledVector(dir, along).addScaledVector(bend, height),
    end: root.clone().addScaledVector(dir, distance),
    reachable: requested >= minimum - 1e-5 && requested <= maximum + 1e-5,
  };
}

export const smoothUnit = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function boneTurn(from: Vector3, to: Vector3): Quaternion {
  return new Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
}

/** Shortest signed yaw change, including a stable wrap across +/-pi. */
export function turnTowards(from: number, to: number, amount: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * Math.max(0, Math.min(1, amount));
}
