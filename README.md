# Dashboard de aceleração – ESP32/ESP8266 + Flask + PostgreSQL

O microcontrolador lê o MPU6050 e envia lotes de leituras (X/Y/Z, em m/s²) por HTTP POST para uma API Flask. A API grava no PostgreSQL e serve um dashboard com gráfico em tempo real, histórico, estatísticas e exportação em CSV.

```
ESP32 / ESP8266 ──POST /api/leituras──▶ Flask (gunicorn) ──▶ PostgreSQL
                                         │
                       navegador ◀── dashboard (/)
```

## 1. Subir o servidor

Requisito: Docker Desktop.

```powershell
copy .env.example .env      # edite API_KEY e, se quiser, a senha do banco
docker compose up --build -d
```

- Dashboard: http://localhost:5000
- Logs: `docker compose logs -f web`
- Parar: `docker compose down` (os dados ficam no volume `pgdata`; `down -v` apaga tudo)

Para testar sem o hardware, use o simulador em outro terminal:

```powershell
python scripts/simular_esp32.py --chave <sua API_KEY>
```

### Acesso pela rede (para o microcontrolador)

1. Descubra o IP do PC com `ipconfig` (ex. `192.168.0.100`).
2. Libere a porta 5000 no Firewall do Windows (PowerShell como administrador):
   ```powershell
   New-NetFirewallRule -DisplayName "Flask 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
   ```

## 2. Gravar o microcontrolador

| Placa | Sketch | I2C (SDA / SCL) |
|---|---|---|
| ESP32 | [esp32/esp32_http/esp32_http.ino](esp32/esp32_http/esp32_http.ino) | GPIO21 / GPIO22 |
| ESP8266 (NodeMCU, Wemos D1 mini) | [esp8266/esp8266_http/esp8266_http.ino](esp8266/esp8266_http/esp8266_http.ino) | D2 (GPIO4) / D1 (GPIO5) |

Na Arduino IDE:
1. Instale o pacote da placa (ESP32 by Espressif ou ESP8266 Community, versão 3.x).
2. Instale as bibliotecas **Adafruit MPU6050** e **Adafruit Unified Sensor**. As bibliotecas `IOXhop_FirebaseESP32` e `ArduinoJson` deixam de ser necessárias.
3. Edite os `#define` no topo do sketch: `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_URL` (com o IP do PC), `API_KEY` (igual ao `.env`) e `DEVICE_ID`.
4. Grave e abra o Monitor Serial em 115200. Cada lote enviado com sucesso imprime `HTTP 201`.

O sketch lê uma amostra a cada 10 ms e envia lotes de 50 (um POST a cada ~0,5 s). Enquanto o POST está em andamento a leitura do sensor para por alguns milissegundos.

## 3. API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/leituras` | Recebe um lote. Header `X-API-Key` obrigatório. |
| GET | `/api/dispositivos` | Dispositivos com total de leituras e horário da última. |
| GET | `/api/leituras?device_id=&inicio=&fim=` | Pontos para o gráfico. Acima de 2000 pontos, devolve médias por intervalo de tempo. |
| GET | `/api/leituras/recentes?device_id=&apos_id=` | Leituras novas para o modo tempo real. |
| GET | `/api/estatisticas?device_id=&inicio=&fim=` | Total, mín/máx/média/desvio por eixo e última leitura. |
| GET | `/api/leituras.csv?device_id=&inicio=&fim=[&excel=1]` | Exporta CSV. `excel=1` usa `;` e vírgula decimal. |

`inicio` e `fim` usam ISO 8601 (ex. `2026-10-05T14:00:00Z`). Os horários são gravados e exportados em UTC.

Formato do POST:

```json
{
  "device_id": "esp32-01",
  "enviado_ms": 123456,
  "leituras": [
    {"t": 122960, "x": 0.123, "y": -0.081, "z": 9.807}
  ]
}
```

`t` e `enviado_ms` são o `millis()` do microcontrolador. O servidor calcula o horário de cada amostra como `agora - (enviado_ms - t)`, então a placa não precisa de RTC nem de NTP. A latência da rede, normalmente de algumas dezenas de ms, entra como erro nesse horário.

## Rodar sem Docker (desenvolvimento)

Com um PostgreSQL local:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
$env:DATABASE_URL = "postgresql+psycopg://sensor:sensor123@localhost:5432/sensoriamento"
$env:API_KEY = "troque-esta-chave"
flask --app app run --host 0.0.0.0 --port 5000
```
