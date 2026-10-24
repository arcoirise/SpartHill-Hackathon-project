import { computeNiosh, liRange } from "../niosh/niosh";
import { RISK_COLOR, RISK_TEXT, fmtLi, type LiftRecord } from "../ui";
import Gauge from "./Gauge";

const LOW_VISIBILITY = 0.5;

/** The headline number: Lifting Index of the last lift, with its uncertainty and caveats. */
export default function ScoreCard({ record, onDiscard }: { record?: LiftRecord; onDiscard: () => void }) {
  if (!record) {
    return (
      <section className="panel score">
        <header className="panel-head">
          <h2>Lifting Index</h2>
        </header>
        <Gauge />
        <p className="empty">
          Waiting for the first lift.
          <br />
          Lift something from the floor or a table, or press <b>Replay</b> below.
        </p>
      </section>
    );
  }

  const { task, measurement: m } = record;
  const result = computeNiosh(task);
  const range = liRange(task);
  const color = RISK_COLOR[result.risk];
  const notes: string[] = [];
  if (m.minVisibility < LOW_VISIBILITY) notes.push("Some joints were hidden during this lift. Keep the whole body in view.");
  if (!m.calibrated) notes.push("Height calibration had not finished. Stand upright for a second before lifting.");
  if (m.view !== "side") notes.push("Camera was not side-on, so reach is a 3D estimate. Side-on is most accurate.");
  if (m.floorSource === "estimated") notes.push("Feet were out of view, so the floor was estimated from body proportions (a few cm less precise).");

  return (
    <section className="panel score" style={{ ["--risk" as string]: color }}>
      <header className="panel-head">
        <h2>Lifting Index</h2>
        <span className="tag">{record.source === "replay" ? "Replay" : "Live"} · lift #{record.id}</span>
      </header>
      <Gauge li={result.li} low={range.low} high={range.high} />
      <div className="score-main">
        <div className="score-value" style={{ color }}>
          {fmtLi(result.li)}
        </div>
        <div>
          <div className="score-risk" style={{ color }}>
            {RISK_TEXT[result.risk]}
          </div>
          <div className="score-range">
            likely {fmtLi(range.low)}–{fmtLi(range.high)} (single-camera estimate)
          </div>
        </div>
      </div>
      <div className="score-facts">
        <span>
          Limit <b>{result.rwl.toFixed(1)} kg</b>
        </span>
        <span>
          Load <b>{task.loadKg} kg</b>
        </span>
        <span>
          V <b>{Math.round(task.V)} cm</b>
        </span>
        <span>
          H <b>{Math.round(task.H)} cm</b>
        </span>
        <span>
          D <b>{Math.round(task.D)} cm</b>
        </span>
        <span>
          A <b>{Math.round(task.A)}°</b>
        </span>
      </div>
      <div className="score-foot">
        <span className="muted">
          {m.reachSource === "2d" ? "Side view · 2D, calibrated to height" : "3D estimate"}
        </span>
        <button className="link" onClick={onDiscard} title="Remove this lift, e.g. if it was putting a load down">
          Not a lift? Discard
        </button>
      </div>
      {notes.map((n) => (
        <p key={n} className="warn">
          {n}
        </p>
      ))}
    </section>
  );
}
