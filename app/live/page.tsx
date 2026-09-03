"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RiskLevel = "normal" | "caution" | "danger";
type ViewKey = "overview" | "rules" | "events" | "misc";
type ScenarioKey = "normal" | "bathroom" | "inactivity" | "nightExit" | "bedRest" | "fall";
type DeveloperScenarioKey = "live" | "manual" | ScenarioKey;
type BehaviorOffsetKey = "bedroomMove" | "bathroomMove" | "returnHome" | ScenarioKey;
type CheckState = "safe" | "watch" | "triggered";
type EventState = "new" | "checked" | "resolved";
type SimulationSpeed = 0 | 1 | 10 | 60 | 300 | 600;
type TrackedLocation = "unknown" | "living" | "bedroom" | "bathroom" | "outside";
type LocationConfidence = "unknown" | "confirmed" | "estimated";
type TransitionDoor = "exitDoorOpen" | "bedroomDoorOpen" | "bathroomDoorOpen";

type PendingTransition = {
  door: TransitionDoor;
  origin: TrackedLocation;
  startedAtSeconds: number;
};

type SensorState = {
  exitDoorOpen: boolean;
  bedroomDoorOpen: boolean;
  bathroomDoorOpen: boolean;
  pressureValue: number | null;
  bedOccupied: boolean;
  bedroomDistanceCm: number;
  bedroomDistanceChanged: boolean;
  bathroomDistanceCm: number;
  bathroomDistanceChanged: boolean;
  cameraConnected: boolean;
  fallDetected: boolean;
};

type DeveloperSensorState = {
  exitDoorOpen: boolean;
  bedroomDoorOpen: boolean;
  bathroomDoorOpen: boolean;
  bedroomPresent: boolean;
  bathroomPresent: boolean;
  bedOccupied: boolean;
  cameraConnected: boolean;
  fallDetected: boolean;
};

type Scenario = {
  label: string;
  description: string;
  room: string;
  sensors: SensorState;
  derived: {
    bathroomStayMinutes: number;
    inactivityMinutes: number;
    bedDurationMinutes: number;
    exitDoorOpenMinutes: number;
    bedroomDoorOpenMinutes: number;
    outsideMinutes: number;
    exitDoorOpen: boolean;
    bedroomDoorOpen: boolean;
    bathroomDoorOpen: boolean;
    bathroomOccupied: boolean;
    residentOutside: boolean;
    residentInBedroom: boolean;
    lastExitTransition: string;
    lastBedroomTransition: string;
    nightTime: boolean;
  };
  activity: number[];
};

type RuleCheck = {
  id: string;
  title: string;
  condition: string;
  reading: string;
  cautionCriteria: string;
  dangerCriteria: string;
  state: CheckState;
  level: RiskLevel;
};

type RiskResult = {
  level: RiskLevel;
  title: string;
  summary: string;
  action: string;
  checks: RuleCheck[];
};

type RiskEvent = {
  id: number;
  time: string;
  level: RiskLevel;
  title: string;
  room: string;
  evidence: string;
  state: EventState;
  source: "sample" | "session" | "live";
};

type LiveConnection = "connecting" | "online" | "offline";

type LiveStatus = {
  api: { connected: boolean; version: string; server_time: string };
  mqtt: { connected: boolean; broker: string; port: number; topic: string; error: string | null };
  esp32: { connected: boolean; last_received_at: string | null; message_count: number };
  camera: {
    connected: boolean;
    requested?: boolean;
    privacy_mode?: "active" | "standby";
    privacy_reason?: string;
    last_seen_at: string | null;
    stream_available?: boolean;
    stream_path?: string;
    snapshot_path?: string;
    error?: string | null;
    width?: number;
    height?: number;
    fps?: number;
    frame_count?: number;
    detection?: {
      object_detected: boolean;
      raw_state: "STANDING" | "TRANSITION" | "FALLEN" | "UNKNOWN";
      state: "STANDING" | "TRANSITION" | "FALLEN" | "UNKNOWN";
      label: string;
      fall_detected: boolean;
      last_event: "FALL" | "NORMAL_LYING" | null;
      ratio: number;
      transition_seconds: number;
      bbox: { x: number; y: number; width: number; height: number } | null;
    };
  };
  sensors: {
    main_door: { connected: boolean; open: boolean };
    bedroom_door: { connected: boolean; open: boolean };
    bathroom_door: { connected: boolean; open: boolean };
    pressure: { connected: boolean; value: number; occupied: boolean };
    bedroom_distance: { connected: boolean; value_cm: number | null; present: boolean; movement: boolean };
    bathroom_distance: { connected: boolean; value_cm: number | null; present: boolean; movement: boolean };
  };
  rooms: {
    location: TrackedLocation;
    confidence: LocationConfidence;
    location_seconds: number;
    bedroom: { present: boolean; state: string; inactivity_seconds: number };
    bathroom: { present: boolean; state: string; duration: number; inactivity: number };
    living: { present: boolean; camera_confirmed: boolean; door_cycle_pending: boolean };
    bed: { occupied: boolean; duration_seconds: number };
    outside: { active: boolean; night: boolean; started_at: string | null; duration_seconds: number };
  };
  risk: { level: RiskLevel | "offline"; title: string; summary: string; reasons: string[] };
  analysis: {
    virtual_time: string;
    simulation_mode: boolean;
    time_scale: number;
    bathroom_state: string;
    bedroom_state: string;
    entrance_state: string;
  };
};

type LiveEventResponse = {
  anomalies: Array<{
    id: number;
    timestamp: string;
    anomaly_type: string;
    risk_level: string;
    reason: string;
  }>;
};

const SENSOR_RULES = {
  pressureOccupiedAtOrAbove: 2500,
  bedroomEmptyDistanceCm: 10.7,
  bathroomEmptyDistanceCm: 9.1,
  bedroomPresenceMaxCm: 8.7,
  bathroomPresenceMaxCm: 7.1,
  confirmationSamples: 2,
} as const;

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_SAFENEST_API_BASE ?? "http://127.0.0.1:8000";
const LIVE_POLL_INTERVAL_MS = 100;

const DEFAULT_DEVELOPER_SENSORS: DeveloperSensorState = {
  exitDoorOpen: false,
  bedroomDoorOpen: false,
  bathroomDoorOpen: false,
  bedroomPresent: false,
  bathroomPresent: false,
  bedOccupied: false,
  cameraConnected: false,
  fallDetected: false,
};

const SIMULATION_SPEEDS: SimulationSpeed[] = [0, 1, 60, 300, 600];

const scenarios: Record<ScenarioKey, Scenario> = {
  normal: {
    label: "정상 생활",
    description: "사람이 없을 때 실제 측정한 정상 기준값",
    room: "스마트홈",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: null,
      bedOccupied: false,
      bedroomDistanceCm: 10.7,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 9.1,
      bathroomDistanceChanged: false,
      cameraConnected: true,
      fallDetected: false,
    },
    derived: {
      bathroomStayMinutes: 0,
      inactivityMinutes: 2,
      bedDurationMinutes: 0,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 0,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: false,
      residentOutside: false,
      residentInBedroom: false,
      lastExitTransition: "초기 상태: 집 안",
      lastBedroomTransition: "초기 상태: 침실 밖",
      nightTime: false,
    },
    activity: [34, 51, 43, 67, 58, 74, 62, 81, 69, 77, 64, 72],
  },
  bathroom: {
    label: "화장실 장기 체류",
    description: "18분부터 시작해 20분 주의·30분 위험으로 전환",
    room: "화장실",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: null,
      bedOccupied: false,
      bedroomDistanceCm: 10.7,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 6.8,
      bathroomDistanceChanged: false,
      cameraConnected: false,
      fallDetected: false,
    },
    derived: {
      bathroomStayMinutes: 18,
      inactivityMinutes: 18,
      bedDurationMinutes: 0,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 0,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: true,
      residentOutside: false,
      residentInBedroom: false,
      lastExitTransition: "초기 상태: 집 안",
      lastBedroomTransition: "초기 상태: 침실 밖",
      nightTime: false,
    },
    activity: [52, 47, 39, 31, 24, 18, 12, 8, 5, 3, 2, 1],
  },
  inactivity: {
    label: "침실 장시간 무반응",
    description: "85분부터 시작해 90분 주의·120분 위험으로 전환",
    room: "침실",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: null,
      bedOccupied: false,
      bedroomDistanceCm: 8.2,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 9.1,
      bathroomDistanceChanged: false,
      cameraConnected: false,
      fallDetected: false,
    },
    derived: {
      bathroomStayMinutes: 0,
      inactivityMinutes: 85,
      bedDurationMinutes: 0,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 0,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: false,
      residentOutside: false,
      residentInBedroom: true,
      lastExitTransition: "초기 상태: 집 안",
      lastBedroomTransition: "초기 상태: 침실 밖",
      nightTime: false,
    },
    activity: [61, 48, 37, 26, 18, 12, 7, 4, 2, 1, 0, 0],
  },
  nightExit: {
    label: "야간 외출",
    description: "외부 출입문을 열고 나간 뒤 1분부터 외출 시간을 가속",
    room: "외부 출입문",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: null,
      bedOccupied: false,
      bedroomDistanceCm: 10.7,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 9.1,
      bathroomDistanceChanged: false,
      cameraConnected: false,
      fallDetected: false,
    },
    derived: {
      bathroomStayMinutes: 0,
      inactivityMinutes: 12,
      bedDurationMinutes: 0,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 1,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: false,
      residentOutside: true,
      residentInBedroom: false,
      lastExitTransition: "외출",
      lastBedroomTransition: "초기 상태: 침실 밖",
      nightTime: true,
    },
    activity: [4, 3, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0],
  },
  bedRest: {
    label: "침대 12시간 사용",
    description: "침대 사용 12시간부터 시작해 장시간 침상 주의·위험을 시연",
    room: "침실",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: 2800,
      bedOccupied: true,
      bedroomDistanceCm: 8.2,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 9.1,
      bathroomDistanceChanged: false,
      cameraConnected: false,
      fallDetected: false,
    },
    derived: {
      bathroomStayMinutes: 0,
      inactivityMinutes: 0,
      bedDurationMinutes: 12 * 60,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 0,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: false,
      residentOutside: false,
      residentInBedroom: true,
      lastExitTransition: "초기 상태: 집 안",
      lastBedroomTransition: "침대 사용 중",
      nightTime: false,
    },
    activity: [12, 8, 5, 3, 2, 1, 0, 0, 0, 0, 0, 0],
  },
  fall: {
    label: "거실 쓰러짐",
    description: "카메라가 1.5초 미만의 급격한 자세 전환을 감지한 상태",
    room: "거실",
    sensors: {
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      pressureValue: 0,
      bedOccupied: false,
      bedroomDistanceCm: 10.7,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: 9.1,
      bathroomDistanceChanged: false,
      cameraConnected: true,
      fallDetected: true,
    },
    derived: {
      bathroomStayMinutes: 0,
      inactivityMinutes: 0,
      bedDurationMinutes: 0,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: 0,
      exitDoorOpen: false,
      bedroomDoorOpen: false,
      bathroomDoorOpen: false,
      bathroomOccupied: false,
      residentOutside: false,
      residentInBedroom: false,
      lastExitTransition: "집 안",
      lastBedroomTransition: "침실 밖",
      nightTime: false,
    },
    activity: [18, 11, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0],
  },
};

