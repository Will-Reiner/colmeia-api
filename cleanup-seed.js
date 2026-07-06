'use strict';

/**
 * Remove leituras "fake" (seed/demo) do banco, preservando os dados REAIS do ESP.
 *
 * Uso:
 *   node cleanup-seed.js          -> remove APENAS linhas identificaveis como seed
 *   node cleanup-seed.js --dry    -> so mostra o que seria removido (nao apaga)
 *   node cleanup-seed.js --all    -> APAGA TUDO (comeco do zero) - cuidado!
 *
 * Aponte o banco com DB_PATH:
 *   Local:  node cleanup-seed.js
 *   Prod:   DB_PATH=/app/data/colmeia.db node cleanup-seed.js
 *   (no Coolify, rode no terminal do container da aplicacao)
 *
 * Por que nao apagar so por device_id? O dispositivo real e o seed usam o mesmo
 * device_id "colmeia_01". Mas o seed.js ORIGINAL sempre preenchia os campos
 * legado peso_kg / servo_status / fim_curso, que o firmware real NUNCA envia.
 * Entao removemos: device_id "colmeia_02" (100% demo) OU qualquer linha com um
 * desses campos legado preenchido. As leituras reais (esses campos NULL) ficam.
 */

const db = require('./src/db');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const DRY = args.includes('--dry');
const DEMO_DEVICES = ['colmeia_02'];

const count = (where, params = []) =>
  db.db.prepare(`SELECT COUNT(*) AS n FROM sensor_readings WHERE ${where}`).get(...params).n;

const total = db.db.prepare('SELECT COUNT(*) AS n FROM sensor_readings').get().n;

let where, params;
if (ALL) {
  where = '1 = 1';
  params = [];
} else {
  const ph = DEMO_DEVICES.map(() => '?').join(', ');
  where = `device_id IN (${ph}) OR peso_kg IS NOT NULL OR servo_status IS NOT NULL OR fim_curso IS NOT NULL`;
  params = DEMO_DEVICES;
}

const toDelete = count(where, params);

console.log(`[cleanup] banco: ${db.DB_PATH}`);
console.log(`[cleanup] total de leituras: ${total}`);
console.log(`[cleanup] ${ALL ? 'modo --all (apaga TUDO)' : 'identificadas como seed/demo'}: ${toDelete}`);
console.log(`[cleanup] permaneceriam (reais): ${total - toDelete}`);

if (DRY) {
  console.log('[cleanup] --dry: nada foi apagado.');
  db.close();
  process.exit(0);
}

const info = db.db.prepare(`DELETE FROM sensor_readings WHERE ${where}`).run(...params);
const rest = db.db.prepare('SELECT COUNT(*) AS n FROM sensor_readings').get().n;
console.log(`[cleanup] removidas: ${info.changes} | restantes: ${rest}`);

// Recupera espaco em disco (SQLite nao encolhe o arquivo sozinho).
db.db.exec('VACUUM');
console.log('[cleanup] VACUUM concluido.');
db.close();
