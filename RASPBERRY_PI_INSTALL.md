# SafeNest Raspberry Pi 센서 안전 대시보드 설치 가이드

이 묶음은 ESP32 센서, Camera Module 3, OpenCV 쓰러짐 판정, MQTT 분석 서버와 SafeNest 대시보드를 Raspberry Pi에서 함께 실행합니다.

주요 변경 사항:

- 기본 주소(`/`)와 `/live` 화면 통합
- 아날로그 시계 제거, 상단에 작은 디지털 시각 표시
- 기존 시계 영역에 실시간 카메라 배치 및 더블클릭 전체화면
- 카메라 영상에는 피규어 바운딩 박스와 현재 상태만 표시
- 안전 상태 그래픽을 정원으로 고정
- 거실 카메라 객체 감지와 현관문 열림→닫힘을 결합한 외출·귀가 판정
- 위험 규칙: 화장실 장기 체류, 장시간 무활동, 침대 장시간 사용, 거실 쓰러짐 감지
- 야간 외출 상태와 외출 경과시간 별도 표시
- 거실 재실 가능성이 있을 때만 카메라를 켜는 프라이버시 정책

권장 환경은 Raspberry Pi 5와 64비트 Raspberry Pi OS Bookworm입니다.

## 1. 시스템 프로그램 설치

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip python3-picamera2 python3-opencv python3-numpy rpicam-apps mosquitto mosquitto-clients unzip
sudo systemctl enable --now mosquitto
```

Node.js `22.13.0` 이상과 `pnpm`이 필요합니다.

```bash
node -v
pnpm -v
```

`pnpm`만 없다면 다음을 실행합니다.

```bash
sudo npm install -g pnpm
```

Node.js 버전이 `22.13.0`보다 낮다면 Node.js 22 이상을 먼저 설치해야 합니다.

## 2. ESP32 MQTT 연결 설정

시연용 폐쇄 Wi-Fi에서만 익명 MQTT 연결을 사용합니다.

```bash
sudo nano /etc/mosquitto/conf.d/safenest.conf
```

다음 내용을 저장합니다.

```conf
listener 1883 0.0.0.0
allow_anonymous true
```

```bash
sudo systemctl restart mosquitto
hostname -I
```

ESP32 코드의 MQTT 서버 주소를 위에서 확인한 Raspberry Pi IP로 지정합니다.

```text
포트: 1883
토픽: SafeNest/sensor
```

## 3. 압축 해제 및 설치

`SafeNest-RaspberryPi-privacy-rules.tar.gz` 파일을 Raspberry Pi 홈 폴더로 복사한 뒤 실행합니다.

```bash
cd ~
tar -xzf SafeNest-RaspberryPi-privacy-rules.tar.gz
cd ~/SafeNest-RaspberryPi
bash setup_raspberry_pi.sh
```

패키지는 `esbuild`, `sharp`, `workerd` 설치 스크립트를 허용하도록 설정되어 있으므로 `ERR_PNPM_IGNORED_BUILDS` 문제를 별도로 승인할 필요가 없습니다.

## 4. 실행

```bash
cd ~/SafeNest-RaspberryPi
bash start_safenest.sh
```

Raspberry Pi 브라우저 또는 TigerVNC에서 다음 주소를 엽니다.

```text
http://127.0.0.1:3000/
```

`http://127.0.0.1:3000/live`도 동일한 화면입니다. 카메라 화면을 더블클릭하면 전체화면으로 전환되고 `Esc`를 누르면 돌아옵니다.

종료할 때는 실행 중인 터미널에서 `Ctrl+C`를 누릅니다.

## 5. 연결 확인

```bash
mosquitto_sub -h localhost -p 1883 -t "SafeNest/sensor" -v
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/status
curl http://127.0.0.1:8000/api/camera/status
```

카메라 인식과 원본 스트림도 확인할 수 있습니다.

```bash
rpicam-hello --list-cameras
rpicam-hello -t 5000
```

```text
http://127.0.0.1:8000/api/camera/stream
```

## 6. 센서 JSON 규격

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

- 문 센서: `0=닫힘`, `1=열림`
- 침대 사용: 압력값 `2500 이상`
- 침실 재실: 거리 `8.7cm 이하`
- 화장실 재실: 거리 `7.1cm 이하`
- 센서 화면 갱신: `100ms`

## 7. 위험 판정

- R01 화장실 장기 체류: 20분 이상 주의, 30분 이상 위험
- R02 장시간 무활동: 침실 재실 중 90분 이상 주의, 120분 이상 위험
- R03 침대 장시간 사용: 12시간 이상 주의, 14시간 이상 위험
- R04 거실 쓰러짐 감지: 서 있는 형태에서 누운 형태로 1.5초 미만에 변할 때 위험
- 야간 외출은 위험도와 분리해 외출 시간과 함께 표시

OpenCV는 가장 큰 피규어 영역을 선택하고 바운딩 박스 비율을 이용합니다. `W/H ≤ 0.80`은 서 있음, `W/H ≥ 1.10`은 누운 상태입니다. 실제 카메라의 1.5초 기준에는 화면의 시간 배속이 적용되지 않습니다.

## 8. 시연 제어

별도의 개발자 모드는 없습니다. 실제 센서값을 계속 수신하면서 시간 배속, 임의 행동·상황, 개별 센서 조작을 사용할 수 있습니다. 실제 화면으로 돌아갈 때는 `모의 상태 해제`를 누릅니다. 모의 값은 SQLite 기록과 실제 보호자 알림에 저장되지 않습니다.

## 9. 거실·외출·귀가 판정

- 현관 출입 판정 중이거나 침실·화장실·침대 센서가 모두 비어 있을 때만 카메라를 켭니다.
- 외출 또는 침실·화장실 재실이 확인되면 카메라를 끕니다.
- 카메라 객체 감지가 0.5초 이상 유지되면 거실 재실로 확인합니다.
- 객체 미감지가 1.5초 이상 유지되면 거실에 없는 것으로 확인합니다.
- 카메라 상태만으로는 외출이나 귀가를 변경하지 않습니다.
- 현관문이 열렸다 닫힌 뒤 객체가 없으면 외출로 확정합니다.
- 현관문이 열렸다 닫힌 뒤 객체가 있으면 귀가로 확정합니다.
- 카메라가 끊기거나 판정이 불안정하면 기존 재택·외출 상태를 유지합니다.

## 10. 문제 해결

```bash
cd ~/SafeNest-RaspberryPi
tail -n 100 logs/api.log
tail -n 100 logs/dashboard.log
```

- MQTT가 안 보임: ESP32의 Wi-Fi, Raspberry Pi IP, 포트 `1883`, 토픽 `SafeNest/sensor` 확인
- 센서값은 오는데 화면이 안 바뀜: JSON 필드 이름 확인
- 카메라 연결 안 됨: CSI 케이블 방향과 `rpicam-hello --list-cameras` 확인
- 대시보드 빌드 실패: Node.js 버전과 `logs/dashboard.log` 확인
- 외부 노트북에서 접속: `http://라즈베리파이IP:3000/?api=http://라즈베리파이IP:8000` 사용
