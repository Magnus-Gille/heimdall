/* Heimdall — Client-side Chart.js initialization */
'use strict';

// Theme toggle
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : (current === 'dark' ? null : 'light');
  if (next) {
    html.setAttribute('data-theme', next);
    localStorage.setItem('heimdall-theme', next);
  } else {
    html.removeAttribute('data-theme');
    localStorage.removeItem('heimdall-theme');
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  const theme = document.documentElement.getAttribute('data-theme');
  btn.textContent = theme === 'light' ? '☾' : '☀';
}

// Restore saved theme on load
(function() {
  const saved = localStorage.getItem('heimdall-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  }
  // Update icon and bind click handler after DOM is ready
  function initThemeToggle() {
    updateThemeIcon();
    const btn = document.querySelector('.theme-toggle');
    if (btn) btn.addEventListener('click', toggleTheme);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeToggle);
  } else {
    initThemeToggle();
  }
})();

let tempChart = null;

function initTempChart() {
  const canvas = document.getElementById('temp-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (tempChart) {
    tempChart.destroy();
  }

  tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'control-node',
          data: [],
          borderColor: '#7aa2f7',
          backgroundColor: 'rgba(122, 162, 247, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'nas',
          data: [],
          borderColor: '#9ece6a',
          backgroundColor: 'rgba(158, 206, 106, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'threshold',
          data: [],
          borderColor: '#f7768e',
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          type: 'time',
          time: {
            displayFormats: {
              hour: 'HH:mm',
              day: 'MMM d',
            },
          },
          ticks: { color: '#565f89', maxTicksLimit: 8 },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
        y: {
          ticks: {
            color: '#565f89',
            callback: function(value) { return value + '°C'; },
          },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
      },
      plugins: {
        legend: {
          labels: { color: '#c0caf5', boxWidth: 12 },
        },
      },
    },
  });

  loadTempData('24h');
}

async function loadTempData(range) {
  if (!tempChart) return;

  try {
    const [huginData, nasData] = await Promise.all([
      fetch('/api/metrics/control-node/cpu_temp?range=' + range).then(r => r.json()),
      fetch('/api/metrics/nas/cpu_temp?range=' + range).then(r => r.json()),
    ]);

    tempChart.data.datasets[0].data = huginData.map(d => ({ x: d.x, y: d.y }));
    tempChart.data.datasets[1].data = nasData.map(d => ({ x: d.x, y: d.y }));

    // Add threshold line spanning the data range
    if (huginData.length > 0) {
      const first = huginData[0].x;
      const last = huginData[huginData.length - 1].x;
      tempChart.data.datasets[2].data = [
        { x: first, y: 65 },
        { x: last, y: 65 },
      ];
    }

    tempChart.update('none');
  } catch (err) {
    console.error('Failed to load temperature data:', err);
  }
}

let ramChart = null;

function initRamChart() {
  const canvas = document.getElementById('ram-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ramChart) ramChart.destroy();

  ramChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'control-node',
          data: [],
          borderColor: '#7aa2f7',
          backgroundColor: 'rgba(122, 162, 247, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'nas',
          data: [],
          borderColor: '#9ece6a',
          backgroundColor: 'rgba(158, 206, 106, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time',
          time: { displayFormats: { hour: 'HH:mm', day: 'MMM d' } },
          ticks: { color: '#565f89', maxTicksLimit: 8 },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: '#565f89',
            callback: function(value) { return value + '%'; },
          },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
      },
      plugins: {
        legend: { labels: { color: '#c0caf5', boxWidth: 12 } },
      },
    },
  });

  loadRamData('24h');
}

async function loadRamData(range) {
  if (!ramChart) return;
  try {
    const [huginData, nasData] = await Promise.all([
      fetch('/api/metrics/control-node/mem_used_pct?range=' + range).then(r => r.json()),
      fetch('/api/metrics/nas/mem_used_pct?range=' + range).then(r => r.json()),
    ]);
    ramChart.data.datasets[0].data = huginData.map(d => ({ x: d.x, y: d.y }));
    ramChart.data.datasets[1].data = nasData.map(d => ({ x: d.x, y: d.y }));
    ramChart.update('none');
  } catch (err) {
    console.error('Failed to load RAM data:', err);
  }
}

// Handle range button clicks using event delegation
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('chart-range-ram')) {
    const range = e.target.dataset.range;
    if (!range) return;
    document.querySelectorAll('.chart-range-ram').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    loadRamData(range);
  }
  if (e.target.classList.contains('chart-range')) {
    const range = e.target.dataset.range;
    if (!range) return;

    // Update active state
    document.querySelectorAll('.chart-range').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');

    loadTempData(range);
  }
});

// Re-initialize charts when HTMX settles new content
document.addEventListener('htmx:afterSettle', function() {
  if (document.getElementById('temp-chart')) {
    setTimeout(initTempChart, 50);
  }
  if (document.getElementById('ram-chart')) {
    setTimeout(initRamChart, 50);
  }
});

