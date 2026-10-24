import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Coupling } from "../niosh/niosh";
import { LM } from "../pose/landmarks";
import type { PoseFrame } from "../pose/types";
import { NOSE_TO_STATURE } from "./measure";

/**
 * Replay mode: landmark sequences (never video) that run through exactly the
 * same pipeline as the live camera. Used as the demo safety net and for tests.
 */
export interface ReplayClip {
  name: string;
  /** True for generated clips; shown in the UI so nobody mistakes them for a real recording. */
  synthetic: boolean;
  frames: PoseFrame[];
  /** Task inputs the clip was made for; applied to the Setup bar when it plays. */
  settings?: { loadKg: number; coupling: Coupling; workerHeight: number };
}

// ---------------------------------------------------------------------------
// Synthetic worker
// ---------------------------------------------------------------------------

export interface BodyPose {
  /** Grip-centre height above the floor, cm. */
  hand: number;
  /** Grip-centre distance in front of the ankles, cm. */
  reach: number;
  /** Shoulder rotation relative to the hips, degrees. */
  twist: number;
  /** Forward trunk lean in degrees; by default it follows how low the hands are. */
  lean?: number;
}

export interface SyntheticOptions {
  view?: "side" | "front";
  statureCm?: number;
  aspect?: number;
  /** Simulate a desk / frame edge: landmarks below this image y are reported as barely visible. */
  cropBelowY?: number;
}

type V3 = [number, number, number];

const FPS = 30;
const IMAGE_SCALE = 0.48; // image-height units per metre
const FLOOR_IMAGE_Y = 0.92;

const smoothstep = (u: number) => u * u * (3 - 2 * u);
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/**
 * A simple side-view kinematic model of a squat-style lift. Ground frame in
 * metres: X forward, Y up from the floor, Z lateral (left = +Z). Body
 * proportions are for a 170 cm adult (hip 88 cm, shoulder-to-hip 51 cm, knee
 * 48 cm, nose 156 cm), scaled to `statureCm`.
 */
function skeleton({ hand, reach, twist, lean: leanDeg }: BodyPose, statureCm: number): V3[] {
  const s = statureCm / 170;
  const handM = hand / 100;
  const crouch = Math.min(1, Math.max(0, (0.8 * s - handM) / (0.68 * s)));
  const lean = ((leanDeg ?? 8 + 45 * crouch) * Math.PI) / 180;
  const tw = (twist * Math.PI) / 180;
  const lateral: V3 = [Math.sin(tw), 0, Math.cos(tw)];

  const p: V3[] = Array.from({ length: 33 }, () => [0, 0, 0] as V3);
  const side = (l: number, r: number, base: V3, half: number, dir: V3 = [0, 0, 1]) => {
    p[l] = add(base, scale(dir, half));
    p[r] = add(base, scale(dir, -half));
  };

  // Legs and feet (foot index on the floor, so the floor is detected at Y = 0).
  side(LM.L_ANKLE, LM.R_ANKLE, [0, 0.08 * s, 0], 0.1 * s);
  side(LM.L_HEEL, LM.R_HEEL, [-0.06 * s, 0.02 * s, 0], 0.1 * s);
  side(LM.L_FOOT, LM.R_FOOT, [0.14 * s, 0, 0], 0.1 * s);
  side(LM.L_KNEE, LM.R_KNEE, [(0.06 + 0.22 * crouch) * s, (0.48 - 0.06 * crouch) * s, 0], 0.1 * s);
  const hipC: V3 = [-0.15 * crouch * s, (0.88 - 0.4 * crouch) * s, 0];
  side(LM.L_HIP, LM.R_HIP, hipC, 0.1 * s);

  // Trunk and head. Upright nose height = 0.92 × stature (matches calibration).
  const shoulderC = add(hipC, scale([Math.sin(lean), Math.cos(lean), 0], 0.51 * s));
  side(LM.L_SHOULDER, LM.R_SHOULDER, shoulderC, 0.19 * s, lateral);
  const headLean = lean * 0.6;
  const nose = add(shoulderC, scale([Math.sin(headLean), Math.cos(headLean), 0], 0.18 * s));
  p[LM.NOSE] = nose;
  const face: [number, V3][] = [
    [1, [-0.02, 0.035, 0.02]],
    [2, [-0.02, 0.035, 0.035]],
    [3, [-0.025, 0.035, 0.05]],
    [4, [-0.02, 0.035, -0.02]],
    [5, [-0.02, 0.035, -0.035]],
    [6, [-0.025, 0.035, -0.05]],
    [7, [-0.1, 0.02, 0.075]],
    [8, [-0.1, 0.02, -0.075]],
    [9, [-0.01, -0.03, 0.025]],
    [10, [-0.01, -0.03, -0.025]],
  ];
  for (const [i, off] of face) p[i] = add(nose, scale(off, s));

  // Arms: both hands on the load, grip centre at (reach, hand).
  const grip: V3 = [reach / 100, handM, 0];
  const hands: [number, number, number, number, number, number][] = [
    // wrist, index, pinky, thumb, elbow, shoulder
    [LM.L_WRIST, LM.L_INDEX, 17, 21, LM.L_ELBOW, LM.L_SHOULDER],
    [LM.R_WRIST, LM.R_INDEX, 18, 22, LM.R_ELBOW, LM.R_SHOULDER],
  ];
  hands.forEach(([wrist, index, pinky, thumb, elbow, shoulder], k) => {
    const z = (k === 0 ? 1 : -1) * 0.17 * s;
    const g = add(grip, [0, 0, z]);
    p[wrist] = add(g, [-0.04 * s, 0.02 * s, 0]);
    p[index] = add(g, [0.04 * s, -0.02 * s, 0]);
    p[pinky] = add(g, [0.03 * s, -0.03 * s, 0]);
    p[thumb] = add(g, [0.03 * s, 0, z > 0 ? -0.03 * s : 0.03 * s]);
    p[elbow] = add(scale(add(p[shoulder], p[wrist]), 0.5), [-0.06 * s, -0.04 * s, 0]);
  });
  return p;
}

