/**
 * core/virtual-list.js —— 长列表虚拟滚动视图
 * 要点：只渲染可视区及预读区的行，行高固定、绝对定位平移；供主机列表、日志等大列表使用。
 */
import { h, useState } from './vdom.js';

const DEFAULT_OVERSCAN = 4;

/** 虚拟列表视图组件：按可视范围渲染行，支持空态、点击和范围回调 */
export function VirtualList(props) {
  const {
    items = [], rowHeight = 32, render, rowKey = null, height = '100%',
    overscan = DEFAULT_OVERSCAN, cls = '', empty = null, onRangeChange = null,
    onRowClick = null, listRef = null,
  } = props;
  const scrollTop = useState(0);
  const viewH = useState(0);
  const rt = useState(() => ({ el: null, ro: null, lastRange: '', dead: false })).value;

  const total = items.length;
  const rh = Math.max(1, Number(rowHeight) || 32);
  const vh = viewH.value;
  const top = scrollTop.value;
  const start = Math.max(0, Math.floor(top / rh) - overscan);
  const visible = vh > 0 ? Math.ceil(vh / rh) : 0;
  const end = Math.min(total, start + visible + overscan * 2);

  if (onRangeChange && vh > 0) {
    const sig = `${start}:${end}`;
    if (sig !== rt.lastRange) {
      rt.lastRange = sig;
      queueMicrotask(() => onRangeChange({ start, end }));
    }
  }

  const rows = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    rows.push(h('div', {
      key: rowKey ? String(rowKey(item, i)) : String(i),
      class: 'qx-vlist-row',
      style: { transform: `translateY(${i * rh}px)`, height: `${rh}px` },
      dataset: { index: String(i) },
      onClick: onRowClick ? (e) => onRowClick(item, i, e) : undefined,
    }, [render ? render(item, i) : String(item)]));
  }

  return h('div', {
    class: `qx-vlist ${cls}`.trim(),
    style: { height },
    onScroll: (e) => { scrollTop.next = e.currentTarget.scrollTop; },
    ref: (el) => {
      rt.el = el;
      if (listRef) listRef.current = el;
    },
    onMount: (el) => {
      const measure = () => { if (!rt.dead && el.clientHeight !== viewH.peek()) viewH.next = el.clientHeight; };
      queueMicrotask(measure);
      if (typeof ResizeObserver === 'function') {
        rt.ro = new ResizeObserver(measure);
        rt.ro.observe(el);
      }
    },
    onUnmount: () => {
      rt.dead = true;
      if (rt.ro) { rt.ro.disconnect(); rt.ro = null; }
      rt.el = null;
      if (listRef) listRef.current = null;
    },
  }, [
    total === 0 && empty != null
      ? h('div', { class: 'qx-vlist-empty' }, [empty])
      : h('div', { class: 'qx-vlist-body', style: { height: `${total * rh}px` } }, rows),
  ]);
}

/** 把指定行滚动到视口内（支持 start/center/end/nearest 对齐） */
export function scrollToRow(el, index, rowHeight, align = 'nearest') {
  if (!el) return;
  const rh = Math.max(1, Number(rowHeight) || 32);
  const rowTop = Math.max(0, index) * rh;
  const viewTop = el.scrollTop;
  const viewH = el.clientHeight;
  let next = viewTop;
  if (align === 'start') next = rowTop;
  else if (align === 'center') next = rowTop - (viewH - rh) / 2;
  else if (align === 'end') next = rowTop - viewH + rh;
  else if (rowTop < viewTop) next = rowTop;
  else if (rowTop + rh > viewTop + viewH) next = rowTop - viewH + rh;
  el.scrollTop = Math.max(0, next);
}
