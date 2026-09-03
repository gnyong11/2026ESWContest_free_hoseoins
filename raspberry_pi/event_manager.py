"""Lifestyle event model and persistence helper."""
from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass
class LifeEvent:
    timestamp: datetime
    event_type: str
    location: str
    duration: Optional[float] = None
    value: Optional[float] = None
    reason: str = ""


class EventManager:
    def __init__(self, database=None, echo=True):
        self.database = database
        self.echo = echo
        self.emitted = []

    def emit(self, event):
        self.emitted.append(event)
        if self.database:
            self.database.insert_event(event)
        if self.echo:
            duration = "" if event.duration is None else f" duration={event.duration:.1f}s"
            print(f"[{event.timestamp:%H:%M:%S}] EVENT {event.event_type} "
                  f"location={event.location}{duration} reason={event.reason}")
        return event

