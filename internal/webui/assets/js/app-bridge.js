/**
 * app-bridge.js —— 应用与桌面宿主之间的通信桥
 * 要点：内嵌应用经 postMessage/RPC 使用窗口控制、主题、权限、跨应用 API 与事件等宿主能力，是应用侧的统一入口。
 */
import { readCachedPref } from './core/prefs-cache.js';
import { loadPrefs, setPref } from './core/prefs.js';
import { on as onBus } from './core/bus.js';
import {
  t, tf, setLang as setI18nLang, currentScope, savedLang,
} from './core/i18n.js';

const earlyUrlLang = (() => {
  try {
    return new URLSearchParams(location.search).get('lang') || null;
  } catch {
    return null;
  }
})();

const state = {
  hostId: null,
  windowId: null,
  appId: null,
  session: null,
  title: document.title,
  theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  themeMode: 'system',
  taskbarPos: 'bottom',
  glass: null,
  lang: earlyUrlLang,
  windowState: null,
  ready: false,
};

const waiters = [];
const themeListeners = new Set();
const windowStateListeners = new Set();
const sessionListeners = new Set();
const permChangeListeners = new Set();
const eventListeners = new Set();
const apiHandlers = new Map();
const inflightInvokes = new Map();
const apiChangeListeners = new Set();
const pendingCalls = new Map();
const pendingLists = new Map();
const pendingHost = new Map();
let rpcSeq = 0;

function rpcId() {
  return `rpc-${Date.now().toString(36)}-${++rpcSeq}`;
}

function post(type, extra = {}) {
  try {
    // 应用处于不透明源（sandbox 无 allow-same-origin），targetOrigin 只能用 '*'；
    // 宿主侧按 e.source 是否为已挂载的应用帧来校验来源。
    if (!window.parent || window.parent === window || typeof window.parent.postMessage !== 'function') {
      return;
    }
    window.parent.postMessage({ __qx: true, type, ...extra }, '*');
  } catch (err) {
    console.warn('[app] postMessage 失败', err);
  }
}

function hostCall(method, params, timeout, fallback) {
  return new Promise((resolve) => {
    const reqId = rpcId();
    pendingHost.set(reqId, {
      resolve,
      fallback,
      timer: setTimeout(() => {
        pendingHost.delete(reqId);
        resolve(fallback);
      }, timeout),
    });
    post('host-call', { reqId, method, params });
  });
}

function applyHostLang(code) {
  const next = code ? String(code) : '';
  if (!next) return;
  state.lang = next;
  const scope = currentScope();
  if (scope && savedLang(scope)) return;
  setI18nLang(next, { persist: false });
}

onBus('i18n:changed', (code) => {
  if (!state.ready) return;
  if (currentScope()) return;
  const next = String(code || '');
  if (!next || next === state.lang) return;
  state.lang = next;
  post('set-lang', { lang: next });
});

function applyTheme(theme) {
  if (!theme) return;
  state.theme = theme;
  const isDark = theme === 'dark';
  if (document.documentElement.classList.contains('dark') !== isDark) {
    document.documentElement.classList.toggle('dark', isDark);
  }
}

