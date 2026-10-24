import { describe, expect, it } from "vitest";
import { computeNiosh, type LiftTask } from "./niosh";
import { buildOptions } from "./options";

const floorLift: LiftTask = { H: 40, V: 10, D: 70, A: 25, frequency: 1, coupling: "fair", loadKg: 12 };

describe("buildOptions", () => {
  it("offers only changes that reduce LI, best first", () => {
    const options = buildOptions(floorLift);
    const base = computeNiosh(floorLift).li;
    expect(options.length).toBeGreaterThan(2);
    for (const o of options) expect(o.liAfter).toBeLessThan(base);
    const reductions = options.map((o) => o.reductionPct);
    expect(reductions).toEqual([...reductions].sort((a, b) => b - a));
  });

  it("recomputes LI through NIOSH for the raise-pickup option", () => {
    const raise = buildOptions(floorLift).find((o) => o.id === "raise_pickup")!;
    expect(raise.task.V).toBe(75);
    // Destination (V + D = 80 cm) is unchanged, so travel shrinks to 5 cm.
    expect(raise.task.D).toBe(5);
    expect(raise.liAfter).toBeCloseTo(computeNiosh(raise.task).li, 10);
  });

  it("offers a combined close platform that fixes height and reach together", () => {
    const options = buildOptions(floorLift);
    const combined = options.find((o) => o.id === "platform_close")!;
    const raise = options.find((o) => o.id === "raise_pickup")!;
    expect(combined.task.V).toBe(75);
    expect(combined.task.H).toBe(30);
    expect(combined.liAfter).toBeLessThan(raise.liAfter);
  });

  it("splitting the load doubles the lift frequency", () => {
    const split = buildOptions(floorLift).find((o) => o.id === "split_load")!;
    expect(split.task.loadKg).toBe(6);
    expect(split.task.frequency).toBe(2);
    expect(split.reductionPct).toBeLessThan(50);
  });

  it("skips options that don't apply to an already good lift", () => {
    const good: LiftTask = { H: 25, V: 75, D: 25, A: 0, frequency: 0.2, coupling: "good", loadKg: 4 };
    expect(buildOptions(good)).toHaveLength(0);
  });
});
