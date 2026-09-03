"""Fixed, explainable live safety rules for the dashboard."""

from __future__ import annotations

from dataclasses import dataclass

import config


@dataclass(frozen=True)
class LiveRiskThresholds:
    bathroom_caution_seconds: float = config.FSM.bathroom_long_stay_seconds
    bathroom_danger_seconds: float = config.FSM.bathroom_severe_stay_seconds
    inactivity_caution_seconds: float = config.FSM.bedroom_idle_seconds
    inactivity_danger_seconds: float = config.FSM.bedroom_idle_danger_seconds
    bed_caution_seconds: float = 12 * 60 * 60
    bed_danger_seconds: float = 14 * 60 * 60


def _hours(seconds):
    return f"{max(0.0, float(seconds)) / 3600:.1f}시간"


def _minutes(seconds):
    return f"{max(0.0, float(seconds)) / 60:.0f}분"


def evaluate_live_risk(
    *,
    fall_detected=False,
    fall_transition_seconds=0,
    fall_ratio=0,
    bed_seconds=0,
    bathroom_seconds=0,
    inactivity_seconds=0,
    thresholds=None,
):
    """Return the highest-priority current risk without personal-pattern scoring."""
    limits = thresholds or LiveRiskThresholds()

    if fall_detected:
        return {
            "level": "danger",
            "title": "거실 쓰러짐 감지",
            "summary": "카메라가 급격한 자세 전환과 쓰러진 상태를 확인했습니다.",
            "reasons": [
                f"자세 전환 {float(fall_transition_seconds):.2f}초",
                f"바운딩 비율 {float(fall_ratio):.2f}",
            ],
        }

    candidates = []

    if bed_seconds >= limits.bed_danger_seconds:
        candidates.append((2, 40, {
            "level": "danger", "title": "침대 장시간 사용",
            "summary": "침대 사용이 14시간 위험 기준을 넘었습니다.",
            "reasons": [f"침대 사용 {_hours(bed_seconds)}"],
        }))
    elif bed_seconds >= limits.bed_caution_seconds:
        candidates.append((1, 40, {
            "level": "caution", "title": "침대 장시간 사용",
            "summary": "침대 사용이 12시간 주의 기준을 넘었습니다.",
            "reasons": [f"침대 사용 {_hours(bed_seconds)}"],
        }))

    if bathroom_seconds >= limits.bathroom_danger_seconds:
        candidates.append((2, 30, {
            "level": "danger", "title": "화장실 장기 체류",
            "summary": "화장실 체류가 30분 위험 기준을 넘었습니다.",
            "reasons": [f"화장실 체류 {_minutes(bathroom_seconds)}"],
        }))
    elif bathroom_seconds >= limits.bathroom_caution_seconds:
        candidates.append((1, 30, {
            "level": "caution", "title": "화장실 장기 체류",
            "summary": "화장실 체류가 20분 주의 기준을 넘었습니다.",
            "reasons": [f"화장실 체류 {_minutes(bathroom_seconds)}"],
        }))

    if inactivity_seconds >= limits.inactivity_danger_seconds:
        candidates.append((2, 20, {
            "level": "danger", "title": "장시간 무활동",
            "summary": "침실에서 움직임이 없는 상태가 2시간 위험 기준을 넘었습니다.",
            "reasons": [f"무활동 {_minutes(inactivity_seconds)}"],
        }))
    elif inactivity_seconds >= limits.inactivity_caution_seconds:
        candidates.append((1, 20, {
            "level": "caution", "title": "장시간 무활동",
            "summary": "침실에서 움직임이 없는 상태가 90분 주의 기준을 넘었습니다.",
            "reasons": [f"무활동 {_minutes(inactivity_seconds)}"],
        }))

    if not candidates:
        return {
            "level": "normal", "title": "생활 상태 정상",
            "summary": "현재 주의 또는 위험 조건에 해당하는 센서 상태가 없습니다.",
            "reasons": [],
        }

    return max(candidates, key=lambda item: (item[0], item[1]))[2]
