"""Front-door transition estimator confirmed by living-room camera occupancy."""

from __future__ import annotations

import time

from event_manager import LifeEvent


class EntranceFSM:
    """Use a complete door cycle plus stable camera presence to infer direction."""

    def __init__(
        self,
        event_manager,
        initially_home=True,
        echo=True,
        presence_confirm_seconds=0.5,
        absence_confirm_seconds=1.5,
        post_close_delay_seconds=0.5,
    ):
        self.events = event_manager
        self.is_home = bool(initially_home)
        self.echo = echo
        self.presence_confirm_seconds = float(presence_confirm_seconds)
        self.absence_confirm_seconds = float(absence_confirm_seconds)
        self.post_close_delay_seconds = float(post_close_delay_seconds)
        self.previous_open = False
        self.opened_at = None
        self.closed_at_real = None
        self.door_cycle_pending = False
        self.outing_started_at = None
        self.living_present = None
        self.camera_candidate = None
        self.camera_candidate_since = None

    @property
    def state(self):
        return "HOME" if self.is_home else "AWAY"

    def update(self, door_open, now, real_now=None):
        """Record front-door edges without guessing direction from the door alone."""
        real_now = time.monotonic() if real_now is None else float(real_now)
        door_open = bool(door_open)

        if door_open and not self.previous_open:
            self.opened_at = now
            self.door_cycle_pending = False
            self.closed_at_real = None
        elif not door_open and self.previous_open and self.opened_at is not None:
            self.door_cycle_pending = True
            self.closed_at_real = real_now

        self.previous_open = door_open
        self._try_finalize(now, real_now)
        return self.state

    def observe_camera(self, object_detected, now, real_now=None):
        """Debounce camera detection and resolve a pending door cycle."""
        real_now = time.monotonic() if real_now is None else float(real_now)
        detected = bool(object_detected)

        if detected != self.camera_candidate:
            self.camera_candidate = detected
            self.camera_candidate_since = real_now
        else:
            confirm_seconds = self.presence_confirm_seconds if detected else self.absence_confirm_seconds
            if (
                self.camera_candidate_since is not None
                and real_now - self.camera_candidate_since >= confirm_seconds
            ):
                self.living_present = detected

        self._try_finalize(now, real_now)
        return self.state

    def _try_finalize(self, now, real_now):
        if not self.door_cycle_pending or self.closed_at_real is None:
            return
        if real_now - self.closed_at_real < self.post_close_delay_seconds:
            return
        if self.living_present is None:
            return
        if self.camera_candidate != self.living_present:
            return

        if self.living_present and not self.is_home:
            duration = 0 if self.outing_started_at is None else (now - self.outing_started_at).total_seconds()
            self.is_home = True
            self.events.emit(
                LifeEvent(
                    now,
                    "OUTING_END",
                    "entrance",
                    duration=duration,
                    reason="Front-door cycle followed by camera-confirmed living-room presence",
                )
            )
        elif not self.living_present and self.is_home:
            self.is_home = False
            self.outing_started_at = now
            self.events.emit(
                LifeEvent(
                    now,
                    "OUTING_START",
                    "entrance",
                    reason="Front-door cycle followed by camera-confirmed living-room absence",
                )
            )

        self.door_cycle_pending = False
        self.closed_at_real = None
        self.opened_at = None
