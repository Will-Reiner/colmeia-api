'use strict';
/**
 * Rota de ÁUDIO para o colmeia-api.
 * Recebe os clipes PCM 16-bit do ESP32, junta cada rajada (mesma X-Session)
 * num único .wav, exige token (se configurado) e limpa áudio antigo sozinho.
 * Salva os arquivos em disco, no MESMO volume persistente do banco.
 *
 * Onde colocar: src/routes/audio.js
 * Como ligar no server.js (junto dos outros routers), 2 linhas:
 *     const audioRouter = require('./routes/audio');
 *     api.use('/', audioRouter);
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const AUDIO_DIR = process.env.AUDIO_DIR || '/app/data/audio';
const API_TOKEN = process.env.API_TOKEN || '';                      // se vazio, aceita sem token
const RETENTION_HOURS = parseInt(process.env.AUDIO_RETENTION_HOURS || '48', 10);
const BODY_LIMIT = process.env.AUDIO_BODY_LIMIT || '4mb';

fs.mkdirSync(AUDIO_DIR, { recursive: true });

function safe(s, re) { return String(s || '').replace(re, ''); }

function dayDir(ts) {
  const day = new Date(ts * 1000).toISOString().slice(0, 10);
  const dir = path.join(AUDIO_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, day };
}

function wavHeader(dataLen, sr, bits, ch) {
  const blockAlign = (ch * bits) / 8;
  const byteRate = sr * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

// Token opcional: só bloqueia se API_TOKEN estiver definido no ambiente.
function checaToken(req, res, next) {
  if (!API_TOKEN) return next();
  if (req.get('Authorization') === 'Bearer ' + API_TOKEN) return next();
  return res.status(401).json({ error: { message: 'token invalido' } });
}

// ---- POST /api/audio : recebe 1 clipe e emenda no .wav da sessão ----
router.post('/audio',
  checaToken,
  express.raw({ type: 'application/octet-stream', limit: BODY_LIMIT }),
  (req, res) => {
    const body = req.body;
    if (!body || !body.length) return res.status(400).json({ error: { message: 'corpo vazio' } });

    const device  = safe(req.get('X-Device-Id') || 'colmeia', /[^\w\-]/g) || 'colmeia';
    const session = safe(req.get('X-Session') || req.get('X-Timestamp') || Date.now(), /[^\d]/g) || String(Date.now());
    const trigger = safe(req.get('X-Trigger') || 'periodic', /[^\w]/g) || 'periodic';
    const sr   = parseInt(req.get('X-Sample-Rate') || '16000', 10);
    const bits = parseInt(req.get('X-Bits') || '16', 10);
    const ch   = parseInt(req.get('X-Channels') || '1', 10);

    const { dir, day } = dayDir(parseInt(session, 10) || Math.floor(Date.now() / 1000));
    const fname = `${device}_${session}_${trigger}.wav`;
    const full = path.join(dir, fname);

    try {
      if (!fs.existsSync(full)) {
        fs.writeFileSync(full, Buffer.concat([wavHeader(body.length, sr, bits, ch), body]));
      } else {
        fs.appendFileSync(full, body);
        const dataLen = fs.statSync(full).size - 44;
        const fd = fs.openSync(full, 'r+');
        const b = Buffer.alloc(4);
        b.writeUInt32LE(36 + dataLen, 0); fs.writeSync(fd, b, 0, 4, 4);
        b.writeUInt32LE(dataLen, 0);      fs.writeSync(fd, b, 0, 4, 40);
        fs.closeSync(fd);
      }
    } catch (e) {
      console.error('[audio] erro ao salvar:', e.message);
      return res.status(500).json({ error: { message: 'falha ao salvar' } });
    }

    const totalBytes = fs.statSync(full).size - 44;
    const dur = totalBytes / (sr * ch * (bits / 8));
    res.status(201).json({ status: 'ok', file: `${day}/${fname}`, trigger, duracao_s: +dur.toFixed(1) });
  }
);

// ---- GET /api/audio : lista as sessões (JSON) ----
router.get('/audio', (req, res) => {
  const limit = clampLimit(req.query.limit);
  return res.json(listar(limit));
});

// ---- GET /api/audio/file/<dia>/<arquivo>.wav : baixa/toca ----
router.get('/audio/file/:day/:name', (req, res) => {
  const day = safe(req.params.day, /[^\d\-]/g);
  const name = safe(req.params.name, /[^\w\-.]/g);
  const full = path.join(AUDIO_DIR, day, name);
  if (!full.startsWith(AUDIO_DIR) || !fs.existsSync(full)) return res.status(404).json({ error: { message: 'nao encontrado' } });
  res.type('audio/wav').sendFile(full);
});

function listar(limit) {
  const out = [];
  try {
    for (const day of fs.readdirSync(AUDIO_DIR)) {
      const dayPath = path.join(AUDIO_DIR, day);
      if (!fs.statSync(dayPath).isDirectory()) continue;
      for (const f of fs.readdirSync(dayPath)) {
        if (!f.endsWith('.wav')) continue;
        const st = fs.statSync(path.join(dayPath, f));
        const bytes = Math.max(st.size - 44, 0);
        out.push({
          file: `${day}/${f}`,
          trigger: f.includes('_anomaly') ? 'anomaly' : 'periodic',
          bytes, duracao_s: +(bytes / (16000 * 2)).toFixed(1),
          quando: new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19),
          mtime: st.mtimeMs
        });
      }
    }
  } catch (e) { console.error('[audio] listar:', e.message); }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 200);
}

// ---- retenção: apaga áudio antigo pra não lotar o disco ----
function limpaAntigos() {
  if (!RETENTION_HOURS || RETENTION_HOURS <= 0) return;
  const corte = Date.now() - RETENTION_HOURS * 3600 * 1000;
  try {
    for (const day of fs.readdirSync(AUDIO_DIR)) {
      const dayPath = path.join(AUDIO_DIR, day);
      if (!fs.statSync(dayPath).isDirectory()) continue;
      let restantes = 0;
      for (const f of fs.readdirSync(dayPath)) {
        const fp = path.join(dayPath, f);
        if (fs.statSync(fp).mtimeMs < corte) fs.unlinkSync(fp);
        else restantes++;
      }
      if (restantes === 0) { try { fs.rmdirSync(dayPath); } catch (_) {} }
    }
  } catch (e) { console.error('[audio] limpeza:', e.message); }
}
setInterval(limpaAntigos, 30 * 60 * 1000);
limpaAntigos();

module.exports = router;