window.addEventListener('message', (e) => {
  // 不透明源下无法用 origin 判定，改为只接纳来自父窗口（宿主）的消息。
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d || d.__qx !== true) return;
  if (d.type === 'init') {
    state.hostId = d.ctx?.hostId || null;
    state.windowId = d.ctx?.windowId || null;
    state.title = d.ctx?.title || document.title;
    state.appId = d.ctx?.appId || null;
    if (d.ctx?.session) state.session = d.ctx.session;
    state.lang = d.ctx?.lang || null;
    state.themeMode = d.ctx?.themeMode || null;
    state.taskbarPos = d.ctx?.taskbarPos || null;
    state.glass = typeof d.ctx?.glass === 'number' ? d.ctx.glass : null;
    if (d.ctx?.prefs && typeof d.ctx.prefs === 'object') {
      loadPrefs(d.ctx.prefs);
    }
    if (d.ctx?.lang) {
      applyHostLang(d.ctx.lang);
    }
    state.windowState = d.ctx?.windowState || null;
    applyTheme(d.ctx?.theme);
    if (d.ctx && typeof d.ctx.glass === 'number') {
      document.documentElement.style.setProperty('--glass-a', String(d.ctx.glass));
    }
    state.ready = true;
    for (const fn of waiters.splice(0)) {
      try { fn(state); } catch (err) { console.error('[app] init handler', err); }
    }
  } else if (d.type === 'theme') {
    applyTheme(d.theme);
    if (d.themeMode) {
      state.themeMode = d.themeMode;
      setPref('qx-theme', d.themeMode);
    }
    for (const fn of [...themeListeners]) {
      try { fn(d.theme, d.themeMode || state.themeMode); } catch (err) { console.error('[app] theme listener', err); }
    }
  } else if (d.type === 'lang') {
    applyHostLang(d.lang);
  } else if (d.type === 'glass') {
    applyStoredGlass();
  } else if (d.type === 'win-state') {
    const next = String(d.state || '') || null;
    const prev = state.windowState;
    state.windowState = next;
    for (const fn of [...windowStateListeners]) {
      try { fn(next, prev); } catch (err) { console.error('[app] window state listener', err); }
    }
  } else if (d.type === 'session') {
    state.session = typeof d.token === 'string' && d.token ? d.token : null;
    for (const fn of [...sessionListeners]) {
      try { fn(state.session); } catch (err) { console.error('[app] session listener', err); }
    }
  } else if (d.type === 'session-revoked') {
    state.session = null;
    for (const fn of [...sessionListeners]) {
      try { fn(null); } catch (err) { console.error('[app] session listener', err); }
    }
  } else if (d.type === 'perm-changed') {
    for (const fn of [...permChangeListeners]) {
      try { fn(d.app); } catch (err) { console.error('[app] perm-changed listener', err); }
    }
  } else if (d.type === 'app-event') {
    dispatchEvent_(String(d.topic || ''), d.payload, d.from ? String(d.from) : null);
  } else if (d.type === 'api-progress') {
    const p = pendingCalls.get(d.reqId);
    if (p && p.onProgress) {
      try { p.onProgress(d.value); } catch (err) { console.error('[app] onProgress', err); }
    }
  } else if (d.type === 'api-cancel') {
    const inflight = inflightInvokes.get(String(d.reqId || ''));
    if (inflight) {
      inflightInvokes.delete(String(d.reqId || ''));
      try { inflight.abort(); } catch { }
    }
  } else if (d.type === 'app-apis') {
    for (const { fn, filter } of [...apiChangeListeners]) {
      if (filter && filter !== String(d.appId || '')) continue;
      try { fn({ appId: String(d.appId || ''), apis: Array.isArray(d.apis) ? d.apis : [] }); }
      catch (err) { console.error('[app] app-apis listener', err); }
    }
  } else if (d.type === 'api-invoke') {
    const name = String(d.api || '');
    const reqId = String(d.reqId || '');
    const meta = apiHandlers.get(name);
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    if (reqId) inflightInvokes.set(reqId, { api: name, abort: () => ac && ac.abort() });
    const handler = meta && meta.handler;
    const ctx = {
      from: String(d.from || '') || null,
      windowId: String(d.windowId || '') || null,
      signal: ac ? ac.signal : null,
      progress: (value) => {
        if (!inflightInvokes.has(reqId)) return;
        post('api-progress', { reqId, value });
      },
    };
    Promise.resolve()
      .then(() => (handler
        ? handler(d.args, ctx)
        : Promise.reject(appApiError(APP_API_ERR.NOT_PROVIDED, tf('app.core.api-not-provided', { v1: (name || '?') })))))
      .then((value) => {
        if (!inflightInvokes.delete(reqId)) return;
        post('api-return', { reqId, ok: true, value });
      })
      .catch((err) => {
        if (!inflightInvokes.delete(reqId)) return;
        post('api-return', {
          reqId,
          ok: false,
          code: (err && err.appApiCode) || APP_API_ERR.HANDLER,
          error: (err && err.message) || String(err),
        });
      });
  } else if (d.type === 'api-result') {
    const p = pendingCalls.get(d.reqId);
    if (p) {
      p.settle(() => {
        if (d.ok) p.resolve(d.value);
        else p.reject(appApiError(d.code || APP_API_ERR.HANDLER, d.error || t('app.core.api-call-failed')));
      });
    }
  } else if (d.type === 'api-list-result') {
    const p = pendingLists.get(d.reqId);
    if (p) {
      clearTimeout(p.timer);
      pendingLists.delete(d.reqId);
      if (d.error) p.reject(appApiError(d.code, d.error));
      else p.resolve(Array.isArray(d.apis) ? d.apis : []);
    }
  } else if (d.type === 'host-result') {
    const p = pendingHost.get(d.reqId);
    if (p) {
      clearTimeout(p.timer);
      pendingHost.delete(d.reqId);
      if (d.ok === false && p.reject) p.reject(appApiError(d.code, d.error));
      else p.resolve(d.ok === false ? p.fallback : (d.value === undefined ? p.fallback : d.value));
    }
  }
});

