"""Camera Module 3 stream with shared OpenCV fall detection."""

from __future__ import annotations

import io
import os
import threading
import time
from typing import Callable, Iterator

import cv2

from fall_detector import FigureFallDetector


class StreamingOutput(io.BufferedIOBase):
    """Thread-safe latest JPEG buffer for the dashboard MJPEG response."""

    def __init__(self, on_frame: Callable[[], None] | None = None):
        super().__init__()
        self.condition = threading.Condition()
        self.frame: bytes | None = None
        self.sequence = 0
        self.frame_count = 0
        self.on_frame = on_frame

    def write(self, buffer):
        frame = bytes(buffer)
        with self.condition:
            self.frame = frame
            self.sequence += 1
            self.frame_count += 1
            self.condition.notify_all()
        if self.on_frame is not None:
            self.on_frame()
        return len(frame)

    def wait_for_frame(self, previous_sequence: int, timeout: float = 5.0):
        with self.condition:
            self.condition.wait_for(lambda: self.sequence != previous_sequence, timeout=timeout)
            return self.frame, self.sequence

    def latest_frame(self):
        with self.condition:
            return self.frame

    def wake_waiters(self):
        with self.condition:
            self.sequence += 1
            self.condition.notify_all()


class CameraStream:
    """Own one Picamera2 device, analyze each frame, and serve annotated JPEGs."""

    def __init__(
        self,
        on_frame: Callable[[], None] | None = None,
        on_detection: Callable[[dict], None] | None = None,
    ):
        self.width = int(os.getenv("SAFENEST_CAMERA_WIDTH", "640"))
        self.height = int(os.getenv("SAFENEST_CAMERA_HEIGHT", "360"))
        self.fps = int(os.getenv("SAFENEST_CAMERA_FPS", "10"))
        self.jpeg_quality = int(os.getenv("SAFENEST_CAMERA_JPEG_QUALITY", "82"))
        self.full_fov = os.getenv("SAFENEST_CAMERA_FULL_FOV", "true").lower() not in {
            "0", "false", "no", "off",
        }
        self.enabled = os.getenv("SAFENEST_CAMERA_ENABLED", "true").lower() not in {
            "0", "false", "no", "off",
        }
        self.output = StreamingOutput(on_frame=on_frame)
        self.on_detection = on_detection
        self.detector = FigureFallDetector()
        self._camera = None
        self._thread = None
        self._running = False
        self._error: str | None = "카메라 시작 대기"
        self._started_at: float | None = None
        self._sensor_mode: tuple[int, int] | None = None
        self._crop_limits: tuple[int, int, int, int] | None = None
        self._detection = self._empty_detection()
        self._lock = threading.RLock()

    @staticmethod
    def _empty_detection():
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

    @property
    def running(self):
        with self._lock:
            return self._running

    @property
    def error(self):
        with self._lock:
            return self._error

    def start(self):
        if not self.enabled:
            with self._lock:
                self._error = "SAFENEST_CAMERA_ENABLED 설정으로 비활성화됨"
            return False

        try:
            from libcamera import Transform
            from picamera2 import Picamera2

            camera = Picamera2()
            controls = {"FrameRate": self.fps}
            raw_configuration = {}

            if self.full_fov:
                modes = []
                for mode in camera.sensor_modes:
                    crop_value = mode.get("crop_limits")
                    if crop_value is None:
                        continue
                    crop = tuple(crop_value.to_tuple()) if hasattr(crop_value, "to_tuple") else tuple(crop_value)
                    size_value = mode.get("size")
                    size = tuple(size_value.to_tuple()) if hasattr(size_value, "to_tuple") else tuple(size_value)
                    modes.append((mode, crop, size))

                if modes:
                    largest_crop_area = max(crop[2] * crop[3] for _, crop, _ in modes)
                    full_field_modes = [item for item in modes if item[1][2] * item[1][3] == largest_crop_area]
                    fps_compatible = [item for item in full_field_modes if float(item[0].get("fps", 0)) >= self.fps]
                    selected_mode, selected_crop, selected_size = min(
                        fps_compatible or full_field_modes,
                        key=lambda item: item[2][0] * item[2][1],
                    )
                    raw_configuration = selected_mode
                    controls["ScalerCrop"] = selected_crop
                    self._sensor_mode = selected_size
                    self._crop_limits = selected_crop

            configuration = camera.create_video_configuration(
                main={"size": (self.width, self.height), "format": "RGB888"},
                raw=raw_configuration,
                controls=controls,
                transform=Transform(vflip=True),
                buffer_count=4,
            )
            camera.configure(configuration)
            camera.start()

            with self._lock:
                self._camera = camera
                self._running = True
                self._error = None
                self._started_at = time.monotonic()
                self._detection = self._empty_detection()
                self._thread = threading.Thread(target=self._capture_loop, name="safenest-camera", daemon=True)
                self._thread.start()
            return True
        except Exception as exc:
            with self._lock:
                self._running = False
                self._error = f"{type(exc).__name__}: {exc}"
            self._close_camera()
            return False

    def _capture_loop(self):
        try:
            while self.running:
                with self._lock:
                    camera = self._camera
                if camera is None:
                    break
                frame_rgb = camera.capture_array("main")
                frame_bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
                display, detection = self.detector.process(frame_bgr)
                encoded_ok, encoded = cv2.imencode(
                    ".jpg",
                    display,
                    [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality],
                )
                if not encoded_ok:
                    raise RuntimeError("OpenCV JPEG 인코딩 실패")
                with self._lock:
                    self._detection = detection
                self.output.write(encoded.tobytes())
                if self.on_detection is not None:
                    self.on_detection(dict(detection))
        except Exception as exc:
            with self._lock:
                self._running = False
                self._error = f"{type(exc).__name__}: {exc}"
        finally:
            self.output.wake_waiters()
            self._close_camera()

    def stop(self):
        with self._lock:
            self._running = False
            worker = self._thread
        self.output.wake_waiters()
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=3.0)
        self._close_camera()

    def _close_camera(self):
        with self._lock:
            camera = self._camera
            self._camera = None
            self._thread = None
        if camera is None:
            return
        try:
            camera.stop()
        except Exception:
            pass
        try:
            camera.close()
        except Exception:
            pass

    def status(self):
        with self._lock:
            running = self._running
            error = self._error
            started_at = self._started_at
            detection = dict(self._detection)
        return {
            "running": running,
            "error": error,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "full_fov": self.full_fov,
            "sensor_mode": self._sensor_mode,
            "crop_limits": self._crop_limits,
            "frame_count": self.output.frame_count,
            "uptime_seconds": max(0.0, time.monotonic() - started_at) if started_at else 0.0,
            "detection": detection,
        }

    def snapshot(self):
        return self.output.latest_frame()

    def mjpeg_frames(self) -> Iterator[bytes]:
        sequence = -1
        while self.running:
            frame, sequence = self.output.wait_for_frame(sequence)
            if frame is None:
                continue
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                + f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii")
                + frame
                + b"\r\n"
            )
