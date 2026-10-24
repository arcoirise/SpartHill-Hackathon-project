import type { RefObject } from "react";
import type { Landmark } from "@mediapipe/tasks-vision";
import { fmtBytes } from "../ui";

interface Props {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Latest world landmarks (metres, hip-centred), throttled for display; null when nobody is in view. */
  sample: Landmark[] | null;
  videoBytes: number;
}

/** Right half of the split view: the anonymized stick figure and numbers, never any video. */
export default function ServerView({ canvasRef, sample, videoBytes }: Props) {
  return (
    <section className="panel split-pane server-view">
      <header className="panel-head">
        <h2>What the Server Sees</h2>
        <span className="tag">anonymized X, Y, Z stick-figure · zero facial or video data</span>
      </header>
      <div className="wire">
        <canvas ref={canvasRef} width={1280} height={720} />
        {!sample && <div className="wire-empty">Waiting for a skeleton…</div>}
        <div className="wire-bytes">
          Video bytes sent <b>{fmtBytes(videoBytes)}</b>
        </div>
      </div>
      <p className="hint">
        Requests carry only lift scores, redesign options and room readings — no images. Raw video never leaves this device.
      </p>
    </section>
  );
}
