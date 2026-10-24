# EdgeSense

**The first workplace safety system where workers own the data, and the workplace takes the blame.**

EdgeSense is a no-recording workstation assessment tool. A camera points at a
workstation for a limited assessment period. Pose estimation runs in the
browser, every lift is scored with the Revised NIOSH Lifting Equation, and an
AI agent picks the workstation redesign that cuts the risk most for the effort.
Raw video and pose landmarks never leave the device.

## What leaves the browser

Only numbers, and every request body is shown verbatim in the app's
**What the server sees** panel next to a live "Video bytes sent: 0" counter.

| Request | Contents |
| --- | --- |
| `POST /recommend` | zone ID, Lifting Index, risk level, NIOSH multipliers, code-computed redesign options |
| `POST /telemetry` | zone ID, Lifting Index, risk level, multipliers, the chosen fix (the server rejects any other field) |
| `GET /zones?k=3` | nothing but the privacy threshold `k` |

Never sent: video frames, images, pose landmarks, names, worker or device IDs,
exact timestamps (the server keeps a one-hour window). The worker's personal
lift record stays in their browser (SHA-256 hash chain) and only they can
export it.

## How it works

1. **Sees (edge AI):** MediaPipe Pose Landmarker (heavy or full model) runs in
   the browser. Frames are processed in memory and discarded. A COCO object
   detector (EfficientDet) boxes the object being lifted, for display only.
2. **Measures (deterministic code):** One Euro filtering, a lift state machine
   (standing → reaching → lifting → complete, from the floor *or* a table), and
   height-calibrated measurement of H, V, D and twist. With a side-on camera, H
   and V are measured in the 2D image and scaled using the worker's height,
   which avoids MediaPipe's noisy depth estimate.
3. **Reasons (AI agent):** code computes the Lifting Index and several what-if
   redesigns. The LLM only chooses among them and explains why, with no
   numbers in its text. The server verifies its answer against the options and
   falls back to a built-in template if the LLM is unavailable.
4. **Explains:** the UI shows every multiplier, the dominant problem, the
   suggested fix with predicted LI, and draws the suggested 75 cm platform
   into the live view.

## Structure

| Path | Purpose |
| --- | --- |
| `frontend/` | Vite + React + TypeScript app (camera, pose, NIOSH maths, all panels) |
| `frontend/src/niosh/` | NIOSH equation and redesign options (pure functions, unit-tested) |
| `frontend/src/lift/` | One Euro filter, measurement, lift detector, replay clips |
| `frontend/src/session/` | Worker's device-only hash-chained lift record |
| `backend/` | FastAPI: `/recommend`, `/telemetry`, `/zones` (in-memory) |
| `.openai/` | LLM system prompt and model config |
| `.github/workflows/` | CI: tests and build |

## Run it (Windows / PowerShell)

Requires Node 20+ and Python 3.11+.

```powershell
# Backend (window 1)
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# Frontend (window 2)
cd frontend
npm install        # also downloads the MediaPipe models (~60 MB) into public/mediapipe
npm run dev
```

Open http://localhost:3000 in Chrome, click **Start camera**, allow the camera,
stand 2–3 m away side-on with your whole body in view, then lift something.
No camera? Use the **Replay** buttons: they run recorded landmarks through the
same pipeline. Or just run `start-edgesense.bat` / `./start-edgesense.sh`.

**LLM (optional):** copy `backend/.env.example` to `backend/.env` and set
`OPENAI_API_KEY` (any OpenAI-compatible endpoint works via `OPENAI_BASE_URL`,
for example IBM watsonx). Without a key the app uses a built-in template.

## Tests

```powershell
cd frontend; npm test            # NIOSH maths, lift detection, filters, hash chain
cd backend;  pip install -r requirements-dev.txt; python -m pytest -q
```

## Known limitations

- Single 2D camera: distances and twist angles are estimates (a screening
  tool, not a measurement instrument). The Lifting Index is shown as a range.
- Load weight is entered manually (a typical weight is suggested for
  recognised objects); the frequency multiplier is simplified to 1 lift/min.
- NIOSH applies to two-handed standing lifts only, not carrying, pushing or
  one-handed lifts. Setting a load down onto the floor can register as a lift;
  the app has a "Not a lift? Discard" button.
- Skeleton data could in theory help re-identify people; this is why it never
  leaves the device and zone statistics stay hidden below `k` lifts.
- Not a medical or legal tool. The personal record is a record, not a
  guarantee of any claim outcome.
- The "synthetic" replay clips are generated test data, not recordings.

## Built with

MediaPipe Tasks Vision (Google), React, Vite, FastAPI. Development was
assisted by Claude Code (Anthropic). Add any other tools the team used (for
example IBM Bob) here.
