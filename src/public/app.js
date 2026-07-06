'use strict';

/**
 * Logica do dashboard: busca dados via fetch, renderiza cards/graficos/tabela,
 * e faz auto-refresh a cada 30s. Sem framework.
 */

const REFRESH_MS = 30000;
const RANGE_HOURS_DEFAULT = 24;

// Espectro de audio: o ESP envia 20 faixas de 100 Hz (0-2 kHz) em audio_bands.
const NUM_BANDS = 20;
const BAND_HZ_STEP = 100;

// Calibracao do peso. O firmware envia apenas peso_raw (contagens brutas do
// HX711 — faz tare() mas nao set_scale()). Enquanto `factor` for null, o
// dashboard mostra o valor bruto. Para exibir em kg quando voce calibrar:
//   factor = contagens por kg  |  offset = leitura bruta com a colmeia vazia.
const PESO_CAL = { factor: null, offset: 0 };

const state = {
  deviceId: '',          // '' = todos
  rangeHours: RANGE_HOURS_DEFAULT,
  sort: { key: 'received_at', dir: 'desc' },
  lastReadings: [],
  lastSeries: [],        // serie cronologica usada nos graficos/espectrograma
  lastFetch: null,
};

const charts = {}; // instancias Chart.js por id

// Paleta consistente para as series.
const COLORS = {
  t1: '#4c8bf5', t2: '#38bdf8',
  u1: '#34d399', u2: '#a3e635',
  peso: '#fbbf24',
  audio: '#f472b6',
  ax: '#f87171', ay: '#a3e635', az: '#38bdf8',
  spectrum: '#c084fc',
};

// --- Boot -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  setupControls();
  setupSorting();
  initCharts();
  refresh();
  setInterval(refresh, REFRESH_MS);

  // O espectrograma e desenhado no canvas em pixels; redesenha ao redimensionar.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderSpectrogram(state.lastSeries), 150);
  });
});

function setupControls() {
  const deviceSelect = document.getElementById('device-select');
  const rangeSelect = document.getElementById('range-select');

  deviceSelect.addEventListener('change', (e) => {
    state.deviceId = e.target.value;
    refresh();
  });
  rangeSelect.addEventListener('change', (e) => {
    state.rangeHours = Number(e.target.value);
    refresh();
  });
}

function setupSorting() {
  document.querySelectorAll('#readings-table thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = 'desc';
      }
      renderTable(state.lastReadings);
    });
  });
}

// --- Data fetching --------------------------------------------------------

