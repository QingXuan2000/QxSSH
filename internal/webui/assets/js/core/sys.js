/**
 * core/sys.js —— 宿主系统 API 的统一调用层
 * 要点：带会话令牌与权限补授的请求封装（sysFetch/sysGet/sysCall/sysPut/sysStream），以及 sudo 提权交互。
 */
import { dom } from './dom.js';
import { bridge, onInit, onSessionChange, requestAppPermission as bridgeGrantRequest } from '../app-bridge.js';
import { drainText } from './read-stream.js';
import { t, tf } from './i18n.js';

/** 宿主 API 的基础路径 */
export const API_BASE = '/api/v1';

let sessCached = null;

onSessionChange((tok) => {
  sessCached = tok;
});

/** 取当前会话令牌（来自桌面桥接或页面 meta 标签） */
export function sessionToken() {
  if (bridge && bridge.session) return (sessCached = bridge.session);
  if (sessCached) return sessCached;
  try {
    const m = document.querySelector('meta[name="qx-session"]');
    if (m && m.content) return (sessCached = m.content);
  } catch { }
  return null;
}

function ensureToken() {
  const t = sessionToken();
  if (t || bridge.ready) return Promise.resolve(t);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(sessionToken()), 4000);
    onInit(() => { clearTimeout(timer); resolve(sessionToken()); });
  });
}

function withAuditWS(query) {
  const ws = bridge.hostId;
  if (!ws) return query;
  if (query && query.host) return query;
  return { ...(query || {}), qxws: ws };
}

/** 把失败响应转换成带 status/code/need 的 Error */
export async function errorFromResponse(res) {
  let msg = `HTTP ${res.status}`;
  let code = '';
  let need = null;
  try {
    const j = await res.json();
    if (j) {
      if (j.error) msg = j.error;
      code = j.code || '';
      need = Array.isArray(j.need) ? j.need : null;
    }
  } catch { }
  const err = new Error(msg);
  err.status = res.status;
  if (code) err.code = code;
  if (need) err.need = need;
  return err;
}

function buildQuery(query) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 通用请求：自动附加令牌与 JSON 序列化，权限不足时先申请授权再重试一次 */
export async function sysFetch(verb, target, { query, body, form, blob, raw, _retried } = {}) {
  const tok = await ensureToken();
  const url = `${API_BASE}/${target}${buildQuery(withAuditWS(query))}`;
  const opts = { method: verb, headers: {} };
  if (tok) opts.headers['X-Qx-Session'] = tok;
  if (form) {
    opts.body = form;
  } else if (blob !== undefined) {
    if (blob && blob.type) opts.headers['Content-Type'] = blob.type;
    else opts.headers['Content-Type'] = 'application/octet-stream';
    opts.body = blob;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    const err = new Error(t('app.core.network-error') + ((e && e.message) || e));
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (err.status === 403 && err.code === 'permission' && err.need && err.need.length && !_retried) {
      let granted = false;
      try { granted = await bridgeGrantRequest(err.need); } catch { }
      if (granted) return sysFetch(verb, target, { query, body, form, blob, raw, _retried: true });
    }
    throw err;
  }
  if (raw) return res;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** GET 请求 */
export function sysGet(target, query) {
  return sysFetch('GET', target, { query });
}

/** POST 请求 */
export function sysCall(target, body) {
  return sysFetch('POST', target, { body });
}

/** PUT 请求 */
export function sysPut(target, body) {
  return sysFetch('PUT', target, { body });
}

/** 拼接带会话令牌的普通请求地址 */
export function sysUrl(target, query = {}) {
  const tok = sessionToken();
  const q = { ...query };
  if (tok) q.session = tok;
  return `${API_BASE}/${target}${buildQuery(q)}`;
}

/** 拼接带会话令牌的 WebSocket 地址 */
export function sysWsUrl(target, query = {}) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tok = sessionToken();
  const q = { ...query };
  if (tok) q.session = tok;
  return `${proto}://${location.host}${API_BASE}/ws/${target}${buildQuery(q)}`;
}

/** 向宿主申请应用权限 */
export function requestAppGrants(need) {
  return bridgeGrantRequest(need);
}