let consolidationChart = null;

function initConsolidationChart() {
  const canvas = document.getElementById('consolidation-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (consolidationChart) consolidationChart.destroy();

  consolidationChart = new Chart(ctx, {
    type: 'bar',
    data: {
      datasets: [
        {
          label: 'Synthesis events',
          data: [],
          backgroundColor: 'rgba(122, 162, 247, 0.6)',
          borderColor: '#7aa2f7',
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'day',
            displayFormats: { day: 'MMM d' },
          },
          ticks: { color: '#565f89', maxTicksLimit: 10 },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#565f89',
            precision: 0,
          },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
      },
      plugins: {
        legend: { labels: { color: '#c0caf5', boxWidth: 12 } },
        title: {
          display: true,
          text: 'Synthesis activity (30d)',
          color: '#c0caf5',
        },
      },
    },
  });

  loadConsolidationData();
}

async function loadConsolidationData() {
  if (!consolidationChart) return;
  try {
    const data = await fetch('/api/consolidation/activity').then(r => r.json());
    consolidationChart.data.datasets[0].data = data.map(d => ({ x: d.x, y: d.y }));
    consolidationChart.update('none');
  } catch (err) {
    console.error('Failed to load consolidation activity data:', err);
  }
}

// Initialize consolidation chart if present on page load
if (document.getElementById('consolidation-chart')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsolidationChart);
  } else {
    initConsolidationChart();
  }
}

// Re-initialize consolidation chart after HTMX content settles (update existing listener)
document.addEventListener('htmx:afterSettle', function() {
  if (document.getElementById('consolidation-chart')) {
    setTimeout(initConsolidationChart, 50);
  }
});

// ── Insights charts ──────────────────────────────────────────────────────────

let insightsSisChart = null;
let insightsFrictionChart = null;
let insightsOutcomeChart = null;
let insightsSatChart = null;

async function initInsightsCharts() {
  const sisCanvas    = document.getElementById('insights-sis-chart');
  const fricCanvas   = document.getElementById('insights-friction-chart');
  const outcomeCanvas= document.getElementById('insights-outcome-chart');
  const satCanvas    = document.getElementById('insights-satisfaction-chart');

  // Nothing to do if no canvases present (page not rendered with charts)
  if (!sisCanvas && !fricCanvas && !outcomeCanvas && !satCanvas) return;

  let trend = [];
  try {
    trend = await fetch('/api/insights/trend').then(r => r.json());
  } catch (err) {
    console.error('Failed to load insights trend:', err);
    return;
  }

  if (!Array.isArray(trend) || trend.length === 0) return;

  const labels     = trend.map(d => d.date);
  const tickColor  = '#7e87b3';
  const gridColor  = 'rgba(59, 66, 97, 0.3)';
  const legendColor= '#c0caf5';

  const baseScaleX = {
    ticks: { color: tickColor, maxTicksLimit: 12 },
    grid: { color: gridColor },
  };
  const baseScaleY = {
    beginAtZero: true,
    ticks: { color: tickColor },
    grid: { color: gridColor },
  };

  // 1 — SIS trend (line)
  if (sisCanvas) {
    const ctx = sisCanvas.getContext('2d');
    if (insightsSisChart) insightsSisChart.destroy();
    insightsSisChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Self-Improvement Score',
          data: trend.map(d => d.sis),
          borderColor: '#7aa2f7',
          backgroundColor: 'rgba(122, 162, 247, 0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ...baseScaleX },
          y: { ...baseScaleY, suggestedMax: 100 },
        },
        plugins: {
          legend: { labels: { color: legendColor, boxWidth: 12 } },
          title: { display: true, text: 'Self-Improvement Score (weekly)', color: legendColor },
        },
      },
    });
  }

  // 2 — Friction events per session by category
  if (fricCanvas) {
    const ctx = fricCanvas.getContext('2d');
    if (insightsFrictionChart) insightsFrictionChart.destroy();
    insightsFrictionChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Buggy code',              data: trend.map(d => (d.friction || {}).buggy_code            || 0), backgroundColor: '#f7768e' },
          { label: 'Wrong approach',          data: trend.map(d => (d.friction || {}).wrong_approach        || 0), backgroundColor: '#e0af68' },
          { label: 'Misunderstood request',   data: trend.map(d => (d.friction || {}).misunderstood_request || 0), backgroundColor: '#bb9af7' },
          { label: 'Tooling friction',        data: trend.map(d => (d.friction || {}).tooling_friction      || 0), backgroundColor: '#7dcfff' },
          { label: 'Infrastructure failure',  data: trend.map(d => (d.friction || {}).infrastructure_failure|| 0), backgroundColor: '#9ece6a' },
          { label: 'User rejected action',    data: trend.map(d => (d.friction || {}).user_rejected_action  || 0), backgroundColor: '#7aa2f7' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ...baseScaleX, stacked: true },
          y: { ...baseScaleY, stacked: true },
        },
        plugins: {
          legend: { labels: { color: legendColor, boxWidth: 12 } },
          title: { display: true, text: 'Friction events by category', color: legendColor },
        },
      },
    });
  }

  // 3 — Outcome mix (stacked bar)
  if (outcomeCanvas) {
    const ctx = outcomeCanvas.getContext('2d');
    if (insightsOutcomeChart) insightsOutcomeChart.destroy();
    insightsOutcomeChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Fully achieved',          data: trend.map(d => (d.outcomes || {}).fully_achieved            || 0), backgroundColor: '#9ece6a' },
          { label: 'Mostly achieved',         data: trend.map(d => (d.outcomes || {}).mostly_achieved           || 0), backgroundColor: '#e0af68' },
          { label: 'Not achieved',            data: trend.map(d => (d.outcomes || {}).not_achieved              || 0), backgroundColor: '#f7768e' },
          { label: 'Unclear',                 data: trend.map(d => (d.outcomes || {}).unclear_from_transcript   || 0), backgroundColor: '#7e87b3' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ...baseScaleX, stacked: true },
          y: { ...baseScaleY, stacked: true },
        },
        plugins: {
          legend: { labels: { color: legendColor, boxWidth: 12 } },
          title: { display: true, text: 'Outcome mix per week', color: legendColor },
        },
      },
    });
  }

  // 4 — Satisfaction trend (line)
  if (satCanvas) {
    const ctx = satCanvas.getContext('2d');
    if (insightsSatChart) insightsSatChart.destroy();
    insightsSatChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Satisfaction quality (0–1)',
          data: trend.map(d => d.satisfaction_quality),
          borderColor: '#9ece6a',
          backgroundColor: 'rgba(158, 206, 106, 0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 4,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ...baseScaleX },
          y: { ...baseScaleY, suggestedMax: 1 },
        },
        plugins: {
          legend: { labels: { color: legendColor, boxWidth: 12 } },
          title: { display: true, text: 'Satisfaction quality trend', color: legendColor },
        },
      },
    });
  }
}

