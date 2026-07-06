'use strict';

/**
 * Dashboard da colmeia: temperatura, umidade, peso bruto, audio RMS,
 * aceleracao, espectro de 20 bandas, espectrograma e biblioteca de WAV.
 */

const REFRESH_MS = 30000;
const RANGE_HOURS_DEFAULT = 24;
const MAX_AUDIO_FILES = 12;
const NUM_BANDS = 20;
const BAND_HZ_STEP = 100;
const BAND_MAX_HZ = 2000;

const state = {
  deviceId: '',
  rangeHours: RANGE_HOURS_DEFAULT,
  sort: { key: 'received_at', dir: 'desc' },
  latestReadings: [],
  lastSeries: [],
  lastReadings: [],
  audioFiles: [],
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

const DB_STOPS = [
  [13, 17, 22],
  [30, 60, 140],
  [30, 150, 180],
  [40, 180, 90],
  [230, 200, 40],
  [240, 90, 60],
];

// Faixa ideal de temperatura interna da colmeia (°C).
const IDEAL_TEMP = { min: 28, max: 32 };

// Posicao da colmeia (acelerometro). ACCEL_REF e a direcao da gravidade com a
// colmeia em repouso, normalizada (de (0.05, 2.85, 8.65) medido). O angulo de
// inclinacao e o angulo entre a leitura atual (normalizada) e essa referencia.
// Para recalibrar: capture uma leitura em repouso e normalize (x,y,z)/|v|.
const ACCEL_REF = { x: 0.006, y: 0.313, z: 0.950 };
const TILT_OK_DEG = 15;    // < 15°  = no lugar
const TILT_WARN_DEG = 45;  // 15–45° = inclinada ; > 45° = derrubada

window.addEventListener('DOMContentLoaded', () => {
  setupControls();
  setupSorting();
  initCharts();
  refresh();
  setInterval(refresh, REFRESH_MS);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderSpectrogram(state.lastSeries), 120);
  });
});

function setupControls() {
  const deviceSelect = document.getElementById('device-select');
  const rangeSelect = document.getElementById('range-select');

  deviceSelect.addEventListener('change', (event) => {
    state.deviceId = event.target.value;
    refresh();
  });

  rangeSelect.addEventListener('change', (event) => {
    state.rangeHours = Number(event.target.value) || RANGE_HOURS_DEFAULT;
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

    const [statsRes, latestRes, seriesRes, tableRes, devicesRes, audioRes] = await Promise.all([
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
    state.audioFiles = Array.isArray(audioRes) ? audioRes : [];

    updateDeviceOptions(devicesRes.data || []);
    renderOverview(selectReferenceReading(state.latestReadings), statsRes);
    renderThermoregulation(statsRes, state.lastSeries);
    renderCharts(state.lastSeries);
    renderTable(state.lastReadings);
    renderAudioLibrary(state.audioFiles);
    updateLastUpdate();
  } catch (error) {
    console.error('Falha ao atualizar dashboard:', error);
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
    return readings.find((reading) => reading.device_id === state.deviceId) || null;
  }
  return readings.slice().sort((a, b) => b.timestamp - a.timestamp)[0] || null;
}

function renderOverview(reading, stats) {
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
    pesoEl.innerHTML = '&mdash;<span class="unit">kg</span>';
    audioEl.innerHTML = '&mdash;<span class="unit">dBFS</span>';
    accelEl.textContent = '—';
    accelEl.className = 'card-value card-status';
    return;
  }

  // Interna = T2/U2 ; externa = T1/U1.
  const tIn = reading.temperatura_2;
  const tOut = reading.temperatura_1;
  const uIn = reading.umidade_2;
  const uOut = reading.umidade_1;
  const peso = pesoInfo(reading);
  const pos = tiltInfo(reading);

  tempEl.innerHTML = `${fmt(tIn, 1)}<span class="unit">&deg;C</span>`;
  tempSub.textContent = tOut != null
    ? `externa ${fmt(tOut, 1)}°C · Δ ${signed(diff(tIn, tOut), 1)}°C`
    : 'externa —';

  umidEl.innerHTML = `${fmt(uIn, 1)}<span class="unit">%</span>`;
  umidSub.textContent = uOut != null
    ? `externa ${fmt(uOut, 1)}% · Δ ${signed(diff(uIn, uOut), 1)}`
    : 'externa —';

  pesoEl.innerHTML = `${fmt(peso.value, peso.decimals)}<span class="unit">${peso.unit}</span>`;
  const pstat = stats && stats.peso_kg && stats.peso_kg.min != null
    ? stats.peso_kg
    : (stats && stats.peso_raw && stats.peso_raw.min != null ? stats.peso_raw : null);
  pesoSub.textContent = pstat
    ? `min ${fmt(pstat.min, 2)} / max ${fmt(pstat.max, 2)} kg (${state.rangeHours}h)`
    : 'HX711';

  audioEl.innerHTML = `${fmt(reading.audio_rms, 1)}<span class="unit">dBFS</span>`;
  audioSub.textContent = stats && stats.audio_rms && stats.audio_rms.avg != null
    ? `media ${fmt(stats.audio_rms.avg, 1)} dBFS (${state.rangeHours}h)`
    : 'nivel sonoro';

  accelEl.textContent = pos.label;
  accelEl.className = `card-value card-status ${pos.cls}`;
  accelSub.textContent = pos.angle != null ? `inclinacao ${fmt(pos.angle, 0)}°` : 'acelerometro';
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
    { key: 'peso_kg', fallback: 'peso_raw', label: 'Peso (kg)', color: COLORS.peso },
  ]);

  charts.audio = makeLineChart('chart-audio', [
    { key: 'audio_rms', label: 'Audio RMS', color: COLORS.audio },
  ]);

  charts.accel = makeLineChart('chart-accel', [
    { key: 'accel_x', label: 'X', color: COLORS.ax },
    { key: 'accel_y', label: 'Y', color: COLORS.ay },
    { key: 'accel_z', label: 'Z', color: COLORS.az },
  ]);

  // Interna (T2) vs externa (T1) com a faixa ideal 28–32°C sombreada.
  charts.thermo = makeLineChart('chart-thermo', [
    { key: 'temperatura_2', label: 'Interna (T2)', color: COLORS.t1 },
    { key: 'temperatura_1', label: 'Externa (T1)', color: COLORS.u2 },
  ], [idealBandPlugin]);

  charts.spectrum = makeSpectrumChart('chart-spectrum');
}

