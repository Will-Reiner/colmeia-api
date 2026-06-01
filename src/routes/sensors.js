'use strict';

/**
 * Endpoints /api/sensor-data*
 */

const express = require('express');
const { z } = require('zod');
const db = require('../db');

const router = express.Router();

// --- Validacao do payload (POST) ------------------------------------------
// device_id e timestamp obrigatorios; todos os demais campos opcionais.
const sensorSchema = z.object({
  device_id: z.string().min(1, 'device_id e obrigatorio'),
  timestamp: z.number().int('timestamp deve ser um inteiro (Unix epoch em segundos)'),
  temperatura_1: z.number().optional(),
  umidade_1: z.number().optional(),
  temperatura_2: z.number().optional(),
  umidade_2: z.number().optional(),
  peso_raw: z.number().int().optional(),
  peso_kg: z.number().optional(),
  accel_x: z.number().optional(),
  accel_y: z.number().optional(),
  accel_z: z.number().optional(),
  audio_rms: z.number().optional(),
  servo_status: z.string().optional(),
  fim_curso: z.boolean().optional(),
}).strict();

// POST /api/sensor-data  -> recebe leitura do ESP32
router.post('/sensor-data', (req, res, next) => {
  const parsed = sensorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        message: 'Payload invalido',
        details: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      },
    });
  }

  try {
    const id = db.insertReading(parsed.data);
    return res.status(201).json({ status: 'ok', id });
  } catch (err) {
    return next(err);
  }
});

// GET /api/sensor-data  -> ultimas leituras (com filtros)
router.get('/sensor-data', (req, res, next) => {
  try {
    const rows = db.queryReadings({
      device_id: req.query.device_id || undefined,
      limit: req.query.limit,
      since: toInt(req.query.since),
      until: toInt(req.query.until),
    });
    return res.json({ count: rows.length, data: rows });
  } catch (err) {
    return next(err);
  }
});

// GET /api/sensor-data/latest  -> leitura mais recente de cada device
router.get('/sensor-data/latest', (req, res, next) => {
  try {
    const rows = db.latestPerDevice();
    return res.json({ count: rows.length, data: rows });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/sensor-data?older_than=<unix>  -> limpeza de dados antigos
// TODO(seguranca): este endpoint apaga dados e DEVE exigir API key/auth
// antes de ir para producao com acesso publico. Por ora segue sem protecao
// (uso pessoal/academico).
router.delete('/sensor-data', (req, res, next) => {
  const olderThan = toInt(req.query.older_than);
  if (olderThan == null) {
    return res.status(400).json({
      error: { message: 'Query param "older_than" (timestamp Unix) e obrigatorio' },
    });
  }
  try {
    const deleted = db.deleteOlderThan(olderThan);
    return res.json({ status: 'ok', deleted });
  } catch (err) {
    return next(err);
  }
});

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

module.exports = router;
