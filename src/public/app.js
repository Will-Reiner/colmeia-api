'use strict';

/**
 * Dashboard da colmeia: mostra temperatura, umidade, peso, audio RMS,
 * espectro de 20 bandas e uma biblioteca de clipes WAV capturados pelo ESP32.
 */

const REFRESH_MS = 30000;
const RANGE_HOURS_DEFAULT = 24;
const MAX_AUDIO_FILES = 12;

// Espectro de audio: o ESP envia 20 faixas de 100 Hz (0-2 kHz) em audio_bands.
const NUM_BANDS = 20;
const BAND_HZ_STEP = 100;

// Calibracao do peso. O firmware envia apenas peso_raw (contagens brutas do
// HX711 — faz tare() mas nao set_scale()). Enquanto `factor` for null, o
// dashboard mostra o valor bruto. Para exibir em kg quando voce calibrar:
'use strict';

/**
 * Dashboard da colmeia: mostra temperatura, umidade, peso bruto, audio RMS,
 * aceleracao, espectro, espectrograma e uma biblioteca de clipes WAV.
 */

const REFRESH_MS = 30000;
const RANGE_HOURS_DEFAULT = 24;
const MAX_AUDIO_FILES = 12;
const NUM_BANDS = 20;
const BAND_HZ_STEP = 100;
const BAND_MAX_HZ = 2000;
const PESO_CAL = { factor: null, offset: 0 };

const state = {
  deviceId: '',
  rangeHours: RANGE_HOURS_DEFAULT,
  sort: { key: 'received_at', dir: 'desc' },
  lastReadings: [],
  lastSeries: [],
  latestReadings: [],
  audioFiles: [],
  lastFetch: null,
};

const charts = {};

const COLORS = {
  t1: '#ff8a5b',
  t2: '#ffb86b',
  u1: '#2dd4bf',
  u2: '#38bdf8',
  peso: '#fbbf24',
  audio: '#f472b6',
  ax: '#f87171',
  ay: '#a3e635',
  az: '#38bdf8',
  spectrum: '#c084fc',
};

