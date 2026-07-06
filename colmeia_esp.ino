// =====================================================
// Projeto Colmeia 4.0 - TCC   (FIRMWARE DE CAMPO V5)
//
// Merge do V4 (dual-core + FFT + rajadas de audio) com:
//   - Telemetria dos sensores a cada 15 s.
//   - Espectro por BANDAS de 100 Hz (0 a 2 kHz = 20 faixas),
//     RMS por banda em dBFS, com MEDIA sobre janela de 30 s.
//   - FFT_N = 1024 (bin ~15,6 Hz) para resolver as faixas.
//
// Nucleo 1 (loop): DHT22 x2, MPU-6050, HX711, LED, telemetria JSON
//                  (sensores + audio_rms geral + audio_bands[20]).
// Nucleo 0 (task): monitora RMS + energia por banda (FFT continua),
//                  acumula a media de 30 s das 20 bandas, detecta
//                  anomalia, e envia audio em RAJADA (clipes de 2 s)
//                  a cada 15 min e em anomalia. Sem cartao SD.
//
// (Servo e fim de curso REMOVIDOS. LED mantido do V4 - opcional.)
// Bibliotecas extras: "arduinoFFT" v2.x (kosme / Enrique Condes)
// =====================================================

#include <Wire.h>
#include <DHTesp.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include "HX711.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <driver/i2s.h>
#include <arduinoFFT.h>

// =====================================================
// >>> COMPORTAMENTO (ajuste aqui) <<<
// =====================================================
const unsigned long INTERVALO_AUDIO_MS = 30UL * 60UL * 1000UL; // rajada a cada 30 min. Pra TESTAR: 60000 (1 min).
const int  BURST_CLIPS = 8;         // clipes de 2 s por rajada -> ~16 s de audio (costura no servidor)

const float ANOMALY_FACTOR = 8.0;   // dispara se a energia da banda passar de 4x o normal atual
const unsigned long COOLDOWN_ANOMALIA_MS = 60UL * 8000UL;      // 1 min entre disparos

const unsigned long BAND_WINDOW_MS = 30UL * 1000UL;            // NOVO: janela de media das bandas (30 s)

// =====================================================
// PINOS  (identicos ao V4 e a versao anterior)
// =====================================================
const int DHT1_PIN   = 5;
const int DHT2_PIN   = 16;
const int HX_DT_PIN  = 19;   // HX711 DT / DOUT
const int HX_SCK_PIN = 18;   // HX711 SCK / PD_SCK
const int I2S_WS     = 25;
const int I2S_SCK    = 26;
const int I2S_SD     = 33;
const int LED_PIN    = 15;   // opcional (alerta de temperatura); remova se nao usar

// =====================================================
// AUDIO
// =====================================================
#define SAMPLE_RATE   16000
#define AUDIO_SEG_SEC 2
#define I2S_PORT      I2S_NUM_0
const size_t SEG_SAMPLES = (size_t)SAMPLE_RATE * AUDIO_SEG_SEC;
const size_t SEG_BYTES   = SEG_SAMPLES * 2;              // 16-bit
int32_t  i2sChunk[256];
int16_t* segBuf = nullptr;                              // 64 KB (alocado no setup)
volatile float g_audio_dbfs = -120.0;

// ---- FFT ----
#define FFT_N 512
float vReal[FFT_N];
float vImag[FFT_N];
ArduinoFFT<float> FFT = ArduinoFFT<float>(vReal, vImag, FFT_N, (float)SAMPLE_RATE);
const float BIN_HZ = (float)SAMPLE_RATE / (float)FFT_N;   // ~15,625 Hz

// Deteccao de anomalia (banda larga das abelhas)
const int   BAND_LOW_HZ  = 150;
const int   BAND_HIGH_HZ = 2000;
const int   binLow  = (int)(BAND_LOW_HZ  / BIN_HZ);
const int   binHigh = (int)(BAND_HIGH_HZ / BIN_HZ);
float g_band_baseline = 0;
volatile float g_band_ratio = 1.0;

