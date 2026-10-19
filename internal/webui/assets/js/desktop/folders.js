/**
 * desktop/folders.js —— 桌面文件夹（图标分组）的存储与整理
 * 要点：按主机维度持久化文件夹定义，读取时清理非法或重复的应用 id，并负责新建文件夹。
 */
import { getPref, setJSONPref } from '../core/prefs.js';
import { t, tf } from '../core/i18n.js';
const VERSION = 1;
let sequence = 0;

/** 按主机拼装文件夹配置的偏好键名 */
export function folderKey(hostId) {
  return `qx-desktop-folders-${hostId}`;
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 60) || t('core.desktop.new-folder');
}

function uniqueIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))];
}

/** 保存某主机的文件夹定义 */
export function save(key, folders) {
  try {
    setJSONPref(key, { version: VERSION, folders });
    return true;
  } catch (err) {
    console.warn('[desktop] 文件夹保存失败', err);
    return false;
  }
}

/** 读取并清洗文件夹定义，可开关是否剔除已不存在的应用 */
export function load(key, validAppIds, { pruneUnknown = true } = {}) {
  const valid = new Set(Array.isArray(validAppIds) ? validAppIds : []);
  let parsed = null;
  try {
    const raw = getPref(key, '');
    if (raw) parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[desktop] 文件夹读取失败', err);
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.folders && typeof parsed.folders === 'object' && !Array.isArray(parsed.folders) ? parsed.folders : parsed)
    : {};
  const folders = {};
  const usedApps = new Set();
  for (const [id, value] of Object.entries(source)) {
    if (!id || valid.has(id) || !value || typeof value !== 'object') continue;
    const appIds = uniqueIds(value.appIds).filter((appId) => (valid.has(appId) || !pruneUnknown) && !usedApps.has(appId));
    if (!appIds.length) continue;
    for (const appId of appIds) usedApps.add(appId);
    folders[id] = { id, name: cleanName(value.name), appIds };
  }
  if (parsed?.version !== VERSION || JSON.stringify(folders) !== JSON.stringify(source)) save(key, folders);
  return folders;
}

/** 生成一个新文件夹，自动取不重复的 id 与名称 */
export function createFolder(folders, appIds) {
  const used = new Set([...Object.keys(folders || {}), ...uniqueIds(appIds)]);
  const names = new Set(Object.values(folders || {}).map((folder) => folder.name));
  let index = 1;
  let name = t('core.desktop.new-folder');
  while (names.has(name)) {
    index += 1;
    name = tf('core.desktop.new-folder-n', { v1: index });
  }
  let id;
  do {
    sequence += 1;
    id = `qx-folder-${Date.now().toString(36)}-${sequence.toString(36)}`;
  } while (used.has(id));
  return { id, name, appIds: uniqueIds(appIds) };
}
