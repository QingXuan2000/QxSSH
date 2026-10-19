/**
 * desktop/wallpaper.js —— 桌面与启动页壁纸设置
 * 要点：管理壁纸模式（图片/纯色/纹理）与各主题下的选择、填充方式、纹理颜色与密度，并负责实际落地到页面。
 */
import { dom } from '../core/vdom.js';
import { fetchWallpapers } from '../core/wallpapers.js';
import { getPref, setPref, delPref } from '../core/prefs.js';

/** 桌面壁纸目标标识 */
export const TARGET_DESKTOP = 'desktop';
/** 启动页壁纸目标标识 */
export const TARGET_BOOT = 'boot';

/** 浅色主题档位 */
export const TIER_LIGHT = 'light';
/** 深色主题档位 */
export const TIER_DARK = 'dark';

/** 取当前主题档位（浅色/深色） */
export function currentTier() {
  if (typeof document === 'undefined') return TIER_LIGHT;
  return document.documentElement.classList.contains('dark') ? TIER_DARK : TIER_LIGHT;
}

function normTier(tier) {
  return tier === TIER_DARK || tier === TIER_LIGHT ? tier : currentTier();
}

function keyOf(target, name, tier) {
  const prefix = target === TARGET_BOOT ? 'qx-bootwall' : 'qx-wallpaper';
  return `${prefix}-${normTier(tier)}-${name}`;
}

const K_MODE = 'mode';
const K_COLOR = 'color';
const K_NAME = 'name';
const K_FIT = 'fit';
const K_TEX_NAME = 'tex';
const K_TEX_BASE = 'tex-base';
const K_TEX_LINE = 'tex-line';
const K_TEX_A = 'tex-a';
const K_TEX_DENSITY = 'tex-density';

const DEFAULT_TEXTURE = 'topography';

const FITS = ['cover', 'contain', 'fill', 'tile', 'center'];

/** 纹理透明度下限 */
export const TEX_ALPHA_MIN = 0.05;
/** 纹理透明度上限 */
export const TEX_ALPHA_MAX = 1;

/** 纹理密度下限 */
export const TEX_DENSITY_MIN = 0.5;
/** 纹理密度上限 */
export const TEX_DENSITY_MAX = 4;

const TEX_TILE_FLOOR = 2;

let cachedAll = null;
let cachedTextures = null;

/** 加载并缓存壁纸与纹理清单，force 为 true 时强制刷新 */
export async function loadWallpapers(force = false) {
  if (cachedAll && !force) return cachedAll;
  try {
    const data = await fetchWallpapers();
    cachedAll = (data.wallpapers || []).filter((w) => w && w.url);
    cachedTextures = (data.textures || []).filter((t) => t && t.name && t.url);
  } catch {
    cachedAll = cachedAll || [];
    cachedTextures = cachedTextures || [];
  }
  return cachedAll;
}

/** 取已缓存的壁纸条目 */
export function getWallpaperItems() {
  return cachedAll || [];
}

/** 取全部壁纸地址列表 */
export function getDefaultWallpapers() {
  return getWallpaperItems().map((w) => w.url);
}

/** 取已缓存的纹理条目 */
export function getTextureItems() {
  return cachedTextures || [];
}

/** 取当前选中的壁纸名 */
export function getSelectedWallpaperName(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_NAME, tier), '') || '';
}

/** 判断选中的壁纸是否仍存在（清单为空时视为可用） */
export function isSelectionResolvable(target = TARGET_DESKTOP, tier) {
  const list = getWallpaperItems();
  if (!list.length) return true;
  const name = getSelectedWallpaperName(target, tier);
  if (!name) return true;
  return list.some((w) => w.name === name);
}

/** 取应生效的壁纸地址：选中项优先，否则取第一个 */
export function getDefaultWallpaper(target = TARGET_DESKTOP, tier) {
  const list = getWallpaperItems();
  if (!list.length) return '';
  const name = getSelectedWallpaperName(target, tier);
  const hit = name ? list.find((w) => w.name === name) : null;
  return (hit || list[0]).url;
}

