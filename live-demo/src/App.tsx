import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getSent,
  requestRecommendation,
  sendTelemetry,
  subscribeSent,
  type GripAdvice,
  type GripIssue,
  type Pick,
  type Recommendation,
} from "./api";
import CameraView, { type CameraStats } from "./components/CameraView";
import { POSTURE_COLORS, type Overlay } from "./components/draw";
import { mediaBytes } from "./components/ServerPanel";
import ServerView from "./components/ServerView";
import type { Environment } from "./env/hazards";
import { LiftDetector, type LiftSnapshot } from "./lift/liftDetector";
import type { LiftPosture } from "./lift/measure";
import { typicalWeight } from "./lift/presets";
import { MULTIPLIER_INFO, computeNiosh, type Coupling, type LiftTask, type NioshResult } from "./niosh/niosh";
import { buildOptions, type RedesignOption } from "./niosh/options";
import type { Quality } from "./pose/landmarker";
import type { GripAssessment } from "./pose/objectTracker";
import type { PoseFrame } from "./pose/types";
import type { Landmark } from "@mediapipe/tasks-vision";
import { RISK_COLOR, ZONES, fmtBytes, fmtLi } from "./ui";

const QUALITY_KEY = "edgesense.quality";
const ZONE_ID = ZONES[0].id;
// Simulated sensors stay fixed at normal readings.
const ROOM_ENV: Environment = { temperatureC: 24, decibels: 65, aqi: 35 };

function loadQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "fast" ? "fast" : "accurate";
  } catch {
    return "accurate";
  }
}

const DEEP_BEND = 35;
const MODERATE_BEND = 20;
/** How long a posture alert stays up after the deep bend ends, so people can read it. */
const POSTURE_ALERT_MS = 3000;
/** A new grip/posture issue must hold this long before the AI is asked, so jitter at a threshold doesn't spam it. */
const ADVICE_DEBOUNCE_MS = 400;

type Posture = "safe" | "moderate" | "deep";
type PostureKind = "stoop" | "low_pickup" | "deep_bend";
interface PostureAlert {
  kind: PostureKind;
  text: string;
  at: number;
}

function postureOf(snap: LiftSnapshot): Posture {
  const bend = snap.measure.trunkBendDeg;
  if ((snap.phase !== "STANDING" && snap.lowPickup) || bend > DEEP_BEND) return "deep";
  if (snap.phase !== "STANDING" || bend > MODERATE_BEND) return "moderate";
  return "safe";
}

/** Coaching for a stoop lift or deep bend, phrased about the task and workstation, never blaming the worker. */
function postureIssue(snap: LiftSnapshot): Omit<PostureAlert, "at"> | null {
  if (snap.phase !== "STANDING" && snap.measure.liftPosture === "stoop") {
    return {
      kind: "stoop",
      text: "Stoop lift detected (back bent with straight knees): bending the knees lets the legs do the lifting; a higher pickup point avoids the bend",
    };
  }
  if (postureOf(snap) !== "deep") return null;
  if (snap.phase !== "STANDING" && snap.lowPickup) {
    return { kind: "low_pickup", text: "Low pickup point: this load starts below knee height" };
  }
  return {
    kind: "deep_bend",
    text: `Deep forward bend (${Math.round(snap.measure.trunkBendDeg)}°): the load sits too low or too far away`,
  };
}

/**
 * The grip/posture issue the AI is asked about: categories and code-written text only, never landmarks.
 * Null when the grip is proper (or absent) and there is no posture alert.
 */
function gripIssueOf(
  grip: GripAssessment | null,
  posture: PostureAlert | null,
  label: string | null,
  liftPosture: LiftPosture | undefined,
): GripIssue | null {
  const bad = grip && grip.status !== "proper" ? grip : null;
  if (!bad && !posture) return null;
  // Clamped to the server's limits, so a long message can never get a lift's request rejected.
  return {
    object_label: (label ?? "load").slice(0, 40),
    status: bad ? bad.status : "posture",
    detail: (bad?.message ?? posture?.text ?? null)?.slice(0, 300) ?? null,
    lift_posture: posture?.kind === "stoop" ? "stoop" : liftPosture,
  };
}

type GripFixId = "grip_seat_base" | "grip_lower_sides" | "grip_even" | "lift_with_legs" | "raise_pickup" | "bring_closer" | "provide_handles";

