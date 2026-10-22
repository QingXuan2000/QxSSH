/**
 * core/vdom.js —— 轻量虚拟 DOM 运行时
 * 要点：提供 h/组件/Fragment/Portal 与挂载、diff、卸载流程，并配合 signal 在依赖变化时自动重渲染；前端界面基本都经它渲染。
 */
import { effect, signal } from './signal.js';

const VNODE = Symbol('qx.vnode');

const TEXT = '#text';
const FRAG = '#frag';
const PORTAL = '#portal';

const EV_RE = /^on[A-Z]/;

const META = new Set(['key', 'ref', 'memo', 'onMount', 'onUnmount']);

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'rect', 'text', 'tspan', 'defs', 'use', 'symbol', 'marker', 'clipPath',
  'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'filter',
  'feGaussianBlur', 'feOffset', 'feBlend', 'feMerge', 'feMergeNode',
  'foreignObject', 'image', 'title', 'desc',
]);

const SHOW = new Set(['class', 'style', 'text', 'html', 'dataset']);

const HOOK = /^on[A-Z]/;

let uid = 0;

/** 创建虚拟节点：标签名、组件函数或特殊节点 */
export function h(type, props = {}, children = []) {
  const p = props || {};
  const t = type === Fragment ? FRAG : type === Portal ? PORTAL : type;
  const vnode = {
    [VNODE]: true,
    uid: uid++,
    type: t,
    props: p,
    key: p.key != null ? String(p.key) : null,
    children: null,
    el: null,
    anchor: null,
    component: null,
    sig: null,
  };
  vnode.children = normalizeChildren(children);
  return vnode;
}

/** 创建文本节点 */
export function text(value) {
  return h(TEXT, { nodeValue: String(value) });
}

/** 直接创建并返回真实 DOM 元素 */
export function dom(tag, props = {}, children = []) {
  const holder = document.createElement('div');
  return mount(h(tag, props, children), holder, null, null, newStats());
}

/** 片段节点：自身不产生元素，仅聚合多个子节点 */
export function Fragment(props, children) {
  return h(FRAG, props || {}, children);
}

/** 传送门节点：把子节点渲染到指定容器 */
export function Portal(to, children) {
  return h(PORTAL, { to }, children);
}

/** 判断是否为虚拟节点 */
export function isVNode(x) {
  return !!(x && x[VNODE] === true);
}

/** 判断节点类型是否为组件函数 */
export function isComponent(type) {
  return typeof type === 'function';
}

/** 把任意子节点输入拍平为虚拟节点数组 */
export function normalizeChildren(input) {
  const out = [];
  walk(input, out);
  return out;
}

function walk(input, out) {
  const list = Array.isArray(input) ? input : [input];
  for (const c of list) {
    if (c == null || c === false || c === true) continue;
    if (isVNode(c)) { out.push(c); continue; }
    if (Array.isArray(c)) { walk(c, out); continue; }
    if (typeof c === 'object' && typeof c.nodeType === 'number') {
      out.push(h(RAW, { dom: c }));
      continue;
    }
    out.push(text(c));
  }
}

const RAW = '#dom';

/** 创建挂载/更新统计对象 */
export function newStats() {
  return { created: 0, updated: 0, moved: 0, removed: 0, skipped: 0 };
}

/** 把虚拟节点挂载到容器，返回对应的真实 DOM 节点 */
export function mount(vnode, container, anchor, parent, stats) {
  const st = stats || newStats();
  const { type, props } = vnode;

  if (type === TEXT) {
    vnode.el = document.createTextNode(props.nodeValue != null ? props.nodeValue : (props.text || ''));
    place(container, vnode.el, anchor);
    st.created++;
    return vnode.el;
  }
  if (type === RAW) {
    vnode.el = props.dom;
    place(container, vnode.el, anchor);
    return vnode.el;
  }
  if (type === FRAG) {
    vnode.anchor = document.createTextNode('');
    for (const c of vnode.children) mount(c, container, vnode.anchor, parent, st);
    place(container, vnode.anchor, anchor);
    vnode.el = vnode.children.length ? vnode.children[0].el : vnode.anchor;
    callHook(vnode, 'onMount');
    return vnode.el;
  }
  if (type === PORTAL) {
    vnode.anchor = document.createTextNode('');
    vnode.el = vnode.anchor;
    place(container, vnode.anchor, anchor);
    for (const c of vnode.children) mount(c, props.to, null, parent, st);
    callHook(vnode, 'onMount');
    return vnode.el;
  }
  if (isComponent(type)) {
    mountComponent(vnode, container, anchor, parent, st);
    return vnode.el;
  }

  if (typeof type !== 'string' || type.startsWith('#')) {
    throw new Error(`[vdom] ${String(type)} 不是合法标签名`);
  }
  const el = SVG_TAGS.has(type) ? document.createElementNS(SVG_NS, type) : document.createElement(type);
  vnode.el = el;
  applyProps(el, props, undefined);
  for (const c of vnode.children) mount(c, el, null, parent, st);
  place(container, el, anchor);
  st.created++;
  if (typeof props.ref === 'function') props.ref(el);
  else if (props.ref && typeof props.ref === 'object') props.ref.current = el;
  if (typeof props.onMount === 'function') props.onMount(el);
  return el;
}

