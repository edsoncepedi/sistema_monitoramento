// ESP32 + PZEM-004T v3 -> API Flask (tensão, corrente e potência)
// WiFi configurado pelo WiFiManager
//
// Bibliotecas:
// - WiFiManager
// - PZEM-004T-v30 (Jakub Mandula)
//
// Bibliotecas já fornecidas pelo core ESP32:
// - WiFi.h
// - HTTPClient.h
//
// Ligação UART (Serial2):
// PZEM TX -> GPIO16 (RX2)
// PZEM RX -> GPIO17 (TX2)
// VCC -> 3V3 (o lado TTL do PZEM v3 funciona com 3,3 V; com 5 V use divisor no TX do PZEM)
// GND -> GND
//
// O PZEM só responde com o lado AC energizado. Sem tensão na rede as leituras
// voltam NAN e são descartadas.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiManager.h>
#include <PZEM004Tv30.h>
#include <math.h>

// ----------------------------------------------------------------- configuração
#define SERVER_URL     "http://172.16.10.68:5001/api/energia"    // IP do PC que roda o Docker
#define API_KEY        "troque-esta-chave"                        // igual ao API_KEY do .env
#define DEVICE_ID      "esp32-energia-01"

#define PINO_PZEM_RX 16   // RX2 do ESP32, ligado ao TX do PZEM
#define PINO_PZEM_TX 17   // TX2 do ESP32, ligado ao RX do PZEM

// O PZEM conversa a 9600 baud e cada leitura leva dezenas de ms: 1 amostra/s basta.
#define INTERVALO_AMOSTRA_MS  1000  // 1 amostra/s
#define TAMANHO_LOTE          2     // 1 POST a cada ~2 s
#define TIMEOUT_HTTP_MS       3000
#define INTERVALO_RECONEXAO_MS 5000

// Tempo máximo do portal WiFiManager.
// 180 segundos = 3 minutos.
#define TIMEOUT_CONFIG_WIFI 180

// ----------------------------------------------------------------- estado
struct Amostra {
  unsigned long t;   // millis() no momento da leitura
  float tensao, corrente, potencia;
};

Amostra lote[TAMANHO_LOTE];

int qtdAmostras = 0;

unsigned long ultimaAmostra = 0;
unsigned long ultimaReconexao = 0;

// Cada amostra ocupa ~60 caracteres no JSON; 1 KB sobra para o lote.
char json[1024];

PZEM004Tv30 pzem(Serial2, PINO_PZEM_RX, PINO_PZEM_TX);

HTTPClient http;

// ----------------------------------------------------------------- funções
void conectarWiFi() {
  WiFi.mode(WIFI_STA);

  // Permite que o ESP32 tente reconectar automaticamente
  // caso a conexão seja perdida.
  WiFi.setAutoReconnect(true);
  WiFiManager wifiManager;

  // Se não houver credenciais salvas, o ESP32
  // criará um Access Point para configuração.

  wifiManager.setConfigPortalTimeout(TIMEOUT_CONFIG_WIFI);

  //Serial.println();
  //Serial.println("Iniciando WiFiManager...");

  if (!wifiManager.autoConnect("Energia IoT CEPEDI", "CEPEDI123")) {
    //Serial.println();
    //Serial.println("Falha na configuração do WiFi.");
    //Serial.println("Reiniciando ESP32...");
    delay(3000);
    ESP.restart();
  } else {
    //Serial.println();
    //Serial.print("Conectado. IP: ");
    //Serial.println(WiFi.localIP());
  }
}

// Monta {"device_id":..,"enviado_ms":..,"leituras":[{"t":..,"tensao":..,"corrente":..,"potencia":..},...]}
// Retorna o tamanho do JSON ou -1 se não couber no buffer.
int montarJson() {
  size_t n = snprintf(json, sizeof(json),
                      "{\"device_id\":\"%s\",\"enviado_ms\":%lu,\"leituras\":[",
                      DEVICE_ID, millis());

  for (int i = 0; i < qtdAmostras && n < sizeof(json); i++) {
    n += snprintf(json + n, sizeof(json) - n,
                  "%s{\"t\":%lu,\"tensao\":%.1f,\"corrente\":%.3f,\"potencia\":%.1f}",
                  i ? "," : "", lote[i].t, lote[i].tensao, lote[i].corrente, lote[i].potencia);
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

  http.begin(SERVER_URL);
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

  // O PZEM não tem "begin": se não responder aqui, avisa e segue tentando no loop.
  if (isnan(pzem.voltage())) {
    Serial.println("PZEM-004T não respondeu (verifique a ligação e se o lado AC está energizado)");
  }
}

void loop() {
  unsigned long agora = millis();

  if (agora - ultimaAmostra >= INTERVALO_AMOSTRA_MS) {
    ultimaAmostra = agora;

    // As três chamadas usam a mesma leitura: a biblioteca guarda o resultado por 200 ms.
    float tensao = pzem.voltage();
    float corrente = pzem.current();
    float potencia = pzem.power();

    if (!isnan(tensao) && !isnan(corrente) && !isnan(potencia)) {
      lote[qtdAmostras++] = {agora, tensao, corrente, potencia};
    }
  }

  if (qtdAmostras >= TAMANHO_LOTE) {
    enviarLote();
    qtdAmostras = 0;
  }
}