/** 流式请求：边接收边把文本交给 onChunk */
export async function sysStream(target, { query, body, signal, onChunk, _retried } = {}) {
  const tok = await ensureToken();
  const url = `${API_BASE}/${target}${buildQuery(query)}`;
  const opts = { method: body !== undefined ? 'POST' : 'GET', signal, headers: {} };
  if (tok) opts.headers['X-Qx-Session'] = tok;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const err = new Error(t('app.core.network-error') + ((e && e.message) || e));
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (err.status === 403 && err.code === 'permission' && err.need && err.need.length && !_retried) {
      let granted = false;
      try { granted = await bridgeGrantRequest(err.need); } catch { }
      if (granted) return sysStream(target, { query, body, signal, onChunk, _retried: true });
    }
    throw err;
  }
  await drainText(res, onChunk);
}

/** 弹出 sudo 密码输入框并验证，返回是否通过 */
export function promptSudoPassword(hostId, title = t('app.core.open-as-admin'), reason = '') {
  return new Promise((resolve) => {
    const input = dom('input', {
      class: 'input', type: 'password', autocomplete: 'current-password',
      placeholder: t('app.core.sudo-prompt'),
    });
    const errEl = dom('div', { class: 'qx-sudo-err' });
    const okBtn = dom('button', { class: 'btn btn-primary btn-sm' }, [t('app.core.ok-action')]);
    const cancelBtn = dom('button', { class: 'btn btn-ghost btn-sm' }, [t('app.core.cancel')]);
    const content = [
      dom('div', { class: 'confirm-title', text: title }),
      dom('div', { class: 'confirm-desc', text: t('app.core.sudo-prompt-note') }),
    ];
    if (reason) content.push(dom('div', { class: 'confirm-desc', style: { marginTop: '6px' }, text: reason }));
    content.push(dom('div', { style: { marginTop: '12px' } }, [input]), errEl);
    const mask = dom('div', { class: 'overlay' }, [
      dom('div', { class: 'dialog dialog-sm' }, [
        dom('div', { class: 'confirm-body' }, [
          dom('div', { class: 'confirm-content' }, content),
        ]),
        dom('div', { class: 'dialog-foot' }, [cancelBtn, okBtn]),
      ]),
    ]);
    const done = (v) => { mask.remove(); resolve(v); };
    cancelBtn.addEventListener('click', () => done(false));
    mask.addEventListener('click', (e) => { if (e.target === mask) done(false); });

    async function submit() {
      const pw = input.value;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      errEl.textContent = t('app.core.verifying');
      try {
        await sysCall('sudo/request', { host: hostId, password: pw, submit: true });
        done(true);
      } catch (e) {
        errEl.textContent = e.message || String(e);
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        input.focus();
        input.select();
      }
    }
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    document.body.append(mask);
    input.focus();
  });
}

const permFlight = new Map();

/** 请求提权：先探测免密，必要时提示输入密码；同一主机的并发请求会合并 */
export function requestSudoElevation(hostId, opts = {}) {
  const exist = permFlight.get(hostId);
  if (exist) return exist;
  const p = doRequest(hostId, opts).finally(() => permFlight.delete(hostId));
  permFlight.set(hostId, p);
  return p;
}

async function doRequest(hostId, { title = t('app.core.sudo-required'), reason = '' } = {}) {
  let probe;
  try {
    probe = await sysCall('sudo/request', { host: hostId, password: '', submit: false });
  } catch (e) {
    return { ok: false, error: t('app.core.sudo-auth-failed') + (e.message || e) };
  }
  if (probe.ok) return { ok: true, mode: probe.mode };
  if (probe.needPass) {
    const confirmed = await promptSudoPassword(hostId, title, reason);
    return confirmed ? { ok: true, mode: 'password' } : { ok: false, cancelled: true };
  }
  return { ok: false, error: t('app.core.sudo-enable-failed') };
}

/** 判断错误是否属于“权限不足/需要 sudo” */
export function isSudoPermError(err) {
  if (!err) return false;
  if (typeof err === 'string') return isPermMsg(err);
  if (err.code === 'permission') return false;
  if (err.status === 403) return true;
  return isPermMsg(err.message);
}

function isPermMsg(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('permission denied')
    || m.includes('operation not permitted')
    || m.includes(t('app.core.perm-denied'))
    || m.includes(t('app.core.need-sudo'));
}