/** Project the ground-frame skeleton into a MediaPipe-style frame (image + world landmarks). */
export function syntheticFrame(pose: BodyPose, t: number, opts: SyntheticOptions = {}): PoseFrame {
  const { view = "side", statureCm = 170, aspect = 16 / 9, cropBelowY } = opts;
  const g = skeleton(pose, statureCm);
  const hip = scale(add(g[LM.L_HIP], g[LM.R_HIP]), 0.5);

  // Side view: the camera looks at the worker's left side, so the right limbs are partly hidden.
  const visibility = (i: number) => {
    if (view === "front") return 0.95;
    const isRight = i >= 11 ? i % 2 === 0 : [4, 5, 6, 8, 10].includes(i);
    return isRight ? 0.55 : 0.98;
  };

  const landmarks: NormalizedLandmark[] = g.map(([X, Y, Z], i) => {
    const y = FLOOR_IMAGE_Y - Y * IMAGE_SCALE;
    return {
      x: view === "side" ? 0.42 + (X * IMAGE_SCALE) / aspect : 0.5 + (Z * IMAGE_SCALE) / aspect,
      y,
      z: view === "side" ? -Z : -X,
      visibility: cropBelowY !== undefined && y > cropBelowY ? 0.05 : visibility(i),
    };
  });
  // MediaPipe world landmarks: metres, hip-centred, x right, y down, smaller z = closer.
  const worldLandmarks = g.map(([X, Y, Z], i) => ({
    x: view === "side" ? X - hip[0] : Z - hip[2],
    y: -(Y - hip[1]),
    z: view === "side" ? -(Z - hip[2]) : -(X - hip[0]),
    visibility: visibility(i),
  }));
  return { t, landmarks, worldLandmarks, aspect };
}

/** A motion step: move to `to` over `ms`, easing in and out. */
export type Step = { to: BodyPose; ms: number };

export function synthesize(start: BodyPose, steps: Step[], opts: SyntheticOptions = {}, t0 = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  const dt = 1000 / FPS;
  let t = t0;
  let from = start;
  for (const { to, ms } of steps) {
    const n = Math.max(1, Math.round(ms / dt));
    for (let i = 1; i <= n; i++) {
      const u = smoothstep(i / n);
      const pose: BodyPose = {
        hand: from.hand + (to.hand - from.hand) * u,
        reach: from.reach + (to.reach - from.reach) * u,
        twist: from.twist + (to.twist - from.twist) * u,
        lean: from.lean === undefined && to.lean === undefined ? undefined : (from.lean ?? 8) + ((to.lean ?? 8) - (from.lean ?? 8)) * u,
      };
      frames.push(syntheticFrame(pose, t, opts));
      t += dt;
    }
    from = to;
  }
  return frames;
}

