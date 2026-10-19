/**
 * pages/boot.js —— 启动页（主机选择）
 * 要点：列出主机并探测系统信息生成图标，支持分组检索、主题切换与新建/编辑主机，选定后进入该主机桌面。
 */
import { $, createPoller } from '../core/dom.js';
import { PREFS_CACHE_KEY } from '../core/prefs-cache.js';
import { h, createView } from '../core/vdom.js';
import { signal, effect } from '../core/signal.js';
import { loadHosts, getState, subscribe } from '../core/store.js';
import { probeHost, prefsAll } from '../core/qxssh-api.js';
import { readCachedPref, setPref, loadPrefs } from '../core/prefs.js';
import { applyWallpaper, TARGET_BOOT } from '../desktop/wallpaper.js';
import { openHostForm } from './host-form.js';
import { toast } from '../core/ui.js';
import {
  setupI18n, t, tf, lang,
} from '../core/i18n.js';
import { i18nMenu as I18nMenu } from '../core/i18n-ui.js';
import { icon } from '../icons/index.js';

const PROBE_CONCURRENCY = 4;
const PROBE_INTERVAL_MS = 15000;

const node = { search: null, group: null };

const probes = signal(new Map());

const osIds = signal(new Map());

const osNames = signal(new Map());

const selectedId = signal('');
const query = signal('');

const groupFilter = signal('');

const loadErr = signal('');

const themeTick = signal(0);

const tick = signal(0);

let prober = null;

let formDlg = null;

const THEMES = [
  { id: 'system', icon: 'monitor', key: 'app.boot.theme-system' },
  { id: 'light', icon: 'sun', key: 'app.boot.theme-light' },
  { id: 'dark', icon: 'moon', key: 'app.boot.theme-dark' },
];

