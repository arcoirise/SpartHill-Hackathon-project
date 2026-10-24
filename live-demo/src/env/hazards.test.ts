import { describe, expect, it } from "vitest";
import { envHazards, hazardKey } from "./hazards";

describe("envHazards", () => {
  it("is empty for a normal room", () => {
    expect(envHazards({ temperatureC: 24, decibels: 65, aqi: 35 })).toEqual([]);
  });

  it("flags each reading at its threshold", () => {
    const found = envHazards({ temperatureC: 30, decibels: 85, aqi: 100 });
    expect(found.map((h) => h.id)).toEqual(["heat", "noise", "air"]);
    expect(found[0].reading).toBe("30 °C");
  });

  it("stays quiet just below the thresholds", () => {
    expect(envHazards({ temperatureC: 29.5, decibels: 84, aqi: 99 })).toEqual([]);
  });

  it("keys hazard sets so changes can be detected", () => {
    expect(hazardKey(envHazards({ temperatureC: 34, decibels: 65, aqi: 35 }))).toBe("heat");
    expect(hazardKey([])).toBe("");
  });
});
