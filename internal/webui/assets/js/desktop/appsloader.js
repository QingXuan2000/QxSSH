/**
 * desktop/appsloader.js —— 用户应用加载器
 * 要点：从宿主读取已安装的应用包并重新登记到应用注册表，同时提供安装与卸载入口。
 */
import { registerApp, unregisterApp, getApps } from '../apps/registry.js';
import { emit } from '../core/bus.js';
import { toast } from '../core/ui.js';
import * as api from '../core/qxssh-api.js';
import { setupI18n, t, tf } from '../core/i18n.js';

setupI18n().catch(() => { });

let userAppsLoaded = false;

/** 是否已成功完成一次用户应用加载 */
export function isUserAppsLoaded() {
  return userAppsLoaded;
}

/** 取应用的入口页地址，越界或非法路径回退到 index.html */
export function userAppFrame(app) {
  let entry = String(app.entry || 'index.html').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!entry || entry.includes('..')) entry = 'index.html';
  return api.appFileUrl(app.id, entry);
}

/** 拉取已安装应用并重新注册（系统应用走内置路径） */
export async function loadUserApps() {
  let list = [];
  try {
    list = await api.listUserApps();
  } catch (err) {
    userAppsLoaded = false;
    console.warn('[store] 读取应用列表失败', err);
    return;
  }
  userAppsLoaded = true;
  for (const a of getApps().filter((x) => x.source === 'store' || x.source === 'builtin')) {
    unregisterApp(a.id);
  }
  for (const m of list) {
    if (!m.id || m.disabled === true) continue;
    const systemApp = m.systemApp === true;
    registerApp({
      ...m,
      source: systemApp ? 'builtin' : 'store',
      frame: systemApp ? `/apps/${encodeURIComponent(m.id)}/index.html` : userAppFrame(m),
      mount() { },
    });
  }
  emit('apps-changed');
}

/** 卸载用户应用并刷新注册表与提示 */
export async function uninstallUserApp(id, name) {
  try {
    await api.uninstallApp(id);
  } catch (err) {
    throw new Error(err.message || t('app.desktop.uninstall-failed'));
  }
  userAppsLoaded = true;
  unregisterApp(id);
  emit('apps-changed');
  toast(tf('app.desktop.uninstalled', { v1: name || id }), 'success');
}

/** 从下载地址安装应用包 */
export async function installFromUrl(url) {
  try {
    return await api.installApp({ url });
  } catch (err) {
    throw new Error(err.message || t('app.desktop.install-failed'));
  }
}

/** 从本地文件安装应用包 */
export async function installFromFile(file) {
  try {
    return await api.installApp(file);
  } catch (err) {
    throw new Error(err.message || t('app.desktop.install-failed'));
  }
}
