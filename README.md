# colmeia-api

API REST + dashboard web para um sistema de monitoramento de colmeia baseado em
ESP32 (TCC de Engenharia Mecatronica). O ESP32 coleta leituras de multiplos
sensores — 2x DHT22 (temperatura/umidade), MPU-6050 (acelerometro), HX711
(peso bruto), INMP441 (audio: RMS geral + espectro de 20 faixas de 100 Hz) — e
as envia periodicamente via HTTP POST (telemetria a cada 15 s; clipes de audio
em rajadas). Este servico recebe e armazena esses dados em SQLite, expoe uma API
REST para consulta/estatisticas e serve um dashboard dark mode (HTML/CSS/JS puro
+ Chart.js) com cards de status, graficos ao longo do tempo, **espectrograma de
audio**, tabela das ultimas leituras e atualizacao automatica.

> Campos `servo_status`, `fim_curso` e `peso_kg` sao **legado**: o schema ainda
> os aceita (opcionais), mas o firmware atual (`colmeia_esp.ino`) nao os envia.
> O peso vai como `peso_raw` (contagens brutas do HX711, sem calibracao).

## Stack

- **Backend:** Node.js + Express
- **Banco:** SQLite via `better-sqlite3` (sincrono, sem servidor separado)
- **Validacao:** Zod &nbsp;|&nbsp; **Logs:** morgan &nbsp;|&nbsp; **CORS:** liberado em `/api/*`
- **Frontend:** HTML + CSS + JS vanilla + Chart.js (via CDN)
- **Deploy:** Dockerfile (`node:20-alpine`), pronto para Coolify

## Rodar localmente

Pre-requisitos: Node.js >= 18.

```bash
npm install            # instala dependencias (compila better-sqlite3)
npm run seed           # opcional: popula ~200 leituras fake das ultimas 24h
npm start              # sobe o servidor em http://localhost:3000
```

Por padrao, em ambiente local o banco fica em `./data/colmeia.db`. Para
sobrescrever, defina `DB_PATH` (veja `.env.example`). Abra
`http://localhost:3000/` para ver o dashboard.

Durante o desenvolvimento, `npm run dev` reinicia o servidor a cada alteracao.

## Variaveis de ambiente

| Variavel   | Default                  | Descricao                              |
|------------|--------------------------|----------------------------------------|
| `PORT`     | `3000`                   | Porta HTTP                             |
| `DB_PATH`  | `./data/colmeia.db`      | Caminho do arquivo SQLite              |
| `NODE_ENV` | `development`            | `production` em deploy                 |

Em producao/Coolify use `DB_PATH=/app/data/colmeia.db` (dentro do volume).

## Endpoints da API

| Metodo | Rota                        | Descricao                                                |
|--------|-----------------------------|----------------------------------------------------------|
| GET    | `/api/health`               | Healthcheck (status do banco). Usado pelo Docker.        |
| POST   | `/api/sensor-data`          | Recebe uma leitura do ESP32. `201 {status, id}`.         |
| GET    | `/api/sensor-data`          | Ultimas leituras. Query: `device_id`, `limit` (max 1000), `since`, `until`. |
| GET    | `/api/sensor-data/latest`   | Leitura mais recente de cada device.                     |
| GET    | `/api/stats`                | Min/max/media (temp, umidade, peso) das ultimas 24h.     |
| GET    | `/api/devices`              | device_ids unicos + timestamp da ultima leitura.         |
| DELETE | `/api/sensor-data`          | Apaga dados antigos. Query obrigatoria: `older_than`.    |

> **Seguranca:** o `DELETE` (e futuramente o `POST`) deve ser protegido por
> API key antes de exposicao publica. Hoje segue **sem autenticacao** (uso
> pessoal/academico) — ha um `TODO` marcando isso no codigo.

### Exemplo de payload

Payload real do firmware atual (`colmeia_esp.ino`):

```json
{
  "device_id": "colmeia_01",
  "timestamp": 1716998400,
  "temperatura_1": 28.5,
  "umidade_1": 65.2,
  "temperatura_2": 27.8,
  "umidade_2": 67.1,
  "accel_x": 0.02,
  "accel_y": -0.01,
  "accel_z": 9.81,
  "peso_raw": 245678,
  "audio_rms": -38.4,
  "audio_bands": [-80.1, -72.3, -55.2, -48.9, -52.1, -60.3, -66.0, -70.2, -74.1,
                  -77.0, -80.2, -82.1, -84.0, -85.1, -86.0, -86.9, -87.5, -88.0,
                  -88.4, -89.0]
}
```

Apenas `device_id` e `timestamp` sao obrigatorios — os demais campos sao
opcionais (o ESP32 pode enviar leituras parciais). `audio_rms` esta em **dBFS**
(negativo; mais proximo de 0 = mais alto) e `audio_bands` traz 20 faixas de
100 Hz (0–2 kHz) em dBFS, media de 30 s. Campos legado ainda aceitos:
`peso_kg`, `servo_status`, `fim_curso`.

