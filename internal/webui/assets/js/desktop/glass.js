/**
 * desktop/glass.js —— 毛玻璃（玻璃拟态）强度控制
 * 要点：读写玻璃强度偏好并落到根元素的 --glass-a 变量上，供窗口与面板统一取用。
 */
import { getPref, setPref, delPref } from '../core/prefs.js';

const KEY = 'qx-glass-a';

/** 玻璃强度下限 */
export const GLASS_MIN = 0;
/** 玻璃强度上限 */
export const GLASS_MAX = 2;
const DEFAULT = 1;

const PRECISION = 2;

function clamp(v) {
  return Math.min(GLASS_MAX, Math.max(GLASS_MIN, v));
}

/** 取当前玻璃强度，超出范围时夹到上下限 */
export function getGlassAlpha() {
  const n = parseFloat(getPref(KEY, String(DEFAULT)));
  if (!Number.isFinite(n)) return DEFAULT;
  return clamp(n);
}

/** 把玻璃强度写入根元素的 --glass-a 变量 */
export function applyGlass() {
  const el = document.documentElement;
  if (el) el.style.setProperty('--glass-a', String(getGlassAlpha()));
}

/** 设置并保存玻璃强度，返回实际生效值 */
export function setGlassAlpha(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return DEFAULT;
  const safe = Number(clamp(n).toFixed(PRECISION));
  setPref(KEY, String(safe));
  document.documentElement.style.setProperty('--glass-a', String(safe));
  return safe;
}

/** 恢复默认玻璃强度 */
export function resetGlassAlpha() {
  delPref(KEY);
  applyGlass();
  return DEFAULT;
}