// ---- Espectro por bandas de 100 Hz (telemetria) ----
#define BAND_HZ_STEP  100
#define BAND_MAX_HZ   2000
#define NUM_BANDS     (BAND_MAX_HZ / BAND_HZ_STEP)   // 20 faixas: [0-100), ..., [1900-2000)
float  g_bands[NUM_BANDS];                           // publicado (dBFS por faixa), lido pelo nucleo 1
volatile bool g_bands_valido = false;
portMUX_TYPE bandsMux = portMUX_INITIALIZER_UNLOCKED;

// Acumuladores da janela de 30 s (usados APENAS no nucleo 0)
double  bandAccum[NUM_BANDS];
uint32_t bandBlocks = 0;
unsigned long tBandWin = 0;

// =====================================================
// WI-FI / API / NTP / SEGURANCA
// =====================================================
const char* WIFI_SSID     = "Sara";
const char* WIFI_PASSWORD = "10071964";              // <-- preencha (segredo)

const char* API_URL   = "https://colmeia.astraflow.io/api/sensor-data";
const char* AUDIO_URL = "https://colmeia.astraflow.io/api/audio";
const char* DEVICE_ID = "colmeia_01";
const char* API_TOKEN = "cishjdbckihhdbcajsncpoauhc82h81-98ijcpoinp98h";                  // <-- preencha (segredo)

const char* NTP_SERVER          = "pool.ntp.org";
const long  GMT_OFFSET_SEC      = -3 * 3600;
const int   DAYLIGHT_OFFSET_SEC = 0;

// =====================================================
// INTERVALOS (ms) DA TELEMETRIA (nucleo 1)
// =====================================================
const long INTERVAL_DHT     = 2000;
const long INTERVAL_MPU     = 200;
const long INTERVAL_HX711   = 1000;
const long INTERVAL_POST    = 15000;   // <<< ALTERADO: 15 s
const long INTERVAL_WIFICHK = 10000;

// =====================================================
// OBJETOS E ESTADO
// =====================================================
DHTesp dht1, dht2;
Adafruit_MPU6050 mpu;
HX711 scale;

unsigned long tDHT = 0, tMPU = 0, tHX = 0, tPOST = 0, tWIFI = 0;
int contador_envios = 0;
TaskHandle_t audioTaskHandle = nullptr;

// Mutex de rede: serializa o acesso TLS entre os dois nucleos.
// O ESP32 faz TLS por mbedTLS, que NAO tolera dois handshakes simultaneos
// (core 0 = audio, core 1 = telemetria) e esgota o heap. Sem este mutex, o
// POST /api/sensor-data falhava silenciosamente enquanto o audio estava no ar.
SemaphoreHandle_t netMutex = nullptr;

struct DadosColmeia {
  float temp1 = NAN, umid1 = NAN;
  float temp2 = NAN, umid2 = NAN;
  float accel_x = NAN, accel_y = NAN, accel_z = NAN;
  long  peso_raw = 0;
  bool  peso_valido = false;
};
DadosColmeia dados;

// Prototipos
void setup_i2s();
bool monitorBlock();
void doBurst(bool anomaly, WiFiClientSecure &cli, HTTPClient &http, int &backoff);
void audioTask(void* p);
void ler_dhts(); void ler_mpu(); void ler_hx711();
void atualizar_led();
void conectar_wifi(); void sincronizar_ntp(); void enviar_dados();

