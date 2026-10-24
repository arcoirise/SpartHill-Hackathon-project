import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { LM } from "../pose/landmarks";

/**
 * Body measurements in centimetres.
 *
 * Heights (V, knee, hip) come from the 2D image, converted to cm with a scale
 * calibrated from the worker's entered height. For a side-on camera the
 * horizontal reach (H) also comes from the image; this is the approach of
 * validated 2D video lifting monitors and avoids MediaPipe's noisy depth
 * estimate. For other views, H comes from MediaPipe's 3D world landmarks.
 *
 * Works when a desk or the bottom of the frame hides the knees and feet: the
 * floor is then estimated from body proportions (see estimatedFloorY) and the
 * knee height from the worker's stature.
 */
export interface BodyMeasure {
  /** Grip-centre height above the floor. NIOSH V. */
  handHeight: number;
  /** Horizontal distance from the ankle midpoint to the grip centre. NIOSH H. */
  handReach: number;
  reachSource: "2d" | "3d";
  kneeHeight: number;
  hipHeight: number;
  /** Shoulder line vs hip line in the floor plane, degrees. Proxy for NIOSH A. */
  twist: number;
  /** Forward/sideways lean of the spine (hip mid → shoulder mid) from vertical, degrees. */
  trunkBendDeg: number;
  /** Knee flexion (thigh vs shin), degrees: 0 = straight leg, 90 = right-angle squat. */
  kneeBendDeg: number;
  /** Stoop vs squat; "upright" when the knees or ankles are out of view (can't be judged). */
  liftPosture: LiftPosture;
  /** Lowest visibility among wrists, shoulders and hips (best side of each pair), 0–1. */
  minVisibility: number;
}

/** "stoop": back bent with near-straight knees (back takes the load); "squat": knees bent (legs take it). */
export type LiftPosture = "stoop" | "squat" | "upright";

/** Where things are in the image (normalized, unmirrored), for overlays and calibration. */
export interface ImageGeometry {
  floorY: number;
  /** Centimetres per one image-height unit. */
  cmPerUnit: number;
  aspect: number;
  grip: { x: number; y: number };
}

export type View = "side" | "angled" | "front";

/** Anthropometric ratios for an average adult (fractions of standing height). */
export const NOSE_TO_STATURE = 0.92;
export const SHOULDER_TO_STATURE = 0.818;
export const KNEE_TO_STATURE = 0.285;
/** Hip-to-floor and hip-to-knee distances in multiples of the shoulder-to-hip (torso) length. */
export const HIP_TO_FLOOR_PER_TORSO = 1.75;
export const HIP_TO_KNEE_PER_TORSO = 0.85;
/** Foot/knee points below this visibility, or below the frame edge, are treated as hidden. */
export const LOWER_BODY_VISIBILITY = 0.35;
/** Stoop: trunk bent at least this far with the knees bent less than STOOP_MAX_KNEE. */
export const STOOP_MIN_TRUNK = 30;
export const STOOP_MAX_KNEE = 25;
/** Knees bent at least this far count as a leg-driven squat. */
export const SQUAT_MIN_KNEE = 35;

type P = { x: number; y: number; z: number; visibility?: number };

const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const vis = (p: P) => p.visibility ?? 0;

/**
 * Visibility-weighted blend of a left/right pair. When the camera sees the
 * worker side-on, the far limb is hidden and MediaPipe only guesses where it
 * is, so the visible side should dominate.
 */
function blend(a: P, b: P): P & { visibility: number } {
  const wa = Math.max(vis(a), 0.01) ** 2;
  const wb = Math.max(vis(b), 0.01) ** 2;
  const s = wa + wb;
  return {
    x: (a.x * wa + b.x * wb) / s,
    y: (a.y * wa + b.y * wb) / s,
    z: (a.z * wa + b.z * wb) / s,
    visibility: Math.max(vis(a), vis(b)),
  };
}

function gripOf(p: P[]): P & { visibility: number } {
  const left = { ...mid(p[LM.L_WRIST], p[LM.L_INDEX]), visibility: vis(p[LM.L_WRIST]) };
  const right = { ...mid(p[LM.R_WRIST], p[LM.R_INDEX]), visibility: vis(p[LM.R_WRIST]) };
  return blend(left, right);
}

const inFrame = (p: P) => vis(p) > LOWER_BODY_VISIBILITY && p.y <= 1;

