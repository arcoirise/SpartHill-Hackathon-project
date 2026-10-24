import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import type { Quality } from "./landmarker";

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL: Record<Quality, string> = {
  accurate: `${import.meta.env.BASE_URL}mediapipe/efficientdet_lite2.tflite`,
  fast: `${import.meta.env.BASE_URL}mediapipe/efficientdet_lite0.tflite`,
};

/**
 * COCO-trained EfficientDet (Google, via MediaPipe). It knows 80 everyday
 * classes (chair, suitcase, backpack, bottle…). Plain cardboard boxes are not
 * a COCO class, so we keep the threshold low and pick the detection closest
 * to the hands instead of trusting the label.
 */
export async function createObjectDetector(quality: Quality): Promise<ObjectDetector> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = {
    runningMode: "VIDEO" as const,
    // Keep up to 30 low-confidence detections, including covered or edge-on objects;
    // pickHeldObject filters them by hand contact and size.
    scoreThreshold: 0.04,
    maxResults: 30,
  };
  try {
    return await ObjectDetector.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL[quality], delegate: "GPU" },
    });
  } catch (err) {
    console.warn("[object] GPU delegate unavailable, falling back to CPU", err);
    return ObjectDetector.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL[quality], delegate: "CPU" },
    });
  }
}
