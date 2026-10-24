import type { GripIssue } from "./api";
import type { GripAssessment } from "./pose/objectTracker";

export interface RecommendationExplanation {
  summary: string;
  signals: string[];
  limitation: string;
  source: string;
}

export const hasGripEvidence = (grip: GripAssessment | null): boolean =>
  grip?.evidence?.visibleWrists === 2;

/** Derive a human-readable posture summary from the structured GripIssue fields. */
function postureSummary(issue: GripIssue): string {
  if (issue.detail?.startsWith("Low pickup")) {
    return "A low-pickup-point rule triggered the current recommendation: load origin was below knee height.";
  }
  if (issue.detail?.startsWith("Deep forward bend")) {
    return "A deep-forward-bend rule triggered the current recommendation.";
  }
  if (issue.lift_posture === "stoop") {
    return "A stoop-lift rule triggered the current recommendation: back bent with knees nearly straight.";
  }
  return "A posture rule triggered the current recommendation; its specific trigger is unavailable.";
}

/**
 * All evidence comes from local on-device rules only.
 * No LLM reasoning is quoted or paraphrased here; only structured detection
 * signals and threshold values from the classifier are shown.
 */
export function explainRecommendation(
  grip: GripAssessment | null,
  issue: GripIssue | null,
  source?: "llm" | "fallback",
): RecommendationExplanation {
  const origin = source === "llm"
    ? "Detection: on-device rules. Wording: model-generated, using server-checked suggestion IDs."
    : "Detection: on-device rules. Wording: built-in template; no live model answer is being shown.";
  const limitation = "Camera estimates cannot confirm contact, grip force, load balance or whether a technique is safe. Object labels and body positions may be wrong.";

  if (grip && !hasGripEvidence(grip)) {
    return {
      summary: "Hand visibility is insufficient to explain a reliable grip recommendation.",
      signals: ["Both wrists must be visible before specific hand-placement advice is shown."],
      limitation,
      source: "Evidence check: on-device rules. No specific grip advice is shown for this observation.",
    };
  }
  if (!issue) {
    return {
      summary: "No current recommendation to explain.",
      signals: [grip?.status === "proper"
        ? "The grip classifier did not flag an upper or uneven grip in this observation. This does not establish safety."
        : "Waiting for a visible person and a supported grip or posture observation."],
      limitation,
      source: "No recommendation has been selected for the current observation.",
    };
  }
  if (issue.status === "posture") {
    const postureSignals: string[] = [];
    if (issue.detail) {
      postureSignals.push(issue.detail);
    } else {
      postureSignals.push("A posture category was reported; detailed measurements are unavailable.");
    }
    postureSignals.push("Posture alerts remain visible for up to three seconds after the triggering observation.");
    return {
      summary: postureSummary(issue),
      signals: postureSignals,
      limitation: "Trunk and knee angles, pickup height and floor position are camera estimates. " +
        "Trunk and knee angles use model-estimated 3D landmarks from a single camera; depth and rotation errors can affect these estimates. " +
        "This is a screening signal, not a measurement of injury risk.",
      source: origin,
    };
  }
  const e = grip?.evidence;
  if (!e || grip?.status !== issue.status) {
    return {
      summary: "The recommendation has no matching current grip evidence.",
      signals: ["Waiting for a matching observation; previous detection details are not reused."],
      limitation,
      source: "No matching evidence is available.",
    };
  }
  const signals: string[] = ["The object detector and pose model supplied an estimated object box and hand positions."];
  if (issue.status === "wrong_top" && e.relativeGripHeight !== null) {
    signals.push(
      `Estimated grip height: ${e.relativeGripHeight.toFixed(2)} of the object box height from its top; ` +
      `the upper-grip rule triggers below 0.38.`,
    );
  }
  if (issue.status === "wrong_uneven") {
    if (e.wristsNearObject < 2) {
      signals.push(
        `Only ${e.wristsNearObject} of 2 estimated wrist positions were within the rule's proximity threshold of the object box.`,
      );
    }
    if (e.wristHeightDifference !== null && e.wristHeightDifference > 0.38) {
      signals.push(
        `Estimated wrist-height difference: ${e.wristHeightDifference.toFixed(2)} of the object box height, above the 0.38 threshold.`,
      );
    }
  }
  return {
    summary: issue.status === "wrong_top"
      ? "Estimated hand positions triggered the upper-grip rule. This is why a lower-support suggestion was selected."
      : "Estimated hand positions triggered the uneven-grip rule. This is why a two-hand support suggestion was selected.",
    signals,
    limitation,
    source: origin,
  };
}