const initialEvents: RiskEvent[] = [];

function levelRank(level: RiskLevel) {
  return level === "danger" ? 2 : level === "caution" ? 1 : 0;
}

function evaluateRisk(scenario: Scenario): RiskResult {
  const { sensors, derived } = scenario;
  const bathroomDanger = derived.bathroomOccupied && derived.bathroomStayMinutes >= 30;
  const bathroomCaution = derived.bathroomOccupied && derived.bathroomStayMinutes >= 20;
  const inactivityDanger = derived.residentInBedroom && !sensors.bedOccupied && derived.inactivityMinutes >= 120;
  const inactivityCaution = derived.residentInBedroom && !sensors.bedOccupied && derived.inactivityMinutes >= 90;
  const bedRestDanger = sensors.bedOccupied && derived.bedDurationMinutes >= 14 * 60;
  const bedRestCaution = sensors.bedOccupied && derived.bedDurationMinutes >= 12 * 60;
  const fallDanger = sensors.cameraConnected && sensors.fallDetected;

  const checks: RuleCheck[] = [
    {
      id: "bathroom-stay",
      title: "화장실 장기 체류",
      condition: "화장실 초음파 재실 상태가 문이 닫힌 채 연속 유지될 때",
      reading: derived.bathroomOccupied ? `화장실 체류 ${formatDuration(derived.bathroomStayMinutes * 60)}` : "화장실 미재실",
      cautionCriteria: "20분 이상",
      dangerCriteria: "30분 이상",
      state: bathroomDanger ? "triggered" : bathroomCaution ? "watch" : "safe",
      level: bathroomDanger ? "danger" : bathroomCaution ? "caution" : "normal",
    },
    {
      id: "inactivity",
      title: "장시간 무활동",
      condition: "침실 재실 중 침대는 사용하지 않고 초음파 거리 변화가 없을 때",
      reading: derived.residentInBedroom && !sensors.bedOccupied
        ? `무활동 ${formatDuration(derived.inactivityMinutes * 60)}`
        : "무활동 판정 대상 아님",
      cautionCriteria: "90분 이상",
      dangerCriteria: "120분 이상",
      state: inactivityDanger ? "triggered" : inactivityCaution ? "watch" : "safe",
      level: inactivityDanger ? "danger" : inactivityCaution ? "caution" : "normal",
    },
    {
      id: "bed-rest",
      title: "침대 장시간 사용",
      condition: "FSR402 압력 2500 이상 상태가 장시간 연속 유지될 때",
      reading: sensors.bedOccupied
        ? `침대 사용 ${formatDuration(derived.bedDurationMinutes * 60)}`
        : "침대 미사용",
      cautionCriteria: "12시간 이상",
      dangerCriteria: "14시간 이상",
      state: bedRestDanger ? "triggered" : bedRestCaution ? "watch" : "safe",
      level: bedRestDanger ? "danger" : bedRestCaution ? "caution" : "normal",
    },
    {
      id: "fall",
      title: "거실 쓰러짐 감지",
      condition: "카메라 바운딩 박스가 서 있음에서 누운 형태로 1.5초 미만에 전환될 때",
      reading: !sensors.cameraConnected
        ? "카메라 연결 대기"
        : sensors.fallDetected ? "급격한 자세 전환 · 쓰러짐" : "피규어 상태 정상",
      cautionCriteria: "별도 주의 단계 없음",
      dangerCriteria: "1.5초 미만 자세 전환",
      state: fallDanger ? "triggered" : "safe",
      level: fallDanger ? "danger" : "normal",
    },
  ];

  const highest = checks.reduce<RiskLevel>(
    (current, check) => (levelRank(check.level) > levelRank(current) ? check.level : current),
    "normal",
  );
  const primary = checks.reduce<RuleCheck | undefined>(
    (current, check) => check.level === highest ? check : current,
    undefined,
  );

  if (highest === "danger") {
    return {
      level: "danger",
      title: primary?.title ?? "위험 상황 감지",
      summary: `${scenario.room}에서 보호자 확인이 필요한 위험 조건이 충족되었습니다.`,
      action: "보호자에게 즉시 알리고 전화로 상태를 확인하세요.",
      checks,
    };
  }
  if (highest === "caution") {
    return {
      level: "caution",
      title: primary?.title ?? "주의 상황 감지",
      summary: "위험 기준에 가까워지고 있어 추가 센서 데이터를 확인하고 있습니다.",
      action: "상태가 지속되면 보호자 알림 단계로 전환합니다.",
      checks,
    };
  }
  return {
    level: "normal",
    title: "생활 상태 정상",
    summary: "현재 주의 또는 위험 조건에 해당하는 센서 상태가 없습니다.",
    action: "별도의 확인이 필요하지 않습니다.",
    checks,
  };
}

function levelLabel(level: RiskLevel) {
  return level === "danger" ? "위험" : level === "caution" ? "주의" : "정상";
}

function checkLabel(state: CheckState) {
  return state === "triggered" ? "위험 충족" : state === "watch" ? "관찰 중" : "해당 없음";
}

function eventStateLabel(state: EventState) {
  return state === "new" ? "신규" : state === "checked" ? "확인함" : "종료";
}

