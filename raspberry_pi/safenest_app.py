"""Straightforward integration layer from incoming sensors to explainable decisions."""
import config
from bathroom_fsm import BathroomFSM
from bedroom_fsm import BedroomFSM
from database import Database
from entrance_fsm import EntranceFSM
from event_manager import EventManager
from sensor_processor import SensorProcessor
from simulation_clock import SimulationClock


LOCATION_BY_SENSOR = {
    "bedroom_door": "bedroom", "bed_pressure": "bedroom", "bedroom_distance": "bedroom",
    "bathroom_door": "bathroom", "bathroom_distance": "bathroom", "front_door": "entrance",
}


class SafeNestApp:
    def __init__(self, database=None, clock=None, echo=True):
        self.database = database or Database(config.DATABASE_PATH)
        self.clock = clock or SimulationClock()
        self.events = EventManager(self.database, echo=echo)
        self.processor = SensorProcessor()
        self.bathroom = BathroomFSM(self.events, echo=echo)
        self.bedroom = BedroomFSM(self.events, echo=echo)
        self.entrance = EntranceFSM(self.events, echo=echo)
        self.echo = echo
        self.latest = {
            "bathroom_door": False, "front_door": False, "bed_occupied": False,
            "bathroom_present": False, "bedroom_present": False,
        }

    def canonicalize(self, incoming):
        result = {}
        for canonical, external in config.MQTT.fields.items():
            if external in incoming:
                result[canonical] = incoming[external]
        return result

    def handle_payload(self, incoming):
        payload = self.canonicalize(incoming)
        virtual_now = self.clock.virtual_now()
        for sensor, value in payload.items():
            if isinstance(value, (int, float)):
                self.database.insert_raw(virtual_now, sensor, LOCATION_BY_SENSOR.get(sensor, "unknown"), value)

        processed = self.processor.process(payload, real_now=self.clock.real_monotonic())
        self.latest.update(processed)
        bathroom_distance = self.latest.get("bathroom_distance")
        bathroom_snapshot = self.bathroom.update(
            self.latest["bathroom_door"], self.latest["bathroom_present"],
            bool(bathroom_distance and bathroom_distance.movement), virtual_now)
        bedroom_distance = self.latest.get("bedroom_distance")
        bedroom_state = self.bedroom.update(
            self.latest["bed_occupied"], self.latest["bedroom_present"],
            bool(bedroom_distance and bedroom_distance.movement), virtual_now)
        entrance_state = self.entrance.update(
            self.latest["front_door"],
            virtual_now,
            real_now=self.clock.real_monotonic(),
        )

        return {"virtual_time": virtual_now, "bathroom": bathroom_snapshot,
                "bedroom": bedroom_state, "entrance": entrance_state}