document.addEventListener('DOMContentLoaded', () => {
  setupControls();
  setupSorting();
  initCharts();
  refresh();
  setInterval(refresh, REFRESH_MS);

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
  document.querySelectorAll('#readings-table thead th[data-key]').forEach((th) => {
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

async function refresh() {
  try {
    const since = nowUnix() - state.rangeHours * 3600;
    const deviceQuery = state.deviceId ? `&device_id=${encodeURIComponent(state.deviceId)}` : '';

    const [statsRes, latestRes, seriesRes, tableRes, devicesRes, audioFiles] = await Promise.all([
      fetchJson(`/api/stats?hours=${state.rangeHours}${deviceQuery}`),
      fetchJson('/api/sensor-data/latest'),
      fetchJson(`/api/sensor-data?limit=1000&since=${since}${deviceQuery}`),
      fetchJson(`/api/sensor-data?limit=40${deviceQuery}`),
      fetchJson('/api/devices'),
      fetchJson(`/api/audio?limit=${MAX_AUDIO_FILES}`).catch(() => []),
    ]);

    state.latestReadings = latestRes.data || [];
    state.lastSeries = (seriesRes.data || []).slice().reverse();
    state.lastReadings = tableRes.data || [];
    state.audioFiles = Array.isArray(audioFiles) ? audioFiles : [];

    updateDeviceOptions(devicesRes.data || []);
    renderOverview(selectReferenceReading(state.latestReadings), statsRes);
    renderCharts(state.lastSeries, selectReferenceReading(state.latestReadings));
    renderTable(state.lastReadings);
    renderAudioLibrary(state.audioFiles);
    updateDashboardMeta();

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

function selectReferenceReading(readings) {
  if (!readings || !readings.length) return null;
  if (state.deviceId) {
    return readings.find((r) => r.device_id === state.deviceId) || null;
  }
  return readings.slice().sort((a, b) => b.timestamp - a.timestamp)[0] || null;
}

function renderOverview(reading, stats) {
  const deviceChip = document.getElementById('hero-device-chip');
  const lastReading = document.getElementById('dashboard-last-reading');
  const audioCount = document.getElementById('dashboard-audio-count');
  const windowLabel = document.getElementById('dashboard-window');

  if (deviceChip) deviceChip.textContent = state.deviceId ? `Device: ${state.deviceId}` : 'Todos os devices';
  if (lastReading) {
    lastReading.textContent = reading
      ? `${reading.device_id} • ${formatDateTime(reading.timestamp)}`
      : 'Sem leitura recente';
  }
  if (audioCount) audioCount.textContent = String(state.audioFiles.length);
  if (windowLabel) windowLabel.textContent = `${state.rangeHours}h`;

  const tempEl = document.getElementById('card-temp');
  const tempSub = document.getElementById('card-temp-sub');
  const umidEl = document.getElementById('card-umid');
  const umidSub = document.getElementById('card-umid-sub');
  const pesoEl = document.getElementById('card-peso');
  const pesoSub = document.getElementById('card-peso-sub');
  const audioEl = document.getElementById('card-audio');
  const audioSub = document.getElementById('card-audio-sub');
  const accelEl = document.getElementById('card-accel');
  const accelSub = document.getElementById('card-accel-sub');

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
  tempSub.textContent = `T1 ${fmt(reading.temperatura_1, 1)} / T2 ${fmt(reading.temperatura_2, 1)}`;

  umidEl.innerHTML = `${fmt(uAvg, 1)}<span class="unit">%</span>`;
  umidSub.textContent = `U1 ${fmt(reading.umidade_1, 1)} / U2 ${fmt(reading.umidade_2, 1)}`;

  const p = pesoInfo(reading.peso_raw);
  pesoEl.innerHTML = `${fmt(p.value, p.decimals)}<span class="unit">${p.unit}</span>`;
  pesoSub.textContent = stats && stats.peso_raw && stats.peso_raw.min != null
    ? `min ${fmt(stats.peso_raw.min, 0)} / max ${fmt(stats.peso_raw.max, 0)} (24h)`
    : reading.device_id;

  audioEl.innerHTML = `${fmt(reading.audio_rms, 1)}<span class="unit">dBFS</span>`;
  audioSub.textContent = stats && stats.audio_rms && stats.audio_rms.avg != null
    ? `media ${fmt(stats.audio_rms.avg, 1)} dBFS (24h)`
    : 'nivel sonoro';

  const mag = accelMag(reading);
  accelEl.innerHTML = `${fmt(mag, 2)}<span class="unit">m/s&sup2;</span>`;
  accelSub.textContent = reading.accel_x != null
    ? `x ${fmt(reading.accel_x, 2)} · y ${fmt(reading.accel_y, 2)} · z ${fmt(reading.accel_z, 2)}`
    : 'acelerometro';
}

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
        tension: 0.28,
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
          labels: { color: '#a9b2c3', boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#111620',
          borderColor: '#2b3240',
          borderWidth: 1,
          titleColor: '#f4f7fb',
          bodyColor: '#f4f7fb',
        },
      },
      scales: {
        x: {
          ticks: { color: '#778093', maxTicksLimit: 6, font: { size: 10 } },
          grid: { color: '#1c222c' },
        },
        y: {
          ticks: { color: '#778093', font: { size: 10 } },
          grid: { color: '#1c222c' },
        },
      },
    },
  });
}

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
          backgroundColor: '#1d222b',
          borderColor: '#272d38',
          borderWidth: 1,
          titleColor: '#e6e9ef',
          bodyColor: '#e6e9ef',
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

function renderCharts(readings, reading) {
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

function bandsOf(reading) {
  const b = reading && reading.audio_bands;
  return Array.isArray(b) && b.length === NUM_BANDS ? b : null;
}

function renderSpectrumBar(readings) {
  let latest = null;
  for (let i = readings.length - 1; i >= 0; i--) {
    const b = bandsOf(readings[i]);
    if (b) { latest = b; break; }
  }
  if (charts.spectrum) {
    charts.spectrum.data.datasets[0].data = latest || [];
    charts.spectrum.update('none');
  }
}

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

  let lo = Infinity;
  let hi = -Infinity;
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
      const y = cssH - (b + 1) * rowH;
      ctx.fillRect(c * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
    }
  }
}

