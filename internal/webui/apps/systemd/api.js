/**
 * api.js —— Systemd 交互 API 层
 * 封装 systemctl、journalctl 命令，支持自动提权与健壮解析
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { execRun } from '/assets/js/core/qxssh-api.js';
import { isSudoPermError, requestSudoElevation } from '/assets/js/core/sys.js';

const T_CMD = 20;
const T_ACTION = 45;

const elevHosts = new Set();

function isPermErr(str) {
  const s = String(str || '').toLowerCase();
  return isSudoPermError(str)
    || s.includes('interactive authentication required')
    || s.includes('access denied')
    || s.includes('permission denied')
    || s.includes('authentication is required')
    || s.includes('must be root')
    || s.includes('failed to set unit properties')
    || s.includes('polkit');
}

/**
 * 包装命令执行，若遇到权限错误自动请求提权并重试
 */
async function runCommand(host, argv, { timeout = T_CMD, elevated = elevHosts.has(host) } = {}) {
  let r = await execRun({ host, argv, timeout, elevated });
  if (!r.ok && !elevated && isPermErr(`${r.output || ''} ${r.error || ''}`)) {
    const elevatedOk = await requestSudoElevation(host, {
      title: t('app.systemd.name'),
      reason: t('app.systemd.need-sudo-hint'),
    });
    if (elevatedOk && elevatedOk.ok) {
      elevHosts.add(host);
      r = await execRun({ host, argv, timeout, elevated: true });
    }
  }
  return r;
}

/**
 * 探测目标主机 Systemd 支持状态
 * @param {string} host
 * @returns {Promise<{ ok: boolean, state: string, isSystemd: boolean, error?: string }>}
 */
export async function checkSystemd(host) {
  if (!host) {
    return { ok: false, state: 'unknown', isSystemd: false, error: 'Host ID missing' };
  }
  const r = await runCommand(host, [
    'sh', '-c',
    'if command -v systemctl >/dev/null 2>&1; then systemctl is-system-running 2>&1 || true; else echo "NO_SYSTEMCTL"; fi'
  ], { timeout: 10 });

  const out = String(r.output || '').trim();
  if (out === 'NO_SYSTEMCTL' || out.includes('not been booted with systemd') || out.includes('Offline')) {
    return { ok: false, state: 'offline', isSystemd: false, error: out };
  }
  const state = out.split('\n')[0].trim().toLowerCase() || 'unknown';
  return { ok: true, state, isSystemd: true };
}

/**
 * 获取系统状态与失败单元数
 * @param {string} host
 */
export async function getSystemdState(host) {
  const r = await runCommand(host, [
    'sh', '-c',
    'systemctl is-system-running 2>&1 || true; systemctl --failed --no-legend --no-pager 2>/dev/null | grep -c "\\.service\\|\\.socket\\|\\.timer\\|\\.mount" || echo "0"'
  ], { timeout: 10 });
  const lines = String(r.output || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const state = (lines[0] || 'unknown').toLowerCase();
  const failedCount = parseInt(lines[1] || '0', 10) || 0;
  return {
    state,
    isDegraded: state === 'degraded',
    isRunning: state === 'running',
    failedCount,
  };
}

/**
 * 获取全量 Units 列表及自启状态映射
 * @param {string} host
 * @returns {Promise<Array<{ unit: string, load: string, active: string, sub: string, description: string, unitFileState: string, unitType: string }>>}
 */
export async function listUnits(host) {
  const cmd = [
    'sh', '-c',
    'systemctl list-units --all --full --no-legend --no-pager --plain 2>&1; echo "---SPLIT---"; systemctl list-unit-files --full --no-legend --no-pager 2>/dev/null || true'
  ];
  const r = await runCommand(host, cmd, { timeout: 35 });
  const raw = String(r.output || '');
  const [unitsRaw, filesRaw] = raw.split('---SPLIT---');

  const fileStateMap = new Map();
  if (filesRaw) {
    const fileLines = filesRaw.trim().split('\n');
    for (const line of fileLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        fileStateMap.set(parts[0], parts[1].toLowerCase());
      }
    }
  }

  const units = [];
  if (unitsRaw) {
    const unitLines = unitsRaw.trim().split('\n');
    for (const line of unitLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('●') || trimmed.startsWith('*')) {
        // 部分 systemctl 版本输出可能会带有前导特殊符号 ●
      }
      // 移除前导状态符号
      const clean = trimmed.replace(/^[●*]\s+/, '').trim();
      if (!clean) continue;

      // 匹配格式: UNIT LOAD ACTIVE SUB DESCRIPTION...
      // 例如: docker.service loaded active running Docker Application Container Engine
      const match = clean.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) continue;

      const unit = match[1];
      // 过滤掉最后的总结行 (如 "LOAD = Reflects whether the unit definition...")
      if (unit.startsWith('LOAD') || unit.startsWith('To') || unit.includes('loaded units listed')) {
        continue;
      }

      const load = match[2];
      const active = match[3];
      const sub = match[4];
      const description = (match[5] || '').trim();

      const lastDot = unit.lastIndexOf('.');
      const unitType = lastDot >= 0 ? unit.slice(lastDot + 1).toLowerCase() : 'service';
      const unitFileState = fileStateMap.get(unit) || (load === 'not-found' ? 'not-found' : 'unknown');

      units.push({
        unit,
        load,
        active,
        sub,
        description,
        unitType,
        unitFileState,
      });
    }
  }

  return units;
}

