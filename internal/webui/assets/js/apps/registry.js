/**
 * apps/registry.js —— 应用注册表
 * 要点：维护全局应用清单；桌面、开始菜单与任务栏据此列出应用，启动器按 id 取用。
 */
import { appCategoryKey } from './apptext.js';

const apps = new Map();

/** 注册（或覆盖）一个应用，补齐默认字段并计算分类 */
export function registerApp(app) {
  if (!app?.id || !app?.name || typeof app?.mount !== 'function') {
    throw new Error('registerApp: app must have id, name and mount');
  }
  if (apps.has(app.id)) {
    console.warn(`[registry] app ${app.id} already registered, overwriting`);
  }
  apps.set(app.id, {
    singleton: false,
    keywords: [],
    unmount() {},
    ...app,
  });
  const entry = apps.get(app.id);
  entry.categoryKey = appCategoryKey(entry);
}

/** 取全部已注册应用 */
export function getApps() {
  return [...apps.values()];
}

/** 取出现过的应用分类键 */
export function getCategories() {
  const out = [];
  for (const a of apps.values()) {
    if (a.categoryKey && !out.includes(a.categoryKey)) out.push(a.categoryKey);
  }
  return out;
}

/** 按 id 注销应用 */
export function unregisterApp(id) {
  apps.delete(id);
}

/** 按 id 取应用 */
export function getApp(id) {
  return apps.get(id);
}

/** 判断某 id 是否已注册 */
export function hasApp(id) {
  return apps.has(id);
}
