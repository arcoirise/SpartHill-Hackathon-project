import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";

/**
 * One pose sample: the only thing downstream code (lift detection, NIOSH,
 * replay recording) ever sees. Contains landmarks only — never pixels.
 */
export interface PoseFrame {
  /** performance.now() timestamp in ms. */
  t: number;
  /** Image-space landmarks, x/y normalized to [0, 1]. */
  landmarks: NormalizedLandmark[];
  /** Metric landmarks in meters, origin at the hip midpoint. */
  worldLandmarks: Landmark[];
  /** Video width / height, needed to compare x and y distances in the image. */
  aspect: number;
}
