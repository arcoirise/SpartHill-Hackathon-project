"""EdgeSense demo API: ephemeral pose relay and persisted zone aggregates."""
import asyncio
import hmac
import json
import os
import sqlite3
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .models import Aggregate, PoseUpdate, Zone
from .recommend import aclose_client
from .recommend import router as recommend_router
from .telemetry import router as telemetry_router

POSE_TTL = 3.0
MAX_BODY = 32768
MAX_LIVE_ZONES = 100
ALERT_FIELDS = ("posture_alert_episodes", "heat_alert_episodes", "noise_alert_episodes", "air_quality_alert_episodes")


def create_app(db_path=None, api_key=None, retention_days=None):
    database = str(db_path or os.getenv("EDGESENSE_DB_PATH", "data/edgesense.sqlite3"))
    key = api_key if api_key is not None else os.getenv("EDGESENSE_API_KEY", "")
    days = int(retention_days if retention_days is not None else os.getenv("EDGESENSE_RETENTION_DAYS", "7"))
    if not 1 <= days <= 365:
        raise ValueError("Retention must be between 1 and 365 days")
    poses = {}

    def purge():
        now = time.monotonic()
        for zone in list(poses):
            if poses[zone][0] <= now:
                del poses[zone]
        with app.state.db:
            app.state.db.execute("DELETE FROM aggregates WHERE created_at < ?", (time.time() - days * 86400,))

    async def cleanup():
        while True:
            purge()
            await asyncio.sleep(1)

    @asynccontextmanager
    async def lifespan(app):
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(database)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS aggregates (batch_id TEXT PRIMARY KEY, zone_id TEXT NOT NULL, window_start TEXT NOT NULL, created_at REAL NOT NULL, payload TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS aggregates_window ON aggregates(window_start, zone_id)")
        db.commit()
        app.state.db = db
        task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            poses.clear()
            db.close()
            await aclose_client()

    app = FastAPI(title="EdgeSense API", version="0.2.0", lifespan=lifespan,
                  description="Demo API. No video upload. Live skeletons are sensitive, ephemeral data, not anonymous records.")
    app.add_middleware(CORSMiddleware, allow_origins=[v.strip() for v in os.getenv("EDGESENSE_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173").split(",") if v.strip()], allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "X-API-Key"])

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # Bound actual streamed bytes, even without Content-Length.
        if request.method in ("POST", "PUT", "PATCH"):
            if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                return JSONResponse({"detail": "Only application/json is accepted"}, status_code=415)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY:
                    return JSONResponse({"detail": "Payload exceeds 32 KiB"}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_payload(request, exc):
        # Do not reflect input bodies, unknown field names, or camera data.
        return JSONResponse({"detail": "Payload does not match the API schema; see /docs"}, status_code=422)

    async def authorized(x_api_key: str | None = Header(default=None)):
        if key and not hmac.compare_digest(key.encode(), (x_api_key or "").encode()):
            raise HTTPException(401, "Valid X-API-Key required")

    auth = [Depends(authorized)]

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": "0.2.0"}

    @app.post("/api/v1/pose", dependencies=auth, status_code=202)
    async def put_pose(payload: PoseUpdate):
        purge()
        if not payload.landmarks:
            poses.pop(payload.zone_id, None)
            return {"accepted": True, "expires_in_seconds": 0}
        if payload.zone_id not in poses and len(poses) >= MAX_LIVE_ZONES:
            raise HTTPException(429, "Live zone capacity reached")
        poses[payload.zone_id] = (time.monotonic() + POSE_TTL, {**payload.model_dump(), "received_at": datetime.now(timezone.utc).isoformat()})
        return {"accepted": True, "expires_in_seconds": POSE_TTL}

    @app.get("/api/v1/pose/{zone_id}", dependencies=auth)
    async def get_pose(zone_id: Zone):
        purge()
        if zone_id not in poses:
            return Response(status_code=204)
        return poses[zone_id][1]

    @app.delete("/api/v1/pose/{zone_id}", dependencies=auth, status_code=204)
    async def clear_pose(zone_id: Zone):
        poses.pop(zone_id, None)
        return Response(status_code=204)

    @app.post("/api/v1/aggregates", dependencies=auth)
    async def ingest(payload: Aggregate):
        purge()
        if payload.window_start.timestamp() < time.time() - days * 86400:
            raise HTTPException(422, "Window is outside the retention period")
        encoded = payload.model_dump_json()
        batch_id = str(payload.batch_id)
        existing = app.state.db.execute("SELECT payload FROM aggregates WHERE batch_id=?", (batch_id,)).fetchone()
        if existing:
            if existing[0] != encoded:
                raise HTTPException(409, "batch_id already exists with a different payload")
            return {"accepted": True, "duplicate": True, "batch_id": batch_id}
        with app.state.db:
            app.state.db.execute("INSERT INTO aggregates VALUES (?, ?, ?, ?, ?)", (batch_id, payload.zone_id, payload.window_start.isoformat(), time.time(), encoded))
        return JSONResponse({"accepted": True, "duplicate": False, "batch_id": batch_id}, status_code=201)

    @app.get("/api/v1/dashboard", dependencies=auth)
    async def dashboard(zone_id: Zone | None = None, hours: int = Query(24, ge=1, le=168)):
        purge()
        since = datetime.fromtimestamp(time.time() - hours * 3600, timezone.utc).isoformat()
        query = "SELECT payload FROM aggregates WHERE window_start >= ?"
        params = [since]
        if zone_id:
            query += " AND zone_id = ?"
            params.append(zone_id)
        zones, hourly = {}, {}
        for (raw,) in app.state.db.execute(query, params):
            p = json.loads(raw)
            z = zones.setdefault(p["zone_id"], {"zone_id": p["zone_id"], "batches": 0, "valid_observation_seconds": 0, **dict.fromkeys(ALERT_FIELDS, 0), "environment_sources": set()})
            z["batches"] += 1
            z["valid_observation_seconds"] += p["valid_observation_seconds"]
            z["environment_sources"].add(p["environment"]["source"])
            h = hourly.setdefault(p["window_start"][:13] + ":00:00+00:00", dict.fromkeys(ALERT_FIELDS, 0))
            for field in ALERT_FIELDS:
                z[field] += p[field]
                h[field] += p[field]
        recommendations = []
        messages = {
            "posture_alert_episodes": "Assess lifting-assist equipment and workstation layout.",
            "heat_alert_episodes": "Review cooling, ventilation and the facility heat-safety plan.",
            "noise_alert_episodes": "Assess noise sources and engineering controls.",
            "air_quality_alert_episodes": "Review ventilation and verify readings with calibrated sensors.",
        }
        for z in zones.values():
            z["environment_sources"] = sorted(z["environment_sources"])
            for field, message in messages.items():
                if z[field]:
                    recommendations.append({"zone_id": z["zone_id"], "category": field, "alert_episodes": z[field], "message": message, "source": "rule_based"})
        return {"hours": hours, "zones": sorted(zones.values(), key=lambda z: z["zone_id"]), "hourly": [{"hour": h, **v} for h, v in sorted(hourly.items())], "recommendations": recommendations, "notice": "Demo coaching signals, not a medical assessment. Counts depend on observation coverage. Simulated telemetry is not a measured hazard."}

    # Live demo (live-demo/ Vite app): NIOSH telemetry, zone stats and LLM workstation suggestions.
    app.include_router(recommend_router)
    app.include_router(telemetry_router)

    return app


app = create_app()
