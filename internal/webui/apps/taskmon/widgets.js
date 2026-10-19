import { h } from '/assets/js/core/vdom.js';
import { fmtRate } from '/assets/js/core/dom.js';
import { t, tf } from '/assets/js/core/i18n.js';

export const WIDGET_TYPES = ['line', 'number', 'bar', 'log'];

export const SENSORS = [
  {
    id: 'cpu', groupKey: 'app.taskmon.w-cpu', icon: 'cpu', items: [
      { id: 'cpu', labelKey: 'app.taskmon.w-cpu-usage', unit: '%', type: 'line', max: 100, series: [{ key: 'cpu', label: 'CPU', color: 'var(--chart-2)' }] },
      { id: 'load', labelKey: 'app.taskmon.w-load', unit: '', type: 'line', series: [{ key: 'load1', labelKey: 'app.taskmon.w-load-1m', color: 'var(--chart-3)' }] },
    ],
  },
  {
    id: 'memory', groupKey: 'app.taskmon.w-memory', icon: 'memory', items: [
      { id: 'mem', labelKey: 'app.taskmon.w-mem-usage', unit: '%', type: 'line', max: 100, series: [{ key: 'memPct', labelKey: 'app.taskmon.w-memory', color: 'var(--chart-1)' }] },
      { id: 'memUsed', labelKey: 'app.taskmon.w-mem-used', unit: 'GB', type: 'number', key: 'memUsedGB', sub: 'memTotalGB' },
    ],
  },
  {
    id: 'net', groupKey: 'app.taskmon.w-net', icon: 'network', items: [
      {
        id: 'net', labelKey: 'app.taskmon.w-net-rate', unit: 'B/s', type: 'line', series: [
          { key: 'netTxRate', labelKey: 'app.taskmon.w-send', color: 'var(--chart-2)' },
          { key: 'netRxRate', labelKey: 'app.taskmon.w-recv', color: 'var(--chart-1)' },
        ],
      },
    ],
  },
  {
    id: 'disk', groupKey: 'app.taskmon.w-disk', icon: 'disk', items: [
      {
        id: 'disk', labelKey: 'app.taskmon.w-disk-throughput', unit: 'B/s', type: 'line', series: [
          { key: 'diskWriteRate', labelKey: 'app.taskmon.w-write', color: 'var(--chart-3)' },
          { key: 'diskReadRate', labelKey: 'app.taskmon.w-read', color: 'var(--chart-4)' },
        ],
      },
      { id: 'diskUsed', labelKey: 'app.taskmon.w-root-used', unit: '%', type: 'number', key: 'diskPct', sub: 'diskText' },
    ],
  },
  {
    id: 'gpu', group: 'GPU', icon: 'monitor', items: [
      { id: 'gpu', labelKey: 'app.taskmon.w-gpu', unit: '%', type: 'number', key: 'gpu' },
    ],
  },
  {
    id: 'host', groupKey: 'app.taskmon.w-host', icon: 'server', items: [
      { id: 'procs', labelKey: 'app.taskmon.w-proc-total', unit: '', type: 'number', key: 'procCount' },
      { id: 'uptime', labelKey: 'app.taskmon.col-runtime', unit: '', type: 'number', key: 'uptimeText' },
      { id: 'topCpu', labelKey: 'app.taskmon.w-cpu-top5', unit: '%', type: 'bar', listKey: 'topCpu' },
      { id: 'topMem', labelKey: 'app.taskmon.w-mem-top5', unit: '%', type: 'bar', listKey: 'topMem' },
      { id: 'log', labelKey: 'app.taskmon.w-samples', unit: '', type: 'log', key: 'log' },
    ],
  },
];

export const SENSOR_MAP = new Map();
for (const g of SENSORS) for (const s of g.items) SENSOR_MAP.set(s.id, s);

export function sensorGroupLabel(g) {
  return g.groupKey ? t(g.groupKey) : g.group;
}

export function sensorLabel(s) {
  return s.labelKey ? t(s.labelKey) : s.label;
}

export function seriesLabel(se) {
  return se.labelKey ? t(se.labelKey) : se.label;
}

export function widgetTitle(w) {
  const s = SENSOR_MAP.get(w.sensor);
  return s ? sensorLabel(s) : w.sensor;
}

export function widgetHeaderValue(w, samples) {
  const s = SENSOR_MAP.get(w.sensor);
  if (!s || !s.series || s.series.length !== 1 || !samples.length) return '';
  const last = samples[samples.length - 1];
  return fmtValue(Number(last[s.series[0].key]), s.unit);
}

export function newWidget(sensorId) {
  const s = SENSOR_MAP.get(sensorId);
  if (!s) return null;
  return {
    id: `${sensorId}-${Math.random().toString(36).slice(2, 8)}`,
    sensor: sensorId,
    type: WIDGET_TYPES.includes(s.type) ? s.type : 'line',
    size: 'm',
  };
}

