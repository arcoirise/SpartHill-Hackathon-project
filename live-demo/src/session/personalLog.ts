import type { LiftTask, MultiplierKey, RiskLevel } from "../niosh/niosh";

/**
 * The worker's own lift record. It lives only on the worker's device
 * (localStorage) and is never sent to the server. Entries form a SHA-256 hash
 * chain: each entry's hash covers its content plus the previous hash, so
 * editing, removing or reordering any entry breaks verification from that point on.
 */
export interface LogEntry {
  index: number;
  /** ISO timestamp, local to this device. */
  timestamp: string;
  zoneId: string;
  task: LiftTask;
  li: number;
  risk: RiskLevel;
  dominant: MultiplierKey;
  prevHash: string;
  hash: string;
}

export type NewEntry = Omit<LogEntry, "index" | "prevHash" | "hash">;

export const GENESIS_HASH = "0".repeat(64);
const STORAGE_KEY = "edgesense.personalLog.v1";

/** Canonical JSON (sorted keys) so the same content always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashEntry(entry: Omit<LogEntry, "hash">): Promise<string> {
  return sha256Hex(canonical(entry));
}

export async function appendEntry(log: LogEntry[], entry: NewEntry): Promise<LogEntry[]> {
  const prevHash = log.length ? log[log.length - 1].hash : GENESIS_HASH;
  const body = { ...entry, index: log.length, prevHash };
  return [...log, { ...body, hash: await hashEntry(body) }];
}

export type Verification = { ok: true; count: number } | { ok: false; brokenAt: number; reason: string };

/** Recompute every hash and link; report the first entry that doesn't match. */
export async function verifyLog(log: LogEntry[]): Promise<Verification> {
  let prev = GENESIS_HASH;
  for (let i = 0; i < log.length; i++) {
    const { hash, ...body } = log[i];
    if (body.index !== i) return { ok: false, brokenAt: i, reason: "entry out of order or missing" };
    if (body.prevHash !== prev) return { ok: false, brokenAt: i, reason: "link to previous entry broken" };
    if ((await hashEntry(body)) !== hash) return { ok: false, brokenAt: i, reason: "entry content was changed" };
    prev = hash;
  }
  return { ok: true, count: log.length };
}

// --- device storage (worker-only) -------------------------------------------

export function loadLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Returns false when storage is unavailable (private window etc.); the log then lives in memory only. */
export function saveLog(log: LogEntry[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
    return true;
  } catch {
    return false;
  }
}

export function exportLog(log: LogEntry[]): Blob {
  const doc = {
    format: "edgesense-personal-log/1",
    note: "Exported by the worker from their own device. Each entry's SHA-256 hash covers its content and the previous hash.",
    exportedAt: new Date().toISOString(),
    entries: log,
  };
  return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
}
