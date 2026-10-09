// ESP8266 (NodeMCU / Wemos D1 mini) + MPU6050 -> API Flask
// WiFi configurado pelo WiFiManager
//
// Bibliotecas:
// - WiFiManager
// - Adafruit MPU6050
// - Adafruit Unified Sensor
//
// Bibliotecas já fornecidas pelo core ESP8266:
// - ESP8266WiFi.h
// - ESP8266HTTPClient.h
//
// Ligação I2C:
// MPU6050 SDA -> GPIO0 (D3)
// MPU6050 SCL -> GPIO2 (D4)
// VCC -> 3V3
// GND -> GND

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiManager.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
#include <math.h>

// ----------------------------------------------------------------- configuração
#define SERVER_URL     "http://172.16.10.68:5001/api/leituras"   // IP do PC que roda o Docker
#define API_KEY        "troque-esta-chave"                        // igual ao API_KEY do .env
#define DEVICE_ID      "esp8266-01"

#define PINO_SDA 0   // IO0
#define PINO_SCL 2   // IO2

#define INTERVALO_AMOSTRA_MS  10    // 100 amostras/s
#define TAMANHO_LOTE          50    // 1 POST a cada ~0,5 s
#define TIMEOUT_HTTP_MS       3000
#define INTERVALO_RECONEXAO_MS 5000

// Tempo máximo do portal WiFiManager.
// 180 segundos = 3 minutos.
#define TIMEOUT_CONFIG_WIFI 180

// ----------------------------------------------------------------- estado
struct Amostra {
  unsigned long t;   // millis() no momento da leitura
  float x, y, z;
};

Amostra lote[TAMANHO_LOTE];

int qtdAmostras = 0;

unsigned long ultimaAmostra = 0;
unsigned long ultimaReconexao = 0;

// Buffer estático: evita alocar String a cada envio e fragmentar a RAM (~40 KB livres).
char json[4096];

Adafruit_MPU6050 mpu;

WiFiClient wifiClient;
HTTPClient http;

// ----------------------------------------------------------------- funções
void conectarWiFi() {
  WiFi.mode(WIFI_STA);

  // Permite que o ESP8266 tente reconectar automaticamente
  // caso a conexão seja perdida.
  WiFi.setAutoReconnect(true);
  WiFiManager wifiManager;

  // Se não houver credenciais salvas, o ESP8266
  // criará um Access Point para configuração.

  wifiManager.setConfigPortalTimeout(TIMEOUT_CONFIG_WIFI);

  //Serial.println();
  //Serial.println("Iniciando WiFiManager...");

  if (!wifiManager.autoConnect("Sensor IoT CEPEDI", "CEPEDI123")) {
    //Serial.println();
    //Serial.println("Falha na configuração do WiFi.");
    //Serial.println("Reiniciando ESP8266...");
    delay(3000);
    ESP.restart();
  } else {
    //Serial.println();
    //Serial.print("Conectado. IP: ");
    //Serial.println(WiFi.localIP());
  }
}

// Monta {"device_id":..,"enviado_ms":..,"leituras":[{"t":..,"x":..,"y":..,"z":..},...]}
// Retorna o tamanho do JSON ou -1 se não couber no buffer.
int montarJson() {
  size_t n = snprintf(json, sizeof(json),
                      "{\"device_id\":\"%s\",\"enviado_ms\":%lu,\"leituras\":[",
                      DEVICE_ID, millis());

  for (int i = 0; i < qtdAmostras && n < sizeof(json); i++) {
    n += snprintf(json + n, sizeof(json) - n,
                  "%s{\"t\":%lu,\"x\":%.3f,\"y\":%.3f,\"z\":%.3f}",
                  i ? "," : "", lote[i].t, lote[i].x, lote[i].y, lote[i].z);
  }
  if (n < sizeof(json)) {
    n += snprintf(json + n, sizeof(json) - n, "]}");
  }
  return n < sizeof(json) ? (int)n : -1;
}

void enviarLote() {
  if (WiFi.status() != WL_CONNECTED) {
    //Serial.println("WiFi desconectado, lote descartado");
    if (millis() - ultimaReconexao > INTERVALO_RECONEXAO_MS) {
      ultimaReconexao = millis();
      WiFi.reconnect();
    }
    return;
  }

  int tamanho = montarJson();
  if (tamanho < 0) {
    //Serial.println("JSON maior que o buffer, lote descartado");
    return;
  }

  // No core 3.x o begin() exige o WiFiClient.
  http.begin(wifiClient, SERVER_URL);
  http.setReuse(true);  // mantém a conexão aberta entre lotes
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);

  int codigo = http.POST((uint8_t *)json, tamanho);
  if (codigo == 201) {
    Serial.printf("Lote de %d amostras enviado (HTTP 201)\n", qtdAmostras);
  } else if (codigo > 0) {
    Serial.printf("Servidor respondeu HTTP %d: %s\n", codigo, http.getString().c_str());
  } else {
    Serial.printf("Falha no POST: %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
}

// ----------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  Serial.println();

  // ---------------------------------------------------------------
  // WIFI
  conectarWiFi();

  Wire.begin(PINO_SDA, PINO_SCL);

  //Serial.println("Adafruit MPU6050 test!");
  if (!mpu.begin()) {
    Serial.println("Failed to find MPU6050 chip");
    while (1) {
      delay(10);   // delay() também alimenta o watchdog do ESP8266
    }
  }
  //Serial.println("MPU6050 Found!");

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
}

void loop() {
  unsigned long agora = millis();

  if (agora - ultimaAmostra >= INTERVALO_AMOSTRA_MS) {
    ultimaAmostra = agora;

    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);

    float x = a.acceleration.x;
    float y = a.acceleration.y;
    float z = a.acceleration.z;

    if (!isnan(x) && !isnan(y) && !isnan(z)) {
      lote[qtdAmostras++] = {agora, x, y, z};
    }
  }

  if (qtdAmostras >= TAMANHO_LOTE) {
    enviarLote();      // durante o envio (~100-300 ms) não há amostragem
    qtdAmostras = 0;
  }

  yield();  // dá tempo para a pilha WiFi do ESP8266 e evita reset do watchdog
}
