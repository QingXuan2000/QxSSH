/**
 * core/i18n.js —— 国际化词表加载与语言状态
 * 要点：管理语言选择与词表按需加载，提供 t/tf 取值函数，并通过信号和事件通知界面在语言切换后重渲染。
 */
import { emit, on } from './bus.js';
import { lsGet, lsSet } from './storage.js';
import { signal } from './signal.js';

const STORAGE_KEY = 'qx-lang';
/** 兜底语言代码，未配置或协商失败时使用 */
export const DEFAULT_LANG = 'zh-CN';
const DEFAULT_BASE = '/assets/language';

function normalizeBase(dir) {
  try {
    return new URL(dir, location.href).href;
  } catch {
    return dir;
  }
}

/** 内置语言清单（代码 + 显示名） */
export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
];

function earlyLang() {
  try {
    if (typeof location !== 'undefined') {
      const u = new URLSearchParams(location.search).get('lang');
      if (u && LANGUAGES.some((l) => l.code === u)) return u;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch { }
  return DEFAULT_LANG;
}

let current = earlyLang();
applyDocLang();
let table = Object.create(null);
const loaded = new Set();
let baseDir = DEFAULT_BASE;
let curBase = null;
let scopeLangs = null;
let scoped = false;
let scopeKey = STORAGE_KEY;
let curScope = null;

function normalizeLangs(list) {
  if (!Array.isArray(list)) return [];
  return list.map((l) => (typeof l === 'string' ? l : l && l.code)).filter((c) => typeof c === 'string' && c);
}

/** 拼装语言偏好在本地存储中的键名，可按作用域区分 */
export function langPrefKey(scope) {
  return scope ? `${STORAGE_KEY}:${scope}` : STORAGE_KEY;
}

/** 读取某个作用域下已保存的语言 */
export function savedLang(scope) {
  return lsGet(langPrefKey(scope), '') || '';
}

function isKnown(code) {
  const list = scopeLangs || LANGUAGES.map((l) => l.code);
  return list.includes(code);
}

/** 取当前可用语言清单（应用限制了语言范围时以其为准） */
export function currentLangs() {
  if (!scopeLangs) return LANGUAGES;
  return scopeLangs.map((code) => LANGUAGES.find((l) => l.code === code) || { code, label: code });
}

/** 取当前语言偏好的作用域名 */
export function currentScope() {
  return scopeKey === STORAGE_KEY ? null : scopeKey.slice(STORAGE_KEY.length + 1);
}

const hostTables = new Map();

/** 取宿主语言词表，用于在切换前展示其他语言的文案 */
export function hostTerms(code) {
  if (!code) return null;
  if (code === current) return table;
  return hostTables.get(code) || null;
}

/** 预热宿主语言词表，加载完成后触发词表刷新 */
export function prefetchHostLang(code) {
  if (!code || code === current || hostTables.has(code)) return;
  hostTables.set(code, null);
  fetchTable(code, DEFAULT_BASE).then((t) => {
    hostTables.set(code, t);
    tickTable();
  }).catch(() => {
    hostTables.delete(code);
  });
}

/** 当前语言的响应式信号，界面订阅它即可跟随语言切换 */
export const langSignal = signal(current);

/** 读取当前语言代码，同时登记对词表的依赖 */
export function lang() {
  tableTick.value;
  return langSignal.value;
}

/** 词表版本信号，词表更新后自增以触发重渲染 */
export const tableTick = signal(0);

/** 通知依赖方词表已更新 */
export function tickTable() {
  tableTick.next = tableTick.value + 1;
}

/** 设置当前语言并广播信号 */
export function setCurrent(code) {
  current = code;
  langSignal.next = code;
}

/** 取当前已加载的全部词条 */
export function allTerms() {
  return table;
}

/** 从 URL 参数、本地存储与作用域初始化语言，返回命中语言代码或 null */
export function initLang() {
  const own = scoped ? lsGet(scopeKey, '') : '';
  if (own && isKnown(own)) {
    setCurrent(own);
    return current;
  }
  let urlLang = null;
  try {
    if (typeof location !== 'undefined') {
      urlLang = new URLSearchParams(location.search).get('lang');
    }
  } catch { }
  if (urlLang && isKnown(urlLang)) {
    setCurrent(urlLang);
    return current;
  }
  const saved = lsGet(STORAGE_KEY, '');
  if (saved && isKnown(saved)) {
    setCurrent(saved);
    return current;
  }
  return null;
}

/** 与后端协商语言，已有本地设置时直接沿用 */
export async function negotiateLang() {
  const determined = initLang();
  if (determined) return determined;
  if (scoped) {
    setCurrent(scopeLangs ? scopeLangs[0] : DEFAULT_LANG);
    return current;
  }
  try {
    const res = await fetch('/api/v1/lang/negotiate', { headers: { Accept: 'application/json' } });
    if (!res.ok) return current;
    const data = await res.json();
    if (isKnown(data.lang)) {
      setCurrent(data.lang);
      applyDocLang();
    }
  } catch {
  }
  return current;
}

/** 从后端取可用语言清单与默认语言 */
export async function listLangs() {
  const res = await fetch('/api/v1/lang/list');
  if (!res.ok) throw new Error(tf('core.lang.list-failed', { v1: res.status }));
  const data = await res.json();
  return { languages: data.languages || LANGUAGES, default: data.default || DEFAULT_LANG };
}

async function fetchTable(code, base) {
  const res = await fetch(`${base}/${code}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${base}/${code}.json → HTTP ${res.status}`);
  return res.json();
}

async function loadTable(code, dir) {
  const isBase = normalizeBase(dir) === normalizeBase(DEFAULT_BASE);
  let base = null;
  if (!isBase) {
    try {
      base = await fetchTable(code, DEFAULT_BASE);
    } catch (err) {
      console.warn('[i18n] 宿主级基线词条加载失败，仅用应用自己的词条', err);
    }
  }
  const app = await fetchTable(code, dir);
  return base ? Object.assign(Object.create(null), base, app) : app;
}

/** 取词条文案，未命中时返回 fallback 或键名本身 */
export function t(key, fallback) {
  tableTick.value;
  if (fallback !== undefined) return fallback;
  const v = table[key];
  return typeof v === 'string' ? v : key;
}

/** 取词条并替换其中的 {占位符} 参数 */
export function tf(key, params) {
  const s = t(key);
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (all, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all
  ));
}

/** 初始化国际化：确定语言、加载词表并广播 i18n:ready */
export async function setupI18n(dir = DEFAULT_BASE, opts = {}) {
  const codes = normalizeLangs(opts.languages);
  const nextScope = codes.length ? codes.join(',') : null;
  const nextKey = langPrefKey(opts.scope);
  if (nextScope !== curScope) {
    curScope = nextScope;
    loaded.clear();
  }
  if (codes.length) scopeLangs = codes;
  scoped = !!opts.scope;
  scopeKey = nextKey;
  const norm = normalizeBase(dir);
  if (norm !== curBase) {
    loaded.clear();
    curBase = norm;
  }
  baseDir = norm;
  const determined = initLang();
  applyDocLang();
  if (!determined) {
    await negotiateLang();
    applyDocLang();
  }
  try {
    table = await loadTable(current, baseDir);
    loaded.add(current);
  } catch (err) {
    console.warn('[i18n] 语言表加载失败', err);
  }
  setCurrent(current);
  tickTable();
  emit('i18n:ready', current);
  return current;
}

/** 切换语言并加载对应词表，可选择是否持久化 */
export async function setLang(code, opts = {}) {
  if (!isKnown(code)) return current;
  try {
    if (code !== current || !loaded.has(code)) {
      table = await loadTable(code, baseDir);
      loaded.add(code);
    }
  } catch (err) {
    console.warn('[i18n] 切换语言失败', err);
    return current;
  }
  setCurrent(code);
  tickTable();
  if (opts.persist !== false) lsSet(scopeKey, code);
  applyDocLang();
  emit('i18n:changed', code);
  return code;
}

/** 订阅语言就绪与语言切换事件，返回取消订阅函数 */
export function onLangChange(fn) {
  const offReady = on('i18n:ready', fn);
  const offChanged = on('i18n:changed', fn);
  return () => {
    offReady();
    offChanged();
  };
}

function applyDocLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}