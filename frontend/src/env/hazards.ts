/**
 * Environmental readings (simulated sensors in the demo) and hazard thresholds.
 * Keep the thresholds in sync with backend/app/environment.py.
 */
export interface Environment {
  temperatureC: number;
  decibels: number;
  aqi: number;
}

export interface Hazard {
  id: "heat" | "noise" | "air";
  label: string;
  reading: string;
}

export const HAZARD_RULES: ReadonlyArray<{
  id: Hazard["id"];
  key: keyof Environment;
  threshold: number;
  unit: string;
  label: string;
}> = [
  { id: "heat", key: "temperatureC", threshold: 30, unit: "°C", label: "High room temperature" },
  { id: "noise", key: "decibels", threshold: 85, unit: "dB", label: "High noise level" },
  { id: "air", key: "aqi", threshold: 100, unit: "AQI", label: "Poor air quality" },
];

export function envHazards(env: Environment): Hazard[] {
  return HAZARD_RULES.filter((r) => env[r.key] >= r.threshold).map((r) => ({
    id: r.id,
    label: r.label,
    reading: `${env[r.key]} ${r.unit}`,
  }));
}

/** Stable identity of the current hazard set, to notice when it changes. */
export const hazardKey = (hazards: Hazard[]) => hazards.map((h) => h.id).join("+");