/** 取壁纸模式：image / color / texture */
export function getMode(target = TARGET_DESKTOP, tier) {
  const v = getPref(keyOf(target, K_MODE, tier), 'texture');
  return (v === 'image' || v === 'color' || v === 'texture') ? v : 'texture';
}

/** 取纯色壁纸的颜色 */
export function getColorWallpaper(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_COLOR, tier), '') || '#1a1a2e';
}

/** 取壁纸填充方式 */
export function getWallpaperFit(target = TARGET_DESKTOP, tier) {
  const v = getPref(keyOf(target, K_FIT, tier), '');
  return FITS.includes(v) ? v : 'cover';
}

/** 设置壁纸填充方式并立即应用 */
export function setWallpaperFit(fit, target = TARGET_DESKTOP, tier) {
  if (FITS.includes(fit)) setPref(keyOf(target, K_FIT, tier), fit);
  else delPref(keyOf(target, K_FIT, tier));
  applyWallpaper(target);
}

/** 把填充方式转换为 CSS 背景样式对象 */
export function wallpaperFitStyle(fit = getWallpaperFit()) {
  const base = { backgroundPosition: 'center' };
  switch (fit) {
    case 'contain':
      return { ...base, backgroundSize: 'contain', backgroundRepeat: 'no-repeat' };
    case 'fill':
      return { ...base, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' };
    case 'tile':
      return { ...base, backgroundSize: 'auto', backgroundRepeat: 'repeat' };
    case 'center':
      return { ...base, backgroundSize: 'auto', backgroundRepeat: 'no-repeat' };
    default:
      return { ...base, backgroundSize: 'cover', backgroundRepeat: 'no-repeat' };
  }
}

/** 设置壁纸模式并立即应用 */
export function setMode(mode, target = TARGET_DESKTOP, tier) {
  if (mode === 'image' || mode === 'color' || mode === 'texture') {
    setPref(keyOf(target, K_MODE, tier), mode);
  }
  applyWallpaper(target);
}

/** 取当前选中的纹理条目（默认 topography 或第一个） */
export function getSelectedTexture(target = TARGET_DESKTOP, tier) {
  const list = getTextureItems();
  const name = getPref(keyOf(target, K_TEX_NAME, tier), '') || '';
  if (name) return list.find((t) => t.name === name) || null;
  return list.find((t) => t.name === DEFAULT_TEXTURE) || list[0] || null;
}

/** 取纹理底色，未自定义时跟随主题变量 */
export function getTextureBase(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_TEX_BASE, tier), '') || texThemeColor('--qx-tex-base', '#E7EAF0', tier);
}

/** 取纹理线条色，未自定义时跟随主题变量 */
export function getTextureLine(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_TEX_LINE, tier), '') || texThemeColor('--qx-tex-line', '#44506B', tier);
}

/** 取纹理透明度，取值夹在上下限内 */
export function getTextureAlpha(target = TARGET_DESKTOP, tier) {
  const v = parseFloat(getPref(keyOf(target, K_TEX_A, tier), ''));
  return Number.isFinite(v)
    ? Math.min(TEX_ALPHA_MAX, Math.max(TEX_ALPHA_MIN, v))
    : texThemeAlpha(tier);
}

let tierProbe = null;

function texThemeColor(prop, fallback, tier) {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
  if (normTier(tier) === currentTier()) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    return v || fallback;
  }
  if (!tierProbe) {
    tierProbe = dom('div', { class: TIER_DARK, 'aria-hidden': 'true' });
    tierProbe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none';
  }
  if (!tierProbe.isConnected) document.body.appendChild(tierProbe);
  const v = getComputedStyle(tierProbe).getPropertyValue(prop).trim();
  return v || fallback;
}

function texThemeAlpha(tier) {
  const v = parseFloat(texThemeColor('--qx-tex-a', '', tier));
  return Number.isFinite(v) ? Math.min(TEX_ALPHA_MAX, Math.max(TEX_ALPHA_MIN, v)) : 0.4;
}