// =====================================================
// SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n========================================");
  Serial.println("  Colmeia 4.0 - FIRMWARE DE CAMPO V5");
  Serial.println("========================================\n");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  if (!mpu.begin()) {
    Serial.println("[INIT] AVISO: MPU6050 nao encontrado.");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("[INIT] MPU6050 OK.");
  }

  dht1.setup(DHT1_PIN, DHTesp::DHT22);
  dht2.setup(DHT2_PIN, DHTesp::DHT22);
  Serial.println("[INIT] DHT22 #1 e #2 OK.");

  scale.begin(HX_DT_PIN, HX_SCK_PIN);
  scale.tare();
  Serial.println("[INIT] HX711 inicializado (tara feita).");

  setup_i2s();

  segBuf = (int16_t*)malloc(SEG_BYTES);
  if (segBuf == nullptr) Serial.println("[INIT] ERRO: sem RAM pro audio. Audio DESATIVADO.");
  else Serial.printf("[INIT] Buffer de audio: %u bytes.\n", (unsigned)SEG_BYTES);

  for (int i = 0; i < NUM_BANDS; i++) { bandAccum[i] = 0; g_bands[i] = -120.0f; }

  Serial.printf("[INIT] Anomalia: banda %d-%d Hz (bins %d-%d).\n",
                BAND_LOW_HZ, BAND_HIGH_HZ, binLow, binHigh);
  Serial.printf("[INIT] Telemetria: %d bandas de %d Hz (0-%d Hz), media de %lu s.\n",
                NUM_BANDS, BAND_HZ_STEP, BAND_MAX_HZ, BAND_WINDOW_MS / 1000);

  conectar_wifi();
  sincronizar_ntp();

  // Cria o mutex de rede ANTES de subir a tarefa de audio (core 0).
  netMutex = xSemaphoreCreateMutex();
  if (netMutex == nullptr) Serial.println("[INIT] AVISO: falha ao criar netMutex.");

  if (segBuf != nullptr) {
    xTaskCreatePinnedToCore(audioTask, "audio", 16384, NULL, 1, &audioTaskHandle, 0);
    Serial.println("[INIT] Tarefa de audio criada no core 0.");
  }
  Serial.println("\n[INIT] Setup concluido.\n");
}

// =====================================================
// LOOP (NUCLEO 1) - sensores + telemetria
// =====================================================
void loop() {
  unsigned long agora = millis();
  if (agora - tDHT  >= INTERVAL_DHT)   { tDHT = agora;  ler_dhts(); atualizar_led(); }
  if (agora - tMPU  >= INTERVAL_MPU)   { tMPU = agora;  ler_mpu(); }
  if (agora - tHX   >= INTERVAL_HX711) { tHX = agora;   ler_hx711(); }
  if (agora - tWIFI >= INTERVAL_WIFICHK) {
    tWIFI = agora;
    if (WiFi.status() != WL_CONNECTED) { Serial.println("[WIFI] Caiu. Reconectando..."); conectar_wifi(); }
  }
  if (agora - tPOST >= INTERVAL_POST) { tPOST = agora; enviar_dados(); }
}

// =====================================================
// MONITOR (NUCLEO 0) - RMS geral + bandas de 100 Hz + anomalia
// =====================================================
bool monitorBlock() {
  static int warmup = 300;
  static int printc = 0;

  // 1) Preenche a janela da FFT com amostras (24 bits) e calcula o RMS geral
  size_t got = 0; int filled = 0; double somaQuad = 0;
  while (filled < FFT_N) {
    i2s_read(I2S_PORT, i2sChunk, sizeof(i2sChunk), &got, portMAX_DELAY);
    int n = got / sizeof(int32_t);
    for (int i = 0; i < n && filled < FFT_N; i++) {
      float f = (float)(i2sChunk[i] >> 8);
      somaQuad += (double)f * f;
      vReal[filled] = f; vImag[filled] = 0; filled++;
    }
  }
  double rms = sqrt(somaQuad / (double)FFT_N);
  g_audio_dbfs = rms > 0 ? 20.0f * log10f((float)(rms / 8388608.0)) : -120.0f;

  // 2) FFT -> espectro de magnitude em vReal
  FFT.windowing(FFTWindow::Hamming, FFTDirection::Forward);
  FFT.compute(FFTDirection::Forward);
  FFT.complexToMagnitude();

  // 3) Energia na banda larga (deteccao de anomalia)
  float band = 0;
  for (int b = binLow; b <= binHigh; b++) band += vReal[b];
  if (g_band_baseline <= 0) g_band_baseline = band;
  g_band_ratio = (g_band_baseline > 0) ? band / g_band_baseline : 1.0f;

  bool anomaly = false;
  if (warmup > 0) {
    warmup--;
    g_band_baseline = 0.9f * g_band_baseline + 0.1f * band;
  } else if (g_band_ratio >= ANOMALY_FACTOR) {
    anomaly = true;
  } else {
    g_band_baseline = 0.98f * g_band_baseline + 0.02f * band;
  }

  // 4) Acumula a potencia por banda de 100 Hz (telemetria)
  double blockBand[NUM_BANDS];
  for (int i = 0; i < NUM_BANDS; i++) blockBand[i] = 0.0;
  for (int b = 1; b < FFT_N / 2; b++) {           // pula o bin 0 (DC/offset)
    float freq = b * BIN_HZ;
    if (freq >= BAND_MAX_HZ) break;
    int bi = (int)(freq / BAND_HZ_STEP);          // 0..NUM_BANDS-1
    blockBand[bi] += (double)vReal[b] * (double)vReal[b];
  }
  for (int i = 0; i < NUM_BANDS; i++) bandAccum[i] += blockBand[i];
  bandBlocks++;

  // 5) Fecha a janela de 30 s: calcula a media e publica as bandas
  if (millis() - tBandWin >= BAND_WINDOW_MS && bandBlocks > 0) {
    float tmp[NUM_BANDS];
    for (int i = 0; i < NUM_BANDS; i++) {
      double avgP  = bandAccum[i] / (double)bandBlocks;   // potencia media da faixa
      double rmsB  = sqrt(avgP) / (double)FFT_N;          // RMS da faixa (proxy consistente)
      tmp[i] = (rmsB > 1e-9) ? 20.0f * log10f((float)(rmsB / 8388608.0)) : -120.0f;
    }
    taskENTER_CRITICAL(&bandsMux);
    for (int i = 0; i < NUM_BANDS; i++) g_bands[i] = tmp[i];
    g_bands_valido = true;
    taskEXIT_CRITICAL(&bandsMux);

    for (int i = 0; i < NUM_BANDS; i++) bandAccum[i] = 0;
    bandBlocks = 0;
    tBandWin = millis();
  }

  if (++printc >= 150) {
    printc = 0;
    Serial.printf("[MON] rms %.0f dBFS | banda ratio %.2f (fator=%.1f)\n",
                  g_audio_dbfs, g_band_ratio, ANOMALY_FACTOR);
  }
  return anomaly;
}

