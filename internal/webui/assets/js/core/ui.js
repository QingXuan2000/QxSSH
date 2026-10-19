/**
 * core/ui.js —— 全局提示与交互反馈
 * 要点：初始化 data-tip 悬浮提示，并提供 toast、确认框、复制与任务包装等页面级通用交互。
 */
import { $, esc } from './dom.js';
import { dom } from './vdom.js';
import { writeClipboard } from './clipboard.js';
import { setupI18n, t } from './i18n.js';
import { focusWindow } from '../app-bridge.js';

setupI18n().catch(() => { });

(function initTooltip() {
  let tipEl = null;
  let target = null;

  function ensureTip() {
    if (!tipEl) { tipEl = dom('div', { id: 'qx-tip' }); document.body.append(tipEl); }
    return tipEl;
  }
  function show(t) {
    const text = t.dataset.tip;
    if (!text) return;
    target = t;
    const tip = ensureTip();
    tip.textContent = text;
    tip.classList.remove('show');
    tip.style.left = '0px'; tip.style.top = '0px';

    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const margin = 8;
    const gap = 8;

    let top = r.top - tr.height - gap;
    if (top < margin) top = r.bottom + gap;

    let left = r.left + r.width / 2 - tr.width / 2;
    if (left < margin) left = r.left;
    if (left + tr.width > innerWidth - margin) left = r.right - tr.width;
    left = Math.max(margin, Math.min(left, innerWidth - margin - tr.width));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.classList.add('show');
  }
  function hide() {
    target = null;
    tipEl?.classList.remove('show');
  }

  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest?.('[data-tip]')) hide();
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', (e) => { if (target && !target.contains(e.target)) hide(); }, true);
})();

const MSG_ICON = {
  success: '<svg class="message-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M7 10l2 2 4-4"/></svg>',
  error: '<svg class="message-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/></svg>',
  warning: '<svg class="message-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 6v4.5M10 13.5h.01"/></svg>',
  info: '<svg class="message-ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 9v4.5M10 6.5h.01"/></svg>',
};
const CLOSE_ICON = '<svg class="qicon qicon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** 右上角弹出轻提示，可选 success/error/warning/info 类型 */
export function toast(text, type = 'info', timeout = 3600) {
  let box = $('#messages');
  if (!box) { box = dom('div', { id: 'messages' }); document.body.append(box); }
  const el = dom('div', {
    class: `message message-${type}`,
    html: `${MSG_ICON[type] || MSG_ICON.info}<span class="message-content">${esc(text)}</span>`,
  }, dom('button', {
    class: 'message-close',
    'aria-label': t('core.ui.close'),
    html: CLOSE_ICON,
    onClick: () => el.remove(),
  }));
  box.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

/** 弹出确认对话框，返回用户是否确认 */
export function confirmAction(title, desc, { okText = t('core.ui.confirm-ok-default'), danger = true } = {}) {
  try { focusWindow(); } catch { }
  return new Promise((resolve) => {
    const okBtn = dom('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm` }, okText);
    const cancelBtn = dom('button', { class: 'btn btn-ghost btn-sm' }, t('core.ui.cancel'));
    const ic = danger
      ? '<svg class="qicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4.5M12 17h.01"/></svg>'
      : '<svg class="qicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>';
    const mask = dom('div', { class: 'overlay' }, [
      dom('div', { class: 'dialog dialog-sm' }, [
        dom('div', { class: 'confirm-body' }, [
          dom('div', { class: `confirm-ic ${danger ? '' : 'confirm-ic-info'}`, html: ic }),
          dom('div', { class: 'confirm-content' }, [
            dom('div', { class: 'confirm-title', text: title }),
            dom('div', { class: 'confirm-desc', text: desc }),
          ]),
        ]),
        dom('div', { class: 'dialog-foot' }, [cancelBtn, okBtn]),
      ]),
    ]);
    const close = (v) => { mask.remove(); resolve(v); };
    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    document.body.append(mask);
    okBtn.focus();
  });
}

/** 复制文本到剪贴板，返回是否成功 */
export async function copyText(text) {
  return writeClipboard(text);
}

/** 包装异步任务：成功可提示、失败自动报错，避免各处重复 try/catch */
export async function task(fn, { ok = '', err = t('core.ui.task-failed'), rethrow = false } = {}) {
  try {
    const result = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(result) : ok, 'success');
    return result;
  } catch (e) {
    toast(`${typeof err === 'function' ? err(e) : err}：${e.message}`, 'error');
    if (rethrow) throw e;
    return undefined;
  }
}
