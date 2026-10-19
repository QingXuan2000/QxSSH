/**
 * core/appkit.js —— 远程命令与主机能力工具箱
 * 要点：面向应用开发者的高层封装：在主机上执行命令（sudo 自动提权）、解析输出、流式跟踪、HTTP/TCP 转发与后台任务管理。
 */
import {
  execRun, execStream, netHttpRequest, tcpBridgeWSUrl, jobStart, jobStatus, jobOutput, jobKill, jobRemove, jobList,
  sftpUpload, sftpSetAttrs, sftpStat, auditLogs,
} from './qxssh-api.js';
import { requestSudoElevation, isSudoPermError, sysGet } from './sys.js';
import { t, tf } from './i18n.js';

const DEFAULT_TIMEOUT = 60;

/** 命令执行失败时抛出的错误，携带退出码、输出与截断标记 */
export class ShellError extends Error {
  constructor(message, r = {}) {
    super(message);
    this.name = 'ShellError';
    this.exit = r.exit;
    this.output = r.output || '';
    this.truncated = r.truncated === true;
    this.status = r.permission ? 403 : 400;
  }
}

function looksLikePermFailure(r) {
  const text = `${r.output || ''}\n${r.error || ''}`.toLowerCase();
  return isSudoPermError(text)
    || text.includes('a password is required')
    || text.includes('incorrect password')
    || text.includes('no password was provided')
    || text.includes('not in the sudoers')
    || text.includes('must be root');
}

function failureOf(r) {
  const out = String(r.output || '').trim();
  const msg = out || String(r.error || '').trim() || tf('app.core.sh-failed', { v1: r.exit ?? '?' });
  return new ShellError(msg.length > 4000 ? `${msg.slice(0, 4000)}…` : msg, { ...r, permission: looksLikePermFailure(r) });
}

function argvOf(argv) {
  if (typeof argv === 'string') return ['sh', '-c', argv];
  return (Array.isArray(argv) ? argv : [argv]).map(String);
}

/** 在主机上执行命令，sudo 可选 auto/always/never 决定是否提权 */
export async function sh(host, argv, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, cwd = '', stdin = '', sudo = 'auto' } = opts;
  const base = { host: host || '', argv: argvOf(argv), timeout, cwd, stdin };
  if (sudo === 'always') {
    const r = await execRun({ ...base, elevated: true });
    return { ...r, elevated: true };
  }
  const r = await execRun({ ...base, elevated: false });
  if (r.ok || sudo === 'never' || !looksLikePermFailure(r)) return { ...r, elevated: false };
  const grant = await requestSudoElevation(host || '', { reason: t('app.core.sh-sudo-reason') });
  if (!grant.ok) return { ...r, elevated: false };
  const r2 = await execRun({ ...base, elevated: true });
  return { ...r2, elevated: true };
}

/** 执行命令并返回标准输出，失败时抛 ShellError */
export async function run(host, argv, opts = {}) {
  const r = await sh(host, argv, opts);
  if (!r.ok) throw failureOf(r);
  return String(r.output || '');
}

/** 执行命令并把输出解析为 JSON，失败时抛 ShellError */
export async function runJSON(host, argv, opts = {}) {
  const r = await sh(host, argv, opts);
  if (!r.ok) throw failureOf(r);
  if (r.truncated) throw new ShellError(t('app.core.sh-truncated'), r);
  const text = String(r.output || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new ShellError(tf('app.core.sh-not-json', { v1: text.slice(0, 200) }), r);
  }
}

/** 执行命令并按行返回非空结果 */
export async function runLines(host, argv, opts = {}) {
  return splitLines(await run(host, argv, opts));
}

/** 执行命令并把输出解析为对象数组（表格形式） */
export async function runTable(host, argv, opts = {}) {
  const { sep, header, ...rest } = opts;
  return parseTable(await run(host, argv, rest), { sep, header });
}

function splitLines(text) {
  return String(text || '').split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean);
}

/** 把表格文本解析为对象数组，可按制表符或多空格分列 */
export function parseTable(text, { sep, header = true } = {}) {
  const lines = String(text || '').split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.trim());
  if (!lines.length) return [];
  const splitter = sep || (lines.some((l) => l.includes('\t')) ? '\t' : /\s{2,}/);
  const cells = lines.map((l) => l.trim().split(splitter).map((c) => c.trim()));
  if (!header) return cells;
  const keys = cells[0];
  return cells.slice(1).map((row) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = row[i] === undefined ? '' : row[i]; });
    return o;
  });
}

/** 流式执行命令：逐行/逐块回调，并保留最近若干行 */
export async function stream(host, argv, opts = {}) {
  const {
    onLine, onChunk, signal, timeout, cwd = '', stdin = '', elevated = false, maxLines = 5000,
  } = opts;
  const kept = [];
  let partial = '';
  const pushLine = (line) => {
    kept.push(line);
    if (kept.length > maxLines) kept.splice(0, kept.length - maxLines);
    if (onLine) onLine(line);
  };
  await execStream({ host: host || '', argv: argvOf(argv), timeout, cwd, stdin, elevated }, {
    signal,
    onChunk: (chunk) => {
      if (onChunk) onChunk(chunk);
      partial += chunk;
      let idx;
      while ((idx = partial.indexOf('\n')) >= 0) {
        pushLine(partial.slice(0, idx).replace(/\r$/, ''));
        partial = partial.slice(idx + 1);
      }
    },
  });
  if (partial) pushLine(partial);
  return { lines: kept };
}

/** 批量查询命令在主机上的可执行路径 */
export async function which(host, names) {
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  if (!list.length) return {};
  const script = 'for n in "$@"; do p=$(command -v -- "$n" 2>/dev/null); printf "%s\\n" "${p:-}"; done';
  const r = await sh(host, ['sh', '-c', script, 'sh', ...list], { sudo: 'never', timeout: 20 });
  const out = {};
  const lines = String(r.output || '').split('\n');
  list.forEach((n, i) => { out[n] = r.ok && lines[i] && lines[i].trim() ? lines[i].trim() : null; });
  return out;
}

/** 借主机发起 HTTP(S) 请求，返回响应文本与字节读取方法 */
export async function fetchVia(host, url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeout, insecure = false } = opts;
  const hdr = { ...headers };
  let payload = '';
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') payload = body;
    else {
      payload = JSON.stringify(body);
      if (!Object.keys(hdr).some((k) => k.toLowerCase() === 'content-type')) hdr['Content-Type'] = 'application/json';
    }
  }
  const r = await netHttpRequest({
    host: host || '', url: String(url), method, headers: hdr, body: payload, timeout, insecure: insecure === true,
  });
  const base64 = r.encoding === 'base64';
  const text = base64 ? '' : String(r.body || '');
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: r.headers || {},
    text,
    truncated: r.truncated === true,
    encoding: r.encoding || 'text',
    json() { return JSON.parse(base64 ? new TextDecoder().decode(this.bytes()) : text); },
    bytes() {
      if (!base64) return new TextEncoder().encode(text);
      const bin = atob(String(r.body || ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  };
}

/** 通过主机建立 TCP 连接，返回可发送与订阅数据的句柄 */
export function tcpConnect(host, addr, port) {
  const ws = new WebSocket(tcpBridgeWSUrl(host || '', String(addr), Number(port)));
  ws.binaryType = 'arraybuffer';
  const dataFns = new Set();
  const closeFns = new Set();
  const enc = new TextEncoder();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(t('app.core.tcp-open-failed'))), { once: true });
  });
  ready.catch(() => { });
  ws.addEventListener('message', (e) => {
    const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : enc.encode(String(e.data));
    for (const fn of [...dataFns]) {
      try { fn(bytes); } catch (err) { console.error('[appkit] tcp onData', err); }
    }
  });
  ws.addEventListener('close', (e) => {
    for (const fn of [...closeFns]) {
      try { fn({ code: e.code, reason: e.reason || '' }); } catch (err) { console.error('[appkit] tcp onClose', err); }
    }
  });
  return {
    ready,
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(typeof data === 'string' ? enc.encode(data) : data);
      return true;
    },
    onData(fn) { dataFns.add(fn); return () => dataFns.delete(fn); },
    onClose(fn) { closeFns.add(fn); return () => closeFns.delete(fn); },
    close() { try { ws.close(); } catch { } },
    get open() { return ws.readyState === WebSocket.OPEN; },
  };
}