/** 取纹理密度，取值夹在上下限内 */
export function getTextureDensity(target = TARGET_DESKTOP, tier) {
  const v = parseFloat(getPref(keyOf(target, K_TEX_DENSITY, tier), ''));
  if (!Number.isFinite(v)) return 1;
  return Math.min(TEX_DENSITY_MAX, Math.max(TEX_DENSITY_MIN, v));
}

/** 按密度计算纹理平铺尺寸，返回 CSS background-size 值 */
export function textureTileSize(tex, target = TARGET_DESKTOP, tier) {
  const w = tex && tex.w > 0 ? tex.w : 600;
  const h = tex && tex.h > 0 ? tex.h : 600;
  const d = getTextureDensity(target, tier);
  const px = (n) => Math.max(TEX_TILE_FLOOR, n / d);
  return `${px(w).toFixed(1)}px ${px(h).toFixed(1)}px`;
}

/** 选中纹理并切换为纹理模式 */
export function selectTexture(name, target = TARGET_DESKTOP, tier) {
  if (name) setPref(keyOf(target, K_TEX_NAME, tier), String(name));
  setPref(keyOf(target, K_MODE, tier), 'texture');
  applyWallpaper(target);
}

/** 设置纹理的底色、线条色与透明度，空值表示恢复主题默认 */
export function setTextureColors({ base, line, alpha } = {}, target = TARGET_DESKTOP, tier) {
  if (base) setPref(keyOf(target, K_TEX_BASE, tier), base); else delPref(keyOf(target, K_TEX_BASE, tier));
  if (line) setPref(keyOf(target, K_TEX_LINE, tier), line); else delPref(keyOf(target, K_TEX_LINE, tier));
  if (Number.isFinite(alpha)) setPref(keyOf(target, K_TEX_A, tier), String(alpha));
  else delPref(keyOf(target, K_TEX_A, tier));
  applyWallpaper(target);
}

/** 设置纹理密度 */
export function setTextureDensity(density, target = TARGET_DESKTOP, tier) {
  if (Number.isFinite(density)) setPref(keyOf(target, K_TEX_DENSITY, tier), String(density));
  else delPref(keyOf(target, K_TEX_DENSITY, tier));
  applyWallpaper(target);
}

/** 选中壁纸并切换为图片模式，返回该壁纸是否仍存在 */
export function selectWallpaper(name, target = TARGET_DESKTOP, tier) {
  setPref(keyOf(target, K_NAME, tier), String(name || ''));
  setPref(keyOf(target, K_MODE, tier), 'image');
  applyWallpaper(target);
  return isSelectionResolvable(target, tier);
}

/** 设置纯色壁纸并切换为纯色模式 */
export function setColorWallpaper(color, target = TARGET_DESKTOP, tier) {
  if (color) setPref(keyOf(target, K_COLOR, tier), color);
  else delPref(keyOf(target, K_COLOR, tier));
  setPref(keyOf(target, K_MODE, tier), 'color');
  applyWallpaper(target);
}

/** 被删壁纸正好是当前选中项时，回退到内置壁纸 */
export function settleSelectionAfterDelete(name, target = TARGET_DESKTOP, tier) {
  if (getSelectedWallpaperName(target, tier) !== name) return false;
  const builtin = getWallpaperItems().find((w) => w.builtin);
  if (!builtin) return false;
  setPref(keyOf(target, K_NAME, tier), builtin.name);
  setPref(keyOf(target, K_MODE, tier), 'image');
  applyWallpaper(target);
  return true;
}

/** 重置壁纸相关设置，恢复默认图片模式 */
export function resetWallpaper(target = TARGET_DESKTOP, tier) {
  for (const k of [K_COLOR, K_NAME, K_FIT, K_TEX_NAME, K_TEX_BASE, K_TEX_LINE, K_TEX_A, K_TEX_DENSITY]) {
    delPref(keyOf(target, k, tier));
  }
  setPref(keyOf(target, K_MODE, tier), 'image');
  applyWallpaper(target);
}

const TEX_LAYER_CLASS = 'qx-texture';

function removeTextureLayer() {
  document.querySelector(`body > .${TEX_LAYER_CLASS}`)?.remove();
}

