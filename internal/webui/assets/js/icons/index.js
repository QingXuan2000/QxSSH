/**
 * icons/index.js —— 统一图标出口
 * 要点：自绘图标优先，其次按别名查 lucide 图标，统一渲染为 svg 文本；未知名记录一次告警并给出问号占位。
 */
import { ICON_ALIAS } from './aliases.js';
import { CUSTOM_PATHS } from './custom.js';
import { appFileUrl } from '../core/qxssh-api.js';
import '../../vendor/lucide.min.js';

const L = () => (typeof globalThis !== 'undefined' ? globalThis.lucide : null);

if (!L() || !L().icons) {
  throw new Error('[qx] icon: lucide.min.js 未生效，globalThis.lucide.icons 缺失');
}

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

let normMap = null;

function getNormMap() {
  if (!normMap) {
    const lib = L();
    normMap = new Map();
    if (lib && lib.icons) {
      for (const k of Object.keys(lib.icons)) {
        const norm = k.toLowerCase().replace(/[-_]/g, '');
        if (!normMap.has(norm)) normMap.set(norm, k);
      }
    }
  }
  return normMap;
}

function lucideKey(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const lib = L();
  if (!lib || !lib.icons) return null;
  if (Object.prototype.hasOwnProperty.call(lib.icons, n)) return n;
  const alias = ICON_ALIAS[n];
  if (alias && Object.prototype.hasOwnProperty.call(lib.icons, alias)) return alias;
  const norm = n.toLowerCase().replace(/[-_]/g, '');
  const found = getNormMap().get(norm);
  if (found && Object.prototype.hasOwnProperty.call(lib.icons, found)) return found;
  return null;
}

function lucideToMarkup(key) {
  const nodes = (L() && L().icons[key]) || [];
  return nodes.map(([tag, attrs]) => {
    const a = Object.entries(attrs || {})
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join(' ');
    return `<${tag} ${a}/>`;
  }).join('');
}

function renderSvg(cls, inner, viewBox) {
  const vb = viewBox ? ` viewBox="${viewBox}"` : '';
  return `<svg class="${cls}"${vb} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const UNKNOWN_SVG = (cls) =>
  `<svg class="${cls} qicon-bad" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
  + ` stroke-width="1.6" stroke-dasharray="3 2.2" stroke-linecap="round" stroke-linejoin="round"`
  + ` aria-hidden="true">`
  + `<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3.6"/>`
  + `<text class="qicon-bad-q" x="12" y="17" text-anchor="middle" font-size="13" font-weight="700">?</text></svg>`;

const unknownLogged = new Set();

function reportUnknown(n) {
  if (unknownLogged.has(n)) return;
  unknownLogged.add(n);
  console.error(`[icon] 未知图标名「${n}」，已渲染问号占位。用 iconNames() 核对拼写。`, new Error());
}

/** 取图标 svg 文本：自绘优先，其次 lucide，未知名回退为问号占位 */
export function icon(name, cls = 'qicon') {
  const n = String(name || '').trim();
  if (!n) return `<svg class="${cls}" ${SVG_ATTRS} aria-hidden="true"></svg>`;
  const custom = CUSTOM_PATHS[n];
  if (custom) {
    if (custom.startsWith('<svg')) return custom.replace('<svg', `<svg class="${cls}" aria-hidden="true"`);
    return renderSvg(cls, custom);
  }
  const key = lucideKey(n);
  if (!key) {
    reportUnknown(n);
    return UNKNOWN_SVG(cls);
  }
  return `<svg class="${cls}" ${SVG_ATTRS} aria-hidden="true">${lucideToMarkup(key)}</svg>`;
}

function toKebabCase(s) {
  return String(s || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** 列出所有可用图标名（lucide + 别名 + 自绘） */
export function iconNames() {
  const lib = L();
  const names = new Set();
  if (lib && lib.icons) {
    for (const k of Object.keys(lib.icons)) {
      names.add(k);
      names.add(toKebabCase(k));
    }
  }
  for (const k of Object.keys(ICON_ALIAS)) names.add(k);
  for (const k of Object.keys(CUSTOM_PATHS)) names.add(k);
  return [...names];
}

/** 判断图标名是否可用 */
export function hasIcon(name) {
  return Boolean(CUSTOM_PATHS[String(name || '')]) || Boolean(lucideKey(name));
}

/**
 * 把清单里的图标取值拆成亮色 / 暗色两份。
 * 字符串写法（旧清单）视为两种主题共用；对象写法 `{light, dark}` 分别取用，
 * 缺一侧时另一侧兜底，两侧相同时收敛为单一取值。
 */
export function iconPair(spec) {
  if (spec && typeof spec === 'object') {
    const light = String(spec.light || spec.dark || '').trim();
    const dark = String(spec.dark || spec.light || '').trim();
    return { light, dark: dark === light ? '' : dark };
  }
  const s = String(spec || '').trim();
  return { light: s, dark: '' };
}

function plainAppIcon(name, cls, appId) {
  const n = String(name || '');
  if (/\.[a-z0-9]+$/i.test(n) && appId) {
    return `<img class="${cls} qicon-img" src="${appFileUrl(appId, n)}" alt="" aria-hidden="true">`;
  }
  const key = n && (CUSTOM_PATHS[n] || lucideKey(n)) ? n : 'hosts';
  return icon(key, cls);
}

/**
 * 取应用图标：传图片文件名时按应用目录取图，否则按图标名渲染。
 * 第二参数之外还接受清单的复合写法 `{ light, dark }`——亮暗不同时挂两枚，
 * 由根节点 .dark 切换显示，主题切换无需重渲染应用列表。
 */
export function appIcon(spec, cls = 'qicon', appId = '') {
  const pair = iconPair(spec);
  if (!pair.dark) return plainAppIcon(pair.light, cls, appId);
  return `<span class="qicon-swap">`
    + `${plainAppIcon(pair.light, `${cls} qicon-light`, appId)}`
    + `${plainAppIcon(pair.dark, `${cls} qicon-dark`, appId)}`
    + '</span>';
}