// =====================================================
// RAJADA (NUCLEO 0) - envia clipes de 2 s ao /api/audio
// =====================================================
void doBurst(bool anomaly, WiFiClientSecure &cli, HTTPClient &http, int &backoff) {
  uint32_t session = (uint32_t)time(nullptr);
  const char* trig = anomaly ? "anomaly" : "periodic";
  Serial.printf("[AUDIO] Rajada %s (sessao %u) - %d clipes\n", trig, session, BURST_CLIPS);
  int fails = 0;

  for (int seq = 0; seq < BURST_CLIPS; seq++) {
    size_t idx = 0, got = 0;
    while (idx < SEG_SAMPLES) {
      i2s_read(I2S_PORT, i2sChunk, sizeof(i2sChunk), &got, portMAX_DELAY);
      int n = got / sizeof(int32_t);
      for (int i = 0; i < n && idx < SEG_SAMPLES; i++)
        segBuf[idx++] = (int16_t)(i2sChunk[i] >> 16);   // 16-bit para armazenamento
    }

    bool ok = false;
    if (WiFi.status() == WL_CONNECTED) {
      time_t ts = time(nullptr);
      if (ts > 1700000000) {
        // Toma o mutex de rede POR CLIPE: entre clipes ele fica livre, deixando
        // o POST dos sensores (core 1) se encaixar sem colidir com o TLS do audio.
        if (netMutex) xSemaphoreTake(netMutex, portMAX_DELAY);
        http.begin(cli, AUDIO_URL);
        http.addHeader("Content-Type", "application/octet-stream");
        http.addHeader("Authorization", String("Bearer ") + API_TOKEN);
        http.addHeader("X-Device-Id", DEVICE_ID);
        http.addHeader("X-Session", String(session));
        http.addHeader("X-Seq", String(seq));
        http.addHeader("X-Trigger", trig);
        http.addHeader("X-Timestamp", String((long)ts));
        http.addHeader("X-Sample-Rate", String(SAMPLE_RATE));
        http.addHeader("X-Bits", "16");
        http.addHeader("X-Channels", "1");
        int code = http.POST((uint8_t*)segBuf, SEG_BYTES);
        http.end();
        if (netMutex) xSemaphoreGive(netMutex);
        ok = (code == 200 || code == 201);
        if (!ok) Serial.printf("[AUDIO] clipe %d falhou (cod %d)\n", seq, code);
      }
    }

    if (ok) {
      Serial.printf("[AUDIO] clipe %d/%d ok\n", seq + 1, BURST_CLIPS);
      backoff = 2000; fails = 0;
    } else {
      cli.stop();
      vTaskDelay(pdMS_TO_TICKS(backoff));
      backoff = min(backoff * 2, 32000);
      if (++fails >= 2) { Serial.println("[AUDIO] rede instavel: abortando rajada."); break; }
    }
  }
  // Fecha a conexao TLS do audio ao fim da rajada: entre rajadas (que sao
  // esparsas) o heap fica livre para o handshake do POST dos sensores.
  cli.stop();
}

