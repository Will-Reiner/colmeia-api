'use strict';

/**
 * Endpoint /api/devices
 * Lista device_ids unicos que ja enviaram dados.
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/devices', (req, res, next) => {
  try {
    const rows = db.listDevices();
    return res.json({ count: rows.length, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