function formatClock(date: Date | null) {
  if (!date) return "--:--:--";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(totalSeconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
}

function formatOutingDuration(totalSeconds: number) {
  const wholeMinutes = Math.max(0, Math.floor(totalSeconds / 60));
  return `${Math.floor(wholeMinutes / 60)}시간 ${wholeMinutes % 60}분`;
}

function locationLabel(location: TrackedLocation, confidence: LocationConfidence) {
  if (location === "unknown") return "위치 확인 중";
  const label = location === "living" ? "거실" : location === "bedroom" ? "침실" : location === "bathroom" ? "화장실" : "외출 중";
  return `${label} · ${confidence === "confirmed" ? "확정" : "추정"}`;
}

function liveStatusToScenario(status: LiveStatus): Scenario {
  const bedroomDistance = status.sensors.bedroom_distance;
  const bathroomDistance = status.sensors.bathroom_distance;
  return {
    label: "실제 센서 수신",
    description: "Raspberry Pi 분석 API에서 받은 최신 상태",
    room: locationLabel(status.rooms.location, status.rooms.confidence),
    sensors: {
      exitDoorOpen: status.sensors.main_door.open,
      bedroomDoorOpen: status.sensors.bedroom_door.open,
      bathroomDoorOpen: status.sensors.bathroom_door.open,
      pressureValue: status.sensors.pressure.value,
      bedOccupied: status.sensors.pressure.occupied,
      bedroomDistanceCm: bedroomDistance.value_cm ?? SENSOR_RULES.bedroomEmptyDistanceCm,
      bedroomDistanceChanged: bedroomDistance.movement,
      bathroomDistanceCm: bathroomDistance.value_cm ?? SENSOR_RULES.bathroomEmptyDistanceCm,
      bathroomDistanceChanged: bathroomDistance.movement,
      cameraConnected: status.camera.connected,
      fallDetected: Boolean(status.camera.detection?.fall_detected),
    },
    derived: {
      bathroomStayMinutes: Math.floor(status.rooms.bathroom.duration / 60),
      inactivityMinutes: Math.floor(status.rooms.bedroom.inactivity_seconds / 60),
      bedDurationMinutes: status.rooms.bed.duration_seconds / 60,
      exitDoorOpenMinutes: 0,
      bedroomDoorOpenMinutes: 0,
      outsideMinutes: Math.floor(status.rooms.outside.duration_seconds / 60),
      exitDoorOpen: status.sensors.main_door.open,
      bedroomDoorOpen: status.sensors.bedroom_door.open,
      bathroomDoorOpen: status.sensors.bathroom_door.open,
      bathroomOccupied: status.rooms.bathroom.present,
      residentOutside: status.rooms.outside.active,
      residentInBedroom: status.rooms.location === "bedroom",
      lastExitTransition: status.analysis.entrance_state,
      lastBedroomTransition: status.analysis.bedroom_state,
      nightTime: status.rooms.outside.night,
    },
    activity: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
}

function SensorCard({
  code,
  name,
  value,
  detail,
  state = "normal",
}: {
  code: string;
  name: string;
  value: string;
  detail: string;
  state?: "normal" | "active" | "error";
}) {
  return (
    <article className={`sensor-card ${state}`} tabIndex={0} title={`${name}: ${value}`}>
      <div className="sensor-card-head">
        <span className="sensor-code">{code}</span>
        <span className="sensor-state-dot" aria-hidden="true" />
      </div>
      <span className="sensor-name">{name}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default function Home() {
  const [view, setView] = useState<ViewKey>("overview");
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>("normal");
  const [simulationBase, setSimulationBase] = useState<number | null>(null);
  const [simulationSeconds, setSimulationSeconds] = useState(0);
  const [simulationSpeed, setSimulationSpeed] = useState<SimulationSpeed>(1);
  const [events, setEvents] = useState<RiskEvent[]>(initialEvents);
  const [notice, setNotice] = useState("알림 테스트");
  const [developerScenarioKey, setDeveloperScenarioKey] = useState<DeveloperScenarioKey>("live");
  const demoOverlayActive = developerScenarioKey !== "live";
  const [behaviorAction, setBehaviorAction] = useState("선택 대기");
  const [developerSensors, setDeveloperSensors] = useState<DeveloperSensorState>({ ...DEFAULT_DEVELOPER_SENSORS });
  const [trackedLocation, setTrackedLocation] = useState<TrackedLocation>("unknown");
  const [locationConfidence, setLocationConfidence] = useState<LocationConfidence>("unknown");
  const [locationStartedAtSeconds, setLocationStartedAtSeconds] = useState(0);
  const [locationBaseSeconds, setLocationBaseSeconds] = useState(0);
  const [bedStartedAtSeconds, setBedStartedAtSeconds] = useState<number | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null);
  const [resolvedTransitionDoor, setResolvedTransitionDoor] = useState<TransitionDoor | null>(null);
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [apiDraft, setApiDraft] = useState(DEFAULT_API_BASE);
  const [liveConnection, setLiveConnection] = useState<LiveConnection>("connecting");
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [cameraStreamFailed, setCameraStreamFailed] = useState(false);
  const [cameraStreamAttempt, setCameraStreamAttempt] = useState(0);
  const cameraFeedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const queryApi = new URLSearchParams(window.location.search).get("api");
    const savedApi = window.localStorage.getItem("safenest-live-api");
    const resolvedApi = queryApi || savedApi || DEFAULT_API_BASE;
    const normalizedApi = resolvedApi.replace(/\/$/, "");
    const timer = window.setTimeout(() => {
      setApiBase(normalizedApi);
      setApiDraft(normalizedApi);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const loadStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`${apiBase}/api/status`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as LiveStatus;
        if (disposed) return;
        setLiveStatus(payload);
        setLiveConnection("online");
        setLiveError(null);
      } catch (error) {
        if (disposed) return;
        setLiveConnection("offline");
        setLiveError(error instanceof Error ? error.message : "API 연결 실패");
      } finally {
        inFlight = false;
      }
    };

    void loadStatus();
    const timer = window.setInterval(loadStatus, LIVE_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [apiBase]);

  useEffect(() => {
    if (liveConnection !== "online") return;
    let disposed = false;

    const loadEvents = async () => {
      try {
        const response = await fetch(`${apiBase}/api/events?limit=50`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as LiveEventResponse;
        if (disposed) return;
        const mapped: RiskEvent[] = payload.anomalies.map((event) => {
          const normalizedLevel = event.risk_level.toLowerCase() === "danger" ? "danger" : "caution";
          const timestamp = new Date(event.timestamp);
          return {
            id: event.id,
            time: Number.isNaN(timestamp.getTime()) ? event.timestamp : `오늘 ${formatClock(timestamp).slice(0, 5)}`,
            level: normalizedLevel,
            title: event.anomaly_type === "FALL_DETECTED"
              ? "거실 쓰러짐 감지"
              : event.anomaly_type === "BED_LONG_REST" ? "침대 장시간 사용" : "생활 위험 판정",
            room: event.anomaly_type === "FALL_DETECTED" ? "거실" : event.anomaly_type === "BED_LONG_REST" ? "침실" : "Raspberry Pi",
            evidence: event.reason || "저장된 위험 판정",
            state: "new",
            source: "live",
          };
        });
        setEvents((current) => [...current.filter((event) => event.source === "session"), ...mapped]);
      } catch {
        // Status polling owns the visible connection error.
      }
    };

    void loadEvents();
    const timer = window.setInterval(loadEvents, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [apiBase, liveConnection]);

  useEffect(() => {
    setCameraStreamFailed(false);
    setCameraStreamAttempt((value) => value + 1);
  }, [apiBase, liveStatus?.camera.stream_available]);

  useEffect(() => {
    if (!cameraStreamFailed) return;
    const timer = window.setTimeout(() => {
      setCameraStreamFailed(false);
      setCameraStreamAttempt((value) => value + 1);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [cameraStreamFailed]);

  useEffect(() => {
    setSimulationBase(Date.now());
    setSimulationSeconds(0);
  }, [scenarioKey]);

  useEffect(() => {
    if (simulationSpeed === 0) return;
    let animationFrame = 0;
    let previousTime = window.performance.now();

    const advanceSimulation = (currentTime: number) => {
      const elapsedRealSeconds = Math.min((currentTime - previousTime) / 1000, 0.25);
      previousTime = currentTime;
      setSimulationSeconds((value) => value + elapsedRealSeconds * simulationSpeed);
      animationFrame = window.requestAnimationFrame(advanceSimulation);
    };

    animationFrame = window.requestAnimationFrame(advanceSimulation);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [simulationSpeed]);

  const baseScenario = scenarios[scenarioKey];
  const acceleratedMinutes = Math.floor(simulationSeconds / 60);
  const scenario = useMemo(() => {
    const next: Scenario = {
      ...baseScenario,
      sensors: { ...baseScenario.sensors },
      derived: { ...baseScenario.derived },
      activity: [...baseScenario.activity],
    };

    if (scenarioKey === "bathroom") {
      next.derived.bathroomStayMinutes += acceleratedMinutes;
      next.derived.inactivityMinutes += acceleratedMinutes;
    } else if (scenarioKey === "inactivity") {
      next.derived.inactivityMinutes += acceleratedMinutes;
    } else if (scenarioKey === "nightExit") {
      next.derived.outsideMinutes += acceleratedMinutes;
      next.derived.inactivityMinutes += acceleratedMinutes;
    } else if (scenarioKey === "bedRest") {
      next.derived.bedDurationMinutes += acceleratedMinutes;
    }

    return next;
  }, [acceleratedMinutes, baseScenario, scenarioKey]);
  const simulatedNow = useMemo(
    () => (simulationBase === null ? null : new Date(simulationBase + simulationSeconds * 1000)),
    [simulationBase, simulationSeconds],
  );
  const liveNow = liveStatus ? new Date(liveStatus.analysis.virtual_time) : null;
  const displayedNow = demoOverlayActive ? simulatedNow : liveNow;
  const locationElapsedSeconds = trackedLocation === "unknown"
    ? 0
    : locationBaseSeconds + Math.max(0, simulationSeconds - locationStartedAtSeconds);
  const bedElapsedSeconds = bedStartedAtSeconds === null
    ? 0
    : Math.max(0, simulationSeconds - bedStartedAtSeconds);
  const developerLocation = pendingTransition
    ? "이동 확인 중"
    : locationLabel(trackedLocation, locationConfidence);
  const developerBedroomDistance = developerSensors.bedroomPresent ? 8.6 : 10.7;
  const developerBathroomDistance = developerSensors.bathroomPresent ? 7.0 : 9.1;
  const developerConflict =
    (developerSensors.bedroomPresent && developerSensors.bathroomPresent) ||
    (developerSensors.exitDoorOpen && (developerSensors.bedroomPresent || developerSensors.bathroomPresent || developerSensors.bedOccupied));

  const manualScenario = useMemo<Scenario>(() => ({
    label: "수동 센서 조작",
    description: "실제 센서 수신과 별개로 화면에 적용한 시연 센서 조합",
    room: developerLocation,
    sensors: {
      exitDoorOpen: developerSensors.exitDoorOpen,
      bedroomDoorOpen: developerSensors.bedroomDoorOpen,
      bathroomDoorOpen: developerSensors.bathroomDoorOpen,
      pressureValue: null,
      bedOccupied: developerSensors.bedOccupied,
      bedroomDistanceCm: developerBedroomDistance,
      bedroomDistanceChanged: false,
      bathroomDistanceCm: developerBathroomDistance,
      bathroomDistanceChanged: false,
      cameraConnected: developerSensors.cameraConnected,
      fallDetected: developerSensors.fallDetected,
    },
    derived: {
      bathroomStayMinutes: trackedLocation === "bathroom" ? Math.floor(locationElapsedSeconds / 60) : 0,
      inactivityMinutes: trackedLocation === "bedroom" ? Math.floor(locationElapsedSeconds / 60) : 0,
      bedDurationMinutes: developerSensors.bedOccupied ? bedElapsedSeconds / 60 : 0,
      exitDoorOpenMinutes: developerSensors.exitDoorOpen ? acceleratedMinutes : 0,
      bedroomDoorOpenMinutes: developerSensors.bedroomDoorOpen ? acceleratedMinutes : 0,
      outsideMinutes: trackedLocation === "outside" ? Math.floor(locationElapsedSeconds / 60) : 0,
      exitDoorOpen: developerSensors.exitDoorOpen,
      bedroomDoorOpen: developerSensors.bedroomDoorOpen,
      bathroomDoorOpen: developerSensors.bathroomDoorOpen,
      bathroomOccupied: trackedLocation === "bathroom",
      residentOutside: trackedLocation === "outside",
      residentInBedroom: trackedLocation === "bedroom",
      lastExitTransition: developerSensors.exitDoorOpen ? "모의 외출" : "모의 집 안",
      lastBedroomTransition: developerSensors.bedroomPresent ? "모의 침실 재실" : "모의 침실 밖",
      nightTime: false,
    },
    activity: [34, 31, 28, 24, 19, 16, 12, 9, 7, 5, 3, 2],
  }), [
    acceleratedMinutes,
    developerBathroomDistance,
    developerBedroomDistance,
    developerLocation,
    developerSensors,
    bedElapsedSeconds,
    locationElapsedSeconds,
    trackedLocation,
  ]);

  const liveScenario = useMemo(
    () => liveStatus ? liveStatusToScenario(liveStatus) : null,
    [liveStatus],
  );
  const activeScenario = demoOverlayActive
    ? developerScenarioKey === "manual" ? manualScenario : scenario
    : liveScenario ?? scenario;
  const evaluatedRisk = useMemo(() => evaluateRisk(activeScenario), [activeScenario]);
  const displayedChecks = evaluatedRisk.checks;
  const backendRiskLevel: RiskLevel = liveStatus?.risk.level === "danger"
    ? "danger"
    : liveStatus?.risk.level === "caution" ? "caution" : "normal";
  const risk: RiskResult = demoOverlayActive && developerScenarioKey === "manual" && developerConflict
    ? {
        level: "normal",
        title: "센서 조합 확인 필요",
        summary: "서로 다른 공간의 재실 상태가 동시에 선택되어 위험 판정을 잠시 중지했습니다.",
        action: "센서 조합을 수정한 뒤 다시 확인하세요.",
        checks: displayedChecks.map((check) => ({ ...check, state: "safe", level: "normal" })),
      }
    : !demoOverlayActive && liveStatus && liveStatus.risk.level !== "offline"
      ? {
          level: backendRiskLevel,
          title: liveStatus.risk.title,
          summary: liveStatus.risk.summary,
          action: backendRiskLevel === "danger" ? "보호자 확인이 필요합니다." : backendRiskLevel === "caution" ? "상태를 계속 관찰합니다." : "별도의 확인이 필요하지 않습니다.",
          checks: displayedChecks,
        }
    : { ...evaluatedRisk, checks: displayedChecks };
  const liveDataAvailable = liveConnection === "online" && Boolean(liveStatus?.esp32.connected);
  const dataAvailable = demoOverlayActive || liveDataAvailable;
  const displayLocation = demoOverlayActive ? trackedLocation : liveStatus?.rooms.location ?? "unknown";
  const displayConfidence = demoOverlayActive ? locationConfidence : liveStatus?.rooms.confidence ?? "unknown";
  const bedroomTracked = displayLocation === "bedroom";
  const bathroomTracked = displayLocation === "bathroom";
  const livingTracked = displayLocation === "living";
  const displayBedroomPresent = demoOverlayActive ? developerSensors.bedroomPresent : Boolean(liveStatus?.sensors.bedroom_distance.present);
  const displayBathroomPresent = demoOverlayActive ? developerSensors.bathroomPresent : Boolean(liveStatus?.sensors.bathroom_distance.present);
  const bedroomPresenceAvailable = demoOverlayActive || Boolean(liveStatus?.sensors.bedroom_distance.connected);
  const bathroomPresenceAvailable = demoOverlayActive || Boolean(liveStatus?.sensors.bathroom_distance.connected);
  const displayBedroomDistance = demoOverlayActive ? activeScenario.sensors.bedroomDistanceCm : liveStatus?.sensors.bedroom_distance.value_cm;
  const displayBathroomDistance = demoOverlayActive ? activeScenario.sensors.bathroomDistanceCm : liveStatus?.sensors.bathroom_distance.value_cm;
  const displayBedOccupied = demoOverlayActive ? developerSensors.bedOccupied : Boolean(liveStatus?.sensors.pressure.occupied);
  const displayExitDoorOpen = demoOverlayActive ? developerSensors.exitDoorOpen : Boolean(liveStatus?.sensors.main_door.open);
  const displayBedroomDoorOpen = demoOverlayActive ? developerSensors.bedroomDoorOpen : Boolean(liveStatus?.sensors.bedroom_door.open);
  const displayBathroomDoorOpen = demoOverlayActive ? developerSensors.bathroomDoorOpen : Boolean(liveStatus?.sensors.bathroom_door.open);
  const displayCameraConnected = demoOverlayActive ? developerSensors.cameraConnected : Boolean(liveStatus?.camera.connected);
  const cameraPrivacyStandby = !demoOverlayActive && liveStatus?.camera.privacy_mode === "standby";
  const cameraPrivacyReason = !demoOverlayActive
    ? liveStatus?.camera.privacy_reason ?? "거실 재실 가능성이 있을 때만 카메라를 켭니다."
    : "시연용 카메라 상태";
  const livingPresenceAvailable = demoOverlayActive || displayCameraConnected;
  const displayLivingPresent = demoOverlayActive ? developerSensors.cameraConnected : Boolean(liveStatus?.rooms.living.present);
  const livingPresenceConfirmed = demoOverlayActive || Boolean(liveStatus?.rooms.living.camera_confirmed);
  const entranceDecisionPending = !demoOverlayActive && Boolean(liveStatus?.rooms.living.door_cycle_pending);
  const cameraStreamAvailable = liveConnection === "online"
    && Boolean(liveStatus?.camera.stream_available);
  const displayFallDetected = demoOverlayActive
    ? developerSensors.fallDetected
    : Boolean(liveStatus?.camera.detection?.fall_detected);
  const cameraFigureState = cameraPrivacyStandby
    ? "프라이버시 대기"
    : !displayCameraConnected
      ? "연결 대기"
      : displayFallDetected
        ? "쓰러짐"
        : !demoOverlayActive && !liveStatus?.camera.detection?.object_detected
          ? "미검출"
          : liveStatus?.camera.detection?.state === "TRANSITION" ? "전환 중" : "정상";
  const riskDataAvailable = dataAvailable || displayCameraConnected;
  const cameraStreamUrl = `${apiBase}${liveStatus?.camera.stream_path ?? "/api/camera/stream"}?attempt=${cameraStreamAttempt}`;

  const toggleCameraFullscreen = async () => {
    const cameraFeed = cameraFeedRef.current;
    if (!cameraFeed || !cameraStreamAvailable) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await cameraFeed.requestFullscreen();
    } catch {
      // Fullscreen availability is controlled by the browser and display session.
    }
  };
  const displayLocationElapsedSeconds = demoOverlayActive ? locationElapsedSeconds : liveStatus?.rooms.location_seconds ?? 0;
  const displayOutsideElapsedSeconds = demoOverlayActive
    ? displayLocation === "outside" ? locationElapsedSeconds : 0
    : liveStatus?.rooms.outside.duration_seconds ?? 0;
  const displayNightOuting = displayLocation === "outside" && (
    demoOverlayActive ? activeScenario.derived.nightTime : Boolean(liveStatus?.rooms.outside.night)
  );
  const displayLocationText = displayLocation === "outside"
    ? `${displayNightOuting ? "야간 외출" : "외출 중"} · ${formatOutingDuration(displayOutsideElapsedSeconds)}째`
    : locationLabel(displayLocation, displayConfidence);
  const displayBedElapsedSeconds = demoOverlayActive ? activeScenario.derived.bedDurationMinutes * 60 : liveStatus?.rooms.bed.duration_seconds ?? 0;
  const bedroomStateText = !bedroomPresenceAvailable
    ? "연결 대기"
    : `${displayBedroomPresent ? "재실" : "미감지"}${displayBedroomDistance == null ? "" : ` · ${displayBedroomDistance.toFixed(1)}cm`}`;
  const bathroomStateText = !bathroomPresenceAvailable
    ? "연결 대기"
    : `${displayBathroomPresent ? "재실" : "미감지"}${displayBathroomDistance == null ? "" : ` · ${displayBathroomDistance.toFixed(1)}cm`}`;
  const livingStateText = cameraPrivacyStandby
    ? "프라이버시 대기"
    : !livingPresenceAvailable
      ? "카메라 연결 대기"
      : entranceDecisionPending
        ? "출입 판정 중"
        : !livingPresenceConfirmed
          ? "객체 확인 중"
          : displayLivingPresent ? "객체 감지 · 재실" : "객체 없음";

  const moveLocation = (
    next: TrackedLocation,
    confidence: LocationConfidence,
    baseSeconds = 0,
  ) => {
    setTrackedLocation((current) => {
      if (current !== next || baseSeconds > 0) {
        setLocationStartedAtSeconds(simulationSeconds);
        setLocationBaseSeconds(baseSeconds);
      }
      return next;
    });
    setLocationConfidence(confidence);
  };

  const resolveTransition = (transition: PendingTransition, nextSensors: DeveloperSensorState) => {
    if (transition.door === "exitDoorOpen") {
      if (transition.origin === "outside") moveLocation("living", "estimated");
      else if (transition.origin !== "unknown") moveLocation("outside", "estimated");
      else moveLocation("unknown", "unknown");
    } else if (transition.door === "bedroomDoorOpen") {
      if (nextSensors.bedroomPresent || nextSensors.bedOccupied) moveLocation("bedroom", "confirmed");
      else if (transition.origin === "bedroom") moveLocation("living", "estimated");
      else if (transition.origin === "living") moveLocation("bedroom", "estimated");
      else moveLocation("unknown", "unknown");
    } else {
      if (nextSensors.bathroomPresent) moveLocation("bathroom", "confirmed");
      else if (transition.origin === "bathroom") moveLocation("living", "estimated");
      else if (transition.origin === "living") moveLocation("bathroom", "estimated");
      else moveLocation("unknown", "unknown");
    }
  };

  useEffect(() => {
    if (!demoOverlayActive || !pendingTransition) return;
    if (simulationSeconds - pendingTransition.startedAtSeconds < 10) return;
    resolveTransition(pendingTransition, developerSensors);
    setResolvedTransitionDoor(pendingTransition.door);
    setPendingTransition(null);
  }, [demoOverlayActive, developerSensors, pendingTransition, simulationSeconds]);

  const returnToLive = () => {
    setDeveloperSensors({ ...DEFAULT_DEVELOPER_SENSORS });
    setDeveloperScenarioKey("live");
    setSimulationSpeed(1);
    setSimulationSeconds(0);
    setTrackedLocation("unknown");
    setLocationConfidence("unknown");
    setLocationStartedAtSeconds(0);
    setLocationBaseSeconds(0);
    setBedStartedAtSeconds(null);
    setPendingTransition(null);
    setResolvedTransitionDoor(null);
    setEvents((current) => current.filter((event) => event.source !== "session"));
    setNotice("알림 테스트");
    setBehaviorAction("선택 대기");
  };

  const toggleDeveloperSensor = (key: keyof DeveloperSensorState) => {
    setDeveloperScenarioKey("manual");
    const nextActive = !developerSensors[key];
    const nextSensors = { ...developerSensors, [key]: nextActive };
    if (key === "bedOccupied" || key === "bedroomPresent" || key === "bathroomPresent") {
      nextSensors.cameraConnected = !(nextSensors.bedOccupied || nextSensors.bedroomPresent || nextSensors.bathroomPresent);
    } else if (key === "exitDoorOpen" && nextActive) {
      nextSensors.cameraConnected = true;
    }
    setDeveloperSensors(nextSensors);

    if (key === "bedOccupied") {
      setBedStartedAtSeconds(nextActive ? simulationSeconds : null);
      if (nextActive) {
        setPendingTransition(null);
        moveLocation("bedroom", "confirmed");
      } else if (!nextSensors.bedroomPresent && trackedLocation === "bedroom") {
        moveLocation("unknown", "unknown");
      }
      return;
    }
    if (key === "bedroomPresent") {
      if (nextActive) {
        setPendingTransition(null);
        moveLocation(nextSensors.bathroomPresent ? "unknown" : "bedroom", nextSensors.bathroomPresent ? "unknown" : "confirmed");
      } else if (!nextSensors.bedOccupied && trackedLocation === "bedroom") {
        moveLocation("unknown", "unknown");
      }
      return;
    }
    if (key === "bathroomPresent") {
      if (nextActive) {
        setPendingTransition(null);
        moveLocation(nextSensors.bedroomPresent || nextSensors.bedOccupied ? "unknown" : "bathroom", nextSensors.bedroomPresent || nextSensors.bedOccupied ? "unknown" : "confirmed");
      } else if (trackedLocation === "bathroom") {
        moveLocation("unknown", "unknown");
      }
      return;
    }

    if (key === "exitDoorOpen" || key === "bedroomDoorOpen" || key === "bathroomDoorOpen") {
      if (nextActive) {
        setResolvedTransitionDoor(null);
        setPendingTransition({ door: key, origin: trackedLocation, startedAtSeconds: simulationSeconds });
        return;
      }

      if (resolvedTransitionDoor === key) {
        setResolvedTransitionDoor(null);
        return;
      }

      const transition = pendingTransition?.door === key
        ? pendingTransition
        : { door: key, origin: trackedLocation, startedAtSeconds: simulationSeconds };
      setPendingTransition(null);
      resolveTransition(transition, nextSensors);
    }
  };

  const runBehaviorOffset = (key: BehaviorOffsetKey) => {
    if (key === "normal" || key === "bathroom" || key === "inactivity" || key === "nightExit" || key === "bedRest" || key === "fall") {
      const preset = scenarios[key];
      setDeveloperScenarioKey(key);
      setScenarioKey(key);
      setSimulationSeconds(0);
      setSimulationBase(Date.now());
      setPendingTransition(null);
      setResolvedTransitionDoor(null);
      setBedStartedAtSeconds(null);
      setDeveloperSensors({
        exitDoorOpen: preset.sensors.exitDoorOpen,
        bedroomDoorOpen: preset.sensors.bedroomDoorOpen,
        bathroomDoorOpen: preset.sensors.bathroomDoorOpen,
        bedroomPresent: preset.derived.residentInBedroom,
        bathroomPresent: preset.derived.bathroomOccupied,
        bedOccupied: preset.sensors.bedOccupied,
        cameraConnected: preset.sensors.cameraConnected,
        fallDetected: preset.sensors.fallDetected,
      });
      if (preset.sensors.fallDetected) {
        moveLocation("living", "confirmed");
      } else if (preset.derived.residentOutside) {
        moveLocation("outside", "estimated", preset.derived.outsideMinutes * 60);
      } else if (preset.derived.bathroomOccupied) {
        moveLocation("bathroom", "confirmed", preset.derived.bathroomStayMinutes * 60);
      } else if (preset.derived.residentInBedroom) {
        moveLocation("bedroom", "confirmed", preset.derived.inactivityMinutes * 60);
      } else {
        moveLocation("unknown", "unknown");
      }
      setBehaviorAction(preset.label);
      return;
    }

    setDeveloperScenarioKey("manual");
    setPendingTransition(null);
    setResolvedTransitionDoor(null);

    if (key === "bedroomMove") {
      setDeveloperSensors({
        ...DEFAULT_DEVELOPER_SENSORS,
        bedroomDoorOpen: true,
        bedroomPresent: true,
        cameraConnected: false,
      });
      setBedStartedAtSeconds(null);
      moveLocation("bedroom", "confirmed");
      setBehaviorAction("거실에서 침실로 이동");
      return;
    }

    if (key === "bathroomMove") {
      setDeveloperSensors({
        ...DEFAULT_DEVELOPER_SENSORS,
        bathroomDoorOpen: true,
        bathroomPresent: true,
        cameraConnected: false,
      });
      setBedStartedAtSeconds(null);
      moveLocation("bathroom", "confirmed");
      setBehaviorAction("침실에서 화장실로 이동");
      return;
    }

    setDeveloperSensors({
      ...DEFAULT_DEVELOPER_SENSORS,
      exitDoorOpen: true,
      cameraConnected: true,
    });
    setBedStartedAtSeconds(null);
    moveLocation("living", "estimated");
    setBehaviorAction("외출 후 거실로 귀가");
  };

  const developerControls: Array<{
    key: keyof DeveloperSensorState;
    label: string;
    activeText: string;
    inactiveText: string;
  }> = [
    { key: "exitDoorOpen", label: "외부 출입문", activeText: "열림", inactiveText: "닫힘" },
    { key: "bedroomDoorOpen", label: "침실문", activeText: "열림", inactiveText: "닫힘" },
    { key: "bathroomDoorOpen", label: "화장실문", activeText: "열림", inactiveText: "닫힘" },
    { key: "bedroomPresent", label: "침실 초음파", activeText: "재실", inactiveText: "비어있음" },
    { key: "bathroomPresent", label: "화장실 초음파", activeText: "재실", inactiveText: "비어있음" },
    { key: "bedOccupied", label: "FSR402 침대", activeText: "누워있음", inactiveText: "안 누워있음" },
  ];

  const updateEvent = (id: number, state: EventState) => {
    setEvents((current) => current.map((event) => (event.id === id ? { ...event, state } : event)));
  };

  const recordCurrentEvent = () => {
    if (risk.level === "normal") return;
    const nextId = Math.max(...events.map((event) => event.id), 1000) + 1;
    setEvents((current) => [
      {
        id: nextId,
        time: `오늘 ${formatClock(simulatedNow).slice(0, 5)}`,
        level: risk.level,
        title: risk.title,
        room: activeScenario.room,
        evidence: risk.checks.find((check) => check.level === risk.level)?.reading ?? activeScenario.description,
        state: "new",
        source: "session",
      },
      ...current,
    ]);
    setView("events");
  };

  const testNotification = async () => {
    if (!("Notification" in window)) {
      setNotice("지원하지 않음");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotice("권한 필요");
      return;
    }
    new Notification(`SafeNest ${levelLabel(risk.level)} 알림`, {
      body: `${risk.title} · ${risk.action}`,
    });
    setNotice("알림 전송됨");
  };

  const applyApiAddress = () => {
    try {
      const parsed = new URL(apiDraft.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("HTTP 주소가 필요합니다.");
      const normalized = parsed.toString().replace(/\/$/, "");
      window.localStorage.setItem("safenest-live-api", normalized);
      setApiBase(normalized);
      setApiDraft(normalized);
      setLiveError(null);
      setLiveConnection("connecting");
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "API 주소를 확인하세요.");
    }
  };

  const navItems: { key: ViewKey; index: string; label: string }[] = [
    { key: "overview", index: "01", label: "실시간 현황" },
    { key: "rules", index: "02", label: "위험 판정 규칙" },
    { key: "events", index: "03", label: "이벤트 기록" },
    { key: "misc", index: "04", label: "기타" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img src="/safenest-mark.png" alt="" /></div>
          <div>
            <strong>SafeNest</strong>
            <span>Raspberry Pi 실시간 연동</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="대시보드 메뉴">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.key}
              className={view === item.key ? "selected" : ""}
              onClick={() => setView(item.key)}
              aria-pressed={view === item.key}
            >
              <span>{item.index}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="system-status demo-status">
          <div><i className={liveConnection === "online" ? "" : "waiting"} />Raspberry Pi API {liveConnection === "online" ? "연결됨" : liveConnection === "connecting" ? "연결 중" : "연결 안 됨"}</div>
          <div><i className={liveStatus?.mqtt.connected ? "" : "waiting"} />MQTT {liveStatus?.mqtt.connected ? "연결됨" : "연결 안 됨"}</div>
          <div><i className={liveStatus?.esp32.connected ? "" : "waiting"} />ESP32 {liveStatus?.esp32.connected ? "수신 중" : "연결 안 됨"}</div>
          <small>{liveStatus?.esp32.last_received_at ? `마지막 수신 ${formatClock(new Date(liveStatus.esp32.last_received_at))}` : "실시간 연동 화면"}</small>
        </div>
      </aside>

      <section className="main-column">
        {view === "overview" && (
          <div className="page-stack">
            <div className="overview-developer-area overview-mode-top">
              <section className="mode-strip">
                <div className="mode-copy">
                  <span className={`mode-badge ${demoOverlayActive ? "developer" : liveDataAvailable ? "" : "offline"}`}>{demoOverlayActive ? "모의 제어 반영 중" : liveDataAvailable ? "실시간 연결" : liveConnection === "connecting" ? "연결 중" : "연결 안 됨"}</span>
                  <p>{demoOverlayActive ? "실제 센서는 계속 수신하며 지도와 위험 판정에만 임의 조작값을 임시 적용합니다." : liveDataAvailable ? "Raspberry Pi가 분석한 실제 센서 상태를 100ms 간격으로 표시합니다." : `Raspberry Pi API 연결을 기다리고 있습니다.${liveError ? ` (${liveError})` : ""}`}</p>
                </div>
                <div className="mode-actions">
                  <div className="connection-preview" aria-label="현재 연결 상태">
                    <span><i className={liveConnection === "online" ? "online" : ""} />Pi API<strong>{liveConnection === "online" ? "연결됨" : liveConnection === "connecting" ? "연결 중" : "연결 안 됨"}</strong></span>
                    <span><i className={liveStatus?.mqtt.connected ? "online" : ""} />MQTT<strong>{liveStatus?.mqtt.connected ? "연결됨" : "연결 안 됨"}</strong></span>
                    <span><i className={liveStatus?.esp32.connected ? "online" : ""} />ESP32<strong>{liveStatus?.esp32.connected ? "수신 중" : "연결 안 됨"}</strong></span>
                    <span><i className={liveStatus?.camera.connected ? "online" : ""} />CAM 3<strong>{liveStatus?.camera.connected ? "연결됨" : "연결 안 됨"}</strong></span>
                  </div>
                  <label className="simulation-speed-select enabled">
                    <span>시연 배속</span>
                    <select
                      aria-label="시연 시간 배속"
                      value={simulationSpeed}
                      onChange={(event) => setSimulationSpeed(Number(event.target.value) as SimulationSpeed)}
                    >
                      {SIMULATION_SPEEDS.map((speed) => (
                        <option key={speed} value={speed}>{speed === 0 ? "정지" : `×${speed}`}</option>
                      ))}
                    </select>
                    <small>임의 행동 경과시간 가속</small>
                  </label>
                  <button type="button" className={`developer-mode-toggle ${demoOverlayActive ? "enabled" : ""}`} disabled={!demoOverlayActive} onClick={returnToLive}>
                    <b>모의 상태 해제</b>
                  </button>
                </div>
              </section>
            </div>

            <div className="overview-grid">
              <section className="panel home-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">SMART HOME</span>
                    <h2>공간별 실시간 상태</h2>
                    <small className="map-basis">실물 모형 · 사진을 반시계 방향으로 90° 돌린 배치</small>
                  </div>
                  <span className={`live-label ${demoOverlayActive ? "developer" : ""}`}><i />{demoOverlayActive ? "임의 조작값 표시 중" : liveDataAvailable ? "실제 센서 수신 중" : "연결 안 됨"}</span>
                </div>

                <div className="home-map">
                  <article className={`room bedroom ${dataAvailable && bedroomTracked ? "room-active" : ""}`} tabIndex={0} title="침실 센서 상태">
                    <div><strong>침실</strong><span>BEDROOM</span></div>
                    <div className="room-status-stack">
                      <button type="button" className={`presence-card ${bedroomPresenceAvailable ? (displayBedroomPresent ? "active" : "") : "unknown"}`} aria-pressed={bedroomPresenceAvailable && displayBedroomPresent} onClick={() => toggleDeveloperSensor("bedroomPresent")}>
                        <span>방 상태</span>
                        <strong><i className="state-dot" /><b>{bedroomStateText}</b></strong>
                      </button>
                      <button type="button" className={`presence-card ${dataAvailable ? (displayBedOccupied ? "active" : "") : "unknown"}`} aria-pressed={dataAvailable && displayBedOccupied} onClick={() => toggleDeveloperSensor("bedOccupied")}>
                        <span>침대 상태</span>
                        <strong><i className="state-dot" /><b>{dataAvailable ? (displayBedOccupied ? "누워있음" : "안 누워있음") : "연결 대기"}</b></strong>
                      </button>
                    </div>
                    <div className={`bed-visual ${dataAvailable && displayBedOccupied ? "bed-occupied" : ""}`} aria-label="침대 상태 그래픽">
                      <i className="bed-headboard" />
                      <i className="bed-pillow pillow-left" />
                      <i className="bed-pillow pillow-right" />
                      <i className="bed-mattress" />
                    </div>
                    <span className={`map-door bedroom-map-door ${dataAvailable && displayBedroomDoorOpen ? "door-open" : ""}`} tabIndex={0} title={`침실문 GPIO23 · ${dataAvailable ? (displayBedroomDoorOpen ? "열림" : "닫힘") : "데이터 대기"}`} aria-label="침실문 상태">
                      <span className="door-drawing" aria-hidden="true"><i className="door-leaf" /></span>
                    </span>
                  </article>
                  <article className={`room bathroom ${dataAvailable && bathroomTracked ? "room-active" : ""}`} tabIndex={0} title="화장실 센서 상태">
                    <div><strong>화장실</strong><span>BATHROOM</span></div>
                    <div className="room-status-stack single">
                      <button type="button" className={`presence-card ${bathroomPresenceAvailable ? (displayBathroomPresent ? "active" : "") : "unknown"}`} aria-pressed={bathroomPresenceAvailable && displayBathroomPresent} onClick={() => toggleDeveloperSensor("bathroomPresent")}>
                        <span>방 상태</span>
                        <strong><i className="state-dot" /><b>{bathroomStateText}</b></strong>
                      </button>
                    </div>
                    <div className="bathroom-fixture" aria-hidden="true">
                      <i className="toilet-fixture" />
                      <i className="vanity-fixture"><span /></i>
                    </div>
                    <span className={`map-door bathroom-map-door ${dataAvailable && displayBathroomDoorOpen ? "door-open" : ""}`} tabIndex={0} title={`화장실문 GPIO27 · ${dataAvailable ? (displayBathroomDoorOpen ? "열림" : "닫힘") : "데이터 대기"}`} aria-label="화장실문 상태">
                      <span className="door-drawing" aria-hidden="true"><i className="door-leaf" /></span>
                    </span>
                  </article>
                  <article className={`room living ${livingPresenceAvailable && livingTracked ? "room-active" : ""}`} tabIndex={0} title="거실 센서 상태">
                    <div><strong>거실</strong><span>LIVING ROOM</span></div>
                    <div className={`presence-card living-presence-card ${livingPresenceAvailable ? (displayLivingPresent ? "active" : "") : "unknown"}`}>
                      <span>카메라 재실</span>
                      <strong><i className="state-dot" /><b>{livingStateText}</b></strong>
                    </div>
                    <span className={`map-door exit-map-door ${dataAvailable && displayExitDoorOpen ? "door-open" : ""}`} tabIndex={0} title={`외부 출입문 GPIO22 · ${dataAvailable ? (displayExitDoorOpen ? "열림" : "닫힘") : "데이터 대기"}`} aria-label="외부 출입문 상태">
                      <span className="door-drawing" aria-hidden="true"><i className="door-leaf" /></span>
                    </span>
                  </article>
                  <span className={`resident-marker ${displayLocation}`} aria-label={displayLocation === "unknown" ? "독거인 위치 확인 중" : `독거인 위치: ${displayLocationText}`} title={displayLocation === "unknown" ? "위치 확인 중" : displayLocationText}><i /></span>
                </div>

              </section>

              <section className={`panel current-status-panel ${riskDataAvailable ? risk.level : "offline"}`} aria-label={`현재 안전 상태: ${riskDataAvailable ? levelLabel(risk.level) : "연결 대기"}`}>
                <div className="status-camera-section">
                  <div className="status-section-heading"><span>PRIVACY CAMERA</span><strong>거실 카메라</strong></div>
                  <time className="status-compact-clock" aria-label={`현재 시각 ${formatClock(displayedNow)}`}>{formatClock(displayedNow)}</time>
                  <div
                    ref={cameraFeedRef}
                    className={`camera-feed ${cameraStreamAvailable && !cameraStreamFailed ? "online" : "offline"}`}
                    aria-label="거실 Camera Module 3 실시간 영상"
                    title={cameraStreamAvailable ? "더블클릭하면 카메라 전체화면" : cameraPrivacyReason}
                    onDoubleClick={() => void toggleCameraFullscreen()}
                  >
                    {cameraStreamAvailable && !cameraStreamFailed ? (
                      <img
                        src={cameraStreamUrl}
                        alt="거실 Camera Module 3 실시간 영상"
                        onLoad={() => setCameraStreamFailed(false)}
                        onError={() => setCameraStreamFailed(true)}
                      />
                    ) : (
                      <div className="camera-feed-placeholder">
                        <i aria-hidden="true" />
                        <strong>{demoOverlayActive && displayFallDetected ? "모의 쓰러짐 감지" : cameraPrivacyStandby ? "프라이버시 대기" : "카메라 연결 대기"}</strong>
                        <span>{cameraPrivacyStandby ? cameraPrivacyReason : liveStatus?.camera.error || "Camera Module 3를 확인하고 있습니다."}</span>
                      </div>
                    )}
                    <div className={`camera-feed-meta ${displayFallDetected ? "danger" : ""}`}>
                      <span><i />피규어 상태 · {cameraFigureState}</span>
                      <b>{cameraStreamAvailable ? `${liveStatus?.camera.fps ?? 10} FPS · 더블클릭 전체화면` : cameraPrivacyStandby ? "CAMERA OFF" : "OFFLINE"}</b>
                    </div>
                  </div>
                </div>
                <div className="status-result-section">
                  <div className="status-section-heading"><span>CURRENT STATUS</span><strong>현재 안전 상태</strong></div>
                  <div className="current-status-visual" aria-hidden="true">
                    <span className="current-status-rings"><i /><i /><i /></span>
                    <strong>{!riskDataAvailable ? "…" : risk.level === "normal" ? "✓" : risk.level === "caution" ? "!" : "!!"}</strong>
                  </div>
                  <div className="current-status-copy">
                    <span>현재 상태</span>
                    <strong>{riskDataAvailable ? levelLabel(risk.level) : "연결 대기"}</strong>
                    <small>{riskDataAvailable ? risk.title : liveConnection === "online" ? "센서 및 카메라 연결 대기" : "Raspberry Pi API 연결 대기"}</small>
                  </div>
                  {dataAvailable && displayLocation === "outside" && (
                    <div className={`outing-status ${displayNightOuting ? "night" : "day"}`} role="status" aria-label={`${displayNightOuting ? "야간 외출" : "외출 중"}, ${formatOutingDuration(displayOutsideElapsedSeconds)} 경과`}>
                      <span>{displayNightOuting ? "NIGHT OUTING" : "OUTING"}</span>
                      <strong>{displayNightOuting ? "야간 외출" : "외출 중"}</strong>
                      <small>{formatOutingDuration(displayOutsideElapsedSeconds)}째</small>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="overview-developer-area">
                <section className="developer-console" aria-label="시연 제어판">
                  <div className="developer-console-heading">
                    <div><span>SIMULATION CONTROLS</span><strong>행동 및 센서 조작</strong></div>
                    <small>실제 센서는 항상 수신합니다. 임의 조작값은 SQLite와 보호자 알림에 저장되지 않습니다.</small>
                  </div>
                  <div className="developer-demo-grid">
                    <div className="developer-clock"><span>시연 경과</span><strong>{formatDuration(simulationSeconds)}</strong><button type="button" onClick={() => { setSimulationSeconds(0); setSimulationBase(Date.now()); }}>초기화</button></div>
                    <div className="developer-actions">
                      <button type="button" disabled={risk.level === "normal"} onClick={recordCurrentEvent}>임시 이벤트 기록</button>
                      <button type="button" disabled={risk.level === "normal"} onClick={testNotification}>{notice}</button>
                    </div>
                  </div>
                  <div className="behavior-offset-panel">
                    <div><span>BEHAVIOR OFFSETS</span><strong>임의 행동 및 상황</strong><small>현재 동작 · {behaviorAction}</small></div>
                    <div className="behavior-offset-buttons">
                      <button type="button" onClick={() => runBehaviorOffset("bedroomMove")}><span>행동 01</span><strong>침실 이동</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("bathroomMove")}><span>행동 02</span><strong>화장실 이동</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("returnHome")}><span>행동 03</span><strong>외출 후 귀가</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("normal")}><span>상황 01</span><strong>정상 생활</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("bathroom")}><span>상황 02</span><strong>화장실 장기 체류</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("bedRest")}><span>상황 03</span><strong>침대 12시간</strong></button>
                      <button type="button" onClick={() => runBehaviorOffset("fall")}><span>상황 04</span><strong>거실 쓰러짐</strong></button>
                    </div>
                  </div>
                  <div className="developer-control-grid">
                    {developerControls.map((control) => {
                      const active = developerSensors[control.key];
                      return (
                        <button type="button" key={control.key} className={active ? "active" : ""} aria-pressed={active} onClick={() => toggleDeveloperSensor(control.key)}>
                          <span>{control.label}</span>
                          <strong>{active ? control.activeText : control.inactiveText}</strong>
                        </button>
                      );
                    })}
                  </div>
                  {developerConflict && developerScenarioKey === "manual" && <p className="developer-conflict" role="status">서로 다른 공간의 재실 상태가 동시에 선택되었습니다. UI 시험은 가능하지만 실제 위치로 판정하지 않습니다.</p>}
                </section>
            </div>

            <section className="panel sensor-section">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">LIVE SENSOR FEED</span>
                  <h2>센서 및 장치 상태</h2>
                </div>
                <span className="muted-label">실제값 · 100ms 갱신</span>
              </div>
              <div className="sensor-grid">
                <SensorCard
                  code="D1"
                  name="외부 출입문"
                  value={liveStatus?.sensors.main_door.connected ? `${liveStatus.sensors.main_door.open ? "열림" : "닫힘"} · raw ${liveStatus.sensors.main_door.open ? 1 : 0}` : "연결 안 됨"}
                  detail="MC-38 · GPIO22 · 0 닫힘 / 1 열림"
                  state={liveStatus?.sensors.main_door.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="D2"
                  name="침실문"
                  value={liveStatus?.sensors.bedroom_door.connected ? `${liveStatus.sensors.bedroom_door.open ? "열림" : "닫힘"} · raw ${liveStatus.sensors.bedroom_door.open ? 1 : 0}` : "연결 안 됨"}
                  detail="MC-38 · GPIO23 · 0 닫힘 / 1 열림"
                  state={liveStatus?.sensors.bedroom_door.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="D3"
                  name="화장실문"
                  value={liveStatus?.sensors.bathroom_door.connected ? `${liveStatus.sensors.bathroom_door.open ? "열림" : "닫힘"} · raw ${liveStatus.sensors.bathroom_door.open ? 1 : 0}` : "연결 안 됨"}
                  detail="MC-38 · GPIO27 · 0 닫힘 / 1 열림"
                  state={liveStatus?.sensors.bathroom_door.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="FSR"
                  name="침대 압력"
                  value={liveStatus?.sensors.pressure.connected ? `${Math.round(liveStatus.sensors.pressure.value)} · ${liveStatus.sensors.pressure.occupied ? "사용 중" : "미사용"}` : "연결 안 됨"}
                  detail={`FSR402 · GPIO34 · 기준 ≥ ${SENSOR_RULES.pressureOccupiedAtOrAbove}`}
                  state={liveStatus?.sensors.pressure.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="US1"
                  name="침실 초음파"
                  value={liveStatus?.sensors.bedroom_distance.connected ? `${liveStatus.sensors.bedroom_distance.value_cm?.toFixed(1) ?? "--"}cm · ${liveStatus.sensors.bedroom_distance.present ? "재실" : "미감지"}` : "연결 안 됨"}
                  detail="Echo 18 · Trigger 19 · 재실 ≤ 8.7cm"
                  state={liveStatus?.sensors.bedroom_distance.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="US2"
                  name="화장실 초음파"
                  value={liveStatus?.sensors.bathroom_distance.connected ? `${liveStatus.sensors.bathroom_distance.value_cm?.toFixed(1) ?? "--"}cm · ${liveStatus.sensors.bathroom_distance.present ? "재실" : "미감지"}` : "연결 안 됨"}
                  detail="Echo 16 · Trigger 17 · 재실 ≤ 7.1cm"
                  state={liveStatus?.sensors.bathroom_distance.connected ? "active" : "normal"}
                />
                <SensorCard
                  code="CAM"
                  name="거실 카메라"
                  value={cameraPrivacyStandby ? "프라이버시 대기" : displayCameraConnected ? `${cameraFigureState}${liveStatus?.camera.fps ? ` · ${liveStatus.camera.fps}fps` : ""}` : "연결 안 됨"}
                  detail={cameraPrivacyStandby ? cameraPrivacyReason : "Camera Module 3 · 바운딩 박스 자세 분석"}
                  state={displayFallDetected ? "error" : displayCameraConnected ? "active" : "normal"}
                />
              </div>
            </section>
          </div>
        )}

        {view === "rules" && (
          <div className="page-stack">
            <section className="section-hero safety-rules-hero">
              <div>
                <span className="section-kicker">FIXED SENSOR SAFETY RULES</span>
                <h2>현재 센서 상태와 지속시간으로 판정합니다</h2>
                <p>개인 생활 기준선은 사용하지 않으며, 화장실 체류·무활동·침대 사용·쓰러짐만 명확한 고정 기준으로 확인합니다.</p>
              </div>
              <div className="connection-score"><span>판정 단계</span><strong>정상 · 주의 · 위험</strong><small>야간 외출은 별도 상태로 표시</small></div>
            </section>
            <section className="rule-list">
              {risk.checks.map((check, index) => (
                <article key={check.id} className="rule-card">
                  <div className="rule-index">R{String(index + 1).padStart(2, "0")}</div>
                  <div className="rule-main">
                    <div><h3>{check.title}</h3><span className={`status-pill ${dataAvailable ? check.level : "normal"}`}>{dataAvailable ? checkLabel(check.state) : "연결 대기"}</span></div>
                    <p>{check.condition}</p>
                    <dl>
                      <div><dt>현재 판정값</dt><dd>{dataAvailable ? check.reading : "센서 데이터 대기"}</dd></div>
                      <div><dt>주의 기준</dt><dd>{check.cautionCriteria}</dd></div>
                      <div><dt>위험 기준</dt><dd>{check.dangerCriteria}</dd></div>
                    </dl>
                  </div>
                </article>
              ))}
            </section>

          </div>
        )}

        {view === "events" && (
          <div className="page-stack">
            <section className="event-stats">
              <article><span>오늘 이벤트</span><strong>{events.filter((event) => event.time.startsWith("오늘")).length}</strong><small>전체 기록</small></article>
              <article className="danger"><span>위험</span><strong>{events.filter((event) => event.level === "danger").length}</strong><small>보호자 확인 필요</small></article>
              <article className="caution"><span>주의</span><strong>{events.filter((event) => event.level === "caution").length}</strong><small>추가 관찰</small></article>
              <article><span>미확인</span><strong>{events.filter((event) => event.state === "new").length}</strong><small>조치 대기</small></article>
            </section>

            <section className="panel event-status-panel">
              <div className="panel-heading"><div><span className="section-kicker">STATUS MESSAGES</span><h2>상태 메시지</h2></div><span className="muted-label">최근 상태</span></div>
              <div className="summary-grid">
                <article tabIndex={0}><span>추정 위치</span><strong>{dataAvailable ? displayLocationText : "연결 대기"}</strong><small>외부·침실·화장실문 상태 기준</small></article>
                <article tabIndex={0}><span>{displayLocation === "outside" ? (displayNightOuting ? "야간 외출 경과" : "외출 경과") : "현재 위치 체류"}</span><strong>{dataAvailable && displayLocation !== "unknown" ? (displayLocation === "outside" ? formatOutingDuration(displayOutsideElapsedSeconds) : formatDuration(displayLocationElapsedSeconds)) : "연결 대기"}</strong><small>{displayLocation === "outside" ? "귀가 확인 시 종료" : "위치 변경 시 다시 계산"}</small></article>
                <article tabIndex={0}><span>침대 사용</span><strong>{dataAvailable && displayBedOccupied ? formatDuration(displayBedElapsedSeconds) : dataAvailable ? "미사용" : "연결 대기"}</strong><small>침대 사용 상태 기록</small></article>
                <article tabIndex={0}><span>수신 메시지</span><strong>{liveStatus?.esp32.message_count ?? 0}건</strong><small>{liveStatus?.esp32.connected ? `ESP32 실시간 수신 중${demoOverlayActive ? " · 시연 화면 병행" : ""}` : "ESP32 연결 안 됨"}</small></article>
              </div>
            </section>

            <section className="panel events-panel">
              <div className="panel-heading"><div><span className="section-kicker">EVENT LOG</span><h2>위험 이벤트 기록</h2></div><span className="muted-label">최근 순</span></div>
              <div className="sample-notice">
                <strong>{events.some((event) => event.source === "live") ? "Raspberry Pi SQLite에서 불러온 실제 위험 기록입니다." : events.length > 0 ? "시연 제어에서 만든 임시 이벤트입니다." : "현재 저장된 실제 위험 이벤트가 없습니다."}</strong>
                <span>{events.some((event) => event.source === "live") ? "센서 분석 프로그램이 기록한 주의·위험 판정만 표시합니다." : events.length > 0 ? "모의 이벤트는 새로고침하면 사라지며 실제 알림에 사용되지 않습니다." : "Raspberry Pi에서 위험 상태가 발생하면 여기에 표시됩니다."}</span>
              </div>
              <div className="event-list">
                {events.length === 0 && <div className="empty-state">센서 연결 후 생성된 이벤트가 여기에 표시됩니다.</div>}
                {events.map((event) => (
                  <article className="event-row" key={event.id}>
                    <div className={`event-symbol ${event.level}`}>{event.level === "danger" ? "!!" : "!"}</div>
                    <div className="event-main">
                      <div><span className={`status-pill ${event.level}`}>{levelLabel(event.level)}</span><span className={`source-pill ${event.source}`}>{event.source === "live" ? "실제 기록" : event.source === "sample" ? "시연 예시" : "임시 시연"}</span><time>{event.time}</time></div>
                      <h3>{event.title}</h3>
                      <p>{event.evidence}</p>
                      <small>#{event.id} · {event.room}</small>
                    </div>
                    <div className="event-actions">
                      <span className={`event-state ${event.state}`}>{eventStateLabel(event.state)}</span>
                      {event.source !== "live" && event.state === "new" && <button type="button" onClick={() => updateEvent(event.id, "checked")}>확인함</button>}
                      {event.source !== "live" && event.state !== "resolved" && <button type="button" className="subtle" onClick={() => updateEvent(event.id, "resolved")}>상황 종료</button>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === "misc" && (
          <div className="page-stack">
            <section className="section-hero integration-hero">
              <div>
                <span className="section-kicker">SYSTEM INTEGRATION</span>
                <h2>라즈베리파이 연동 규격</h2>
                <p>확정된 GPIO, MQTT 토픽, JSON 필드와 실측 기반 임시 판정값을 반영했습니다.</p>
              </div>
              <div className="connection-score"><span>현재 상태</span><strong>Raspberry Pi {liveConnection === "online" ? "연결됨" : liveConnection === "connecting" ? "연결 중" : "연결 안 됨"}</strong><small>{apiBase}</small></div>
            </section>

            <div className="integration-grid">
              <section className="panel">
                <div className="panel-heading"><div><span className="section-kicker">DATA PIPELINE</span><h2>데이터 흐름</h2></div></div>
                <div className="pipeline">
                  <div><span>ESP32</span><strong>문·거리·압력 측정</strong><small>센서 6개 연결</small></div><i>→</i>
                  <div><span>MQTT</span><strong>SafeNest/sensor</strong><small>JSON 필드 확정</small></div><i>→</i>
                  <div><span>Raspberry Pi</span><strong>센서 상태 수신</strong><small>카메라 조건부 작동</small></div><i>→</i>
                  <div><span>SQLite</span><strong>이력 저장</strong><small>수신 시각·원본값 기록</small></div><i>→</i>
                  <div><span>Dashboard</span><strong>상태 표시</strong><small>규칙 판정 v1</small></div>
                </div>
                <div className="camera-route"><span>거실 Camera Module 3</span><i>→</i><strong>Raspberry Pi CSI</strong><i>→</i><b>대시보드 영상 영역</b></div>
              </section>

              <section className="panel contract-card">
                <div className="panel-heading"><div><span className="section-kicker">CONNECTION CONTRACT</span><h2>확정된 연동 정보</h2></div></div>
                <div className="api-address-form">
                  <label htmlFor="live-api-address">Raspberry Pi API 주소</label>
                  <div><input id="live-api-address" value={apiDraft} onChange={(event) => setApiDraft(event.target.value)} placeholder="http://127.0.0.1:8000" /><button type="button" onClick={applyApiAddress}>연결 적용</button></div>
                  <small>TigerVNC에서 라즈베리파이 브라우저를 사용하면 기본 주소를 그대로 사용할 수 있습니다.</small>
                </div>
                <dl>
                  <div><dt>MQTT 토픽</dt><dd>SafeNest/sensor</dd></div>
                  <div><dt>MQTT 포트</dt><dd>1883</dd></div>
                  <div><dt>메시지 필드</dt><dd>main_door · bedroom_door · bathroom_door · pressure · bedroom_distance · bathroom_distance</dd></div>
                  <div><dt>문 센서</dt><dd>외부 22 · 침실 23 · 화장실 27</dd></div>
                  <div><dt>침실 초음파</dt><dd>Echo 18 · Trigger 19</dd></div>
                  <div><dt>화장실 초음파</dt><dd>Echo 16 · Trigger 17</dd></div>
                  <div><dt>침대 압력</dt><dd>FSR402 · GPIO34</dd></div>
                  <div><dt>사람 감지 기준</dt><dd>침실 ≤ 8.7cm · 화장실 ≤ 7.1cm · 2회 연속</dd></div>
                  <div><dt>침대 사용 기준</dt><dd>pressure ≥ {SENSOR_RULES.pressureOccupiedAtOrAbove}</dd></div>
                  <div><dt>거실 카메라</dt><dd>Camera Module 3 · Raspberry Pi CSI</dd></div>
                  <div><dt>카메라 프라이버시</dt><dd>현관 판정 중 또는 거실 재실 가능성이 있을 때만 작동</dd></div>
                  <div><dt>데이터 저장</dt><dd>Raspberry Pi · SQLite</dd></div>
                </dl>
              </section>
            </div>

            <section className="panel hardware-panel">
              <div className="panel-heading"><div><span className="section-kicker">HARDWARE MAP</span><h2>현재 확정된 장치 구성</h2></div><span className="muted-label">총 7개</span></div>
              <div className="hardware-grid">
                <div><span>침실</span><strong>침실문 · 압력 · 초음파</strong><small>GPIO23 · 34 · 18/19</small></div>
                <div><span>화장실</span><strong>화장실문 · 초음파</strong><small>GPIO27 · 16/17</small></div>
                <div><span>거실</span><strong>외부 출입문 · 카메라</strong><small>GPIO22 · Raspberry Pi CSI</small></div>
              </div>
            </section>

            <section className="integration-note">
              <strong>개인 생활 기준선 없이 동작하는 센서 안전 규칙</strong>
              <p>초음파는 실측 거리로 재실을 확인하고, 침대는 압력 2500 이상과 미만으로 구분합니다.</p>
              <span>화장실 20분/30분, 무활동 90분/120분, 침대 12시간/14시간 기준을 사용하며 야간 외출은 위험도와 분리해 표시합니다.</span>
            </section>
          </div>
        )}

        {view === "misc" && (
          <div className="page-stack">
            <section className="logic-flow panel">
              <div className="panel-heading"><div><span className="section-kicker">DECISION FLOW</span><h2>판정 흐름</h2></div></div>
              <div className="flow-steps">
                <div><span>01</span><strong>센서 상태 수집</strong><small>JSON 6개 필드 수신</small></div><i>→</i>
                <div><span>02</span><strong>값 검증</strong><small>연결·측정 범위 확인</small></div><i>→</i>
                <div><span>03</span><strong>상태 해석</strong><small>압력·거리 기준</small></div><i>→</i>
                <div><span>04</span><strong>규칙 비교</strong><small>지속 시간 확인</small></div><i>→</i>
                <div><span>05</span><strong>위험 알림</strong><small>정상·주의·위험</small></div>
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
