import pytest
from fastapi.testclient import TestClient

from app import recommend, telemetry
from app.main import app

client = TestClient(app)

OPTIONS = [
    {"id": "platform_close", "label": "75 cm platform close to the worker", "effort": "medium", "fixes": "VM", "li_after": 1.25, "reduction_pct": 45},
    {"id": "raise_pickup", "label": "Raise the pickup point", "effort": "medium", "fixes": "VM", "li_after": 1.6, "reduction_pct": 28},
    {"id": "add_handles", "label": "Add handles", "effort": "low", "fixes": "CM", "li_after": 2.2, "reduction_pct": 5},
]
MULTS = {"HM": 0.64, "VM": 0.81, "DM": 0.88, "AM": 0.94, "FM": 0.94, "CM": 0.95}


def rec_body(**over):
    body = {"zone_id": "zone-a", "li": 2.28, "risk": "red", "dominant": "HM", "multipliers": MULTS, "options": OPTIONS}
    body.update(over)
    return body


HOT = {"temperature_c": 34, "decibels": 65, "aqi": 35}
NORMAL = {"temperature_c": 24, "decibels": 65, "aqi": 35}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    recommend._cache.clear()
    client.post("/zones/reset")
    yield


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_recommend_falls_back_without_key():
    res = client.post("/recommend", json=rec_body()).json()
    assert res["source"] == "fallback"
    assert [p["id"] for p in res["picks"]] == ["platform_close", "raise_pickup"]
    assert res["picks"][0]["li_after"] == 1.25


def test_fallback_weighs_reduction_against_effort():
    options = [
        {"id": "split_load", "label": "Split the load", "effort": "high", "fixes": "FM", "li_after": 1.2, "reduction_pct": 48},
        *OPTIONS,
    ]
    res = client.post("/recommend", json=rec_body(options=options)).json()
    assert res["picks"][0]["id"] == "platform_close"


def test_green_lift_gets_at_most_one_optional_pick():
    res = client.post("/recommend", json=rec_body(li=0.98, risk="green")).json()
    assert len(res["picks"]) == 1
    assert "no change is required" in res["summary"]


