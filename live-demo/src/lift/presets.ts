/**
 * Typical weights (kg) for objects the COCO detector recognises. Only a
 * starting point for the "Box weight" field; the worker can always overwrite it.
 */
export const TYPICAL_WEIGHT_KG: Record<string, number> = {
  chair: 6,
  backpack: 6,
  suitcase: 10,
  handbag: 4,
  bottle: 2,
  book: 2,
  laptop: 3,
  "potted plant": 8,
  vase: 4,
  "tv": 10,
  microwave: 12,
  oven: 25,
  refrigerator: 60,
  bench: 15,
  "dining table": 20,
  couch: 40,
  "sports ball": 1,
  // Display labels of held objects (see HELD_LABELS in pose/objectTracker.ts) and their COCO names.
  phone: 0.2,
  "cell phone": 0.2,
  remote: 0.2,
  bag: 4,
  box: 8,
  cup: 0.5,
  container: 2,
  bowl: 1,
  equipment: 3,
  tool: 1,
  load: 8,
  item: 2,
};

export function typicalWeight(label: string): number | undefined {
  return TYPICAL_WEIGHT_KG[label.toLowerCase()];
}
