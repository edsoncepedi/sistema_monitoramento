# Dashboard de aceleração e energia – ESP32/ESP8266 + Flask + TimescaleDB

Dois tipos de microcontrolador enviam lotes de leituras por HTTP POST para uma API Flask:

- **Aceleração:** ESP com MPU6050, eixos X/Y/Z em m/s².
- **Energia:** ESP com PZEM-004T v3, tensão (V), corrente (A) e potência ativa (W).

A API grava no TimescaleDB (PostgreSQL com extensão para séries temporais) e serve um dashboard com as duas medições na mesma tela. Ele tem tempo real, histórico, zoom, estatísticas e exportação em CSV, e o modo, o período e o zoom são compartilhados entre os gráficos.

```
ESP + MPU6050   ──POST /api/leituras──▶ Flask (gunicorn) ──▶ TimescaleDB
ESP + PZEM-004T ──POST /api/energia───▶        │
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
- Parar: `docker compose down` (os dados ficam no volume `tsdata`; `down -v` apaga tudo)

Para testar sem o hardware, use o simulador em outro terminal:

```powershell
python scripts/simular_esp32.py --chave <sua API_KEY>                  # aceleração
python scripts/simular_esp32.py --chave <sua API_KEY> --tipo energia   # tensão/corrente/potência
```

### Acesso pela rede (para o microcontrolador)

1. Descubra o IP do PC com `ipconfig` (ex. `192.168.0.100`).
2. Libere a porta 5000 no Firewall do Windows (PowerShell como administrador):
   ```powershell
   New-NetFirewallRule -DisplayName "Flask 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
   ```

## 2. Gravar o microcontrolador

### Aceleração (MPU6050, I2C)

| Placa | Sketch | SDA / SCL |
|---|---|---|
| ESP32 | [esp32/esp32_http/esp32_http.ino](esp32/esp32_http/esp32_http.ino) | GPIO21 / GPIO22 |
| ESP8266 (NodeMCU, Wemos D1 mini) | [esp8266/esp8266_http/esp8266_http.ino](esp8266/esp8266_http/esp8266_http.ino) | D3 (GPIO0) / D4 (GPIO2) |

> GPIO0 e GPIO2 do ESP8266 precisam estar em nível alto no boot. Os pull-ups do módulo MPU6050 garantem isso; se a placa ficar presa no boot após um reset, desligue e ligue a alimentação.

O sketch lê uma amostra a cada 10 ms e envia lotes de 50 (um POST a cada ~0,5 s). Enquanto o POST está em andamento a leitura do sensor para por alguns milissegundos.

### Energia (PZEM-004T v3, UART)

| Placa | Sketch | PZEM TX → ESP / PZEM RX → ESP |
|---|---|---|
| ESP32 | [esp32/esp32_energia/esp32_energia.ino](esp32/esp32_energia/esp32_energia.ino) | GPIO16 (RX2) / GPIO17 (TX2) |
| ESP8266 (NodeMCU, Wemos D1 mini) | [esp8266/esp8266_energia/esp8266_energia.ino](esp8266/esp8266_energia/esp8266_energia.ino) | D5 (GPIO14) / D6 (GPIO12), via SoftwareSerial |

- Alimente o lado TTL do PZEM com 3,3 V do ESP. O PZEM v3 funciona assim e o TX dele não passa de 3,3 V. Se usar 5 V, coloque um divisor de tensão no fio TX do PZEM → RX do ESP.
- O PZEM só responde com o lado AC energizado. Sem tensão na rede, as leituras são descartadas e o Monitor Serial avisa no boot.
- O sketch lê 1 amostra por segundo e envia lotes de 2 (um POST a cada ~2 s).

### Gravar

Na Arduino IDE:
1. Instale o pacote da placa (ESP32 by Espressif ou ESP8266 Community, versão 3.x).
2. Instale a biblioteca **WiFiManager** (tzapu) e as do sensor:
   - aceleração: **Adafruit MPU6050** e **Adafruit Unified Sensor**;
   - energia: **PZEM-004T-v30** (Jakub Mandula).
3. Edite os `#define` no topo do sketch: `SERVER_URL` (com o IP do PC), `API_KEY` (igual ao `.env`) e `DEVICE_ID`. Use um `DEVICE_ID` diferente em cada placa.
4. Grave a placa. Sem rede salva, ela abre um ponto de acesso (senha `CEPEDI123`): **Sensor IoT CEPEDI** nos sketches de aceleração e **Energia IoT CEPEDI** nos de energia. Conecte-se a ele, escolha a rede WiFi no portal e informe a senha. O portal fecha após 3 minutos sem configuração e a placa reinicia.
5. Abra o Monitor Serial em 115200. Cada lote enviado com sucesso imprime `HTTP 201`.

