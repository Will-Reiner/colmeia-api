'use strict';

/**
 * Logica do dashboard: busca dados via fetch, renderiza cards/graficos/tabela,
 * e faz auto-refresh a cada 30s. Sem framework.
 */

const REFRESH_MS = 30000;
const RANGE_HOURS_DEFAULT = 24;

const state = {
  deviceId: '',          // '' = todos
  rangeHours: RANGE_HOURS_DEFAULT,
  sort: { key: 'received_at', dir: 'desc' },
  lastReadings: [],
  lastFetch: null,
};

const charts = {}; // instancias Chart.js por id

// Paleta consistente para as series.
const COLORS = {
  t1: '#4c8bf5', t2: '#38bdf8',
  u1: '#34d399', u2: '#a3e635',
  peso: '#fbbf24',
  audio: '#f472b6',
};

// --- Boot -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  setupControls();
  setupSorting();
  initCharts();
  refresh();
  setInterval(refresh, REFRESH_MS);
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
    renderCharts((seriesRes.data || []).slice().reverse()); // ordem cronologica
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

  const tempEl = document.getElementById('card-temp');
  const tempSub = document.getElementById('card-temp-sub');
  const umidEl = document.getElementById('card-umid');
  const umidSub = document.getElementById('card-umid-sub');
  const pesoEl = document.getElementById('card-peso');
  const pesoSub = document.getElementById('card-peso-sub');
  const servoEl = document.getElementById('card-servo');
  const servoSub = document.getElementById('card-servo-sub');

  if (!reading) {
    tempEl.innerHTML = '&mdash;<span class="unit">&deg;C</span>';
    umidEl.innerHTML = '&mdash;<span class="unit">%</span>';
    pesoEl.innerHTML = '&mdash;<span class="unit">kg</span>';
    servoEl.textContent = '—';
    return;
  }

  const tAvg = avg([reading.temperatura_1, reading.temperatura_2]);
  const uAvg = avg([reading.umidade_1, reading.umidade_2]);

  tempEl.innerHTML = `${fmt(tAvg, 1)}<span class="unit">&deg;C</span>`;
  tempSub.textContent = `t1 ${fmt(reading.temperatura_1, 1)} / t2 ${fmt(reading.temperatura_2, 1)}`;

  umidEl.innerHTML = `${fmt(uAvg, 1)}<span class="unit">%</span>`;
  umidSub.textContent = `u1 ${fmt(reading.umidade_1, 1)} / u2 ${fmt(reading.umidade_2, 1)}`;

  pesoEl.innerHTML = `${fmt(reading.peso_kg, 2)}<span class="unit">kg</span>`;
  pesoSub.textContent = stats && stats.peso_kg
    ? `min ${fmt(stats.peso_kg.min, 2)} / max ${fmt(stats.peso_kg.max, 2)} (24h)`
    : reading.device_id;

  const servo = reading.servo_status || '—';
  servoEl.textContent = capitalize(servo);
  servoEl.className = 'card-value ' + (servo === 'aberto' ? 'badge-open' : 'badge-close');
  servoSub.textContent = reading.fim_curso === 1 || reading.fim_curso === true
    ? 'fim de curso: ativo' : 'fim de curso: inativo';
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
    { key: 'peso_kg', label: 'Peso (kg)', color: COLORS.peso },
  ]);
  charts.audio = makeLineChart('chart-audio', [
    { key: 'audio_rms', label: 'Audio RMS', color: COLORS.audio },
  ]);
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
  for (const chart of [charts.temp, charts.umid, charts.peso, charts.audio]) {
    chart.data.labels = labels;
    chart.data.datasets.forEach((ds) => {
      ds.data = readings.map((r) => (r[ds._key] != null ? r[ds._key] : null));
    });
    chart.update('none');
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
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Sem leituras no periodo.</td></tr>';
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
      <td class="num">${fmt(r.peso_kg, 2)}</td>
      <td class="num">${fmt(r.audio_rms, 4)}</td>
      <td>${r.servo_status ? escapeHtml(r.servo_status) : '<span class="muted">—</span>'}</td>
      <td>${fimCurso(r.fim_curso)}</td>
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

function fimCurso(v) {
  if (v == null) return '<span class="muted">—</span>';
  return (v === 1 || v === true) ? 'sim' : 'nao';
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