async function refresh() {
  try {
    const since = nowUnix() - state.rangeHours * 3600;
    const deviceQ = state.deviceId ? `&device_id=${encodeURIComponent(state.deviceId)}` : '';

    const [statsRes, latestRes, seriesRes, tableRes, devicesRes] = await Promise.all([
      fetchJson(`/api/stats${state.deviceId ? `?device_id=${encodeURIComponent(state.deviceId)}` : ''}`),
      fetchJson('/api/sensor-data/latest'),
      fetchJson(`/api/sensor-data?limit=1000&since=${since}${deviceQ}`),
      fetchJson(`/api/sensor-data?limit=20${deviceQ}`),
      fetchJson('/api/devices'),
    ]);

    updateDeviceOptions(devicesRes.data || []);
    renderCards(latestRes.data || [], statsRes);
    state.lastSeries = (seriesRes.data || []).slice().reverse(); // ordem cronologica
    renderCharts(state.lastSeries);
    state.lastReadings = tableRes.data || [];
    renderTable(state.lastReadings);

    state.lastFetch = Date.now();
    updateLastUpdate();
  } catch (err) {
    console.error('Falha ao atualizar dashboard:', err);
    setLastUpdateError();
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// --- Cards ----------------------------------------------------------------

function renderCards(latest, stats) {
  // Escolhe a leitura de referencia: device selecionado, ou a mais recente.
  let reading = null;
  if (state.deviceId) {
    reading = latest.find((r) => r.device_id === state.deviceId) || null;
  } else {
    reading = latest.slice().sort((a, b) => b.timestamp - a.timestamp)[0] || null;
  }

  const el = (id) => document.getElementById(id);
  const tempEl = el('card-temp'), tempSub = el('card-temp-sub');
  const umidEl = el('card-umid'), umidSub = el('card-umid-sub');
  const pesoEl = el('card-peso'), pesoSub = el('card-peso-sub');
  const audioEl = el('card-audio'), audioSub = el('card-audio-sub');
  const accelEl = el('card-accel'), accelSub = el('card-accel-sub');

  if (!reading) {
    tempEl.innerHTML = '&mdash;<span class="unit">&deg;C</span>';
    umidEl.innerHTML = '&mdash;<span class="unit">%</span>';
    pesoEl.innerHTML = '&mdash;<span class="unit">raw</span>';
    audioEl.innerHTML = '&mdash;<span class="unit">dBFS</span>';
    accelEl.innerHTML = '&mdash;<span class="unit">m/s&sup2;</span>';
    return;
  }

  const tAvg = avg([reading.temperatura_1, reading.temperatura_2]);
  const uAvg = avg([reading.umidade_1, reading.umidade_2]);

  tempEl.innerHTML = `${fmt(tAvg, 1)}<span class="unit">&deg;C</span>`;
  tempSub.textContent = `t1 ${fmt(reading.temperatura_1, 1)} / t2 ${fmt(reading.temperatura_2, 1)}`;

  umidEl.innerHTML = `${fmt(uAvg, 1)}<span class="unit">%</span>`;
  umidSub.textContent = `u1 ${fmt(reading.umidade_1, 1)} / u2 ${fmt(reading.umidade_2, 1)}`;

  // Peso: bruto por padrao; convertido para kg se PESO_CAL.factor estiver definido.
  const p = pesoInfo(reading.peso_raw);
  pesoEl.innerHTML = `${fmt(p.value, p.decimals)}<span class="unit">${p.unit}</span>`;
  pesoSub.textContent = (stats && stats.peso_raw && stats.peso_raw.min != null)
    ? `min ${fmt(stats.peso_raw.min, 0)} / max ${fmt(stats.peso_raw.max, 0)} (24h)`
    : reading.device_id;

  // Audio RMS (dBFS): quanto mais proximo de 0, mais alto o som.
  audioEl.innerHTML = `${fmt(reading.audio_rms, 1)}<span class="unit">dBFS</span>`;
  audioSub.textContent = (stats && stats.audio_rms && stats.audio_rms.avg != null)
    ? `media ${fmt(stats.audio_rms.avg, 1)} dBFS (24h)`
    : 'nivel sonoro';

  // Vibracao: magnitude do vetor de aceleracao (~9.8 m/s2 em repouso).
  const mag = accelMag(reading);
  accelEl.innerHTML = `${fmt(mag, 2)}<span class="unit">m/s&sup2;</span>`;
  accelSub.textContent = (reading.accel_x != null)
    ? `x ${fmt(reading.accel_x, 2)} · y ${fmt(reading.accel_y, 2)} · z ${fmt(reading.accel_z, 2)}`
    : 'acelerometro';
}

// --- Charts ---------------------------------------------------------------

function initCharts() {
  charts.temp = makeLineChart('chart-temp', [
    { key: 'temperatura_1', label: 'T1', color: COLORS.t1 },
    { key: 'temperatura_2', label: 'T2', color: COLORS.t2 },
  ]);
  charts.umid = makeLineChart('chart-umid', [
    { key: 'umidade_1', label: 'U1', color: COLORS.u1 },
    { key: 'umidade_2', label: 'U2', color: COLORS.u2 },
  ]);
  charts.peso = makeLineChart('chart-peso', [
    { key: 'peso_raw', label: 'Peso (bruto)', color: COLORS.peso },
  ]);
  charts.audio = makeLineChart('chart-audio', [
    { key: 'audio_rms', label: 'Audio RMS', color: COLORS.audio },
  ]);
  charts.accel = makeLineChart('chart-accel', [
    { key: 'accel_x', label: 'X', color: COLORS.ax },
    { key: 'accel_y', label: 'Y', color: COLORS.ay },
    { key: 'accel_z', label: 'Z', color: COLORS.az },
  ]);
  charts.spectrum = makeSpectrumChart('chart-spectrum');
}

// Grafico de barras: espectro (20 faixas de 100 Hz) da leitura mais recente.
function makeSpectrumChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Array.from({ length: NUM_BANDS }, (_, i) => bandLabelShort(i)),
      datasets: [{
        label: 'dBFS',
        data: [],
        backgroundColor: COLORS.spectrum + '99',
        borderColor: COLORS.spectrum,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1d222b', borderColor: '#272d38', borderWidth: 1,
          titleColor: '#e6e9ef', bodyColor: '#e6e9ef',
          callbacks: { title: (items) => bandLabelFull(items[0].dataIndex) },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Faixa (Hz)', color: '#6b7484', font: { size: 10 } },
          ticks: { color: '#6b7484', maxRotation: 0, autoSkip: true, maxTicksLimit: 10, font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: 'dBFS', color: '#6b7484', font: { size: 10 } },
          ticks: { color: '#6b7484', font: { size: 10 } },
          grid: { color: '#1d222b' },
        },
      },
    },
  });
}