/** Built-in hand-placement fixes: [label, effort, why]. Same templates as the backend's fallback (backend/app/recommend.py). */
const GRIP_FIXES: Record<GripFixId, (label: string) => [string, Pick["effort"], string]> = {
  grip_seat_base: () => [
    "Grip both sides of the seat base",
    "low",
    "Slide both palms and all five fingers down to the green [ ] brackets under the left and right edges of the seat base (55–75% of the chair's height). The chair's weight then hangs between the hands, close to the torso, so it can't swing or tip.",
  ],
  grip_lower_sides: (label) => [
    `Hold the lower sides of the ${label}`,
    "low",
    `Move both hands down to the green [ ] brackets on the lower sides of the ${label} (55–75% of its height), fingers wrapped underneath, so its weight sits between the hands and close to the torso.`,
  ],
  grip_even: (label) => [
    "Both hands, level, on opposite sides",
    "low",
    `Put one palm on each side of the ${label} at the same height inside the green [ ] brackets, fingers wrapped underneath, so both arms share the weight and the load stays level.`,
  ],
  lift_with_legs: () => [
    "Bend the knees and keep the load close",
    "low",
    "Squat with the load against the body and let the legs straighten to raise it, so the back stays upright instead of working as a crane.",
  ],
  raise_pickup: () => [
    "Raise the pickup point to about 75 cm",
    "medium",
    "A table or shelf at waist height (about 75 cm) removes the deep bend for every lift at this station.",
  ],
  bring_closer: () => [
    "Store the load at the front edge",
    "low",
    "Keep the load at the front of the shelf or platform so it can be lifted close to the body without reaching.",
  ],
  provide_handles: (label) => [
    "Provide handholds or a trolley",
    "medium",
    `Handholds at the base of the ${label}, or a trolley to move it, make the safe grip the easy grip.`,
  ],
};

/**
 * Hand-placement solution written by code, shown the moment an issue is detected and kept when the
 * backend has no answer. Mirrors the backend's fallback: the most direct fix first, two picks.
 */
function fallbackGripAdvice(issue: GripIssue): GripAdvice {
  const label = issue.object_label;
  const grip = issue.status === "wrong_top" ? "top" : issue.status === "wrong_uneven" ? "uneven" : null;
  const posture = issue.lift_posture === "stoop" ? "stoop" : grip ? null : "bend";

  const ids: GripFixId[] = [];
  if (grip === "top") ids.push(label === "chair" ? "grip_seat_base" : "grip_lower_sides");
  if (grip === "uneven") ids.push("grip_even");
  if (posture === "stoop") ids.push("lift_with_legs", "raise_pickup");
  if (posture === "bend") ids.push("raise_pickup", "bring_closer");
  if (grip) ids.push("provide_handles", "lift_with_legs");
  const picks: Pick[] = [...new Set(ids)].slice(0, 2).map((id) => {
    const [title, effort, why] = GRIP_FIXES[id](label);
    return { id, kind: "grip", label: title, li_after: null, reduction_pct: null, effort, why };
  });

  const wrong: string[] = [];
  if (grip === "top" && label === "chair") {
    wrong.push(
      "The fingers are hooked over the upper backrest (the top 38% of the chair), far above its centre of gravity: the chair hangs below the hands on a long lever arm, which adds tipping torque at the wrists and pulls on the lower back.",
    );
  } else if (grip === "top") {
    wrong.push(
      `The hands hold the top edge of the ${label}, far above its centre of gravity, so the load swings below the hands and adds torque at the wrists and lower back.`,
    );
  } else if (grip === "uneven") {
    wrong.push(
      `The ${label} is held by one hand, or the hands sit at very different heights, so the load tilts and one side of the back takes most of the weight.`,
    );
  }
  if (posture === "stoop") {
    wrong.push("The back bends with nearly straight knees (a stoop lift), so the lower back, not the legs, raises the load.");
  } else if (posture === "bend") {
    const detail = (issue.detail ?? "").trim().replace(/\.+$/, "");
    wrong.push(detail ? `${detail}.` : "The load starts low or far away, which forces a deep forward bend.");
  }

  const summary =
    grip === "top"
      ? label === "chair"
        ? "Move the hands from the backrest down to the seat base, where the chair's weight sits."
        : "Move the hands from the top edge down to the lower sides, where the weight sits."
      : grip === "uneven"
        ? "Share the load evenly between both hands."
        : posture === "stoop"
          ? "Let the legs do the lifting, and raise the pickup point so the bend isn't needed."
          : "Bring the load up and closer so it can be lifted without a deep bend.";

  return { source: "fallback", issue: wrong.join(" "), summary, picks, latency_ms: 0 };
}