/** Standing upright, arms hanging. */
export const STAND: BodyPose = { hand: 80, reach: 5, twist: 0 };
const hold = (pose: BodyPose, ms: number): Step => ({ to: pose, ms });

// Both demo clips assume a 20 kg box with a fair grip, matching the demo script.
const DEMO_SETTINGS = { loadKg: 20, coupling: "fair" as Coupling, workerHeight: 170 };

/** Floor pickup: V ≈ 12 cm, H ≈ 38 cm, D ≈ 68 cm, A ≈ 20° → high risk. */
export function floorLiftClip(opts: SyntheticOptions = {}): ReplayClip {
  const bottom = { hand: 12, reach: 38, twist: 0 };
  const top = { hand: 80, reach: 20, twist: 20 };
  const frames = synthesize(
    STAND,
    [hold(STAND, 1500), { to: bottom, ms: 1300 }, hold(bottom, 500), { to: top, ms: 1300 }, hold(top, 1500), { to: STAND, ms: 900 }, hold(STAND, 800)],
    opts,
  );
  return { name: "Floor lift (synthetic)", synthetic: true, frames, settings: DEMO_SETTINGS };
}

/** Redesigned station: pickup from a 75 cm table, V ≈ 75, H ≈ 25, D ≈ 20, A ≈ 0 → low risk. */
export function tableLiftClip(opts: SyntheticOptions = {}): ReplayClip {
  const pickup = { hand: 75, reach: 25, twist: 0 };
  const top = { hand: 95, reach: 18, twist: 0 };
  const frames = synthesize(
    STAND,
    [hold(STAND, 1500), { to: pickup, ms: 900 }, hold(pickup, 500), { to: top, ms: 1000 }, hold(top, 1500), { to: STAND, ms: 900 }, hold(STAND, 800)],
    opts,
  );
  return { name: "Table lift (synthetic)", synthetic: true, frames, settings: DEMO_SETTINGS };
}

// ---------------------------------------------------------------------------
// Recording real sessions
// ---------------------------------------------------------------------------

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Landmarks only, rounded to keep files small. Times are made relative to the first frame. */
export function serializeClip(name: string, frames: PoseFrame[]): string {
  const t0 = frames[0]?.t ?? 0;
  const slim = frames.map((f) => ({
    t: Math.round(f.t - t0),
    aspect: round(f.aspect),
    landmarks: f.landmarks.map((p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 0)]),
    worldLandmarks: f.worldLandmarks.map((p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 0)]),
  }));
  return JSON.stringify({ format: "edgesense-replay/1", name, frames: slim });
}

export function parseClip(text: string, fallbackName: string): ReplayClip {
  const data = JSON.parse(text);
  if (data?.format !== "edgesense-replay/1" || !Array.isArray(data.frames) || data.frames.length === 0) {
    throw new Error("Not an EdgeSense replay file");
  }
  const toPoint = ([x, y, z, visibility]: number[]) => ({ x, y, z, visibility });
  const frames: PoseFrame[] = data.frames.map((f: { t: number; aspect: number; landmarks: number[][]; worldLandmarks: number[][] }) => {
    if (f.landmarks?.length !== 33 || f.worldLandmarks?.length !== 33) throw new Error("Replay frame needs 33 landmarks");
    return { t: f.t, aspect: f.aspect, landmarks: f.landmarks.map(toPoint), worldLandmarks: f.worldLandmarks.map(toPoint) };
  });
  return { name: String(data.name ?? fallbackName), synthetic: false, frames };
}

/** Rolling buffer of the most recent live frames, for "Save last lift". */
export class FrameRecorder {
  private frames: PoseFrame[] = [];

  constructor(private keepMs = 30_000) {}

  push(frame: PoseFrame) {
    this.frames.push(frame);
    const cutoff = frame.t - this.keepMs;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }

  /** Frames from `fromT - padMs` to the end of the buffer. */
  since(fromT: number, padMs = 1500): PoseFrame[] {
    return this.frames.filter((f) => f.t >= fromT - padMs);
  }

  get length() {
    return this.frames.length;
  }
}

/** Typical upright nose height for a stature (used by tests to sanity-check calibration). */
export const uprightNoseCm = (statureCm: number) => statureCm * NOSE_TO_STATURE;
