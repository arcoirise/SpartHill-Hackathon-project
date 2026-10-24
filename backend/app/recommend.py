"""POST /recommend: pick and explain workstation redesigns.

"AI proposes, code verifies": the client computes every number (LI, multipliers,
what-if options) with the NIOSH equation. The LLM only chooses among the
supplied option ids and writes plain-language reasons, with no numbers in its
text; the UI shows the code-computed numbers next to it. Anything the LLM
returns is checked against the supplied options. If there is no API key, the
call fails, or it takes too long, a deterministic template answer is returned
so the demo never shows a blank panel.

Environmental readings (simulated sensors in the demo) add facility fixes such
as cooling ventilation. These come from fixed thresholds in code, not from the LLM.

Grip and posture issues flagged on the device (hands on a chair backrest, a
one-sided grip, a stoop lift) arrive as categories only. Code describes what is
wrong and lists the candidate fixes; the LLM picks among them and explains where
the hands should go, under the same verification and fallback rules.

The LLM only ever receives numbers and categories: no images, no landmarks, no person IDs.
"""

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from .environment import LIFT_NEEDS, Environment, Hazard, hazards, join_needs

router = APIRouter()

ROOT = Path(__file__).resolve().parents[2]
LLM_TIMEOUT_S = 6.0
CACHE_MAX = 256


def _load_dotenv() -> None:
    """Minimal .env reader (backend/.env) so the key stays on the server."""
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _llm_config() -> dict:
    cfg_path = ROOT / ".openai" / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    cfg["model"] = os.environ.get("LLM_MODEL", cfg.get("model", "gpt-4o"))
    return cfg


def _system_prompt() -> str:
    path = ROOT / ".openai" / "system-prompt.md"
    base = path.read_text(encoding="utf-8") if path.exists() else ""
    return (
        base
        + "\n\nTASK: A lift was just scored with the NIOSH Lifting Equation. You get the Lifting Index, "
        "the multipliers, the dominant problem, and a list of candidate workstation redesigns that were "
        "already recomputed by code (li_after, reduction_pct).\n"
        "Rules:\n"
        "- Choose 1 or 2 option ids from the list, weighing risk reduction against effort.\n"
        "- If risk is green, say the lift is within the recommended limit and no change is required; choose at most 1 optional improvement.\n"
        "- Talk about the workstation, never the worker. Never say the person's posture or technique is wrong.\n"
        "- Do not write any numbers or digits. The interface shows the verified numbers next to your text.\n"
        "- Calm, plain language, at most 2 short sentences per reason.\n"
        "- Environmental readings, if present, are handled separately by the system; only choose among the lift options.\n"
        'Reply with JSON only: {"chosen":[{"id":"<option id>","why":"<reason>"}],"summary":"<one sentence>"}'
    )


class Option(BaseModel):
    id: str
    label: str
    effort: Literal["low", "medium", "high"]
    fixes: str
    li_after: float
    reduction_pct: float


class GripIssue(BaseModel):
    """What the on-device screening flagged: categories and a code-written sentence, never landmarks."""

    model_config = ConfigDict(extra="forbid")
    object_label: str = Field(default="load", min_length=1, max_length=40)
    # "posture" = no grip problem, only a deep bend or low pickup.
    status: Literal["proper", "wrong_top", "wrong_uneven", "posture"]
    detail: str | None = Field(default=None, max_length=300)
    lift_posture: Literal["stoop", "squat", "upright"] | None = None


class RecommendRequest(BaseModel):
    zone_id: str = "zone-1"
    # Lift numbers; all omitted when only the environment changed and there is no lift yet.
    li: float | None = None
    risk: Literal["green", "yellow", "red"] | None = None
    dominant: str | None = None
    multipliers: dict[str, float] | None = None
    options: list[Option] = Field(default_factory=list, max_length=12)
    environment: Environment | None = None
    grip_issue: GripIssue | None = None
    language: str = "English"


class Pick(BaseModel):
    id: str
    kind: Literal["lift", "environment", "grip"] = "lift"
    label: str
    # Code-computed NIOSH prediction; None for environmental fixes (NIOSH has no climate term).
    li_after: float | None
    reduction_pct: float | None
    effort: str
    why: str