/**
 * 获取单个 Unit 的详细系统属性 (通过 systemctl show)
 * @param {string} host
 * @param {string} unit
 */
export async function getUnitDetail(host, unit) {
  if (!unit) throw new Error('Unit name is required');
  const r = await runCommand(host, ['systemctl', 'show', unit, '--no-pager'], { timeout: 15 });
  if (!r.ok) {
    throw new Error(String(r.output || r.error || 'Failed to get unit detail'));
  }
  const lines = String(r.output || '').split('\n');
  const props = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      props[k] = v;
    }
  }
  return props;
}

/**
 * 获取 Unit 的配置文件原始内容 (systemctl cat)
 * @param {string} host
 * @param {string} unit
 */
export async function getUnitCat(host, unit) {
  if (!unit) throw new Error('Unit name is required');
  const r = await runCommand(host, ['systemctl', 'cat', unit, '--no-pager'], { timeout: 15 });
  return String(r.output || r.error || '');
}

/**
 * 获取 Unit 的依赖树 (systemctl list-dependencies)
 * @param {string} host
 * @param {string} unit
 */
export async function getUnitDependencies(host, unit) {
  if (!unit) throw new Error('Unit name is required');
  const r = await runCommand(host, ['systemctl', 'list-dependencies', unit, '--all', '--no-pager'], { timeout: 15 });
  return String(r.output || '');
}

/**
 * 对 Unit 执行生命周期控制动作
 * @param {string} host
 * @param {string} unit
 * @param {'start'|'stop'|'restart'|'reload'|'try-restart'|'enable'|'disable'|'mask'|'unmask'|'reset-failed'} action
 */
