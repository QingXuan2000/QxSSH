/**
 * core/prefs-cache.js —— 偏好缓存的最小读取入口
 * 要点：不依赖 prefs 模块即可读取本地缓存的偏好，供首屏在配置加载完成前使用。
 */
/** 偏好缓存在 localStorage 中的键名 */
export const PREFS_CACHE_KEY = 'qx-prefs-cache';

let memoryCache = null;

/** 更新偏好内存缓存，供沙箱 iframe 或独立环境优先读取 */
export function setCachedPrefs(prefs) {
  if (prefs && typeof prefs === 'object') {
    memoryCache = { ...(memoryCache || {}), ...prefs };
  }
}

/** 从缓存中读取偏好项，缺失时回退到同名的旧键 */
export function readCachedPref(key) {
  if (memoryCache && memoryCache[key] !== undefined) {
    const v = memoryCache[key];
    if (typeof v === 'string') return v;
  }
  try {
    const raw = localStorage.getItem(PREFS_CACHE_KEY);
    if (raw) {
      const v = JSON.parse(raw)[key];
      if (typeof v === 'string') return v;
    }
  } catch {
  }
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