function makeLineChart(canvasId, series) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: series.map((s) => ({
        label: s.label,
        data: [],
        borderColor: s.color,
        backgroundColor: s.color + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: true,
        _key: s.key,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: series.length > 1,
          labels: { color: '#9aa4b2', boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#1d222b',
          borderColor: '#272d38',
          borderWidth: 1,
          titleColor: '#e6e9ef',
          bodyColor: '#e6e9ef',
        },
      },
      scales: {
        x: {
          ticks: { color: '#6b7484', maxTicksLimit: 6, font: { size: 10 } },
          grid: { color: '#1d222b' },
        },
        y: {
          ticks: { color: '#6b7484', font: { size: 10 } },
          grid: { color: '#1d222b' },
        },
      },
    },
  });
}

function renderCharts(readings) {
  const labels = readings.map((r) => formatClock(r.timestamp));
  for (const chart of [charts.temp, charts.umid, charts.peso, charts.audio, charts.accel]) {
    chart.data.labels = labels;
    chart.data.datasets.forEach((ds) => {
      ds.data = readings.map((r) => (r[ds._key] != null ? r[ds._key] : null));
    });
    chart.update('none');
  }
  renderSpectrumBar(readings);
  renderSpectrogram(readings);
}

// --- Espectro de audio (audio_bands[20]) ----------------------------------

// Retorna o array audio_bands de tamanho NUM_BANDS, ou null se ausente/invalido.
function bandsOf(reading) {
  const b = reading && reading.audio_bands;
  return Array.isArray(b) && b.length === NUM_BANDS ? b : null;
}

// Barras: espectro da leitura mais recente que tenha audio_bands.
function renderSpectrumBar(readings) {
  let latest = null;
  for (let i = readings.length - 1; i >= 0; i--) {
    const b = bandsOf(readings[i]);
    if (b) { latest = b; break; }
  }
  charts.spectrum.data.datasets[0].data = latest || [];
  charts.spectrum.update('none');
}

// Espectrograma: heatmap (faixa x tempo), cor = dBFS. Desenhado no canvas.
function renderSpectrogram(readings) {
  const canvas = document.getElementById('spectrogram');
  if (!canvas) return;
  const box = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(box.clientWidth, 1);
  const cssH = Math.max(box.clientHeight, 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cols = readings.map(bandsOf).filter(Boolean);
  if (!cols.length) {
    ctx.fillStyle = '#6b7484';
    ctx.font = '12px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem espectro no periodo (audio_bands vazio).', cssW / 2, cssH / 2);
    return;
  }

  // Escala dinamica de dBFS, ignorando o piso -120 (silencio/sem sinal).
  let lo = Infinity, hi = -Infinity;
  for (const col of cols) {
    for (const v of col) {
      if (v == null || v <= -119.9) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1) { lo = -90; hi = -20; }

  const colW = cssW / cols.length;
  const rowH = cssH / NUM_BANDS;
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c];
    for (let b = 0; b < NUM_BANDS; b++) {
      const v = col[b];
      const t = (v == null || v <= -119.9) ? 0 : clamp01((v - lo) / (hi - lo));
      ctx.fillStyle = dbColor(t);
      // Faixa 0 (grave) embaixo; faixa 19 (aguda) em cima.
      const y = cssH - (b + 1) * rowH;
      ctx.fillRect(c * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
    }
  }
}

// --- Table ----------------------------------------------------------------

