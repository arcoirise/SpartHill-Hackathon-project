"""Environmental hazards (simulated sensors in the demo) and facility fixes.

Readings are numbers about the room, not about any person. Thresholds are
kept in sync with frontend/src/env/hazards.ts.
"""

from pydantic import BaseModel, ConfigDict, Field


class Environment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    temperature_c: float = Field(ge=-40, le=70)
    decibels: float = Field(ge=0, le=160)
    aqi: float = Field(ge=0, le=1000)


class Hazard(BaseModel):
    id: str
    label: str
    reading: str
    fix_id: str
    fix_label: str
    need: str


# (id, field, threshold, unit, label, fix id, fix label, short "needs" phrase)
_RULES = [
    ("heat", "temperature_c", 30, "°C", "High room temperature", "cooling_ventilation",
     "Add cooling ventilation at this workstation", "cooling ventilation"),
    ("noise", "decibels", 85, "dB", "High noise level", "acoustic_damping",
     "Add acoustic damping and provide hearing protection", "acoustic damping"),
    ("air", "aqi", 100, "AQI", "Poor air quality", "air_filtration",
     "Add air filtration and fresh-air ventilation", "air filtration"),
]


def hazards(env: Environment | None) -> list[Hazard]:
    if env is None:
        return []
    found = []
    for hid, field, threshold, unit, label, fix_id, fix_label, need in _RULES:
        value = getattr(env, field)
        if value >= threshold:
            reading = f"{value:g} {unit}"
            found.append(Hazard(id=hid, label=label, reading=reading, fix_id=fix_id, fix_label=fix_label, need=need))
    return found


# Short phrases for lift redesigns, used in "This zone needs ..." sentences.
LIFT_NEEDS = {
    "platform_close": "a 75 cm lifting assist table",
    "raise_pickup": "a raised pickup point at about 75 cm",
    "bring_closer": "shallower shelving so loads sit closer",
    "remove_twist": "a layout that removes twisting",
    "add_handles": "loads with handles",
    "shorten_travel": "a lift table to cut vertical travel",
    "split_load": "smaller load units",
}


def join_needs(needs: list[str]) -> str:
    if len(needs) <= 1:
        return "".join(needs)
    return ", ".join(needs[:-1]) + " and " + needs[-1]
