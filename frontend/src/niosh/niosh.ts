/**
 * Revised NIOSH Lifting Equation (Waters et al. 1993; NIOSH Applications
 * Manual 1994), metric form. Pure functions only — no measurement, no UI.
 *
 *   RWL = LC × HM × VM × DM × AM × FM × CM
 *   LI  = load / RWL
 */

export const LOAD_CONSTANT_KG = 23;

export type Coupling = "good" | "fair" | "poor";

export interface LiftTask {
  /** Horizontal distance of the hands from the ankle midpoint at the origin, cm. */
  H: number;
  /** Hand height above the floor at the origin, cm. */
  V: number;
  /** Vertical travel distance between origin and destination, cm. */
  D: number;
  /** Asymmetry (twist) angle, degrees. */
  A: number;
  /** Lifts per minute. */
  frequency: number;
  coupling: Coupling;
  /** Weight of the object, kg (entered by the user). */
  loadKg: number;
}

export type MultiplierKey = "HM" | "VM" | "DM" | "AM" | "FM" | "CM";

export interface NioshResult {
  multipliers: Record<MultiplierKey, number>;
  rwl: number;
  /** load / RWL. Infinity when RWL is 0 (task outside the equation's limits). */
  li: number;
  risk: RiskLevel;
  /** The multiplier with the lowest value, i.e. the biggest contributor to risk. */
  dominant: MultiplierKey;
}

export type RiskLevel = "green" | "yellow" | "red";

export function horizontalMultiplier(H: number): number {
  if (H <= 25) return 1;
  if (H > 63) return 0;
  return 25 / H;
}

export function verticalMultiplier(V: number): number {
  if (V > 175 || V < 0) return 0;
  return Math.max(0, 1 - 0.003 * Math.abs(V - 75));
}

export function distanceMultiplier(D: number): number {
  if (D <= 25) return 1;
  if (D > 175) return 0;
  return 0.82 + 4.5 / D;
}

export function asymmetricMultiplier(A: number): number {
  const angle = Math.abs(A);
  if (angle > 135) return 0;
  return 1 - 0.0032 * angle;
}

/**
 * Frequency multiplier, short duration (≤ 1 h). Simplified from the NIOSH
 * Applications Manual Table 5: values are linearly interpolated between table
 * rows and clamped to the 0.2–5 lifts/min range we support in the demo.
 */
const FM_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0.2, 1.0],
  [0.5, 0.97],
  [1, 0.94],
  [2, 0.91],
  [3, 0.88],
  [4, 0.84],
  [5, 0.8],
];

export function frequencyMultiplier(liftsPerMinute: number): number {
  const first = FM_TABLE[0];
  const last = FM_TABLE[FM_TABLE.length - 1];
  if (liftsPerMinute <= first[0]) return first[1];
  if (liftsPerMinute >= last[0]) return last[1];
  for (let i = 1; i < FM_TABLE.length; i++) {
    const [f1, m1] = FM_TABLE[i];
    if (liftsPerMinute <= f1) {
      const [f0, m0] = FM_TABLE[i - 1];
      return m0 + ((m1 - m0) * (liftsPerMinute - f0)) / (f1 - f0);
    }
  }
  return last[1];
}

const COUPLING_MULTIPLIER: Record<Coupling, number> = { good: 1, fair: 0.95, poor: 0.9 };

export function couplingMultiplier(coupling: Coupling): number {
  return COUPLING_MULTIPLIER[coupling];
}

export function riskLevel(li: number): RiskLevel {
  if (li <= 1) return "green";
  if (li <= 2) return "yellow";
  return "red";
}

export function computeNiosh(task: LiftTask): NioshResult {
  const multipliers: Record<MultiplierKey, number> = {
    HM: horizontalMultiplier(task.H),
    VM: verticalMultiplier(task.V),
    DM: distanceMultiplier(task.D),
    AM: asymmetricMultiplier(task.A),
    FM: frequencyMultiplier(task.frequency),
    CM: couplingMultiplier(task.coupling),
  };
  const rwl =
    LOAD_CONSTANT_KG *
    multipliers.HM *
    multipliers.VM *
    multipliers.DM *
    multipliers.AM *
    multipliers.FM *
    multipliers.CM;
  const li = rwl > 0 ? task.loadKg / rwl : Infinity;
  const dominant = (Object.keys(multipliers) as MultiplierKey[]).reduce((worst, key) =>
    multipliers[key] < multipliers[worst] ? key : worst,
  );
  return { multipliers, rwl, li, risk: riskLevel(li), dominant };
}

/**
 * Single-camera measurements are estimates. Re-evaluate the equation with each
 * measured input nudged by its typical error and report the LI spread.
 * Error sizes follow published single-RGB-camera results (~6–8 cm for hand
 * distances); twist angle is the least reliable, so it gets a wide band.
 */
export const MEASUREMENT_ERROR = { H: 8, V: 8, A: 15 } as const;

export function liRange(task: LiftTask): { low: number; high: number } {
  let low = Infinity;
  let high = 0;
  for (const dH of [-1, 0, 1]) {
    for (const dV of [-1, 0, 1]) {
      for (const dA of [-1, 0, 1]) {
        const { li } = computeNiosh({
          ...task,
          H: Math.max(0, task.H + dH * MEASUREMENT_ERROR.H),
          V: Math.max(0, task.V + dV * MEASUREMENT_ERROR.V),
          A: Math.max(0, task.A + dA * MEASUREMENT_ERROR.A),
        });
        low = Math.min(low, li);
        high = Math.max(high, li);
      }
    }
  }
  return { low, high };
}

/** Plain-language meaning of each multiplier, phrased about the workstation. */
export const MULTIPLIER_INFO: Record<MultiplierKey, { name: string; problem: string }> = {
  HM: { name: "Horizontal", problem: "The load is picked up too far from the body." },
  VM: { name: "Vertical", problem: "The pickup point is too low (or too high)." },
  DM: { name: "Distance", problem: "The load travels too far vertically." },
  AM: { name: "Asymmetry", problem: "The layout forces a twist during the lift." },
  FM: { name: "Frequency", problem: "Lifts happen too often." },
  CM: { name: "Coupling", problem: "The object is hard to grip." },
};
