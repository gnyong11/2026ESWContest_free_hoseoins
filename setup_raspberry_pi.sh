#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE_VERSION="22.13.0"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[오류] $1 명령을 찾을 수 없습니다. RASPBERRY_PI_INSTALL.md를 확인하세요."
    exit 1
  fi
}

require_command python3
require_command node
require_command pnpm

NODE_VERSION="$(node -p 'process.versions.node')"
if [ "$(printf '%s\n' "$MIN_NODE_VERSION" "$NODE_VERSION" | sort -V | head -n 1)" != "$MIN_NODE_VERSION" ]; then
  echo "[오류] Node.js $MIN_NODE_VERSION 이상이 필요합니다. 현재 버전: $NODE_VERSION"
  exit 1
fi

echo "[1/5] Camera Module 3 라이브러리 확인"
if ! python3 -c 'import picamera2' >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    if [ "${EUID:-$(id -u)}" -eq 0 ]; then
      apt-get update
      apt-get install -y python3-picamera2 rpicam-apps
    else
      require_command sudo
      sudo apt-get update
      sudo apt-get install -y python3-picamera2 rpicam-apps
    fi
  else
    echo "[오류] Picamera2를 찾을 수 없습니다. Raspberry Pi OS Bookworm 환경인지 확인하세요."
    exit 1
  fi
fi

if ! python3 -c 'import cv2, numpy' >/dev/null 2>&1; then
  echo "OpenCV 낙상 분석 라이브러리를 설치합니다."
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    apt-get update
    apt-get install -y python3-opencv python3-numpy
  else
    require_command sudo
    sudo apt-get update
    sudo apt-get install -y python3-opencv python3-numpy
  fi
fi

echo "[2/5] Python 가상환경 생성"
python3 -m venv --system-site-packages "$ROOT_DIR/raspberry_pi/.venv"

echo "[3/5] Python 라이브러리 설치"
"$ROOT_DIR/raspberry_pi/.venv/bin/python" -m pip install --upgrade pip
"$ROOT_DIR/raspberry_pi/.venv/bin/python" -m pip install -r "$ROOT_DIR/raspberry_pi/requirements.txt"

echo "[4/5] 대시보드 라이브러리 설치"
cd "$ROOT_DIR"
pnpm install --frozen-lockfile

echo "[5/5] 대시보드 빌드"
pnpm build

echo
echo "설치가 완료됐습니다. 다음 명령으로 실행하세요."
echo "bash start_safenest.sh"