const RUN_MANY_CONCURRENCY = 16;

/** 在多个主机上并发执行同一命令并汇总每台的结果 */
export async function runMany(hosts, command, { timeout = DEFAULT_TIMEOUT, concurrency = RUN_MANY_CONCURRENCY } = {}) {
  const list = (Array.isArray(hosts) ? hosts : [hosts]).map((h) => (typeof h === 'string' ? { id: h, name: h } : { id: String(h.id), name: String(h.name || h.id) }));
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const h = list[i];
      const t0 = Date.now();
      let r;
      try {
        r = await execRun({ host: h.id, argv: argvOf(command), timeout: Math.min(Math.max(1, timeout), 300) });
      } catch (e) {
        r = { ok: false, output: '', error: (e && e.message) || String(e) };
      }
      out[i] = {
        hostId: h.id,
        hostName: h.name,
        output: String((r && r.output) || ''),
        error: r && r.ok ? '' : String((r && r.error) || '').trim() || (r && r.exit != null ? tf('app.core.sh-failed', { v1: r.exit }) : ''),
        success: !!(r && r.ok),
        durationMs: Date.now() - t0,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) || 0 }, worker));
  return out;
}

const JOB_POLL_MS = 1500;

/** 持续拉取后台任务输出直到任务结束 */
export async function followJob(host, id, { onLine, onChunk, signal, interval = JOB_POLL_MS, offset = 0 } = {}) {
  let pos = offset;
  let partial = '';
  const feed = (text) => {
    if (!text) return;
    if (onChunk) onChunk(text);
    if (!onLine) return;
    partial += text;
    let i;
    while ((i = partial.indexOf('\n')) >= 0) {
      onLine(partial.slice(0, i).replace(/\r$/, ''));
      partial = partial.slice(i + 1);
    }
  };
  for (;;) {
    if (signal && signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const r = await jobOutput(host, id, pos);
    feed(r.data);
    pos = r.next;
    if (r.done) break;
    if (!r.data) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (partial && onLine) onLine(partial);
  return jobStatus(host, id);
}

/** 在主机上启动后台任务，返回任务句柄 */
export async function startJob(host, argv, { cwd = '', name = '' } = {}) {
  const st = await jobStart({ host, argv: argvOf(argv), cwd, name });
  return jobHandle(host, st.id, st);
}

/** 由任务 id 构造句柄，封装状态查询、输出读取、跟踪与结束 */
export function jobHandle(host, id, initial = null) {
  return {
    id,
    host,
    pid: initial ? initial.pid : 0,
    initial,
    status: () => jobStatus(host, id),
    output: (offset = 0, limit) => jobOutput(host, id, offset, limit),
    follow: (opts) => followJob(host, id, opts),
    kill: (signal = 'TERM') => jobKill(host, id, signal),
    remove: () => jobRemove(host, id),
  };
}

/** 列出主机上的后台任务并附带各自句柄 */
export async function jobs(host) {
  const r = await jobList(host);
  return (r.jobs || []).map((st) => ({ ...st, handle: jobHandle(host, st.id, st) }));
}

/** 确保已获得提权，必要时弹出密码输入 */
export function ensureSudo(host, opts = {}) {
  return requestSudoElevation(host || '', opts);
}

/**
 * 批量在多台主机上并发执行命令
 * @param {string[]|object} arg1 主机列表或参数对象
 * @param {string|string[]} [arg2] 待执行命令
 * @param {object} [arg3] 配置项：concurrency, timeout, elevated, cwd, stdin, onProgress, signal
 */
export async function batchExec(arg1, arg2, arg3 = {}) {
  let hosts;
  let cmd;
  let opts;
  if (Array.isArray(arg1) || typeof arg1 === 'string') {
    hosts = Array.isArray(arg1) ? arg1 : [arg1];
    cmd = arg2;
    opts = arg3 || {};
  } else {
    hosts = (arg1 && arg1.hosts) || [];
    cmd = (arg1 && (arg1.cmd || arg1.command || arg1.argv)) || '';
    opts = arg1 || {};
  }
  const hostList = (Array.isArray(hosts) ? hosts : [hosts]).map((h) => (typeof h === 'string' ? h : String(h.id || h.host || ''))).filter(Boolean);
  const total = hostList.length;
  if (!total) {
    return { ok: true, total: 0, successCount: 0, failedCount: 0, succeeded: 0, failed: 0, results: [] };
  }
  const {
    timeout = DEFAULT_TIMEOUT,
    concurrency = 10,
    elevated = false,
    cwd = '',
    stdin = '',
    onProgress,
    signal,
  } = opts;

  const results = new Array(total);
  let next = 0;
  let successCount = 0;
  let failedCount = 0;

  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) break;
      const i = next++;
      if (i >= total) return;
      const hostId = hostList[i];
      const t0 = Date.now();
      try {
        const r = await execRun({ host: hostId, argv: argvOf(cmd), timeout, elevated: !!elevated, cwd, stdin });
        const dur = Date.now() - t0;
        const ok = !!(r && r.ok);
        const item = {
          host: hostId,
          hostId,
          ok,
          success: ok,
          output: String((r && r.output) || ''),
          error: ok ? '' : String((r && r.error) || '').trim() || (r && r.exit != null ? tf('app.core.sh-failed', { v1: r.exit }) : ''),
          exit: r ? r.exit : -1,
          durationMs: dur,
        };
        results[i] = item;
        if (ok) successCount++; else failedCount++;
        if (onProgress) {
          try { onProgress({ index: i, host: hostId, item, successCount, failedCount, total, done: successCount + failedCount }); } catch {}
        }
      } catch (e) {
        const dur = Date.now() - t0;
        const item = {
          host: hostId,
          hostId,
          ok: false,
          success: false,
          output: '',
          error: (e && e.message) || String(e),
          exit: -1,
          durationMs: dur,
        };
        results[i] = item;
        failedCount++;
        if (onProgress) {
          try { onProgress({ index: i, host: hostId, item, successCount, failedCount, total, done: successCount + failedCount }); } catch {}
        }
      }
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: poolSize }, worker));

  return {
    ok: failedCount === 0,
    total,
    successCount,
    failedCount,
    succeeded: successCount,
    failed: failedCount,
    results,
  };
}

/**
 * 批量并发上传文件或内容至多台受管主机
 * @param {string[]|object} arg1 主机列表或参数对象
 * @param {string} [arg2] 目标路径
 * @param {string|Blob|File|Uint8Array} [arg3] 文件或文本内容
 * @param {object} [arg4] 配置项：concurrency, mode, elevated, isBase64, onProgress, signal
 */
