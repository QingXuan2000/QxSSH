/**
 * core/storage.js —— localStorage 读写安全包装
 * 要点：在隐私模式或存储被禁用时静默降级，避免各处重复写 try/catch。
 */
/** 读取本地存储项，失败或不存在时返回默认值 */
export function lsGet(key, def = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? def : v;
  } catch {
    return def;
  }
}

/** 写入本地存储项，失败时静默忽略 */
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    return;
  }
}