// =====================================================
// TAREFA DE AUDIO (NUCLEO 0)
// =====================================================
void audioTask(void* p) {
  WiFiClientSecure audioClient;
  audioClient.setInsecure();
  audioClient.setTimeout(8000);
  HTTPClient audioHttp;
  audioHttp.setReuse(true);

  unsigned long tLastBurst   = millis() - INTERVALO_AUDIO_MS + 20000;
  unsigned long tLastAnomaly = 0;
  int backoff = 2000;
  tBandWin = millis();   // inicia a janela das bandas

  for (;;) {
    bool anomaly = monitorBlock();

    bool periodic = (millis() - tLastBurst >= INTERVALO_AUDIO_MS);
    bool anom = anomaly && (millis() - tLastAnomaly >= COOLDOWN_ANOMALIA_MS);

    if (periodic || anom) {
      if (anom) Serial.printf("[AUDIO] ANOMALIA! banda ratio=%.1f\n", g_band_ratio);
      doBurst(anom, audioClient, audioHttp, backoff);
      tLastBurst = millis();
      if (anom) tLastAnomaly = millis();
      tBandWin = millis();   // reinicia a janela das bandas apos a rajada
    }
  }
}

// =====================================================
// I2S (microfone)
// =====================================================
void setup_i2s() {
  const i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  const i2s_pin_config_t pins = {
    .bck_io_num = I2S_SCK, .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE, .data_in_num = I2S_SD
  };
  if (i2s_driver_install(I2S_PORT, &cfg, 0, NULL) != ESP_OK) { Serial.println("[INIT] ERRO I2S."); return; }
  i2s_set_pin(I2S_PORT, &pins);
  Serial.println("[INIT] INMP441 (I2S) OK.");
}

// =====================================================
// SENSORES
// =====================================================
void ler_dhts() {
  TempAndHumidity d1 = dht1.getTempAndHumidity();
  TempAndHumidity d2 = dht2.getTempAndHumidity();
  if (String(dht1.getStatusString()) == "OK") { dados.temp1 = d1.temperature; dados.umid1 = d1.humidity;
    Serial.printf("[DHT1] %.2f C | %.1f%%\n", dados.temp1, dados.umid1); }
  else Serial.printf("[DHT1] Erro: %s\n", dht1.getStatusString());
  if (String(dht2.getStatusString()) == "OK") { dados.temp2 = d2.temperature; dados.umid2 = d2.humidity;
    Serial.printf("[DHT2] %.2f C | %.1f%%\n", dados.temp2, dados.umid2); }
  else Serial.printf("[DHT2] Erro: %s\n", dht2.getStatusString());
}

void ler_mpu() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  dados.accel_x = a.acceleration.x; dados.accel_y = a.acceleration.y; dados.accel_z = a.acceleration.z;
}

void ler_hx711() {
  if (scale.is_ready()) {
    dados.peso_raw = scale.read_average(2);
    dados.peso_valido = true;
    Serial.printf("[HX711] Raw: %ld\n", dados.peso_raw);
  } else {
    dados.peso_valido = false;
    Serial.println("[HX711] Nao pronto (verifique DT=19, SCK=18, VCC=3V3, GND).");
  }
}

void atualizar_led() {
  float tmax = -100.0;
  if (!isnan(dados.temp1)) tmax = max(tmax, dados.temp1);
  if (!isnan(dados.temp2)) tmax = max(tmax, dados.temp2);
  digitalWrite(LED_PIN, (tmax > 30.0) ? HIGH : LOW);
}

