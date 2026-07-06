'use strict';

/**
 * Endpoint /api/stats
 * Estatisticas agregadas das ultimas 24h.
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/stats', (req, res, next) => {
  try {
    const raw = db.stats24h({ device_id: req.query.device_id || undefined });

    const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

    return res.json({
      window_hours: 24,
      count: raw.count,
      temperatura: {
        t1: { min: round(raw.temp1_min), max: round(raw.temp1_max), avg: round(raw.temp1_avg) },
        t2: { min: round(raw.temp2_min), max: round(raw.temp2_max), avg: round(raw.temp2_avg) },
      },
      umidade: {
        u1: { min: round(raw.umid1_min), max: round(raw.umid1_max), avg: round(raw.umid1_avg) },
        u2: { min: round(raw.umid2_min), max: round(raw.umid2_max), avg: round(raw.umid2_avg) },
      },
      // peso_kg fica para quando houver calibracao; hoje o ESP so envia peso_raw.
      peso_kg: { min: round(raw.peso_min), max: round(raw.peso_max), avg: round(raw.peso_avg) },
      peso_raw: { min: round(raw.pesoraw_min), max: round(raw.pesoraw_max), avg: round(raw.pesoraw_avg) },
      audio_rms: { min: round(raw.audio_min), max: round(raw.audio_max), avg: round(raw.audio_avg) },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