/** Shoulder-mid to hip-mid distance in image-height units. */
export function torsoLength(img: NormalizedLandmark[], aspect: number): number {
  const s = mid(img[LM.L_SHOULDER], img[LM.R_SHOULDER]);
  const h = mid(img[LM.L_HIP], img[LM.R_HIP]);
  return Math.hypot((s.x - h.x) * aspect, h.y - s.y);
}

/** Lowest visible foot point (largest y), or null when the feet are out of view. */
export function measuredFloorY(img: NormalizedLandmark[]): number | null {
  const feet = [LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT, LM.L_ANKLE, LM.R_ANKLE].filter((i) => inFrame(img[i]));
  return feet.length ? Math.max(...feet.map((i) => img[i].y)) : null;
}

/** Horizontal image position of the visible ankles, or null when they're out of view. */
export function visibleAnkleX(img: NormalizedLandmark[]): number | null {
  const seen = [img[LM.L_ANKLE], img[LM.R_ANKLE]].filter(inFrame);
  return seen.length ? blend(img[LM.L_ANKLE], img[LM.R_ANKLE]).x : null;
}

/** Floor position from body proportions. Only valid while the worker stands upright. */
export function estimatedFloorY(img: NormalizedLandmark[], aspect: number): number {
  return mid(img[LM.L_HIP], img[LM.R_HIP]).y + HIP_TO_FLOOR_PER_TORSO * torsoLength(img, aspect);
}

/**
 * How the camera sees the worker: shoulder width in the image relative to
 * torso length. Side-on, the shoulders overlap; facing the camera they are
 * almost as wide as the torso is long.
 */
export function viewOf(img: NormalizedLandmark[], aspect: number): View {
  const torso = torsoLength(img, aspect);
  if (torso < 1e-3) return "front";
  const ratio = (Math.abs(img[LM.L_SHOULDER].x - img[LM.R_SHOULDER].x) * aspect) / torso;
  return ratio < 0.45 ? "side" : ratio < 0.75 ? "angled" : "front";
}

/** True when the trunk looks vertical in the image (front views also need trunkBendDeg). */
export function isUpright(img: NormalizedLandmark[], aspect: number): boolean {
  const s = mid(img[LM.L_SHOULDER], img[LM.R_SHOULDER]);
  const h = mid(img[LM.L_HIP], img[LM.R_HIP]);
  const dy = h.y - s.y;
  return dy > 0 && Math.abs((s.x - h.x) * aspect) / dy < 0.35;
}

/** Shoulders and hips in view: enough to calibrate and detect lifts even if a desk hides the legs. */
export function isUpperBodyVisible(img: NormalizedLandmark[]): boolean {
  return blend(img[LM.L_SHOULDER], img[LM.R_SHOULDER]).visibility > 0.5 && blend(img[LM.L_HIP], img[LM.R_HIP]).visibility > 0.5;
}

/**
 * Image-height units per cm, from the worker's height: nose height when the
 * face is visible, shoulder height otherwise.
 */
export function calibrationCmPerUnit(img: NormalizedLandmark[], floorY: number, statureCm: number): number {
  const nose = img[LM.NOSE];
  const [y, ratio] =
    vis(nose) > 0.5 ? [nose.y, NOSE_TO_STATURE] : [mid(img[LM.L_SHOULDER], img[LM.R_SHOULDER]).y, SHOULDER_TO_STATURE];
  return (statureCm * ratio) / Math.max(floorY - y, 0.05);
}

/** World-landmark nose height in metres (MediaPipe's own body-size estimate). */
export function worldNoseHeight(world: Landmark[]): number {
  const floorY = Math.max(...[LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT].map((i) => world[i].y));
  return floorY - world[LM.NOSE].y;
}

/** Twist (degrees) between the shoulder line and the hip line in the floor plane. */
export function twistAngle(world: Landmark[]): number {
  const angle = (a: P, b: P) => Math.atan2(a.z - b.z, a.x - b.x);
  const diff = angle(world[LM.L_SHOULDER], world[LM.R_SHOULDER]) - angle(world[LM.L_HIP], world[LM.R_HIP]);
  let deg = Math.abs((diff * 180) / Math.PI) % 360;
  if (deg > 180) deg = 360 - deg;
  return deg;
}

/**
 * Spine angle from vertical, in 3D world landmarks so it also works when the
 * worker faces the camera and bends toward it (invisible as a tilt in 2D).
 */
export function trunkBendDeg(world: Landmark[]): number {
  const s = mid(world[LM.L_SHOULDER], world[LM.R_SHOULDER]);
  const h = mid(world[LM.L_HIP], world[LM.R_HIP]);
  const dx = s.x - h.x;
  const up = h.y - s.y; // y points down
  const dz = s.z - h.z;
  const len = Math.hypot(dx, up, dz);
  if (len < 1e-6) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, up / len))) * 180) / Math.PI;
}