function isDark() {
  const pref = readCachedPref('qx-theme') || 'system';
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return document.documentElement.classList.contains('dark')
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme() {
  const dark = isDark();
  if (document.documentElement.classList.contains('dark') !== dark) {
    document.documentElement.classList.toggle('dark', dark);
  }
}

function repaintWallpaper() {
  applyWallpaper(TARGET_BOOT).catch((err) => console.warn('[boot] wallpaper', err));
}

function cycleTheme() {
  const cur = readCachedPref('qx-theme') || 'system';
  setPref('qx-theme', THEMES[(THEMES.findIndex((x) => x.id === cur) + 1) % THEMES.length].id);
  applyTheme();
  repaintWallpaper();
  themeTick.next = themeTick.value + 1;
}

function allGroups() {
  return [...new Set((getState().hosts || []).map((x) => x.group).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

function probeOf(id) {
  return probes.value.get(id) || { state: 'idle' };
}

function setProbe(id, val) {
  probes.next = new Map(probes.value).set(id, val);
}

const STATE_INFO = {
  ok: {
    kind: 'online', cls: 'online', textKey: 'app.boot.status-online',
    hintKey: 'app.boot.press-enter', toastKey: '',
  },
  fail: {
    kind: 'offline', cls: 'offline', textKey: 'app.boot.status-offline',
    hintKey: 'app.boot.status-offline-hint', toastKey: 'app.boot.ssh-failed',
  },
  testing: {
    kind: 'pending', cls: 'probing', textKey: 'app.boot.probing',
    hintKey: 'app.boot.probing-now', toastKey: 'app.boot.probing-retry',
  },
  idle: {
    kind: 'pending', cls: 'idle', textKey: null,
    hintKey: 'app.boot.probing-now', toastKey: 'app.boot.probing-retry',
  },
};

function stateOf(st) {
  const s = STATE_INFO[st.state] || STATE_INFO.idle;
  return {
    kind: s.kind,
    cls: s.cls,
    text: s.textKey ? t(s.textKey) : '—',
    hint: t(s.hintKey),
    toast: s.toastKey ? t(s.toastKey) : '',
  };
}

function canEnter(st) {
  return stateOf(st).kind === 'online';
}

function openForm(host) {
  if (formDlg && formDlg.isOpen) return formDlg;
  formDlg = openHostForm({
    host,
    groups: allGroups(),
    onSaved: async () => {
      try {
        await loadHosts();
        if (host) setProbe(host.id, { state: 'testing' });
        await runProbes();
      } catch (err) {
        toast(tf('app.boot.refresh-failed', { v1: (err.message) }), 'error');
      }
    },
  });
  return formDlg;
}

function statusCell(st) {
  const s = stateOf(st);
  return h('span', { class: `boot-st ${s.cls}` }, [
    h('i', { class: 'boot-dot' }), h('span', { text: s.text }),
  ]);
}

function latencyCell(st) {
  if (!canEnter(st)) return h('span', { class: 'boot-lat pending', text: '—' });
  const tcp = st.tcpMs >= 0
    ? h('span', { class: 'boot-lat-tcp', title: t('app.boot.latency-tcp'), text: `TCP ${st.tcpMs}ms` })
    : h('span', { class: 'boot-lat-tcp na', title: t('app.boot.latency-tcp-jump'), text: 'TCP —' });
  return h('span', { class: 'boot-lat' }, [
    tcp,
    h('span', { class: 'boot-lat-ssh', title: t('app.boot.latency-ssh'), text: `SSH ${st.handshakeMs}ms` }),
  ]);
}

function osIconCell(host) {
  const osId = osIds.value.get(host.id) || host.osId || 'linux';
  const osName = osNames.value.get(host.id) || host.osName || '';
  return h('span', { class: 'boot-os' }, [
    h('img', {
      class: 'boot-os-icon',
      src: `/assets/images/icon/systems/${osId}.png`,
      title: osName ? tf('app.boot.host-os', { v1: osName }) : t('app.boot.host-os-detecting'),
      alt: '',
    }),
  ]);
}

function entryRow(host, i, sel) {
  const st = probeOf(host.id);

  const jump = host.jumpHostId
    ? h('span', {
      class: 'boot-jump',
      dataset: { tip: tf('app.boot.host-jump-detail', { v1: (host.jumpHostName || host.jumpHostId) }) },
      text: tf('app.boot.host-jump-short', { v1: host.jumpHostName || t('app.boot.jump-fallback') }),
    })
    : null;

  return h('div', {
    key: host.id,
    class: `boot-entry${sel ? ' sel' : ''}${stateOf(st).kind === 'offline' ? ' offline' : ''}`,
    role: 'option',
    tabindex: '-1',
    'aria-selected': sel ? 'true' : 'false',
    onClick: () => { enter(host.id).catch(() => {}); },
    onMouseenter: () => { if (selectedId.value !== host.id) selectedId.next = host.id; },
  }, [
    h('span', { class: 'boot-idx', text: String(i + 1).padStart(2, '0') }),
    osIconCell(host),
    h('span', { class: 'boot-name', text: host.name }),
    jump,
    h('span', { class: 'boot-addr', text: `${host.user}@${host.address}:${host.port}` }),
    statusCell(st),
    latencyCell(st),
    h('button', {
      class: 'boot-info',
      type: 'button',
      html: icon('edit', 'qicon qicon-sm'),
      'aria-label': tf('app.boot.edit-host', { v1: (host.name) }),
      dataset: { tip: t('app.boot.edit-host-label') },
      onClick: (e) => { e.stopPropagation(); openForm(host); },
    }),
  ]);
}

function hosts() {
  return getState().hosts || [];
}

function visibleBuckets() {
  const q = query.value.trim().toLowerCase();
  const g = groupFilter.value;
  const matched = hosts().filter((x) => {
    if (g !== '' && groupKeyOf(x.group) !== g) return false;
    if (!q) return true;
    return `${x.name} ${x.address} ${x.user} ${x.note || ''} ${x.group || ''}`
      .toLowerCase().includes(q);
  });
  return groupBuckets(matched);
}

function visible() {
  return visibleBuckets().flatMap((b) => b.hosts);
}

function selIndex(list) {
  const i = list.findIndex((x) => x.id === selectedId.value);
  return i >= 0 ? i : 0;
}

const NO_GROUP = '';

function groupKeyOf(name) {
  const k = (name || '').trim();
  return k === '' ? NO_GROUP : k;
}

function groupBuckets(list) {
  const buckets = new Map();
  for (const hst of list) {
    const key = (hst.group || '').trim();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(hst);
  }
  return [...buckets.keys()]
    .sort((a, b) => (a ? (b ? a.localeCompare(b, 'zh') : 1) : -1))
    .map((name) => ({ name, hosts: buckets.get(name) }));
}

function renderRows(buckets, selId) {
  const heads = buckets.length >= 2;
  const out = [];
  let n = 0;
  for (const b of buckets) {
    if (heads) {
      out.push(h('div', { key: `g-${b.name}`, class: 'boot-group' }, [
        h('span', { class: 'boot-group-name', text: b.name || t('app.boot.group-none') }),
        h('span', { class: 'boot-group-n', text: String(b.hosts.length) }),
      ]));
    }
    for (const hst of b.hosts) out.push(entryRow(hst, n++, hst.id === selId));
  }
  return out;
}

function emptyPane() {
  const all = hosts();
  const q = query.value.trim();
  const g = groupFilter.value;
  const gname = g === '' ? '' : (g === NO_GROUP ? t('app.boot.group-none') : g);
  let title;
  let hint;
  if (q && gname) {
    title = tf('app.boot.empty-group-no-match', { v1: gname, v2: q });
    hint = t('app.boot.empty-group-no-match-hint');
  } else if (q) {
    title = tf('app.boot.empty-no-match', { v1: q });
    hint = t('app.boot.empty-no-match-hint');
  } else if (gname) {
    title = all.length ? tf('app.boot.empty-group', { v1: gname }) : t('app.boot.empty-none');
    hint = all.length
      ? t('app.boot.empty-group-hint')
      : t('app.boot.empty-add-hint');
  } else {
    title = t('app.boot.empty-none');
    hint = t('app.boot.empty-add-hint');
  }
  return h('div', { class: 'boot-empty' }, [
    h('div', { class: 'boot-empty-title', text: title }),
    h('div', { class: 'boot-empty-hint', text: hint }),
  ]);
}

function Brand() {
  return h('div', { class: 'boot-brand' }, [
    h('img', { class: 'boot-brand-logo', src: '/favicon.ico', alt: '' }),
    h('span', { class: 'boot-brand-text' }, [
      'Q', h('span', { class: 'boot-brand-accent', text: 'x' }), 'SSH',
    ]),
  ]);
}

function Stats() {
  void tick.value;
  const all = hosts();
  let online = 0;
  let offline = 0;
  for (const hst of all) {
    const kind = stateOf(probeOf(hst.id)).kind;
    if (kind === 'online') online++;
    else if (kind === 'offline') offline++;
  }
  return h('div', { class: 'boot-stats' }, [
    h('span', { class: 'boot-stat' }, [h('b', { text: String(all.length) }), t('app.boot.unit-hosts')]),
    h('span', { class: 'boot-stat ok' }, [h('b', { text: String(online) }), t('app.boot.unit-online')]),
    h('span', { class: 'boot-stat bad' }, [h('b', { text: String(offline) }), t('app.boot.unit-offline')]),
  ]);
}

function GroupFilter() {
  void tick.value;
  const keys = groupBuckets(hosts()).map((b) => groupKeyOf(b.name));
  const cur = groupFilter.value;
  if (cur !== '' && !keys.includes(cur)) groupFilter.next = '';
  const countOf = (key) => hosts().filter((x) => groupKeyOf(x.group) === key).length;
  const label = (key) => tf('app.boot.group-item', { v1: key === NO_GROUP ? t('app.boot.group-none') : key, v2: countOf(key) });
  return h('label', { class: 'boot-group-filter' }, [
    h('span', { class: 'boot-group-filter-lb', 'aria-hidden': 'true', text: t('app.boot.filter-group') }),
    h('select', {
      ref: (el) => { node.group = el; },
      class: 'select boot-group-sel',
      'aria-label': t('app.boot.filter-group-tip'),
      onChange: (e) => { groupFilter.next = e.target.value; },
    }, [
      h('option', { key: '', value: '', text: tf('app.boot.group-all', { v1: (hosts().length) }) }),
      ...keys.map((k) => h('option', { key: k, value: k, text: label(k) })),
    ]),
  ]);
}

function SearchField() {
  return h('label', { class: 'boot-search' }, [
    h('span', { class: 'boot-search-ic', 'aria-hidden': 'true', html: icon('search', 'qicon qicon-sm') }),
    h('input', {
      ref: (el) => { node.search = el; },
      class: 'input boot-search-input',
      type: 'search',
      autocomplete: 'off',
      placeholder: t('app.boot.search-placeholder'),
      'aria-label': t('app.boot.search-label'),
      onInput: (e) => { query.next = e.target.value; },
    }),
  ]);
}

function ThemeButton() {
  void themeTick.value;
  const pref = readCachedPref('qx-theme') || 'system';
  const theme = THEMES.find((x) => x.id === pref) || THEMES[0];
  const label = t(theme.key);
  return h('button', {
    class: 'boot-theme',
    type: 'button',
    'aria-label': tf('app.boot.theme-button', { v1: label }),
    dataset: { tip: tf('app.boot.theme-button', { v1: label }) },
    html: icon(theme.icon, 'qicon qicon-sm'),
    onClick: cycleTheme,
  });
}

function LanguageButton() {
  return h(I18nMenu, {
    cls: 'boot-lang',
    onChange: (code, now) => {
      if (code) return;
      toast(t('app.boot.lang-switch-failed'), 'error');
      if (now) console.warn('[boot] 语言未切换，仍是', now);
    },
  });
}

function HeadTools() {
  return h('div', { class: 'boot-head-tools' }, [
    h(GroupFilter),
    h(SearchField),
    h('button', {
      class: 'btn btn-primary btn-sm boot-add',
      type: 'button',
      text: t('app.boot.add-host'),
      onClick: () => openForm(null),
    }),
    h(ThemeButton),
    h(LanguageButton),
  ]);
}

function HostList() {
  void tick.value;
  if (loadErr.value) {
    return h('div', { class: 'boot-list', role: 'listbox', 'aria-label': t('app.boot.host-list') }, [
      h('div', { class: 'boot-empty' }, [
        h('div', { class: 'boot-empty-title', text: t('app.boot.load-failed') }),
        h('div', { class: 'boot-empty-hint', text: loadErr.value }),
      ]),
    ]);
  }
  const buckets = visibleBuckets();
  return h('div', { class: 'boot-list', id: 'boot-entries', role: 'listbox', 'aria-label': t('app.boot.host-list') },
    buckets.length ? renderRows(buckets, selectedId.value) : [emptyPane()]);
}

function FootStatus() {
  void tick.value;
  const all = hosts();
  const list = visible();
  const filtering = query.value.trim() !== '' || groupFilter.value !== '';
  const cur = list[selIndex(list)];
  const hint = cur ? stateOf(probeOf(cur.id)).hint : '';
  return h('footer', { class: 'boot-foot' }, [
    h('span', { class: 'boot-count', text: filtering ? tf('app.boot.match-count', { v1: (list.length), v2: (all.length) }) : '' }),
    h('span', {
      class: 'boot-status',
text: cur ? (hint ? tf('app.boot.selected-host', { v1: cur.name, v2: hint }) : cur.name) : '',
    }),
  ]);
}

function scrollSelectedIntoView() {
  const list = document.getElementById('boot-entries');
  const sel = list && list.querySelector('.boot-entry.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function enter(hostId) {
  const host = visible().find((x) => x.id === hostId) || hosts().find((x) => x.id === hostId);
  if (!host) return;
  let s = stateOf(probeOf(host.id));
  if (s.kind !== 'online') {
    if (s.kind === 'offline') {
      setProbe(host.id, { state: 'testing' });
      s = stateOf(await probeOnce(host.id));
    }
    if (s.kind !== 'online') {
      toast(`${host.name} ${s.text}，${s.toast}`, s.kind === 'offline' ? 'error' : 'info');
      return;
    }
  }
  location.href = `desktop.html?host=${encodeURIComponent(host.id)}`;
}

async function probeOnce(hostId) {
  try {
    const r = await probeHost(hostId);
    setProbe(hostId, r.ok
      ? { state: 'ok', tcpMs: r.tcpMs, handshakeMs: r.handshakeMs }
      : { state: 'fail', error: r.error });
    if (r.osId) osIds.next = new Map(osIds.value).set(hostId, r.osId);
    if (r.osName) osNames.next = new Map(osNames.value).set(hostId, r.osName);
  } catch (err) {
    setProbe(hostId, { state: 'fail', error: err.message || String(err) });
  }
  return probeOf(hostId);
}

async function runProbes() {
  const queue = [...hosts()];
  const worker = async () => {
    while (queue.length) {
      const host = queue.shift();
      await probeOnce(host.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
}

function startProbing() {
  const next = new Map(probes.value);
  for (const t of hosts()) next.set(t.id, { state: 'testing' });
  probes.next = next;
  if (!prober) {
    prober = createPoller(runProbes, PROBE_INTERVAL_MS, { immediate: false, hiddenPause: false });
  }
  prober.tick();
  prober.start();
}

function move(delta) {
  const list = visible();
  if (!list.length) return;
  const i = (selIndex(list) + delta + list.length) % list.length;
  selectedId.next = list[i].id;
  scrollSelectedIntoView();
}

function onKey(e) {
  const inSearch = document.activeElement === node.search;
  const inGroup = document.activeElement === node.group;
  if (e.key === 'Escape' && inSearch) {
    if (node.search) node.search.value = '';
    query.next = '';
    e.preventDefault();
    return;
  }
  if (inSearch) return;
  if (inGroup) {
    if (e.key === 'Escape' && groupFilter.value !== '') {
      groupFilter.next = '';
      e.preventDefault();
    }
    return;
  }
  if (formDlg && formDlg.isOpen) return;
  const list = visible();
  if (e.key === '/') {
    e.preventDefault();
    if (node.search) { node.search.focus(); node.search.select(); }
  } else if (e.key === 'ArrowDown' || e.key === 'j') { move(1); e.preventDefault(); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { move(-1); e.preventDefault(); }
  else if (e.key === 'PageDown') { move(5); e.preventDefault(); }
  else if (e.key === 'PageUp') { move(-5); e.preventDefault(); }
  else if (e.key === 'Home') { if (list.length) selectedId.next = list[0].id; scrollSelectedIntoView(); e.preventDefault(); }
  else if (e.key === 'End') { if (list.length) selectedId.next = list[list.length - 1].id; scrollSelectedIntoView(); e.preventDefault(); }
  else if (e.key === 'Enter') { const c = list[selIndex(list)]; if (c) enter(c.id).catch(() => {}); e.preventDefault(); }
  else if (e.key === 'e' || e.key === 'E') { const t = list[selIndex(list)]; if (t) { e.preventDefault(); openForm(t); } }
  else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); openForm(null); }
}

function Page() {
  return h('div', { class: 'boot' }, [
    h(Brand),
    h('div', { class: 'boot-panel' }, [
      h('header', { class: 'boot-head' }, [h(Stats), h(HeadTools)]),
      h('main', { class: 'boot-main' }, [h(HostList)]),
      h(FootStatus),
    ]),
  ]);
}

function bootPrefBlob() {
  let raw = null;
  try { raw = localStorage.getItem(PREFS_CACHE_KEY); } catch { }
  if (raw) return Promise.resolve();
  return prefsAll()
    .then(({ prefs }) => loadPrefs(prefs))
    .catch((err) => console.warn('[boot] 读取个性化偏好失败，沿用本机缓存', err));
}

function init() {
  bootPrefBlob().then(() => setupI18n(new URL('../../language', import.meta.url).href))
    .catch((err) => console.warn('[boot] 语言表加载失败，沿用默认语言', err))
    .then(() => {
  applyTheme();
  repaintWallpaper();

  createView($('#boot-root')).update(() => {
    lang();
    return Page();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((readCachedPref('qx-theme') || 'system') === 'system') {
      applyTheme();
      repaintWallpaper();
      themeTick.next = themeTick.value + 1;
    }
  });
  document.addEventListener('keydown', onKey);
  subscribe(() => { tick.next = tick.value + 1; });

  effect(() => { if (node.group) node.group.value = groupFilter.value; });

  prefsAll()
    .then(({ prefs }) => {
      loadPrefs(prefs);
      applyTheme();
      repaintWallpaper();
      themeTick.next = themeTick.value + 1;
    })
    .catch((err) => console.warn('[boot] 读取个性化偏好失败，沿用本机缓存', err));

  loadHosts()
    .then(startProbing)
    .catch((err) => { loadErr.next = err.message || String(err); });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
