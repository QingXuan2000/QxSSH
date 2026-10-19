/**
 * desktop/desktop.js —— 桌面主界面的装配入口
 * 要点：组装壁纸、图标网格、文件夹、任务栏与开始菜单，绑定窗口管理器与宿主钩子；桌面页面加载后自行运行。
 */
import { $, fmtSize, fmtRate, createPoller } from '../core/dom.js';
import { h, dom, createView, useState } from '../core/vdom.js';
import { signal } from '../core/signal.js';
import { appIcon } from '../icons/index.js';
import { loadHosts, setWorkspace, getState, clearWorkspace } from '../core/store.js';
import { toast, confirmAction } from '../core/ui.js';
import { dialog } from '../core/components.js';
import { prefsAll } from '../core/qxssh-api.js';
import { collectMetrics } from '../core/hostprobe.js';
import { loadPrefs, flushPrefs } from '../core/prefs.js';
import { PREFS_CACHE_KEY } from '../core/prefs-cache.js';
import { WindowManager } from '../wm/manager.js';
import { getApps } from '../apps/registry.js';
import { appName } from '../apps/apptext.js';
import {
  layoutKey,
  load as loadIconLayout,
  save as saveIconLayout,
  reconcile as reconcileIconLayout,
  prune as pruneIconLayout,
  arrange as arrangeIconLayout,
} from './iconlayout.js';
import {
  folderKey,
  load as loadFolderState,
  save as saveFolderState,
  createFolder as createFolderState,
} from './folders.js';
import { Taskbar, taskbarButtonRect } from './taskbar.js';
import { StartMenu } from './startmenu.js';
import { setHostHooks } from '../core/host-hooks.js';
import { contextMenu, closeAllMenus } from './ctxmenu.js';
import { loadUserApps, isUserAppsLoaded } from './appsloader.js';
import { on as onBus } from '../core/bus.js';
import { applyWallpaper } from './wallpaper.js';
import { applyGlass } from './glass.js';
import { hiddenIconIds } from './iconvis.js';
import { setupI18n, t, tf, lang, onLangChange } from '../core/i18n.js';

const params = new URLSearchParams(location.search);
const hostId = params.get('host');
const initialApp = params.get('app');
const initialTab = params.get('tab');
const wm = new WindowManager();
const DESKTOP_LAYOUT_KEY = layoutKey(hostId);
const DESKTOP_FOLDERS_KEY = folderKey(hostId);
let activeFolders = {};
let activeIconLayout = null;

const startOpen = signal(false);
const folderRev = signal(0);

const iconState = {
  host: null,
  items: [],
  itemMap: new Map(),
  els: new Map(),
  layout: {},
  cellW: 100,
  cellH: 113,
  cols: 4,
  lastGrid: null,
  drag: null,
  bound: false,
};
const iconModel = signal(null);

function openApp(app, opts = {}) {
  try {
    if (app.singleton && !opts.forceNew && wm.findByAppId(app.id)) {
      const win = wm.findByAppId(app.id);
      win.focus();

      if (opts.initialTab && app.id === 'settings') {
        const frame = win.bodyEl.querySelector('iframe');
        if (frame) {
          const u = new URL(frame.getAttribute('src'), location.href);
          if (u.searchParams.get('tab') !== opts.initialTab) {
            u.searchParams.set('tab', opts.initialTab);
            frame.src = u.toString();
          }
        }
      }
      return;
    }
    const ps = app.preferredSize || {};
    const q = new URLSearchParams();
    if (opts.cwd) q.set('cwd', opts.cwd);
    if (opts.initialTab) q.set('tab', opts.initialTab);
    if (opts.qxapi) q.set('qxapi', String(opts.qxapi));
    const frameSrc = app.frame ? `${app.frame}${q.toString() ? '?' + q.toString() : ''}` : '';
    const frameOpts = app.frame
      ? { frame: { src: frameSrc, hostId } }
      : {
          content: (el, win) => {
            app.mount(el, { ...opts, hostId, win });
          },
        };
    const win = wm.open({
      appId: app.id,
      dev: app.dev === true,
      title: appName(app),
      icon: appIcon(app.icon || app.id, 'qicon qicon-sm', app.id),
      width: ps.width,
      height: ps.height,
      minWidth: ps.minWidth,
      minHeight: ps.minHeight,
      ...frameOpts,
      onClose: (win) => {
        try { app.unmount(win); } catch (e) { console.error(e); }
      },
    });
    win._titleCustom = false;
  } catch (err) {
    console.error('[desktop] openApp failed', err);
    toast(t('app.desktop.open-app-failed') + err.message, 'error');
  }
}

function openFolder(folderId) {
  const folder = activeFolders[folderId];
  if (!folder) return;
  const appId = `folder:${folderId}`;
  const existing = wm.findByAppId(appId);
  if (existing) {
    existing.focus();
    return;
  }
  const win = wm.open({
    appId,
    title: folder.name,
    icon: appIcon('folder', 'qicon qicon-sm'),
    width: 560,
    height: 420,
    minWidth: 360,
    minHeight: 260,
    autoSize: false,
    content: (el, w) => {
      w._folderId = folderId;
      const view = createView(el);
      view.update(() => folderTree(folderId));
      return () => view.unmount();
    },
  });
  win.addClass('qx-folder-host');
}

function folderTree(folderId) {
  void folderRev.value;
  const folder = activeFolders[folderId];
  if (!folder) return h('div', { class: 'qx-folder-empty', text: t('app.desktop.folder-missing') });
  const apps = new Map(getApps().map((app) => [app.id, app]));
  const children = folder.appIds.map((id) => apps.get(id)).filter(Boolean);
  if (!children.length) {
    return h('div', { class: 'qx-folder-window' }, [
      h('div', { class: 'qx-folder-empty' }, [
        h('span', { class: 'qx-folder-empty-title', text: t('app.desktop.folder-empty') }),
        h('span', { class: 'qx-folder-empty-desc', text: t('app.desktop.folder-empty-hint') }),
      ]),
    ]);
  }
  return h('div', { class: 'qx-folder-window' }, [
    h('div', {
      class: 'qx-folder-grid',
      onPointerdown: folderGridDown,
      onPointermove: folderGridMove,
      onPointerup: folderGridUp,
      onPointercancel: folderGridUp,
    }, children.map((app) => h('button', {
      key: app.id,
      class: 'qx-folder-item',
      type: 'button',
      dataset: { appId: app.id, tip: appName(app) },
      onClick: () => {
        if (folderDrag.suppressClick) { folderDrag.suppressClick = false; return; }
        openApp(app);
      },
    }, [
      h('span', { class: 'qx-folder-item-ic', html: appIcon(app.icon || app.id, 'qicon', app.id) }),
      h('span', { class: 'qx-folder-item-name', text: appName(app) }),
    ]))),
  ]);
}

const folderDrag = { state: null, suppressClick: false };

function folderIdOf(gridEl) {
  const win = wm.getWindows().find((w) => w.bodyEl && w.bodyEl.contains(gridEl));
  return win ? win._folderId || null : null;
}