function renderTable(readings) {
  const tbody = document.getElementById('readings-body');
  const { key, dir } = state.sort;

  const sorted = readings.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      return dir === 'asc' ? av - bv : bv - av;
    }
    return dir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  // Indicadores de ordenacao no cabecalho.
  document.querySelectorAll('#readings-table thead th').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">Sem leituras no periodo.</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map((r) => `
    <tr>
      <td class="muted">${formatDateTime(r.received_at)}</td>
      <td>${escapeHtml(r.device_id)}</td>
      <td class="num muted">${r.timestamp}</td>
      <td class="num">${fmt(r.temperatura_1, 1)}</td>
      <td class="num">${fmt(r.temperatura_2, 1)}</td>
      <td class="num">${fmt(r.umidade_1, 1)}</td>
      <td class="num">${fmt(r.umidade_2, 1)}</td>
      <td class="num">${fmt(r.peso_raw, 0)}</td>
      <td class="num">${fmt(r.accel_x, 2)}</td>
      <td class="num">${fmt(r.accel_y, 2)}</td>
      <td class="num">${fmt(r.accel_z, 2)}</td>
      <td class="num">${fmt(r.audio_rms, 1)}</td>
    </tr>
  `).join('');
}

// --- Device selector ------------------------------------------------------

function updateDeviceOptions(devices) {
  const select = document.getElementById('device-select');
  const existing = new Set(Array.from(select.options).map((o) => o.value));
  for (const d of devices) {
    if (!existing.has(d.device_id)) {
      const opt = document.createElement('option');
      opt.value = d.device_id;
      opt.textContent = d.device_id;
      select.appendChild(opt);
    }
  }
}

// --- Last update indicator ------------------------------------------------

function updateLastUpdate() {
  const el = document.getElementById('last-update');
  if (!state.lastFetch) { el.textContent = '—'; return; }
  el.classList.remove('stale');
  el.textContent = `Atualizado ${relativeTime(state.lastFetch)}`;
}

function setLastUpdateError() {
  const el = document.getElementById('last-update');
  el.classList.add('stale');
  el.textContent = 'Falha ao atualizar';
}

// --- Helpers --------------------------------------------------------------

function nowUnix() { return Math.floor(Date.now() / 1000); }

function avg(values) {
  const nums = values.filter((v) => v != null && !Number.isNaN(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmt(v, decimals) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toFixed(decimals);
}

// Peso: bruto por padrao; convertido para kg se PESO_CAL.factor estiver setado.
function pesoInfo(raw) {
  if (raw == null) return { value: null, unit: 'raw', decimals: 0 };
  if (PESO_CAL.factor) {
    return { value: (raw - PESO_CAL.offset) / PESO_CAL.factor, unit: 'kg', decimals: 2 };
  }
  return { value: raw, unit: 'raw', decimals: 0 };
}

// Magnitude do vetor de aceleracao (m/s2); ~9.8 em repouso.
function accelMag(r) {
  if (r.accel_x == null && r.accel_y == null && r.accel_z == null) return null;
  const x = r.accel_x || 0, y = r.accel_y || 0, z = r.accel_z || 0;
  return Math.sqrt(x * x + y * y + z * z);
}

// Rotulos da faixa espectral i (0..NUM_BANDS-1): 100 Hz por faixa.
function bandLabelShort(i) { return String(i * BAND_HZ_STEP); }
function bandLabelFull(i) { return `${i * BAND_HZ_STEP}–${(i + 1) * BAND_HZ_STEP} Hz`; }

function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

// Colormap para o espectrograma (deve casar com .spectro-grad no style.css).
const DB_STOPS = [
  [13, 17, 22], [30, 60, 140], [30, 150, 180], [40, 180, 90], [230, 200, 40], [240, 90, 60],
];
function dbColor(t) {
  t = clamp01(t);
  const n = DB_STOPS.length - 1;
  const seg = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - seg;
  const a = DB_STOPS[seg], b = DB_STOPS[seg + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

function formatClock(unix) {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(unix) {
  if (unix == null) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function relativeTime(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5) return 'agora';
  if (secs < 60) return `ha ${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `ha ${mins} min`;
  const hours = Math.floor(mins / 60);
  return `ha ${hours}h`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
