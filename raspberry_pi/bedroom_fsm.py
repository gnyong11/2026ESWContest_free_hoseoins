"""Bedroom/bed usage finite-state machine."""
from enum import Enum

import config
from event_manager import LifeEvent


class BedroomState(str, Enum):
    ROOM_EMPTY = "ROOM_EMPTY"
    BED_OCCUPIED = "BED_OCCUPIED"
    BED_EXIT = "BED_EXIT"
    ROOM_ACTIVE = "ROOM_ACTIVE"
    ROOM_IDLE = "ROOM_IDLE"


class BedroomFSM:
    def __init__(self, event_manager, settings=config.FSM, echo=True):
        self.events = event_manager
        self.settings = settings
        self.echo = echo
        self.state = BedroomState.ROOM_EMPTY
        self.bed_entered_at = None
        self.last_activity_at = None
        self._previous_bed = False

    def _transition(self, state, now, reason):
        if state != self.state:
            old = self.state
            self.state = state
            if self.echo:
                print(f"[{now:%H:%M:%S}] Bedroom FSM: {old.value} -> {state.value} ({reason})")

    def update(self, bed_occupied, present, movement, now):
        if movement:
            self.last_activity_at = now
            self.events.emit(LifeEvent(now, "ACTIVITY", "bedroom", reason="Confirmed ultrasonic movement"))
        elif present and self.last_activity_at is None:
            self.last_activity_at = now

        if bed_occupied and not self._previous_bed:
            self.bed_entered_at = now
            self._transition(BedroomState.BED_OCCUPIED, now, "bed pressure activated")
            self.events.emit(LifeEvent(now, "BED_ENTER", "bedroom", reason="Bed pressure crossed ON threshold"))
            self.events.emit(LifeEvent(now, "SLEEP_START", "bedroom", reason="Bed entry used as sleep candidate"))
        elif not bed_occupied and self._previous_bed:
            duration = 0 if self.bed_entered_at is None else (now - self.bed_entered_at).total_seconds()
            self._transition(BedroomState.BED_EXIT, now, "bed pressure released")
            self.events.emit(LifeEvent(now, "BED_EXIT", "bedroom", duration=duration,
                                       reason="Bed pressure changed from ON to OFF"))
            self.events.emit(LifeEvent(now, "WAKE_UP", "bedroom", duration=duration,
                                       reason="Bed exit used as wake-up candidate"))
        elif bed_occupied:
            self._transition(BedroomState.BED_OCCUPIED, now, "bed remains occupied")
        elif movement:
            self._transition(BedroomState.ROOM_ACTIVE, now, "movement detected with bed unoccupied")
        elif present:
            idle = 0 if self.last_activity_at is None else (now - self.last_activity_at).total_seconds()
            if idle >= self.settings.bedroom_idle_seconds:
                if self.state != BedroomState.ROOM_IDLE:
                    self.events.emit(LifeEvent(now, "INACTIVITY", "bedroom", duration=idle,
                                               reason="No confirmed movement in bedroom"))
                self._transition(BedroomState.ROOM_IDLE, now, "presence without movement")
        else:
            self._transition(BedroomState.ROOM_EMPTY, now, "no bed pressure or room presence")
            self.last_activity_at = None

        self._previous_bed = bed_occupied
        return self.state.value
