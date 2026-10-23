from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class Landmark(BaseModel):
    x: float
    y: float
    z: float = 0.0
    visibility: float = 1.0


class PoseFrame(BaseModel):
    """Anonymized pose landmarks for one frame. No raw imagery is retained."""

    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    landmarks: list[Landmark] = Field(default_factory=list)


class TelemetryEvent(BaseModel):
    device_id: str
    risk: RiskLevel = RiskLevel.LOW
    score: float = Field(0.0, ge=0.0, le=1.0)
    frame: PoseFrame | None = None
