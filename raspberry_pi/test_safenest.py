import os
import sys
import tempfile
import types
import unittest
from dataclasses import replace
from datetime import datetime, timedelta

import config

try:
    import cv2  # noqa: F401 - available on Raspberry Pi OS
except ModuleNotFoundError:
    sys.modules["cv2"] = types.ModuleType("cv2")

from bathroom_fsm import BathroomFSM
from database import Database
from event_manager import EventManager, LifeEvent
from fall_detector import FigureFallDetector
from entrance_fsm import EntranceFSM
from privacy_policy import living_room_camera_policy
from risk_rules import LiveRiskThresholds, evaluate_live_risk
from safenest_app import SafeNestApp
from sensor_processor import BinaryDebouncer, SensorProcessor, UltrasonicProcessor
from simulation_clock import SimulationClock


class SafeNestTests(unittest.TestCase):
    def test_ultrasonic_rejects_outlier_and_filters(self):
        processor = UltrasonicProcessor()
        self.assertFalse(processor.update(9999).valid)
        self.assertEqual(processor.update(20).distance, 20)
        self.assertEqual(processor.update(22).distance, 21)

    def test_door_debounce_uses_real_elapsed_time(self):
        debounce = BinaryDebouncer(0.15)
        self.assertFalse(debounce.update(False, 0.0))
        self.assertFalse(debounce.update(True, 1.0))
        self.assertFalse(debounce.update(True, 1.1))
        self.assertTrue(debounce.update(True, 1.2))

    def test_bed_pressure_uses_2500_boundary(self):
        processor = SensorProcessor()
        self.assertFalse(processor.process({"bed_pressure": 2499})["bed_occupied"])
        self.assertTrue(processor.process({"bed_pressure": 2500})["bed_occupied"])

    def test_bathroom_long_stay_is_event_not_immediate_danger(self):
        manager = EventManager(echo=False)
        fsm = BathroomFSM(manager, replace(config.FSM, bathroom_long_stay_seconds=10), echo=False)
        start = datetime(2026, 1, 1, 8, 0)
        fsm.update(True, True, True, start)
        fsm.update(False, True, False, start + timedelta(seconds=1))
        result = fsm.update(False, True, False, start + timedelta(seconds=11))
        self.assertEqual(result["state"], "LONG_STAY")
        self.assertIn("LONG_BATHROOM_STAY", [event.event_type for event in manager.emitted])

    def test_fixed_live_risk_thresholds(self):
        limits = LiveRiskThresholds(
            bathroom_caution_seconds=20 * 60,
            bathroom_danger_seconds=30 * 60,
            inactivity_caution_seconds=90 * 60,
            inactivity_danger_seconds=120 * 60,
        )
        self.assertEqual(evaluate_live_risk(bathroom_seconds=20 * 60, thresholds=limits)["level"], "caution")
        self.assertEqual(evaluate_live_risk(bathroom_seconds=30 * 60, thresholds=limits)["level"], "danger")
        self.assertEqual(evaluate_live_risk(inactivity_seconds=90 * 60, thresholds=limits)["level"], "caution")
        self.assertEqual(evaluate_live_risk(inactivity_seconds=120 * 60, thresholds=limits)["level"], "danger")

    def test_camera_only_runs_for_living_room_or_entrance_likelihood(self):
        common = dict(sensor_data_available=True, resident_away=False,
                      front_door_open=False, door_cycle_pending=False)
        self.assertTrue(living_room_camera_policy(
            **common, bedroom_present=False, bathroom_present=False, bed_occupied=False,
        )[0])
        self.assertFalse(living_room_camera_policy(
            **common, bedroom_present=True, bathroom_present=False, bed_occupied=False,
        )[0])
        self.assertTrue(living_room_camera_policy(
            **{**common, "door_cycle_pending": True},
            bedroom_present=True, bathroom_present=False, bed_occupied=False,
        )[0])

    def test_figure_fall_uses_1_5_second_transition(self):
        detector = FigureFallDetector(history_size=1)
        detector.update_state("STANDING", now=0.0)
        state, elapsed = detector.update_state("FALLEN", now=1.0)
        self.assertEqual(state, "FALLEN")
        self.assertLess(elapsed, 1.5)
        self.assertTrue(detector.fall_detected)
        self.assertEqual(detector.last_event, "FALL")

        detector.update_state("STANDING", now=2.0)
        detector.update_state("TRANSITION", now=3.0)
        detector.update_state("FALLEN", now=5.0)
        self.assertFalse(detector.fall_detected)
        self.assertEqual(detector.last_event, "NORMAL_LYING")

    def test_front_door_cycle_uses_camera_to_decide_direction(self):
        manager = EventManager(echo=False)
        fsm = EntranceFSM(manager, echo=False)
        start = datetime(2026, 1, 1, 8, 0)

        fsm.observe_camera(False, start, real_now=0.0)
        fsm.observe_camera(False, start + timedelta(seconds=2), real_now=2.0)
        self.assertEqual(fsm.state, "HOME")

        fsm.update(True, start + timedelta(seconds=3), real_now=3.0)
        fsm.update(False, start + timedelta(seconds=4), real_now=4.0)
        self.assertTrue(fsm.door_cycle_pending)
        fsm.observe_camera(False, start + timedelta(seconds=5), real_now=5.0)
        self.assertEqual(fsm.state, "AWAY")

        fsm.observe_camera(True, start + timedelta(seconds=6), real_now=6.0)
        fsm.observe_camera(True, start + timedelta(seconds=7), real_now=7.0)
        self.assertEqual(fsm.state, "AWAY")
        fsm.update(True, start + timedelta(seconds=8), real_now=8.0)
        fsm.update(False, start + timedelta(seconds=9), real_now=9.0)
        fsm.observe_camera(True, start + timedelta(seconds=10), real_now=10.0)
        self.assertEqual(fsm.state, "HOME")
        self.assertEqual(
            [event.event_type for event in manager.emitted],
            ["OUTING_START", "OUTING_END"],
        )

    def test_camera_absence_without_door_cycle_does_not_create_outing(self):
        manager = EventManager(echo=False)
        fsm = EntranceFSM(manager, echo=False)
        start = datetime(2026, 1, 1, 8, 0)
        fsm.observe_camera(False, start, real_now=0.0)
        fsm.observe_camera(False, start + timedelta(seconds=2), real_now=2.0)
        self.assertFalse(fsm.living_present)
        self.assertEqual(fsm.state, "HOME")
        self.assertEqual(manager.emitted, [])

    def test_door_cycle_waits_for_new_camera_absence_confirmation(self):
        manager = EventManager(echo=False)
        fsm = EntranceFSM(manager, echo=False)
        start = datetime(2026, 1, 1, 8, 0)
        fsm.observe_camera(True, start, real_now=0.0)
        fsm.observe_camera(True, start + timedelta(seconds=1), real_now=1.0)
        fsm.update(True, start + timedelta(seconds=2), real_now=2.0)
        fsm.update(False, start + timedelta(seconds=3), real_now=3.0)

        fsm.observe_camera(False, start + timedelta(seconds=3.1), real_now=3.1)
        fsm.observe_camera(False, start + timedelta(seconds=3.7), real_now=3.7)
        self.assertEqual(fsm.state, "HOME")
        self.assertTrue(fsm.door_cycle_pending)

        fsm.observe_camera(False, start + timedelta(seconds=4.7), real_now=4.7)
        self.assertEqual(fsm.state, "AWAY")

    def test_database_schema_and_event(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db = Database(os.path.join(temp_dir, "test.db"))
            db.insert_event(LifeEvent(datetime.now(), "ACTIVITY", "bedroom", reason="test"))
            rows = db.events_between(datetime.now() - timedelta(days=1), datetime.now() + timedelta(days=1))
            self.assertEqual(len(rows), 1)
            db.close()

    def test_actual_esp32_json_contract(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db = Database(os.path.join(temp_dir, "contract.db"))
            app = SafeNestApp(database=db, clock=SimulationClock(simulation_mode=False), echo=False)
            result = app.handle_payload({
                "main_door": 0,
                "bedroom_door": 0,
                "bathroom_door": 0,
                "pressure": 2500,
                "bedroom_distance": 8.6,
                "bathroom_distance": 9.1,
            })
            self.assertEqual(result["entrance"], "HOME")
            self.assertTrue(app.latest["bed_occupied"])
            self.assertTrue(app.latest["bedroom_present"])
            self.assertFalse(app.latest["bathroom_present"])
            db.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