/** 向宿主查询已安装应用列表 */
export function listApps() {
  return hostCall('apps.list', {}, 10000, []);
}

/** 通知宿主应用列表已变化 */
export function notifyAppsChanged() {
  post('apps-changed');
}

/** 调起宿主的文件/目录选择器，返回所选路径或 null */
export function pickPath({ type = 'file', start = '', title = '', timeout = 600000, keepOpen = false } = {}) {
  return callAppApi('files', 'pick', {
    type: type === 'dir' ? 'dir' : 'file',
    start: String(start || ''),
    title: String(title || ''),
  }, { autoOpen: true, keepOpen, timeout })
    .then((r) => (typeof r === 'string' && r ? r : null))
    .catch(() => null);
}

/** 取当前窗口的上下文信息（主机、窗口、主题、会话等） */
export function getContext() {
  return {
    hostId: state.hostId,
    windowId: state.windowId,
    title: state.title,
    theme: state.theme,
    appId: state.appId || null,
    session: state.session || null,
    windowState: state.windowState || null,
  };
}

/** 向宿主申请权限，返回是否全部获批 */
export function requestAppPermission(need) {
  const list = Array.isArray(need) ? need.map(String).filter(Boolean) : [];
  if (!list.length) return Promise.resolve(true);
  return hostCall('perm.request', { need: list }, 300000, false);
}

/** 通知宿主某应用的权限已变更 */
export function notifyPermChanged(app) {
  post('perm-changed', { app: app ? String(app) : state.appId });
}

/** 通知宿主某应用的会话已吊销，清空其运行期令牌并断开网络能力 */
export function notifySessionRevoked(app) {
  post('session-revoked-notify', { app: app ? String(app) : state.appId });
}

