/**
 * core/i18n-ui.js —— 面向应用的国际化界面件
 * 要点：在应用内加载自带词表，并提供语言切换的分段选择、单键轮换、下拉菜单与自动重渲染包装。
 */
import { h } from './vdom.js';
import { openPopper, segmented } from './components.js';
import { icon } from '../icons/index.js';
import {
  LANGUAGES, t, tf, lang, setLang, onLangChange, setupI18n, currentLangs,
} from './i18n.js';

/** 按应用目录初始化词表（默认取应用自带的 language/ 目录） */
export async function setupAppI18n(opts = {}) {
  const o = typeof opts === 'string' ? { base: opts } : (opts || {});
  const dir = o.base || new URL('./language', import.meta.url).href;
  return setupI18n(dir, { languages: o.languages, scope: o.scope });
}

/** 语言分段选择器，切换语言后自动重渲染 */
export function i18nSelect({ languages = null, cls = '', onChange = null } = {}) {
  const langs = languages || currentLangs();
  return h(() => {
    const cur = lang();
    return segmented(
      langs.map((l) => ({ value: l.code, label: l.label })),
      cur,
      (code) => switchTo(code, onChange),
      { cls }
    );
  });
}

/** 按顺序轮换语言的按钮 */
export function i18nButton({ languages = null, cls = '', onChange = null } = {}) {
  const langs = languages || currentLangs();
  return h('button', {
    class: cls,
    type: 'button',
    onClick: () => {
      const cur = lang();
      const i = langs.findIndex((l) => l.code === cur);
      switchTo(langs[(i + 1) % langs.length].code, onChange);
    },
  }, []);
}

function LangPanel({ languages, cls = '', onClose = null, onPick = null }) {
  const cur = lang();
  const langs = languages || currentLangs();
  return h('div', { class: `cmp-pop-menu ${cls}`.trim() }, langs.map((l) => h('button', {
    key: l.code,
    class: `cmp-pop-item${cur === l.code ? ' active' : ''}`,
    type: 'button',
    onClick: () => {
      onClose?.();
      onPick?.(l.code);
    },
  }, [
    h('span', { class: 'cmp-pop-item-name', lang: l.code, text: l.label }),
    cur === l.code ? h('span', { class: 'cmp-pop-item-tick', html: icon('check', 'qicon qicon-sm') }) : null,
  ].filter(Boolean))));
}

/** 带下拉面板的语言切换菜单 */
export function i18nMenu({
  languages = null, cls = '', panelCls = '', placement = 'bottom',
  onChange = null, onToggle = null,
} = {}) {
  const langs = languages || currentLangs();
  const curLabel = (langs.find((l) => l.code === lang()) || langs[0] || {}).label || '';
  const anchor = { current: null };
  const handle = { current: null };
  return h('button', {
    class: cls,
    type: 'button',
    ref: (el) => { anchor.current = el; },
    'aria-label': tf('core.i18n.lang-button', { v1: curLabel }),
    dataset: { tip: tf('core.i18n.lang-button', { v1: curLabel }) },
    html: `${icon('globe', 'qicon qicon-sm')}<span class="cmp-pop-trigger-label">${curLabel}</span>`,
    onClick: (e) => {
      e.stopPropagation();
      if (handle.current && !handle.current.closed) { handle.current.close(); return; }
      const p = openPopper(LangPanel, {
        anchor: anchor.current,
        placement,
        cls: panelCls,
        onClose: () => { handle.current = null; onToggle?.(false); },
        props: { languages: langs, onPick: (code) => switchTo(code, onChange) },
      });
      handle.current = p;
      onToggle?.(true);
    },
  });
}

/** 包装渲染函数：语言变化后自动重新渲染并替换内容 */
export function withI18n(renderFn) {
  return h(() => {
    lang();
    return h('div', { class: 'i18n-scope' }, [renderFn()]);
  });
}

function switchTo(code, onChange) {
  setLang(code).then((now) => onChange && onChange(now === code ? code : null, now))
    .catch(() => onChange && onChange(null, code));
}

/** 转出国际化取值与语言接口，便于应用只依赖本文件 */
export { t, tf, LANGUAGES, lang, setLang, onLangChange, currentLangs };