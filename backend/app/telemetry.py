"""POST /telemetry and GET /zones: zone-level aggregates for the manager view.

The server receives numbers only: a zone ID, the lift's Lifting Index, risk
bucket, NIOSH multipliers, the code-verified fix chosen for it, and (optionally)
environmental readings for the room. Unknown fields are rejected outright, so
landmarks, images or person/device IDs cannot be sent even by mistake. The
server stamps a coarse one-hour time window instead of keeping exact
timestamps.

Lift statistics for a zone stay hidden until at least k lifts have
contributed, so no single lift can be singled out. Environmental readings are
about the room, not about a person, so their hazards and fixes are always shown.

Storage is in memory (fine for a demo; restart clears it).
"""

from collections import Counter
from datetime import datetime, timezone
from threading import Lock
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .environment import LIFT_NEEDS, Environment, Hazard, hazards

router = APIRouter()

Risk = Literal["green", "yellow", "red"]
Factor = Literal["HM", "VM", "DM", "AM", "FM", "CM"]


class Fix(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(max_length=40)
    label: str = Field(max_length=200)
    li_after: float = Field(ge=0, le=100)
    reduction_pct: float = Field(ge=0, le=100)
    effort: Literal["low", "medium", "high"]


class TelemetryIn(BaseModel):
    """A completed lift (li, risk, dominant, multipliers, fix), an environment update, or both."""

    model_config = ConfigDict(extra="forbid")
    zone_id: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9-]+$")
    li: float | None = Field(default=None, ge=0, le=100)
    risk: Risk | None = None
    dominant: Factor | None = None
    multipliers: dict[Factor, float] | None = None
    fix: Fix | None = None
    environment: Environment | None = None

    @model_validator(mode="after")
    def lift_or_environment(self):
        lift = [self.li, self.risk, self.dominant, self.multipliers]
        if any(v is not None for v in lift) and any(v is None for v in lift):
            raise ValueError("a lift needs li, risk, dominant and multipliers together")
        if self.li is None and self.environment is None:
            raise ValueError("send a lift, an environment reading, or both")
        return self


class TelemetryAck(BaseModel):
    zone_id: str
    time_window: str
    lift_count: int


class FixStat(BaseModel):
    id: str
    kind: Literal["lift", "environment"] = "lift"
    label: str
    times_recommended: int
    avg_reduction_pct: float | None = None
    avg_li_after: float | None = None
    effort: str


class EnvironmentStatus(BaseModel):
    reading: Environment
    hazards: list[Hazard]
    time_window: str


class ZoneStats(BaseModel):
    zone_id: str
    lift_count: int
    k_threshold: int
    hidden: bool
    avg_li: float | None = None
    max_li: float | None = None
    risk_counts: dict[str, int] | None = None
    dominant_counts: dict[str, int] | None = None
    top_fixes: list[FixStat] | None = None
    time_windows: list[str] | None = None
    environment: EnvironmentStatus | None = None
    # What the facility should do, as short phrases: lift fix (only once visible) + environmental fixes.
    needs: list[str] = Field(default_factory=list)


_records: dict[str, list[dict]] = {}
_environment: dict[str, dict] = {}
_env_fix_counts: dict[str, Counter] = {}
_lock = Lock()


def _window(now: datetime) -> str:
    return now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00Z")


@router.post("/telemetry", response_model=TelemetryAck)
def post_telemetry(body: TelemetryIn) -> TelemetryAck:
    window = _window(datetime.now(timezone.utc))
    with _lock:
        if body.li is not None:
            record = body.model_dump(exclude={"environment"})
            record["time_window"] = window
            _records.setdefault(body.zone_id, []).append(record)
        if body.environment is not None:
            _environment[body.zone_id] = {"reading": body.environment, "time_window": window}
            counts = _env_fix_counts.setdefault(body.zone_id, Counter())
            for h in hazards(body.environment):
                counts[h.fix_id] += 1
        count = len(_records.get(body.zone_id, []))
    return TelemetryAck(zone_id=body.zone_id, time_window=window, lift_count=count)


def _zone_stats(zone_id: str, records: list[dict], env: dict | None, env_counts: Counter, k: int) -> ZoneStats:
    count = len(records)
    env_status = None
    env_needs: list[str] = []
    env_fixes: list[FixStat] = []
    if env:
        found = hazards(env["reading"])
        env_status = EnvironmentStatus(reading=env["reading"], hazards=found, time_window=env["time_window"])
        env_needs = [h.need for h in found]
        env_fixes = [
            FixStat(id=h.fix_id, kind="environment", label=h.fix_label, times_recommended=env_counts[h.fix_id], effort="medium")
            for h in found
        ]

    if count < k:
        return ZoneStats(zone_id=zone_id, lift_count=count, k_threshold=k, hidden=True, environment=env_status, needs=env_needs)

    lis = [r["li"] for r in records]
    fixes: dict[str, list[dict]] = {}
    for r in records:
        if r.get("fix"):
            fixes.setdefault(r["fix"]["id"], []).append(r["fix"])
    lift_fixes = sorted(
        (
            FixStat(
                id=fix_id,
                label=items[-1]["label"],
                times_recommended=len(items),
                avg_reduction_pct=round(sum(f["reduction_pct"] for f in items) / len(items), 1),
                avg_li_after=round(sum(f["li_after"] for f in items) / len(items), 2),
                effort=items[-1]["effort"],
            )
            for fix_id, items in fixes.items()
        ),
        key=lambda f: (-f.times_recommended, -(f.avg_reduction_pct or 0)),
    )[:3]
    needs = ([LIFT_NEEDS[lift_fixes[0].id]] if lift_fixes and lift_fixes[0].id in LIFT_NEEDS else []) + env_needs
    return ZoneStats(
        zone_id=zone_id,
        lift_count=count,
        k_threshold=k,
        hidden=False,
        avg_li=round(sum(lis) / count, 2),
        max_li=round(max(lis), 2),
        risk_counts={level: sum(1 for r in records if r["risk"] == level) for level in ("green", "yellow", "red")},
        # Only lifts above the limit say anything about what needs fixing.
        dominant_counts=dict(Counter(r["dominant"] for r in records if r["risk"] != "green").most_common()),
        top_fixes=lift_fixes + env_fixes,
        time_windows=sorted({r["time_window"] for r in records}),
        environment=env_status,
        needs=needs,
    )


@router.get("/zones", response_model=list[ZoneStats])
def get_zones(k: int = Query(3, ge=1, le=50)) -> list[ZoneStats]:
    with _lock:
        zones = sorted(set(_records) | set(_environment))
        snapshot = [
            (zone, list(_records.get(zone, [])), _environment.get(zone), Counter(_env_fix_counts.get(zone, Counter())))
            for zone in zones
        ]
    return [_zone_stats(zone, records, env, counts, k) for zone, records, env, counts in snapshot]


@router.post("/zones/reset")
def reset_zones() -> dict[str, str]:
    """Demo helper: clear all aggregates."""
    with _lock:
        _records.clear()
        _environment.clear()
        _env_fix_counts.clear()
    return {"status": "cleared"}