export async function batchUpload(arg1, arg2, arg3, arg4 = {}) {
  let hosts;
  let destPath;
  let content;
  let opts;
  if (Array.isArray(arg1) || typeof arg1 === 'string') {
    hosts = Array.isArray(arg1) ? arg1 : [arg1];
    destPath = arg2;
    content = arg3;
    opts = arg4 || {};
  } else {
    hosts = (arg1 && arg1.hosts) || [];
    destPath = (arg1 && arg1.path) || '';
    content = (arg1 && (arg1.file != null ? arg1.file : arg1.content)) || '';
    opts = arg1 || {};
  }
  const hostList = (Array.isArray(hosts) ? hosts : [hosts]).map((h) => (typeof h === 'string' ? h : String(h.id || h.host || ''))).filter(Boolean);
  const total = hostList.length;
  if (!total) {
    return { ok: true, total: 0, successCount: 0, failedCount: 0, succeeded: 0, failed: 0, path: destPath, results: [] };
  }
  const {
    concurrency = 10,
    elevated = false,
    mode,
    isBase64 = false,
    onProgress,
    signal,
  } = opts;

  let blob;
  let filename = 'file';
  if (destPath) {
    const parts = destPath.split(/[/\\]/);
    if (parts.length && parts[parts.length - 1]) filename = parts[parts.length - 1];
  }
  if (content instanceof Blob || (typeof File !== 'undefined' && content instanceof File)) {
    blob = content;
  } else if (content instanceof Uint8Array) {
    blob = new Blob([content], { type: 'application/octet-stream' });
  } else if (isBase64 && typeof content === 'string') {
    const binStr = atob(content);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    blob = new Blob([bytes], { type: 'application/octet-stream' });
  } else {
    blob = new Blob([String(content ?? '')], { type: 'text/plain; charset=utf-8' });
  }

  const results = new Array(total);
  let next = 0;
  let successCount = 0;
  let failedCount = 0;

  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) break;
      const i = next++;
      if (i >= total) return;
      const hostId = hostList[i];
      const t0 = Date.now();
      try {
        const fileObj = typeof File !== 'undefined' && !(blob instanceof File)
          ? new File([blob], filename, { type: blob.type })
          : blob;
        const r = await sftpUpload(hostId, destPath, fileObj, elevated);
        if (mode != null && r && r.ok) {
          try { await sftpSetAttrs({ host: hostId, path: destPath, mode, elevated }); } catch {}
        }
        const dur = Date.now() - t0;
        const ok = !!(r && r.ok);
        const item = {
          host: hostId,
          hostId,
          ok,
          success: ok,
          path: (r && r.path) || destPath,
          error: ok ? '' : String((r && r.error) || '上传失败'),
          durationMs: dur,
        };
        results[i] = item;
        if (ok) successCount++; else failedCount++;
        if (onProgress) {
          try { onProgress({ index: i, host: hostId, item, successCount, failedCount, total, done: successCount + failedCount }); } catch {}
        }
      } catch (e) {
        const dur = Date.now() - t0;
        const item = {
          host: hostId,
          hostId,
          ok: false,
          success: false,
          path: destPath,
          error: (e && e.message) || String(e),
          durationMs: dur,
        };
        results[i] = item;
        failedCount++;
        if (onProgress) {
          try { onProgress({ index: i, host: hostId, item, successCount, failedCount, total, done: successCount + failedCount }); } catch {}
        }
      }
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: poolSize }, worker));

  return {
    ok: failedCount === 0,
    total,
    successCount,
    failedCount,
    succeeded: successCount,
    failed: failedCount,
    path: destPath,
    bytes: blob.size,
    results,
  };
}

/**
 * 查询审计日志统计概览（客户端聚合计算）
 * @param {object} opts { host, app, limit }
 */
export async function auditStats({ host = '_', app = '', limit = 1000 } = {}) {
  const r = await auditLogs({ host: host || '_', app, limit });
  const logs = (r && r.logs) || [];
  const total = logs.length;
  let successCount = 0;
  let errorCount = 0;
  let deniedCount = 0;
  let durSum = 0;
  let durCount = 0;
  const byType = {};
  const byApp = {};
  const byResult = {};
  const targetCounts = {};

  for (const entry of logs) {
    const t = entry.type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
    const a = entry.appId || 'host';
    byApp[a] = (byApp[a] || 0) + 1;
    const res = entry.result || 'unknown';
    byResult[res] = (byResult[res] || 0) + 1;

    if (res === 'ok' || res === '200' || String(res).startsWith('2')) {
      successCount++;
    } else if (res === 'denied') {
      deniedCount++;
    } else {
      errorCount++;
    }

    if (typeof entry.durationMs === 'number' && entry.durationMs > 0) {
      durSum += entry.durationMs;
      durCount++;
    }
    if (entry.target) {
      targetCounts[entry.target] = (targetCounts[entry.target] || 0) + 1;
    }
  }

  const topTargets = Object.entries(targetCounts)
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const avgDurationMs = durCount > 0 ? durSum / durCount : 0;

  return {
    ok: true,
    stats: {
      total,
      successCount,
      errorCount,
      deniedCount,
      avgDurationMs,
      byType,
      byApp,
      byResult,
      topTargets,
    },
  };
}

/**
 * 导出审计日志为 JSON 或 CSV（客户端格式化与下载）
 * @param {object} opts { host, app, type, format, limit, download, filename }
 */
