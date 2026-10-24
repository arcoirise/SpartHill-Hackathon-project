// Puts the MediaPipe WASM runtime and pose model under public/ so the app
// runs fully offline at demo time (no CDN or venue Wi-Fi needed).
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDest = join(root, "public", "mediapipe", "wasm");
const models = [
  {
    name: "Pose model",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    dest: join(root, "public", "mediapipe", "pose_landmarker_full.task"),
  },
  {
    // Most accurate pose model (~31 MB), used in "Accurate" mode.
    name: "Pose model (heavy)",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
    dest: join(root, "public", "mediapipe", "pose_landmarker_heavy.task"),
  },
  {
    // COCO-trained detector (EfficientDet-Lite0, ~7 MB); used to box the object being lifted in "Fast" mode.
    name: "Object model",
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite",
    dest: join(root, "public", "mediapipe", "efficientdet_lite0.tflite"),
  },
  {
    // Larger, more accurate COCO detector (EfficientDet-Lite2, ~12 MB), used in "Accurate" mode.
    name: "Object model (Lite2)",
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite",
    dest: join(root, "public", "mediapipe", "efficientdet_lite2.tflite"),
  },
];

cpSync(wasmSrc, wasmDest, { recursive: true });
console.log("[mediapipe] WASM copied to public/mediapipe/wasm");

if (process.env.SKIP_MEDIAPIPE_MODELS) {
  console.log("[mediapipe] SKIP_MEDIAPIPE_MODELS set, not downloading models");
  process.exit(0);
}

for (const { name, url, dest } of models) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[mediapipe] ${name} already present`);
    continue;
  }
  console.log(`[mediapipe] Downloading ${name}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} download failed: ${res.status} ${res.statusText}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[mediapipe] ${name} saved`);
}
