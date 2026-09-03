"""Mosquitto JSON receiver. paho-mqtt is the only optional runtime dependency."""
import json

import config


class MQTTReceiver:
    def __init__(self, on_payload, settings=config.MQTT, on_connection_change=None):
        self.on_payload = on_payload
        self.settings = settings
        self.on_connection_change = on_connection_change
        self.client = None

    def start(self, blocking=True):
        try:
            import paho.mqtt.client as mqtt
        except ImportError as exc:
            raise RuntimeError("Install MQTT support with: pip install paho-mqtt") from exc

        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:  # paho-mqtt 1.x compatibility
            self.client = mqtt.Client()
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.connect(self.settings.broker, self.settings.port, self.settings.keepalive)
        if blocking:
            self.client.loop_forever()
        else:
            self.client.loop_start()

    def stop(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        numeric_reason = getattr(reason_code, "value", reason_code)
        if int(numeric_reason) == 0:
            print(f"MQTT connected: {self.settings.broker}:{self.settings.port} topic={self.settings.topic}")
            client.subscribe(self.settings.topic)
            if self.on_connection_change:
                self.on_connection_change(True, None)
        else:
            print(f"MQTT connection failed: {reason_code}")
            if self.on_connection_change:
                self.on_connection_change(False, f"MQTT connection failed: {reason_code}")

    def _on_disconnect(self, client, userdata, *args):
        if self.on_connection_change:
            self.on_connection_change(False, "MQTT disconnected")

    def _on_message(self, client, userdata, message):
        try:
            payload = json.loads(message.payload.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON root must be an object")
            self.on_payload(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            print(f"MQTT payload ignored: {exc}")
