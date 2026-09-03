"""Contour-based transformer figure posture and fall detection."""

from __future__ import annotations

from collections import deque
import time

import cv2
import numpy as np


class FigureFallDetector:
    """Detect the largest fixed-scene figure and classify its posture."""

    def __init__(
        self,
        *,
        canny_low=100,
        canny_high=200,
        min_area=1500,
        standing_max_ratio=0.80,
        fallen_min_ratio=1.10,
        fall_time_threshold=1.50,
        history_size=3,
        monotonic_fn=time.monotonic,
    ):
        self.canny_low = int(canny_low)
        self.canny_high = int(canny_high)
        self.min_area = float(min_area)
        self.standing_max_ratio = float(standing_max_ratio)
        self.fallen_min_ratio = float(fallen_min_ratio)
        self.fall_time_threshold = float(fall_time_threshold)
        self.history = deque(maxlen=max(1, int(history_size)))
        self.monotonic = monotonic_fn
        self.previous_state = "UNKNOWN"
        self.transition_started_at = None
        self.fall_detected = False
        self.last_event = None

    def classify(self, width, height):
        if height <= 0:
            return "UNKNOWN", 0.0
        ratio = width / height
        if ratio <= self.standing_max_ratio:
            return "STANDING", ratio
        if ratio >= self.fallen_min_ratio:
            return "FALLEN", ratio
        return "TRANSITION", ratio

    def stabilize(self, raw_state):
        self.history.append(raw_state)
        if len(self.history) < self.history.maxlen:
            return raw_state
        counts = {
            state: self.history.count(state)
            for state in ("STANDING", "TRANSITION", "FALLEN")
        }
        maximum = max(counts.values())
        if counts["STANDING"] == maximum:
            return "STANDING"
        if counts["FALLEN"] == maximum:
            return "FALLEN"
        return "TRANSITION"

    def update_state(self, raw_state, now=None):
        now = self.monotonic() if now is None else float(now)
        state = self.stabilize(raw_state)
        transition_seconds = 0.0

        if self.previous_state == "STANDING" and state != "STANDING" and self.transition_started_at is None:
            self.transition_started_at = now

        if state == "STANDING":
            self.transition_started_at = None
            self.fall_detected = False
            self.last_event = None
        elif self.transition_started_at is not None:
            transition_seconds = max(0.0, now - self.transition_started_at)

        if (
            state == "FALLEN"
            and self.previous_state != "FALLEN"
            and self.transition_started_at is not None
        ):
            if transition_seconds < self.fall_time_threshold:
                self.last_event = "FALL"
                self.fall_detected = True
            else:
                self.last_event = "NORMAL_LYING"
                self.fall_detected = False

        self.previous_state = state
        return state, transition_seconds

    def reset_missing(self):
        self.history.clear()
        self.previous_state = "UNKNOWN"
        self.transition_started_at = None
        self.fall_detected = False
        self.last_event = None

    def process(self, frame_bgr):
        """Return an annotated frame and a JSON-ready detection snapshot."""
        display = frame_bgr.copy()
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, self.canny_low, self.canny_high)
        kernel = np.ones((5, 5), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        valid = [contour for contour in contours if cv2.contourArea(contour) >= self.min_area]

        if not valid:
            self.reset_missing()
            return display, {
                "object_detected": False,
                "raw_state": "UNKNOWN",
                "state": "UNKNOWN",
                "label": "NO OBJECT",
                "fall_detected": False,
                "last_event": None,
                "ratio": 0.0,
                "transition_seconds": 0.0,
                "bbox": None,
            }

        largest = max(valid, key=cv2.contourArea)
        x, y, width, height = cv2.boundingRect(largest)
        raw_state, ratio = self.classify(width, height)
        state, transition_seconds = self.update_state(raw_state)

        if self.fall_detected:
            color, label = (0, 0, 255), "FALL DETECTED"
        elif state == "TRANSITION":
            color, label = (0, 210, 255), "TRANSITION"
        elif state == "FALLEN":
            color, label = (70, 190, 70), "NORMAL LYING"
        else:
            color, label = (70, 190, 70), "NORMAL"

        cv2.rectangle(display, (x, y), (x + width, y + height), color, 3)
        text_origin = (x, max(24, y - 10))
        cv2.putText(display, label, text_origin, cv2.FONT_HERSHEY_SIMPLEX, 0.72, color, 2)

        return display, {
            "object_detected": True,
            "raw_state": raw_state,
            "state": state,
            "label": label,
            "fall_detected": self.fall_detected,
            "last_event": self.last_event,
            "ratio": round(ratio, 3),
            "transition_seconds": round(transition_seconds, 3),
            "bbox": {"x": x, "y": y, "width": width, "height": height},
        }
