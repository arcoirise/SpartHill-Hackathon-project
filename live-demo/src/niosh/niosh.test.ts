import { describe, expect, it } from "vitest";
import {
  asymmetricMultiplier,
  computeNiosh,
  couplingMultiplier,
  distanceMultiplier,
  frequencyMultiplier,
  horizontalMultiplier,
  liRange,
  riskLevel,
  verticalMultiplier,
  type LiftTask,
} from "./niosh";

// The NIOSH "ideal" lift: every multiplier is 1, so RWL equals the 23 kg load constant.
const IDEAL: LiftTask = { H: 25, V: 75, D: 25, A: 0, frequency: 0.2, coupling: "good", loadKg: 23 };

describe("multipliers", () => {
  it("HM = 25/H, 1 below 25 cm, 0 beyond 63 cm", () => {
    expect(horizontalMultiplier(20)).toBe(1);
    expect(horizontalMultiplier(25)).toBe(1);
    expect(horizontalMultiplier(50)).toBeCloseTo(0.5);
    expect(horizontalMultiplier(63)).toBeCloseTo(0.397, 3);
    expect(horizontalMultiplier(64)).toBe(0);
  });

  it("VM = 1 - 0.003|V-75|, 0 above 175 cm", () => {
    expect(verticalMultiplier(75)).toBe(1);
    expect(verticalMultiplier(0)).toBeCloseTo(0.775);
    expect(verticalMultiplier(10)).toBeCloseTo(0.805);
    expect(verticalMultiplier(175)).toBeCloseTo(0.7);
    expect(verticalMultiplier(176)).toBe(0);
  });

  it("DM = 0.82 + 4.5/D, 1 below 25 cm, 0 beyond 175 cm", () => {
    expect(distanceMultiplier(10)).toBe(1);
    expect(distanceMultiplier(25)).toBe(1);
    expect(distanceMultiplier(50)).toBeCloseTo(0.91);
    expect(distanceMultiplier(175)).toBeCloseTo(0.8457, 4);
    expect(distanceMultiplier(176)).toBe(0);
  });

  it("AM = 1 - 0.0032A, 0 beyond 135°", () => {
    expect(asymmetricMultiplier(0)).toBe(1);
    expect(asymmetricMultiplier(45)).toBeCloseTo(0.856);
    expect(asymmetricMultiplier(-45)).toBeCloseTo(0.856);
    expect(asymmetricMultiplier(135)).toBeCloseTo(0.568);
    expect(asymmetricMultiplier(136)).toBe(0);
  });

  it("FM uses the short-duration table and interpolates between rows", () => {
    expect(frequencyMultiplier(0.1)).toBe(1);
    expect(frequencyMultiplier(1)).toBe(0.94);
    expect(frequencyMultiplier(1.5)).toBeCloseTo(0.925);
    expect(frequencyMultiplier(5)).toBe(0.8);
    expect(frequencyMultiplier(9)).toBe(0.8);
  });

  it("CM maps good/fair/poor", () => {
    expect(couplingMultiplier("good")).toBe(1);
    expect(couplingMultiplier("fair")).toBe(0.95);
    expect(couplingMultiplier("poor")).toBe(0.9);
  });
});

describe("computeNiosh", () => {
  it("ideal lift: RWL = 23 kg, LI = 1", () => {
    const r = computeNiosh(IDEAL);
    expect(r.rwl).toBeCloseTo(23);
    expect(r.li).toBeCloseTo(1);
    expect(r.risk).toBe("green");
  });

  it("floor pickup: RWL is the product of all multipliers", () => {
    // Demo scenario: 12 kg box lifted from the floor to waist height.
    const task: LiftTask = { H: 40, V: 10, D: 70, A: 20, frequency: 1, coupling: "fair", loadKg: 12 };
    const expected = 23 * (25 / 40) * (1 - 0.003 * 65) * (0.82 + 4.5 / 70) * (1 - 0.0032 * 20) * 0.94 * 0.95;
    const r = computeNiosh(task);
    expect(r.rwl).toBeCloseTo(expected, 6);
    expect(r.li).toBeCloseTo(12 / expected, 6);
    expect(r.dominant).toBe("HM");
    expect(r.risk).toBe("yellow");
  });

  it("raising the pickup point to 75 cm lowers LI", () => {
    const floor: LiftTask = { H: 30, V: 5, D: 70, A: 0, frequency: 1, coupling: "good", loadKg: 15 };
    const table: LiftTask = { ...floor, V: 75, D: 10 };
    expect(computeNiosh(table).li).toBeLessThan(computeNiosh(floor).li);
    expect(computeNiosh(floor).dominant).toBe("VM");
  });

  it("returns Infinity LI when the task is outside the equation's limits", () => {
    const r = computeNiosh({ ...IDEAL, H: 70 });
    expect(r.rwl).toBe(0);
    expect(r.li).toBe(Infinity);
    expect(r.risk).toBe("red");
  });
});

describe("riskLevel", () => {
  it("green ≤ 1, yellow ≤ 2, red above", () => {
    expect(riskLevel(1)).toBe("green");
    expect(riskLevel(1.01)).toBe("yellow");
    expect(riskLevel(2)).toBe("yellow");
    expect(riskLevel(2.01)).toBe("red");
  });
});

describe("liRange", () => {
  it("brackets the nominal LI", () => {
    const task: LiftTask = { H: 40, V: 20, D: 60, A: 20, frequency: 1, coupling: "fair", loadKg: 12 };
    const nominal = computeNiosh(task).li;
    const { low, high } = liRange(task);
    expect(low).toBeLessThan(nominal);
    expect(high).toBeGreaterThan(nominal);
  });
});
