/**
 * desktop/ctxmenu.js —— 桌面右键菜单封装
 * 要点：在桌面、任务栏等处弹出上下文菜单，并登记已打开的菜单以便一次性全部关闭。
 */
import { menu } from '../core/components.js';

const opened = new Set();

/** 关闭当前已打开的所有右键菜单 */
export function closeAllMenus() {
  for (const rec of [...opened]) rec.close();
}

/** 在指定坐标弹出右键菜单，返回可关闭的句柄 */
export function contextMenu(items, { x = 0, y = 0, cls = '', zIndex = 1500 } = {}) {
  const rec = menu(items, { x, y, cls, zIndex, onClose: () => opened.delete(rec) });
  opened.add(rec);
  return rec;
}
