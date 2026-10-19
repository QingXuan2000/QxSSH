/**
 * core/splitter.js —— 左右分栏的拖拽分隔条
 * 要点：拖动改变分栏宽度并写入偏好持久化，窗口缩放时自动收敛，双击可重置。
 */
import { dom } from './vdom.js';
import { getPref, setPref, delPref } from './prefs.js';

/** 创建可拖动分隔条，返回控制宽度的对象 */
export function createSplitter({ cls = 'qx-splitter', title, key, min = 300, pad = 280, getBody, getPanel }) {
  const el = dom('div', { class: cls, title });
  let width = parseInt(getPref(key), 10) || 0;

  const panel = () => getPanel() || null;
  const maxW = () => Math.max(min, (getBody()?.clientWidth || 0) - pad);

  function applyWidth() {
    const p = panel();
    if (!p) return;
    const cur = parseInt(p.style.flexBasis, 10);
    if (!cur) return;
    p.style.flexBasis = `${Math.min(cur, maxW())}px`;
  }

  function restore() {
    const p = panel();
    if (!p || width <= 0) return;
    p.style.flexBasis = `${Math.min(width, maxW())}px`;
  }

  function reset() {
    width = 0;
    const p = panel();
    if (p) p.style.flexBasis = '';
    delPref(key);
  }

  function setHidden(hidden) {
    el.classList.toggle('hidden', hidden);
  }

  el.addEventListener('mousedown', (e) => {
    const p = panel();
    if (!p) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = p.getBoundingClientRect().width;
    const body = getBody();
    const setW = (w) => {
      const v = Math.round(Math.min(maxW(), Math.max(min, w)));
      p.style.flexBasis = `${v}px`;
    };
    el.classList.add('dragging');
    body?.classList.add('qx-resizing');
    document.body.style.userSelect = 'none';
    const move = (ev) => setW(startW - (ev.clientX - startX));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      el.classList.remove('dragging');
      body?.classList.remove('qx-resizing');
      document.body.style.userSelect = '';
      width = parseInt(p.style.flexBasis, 10) || 0;
      setPref(key, width);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  el.addEventListener('dblclick', reset);

  window.addEventListener('resize', applyWidth);

  return {
    el,
    applyWidth,
    restore,
    reset,
    setHidden,
    destroy: () => window.removeEventListener('resize', applyWidth),
  };
}
