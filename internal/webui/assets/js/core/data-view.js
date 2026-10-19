/**
 * core/data-view.js —— 带加载/空/错误态的异步数据视图
 * 要点：宿主只需提供 load/pick/render，本类负责状态流转、自动轮询与重绘，是各功能页列表的统一基座。
 */
import { createPoller } from './dom.js';
import { h, Fragment, createView } from './vdom.js';
import { t, tf, lang } from './i18n.js';

/** 异步数据视图：管理加载状态、轮询节奏与渲染时机 */
export class DataView {
  constructor(o) {
    this.o = Object.assign({ empty: t('app.core.empty-no-data'), error: t('app.core.load-failed'), loading: t('app.core.loading') }, o);
    this.rows = [];
    this.state = 'idle';
    this.lastError = null;
    this.el = document.createElement('div');
    this.el.className = 'dv';
    this._view = createView(this.el);
    this._seq = 0;
    this._inflight = false;
    this._disposed = false;
    this._poller = createPoller(() => this.refresh(), this._interval(), { immediate: false });
    if (this._interval() > 0) this._poller.start();
  }

  stopPolling() { this._poller.stop(); }

  startPolling() { if (!this._disposed && this._interval() > 0) this._poller.start(); }

  get element() { return this.el; }

  _interval() {
    const busy = Number(this.o.busyMs) || 0;
    const idle = Number(this.o.idleMs) || busy;
    return this.hasRows ? busy : idle;
  }

  get hasRows() {
    return this.o.pick ? this.o.pick(this.rows).length > 0 : this.rows.length > 0;
  }

  async refresh(force = false) {
    if (this._disposed) return;
    if (this._inflight && !force) return;
    if (this._inflight) this._seq++;
    this._inflight = true;
    const mine = ++this._seq;
    if (this.state === 'idle') this.state = 'loading';
    else this.el.classList.add('dv-busy');
    try {
      const rows = (await this.o.load()) || [];
      if (this._disposed || mine !== this._seq) return;
      this.rows = Array.isArray(rows) ? rows : [rows];
      this.lastError = null;
      this.state = 'ready';
    } catch (e) {
      if (this._disposed || mine !== this._seq) return;
      this.lastError = e;
      this.state = 'error';
    } finally {
      if (mine === this._seq) this._inflight = false;
      this._paint();
      this._syncPoller();
    }
  }

  setRows(rows) {
    if (this._disposed) return;
    this.rows = Array.isArray(rows) ? rows : [];
    this.state = 'ready';
    this._paint();
    this._syncPoller();
  }

  reload() { return this.refresh(true); }

  dispose() {
    this._disposed = true;
    this._seq++;
    this._poller.dispose();
    this._view.unmount();
    this.el.remove();
  }

  _syncPoller() {
    if (this._disposed) return;
    this._poller.setPeriod(this._interval());
  }

  _paint() {
    this.el.classList.remove('dv-busy');
    this._view.update(() => { lang(); return h(Fragment, {}, [this._tree()]); });
  }

  _tree() {
    if (this.state === 'loading') {
      return h('div', { class: 'qx-card-empty', text: lazyText(this.o.loading) });
    }
    if (this.state === 'error') {
      return h('div', { class: 'qx-card-empty' }, [
        h('div', { text: `${lazyText(this.o.error)}：${errText(this.lastError)}` }),
        h('div', { class: 'dv-retry' }, [
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.core.retry'), onClick: () => this.reload() }),
        ]),
      ]);
    }
    const rows = this.o.pick ? this.o.pick(this.rows) : this.rows;
    if (!rows.length) {
      return h('div', { class: 'qx-card-empty', text: lazyText(this.o.empty) });
    }
    return this.o.render(rows);
  }
}

function lazyText(v) {
  return typeof v === 'function' ? v() : v;
}

function errText(e) {
  if (!e) return '';
  return e.message || String(e);
}

/** 创建数据视图并默认立即刷新一次（immediate:false 可关闭） */
export function createDataView(o) {
  const v = new DataView(o);
  if (o.immediate !== false) v.refresh();
  return v;
}
