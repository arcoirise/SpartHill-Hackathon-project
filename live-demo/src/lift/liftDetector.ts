import type { PoseFrame } from "../pose/types";
import {
  NOSE_TO_STATURE,
  calibrationCmPerUnit,
  estimatedFloorY,
  isUpperBodyVisible,
  isUpright,
  measureBody,
  measuredFloorY,
  torsoLength,
  viewOf,
  visibleAnkleX,
  worldNoseHeight,
  type BodyMeasure,
  type ImageGeometry,
  type View,
} from "./measure";
import { LandmarkFilter } from "./oneEuro";
import { LM } from "../pose/landmarks";

/**
 * STANDING → REACHING_DOWN (hands go to a pickup point: below the knees,
 * reaching forward below hip height e.g. a table, or the trunk bends forward)
 * → LIFTING (hands rise) → lift complete (hands hold still well above the
 * pickup) → STANDING.
 */
export type LiftPhase = "STANDING" | "REACHING_DOWN" | "LIFTING";

type Pt = { x: number; y: number };

/** Everything NIOSH needs from one completed lift, in cm / degrees. */
export interface LiftMeasurement {
  originHeight: number;
  originReach: number;
  destinationHeight: number;
  travel: number;
  maxTwist: number;
  maxTrunkBend: number;
  /** Lowest visibility of wrists, shoulders and hips during the lift, 0–1. */
  minVisibility: number;
  /** Whether height calibration had settled before this lift. */
  calibrated: boolean;
  view: View;
  reachSource: "2d" | "3d";
  /** "estimated" when the feet were out of view and the floor came from body proportions. */
  floorSource: "feet" | "estimated";
  /** Pickup below knee height (floor / low shelf). */
  lowPickup: boolean;
  durationMs: number;
  /** Where the pickup happened in the image (normalized, unmirrored) and the scale then. */
  originImage: Pt;
  geometry: ImageGeometry;
  trail: Pt[];
}

export interface LiftSnapshot {
  phase: LiftPhase;
  measure: BodyMeasure;
  geometry: ImageGeometry;
  calibrated: boolean;
  /** Shoulders and hips in view (enough to work; the legs may be hidden by a desk). */
  tracked: boolean;
  feetVisible: boolean;
  view: View;
  /** Lowest hand height so far in the current lift, if one is in progress. */
  originHeight?: number;
  /** Current pickup is below knee height. */
  lowPickup: boolean;
  /** Hand path of the current lift, or of the last completed one. */
  trail: Pt[];
}

export interface LiftUpdate {
  snapshot: LiftSnapshot;
  completed?: LiftMeasurement;
}

// Tuning constants. Heights in cm, speeds in cm/s, angles in degrees, times in ms.
/** Hands must rise this far above the pickup point before we call it lifting. */
const RISE_TO_START_LIFT = 12;
/** ...and end at least this far above it for the lift to count. */
const MIN_TRAVEL = 15;
/** Reaching forward at least this far (below hip height) counts as a pickup, e.g. from a table. */
const REACH_FORWARD = 22;
/** Bending the trunk forward this far counts as reaching for a pickup. */
const BEND_TO_START = 25;
/** Below this trunk angle the worker counts as upright (for calibration and floor estimation). */
const UPRIGHT_BEND = 15;
/** Hips moving slower than this (torso lengths per second) count as standing still. */
const STILL_HIPS = 0.15;
/** Hands slower than this (cm/s) for STILL_TIME end a lift: short enough that nobody has to pause long at the top. */
export const STILL_SPEED = 22;
export const STILL_TIME = 200;
/** Pickup posture must hold this long (ignores tracking blips, but keeps up with a quick grab). */
export const REACH_CONFIRM = 80;
/** Leaving the pickup posture without lifting for this long cancels the attempt. */
const ABANDON_TIME = 800;
const MAX_LIFT_TIME = 20_000;
const COOLDOWN = 800;
const LOST_PERSON_GAP = 1_000;
const CALIBRATION_FRAMES = 15;
const MIN_VISIBILITY = 0.5;
const MAX_TRAIL = 240;

