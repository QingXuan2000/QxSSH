import { toast } from '/assets/js/core/ui.js';
import { requestSudoElevation } from '/assets/js/core/sys.js';
import { getJSONPref, setJSONPref } from '/assets/js/core/prefs.js';
import { createPoller } from '/assets/js/core/dom.js';
import { signal, batch } from '/assets/js/core/signal.js';
import { sftpSudoForget } from '/assets/js/core/qxssh-api.js';
import { collectMetrics as fetchMetrics } from '/assets/js/core/hostprobe.js';
import { taskmonProcesses } from './api.js';
import { SENSOR_MAP, newWidget, fmtUptime } from './widgets.js';
import { t, tf } from '/assets/js/core/i18n.js';

export const LS_LAYOUT = 'qx-taskmon-layout';
export const TICK_MS = 2500;
export const MAX_SAMPLES = 180;
export const MAX_ROWS = 2000;
export const DEFAULT_LAYOUT = {
  overview: ['cpu', 'mem', 'net', 'procs', 'disk', 'topCpu'],
};

export const hostId = signal(null);

export const elevated = signal(false);

export const layout = signal({});

export const samples = signal([]);

export const sys = signal(null);
export const list = signal(null);
export const procs = signal([]);

export const errMetrics = signal('');
export const errProcs = signal('');
export const lastTick = signal(0);

let upBase = null;

export const filter = {
  q: signal(''),
  preset: signal('all'),
  view: signal('flat'),
  sort: signal('cpu'),
  dir: signal(-1),
};

export const collapsed = signal(new Set());
export const expanded = signal(new Set());

export function loadLayout() {
  const stored = getJSONPref(LS_LAYOUT, null);
  const out = {};
  for (const pid of Object.keys(DEFAULT_LAYOUT)) {
    const src = Array.isArray(stored?.[pid]) ? stored[pid] : [];
    out[pid] = src.filter((w) => w && SENSOR_MAP.has(w.sensor) && typeof w.type === 'string');
    if (!out[pid].length) out[pid] = DEFAULT_LAYOUT[pid].map(newWidget).filter(Boolean);
  }
  return out;
}

function saveLayout() {
  setJSONPref(LS_LAYOUT, layout.value);
}

export function setLayout(pid, next) {
  layout.next = { ...layout.value, [pid]: next };
  saveLayout();
}

export function uptimeSec() {
  return upBase ? upBase.sec + (Date.now() - upBase.at) / 1000 : null;
}

export function toggleGroup(name) {
  const s = new Set(expanded.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  expanded.next = s;
}

export function setElevated(v) {
  elevated.next = !!v;
}

export async function toggleAdmin() {
  if (elevated.value) {
    setElevated(false);
    sftpSudoForget(hostId.value).catch(() => { });
    toast(t('app.taskmon.admin-exited'), 'success');
    refresh();
    return;
  }
  try {
    const r = await requestSudoElevation(hostId.value, { title: t('app.taskmon.sudo-prompt') });
    if (r.ok) {
      setElevated(true);
      toast(t('app.taskmon.admin-enabled'), 'success');
      refresh();
    } else if (!r.cancelled) {
      toast(r.error, 'error');
    }
  } catch (e) {
    toast(t('app.taskmon.sudo-auth-failed') + (e.message || e), 'error');
  }
}

async function tickMetrics() {
  if (busy.m) return;
  busy.m = true;
  try {
    const data = await fetchMetrics(hostId.value);
    if (data && data.error) {
      errMetrics.next = data.error;
      return;
    }
    batch(() => {
      errMetrics.next = '';
      sys.next = data;
      pushSample();
      lastTick.next = Date.now();
    });
  } catch (e) {
    errMetrics.next = e.message || String(e);
  } finally {
    busy.m = false;
  }
}

async function tickProcs() {
  if (busy.p) return;
  busy.p = true;
  try {
    const data = await taskmonProcesses(hostId.value, elevated.value);
    if (data && data.error) {
      errProcs.next = data.error;
      return;
    }
    batch(() => {
      errProcs.next = '';
      list.next = data;
      procs.next = Array.isArray(data.procs) ? data.procs : [];
    });
  } catch (e) {
    errProcs.next = e.message || String(e);
  } finally {
    busy.p = false;
  }
}

const busy = { m: false, p: false };

function pushSample() {
  const s = sys.peek();
  if (!s) return;
  const now = Date.now();
  const pts = samples.peek();
  const prev = pts.length ? pts[pts.length - 1] : null;
  const dt = prev ? (now - prev.t) / 1000 : 0;

  const rate = (cur, old) => {
    if (!prev || dt <= 0 || cur == null || old == null || cur < old) return 0;
    return (cur - old) / dt;
  };

  if (s.uptimeSec > 0 && (!upBase || upBase.sec !== s.uptimeSec)) {
    upBase = { sec: s.uptimeSec, at: now };
  }
  const uptime = upBase ? upBase.sec + (now - upBase.at) / 1000 : s.uptimeSec;

  const top = (key, n = 5) => procs.peek()
    .slice()
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, n)
    .map((p) => ({ label: p.name, value: p[key] || 0 }));

  const sample = {
    t: now,
    cpu: s.cpuPct,
    memPct: s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0,
    memUsedGB: s.memUsed,
    memTotalGB: s.memTotal,
    netRxRate: rate(s.netRxBytes, prev?._netRx),
    netTxRate: rate(s.netTxBytes, prev?._netTx),
    diskReadRate: rate(s.diskReadBytes, prev?._diskR),
    diskWriteRate: rate(s.diskWriteBytes, prev?._diskW),
    diskPct: s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : 0,
    diskText: s.diskTotal ? `${s.diskUsed.toFixed(1)} / ${s.diskTotal.toFixed(0)} GB` : '',
    gpu: s.gpuPct,
    load1: list.peek()?.load1 ?? 0,
    procCount: list.peek()?.count ?? 0,
    uptimeText: fmtUptime(uptime),
    topCpu: top('cpu'),
    topMem: top('mem'),
    _netRx: s.netRxBytes,
    _netTx: s.netTxBytes,
    _diskR: s.diskReadBytes,
    _diskW: s.diskWriteBytes,
  };
  samples.next = pts.length >= MAX_SAMPLES
    ? [...pts.slice(pts.length - MAX_SAMPLES + 1), sample]
    : [...pts, sample];
}

export function refresh() {
  return Promise.all([tickMetrics(), tickProcs()]);
}

export function startPolling() {
  poller?.dispose();
  poller = createPoller(() => refresh(), TICK_MS);
  poller.start();
  return () => {
    poller?.dispose();
    poller = null;
  };
}

let poller = null;
