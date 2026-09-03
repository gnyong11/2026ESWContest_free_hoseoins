import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the live dashboard at the root URL", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /SafeNest/);
  assert.match(html, /Raspberry Pi 실시간 연동/);
  assert.match(html, /시연 제어판/);
  assert.doesNotMatch(html, /개발자 모드|시연 시나리오/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("server-renders the separate Raspberry Pi live dashboard", async () => {
  const response = await render("/live");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Raspberry Pi 실시간 연동/);
  assert.match(html, /시연 제어판/);
  assert.doesNotMatch(html, /개발자 모드|시연 시나리오/);
  assert.match(html, /Raspberry Pi API 연결/);
});

test("ships the MQTT, privacy camera, fixed safety rules, and API bridge", async () => {
  const [livePage, apiServer, cameraStream, fallDetector, config, styles, riskRules, privacyPolicy] = await Promise.all([
    readFile(new URL("../app/live/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/api_server.py", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/camera_stream.py", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/fall_detector.py", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/config.py", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/risk_rules.py", import.meta.url), "utf8"),
    readFile(new URL("../raspberry_pi/privacy_policy.py", import.meta.url), "utf8"),
  ]);

  assert.match(livePage, /\/api\/status/);
  assert.match(livePage, /\/api\/events/);
  assert.match(livePage, /LIVE_POLL_INTERVAL_MS = 100/);
  assert.match(livePage, /실제값 · 100ms 갱신/);
  assert.doesNotMatch(livePage, /title: "급성 이상행동 감지"/);
  assert.doesNotMatch(livePage, /평소와 다른 행동|SYNTHETIC_IQR_BASELINE|analyzeScenarioIqr/i);
  assert.match(livePage, /title: "화장실 장기 체류"/);
  assert.match(livePage, /title: "장시간 무활동"/);
  assert.match(livePage, /title: "침대 장시간 사용"/);
  assert.match(livePage, /title: "거실 쓰러짐 감지"/);
  assert.match(livePage, /20분 이상/);
  assert.match(livePage, /30분 이상/);
  assert.match(livePage, /90분 이상/);
  assert.match(livePage, /120분 이상/);
  assert.match(livePage, /12시간 이상/);
  assert.match(livePage, /1\.5초 미만 자세 전환/);
  assert.match(livePage, /api\/camera\/stream/);
  assert.match(livePage, /Camera Module 3 실시간 영상/);
  assert.match(livePage, /requestFullscreen/);
  assert.match(livePage, /onDoubleClick/);
  assert.match(livePage, /formatOutingDuration/);
  assert.match(livePage, /야간 외출 경과/);
  assert.match(livePage, /프라이버시 대기/);
  assert.match(cameraStream, /Transform\(vflip=True\)/);
  assert.match(cameraStream, /ScalerCrop/);
  assert.match(cameraStream, /SAFENEST_CAMERA_FULL_FOV/);
  assert.match(cameraStream, /FigureFallDetector/);
  assert.match(cameraStream, /cv2\.imencode/);
  assert.match(fallDetector, /cv2\.boundingRect/);
  assert.match(fallDetector, /FALL DETECTED/);
  assert.doesNotMatch(fallDetector, /drawContours/);
  assert.match(apiServer, /SafeNest MQTT analysis bridge/);
  assert.match(apiServer, /@app\.get\("\/api\/status"\)/);
  assert.match(apiServer, /@app\.get\("\/api\/events"\)/);
  assert.match(apiServer, /@app\.get\("\/api\/camera\/stream"\)/);
  assert.match(apiServer, /@app\.get\("\/api\/camera\/snapshot"\)/);
  assert.match(apiServer, /observe_camera/);
  assert.match(apiServer, /door_cycle_pending/);
  assert.match(apiServer, /"living":/);
  assert.match(apiServer, /living_room_camera_policy/);
  assert.match(apiServer, /evaluate_live_risk/);
  assert.match(apiServer, /"privacy_mode":/);
  assert.match(apiServer, /"night":/);
  const lifespanSource = apiServer.match(/async def lifespan[\s\S]*?yield/)?.[0] ?? "";
  assert.doesNotMatch(lifespanSource, /camera_stream\.start\(\)/);
  assert.match(cameraStream, /class CameraStream/);
  assert.match(cameraStream, /SAFENEST_CAMERA_FPS/);
  assert.match(styles, /status-camera-section/);
  assert.match(styles, /living-presence-card/);
  assert.match(styles, /outing-status\.night/);
  assert.match(styles, /object-fit: contain/);
  assert.match(config, /"front_door": "main_door"/);
  assert.match(config, /"bed_pressure": "pressure"/);
  assert.match(config, /bed_pressure_on: float = 2500\.0/);
  assert.match(config, /bedroom_presence_cm: float = 8\.7/);
  assert.match(config, /bathroom_presence_cm: float = 7\.1/);
  assert.match(config, /bedroom_idle_danger_seconds: float = 120 \* 60/);
  assert.match(riskRules, /bathroom_caution_seconds/);
  assert.match(riskRules, /inactivity_danger_seconds/);
  assert.match(privacyPolicy, /거실 재실 가능성 확인 중/);
});

test("keeps the root route unified with the live dashboard and social preview", async () => {
  const [page, livePage, layout, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/live/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    access(new URL("../public/og.png", import.meta.url)),
    access(new URL("../public/safenest-mark.png", import.meta.url)),
  ]);

  assert.match(page, /export \{ default \} from "\.\/live\/page"/);
  assert.match(livePage, /status-camera-section/);
  assert.match(livePage, /status-compact-clock/);
  assert.doesNotMatch(livePage, /analog-clock|status-digital-clock/);
  assert.match(livePage, /current-status-visual/);
  assert.match(styles, /flex: 0 0 92px/);
  assert.match(styles, /aspect-ratio: 1 \/ 1/);
  assert.match(layout, /SafeNest \| 독거인 생활 안전 모니터링/);
  assert.match(layout, /og\.png/);
});
