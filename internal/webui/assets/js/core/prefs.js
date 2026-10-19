/**
 * core/prefs.js —— 偏好设置的本地缓存与后端同步
 * 要点：localStorage 作即时缓存保证读取同步，改动去抖 200ms 批量写回配置库，并自动迁移旧的散落键。
 */
import { signal } from './signal.js';
import { PREFS_CACHE_KEY, readCachedPref, setCachedPrefs } from './prefs-cache.js';

/** 转出缓存读取函数，供首屏在配置库就绪前使用 */
export { readCachedPref };

const CACHE_KEY = PREFS_CACHE_KEY;

const LEGACY_KEYS = [
  'qx-theme',
  'qx-glass-a',
  'qx-taskbar-pos',
  'qx-desktop-hidden-icons',
  'qx-sm-fav', 'qx-sm-view',
  'qx-browser-prog',
  'qx-docker-dir', 'qx-docker-autoref', 'qx-docker-logh',
  'qx-docker-notify', 'qx-notify',
  'qx-logs-detail', 'qx-logs-setting',
  'qx-fm-view', 'qx-fm-hidden', 'qx-fm-bookmarks',
  'qx-taskmon-layout',
  'qx-term-config',
  'qx-logs-detailw', 'qx-fm-previeww', 'qx-docker-detailw',
];
const LEGACY_PREFIXES = [
  'qx-desktop-layout-', 'qx-desktop-folders-', 'qx-term-session-',
];

let mem = null;
let memRaw = null;
let lsUsable = true;

function readCache() {
  let raw = null;
  if (lsUsable) {
    try {
      raw = localStorage.getItem(CACHE_KEY);
    } catch {
      lsUsable = false;
    }
  }
  if (mem && !lsUsable) return mem;
  if (mem && raw === memRaw) return mem;
  try {
    const parsed = JSON.parse(raw || '{}');
    mem = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    mem = {};
  }
  memRaw = raw;
  return mem;
}

function writeCache() {
  try {
    const s = JSON.stringify(mem);
    localStorage.setItem(CACHE_KEY, s);
    memRaw = s;
  } catch {
    lsUsable = false;
  }
}

let pending = {};
let flushTimer = 0;
let flushInFlight = false;

function migrateLegacy() {
  const moved = {};
  if (!lsUsable) return moved;
  const take = (k) => {
    if (mem[k] !== undefined) {
      dropLoose(k);
      return;
    }
    const v = readLoose(k);
    if (v === undefined) return;
    mem[k] = v;
    moved[k] = v;
    dropLoose(k);
  };
  for (const k of LEGACY_KEYS) take(k);
  for (const k of allLooseKeys()) {
    if (LEGACY_PREFIXES.some((p) => k.startsWith(p))) take(k);
  }
  return moved;
}

function allLooseKeys() {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}

async function flush() {
  flushTimer = 0;
  if (flushInFlight || !Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  flushInFlight = true;
  try {
    const { sysPut } = await import('./sys.js');
    if (typeof window !== 'undefined' && window.parent !== window) {
      // 处于沙箱应用 iframe 内：优先使用方案 A 的应用专属私有偏好
      try {
        await sysPut('prefs/self', { prefs: body });
        return;
      } catch {
        // 回退尝试全局
      }
    }
    await sysPut('prefs', { prefs: body });
  } catch (err) {
    try {
      const { sysPut } = await import('./sys.js');
      await sysPut('prefs/self', { prefs: body });
    } catch {
      console.warn('[prefs] 写入配置库失败，本次改动只存在于本机缓存', err);
    }
  } finally {
    flushInFlight = false;
    if (Object.keys(pending).length) scheduleFlush();
  }
}

/** 在沙箱应用内部从专属偏好库（prefs/self）拉取并恢复状态 */
export async function initAppPrefs() {
  try {
    const { sysGet } = await import('./sys.js');
    const d = await sysGet('prefs/self');
    if (d && d.prefs && typeof d.prefs === 'object') {
      loadPrefs(d.prefs);
    }
  } catch { }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 200);
}

/** 用配置库数据初始化本地缓存，并迁移遗留旧键 */
export function loadPrefs(remote) {
  const m = readCache();
  const moved = migrateLegacy();
  if (remote && typeof remote === 'object') {
    for (const [k, v] of Object.entries(remote)) {
      if (typeof v === 'string') m[k] = v;
    }
  }
  setCachedPrefs(m);
  writeCache();
  if (Object.keys(moved).length) {
    Object.assign(pending, moved);
    scheduleFlush();
  }
  return m;
}

/** 取当前全部偏好项的只读拷贝 */
export function allPrefs() {
  return { ...readCache() };
}

/** 读取字符串偏好，未命中时回退到旧键或默认值 */
export function getPref(key, fallback = '') {
  const m = readCache();
  if (m[key] !== undefined) return m[key];
  const loose = readLoose(key);
  return loose === undefined ? fallback : loose;
}

function readLoose(key) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

function dropLoose(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}

/** 读取并解析 JSON 偏好，解析失败返回默认值 */
export function getJSONPref(key, fallback) {
  const raw = getPref(key, '');
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 写入字符串偏好：本地即时生效，稍后同步到配置库 */
export function setPref(key, value) {
  const m = readCache();
  const s = String(value);
  m[key] = s;
  setCachedPrefs({ [key]: s });
  writeCache();
  pending[key] = s;
  scheduleFlush();
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ __qx: true, type: 'set-pref', key: String(key), value: s }, '*');
    } catch { }
  }
  return value;
}

/** 写入 JSON 偏好 */
export function setJSONPref(key, value) {
  return setPref(key, JSON.stringify(value));
}

/** 创建与偏好项绑定的响应式信号，赋值即持久化 */
export function prefSignal(key, def, { json = true } = {}) {
  const inner = signal(json ? getJSONPref(key, def) : getPref(key, def));
  return {
    get value() { return inner.value; },
    set next(v) {
      if (json) setJSONPref(key, v);
      else setPref(key, v);
      inner.next = v;
    },
    peek() { return inner.peek(); },
    subscribe(fn) { return inner.subscribe(fn); },
  };
}

/** 删除偏好项并同步到配置库 */
export function delPref(key) {
  const m = readCache();
  delete m[key];
  setCachedPrefs({ [key]: '' });
  writeCache();
  pending[key] = '';
  scheduleFlush();
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ __qx: true, type: 'set-pref', key: String(key), value: '' }, '*');
    } catch { }
  }
}

/** 是否还有偏好改动未同步到配置库 */
export function prefsPending() {
  return Object.keys(pending).length > 0;
}

/** 立即把待同步的偏好写入配置库，页面卸载时调用 */
export function flushPrefs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  return flush();
}

window.addEventListener('pagehide', () => { flushPrefs(); });

