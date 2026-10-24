import type { LiftMeasurement } from "./lift/liftDetector";
import type { LiftTask, RiskLevel } from "./niosh/niosh";

/** Workstation zones for the demo. Only the zone ID ever goes to the server. */
export const ZONES = [
  { id: "zone-a", name: "Receiving dock" },
  { id: "zone-b", name: "Packing line" },
] as const;

export const RISK_COLOR: Record<RiskLevel, string> = { green: "#34d399", yellow: "#fbbf24", red: "#f87171" };
export const RISK_TEXT: Record<RiskLevel, string> = { green: "Low risk", yellow: "Elevated risk", red: "High risk" };

export interface LiftRecord {
  id: number;
  at: number;
  source: "live" | "replay";
  measurement: LiftMeasurement;
  task: LiftTask;
}

export function fmtLi(li: number): string {
  return Number.isFinite(li) ? li.toFixed(1) : "∞";
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} kB`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