interface LiftInProgress {
  startT: number;
  originHeight: number;
  originReach: number;
  originKnee: number;
  originImage: Pt;
  originGeometry: ImageGeometry;
  maxTwist: number;
  maxTrunkBend: number;
  minVisibility: number;
  floorEstimated: boolean;
  trail: Pt[];
}

export class LiftDetector {
  // One Euro filtering: smooth when still, responsive when moving.
  private imgFilter = new LandmarkFilter(1.2, 4);
  private worldFilter = new LandmarkFilter(1.2, 2);

  private phase: LiftPhase = "STANDING";
  private lift: LiftInProgress | null = null;
  private lastTrail: Pt[] = [];
  private prev: { t: number; measure: BodyMeasure } | null = null;
  private reachSince: number | null = null;
  private notReachingSince: number | null = null;
  private stillSince: number | null = null;
  private cooldownUntil = 0;

  private cmPerUnit: number | null = null;
  private worldScale = 1;
  private calibrationFrames = 0;
  private view: View = "side";
  /** Last trusted floor position (image units) for when the feet are out of view. */
  private floorEstimate: number | null = null;
  private prevHip: { t: number; y: number } | null = null;
  /** Last trusted horizontal foot position (image units); hips sit above the feet when standing. */
  private footEstimate: number | null = null;

  constructor(private workerHeightCm = 170) {}

  setWorkerHeight(cm: number) {
    if (cm === this.workerHeightCm || !(cm > 0)) return;
    this.workerHeightCm = cm;
    this.cmPerUnit = null;
    this.calibrationFrames = 0;
  }

  /** Forget the current motion (e.g. when switching between camera and replay). */
  reset() {
    this.imgFilter.reset();
    this.worldFilter.reset();
    this.phase = "STANDING";
    this.lift = null;
    this.prev = null;
    this.reachSince = null;
    this.notReachingSince = null;
    this.stillSince = null;
    this.cooldownUntil = 0;
  }

  /** Also forget calibration, the floor estimate and the last trail (new person / new clip). */
  resetAll() {
    this.reset();
    this.cmPerUnit = null;
    this.calibrationFrames = 0;
    this.floorEstimate = null;
    this.prevHip = null;
    this.footEstimate = null;
    this.lastTrail = [];
  }