export function fmtUptime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '-';
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (d > 0) return tf('app.taskmon.fmt-d-h', { v1: d, v2: hh });
  if (hh > 0) return tf('app.taskmon.fmt-h-m', { v1: hh, v2: mm });
  return tf('app.taskmon.fmt-m', { v1: mm });
}

function fmtValue(v, unit) {
  if (v == null || Number.isNaN(v)) return '-';
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === 'B/s') return fmtRate(v);
  if (unit === 'GB') return `${v.toFixed(2)} GB`;
  if (unit === '') return String(Math.round(v * 100) / 100);
  return `${v.toFixed(1)} ${unit}`;
}

function fmtAxis(v, unit) {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (unit === '%') return `${Math.round(v)}%`;
  if (unit === 'GB') return `${v >= 10 ? Math.round(v) : v.toFixed(1)}G`;
  const bytes = unit === 'B/s';
  const step = bytes ? 1024 : 1000;
  const u = ['', 'K', 'M', 'G', 'T'];
  let x = v;
  let i = 0;
  while (x >= step && i < u.length - 1) { x /= step; i++; }
  const n = x >= 100 ? String(Math.round(x)) : (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  return `${n}${u[i]}`;
}

function spanLabel(pts) {
  if (pts.length < 2) return t('app.taskmon.samples-waiting');
  const sec = Math.max(0, Math.round((pts[pts.length - 1].t - pts[0].t) / 1000));
  if (sec < 60) return tf('app.taskmon.samples-last-sec', { v1: sec });
  const m = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? tf('app.taskmon.samples-last-m-s', { v1: m, v2: rest }) : tf('app.taskmon.samples-last-m', { v1: m });
}

const VIEW_W = 300;
const VIEW_H = 100;

function lineChart(sensor, samples) {
  const grid = h('g', { class: 'tmon-axis', stroke: 'currentColor' },
    [0, 0.25, 0.5, 0.75, 1].map((f) => h('line', {
      key: f, x1: 0, y1: VIEW_H * f, x2: VIEW_W, y2: VIEW_H * f,
    })));

  const pts = samples.length ? samples : [];

  let peak = 0;
  for (const s of pts) {
    for (const se of sensor.series) {
      const v = Number(s[se.key]);
      if (Number.isFinite(v) && v > peak) peak = v;
    }
  }
  const max = sensor.max || (peak > 0 ? peak : 1) * 1.15;

  const n = Math.max(2, pts.length);
  const paths = [];
  for (const se of sensor.series) {
    let d = '';
    pts.forEach((s, i) => {
      const raw = Number(s[se.key]);
      const v = Number.isFinite(raw) ? raw : 0;
      const x = (i / (n - 1)) * VIEW_W;
      const y = VIEW_H - Math.max(0, Math.min(1, v / max)) * VIEW_H;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `;
    });
    if (!d) continue;
    paths.push(h('path', {
      key: se.key,
      d: d.trim(),
      fill: 'none',
      'vector-effect': 'non-scaling-stroke',
      style: {
        stroke: se.color, strokeWidth: '1.6', strokeLinejoin: 'round', strokeLinecap: 'round',
      },
    }));
  }

  const peakY = VIEW_H - Math.max(0, Math.min(1, peak / max)) * VIEW_H;
  const peakLabel = peak > 0 && peakY > VIEW_H * 0.14 && peakY < VIEW_H * 0.86;
  const marks = peak > 0
    ? [h('line', {
      key: 'peak',
      class: 'tmon-peak-line',
      x1: 0, y1: peakY.toFixed(2), x2: VIEW_W, y2: peakY.toFixed(2),
      'vector-effect': 'non-scaling-stroke',
    })]
    : [];

  return h('div', { class: 'tmon-chart-wrap' }, [
    h('div', { class: 'tmon-yaxis' }, [
      h('span', { key: 'max', text: fmtAxis(max, sensor.unit) }),
      peakLabel
        ? h('span', {
          key: 'peak',
          class: 'tmon-yaxis-peak',
          style: { top: `${((peakY / VIEW_H) * 100).toFixed(2)}%` },
          text: fmtAxis(peak, sensor.unit),
        })
        : null,
      h('span', { key: 'zero', text: '0' }),
    ].filter(Boolean)),
    h('svg', {
      class: 'tmon-chart', viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: 'none',
    }, [grid, ...marks, ...paths]),
    h('div', { class: 'tmon-xaxis' }, [
      h('span', {
        key: 'span',
        text: sensor.unit === 'B/s' ? `${spanLabel(pts)} · B/s` : spanLabel(pts),
      }),
      h('span', { key: 'n', class: 'mono', text: pts.length > 1 ? tf('app.taskmon.samples-count', { v1: (pts.length) }) : '' }),
    ]),
  ]);
}

function unavailableBody(title, hint) {
  return h('div', { class: 'tmon-figure tmon-off' }, [
    h('span', { class: 'tmon-off-tag' }, [
      h('i', { class: 'tmon-off-dot' }),
      h('span', { text: title }),
    ]),
    hint ? h('span', { class: 'tmon-off-sub', text: hint }) : null,
  ].filter(Boolean));
}

function numberBody(sensor, samples) {
  const last = samples.length ? samples[samples.length - 1] : null;
  const v = last ? Number(last[sensor.key]) : NaN;

  if (sensor.key === 'gpu' && (!last || Number(last.gpu) < 0)) {
    return last
      ? unavailableBody(t('app.taskmon.no-data'), t('app.taskmon.gpu-unavailable'))
      : unavailableBody(t('app.taskmon.samples-waiting'));
  }
  const value = Number.isFinite(v) ? v : null;

  let main = '-';
  let unit = sensor.unit || '';
  if (value != null) {
    if (sensor.unit === '%') { main = value.toFixed(1); unit = '%'; }
    else if (sensor.unit === 'GB') { main = value.toFixed(2); unit = 'GB'; }
    else if (sensor.unit === '') { main = String(Math.round(value * 100) / 100); unit = ''; }
    else { main = value.toFixed(1); }
  }
  if (sensor.key === 'uptimeText' && last) { main = last.uptimeText || '-'; unit = ''; }
  let sub = '';
  if (sensor.sub === 'memTotalGB' && last) {
    sub = tf('app.taskmon.mem-total', { v1: (Number(last.memTotalGB).toFixed(2)) });
  } else if (sensor.sub === 'diskText' && last) {
    sub = last.diskText || '';
  }
  const pct = sensor.unit === '%' && value != null ? value : null;
  const kind = pct == null ? '' : pct >= 90 ? ' danger' : pct >= 75 ? ' warning' : '';
  return h('div', { class: `tmon-figure${kind}` }, [
    h('div', { class: 'tmon-figure-v' }, [
      h('span', { class: 'tmon-figure-num', text: main }),
      unit ? h('span', { class: 'tmon-figure-u', text: unit }) : null,
    ].filter(Boolean)),
    sub ? h('div', { class: 'tmon-figure-sub', text: sub }) : null,
  ].filter(Boolean));
}

function barBody(sensor, samples) {
  const last = samples.length ? samples[samples.length - 1] : null;
  const list = (last && Array.isArray(last[sensor.listKey])) ? last[sensor.listKey] : [];
  if (!list.length) {
    return h('div', { class: 'tmon-bars' }, [h('div', { class: 'tmon-empty', text: t('app.taskmon.no-data') })]);
  }
  const max = Math.max(...list.map((x) => Number(x.value) || 0), 1);
  return h('div', { class: 'tmon-bars' }, list.map((x) => h('div', { class: 'tmon-bar' }, [
    h('div', { class: 'tmon-bar-label', title: x.label, text: x.label }),
    h('div', { class: 'tmon-bar-track' }, [
      h('div', { class: 'tmon-bar-fill', style: { width: `${Math.max(2, ((Number(x.value) || 0) / max) * 100)}%` } }),
    ]),
    h('div', { class: 'tmon-bar-val mono', text: fmtValue(Number(x.value), sensor.unit) }),
  ])));
}

function logBody(sensor, samples) {
  const lines = samples.slice(-14).map((s) => {
    const at = new Date(s.t).toLocaleTimeString('zh-CN', { hour12: false });
    return `${at}  CPU ${s.cpu == null ? '-' : s.cpu.toFixed(1) + '%'}  MEM ${s.memPct == null ? '-' : s.memPct.toFixed(1) + '%'}  ↑${fmtRate(s.netTxRate)} ↓${fmtRate(s.netRxRate)}`;
  });
  if (!lines.length) return h('div', { class: 'tmon-empty', text: t('app.taskmon.samples-waiting') });
  return h('pre', { class: 'tmon-log', text: lines.join('\n') });
}

function legend(sensor, last) {
  if (!sensor.series || sensor.series.length < 2) return null;
  return h('div', { class: 'tmon-legend' }, sensor.series.map((se) => h('span', { class: 'tmon-lg' }, [
    h('i', { class: 'tmon-lg-dot', style: { background: se.color } }),
    h('span', { text: `${seriesLabel(se)} ${last ? fmtValue(Number(last[se.key]), sensor.unit) : '-'}` }),
  ])));
}

export function renderWidgetBody(w, samples) {
  const sensor = SENSOR_MAP.get(w.sensor);
  if (!sensor) return h('div', { class: 'tmon-empty', text: t('app.taskmon.sensor-unknown') });
  const last = samples.length ? samples[samples.length - 1] : null;

  let body;
  switch (w.type) {
    case 'number':
      body = numberBody(sensor, samples);
      break;
    case 'bar':
      body = barBody(sensor, samples);
      break;
    case 'log':
      body = logBody(sensor, samples);
      break;
    default:
      body = lineChart(sensor, samples);
  }

  const lg = legend(sensor, last);
  return h('div', { class: 'tmon-w-body' }, lg ? [lg, body] : [body]);
}
