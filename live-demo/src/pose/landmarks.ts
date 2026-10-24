/** MediaPipe Pose landmark indices (33-point BlazePose topology). */
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_PINKY: 17,
  R_PINKY: 18,
  L_INDEX: 19,
  R_INDEX: 20,
  L_THUMB: 21,
  R_THUMB: 22,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
  L_HEEL: 29,
  R_HEEL: 30,
  L_FOOT: 31,
  R_FOOT: 32,
} as const;

/** Joints the lifting analysis depends on, drawn larger and labelled. */
export const KEY_JOINTS: ReadonlyArray<{ index: number; label: string }> = [
  { index: LM.L_SHOULDER, label: "shoulder" },
  { index: LM.R_SHOULDER, label: "shoulder" },
  { index: LM.L_WRIST, label: "wrist" },
  { index: LM.R_WRIST, label: "wrist" },
  { index: LM.L_HIP, label: "hip" },
  { index: LM.R_HIP, label: "hip" },
  { index: LM.L_KNEE, label: "knee" },
  { index: LM.R_KNEE, label: "knee" },
  { index: LM.L_ANKLE, label: "ankle" },
  { index: LM.R_ANKLE, label: "ankle" },
];

/** Landmarks whose visibility decides whether a lift measurement is trustworthy. */
export const REQUIRED_FOR_LIFT = [
  LM.L_WRIST,
  LM.R_WRIST,
  LM.L_HIP,
  LM.R_HIP,
  LM.L_KNEE,
  LM.R_KNEE,
  LM.L_ANKLE,
  LM.R_ANKLE,
] as const;
