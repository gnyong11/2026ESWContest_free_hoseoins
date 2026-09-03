"""SafeNest MQTT analysis bridge exposed as a small Raspberry Pi HTTP API."""
from contextlib import asynccontextmanager
from datetime import datetime
import os
import threading
import time

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import config
from camera_stream import CameraStream
from database import Database
from mqtt_receiver import MQTTReceiver
from privacy_policy import living_room_camera_policy
from risk_rules import LiveRiskThresholds, evaluate_live_risk
from safenest_app import SafeNestApp


API_VERSION = "live-bridge-v6-privacy-rules"
ESP32_TIMEOUT_SECONDS = float(os.getenv("SAFENEST_ESP32_TIMEOUT", "3"))
CAMERA_TIMEOUT_SECONDS = float(os.getenv("SAFENEST_CAMERA_TIMEOUT", "3"))
LIVE_RISK_THRESHOLDS = LiveRiskThresholds(
    bathroom_caution_seconds=float(os.getenv(
        "SAFENEST_BATHROOM_CAUTION_SECONDS", str(config.FSM.bathroom_long_stay_seconds),
    )),
    bathroom_danger_seconds=float(os.getenv(
        "SAFENEST_BATHROOM_DANGER_SECONDS", str(config.FSM.bathroom_severe_stay_seconds),
    )),
    inactivity_caution_seconds=float(os.getenv(
        "SAFENEST_INACTIVITY_CAUTION_SECONDS", str(config.FSM.bedroom_idle_seconds),
    )),
    inactivity_danger_seconds=float(os.getenv(
        "SAFENEST_INACTIVITY_DANGER_SECONDS", str(config.FSM.bedroom_idle_danger_seconds),
    )),
    bed_caution_seconds=float(os.getenv("SAFENEST_BED_REST_CAUTION_SECONDS", str(12 * 60 * 60))),
    bed_danger_seconds=float(os.getenv("SAFENEST_BED_REST_DANGER_SECONDS", str(14 * 60 * 60))),
)


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