class GripAdvice(BaseModel):
    source: Literal["llm", "fallback"]
    # What is wrong with the current grip or posture, written by code.
    issue: str
    summary: str
    # kind "grip": hand-placement, posture and workstation fixes; no NIOSH numbers.
    picks: list[Pick]
    latency_ms: int
    cached: bool = False
    note: str | None = None


class RecommendResponse(BaseModel):
    source: Literal["llm", "fallback"]
    summary: str
    picks: list[Pick]
    latency_ms: int
    cached: bool = False
    note: str | None = None
    # Short phrases for the facility log, e.g. ["a 75 cm lifting assist table", "cooling ventilation"].
    needs: list[str] = Field(default_factory=list)
    hazards: list[Hazard] = Field(default_factory=list)
    # Hand-placement solution when a grip or posture issue was sent.
    grip: GripAdvice | None = None


_EFFORT_RANK = {"low": 0, "medium": 1, "high": 2}
# Risk reduction is discounted by how hard a change is to make ("reduction vs. effort").
_EFFORT_WEIGHT = {"low": 1.0, "medium": 0.85, "high": 0.6}

_WHY_BY_FIX = {
    "VM": "The pickup point is far from waist height, so the lift starts from an awkward position.",
    "HM": "The load sits far from the body, which multiplies the strain on the lower back.",
    "AM": "The layout forces a twist during the lift.",
    "CM": "A poor grip makes every lift harder than it needs to be.",
    "DM": "The load travels a long way vertically.",
    "FM": "Lighter units spread the effort, at the cost of more lifts.",
}

_GREEN_SUMMARY = "This lift is within the recommended limit, so no change is required. An optional improvement is shown below."
_RED_SUMMARY = "This is a workstation design issue, not a worker issue. The changes below give the biggest reduction."

# LLM text may not make quantitative claims: no digits, and no numbers or ratios spelled out
# ("ninety percent", "halves the risk"). Only code-computed numbers are shown. "one" is allowed
# ("one hand"); a false positive only swaps in the code-written template.
_HAS_NUMBER = re.compile(
    r"\d|%|(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\w+teen|twenty|thirty|forty|fifty|"
    r"sixty|seventy|eighty|ninety|hundred|thousand|percent|per\s*cent|half|halves|halve|halved|halving|twice|"
    r"double[sd]?|triple[sd]?|quadruple[sd]?|\w+fold|times)",
    re.IGNORECASE,
)


def _elapsed(started: float) -> int:
    return int((time.time() - started) * 1000)


def _pick(o: Option, why: str) -> Pick:
    return Pick(id=o.id, label=o.label, li_after=o.li_after, reduction_pct=o.reduction_pct, effort=o.effort, why=why)


def _fallback(req: RecommendRequest, note: str, started: float) -> RecommendResponse:
    # Best value first: risk reduction weighted by effort, ties to the easier change.
    ranked = sorted(req.options, key=lambda o: (-o.reduction_pct * _EFFORT_WEIGHT[o.effort], _EFFORT_RANK[o.effort]))
    ranked = ranked[: 1 if req.risk == "green" else 2]
    picks = [_pick(o, _WHY_BY_FIX.get(o.fixes, "This change makes the workstation easier on the body.")) for o in ranked]
    if not picks:
        summary = "This workstation is within the recommended limit."
    else:
        summary = _GREEN_SUMMARY if req.risk == "green" else _RED_SUMMARY
    return RecommendResponse(source="fallback", summary=summary, picks=picks, latency_ms=_elapsed(started), note=note)


def _verify(req: RecommendRequest, raw: dict, started: float, cached: bool) -> RecommendResponse | None:
    """Keep only picks that match real options. Numbers always come from our data; text with digits is replaced."""
    by_id = {o.id: o for o in req.options}
    limit = 1 if req.risk == "green" else 2
    picks: list[Pick] = []
    for item in raw.get("chosen", []) if isinstance(raw.get("chosen"), list) else []:
        if len(picks) >= limit or not isinstance(item, dict):
            break
        option = by_id.get(str(item.get("id")))
        if not option or any(p.id == option.id for p in picks):
            continue
        why = str(item.get("why", "")).strip()
        if not why or _HAS_NUMBER.search(why):
            why = _WHY_BY_FIX.get(option.fixes, "This change makes the workstation easier on the body.")
        picks.append(_pick(option, why))
    if not picks:
        return None
    summary = str(raw.get("summary", "")).strip()
    if not summary or _HAS_NUMBER.search(summary):
        summary = _GREEN_SUMMARY if req.risk == "green" else _RED_SUMMARY
    return RecommendResponse(source="llm", summary=summary, picks=picks, latency_ms=_elapsed(started), cached=cached)


