'use strict';

/**
 * Popula o banco com ~200 leituras fake distribuidas nas ultimas 24h,
 * para visualizar o dashboard antes de ligar o ESP32 real.
 *
 * Uso: npm run seed
 * (apaga as leituras existentes dos devices de exemplo e regrava)
 */

const db = require('./src/db');

const DEVICES = ['colmeia_01', 'colmeia_02'];
const READINGS_PER_DEVICE = 100; // 2 devices x 100 = 200 leituras
const WINDOW_SECONDS = 24 * 3600;

const now = db.nowUnix();
const start = now - WINDOW_SECONDS;
const stepDevice01 = WINDOW_SECONDS / READINGS_PER_DEVICE;

function noise(amp) {
  return (Math.random() - 0.5) * 2 * amp;
}

// Curva diurna suave: senoide com periodo de 24h (pico ~tarde).
function diurnal(tsFraction) {
  return Math.sin((tsFraction * 2 - 0.5) * Math.PI);
}

function buildReading(deviceId, ts, i, total) {
  const frac = i / total; // 0..1 ao longo da janela
  const wave = diurnal(frac);

  // Temperaturas em torno de 28C, com leve variacao entre sensores.
  const temp1 = round(27.5 + wave * 3 + noise(0.4));
  const temp2 = round(27.0 + wave * 2.8 + noise(0.4));

  // Umidade inversamente relacionada a temperatura (~55-75%).
  const umid1 = round(65 - wave * 8 + noise(1.5));
  const umid2 = round(66 - wave * 7.5 + noise(1.5));

  // Peso cresce lentamente ao longo do tempo (mel acumulando) ~12kg.
  const pesoKg = round(12.0 + frac * 0.6 + noise(0.03));
  const pesoRaw = Math.round(pesoKg * 19900 + noise(50));

  // Acelerometro praticamente parado (gravidade no eixo Z).
  const accelX = round(noise(0.03), 3);
  const accelY = round(noise(0.03), 3);
  const accelZ = round(9.81 + noise(0.05), 3);

  // Audio RMS geral (dBFS): mais alto (proximo de 0) durante o dia.
  const audioRms = round(-45 + (wave + 1) / 2 * 12 + noise(1.5), 1);

  // Espectro de 20 faixas de 100 Hz (0-2 kHz) em dBFS. A energia das abelhas
  // concentra-se em ~150-450 Hz; modela-se uma gaussiana + ruido, com o nivel
  // subindo com a atividade diurna (wave). Mesmo formato de audio_bands do ESP.
  const audioBands = [];
  for (let b = 0; b < 20; b++) {
    const centerHz = b * 100 + 50;
    const shape = Math.exp(-Math.pow((centerHz - 300) / 250, 2)); // pico ~300 Hz
    audioBands.push(round(-85 + shape * (35 + (wave + 1) * 8) + noise(3), 1));
  }

  return {
    device_id: deviceId,
    timestamp: ts,
    received_at: ts + Math.floor(Math.random() * 3),
    temperatura_1: temp1,
    umidade_1: umid1,
    temperatura_2: temp2,
    umidade_2: umid2,
    peso_raw: pesoRaw,
    accel_x: accelX,
    accel_y: accelY,
    accel_z: accelZ,
    audio_rms: audioRms,
    audio_bands: audioBands,
  };
}

function round(v, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function run() {
  console.log('[seed] limpando leituras dos devices de exemplo...');
  const placeholders = DEVICES.map(() => '?').join(', ');
  db.db.prepare(`DELETE FROM sensor_readings WHERE device_id IN (${placeholders})`).run(...DEVICES);

  // Transacao para inserir tudo de uma vez (rapido).
  const insertMany = db.db.transaction((readings) => {
    for (const r of readings) db.insertReading(r);
  });

  let total = 0;
  for (const deviceId of DEVICES) {
    const readings = [];
    for (let i = 0; i < READINGS_PER_DEVICE; i++) {
      const ts = Math.floor(start + i * stepDevice01);
      readings.push(buildReading(deviceId, ts, i, READINGS_PER_DEVICE));
    }
    insertMany(readings);
    total += readings.length;
    console.log(`[seed] ${readings.length} leituras inseridas para ${deviceId}`);
  }

  console.log(`[seed] concluido. Total: ${total} leituras nas ultimas 24h.`);
  db.close();
}

run();
