/**
 * wm/window.js —— 窗口实例与窗口视图
 * 要点：Window 承载位置尺寸、状态（普通/最大化/贴边/最小化）、拖拽缩放与动画，WindowView 把状态渲染成 DOM。
 */
import { h, dom } from '../core/vdom.js';
import { signal, batch } from '../core/signal.js';
import { icon } from '../core/components.js';
import { mountAppFrame, reloadAppFrames } from './appframe.js';
import { t } from '../core/i18n.js';

const MIN_W = 280;
const MIN_H = 180;
const DRAG_THRESHOLD = 2;

const RESIZE_DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DUR_GEOMETRY = 220;
const DUR_MINIMIZE = 240;
const DUR_OPEN = 180;
const MINIMIZE_SCALE = 0.1;
const DUR_CLOSE = 140;
const DUR_FLASH = 420;

function sameRect(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function px(n) {
  return `${Math.round(n)}px`;
}

function Titlebar({ win }) {
  const badge = win._badge.value;
  const maxed = win._state.value === 'maximized';
  return h('div', {
    class: 'qx-win-titlebar',
    onPointerdown: win._onBarDown,
    onDblclick: win._onBarDblclick,
  }, [
    h('div', { class: 'qx-win-title-group' }, [
      win.options.icon ? h('span', { class: 'qx-win-icon', html: win.options.icon }) : null,
      h('div', { class: 'qx-win-title', text: win._title.value }),
      badge ? h('span', { class: 'qx-win-badge', text: badge }) : null,
    ]),
    h('div', { class: 'qx-win-actions' }, [
      win.options.dev ? h('button', {
        class: 'qx-win-btn qx-win-reload',
        html: icon('refresh', 'qicon qicon-sm'),
        'aria-label': 'reload',
        title: t('core.wm.reload'),
        onClick: win._onBtnReload,
      }) : null,
      h('button', { class: 'qx-win-btn qx-win-min', html: icon('minimize', 'qicon qicon-sm'), 'aria-label': 'min', onClick: win._onBtnMin }),
      h('button', {
        class: 'qx-win-btn qx-win-max',
        html: icon(maxed ? 'restore' : 'maximize', 'qicon qicon-sm'),
        'aria-label': 'max',
        onClick: win._onBtnMax,
      }),
      h('button', { class: 'qx-win-btn qx-win-close', html: icon('close', 'qicon qicon-sm'), 'aria-label': 'close', onClick: win._onBtnClose }),
    ]),
  ]);
}

/** 窗口视图：渲染标题栏、内容区与八个方向的缩放手柄 */
export function WindowView({ win }) {
  const state = win._state.value;
  const rect = win.currentRect();
  const drag = win._dragOffset.value;
  const accent = win._accent.value;
  const classes = ['qx-window'];
  if (win._active.value) classes.push('qx-win-active');
  if (state === 'minimized' && win._hidden.value) classes.push('qx-win-minimized');
  if (win._dragging.value) classes.push('qx-win-dragging');
  if (win._resizing.value) classes.push('qx-win-resizing');
  if (win._animating.value) classes.push('qx-win-animating');
  if (win._closing.value) classes.push('qx-win-closing');
  if (accent) classes.push('qx-win-accent');
  for (const c of win._classes.value) classes.push(c);

  const style = {
    left: px(rect.x),
    top: px(rect.y),
    width: px(rect.width),
    height: px(rect.height),
    zIndex: String(win._z.value),
    contain: 'layout paint',
  };
  if (drag) style.transform = `translate3d(${Math.round(drag.dx)}px, ${Math.round(drag.dy)}px, 0)`;
  if (accent) style['--qx-title-accent'] = accent;

  return h('div', {
    class: classes.join(' '),
    dataset: { id: win.id, app: win.appId },
    style,
    ref: win._rootRef,
    onPointerdown: win._onRootDown,
  }, [
    h(Titlebar, { win }),
    win.bodyEl,
    ...RESIZE_DIRS.map((dir) => h('div', {
      class: `qx-win-resize qx-win-resize-${dir}`,
      dataset: { dir },
      onPointerdown: win._onHandleDown[dir],
    })),
    win.overlayEl,
  ]);
}

/** 窗口实例：状态、几何计算、拖拽缩放、动画与内容挂载 */
export class Window {
  constructor(manager, options) {
    this.manager = manager;
    this.options = options;
    this.minW = options.minWidth || MIN_W;
    this.minH = options.minHeight || MIN_H;
    this._minContentWidth = this.minW;
    this._minContentHeight = this.minH;
    this.id = `win-${++manager.idCounter}`;
    this.appId = options.appId || 'app';

    this._title = signal(options.title || t('core.wm.window'));
    this._badge = signal('');
    this._accent = signal('');
    this._classes = signal([]);
    this._state = signal('normal');
    this._rect = signal(this._computeInitialRect());
    this._snapZone = signal(null);
    this._dragOffset = signal(null);
    this._active = signal(false);
    this._z = signal(0);
    this._dragging = signal(false);
    this._resizing = signal(false);
    this._animating = signal(false);
    this._closing = signal(false);
    this._hidden = signal(false);

    this.bodyEl = dom('div', { class: 'qx-win-body' });
    this.overlayEl = dom('div', { class: 'qx-win-overlay' });
    this.bodyEl.addEventListener('pointerdown', () => this.focus(), true);
    this.overlayEl.addEventListener('pointerdown', () => this.focus(), true);
    this.el = null;

    this._closed = false;
    this._mounted = false;
    this._drag = null;
    this._resize = null;
    this._snap = null;
    this._contentMounted = false;
    this._contentCleanup = null;
    this._frameApi = null;
    this._anim = null;
    this._flashTimer = null;

    this._rootRef = (el) => { this.el = el; };
    this._onRootDown = (e) => { if (e.button === 0) this.focus(); };
    this._onBarDown = (e) => this._barDown(e);
    this._onBarDblclick = (e) => { if (!e.target.closest('.qx-win-btn')) this.toggleMaximize(); };
    this._onBtnReload = (e) => { e.stopPropagation(); this.reload(); };
    this._onBtnMin = (e) => { e.stopPropagation(); this.minimize(); };
    this._onBtnMax = (e) => { e.stopPropagation(); this.toggleMaximize(); };
    this._onBtnClose = (e) => { e.stopPropagation(); this.close(); };
    this._onHandleDown = {};
    for (const dir of RESIZE_DIRS) this._onHandleDown[dir] = (e) => this._handleDown(e, dir);
  }

  get title() { return this._title.value; }
  get state() { return this._state.value; }
  get active() { return this._active.value; }
  get zIndex() { return this._z.value; }
  get normalRect() { return this._rect.value; }

  currentRect() {
    const state = this._state.value;
    if (state === 'maximized') {
      void this.manager.viewportRev.value;
      return this.manager.maxRect();
    }
    if (state === 'snapped' && this._snapZone.value) {
      void this.manager.viewportRev.value;
      return this.manager.snapRect(this._snapZone.value);
    }
    return this._rect.value;
  }

  _computeInitialRect() {
    const { width: vw, height: vh } = this.manager.viewport();
    const opts = this.options || {};
    const w = opts.width ? Math.max(this.minW, opts.width) : this.minW;
    const h_ = opts.height ? Math.max(this.minH, opts.height) : this.minH;
    const width = Math.min(w, vw - 32);
    const height = Math.min(h_, vh - 64);
    return {
      x: opts.x ?? Math.max(16, (vw - width) / 2),
      y: opts.y ?? Math.max(16, (vh - height) / 2 - 24),
      width,
      height,
    };
  }

  open() {
    if (this._closed || this._mounted) return this;
    this._mounted = true;
    this.manager._attach(this);
    if (!this.el) {
      console.error('[wm] window root did not mount', this.id);
      return this;
    }
    this._mountContent();
    this.focus();
    if (this._canAnimate()) {
      this._runAnim([
        { opacity: 0, transform: 'scale(.96)' },
        { opacity: 1, transform: 'none' },
      ], DUR_OPEN);
    }
    return this;
  }

  _mountContent() {
    if (this._contentMounted) return;
    this._contentMounted = true;
    if (this.options.frame) {
      try {
        this._frameApi = mountAppFrame(this.bodyEl, this.options.frame, this);
      } catch (err) {
        console.error('[wm] frame mount failed', err);
        this.bodyEl.append(dom('div', {
          class: 'app-placeholder',
          text: t('core.wm.app-load-failed') + err.message,
        }));
      }
      return;
    }
    if (this.options.content) {
      try {
        this._contentCleanup = this.options.content(this.bodyEl, this) || null;
      } catch (err) {
        console.error('[wm] content mount error', err);
        this.bodyEl.textContent = t('core.wm.content-load-failed');
      }
      this._autoSize();
    }
  }

  reload() {
    if (typeof this.options.onReload === 'function') {
      this.options.onReload(this);
      return;
    }
    if (this._frameApi && this._frameApi.entry) {
      reloadAppFrames(this.appId);
      return;
    }
    const iframe = this.bodyEl.querySelector('iframe');
    if (iframe) {
      try {
        iframe.contentWindow.location.reload();
        return;
      } catch { }
      const src = iframe.getAttribute('src') || iframe.src;
      if (src) iframe.src = src;
    }
  }

  _autoSize() {
    const opts = this.options || {};
    if (opts.autoSize === false) return;

    const scrollW = this.bodyEl.scrollWidth;
    const scrollH = this.bodyEl.scrollHeight;
    const bodyRect = this.bodyEl.getBoundingClientRect();

    const contentW = Math.max(scrollW, bodyRect.width);
    const contentH = Math.max(scrollH, bodyRect.height);

    const titleH = 40;
    const padX = 12;
    const padY = 16;

    const cur = this._rect.value;
    const targetW = Math.max(cur.width, contentW + padX);
    const targetH = Math.max(cur.height, contentH + titleH + padY);

    const { width: vw, height: vh } = this.manager.viewport();
    const width = Math.max(this.minW, Math.min(targetW, vw - 32));
    const height = Math.max(this.minH, Math.min(targetH, vh - 64));

    this._rect.next = {
      x: Math.max(16, Math.min(cur.x, vw - width - 16)),
      y: Math.max(16, Math.min(cur.y, vh - height - 16)),
      width,
      height,
    };

    this._minContentWidth = Math.max(this.minW, contentW + padX);
    this._minContentHeight = Math.max(this.minH, contentH + titleH + padY);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._teardownDrag();
    this._teardownResize();
    this._cancelAnim();
    clearTimeout(this._flashTimer);
    try { this._frameApi?.destroy(); } catch (e) { console.error('[wm] frame destroy', e); }
    this._closing.next = true;
    this.manager.onChanged();
    setTimeout(() => {
      this.manager._detach(this);
      try { this._contentCleanup?.(); } catch (e) { console.error('[wm] content cleanup', e); }
      if (this.options.onClose) {
        try { this.options.onClose(this); } catch (e) { console.error('[wm] onClose error', e); }
      }
    }, DUR_CLOSE);
  }

  setTitle(t) {
    const next = String(t ?? '');
    if (next === this.title) return;
    this._title.next = next;
    this.options.title = next;
    this.manager.onChanged();
  }

  setBadge(text) {
    this._badge.next = text == null ? '' : String(text);
  }

  setAccent(color) {
    this._accent.next = color ? String(color) : '';
  }

  addClass(...names) {
    const cur = this._classes.value;
    const add = names.flat().map(String).filter((c) => c && !cur.includes(c));
    if (add.length) this._classes.next = [...cur, ...add];
  }

  removeClass(...names) {
    const drop = new Set(names.flat().map(String));
    const cur = this._classes.value;
    const next = cur.filter((c) => !drop.has(c));
    if (next.length !== cur.length) this._classes.next = next;
  }

  flash() {
    if (this._closed) return;
    clearTimeout(this._flashTimer);
    this.addClass('term-bell-flash');
    this._flashTimer = setTimeout(() => this.removeClass('term-bell-flash'), DUR_FLASH);
  }

  focus() {
    if (this._closed) return;
    this.manager.focusWindow(this);
  }

  setRect(rect, { animate = true } = {}) {
    if (this._closed) return;
    const vp = this.manager.viewport();
    const cur = this.currentRect();
    const width = Math.min(Math.max(this.minW, Number(rect.width) || cur.width), vp.width);
    const height = Math.min(Math.max(this.minH, Number(rect.height) || cur.height), vp.height);
    const x = Math.max(0, Math.min(Number(rect.x) || 0, vp.width - width));
    const y = Math.max(0, Math.min(Number(rect.y) || 0, vp.height - height));
    const target = { x, y, width, height };
    if (this.state === 'minimized') {
      this._cancelAnim();
      batch(() => {
        this._hidden.next = false;
        this._state.next = 'normal';
        this._rect.next = target;
      });
      this.focus();
    } else {
      const from = animate ? this._visualRect() : null;
      this._cancelAnim();
      batch(() => {
        this._state.next = 'normal';
        this._snapZone.next = null;
        this._rect.next = target;
      });
      this._animateFrom(from, target);
    }
    this.manager.onChanged();
  }

  minimize() {
    if (this._closed || this.state === 'minimized') return;
    this._preMinState = this.state;
    this._cancelAnim();
    batch(() => {
      this._snapZone.next = null;
      this._state.next = 'minimized';
    });
    this.manager.onChanged();
    if (!this._canAnimate()) {
      this._hidden.next = true;
      return;
    }
    const to = this._minimizeFrame(this.manager.minimizeAnchor(this));
    this._runAnim([{ transform: 'none', opacity: 1 }, to], DUR_MINIMIZE, {
      hold: true,
      onDone: () => { if (this.state === 'minimized') this._hidden.next = true; },
    });
  }

  restore() {
    if (this._closed || this.state === 'normal') return;
    if (this.state === 'minimized') {
      this._cancelAnim();
      batch(() => {
        this._hidden.next = false;
        this._state.next = 'normal';
      });
      this.focus();
      if (this._canAnimate()) {
        const from = this._minimizeFrame(this.manager.minimizeAnchor(this));
        this._runAnim([from, { transform: 'none', opacity: 1 }], DUR_MINIMIZE);
      }
    } else {
      this._restoreFromMax(true);
    }
    this.manager.onChanged();
  }

  maximize() {
    if (this._closed || this.state === 'maximized') return;
    let from;
    if (this.state === 'minimized') {
      this._cancelAnim();
      this._hidden.next = false;
      from = { ...this._rect.value };
    } else {
      from = this._visualRect();
      this._cancelAnim();
    }
    batch(() => {
      this._snapZone.next = null;
      this._state.next = 'maximized';
    });
    this._animateFrom(from, this.manager.maxRect());
    this.focus();
    this.manager.onChanged();
  }

  _restoreFromMax(animate = false) {
    const from = animate ? this._visualRect() : null;
    this._cancelAnim();
    batch(() => {
      this._snapZone.next = null;
      this._state.next = 'normal';
    });
    this._animateFrom(from, this._rect.value);
  }

  toggleMaximize() {
    if (this.state === 'maximized') this.restore();
    else this.maximize();
  }

  snapTo(zone) {
    if (this._closed) return;
    const z = zone === 'left' || zone === 'right' ? zone : 'max';
    let from;
    if (this.state === 'minimized') {
      this._cancelAnim();
      this._hidden.next = false;
      from = { ...this._rect.value };
    } else {
      from = this._visualRect();
      this._cancelAnim();
    }
    batch(() => {
      this._snapZone.next = z;
      this._state.next = 'snapped';
    });
    this._animateFrom(from, this.manager.snapRect(z));
    this.focus();
    this.manager.onChanged();
  }

  unsnap({ animate = true } = {}) {
    if (this._closed) return;
    if (this.state === 'snapped' || this.state === 'maximized') {
      this._restoreFromMax(animate);
      this.manager.onChanged();
    }
  }

  _canAnimate() {
    if (!this.el || this._closed || typeof this.el.animate !== 'function') return false;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return this.manager.viewport().width >= 768;
  }

  _cancelAnim() {
    const a = this._anim;
    if (!a) return;
    this._anim = null;
    try { a.cancel(); } catch { }
    if (!this._closed) this._animating.next = false;
  }

  _visualRect() {
    if (!this.el) return { ...this._rect.value };
    const r = this.el.getBoundingClientRect();
    const area = this.manager.areaRect();
    return {
      x: r.left - (area ? area.left : 0),
      y: r.top - (area ? area.top : 0),
      width: r.width,
      height: r.height,
    };
  }

  _animateFrom(from, to) {
    if (!from || sameRect(from, to) || !this._canAnimate()) return;
    this._runAnim([
      { left: px(from.x), top: px(from.y), width: px(from.width), height: px(from.height) },
      { left: px(to.x), top: px(to.y), width: px(to.width), height: px(to.height) },
    ], DUR_GEOMETRY);
  }

  _minimizeFrame(anchor) {
    if (!anchor || !this.el) return { transform: 'scale(.9)', opacity: 0 };
    const r = this.el.getBoundingClientRect();
    const dx = (anchor.left + anchor.width / 2) - (r.left + r.width / 2);
    const dy = (anchor.top + anchor.height / 2) - (r.top + r.height / 2);
    return { transform: `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(${MINIMIZE_SCALE})`, opacity: 0 };
  }

  _runAnim(frames, duration, { hold = false, onDone = null } = {}) {
    this._animating.next = true;
    const anim = this.el.animate(frames, { duration, easing: EASE, fill: hold ? 'forwards' : 'none' });
    this._anim = anim;
    anim.finished.then(() => {
      if (this._anim !== anim) return;
      this._anim = null;
      if (!this._closed) this._animating.next = false;
      if (onDone) onDone();
      if (hold) { try { anim.cancel(); } catch { } }
    }, () => { });
    return anim;
  }

  _barDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.qx-win-btn, .qx-win-actions')) return;
    this.focus();
    this._startDrag(e);
  }

  _startDrag(e) {
    this._cancelAnim();
    if (this.state === 'maximized') {
      const { width: vw } = this.manager.viewport();
      const area = this.manager.areaRect();
      const localX = area ? e.clientX - area.left : e.clientX;
      const { width, height } = this._rect.value;
      const ratio = Math.min(1, Math.max(0, localX / vw));
      const x = Math.max(0, Math.min(vw - width, localX - width * ratio));
      const y = Math.max(0, e.clientY - (area ? area.top : 0) - 16);
      batch(() => {
        this._snapZone.next = null;
        this._state.next = 'normal';
        this._rect.next = { x, y, width, height };
      });
      this.manager.onChanged();
    } else if (this.state === 'snapped') {
      this.unsnap({ animate: false });
    }

    this.el.setPointerCapture(e.pointerId);
    document.body.classList.add('qx-dragging');
    this._drag = {
      startX: e.clientX,
      startY: e.clientY,
      rect: { ...this._rect.value },
      pointerId: e.pointerId,
      moved: false,
      x: this._rect.value.x,
      y: this._rect.value.y,
    };

    const onMove = (ev) => this._onDragMove(ev);
    const onUp = (ev) => this._onDragUp(ev);
    const el = this.el;
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    this._dragCleanup = () => {
      try { el.releasePointerCapture(e.pointerId); } catch { }
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      this._dragCleanup = null;
    };
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d) return;
    if (!d.moved && (Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD || Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD)) {
      d.moved = true;
      this._dragging.next = true;
      if (this._snap) this._snap.onDragStart(this);
    }
    if (!d.moved) return;

    let x = d.rect.x + (e.clientX - d.startX);
    let y = d.rect.y + (e.clientY - d.startY);
    const { width: vw, height: vh } = this.manager.viewport();
    x = Math.max(0, Math.min(x, vw - 80));
    y = Math.max(0, Math.min(y, vh - 48));
    d.x = x;
    d.y = y;
    this._dragOffset.next = { dx: x - d.rect.x, dy: y - d.rect.y };

    if (this._snap) this._snap.onDragMove(this, e.clientX, e.clientY);
  }

  _onDragUp(e) {
    const d = this._drag;
    if (!d) return;
    const moved = d.moved;
    const { x, y } = d;
    this._teardownDrag();
    if (moved) this._rect.next = { ...this._rect.value, x, y };
    if (this._snap) this._snap.onDragEnd(this, e.clientX, e.clientY);
  }

  _teardownDrag() {
    document.body.classList.remove('qx-dragging');
    if (this._dragCleanup) this._dragCleanup();
    this._drag = null;
    if (this._closed) return;
    this._dragOffset.next = null;
    requestAnimationFrame(() => {
      if (!this._drag && !this._closed) this._dragging.next = false;
    });
  }

  _handleDown(e, dir) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.focus();
    if (this.state === 'maximized' || this.state === 'snapped') this.unsnap({ animate: false });
    this._startResize(e, dir);
  }

  _startResize(e, dir) {
    this._cancelAnim();
    document.body.classList.add('qx-dragging');
    this._resizing.next = true;
    this.el.setPointerCapture(e.pointerId);
    this._resize = { dir, startX: e.clientX, startY: e.clientY, startRect: { ...this._rect.value }, pointerId: e.pointerId };

    const onMove = (ev) => this._onResizeMove(ev);
    const onUp = () => this._teardownResize();
    const el = this.el;
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    this._resizeCleanup = () => {
      try { el.releasePointerCapture(e.pointerId); } catch { }
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      this._resizeCleanup = null;
    };
  }

  _onResizeMove(e) {
    const r = this._resize;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    const { startRect, dir } = r;
    const out = { x: startRect.x, y: startRect.y, width: startRect.width, height: startRect.height };

    const minW = this._minContentWidth || MIN_W;
    const minH = this._minContentHeight || MIN_H;
    if (dir.includes('e')) out.width = Math.max(minW, startRect.width + dx);
    if (dir.includes('w')) {
      out.width = Math.max(minW, startRect.width - dx);
      out.x = startRect.x + (startRect.width - out.width);
    }
    if (dir.includes('s')) out.height = Math.max(minH, startRect.height + dy);
    if (dir.includes('n')) {
      out.height = Math.max(minH, startRect.height - dy);
      out.y = startRect.y + (startRect.height - out.height);
    }

    const { width: vw, height: vh } = this.manager.viewport();
    if (out.x < 0) { out.width += out.x; out.x = 0; }
    if (out.y < 0) { out.height += out.y; out.y = 0; }
    if (out.x + out.width > vw) out.width = vw - out.x;
    if (out.y + out.height > vh) out.height = vh - out.y;
    if (out.width < minW) { out.width = minW; if (dir.includes('w')) out.x = startRect.x + startRect.width - minW; }
    if (out.height < minH) { out.height = minH; if (dir.includes('n')) out.y = startRect.y + startRect.height - minH; }

    this._rect.next = out;
  }

  _teardownResize() {
    document.body.classList.remove('qx-dragging');
    if (this._resizeCleanup) this._resizeCleanup();
    this._resize = null;
    if (!this._closed) this._resizing.next = false;
  }

  _setActive(active) {
    this._active.next = !!active;
  }

  _setZIndex(z) {
    this._z.next = z;
  }

  _clampToViewport(vw, vh) {
    if (this._closed || this.state !== 'normal') return;
    let { x, y, width, height } = this._rect.value;
    if (x + width > vw) x = Math.max(0, vw - width);
    if (y + height > vh) y = Math.max(0, vh - height);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (width > vw) { width = vw; x = 0; }
    if (height > vh) { height = vh; y = 0; }
    const cur = this._rect.value;
    if (x !== cur.x || y !== cur.y || width !== cur.width || height !== cur.height) {
      this._rect.next = { x, y, width, height };
    }
  }
}