// Plugin Chart.js inline: sombreia a faixa ideal de temperatura no fundo.
const idealBandPlugin = {
  id: 'idealBand',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const y = scales.y;
    if (!y || !chartArea) return;
    const yHi = y.getPixelForValue(IDEAL_TEMP.max);
    const yLo = y.getPixelForValue(IDEAL_TEMP.min);
    const top = Math.min(yHi, yLo);
    const height = Math.abs(yLo - yHi);
    ctx.save();
    ctx.fillStyle = 'rgba(45, 212, 191, 0.12)';
    ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, height);
    ctx.restore();
  },
};

function makeLineChart(canvasId, series, plugins) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    plugins: plugins || [],
    data: {
      labels: [],
      datasets: series.map((serie) => ({
        label: serie.label,
        data: [],
        borderColor: serie.color,
        backgroundColor: serie.color + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.28,
        spanGaps: true,
        _key: serie.key,
        _fallback: serie.fallback,
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
      labels: Array.from({ length: NUM_BANDS }, (_, index) => bandLabelShort(index)),
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

function renderCharts(readings) {
  const labels = readings.map((reading) => formatClock(reading.timestamp));

  [charts.temp, charts.umid, charts.peso, charts.audio, charts.accel, charts.thermo].forEach((chart) => {
    chart.data.labels = labels;
    chart.data.datasets.forEach((dataset) => {
      dataset.data = readings.map((reading) => {
        let value = reading[dataset._key];
        if (value == null && dataset._fallback) value = reading[dataset._fallback];
        return value != null ? value : null;
      });
    });
    chart.update('none');
  });

  renderSpectrumBar(readings);
  renderSpectrogram(readings);
}

function renderSpectrumBar(readings) {
  let latestBands = null;
  for (let index = readings.length - 1; index >= 0; index--) {
    const bands = bandsOf(readings[index]);
    if (bands) {
      latestBands = bands;
      break;
    }
  }

  charts.spectrum.data.datasets[0].data = latestBands || [];
  charts.spectrum.update('none');
}

function renderSpectrogram(readings) {
  const canvas = document.getElementById('spectrogram');
  if (!canvas) return;

  const box = canvas.parentElement;
  const cssWidth = Math.max(box.clientWidth, 1);
  const cssHeight = Math.max(box.clientHeight, 1);
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const columns = readings.map(bandsOf).filter(Boolean);
  if (!columns.length) {
    ctx.fillStyle = '#6b7484';
    ctx.font = '12px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem audio_bands no periodo.', cssWidth / 2, cssHeight / 2);
    return;
  }

  let lo = Infinity;
  let hi = -Infinity;
  columns.forEach((bands) => {
    bands.forEach((value) => {
      if (value == null || value <= -119.9) return;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    });
  });

  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1) {
    lo = -90;
    hi = -20;
  }

  const colWidth = cssWidth / columns.length;
  const rowHeight = cssHeight / NUM_BANDS;

  columns.forEach((bands, columnIndex) => {
    bands.forEach((value, bandIndex) => {
      const normalized = value == null || value <= -119.9 ? 0 : clamp01((value - lo) / (hi - lo));
      ctx.fillStyle = dbColor(normalized);
      const y = cssHeight - (bandIndex + 1) * rowHeight;
      ctx.fillRect(columnIndex * colWidth, y, Math.ceil(colWidth) + 0.5, Math.ceil(rowHeight) + 0.5);
    });
  });
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
      : String(String(bv)).localeCompare(String(av));
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
      <td class="num">${fmt(reading.peso_kg != null ? reading.peso_kg : reading.peso_raw, 2)}</td>
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
    const tagClass = file.trigger === 'anomaly' ? 'audio-tag-alert' : 'audio-tag-soft';
    return `
      <article class="audio-card">
        <div class="audio-card-head">
          <span class="audio-tag ${tagClass}">${escapeHtml(file.trigger || 'periodic')}</span>
          <span class="audio-meta">${escapeHtml(formatDateTime(file.timestamp))}</span>
        </div>
        <h3>${escapeHtml(file.file)}</h3>
        <p>${fmt(file.duracao_s, 1)} s · ${bytesLabel(file.bytes)}</p>
        <audio controls preload="none" src="${url}"></audio>
        <a class="audio-link" href="${url}" target="_blank" rel="noreferrer">Abrir WAV</a>
      </article>
    `;
  }).join('');
}

