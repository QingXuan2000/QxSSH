import { h, island } from '/assets/js/core/vdom.js';
import { t } from '/assets/js/core/i18n.js';
import { toast } from '/assets/js/core/ui.js';
import {
  DialogPanel, SwitchToggle, SliderField, selectField, sectionTitle,
} from '/assets/js/core/components.js';
import { getConfig, patchConfig, resetConfig, FONT_STACKS } from './config.js';

const opt = (label, value) => ({ label, value });
const optKey = (labelKey, value) => ({ labelKey, value });

const GROUPS = [
  {
    secKey: 'app.terminal.group-appearance',
    items: [
      {
        key: 'fontFamily', labelKey: 'app.terminal.field-font', type: 'select',
        options: Object.entries(FONT_STACKS).map(([label, value]) => opt(label, value)),
      },
      { key: 'fontSize', labelKey: 'app.terminal.field-font-size', type: 'range', min: 6, max: 32, step: 0.5, unit: 'px' },
      { key: 'lineHeight', labelKey: 'app.terminal.field-line-height', type: 'range', min: 1, max: 2.5, step: 0.05 },
      { key: 'letterSpacing', labelKey: 'app.terminal.field-letter-spacing', type: 'range', min: -2, max: 4, step: 0.5, unit: 'px' },
      {
        key: 'cursorStyle', labelKey: 'app.terminal.field-cursor-style', type: 'select',
        options: [optKey('app.terminal.cursor-block', 'block'), optKey('app.terminal.cursor-bar', 'bar'), optKey('app.terminal.cursor-underline', 'underline')],
      },
      { key: 'cursorBlink', labelKey: 'app.terminal.field-cursor-blink', type: 'bool' },
      { key: 'ligatures', labelKey: 'app.terminal.field-ligatures', type: 'bool', hintKey: 'app.terminal.ligatures-hint' },
    ],
  },
  {
    secKey: 'app.terminal.group-window',
    items: [
      { key: 'frameless', labelKey: 'app.terminal.field-borderless', type: 'bool', hintKey: 'app.terminal.borderless-hint' },
      { key: 'showStatusbar', labelKey: 'app.terminal.field-status-bar', type: 'bool' },
    ],
  },
  {
    secKey: 'app.terminal.group-scroll',
    items: [
      { key: 'scrollback', labelKey: 'app.terminal.field-scrollback', type: 'range', min: 0, max: 50000, step: 500, unitKey: 'app.terminal.unit-lines' },
      { key: 'smoothScroll', labelKey: 'app.terminal.field-smooth-scroll', type: 'bool' },
      {
        key: 'fastScrollModifier', labelKey: 'app.terminal.field-page-scroll-mod', type: 'select',
        options: [opt('Alt', 'alt'), opt('Ctrl', 'ctrl'), opt('Shift', 'shift'), optKey('app.terminal.modifier-none', '')],
      },
    ],
  },
  {
    secKey: 'app.terminal.group-input',
    items: [
      {
        key: 'rightClick', labelKey: 'app.terminal.field-right-click', type: 'select',
        options: [optKey('app.terminal.right-menu', 'menu'), optKey('app.terminal.right-paste', 'paste'), optKey('app.terminal.right-copy-paste', 'copyPaste')],
      },
      { key: 'copyOnSelect', labelKey: 'app.terminal.field-copy-on-select', type: 'bool' },
      { key: 'fontSizeStep', labelKey: 'app.terminal.field-font-step', type: 'range', min: 1, max: 4, step: 0.5 },
    ],
  },
  {
    secKey: 'app.terminal.group-alerts',
    items: [
      {
        key: 'bell', labelKey: 'app.terminal.field-bell', type: 'select',
        options: [optKey('app.terminal.bell-ignore', 'off'), optKey('app.terminal.bell-visual', 'visual'), optKey('app.terminal.bell-sound', 'sound'), optKey('app.terminal.bell-both', 'both')],
      },
      { key: 'showTransferRate', labelKey: 'app.terminal.field-show-rate', type: 'bool' },
    ],
  },
  {
    secKey: 'app.terminal.group-session',
    items: [
      { key: 'restoreSession', labelKey: 'app.terminal.field-restore-layout', type: 'bool', hintKey: 'app.terminal.restore-layout-hint' },
      { key: 'autoReconnect', labelKey: 'app.terminal.field-auto-reconnect', type: 'bool', hintKey: 'app.terminal.auto-reconnect-hint' },
    ],
  },
];