function mountComponent(vnode, container, anchor, parent, st) {
  const { type } = vnode;
  const instance = {
    vnode,
    type,
    props: vnode.props,
    parent,
    subTree: null,
    isUnmounted: false,
    mounted: false,
    runner: null,
    api: null,
    slots: [],
    stateIndex: 0,
  };
  vnode.component = instance;

  instance.api = {
    update: () => instance.runner && instance.runner.run(),
    get props() { return instance.props; },
    get unmounted() { return instance.isUnmounted; },
  };

  instance.container = container;
  instance.anchor = anchor;

  instance.runner = effect(() => {
    if (instance.isUnmounted) return;
    const next = renderComponent(instance);
    const prev = instance.subTree;
    instance.subTree = next;
    if (prev == null) {
      mount(next, instance.container, instance.anchor, instance, st);
    } else {
      patch(prev, next, hostParent(prev), nextHostNode(prev), instance, st);
    }
    const v = instance.vnode;
    v.el = next.el;
    v.anchor = next.anchor;
    if (!instance.mounted) {
      instance.mounted = true;
      if (typeof instance.props.onMount === 'function') instance.props.onMount(instance.api);
    }
  });
}

let currentInstance = null;

/** 组件内声明响应式状态，同一渲染位置复用同一个信号 */
export function useState(initial) {
  const inst = currentInstance;
  if (!inst) return signal(typeof initial === 'function' ? initial() : initial);
  const i = inst.stateIndex++;
  if (inst.slots.length <= i) {
    inst.slots[i] = signal(typeof initial === 'function' ? initial() : initial);
  }
  return inst.slots[i];
}

function renderComponent(instance) {
  instance.stateIndex = 0;
  const prevInstance = currentInstance;
  currentInstance = instance;
  let out;
  try {
    out = instance.type(instance.props);
  } finally {
    currentInstance = prevInstance;
  }
  if (out == null || out === false) return h(FRAG, {}, []);
  if (Array.isArray(out)) return h(FRAG, {}, out);
  if (!isVNode(out)) return text(out);
  return out;
}

/** 对比新旧虚拟节点并最小化更新真实 DOM */
export function patch(n1, n2, container, anchor, parent, stats) {
  const st = stats || newStats();

  if (n2 == null || n2 === false || n2 === true) {
    if (n1) { unmount(n1); st.removed++; }
    return null;
  }
  if (n1 == null) return mount(n2, container, anchor, parent, st);

  if (n1.type !== n2.type) {
    const el = mount(n2, container, nextHostNode(n1), parent, st);
    unmount(n1);
    st.removed++;
    return el;
  }

  const { type } = n2;
  if (type === TEXT) {
    const s = n2.props.nodeValue != null ? n2.props.nodeValue : (n2.props.text || '');
    if (n1.el.nodeValue !== s) { n1.el.nodeValue = s; st.updated++; }
    else st.skipped++;
    n2.el = n1.el;
    n2.anchor = n1.anchor;
    return n2.el;
  }
  if (type === RAW) {
    const d = n2.props.dom;
    if (n1 && n1.props && n1.props.dom && n1.props.dom !== d) {
      const old = n1.props.dom;
      if (old.parentNode) { old.parentNode.removeChild(old); st.removed++; }
    }
    if (n1 && n1.el === d) {
      n2.el = d;
      place(container, d, anchor);
      return d;
    }
    n2.el = d;
    place(container, d, anchor);
    st.created++;
    return d;
  }
  if (type === FRAG) {
    n2.anchor = n1.anchor;
    n2.el = n1.el;
    patchChildren(n1, n2, container, parent, st, n2.anchor);
    return n2.el;
  }
  if (type === PORTAL) {
    n2.anchor = n1.anchor;
    n2.el = n1.el;
    if (n1.props.to !== n2.props.to) {
      for (const c of n1.children) unmount(c);
      n1.children = [];
      for (const c of n2.children) mount(c, n2.props.to, null, parent, st);
      return n2.el;
    }
    patchChildren(n1, n2, n2.props.to, parent, st);
    return n2.el;
  }
  if (isComponent(type)) {
    updateComponent(n1, n2, hostParent(n1), nextHostNode(n1), parent, st);
    return n2.el;
  }

  if (memoMatch(n1, n2)) { st.skipped++; n2.el = n1.el; return n2.el; }
  const el = n2.el = n1.el;
  n2.anchor = n1.anchor;
  if (patchProps(el, n2.props, n1.props)) st.updated++;
  else st.skipped++;
  patchChildren(n1, n2, el, parent, st);
  if (typeof n2.props.ref === 'function') n2.props.ref(el);
  else if (n2.props.ref && typeof n2.props.ref === 'object') n2.props.ref.current = el;
  return el;
}