/** The grip/posture issue on screen, with the key that says when its kind changed. */
interface CurrentIssue {
  issue: GripIssue;
  key: string;
}

/** A hand-placement solution and the issue it was written for. */
interface ShownGripAdvice extends CurrentIssue {
  advice: GripAdvice;
}

/** A load box is guaranteed only during an active bend/lift, never while standing idle. */
function isHoldingLoad(snap: LiftSnapshot): boolean {
  return snap.phase !== "STANDING";
}

export default function App() {
  const [quality, setQuality] = useState<Quality>(loadQuality);
  const [stats, setStats] = useState<CameraStats>({ status: "loading", fps: 0, personDetected: false });
  const [loadKg, setLoadKg] = useState(10);
  const [coupling, setCoupling] = useState<Coupling>("fair");
  const [postureAlert, setPostureAlert] = useState<PostureAlert | null>(null);
  const [gripAssessment, setGripAssessment] = useState<GripAssessment | null>(null);
  const [heldObject, setHeldObject] = useState<string | null>(null);
  const [live, setLive] = useState<LiftSnapshot | null>(null);
  // Latest AI answers: the hand-placement solution for a grip/posture issue, and the redesign for the last scored lift.
  const [gripAdvice, setGripAdvice] = useState<ShownGripAdvice | null>(null);
  const [liftAdvice, setLiftAdvice] = useState<{ rec: Recommendation; result: NioshResult } | null>(null);
  const [adviceStatus, setAdviceStatus] = useState<"idle" | "loading" | "error">("idle");
  const adviceSeq = useRef(0);
  const currentIssue = useRef<CurrentIssue | null>(null);
  // Throttled world landmarks feed the server-view empty state.
  const [poseSample, setPoseSample] = useState<Landmark[] | null>(null);
  const serverCanvas = useRef<HTMLCanvasElement>(null);
  const detector = useRef(new LiftDetector(170));
  const snapshot = useRef<LiftSnapshot | null>(null);
  const lastLiveUpdate = useRef(0);

  // Values read inside the per-frame callbacks; refs keep those callbacks stable.
  const inputs = useRef({ loadKg, coupling });
  inputs.current = { loadKg, coupling };

  const sent = useSyncExternalStore(subscribeSent, getSent);
  const videoBytes = sent.reduce((n, r) => n + mediaBytes(r.body), 0);

  /**
   * Ask /recommend about a scored lift and/or the current grip issue. Only the newest
   * request may replace the shown hand-placement solution; every lift answer is kept.
   * Without a grip answer from the backend (none returned, or the request failed), the
   * built-in solution for the issue is kept instead.
   */
  const askAdvice = useCallback(
    (lift: { result: NioshResult; options: RedesignOption[] } | null, current: CurrentIssue | null) => {
      const seq = ++adviceSeq.current;
      setAdviceStatus("loading");
      const showGrip = (advice: GripAdvice | null | undefined) => {
        if (current && seq === adviceSeq.current) setGripAdvice({ ...current, advice: advice ?? fallbackGripAdvice(current.issue) });
      };
      const request = requestRecommendation(ZONE_ID, lift, ROOM_ENV, current?.issue ?? null);
      request
        .then((rec) => {
          if (lift) setLiftAdvice({ rec, result: lift.result });
          showGrip(rec.grip);
        })
        .then(
          () => seq === adviceSeq.current && setAdviceStatus("idle"),
          () => {
            showGrip(null);
            if (seq === adviceSeq.current) setAdviceStatus("error");
          },
        );
      return request;
    },
    [],
  );

  const onPose = useCallback(
    (frame: PoseFrame) => {
      const { snapshot: snap, completed } = detector.current.update(frame);
      snapshot.current = snap;

      if (completed) {
        const { loadKg: load, coupling: grip } = inputs.current;
        const task: LiftTask = {
          H: completed.originReach,
          V: completed.originHeight,
          D: completed.travel,
          A: completed.maxTwist,
          frequency: 1,
          coupling: grip,
          loadKg: load,
        };

        // AI proposes, code verifies: send numbers (and the grip issue as categories), then report the lift to the zone aggregates.
        const result = computeNiosh(task);
        let fix: Pick | undefined;
        askAdvice({ result, options: buildOptions(task) }, currentIssue.current)
          .then((data) => {
            // A lift within the limit needs no fix, so it doesn't vote for one in the manager view.
            fix = result.risk === "green" ? undefined : data.picks.find((p) => p.kind === "lift");
          })
          .catch(() => {})
          .then(() => sendTelemetry(ZONE_ID, { result, fix }, ROOM_ENV))
          .catch(() => {});
      }
      if (frame.t - lastLiveUpdate.current > 100 || completed) {
        lastLiveUpdate.current = frame.t;
        setLive(snap);
        setPoseSample(frame.worldLandmarks);
        const alert = postureIssue(snap);
        if (alert) setPostureAlert({ ...alert, at: Date.now() });
      }
    },
    [askAdvice],
  );

  const getOverlay = useCallback((): Overlay | undefined => {
    const snap = snapshot.current;
    if (!snap) return undefined;
    return { color: POSTURE_COLORS[postureOf(snap)], holdingLoad: isHoldingLoad(snap) };
  }, []);

  const onObjectLabel = useCallback((label: string | null) => {
    setHeldObject(label);
    const kg = label ? typicalWeight(label) : undefined;
    if (kg !== undefined) setLoadKg(kg);
  }, []);

  // A grip held at the top or one-sided is a poor coupling (NIOSH CM 0.90); a balanced lower grip is good.
  const onGripChange = useCallback((grip: GripAssessment | null) => {
    setGripAssessment(grip);
    if (grip) setCoupling(grip.status === "proper" ? "good" : "poor");
  }, []);

  // Keep a posture alert up for a few seconds after the deep bend ends.
  useEffect(() => {
    if (!postureAlert) return;
    const timer = setTimeout(() => setPostureAlert(null), POSTURE_ALERT_MS);
    return () => clearTimeout(timer);
  }, [postureAlert]);

  const changeQuality = (q: Quality) => {
    setQuality(q);
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      // per-viewer convenience only
    }
  };

  // With the camera running and nobody in view there is nothing to show.
  const serverSample = stats.status === "running" && !stats.personDetected ? null : poseSample;
  const snap = stats.personDetected ? live : null;
  const coachingText = (gripAssessment?.status !== "proper" ? gripAssessment?.message : null) ?? postureAlert?.text ?? null;

  // Ask the AI when the kind of issue changes, not on every frame: the key ignores live numbers like the bend angle.
  const issue = gripIssueOf(gripAssessment, postureAlert, heldObject, snap?.measure.liftPosture);
  const issueKey = issue ? `${issue.status}|${issue.object_label}|${postureAlert?.kind ?? ""}` : "";
  const current = issue && { issue, key: issueKey };
  currentIssue.current = current;
  useEffect(() => {
    if (!issueKey) return;
    const timer = setTimeout(() => {
      if (currentIssue.current) askAdvice(null, currentIssue.current).catch(() => {});
    }, ADVICE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [issueKey, askAdvice]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <h1>EdgeSense</h1>
            <p>No-recording workstation lifting assessment</p>
          </div>
        </div>
        <div className="privacy">
          <span className="pulse" /> Raw video never leaves this device
        </div>
        <div className="topbar-right">
          <div className="video-counter" title="Computed from the actual bodies of every outgoing request">
            <span>Video bytes sent</span>
            <b>{fmtBytes(videoBytes)}</b>
          </div>
          <label className="inline-select">
            Model
            <select value={quality} onChange={(e) => changeQuality(e.target.value as Quality)}>
              <option value="accurate">Accurate (heavy)</option>
              <option value="fast">Fast</option>
            </select>
          </label>
        </div>
      </header>

      <div className="split">
        <section className="panel split-pane">
          <header className="panel-head">
            <h2>What the Worker Sees</h2>
            <span className="tag">local raw video · processed in memory, never stored or sent</span>
          </header>
          <CameraView
            quality={quality}
            replay={null}
            onPose={onPose}
            getOverlay={getOverlay}
            onStats={setStats}
            onObjectLabel={onObjectLabel}
            onGripChange={onGripChange}
            serverCanvasRef={serverCanvas}
          >
            <Hud snap={snap} stats={stats} quality={quality} grip={gripAssessment} coaching={coachingText} />
          </CameraView>
          <p className="hint">
            Stand 2–3 m away, <b>side-on</b> to the camera, whole body in view. Stand still for a second to calibrate, then lift.
          </p>
        </section>
        <ServerView canvasRef={serverCanvas} sample={serverSample} videoBytes={videoBytes} />
      </div>

      <SolutionBar
        grip={gripAssessment}
        posture={postureAlert}
        label={heldObject}
        current={current}
        gripAdvice={gripAdvice}
        liftAdvice={liftAdvice}
        status={adviceStatus}
      />
    </div>
  );
}

const POSTURE_TITLE: Record<PostureKind, string> = {
  stoop: "Stoop lift · back bent, knees straight",
  low_pickup: "Low pickup · load below knee height",
  deep_bend: "Deep forward bend",
};

/** Live headline for the detected grip/posture issue (bad grip first, then posture, then a proper grip). */
function detectedIssue(grip: GripAssessment | null, posture: PostureAlert | null, label: string | null) {
  const object = label ?? "load";
  if (grip?.status === "wrong_top") {
    const where = object === "chair" ? "chair backrest" : `${object} top edge`;
    return { tone: "bad", title: `Wrong finger/hand grip · ${where}`, detail: grip.message };
  }
  if (grip?.status === "wrong_uneven") return { tone: "bad", title: `Uneven hand grip · ${object}`, detail: grip.message };
  if (posture) return { tone: "bad", title: POSTURE_TITLE[posture.kind], detail: posture.text };
  if (grip?.status === "proper") {
    return { tone: "ok", title: `Proper grip ✓ · ${object}`, detail: "Both hands sit low on the sides, close to the load's centre of gravity." };
  }
  return { tone: "idle", title: "No issue detected", detail: "Grab a chair or lift a load: hand placement and posture are checked live." };
}

/** Short name of the issue an AI answer was written for. */
function issueName(issue: GripIssue): string {
  if (issue.status === "posture") return `${issue.lift_posture === "stoop" ? "stoop lift" : "deep bend"} · ${issue.object_label}`;
  return `${issue.status === "wrong_top" ? "top grip" : "uneven grip"} · ${issue.object_label}`;
}

function SourceTag({ source, latency, cached }: { source: "llm" | "fallback"; latency: number; cached?: boolean }) {
  return source === "llm" ? (
    <span className="sol-src ai">AI · {cached ? "cached" : `${latency} ms`}</span>
  ) : (
    <span className="sol-src tpl" title="No LLM answer (no API key, timeout or failed check): built-in template">
      Built-in template
    </span>
  );
}

/**
 * Bottom bar: what is wrong right now (live, from code), the AI's hand-placement solution for the
 * latest grip/posture issue, and the code-verified redesign for the last scored lift.
 */
function SolutionBar({
  grip,
  posture,
  label,
  current,
  gripAdvice,
  liftAdvice,
  status,
}: {
  grip: GripAssessment | null;
  posture: PostureAlert | null;
  label: string | null;
  current: CurrentIssue | null;
  gripAdvice: ShownGripAdvice | null;
  liftAdvice: { rec: Recommendation; result: NioshResult } | null;
  status: "idle" | "loading" | "error";
}) {
  const detected = detectedIssue(grip, posture, label);
  // The answer for the issue on screen; until it arrives, the built-in solution for it right away.
  const shown = current && gripAdvice?.key !== current.key ? { ...current, advice: fallbackGripAdvice(current.issue) } : gripAdvice;
  const advice = shown?.advice;
  const liftPick = liftAdvice?.rec.picks.find((p) => p.kind === "lift");

  return (
    <section className="solution" aria-live="polite">
      <div className={`sol-col sol-issue ${detected.tone}`}>
        <h3>Detected issue</h3>
        <div className="sol-issue-title">
          {detected.tone === "bad" && <span aria-hidden>⚠ </span>}
          {detected.title}
        </div>
        {detected.detail && <p className="sol-text">{detected.detail}</p>}
      </div>

      <div className="sol-col sol-ai">
        <h3>
          AI Ergonomic Solution
          {advice && <SourceTag source={advice.source} latency={advice.latency_ms} cached={advice.cached} />}
          {shown && <span className="sol-for">for: {issueName(shown.issue)}</span>}
          {status === "loading" && <span className="sol-status">asking…</span>}
          {status === "error" && <span className="sol-status err">backend unreachable</span>}
        </h3>
        {advice ? (
          <>
            <p className="sol-text sol-why">
              <b>What's wrong:</b> {advice.issue}
            </p>
            <p className="sol-summary">{advice.summary}</p>
            <ol className="sol-picks">
              {advice.picks.map((p) => (
                <li key={p.id}>
                  <b>{p.label}</b> <span className={`sol-effort ${p.effort}`}>{p.effort} effort</span> — {p.why}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="sol-text muted">
            When a wrong grip or a risky bend is detected, the AI explains what is wrong and where the hands should go.
          </p>
        )}
      </div>

      <div className="sol-col sol-lift">
        <h3>
          Last lift · NIOSH
          {liftAdvice && <SourceTag source={liftAdvice.rec.source} latency={liftAdvice.rec.latency_ms} cached={liftAdvice.rec.cached} />}
        </h3>
        {liftAdvice ? (
          <>
            <div className="sol-li">
              <b style={{ color: RISK_COLOR[liftAdvice.result.risk] }}>LI {fmtLi(liftAdvice.result.li)}</b>
              <span className="muted">dominant: {MULTIPLIER_INFO[liftAdvice.result.dominant].name}</span>
            </div>
            {liftPick ? (
              <p className="sol-text">
                <b>{liftPick.label}</b>
                {liftPick.li_after !== null && (
                  <span className="sol-verified">
                    {" "}
                    → LI {liftPick.li_after.toFixed(1)}
                    {liftPick.reduction_pct !== null && ` (−${Math.round(liftPick.reduction_pct)}%)`}
                  </span>
                )}{" "}
                — {liftPick.why}
              </p>
            ) : (
              <p className="sol-text">{liftAdvice.rec.summary}</p>
            )}
          </>
        ) : (
          <p className="sol-text muted">No lift scored yet. Lift a load from low to waist height to get a code-verified redesign.</p>
        )}
      </div>
    </section>
  );
}

function Hud({
  snap,
  stats,
  quality,
  grip,
  coaching,
}: {
  snap: LiftSnapshot | null;
  stats: CameraStats;
  quality: Quality;
  grip: GripAssessment | null;
  coaching: string | null;
}) {
  const phase = snap?.phase ?? "STANDING";
  const phaseText =
    phase === "LIFTING" ? "Lifting" : phase === "REACHING_DOWN" ? (snap?.lowPickup ? "Low pickup · below knees" : "Reaching") : "Ready";
  const phaseClass = phase === "LIFTING" ? "lifting" : phase === "REACHING_DOWN" ? (snap?.lowPickup ? "low" : "reach") : "ready";
  const running = stats.status === "running";

  return (
    <>
      {running && snap && (
        <div className="hud hud-tl">
          <span className={`phase phase-${phaseClass}`}>
            <span className="dot" /> {phaseText}
          </span>
          {grip && (
            <span className={`grip ${grip.status === "proper" ? "ok" : "bad"}`}>{grip.status === "proper" ? "✓" : "⚠"} {grip.badge}</span>
          )}
        </div>
      )}
      {running && snap && (
        <div className="hud hud-tr">
          <Check ok={snap.tracked} label="Body tracked" bad="Show shoulders & hips" />
          <span className={`check ${snap.feetVisible ? "ok" : "info"}`}>{snap.feetVisible ? "✓ Feet in view" : "~ Floor estimated"}</span>
          <Check ok={snap.view === "side"} label="Side view" bad="Turn side-on" />
          <Check ok={snap.calibrated} label="Calibrated" bad="Stand upright…" />
        </div>
      )}
      {running && coaching && (
        <div className="hud hud-bl">
          <div className="hud-coach" role="status" aria-live="polite">
            <span className="hud-coach-icon" aria-hidden>⚠</span>
            <span className="hud-coach-text">{coaching}</span>
          </div>
        </div>
      )}
      {running && (
        <div className="hud hud-br">
          {`${quality === "accurate" ? "Heavy" : "Full"} model · ${stats.delegate} · ${stats.fps} fps`}
        </div>
      )}
      {running && !stats.personDetected && (
        <div className="hud hud-center">Step into view: whole body, side-on, 2–3 m from the camera</div>
      )}
    </>
  );
}

function Check({ ok, label, bad }: { ok: boolean; label: string; bad: string }) {
  return <span className={`check ${ok ? "ok" : "bad"}`}>{ok ? `✓ ${label}` : `! ${bad}`}</span>;
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg)" opacity="0.18" />
      <circle cx="16" cy="8.5" r="2.6" fill="none" stroke="url(#lg)" strokeWidth="2" />
      <path d="M16 11.5 L16 19 M10 14 L16 13 L22 14 M16 19 L12 26 M16 19 L20 26" stroke="url(#lg)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
