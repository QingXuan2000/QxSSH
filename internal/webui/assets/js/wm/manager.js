/**
 * wm/manager.js —— 窗口管理器
 * 要点：维护窗口集合、焦点与层级，渲染窗口层，并在变化时广播 wm:changed 供任务栏等刷新。
 */
import { h, dom, createView } from '../core/vdom.js';
import { Window, WindowView } from './window.js';
import { Snap } from './snap.js';
import { emit } from '../core/bus.js';
import { signal } from '../core/signal.js';

/** 窗口管理器：负责窗口创建、焦点、层级以及铺满与贴边的几何计算 */
export class WindowManager {
  constructor(container = null) {
    this.container = container instanceof Element ? container : null;
    this.windows = signal([]);
    this.active = signal(null);
    this.idCounter = 0;
    this.zCounter = 100;
    this.snap = new Snap(this);
    this._resizeRaf = 0;
    this.rev = signal(0);
    this.viewportRev = signal(0);
    this._anchorResolver = null;
    this._layer = null;
    this._view = null;

    window.addEventListener('resize', () => this._onViewportResize());
  }

  get activeWindow() {
    return this.active.value;
  }

  _ensureLayer() {
    const host = this.containerFor();
    if (!this._layer) {
      this._layer = dom('div', { class: 'qx-win-layer' });
      host.append(this._layer);
      this._view = createView(this._layer);
      this._view.update(() => this.windows.value.map((w) => h(WindowView, { key: w.id, win: w })));
    } else if (this._layer.parentNode !== host) {
      host.append(this._layer);
    }
    return this._layer;
  }

  _attach(win) {
    this._ensureLayer();
    if (!this.windows.value.includes(win)) this.windows.next = [...this.windows.value, win];
  }

  _detach(win) {
    if (this.windows.value.includes(win)) this.windows.next = this.windows.value.filter((w) => w !== win);
    if (this.active.value === win) this.active.next = null;
    this._changed();
  }

  open(options) {
    const win = new Window(this, options);
    win._snap = this.snap;
    win.open();
    this._changed();
    return win;
  }

  closeAll() {
    for (const w of [...this.windows.value]) w.close();
  }

  findByAppId(appId) {
    return this.windows.value.find((w) => w.appId === appId && !w._closed);
  }

  getWindows() {
    return [...this.windows.value];
  }

  focusWindow(win) {
    if (!win || win._closed) return;
    if (this.active.value === win) {
      if (win.zIndex < this.zCounter) {
        win._setZIndex(Math.min(++this.zCounter, 900));
        this._changed();
      }
      return;
    }
    this._focus(win);
    this._changed();
  }

  _focus(win) {
    const prev = this.active.value;
    if (prev && prev !== win && !prev._closed) prev._setActive(false);
    this.active.next = win;
    win._setActive(true);
    win._setZIndex(Math.min(++this.zCounter, 900));
  }

  onChanged() {
    this._changed();
  }

  _changed() {
    this.rev.next = this.rev.value + 1;
    const active = this.active.value;
    emit('wm:changed', {
      windows: this.windows.value.map((w) => ({
        id: w.id,
        appId: w.appId,
        title: w.title,
        state: w.state,
        active: w === active,
      })),
      active: active ? active.id : null,
    });
  }

  setMinimizeAnchor(fn) {
    this._anchorResolver = typeof fn === 'function' ? fn : null;
  }

  minimizeAnchor(win) {
    if (!this._anchorResolver) return null;
    try {
      const r = this._anchorResolver(win);
      return r && r.width > 0 && r.height > 0 ? r : null;
    } catch (err) {
      console.warn('[wm] minimize anchor resolver failed', err);
      return null;
    }
  }

  maxRect() {
    const area = this.areaRect();
    if (area) return { x: 0, y: 0, width: area.width, height: area.height };
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  snapRect(zone) {
    const { width: vw, height: vh } = this.viewport();
    if (zone === 'left') return { x: 0, y: 0, width: Math.round(vw / 2), height: vh };
    if (zone === 'right') return { x: Math.round(vw / 2), y: 0, width: Math.round(vw / 2), height: vh };
    return { x: 0, y: 0, width: vw, height: vh };
  }

  areaRect() {
    const el = this.containerFor();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return r;
  }

  containerFor() {
    if (this.container && this.container.isConnected) return this.container;
    return document.getElementById('desk-area') || document.body;
  }

  viewport() {
    const area = this.areaRect();
    if (area) return { width: area.width, height: area.height, left: area.left, top: area.top };
    return { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  }

  _onViewportResize() {
    if (this._resizeRaf) return;
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this._applyViewportResize();
    });
  }

  _applyViewportResize() {
    const { width: vw, height: vh } = this.viewport();
    for (const w of this.windows.value) {
      w._cancelAnim();
      w._clampToViewport(vw, vh);
    }
    this.viewportRev.next = this.viewportRev.value + 1;
  }
}

let defaultManager = null;
/** 取默认的窗口管理器单例 */
export function getWM() {
  if (!defaultManager) defaultManager = new WindowManager();
  return defaultManager;
}