# One HTTP client for the whole process (connection reuse keeps latency down).
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=LLM_TIMEOUT_S)
    return _client


async def aclose_client() -> None:
    if _client is not None:
        await _client.aclose()


# The LLM's choice depends only on the situation, not on exact numbers (it may not
# write any), so answers are cached by situation and re-verified against each request.
_cache: dict[tuple, dict] = {}


def _cache_key(req: RecommendRequest) -> tuple:
    env = tuple(h.id for h in hazards(req.environment))
    return (req.zone_id, req.dominant, req.risk, req.language, tuple(o.id for o in req.options), env)


def _with_environment(resp: RecommendResponse, req: RecommendRequest) -> RecommendResponse:
    """Add facility fixes for environmental hazards and the combined 'this zone needs ...' sentence."""
    found = hazards(req.environment)
    needs: list[str] = []
    lift_picks = [p for p in resp.picks if p.kind == "lift"]
    if lift_picks and req.risk != "green" and lift_picks[0].id in LIFT_NEEDS:
        needs.append(LIFT_NEEDS[lift_picks[0].id])
    for h in found:
        resp.picks.append(
            Pick(
                id=h.fix_id,
                kind="environment",
                label=h.fix_label,
                li_after=None,
                reduction_pct=None,
                effort="medium",
                why=f"{h.label} ({h.reading}) adds physical strain on top of the lifting work.",
            )
        )
        needs.append(h.need)
    if found:
        sentence = f"This zone needs {join_needs(needs)}."
        resp.summary = f"{resp.summary} {sentence}" if resp.summary else sentence
    resp.needs = needs
    resp.hazards = found
    return resp


async def _chat(system: str, user: str) -> dict:
    cfg = _llm_config()
    payload = {
        "model": cfg["model"],
        "temperature": cfg.get("temperature", 0.2),
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    res = await _get_client().post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
        json=payload,
    )
    res.raise_for_status()
    data = json.loads(res.json()["choices"][0]["message"]["content"])
    # Valid JSON that isn't an object (null, a list) is a failed answer, handled like a timeout.
    if not isinstance(data, dict):
        raise ValueError("LLM reply is not a JSON object")
    return data


async def _ask_llm(req: RecommendRequest) -> dict:
    return await _chat(
        _system_prompt() + f"\nWrite in {req.language}.",
        req.model_dump_json(exclude={"zone_id", "language", "grip_issue"}),
    )


# ---------- Grip and posture advice ----------

# Candidate fixes: id -> (label, effort, template reason). Text is about the grip, the
# load and the workstation; the numbers in it are code's (the green target brackets).
_GRIP_FIXES: dict[str, tuple[str, str, str]] = {
    "grip_seat_base": (
        "Grip both sides of the seat base",
        "low",
        "Slide both palms and all five fingers down to the green [ ] brackets under the left and right edges of "
        "the seat base (55–75% of the chair's height). The chair's weight then hangs between the hands, close to "
        "the torso, so it can't swing or tip.",
    ),
    "grip_lower_sides": (
        "Hold the lower sides of the {label}",
        "low",
        "Move both hands down to the green [ ] brackets on the lower sides of the {label} (55–75% of its height), "
        "fingers wrapped underneath, so its weight sits between the hands and close to the torso.",
    ),
    "grip_even": (
        "Both hands, level, on opposite sides",
        "low",
        "Put one palm on each side of the {label} at the same height inside the green [ ] brackets, fingers "
        "wrapped underneath, so both arms share the weight and the load stays level.",
    ),
    "lift_with_legs": (
        "Bend the knees and keep the load close",
        "low",
        "Squat with the load against the body and let the legs straighten to raise it, so the back stays upright "
        "instead of working as a crane.",
    ),
    "raise_pickup": (
        "Raise the pickup point to about 75 cm",
        "medium",
        "A table or shelf at waist height (about 75 cm) removes the deep bend for every lift at this station.",
    ),
    "bring_closer": (
        "Store the load at the front edge",
        "low",
        "Keep the load at the front of the shelf or platform so it can be lifted close to the body without reaching.",
    ),
    "provide_handles": (
        "Provide handholds or a trolley",
        "medium",
        "Handholds at the base of the {label}, or a trolley to move it, make the safe grip the easy grip.",
    ),
}

