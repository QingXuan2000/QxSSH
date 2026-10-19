/**
 * core/app-shell.js —— 应用页统一外壳（左侧栏 + 主内容区）
 * 要点：渲染分组式侧边导航与主区，支持切换标签页、追加底部操作项；各应用页用它搭建页面骨架。
 */
import { h, createView } from './vdom.js';
import { signal } from './signal.js';
import { sidebarSections } from './components.js';
import { lang } from './i18n.js';

/** 在容器内建立应用外壳，返回切换标签页、渲染主区与销毁的控制对象 */
export function createAppShell(el, { tabs = [], active = '', onChange = null, actions = [], sideTop = [] } = {}) {
  const tabsSig = signal(tabs);
  const activeSig = signal(active);
  const tailSig = signal([]);

  const main = document.createElement('div');
  main.className = 'qx-main';

  let mainView = null;

  function pick(id) {
    activeSig.next = id;
    onChange?.(id);
  }

  function sideChildren() {
    lang();
    const list = resolveNodes(tabsSig.value);
    const tail = resolveNodes(tailSig.value);
    return [
      ...resolveNodes(sideTop).filter(Boolean),
      list.length ? sidebarSections([{ items: list }], activeSig.value, pick) : null,
      tail.length ? h('div', { class: 'qx-side-spacer' }) : null,
      ...tail,
    ].filter(Boolean);
  }

  const view = createView(el);
  view.update(() => h('div', { class: 'qx-shell' }, [
    h('aside', { class: 'cmp-sidebar' }, sideChildren()),
    main,
  ]));

  function setTabs(next) {
    const list = resolveNodes(next);
    let act = activeSig.value;
    if (list.length && !list.some((t) => t.id === act)) act = list[0].id;
    activeSig.next = act;
    tabsSig.next = next;
  }

  function setActive(id) {
    activeSig.next = id;
  }

  function addActions(nodes) {
    tailSig.next = tailSig.value.concat(Array.isArray(nodes) ? nodes : [nodes]);
  }

  if (typeof actions === 'function' || (Array.isArray(actions) && actions.length)) addActions(actions);

  return {
    main,
    setTabs,
    setActive,
    addActions,
    setMain(render) {
      if (!mainView) mainView = createView(main);
      mainView.update(typeof render === 'function'
        ? () => { lang(); return render(); }
        : render);
    },
    get active() { return activeSig.value; },
    destroy() {
      if (mainView) {
        mainView.unmount();
        mainView = null;
      }
      view.unmount();
    },
  };
}

function resolveNodes(v) {
  const list = typeof v === 'function' ? v() : v;
  const arr = Array.isArray(list) ? list : [list];
  const out = [];
  for (const x of arr) {
    const y = typeof x === 'function' ? x() : x;
    if (Array.isArray(y)) out.push(...y);
    else out.push(y);
  }
  return out;
}
