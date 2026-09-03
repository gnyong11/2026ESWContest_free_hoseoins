"""Small thread-safe SQLite repository used by MQTT callbacks and analysis."""
import sqlite3
import threading


SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    sensor_id TEXT NOT NULL,
    location TEXT NOT NULL,
    value REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    location TEXT NOT NULL,
    duration REAL,
    value REAL,
    reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS daily_features (
    date TEXT PRIMARY KEY,
    wake_time TEXT,
    sleep_time TEXT,
    bed_duration REAL,
    bathroom_count INTEGER NOT NULL DEFAULT 0,
    bathroom_avg_duration REAL NOT NULL DEFAULT 0,
    bathroom_max_duration REAL NOT NULL DEFAULT 0,
    outing_count INTEGER NOT NULL DEFAULT 0,
    total_outing_duration REAL NOT NULL DEFAULT 0,
    activity_level INTEGER NOT NULL DEFAULT 0,
    longest_inactivity_duration REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS anomaly_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    risk_score INTEGER NOT NULL,
    risk_level TEXT NOT NULL,
    reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
"""


class Database:
    def __init__(self, path="safenest.db"):
        self.path = path
        self._lock = threading.Lock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.executescript(SCHEMA)
            self._connection.execute("PRAGMA optimize")
            self._connection.commit()

    def close(self):
        with self._lock:
            self._connection.close()

    def insert_raw(self, timestamp, sensor_id, location, value):
        with self._lock:
            self._connection.execute(
                "INSERT INTO raw_sensor_data(timestamp,sensor_id,location,value) VALUES(?,?,?,?)",
                (timestamp.isoformat(), sensor_id, location, float(value)))
            self._connection.commit()

    def insert_event(self, event):
        with self._lock:
            self._connection.execute(
                "INSERT INTO events(timestamp,event_type,location,duration,value,reason) VALUES(?,?,?,?,?,?)",
                (event.timestamp.isoformat(), event.event_type, event.location,
                 event.duration, event.value, event.reason))
            self._connection.commit()

    def events_between(self, start, end):
        with self._lock:
            return self._connection.execute(
                "SELECT * FROM events WHERE timestamp>=? AND timestamp<? ORDER BY timestamp",
                (start.isoformat(), end.isoformat())).fetchall()

    def recent_events(self, limit=50):
        safe_limit = max(1, min(int(limit), 200))
        with self._lock:
            return self._connection.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (safe_limit,)).fetchall()

    def recent_anomalies(self, limit=50):
        safe_limit = max(1, min(int(limit), 200))
        with self._lock:
            return self._connection.execute(
                "SELECT * FROM anomaly_events ORDER BY id DESC LIMIT ?", (safe_limit,)).fetchall()

    def upsert_daily_features(self, features):
        values = features.to_db_tuple()
        with self._lock:
            self._connection.execute("""
                INSERT OR REPLACE INTO daily_features
                (date,wake_time,sleep_time,bed_duration,bathroom_count,
                 bathroom_avg_duration,bathroom_max_duration,outing_count,
                 total_outing_duration,activity_level,longest_inactivity_duration)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""", values)
            self._connection.commit()

    def insert_anomaly(self, timestamp, anomaly_type, score, level, reasons):
        reason = "; ".join(reasons) if isinstance(reasons, list) else str(reasons)
        with self._lock:
            self._connection.execute(
                "INSERT INTO anomaly_events(timestamp,anomaly_type,risk_score,risk_level,reason) VALUES(?,?,?,?,?)",
                (timestamp.isoformat(), anomaly_type, score, level, reason))
            self._connection.commit()