  update(frame: PoseFrame): LiftUpdate {
    const { t, aspect } = frame;
    if (this.prev && (t - this.prev.t > LOST_PERSON_GAP || t < this.prev.t)) this.reset();

    const img = this.imgFilter.filter(frame.landmarks, t);
    const world = this.worldFilter.filter(frame.worldLandmarks, t);
    const tracked = isUpperBodyVisible(img);
    // The view is only re-estimated between lifts, so one lift is measured consistently.
    if (this.phase === "STANDING") this.view = viewOf(img, aspect);

    // Floor: from the feet when they're in view. Otherwise estimate it from body
    // proportions, but only while standing upright and still between lifts:
    // squatting drops the hips, and the feet (the real floor) don't move.
    const feetFloor = measuredFloorY(img);
    const hipY = (img[LM.L_HIP].y + img[LM.R_HIP].y) / 2;
    const hipX = (img[LM.L_HIP].x + img[LM.R_HIP].x) / 2;
    const hipSpeed =
      this.prevHip && t > this.prevHip.t
        ? Math.abs(hipY - this.prevHip.y) / ((t - this.prevHip.t) / 1000) / Math.max(torsoLength(img, aspect), 1e-3)
        : Infinity;
    this.prevHip = { t, y: hipY };
    const standingStill =
      this.phase === "STANDING" &&
      tracked &&
      hipSpeed < STILL_HIPS &&
      isUpright(img, aspect) &&
      this.prev !== null &&
      this.prev.measure.trunkBendDeg < UPRIGHT_BEND;
    if (feetFloor !== null) {
      this.floorEstimate = feetFloor;
    } else if (this.floorEstimate === null) {
      this.floorEstimate = estimatedFloorY(img, aspect);
    } else if (standingStill) {
      this.floorEstimate += 0.2 * (estimatedFloorY(img, aspect) - this.floorEstimate);
    }
    const floorY = feetFloor ?? this.floorEstimate;
    // Same for where the feet are horizontally: under the hips while standing, fixed during a lift.
    const ankleX = visibleAnkleX(img);
    if (ankleX !== null) {
      this.footEstimate = ankleX;
    } else if (this.footEstimate === null) {
      this.footEstimate = hipX;
    } else if (standingStill) {
      this.footEstimate += 0.2 * (hipX - this.footEstimate);
    }
    const footX = ankleX ?? this.footEstimate;

    const targetCmPerUnit = calibrationCmPerUnit(img, floorY, this.workerHeightCm);
    this.cmPerUnit ??= targetCmPerUnit;
    if (this.calibrationFrames === 0) {
      this.worldScale = (this.workerHeightCm * NOSE_TO_STATURE) / Math.max(worldNoseHeight(world) * 100, 50);
    }

    const { measure: m, geometry } = measureBody({
      img,
      world,
      aspect,
      floorY,
      footX,
      cmPerUnit: this.cmPerUnit,
      worldScale: this.worldScale,
      view: this.view,
      statureCm: this.workerHeightCm,
    });

    const dt = this.prev ? (t - this.prev.t) / 1000 : 0;
    const speed =
      this.prev && dt > 0
        ? Math.hypot(m.handHeight - this.prev.measure.handHeight, m.handReach - this.prev.measure.handReach) / dt
        : 0;
    this.prev = { t, measure: m };

    const pickupPosture =
      m.handHeight < m.kneeHeight ||
      m.trunkBendDeg > BEND_TO_START ||
      (m.handHeight < m.hipHeight && m.handReach >= REACH_FORWARD);
    // Starting a lift needs the hands in view. Once started, the hands may dip
    // below the frame or behind a desk (MediaPipe still estimates them, and the
    // lift is flagged low-confidence); only shoulders and hips must stay visible.
    const reaching = m.minVisibility >= MIN_VISIBILITY && pickupPosture;
    const stillReaching = tracked && pickupPosture;

    let completed: LiftMeasurement | undefined;

    if (this.phase === "STANDING") {
      // Calibrate only while upright with arms down and the upper body in view.
      if (!reaching && tracked && m.handHeight > m.kneeHeight && m.trunkBendDeg < UPRIGHT_BEND && isUpright(img, aspect)) {
        this.calibrate(targetCmPerUnit, world);
      }
      if (!reaching || t < this.cooldownUntil) {
        this.reachSince = null;
      } else {
        this.reachSince ??= t;
        if (t - this.reachSince >= REACH_CONFIRM) this.startLift(t, m, geometry, feetFloor === null);
      }
    } else if (this.lift) {
      completed = this.track(t, m, geometry, speed, stillReaching, feetFloor === null);
    }

    const lift = this.lift;
    return {
      snapshot: {
        phase: this.phase,
        measure: m,
        geometry,
        calibrated: this.isCalibrated(),
        tracked,
        feetVisible: feetFloor !== null,
        view: this.view,
        originHeight: lift?.originHeight,
        lowPickup: lift ? lift.originHeight < lift.originKnee : false,
        trail: lift ? lift.trail : this.lastTrail,
      },
      completed,
    };
  }

  private startLift(t: number, m: BodyMeasure, geometry: ImageGeometry, floorEstimated: boolean) {
    this.phase = "REACHING_DOWN";
    this.reachSince = null;
    this.notReachingSince = null;
    this.lift = {
      startT: t,
      originHeight: m.handHeight,
      originReach: m.handReach,
      originKnee: m.kneeHeight,
      originImage: { ...geometry.grip },
      originGeometry: geometry,
      maxTwist: m.twist,
      maxTrunkBend: m.trunkBendDeg,
      minVisibility: m.minVisibility,
      floorEstimated,
      trail: [{ ...geometry.grip }],
    };
  }

