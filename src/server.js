'use strict';

/**
 * Entry point: configura o Express, middlewares, rotas, dashboard estatico,
 * tratamento de erro e graceful shutdown.
 */

const path = require('path');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const db = require('./db');
const sensorsRouter = require('./routes/sensors');
const statsRouter = require('./routes/stats');
const devicesRouter = require('./routes/devices');

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

// Confia no proxy (Coolify/Traefik) para IP correto nos logs.
app.set('trust proxy', true);

// Logs de request (formato simples).
app.use(morgan(NODE_ENV === 'production' ? 'tiny' : 'dev'));

// Body parser JSON limitado a 10kb (payloads do ESP32 sao pequenos).
app.use(express.json({ limit: '10kb' }));

// --- API ------------------------------------------------------------------

const api = express.Router();

// CORS liberado para qualquer origem apenas nos endpoints /api/*.
api.use(cors());

// Healthcheck (usado pelo HEALTHCHECK do Docker).
api.get('/health', (req, res) => {
  try {
    const status = db.healthCheck();
    res.json({ status: 'ok', db: status });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unavailable', message: err.message });
  }
});

api.use('/', sensorsRouter);
api.use('/', statsRouter);
api.use('/', devicesRouter);

app.use('/api', api);

// --- Dashboard estatico ----------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- 404 (JSON para /api, fallback simples para o resto) -------------------

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: { message: 'Endpoint nao encontrado' } });
  }
  return res.status(404).send('Not found');
});

// --- Middleware global de erro ---------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[erro]', err);

  // Body parser rejeita JSON malformado ou maior que o limite.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Payload muito grande (limite 10kb)' } });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { message: 'JSON invalido no corpo da requisicao' } });
  }

  return res.status(500).json({
    error: { message: 'Erro interno do servidor' },
  });
});

// --- Inicializacao + graceful shutdown -------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[colmeia-api] ouvindo na porta ${PORT} (env: ${NODE_ENV})`);
  console.log(`[colmeia-api] banco: ${db.DB_PATH}`);
});

function shutdown(signal) {
  console.log(`\n[colmeia-api] recebido ${signal}, encerrando...`);
  server.close(() => {
    try {
      db.close();
      console.log('[colmeia-api] banco fechado. Ate logo.');
    } catch (err) {
      console.error('[colmeia-api] erro ao fechar banco:', err);
    }
    process.exit(0);
  });

  // Forca saida se o close demorar demais.
  setTimeout(() => {
    console.error('[colmeia-api] shutdown forcado (timeout).');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