class DashboardBridge:
    def __init__(self, database=None):
        self.database = database or Database(config.DATABASE_PATH)
        self.app = SafeNestApp(database=self.database, echo=False)
        self.lock = threading.RLock()
        self.camera_policy_lock = threading.Lock()
        self.mqtt_connected = False
        self.mqtt_error = None
        self.last_received_at = None
        self.last_received_monotonic = None
        self.message_count = 0
        self.raw = {}
        self.sensor_last_seen = {}
        self.latest_analysis = None
        self.location = "unknown"
        self.location_confidence = "unknown"
        self.location_started_at = self.app.clock.virtual_now()
        self.bed_started_at = None
        self.camera_last_seen_monotonic = None
        self.camera_last_seen_at = None
        self.camera_detection = self._empty_camera_detection()
        self.camera_requested = False
        self.camera_policy_reason = "센서 데이터 대기 중"
        self.last_recorded_risk = None

    @staticmethod
    def _empty_camera_detection():
        return {
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

    def set_mqtt_connection(self, connected, error=None):
        with self.lock:
            self.mqtt_connected = bool(connected)
            self.mqtt_error = error
        if not connected:
            self._apply_camera_policy(False, "센서 연결 끊김 · 프라이버시 대기")

    def camera_heartbeat(self):
        with self.lock:
            self.camera_last_seen_monotonic = time.monotonic()
            self.camera_last_seen_at = datetime.now().astimezone()

    def handle_camera_detection(self, detection):
        now_mono = time.monotonic()
        with self.lock:
            self.camera_detection = dict(detection)
            timestamp = self.app.clock.virtual_now()
            entrance_state = self.app.entrance.observe_camera(
                bool(detection.get("object_detected")),
                timestamp,
                real_now=now_mono,
            )
            if self.latest_analysis is not None:
                self.latest_analysis["entrance"] = entrance_state
            self._update_location(self.latest_analysis, virtual_now=timestamp, now_mono=now_mono)
            self._record_new_risk(self._risk_snapshot(self.latest_analysis), timestamp)

    def handle_payload(self, incoming):
        now_mono = time.monotonic()
        with self.lock:
            canonical = self.app.canonicalize(incoming)
            self.raw.update(canonical)
            for canonical_name, external_name in config.MQTT.fields.items():
                if external_name in incoming:
                    self.sensor_last_seen[canonical_name] = now_mono

            analysis = self.app.handle_payload(incoming)
            self.latest_analysis = analysis
            self.last_received_at = datetime.now().astimezone()
            self.last_received_monotonic = now_mono
            self.message_count += 1
            self._update_location(analysis)
            self._record_new_risk(self._risk_snapshot(analysis), analysis["virtual_time"])
            camera_policy = self._camera_policy_locked(sensor_data_available=True)
        self._apply_camera_policy(*camera_policy)
        return analysis

    def _camera_policy_locked(self, sensor_data_available=None):
        if sensor_data_available is None:
            sensor_data_available = (
                self.last_received_monotonic is not None
                and time.monotonic() - self.last_received_monotonic <= ESP32_TIMEOUT_SECONDS
            )
        return living_room_camera_policy(
            sensor_data_available=sensor_data_available,
            resident_away=self.app.entrance.state == "AWAY",
            front_door_open=bool(self.app.latest.get("front_door")),
            door_cycle_pending=self.app.entrance.door_cycle_pending,
            bedroom_present=bool(self.app.latest.get("bedroom_present")),
            bathroom_present=bool(self.app.latest.get("bathroom_present")),
            bed_occupied=bool(self.app.latest.get("bed_occupied")),
        )

    def reconcile_camera_policy(self):
        with self.lock:
            policy = self._camera_policy_locked()
        self._apply_camera_policy(*policy)

    def _apply_camera_policy(self, should_run, reason):
        with self.camera_policy_lock:
            with self.lock:
                self.camera_requested = bool(should_run)
                self.camera_policy_reason = reason
            if should_run:
                if not camera_stream.running:
                    camera_stream.start()
                return

            if camera_stream.running:
                camera_stream.stop()
            with self.lock:
                self.camera_last_seen_monotonic = None
                self.camera_last_seen_at = None
                self.camera_detection = self._empty_camera_detection()
                self.app.entrance.living_present = None

    def _update_location(self, analysis, virtual_now=None, now_mono=None):
        virtual_now = virtual_now or (analysis["virtual_time"] if analysis else self.app.clock.virtual_now())
        now_mono = time.monotonic() if now_mono is None else float(now_mono)
        bathroom_state = analysis["bathroom"]["state"] if analysis else "EMPTY"
        bedroom_present = bool(self.app.latest.get("bedroom_present"))
        bathroom_present = bool(self.app.latest.get("bathroom_present"))
        bed_occupied = bool(self.app.latest.get("bed_occupied"))
        camera_available = (
            self.camera_last_seen_monotonic is not None
            and now_mono - self.camera_last_seen_monotonic <= CAMERA_TIMEOUT_SECONDS
        )
        living_present = camera_available and self.app.entrance.living_present is True

        if self.app.entrance.state == "AWAY":
            next_location, confidence = "outside", "confirmed"
        elif bathroom_present or bathroom_state not in {"EMPTY", "EXITING"}:
            next_location, confidence = "bathroom", "confirmed" if bathroom_present else "estimated"
        elif bedroom_present or bed_occupied:
            next_location, confidence = "bedroom", "confirmed"
        elif living_present:
            next_location, confidence = "living", "confirmed"
        else:
            next_location, confidence = "unknown", "unknown"

        if next_location != self.location:
            self.location = next_location
            self.location_confidence = confidence
            self.location_started_at = virtual_now
        else:
            self.location_confidence = confidence

        if bed_occupied and self.bed_started_at is None:
            self.bed_started_at = virtual_now
        elif not bed_occupied:
            self.bed_started_at = None

    def _bedroom_inactivity_seconds(self, virtual_now):
        if not self.app.latest.get("bedroom_present") or self.app.latest.get("bed_occupied"):
            return 0.0
        last_activity = self.app.bedroom.last_activity_at
        return 0.0 if last_activity is None else max(0.0, (virtual_now - last_activity).total_seconds())

    def _outside_seconds(self, virtual_now):
        if self.location != "outside":
            return 0.0
        return max(0.0, (virtual_now - self.location_started_at).total_seconds())

    def _risk_snapshot(self, analysis=None):
        analysis = analysis or self.latest_analysis
        if analysis is None:
            return {
                "level": "offline", "title": "센서 연결 대기",
                "summary": "ESP32 센서 메시지를 기다리고 있습니다.", "reasons": [],
            }

        virtual_now = analysis["virtual_time"]
        bed_seconds = max(0.0, (virtual_now - self.bed_started_at).total_seconds()) if self.bed_started_at else 0.0
        bathroom_seconds = float(analysis["bathroom"].get("duration", 0))
        inactivity_seconds = self._bedroom_inactivity_seconds(virtual_now)
        return evaluate_live_risk(
            fall_detected=bool(self.camera_detection.get("fall_detected")),
            fall_transition_seconds=self.camera_detection.get("transition_seconds", 0),
            fall_ratio=self.camera_detection.get("ratio", 0),
            bed_seconds=bed_seconds,
            bathroom_seconds=bathroom_seconds,
            inactivity_seconds=inactivity_seconds,
            thresholds=LIVE_RISK_THRESHOLDS,
        )

    def _record_new_risk(self, risk, timestamp):
        signature = (risk["level"], risk["title"])
        if risk["level"] not in {"caution", "danger"}:
            self.last_recorded_risk = None
            return
        if signature == self.last_recorded_risk:
            return
        score = 6 if risk["level"] == "danger" else 3
        anomaly_type = {
            "거실 쓰러짐 감지": "FALL_DETECTED",
            "침대 장시간 사용": "BED_LONG_REST",
            "화장실 장기 체류": "BATHROOM_LONG_STAY",
            "장시간 무활동": "LONG_INACTIVITY",
        }.get(risk["title"], "LIVE_RULE")
        self.database.insert_anomaly(timestamp, anomaly_type, score, risk["level"].upper(), risk["reasons"])
        self.last_recorded_risk = signature

    def _sensor_connected(self, name, now_mono):
        last_seen = self.sensor_last_seen.get(name)
        return last_seen is not None and now_mono - last_seen <= ESP32_TIMEOUT_SECONDS

    def status(self):
        self.reconcile_camera_policy()
        now_mono = time.monotonic()
        with self.lock:
            esp32_connected = (
                self.last_received_monotonic is not None
                and now_mono - self.last_received_monotonic <= ESP32_TIMEOUT_SECONDS
            )
            camera_info = camera_stream.status()
            camera_connected = camera_info["running"] or (
                self.camera_last_seen_monotonic is not None
                and now_mono - self.camera_last_seen_monotonic <= CAMERA_TIMEOUT_SECONDS
            )
            camera_detection_current = (
                self.camera_last_seen_monotonic is not None
                and now_mono - self.camera_last_seen_monotonic <= CAMERA_TIMEOUT_SECONDS
            )
            analysis = self.latest_analysis
            virtual_now = self.app.clock.virtual_now()
            self._update_location(analysis, virtual_now=virtual_now, now_mono=now_mono)
            bathroom = analysis["bathroom"] if analysis else {"state": "EMPTY", "duration": 0, "inactivity": 0}
            bedroom_distance = self.app.latest.get("bedroom_distance")
            bathroom_distance = self.app.latest.get("bathroom_distance")
            bed_occupied = bool(self.app.latest.get("bed_occupied"))
            bedroom_present = bool(self.app.latest.get("bedroom_present"))
            bathroom_present = bool(self.app.latest.get("bathroom_present"))
            location_seconds = max(0.0, (virtual_now - self.location_started_at).total_seconds()) if analysis else 0.0
            bed_seconds = max(0.0, (virtual_now - self.bed_started_at).total_seconds()) if self.bed_started_at else 0.0

            return {
                "api": {"connected": True, "version": API_VERSION, "server_time": _iso(datetime.now().astimezone())},
                "mqtt": {
                    "connected": self.mqtt_connected,
                    "broker": config.MQTT.broker,
                    "port": config.MQTT.port,
                    "topic": config.MQTT.topic,
                    "error": self.mqtt_error,
                },
                "esp32": {
                    "connected": esp32_connected,
                    "last_received_at": _iso(self.last_received_at) if self.last_received_at else None,
                    "message_count": self.message_count,
                },
                "camera": {
                    "connected": camera_connected,
                    "requested": self.camera_requested,
                    "privacy_mode": "active" if camera_info["running"] else "standby",
                    "privacy_reason": self.camera_policy_reason,
                    "last_seen_at": _iso(self.camera_last_seen_at) if self.camera_last_seen_at else None,
                    "stream_available": camera_info["running"],
                    "stream_path": "/api/camera/stream",
                    "snapshot_path": "/api/camera/snapshot",
                    "error": camera_info["error"],
                    "width": camera_info["width"],
                    "height": camera_info["height"],
                    "fps": camera_info["fps"],
                    "frame_count": camera_info["frame_count"],
                    "detection": camera_info["detection"],
                },
                "sensors": {
                    "main_door": {"connected": self._sensor_connected("front_door", now_mono), "open": bool(self.app.latest.get("front_door"))},
                    "bedroom_door": {"connected": self._sensor_connected("bedroom_door", now_mono), "open": bool(self.app.latest.get("bedroom_door"))},
                    "bathroom_door": {"connected": self._sensor_connected("bathroom_door", now_mono), "open": bool(self.app.latest.get("bathroom_door"))},
                    "pressure": {"connected": self._sensor_connected("bed_pressure", now_mono), "value": float(self.raw.get("bed_pressure", 0)), "occupied": bed_occupied},
                    "bedroom_distance": {
                        "connected": self._sensor_connected("bedroom_distance", now_mono),
                        "value_cm": bedroom_distance.distance if bedroom_distance and bedroom_distance.valid else None,
                        "present": bedroom_present,
                        "movement": bool(bedroom_distance and bedroom_distance.movement),
                    },
                    "bathroom_distance": {
                        "connected": self._sensor_connected("bathroom_distance", now_mono),
                        "value_cm": bathroom_distance.distance if bathroom_distance and bathroom_distance.valid else None,
                        "present": bathroom_present,
                        "movement": bool(bathroom_distance and bathroom_distance.movement),
                    },
                },
                "rooms": {
                    "location": self.location,
                    "confidence": self.location_confidence,
                    "location_seconds": location_seconds,
                    "bedroom": {
                        "present": bedroom_present,
                        "state": analysis["bedroom"] if analysis else "ROOM_EMPTY",
                        "inactivity_seconds": self._bedroom_inactivity_seconds(virtual_now),
                    },
                    "bathroom": {"present": bathroom_present, **bathroom},
                    "living": {
                        "present": camera_detection_current and self.app.entrance.living_present is True,
                        "camera_confirmed": camera_detection_current and self.app.entrance.living_present is not None,
                        "door_cycle_pending": self.app.entrance.door_cycle_pending,
                    },
                    "bed": {"occupied": bed_occupied, "duration_seconds": bed_seconds},
                    "outside": {
                        "active": self.location == "outside",
                        "night": self.location == "outside" and (virtual_now.hour >= 22 or virtual_now.hour < 6),
                        "started_at": _iso(self.app.entrance.outing_started_at) if self.app.entrance.outing_started_at else None,
                        "duration_seconds": self._outside_seconds(virtual_now),
                    },
                },
                "risk": self._risk_snapshot(analysis),
                "analysis": {
                    "virtual_time": _iso(virtual_now),
                    "simulation_mode": config.SIMULATION_MODE,
                    "time_scale": config.VIRTUAL_SECONDS_PER_REAL_SECOND if config.SIMULATION_MODE else 1,
                    "bathroom_state": bathroom["state"],
                    "bedroom_state": analysis["bedroom"] if analysis else "ROOM_EMPTY",
                    "entrance_state": self.app.entrance.state if analysis else "UNKNOWN",
                },
            }

    def events(self, limit=50):
        with self.lock:
            anomalies = [dict(row) for row in self.database.recent_anomalies(limit)]
            life_events = [dict(row) for row in self.database.recent_events(limit)]
        return {"anomalies": anomalies, "life_events": life_events}


bridge = DashboardBridge()
camera_stream = CameraStream(
    on_frame=bridge.camera_heartbeat,
    on_detection=bridge.handle_camera_detection,
)
receiver = MQTTReceiver(bridge.handle_payload, on_connection_change=bridge.set_mqtt_connection)


@asynccontextmanager
async def lifespan(_app):
    try:
        receiver.start(blocking=False)
    except Exception as exc:  # API remains available so the dashboard can show the failure.
        bridge.set_mqtt_connection(False, str(exc))
    yield
    try:
        receiver.stop()
    finally:
        camera_stream.stop()
        bridge.database.close()


app = FastAPI(title="SafeNest Raspberry Pi API", version=API_VERSION, lifespan=lifespan)
origins = [item.strip() for item in os.getenv(
    "SAFENEST_CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,https://safenest-iqr-prototype.whdydqja.chatgpt.site,https://safenest-iqr-prototype.eku5ds47.chatgpt.site",
).split(",") if item.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "version": API_VERSION}


@app.get("/api/status")
def status():
    return bridge.status()


@app.get("/api/events")
def events(limit: int = Query(default=50, ge=1, le=200)):
    return bridge.events(limit)


@app.post("/api/camera/heartbeat")
def camera_heartbeat():
    bridge.camera_heartbeat()
    return {"ok": True, "received_at": _iso(datetime.now().astimezone())}


@app.get("/api/camera/status")
def camera_status():
    return camera_stream.status()


@app.get("/api/camera/stream")
def camera_video_stream():
    if not camera_stream.running:
        raise HTTPException(status_code=503, detail=camera_stream.error or "카메라를 사용할 수 없습니다.")
    return StreamingResponse(
        camera_stream.mjpeg_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/api/camera/snapshot")
def camera_snapshot():
    frame = camera_stream.snapshot()
    if frame is None:
        raise HTTPException(status_code=503, detail=camera_stream.error or "카메라 프레임을 기다리고 있습니다.")
    return Response(content=frame, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


def main():
    import uvicorn
    uvicorn.run(
        "api_server:app",
        host=os.getenv("SAFENEST_API_HOST", "0.0.0.0"),
        port=int(os.getenv("SAFENEST_API_PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    main()
