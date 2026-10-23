# EdgeSense

A privacy-first tool which detects accidents before they happen. Pose analysis
runs on the edge; only anonymized landmarks and risk scores are transmitted.

## Structure

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js / React dashboard |
| `backend/` | Python FastAPI service |
| `edgesense/` | Shared MediaPipe logic and telemetry data models |
| `.github/workflows/` | CI/CD pipelines |
| `.openai/` | Agent system prompts and LLM configuration |

## Quick start

Run `./start-edgesense.sh` (macOS/Linux) or `start-edgesense.bat` (Windows).

- Frontend: http://localhost:3000
- Backend: http://localhost:8000 (docs at `/docs`)