function renderTable(readings) {
  const tbody = document.getElementById('readings-body');
  const { key, dir } = state.sort;

  const enriched = readings.map((reading) => {
    const summary = summarizeBands(reading.audio_bands);
    return {
      ...reading,
      band_peak: summary ? summary.peakValue : null,
      band_count: summary ? summary.count : null,
      band_label: summary ? summary.peakLabel : null,
    };
  });

  const sorted = enriched.slice().sort((a, b) => {
    const av = a[key];
    const bv = b[key];
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

  document.querySelectorAll('#readings-table thead th[data-key]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === key) th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty">Sem leituras no periodo.</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map((reading) => `
    <tr>
      <td class="muted">${formatDateTime(reading.received_at)}</td>
      <td>${escapeHtml(reading.device_id)}</td>
      <td class="num muted">${reading.timestamp}</td>
      <td class="num">${fmt(reading.temperatura_1, 1)}</td>
      <td class="num">${fmt(reading.temperatura_2, 1)}</td>
      <td class="num">${fmt(reading.umidade_1, 1)}</td>
      <td class="num">${fmt(reading.umidade_2, 1)}</td>
      <td class="num">${fmt(reading.peso_raw, 0)}</td>
      <td class="num">${fmt(reading.accel_x, 2)}</td>
      <td class="num">${fmt(reading.accel_y, 2)}</td>
      <td class="num">${fmt(reading.accel_z, 2)}</td>
      <td class="num">${fmt(reading.audio_rms, 1)}</td>
      <td>${reading.band_label ? `<span class="band-summary-cell"><strong>${escapeHtml(reading.band_label)}</strong><span>${fmt(reading.band_peak, 1)} dBFS</span></span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${reading.band_count ? `${reading.band_count} faixas` : '<span class="muted">—</span>'}</td>
    </tr>
  `).join('');
}

function renderAudioLibrary(files) {
  const grid = document.getElementById('audio-library');
  const count = document.getElementById('audio-count');

  if (count) count.textContent = String(files.length);
  if (!grid) return;

  if (!files.length) {
    grid.innerHTML = '<div class="empty audio-empty">Nenhum WAV capturado ainda.</div>';
    return;
  }

  grid.innerHTML = files.map((file) => {
    const url = audioFileUrl(file.file);
    return `
      <article class="audio-card">
        <div class="audio-card-head">
          <span class="audio-tag ${file.trigger === 'anomaly' ? 'audio-tag-alert' : 'audio-tag-soft'}">${escapeHtml(file.trigger)}</span>
          <span class="audio-meta">${escapeHtml(file.quando || '—')}</span>
        </div>
        <h3>${escapeHtml(file.file)}</h3>
        <p>${fmt(file.duracao_s, 1)} s · ${bytesLabel(file.bytes)}</p>
        <audio controls preload="none" src="${url}"></audio>
        <a class="audio-link" href="${url}" target="_blank" rel="noreferrer">Abrir WAV</a>
      </article>
    `;
  }).join('');
}

function updateDeviceOptions(devices) {
  const select = document.getElementById('device-select');
  if (!select) return;
  select.innerHTML = '<option value="">Todos</option>';
  devices.forEach((device) => {
    const option = document.createElement('option');
    option.value = device.device_id;
    option.textContent = `${device.device_id} (${device.reading_count})`;
    select.appendChild(option);
  });
  select.value = state.deviceId;
}

function updateDashboardMeta() {
  const label = document.getElementById('dashboard-window');
  if (label) label.textContent = `${state.rangeHours}h`;
}

function updateLastUpdate() {
  const el = document.getElementById('last-update');
  if (!el) return;
  if (!state.lastFetch) {
    el.textContent = '—';
    return;
  }
  el.classList.remove('stale');
  el.textContent = `Atualizado ${relativeTime(state.lastFetch)}`;
}

function setLastUpdateError() {
  const el = document.getElementById('last-update');
  if (!el) return;
  el.classList.add('stale');
  el.textContent = 'Falha ao atualizar';
}

function summarizeBands(bands) {
  if (!Array.isArray(bands) || !bands.length) return null;
  let peakIndex = 0;
  let peakValue = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let valid = 0;

  bands.forEach((value, index) => {
    if (value == null || Number.isNaN(value)) return;
    valid += 1;
    sum += value;
    if (value > peakValue) {
      peakValue = value;
      peakIndex = index;
    }
  });

  if (!valid) return null;

  return {
    count: valid,
    peakIndex,
    peakValue,
    peakLabel: bandLabel(peakIndex),
    average: sum / valid,
  };
}

function bandLabel(index) {
  const start = index * BAND_HZ_STEP;
  const end = start + BAND_HZ_STEP;
  return `${start}-${end}Hz`;
}

function bandLabelShort(index) {
  return String(index * BAND_HZ_STEP);
}

function bandLabelFull(index) {
  return `${index * BAND_HZ_STEP}–${(index + 1) * BAND_HZ_STEP} Hz`;
}

function audioFileUrl(file) {
  const parts = String(file || '').split('/');
  if (parts.length < 2) return '#';
  const day = encodeURIComponent(parts[0]);
  const name = encodeURIComponent(parts.slice(1).join('/'));
  return `/api/audio/file/${day}/${name}`;
}

function bytesLabel(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function avg(values) {
  const nums = values.filter((value) => value != null && !Number.isNaN(value));
  if (!nums.length) return null;
  return nums.reduce((acc, value) => acc + value, 0) / nums.length;
}

function fmt(value, decimals) {
  if (value == null || Number.isNaN(value)) return '—';
  return Number(value).toFixed(decimals);
}

function pesoInfo(raw) {
  if (raw == null) return { value: null, unit: 'raw', decimals: 0 };
  if (PESO_CAL.factor) {
    return { value: (raw - PESO_CAL.offset) / PESO_CAL.factor, unit: 'kg', decimals: 2 };
  }
  return { value: raw, unit: 'raw', decimals: 0 };
}

function accelMag(reading) {
  if (reading.accel_x == null && reading.accel_y == null && reading.accel_z == null) return null;
  const x = reading.accel_x || 0;
  const y = reading.accel_y || 0;
  const z = reading.accel_z || 0;
  return Math.sqrt(x * x + y * y + z * z);
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const DB_STOPS = [
  [13, 17, 22],
  [30, 60, 140],
  [30, 150, 180],
  [40, 180, 90],
  [230, 200, 40],
  [240, 90, 60],
];

function dbColor(t) {
  t = clamp01(t);
  const n = DB_STOPS.length - 1;
  const seg = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - seg;
  const a = DB_STOPS[seg];
  const b = DB_STOPS[seg + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

function formatClock(unix) {
  const date = new Date(unix * 1000);
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(unix) {
  if (unix == null) return '—';
  const date = new Date(unix * 1000);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
    return;
