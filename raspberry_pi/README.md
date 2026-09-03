# SafeNest Raspberry Pi 실시간 연동본

이 폴더는 ESP32의 `SafeNest/sensor` MQTT 메시지를 받아 분석하고, 별도 `/live` 대시보드가 읽을 수 있는 HTTP API를 제공합니다.

## 데이터 흐름

```text
ESP32 → Mosquitto → Python 분석/FSM ┐
Camera Module 3 → OpenCV 낙상 분석 ├→ SQLite → HTTP API → /live 대시보드
```

## 현재 ESP32 JSON 규격

```json
{
  "main_door": 0,
  "bedroom_door": 0,
  "bathroom_door": 0,
  "pressure": 2500,
  "bedroom_distance": 10.7,
  "bathroom_distance": 9.1
}
```

- 문 센서는 `0=닫힘`, `1=열림`입니다.
- 침대는 `pressure >= 2500`일 때 사용 중, `pressure < 2500`일 때 미사용으로 판단합니다.
- 침실은 `8.7cm 이하`, 화장실은 `7.1cm 이하`일 때 재실 후보입니다.

## 라즈베리파이 설치

```bash
sudo apt update
sudo apt install -y python3-picamera2 rpicam-apps python3-opencv python3-numpy
cd raspberry_pi
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt
python api_server.py
```

정상적으로 실행되면 API는 기본적으로 `http://127.0.0.1:8000`에서 열립니다.

확인 주소:

- `http://127.0.0.1:8000/api/health`
- `http://127.0.0.1:8000/api/status`
- `http://127.0.0.1:8000/api/events`

`/live` 대시보드는 `/api/status`를 100ms마다 확인합니다. 실제 센서값이 바뀌는 속도는 ESP32의 MQTT 발행 주기를 넘을 수 없으므로 ESP32도 100~200ms 간격으로 발행하거나, 짧은 문 이벤트를 일정 시간 유지해 전송하는 방식을 권장합니다.

## 대시보드 실행

프로젝트 상위 폴더에서 별도 터미널을 열고 다음을 실행합니다.

```bash
pnpm install
pnpm dev
```

TigerVNC의 라즈베리파이 브라우저에서 다음 주소를 엽니다.

```text
http://localhost:3000/live
```

기존 모의 대시보드는 `http://localhost:3000/`에 그대로 남아 있습니다.

## 환경 설정

필요할 때 실행 전에 환경변수로 변경합니다.

```bash
export SAFENEST_MQTT_BROKER=localhost
export SAFENEST_MQTT_PORT=1883
export SAFENEST_MQTT_TOPIC=SafeNest/sensor
export SAFENEST_DATABASE_PATH=safenest.db
```

시연용 가상 시간을 사용하려면 다음을 추가합니다.

```bash
export SAFENEST_SIMULATION_MODE=true
export SAFENEST_TIME_SCALE=480
```

실제 운영에서는 `SAFENEST_SIMULATION_MODE`를 설정하지 않는 것이 기본입니다.

## Camera Module 3 영상

API 서버가 시작되면 Picamera2가 Camera Module 3를 640×360, 10fps로 한 번만 엽니다. 같은 프레임을 OpenCV 낙상 판정과 MJPEG 대시보드 송출이 함께 사용하므로 카메라 점유 충돌이 없습니다.

OpenCV는 Canny 윤곽선 중 가장 큰 고정 피규어를 잡고 바운딩 박스의 `가로/세로` 비율을 계산합니다. 서 있음에서 누운 형태로 1.5초 미만에 바뀌면 `FALL`로 판정합니다. 영상에는 원본 화면, 바운딩 박스, 현재 상태만 표시하며 윤곽선과 Edge 디버그 화면은 송출하지 않습니다.

```text
GET http://127.0.0.1:8000/api/camera/stream
GET http://127.0.0.1:8000/api/camera/snapshot
GET http://127.0.0.1:8000/api/camera/status
```

`/api/camera/snapshot`의 최신 JPEG 프레임은 추후 YOLO 추론 입력으로 재사용할 수 있습니다. 외부 카메라 프로세스를 붙이는 경우에는 기존 heartbeat 주소도 사용할 수 있습니다.

```text
POST http://127.0.0.1:8000/api/camera/heartbeat
```

`/api/status`와 `/api/camera/status`의 `detection` 필드에는 `state`, `fall_detected`, `ratio`, `bbox`가 포함됩니다.

## 현재 위험 판정 규칙

- R01 침대 장시간 사용: 12시간 이상 주의, 14시간 이상 위험
- R02 거실 쓰러짐 감지: 바운딩 박스가 1.5초 미만에 서 있음에서 누운 형태로 전환되면 즉시 위험
- 야간 외출: 위험도와 분리해 외출 경과시간과 함께 표시

## 현관문·거실 카메라 상태 결합

- 카메라는 현관 이동 판정 중이거나 거실 재실 가능성이 있을 때만 작동
- 외출 또는 침실·화장실 재실 확인 시 카메라를 끄고 프라이버시 대기
- 객체 감지 0.5초 유지: 거실 재실 확인
- 객체 미감지 1.5초 유지: 거실 미재실 확인
- 현관문 열림→닫힘 후 미재실: `OUTING_START`
- 현관문 열림→닫힘 후 재실: `OUTING_END`
- 문 동작 없이 카메라 객체가 사라진 경우에는 외출 상태로 변경하지 않음

R01부터 R02까지의 실제 주의·위험 판정은 Raspberry Pi API에서 SQLite 이벤트로 저장됩니다.

## 아직 포함되지 않은 기능

- 실제 SMS 발송
- YOLO 모델 추론

현재 낙상 판정은 고정 카메라와 단일 피규어를 전제로 한 OpenCV 규칙 기반 1단계입니다.
