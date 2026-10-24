import { describe, expect, it } from "vitest";
import type { Landmark } from "@mediapipe/tasks-vision";
import { LM } from "../pose/landmarks";
import type { PoseFrame } from "../pose/types";
import { LiftDetector, REACH_CONFIRM, STILL_SPEED, STILL_TIME, type LiftMeasurement, type LiftSnapshot } from "./liftDetector";
import { kneeBendDeg, liftPosture, measureBody } from "./measure";
import { STAND, floorLiftClip, synthesize, syntheticFrame, type BodyPose } from "./replay";

/** World landmarks (metres, y down) with one leg pose on both sides; `vis` per side. */
function legs(hip: [number, number], knee: [number, number], ankle: [number, number], vis = { l: 0.95, r: 0.95 }): Landmark[] {
  const w: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
  const put = (i: number, [x, y]: [number, number], z: number, visibility: number) => (w[i] = { x, y, z, visibility });
  put(LM.L_HIP, hip, 0.1, vis.l);
  put(LM.L_KNEE, knee, 0.1, vis.l);
  put(LM.L_ANKLE, ankle, 0.1, vis.l);
  put(LM.R_HIP, hip, -0.1, vis.r);
  put(LM.R_KNEE, knee, -0.1, vis.r);
  put(LM.R_ANKLE, ankle, -0.1, vis.r);
  return w;
}

function run(frames: PoseFrame[]): { lifts: LiftMeasurement[]; snaps: LiftSnapshot[] } {
  const detector = new LiftDetector(170);
  const lifts: LiftMeasurement[] = [];
  const snaps: LiftSnapshot[] = [];
  for (const f of frames) {
    const { snapshot, completed } = detector.update(f);
    snaps.push(snapshot);
    if (completed) lifts.push(completed);
  }
  return { lifts, snaps };
}

/** measureBody on one synthetic frame, with the scale the synthesizer uses (0.48 image units per metre). */
function measureFrame(frame: PoseFrame) {
  return measureBody({
    img: frame.landmarks,
    world: frame.worldLandmarks,
    aspect: frame.aspect,
    floorY: 0.92,
    footX: 0.42,
    cmPerUnit: 100 / 0.48,
    worldScale: 1,
    view: "side",
    statureCm: 170,
  }).measure;
}

describe("kneeBendDeg", () => {
  it("is 0° for a straight leg and 90° for a right-angle squat", () => {
    expect(kneeBendDeg(legs([0, 0], [0, 0.45], [0, 0.85]))).toBeCloseTo(0);
    // Thigh horizontal (hip → knee forward), shin vertical.
    expect(kneeBendDeg(legs([0, 0], [0.45, 0], [0.45, 0.4]))).toBeCloseTo(90);
  });

  it("follows the visible leg when the far leg is hidden (side-on)", () => {
    const w = legs([0, 0], [0.45, 0], [0.45, 0.4], { l: 0.95, r: 0.1 });
    // The hidden right leg is guessed straight; the visible left leg is at 90°.
    w[LM.R_KNEE] = { x: 0, y: 0.45, z: -0.1, visibility: 0.1 };
    w[LM.R_ANKLE] = { x: 0, y: 0.85, z: -0.1, visibility: 0.1 };
    expect(kneeBendDeg(w)).toBeGreaterThan(85);
  });
});

describe("liftPosture", () => {
  it("calls a deep back bend with near-straight knees a stoop", () => {
    expect(liftPosture(30, 24)).toBe("stoop");
    expect(liftPosture(60, 5)).toBe("stoop");
  });

  it("calls bent knees a squat, however far the back bends", () => {
    expect(liftPosture(50, 35)).toBe("squat");
    expect(liftPosture(10, 90)).toBe("squat");
  });

  it("is upright otherwise (shallow bend, or knees between stoop and squat)", () => {
    expect(liftPosture(29, 0)).toBe("upright");
    expect(liftPosture(45, 30)).toBe("upright");
    expect(liftPosture(5, 10)).toBe("upright");
  });
});

describe("measureBody posture", () => {
  it("reports the synthetic floor pickup (knees bent) as a squat", () => {
    const m = measureFrame(syntheticFrame({ hand: 12, reach: 38, twist: 0 }, 0));
    expect(m.kneeBendDeg).toBeGreaterThan(90);
    expect(m.liftPosture).toBe("squat");
  });

  it("reports a deep bend with straight knees as a stoop", () => {
    const frame = syntheticFrame({ hand: 40, reach: 30, twist: 0, lean: 60 }, 0);
    const world = frame.worldLandmarks.map((p) => ({ ...p }));
    // Straighten both legs: knee halfway between hip and ankle.
    for (const [hip, knee, ankle] of [
      [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE],
      [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE],
    ]) {
      world[knee] = { ...world[knee], x: (world[hip].x + world[ankle].x) / 2, y: (world[hip].y + world[ankle].y) / 2 };
    }
    const m = measureFrame({ ...frame, worldLandmarks: world });
    expect(m.trunkBendDeg).toBeGreaterThan(50);
    expect(m.kneeBendDeg).toBeLessThan(5);
    expect(m.liftPosture).toBe("stoop");
  });

  it("does not judge stoop vs squat when a desk hides the knees and feet", () => {
    const frame = syntheticFrame({ hand: 40, reach: 30, twist: 0, lean: 60 }, 0, { cropBelowY: 0.62 });
    const m = measureFrame(frame);
    expect(m.trunkBendDeg).toBeGreaterThan(50);
    expect(m.liftPosture).toBe("upright");
  });

  it("shows the squat in live snapshots during the synthetic floor lift", () => {
    const { snaps } = run(floorLiftClip().frames);
    const atPickup = snaps.filter((s) => s.phase === "REACHING_DOWN");
    expect(atPickup.some((s) => s.measure.liftPosture === "squat")).toBe(true);
    expect(snaps.some((s) => s.measure.liftPosture === "stoop")).toBe(false);
  });
});

describe("LiftDetector timing for quick lifts", () => {
  it("uses short confirm and still times with a noise-tolerant still speed", () => {
    expect(REACH_CONFIRM).toBe(80);
    expect(STILL_SPEED).toBe(22);
    expect(STILL_TIME).toBe(200);
  });

  it("detects a quick floor lift with only a brief pause at the top", () => {
    const bottom: BodyPose = { hand: 12, reach: 38, twist: 0 };
    const top: BodyPose = { hand: 80, reach: 20, twist: 0 };
    const frames = synthesize(STAND, [
      { to: STAND, ms: 1500 },
      { to: bottom, ms: 600 },
      { to: bottom, ms: 100 },
      { to: top, ms: 600 },
      { to: top, ms: 250 },
      { to: STAND, ms: 600 },
      { to: STAND, ms: 800 },
    ]);
    const { lifts } = run(frames);
    expect(lifts).toHaveLength(1);
    expect(lifts[0].lowPickup).toBe(true);
    expect(lifts[0].travel).toBeGreaterThan(50);
    expect(lifts[0].durationMs).toBeLessThan(1500);
  });
});