_GRIP_SUMMARY = {
    "top_chair": "Move the hands from the backrest down to the seat base, where the chair's weight sits.",
    "top": "Move the hands from the top edge down to the lower sides, where the weight sits.",
    "uneven": "Share the load evenly between both hands.",
    "stoop": "Let the legs do the lifting, and raise the pickup point so the bend isn't needed.",
    "bend": "Bring the load up and closer so it can be lifted without a deep bend.",
}


def _grip_problems(issue: GripIssue) -> tuple[str | None, str | None]:
    """(grip problem, posture problem); both None when nothing needs fixing."""
    grip = {"wrong_top": "top", "wrong_uneven": "uneven"}.get(issue.status)
    if issue.lift_posture == "stoop":
        posture = "stoop"
    elif issue.status == "posture":
        posture = "bend"
    else:
        posture = None
    return grip, posture


def _issue_text(issue: GripIssue, label: str, grip: str | None, posture: str | None) -> str:
    """What is wrong with the current grip or posture, in plain words about the grip and the load."""
    parts = []
    if grip == "top" and label == "chair":
        parts.append(
            "The fingers are hooked over the upper backrest (the top 38% of the chair), far above its centre of "
            "gravity: the chair hangs below the hands on a long lever arm, which adds tipping torque at the wrists "
            "and pulls on the lower back."
        )
    elif grip == "top":
        parts.append(
            f"The hands hold the top edge of the {label}, far above its centre of gravity, so the load swings below "
            "the hands and adds torque at the wrists and lower back."
        )
    elif grip == "uneven":
        parts.append(
            f"The {label} is held by one hand, or the hands sit at very different heights, so the load tilts and "
            "one side of the back takes most of the weight."
        )
    if posture == "stoop":
        parts.append("The back bends with nearly straight knees (a stoop lift), so the lower back, not the legs, raises the load.")
    elif posture == "bend":
        detail = (issue.detail or "").strip().rstrip(".")
        parts.append(f"{detail}." if detail else "The load starts low or far away, which forces a deep forward bend.")
    return " ".join(parts)


def _grip_option_ids(grip: str | None, posture: str | None, label: str) -> list[str]:
    """Candidate fixes, most direct first: hand placement, then posture, then workstation changes."""
    ids = []
    if grip == "top":
        ids.append("grip_seat_base" if label == "chair" else "grip_lower_sides")
    elif grip == "uneven":
        ids.append("grip_even")
    if posture == "stoop":
        ids += ["lift_with_legs", "raise_pickup"]
    elif posture == "bend":
        ids += ["raise_pickup", "bring_closer"]
    if grip:
        ids += ["provide_handles", "lift_with_legs"]
    return list(dict.fromkeys(ids))


def _grip_pick(fix_id: str, label: str, why: str | None = None) -> Pick:
    title, effort, template = _GRIP_FIXES[fix_id]
    return Pick(
        id=fix_id,
        kind="grip",
        label=title.format(label=label),
        li_after=None,
        reduction_pct=None,
        effort=effort,
        why=why or template.format(label=label),
    )


def _grip_system_prompt() -> str:
    return (
        "You are the EdgeSense handling assistant. On-device screening (no video, no images, no identity) flagged "
        "how a load is being held or lifted. You get only categories: the object type, the grip status, the lift "
        "posture, a code-written description of the problem, and candidate fixes defined by code.\n"
        "Rules:\n"
        "- Choose 1 or 2 fix ids from the list, the most direct fix first; prefer a workstation change as the second.\n"
        "- For each, say concretely where the palms and fingers go, or what changes at the workstation, and why "
        "that reduces strain. At most 2 short sentences.\n"
        "- Describe the grip, the load and the workstation; never blame or judge the person. Calm, plain language.\n"
        "- Do not write any numbers or digits; the interface marks the target hand zone.\n"
        'Reply with JSON only: {"chosen":[{"id":"<fix id>","why":"<reason>"}],"summary":"<one sentence: what to change first>"}'
    )


async def _ask_grip_llm(language: str, facts: dict) -> dict:
    return await _chat(_grip_system_prompt() + f"\nWrite in {language}.", json.dumps(facts, ensure_ascii=False))