function folderGridDown(e) {
  if (e.button !== 0) return;
  const itemEl = e.target.closest?.('.qx-folder-item');
  if (!itemEl) return;
  const appId = itemEl.dataset.appId;
  const app = getApps().find((entry) => entry.id === appId);
  if (!app) return;
  folderDrag.suppressClick = false;
  folderDrag.state = {
    app,
    appId,
    itemEl,
    folderId: folderIdOf(e.currentTarget),
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    dropTargetId: null,
    clone: null,
    pointerId: e.pointerId,
  };
  try { itemEl.setPointerCapture(e.pointerId); } catch { }
}

function folderGridMove(e) {
  const d = folderDrag.state;
  if (!d) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    folderDrag.suppressClick = true;
    d.itemEl.classList.add('qx-folder-item-dragging');
    d.clone = createDragClone(d.app, e.clientX, e.clientY);
    document.body.classList.add('icon-dragging');
  }
  moveDragClone(d.clone, e.clientX, e.clientY);
  setDesktopDropHighlight(d, findDesktopDropTarget(e.clientX, e.clientY, d.folderId));
}

function folderGridUp(e) {
  const d = folderDrag.state;
  if (!d) return;
  folderDrag.state = null;
  const cancelled = e?.type === 'pointercancel';
  const targetId = cancelled ? null : d.dropTargetId;
  if (d.moved) {
    d.itemEl.classList.remove('qx-folder-item-dragging');
    removeDragClone(d.clone);
    document.body.classList.remove('icon-dragging');
  }
  clearDesktopDropHighlight(d);
  try { d.itemEl.releasePointerCapture(d.pointerId); } catch { }
  if (cancelled || !d.moved) return;

  const sourceEl = deskIconById(d.folderId);
  if (sourceEl) {
    const rect = sourceEl.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom) return;
  }
  if (targetId) {
    extractAppFromFolder(d.appId, d.folderId, { targetId });
    return;
  }
  const cell = desktopCellAt(e.clientX, e.clientY);
  if (cell) extractAppFromFolder(d.appId, d.folderId, { cell });
}

function openSettingsTab(tab) {
  const app = getApps().find((a) => a.id === 'settings');
  if (!app) return;
  openApp(app, { initialTab: tab });
}

const GRID_GAP_X = 16;
const GRID_GAP_Y = 18;

function getDesktopModel() {
  const apps = getApps();
  const validIds = new Set(apps.map((app) => app.id));
  const hidden = hiddenIconIds();
  let folders = loadFolderState(DESKTOP_FOLDERS_KEY, [...validIds], { pruneUnknown: isUserAppsLoaded() });
  const layout = { ...(activeIconLayout || loadIconLayout(DESKTOP_LAYOUT_KEY)) };
  const normalized = dissolveSingleAppFolders(folders, layout, validIds);
  if (normalized !== folders) {
    folders = normalized;
    saveFolderState(DESKTOP_FOLDERS_KEY, folders);
    saveIconLayout(DESKTOP_LAYOUT_KEY, layout);
    activeIconLayout = layout;
  }
  activeFolders = folders;
  const contained = new Set();
  for (const folder of Object.values(folders)) {
    for (const appId of folder.appIds) contained.add(appId);
  }
  const items = [];
  for (const app of apps) {
    if (contained.has(app.id) || hidden.has(app.id)) continue;
    items.push({ kind: 'app', id: app.id, app });
  }
  for (const folder of Object.values(folders)) {
    items.push({ kind: 'folder', id: folder.id, folder });
  }
  return { apps, folders, items, itemMap: new Map(items.map((item) => [item.id, item])) };
}

function measureIconGrid(container) {
  const cells = container ? [...container.querySelectorAll('.desk-icon')] : [];
  if (!cells.length || !container.clientWidth || !container.clientHeight) return null;
  let cellW = 0;
  let cellH = 0;
  for (const cell of cells) {
    cellW = Math.max(cellW, cell.offsetWidth);
    cellH = Math.max(cellH, cell.offsetHeight);
  }
  cellW += GRID_GAP_X;
  cellH += GRID_GAP_Y;
  return {
    cellW,
    cellH,
    cols: Math.max(1, Math.floor((container.clientWidth + GRID_GAP_X) / cellW)),
    rows: Math.max(1, Math.floor((container.clientHeight + GRID_GAP_Y) / cellH)),
  };
}

function folderPreviewSlots(folder, appMap) {
  const preview = folder.appIds.map((id) => appMap.get(id)).filter(Boolean).slice(0, 4);
  return preview.map((app) => h('span', {
    key: app.id,
    class: 'desk-folder-mini',
    dataset: { previewAppId: app.id },
    html: appIcon(app.icon || app.id, 'qicon', app.id),
  }));
}

function deskIconNode(item, appMap) {
  const isFolder = item.kind === 'folder';
  const name = isFolder ? item.folder.name : appName(item.app);
  const ds = { itemId: item.id, tip: name };
  if (isFolder) ds.folderId = item.id;
  else ds.appId = item.id;
  const iconEl = isFolder
    ? h('span', { class: 'desk-icon-ic' }, [
      h('span', { class: 'desk-folder-preview' }, folderPreviewSlots(item.folder, appMap)),
    ])
    : h('span', {
      class: 'desk-icon-ic',
      html: appIcon(item.app.icon || item.app.id, 'qicon', item.app.id),
    });
  return h('button', {
    key: item.id,
    ref: (el) => { if (el) iconState.els.set(item.id, el); },
    class: `desk-icon ${isFolder ? 'desk-folder' : 'desk-app'}`,
    type: 'button',
    dataset: ds,
    onContextmenu: (e) => {
      e.preventDefault();
      if (!isFolder) return;
      e.stopPropagation();
      showFolderMenu(e, item.id);
    },
  }, [
    iconEl,
    h('span', { class: 'desk-icon-label', text: name }),
  ]);
}

function deskIconsTree() {
  const model = iconModel.value;
  return model ? model.items.map((item) => deskIconNode(item, model.appMap)) : [];
}

function refreshDesktopIcons() {
  const host = iconState.host;
  const grid = measureIconGrid(host);
  const model = buildIconModel(grid);
  const scrollLeft = host ? host.scrollLeft : 0;
  const scrollTop = host ? host.scrollTop : 0;
  iconState.els.clear();
  iconModel.next = model;
  requestAnimationFrame(() => {
    layoutIcons();
    if (host) {
      host.scrollLeft = scrollLeft;
      host.scrollTop = scrollTop;
    }
    syncFolderWindows();
  });
}

function buildIconModel(grid) {
  const { items, apps } = getDesktopModel();
  const appMap = new Map(apps.map((app) => [app.id, app]));
  const ids = items.map((item) => item.id);
  const preserveUnknown = !isUserAppsLoaded();

  if (!preserveUnknown) pruneIconLayout(DESKTOP_LAYOUT_KEY, ids);
  const saved = loadIconLayout(DESKTOP_LAYOUT_KEY);
  const fallbackCols = Object.values(saved).reduce((m, cell) => Math.max(m, cell.col + 1), 1);
  const cols = grid?.cols || fallbackCols;
  const layout = reconcileIconLayout(DESKTOP_LAYOUT_KEY, ids, cols, Infinity, {
    preserveUnknown,
    placeRows: grid?.rows,
    persist: !!grid,
  });
  activeIconLayout = layout;
  iconState.layout = layout;
  iconState.items = items;
  iconState.itemMap = new Map(items.map((item) => [item.id, item]));
  return { items, appMap };
}