function memoMatch(n1, n2) {
  if (!n2.props.memo) return false;
  if (n2.sig == null) n2.sig = vnodeHTML(n2);
  return n1.el.outerHTML === n2.sig;
}

function updateComponent(n1, n2, container, anchor, parent, st) {
  const inst = n1.component;
  n2.component = inst;
  n2.el = n1.el;
  n2.anchor = n1.anchor;
  if (!inst) { mountComponent(n2, container, anchor, parent, st); return; }
  inst.vnode = n2;
  inst.props = n2.props;
  inst.container = container;
  inst.anchor = anchor;
  if (shallowEqual(n1.props, n2.props)) { st.skipped++; return; }
  st.updated++;
  inst.runner.run();
}

/** 浅比较两个对象的属性是否完全一致 */
export function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function patchChildren(n1, n2, container, parent, st, endAnchor = null) {
  const c1 = n1.children;
  const c2 = n2.children;
  const len1 = c1.length;
  const len2 = c2.length;
  const allKeyed = len1 > 0 && len2 > 0
    && c1.every((c) => c.key != null) && c2.every((c) => c.key != null);

  if (allKeyed) {
    const oldByKey = new Map(c1.map((c) => [c.key, c]));
    const used = new Set();
    for (const child of c2) {
      const old = oldByKey.get(child.key);
      if (old) used.add(old);
      patch(old, child, container, old ? nextHostNode(old) : endAnchor, parent, st);
    }
    for (const old of c1) {
      if (used.has(old)) continue;
      unmount(old);
      st.removed++;
    }
    orderChildren(container, c2, st, endAnchor);
    return;
  }
  patchUnkeyed(c1, c2, container, parent, st, endAnchor);
}

function orderChildren(container, children, st, endAnchor = null) {
  let next = endAnchor;
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i].el;
    if (!node) continue;
    if (node.parentNode !== container || node.nextSibling !== next) {
      container.insertBefore(node, next);
      st.moved++;
    }
    next = node;
  }
}

function patchUnkeyed(c1, c2, container, parent, st, endAnchor = null) {
  const len = Math.max(c1.length, c2.length);
  for (let i = 0; i < len; i++) {
    const old = i < c1.length ? c1[i] : null;
    const next = i < c2.length ? c2[i] : null;
    const anchor = old ? nextHostNode(old) : endAnchor;
    patch(old, next, container, anchor, parent, st);
  }
}

/** 卸载虚拟节点及其子树，并触发 onUnmount */
export function unmount(vnode) {
  if (!vnode) return;
  if (vnode.component) { unmountComponent(vnode.component); return; }
  if (vnode.type === RAW) {
    const d = vnode.props && vnode.props.dom;
    if (d && d.parentNode) d.parentNode.removeChild(d);
    return;
  }
  if (vnode.type === PORTAL) {
    callHook(vnode, 'onUnmount');
    for (const c of vnode.children) unmount(c);
    return;
  }
  if (vnode.type === FRAG) {
    callHook(vnode, 'onUnmount');
    for (const c of vnode.children) unmount(c);
    if (vnode.anchor && vnode.anchor.parentNode) vnode.anchor.parentNode.removeChild(vnode.anchor);
    return;
  }
  callHook(vnode, 'onUnmount');
  for (const c of vnode.children) unmount(c);
  if (vnode.el && vnode.el.parentNode) vnode.el.parentNode.removeChild(vnode.el);
}

function callHook(vnode, name) {
  const fn = vnode.props && vnode.props[name];
  if (typeof fn !== 'function') return;
  try {
    fn(vnode.el);
  } catch (err) {
    console.error(`[vdom] ${name} 抛错，已忽略`, err);
  }
}

