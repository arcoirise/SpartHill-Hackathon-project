import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

// Served from public/ (populated by scripts/fetch-mediapipe.mjs on npm install),
// so nothing is fetched from the internet at runtime.
const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;

export type Delegate = "GPU" | "CPU";

/** "accurate" = heavy pose model + EfficientDet-Lite2; "fast" = full pose model + Lite0. */
export type Quality = "accurate" | "fast";

const POSE_MODEL: Record<Quality, string> = {
  accurate: `${import.meta.env.BASE_URL}mediapipe/pose_landmarker_heavy.task`,
  fast: `${import.meta.env.BASE_URL}mediapipe/pose_landmarker_full.task`,
};

/** Creates a single-person video-mode PoseLandmarker, preferring the GPU. */
export async function createPoseLandmarker(quality: Quality): Promise<{
  landmarker: PoseLandmarker;
  delegate: Delegate;
}> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      const landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL[quality], delegate },
        runningMode: "VIDEO",
        numPoses: 1,
        // Slightly stricter than the 0.5 defaults: fewer phantom skeletons on background clutter.
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      return { landmarker, delegate };
    } catch (err) {
      if (delegate === "CPU") throw err;
      console.warn("[pose] GPU delegate unavailable, falling back to CPU", err);
    }
  }
  throw new Error("unreachable");
}