async def _recommend_grip(req: RecommendRequest) -> GripAdvice | None:
    issue = req.grip_issue
    if issue is None:
        return None
    grip, posture = _grip_problems(issue)
    if not grip and not posture:
        return None
    started = time.time()
    label = issue.object_label.strip().lower() or "load"
    ids = _grip_option_ids(grip, posture, label)
    text = _issue_text(issue, label, grip, posture)
    default_summary = _GRIP_SUMMARY["top_chair" if grip == "top" and label == "chair" else (grip or posture)]

    def fallback(note: str) -> GripAdvice:
        picks = [_grip_pick(i, label) for i in ids[:2]]
        return GripAdvice(
            source="fallback", issue=text, summary=default_summary, picks=picks, latency_ms=_elapsed(started), note=note
        )

    def verify(raw: dict, cached: bool) -> GripAdvice | None:
        picks: list[Pick] = []
        chosen = raw.get("chosen")
        for item in chosen if isinstance(chosen, list) else []:
            if len(picks) >= 2 or not isinstance(item, dict):
                break
            fix_id = str(item.get("id"))
            if fix_id not in ids or any(p.id == fix_id for p in picks):
                continue
            why = str(item.get("why", "")).strip()[:400]
            picks.append(_grip_pick(fix_id, label, None if _HAS_NUMBER.search(why) else why))
        if not picks:
            return None
        summary = str(raw.get("summary", "")).strip()[:300]
        if not summary or _HAS_NUMBER.search(summary):
            summary = default_summary
        return GripAdvice(
            source="llm", issue=text, summary=summary, picks=picks, latency_ms=_elapsed(started), cached=cached
        )

    if not os.environ.get("OPENAI_API_KEY"):
        return fallback("no API key configured, using built-in template")
    key = ("grip", label, grip, posture, req.language)
    if key in _cache:
        verified = verify(_cache[key], cached=True)
        if verified:
            return verified
    facts = {
        "object": label,
        "grip_status": issue.status,
        "lift_posture": issue.lift_posture,
        "problem": text,
        "fixes": [{"id": i, "label": _GRIP_FIXES[i][0].format(label=label), "effort": _GRIP_FIXES[i][1]} for i in ids],
    }
    try:
        raw = await _ask_grip_llm(req.language, facts)
    except Exception as exc:  # network, timeout, bad JSON: never break the demo
        return fallback(f"LLM unavailable ({type(exc).__name__}), using built-in template")
    verified = verify(raw, cached=False)
    if not verified:
        return fallback("LLM answer failed verification, using built-in template")
    if len(_cache) >= CACHE_MAX:
        _cache.clear()
    _cache[key] = raw
    return verified


@router.post("/recommend", response_model=RecommendResponse)
async def recommend(req: RecommendRequest) -> RecommendResponse:
    # Lift redesigns and the grip solution are independent, so their LLM calls run side by side.
    # An unexpected grip failure must never take the lift recommendation down with it.
    lift, grip = await asyncio.gather(_recommend_lift(req), _recommend_grip(req), return_exceptions=True)
    if isinstance(lift, BaseException):
        raise lift
    resp = _with_environment(lift, req)
    resp.grip = None if isinstance(grip, BaseException) else grip
    return resp


async def _recommend_lift(req: RecommendRequest) -> RecommendResponse:
    started = time.time()
    if req.li is None:
        summary = "" if hazards(req.environment) or req.grip_issue else "No lift yet and no environmental hazards."
        return RecommendResponse(
            source="fallback", summary=summary, picks=[], latency_ms=_elapsed(started), note="environment only, no lift yet"
        )
    if not req.options:
        return _fallback(req, "no redesign options apply", started)
    if not os.environ.get("OPENAI_API_KEY"):
        return _fallback(req, "no API key configured, using built-in template", started)

    key = _cache_key(req)
    if key in _cache:
        verified = _verify(req, _cache[key], started, cached=True)
        if verified:
            return verified
    try:
        raw = await _ask_llm(req)
    except Exception as exc:  # network, timeout, bad JSON: never break the demo
        return _fallback(req, f"LLM unavailable ({type(exc).__name__}), using built-in template", started)
    verified = _verify(req, raw, started, cached=False)
    if not verified:
        return _fallback(req, "LLM answer failed verification, using built-in template", started)
    if len(_cache) >= CACHE_MAX:
        _cache.clear()
    _cache[key] = raw
    return verified
