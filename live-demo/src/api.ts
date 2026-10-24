import type { Environment } from "./env/hazards";
import type { NioshResult } from "./niosh/niosh";
import type { RedesignOption } from "./niosh/options";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/live-api";

export interface Pick {
  id: string;
  /** "environment" fixes (e.g. cooling ventilation) and "grip" fixes (hand placement) don't change the NIOSH numbers. */
  kind: "lift" | "environment" | "grip";
  label: string;
  li_after: number | null;
  reduction_pct: number | null;
  effort: "low" | "medium" | "high";
  why: string;
}

export interface HazardInfo {
  id: string;
  label: string;
  reading: string;
  fix_id: string;
  fix_label: string;
  need: string;
}

/** What the on-device screening flagged about the grip or posture: categories and code-written text only. */
export interface GripIssue {
  object_label: string;
  /** "posture" = no grip problem, only a deep bend or low pickup. */
  status: "proper" | "wrong_top" | "wrong_uneven" | "posture";
  detail: string | null;
  lift_posture?: "stoop" | "squat" | "upright";
}

/** Hand-placement solution for a grip or posture issue. */
export interface GripAdvice {
  source: "llm" | "fallback";
  /** What is wrong with the current grip or posture (written by code). */
  issue: string;
  summary: string;
  picks: Pick[];
  latency_ms: number;
  cached?: boolean;
  note?: string | null;
}

export interface Recommendation {
  source: "llm" | "fallback";
  summary: string;
  picks: Pick[];
  latency_ms: number;
  cached?: boolean;
  note?: string | null;
  /** Short facility-log phrases, e.g. ["a 75 cm lifting assist table", "cooling ventilation"]. */
  needs?: string[];
  hazards?: HazardInfo[];
  grip?: GripAdvice | null;
}

export interface FixStat {
  id: string;
  kind: "lift" | "environment";
  label: string;
  times_recommended: number;
  avg_reduction_pct: number | null;
  avg_li_after: number | null;
  effort: string;
}

export interface ZoneStats {
  zone_id: string;
  lift_count: number;
  k_threshold: number;
  hidden: boolean;
  avg_li?: number | null;
  max_li?: number | null;
  risk_counts?: Record<"green" | "yellow" | "red", number> | null;
  dominant_counts?: Record<string, number> | null;
  top_fixes?: FixStat[] | null;
  time_windows?: string[] | null;
  environment?: {
    reading: { temperature_c: number; decibels: number; aqi: number };
    hazards: HazardInfo[];
    time_window: string;
  } | null;
  needs?: string[];
}

/** Every request that leaves the browser, kept for the "What the server sees" panel. */
export interface SentRequest {
  id: number;
  at: number;
  method: string;
  path: string;
  body: string;
  bytes: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let sent: SentRequest[] = [];
let nextId = 1;

export function subscribeSent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getSent = () => sent;

/** The only way the app talks to the server, so nothing leaves unlogged. */
async function send<T>(method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  sent = [
    { id: nextId++, at: Date.now(), method, path, body, bytes: new TextEncoder().encode(body).length },
    ...sent,
  ].slice(0, 60);
  listeners.forEach((l) => l());

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : body,
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

const round = (v: number, d = 3) => Number(v.toFixed(d));

function numbersOnly(result: NioshResult) {
  return {
    li: Number.isFinite(result.li) ? round(result.li, 2) : 99,
    risk: result.risk,
    dominant: result.dominant,
    multipliers: Object.fromEntries(Object.entries(result.multipliers).map(([k, v]) => [k, round(v)])),
  };
}

/** Room readings (numbers only). */
const environmentNumbers = (env: Environment) => ({ temperature_c: env.temperatureC, decibels: env.decibels, aqi: env.aqi });

/**
 * Numbers only: LI, multipliers and code-computed what-if options for the last
 * lift (or null when only the environment changed), plus room readings and,
 * optionally, the grip/posture issue as categories (never landmarks).
 */
export function requestRecommendation(
  zoneId: string,
  lift: { result: NioshResult; options: RedesignOption[] } | null,
  env: Environment,
  gripIssue?: GripIssue | null,
): Promise<Recommendation> {
  return send<Recommendation>("POST", "/recommend", {
    zone_id: zoneId,
    ...(lift && {
      ...numbersOnly(lift.result),
      options: lift.options.map((o) => ({
        id: o.id,
        label: o.label,
        effort: o.effort,
        fixes: o.fixes,
        li_after: round(o.liAfter, 2),
        reduction_pct: o.reductionPct,
      })),
    }),
    environment: environmentNumbers(env),
    ...(gripIssue && { grip_issue: gripIssue }),
    language: "English",
  });
}

/**
 * Zone-level telemetry for the manager view: a completed lift and/or room
 * readings. No landmarks, no images, no person IDs, no exact time.
 */
export function sendTelemetry(zoneId: string, lift: { result: NioshResult; fix: Pick | undefined } | null, env: Environment) {
  const fix = lift?.fix;
  return send<{ lift_count: number }>("POST", "/telemetry", {
    zone_id: zoneId,
    ...(lift && {
      ...numbersOnly(lift.result),
      fix:
        fix && fix.kind === "lift" && fix.li_after !== null && fix.reduction_pct !== null
          ? { id: fix.id, label: fix.label, li_after: fix.li_after, reduction_pct: fix.reduction_pct, effort: fix.effort }
          : null,
    }),
    environment: environmentNumbers(env),
  });
}

export const fetchZones = (k: number) => send<ZoneStats[]>("GET", `/zones?k=${k}`);
export const resetZones = () => send<{ status: string }>("POST", "/zones/reset", {});
