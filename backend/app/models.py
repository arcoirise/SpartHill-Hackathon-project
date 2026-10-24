"""Public API contract. Camera frames and worker identifiers are never accepted."""
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Zone = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,40}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Landmark(StrictModel):
    x: float = Field(ge=-10, le=10)
    y: float = Field(ge=-10, le=10)
    z: float = Field(ge=-100, le=100)
    visibility: float = Field(ge=0, le=1)


class PoseUpdate(StrictModel):
    zone_id: Zone
    # MediaPipe Pose emits exactly 33 landmarks; [] means no person detected.
    landmarks: list[Landmark] = Field(max_length=33)

    @field_validator("landmarks")
    @classmethod
    def complete_pose(cls, value):
        if len(value) not in (0, 33):
            raise ValueError("Expected zero or 33 MediaPipe landmarks")
        return value


class Environment(StrictModel):
    source: Literal["simulated", "sensor"]
    temperature_max_c: float = Field(ge=-50, le=100)
    noise_max_db: float = Field(ge=0, le=180)
    air_quality_max_aqi: int = Field(ge=0, le=500)


class Aggregate(StrictModel):
    # Reuse this UUID when retrying the same submission.
    batch_id: UUID
    zone_id: Zone
    window_start: datetime
    window_seconds: int = Field(ge=1, le=3600)
    valid_observation_seconds: float = Field(ge=0, le=3600)
    posture_alert_episodes: int = Field(ge=0, le=10000)
    heat_alert_episodes: int = Field(ge=0, le=10000)
    noise_alert_episodes: int = Field(ge=0, le=10000)
    air_quality_alert_episodes: int = Field(ge=0, le=10000)
    environment: Environment

    @field_validator("window_start")
    @classmethod
    def aware_time(cls, value):
        if value.tzinfo is None:
            raise ValueError("Include a UTC offset or Z")
        value = value.astimezone(timezone.utc)
        if value.timestamp() > datetime.now(timezone.utc).timestamp() + 60:
            raise ValueError("Window cannot start in the future")
        return value

    @field_validator("valid_observation_seconds")
    @classmethod
    def coverage_within_window(cls, value, info):
        if value > info.data.get("window_seconds", 3600):
            raise ValueError("Observation duration exceeds window")
        return value
