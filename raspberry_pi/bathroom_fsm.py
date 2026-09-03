"""Explainable bathroom occupancy finite-state machine."""
from enum import Enum

import config
from event_manager import LifeEvent


class BathroomState(str, Enum):
    EMPTY = "EMPTY"
    ENTERING = "ENTERING"
    OCCUPIED = "OCCUPIED"
    LONG_STAY = "LONG_STAY"
    EXITING = "EXITING"


class BathroomFSM:
    def __init__(self, event_manager, settings=config.FSM, echo=True):
        self.events = event_manager
        self.settings = settings
        self.echo = echo
        self.state = BathroomState.EMPTY
        self.state_since = None
        self.entered_at = None
        self.last_movement_at = None
        self._long_stay_emitted = False

    def _transition(self, new_state, now, reason):
        if new_state == self.state:
            return
        old = self.state
        self.state = new_state
        self.state_since = now
        if self.echo:
            print(f"[{now:%H:%M:%S}] Bathroom FSM: {old.value} -> {new_state.value} ({reason})")

    def update(self, door_open, present, movement, now):
        if self.state_since is None:
            self.state_since = now
        if movement:
            self.last_movement_at = now

        if self.state == BathroomState.EMPTY:
            if door_open and present:
                self.entered_at = now
                self.last_movement_at = now
                self._long_stay_emitted = False
                self._transition(BathroomState.ENTERING, now, "door opened and internal presence detected")
                self.events.emit(LifeEvent(now, "BATHROOM_ENTER", "bathroom", reason="Door opened followed by internal presence"))

        elif self.state == BathroomState.ENTERING:
            if present and not door_open:
                self._transition(BathroomState.OCCUPIED, now, "door closed while occupied")
            elif not present and (now - self.state_since).total_seconds() > self.settings.transition_timeout_seconds:
                self._transition(BathroomState.EMPTY, now, "entry was not confirmed")

        elif self.state in (BathroomState.OCCUPIED, BathroomState.LONG_STAY):
            duration = (now - self.entered_at).total_seconds() if self.entered_at else 0
            if door_open and not present:
                self._transition(BathroomState.EXITING, now, "door opened and presence disappeared")
                self.events.emit(LifeEvent(now, "BATHROOM_EXIT", "bathroom", duration=duration,
                                           reason="Internal presence disappeared after door opened"))
            elif self.state == BathroomState.OCCUPIED and duration >= self.settings.bathroom_long_stay_seconds:
                self._transition(BathroomState.LONG_STAY, now, "stay exceeded configured limit")
                if not self._long_stay_emitted:
                    inactive = 0 if self.last_movement_at is None else (now - self.last_movement_at).total_seconds()
                    self.events.emit(LifeEvent(now, "LONG_BATHROOM_STAY", "bathroom", duration=duration,
                                               value=inactive, reason="Bathroom stay exceeded normal demo threshold"))
                    self._long_stay_emitted = True

        elif self.state == BathroomState.EXITING:
            if not present and not door_open:
                self._transition(BathroomState.EMPTY, now, "exit completed and door closed")
                self.entered_at = None
            elif present and not door_open:
                self._transition(BathroomState.OCCUPIED, now, "exit cancelled; presence detected")
        return self.snapshot(now)

    def snapshot(self, now):
        duration = 0 if self.entered_at is None else max(0, (now - self.entered_at).total_seconds())
        inactive = 0 if self.last_movement_at is None else max(0, (now - self.last_movement_at).total_seconds())
        return {"state": self.state.value, "duration": duration, "inactivity": inactive}

