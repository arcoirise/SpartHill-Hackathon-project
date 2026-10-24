# Public deployment

The Docker image builds the Next.js website and embedded Vite demo, downloads
MediaPipe models at build time, and runs FastAPI on loopback port 8001 with Next.js
on the hosting platform's PORT (default 10000). Only health, recommend, telemetry
and zones are proxied publicly; administrative reset and legacy skeleton APIs
are not published. Use one replica: current live assessment statistics are in memory.

Render: create a Docker web service from this repository and deployment branch,
or use render.yaml. Railway: deploy the repository using this Dockerfile, expose
PORT=10000, and use /live-api/health for health checks.

Do not supply an LLM key to an unrestricted public demo without adding a usage
budget and request controls. Without a key, the app explicitly uses built-in
recommendation templates. Statistics are shared demo data, not private per-user
records; do not use the public demo for real employee assessments. In-memory
statistics and SQLite on ephemeral hosting are not durable across redeploys.

Add edgesense.org to the hosting provider first, then copy its exact DNS target
to Cloudflare. Preserve unrelated email and verification records. Verify HTTPS
before testing camera access. Do not point the domain at 127.0.0.1.

Docker execution has not been validated locally when Docker is unavailable;
verify the provider's image build and /live-api/health before changing DNS.