/** 监听会话令牌更新（例如动态补授权限后下发了新 JWT） */
export function onSessionChange(fn) {
  if (typeof fn !== 'function') return () => { };
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

/** 监听权限变更广播 */
export function onPermChange(fn) {
  if (typeof fn !== 'function') return () => { };
  permChangeListeners.add(fn);
  return () => permChangeListeners.delete(fn);
}

/** 请求宿主激活并置顶当前窗口（用于应用内弹窗、重要提示等） */
export function focusWindow() {
  try { post('win-focus'); } catch { }
}

/** 应用间 API 调用的错误码枚举 */
export const APP_API_ERR = {
  BAD_ARGS: 'bad_args',
  NOT_OPEN: 'not_open',
  NOT_PROVIDED: 'not_provided',
  NO_WINDOW: 'no_window',
  NEEDS_WINDOW: 'needs_window',
  TARGET_CLOSED: 'target_closed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  PERMISSION: 'permission',
  HANDLER: 'handler',
};

function appApiError(code, message) {
  const err = new Error(message);
  err.code = code || APP_API_ERR.HANDLER;
  return err;
}

function assertCloneable(value, what) {
  if (value === undefined || typeof structuredClone !== 'function') return;
  try {
    structuredClone(value);
  } catch (err) {
    throw appApiError(
      APP_API_ERR.BAD_ARGS,
      tf('app.core.not-cloneable', { v1: what, v2: ((err && err.message) || err) })
      + t('app.core.structured-clone-note'),
    );
  }
}

/** 对外提供本应用的 API，供其他应用调用 */
export function provideApi(name, handler, opts = {}) {
  if (!name || typeof handler !== 'function') {
    throw new Error(t('app.core.provide-bad-args'));
  }
  const key = String(name);
  const prev = apiHandlers.get(key);
  const meta = {
    description: String((opts && opts.description) || ''),
    version: String((opts && opts.version) || ''),
    needsWindow: !!(opts && opts.needsWindow),
    perm: String((opts && opts.perm) || ''),
  };
  apiHandlers.set(key, { handler, ...meta });
  const same = prev && prev.needsWindow === meta.needsWindow && prev.perm === meta.perm
    && prev.description === meta.description && prev.version === meta.version;
  if (!same) post('api-provide', { name: key, ...meta });
}

/** 撤销已提供的 API，并中止进行中的调用 */
export function revokeApi(name) {
  const key = String(name || '');
  if (!apiHandlers.delete(key)) return;
  post('api-revoke', { name: key });
  for (const [reqId, inflight] of [...inflightInvokes]) {
    if (inflight.api !== key) continue;
    inflightInvokes.delete(reqId);
    try { inflight.abort(); } catch { }
    post('api-return', { reqId, ok: false, code: APP_API_ERR.NOT_PROVIDED, error: tf('app.core.api-revoked', { v1: key }) });
  }
}

/** 调用其他应用提供的 API，支持超时、取消与进度回调 */
export function callAppApi(appId, api, args, opts = {}) {
  const timeout = Math.max(1, Number(opts && opts.timeout) || 30000);
  const target = String(appId || '');
  const name = String(api || '');
  const label = `${target || '?'}.${name || '?'}`;
  const signal = opts && opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
  const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (signal && signal.aborted) {
    return Promise.reject(appApiError(APP_API_ERR.CANCELLED, tf('app.core.call-cancelled', { v1: label })));
  }
  let payload;
  try {
    assertCloneable(args, tf('app.core.call-args-title', { v1: label }));
    payload = {
      reqId: rpcId(),
      appId: target,
      api: name,
      args,
      windowId: String((opts && opts.windowId) || ''),
      autoOpen: !!(opts && opts.autoOpen),
      keepOpen: opts && opts.keepOpen !== undefined ? !!opts.keepOpen : undefined,
      silent: !!(opts && opts.silent),
      timeout,
    };
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      onProgress,
      timer: setTimeout(() => settle(() => {
        reject(appApiError(APP_API_ERR.TIMEOUT, tf('app.core.call-timeout', { v1: label, v2: timeout })));
      }), timeout),
      onAbort: null,
    };
    const settle = (fn) => {
      if (!pendingCalls.delete(payload.reqId)) return;
      clearTimeout(entry.timer);
      if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
      fn();
    };
    entry.settle = settle;
    if (signal) {
      entry.onAbort = () => settle(() => {
        post('api-cancel', { reqId: payload.reqId });
        reject(appApiError(APP_API_ERR.CANCELLED, tf('app.core.call-cancelled', { v1: label })));
      });
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    pendingCalls.set(payload.reqId, entry);
    post('api-call', payload);
  });
}

/** 并发调用多个应用的 API，返回逐项成功/失败结果 */
export function callAppApis(calls, opts = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const timeout = Math.max(1, Number(opts && opts.timeout) || 30000);
  return Promise.all(list.map((c) => (
    callAppApi(c && c.appId, c && c.api, c && c.args, {
      timeout: Number(c && c.timeout) || timeout,
      windowId: c && c.windowId,
      autoOpen: !!(c && c.autoOpen),
      keepOpen: c && c.keepOpen !== undefined ? !!c.keepOpen : undefined,
      silent: !!(c && c.silent),
      signal: (c && c.signal) || (opts && opts.signal),
      onProgress: c && c.onProgress,
    }).then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, code: (err && err.code) || APP_API_ERR.HANDLER, error: (err && err.message) || String(err) }),
    )
  )));
}

/** 订阅某应用 API 列表的变化，返回取消订阅函数 */
export function onAppApiChange(fn, appId) {
  if (typeof fn !== 'function') return () => { };
  const filter = appId ? String(appId) : '';
  const entry = { fn, filter };
  apiChangeListeners.add(entry);
  return () => apiChangeListeners.delete(entry);
}

/** 查询指定应用对外提供的 API 列表 */
export function listAppApis(appId, opts = {}) {
  const target = String(appId || '');
  const timeout = Math.max(1, Number(opts && opts.timeout) || 10000);
  return new Promise((resolve, reject) => {
    const reqId = rpcId();
    pendingLists.set(reqId, {
      resolve,
      reject,
      timer: setTimeout(() => {
        pendingLists.delete(reqId);
        reject(appApiError(APP_API_ERR.TIMEOUT, tf('app.core.list-timeout', { v1: (target || '?'), v2: timeout })));
      }, timeout),
    });
    post('api-list-request', { reqId, appId: target });
  });
}

const EVENT_TOPIC_MAX = 128;

