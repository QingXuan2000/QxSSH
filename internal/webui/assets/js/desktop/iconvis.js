/**
 * desktop/iconvis.js —— 桌面图标显隐状态
 * 要点：记录被隐藏的桌面图标 id，供桌面渲染与右键菜单判断。
 */
import { getJSONPref, setJSONPref } from '../core/prefs.js';

const KEY = 'qx-desktop-hidden-icons';

function read() {
  const v = getJSONPref(KEY, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
}

/** 判断某个图标是否被隐藏 */
export function isIconHidden(id) {
  return read().includes(String(id));
}

/** 设置图标隐藏状态并持久化 */
export function setIconHidden(id, hidden) {
  const key = String(id);
  const set = new Set(read());
  if (hidden) set.add(key);
  else set.delete(key);
  setJSONPref(KEY, [...set]);
  return !!hidden;
}

/** 取全部被隐藏的图标 id 集合 */
export function hiddenIconIds() {
  return new Set(read());
}
