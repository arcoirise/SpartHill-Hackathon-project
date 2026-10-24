import { describe, expect, it } from "vitest";
import type { PoseFrame } from "../pose/types";
import { LiftDetector, type LiftMeasurement, type LiftSnapshot } from "./liftDetector";
import { STAND, floorLiftClip, synthesize, tableLiftClip, type BodyPose, type SyntheticOptions } from "./replay";

function run(frames: PoseFrame[], heightCm = 170): { lifts: LiftMeasurement[]; snaps: LiftSnapshot[] } {
  const detector = new LiftDetector(heightCm);
  const lifts: LiftMeasurement[] = [];
  const snaps: LiftSnapshot[] = [];
  for (const f of frames) {
    const { snapshot, completed } = detector.update(f);
    snaps.push(snapshot);
    if (completed) lifts.push(completed);
  }
  return { lifts, snaps };
}

const pose = (hand: number, reach: number, twist = 0): BodyPose => ({ hand, reach, twist });

/** Stand, go to `pickup`, pause, rise to `top`, hold. */
function liftFrames(pickup: BodyPose, top: BodyPose, opts: SyntheticOptions = {}) {
  return synthesize(
    STAND,
    [
      { to: STAND, ms: 1500 },
      { to: pickup, ms: 1200 },
      { to: pickup, ms: 500 },
      { to: top, ms: 1200 },
      { to: top, ms: 1500 },
    ],
    opts,
  );
}