function topicMatches(pattern, topic) {
  if (pattern === topic || pattern === '*') return true;
  if (pattern.endsWith('*')) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

function dispatchEvent_(topic, payload, from) {
  if (!topic) return;
  for (const { pattern, fn } of [...eventListeners]) {
    if (!topicMatches(pattern, topic)) continue;
    try { fn(payload, { topic, from }); } catch (err) { console.error('[app] event listener', topic, err); }
  }
}

/** 向宿主与其他应用广播事件，并在本应用内分发 */
export function publishEvent(topic, payload) {
  const name = String(topic || '');
  if (!name || name.length > EVENT_TOPIC_MAX) throw new Error(t('app.core.event-bad-topic'));
  assertCloneable(payload, tf('app.core.event-args-title', { v1: name }));
  post('event-publish', { topic: name, payload });
  dispatchEvent_(name, payload, state.appId);
}

/** 订阅事件（支持 * 通配），返回取消订阅函数 */
export function onEvent(pattern, fn) {
  if (typeof fn !== 'function') return () => { };
  const entry = { pattern: String(pattern || '*'), fn };
  eventListeners.add(entry);
  return () => eventListeners.delete(entry);
}

/** 订阅窗口状态变化，返回取消订阅函数 */
export function onWindowState(fn) {
  if (typeof fn !== 'function') return () => { };
  windowStateListeners.add(fn);
  try { fn(state.windowState, null); } catch (err) { console.error('[app] window state listener', err); }
  return () => windowStateListeners.delete(fn);
}

/** 窗口上下文状态对象，随宿主 init 消息更新 */
export const bridge = state;

/** 注册初始化回调：宿主已就绪则立即执行，否则等待 */
export function onInit(fn) {
  if (state.ready) {
    try { fn(state); } catch (err) { console.error('[app] init handler', err); }
  } else {
    waiters.push(fn);
  }
}

/** 启动准备：等待就绪并取出根元素、URL 参数与主机 id */
export async function appBoot({ root = '#app' } = {}) {
  const ctx = await new Promise((resolve) => onInit(resolve));
  const el = document.querySelector(root);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  return { root: el, ctx, params, hostId: ctx?.hostId || null };
}

/** 等待宿主就绪后运行应用入口，返回带 dispose 的句柄 */
export async function bootApp(boot, opts = {}) {
  const args = await appBoot(opts);
  try {
    return runApp(boot, args);
  } catch (err) {
    // 启动期抛错时主动上报：宿主在不透明源下看不到应用 DOM，只能靠这里。
    reportAppError(err);
    throw err;
  }
}

/** 不等待宿主就绪直接运行应用入口，用于独立运行的页面 */
export function bootAppNoInit(boot, { root = '#app' } = {}) {
  const el = document.querySelector(root);
  const params = Object.fromEntries(new URLSearchParams(location.search));
  return runApp(boot, { root: el, ctx: undefined, params, hostId: null });
}

function runApp(boot, args) {
  const raw = boot(args) || (() => { });
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    raw();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  return { dispose };
}

/** 订阅主题变化并立即回调当前主题，返回取消订阅函数 */
export function onThemeChange(fn) {
  if (typeof fn !== 'function') return () => { };
  themeListeners.add(fn);
  fn(state.theme, state.themeMode);
  return () => themeListeners.delete(fn);
}

/** 请求宿主更新窗口标题 */
export function setTitle(title) {
  if (title) post('title', { title: String(title) });
}

/** 请求宿主打开另一个应用 */
export function openApp(id, opts = {}) {
  post('open-app', { id: String(id), opts });
}

/** 请求宿主关闭当前窗口 */
export function closeSelf() {
  post('close');
}

/** 让宿主弹出全局轻提示 */
export function hostToast(text, kind = 'info') {
  post('toast', { text: String(text), kind });
}

/** 请求宿主切换主题 */
export function setTheme(mode) {
  post('set-theme', { mode });
}

/** 请求宿主重新应用壁纸 */
export function applyWallpaper() {
  post('apply-wallpaper');
}

/** 请求宿主调整毛玻璃强度 */
export function setGlass(alpha) {
  post('set-glass', { alpha: Number(alpha) });
}

/** 请求宿主调整任务栏位置 */
export function applyTaskbar(pos) {
  post('apply-taskbar', { pos });
}

/** 请求宿主增删窗口容器上的类名 */
export function windowClass(add = [], remove = []) {
  post('win-class', { add, remove });
}

/** 请求宿主让窗口闪烁以提醒用户 */
export function windowFlash() {
  post('win-flash');
}

/** 依据本地缓存的偏好立即应用主题，避免首屏闪烁 */
export function applyStoredTheme() {
  try {
    const mode = readCachedPref('qx-theme') || 'system';
    const dark = mode === 'dark' || (mode !== 'light' && (document.documentElement.classList.contains('dark') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)));
    if (document.documentElement.classList.contains('dark') !== dark) {
      document.documentElement.classList.toggle('dark', dark);
    }
    state.theme = dark ? 'dark' : 'light';
  } catch { }
}

