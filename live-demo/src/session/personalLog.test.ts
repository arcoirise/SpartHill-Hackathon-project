import { describe, expect, it } from "vitest";
import type { LiftTask } from "../niosh/niosh";
import { GENESIS_HASH, appendEntry, sha256Hex, verifyLog, type LogEntry, type NewEntry } from "./personalLog";

const task: LiftTask = { H: 39, V: 12, D: 70, A: 20, frequency: 1, coupling: "fair", loadKg: 20 };
const entry = (li: number, minute: number): NewEntry => ({
  timestamp: `2026-10-23T18:${String(minute).padStart(2, "0")}:00.000Z`,
  zoneId: "zone-a",
  task,
  li,
  risk: li > 2 ? "red" : li > 1 ? "yellow" : "green",
  dominant: "HM",
});

async function build(n: number): Promise<LogEntry[]> {
  let log: LogEntry[] = [];
  for (let i = 0; i < n; i++) log = await appendEntry(log, entry(1 + i * 0.4, i));
  return log;
}

describe("personal log hash chain", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("links each entry to the previous hash", async () => {
    const log = await build(3);
    expect(log[0].prevHash).toBe(GENESIS_HASH);
    expect(log[1].prevHash).toBe(log[0].hash);
    expect(log[2].prevHash).toBe(log[1].hash);
    expect(await verifyLog(log)).toEqual({ ok: true, count: 3 });
  });

  it("detects an edited entry", async () => {
    const log = await build(3);
    const tampered = log.map((e, i) => (i === 1 ? { ...e, li: 0.5 } : e));
    expect(await verifyLog(tampered)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("detects a deleted entry", async () => {
    const log = await build(3);
    expect(await verifyLog([log[0], log[2]])).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("detects an entry whose hash was recomputed but the chain not rebuilt", async () => {
    const log = await build(3);
    const { hash: _old, ...body } = { ...log[0], li: 0.4 };
    const rehashed = { ...body, hash: await sha256Hex(JSON.stringify(body)) };
    expect(await verifyLog([rehashed, log[1], log[2]])).toMatchObject({ ok: false });
  });
});
