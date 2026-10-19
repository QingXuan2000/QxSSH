/**
 * core/dom.js —— DOM 查询、文本格式化与通用工具函数
 * 要点：全项目共用的 $/$$ 查询、转义、体积/时间格式化，以及防抖、节流和定时轮询器。
 */
import { t, tf } from './i18n.js';

/** 查询单个元素，未命中返回 null */
export function $(sel, root = document) {
  return root.querySelector(sel);
}

/** 查询所有匹配元素并返回数组 */
export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** HTML 转义，用于把外部文本安全拼进 HTML */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 把字节数格式化为带单位的可读体积 */
export function fmtSize(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 把每秒字节数格式化为速率文本 */
export function fmtRate(v) {
  if (!Number.isFinite(v) || v <= 0) return '-';
  return `${fmtSize(Math.round(v))}/s`;
}

/** 把时间戳格式化为“年-月-日 时:分” */
export function fmtTime(t) {
  if (!t) return '-';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '-';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把秒数格式化为本地化的时长（天/时/分/秒） */
export function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  if (d > 0) return tf('app.core.dur-d-h', { v1: d, v2: hh });
  if (hh > 0) return tf('app.core.dur-h-m', { v1: hh, v2: mm });
  if (mm > 0) return tf('app.core.dur-m-s', { v1: mm, v2: ss });
  return tf('app.core.dur-s', { v1: ss });
}

/** 数字千分位格式化，用于统计量展示 */
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) < 1000) return String(n);
  return n.toLocaleString('en-US');
}

/** 把时间戳或时间字符串转换为“多久以前”的相对文案 */
export function timeAgo(when) {
  const ms = typeof when === 'number' ? (when < 1e12 ? when * 1000 : when) : Date.parse(when);
  if (!Number.isFinite(ms)) return '-';
  const diff = Date.now() - ms;
  if (diff < 0) return t('app.core.just-now');
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('app.core.just-now');
  const min = Math.floor(sec / 60);
  if (min < 60) return tf('app.core.ago-min', { v1: min });
  const hh = Math.floor(min / 60);
  if (hh < 24) return tf('app.core.ago-h', { v1: hh });
  const d = Math.floor(hh / 24);
  if (d < 30) return tf('app.core.ago-d', { v1: d });
  return fmtTime(ms);
}

/** 防抖包装：静默 wait 毫秒后执行，附带 cancel/flush */
export function debounce(fn, wait = 200) {
  let timer = null;
  let pending = null;
  const wrapped = (...args) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pending;
      pending = null;
      fn(...a);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  wrapped.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const a = pending;
    pending = null;
    if (a) fn(...a);
  };
  return wrapped;
}

/** 节流包装：每 wait 毫秒最多执行一次，附带 cancel */
export function throttle(fn, wait = 200) {
  let last = 0;
  let timer = null;
  let pending = null;
  const wrapped = (...args) => {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      pending = null;
      fn(...args);
    } else {
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          const a = pending;
          pending = null;
          if (a) fn(...a);
        }, remain);
      }
    }
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return wrapped;
}

/** 创建定时轮询器：页面隐藏可暂停，支持动态改周期与销毁 */
export function createPoller(fn, ms = 1000, { immediate = true, hiddenPause = true } = {}) {
  let timer = null;
  let busy = false;
  let disposed = false;
  let period = ms;

  async function tick() {
    if (disposed || busy) return null;
    if (hiddenPause && document.hidden) return null;
    busy = true;
    try {
      return await fn();
    } catch (err) {
      console.error('poller task failed:', err);
      return null;
    } finally {
      busy = false;
    }
  }

  function onVisible() {
    if (!document.hidden) tick();
  }

  function start() {
    if (disposed || timer !== null) return;
    if (immediate) tick();
    timer = setInterval(tick, period);
    if (hiddenPause) document.addEventListener('visibilitychange', onVisible);
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (hiddenPause) document.removeEventListener('visibilitychange', onVisible);
  }

  function setPeriod(next) {
    const n = Math.max(0, Number(next) || 0);
    if (n === period) return;
    period = n;
    if (timer === null) return;
    clearInterval(timer);
    timer = setInterval(tick, period);
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return {
    start,
    stop,
    dispose,
    tick,
    setPeriod,
    get period() { return period; },
    get running() { return timer !== null; },
  };
}

/** 转出 vdom 的 h 与 dom 创建函数，方便只依赖本模块的调用方 */
export { h, dom } from './vdom.js';

/** 判断当前是否为 macOS 平台 */
export function isMac() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  return /^mac/i.test(p);
}

/** 取平台修饰键的显示名（Cmd / Ctrl） */
export function modLabel() {
  return isMac() ? 'Cmd' : 'Ctrl';
}

/** 判断键盘/鼠标事件是否按下了修饰键 */
export function isMod(e) {
  return !!(e.ctrlKey || e.metaKey);
}