// Termorregulacao: quanto a colmeia amortece a variacao do ambiente e se a
// temperatura interna esta na faixa ideal. Usa /api/stats (min/max/avg) e a
// serie da janela (para o % do tempo na faixa).
function renderThermoregulation(stats, series) {
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const setValue = (id, value, unit) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `${value}${unit ? `<span class="unit">${unit}</span>` : ''}`;
  };

  const t = stats && stats.temperatura;
  const u = stats && stats.umidade;

  // --- Temperatura interna media + status vs faixa ideal ---
  const tInAvg = t && t.t2 ? t.t2.avg : null;
  setValue('thermo-temp-avg', fmt(tInAvg, 1), '&deg;C');
  const idealTile = document.getElementById('thermo-temp-ideal');
  if (idealTile) {
    idealTile.classList.remove('tile-ok', 'tile-warn', 'tile-danger');
    if (tInAvg != null) {
      const inBand = tInAvg >= IDEAL_TEMP.min && tInAvg <= IDEAL_TEMP.max;
      const near = tInAvg >= IDEAL_TEMP.min - 2 && tInAvg <= IDEAL_TEMP.max + 2;
      idealTile.classList.add(inBand ? 'tile-ok' : (near ? 'tile-warn' : 'tile-danger'));
    }
  }
  setText('thermo-temp-band', tInAvg == null
    ? `faixa ${IDEAL_TEMP.min}–${IDEAL_TEMP.max}°C`
    : (tInAvg < IDEAL_TEMP.min ? `abaixo da faixa (${IDEAL_TEMP.min}–${IDEAL_TEMP.max}°C)`
      : (tInAvg > IDEAL_TEMP.max ? `acima da faixa (${IDEAL_TEMP.min}–${IDEAL_TEMP.max}°C)`
        : `dentro da faixa ${IDEAL_TEMP.min}–${IDEAL_TEMP.max}°C`)));

  // --- Amortecimento de temperatura ---
  const ampTout = t && t.t1 ? amplitude(t.t1) : null;
  const ampTin = t && t.t2 ? amplitude(t.t2) : null;
  const dampT = dampening(ampTin, ampTout);
  setValue('thermo-temp-damp', fmt(dampT, 0), '%');
  setText('thermo-temp-damp-sub', ampTout != null ? `ext oscilou ${fmt(ampTout, 1)}°C` : 'ext —');

  // --- Delta T interna - externa ---
  const dT = (t && t.t2 && t.t1) ? diff(t.t2.avg, t.t1.avg) : null;
  setValue('thermo-temp-delta', signed(dT, 1), '&deg;C');
  setText('thermo-temp-delta-sub', dT == null ? '—' : (dT >= 0 ? 'aquecendo' : 'resfriando'));

  // --- % do tempo na faixa ideal (serie) ---
  const pct = pctInBand(series, 'temperatura_2', IDEAL_TEMP.min, IDEAL_TEMP.max);
  setValue('thermo-temp-inband', fmt(pct, 0), '%');

  // --- Umidade (sem faixa ideal): amortecimento + delta ---
  const ampUout = u && u.u1 ? amplitude(u.u1) : null;
  const ampUin = u && u.u2 ? amplitude(u.u2) : null;
  const dampU = dampening(ampUin, ampUout);
  setValue('thermo-umid-damp', fmt(dampU, 0), '%');
  setText('thermo-umid-damp-sub', ampUout != null ? `ext oscilou ${fmt(ampUout, 1)}%` : 'ext —');

  const dU = (u && u.u2 && u.u1) ? diff(u.u2.avg, u.u1.avg) : null;
  setValue('thermo-umid-delta', signed(dU, 1), '%');
}