function getDesktopTidyOrder(items, mode = 'name') {
  const currentLang = lang();
  const itemName = (item) => (item.kind === 'folder' ? item.folder.name : appName(item.app));
  const saved = activeIconLayout || loadIconLayout(DESKTOP_LAYOUT_KEY) || {};
  const cellOf = (id) => saved[id] || { col: 1e9, row: 1e9 };

  return items.slice().sort((a, b) => {
    const isFolderA = a.kind === 'folder';
    const isFolderB = b.kind === 'folder';

    if (mode === 'type') {
      const typeRank = (it) => {
        if (it.kind === 'folder') return 0;
        return it.app.systemApp ? 1 : 2;
      };
      const rankDiff = typeRank(a) - typeRank(b);
      if (rankDiff !== 0) return rankDiff;
      const nameDiff = itemName(a).localeCompare(itemName(b), currentLang);
      if (nameDiff !== 0) return nameDiff;
      return a.id.localeCompare(b.id);
    }

    if (mode === 'compact') {
      const cellA = cellOf(a.id);
      const cellB = cellOf(b.id);
      const geomDiff = (cellA.col - cellB.col) || (cellA.row - cellB.row);
      if (geomDiff !== 0) return geomDiff;
      if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
      const nameDiff = itemName(a).localeCompare(itemName(b), currentLang);
      if (nameDiff !== 0) return nameDiff;
      return a.id.localeCompare(b.id);
    }

    if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
    const nameDiff = itemName(a).localeCompare(itemName(b), currentLang);
    if (nameDiff !== 0) return nameDiff;
    return a.id.localeCompare(b.id);
  }).map((item) => item.id);
}

function arrangeDesktopIcons(mode = 'name') {
  const container = iconState.host;
  if (!isUserAppsLoaded()) return false;
  const { items } = getDesktopModel();
  if (!container || !items.length) return false;
  const grid = measureIconGrid(container);
  if (!grid) return false;

  const order = getDesktopTidyOrder(items, mode);
  const arranged = arrangeIconLayout(
    DESKTOP_LAYOUT_KEY,
    order,
    grid.cols,
    grid.rows,
    { preserveOthers: true },
  );
  if (!arranged) {
    toast(t('app.desktop.layout-save-failed'), 'error');
    return false;
  }
  activeIconLayout = arranged;
  iconState.layout = arranged;

  for (const [id, cell] of Object.entries(arranged)) {
    const el = iconState.els.get(id);
    if (!el || !cell) continue;
    el.style.position = 'absolute';
    el.style.width = '84px';
    el.style.transition = 'left .24s cubic-bezier(0.2, 0, 0, 1), top .24s cubic-bezier(0.2, 0, 0, 1)';
    el.style.left = `${cell.col * grid.cellW}px`;
    el.style.top = `${cell.row * grid.cellH}px`;
  }

  setTimeout(() => {
    for (const id of Object.keys(arranged)) {
      const el = iconState.els.get(id);
      if (el) el.style.transition = '';
    }
    syncFolderWindows();
  }, 260);

  return true;
}

function createFolderFromItems(sourceId, targetId, layout) {
  const { folders, itemMap } = getDesktopModel();
  const source = itemMap.get(sourceId);
  const target = itemMap.get(targetId);
  if (!source || !target || sourceId === targetId) return false;

  const next = { ...folders };
  let message;
  if (source.kind === 'app' && target.kind === 'app') {
    const folder = createFolderState(next, [source.app.id, target.app.id]);
    next[folder.id] = folder;
    const cell = layout[targetId] || layout[sourceId];
    delete layout[sourceId];
    delete layout[targetId];
    if (cell) layout[folder.id] = { ...cell };
    message = t('app.desktop.folder-created');
  } else if (source.kind === 'app' && target.kind === 'folder') {
    next[target.id] = {
      ...target.folder,
      appIds: [...new Set([...target.folder.appIds, source.app.id])],
    };
    delete layout[sourceId];
    message = t('app.desktop.added-to-folder');
  } else if (source.kind === 'folder' && target.kind === 'app') {
    next[source.id] = {
      ...source.folder,
      appIds: [...new Set([...source.folder.appIds, target.app.id])],
    };
    delete layout[targetId];
    message = t('app.desktop.added-to-folder');
  } else {
    next[target.id] = {
      ...target.folder,
      appIds: [...new Set([...target.folder.appIds, ...source.folder.appIds])],
    };
    delete next[source.id];
    delete layout[source.id];
    wm.findByAppId(`folder:${source.id}`)?.close();
    message = t('app.desktop.folders-merged');
  }
  const foldersSaved = saveFolderState(DESKTOP_FOLDERS_KEY, next);
  const layoutSaved = saveIconLayout(DESKTOP_LAYOUT_KEY, layout);
  if (!foldersSaved || !layoutSaved) {
    toast(t('app.desktop.folder-save-failed'), 'error');
    refreshDesktopIcons();
    return false;
  }
  toast(message, 'success');
  refreshDesktopIcons();
  return true;
}

function deskIconById(id) {
  return iconState.els.get(id) || null;
}

function findDesktopDropTarget(x, y, excludeId) {
  const top = document.elementFromPoint(x, y);
  if (!top || !top.closest('#desk-icons')) return null;
  for (const [id, el] of iconState.els) {
    if (id === excludeId) continue;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    if (x >= rect.left - pad && x <= rect.right + pad
      && y >= rect.top - pad && y <= rect.bottom + pad) return id;
  }
  return null;
}

function setDesktopDropHighlight(state, id) {
  if (state.dropTargetId === id) return;
  if (state.dropTargetId) deskIconById(state.dropTargetId)?.classList.remove('folder-drop-target');
  state.dropTargetId = id || null;
  if (id) deskIconById(id)?.classList.add('folder-drop-target');
}

function clearDesktopDropHighlight(state) {
  setDesktopDropHighlight(state, null);
}

function desktopCellAt(x, y) {
  const container = iconState.host;
  if (!container) return null;
  const top = document.elementFromPoint(x, y);
  if (!top || !top.closest('#desk-icons')) return null;
  const rect = container.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const grid = measureIconGrid(container);
  if (!grid) return null;
  const saved = activeIconLayout || loadIconLayout(DESKTOP_LAYOUT_KEY);
  const maxLayoutCol = Object.values(saved).reduce((m, cell) => Math.max(m, cell?.col || 0), -1);
  const maxCol = Math.max(grid.cols, maxLayoutCol + 1);
  const localX = x - rect.left + container.scrollLeft;
  const localY = y - rect.top + container.scrollTop;
  const col = Math.max(0, Math.min(maxCol, Math.round(localX / grid.cellW)));
  const row = Math.max(0, Math.round(localY / grid.cellH));
  return { col, row };
}