/** Angle in degrees between vectors a and b (3D). */
function angleBetween(a: P, b: P): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/**
 * Knee flexion in 3D world landmarks: the angle between the thigh (hip → knee)
 * and the shin (knee → ankle), so 0° is a straight leg and 90° a right-angle
 * squat. Both legs are blended by visibility², so side-on the visible leg
 * dominates (MediaPipe only guesses the far one).
 */
export function kneeBendDeg(world: Landmark[]): number {
  const leg = (hip: number, knee: number, ankle: number) => ({
    deg: angleBetween(sub(world[knee], world[hip]), sub(world[ankle], world[knee])),
    w: Math.max(Math.min(vis(world[knee]), vis(world[ankle])), 0.01) ** 2,
  });
  const l = leg(LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
  const r = leg(LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);
  return (l.deg * l.w + r.deg * r.w) / (l.w + r.w);
}

/** Stoop (deep back bend, near-straight knees) vs squat (knees bent), from the two angles. */
export function liftPosture(trunkDeg: number, kneeDeg: number): LiftPosture {
  if (trunkDeg >= STOOP_MIN_TRUNK && kneeDeg < STOOP_MAX_KNEE) return "stoop";
  if (kneeDeg >= SQUAT_MIN_KNEE) return "squat";
  return "upright";
}

export interface MeasureInput {
  img: NormalizedLandmark[];
  world: Landmark[];
  aspect: number;
  /** Floor position in the image: measured from the feet, or estimated while upright. */
  floorY: number;
  /** Horizontal position of the feet in the image (reach is measured from here in side view). */
  footX: number;
  /** cm per image-height unit (from calibration). */
  cmPerUnit: number;
  /** Scale applied to world landmarks (from calibration). */
  worldScale: number;
  view: View;
  statureCm: number;
}

export function measureBody({ img, world, aspect, floorY, footX, cmPerUnit, worldScale, view, statureCm }: MeasureInput): {
  measure: BodyMeasure;
  geometry: ImageGeometry;
} {
  const height = (p: P) => (floorY - p.y) * cmPerUnit;

  const grip = gripOf(img);
  const knee = blend(img[LM.L_KNEE], img[LM.R_KNEE]);
  const hip = blend(img[LM.L_HIP], img[LM.R_HIP]);

  let handReach: number;
  let reachSource: "2d" | "3d";
  if (view === "side") {
    handReach = Math.abs(grip.x - footX) * aspect * cmPerUnit;
    reachSource = "2d";
  } else {
    const g = gripOf(world);
    const a = mid(world[LM.L_ANKLE], world[LM.R_ANKLE]);
    handReach = Math.hypot(g.x - a.x, g.z - a.z) * 100 * worldScale;
    reachSource = "3d";
  }

  // A desk may hide the knees: then use the typical knee height for this stature.
  const kneeSeen = inFrame(img[LM.L_KNEE]) || inFrame(img[LM.R_KNEE]);
  const kneeHeight = kneeSeen ? height(knee) : KNEE_TO_STATURE * statureCm;
  // Stoop vs squat needs a knee and ankle of the same leg in view; a hidden leg's angle is only a guess.
  const legSeen =
    (inFrame(img[LM.L_KNEE]) && inFrame(img[LM.L_ANKLE])) || (inFrame(img[LM.R_KNEE]) && inFrame(img[LM.R_ANKLE]));
  const trunk = trunkBendDeg(world);
  const knees = kneeBendDeg(world);

  const pairs: [number, number][] = [
    [LM.L_WRIST, LM.R_WRIST],
    [LM.L_SHOULDER, LM.R_SHOULDER],
    [LM.L_HIP, LM.R_HIP],
  ];
  const minVisibility = Math.min(...pairs.map(([l, r]) => Math.max(vis(img[l]), vis(img[r]))));

  return {
    measure: {
      handHeight: height(grip),
      handReach,
      reachSource,
      kneeHeight,
      hipHeight: height(hip),
      twist: twistAngle(world),
      trunkBendDeg: trunk,
      kneeBendDeg: knees,
      liftPosture: legSeen ? liftPosture(trunk, knees) : "upright",
      minVisibility,
    },
    geometry: { floorY, cmPerUnit, aspect, grip: { x: grip.x, y: grip.y } },
  };
}