function updateDeviceOptions(devices) {
  const select = document.getElementById('device-select');
  if (!select) return;

  select.innerHTML = '<option value="">Todos</option>';
  devices
    .slice()
    .sort((a, b) => String(a.device_id).localeCompare(String(b.device_id)))
    .forEach((device) => {
      const option = document.createElement('option');
      option.value = device.device_id;
      option.textContent = `${device.device_id} (${device.reading_count})`;
      select.appendChild(option);
    });

  select.value = state.deviceId;
}

function updateLastUpdate() {
  const label = document.getElementById('last-update');
  if (label) {
    label.textContent = 'Atualizado agora';
  }
}

function setLastUpdateError() {
  const label = document.getElementById('last-update');
  if (label) label.textContent = 'Falha ao atualizar';
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

function bandsOf(reading) {
  const bands = reading && reading.audio_bands;
  return Array.isArray(bands) && bands.length === NUM_BANDS ? bands : null;
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

function diff(a, b) {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return null;
  return a - b;
}

// "+x.x" / "-x.x" (ou "—" se nulo).
function signed(value, decimals) {
  if (value == null || Number.isNaN(value)) return '—';
  const s = Number(value).toFixed(decimals);
  return value > 0 ? `+${s}` : s;
}

// Amplitude (max - min) de um stat { min, max }.
function amplitude(stat) {
  if (!stat || stat.min == null || stat.max == null) return null;
  return stat.max - stat.min;
}

// Amortecimento: quanto da variacao externa a colmeia absorveu, em %.
// 100% = interna totalmente estavel; 0% = varia igual ao ambiente.
function dampening(ampIn, ampOut) {
  if (ampIn == null || ampOut == null || ampOut <= 0) return null;
  const d = (1 - ampIn / ampOut) * 100;
  return Math.max(0, Math.min(100, d));
}

// % das leituras de `key` na serie que caem em [lo, hi].
function pctInBand(series, key, lo, hi) {
  if (!Array.isArray(series) || !series.length) return null;
  let valid = 0;
  let inBand = 0;
  series.forEach((r) => {
    const v = r[key];
    if (v == null || Number.isNaN(v)) return;
    valid += 1;
    if (v >= lo && v <= hi) inBand += 1;
  });
  return valid ? (inBand / valid) * 100 : null;
}

function fmt(value, decimals) {
  if (value == null || Number.isNaN(value)) return '—';
  return Number(value).toFixed(decimals);
}

// Peso ja vem em kg (campo peso_kg, float). Leituras antigas so tem peso_raw
// (kg inteiro): usamos como fallback para nao quebrar o historico.
function pesoInfo(reading) {
  const kg = reading.peso_kg != null ? reading.peso_kg : reading.peso_raw;
  if (kg == null) return { value: null, unit: 'kg', decimals: 2 };
  return { value: kg, unit: 'kg', decimals: 2 };
}

// Posicao da colmeia: angulo entre o vetor de aceleracao atual e a referencia
// de repouso (ACCEL_REF). Independe da magnitude (normaliza os dois vetores),
// entao nao importa se |g| medido nao e exatamente 9.81.
function tiltInfo(reading) {
  if (reading.accel_x == null && reading.accel_y == null && reading.accel_z == null) {
    return { angle: null, label: '—', cls: '' };
  }
  const x = reading.accel_x || 0;
  const y = reading.accel_y || 0;
  const z = reading.accel_z || 0;
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag < 1e-6) return { angle: null, label: '—', cls: '' };

  const refMag = Math.sqrt(ACCEL_REF.x ** 2 + ACCEL_REF.y ** 2 + ACCEL_REF.z ** 2);
  const cos = (x * ACCEL_REF.x + y * ACCEL_REF.y + z * ACCEL_REF.z) / (mag * refMag);
  const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;

  if (angle < TILT_OK_DEG) return { angle, label: 'No lugar', cls: 'status-ok' };
  if (angle < TILT_WARN_DEG) return { angle, label: 'Inclinada', cls: 'status-warn' };
  return { angle, label: 'Derrubada', cls: 'status-danger' };
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

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
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
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