function createDragClone(app, x, y) {
  const el = dom('span', {
    class: 'desk-icon-ic desk-drag-clone',
    html: appIcon(app.icon || app.id, 'qicon', app.id),
  });
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.append(el);
  return el;
}

function moveDragClone(el, x, y) {
  if (!el) return;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function removeDragClone(el) {
  el?.remove();
}

function placeAt(layout, id, cell) {
  const occupied = Object.entries(layout).some(([other, c]) =>
    other !== id && c && c.col === cell.col && c.row === cell.row);
  if (!occupied) layout[id] = { ...cell };
}

function dissolveSingleAppFolders(folders, layout, validIds) {
  const singles = Object.values(folders).filter((folder) =>
    folder.appIds.length === 1 && validIds.has(folder.appIds[0]));
  if (!singles.length) return folders;
  const next = { ...folders };
  for (const folder of singles) {
    const appId = folder.appIds[0];
    const cell = layout[folder.id];
    delete next[folder.id];
    delete layout[folder.id];
    if (cell) placeAt(layout, appId, cell);
  }
  return next;
}

function extractAppFromFolder(appId, sourceFolderId, { targetId = null, cell = null } = {}) {
  if (sourceFolderId === targetId || (!targetId && !cell)) return false;
  const { folders, itemMap } = getDesktopModel();
  const source = folders[sourceFolderId];
  if (!source || !source.appIds.includes(appId)) return false;

  const nextFolders = { ...folders };
  const rest = source.appIds.filter((id) => id !== appId);
  const layout = { ...(activeIconLayout || loadIconLayout(DESKTOP_LAYOUT_KEY)) };
  const sourceCell = layout[sourceFolderId];
  if (rest.length > 1) {
    nextFolders[sourceFolderId] = { ...source, appIds: rest };
  } else {
    delete nextFolders[sourceFolderId];
    delete layout[sourceFolderId];
    if (rest.length === 1 && sourceCell) placeAt(layout, rest[0], sourceCell);
  }
  let message = t('app.desktop.removed-from-folder');

  if (targetId) {
    const target = itemMap.get(targetId);
    if (!target) return false;
    if (target.kind === 'folder') {
      const targetFolder = nextFolders[target.id];
      if (!targetFolder) return false;
      nextFolders[target.id] = {
        ...targetFolder,
        appIds: [...new Set([...targetFolder.appIds, appId])],
      };
      message = t('app.desktop.added-to-folder');
    } else {
      const targetCell = layout[target.id] || cell;
      const folder = createFolderState(nextFolders, [target.id, appId]);
      nextFolders[folder.id] = folder;
      delete layout[target.id];
      if (targetCell) layout[folder.id] = { ...targetCell };
      message = t('app.desktop.removed-and-merged');
    }
  } else {
    placeAt(layout, appId, cell);
  }

  if (!saveFolderState(DESKTOP_FOLDERS_KEY, nextFolders)) {
    toast(t('app.desktop.folder-save-failed'), 'error');
    refreshDesktopIcons();
    return false;
  }
  if (!saveIconLayout(DESKTOP_LAYOUT_KEY, layout)) {
    toast(t('app.desktop.layout-save-failed'), 'error');
    refreshDesktopIcons();
    return false;
  }
  activeFolders = nextFolders;
  toast(message, 'success');
  refreshDesktopIcons();
  return true;
}

function layoutIcons(except) {
  const container = iconState.host;
  if (!container) return;
  const grid = measureIconGrid(container);
  if (!grid) return;
  iconState.cellW = grid.cellW;
  iconState.cellH = grid.cellH;
  iconState.cols = grid.cols;

  const layout = iconState.layout;
  if ((!iconState.lastGrid || iconState.lastGrid.cols !== grid.cols
    || iconState.lastGrid.rows !== grid.rows) && !iconState.drag) {
    syncIconLayout(grid);
  }
  for (const [id, cell] of Object.entries(layout)) {
    const el = iconState.els.get(id);
    if (!el || el === except || !cell) continue;
    const col = Math.max(0, cell.col);
    const row = Math.max(0, cell.row);
    el.style.position = 'absolute';
    el.style.width = '84px';
    el.style.left = `${col * iconState.cellW}px`;
    el.style.top = `${row * iconState.cellH}px`;

    el.style.transition = except ? 'left .16s ease, top .16s ease' : '';
  }
  if (!except) {
    const maxCol = Object.values(layout).reduce((m, cell) => Math.max(m, cell?.col || 0), 0);
    const right = (maxCol + 1) * iconState.cellW;
    if (right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = right - container.clientWidth;
    }
  }
}

function syncIconLayout(grid) {
  const layout = iconState.layout;
  const ids = iconState.items.map((item) => item.id);
  const synced = reconcileIconLayout(DESKTOP_LAYOUT_KEY, ids, grid.cols, Infinity, {
    preserveUnknown: !isUserAppsLoaded(),
    placeRows: grid.rows,
  });
  for (const id of Object.keys(layout)) delete layout[id];
  Object.assign(layout, synced);
  activeIconLayout = layout;
  iconState.lastGrid = grid;
}

function bindIconGrid(container) {
  iconState.host = container;
  if (iconState.bound) return;
  iconState.bound = true;

  const appAt = (col, row) => {
    for (const [id, c] of Object.entries(iconState.layout)) {
      if (c && c.col === col && c.row === row) return id;
    }
    return null;
  };

  const setDropTarget = (id) => {
    const drag = iconState.drag;
    if (!drag || drag.dropTargetId === id) return;
    const prevEl = drag.dropTargetId ? iconState.els.get(drag.dropTargetId) : null;
    prevEl?.classList.remove('folder-drop-target');
    drag.dropTargetId = id || null;
    if (id) iconState.els.get(id)?.classList.add('folder-drop-target');
  };

  const clearDropTarget = () => {
    const drag = iconState.drag;
    if (!drag) return;
    if (drag.dropTargetId) {
      iconState.els.get(drag.dropTargetId)?.classList.remove('folder-drop-target');
    }
    drag.dropTargetId = null;
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.desk-icon');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const id = el.dataset.itemId;
    const item = iconState.itemMap.get(id);
    if (!item) return;
    const previewEl = e.target.closest('[data-preview-app-id]');
    const previewAppId = item.kind === 'folder' ? previewEl?.dataset.previewAppId : null;
    const previewApp = previewAppId ? getApps().find((app) => app.id === previewAppId) : null;
    iconState.drag = {
      id,
      item,
      el,
      mode: previewApp ? 'extract' : 'icon',
      previewApp,
      previewEl: previewApp ? previewEl : null,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      dropTargetId: null,
      oldCell: { ...iconState.layout[id] },
      initialLayout: Object.fromEntries(
        Object.entries(iconState.layout).map(([itemId, cell]) => [itemId, { ...cell }]),
      ),
      pointerId: e.pointerId,
    };
    try { el.setPointerCapture(e.pointerId); } catch { }
  });

  container.addEventListener('pointermove', (e) => {
    const drag = iconState.drag;
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      drag.moved = true;
      if (drag.mode === 'extract') {
        drag.previewEl?.classList.add('is-extracting');
        drag.clone = createDragClone(drag.previewApp, e.clientX, e.clientY);
      } else {
        drag.el.classList.add('dragging');
      }
      document.body.classList.add('icon-dragging');
    }
    if (drag.mode === 'extract') {
      moveDragClone(drag.clone, e.clientX, e.clientY);
      setDropTarget(findDesktopDropTarget(e.clientX, e.clientY, drag.id));
      return;
    }
    const l = iconState.layout;
    const cb = container.getBoundingClientRect();
    const left = e.clientX - cb.left - drag.grabX + container.scrollLeft;
    const top = e.clientY - cb.top - drag.grabY + container.scrollTop;
    drag.el.style.transition = 'none';
    drag.el.style.position = 'absolute';
    drag.el.style.width = '84px';
    drag.el.style.left = `${left}px`;
    drag.el.style.top = `${top}px`;

    setDropTarget(findDesktopDropTarget(e.clientX, e.clientY, drag.id));
    if (drag.dropTargetId) return;

    const maxLayoutCol = Object.values(l).reduce((m, cell) => Math.max(m, cell?.col || 0), -1);
    const maxCol = Math.max(iconState.cols, maxLayoutCol + 1);
    const col = Math.max(0, Math.min(maxCol, Math.round(left / iconState.cellW)));
    const row = Math.max(0, Math.round(top / iconState.cellH));

    const occupant = appAt(col, row);
    if (occupant && occupant !== drag.id) {
      l[occupant] = { ...drag.oldCell };
      l[drag.id] = { col, row };
      drag.oldCell = { col, row };
      layoutIcons(drag.el);
    } else if (!occupant) {
      l[drag.id] = { col, row };
      drag.oldCell = { col, row };
      layoutIcons(drag.el);
    }
  });

  function endDrag(e) {
    const drag = iconState.drag;
    if (!drag) return;
    iconState.drag = null;
    const l = iconState.layout;
    const cancelled = e?.type === 'pointercancel';
    const dropTargetId = cancelled ? null : drag.dropTargetId;
    if (drag.moved) {
      if (drag.mode === 'extract') {
        drag.previewEl?.classList.remove('is-extracting');
        removeDragClone(drag.clone);
      } else {
        drag.el.classList.remove('dragging');
      }
      document.body.classList.remove('icon-dragging');
    }
    clearDropTarget();
    try { drag.el.releasePointerCapture(drag.pointerId); } catch { }

    if (drag.mode === 'extract') {
      if (cancelled || !drag.moved) {
        if (!cancelled && !drag.moved) openFolder(drag.id);
        return;
      }
      const sourceRect = drag.el.getBoundingClientRect();
      const overSource = e.clientX >= sourceRect.left && e.clientX <= sourceRect.right
        && e.clientY >= sourceRect.top && e.clientY <= sourceRect.bottom;
      if (!dropTargetId && overSource) return;
      const cell = dropTargetId ? null : desktopCellAt(e.clientX, e.clientY);
      if (dropTargetId || cell) {
        extractAppFromFolder(drag.previewApp.id, drag.id, { targetId: dropTargetId, cell });
      }
      return;
    }

    if (cancelled) {
      for (const id of Object.keys(l)) delete l[id];
      Object.assign(l, drag.initialLayout);
      layoutIcons();
      return;
    }
    if (dropTargetId) {
      createFolderFromItems(drag.id, dropTargetId, l);
      return;
    }
    if (!drag.moved) {
      if (drag.item.kind === 'folder') openFolder(drag.id);
      else openApp(drag.item.app);
      return;
    }
    const cell = l[drag.id];
    if (!cell) return;
    drag.el.style.transition = 'left .16s ease, top .16s ease';
    drag.el.style.left = `${cell.col * iconState.cellW}px`;
    drag.el.style.top = `${cell.row * iconState.cellH}px`;
    if (!saveIconLayout(DESKTOP_LAYOUT_KEY, l)) {
      toast(t('app.desktop.layout-save-failed'), 'error');
      return;
    }
    layoutIcons();
  }

  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => layoutIcons());
}