  private track(
    t: number,
    m: BodyMeasure,
    geometry: ImageGeometry,
    speed: number,
    reaching: boolean,
    floorEstimated: boolean,
  ): LiftMeasurement | undefined {
    const lift = this.lift!;
    lift.maxTwist = Math.max(lift.maxTwist, m.twist);
    lift.maxTrunkBend = Math.max(lift.maxTrunkBend, m.trunkBendDeg);
    lift.minVisibility = Math.min(lift.minVisibility, m.minVisibility);
    lift.floorEstimated ||= floorEstimated;
    if (lift.trail.length < MAX_TRAIL) lift.trail.push({ ...geometry.grip });
    if (m.handHeight < lift.originHeight) {
      lift.originHeight = m.handHeight;
      lift.originReach = m.handReach;
      lift.originKnee = m.kneeHeight;
      lift.originImage = { ...geometry.grip };
      lift.originGeometry = geometry;
    }

    if (t - lift.startT > MAX_LIFT_TIME) return this.abandon();
    const rise = m.handHeight - lift.originHeight;

    if (this.phase === "REACHING_DOWN") {
      if (rise > RISE_TO_START_LIFT) {
        this.phase = "LIFTING";
        this.stillSince = null;
      } else if (!reaching) {
        // Hands went back to rest without lifting anything (e.g. after setting a load down).
        this.notReachingSince ??= t;
        if (t - this.notReachingSince > ABANDON_TIME) return this.abandon();
      } else {
        this.notReachingSince = null;
      }
      return undefined;
    }

    // LIFTING: complete once the hands hold still clearly above the pickup point.
    if (speed < STILL_SPEED && rise >= MIN_TRAVEL) {
      this.stillSince ??= t;
      if (t - this.stillSince < STILL_TIME) return undefined;
      const result: LiftMeasurement = {
        originHeight: lift.originHeight,
        originReach: lift.originReach,
        destinationHeight: m.handHeight,
        travel: rise,
        maxTwist: lift.maxTwist,
        maxTrunkBend: lift.maxTrunkBend,
        minVisibility: lift.minVisibility,
        calibrated: this.isCalibrated(),
        view: this.view,
        reachSource: m.reachSource,
        floorSource: lift.floorEstimated ? "estimated" : "feet",
        lowPickup: lift.originHeight < lift.originKnee,
        durationMs: t - lift.startT,
        originImage: lift.originImage,
        geometry: lift.originGeometry,
        trail: lift.trail,
      };
      this.lastTrail = lift.trail;
      this.phase = "STANDING";
      this.lift = null;
      this.cooldownUntil = t + COOLDOWN;
      return result;
    }
    this.stillSince = null;
    return undefined;
  }

  private abandon(): undefined {
    this.phase = "STANDING";
    this.lift = null;
    this.notReachingSince = null;
    return undefined;
  }

  private isCalibrated() {
    return this.calibrationFrames >= CALIBRATION_FRAMES;
  }

  /** Nudge the image and world scales toward the worker's entered height. */
  private calibrate(targetCmPerUnit: number, world: PoseFrame["worldLandmarks"]) {
    const targetWorld = (this.workerHeightCm * NOSE_TO_STATURE) / Math.max(worldNoseHeight(world) * 100, 50);
    if (this.calibrationFrames === 0 || this.cmPerUnit === null) {
      this.cmPerUnit = targetCmPerUnit;
      this.worldScale = targetWorld;
    } else {
      this.cmPerUnit += 0.1 * (targetCmPerUnit - this.cmPerUnit);
      this.worldScale += 0.1 * (targetWorld - this.worldScale);
    }
    this.calibrationFrames++;
  }
}