def test_llm_answer_is_verified(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    async def fake(req):
        return {
            "chosen": [
                {"id": "made_up", "why": "Invented option."},
                {"id": "raise_pickup", "why": "This cuts risk by 90%."},  # digits are not allowed
            ],
            "summary": "Fix the pickup height.",
        }

    monkeypatch.setattr(recommend, "_ask_llm", fake)
    res = client.post("/recommend", json=rec_body()).json()
    assert res["source"] == "llm"
    assert [p["id"] for p in res["picks"]] == ["raise_pickup"]
    assert res["picks"][0]["li_after"] == 1.6  # number from the request, not the LLM
    assert "90" not in res["picks"][0]["why"]


def test_llm_failure_falls_back(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    async def boom(req):
        raise TimeoutError

    monkeypatch.setattr(recommend, "_ask_llm", boom)
    res = client.post("/recommend", json=rec_body()).json()
    assert res["source"] == "fallback"
    assert "TimeoutError" in res["note"]


def test_llm_answers_are_cached_and_reverified(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    calls = []

    async def fake(req):
        calls.append(req)
        return {"chosen": [{"id": "platform_close", "why": "Brings the load to waist height."}], "summary": "Raise it."}

    monkeypatch.setattr(recommend, "_ask_llm", fake)
    first = client.post("/recommend", json=rec_body()).json()
    changed = [dict(OPTIONS[0], li_after=1.1, reduction_pct=50), *OPTIONS[1:]]
    second = client.post("/recommend", json=rec_body(li=2.2, options=changed)).json()
    assert len(calls) == 1
    assert first["cached"] is False and second["cached"] is True
    assert second["picks"][0]["li_after"] == 1.1


def test_telemetry_rejects_landmarks_and_unknown_fields():
    body = {"zone_id": "zone-a", "li": 2.1, "risk": "red", "dominant": "HM", "multipliers": MULTS}
    assert client.post("/telemetry", json=body).status_code == 200
    assert client.post("/telemetry", json={**body, "landmarks": [[0.1, 0.2]]}).status_code == 422
    assert client.post("/telemetry", json={**body, "worker_id": "w1"}).status_code == 422


def test_zones_hidden_below_k_and_aggregated_at_k():
    fix = {"id": "platform_close", "label": "75 cm platform", "li_after": 1.2, "reduction_pct": 45, "effort": "medium"}
    for li, risk in [(2.3, "red"), (1.4, "yellow")]:
        client.post("/telemetry", json={"zone_id": "zone-a", "li": li, "risk": risk, "dominant": "HM", "multipliers": MULTS, "fix": fix})

    hidden = client.get("/zones?k=3").json()[0]
    assert hidden == {**hidden, "zone_id": "zone-a", "lift_count": 2, "hidden": True, "avg_li": None}

    client.post("/telemetry", json={"zone_id": "zone-a", "li": 0.9, "risk": "green", "dominant": "VM", "multipliers": MULTS})
    shown = client.get("/zones?k=3").json()[0]
    assert shown["hidden"] is False
    assert shown["lift_count"] == 3
    assert shown["avg_li"] == pytest.approx(1.53, abs=0.01)
    assert shown["max_li"] == 2.3
    assert shown["risk_counts"] == {"green": 1, "yellow": 1, "red": 1}
    assert shown["top_fixes"][0]["id"] == "platform_close"
    assert shown["top_fixes"][0]["times_recommended"] == 2


def test_heat_adds_cooling_fix_and_combined_summary():
    res = client.post("/recommend", json=rec_body(environment=HOT)).json()
    kinds = [p["kind"] for p in res["picks"]]
    assert kinds == ["lift", "lift", "environment"]
    env_pick = res["picks"][-1]
    assert env_pick["id"] == "cooling_ventilation"
    assert env_pick["li_after"] is None
    assert res["needs"] == ["a 75 cm lifting assist table", "cooling ventilation"]
    assert "a 75 cm lifting assist table and cooling ventilation" in res["summary"]


def test_normal_environment_adds_nothing():
    res = client.post("/recommend", json=rec_body(environment=NORMAL)).json()
    assert all(p["kind"] == "lift" for p in res["picks"])
    assert res["hazards"] == []


def test_environment_only_recommendation_without_a_lift():
    res = client.post("/recommend", json={"zone_id": "zone-b", "environment": {"temperature_c": 31, "decibels": 90, "aqi": 120}}).json()
    assert [p["id"] for p in res["picks"]] == ["cooling_ventilation", "acoustic_damping", "air_filtration"]
    assert res["summary"] == "This zone needs cooling ventilation, acoustic damping and air filtration."


def test_environment_telemetry_is_shown_below_k_and_never_counts_as_a_lift():
    ack = client.post("/telemetry", json={"zone_id": "zone-b", "environment": HOT}).json()
    assert ack["lift_count"] == 0
    zone = client.get("/zones?k=3").json()[0]
    assert zone["hidden"] is True and zone["lift_count"] == 0
    assert zone["environment"]["hazards"][0]["id"] == "heat"
    assert zone["needs"] == ["cooling ventilation"]


def test_visible_zone_lists_lift_and_environment_fixes():
    fix = {"id": "platform_close", "label": "75 cm platform", "li_after": 1.2, "reduction_pct": 45, "effort": "medium"}
    for _ in range(3):
        client.post("/telemetry", json={"zone_id": "zone-b", "li": 2.3, "risk": "red", "dominant": "HM", "multipliers": MULTS, "fix": fix, "environment": HOT})
    zone = client.get("/zones?k=3").json()[0]
    assert zone["hidden"] is False
    assert [f["id"] for f in zone["top_fixes"]] == ["platform_close", "cooling_ventilation"]
    assert zone["needs"] == ["a 75 cm lifting assist table", "cooling ventilation"]


def test_telemetry_rejects_half_a_lift():
    assert client.post("/telemetry", json={"zone_id": "zone-a", "li": 2.1}).status_code == 422
    assert client.post("/telemetry", json={"zone_id": "zone-a"}).status_code == 422