function unmountComponent(instance) {
  if (instance.isUnmounted) return;
  instance.isUnmounted = true;
  if (instance.runner) instance.runner.stop();
  const hook = instance.props.onUnmount;
  if (typeof hook === 'function') {
    try {
      hook(instance.api);
    } catch (err) {
      console.error('[vdom] 组件 onUnmount 抛错，已忽略', err);
    }
  }
  if (instance.subTree) unmount(instance.subTree);
  instance.subTree = null;
}

/** 取节点之后的兄弟节点，用作插入锚点 */
export function nextHostNode(vnode) {
  if (!vnode) return null;
  const last = vnode.anchor || vnode.el;
  return last ? last.nextSibling : null;
}

function hostParent(vnode) {
  const node = vnode.el;
  return node ? node.parentNode : null;
}

function applyProps(el, props, old) {
  for (const k of Object.keys(props)) {
    if (META.has(k)) continue;
    if (props[k] === (old && old[k])) continue;
    setProp(el, k, props[k], old && old[k]);
  }
  syncOn(el, collectOn(props), collectOn(old));
}

function patchProps(el, next, prev) {
  const n = next || {};
  const o = prev || {};
  let changed = false;
  for (const k of Object.keys(n)) {
    if (META.has(k)) continue;
    if (n[k] === o[k]) continue;
    setProp(el, k, n[k], o[k]);
    changed = true;
  }
  for (const k of Object.keys(o)) {
    if (META.has(k) || k in n) continue;
    setProp(el, k, null, o[k]);
    changed = true;
  }
  if (syncOn(el, collectOn(n), collectOn(o))) changed = true;
  return changed;
}

function setProp(el, k, val, old) {
  switch (k) {
    case 'class':
      if (val == null || val === '') el.removeAttribute('class');
      else el.setAttribute('class', String(val));
      return;
    case 'text':
      el.textContent = val == null ? '' : String(val);
      return;
    case 'html':
      el.innerHTML = val == null ? '' : String(val);
      return;
    case 'style':
      applyStyle(el, val, old);
      return;
    case 'dataset':
      applyDataset(el, val, old);
      return;
    case 'on':
      return;
    default:
      break;
  }
  if (HOOK.test(k) && typeof val === 'function') return;
  if (k === 'nodeValue') { el.nodeValue = val == null ? '' : String(val); return; }
  if (IDL_PROPS.has(k) && k in el) {
    const cur = k === 'value' && el.tagName === 'OPTION' ? el.getAttribute('value') : el[k];
    const want = k === 'value' ? (val == null ? '' : String(val)) : (val == null ? false : val);
    if (cur !== want) el[k] = want;
    return;
  }
  if (val == null || val === false) el.removeAttribute(k);
  else if (val === true) el.setAttribute(k, '');
  else el.setAttribute(k, String(val));
}

function applyStyle(el, next, old) {
  if (typeof next === 'string') {
    el.style.cssText = next;
    return;
  }
  const n = next || {};
  const o = old || {};
  for (const k of Object.keys(o)) {
    if (k in n) continue;
    if (isCustomProp(k)) el.style.removeProperty(k);
    else el.style[toCamel(k)] = '';
  }
  for (const k of Object.keys(n)) {
    if (o[k] === n[k]) continue;
    if (isCustomProp(k)) el.style.setProperty(k, n[k]);
    else el.style[toCamel(k)] = n[k];
  }
}

function isCustomProp(k) {
  return k.startsWith('--');
}

function toCamel(k) {
  return k.includes('-') ? k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : k;
}

function applyDataset(el, next, old) {
  const n = next || {};
  const o = old || {};
  for (const k of Object.keys(o)) {
    if (k in n) continue;
    delete el.dataset[k];
  }
  for (const k of Object.keys(n)) {
    if (o[k] === n[k]) continue;
    el.dataset[k] = n[k];
  }
}

function collectOn(props) {
  const out = {};
  const p = props || {};
  if (p.on) {
    for (const [t, fn] of Object.entries(p.on)) {
      const n = String(t).toLowerCase();
      out[EVENT_ALIAS[n] || n] = fn;
    }
  }
  for (const [k, v] of Object.entries(p)) {
    if (!EV_RE.test(k) || typeof v !== 'function' || isHook(k)) continue;
    const n = k.slice(2).toLowerCase();
    out[EVENT_ALIAS[n] || n] = v;
  }
  return out;
}

const EVENT_ALIAS = { context: 'contextmenu' };

const HOOKS = new Set(['onMount', 'onUnmount']);

const IDL_PROPS = new Set(['value', 'checked', 'selected', 'muted', 'volume', 'srcObject']);

function isHook(k) {
  return HOOKS.has(k);
}