function secLabel(g) { return t(g.secKey); }
function itemLabel(item) { return item.labelKey ? t(item.labelKey) : (item.label || ''); }
function itemHint(item) { return item.hintKey ? t(item.hintKey) : (item.hint || ''); }
function itemUnit(item) { return item.unitKey ? t(item.unitKey) : (item.unit || ''); }
function optLabel(o) { return o.labelKey ? t(o.labelKey) : (o.label || ''); }
function itemOptions(item) {
  return (item.options || []).map((o) => ({ label: optLabel(o), value: o.value }));
}

export function openTermSettings(opts = {}) {
  const snapshot = getConfig();
  let gen = 0;
  let closed = false;
  let handle = null;

  function commit(key, value) {
    patchConfig({ [key]: value });
    if (opts.onChange) opts.onChange(getConfig(), key);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }

  function finish(keep) {
    if (closed) return;
    closed = true;
    if (!keep) {
      patchConfig(snapshot);
      if (opts.onChange) opts.onChange(getConfig(), null);
    }
    document.removeEventListener('keydown', onKey, true);
    if (handle) handle.close();
    if (opts.onClose) opts.onClose(keep);
  }

  function control(item, cur) {
    if (item.type === 'bool') {
      return h(SwitchToggle, {
        label: itemLabel(item),
        checked: !!cur[item.key],
        onChange: (v) => commit(item.key, v),
      });
    }
    if (item.type === 'range') {
      return h(SliderField, {
        label: itemLabel(item),
        value: cur[item.key],
        min: item.min,
        max: item.max,
        step: item.step,
        unit: itemUnit(item),
        onChange: (v) => commit(item.key, v),
      });
    }
    return selectField(itemLabel(item), itemOptions(item), cur[item.key], (v) => commit(item.key, v));
  }

  function fieldRow(item, cur) {
    const hint = itemHint(item);
    return h('div', { key: item.key, class: 'term-set-item' }, [
      control(item, cur),
      hint ? h('div', { class: 'term-set-hint', text: hint }) : null,
    ].filter(Boolean));
  }

  function panelTree() {
    const cur = getConfig();
    return h('div', {
      onMount: (el) => {
        const d = el.querySelector('.dialog');
        if (d) { d.tabIndex = -1; d.focus(); }
      },
      onUnmount: () => document.removeEventListener('keydown', onKey, true),
    }, h(DialogPanel, {
      title: t('app.terminal.dialog-title'),
      width: 'lg',
      onClose: () => finish(false),
      body: [
        h('div', { key: `body-${gen}`, class: 'term-set-body' },
          GROUPS.map((g) => h('div', { key: g.secKey, class: 'term-set-sec' }, [
            sectionTitle(secLabel(g)),
            ...g.items.map((it) => fieldRow(it, cur)),
          ]))),
        h('div', {
          class: 'term-set-hint',
          text: t('app.terminal.dialog-hint'),
        }),
      ],
      actions: [
        h('button', {
          class: 'btn btn-ghost btn-sm',
          text: t('app.terminal.action-restore-defaults'),
          onClick: () => {
            resetConfig();
            gen += 1;
            handle.update(panelTree());
            if (opts.onChange) opts.onChange(getConfig(), null);
            toast(t('app.terminal.restored-defaults'), 'success');
          },
        }),
        h('span', { class: 'qx-grow' }),
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.terminal.action-cancel'), onClick: () => finish(false) }),
        h('button', { class: 'btn btn-primary btn-sm', text: t('app.terminal.action-done'), onClick: () => finish(true) }),
      ],
    }));
  }

  document.addEventListener('keydown', onKey, true);
  handle = island(panelTree());

  return {
    close() { finish(true); },
  };
}
