# EdgeSense

A workplace safety coaching prototype. Camera processing belongs on the edge.
The demo API relays sensitive skeletal landmarks temporarily and stores only
zone-level safety summaries; skeletal landmarks are not inherently anonymous.

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

## Backend integration

See [backend setup and API contract](backend/README.md) and the
[TypeScript client example](backend/examples/edgesense-client.ts).
The browser pose integration and dashboard are implemented separately by the frontend team.