const HIST = 80;
const POLL_MS = 3000;

let uPlotLib = null;
let uPlotPromise = null;
function loadUPlot() {
  if (!uPlotPromise) {
    uPlotPromise = import('../../vendor/uplot.esm.js')
      .then((m) => { uPlotLib = m.default || m; })
      .catch((err) => { console.warn('[desktop] 图表库加载失败，网络与存储曲线不可用', err); });
  }
  return uPlotPromise;
}

function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return `rgba(0,55,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fmtAxis(v) {
  if (!Number.isFinite(v)) return '';
  if (v <= 0) return '0';
  return fmtRate(v);
}

function makeChart(el) {
  const uPlot = uPlotLib;
  if (!uPlot || !el) return null;
  const cs = getComputedStyle(document.documentElement);
  const primary = cs.getPropertyValue('--primary').trim() || '#0037ff';
  const success = cs.getPropertyValue('--success').trim() || '#34c759';
  const axisText = cs.getPropertyValue('--muted-foreground').trim() || '#8e8e93';
  const gridLine = cs.getPropertyValue('--hairline').trim() || 'rgba(0,0,0,.08)';
  const data = [
    Array.from({ length: HIST }, (_, i) => i),
    new Array(HIST).fill(0),
    new Array(HIST).fill(0),
  ];
  const times = [];

  const u = new uPlot({
    width: Math.max(120, el.clientWidth || 240),
    height: 74,
    legend: { show: false },
    cursor: { show: false },
    scales: { x: { time: false }, y: { range: (_u, _mn, mx) => [0, (mx || 1) * 1.15] } },
    axes: [
      { show: false },
      {
        show: true,
        size: 36,
        stroke: axisText,
        font: '10px "JetBrains Mono", ui-monospace, monospace',
        ticks: { show: false },
        grid: { show: true, stroke: gridLine, width: 1 },
        values: (_u, splits) => splits.map(fmtAxis),
      },
    ],
    series: [
      {},
      {
        stroke: primary, width: 1.5, fill: alpha(primary, 0.16),
        paths: uPlot.paths.spline(),
        points: { show: (_u, _i, idx) => idx === HIST - 1, size: 4, stroke: primary, fill: primary },
      },
      {
        stroke: success, width: 1.5, fill: alpha(success, 0.14),
        paths: uPlot.paths.spline(),
        points: { show: (_u, _i, idx) => idx === HIST - 1, size: 4, stroke: success, fill: success },
      },
    ],
  }, data, el);

  return {
    push(a, b) {
      data[1].push(a); data[1].shift();
      data[2].push(b); data[2].shift();
      times.push(Date.now());
      if (times.length > HIST) times.shift();
      u.setData(data);
    },
    peaks() {
      return [Math.max(...data[1]), Math.max(...data[2])];
    },
    spanLabel() {
      if (times.length < 2) return t('app.desktop.perf-waiting');
      const sec = Math.max(0, Math.round((times[times.length - 1] - times[0]) / 1000));
      if (sec < 60) return tf('app.desktop.perf-last-sec', { v1: sec });
      const m = Math.floor(sec / 60);
      const rest = sec % 60;
      return rest ? tf('app.desktop.perf-last-m-s', { v1: m, v2: rest }) : tf('app.desktop.perf-last-m', { v1: m });
    },
    resize(w) { if (w > 0) u.setSize({ width: w, height: 74 }); },
    destroy() { u.destroy(); },
  };
}

function chartFoot(chart, labels) {
  if (!chart) return null;
  const pk = chart.peaks();
  return h('div', { class: 'dp-chart-foot' }, [
    h('span', { class: 'dp-cf-span', text: chart.spanLabel() }),
    h('span', { class: 'dp-cf-peaks' }, labels.map((lb, i) => h('span', { key: lb, class: 'dp-cf-peak' }, [
      h('span', { class: `dp-cf-tag ${i === 0 ? 'up' : 'down'}`, text: lb }),
      h('span', { class: 'dp-cf-val mono', text: tf('app.desktop.perf-peak', { v1: (fmtRate(pk[i])) }) }),
    ]))),
  ]);
}

function fmtUptime(sec) {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  return tf('app.desktop.perf-uptime', { v1: d, v2: hh, v3: mm, v4: ss });
}

function ring(label, pct, num) {
  const C = 2 * Math.PI * 29;
  const p = Math.max(0, Math.min(100, pct || 0));
  return h('div', { class: 'dp-ring' }, [
    h('svg', { viewBox: '0 0 64 64', width: '64', height: '64', 'aria-hidden': 'true' }, [
      h('circle', {
        class: 'dp-ring-track', cx: '32', cy: '32', r: '29', fill: 'none', 'stroke-width': '6',
      }),
      h('circle', {
        class: 'dp-ring-val',
        cx: '32', cy: '32', r: '29', fill: 'none', 'stroke-width': '6', 'stroke-linecap': 'round',
        'stroke-dasharray': C.toFixed(2),
        'stroke-dashoffset': (C * (1 - p / 100)).toFixed(2),
        transform: 'rotate(-90 32 32)',
      }),
    ]),
    h('div', { class: 'dp-ring-text' }, [
      h('span', { class: 'dp-ring-label', text: label }),
      h('span', { class: 'dp-ring-num', text: num }),
    ]),
  ]);
}

function rateItem(icon, cls, value) {
  return h('div', { class: 'dp-rate' }, [
    icon.length <= 2
      ? h('span', { class: `dp-rate-tag ${cls}`, text: icon })
      : h('span', { class: `dp-rate-ic ${cls}`, html: appIcon(icon, 'qicon') }),
    h('span', { class: `dp-rate-val ${cls}`, text: value }),
  ]);
}

function miniRow(tag, tagCls, value) {
  return h('div', { class: 'dp-mini-row' }, [
    tagCls
      ? h('span', { class: `dp-mini-tag ${tagCls}`, text: tag })
      : h('span', { class: 'dp-mini-label', text: tag }),
    h('span', { class: 'dp-mini-val', text: value }),
  ]);
}

function diskRow(key, d, label, dup) {
  const pct = d.totalGB > 0 ? Math.min(100, (d.usedGB / d.totalGB) * 100) : 0;
  const shown = dup && d.device !== label
    ? `${label} (${String(d.device).replace('/dev/', '')})`
    : label;
  const tip = [
    d.device, d.fsType, d.mount,
    d.model || '', d.diskSize ? tf('app.desktop.perf-disk-used', { v1: (fmtSize(d.diskSize)) }) : '',
  ].filter(Boolean).join(' · ');
  return h('div', { key, class: `dp-disk${d.isSystem ? ' is-sys' : ''}`, title: tip }, [
    h('span', { class: 'dp-disk-ic', html: appIcon('disk', 'qicon') }),
    h('div', { class: 'dp-disk-name mono' }, [
      h('span', { text: shown }),
      d.isSystem ? h('span', { class: 'dp-disk-tag', text: t('app.desktop.perf-system-disk') }) : null,
    ].filter(Boolean)),
    h('div', { class: 'dp-disk-info' }, [
      h('div', { class: 'dp-disk-nums' }, [
        h('span', { class: 'dp-disk-used', text: `${d.usedGB} GB` }),
        h('span', { class: 'dp-disk-sep', text: ' / ' }),
        h('span', { class: 'dp-disk-total', text: `${d.totalGB} GB` }),
      ]),
      h('div', { class: 'dp-disk-bar' }, [h('i', { style: { width: `${pct}%` } })]),
    ]),
  ]);
}

function ChartSlot(props) {
  return h('div', {
    class: 'dp-chart',
    ref: (el) => { props.rt[props.slot] = el; },
    onUnmount: () => { props.rt[props.slot] = null; },
  });
}

function UptimeValue(props) {
  return h('strong', { class: 'dp-uptime-val', text: fmtUptime(props.sec.value) });
}

function SidePanel(props) {
  const { host, panelEl } = props;
  const samples = useState(null);
  const upSec = useState(null);
  const disks = useState([]);
  const collapsed = useState(false);
  const rt = useState(() => ({
    netEl: null,
    ioEl: null,
    netChart: null,
    ioChart: null,
    prev: null,
    upBase: null,
    timer: 0,
    upTimer: 0,
    observer: null,
    offCollapse: null,
  }));

  function renderUptime() {
    const base = rt.value.upBase;
    if (!base) return;
    upSec.next = base.sec + Math.max(0, Math.floor((performance.now() - base.t) / 1000));
  }

  async function update() {
    let m;
    try {
      m = await collectMetrics(host.id);
      if (m.error) throw new Error(m.error);
    } catch (e) {
      return;
    }
    const r = rt.value;
    if (!r.netChart && r.netEl && r.netEl.isConnected) {
      await loadUPlot();
      if (!r.netEl || !r.netEl.isConnected) return;
      r.netChart = makeChart(r.netEl);
      r.ioChart = makeChart(r.ioEl);
      if (r.netChart) {
        r.observer = new ResizeObserver(() => {
          r.netChart?.resize(r.netEl?.clientWidth);
          r.ioChart?.resize(r.ioEl?.clientWidth);
        });
        r.observer.observe(r.netEl);
        if (r.ioEl) r.observer.observe(r.ioEl);
      }
    }

    const now = Date.now();
    const prev = r.prev;
    const hasPrev = prev && now > prev.ts;
    const dt = hasPrev ? (now - prev.ts) / 1000 : 0;
    const up = hasPrev ? Math.max(0, (m.netTxBytes - prev.tx) / dt) : 0;
    const down = hasPrev ? Math.max(0, (m.netRxBytes - prev.rx) / dt) : 0;
    const rd = hasPrev ? Math.max(0, (m.diskReadBytes - prev.rd) / dt) : 0;
    const wr = hasPrev ? Math.max(0, (m.diskWriteBytes - prev.wr) / dt) : 0;
    r.netChart?.push(up, down);
    r.ioChart?.push(rd, wr);

    samples.next = {
      up, down, rd, wr,
      cpu: m.cpuPct,
      memUsed: m.memUsed || 0,
      memTotal: m.memTotal || 0,
      gpu: m.gpuPct,
    };
    r.prev = {
      ts: now, rx: m.netRxBytes, tx: m.netTxBytes, rd: m.diskReadBytes, wr: m.diskWriteBytes,
    };

    if (m.uptimeSec > 0 && (!r.upBase || m.uptimeSec !== r.upBase.sec)) {
      r.upBase = { sec: m.uptimeSec, t: performance.now() };
    }
    renderUptime();
    disks.next = m.disks || [];
  }

  const s = samples.value;
  const rate = (v) => fmtRate(v);
  const memPct = s && s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;

  const allDisks = disks.value;
  const realDisks = allDisks.filter((d) => (d.device || '').startsWith('/dev/') || d.disk);
  const labels = realDisks.map((d) => (d.disk ? `/dev/${d.disk}` : d.device));
  const dupCount = new Map();
  for (const l of labels) dupCount.set(l, (dupCount.get(l) || 0) + 1);

  return [
    h('div', { class: 'dp-head' }, [
      h('button', {
        class: 'dp-head-btn dp-settings-btn',
        html: appIcon('panel-sliders', 'qicon'),
        dataset: { tip: t('app.desktop.action-settings') },
        onClick: () => openSettingsTab(),
      }),
      h('div', { class: 'dp-mini' }, [
        h('div', { class: 'dp-mini-col' }, [
          miniRow('R', 'up', rate(s?.rd)),
          miniRow('W', 'down', rate(s?.wr)),
        ]),
        h('div', { class: 'dp-mini-col' }, [
          miniRow('↑', 'up', rate(s?.up)),
          miniRow('↓', 'down', rate(s?.down)),
        ]),
        h('div', { class: 'dp-mini-col' }, [
          miniRow('CPU', '', `${Math.round(s?.cpu || 0)}%`),
          miniRow('RAM', '', `${Math.round(memPct)}%`),
        ]),
      ]),
      h('span', { class: 'dp-head-spacer' }),
      h('button', {
        class: 'dp-head-btn dp-collapse',
        html: appIcon('chevron-up', 'qicon'),
        dataset: { tip: t('app.desktop.collapse-panel') },
        onClick: () => { collapsed.next = !collapsed.value; },
      }),
    ]),
    h('div', {
      class: 'dp-cards',
      onMount: () => {
        const r = rt.value;
        r.offCollapse = collapsed.subscribe((v) => panelEl.classList.toggle('dp-collapsed', v));
        update();
        r.timer = createPoller(update, POLL_MS, { immediate: false });
        r.timer.start();
        r.upTimer = createPoller(renderUptime, 1000, { immediate: false });
        r.upTimer.start();
      },
      onUnmount: () => {
        const r = rt.value;
        if (r.offCollapse) r.offCollapse();
        r.timer?.dispose();
        r.upTimer?.dispose();
        if (r.observer) r.observer.disconnect();
        r.netChart?.destroy();
        r.ioChart?.destroy();
      },
    }, [
      h('section', { class: 'dp-card' }, [
        h('div', { class: 'dp-card-title', text: t('app.desktop.perf-title') }),
        h('div', { class: 'dp-status-main' }, [
          h('div', { class: 'dp-status-left' }, [
            h('div', { class: 'dp-host-name', text: host.name }),
            h('div', { class: 'dp-uptime' }, [
              h('span', { class: 'dp-uptime-label', text: t('app.desktop.perf-session') }),
              h(UptimeValue, { sec: upSec }),
            ]),
          ]),
          h('div', { class: 'dp-rings' }, [
            ring('CPU', s?.cpu, `${Math.round(s?.cpu || 0)}%`),
            ring(t('app.desktop.perf-memory'), memPct, `${(s?.memUsed || 0).toFixed(1)} GB`),
            ring('GPU', s?.gpu >= 0 ? s.gpu : 0, `${Math.round(s?.gpu >= 0 ? s.gpu : 0)}%`),
          ]),
        ]),
      ]),
      h('section', { class: 'dp-card' }, [
        h('div', { class: 'dp-card-head' }, [
          h('div', { class: 'dp-card-title', text: t('app.desktop.perf-network') }),
          h('div', { class: 'dp-rates' }, [
            rateItem('arrow-up', 'up', rate(s?.up)),
            rateItem('arrow-down', 'down', rate(s?.down)),
          ]),
        ]),
        h(ChartSlot, { rt: rt.value, slot: 'netEl' }),
        chartFoot(rt.value.netChart, ['↑', '↓']),
      ]),
      h('section', { class: 'dp-card' }, [
        h('div', { class: 'dp-card-head' }, [
          h('div', { class: 'dp-card-title', text: t('app.desktop.perf-io') }),
          h('div', { class: 'dp-rates' }, [
            rateItem('R', 'up', rate(s?.rd)),
            rateItem('W', 'down', rate(s?.wr)),
          ]),
        ]),
        h(ChartSlot, { rt: rt.value, slot: 'ioEl' }),
        chartFoot(rt.value.ioChart, ['R', 'W']),
      ]),
      h('section', { class: 'dp-card dp-card-grow' }, [
        h('div', { class: 'dp-card-title', text: t('app.desktop.perf-disk') }),
        h('div', { class: 'dp-disks' }, realDisks.length
          ? realDisks.map((d, i) => diskRow(
            `${d.device}|${d.mount}|${i}`, d, labels[i], dupCount.get(labels[i]) > 1,
          ))
          : [h('div', {
            class: 'dp-disk-empty',
            text: allDisks.length ? t('app.desktop.perf-no-disk') : t('app.desktop.loading'),
          })]),
      ]),
    ]),
  ];
}

function showFolderMenu(e, folderId) {
  contextMenu([
    { icon: 'folder', label: t('app.desktop.action-open'), onClick: () => openFolder(folderId) },
    { icon: 'edit', label: t('app.desktop.action-rename'), onClick: () => renameFolderDialog(folderId) },
  ], { x: e.clientX, y: e.clientY, cls: 'desk-ctx' });
}

function renameFolder(folderId, name) {
  const { folders } = getDesktopModel();
  const folder = folders[folderId];
  if (!folder) return;
  const nextName = String(name || '').trim().slice(0, 60);
  if (!nextName || nextName === folder.name) return;
  const next = { ...folders, [folderId]: { ...folder, name: nextName } };
  if (!saveFolderState(DESKTOP_FOLDERS_KEY, next)) {
    toast(t('app.desktop.folder-rename-failed'), 'error');
    return;
  }
  activeFolders = next;
  toast(t('app.desktop.renamed'), 'success');
  refreshDesktopIcons();
}

function renameFolderDialog(folderId) {
  const folder = getDesktopModel().folders[folderId];
  if (!folder) return;
  const inputRef = { current: null };
  const submit = () => {
    const value = inputRef.current ? inputRef.current.value.trim() : '';
    if (!value) {
      inputRef.current?.focus();
      return;
    }
    dlg.close();
    renameFolder(folderId, value);
  };
  const dlg = dialog({
    title: t('app.desktop.rename-folder'),
    body: [
      h('div', { class: 'field' }, [
        h('label', { class: 'label', text: t('app.desktop.field-name') }),
        h('input', {
          ref: (el) => { inputRef.current = el; },
          class: 'input',
          type: 'text',
          value: folder.name,
          maxlength: '60',
          'aria-label': t('app.desktop.folder-name-label'),
        }),
      ]),
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.desktop.action-cancel'), onClick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary btn-sm', text: t('app.desktop.action-save'), onClick: submit }),
    ],
  });
  setTimeout(() => {
    if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, 0);
}

function showDeskMenu(e) {
  e.preventDefault();
  contextMenu([
    { icon: 'refresh', label: t('app.desktop.action-refresh'), onClick: () => { location.reload(); } },
    { sep: true },
    {
      icon: 'arrow-down-a-z',
      label: t('app.desktop.tidy-by-name'),
      onClick: () => {
        if (arrangeDesktopIcons('name')) toast(t('app.desktop.icons-tidied'), 'success');
      },
    },
    {
      icon: 'layers',
      label: t('app.desktop.tidy-by-type'),
      onClick: () => {
        if (arrangeDesktopIcons('type')) toast(t('app.desktop.icons-tidied'), 'success');
      },
    },
    {
      icon: 'layout-grid',
      label: t('app.desktop.tidy-compact'),
      onClick: () => {
        if (arrangeDesktopIcons('compact')) toast(t('app.desktop.icons-tidied'), 'success');
      },
    },
    { sep: true },
    { icon: 'sun', label: t('app.desktop.open-theme-settings'), onClick: () => openSettingsTab('theme') },
    { sep: true },
    {
      icon: 'user',
      label: t('app.desktop.switch-host'),
      danger: true,
      onClick: async () => {
        const ok = await confirmAction(t('app.desktop.switch-host'), t('app.desktop.switch-hint'), { okText: t('app.desktop.action-switch'), danger: false });
        if (!ok) return;
        wm.closeAll();
        clearWorkspace();
        location.href = '/';
      },
    },
  ], { x: e.clientX, y: e.clientY, cls: 'desk-ctx' });
}

function syncFolderWindows() {
  for (const win of wm.getWindows()) {
    if (!win.appId.startsWith('folder:')) continue;
    const folder = activeFolders[win.appId.slice(7)];
    if (!folder) {
      win.close();
      continue;
    }
    win.setTitle(folder.name);
  }
  folderRev.next = folderRev.value + 1;
}

function retitleWindows() {
  const appMap = new Map(getApps().map((app) => [app.id, app]));
  for (const win of wm.getWindows()) {
    if (win._titleCustom) continue;
    if (win.appId.startsWith('folder:')) {
      const folder = activeFolders[win.appId.slice(7)];
      if (folder) win.setTitle(folder.name);
      continue;
    }
    const app = appMap.get(win.appId);
    if (app) win.setTitle(appName(app));
  }
}

async function renderDesk(host) {
  const iconHost = dom('div', { class: 'desk-icons', id: 'desk-icons' });
  const panelHost = dom('div', { class: 'desk-panel' });
  const deskArea = dom('div', { class: 'desk-area', id: 'desk-area', onContextmenu: showDeskMenu });
  deskArea.append(iconHost, panelHost);

  const iconView = createView(iconHost);
  const panelView = createView(panelHost);
  bindIconGrid(iconHost);
  iconView.update(() => { lang(); return deskIconsTree(); });
  panelView.update(() => { lang(); return h(SidePanel, { host, panelEl: panelHost }); });

  const offLang = onLangChange(() => { retitleWindows(); });

  const doSwitchHost = async () => {
    const ok = await confirmAction(t('app.desktop.confirm-switch-title'), t('app.desktop.confirm-switch-body'), { okText: t('app.desktop.action-switch'), danger: false });
    if (!ok) return;
    wm.closeAll();
    clearWorkspace();
    location.href = '/';
  };

  const view = createView($('#root'));
  view.update(() => {
    lang();
    return h('div', { class: 'desk' }, [
    h(Taskbar, {
      wm,
      onToggleStart: () => { startOpen.next = !startOpen.value; },
      onOpenSettings: () => openSettingsTab(),
      onSwitchHost: doSwitchHost,
    }),
    deskArea,
    h(StartMenu, {
      wm,
      getApps,
      host,
      open: startOpen,
      onOpenApp: openApp,
      onSwitchHost: doSwitchHost,
      onQuit: () => { wm.closeAll(); toast(t('app.desktop.all-windows-closed'), 'success'); },
    }),
    ]);
  });

  requestAnimationFrame(() => { refreshDesktopIcons(); });

  applyWallpaper().catch((err) => console.warn('[desktop] 壁纸应用失败', err));
  applyGlass();

  const themeObserver = new MutationObserver(() => {
    applyWallpaper().catch((err) => console.warn('[desktop] 主题切换后重刷壁纸失败', err));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  wm.setMinimizeAnchor((win) => taskbarButtonRect(win.id));

  setHostHooks({
    wm,
    openApp,
    openSettingsTab: (tab) => openSettingsTab(tab || undefined),
    workspaceHostId: () => hostId,
    openAppById: (id, opts = {}) => {
      const app = getApps().find((a) => a.id === id);
      if (app) openApp(app, opts);
      else console.warn('[desktop] 未知的 app id：', id);
    },
    openApiWindow: (appId, api) => {
      const app = getApps().find((a) => a.id === appId);
      if (!app) return false;
      openApp(app, { qxapi: String(api || '') });
      return true;
    },
  });

  window.addEventListener('pagehide', () => {
    offLang();
    themeObserver.disconnect();
    iconView.unmount();
    panelView.unmount();
    view.unmount();
    closeAllMenus();
  }, { once: true });
}

function backToBoot() {
  try { location.replace('/'); } catch (err) { console.warn('[desktop] 返回开机页失败', err); }
}

async function boot() {
  try {
    await loadHosts();
    const host = ((getState() || {}).hosts || []).find((x) => x.id === hostId);
    if (!host) { backToBoot(); return; }
    let raw = null;
    try { raw = localStorage.getItem(PREFS_CACHE_KEY); } catch { }
    if (raw) {
      loadPrefs(null);
    } else {
      try {
        const { prefs } = await prefsAll();
        loadPrefs(prefs);
      } catch (err) {
        console.warn('[desktop] 读取个性化偏好失败，沿用本机缓存', err);
        loadPrefs(null);
      }
    }
    await setupI18n();
    await loadUserApps();
    setWorkspace(hostId);
    const refreshApps = () => refreshDesktopIcons();
    onBus('apps-changed', refreshApps);
    window.addEventListener('pagehide', () => {
      if (activeIconLayout) saveIconLayout(DESKTOP_LAYOUT_KEY, activeIconLayout);
      flushPrefs();
    });
    setHostHooks({
      reloadUserApps: async () => {
        await loadUserApps();
        refreshApps();
      },
    });
    await renderDesk(host);

    if (initialApp) {
      const app = getApps().find((a) => a.id === initialApp);
      if (app) openApp(app, { initialTab: initialTab || undefined });
      else console.warn('[desktop] 未知的 app 参数：', initialApp);
    }
  } catch (err) {
    console.error('[desktop] 初始化失败', err);
    toast(t('app.desktop.init-failed') + err.message, 'error');
    setTimeout(backToBoot, 1500);
  }
}

boot();
