import sqlite3
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "test.sqlite3", api_key="")) as c:
        yield c


def aggregate(**changes):
    return {"batch_id": str(uuid4()), "zone_id": "zone-b", "window_start": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(), "window_seconds": 60, "valid_observation_seconds": 50, "posture_alert_episodes": 2, "heat_alert_episodes": 1, "noise_alert_episodes": 0, "air_quality_alert_episodes": 0, "environment": {"source": "simulated", "temperature_max_c": 33, "noise_max_db": 70, "air_quality_max_aqi": 20}, **changes}


def pose():
    return {"zone_id": "zone-b", "landmarks": [{"x": .5, "y": .4, "z": -.1, "visibility": .9}] * 33}


def test_pose_relay_expiry_and_no_database_storage(client, monkeypatch):
    assert client.post("/api/v1/pose", json=pose()).status_code == 202
    response = client.get("/api/v1/pose/zone-b")
    assert response.json()["landmarks"] == pose()["landmarks"]
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/v1/dashboard").json()["zones"] == []
    import app.main as main
    monkeypatch.setattr(main, "POSE_TTL", 0)
    client.post("/api/v1/pose", json=pose())
    assert client.get("/api/v1/pose/zone-b").status_code == 204


def test_clear_and_loss_of_detection(client):
    client.post("/api/v1/pose", json=pose())
    client.post("/api/v1/pose", json={"zone_id": "zone-b", "landmarks": []})
    assert client.get("/api/v1/pose/zone-b").status_code == 204
    client.post("/api/v1/pose", json=pose())
    assert client.delete("/api/v1/pose/zone-b").status_code == 204
    assert client.get("/api/v1/pose/zone-b").status_code == 204


@pytest.mark.parametrize("extra", [{"video": "private-frame"}, {"device_id": "worker-1"}, {"image": "data:image/png;base64,secret"}])
def test_reject_unapproved_data_without_echo(client, extra):
    r = client.post("/api/v1/pose", json={**pose(), **extra})
    assert r.status_code == 422
    assert all(value not in r.text for value in extra.values())
    assert client.post("/api/v1/aggregates", json={**aggregate(), **extra}).status_code == 422


def test_size_and_media_guards(client):
    assert client.post("/api/v1/pose", content=b"x" * 33000, headers={"Content-Type": "application/json"}).status_code == 413
    assert client.post("/api/v1/pose", files={"video": ("v.mp4", b"video")}).status_code == 415
    assert client.post("/api/v1/pose", content="broken", headers={"Content-Type": "application/json"}).status_code == 422


def test_invalid_landmarks_and_ranges(client):
    p = pose()
    p["landmarks"] = p["landmarks"][:2]
    assert client.post("/api/v1/pose", json=p).status_code == 422
    assert client.post("/api/v1/aggregates", json=aggregate(valid_observation_seconds=61)).status_code == 422
    assert client.post("/api/v1/aggregates", json=aggregate(window_start="2026-01-01T00:00:00")).status_code == 422
    p = pose()
    p["landmarks"][0]["visibility"] = 2
    assert client.post("/api/v1/pose", json=p).status_code == 422


def test_idempotency_dashboard_and_zone_filter(client):
    p = aggregate()
    assert client.post("/api/v1/aggregates", json=p).status_code == 201
    assert client.post("/api/v1/aggregates", json=p).json()["duplicate"]
    assert client.post("/api/v1/aggregates", json={**p, "posture_alert_episodes": 3}).status_code == 409
    d = client.get("/api/v1/dashboard").json()
    assert d["zones"][0]["posture_alert_episodes"] == 2
    assert d["zones"][0]["valid_observation_seconds"] == 50
    assert d["zones"][0]["environment_sources"] == ["simulated"]
    assert len(d["recommendations"]) == 2
    assert client.get("/api/v1/dashboard?zone_id=zone-c").json()["zones"] == []
    assert client.get("/api/v1/dashboard?hours=0").status_code == 422


def test_auth_and_cors(tmp_path):
    with TestClient(create_app(tmp_path / "auth.db", api_key="secret")) as c:
        assert c.get("/health").status_code == 200
        assert c.get("/api/v1/dashboard").status_code == 401
        assert c.post("/api/v1/pose", json=pose()).status_code == 401
        assert c.delete("/api/v1/pose/zone-b").status_code == 401
        assert c.get("/api/v1/dashboard", headers={"X-API-Key": "secret"}).status_code == 200
        r = c.options("/api/v1/pose", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-API-Key,Content-Type"})
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
        r = c.options("/api/v1/pose", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
        assert r.status_code == 400


def test_persistence_and_retention(tmp_path):
    path = tmp_path / "persistent.db"
    with TestClient(create_app(path, api_key="")) as c:
        c.post("/api/v1/aggregates", json=aggregate())
        c.post("/api/v1/pose", json=pose())
    with TestClient(create_app(path, api_key="")) as c:
        assert c.get("/api/v1/dashboard").json()["zones"][0]["batches"] == 1
        assert c.get("/api/v1/pose/zone-b").status_code == 204
        with sqlite3.connect(path) as db:
            db.execute("UPDATE aggregates SET created_at=?", (time.time() - 8 * 86400,))
        assert c.get("/api/v1/dashboard").json()["zones"] == []


def test_nested_privacy_fields_and_nonfinite_values(client):
    p = pose()
    p["landmarks"][0]["image"] = "secret-frame"
    r = client.post("/api/v1/pose", json=p)
    assert r.status_code == 422 and "secret-frame" not in r.text
    p = aggregate()
    p["environment"]["employee_name"] = "private-name"
    assert client.post("/api/v1/aggregates", json=p).status_code == 422
    import json
    p = pose()
    p["landmarks"][0]["x"] = float("nan")
    assert client.post("/api/v1/pose", content=json.dumps(p), headers={"Content-Type": "application/json"}).status_code == 422


def test_openapi_contract(client):
    schema = client.get("/openapi.json").json()
    assert "/api/v1/pose/{zone_id}" in schema["paths"]
    assert schema["components"]["schemas"]["Landmark"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["Aggregate"]["additionalProperties"] is False
