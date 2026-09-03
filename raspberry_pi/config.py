"""SafeNest Raspberry Pi integration configuration."""
import os
from dataclasses import dataclass, field
from typing import Dict


def _env_bool(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


SIMULATION_MODE = _env_bool("SAFENEST_SIMULATION_MODE", False)
VIRTUAL_SECONDS_PER_REAL_SECOND = float(os.getenv("SAFENEST_TIME_SCALE", "480"))


@dataclass(frozen=True)
class MQTTConfig:
    broker: str = os.getenv("SAFENEST_MQTT_BROKER", "localhost")
    port: int = int(os.getenv("SAFENEST_MQTT_PORT", "1883"))
    topic: str = os.getenv("SAFENEST_MQTT_TOPIC", "SafeNest/sensor")
    keepalive: int = 60
    fields: Dict[str, str] = field(default_factory=lambda: {
        "bedroom_door": "bedroom_door",
        "bathroom_door": "bathroom_door",
        "front_door": "main_door",
        "bed_pressure": "pressure",
        "bedroom_distance": "bedroom_distance",
        "bathroom_distance": "bathroom_distance",
    })


@dataclass(frozen=True)
class SensorConfig:
    filter_size: int = 5
    max_distance_cm: float = 300.0
    movement_threshold_cm: float = 3.0
    movement_votes_required: int = 2
    movement_vote_window: int = 3
    door_debounce_seconds: float = 0.15  # always real time
    bedroom_presence_cm: float = 8.7
    bathroom_presence_cm: float = 7.1
    bed_pressure_on: float = 2500.0


@dataclass(frozen=True)
class FSMConfig:
    bathroom_long_stay_seconds: float = 20 * 60
    bathroom_severe_stay_seconds: float = 30 * 60
    bathroom_inactivity_seconds: float = 5 * 60
    bedroom_idle_seconds: float = 90 * 60
    bedroom_idle_danger_seconds: float = 120 * 60
    transition_timeout_seconds: float = 10


MQTT = MQTTConfig()
SENSOR = SensorConfig()
FSM = FSMConfig()
DATABASE_PATH = os.getenv("SAFENEST_DATABASE_PATH", "safenest.db")