function syncOn(el, next, prev) {
  let changed = false;
  for (const t of Object.keys(prev)) {
    if (next[t] === prev[t]) continue;
    el.removeEventListener(t, prev[t]);
    changed = true;
  }
  for (const t of Object.keys(next)) {
    if (next[t] === prev[t]) continue;
    el.addEventListener(t, next[t]);
    changed = true;
  }
  return changed;
}

/** 创建视图：传入渲染函数即自动重渲染，可暂停、恢复与卸载 */
export function createView(container, opts = {}) {
  let treeFn = null;
  let root = null;
  let owned = null;
  let last = newStats();
  const onError = opts.onError || ((e) => console.error('[vdom] 渲染失败：', e));
  const totals = { ...newStats(), renders: 0 };

  function renderOnce() {
    const st = newStats();
    const tree = h(FRAG, {}, normalizeChildren(treeFn()));
    try {
      if (root == null || !stillOurs()) {
        if (root) unmount(root);
        root = null;
        container.replaceChildren();
        mount(tree, container, null, null, st);
      } else {
        patch(root, tree, container, null, null, st);
      }
      root = tree;
      owned = nodesOf(container);
    } catch (e) {
      root = null;
      owned = null;
      onError(e);
    }
    totals.renders++;
    totals.created += st.created;
    totals.updated += st.updated;
    totals.moved += st.moved;
    totals.removed += st.removed;
    totals.skipped += st.skipped;
    last = st;
  }

  const runner = effect(() => {
    if (treeFn == null) return;
    renderOnce();
  });

  function stillOurs() {
    if (owned === null) return true;
    const now = nodesOf(container);
    if (now.length !== owned.length) return false;
    for (let i = 0; i < owned.length; i++) {
      if (now[i] !== owned[i]) return false;
    }
    return true;
  }

  return {
    update(next) {
      treeFn = typeof next === 'function' ? next : () => next;
      runner.run();
      return { ...last };
    },
    get el() { return container; },
    get tree() { return root; },
    get stats() { return { ...totals }; },
    pause() { runner.stop(); },
    resume() { runner.run(); },
    unmount() {
      runner.stop();
      if (root) unmount(root);
      root = null;
      owned = null;
      container.replaceChildren();
    },
  };
}

function nodesOf(parent) {
  const out = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) out.push(n);
  return out;
}

function place(parent, node, anchor) {
  if (!node) return;
  if (anchor && anchor.parentNode === parent) {
    if (node.parentNode === parent && node.nextSibling === anchor) return;
    parent.insertBefore(node, anchor);
    return;
  }
  if (node.parentNode === parent && node.nextSibling === null) return;
  parent.appendChild(node);
}

/** 一次性把虚拟节点渲染进容器，返回视图句柄 */
export function render(container, vnode) {
  const view = createView(container);
  view.update(vnode);
  return view;
}

/** 在指定容器挂一个独立浮层视图，返回可关闭、可更新的句柄 */
export function island(vnode, to = document.body) {
  const host = document.createElement('div');
  host.className = 'qx-island';
  to.appendChild(host);
  const view = createView(host);
  view.update(vnode);
  const handle = {
    el: host,
    closed: false,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      view.unmount();
      if (host.parentNode) host.parentNode.removeChild(host);
    },
    update: (next) => view.update(next),
    stats: () => view.stats,
  };
  return handle;
}

/** 把虚拟节点序列化为 HTML 字符串（供 memo 比较等场景使用） */
export function vnodeHTML(input) {
  if (Array.isArray(input)) return input.map(vnodeHTML).join('');
  if (!isVNode(input)) return String(input);
  if (input.type === TEXT) return input.props.nodeValue != null ? input.props.nodeValue : '';
  if (input.type === RAW) return input.props.dom ? input.props.dom.outerHTML : '';
  const p = input.props || {};
  const attrs = [];
  if (p.class != null && p.class !== '') attrs.push(`class="${p.class}"`);
  for (const [k, val] of Object.entries(p)) {
    if (META.has(k) || SHOW.has(k)) continue;
    if (typeof val === 'function' || val == null || val === false) continue;
    attrs.push(`${k}="${val}"`);
  }
  if (p.style && Object.keys(p.style).length) {
    attrs.push(`style="${Object.entries(p.style).map(([k, val]) => `${k}:${val}`).join(';')}"`);
  }
  const head = attrs.length ? ` ${attrs.join(' ')}` : '';
  const inner = p.html != null ? p.html
    : p.text != null && !input.children.length ? String(p.text)
      : input.children.map(vnodeHTML).join('');
  return `<${input.type}${head}>${inner}</${input.type}>`;
}