export async function exportAuditLogs({
  host = '_',
  app = '',
  type = '',
  format = 'json',
  limit = 1000,
  download = false,
  filename = '',
} = {}) {
  const r = await auditLogs({ host: host || '_', app, type, limit });
  const logs = (r && r.logs) || [];
  const fmt = String(format).toLowerCase().trim();

  let data = '';
  let mimeType = 'application/json; charset=utf-8';
  let defaultExt = 'json';

  if (fmt === 'csv') {
    mimeType = 'text/csv; charset=utf-8';
    defaultExt = 'csv';
    const escapeCsv = (val) => {
      const s = String(val == null ? '' : val);
      if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const headers = ['seq', 'time', 'appId', 'hostId', 'type', 'target', 'detail', 'result', 'durationMs', 'user', 'deny'];
    const rows = [headers.join(',')];
    for (const e of logs) {
      rows.push([
        escapeCsv(e.seq),
        escapeCsv(e.time),
        escapeCsv(e.appId),
        escapeCsv(e.hostId),
        escapeCsv(e.type),
        escapeCsv(e.target),
        escapeCsv(e.detail),
        escapeCsv(e.result),
        escapeCsv(e.durationMs || 0),
        escapeCsv(e.user),
        escapeCsv(e.deny),
      ].join(','));
    }
    data = rows.join('\r\n');
  } else {
    data = JSON.stringify({
      ok: true,
      format: 'json',
      exportedAt: new Date().toISOString(),
      count: logs.length,
      logs,
    }, null, 2);
  }

  let downloaded = false;
  if (download && typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const blob = new Blob([data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `audit-export-${Date.now()}.${defaultExt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      downloaded = true;
    } catch {}
  }

  return {
    ok: true,
    format: fmt === 'csv' ? 'csv' : 'json',
    count: logs.length,
    data,
    downloaded,
  };
}

/**
 * 查询远端主机指定挂载点或路径的磁盘使用量
 * @param {string} host 主机 ID
 * @param {string} [path='/'] 路径或挂载点
 * @returns {Promise<{ filesystem: string, sizeBytes: number, usedBytes: number, availBytes: number, usePercent: number, mount: string }|null>}
 */
export async function diskUsage(host, path = '/') {
  const r = await sh(host, ['df', '-kP', path || '/'], { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  if (lines.length < 2) return null;
  const parts = lines[1].trim().split(/\s+/);
  if (parts.length < 6) return null;
  const sizeKb = parseInt(parts[1], 10) || 0;
  const usedKb = parseInt(parts[2], 10) || 0;
  const availKb = parseInt(parts[3], 10) || 0;
  const pctStr = parts[4].replace('%', '');
  return {
    filesystem: parts[0],
    sizeBytes: sizeKb * 1024,
    usedBytes: usedKb * 1024,
    availBytes: availKb * 1024,
    usePercent: parseFloat(pctStr) || 0,
    mount: parts[5],
  };
}

/**
 * 查询远端主机内存与交换空间使用量
 * @param {string} host 主机 ID
 * @returns {Promise<{ totalBytes: number, freeBytes: number, availBytes: number, usedBytes: number, usePercent: number, swapTotal: number, swapUsed: number, swapUsePercent: number }|null>}
 */
export async function memoryUsage(host) {
  const r = await sh(host, 'cat /proc/meminfo 2>/dev/null || free -b 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const text = String(r.output || '');
  if (text.includes('MemTotal:')) {
    const map = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = parseInt(line.slice(idx + 1).trim(), 10) || 0;
        map[key] = val;
      }
    }
    const totalBytes = (map.MemTotal || 0) * 1024;
    const freeBytes = (map.MemFree || 0) * 1024;
    const availBytes = (map.MemAvailable !== undefined ? map.MemAvailable : (map.MemFree || 0) + (map.Buffers || 0) + (map.Cached || 0)) * 1024;
    const usedBytes = Math.max(0, totalBytes - availBytes);
    const swapTotal = (map.SwapTotal || 0) * 1024;
    const swapFree = (map.SwapFree || 0) * 1024;
    const swapUsed = Math.max(0, swapTotal - swapFree);
    return {
      totalBytes,
      freeBytes,
      availBytes,
      usedBytes,
      usePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      swapTotal,
      swapUsed,
      swapUsePercent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
    };
  }
  const lines = splitLines(text);
  if (lines.length >= 2 && lines[0].includes('total')) {
    const memParts = lines[1].trim().split(/\s+/);
    const total = parseInt(memParts[1], 10) || 0;
    const used = parseInt(memParts[2], 10) || 0;
    const free = parseInt(memParts[3], 10) || 0;
    const avail = memParts[6] ? parseInt(memParts[6], 10) : free;
    return {
      totalBytes: total,
      freeBytes: free,
      availBytes: avail,
      usedBytes: used,
      usePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      swapTotal: 0,
      swapUsed: 0,
      swapUsePercent: 0,
    };
  }
  return null;
}

/**
 * 查询远端主机 CPU 规格与核心数
 * @param {string} host 主机 ID
 * @returns {Promise<{ model: string, cores: number, mhz: number, vendor: string, arch?: string }>}
 */
export async function cpuInfo(host) {
  const r = await sh(host, 'cat /proc/cpuinfo 2>/dev/null || lscpu 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const text = String(r.output || '');
  if (text.includes('model name') || text.includes('Processor')) {
    let model = '';
    let cores = 0;
    let mhz = 0;
    let vendor = '';
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === 'processor') cores++;
        if (k === 'model name' && !model) model = v;
        if (k === 'cpu mhz' && !mhz) mhz = parseFloat(v) || 0;
        if (k === 'vendor_id' && !vendor) vendor = v;
      }
    }
    return {
      model: model || 'Unknown CPU',
      cores: Math.max(1, cores),
      mhz,
      vendor,
    };
  }
  const map = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    model: map['Model name'] || 'Unknown CPU',
    cores: parseInt(map['CPU(s)'] || '1', 10),
    mhz: parseFloat(map['CPU MHz'] || '0'),
    vendor: map['Vendor ID'] || '',
    arch: map['Architecture'] || '',
  };
}

/**
 * 查询远端主机发行版版本信息（解析 /etc/os-release）
 * @param {string} host 主机 ID
 * @returns {Promise<{ id: string, name: string, version: string, versionId: string, prettyName: string, codename: string, homeUrl: string, raw: Record<string, string> }>}
 */
export async function osRelease(host) {
  const r = await sh(host, 'cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const raw = {};
  for (const l of lines) {
    const idx = l.indexOf('=');
    if (idx > 0) {
      const k = l.slice(0, idx).trim();
      let v = l.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      raw[k] = v;
    }
  }
  return {
    id: raw.ID || '',
    name: raw.NAME || '',
    version: raw.VERSION || '',
    versionId: raw.VERSION_ID || '',
    prettyName: raw.PRETTY_NAME || raw.NAME || '',
    codename: raw.VERSION_CODENAME || '',
    homeUrl: raw.HOME_URL || '',
    raw,
  };
}

/**
 * 查询远端主机运行时长与系统平均负载
 * @param {string} host 主机 ID
 * @returns {Promise<{ uptimeSeconds: number, idleSeconds: number, loadAvg: [number, number, number] }>}
 */
export async function systemUptime(host) {
  const r = await sh(host, 'cat /proc/uptime 2>/dev/null; echo "---"; cat /proc/loadavg 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const parts = String(r.output || '').split('---');
  const uptimeLine = (parts[0] || '').trim();
  const loadLine = (parts[1] || '').trim();
  let uptimeSeconds = 0;
  let idleSeconds = 0;
  if (uptimeLine) {
    const uParts = uptimeLine.split(/\s+/);
    uptimeSeconds = parseFloat(uParts[0]) || 0;
    idleSeconds = parseFloat(uParts[1]) || 0;
  }
  let loadAvg = [0, 0, 0];
  if (loadLine) {
    const lParts = loadLine.split(/\s+/);
    if (lParts.length >= 3) {
      loadAvg = [parseFloat(lParts[0]) || 0, parseFloat(lParts[1]) || 0, parseFloat(lParts[2]) || 0];
    }
  }
  return {
    uptimeSeconds: Math.floor(uptimeSeconds),
    idleSeconds: Math.floor(idleSeconds),
    loadAvg,
  };
}

/**
 * 查询远端主机运行中的进程列表
 * @param {string} host 主机 ID
 * @param {object} [opts] { user, search, limit }
 * @returns {Promise<Array<{ pid: number, ppid: number, user: string, cpu: number, mem: number, stat: string, comm: string, args: string }>>}
 */
export async function psList(host, { user = '', search = '', limit = 100 } = {}) {
  const r = await sh(host, 'ps -eo pid,ppid,user,%cpu,%mem,stat,comm,args --no-headers 2>/dev/null || ps -eo pid,ppid,user,%cpu,%mem,stat,comm,args 2>/dev/null', { timeout: 20 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const list = [];
  const searchLower = String(search || '').toLowerCase();
  const userLower = String(user || '').toLowerCase();
  for (const line of lines) {
    if (line.includes('PID') && line.includes('PPID')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const u = parts[2];
    const cpu = parseFloat(parts[3]) || 0;
    const mem = parseFloat(parts[4]) || 0;
    const stat = parts[5];
    const comm = parts[6];
    const args = parts.slice(7).join(' ');

    if (userLower && u.toLowerCase() !== userLower) continue;
    if (searchLower && !comm.toLowerCase().includes(searchLower) && !args.toLowerCase().includes(searchLower)) continue;

    list.push({ pid, ppid, user: u, cpu, mem, stat, comm, args });
    if (limit && list.length >= limit) break;
  }
  return list;
}

/**
 * 终止远端主机上的指定进程（支持 PID 或进程名，自动支持提权）
 * @param {string} host 主机 ID
 * @param {number|string} pidOrName 进程 PID 或命令名
 * @param {object} [opts] { signal: 'TERM'|'KILL'|'INT'|string, sudo: 'auto'|'always'|'never' }
 */
export async function killProcess(host, pidOrName, { signal = 'TERM', sudo = 'auto' } = {}) {
  const sig = String(signal).toUpperCase().replace(/^SIG/, '');
  const target = String(pidOrName).trim();
  if (!target) throw new Error('PID or process name is required');
  const isPid = /^\d+$/.test(target);
  const cmd = isPid ? `kill -s ${sig} ${target}` : `pkill -${sig} -f ${target} || killall -s ${sig} ${target}`;
  const r = await sh(host, cmd, { sudo, timeout: 15 });
  if (!r.ok) throw failureOf(r);
  return { ok: true, target, signal: sig, isPid };
}

/**
 * 查询远端主机正在监听的网络端口及所属进程
 * @param {string} host 主机 ID
 * @param {object} [opts] { proto: 'all'|'tcp'|'udp' }
 * @returns {Promise<Array<{ proto: string, localIp: string, port: number, pid: number|null, process: string|null }>>}
 */
export async function listeningPorts(host, { proto = 'all' } = {}) {
  const r = await sh(host, 'ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null', { sudo: 'auto', timeout: 20 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const ports = [];
  const pFilter = String(proto || 'all').toLowerCase();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Netid') || trimmed.startsWith('Active Internet') || trimmed.startsWith('Proto')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    let pr = parts[0].toLowerCase();
    let localAddr = '';
    let pid = null;
    let procName = null;

    if (trimmed.startsWith('tcp') || trimmed.startsWith('udp')) {
      if (line.includes('LISTEN') || parts[1] === 'LISTEN') {
        localAddr = parts[4] || '';
        const extra = parts.slice(6).join(' ');
        const m = extra.match(/users:\(\("([^"]+)",pid=(\d+)/) || extra.match(/pid=(\d+)/);
        if (m) {
          if (m[2]) { procName = m[1]; pid = parseInt(m[2], 10); }
          else if (m[1]) { pid = parseInt(m[1], 10); }
        }
      } else {
        localAddr = parts[3] || '';
        const lastPart = parts[parts.length - 1] || '';
        const m = lastPart.match(/^(\d+)\/(.*)$/);
        if (m) { pid = parseInt(m[1], 10); procName = m[2]; }
      }
    }
    if (!localAddr) continue;
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon < 0) continue;
    const ip = localAddr.slice(0, lastColon).replace(/^\[|\]$/g, '');
    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (!port) continue;

    if (pFilter !== 'all' && !pr.includes(pFilter)) continue;

    ports.push({
      proto: pr.startsWith('tcp') ? 'tcp' : (pr.startsWith('udp') ? 'udp' : pr),
      localIp: ip || '*',
      port,
      pid,
      process: procName,
    });
  }
  return ports;
}

/**
 * 借远端主机 ping 目标网络地址，测试连通性与往返延迟
 * @param {string} host 主机 ID
 * @param {string} target 目标 IP 或域名
 * @param {object} [opts] { count: number, timeout: number }
 * @returns {Promise<{ ok: boolean, target: string, packetsSent: number, packetsReceived: number, packetLoss: number, minMs: number, avgMs: number, maxMs: number, output: string }>}
 */
export async function pingHost(host, target, { count = 3, timeout = 5 } = {}) {
  const tgt = String(target || '').trim();
  if (!tgt) throw new Error('Target host or IP is required');
  const cnt = Math.max(1, Math.min(count, 10));
  const tmo = Math.max(1, Math.min(timeout, 30));
  const r = await sh(host, ['ping', '-c', String(cnt), '-W', String(tmo), tgt], { timeout: tmo * cnt + 10 });
  const out = String(r.output || '');
  const ok = r.ok;

  let sent = cnt;
  let received = 0;
  let loss = 100;
  let minMs = 0;
  let avgMs = 0;
  let maxMs = 0;

  const pkgMatch = out.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received.*?(\d+(?:\.\d+)?)%\s+packet loss/i);
  if (pkgMatch) {
    sent = parseInt(pkgMatch[1], 10) || cnt;
    received = parseInt(pkgMatch[2], 10) || 0;
    loss = parseFloat(pkgMatch[3]) || 0;
  }
  const rttMatch = out.match(/(?:rtt|round-trip)\s+min\/avg\/max(?:\/mdev)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/i);
  if (rttMatch) {
    minMs = parseFloat(rttMatch[1]) || 0;
    avgMs = parseFloat(rttMatch[2]) || 0;
    maxMs = parseFloat(rttMatch[3]) || 0;
  }
  return {
    ok: ok && received > 0,
    target: tgt,
    packetsSent: sent,
    packetsReceived: received,
    packetLoss: loss,
    minMs,
    avgMs,
    maxMs,
    output: out,
  };
}

/**
 * 检查远端文件或目录是否存在（不抛异常，返回 boolean）
 * @param {string} host 主机 ID
 * @param {string} path 远端路径
 * @param {object} [opts] { elevated: boolean }
 */
export async function remoteFileExists(host, path, { elevated = false } = {}) {
  const p = String(path || '').trim();
  if (!p) return false;
  try {
    const st = await sftpStat(host, p, elevated);
    return !!(st && (st.size != null || st.mode != null || st.type != null));
  } catch {
    try {
      const r = await sh(host, ['test', '-e', p], { sudo: elevated ? 'always' : 'never', timeout: 10 });
      return r.ok && r.exit === 0;
    } catch {
      return false;
    }
  }
}

/**
 * 读取远端文本文件内容
 * @param {string} host 主机 ID
 * @param {string} path 远端路径
 * @param {object} [opts] { elevated: boolean, fallbackSh: boolean }
 * @returns {Promise<string>}
 */
export async function remoteReadText(host, path, { elevated = false, fallbackSh = true } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('Path is required');
  try {
    const res = await sysGet('files/download', { host, path: p, elevated });
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object') {
      if (res.content != null) return String(res.content);
      return JSON.stringify(res, null, 2);
    }
    return String(res ?? '');
  } catch (err) {
    if (!fallbackSh) throw err;
    return run(host, ['cat', p], { sudo: elevated ? 'always' : 'auto' });
  }
}

/**
 * 向远端路径写入文本内容（自动处理目录与文件名分解）
 * @param {string} host 主机 ID
 * @param {string} path 远端目标路径
 * @param {string} text 写入内容
 * @param {object} [opts] { mode: number, elevated: boolean }
 */
export async function remoteWriteText(host, path, text, { mode, elevated = false } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('Path is required');
  const lastSlash = p.lastIndexOf('/');
  const dir = lastSlash <= 0 ? '/' : p.slice(0, lastSlash);
  const name = lastSlash < 0 ? p : p.slice(lastSlash + 1);
  const content = String(text ?? '');
  const blob = new Blob([content], { type: 'text/plain; charset=utf-8' });
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: 'text/plain' }) : blob;
  const r = await sftpUpload(host, dir, file, elevated);
  if (mode != null) {
    try { await sftpSetAttrs({ host, path: p, mode, elevated }); } catch {}
  }
  return {
    ok: !!(r && r.ok),
    path: p,
    bytes: blob.size,
  };
}

/**
 * 读取远端 JSON 配置文件并自动解析
 * @param {string} host 主机 ID
 * @param {string} path 远端路径
 * @param {object} [opts]
 */
export async function remoteReadJSON(host, path, opts = {}) {
  const text = await remoteReadText(host, path, opts);
  return JSON.parse(text);
}

/**
 * 序列化对象并写入远端 JSON 配置文件
 * @param {string} host 主机 ID
 * @param {string} path 远端目标路径
 * @param {any} data 待写入对象
 * @param {object} [opts] { indent: number, mode: number, elevated: boolean }
 */
export async function remoteWriteJSON(host, path, data, { indent = 2, ...opts } = {}) {
  const text = JSON.stringify(data, null, indent);
  return remoteWriteText(host, path, text, opts);
}

/**
 * 确保远端目录存在（类似 mkdir -p）
 * @param {string} host 主机 ID
 * @param {string} path 远端目录路径
 * @param {object} [opts] { mode: number, elevated: boolean }
 */
export async function remoteEnsureDir(host, path, { mode, elevated = false } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('Path is required');
  const r = await sh(host, ['mkdir', '-p', p], { sudo: elevated ? 'always' : 'auto', timeout: 15 });
  if (!r.ok) throw failureOf(r);
  if (mode != null) {
    await sh(host, ['chmod', String(mode), p], { sudo: elevated ? 'always' : 'auto', timeout: 10 });
  }
  return { ok: true, path: p };
}

/**
 * 查询远端 systemd 服务当前状态与最近日志
 * @param {string} host 主机 ID
 * @param {string} name 服务名（如 nginx, docker）
 * @returns {Promise<{ name: string, active: boolean, status: string, enabled: boolean, description: string, output: string }>}
 */
export async function serviceStatus(host, name) {
  const sName = String(name || '').trim();
  if (!sName) throw new Error('Service name is required');
  const rActive = await sh(host, ['systemctl', 'is-active', sName], { timeout: 10 });
  const rEnabled = await sh(host, ['systemctl', 'is-enabled', sName], { timeout: 10 });
  const rStatus = await sh(host, ['systemctl', 'status', sName, '--no-pager', '-l', '-n', '15'], { timeout: 15 });

  const activeStr = String(rActive.output || '').trim();
  const enabledStr = String(rEnabled.output || '').trim();
  const statusOut = String(rStatus.output || '').trim();

  let desc = '';
  const descMatch = statusOut.match(/Loaded:[^\n]*?\(([^;\n]+)/i);
  if (descMatch) desc = descMatch[1].trim();

  return {
    name: sName,
    active: activeStr === 'active',
    status: activeStr || 'unknown',
    enabled: enabledStr === 'enabled',
    description: desc,
    output: statusOut,
  };
}

/**
 * 对远端 systemd 服务执行生命周期操作（支持自动提权）
 * @param {string} host 主机 ID
 * @param {string} name 服务名
 * @param {'start'|'stop'|'restart'|'reload'|'enable'|'disable'|'mask'|'unmask'} action 操作类型
 * @param {object} [opts] { sudo: 'auto'|'always'|'never' }
 */
export async function serviceAction(host, name, action, { sudo = 'auto' } = {}) {
  const sName = String(name || '').trim();
  const act = String(action || '').toLowerCase().trim();
  if (!sName) throw new Error('Service name is required');
  const ALLOWED_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'];
  if (!ALLOWED_ACTIONS.includes(act)) {
    throw new Error(`Unsupported service action: ${act}. Supported: ${ALLOWED_ACTIONS.join(', ')}`);
  }
  const r = await sh(host, ['systemctl', act, sName], { sudo, timeout: 30 });
  if (!r.ok) throw failureOf(r);
  return {
    ok: true,
    name: sName,
    action: act,
    output: String(r.output || ''),
  };
}

/**
 * 查询远端环境变量
 * @param {string} host 主机 ID
 * @param {string|string[]} [names] 待查询的变量名（可选）
 * @returns {Promise<Record<string, string|null>>}
 */
export async function remoteEnv(host, names) {
  const r = await sh(host, 'env', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const envMap = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1);
      envMap[k] = v;
    }
  }
  if (!names) return envMap;
  const keys = (Array.isArray(names) ? names : [names]).map(String);
  const out = {};
  for (const k of keys) out[k] = envMap[k] !== undefined ? envMap[k] : null;
  return out;
}

/**
 * 查询远端登录用户的详细身份信息（UID、GID、用户组、主目录及默认 Shell）
 * @param {string} host 主机 ID
 * @returns {Promise<{ uid: number, user: string, gid: number, group: string, groups: string[], home: string, shell: string }>}
 */
export async function remoteUser(host) {
  const r = await sh(host, 'id -u; id -un; id -g; id -gn; id -G -n; echo "$HOME"; echo "$SHELL"', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  return {
    uid: parseInt(lines[0], 10) || 0,
    user: lines[1] || '',
    gid: parseInt(lines[2], 10) || 0,
    group: lines[3] || '',
    groups: lines[4] ? lines[4].split(/\s+/) : [],
    home: lines[5] || '',
    shell: lines[6] || '',
  };
}

/**
 * 查询远端主机网络接口、IP 地址及状态列表
 * @param {string} host 主机 ID
 * @returns {Promise<Array<{ name: string, state: string, mac: string, mtu: number, ip4: string[], ip6: string[], flags: string[] }>>}
 */
export async function netInterfaces(host) {
  const rJson = await sh(host, 'ip -j addr 2>/dev/null', { timeout: 15 });
  if (rJson.ok && rJson.output.trim().startsWith('[')) {
    try {
      const data = JSON.parse(rJson.output.trim());
      return data.map((item) => {
        const ip4 = [];
        const ip6 = [];
        (item.addr_info || []).forEach((info) => {
          if (info.family === 'inet' && info.local) ip4.push(info.local);
          else if (info.family === 'inet6' && info.local) ip6.push(info.local);
        });
        return {
          name: item.ifname || '',
          state: item.operstate || 'unknown',
          mac: item.address || '',
          mtu: item.mtu || 1500,
          ip4,
          ip6,
          flags: item.flags || [],
        };
      });
    } catch {}
  }
  const r = await sh(host, 'ip addr show 2>/dev/null || ifconfig -a 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const list = [];
  let cur = null;
  for (const line of lines) {
    const ifaceMatch = line.match(/^\d+:\s+([^:@]+)[:@]/);
    if (ifaceMatch) {
      if (cur) list.push(cur);
      const stateMatch = line.match(/state\s+([A-Z]+)/);
      const mtuMatch = line.match(/mtu\s+(\d+)/);
      cur = {
        name: ifaceMatch[1],
        state: stateMatch ? stateMatch[1].toLowerCase() : 'unknown',
        mac: '',
        mtu: mtuMatch ? parseInt(mtuMatch[1], 10) : 1500,
        ip4: [],
        ip6: [],
        flags: [],
      };
      continue;
    }
    if (!cur) continue;
    const macMatch = line.match(/link\/ether\s+([0-9a-fA-F:]{17})/);
    if (macMatch) cur.mac = macMatch[1];
    const ip4Match = line.match(/inet\s+([0-9.]+)\/(\d+)/);
    if (ip4Match) cur.ip4.push(ip4Match[1]);
    const ip6Match = line.match(/inet6\s+([0-9a-fA-F:]+)\/(\d+)/);
    if (ip6Match) cur.ip6.push(ip6Match[1]);
  }
  if (cur) list.push(cur);
  return list;
}

/**
 * 查询远端主机路由表及默认网关
 * @param {string} host 主机 ID
 * @returns {Promise<Array<{ destination: string, gateway: string, interface: string, protocol: string, metric: number|null }>>}
 */
export async function routeTable(host) {
  const rJson = await sh(host, 'ip -j route 2>/dev/null', { timeout: 15 });
  if (rJson.ok && rJson.output.trim().startsWith('[')) {
    try {
      const data = JSON.parse(rJson.output.trim());
      return data.map((r) => ({
        destination: r.dst || 'default',
        gateway: r.gateway || '',
        interface: r.dev || '',
        protocol: r.protocol || '',
        metric: r.metric != null ? r.metric : null,
      }));
    } catch {}
  }
  const r = await sh(host, 'ip route show 2>/dev/null', { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  return lines.map((l) => {
    const parts = l.trim().split(/\s+/);
    const dest = parts[0] || '';
    const gwIdx = parts.indexOf('via');
    const devIdx = parts.indexOf('dev');
    const protoIdx = parts.indexOf('proto');
    const metricIdx = parts.indexOf('metric');
    return {
      destination: dest,
      gateway: gwIdx >= 0 ? parts[gwIdx + 1] : '',
      interface: devIdx >= 0 ? parts[devIdx + 1] : '',
      protocol: protoIdx >= 0 ? parts[protoIdx + 1] : '',
      metric: metricIdx >= 0 ? parseInt(parts[metricIdx + 1], 10) : null,
    };
  });
}

/**
 * 借远端主机测试目标 IP/端口连通性及网络延迟
 * @param {string} host 主机 ID
 * @param {string} target 目标地址或域名
 * @param {number} port 目标端口
 * @param {object} [opts] { timeout: number }
 * @returns {Promise<{ open: boolean, target: string, port: number, latencyMs: number }>}
 */
export async function testPort(host, target, port, { timeout = 3 } = {}) {
  const tgt = String(target || '').trim();
  const prt = parseInt(port, 10);
  if (!tgt || !prt) throw new Error('Target and port are required');
  const tmo = Math.max(1, Math.min(timeout, 30));
  const t0 = Date.now();
  const cmd = `(timeout ${tmo} bash -c "echo > /dev/tcp/${tgt}/${prt}" 2>/dev/null || nc -z -w ${tmo} ${tgt} ${prt} 2>/dev/null) && echo "OPEN" || echo "CLOSED"`;
  const r = await sh(host, cmd, { timeout: tmo + 5 });
  const open = String(r.output || '').includes('OPEN');
  const dur = Date.now() - t0;
  return {
    open,
    target: tgt,
    port: prt,
    latencyMs: dur,
  };
}

/**
 * 借远端主机解析域名 DNS 记录
 * @param {string} host 主机 ID
 * @param {string} domain 待解析域名
 * @param {object} [opts] { dnsServer: string }
 * @returns {Promise<{ domain: string, addresses: string[], output: string }>}
 */
export async function dnsResolve(host, domain, { dnsServer = '' } = {}) {
  const dom = String(domain || '').trim();
  if (!dom) throw new Error('Domain name is required');
  const serverArg = dnsServer ? `@${dnsServer}` : '';
  const cmd = dnsServer
    ? `dig +short ${serverArg} ${dom} 2>/dev/null || nslookup ${dom} ${dnsServer} 2>/dev/null`
    : `getent hosts ${dom} 2>/dev/null || dig +short ${dom} 2>/dev/null || host ${dom} 2>/dev/null`;
  const r = await sh(host, cmd, { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  const addresses = [];
  for (const l of lines) {
    const ips = l.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|[0-9a-fA-F:]{7,39}/g);
    if (ips) {
      for (const ip of ips) {
        if (!addresses.includes(ip)) addresses.push(ip);
      }
    }
  }
  return {
    domain: dom,
    addresses,
    output: String(r.output || ''),
  };
}


/**
 * 查看远端系统日志（journalctl），支持指定服务单元与行数
 * @param {string} host 主机 ID
 * @param {object} [opts] { unit: string, lines: number, since: string, priority: string }
 * @returns {Promise<Array<{ time: string, host: string, unit: string, message: string }>>}
 */
export async function journalTail(host, { unit = '', lines = 50, since = '', priority = '' } = {}) {
  const args = ['journalctl', '-n', String(Math.max(1, Math.min(lines, 1000))), '--no-pager', '-o', 'short-iso'];
  if (unit) args.push('-u', unit);
  if (since) args.push('--since', since);
  if (priority) args.push('-p', priority);
  const r = await sh(host, args, { sudo: 'auto', timeout: 20 });
  if (!r.ok) throw failureOf(r);
  const rawLines = splitLines(r.output);
  const entries = [];
  for (const l of rawLines) {
    const match = l.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+([^\s]+)\s+([^:]+):\s*(.*)$/);
    if (match) {
      entries.push({
        time: match[1],
        host: match[2],
        unit: match[3],
        message: match[4],
      });
    } else {
      entries.push({ time: '', host: '', unit: '', message: l });
    }
  }
  return entries;
}

/**
 * 读取远端内核环形缓冲区日志（dmesg 最近条目）
 * @param {string} host 主机 ID
 * @param {object} [opts] { lines: number }
 * @returns {Promise<Array<{ time: string, message: string }>>}
 */
export async function dmesgTail(host, { lines = 50 } = {}) {
  const cnt = Math.max(1, Math.min(lines, 1000));
  const r = await sh(host, `dmesg -T 2>/dev/null | tail -n ${cnt}`, { sudo: 'auto', timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const rawLines = splitLines(r.output);
  return rawLines.map((l) => {
    const m = l.match(/^\[([^\]]+)\]\s*(.*)$/);
    return {
      time: m ? m[1].trim() : '',
      message: m ? m[2] : l,
    };
  });
}

/**
 * 探测远端 Linux 发行版的包管理器类型
 * @param {string} host 主机 ID
 * @returns {Promise<{ manager: 'apt'|'dnf'|'yum'|'apk'|'pacman'|'zypper'|'unknown', path: string|null, family: string }>}
 */
export async function pkgDetect(host) {
  const r = await which(host, ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper']);
  if (r['apt-get']) return { manager: 'apt', path: r['apt-get'], family: 'debian' };
  if (r.dnf) return { manager: 'dnf', path: r.dnf, family: 'redhat' };
  if (r.yum) return { manager: 'yum', path: r.yum, family: 'redhat' };
  if (r.apk) return { manager: 'apk', path: r.apk, family: 'alpine' };
  if (r.pacman) return { manager: 'pacman', path: r.pacman, family: 'arch' };
  if (r.zypper) return { manager: 'zypper', path: r.zypper, family: 'suse' };
  return { manager: 'unknown', path: null, family: 'unknown' };
}

/**
 * 检查指定软件包是否已安装并获取其版本
 * @param {string} host 主机 ID
 * @param {string} pkgName 软件包名（如 curl, nginx, docker-ce）
 * @returns {Promise<{ package: string, installed: boolean, version: string }>}
 */
export async function pkgInstalled(host, pkgName) {
  const name = String(pkgName || '').trim();
  if (!name) throw new Error('Package name is required');
  const script = `
if command -v dpkg >/dev/null 2>&1; then
  dpkg -s "${name}" 2>/dev/null | grep -E '^(Status|Version):'
elif command -v rpm >/dev/null 2>&1; then
  rpm -q --qf "Status: install ok installed\\nVersion: %{VERSION}-%{RELEASE}\\n" "${name}" 2>/dev/null
elif command -v apk >/dev/null 2>&1; then
  apk info -e "${name}" 2>/dev/null && echo "Status: install ok installed"
elif command -v pacman >/dev/null 2>&1; then
  pacman -Q "${name}" 2>/dev/null && echo "Status: install ok installed"
fi
`;
  const r = await sh(host, script, { timeout: 15 });
  const out = String(r.output || '');
  const installed = out.includes('installed');
  let version = '';
  const vMatch = out.match(/Version:\s*([^\s]+)/i);
  if (vMatch) version = vMatch[1];
  return {
    package: name,
    installed,
    version,
  };
}

/**
 * 查询远端 Git 仓库的分支、提交追踪与修改状态
 * @param {string} host 主机 ID
 * @param {string} repoPath 仓库工作区根目录
 * @returns {Promise<{ path: string, branch: string, upstream: string, ahead: number, behind: number, clean: boolean, files: Array<{ status: string, path: string }> }>}
 */
export async function gitStatus(host, repoPath) {
  const p = String(repoPath || '').trim();
  if (!p) throw new Error('Repository path is required');
  const r = await sh(host, ['git', '-C', p, 'status', '--porcelain=v1', '-b'], { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const l of lines) {
    if (l.startsWith('## ')) {
      const header = l.slice(3).trim();
      const m = header.match(/^([^\s.]+)(?:\.\.\.([^\s]+))?(?:\s+\[(?:ahead\s+(\d+))?(?:,\s*)?(?:behind\s+(\d+))?\])?/);
      if (m) {
        branch = m[1] || '';
        upstream = m[2] || '';
        ahead = m[3] ? parseInt(m[3], 10) : 0;
        behind = m[4] ? parseInt(m[4], 10) : 0;
      }
      continue;
    }
    const status = l.slice(0, 2).trim();
    const filePath = l.slice(3).trim();
    files.push({ status, path: filePath });
  }

  return {
    path: p,
    branch,
    upstream,
    ahead,
    behind,
    clean: files.length === 0,
    files,
  };
}

/**
 * 查询远端 Git 仓库近期提交日志记录
 * @param {string} host 主机 ID
 * @param {string} repoPath 仓库工作区根目录
 * @param {object} [opts] { count: number }
 * @returns {Promise<Array<{ hash: string, shortHash: string, author: string, email: string, timestamp: number, subject: string }>>}
 */
export async function gitLog(host, repoPath, { count = 10 } = {}) {
  const p = String(repoPath || '').trim();
  if (!p) throw new Error('Repository path is required');
  const cnt = Math.max(1, Math.min(count, 100));
  const r = await sh(host, ['git', '-C', p, 'log', '-n', String(cnt), '--pretty=format:%H|%an|%ae|%at|%s'], { timeout: 15 });
  if (!r.ok) throw failureOf(r);
  const lines = splitLines(r.output);
  return lines.map((l) => {
    const parts = l.split('|');
    return {
      hash: parts[0] || '',
      shortHash: (parts[0] || '').slice(0, 7),
      author: parts[1] || '',
      email: parts[2] || '',
      timestamp: parseInt(parts[3], 10) || 0,
      subject: parts.slice(4).join('|'),
    };
  });
}

/**
 * 计算远端文件散列校验和（SHA256 / MD5 / SHA1 等）
 * @param {string} host 主机 ID
 * @param {string} path 远端目标路径
 * @param {object} [opts] { algo: 'sha256'|'md5'|'sha1'|'sha512' }
 * @returns {Promise<{ path: string, algo: string, hash: string }>}
 */
export async function fileChecksum(host, path, { algo = 'sha256' } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('Path is required');
  const a = String(algo || 'sha256').toLowerCase().replace(/sum$/, '');
  const cmdMap = {
    sha256: 'sha256sum',
    md5: 'md5sum',
    sha1: 'sha1sum',
    sha512: 'sha512sum',
  };
  const bin = cmdMap[a] || 'sha256sum';
  const r = await sh(host, [bin, p], { timeout: 30 });
  if (!r.ok) throw failureOf(r);
  const parts = String(r.output || '').trim().split(/\s+/);
  return {
    path: p,
    algo: a,
    hash: parts[0] || '',
  };
}

/**
 * 解压远端归档文件（自动识别 .tar.gz, .tgz, .zip, .tar.bz2, .tar.xz）
 * @param {string} host 主机 ID
 * @param {string} archivePath 归档文件路径
 * @param {object} [opts] { destDir: string, sudo: 'auto'|'always'|'never' }
 */
export async function archiveExtract(host, archivePath, { destDir = '', sudo = 'auto' } = {}) {
  const arc = String(archivePath || '').trim();
  if (!arc) throw new Error('Archive path is required');
  const dest = destDir ? String(destDir).trim() : arc.replace(/\.(tar\.(gz|bz2|xz)|tgz|zip|tar)$/i, '');
  let cmd = '';
  if (arc.endsWith('.zip')) {
    cmd = `mkdir -p "${dest}" && unzip -q -o "${arc}" -d "${dest}"`;
  } else {
    cmd = `mkdir -p "${dest}" && tar -xf "${arc}" -C "${dest}"`;
  }
  const r = await sh(host, cmd, { sudo, timeout: 60 });
  if (!r.ok) throw failureOf(r);
  return { ok: true, archive: arc, destDir: dest };
}

/**
 * 将远端文件或目录打包为压缩归档文件
 * @param {string} host 主机 ID
 * @param {string} sourcePath 待压缩的源路径
 * @param {string} targetArchive 目标归档路径（.tar.gz / .zip / .tar.bz2）
 * @param {object} [opts] { sudo: 'auto'|'always'|'never' }
 */
export async function archiveCreate(host, sourcePath, targetArchive, { sudo = 'auto' } = {}) {
  const src = String(sourcePath || '').trim();
  const tgt = String(targetArchive || '').trim();
  if (!src || !tgt) throw new Error('Source path and target archive path are required');
  const parent = src.substring(0, src.lastIndexOf('/')) || '.';
  const base = src.substring(src.lastIndexOf('/') + 1);
  let cmd = '';
  if (tgt.endsWith('.zip')) {
    cmd = `cd "${parent}" && zip -r -q "${tgt}" "${base}"`;
  } else if (tgt.endsWith('.tar.bz2')) {
    cmd = `tar -cjf "${tgt}" -C "${parent}" "${base}"`;
  } else if (tgt.endsWith('.tar.xz')) {
    cmd = `tar -cJf "${tgt}" -C "${parent}" "${base}"`;
  } else {
    cmd = `tar -czf "${tgt}" -C "${parent}" "${base}"`;
  }
  const r = await sh(host, cmd, { sudo, timeout: 120 });
  if (!r.ok) throw failureOf(r);
  return { ok: true, source: src, target: tgt };
}

/**
 * 查询远端用户的定时任务列表（解析 crontab -l）
 * @param {string} host 主机 ID
 * @param {object} [opts] { user: string }
 * @returns {Promise<Array<{ schedule: string, command: string, raw: string }>>}
 */
export async function crontabList(host, { user = '' } = {}) {
  const u = String(user || '').trim();
  const cmd = u ? ['crontab', '-u', u, '-l'] : ['crontab', '-l'];
  const r = await sh(host, cmd, { sudo: u ? 'always' : 'auto', timeout: 15 });
  if (!r.ok) {
    if (String(r.output || '').includes('no crontab for')) return [];
    throw failureOf(r);
  }
  const lines = splitLines(r.output);
  const rules = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 6) {
      const schedule = parts.slice(0, 5).join(' ');
      const command = parts.slice(5).join(' ');
      rules.push({ schedule, command, raw: trimmed });
    }
  }
  return rules;
}



