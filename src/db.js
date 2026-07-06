'use strict';

/**
 * Camada de banco de dados (SQLite via better-sqlite3).
 *
 * better-sqlite3 e sincrono: cada chamada retorna o resultado direto,
 * sem callbacks/promises. Simples e rapido, perfeito para este TCC.
 *
 * Exporta o handle `db` e funcoes helper usadas pelas rotas, para que a
 * logica de SQL fique concentrada aqui (e os routers fiquem finos).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'colmeia.db');

// Garante que o diretorio do banco exista (ex.: ./data ou /app/data).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // melhor concorrencia leitura/escrita
db.pragma('foreign_keys = ON');

// --- Schema / migration (idempotente) ------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT    NOT NULL,
    timestamp     INTEGER NOT NULL,
    received_at   INTEGER NOT NULL,
    temperatura_1 REAL,
    umidade_1     REAL,
    temperatura_2 REAL,
    umidade_2     REAL,
    peso_raw      INTEGER,
    peso_kg       REAL,
    accel_x       REAL,
    accel_y       REAL,
    accel_z       REAL,
    audio_rms     REAL,
    audio_bands   TEXT,
    servo_status  TEXT,
    fim_curso     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_readings_device_id ON sensor_readings (device_id);
  CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON sensor_readings (timestamp);
`);

// Migracao para bancos que ja existiam sem a coluna audio_bands.
// (CREATE TABLE IF NOT EXISTS nao altera tabela existente.)
const colunas = db.prepare('PRAGMA table_info(sensor_readings)').all();
if (!colunas.some((c) => c.name === 'audio_bands')) {
  db.exec('ALTER TABLE sensor_readings ADD COLUMN audio_bands TEXT');
}

// --- Prepared statements ---------------------------------------------------

const insertStmt = db.prepare(`
  INSERT INTO sensor_readings (
    device_id, timestamp, received_at,
    temperatura_1, umidade_1, temperatura_2, umidade_2,
    peso_raw, peso_kg, accel_x, accel_y, accel_z,
    audio_rms, audio_bands, servo_status, fim_curso
  ) VALUES (
    @device_id, @timestamp, @received_at,
    @temperatura_1, @umidade_1, @temperatura_2, @umidade_2,
    @peso_raw, @peso_kg, @accel_x, @accel_y, @accel_z,
    @audio_rms, @audio_bands, @servo_status, @fim_curso
  )
`);

// Colunas opcionais simples: usamos um template com null para campos ausentes.
const OPTIONAL_COLUMNS = [
  'temperatura_1', 'umidade_1', 'temperatura_2', 'umidade_2',
  'peso_raw', 'peso_kg', 'accel_x', 'accel_y', 'accel_z',
  'audio_rms', 'servo_status', 'fim_curso',
];

/**
 * Insere uma leitura. `reading` ja deve estar validado (device_id, timestamp).
 * Campos opcionais ausentes viram NULL. `fim_curso` boolean vira 0/1.
 * `audio_bands` (array de numeros) e guardado como texto JSON.
 * Retorna o id inserido.
 */
function insertReading(reading) {
  const row = {
    device_id: reading.device_id,
    timestamp: reading.timestamp,
    received_at: reading.received_at != null ? reading.received_at : nowUnix(),
  };

  for (const col of OPTIONAL_COLUMNS) {
    let value = reading[col];
    if (value === undefined) value = null;
    if (col === 'fim_curso' && typeof value === 'boolean') {
      value = value ? 1 : 0;
    }
    row[col] = value;
  }

  // audio_bands: array -> JSON string (ou null se ausente/vazio)
  row.audio_bands = Array.isArray(reading.audio_bands) && reading.audio_bands.length
    ? JSON.stringify(reading.audio_bands)
    : null;

  const info = insertStmt.run(row);
  return info.lastInsertRowid;
}

// Converte a coluna audio_bands (texto JSON) de volta para array nas leituras.
function parseRow(row) {
  if (row && typeof row.audio_bands === 'string') {
    try {
      row.audio_bands = JSON.parse(row.audio_bands);
    } catch (_) {
      row.audio_bands = null;
    }
  }
  return row;
}

/**
 * Consulta leituras com filtros opcionais.
 * @param {{device_id?: string, limit?: number, since?: number, until?: number}} opts
 */
