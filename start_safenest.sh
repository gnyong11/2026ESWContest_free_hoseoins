#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$ROOT_DIR/raspberry_pi/.venv/bin/python"
LOG_DIR="$ROOT_DIR/logs"

if [ ! -x "$PYTHON_BIN" ] || [ ! -d "$ROOT_DIR/node_modules" ] || [ ! -f "$ROOT_DIR/dist/server/index.js" ]; then
  echo "[오류] 설치가 완료되지 않았습니다. 먼저 bash setup_raspberry_pi.sh 를 실행하세요."
  exit 1
fi

mkdir -p "$LOG_DIR"

export SAFENEST_MQTT_BROKER="${SAFENEST_MQTT_BROKER:-127.0.0.1}"
export SAFENEST_MQTT_PORT="${SAFENEST_MQTT_PORT:-1883}"
export SAFENEST_MQTT_TOPIC="${SAFENEST_MQTT_TOPIC:-SafeNest/sensor}"
export SAFENEST_DATABASE_PATH="${SAFENEST_DATABASE_PATH:-$ROOT_DIR/raspberry_pi/safenest.db}"
export SAFENEST_API_HOST="${SAFENEST_API_HOST:-0.0.0.0}"
export SAFENEST_API_PORT="${SAFENEST_API_PORT:-8000}"
export SAFENEST_CAMERA_ENABLED="${SAFENEST_CAMERA_ENABLED:-true}"
export SAFENEST_CAMERA_WIDTH="${SAFENEST_CAMERA_WIDTH:-640}"
export SAFENEST_CAMERA_HEIGHT="${SAFENEST_CAMERA_HEIGHT:-360}"
export SAFENEST_CAMERA_FPS="${SAFENEST_CAMERA_FPS:-10}"

cleanup() {
  echo
  echo "SafeNest를 종료합니다."
  kill "${API_PID:-}" "${DASHBOARD_PID:-}" 2>/dev/null || true
  wait "${API_PID:-}" "${DASHBOARD_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR/raspberry_pi"
  exec "$PYTHON_BIN" api_server.py
) >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!

(
  cd "$ROOT_DIR"
  exec pnpm start --host 0.0.0.0
) >"$LOG_DIR/dashboard.log" 2>&1 &
DASHBOARD_PID=$!

echo "SafeNest가 실행됐습니다."
echo "대시보드: http://127.0.0.1:3000/"
echo "API 상태: http://127.0.0.1:8000/api/health"
echo "카메라 영상: http://127.0.0.1:8000/api/camera/stream"
echo "MQTT: $SAFENEST_MQTT_BROKER:$SAFENEST_MQTT_PORT / $SAFENEST_MQTT_TOPIC"
echo "종료하려면 Ctrl+C를 누르세요."

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$DASHBOARD_PID" 2>/dev/null; do
  sleep 1
done

echo "[오류] 구성 요소 하나가 종료되었습니다. logs 폴더를 확인하세요."
exit 1