// =====================================================
// WI-FI / NTP
// =====================================================
void conectar_wifi() {
  Serial.printf("[WIFI] Conectando em %s", WIFI_SSID);
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int t = 0;
  while (WiFi.status() != WL_CONNECTED && t < 30) { delay(500); Serial.print("."); t++; }
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf(" OK! IP %s | RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  else Serial.println(" FALHOU!");
}

void sincronizar_ntp() {
  Serial.print("[NTP] Sincronizando");
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  struct tm ti; int t = 0;
  while (!getLocalTime(&ti) && t < 20) { delay(500); Serial.print("."); t++; }
  if (getLocalTime(&ti))
    Serial.printf(" OK! %04d-%02d-%02d %02d:%02d:%02d\n",
                  ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday, ti.tm_hour, ti.tm_min, ti.tm_sec);
  else Serial.println(" FALHOU!");
}

// =====================================================
// TELEMETRIA (JSON) - NUCLEO 1
// audio_bands[i] = dBFS medio da faixa [i*100, (i+1)*100) Hz, i=0..19
// =====================================================
void enviar_dados() {
  contador_envios++;
  Serial.printf("\n----- [POST #%d] -----\n", contador_envios);
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[POST] Sem Wi-Fi. Pula."); return; }
  time_t agora = time(nullptr);
  if (agora < 1700000000) { Serial.println("[POST] Timestamp invalido. Pula."); return; }

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"timestamp\":" + String((long)agora);
  if (!isnan(dados.temp1))   payload += ",\"temperatura_1\":" + String(dados.temp1, 2);
  if (!isnan(dados.umid1))   payload += ",\"umidade_1\":"     + String(dados.umid1, 2);
  if (!isnan(dados.temp2))   payload += ",\"temperatura_2\":" + String(dados.temp2, 2);
  if (!isnan(dados.umid2))   payload += ",\"umidade_2\":"     + String(dados.umid2, 2);
  if (!isnan(dados.accel_x)) payload += ",\"accel_x\":"       + String(dados.accel_x, 3);
  if (!isnan(dados.accel_y)) payload += ",\"accel_y\":"       + String(dados.accel_y, 3);
  if (!isnan(dados.accel_z)) payload += ",\"accel_z\":"       + String(dados.accel_z, 3);
  if (dados.peso_valido)     payload += ",\"peso_raw\":"      + String(dados.peso_raw);

  // RMS geral (dBFS)
  payload += ",\"audio_rms\":" + String((float)g_audio_dbfs, 1);

  // Espectro por bandas de 100 Hz (dBFS, media de 30 s) - copia protegida entre nucleos
  bool bandsOk = false;
  float localBands[NUM_BANDS];
  taskENTER_CRITICAL(&bandsMux);
  bandsOk = g_bands_valido;
  if (bandsOk) for (int i = 0; i < NUM_BANDS; i++) localBands[i] = g_bands[i];
  taskEXIT_CRITICAL(&bandsMux);

  if (bandsOk) {
    payload += ",\"audio_bands\":[";
    for (int i = 0; i < NUM_BANDS; i++) {
      payload += String(localBands[i], 1);
      if (i < NUM_BANDS - 1) payload += ",";
    }
    payload += "]";
  }

  payload += "}";
  Serial.println("Payload: " + payload);

  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;

  // Serializa com a tarefa de audio (core 0). Sem isto, quando uma rajada de
  // audio esta no ar, este handshake TLS falha por falta de heap e a leitura
  // e perdida antes mesmo de sair do ESP (nao aparece nem no log do servidor).
  if (netMutex) xSemaphoreTake(netMutex, portMAX_DELAY);
  http.begin(client, API_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + API_TOKEN);
  http.setTimeout(10000);
  int code = http.POST(payload);
  if (code > 0) { Serial.printf("[POST] HTTP %d\n", code);
    if (code != 200 && code != 201) Serial.println("[POST] Resp: " + http.getString()); }
  else Serial.printf("[POST] Erro: %s\n", http.errorToString(code).c_str());
  http.end();
  client.stop();                     // libera o socket/heap TLS de imediato
  if (netMutex) xSemaphoreGive(netMutex);
}