function ensureTextureLayer(target, tier) {
  const tex = getSelectedTexture(target, tier);
  if (!tex) {
    removeTextureLayer();
    return null;
  }
  let el = document.querySelector(`body > .${TEX_LAYER_CLASS}`);
  if (!el) {
    el = dom('div', { class: TEX_LAYER_CLASS, 'aria-hidden': 'true' });
    document.body.appendChild(el);
  }
  el.style.setProperty('--qx-tex-src', `url("${tex.url}")`);
  el.style.setProperty('--qx-tex-size', textureTileSize(tex, target, tier));
  el.style.setProperty('--qx-tex-base', getTextureBase(target, tier));
  el.style.setProperty('--qx-tex-line', getTextureLine(target, tier));
  el.style.setProperty('--qx-tex-a', String(getTextureAlpha(target, tier)));
  return el;
}

/** 把当前设置应用到桌面或启动页（图片/纯色/纹理） */
export async function applyWallpaper(target = TARGET_DESKTOP, tier) {
  if (target === TARGET_BOOT) {
    await applyBootWallpaper(true, tier);
    return;
  }
  const desk = document.querySelector('.desk') || document.querySelector('.desk-area');
  if (!desk) {
    if (getMode(target, tier) !== 'texture') removeTextureLayer();
    return;
  }

  const mode = getMode(target, tier);

  if (mode !== 'color') {
    await loadWallpapers();
    if (!isSelectionResolvable(target, tier)
      || (mode === 'texture' && !getSelectedTexture(target, tier))) {
      await loadWallpapers(true);
    }
  }

  if (mode === 'color') {
    removeTextureLayer();
    const color = getColorWallpaper(target, tier);
    desk.style.backgroundColor = color;
    desk.style.backgroundImage = 'none';
    desk.style.backgroundSize = '';
    desk.style.backgroundPosition = '';
    desk.style.backgroundRepeat = '';
    return;
  }

  if (mode === 'texture') {
    const el = ensureTextureLayer(target, tier);
    if (el) {
      desk.style.background = 'none';
      return;
    }
  }

  removeTextureLayer();
  const url = getDefaultWallpaper(target, tier);
  if (!url) {
    desk.style.background = 'none';
    return;
  }
  desk.style.backgroundColor = '';
  desk.style.backgroundImage = `url("${url}")`;
  Object.assign(desk.style, wallpaperFitStyle(getWallpaperFit(target, tier)));
}

async function applyBootWallpaper(ensureLoaded, tier) {
  const el = document.querySelector(`.${TEX_LAYER_CLASS}`);
  if (!el) return;
  if (ensureLoaded) {
    await loadWallpapers();
    if (!isSelectionResolvable(TARGET_BOOT, tier)
      || (getMode(TARGET_BOOT, tier) === 'texture' && !getSelectedTexture(TARGET_BOOT, tier))) {
      await loadWallpapers(true);
    }
  }
  const mode = getMode(TARGET_BOOT, tier);

  if (mode === 'color') {
    el.classList.add('no-mask');
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = getColorWallpaper(TARGET_BOOT, tier);
    return;
  }
  if (mode === 'texture') {
    const tex = getSelectedTexture(TARGET_BOOT, tier);
    if (tex) {
      el.classList.remove('no-mask');
      el.style.backgroundImage = '';
      el.style.backgroundColor = '';
      el.style.setProperty('--qx-tex-src', `url("${tex.url}")`);
      el.style.setProperty('--qx-tex-size', textureTileSize(tex, TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-base', getTextureBase(TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-line', getTextureLine(TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-a', String(getTextureAlpha(TARGET_BOOT, tier)));
      return;
    }
  }

  el.classList.add('no-mask');
  el.style.backgroundColor = '';
  const url = getDefaultWallpaper(TARGET_BOOT, tier);
  el.style.backgroundImage = url ? `url("${url}")` : 'none';
  if (url) Object.assign(el.style, wallpaperFitStyle(getWallpaperFit(TARGET_BOOT, tier)));
}
