"""Separate real time (I/O, debounce, camera) from virtual lifestyle time."""
from datetime import datetime, timedelta
import time

import config


class SimulationClock:
    def __init__(self, simulation_mode=None, scale=None, virtual_start=None):
        self.simulation_mode = config.SIMULATION_MODE if simulation_mode is None else simulation_mode
        self.scale = scale or config.VIRTUAL_SECONDS_PER_REAL_SECOND
        self._real_start_mono = time.monotonic()
        self._virtual_start = virtual_start or datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    def real_monotonic(self):
        return time.monotonic()

    def real_now(self):
        return datetime.now()

    def virtual_now(self):
        if not self.simulation_mode:
            return self.real_now()
        elapsed = time.monotonic() - self._real_start_mono
        return self._virtual_start + timedelta(seconds=elapsed * self.scale)

    def advance_virtual(self, seconds):
        """Test helper: advance virtual time without sleeping."""
        self._virtual_start += timedelta(seconds=seconds)
