# SafeNest Raspberry Pi 5 MVP

센서 데이터를 `전처리 → FSM → 지속시간 확인 → 고정 안전 규칙 → 위험 등급`으로 변환하고, 거실 카메라는 OpenCV 바운딩 박스의 자세 전환으로 쓰러짐을 감지합니다. 이 시스템은 질병을 진단하지 않습니다.

## 설치와 실행

Raspberry Pi 5에서 Python 3.9 이상을 사용합니다.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

기본 MQTT 설정은 `localhost:1883`, 토픽은 `SafeNest/sensor`입니다. 센서 JSON 필드명이 다르면 `config.py`의 `MQTT.fields` 오른쪽 값만 실제 필드명으로 변경합니다. 도어 센서는 기본적으로 `1=열림`, `0=닫힘`입니다.

## 센서 없는 검증

```bash
python main.py --run-tests
python -m unittest -v test_safenest.py
```

두 번째 명령은 필터, FSM, 고정 안전 규칙, 카메라 프라이버시 정책, OpenCV 자세 전환, SQLite를 자동 검증합니다.

## 시간과 임계값

`config.py`에서 센서 기준을 수정합니다. `SIMULATION_MODE=True`이면 생활 이벤트와 지속시간은 1초당 8분의 가상 시간을 사용합니다. MQTT 처리와 카메라의 1.5초 자세 전환 기준은 실제 시간을 사용합니다. 제품 모드에서는 `SIMULATION_MODE=False`로 바꿉니다.

도어 입력의 `door_debounce_seconds`도 실제 단조 시간을 사용하므로 시간 압축 배율의 영향을 받지 않습니다.

실시간 API는 화장실 20분/30분, 침실 무활동 90분/120분, 침대 12시간/14시간을 각각 `CAUTION`/`DANGER`로 판정하고, 거실 쓰러짐은 즉시 `DANGER`로 판정합니다. 야간 외출은 위험 점수와 분리된 상태 메시지로 제공합니다.

거실 카메라는 현관 출입 판정 중이거나 거실 재실 가능성이 있을 때만 켜지고, 외출 또는 침실·화장실 재실이 확인되면 꺼집니다.
