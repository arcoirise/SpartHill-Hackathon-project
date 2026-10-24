import { describe, expect, it } from "vitest";
import { OneEuroFilter } from "./oneEuro";

// Deterministic pseudo-random noise so the test is repeatable.
function noise(i: number) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2;
}

describe("OneEuroFilter", () => {
  it("passes the first sample through", () => {
    expect(new OneEuroFilter(1, 0).filter(5, 0)).toBe(5);
  });

  it("removes most jitter from a still point", () => {
    const f = new OneEuroFilter(1, 0.5);
    let rawVar = 0;
    let outVar = 0;
    for (let i = 0; i < 300; i++) {
      const raw = 10 + noise(i) * 0.5;
      const out = f.filter(raw, i * 33);
      if (i > 30) {
        rawVar += (raw - 10) ** 2;
        outVar += (out - 10) ** 2;
      }
    }
    expect(outVar).toBeLessThan(rawVar * 0.25);
  });

  it("follows a fast move with little lag when beta is set", () => {
    const slow = new OneEuroFilter(1, 0);
    const fast = new OneEuroFilter(1, 5);
    let s = 0;
    let q = 0;
    for (let i = 0; i < 10; i++) {
      s = slow.filter(i * 5, i * 33);
      q = fast.filter(i * 5, i * 33);
    }
    expect(Math.abs(45 - q)).toBeLessThan(Math.abs(45 - s));
  });

  it("converges to a constant", () => {
    const f = new OneEuroFilter(1, 1);
    let out = 0;
    for (let i = 0; i < 100; i++) out = f.filter(i === 0 ? 0 : 7, i * 33);
    expect(out).toBeCloseTo(7, 3);
  });
});