// ── Fleet temperature chart (one dataset per fleet host, overlaid) ──────────

let fleetTempChart = null;
const FLEET_TEMP_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff'];

function initFleetTempChart() {
  const canvas = document.getElementById('fleet-temp-chart');
  if (!canvas) return;

  // Host list is passed via a CSP-safe data attribute (inline <script> is blocked
  // by the page's script-src 'self' CSP).
  let hosts = [];
  try { hosts = JSON.parse(canvas.dataset.hosts || '[]'); } catch { hosts = []; }
  if (!Array.isArray(hosts)) hosts = [];

  const ctx = canvas.getContext('2d');
  if (fleetTempChart) fleetTempChart.destroy();

  fleetTempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: hosts.map((host, i) => ({
        label: host,
        data: [],
        borderColor: FLEET_TEMP_COLORS[i % FLEET_TEMP_COLORS.length],
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time',
          time: {
            displayFormats: { hour: 'HH:mm', day: 'MMM d' },
          },
          ticks: { color: '#565f89', maxTicksLimit: 8 },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
        y: {
          ticks: {
            color: '#565f89',
            callback: function(value) { return value + '°C'; },
          },
          grid: { color: 'rgba(59, 66, 97, 0.3)' },
        },
      },
      plugins: {
        legend: { labels: { color: '#c0caf5', boxWidth: 12 } },
      },
    },
  });

  loadFleetTempData(hosts, '24h');
}

async function loadFleetTempData(hosts, range) {
  if (!fleetTempChart) return;

  try {
    const results = await Promise.all(
      hosts.map((host) =>
        fetch('/api/metrics/' + host + '/temp_cpu_c?range=' + range)
          .then((r) => r.json())
          .catch(() => [])
      )
    );
    results.forEach((data, i) => {
      fleetTempChart.data.datasets[i].data = Array.isArray(data) ? data.map((d) => ({ x: d.x, y: d.y })) : [];
    });
    fleetTempChart.update('none');
  } catch (err) {
    console.error('Failed to load fleet temperature data:', err);
  }
}

// Initialize fleet temperature chart on page load if canvas present
if (document.getElementById('fleet-temp-chart')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFleetTempChart);
  } else {
    initFleetTempChart();
  }
}

// Initialize insights charts on page load if canvases present
if (document.getElementById('insights-sis-chart')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInsightsCharts);
  } else {
    initInsightsCharts();
  }
}

// Re-initialize insights charts after HTMX content settles
document.addEventListener('htmx:afterSettle', function() {
  if (document.getElementById('insights-sis-chart')) {
    setTimeout(initInsightsCharts, 50);
  }
});
