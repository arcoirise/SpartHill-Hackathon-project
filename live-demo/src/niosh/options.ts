import { computeNiosh, type LiftTask, type MultiplierKey } from "./niosh";

/** Hand height that maximises VM (and is comfortable): waist-ish, 75 cm. */
export const IDEAL_PICKUP_CM = 75;
const IDEAL_V = IDEAL_PICKUP_CM;
const NEAR_H = 25;

export type Effort = "low" | "medium" | "high";

export interface RedesignOption {
  id: string;
  /** Short workstation-focused label, e.g. "Raise the pickup point to 75 cm". */
  label: string;
  effort: Effort;
  /** Multiplier this change mainly improves. */
  fixes: MultiplierKey;
  liAfter: number;
  /** Percentage of the current LI removed by this change (0–100). */
  reductionPct: number;
  task: LiftTask;
}

interface Draft {
  id: string;
  label: string;
  effort: Effort;
  fixes: MultiplierKey;
  apply: (t: LiftTask) => LiftTask | null;
}

/**
 * "What-if" redesigns. Each one changes the workstation (never the worker's
 * technique) and is recomputed through the real NIOSH equation, so every
 * number the AI later talks about comes from code.
 */
const DRAFTS: Draft[] = [
  {
    id: "platform_close",
    label: "Put the load on a 75 cm platform right in front of the worker (lift table or pallet stand)",
    effort: "medium",
    fixes: "VM",
    apply: (t) => {
      if (Math.abs(t.V - IDEAL_V) < 10 || t.H <= NEAR_H + 5) return null;
      const destination = t.V + t.D;
      return { ...t, V: IDEAL_V, H: NEAR_H + 5, D: Math.abs(destination - IDEAL_V) };
    },
  },
  {
    id: "raise_pickup",
    label: "Raise the pickup point to about 75 cm (waist height)",
    effort: "medium",
    fixes: "VM",
    apply: (t) => {
      if (Math.abs(t.V - IDEAL_V) < 10) return null;
      const destination = t.V + t.D;
      return { ...t, V: IDEAL_V, D: Math.abs(destination - IDEAL_V) };
    },
  },
  {
    id: "bring_closer",
    label: "Bring the load closer to the body (shallower shelf, no obstruction)",
    effort: "medium",
    fixes: "HM",
    apply: (t) => (t.H > NEAR_H + 5 ? { ...t, H: NEAR_H + 5 } : null),
  },
  {
    id: "remove_twist",
    label: "Re-orient the layout so the worker faces the destination (no twisting)",
    effort: "low",
    fixes: "AM",
    apply: (t) => (t.A > 10 ? { ...t, A: 0 } : null),
  },
  {
    id: "add_handles",
    label: "Add handles or a better grip to the load",
    effort: "low",
    fixes: "CM",
    apply: (t) => (t.coupling !== "good" ? { ...t, coupling: "good" } : null),
  },
  {
    id: "shorten_travel",
    label: "Reduce the vertical travel with a lift table or intermediate shelf",
    effort: "high",
    fixes: "DM",
    apply: (t) => (t.D > 50 ? { ...t, D: 25 } : null),
  },
  {
    id: "split_load",
    label: "Split the load into smaller units (half the weight, twice as many lifts)",
    // Needs packaging/supplier changes and doubles handling time.
    effort: "high",
    fixes: "FM",
    // Half the weight means twice the lifts, so the frequency multiplier gets worse.
    apply: (t) => (t.loadKg > 5 ? { ...t, loadKg: t.loadKg / 2, frequency: t.frequency * 2 } : null),
  },
];

/** All options that actually reduce LI, best reduction first. */
export function buildOptions(task: LiftTask): RedesignOption[] {
  const base = computeNiosh(task).li;
  const options: RedesignOption[] = [];
  for (const d of DRAFTS) {
    const changed = d.apply(task);
    if (!changed) continue;
    const liAfter = computeNiosh(changed).li;
    if (!(liAfter < base)) continue;
    const reductionPct = Number.isFinite(base) ? ((base - liAfter) / base) * 100 : 100;
    options.push({
      id: d.id,
      label: d.label,
      effort: d.effort,
      fixes: d.fixes,
      liAfter,
      reductionPct: Math.round(reductionPct),
      task: changed,
    });
  }
  return options.sort((a, b) => b.reductionPct - a.reductionPct);
}
