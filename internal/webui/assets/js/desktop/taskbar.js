/**
 * desktop/taskbar.js —— 任务栏视图与停靠位置
 * 要点：渲染开始按钮、窗口按钮与工具入口，支持任务栏停靠位置持久化以及窗口按钮的右键菜单。
 */
import { h } from '../core/vdom.js';
import { signal } from '../core/signal.js';
import { getPref, setPref } from '../core/prefs.js';
import { appIcon } from '../icons/index.js';
import { getApp } from '../apps/registry.js';
import { contextMenu } from './ctxmenu.js';
import { setupI18n, t } from '../core/i18n.js';

setupI18n().catch(() => { });

const POS_KEY = 'qx-taskbar-pos';
const DEFAULT_POS = 'bottom';
const VALID_POS = ['top', 'bottom', 'left', 'right'];

let posSig = null;

function posSignal() {
  if (posSig) return posSig;
  const p = readPos();
  document.body.dataset.tbpos = p;
  posSig = signal(p);
  return posSig;
}

function taskbarPos() {
  return posSignal().value;
}

function readPos() {
  const p = getPref(POS_KEY, DEFAULT_POS);
  return VALID_POS.includes(p) ? p : DEFAULT_POS;
}

/** 取任务栏停靠位置 */
export function getTaskbarPos() {
  return posSignal().value;
}

/** 设置任务栏停靠位置（top/bottom/left/right） */
export function setTaskbarPos(pos) {
  if (!VALID_POS.includes(pos)) return;
  setPref(POS_KEY, pos);
  document.body.dataset.tbpos = pos;
  if (posSig) posSig.next = pos;
}

/** 取某窗口在任务栏上的按钮矩形，用于最小化动画定位 */
export function taskbarButtonRect(winId) {
  if (!winId) return null;
  const el = document.querySelector(`.tb-win[data-win-id="${CSS.escape(String(winId))}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

let iconWarmed = false;
function warmLaunchIcons() {
  if (iconWarmed) return;
  iconWarmed = true;
  if (typeof Image !== 'function') return;
  ['1', '2', '3'].forEach((n) => { new Image().src = `assets/images/icon/bar/${n}.png`; });
}

/** 任务栏组件：开始按钮、窗口按钮与工具区 */
export function Taskbar(props) {
  const { wm, onToggleStart, onOpenSettings, onSwitchHost } = props;
  void wm.rev.value;
  const wins = wm.getWindows();
  warmLaunchIcons();

  const findWin = (id) => {
    const win = wm.getWindows().find((x) => x.id === id);
    return win && !win._closed ? win : null;
  };

  const openWinMenu = (e, id) => {
    e.preventDefault();
    const win = findWin(id);
    if (!win) return;
    const isMin = win.state === 'minimized';
    const isMax = win.state === 'maximized';
    contextMenu([
      isMin
        ? { icon: 'restore', label: t('app.taskbar.restore'), onClick: () => win.restore() }
        : { icon: 'minimize', label: t('app.taskbar.minimize'), onClick: () => win.minimize() },
      {
        icon: isMax ? 'restore' : 'maximize',
        label: isMax ? t('app.taskbar.restore-window') : t('app.taskbar.maximize'),
        onClick: () => win.toggleMaximize(),
      },
      { sep: true },
      { icon: 'close', label: t('app.taskbar.close'), danger: true, onClick: () => win.close() },
    ], { x: e.clientX, y: e.clientY, cls: 'tb-ctx', zIndex: 1600 });
  };

  const startBtn = h('button', {
    class: 'tb-big tb-launch',
    dataset: { tip: t('app.taskbar.start-menu') },
    onClick: onToggleStart,
  }, [h('span', { class: 'tb-launch-ic' })]);

  const utils = h('div', { class: 'tb-utils' }, [
    onSwitchHost ? h('button', {
      class: 'tb-util',
      html: appIcon('user', 'qicon'),
      dataset: { tip: t('app.taskbar.switch-host') },
      onClick: onSwitchHost,
    }) : null,
    h('button', {
      class: 'tb-util',
      html: appIcon('settings', 'qicon'),
      dataset: { tip: t('app.taskbar.settings') },
      onClick: onOpenSettings,
    }),
  ].filter(Boolean));

  const buttons = wins.map((w) => {
    const app = getApp(w.appId);
    const icName = app?.icon || (w.appId.startsWith('folder:') ? 'folder' : w.appId);
    const isMin = w.state === 'minimized';
    return h('button', {
      key: w.id,
      class: `tb-win${w.active ? ' active' : ''}`,
      dataset: { winId: w.id, tip: w.title },
      onClick: () => {
        const win = findWin(w.id);
        if (!win) return;
        if (win.state === 'minimized') { win.restore(); win.focus(); }
        else if (wm.activeWindow === win) win.minimize();
        else win.focus();
      },
      onContextmenu: (e) => openWinMenu(e, w.id),
    }, [
      h('span', { class: 'tb-win-ic', html: appIcon(icName, 'qicon', app?.id || '') }),
      h('span', { class: `tb-win-pill${isMin ? '' : ' on'}` }),
    ]);
  });

  return h('div', { class: `taskbar taskbar-${taskbarPos()}` }, [
    startBtn,
    h('span', { class: 'tb-sep' }),
    h('div', { class: 'tb-windows' }, buttons),
    h('span', { class: 'tb-sep' }),
    utils,
  ]);
}
