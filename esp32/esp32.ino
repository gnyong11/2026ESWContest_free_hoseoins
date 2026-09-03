#include <WiFi.h>
#include <PubSubClient.h>

// =====================================================
// Wi-Fi 설정
// =====================================================

const char* WIFI_SSID = "Dadd";
const char* WIFI_PASSWORD = "aksdyddl";

// Raspberry Pi MQTT Broker IP
const char* MQTT_SERVER = "10.236.82.235";
const int MQTT_PORT = 1883;

// MQTT Topic
const char* MQTT_TOPIC = "SafeNest/sensor";


// =====================================================
// GPIO 설정
// =====================================================

// MC-38
#define MAIN_DOOR_PIN       22
#define BEDROOM_DOOR_PIN    23
#define BATHROOM_DOOR_PIN   27

// 압력센서
#define PRESSURE_PIN        34

// HC-SR04 #1 - 화장실
#define BATH_TRIG_PIN       17
#define BATH_ECHO_PIN       16

// HC-SR04 #2 - 침실
#define BED_TRIG_PIN        19
#define BED_ECHO_PIN        18


// =====================================================
// MQTT 세팅
// =====================================================

WiFiClient espClient;
PubSubClient mqttClient(espClient);


// =====================================================
// Wi-Fi 연결
// =====================================================

void connectWiFi()
{
  Serial.print("WiFi 연결 중");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi 연결 성공");

  Serial.print("ESP32 IP : ");
  Serial.println(WiFi.localIP());
}


// =====================================================
// MQTT 연결
// =====================================================

void connectMQTT()
{
  while (!mqttClient.connected())
  {
    Serial.print("MQTT 연결 중...");

    if (mqttClient.connect("ESP32_HOUSE_01"))
    {
      Serial.println("성공");
    }
    else
    {
      Serial.print("실패. 상태 코드 : ");
      Serial.println(mqttClient.state());

      delay(2000);
    }
  }
}


// =====================================================
// HC-SR04 센서-거리 측정
// =====================================================

float getDistance(int trigPin, int echoPin)
{
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);

  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);

  digitalWrite(trigPin, LOW);

  unsigned long duration =
      pulseIn(echoPin, HIGH, 30000);

  if (duration == 0)
  {
    return -1;
  }

  return duration * 0.0343 / 2.0;
}


// =====================================================
// SETUP
// =====================================================

void setup()
{
  Serial.begin(115200);

  // ---------------------------------------------------
  // MC-38
  // ---------------------------------------------------

  pinMode(MAIN_DOOR_PIN, INPUT_PULLUP);
  pinMode(BEDROOM_DOOR_PIN, INPUT_PULLUP);
  pinMode(BATHROOM_DOOR_PIN, INPUT_PULLUP);


  // ---------------------------------------------------
  // 압력센서
  // ---------------------------------------------------

  pinMode(PRESSURE_PIN, INPUT);


  // ---------------------------------------------------
  // HC-SR04 #1 - 화장실
  // ---------------------------------------------------

  pinMode(BATH_TRIG_PIN, OUTPUT);
  pinMode(BATH_ECHO_PIN, INPUT);

  digitalWrite(BATH_TRIG_PIN, LOW);


  // ---------------------------------------------------
  // HC-SR04 #2 - 침실
  // ---------------------------------------------------

  pinMode(BED_TRIG_PIN, OUTPUT);
  pinMode(BED_ECHO_PIN, INPUT);

  digitalWrite(BED_TRIG_PIN, LOW);


  // ---------------------------------------------------
  // Wi-Fi
  // ---------------------------------------------------

  connectWiFi();


  // ---------------------------------------------------
  // MQTT
  // ---------------------------------------------------

  mqttClient.setServer(
    MQTT_SERVER,
    MQTT_PORT
  );

  connectMQTT();


  Serial.println();
  Serial.println("======================================");
  Serial.println("     SafeNest SENSOR SYSTEM START");
  Serial.println("======================================");
}


// =====================================================
// LOOP
// =====================================================

void loop()
{
  // MQTT 연결 확인
  if (!mqttClient.connected())
  {
    connectMQTT();
  }

  mqttClient.loop();


  // ===================================================
  // 센서 읽기
  // ===================================================

  int mainDoor =
      digitalRead(MAIN_DOOR_PIN);

  int bedroomDoor =
      digitalRead(BEDROOM_DOOR_PIN);

  int bathroomDoor =
      digitalRead(BATHROOM_DOOR_PIN);


  int pressureValue =
      analogRead(PRESSURE_PIN);


  // ===================================================
  // 화장실 거리
  // HC-SR04 #1
  // ===================================================

  float bathroomDistance =
      getDistance(
        BATH_TRIG_PIN,
        BATH_ECHO_PIN
      );


  // 두 초음파 센서 간섭 방지
  delay(50);


  // ===================================================
  // 침실 거리
  // HC-SR04 #2
  // ===================================================

  float bedroomDistance =
      getDistance(
        BED_TRIG_PIN,
        BED_ECHO_PIN
      );


  // ===================================================
  // Serial 출력
  // ===================================================

  Serial.println();
  Serial.println("========== SENSOR DATA ==========");


  Serial.print("Main Door      : ");
  Serial.println(mainDoor);


  Serial.print("Bedroom Door   : ");
  Serial.println(bedroomDoor);


  Serial.print("Bathroom Door  : ");
  Serial.println(bathroomDoor);


  Serial.print("Pressure       : ");
  Serial.println(pressureValue);


  Serial.print("Bathroom Dist  : ");

  if (bathroomDistance < 0)
  {
    Serial.println("Fail");
  }
  else
  {
    Serial.print(bathroomDistance, 1);
    Serial.println(" cm");
  }


  Serial.print("Bedroom Dist   : ");

  if (bedroomDistance < 0)
  {
    Serial.println("Fail");
  }
  else
  {
    Serial.print(bedroomDistance, 1);
    Serial.println(" cm");
  }


  // ===================================================
  // JSON 생성
  // ===================================================

  char json[256];

  snprintf(
    json,
    sizeof(json),

    "{"
    "\"main_door\":%d,"
    "\"bedroom_door\":%d,"
    "\"bathroom_door\":%d,"
    "\"pressure\":%d,"
    "\"bathroom_distance\":%.1f,"
    "\"bedroom_distance\":%.1f"
    "}",

    mainDoor,
    bedroomDoor,
    bathroomDoor,
    pressureValue,
    bathroomDistance,
    bedroomDistance
  );


  // ===================================================
  // MQTT 전송
  // ===================================================

  bool success =
      mqttClient.publish(
        MQTT_TOPIC,
        json
      );


  // ===================================================
  // MQTT 전송 결과
  // ===================================================

  Serial.println();
  Serial.println("========== MQTT ==========");

  Serial.print("Topic : ");
  Serial.println(MQTT_TOPIC);

  Serial.print("JSON  : ");
  Serial.println(json);


  if (success)
  {
    Serial.println("MQTT 전송 성공");
  }
  else
  {
    Serial.println("MQTT 전송 실패");
  }

  Serial.println("==========================");


  // 1초마다 전송
  delay(1000);
}