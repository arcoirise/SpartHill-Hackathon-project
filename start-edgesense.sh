#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

(cd "$ROOT/backend" && pip install -r requirements.txt && python3 -m uvicorn app.main:app --reload --port 8000) &
BACKEND_PID=$!
(cd "$ROOT/frontend" && npm install && npm run dev) &
FRONTEND_PID=$!

trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null' INT TERM EXIT
wait