/** 依据本地缓存的偏好立即应用玻璃强度 */
export function applyStoredGlass() {
  try {
    const n = parseFloat(readCachedPref('qx-glass-a'));
    if (Number.isFinite(n)) document.documentElement.style.setProperty('--glass-a', String(n));
  } catch { }
}

/** 取宿主程序信息 */
export function getHostInfo() {
  return hostCall('host.info', {}, 5000, null);
}

/** 请求宿主重新加载某个应用 */
export function reloadApp(id) {
  return hostCall('apps.reload', { id: String(id || '') }, 5000, 0);
}

/** 请求宿主执行窗口操作（最小化/最大化/关闭） */
export function windowControl(action) {
  post('win-control', { action: String(action || '') });
}

/** 取当前窗口在宿主中的位置与尺寸 */
export function getWindowRect() {
  return hostCall('win.rect.get', {}, 5000, null);
}

/** 设置当前窗口的位置与尺寸 */
export function setWindowRect(rect = {}) {
  post('win-rect-set', {
    rect: {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
    },
  });
}

/** 调用宿主原生对话框（alert/confirm/prompt）并等待结果 */
export function hostDialog(opts = {}) {
  return hostCall('dialog', {
    kind: ['alert', 'confirm', 'prompt'].includes(opts.kind) ? opts.kind : 'alert',
    title: String(opts.title || ''),
    desc: String(opts.desc || ''),
    okText: String(opts.okText || ''),
    cancelText: String(opts.cancelText || ''),
    value: String(opts.value || ''),
    placeholder: String(opts.placeholder || ''),
    danger: opts.danger === true,
  }, 600000, { ok: false });
}

/** 通过宿主写入系统剪贴板 */
export function writeClipboard(text) {
  return hostCall('clipboard.write', { text: String(text ?? '') }, 5000, false);
}

/** 取当前工作区（主机）信息 */
export function getWorkspaceInfo() {
  return hostCall('workspace.info', {}, 8000, null);
}

/** 通过宿主发送系统通知 */
export function notify({ title, body = '', tag = '', silent = false } = {}) {
  return hostCall('notify', {
    title: String(title || ''), body: String(body), tag: String(tag), silent: silent === true,
  }, 8000, false);
}

/** 列出宿主中的所有窗口 */
export function listWindows() {
  return hostCall('win.list', {}, 5000, []);
}

/** 设置任务栏按钮上的角标文字 */
export function setWindowBadge(text) {
  post('win-badge', { text: text == null ? '' : String(text) });
}

/** 请求宿主打开设置面板的指定页签 */
export function openSettings(tab = '') {
  return hostCall('settings.open', { tab: String(tab || '') }, 5000, false);
}

/** 设置窗口标题栏的强调色 */
export function setTitleAccent(color) {
  post('set-title-color', { color: color ? String(color) : '' });
}

/** 用宿主打开外部链接（不透明源下 window.open 会继承沙箱，改由宿主打开） */
export function openExternal(url) {
  const href = String(url || '');
  if (!/^https?:\/\//i.test(href)) return Promise.resolve(false);
  return hostCall('open-external', { url: href }, 5000, false);
}

/**
 * 主动上报启动/运行错误。宿主在不透明源下读不到应用 DOM，
 * 无法自己发现错误；应用应在启动失败或关键错误时调用它。
 * 未完成握手时会渲染宿主侧错误面板，已运行时只弹 toast。
 */
export function reportAppError(err) {
  const msg = String((err && err.message) || err || '').trim();
  if (msg) post('app-error', { message: msg });
}

// 不透明源下宿主读不到本应用的 DOM，无法在应用内部挂事件；
// 由应用自己上报指针按下，让宿主把窗口置顶。
window.addEventListener('pointerdown', () => {
  try { post('win-focus'); } catch { }
}, true);

post('ready');
