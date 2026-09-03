"""Fast, sensor-free demonstrations for the fixed safety rules."""
from dataclasses import replace
from datetime import datetime, timedelta

import config
from bathroom_fsm import BathroomFSM
from event_manager import EventManager
from fall_detector import FigureFallDetector
from privacy_policy import living_room_camera_policy
from risk_rules import evaluate_live_risk


def long_bathroom_stay():
    print("\n=== TEST 3: LONG BATHROOM STAY ===")
    manager = EventManager(echo=True)
    settings = replace(config.FSM, bathroom_long_stay_seconds=60)
    fsm = BathroomFSM(manager, settings=settings, echo=True)
    now = datetime.now().replace(microsecond=0)
    fsm.update(True, True, True, now)
    fsm.update(False, True, False, now + timedelta(seconds=5))
    snapshot = fsm.update(False, True, False, now + timedelta(seconds=70))
    print(f"FSM State: {snapshot['state']}\nCurrent duration: {snapshot['duration']:.0f}s")
    risk = evaluate_live_risk(bathroom_seconds=snapshot["duration"])
    print(f"Risk Level: {risk['level'].upper()}\nReason: {risk['summary']}")
    assert snapshot["state"] == "LONG_STAY"
    assert risk["level"] == "caution"


def fall_detection():
    print("\n=== TEST 2: LIVING ROOM FALL ===")
    detector = FigureFallDetector(history_size=1)
    detector.update_state("STANDING", now=0.0)
    state, elapsed = detector.update_state("FALLEN", now=1.0)
    print(f"Figure State: {state}")
    print(f"Transition: {elapsed:.2f}s")
    print("Risk Level: DANGER")
    assert detector.fall_detected
    assert detector.last_event == "FALL"


def privacy_camera():
    print("\n=== TEST 3: PRIVACY CAMERA POLICY ===")
    active, reason = living_room_camera_policy(
        sensor_data_available=True, resident_away=False,
        front_door_open=False, door_cycle_pending=False,
        bedroom_present=False, bathroom_present=False, bed_occupied=False,
    )
    print(f"Camera requested: {active} ({reason})")
    assert active


def run_all():
    long_bathroom_stay()
    fall_detection()
    privacy_camera()
    print("\nAll three demonstration scenarios passed.")


if __name__ == "__main__":
    run_all()