export async function unitAction(host, unit, action) {
  if (!unit) throw new Error('Unit name is required');
  const allowed = ['start', 'stop', 'restart', 'reload', 'try-restart', 'enable', 'disable', 'mask', 'unmask', 'reset-failed'];
  if (!allowed.includes(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  const r = await runCommand(host, ['systemctl', action, unit], { timeout: T_ACTION });
  if (!r.ok) {
    const msg = String(r.output || r.error || t('app.systemd.action-failed', { v1: action })).trim();
    throw new Error(msg);
  }
  return { ok: true, output: String(r.output || '') };
}

/**
 * 重新加载 Systemd 配置管理器 (systemctl daemon-reload)
 * @param {string} host
 */
export async function daemonReload(host) {
  const r = await runCommand(host, ['systemctl', 'daemon-reload'], { timeout: 30 });
  if (!r.ok) {
    throw new Error(String(r.output || r.error || 'daemon-reload failed'));
  }
  return { ok: true };
}

/**
 * 重置系统内所有失败状态 (systemctl reset-failed)
 * @param {string} host
 */
export async function resetAllFailed(host) {
  const r = await runCommand(host, ['systemctl', 'reset-failed'], { timeout: 20 });
  if (!r.ok) {
    throw new Error(String(r.output || r.error || 'reset-failed failed'));
  }
  return { ok: true };
}

/**
 * 查询 Systemd Timers 定时器列表
 * @param {string} host
 */
export async function listTimers(host) {
  const r = await runCommand(host, ['systemctl', 'list-timers', '--all', '--no-legend', '--no-pager'], { timeout: 20 });
  const timers = [];
  for (const line of String(r.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /timers? listed/i.test(trimmed)) continue;
    // 列间用 2+ 空格或制表符对齐，日期内部只用单空格，所以按分隔符切列最稳：
    // NEXT | LEFT | LAST | PASSED | UNIT | ACTIVATES
    const cols = trimmed.split(/\t+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length >= 6) {
      timers.push({
        unit: cols[cols.length - 2],
        activates: cols[cols.length - 1],
        next: cols[0],
        left: cols[1],
        last: cols[2],
        passed: cols[3],
        raw: trimmed,
      });
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    timers.push({
      unit: parts[parts.length - 2],
      activates: parts[parts.length - 1],
      next: '', left: '', last: '', passed: '',
      raw: trimmed,
    });
  }
  return timers;
}

/**
 * 查询 Systemd Sockets 套接字列表
 * @param {string} host
 */
export async function listSockets(host) {
  const r = await runCommand(host, ['systemctl', 'list-sockets', '--all', '--no-legend', '--no-pager'], { timeout: 20 });
  const sockets = [];
  for (const line of String(r.output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /sockets? listed/i.test(trimmed)) continue;
    // LISTEN | UNIT | ACTIVATES
    const cols = trimmed.split(/\t+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length >= 3) {
      sockets.push({
        listen: cols[0],
        unit: cols[cols.length - 2],
        activates: cols[cols.length - 1],
        raw: trimmed,
      });
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    sockets.push({
      listen: parts.slice(0, parts.length - 2).join(' '),
      unit: parts[parts.length - 2],
      activates: parts[parts.length - 1],
      raw: trimmed,
    });
  }
  return sockets;
}

/**
 * 查询 Journalctl 日志内容
 * @param {string} host
 * @param {object} opts { units, unit, lines, priority, since, boot }
 */
export async function fetchJournal(host, {
  unit = '', units = [], lines = 100, priority = '', since = '', boot = '',
} = {}) {
  const argv = ['journalctl', '--no-pager', '-o', 'short-iso'];
  const list = (Array.isArray(units) && units.length)
    ? units
    : String(unit || '').split(/[\s,]+/).filter(Boolean);
  for (const u of list) {
    argv.push('-u', u);
  }
  if (boot === 'previous') {
    argv.push('-b', '-1');
  } else if (boot === 'current') {
    argv.push('-b');
  }
  if (lines && Number(lines) > 0) {
    argv.push('-n', String(Math.min(2000, Number(lines))));
  } else {
    argv.push('-n', '100');
  }
  if (priority && priority !== 'all') {
    argv.push('-p', priority);
  }
  if (since && since !== 'all') {
    argv.push('--since', since === 'today' ? 'today' : `-${since}`);
  }
  const r = await runCommand(host, argv, { timeout: 30 });
  return String(r.output || '');
}

/* ------------------------------------------------------------------ *
 * 运维扩展：启动分析 / 单元文件 / 校验 / 诊断包
 * ------------------------------------------------------------------ */

/** 把任意时长文本（如 "1min 2.345s" / "9.183s" / "820ms"）折成秒 */
export function durationToSec(text) {
  const s = String(text || '').trim();
  if (!s || s === '0') return 0;
  let total = 0;
  const min = s.match(/([\d.]+)\s*min/);
  const sec = s.match(/([\d.]+)\s*s(?![\w])/);
  const ms = s.match(/([\d.]+)\s*ms/);
  if (min) total += parseFloat(min[1]) * 60;
  if (sec) total += parseFloat(sec[1]);
  if (ms) total += parseFloat(ms[1]) / 1000;
  return Number.isFinite(total) ? total : 0;
}

/** 单引号转义，供 sh -c 拼接 */
function shq(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 启动耗时分解 (systemd-analyze time)
 * @returns {Promise<{ ok: boolean, raw: string, totalText: string, totalSec: number, parts: Array<{name: string, text: string, sec: number}> }>}
 */
export async function analyzeTime(host) {
  const r = await runCommand(host, ['systemd-analyze', 'time'], { timeout: 25 });
  const raw = String(r.output || '').trim();
  const first = raw.split('\n')[0] || '';
  const empty = { ok: false, raw, totalText: '', totalSec: 0, parts: [] };
  if (!/Startup finished/i.test(first)) return empty;

  // Startup finished in 9.183s (firmware) + 2.221s (loader) + 1.144s (kernel) + 12.922s (userspace) = 25.472s
  const body = first.replace(/^.*Startup finished in\s*/i, '');
  const eqIdx = body.lastIndexOf('=');
  const left = eqIdx >= 0 ? body.slice(0, eqIdx) : body;
  const totalText = eqIdx >= 0 ? body.slice(eqIdx + 1).trim() : '';

  const parts = [];
  for (const seg of left.split('+')) {
    const m = seg.match(/^\s*(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) continue;
    const text = m[1].trim();
    parts.push({ name: m[2].trim(), text, sec: durationToSec(text) });
  }
  return { ok: true, raw: first, totalText, totalSec: durationToSec(totalText), parts };
}

/**
 * 启动耗时排行 (systemd-analyze blame)
 * @returns {Promise<Array<{ unit: string, timeText: string, sec: number }>>}
 */
export async function analyzeBlame(host, limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const r = await runCommand(host, ['systemd-analyze', 'blame', '--no-pager'], { timeout: 30 });
  const rows = [];
  for (const line of String(r.output || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(' ');
    if (idx <= 0) continue;
    const timeText = t.slice(0, idx).trim();
    const unit = t.slice(idx + 1).trim();
    if (!unit || /\s/.test(unit)) continue;
    rows.push({ unit, timeText, sec: durationToSec(timeText) });
  }
  rows.sort((a, b) => b.sec - a.sec);
  return rows.slice(0, n);
}

/**
 * 关键启动链 (systemd-analyze critical-chain)
 * @returns {Promise<string>}
 */
export async function analyzeCriticalChain(host) {
  const r = await runCommand(host, ['systemd-analyze', 'critical-chain', '--no-pager'], { timeout: 30 });
  return String(r.output || '').trim();
}

/**
 * 校验单元文件语法与依赖 (systemd-analyze verify)
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function verifyUnit(host, unit) {
  if (!unit) throw new Error('Unit name is required');
  const r = await runCommand(host, ['sh', '-c', `systemd-analyze verify ${shq(unit)} 2>&1 || true`], { timeout: 30 });
  const output = String(r.output || '').trim();
  return { ok: output === '', output: output || 'OK' };
}

/**
 * 全量单元文件清单 (systemctl list-unit-files)
 * @returns {Promise<Array<{ unit: string, state: string, preset: string, unitType: string }>>}
 */
export async function listUnitFiles(host) {
  const base = ['systemctl', 'list-unit-files', '--full', '--no-legend', '--no-pager'];
  let r = await runCommand(host, [...base, '--plain'], { timeout: 30 });
  // 老版本 systemd 不认 --plain，回退到不带该参数的调用
  if (!String(r.output || '').trim() || /invalid option|unknown option/i.test(String(r.output || '') + String(r.error || ''))) {
    r = await runCommand(host, base, { timeout: 30 });
  }
  const rows = [];
  for (const line of String(r.output || '').split('\n')) {
    const t = line.trim();
    if (!t || /unit files? listed/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    const unit = parts[0];
    if (!/\./.test(unit)) continue;
    const state = (parts[1] || 'unknown').toLowerCase();
    const preset = (parts[2] || '').toLowerCase();
    const dot = unit.lastIndexOf('.');
    rows.push({
      unit,
      state,
      preset,
      unitType: dot >= 0 ? unit.slice(dot + 1).toLowerCase() : 'service',
    });
  }
  return rows;
}

/**
 * 生成单单元诊断包：status + cat + verify + 最近日志，拼成一份可复制/下载的文本
 * @returns {Promise<string>}
 */
export async function diagnoseUnit(host, unit) {
  if (!unit) throw new Error('Unit name is required');
  const [st, cat, vf, jr] = await Promise.all([
    runCommand(host, ['systemctl', 'status', unit, '--no-pager', '-l'], { timeout: 20 }),
    runCommand(host, ['systemctl', 'cat', unit, '--no-pager'], { timeout: 20 }),
    runCommand(host, ['sh', '-c', `systemd-analyze verify ${shq(unit)} 2>&1 || true`], { timeout: 30 }),
    runCommand(host, ['journalctl', '-u', unit, '-n', '200', '--no-pager', '-o', 'short-iso'], { timeout: 30 }),
  ]);
  return [
    `# systemd diagnose: ${unit}`,
    `# host: ${host}`,
    `# generated: ${new Date().toISOString()}`,
    '',
    '## systemctl status',
    String(st.output || '').trim() || '(empty)',
    '',
    '## systemctl cat',
    String(cat.output || '').trim() || '(empty)',
    '',
    '## systemd-analyze verify',
    String(vf.output || '').trim() || '(no output = passed)',
    '',
    '## journalctl -u ' + unit + ' -n 200',
    String(jr.output || '').trim() || '(empty)',
  ].join('\n');
}
