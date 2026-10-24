import { useState, useSyncExternalStore, type ReactNode } from "react";
import { getSent, subscribeSent, type SentRequest } from "../api";
import { fmtBytes, fmtTime } from "../ui";

/** Bytes of image or video data inside a request body (data URIs or long base64 blobs). */
export function mediaBytes(body: string): number {
  let total = 0;
  for (const m of body.matchAll(/data:(?:image|video)\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)) total += m[0].length;
  for (const m of body.matchAll(/"[A-Za-z0-9+/=]{2000,}"/g)) total += m[0].length;
  return total;
}

/** Proof panel: every request body that left the browser, verbatim. */
export default function ServerPanel() {
  const sent = useSyncExternalStore(subscribeSent, getSent);
  const [open, setOpen] = useState<number | null>(null);
  const videoBytes = sent.reduce((n, r) => n + mediaBytes(r.body), 0);
  const totalBytes = sent.reduce((n, r) => n + r.bytes, 0);
  const expanded = open ?? sent[0]?.id ?? null;

  return (
    <section className="panel server">
      <header className="panel-head">
        <h2>What the server sees</h2>
        <span className="tag">every outgoing request, verbatim</span>
      </header>
      <div className="server-stats">
        <div className="stat good">
          <div className="stat-value">{fmtBytes(videoBytes)}</div>
          <div className="stat-label">Video bytes sent</div>
        </div>
        <div className="stat">
          <div className="stat-value">{fmtBytes(totalBytes)}</div>
          <div className="stat-label">
            Numbers-only JSON · {sent.length} request{sent.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      {sent.length === 0 ? (
        <p className="empty">Nothing has been sent yet. Requests appear here the moment they leave the browser.</p>
      ) : (
        <ul className="requests">
          {sent.slice(0, 12).map((r) => (
            <RequestRow key={r.id} r={r} expanded={expanded === r.id} onToggle={() => setOpen(expanded === r.id ? -1 : r.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestRow({ r, expanded, onToggle }: { r: SentRequest; expanded: boolean; onToggle: () => void }) {
  return (
    <li className={expanded ? "open" : undefined}>
      <button className="req-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="method">{r.method}</span>
        <span className="path">{r.path}</span>
        <span className="muted">{fmtBytes(r.bytes)}</span>
        <span className="muted">{fmtTime(r.at)}</span>
      </button>
      {expanded &&
        (r.body ? <pre className="json">{highlight(r.body)}</pre> : <p className="json muted">No body: query parameters only.</p>)}
    </li>
  );
}

/** Tiny JSON syntax highlighter that renders React nodes (no innerHTML). */
function highlight(body: string): ReactNode[] {
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // show raw
  }
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let last = 0;
  let key = 0;
  for (const m of pretty.matchAll(re)) {
    if (m.index! > last) out.push(pretty.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(<span key={key++} className="j-key">{m[1]}</span>, m[2]);
    } else if (m[1]) {
      out.push(<span key={key++} className="j-str">{m[1]}</span>);
    } else if (m[3]) {
      out.push(<span key={key++} className="j-num">{m[3]}</span>);
    } else {
      out.push(<span key={key++} className="j-lit">{m[4]}</span>);
    }
    last = m.index! + m[0].length;
  }
  out.push(pretty.slice(last));
  return out;
}