describe("LiftDetector", () => {
  it("measures a floor-to-waist lift (side view, 2D calibrated)", () => {
    const { lifts, snaps } = run(floorLiftClip().frames);
    expect(lifts).toHaveLength(1);
    const [l] = lifts;
    expect(l.originHeight).toBeGreaterThan(8);
    expect(l.originHeight).toBeLessThan(18);
    expect(l.originReach).toBeGreaterThan(34);
    expect(l.originReach).toBeLessThan(42);
    expect(l.travel).toBeGreaterThan(58);
    expect(l.travel).toBeLessThan(76);
    expect(l.maxTwist).toBeGreaterThan(15);
    expect(l.maxTwist).toBeLessThan(25);
    expect(l.lowPickup).toBe(true);
    expect(l.view).toBe("side");
    expect(l.reachSource).toBe("2d");
    expect(l.calibrated).toBe(true);
    // The pre-lift cue fires while reaching down to the floor.
    expect(snaps.some((s) => s.phase === "REACHING_DOWN" && s.lowPickup)).toBe(true);
  });

  it("detects a pickup from a 75 cm table (never below the knees)", () => {
    const { lifts, snaps } = run(tableLiftClip().frames);
    expect(lifts).toHaveLength(1);
    const [l] = lifts;
    expect(l.originHeight).toBeGreaterThan(70);
    expect(l.originHeight).toBeLessThan(80);
    expect(l.originReach).toBeGreaterThan(21);
    expect(l.originReach).toBeLessThan(29);
    expect(l.travel).toBeGreaterThan(15);
    expect(l.travel).toBeLessThan(26);
    expect(l.lowPickup).toBe(false);
    expect(snaps.some((s) => s.phase === "REACHING_DOWN" && s.lowPickup)).toBe(false);
  });

  it("detects a table-to-chest lift (72 → 95 cm)", () => {
    const { lifts } = run(liftFrames(pose(72, 30), pose(95, 18)));
    expect(lifts).toHaveLength(1);
    expect(lifts[0].originHeight).toBeCloseTo(72, -0.7);
    expect(lifts[0].travel).toBeCloseTo(23, -0.7);
  });

  it("ignores small hand movements (< 10 cm rise)", () => {
    const frames = synthesize(STAND, [
      { to: STAND, ms: 1500 },
      { to: pose(80, 30), ms: 600 },
      { to: pose(88, 30), ms: 400 },
      { to: pose(80, 30), ms: 400 },
      { to: pose(88, 28), ms: 400 },
      { to: pose(88, 28), ms: 1500 },
      { to: STAND, ms: 800 },
      { to: STAND, ms: 1500 },
    ]);
    expect(run(frames).lifts).toHaveLength(0);
  });

  it("ignores arms swinging at the sides", () => {
    const frames = synthesize(STAND, [
      { to: STAND, ms: 1000 },
      { to: pose(76, 12), ms: 500 },
      { to: pose(84, 0), ms: 500 },
      { to: pose(76, 12), ms: 500 },
      { to: STAND, ms: 1500 },
    ]);
    expect(run(frames).lifts).toHaveLength(0);
  });

  it("does not complete while the hands keep moving", () => {
    const frames = synthesize(STAND, [
      { to: STAND, ms: 1500 },
      { to: pose(12, 38), ms: 1200 },
      { to: pose(12, 38), ms: 500 },
      { to: pose(150, 20), ms: 3000 },
    ]);
    expect(run(frames).lifts).toHaveLength(0);
  });

  it("counts two lifts in a row", () => {
    const first = floorLiftClip().frames;
    const offset = first[first.length - 1].t + 33;
    const second = tableLiftClip().frames.map((f) => ({ ...f, t: f.t + offset }));
    expect(run([...first, ...second]).lifts).toHaveLength(2);
  });

  it("uses 3D reach when the worker faces the camera", () => {
    const { lifts } = run(floorLiftClip({ view: "front" }).frames);
    expect(lifts).toHaveLength(1);
    expect(lifts[0].view).toBe("front");
    expect(lifts[0].reachSource).toBe("3d");
    expect(lifts[0].originReach).toBeGreaterThan(32);
    expect(lifts[0].originReach).toBeLessThan(44);
    expect(lifts[0].originHeight).toBeLessThan(20);
  });

  it("still measures a floor lift when a desk hides the feet", () => {
    // Synthetic floor at image y 0.92, ankles at ~0.88: crop everything below 0.8.
    const { lifts, snaps } = run(floorLiftClip({ cropBelowY: 0.8 }).frames);
    expect(snaps[40].feetVisible).toBe(false);
    expect(snaps[40].calibrated).toBe(true);
    expect(lifts).toHaveLength(1);
    const [l] = lifts;
    expect(l.floorSource).toBe("estimated");
    // The floor comes from body proportions, so allow a few cm more error than with feet in view.
    expect(l.originHeight).toBeGreaterThan(5);
    expect(l.originHeight).toBeLessThan(22);
    // Reach is measured from where the feet were while standing, not from the hips (which move back in a squat).
    expect(l.originReach).toBeGreaterThan(32);
    expect(l.originReach).toBeLessThan(46);
    expect(l.travel).toBeGreaterThan(55);
    expect(l.travel).toBeLessThan(80);
    expect(l.lowPickup).toBe(true);
  });

  it("still detects a table lift when a desk hides knees and feet", () => {
    // Knees sit at image y ~0.69 standing; crop below 0.62 (hips at ~0.50 stay visible).
    const { lifts, snaps } = run(tableLiftClip({ cropBelowY: 0.62 }).frames);
    expect(snaps[40].tracked).toBe(true);
    expect(snaps[40].feetVisible).toBe(false);
    expect(lifts).toHaveLength(1);
    expect(lifts[0].originHeight).toBeGreaterThan(68);
    expect(lifts[0].originHeight).toBeLessThan(84);
    expect(lifts[0].lowPickup).toBe(false);
  });

  it("starts a lift from a forward trunk bend, even with hands close to the body", () => {
    // Hands at 62 cm and only 15 cm out: neither below the knees nor reaching forward, but bent 40°.
    const bent = { hand: 62, reach: 15, twist: 0, lean: 40 };
    const top = { hand: 92, reach: 15, twist: 0, lean: 8 };
    const frames = synthesize(STAND, [
      { to: STAND, ms: 1500 },
      { to: bent, ms: 1000 },
      { to: bent, ms: 500 },
      { to: top, ms: 1000 },
      { to: top, ms: 1500 },
    ]);
    const { lifts, snaps } = run(frames);
    expect(snaps.some((s) => s.measure.trunkBendDeg > 35)).toBe(true);
    expect(lifts).toHaveLength(1);
    expect(lifts[0].maxTrunkBend).toBeGreaterThan(35);
    expect(lifts[0].travel).toBeGreaterThan(20);
  });

  it("calibrates image scale to the worker's entered height", () => {
    // A 185 cm worker appears bigger in the image; with the right height entered, cm still come out right.
    const tall = floorLiftClip({ statureCm: 185 }).frames;
    const right = run(tall, 185).lifts[0];
    expect(right.originReach).toBeGreaterThan(34);
    expect(right.originReach).toBeLessThan(42);
    // With the wrong height entered, every distance is scaled by 170/185.
    const wrong = run(tall, 170).lifts[0];
    expect(wrong.originReach / right.originReach).toBeCloseTo(170 / 185, 2);
  });
});
