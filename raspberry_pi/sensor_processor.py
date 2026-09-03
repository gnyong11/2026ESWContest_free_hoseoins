"""Noise-resistant ultrasonic and threshold sensor preprocessing."""
from collections import deque
from dataclasses import dataclass
from statistics import median

import config


@dataclass
class DistanceState:
    distance: float = None
    delta: float = 0.0
    movement: bool = False
    valid: bool = False


class UltrasonicProcessor:
    def __init__(self, settings=config.SENSOR):
        self.settings = settings
        self.samples = deque(maxlen=settings.filter_size)
        self.movement_votes = deque(maxlen=settings.movement_vote_window)
        self.previous = None

    def update(self, raw_value):
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            return DistanceState(distance=self.previous, valid=False)
        if value <= 0 or value > self.settings.max_distance_cm:
            return DistanceState(distance=self.previous, valid=False)

        self.samples.append(value)
        filtered = float(median(self.samples))
        delta = 0.0 if self.previous is None else filtered - self.previous
        self.movement_votes.append(abs(delta) >= self.settings.movement_threshold_cm)
        movement = sum(self.movement_votes) >= self.settings.movement_votes_required
        self.previous = filtered
        return DistanceState(filtered, delta, movement, True)


class BinaryDebouncer:
    def __init__(self, hold_seconds):
        self.hold_seconds = hold_seconds
        self.state = None
        self.candidate = None
        self.candidate_since = None

    def update(self, value, real_now):
        value = bool(value)
        if self.state is None:
            self.state = value
            return self.state
        if value == self.state:
            self.candidate = None
            self.candidate_since = None
        elif value != self.candidate:
            self.candidate = value
            self.candidate_since = real_now
        elif real_now - self.candidate_since >= self.hold_seconds:
            self.state = value
            self.candidate = None
            self.candidate_since = None
        return self.state


class SensorProcessor:
    def __init__(self, settings=config.SENSOR):
        self.settings = settings
        self.distance_processors = {
            "bedroom_distance": UltrasonicProcessor(settings),
            "bathroom_distance": UltrasonicProcessor(settings),
        }
        self.door_processors = {
            name: BinaryDebouncer(settings.door_debounce_seconds)
            for name in ("bedroom_door", "bathroom_door", "front_door")
        }

    def process(self, payload, real_now=0.0):
        result = {}
        for name, processor in self.distance_processors.items():
            if name in payload:
                result[name] = processor.update(payload[name])
        result["bed_occupied"] = float(payload.get("bed_pressure", 0)) >= self.settings.bed_pressure_on
        for door in ("bedroom_door", "bathroom_door", "front_door"):
            if door in payload:
                raw_open = bool(int(payload[door]))  # convention: 1=open, 0=closed
                result[door] = self.door_processors[door].update(raw_open, real_now)
        if "bathroom_distance" in result:
            state = result["bathroom_distance"]
            result["bathroom_present"] = state.valid and state.distance <= self.settings.bathroom_presence_cm
        if "bedroom_distance" in result:
            state = result["bedroom_distance"]
            result["bedroom_present"] = state.valid and state.distance <= self.settings.bedroom_presence_cm
        return result