function queryReadings(opts = {}) {
  const clauses = [];
  const params = {};

  if (opts.device_id) {
    clauses.push('device_id = @device_id');
    params.device_id = opts.device_id;
  }
  if (opts.since != null) {
    clauses.push('timestamp >= @since');
    params.since = opts.since;
  }
  if (opts.until != null) {
    clauses.push('timestamp <= @until');
    params.until = opts.until;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = clampLimit(opts.limit);
  params.limit = limit;

  const sql = `
    SELECT * FROM sensor_readings
    ${where}
    ORDER BY timestamp DESC, id DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params).map(parseRow);
}

/**
 * Retorna a leitura mais recente de cada device_id.
 */
function latestPerDevice() {
  // Para cada device, pega a linha com maior (timestamp, id).
  const sql = `
    SELECT r.* FROM sensor_readings r
    JOIN (
      SELECT device_id, MAX(timestamp) AS max_ts
      FROM sensor_readings
      GROUP BY device_id
    ) m ON r.device_id = m.device_id AND r.timestamp = m.max_ts
    GROUP BY r.device_id
    ORDER BY r.device_id
  `;
  return db.prepare(sql).all().map(parseRow);
}

/**
 * Estatisticas agregadas das ultimas 24h (ou janela custom via `since`).
 * @param {{device_id?: string, since?: number}} opts
 */
function stats24h(opts = {}) {
  const since = opts.since != null ? opts.since : nowUnix() - 24 * 3600;
  const params = { since };
  let deviceClause = '';
  if (opts.device_id) {
    deviceClause = 'AND device_id = @device_id';
    params.device_id = opts.device_id;
  }

  const sql = `
    SELECT
      COUNT(*) AS count,
      MIN(temperatura_1) AS temp1_min, MAX(temperatura_1) AS temp1_max, AVG(temperatura_1) AS temp1_avg,
      MIN(temperatura_2) AS temp2_min, MAX(temperatura_2) AS temp2_max, AVG(temperatura_2) AS temp2_avg,
      MIN(umidade_1)     AS umid1_min, MAX(umidade_1)     AS umid1_max, AVG(umidade_1)     AS umid1_avg,
      MIN(umidade_2)     AS umid2_min, MAX(umidade_2)     AS umid2_max, AVG(umidade_2)     AS umid2_avg,
      MIN(peso_kg)       AS peso_min,  MAX(peso_kg)       AS peso_max,  AVG(peso_kg)       AS peso_avg,
      MIN(peso_raw)      AS pesoraw_min, MAX(peso_raw)    AS pesoraw_max, AVG(peso_raw)     AS pesoraw_avg,
      MIN(audio_rms)     AS audio_min, MAX(audio_rms)     AS audio_max, AVG(audio_rms)     AS audio_avg
    FROM sensor_readings
    WHERE timestamp >= @since ${deviceClause}
  `;
  return db.prepare(sql).get(params);
}

/**
 * Lista device_ids unicos com timestamp da ultima leitura e contagem.
 */
function listDevices() {
  const sql = `
    SELECT
      device_id,
      MAX(timestamp)   AS last_timestamp,
      MAX(received_at) AS last_received_at,
      COUNT(*)         AS reading_count
    FROM sensor_readings
    GROUP BY device_id
    ORDER BY last_timestamp DESC
  `;
  return db.prepare(sql).all();
}

/**
 * Deleta leituras anteriores a `olderThan` (timestamp Unix). Retorna a contagem.
 */
function deleteOlderThan(olderThan) {
  const info = db.prepare('DELETE FROM sensor_readings WHERE timestamp < ?').run(olderThan);
  return info.changes;
}

/**
 * Verifica saude do banco (usado no /api/health). Lanca se algo estiver errado.
 */
function healthCheck() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sensor_readings').get();
  return { ok: true, total_readings: row.n };
}

function close() {
  db.close();
}

// --- Helpers ---------------------------------------------------------------

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 100; // default
  return Math.min(Math.floor(n), 1000); // max 1000
}

module.exports = {
  db,
  DB_PATH,
  insertReading,
  queryReadings,
  latestPerDevice,
  stats24h,
  listDevices,
  deleteOlderThan,
  healthCheck,
  close,
  nowUnix,
};