### Testar o POST com cURL

```bash
curl -X POST https://meudominio.com/api/sensor-data \
  -H "Content-Type: application/json" \
  -d '{"device_id":"colmeia_01","timestamp":1716998400,"temperatura_1":28.5}'
```

Resposta esperada: `201 { "status": "ok", "id": <inserted_id> }`.

## Deploy via Coolify

1. **Nova aplicacao** no Coolify do tipo **Dockerfile** (ou "Docker Compose"),
   apontando para o repositorio Git deste projeto. O Coolify detecta o
   `Dockerfile` na raiz e faz o build automaticamente.

2. **Variaveis de ambiente** (aba *Environment Variables*):
   ```
   PORT=3000
   NODE_ENV=production
   DB_PATH=/app/data/colmeia.db
   ```

3. **Volume persistente (CRITICO):** crie um volume (aba *Storage*) montado em
   **`/app/data`**.
   > Sem isso, o arquivo SQLite vive dentro do container efemero e **todos os
   > dados sao perdidos a cada novo deploy/restart**. Este e o passo mais
   > importante do deploy.

4. **Porta:** a aplicacao escuta na `PORT` (3000). O Coolify mapeia o trafego
   automaticamente via proxy interno (Traefik).

5. **Dominio + SSL:** na aba *Domains*, informe o dominio desejado. O Coolify
   provisiona o certificado SSL (Let's Encrypt) automaticamente.

6. **Deploy** e acompanhe os logs. O `HEALTHCHECK` do container chama
   `GET /api/health`; quando estiver *healthy*, o dashboard estara disponivel no
   dominio configurado.

## Snippet ESP32 (referencia)

Exemplo de envio a partir do ESP32 com `HTTPClient` (Arduino framework). E
apenas ilustrativo — ajuste pinos, leitura de sensores e credenciais Wi-Fi.

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "sua-rede";
const char* WIFI_PASS = "sua-senha";
const char* API_URL   = "https://meudominio.com/api/sensor-data";
const char* DEVICE_ID = "colmeia_01";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi conectado");
}

void enviarLeitura() {
  if (WiFi.status() != WL_CONNECTED) return;

  // Monta o JSON da leitura.
  StaticJsonDocument<512> doc;
  doc["device_id"]     = DEVICE_ID;
  doc["timestamp"]     = (uint32_t) time(nullptr); // Unix epoch (NTP)
  doc["temperatura_1"] = 28.5;   // substitua pela leitura real do sensor
  doc["umidade_1"]     = 65.2;
  doc["peso_kg"]       = 12.34;
  doc["audio_rms"]     = 0.045;
  doc["servo_status"]  = "fechado";
  doc["fim_curso"]     = true;

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  // TODO(futuro): http.addHeader("X-API-Key", "...");

  int code = http.POST(payload);
  Serial.printf("POST -> HTTP %d\n", code);
  if (code > 0) Serial.println(http.getString());
  http.end();
}

void loop() {
  enviarLeitura();
  delay(60000); // envia a cada 60s
}
```

## Estrutura do projeto

```
colmeia-api/
├── src/
│   ├── server.js          # Entry point: Express, middlewares, rotas, shutdown
│   ├── db.js              # SQLite (better-sqlite3): schema, indices, helpers
│   ├── routes/
│   │   ├── sensors.js     # /api/sensor-data*
│   │   ├── stats.js       # /api/stats
│   │   └── devices.js     # /api/devices
│   └── public/            # Dashboard (index.html, style.css, app.js)
├── data/                  # Volume persistente do SQLite (montar em /app/data)
├── seed.js                # Popula ~200 leituras fake (npm run seed)
├── Dockerfile
├── .env.example
└── README.md
```

## Notas

- **Sem autenticacao** por enquanto (uso pessoal/academico); a estrutura esta
  preparada para adicionar API key (ver `.env.example` e `TODO` no codigo).
- O servidor faz *graceful shutdown* em `SIGTERM`/`SIGINT`, fechando o banco.
- O body parser aceita JSON de ate 10kb.
- **Dashboard:** cards (temp, umidade, peso bruto, audio RMS, vibracao),
  graficos ao longo do tempo, **espectro** (barras da ultima leitura) e
  **espectrograma** (heatmap 0–2 kHz x tempo). O peso aparece bruto ate haver
  calibracao — defina `PESO_CAL` em `src/public/app.js` para converter em kg.
- **Firmware (`colmeia_esp.ino`):** telemetria (core 1) e audio (core 0) usam um
  mutex (`netMutex`) para nao fazer handshakes TLS simultaneos — sem ele, o
  `POST /api/sensor-data` falhava no proprio ESP (por falta de heap) enquanto uma
  rajada de audio estava no ar, e a leitura nem chegava ao servidor.
- `npm ci --omit=dev` no Dockerfile instala apenas dependencias de producao
  (equivalente moderno de `npm ci --production`).