## 3. API

Aceleração e energia têm o mesmo conjunto de rotas:

| Método | Aceleração | Energia | Descrição |
|---|---|---|---|
| POST | `/api/leituras` | `/api/energia` | Recebe um lote. Header `X-API-Key` obrigatório. |
| GET | `/api/dispositivos` | `/api/energia/dispositivos` | Dispositivos com total de leituras e horário da última. |
| GET | `/api/leituras?device_id=&inicio=&fim=` | `/api/energia?…` | Pontos para o gráfico. Acima de 2000 pontos, devolve médias por intervalo de tempo. |
| GET | `/api/leituras/recentes?device_id=&apos_id=` | `/api/energia/recentes?…` | Leituras novas para o modo tempo real. |
| GET | `/api/estatisticas?device_id=&inicio=&fim=` | `/api/energia/estatisticas?…` | Total, mín/máx/média/desvio por grandeza (`campos`) e última leitura. |
| GET | `/api/leituras.csv?device_id=&inicio=&fim=[&excel=1]` | `/api/energia.csv?…` | Exporta CSV. `excel=1` usa `;` e vírgula decimal. |

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

Em `/api/energia`, cada leitura traz `tensao`, `corrente` e `potencia` no lugar de `x`, `y` e `z`:

```json
{"t": 122960, "tensao": 220.4, "corrente": 1.234, "potencia": 250.1}
```

`t` e `enviado_ms` são o `millis()` do microcontrolador. O servidor calcula o horário de cada amostra como `agora - (enviado_ms - t)`, então a placa não precisa de RTC nem de NTP. A latência da rede, normalmente de algumas dezenas de ms, entra como erro nesse horário.

## 4. Banco de dados (TimescaleDB)

A estrutura é criada automaticamente quando o app sobe ([app/timescale.py](app/timescale.py)):

- **`leituras`** (aceleração) e **`leituras_energia`** são *hypertables*, particionadas em chunks de 1 dia. Consultas por período leem só os chunks daquele período.
- **Compressão:** chunks com mais de 7 dias são comprimidos automaticamente, segmentados por dispositivo. No teste, os dados de aceleração ficaram cerca de 12 vezes menores.
- **`leituras_1s`** e **`leituras_energia_1s`** são *agregados contínuos*: contagem, mín/máx, Σx e Σx² de cada grandeza, por dispositivo e por segundo, atualizados a cada minuto. Históricos e estatísticas de períodos maiores que 1 h usam esses agregados, e períodos menores leem os dados brutos.
- Nenhuma leitura é apagada automaticamente. Se quiser descartar dados brutos antigos, por exemplo com mais de 90 dias:
  `SELECT add_retention_policy('leituras', INTERVAL '90 days');` (e o mesmo para `leituras_energia`)

`UPDATE` ou `DELETE` em muitos dados antigos (já comprimidos) é recusado por padrão. Para liberar só na sessão atual, rode antes:
`SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0;`

### Migrar uma instalação antiga (Postgres puro → TimescaleDB)

Instalações anteriores guardavam os dados no volume `pgdata`, com Postgres puro. Depois do `git pull`, e **antes** de qualquer `docker compose up`, rode:

```bash
bash scripts/migrar_para_timescale.sh
```

O script segue estes passos:
1. Faz backup completo em `backups/`.
2. Recria o banco com TimescaleDB num volume novo, `tsdata`.
3. Copia as leituras e confere a contagem.
4. Sobe o web de novo.

O serviço fica parado alguns minutos, e os lotes que a placa enviar nesse intervalo são descartados. O volume `pgdata` não é alterado, então para voltar atrás basta `git checkout <commit anterior> && docker compose up -d --build`.

## Rodar sem Docker (desenvolvimento)

Com um PostgreSQL local que tenha a extensão TimescaleDB:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
$env:DATABASE_URL = "postgresql+psycopg://sensor:sensor123@localhost:5432/sensoriamento"
$env:API_KEY = "troque-esta-chave"
flask --app app run --host 0.0.0.0 --port 5000
```
