import { MULTIPLIER_INFO, computeNiosh, type LiftTask, type MultiplierKey } from "../niosh/niosh";
import { RISK_COLOR, fmtLi, type LiftRecord } from "../ui";

const ORDER: MultiplierKey[] = ["HM", "VM", "DM", "AM", "FM", "CM"];

function measured(key: MultiplierKey, t: LiftTask): string {
  switch (key) {
    case "HM":
      return `H ${Math.round(t.H)} cm`;
    case "VM":
      return `V ${Math.round(t.V)} cm`;
    case "DM":
      return `D ${Math.round(t.D)} cm`;
    case "AM":
      return `A ${Math.round(t.A)}°`;
    case "FM":
      return `${t.frequency} / min`;
    case "CM":
      return `${t.coupling} grip`;
  }
}

function formula(key: MultiplierKey, t: LiftTask): string {
  switch (key) {
    case "HM":
      return t.H <= 25 ? "H ≤ 25 → 1" : `25 / ${Math.round(t.H)}`;
    case "VM":
      return `1 − 0.003 × |${Math.round(t.V)} − 75|`;
    case "DM":
      return t.D <= 25 ? "D ≤ 25 → 1" : `0.82 + 4.5 / ${Math.round(t.D)}`;
    case "AM":
      return `1 − 0.0032 × ${Math.round(t.A)}`;
    case "FM":
      return "NIOSH table, ≤ 1 h";
    case "CM":
      return "good 1 · fair .95 · poor .90";
  }
}

const barColor = (m: number) => (m >= 0.9 ? RISK_COLOR.green : m >= 0.75 ? RISK_COLOR.yellow : RISK_COLOR.red);

/** RWL = 23 kg × HM × VM × DM × AM × FM × CM, every factor shown with its measured input. */
export default function MultiplierBars({ record, history }: { record?: LiftRecord; history: LiftRecord[] }) {
  const result = record ? computeNiosh(record.task) : null;
  return (
    <section className="panel breakdown">
      <header className="panel-head">
        <h2>Why this score</h2>
        <span className="tag mono">RWL = 23 kg × HM × VM × DM × AM × FM × CM</span>
      </header>
      {!record || !result ? (
        <p className="empty">Each NIOSH factor and its measured input will appear here after a lift.</p>
      ) : (
        <div className="bars">
          {ORDER.map((key) => {
            const value = result.multipliers[key];
            const dominant = key === result.dominant && result.risk !== "green";
            return (
              <div key={key} className={`bar-row${dominant ? " dominant" : ""}`}>
                <div className="bar-name">
                  <b>{key}</b> {MULTIPLIER_INFO[key].name}
                  {dominant && <span className="flag">Biggest issue</span>}
                </div>
                <div className="bar-measured">{measured(key, record.task)}</div>
                <div className="bar-track" title={formula(key, record.task)}>
                  <div className="bar-fill" style={{ width: `${Math.max(2, value * 100)}%`, background: barColor(value) }} />
                </div>
                <div className="bar-value">{value.toFixed(2)}</div>
              </div>
            );
          })}
          {result.risk === "green" ? (
            <p className="why">
              <b>Within the recommended limit.</b> No factor needs fixing at this workstation.
            </p>
          ) : (
            <p className="why">
              <b>Workstation problem:</b> {MULTIPLIER_INFO[result.dominant].problem}
            </p>
          )}
        </div>
      )}
      {history.length > 1 && (
        <div className="history">
          <span className="muted">Recent lifts</span>
          {history.slice(0, 8).map((l) => {
            const r = computeNiosh(l.task);
            return (
              <span key={l.id} className="chip" style={{ borderColor: RISK_COLOR[r.risk], color: RISK_COLOR[r.risk] }}>
                #{l.id} LI {fmtLi(r.li)}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
