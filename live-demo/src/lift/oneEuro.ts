/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012): an adaptive low-pass
 * filter that is heavily smoothed when a point is still (kills jitter) and
 * opens up when it moves fast (keeps lag low). The standard choice for
 * real-time pose tracking.
 */
function smoothingFactor(dtSeconds: number, cutoffHz: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

export class OneEuroFilter {
  private prevValue: number | null = null;
  private prevDerivative = 0;
  private prevT = 0;

  /**
   * @param minCutoff Hz; lower = smoother when still.
   * @param beta Speed coefficient; higher = less lag during fast motion.
   * @param dCutoff Hz; cutoff for the derivative estimate.
   */
  constructor(
    private minCutoff = 1,
    private beta = 0,
    private dCutoff = 1,
  ) {}

  reset() {
    this.prevValue = null;
    this.prevDerivative = 0;
  }

  filter(value: number, tMs: number): number {
    if (this.prevValue === null) {
      this.prevValue = value;
      this.prevT = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.prevT) / 1000, 1e-3);
    this.prevT = tMs;

    const derivative = (value - this.prevValue) / dt;
    const aD = smoothingFactor(dt, this.dCutoff);
    this.prevDerivative = aD * derivative + (1 - aD) * this.prevDerivative;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.prevDerivative);
    const a = smoothingFactor(dt, cutoff);
    this.prevValue = a * value + (1 - a) * this.prevValue;
    return this.prevValue;
  }
}

interface Point3 {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** One Euro filter for every coordinate of a landmark set. Visibility passes through unfiltered. */
export class LandmarkFilter {
  private filters: OneEuroFilter[] = [];

  constructor(
    private minCutoff: number,
    private beta: number,
  ) {}

  reset() {
    this.filters = [];
  }

  filter<T extends Point3>(points: T[], tMs: number): T[] {
    if (this.filters.length !== points.length * 3) {
      this.filters = Array.from({ length: points.length * 3 }, () => new OneEuroFilter(this.minCutoff, this.beta));
    }
    return points.map((p, i) => ({
      ...p,
      x: this.filters[i * 3].filter(p.x, tMs),
      y: this.filters[i * 3 + 1].filter(p.y, tMs),
      z: this.filters[i * 3 + 2].filter(p.z, tMs),
    }));
  }
}
