import { t, tf } from '/assets/js/core/i18n.js';
export { createLineBuffer, renderLog } from '/assets/js/core/stream.js';

export function containerGroup(c) {
  const state = c.State || '';
  if (state === 'running' || state === 'restarting') return 'running';
  if (state === 'exited') {
    const m = /Exited \((\d+)\)/.exec(c.Status || '');
    return m && m[1] !== '0' ? 'bad' : 'stopped';
  }
  if (state === 'paused') return 'paused';
  return state === 'dead' || state === 'removing' ? 'bad' : 'stopped';
}

const GROUP_LABEL_KEYS = {
  running: 'app.docker.state-running',
  stopped: 'app.docker.state-exited',
  paused: 'app.docker.state-paused',
  bad: 'app.docker.state-dead',
};

export function groupLabel(g) {
  const key = GROUP_LABEL_KEYS[g];
  return key ? t(key) : g;
}

const STATE_LABEL_KEYS = {
  running: 'app.docker.state-running',
  exited: 'app.docker.state-exited-short',
  created: 'app.docker.state-created',
  paused: 'app.docker.state-paused',
  restarting: 'app.docker.state-restarting',
  removing: 'app.docker.state-removing',
  dead: 'app.docker.state-error',
};

export function stateLabel(name) {
  const key = STATE_LABEL_KEYS[name];
  return key ? t(key) : name;
}

const DURATION_UNIT_KEYS = {
  second: 'app.docker.unit-second', seconds: 'app.docker.unit-second', minute: 'app.docker.unit-minute', minutes: 'app.docker.unit-minute',
  hour: 'app.docker.unit-hour', hours: 'app.docker.unit-hour', day: 'app.docker.unit-day', days: 'app.docker.unit-day',
  week: 'app.docker.unit-week', weeks: 'app.docker.unit-week', year: 'app.docker.unit-year', years: 'app.docker.unit-year',
};

function durationUnit(w) {
  const key = DURATION_UNIT_KEYS[w.toLowerCase()];
  return key ? t(key) : w;
}

export function fmtHealth(hv) {
  if (!hv) return '';
  const key = { healthy: 'app.docker.health-healthy', unhealthy: 'app.docker.health-unhealthy', starting: 'app.docker.health-starting' }[hv];
  return key ? t(key) : hv;
}

export function fmtStatus(s) {
  if (!s) return '';
  let out = String(s).trim();
  const m = /^(running|exited|created|paused|restarting|removing|dead)\b\s*(.*)$/i.exec(out);
  if (m) {
    const head = stateLabel(m[1].toLowerCase());
    const rest = (m[2] || '').trim();
    const hm = /^\((healthy|unhealthy|starting)\)$/i.exec(rest);
    if (hm) return `${head} · ${fmtHealth(hm[1].toLowerCase())}`;
    const em = /^\((\d+)\)\s*(.*)$/.exec(rest);
    if (em) out = `${head}（${em[1]}）${em[2] ? ` · ${em[2]}` : ''}`;
    else out = rest ? `${head} · ${rest}` : head;
  } else {
    if (/^Less than a minute/.test(out)) out = out.replace(/^Less than a minute/, t('app.docker.uptime-less-1m'));
    else if (/^About a /.test(out)) out = out.replace(/^About a /, t('app.docker.uptime-about'));
    out = out.replace(/^Up\b\s*/, t('app.docker.upstate-prefix'));
  }
  return out
    .replace(/\b(?:seconds?|minutes?|hours?|days?|weeks?|years?)\b/g, durationUnit)
    .replace(/\bago\b/, t('app.docker.ago'));
}

export function parseMemUsage(s) {
  const m = /^([\d.]+)\s*([kMGT]?i?B)\s*\/\s*([\d.]+)\s*([kMGT]?i?B)$/.exec(String(s || '').trim());
  if (!m) return null;
  return { used: toBytes(m[1], m[2]), total: toBytes(m[3], m[4]) };
}

export function parsePairIO(s) {
  const m = /^([\d.]+\s*[kMGT]?i?B)\s*\/\s*([\d.]+\s*[kMGT]?i?B)$/.exec(String(s || '').trim());
  if (!m) return null;
  return [toBytes(...m[1].split(/\s+/)), toBytes(...m[2].split(/\s+/))];
}

export function toBytes(num, unit) {
  const n = parseFloat(num);
  if (isNaN(n)) return 0;
  const up = String(unit || 'B').toUpperCase();
  if (up === 'B') return n;
  const exp = { K: 1, M: 2, G: 3, T: 4 }[up[0]] || 0;
  return n * Math.pow(up.includes('I') ? 1024 : 1000, exp);
}

export function parsePercent(s) {
  const n = parseFloat(String(s || '').replace('%', ''));
  return isNaN(n) ? null : n;
}

export function fmtMaybeSize(v) {
  if (v == null || v === '') return '-';
  if (typeof v === 'number') {
    if (v < 1024) return `${v} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let x = v / 1000;
    let i = 0;
    while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
    return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
  }
  return String(v);
}

export function imageRef(img) {
  const repo = img.Repository || img.RepositoryName || '';
  const tag = img.Tag || '';
  if (!repo || repo === '<none>') return img.ID || '';
  return tag && tag !== '<none>' ? `${repo}:${tag}` : repo;
}
