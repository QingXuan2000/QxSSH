/**
 * desktop/startmenu.js —— 开始菜单
 * 要点：按分类或搜索列出应用，支持收藏、网格/列表视图切换，并可把同一应用批量启动到多台主机。
 */
import { t, tf, lang } from '../core/i18n.js';
import { h, useState } from '../core/vdom.js';
import { signal } from '../core/signal.js';
import { toast, confirmAction } from '../core/ui.js';
import { runMany } from '../core/appkit.js';
import { prefSignal } from '../core/prefs.js';
import { appIcon } from '../icons/index.js';
import { getCategories } from '../apps/registry.js';
import { appName, appCategory, appCategoryKey, categoryName } from '../apps/apptext.js';
import { contextMenu } from './ctxmenu.js';

const FAV_KEY = 'qx-sm-fav';
const VIEW_KEY = 'qx-sm-view';

function gridOrListSignal() {
  const s = prefSignal(VIEW_KEY, 'list', { json: false });
  if (s.peek() !== 'grid') s.next = 'list';
  return s;
}

/** 开始菜单组件：应用检索、分类浏览、收藏与多主机启动 */
export function StartMenu(props) {
  const { wm, getApps, host, open, onOpenApp, onSwitchHost, onQuit } = props;
  const ctl = useState(() => ({
    query: signal(''),
    tab: signal('all'),
    view: gridOrListSignal(),
    favs: prefSignal(FAV_KEY, []),
    active: signal(0),
    searchEl: { current: null },
    bodyEl: { current: null },
    items: [],
    bound: null,
  }));
  const { query, tab, view, favs, active, searchEl, bodyEl } = ctl.value;

  const hayOf = (app) => [appName(app), app.id, appCategory(app), ...(app.keywords || [])].join(' ').toLowerCase();

  const close = () => { open.next = false; };
  const doOpen = () => {
    query.next = '';
    if (searchEl.current) searchEl.current.value = '';
    active.next = 0;
    open.next = true;
    setTimeout(() => { if (open.value) searchEl.current?.focus(); }, 30);
  };
  const toggle = () => (open.value ? close() : doOpen());

  async function powerAction(kind) {
    close();
    const shutdown = kind === 'shutdown';
    const cmd = shutdown ? 'shutdown -h now' : 'reboot';
    const label = shutdown ? t('app.startmenu.power-shutdown') : t('app.startmenu.power-reboot');
    const target = `${host.user}@${host.address}:${host.port}`;
    const ok = await confirmAction(
      tf('app.startmenu.power-confirm-title', { v1: label }),
      tf('app.startmenu.power-confirm-body', { v1: target, v2: cmd, v3: label }),
      { okText: label, danger: true },
    );
    if (!ok) return;
    try {
      const res = (await runMany([{ id: host.id, name: host.name }], cmd, { timeout: 20 }))[0];
      if (res && res.success) {
        toast(tf('app.startmenu.power-sent', { v1: target, v2: label }), 'success');
      } else if (res && /eof|reset|closed|broken pipe|connection|连接/i.test(res.error || '')) {
        toast(tf('app.startmenu.power-disconnected', { v1: label }), 'success');
      } else {
        toast(tf('app.startmenu.power-failed', {
          v1: label,
          v2: (res && res.error) || t('app.startmenu.unknown-error'),
        }), 'error');
      }
    } catch (e) {
      toast(tf('app.startmenu.power-failed-detail', { v1: label, v2: (e.message) }), 'error');
    }
  }

  function visibleGroups() {
    const q = query.value.toLowerCase();
    const all = getApps().filter((app) => !q || hayOf(app).includes(q));
    const bySort = (a, b) => {
      const fa = favs.value.includes(a.id) ? 0 : 1;
      const fb = favs.value.includes(b.id) ? 0 : 1;
      return fa - fb || appName(a).localeCompare(appName(b), lang());
    };

    if (q) {
      const order = getCategories();
      const groups = [];
      for (const c of order) {
        const list = all.filter((e) => appCategoryKey(e) === c).sort(bySort);
        if (list.length) groups.push({ key: c, title: categoryName(c), rows: list });
      }
      const rest = all.filter((e) => !order.includes(appCategoryKey(e)));
      if (rest.length) groups.push({ key: 'other', title: categoryName(''), rows: rest.sort(bySort) });
      return groups;
    }
    if (tab.value === 'all') return [{ title: '', rows: all.slice().sort(bySort) }];
    if (tab.value === 'fav') return [{ title: '', rows: all.filter((e) => favs.value.includes(e.id)).sort(bySort) }];
    return [{ title: '', rows: all.filter((e) => appCategoryKey(e) === tab.value).sort(bySort) }];
  }

  function launch(app) {
    close();
    onOpenApp(app);
  }

  function openItemMenu(x, y, app) {
    contextMenu([
      { icon: 'play', label: t('app.startmenu.menu-open'), onClick: () => launch(app) },
      { icon: 'external-link', label: t('app.startmenu.menu-open-new-window'), onClick: () => { close(); onOpenApp(app, { forceNew: true }); } },
      { sep: true },
      {
        icon: favs.value.includes(app.id) ? 'star' : 'plus',
        label: favs.value.includes(app.id) ? t('app.startmenu.menu-unfav') : t('app.startmenu.menu-fav'),
        onClick: () => {
          const list = favs.value;
          favs.next = list.includes(app.id) ? list.filter((x) => x !== app.id) : [...list, app.id];
        },
      },
    ], { x, y, cls: 'sm-ctx', zIndex: 1600 });
  }

  function gridCols() {
    if (view.value !== 'grid') return 1;
    const grid = bodyEl.current?.querySelector('.sm-grid');
    if (!grid || !grid.children.length) return 1;
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const cell = grid.children[0].getBoundingClientRect().width;
    if (!cell) return 1;
    return Math.max(1, Math.round((grid.clientWidth + gap) / (cell + gap)));
  }

  function move(dx, dy) {
    const list = ctl.value.items;
    if (!list.length) return;
    const cols = gridCols();
    let next = active.value + dx + dy * cols;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    active.next = next;
    requestAnimationFrame(() => {
      bodyEl.current?.querySelector('.sm-item.active')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function cycleTab(step) {
    const order = ['all', 'fav', ...getCategories()];
    const i = order.indexOf(tab.value);
    tab.next = order[(i + step + order.length) % order.length];
    active.next = 0;
  }

  function onKeyDown(e) {
    if (!open.value) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query.value) { if (searchEl.current) searchEl.current.value = ''; query.next = ''; }
      else close();
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(0, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(0, -1); return; }
    if (query.value === '') {
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1, 0); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1, 0); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const list = ctl.value.items;
      const entry = list[Math.min(active.value, Math.max(0, list.length - 1))];
      if (entry) launch(entry);
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== searchEl.current) {
      const input = searchEl.current;
      if (!input) return;
      input.focus();
      input.value += e.key;
      query.next = input.value.trim();
      e.preventDefault();
    }
  }

  function onGlobalKey(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key === 'Meta' && !e.repeat && !e.ctrlKey && !e.altKey) { toggle(); return; }
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      focusTaskbarWindow(Number(e.key) - 1);
      if (open.value) close();
    }
  }

  function focusTaskbarWindow(i) {
    const wins = wm.getWindows().filter((w) => !w._closed);
    const w = wins[i];
    if (!w) { toast(tf('app.startmenu.nav-no-window', { v1: (i + 1) }), 'info'); return; }
    if (w.state === 'minimized') w.restore();
    w.focus();
  }

  function outsideClick(e) {
    if (e.target.closest?.('.startmenu')) return;
    if (e.target.closest?.('.tb-big') || e.target.closest?.('.sm-ctx')) return;
    close();
  }

  const q = query.value;
  const isGrid = view.value === 'grid';
  const favList = favs.value;

  const searchInput = h('input', {
    ref: (el) => { searchEl.current = el; },
    class: 'sm-search-input',
    type: 'search',
    spellcheck: 'false',
    placeholder: t('app.startmenu.search-placeholder'),
    'aria-label': t('app.startmenu.search-placeholder-plain'),
    onInput: (e) => { query.next = e.target.value.trim(); },
  });

  const viewBtn = h('button', {
    class: 'sm-icon-btn',
    dataset: { tip: isGrid ? t('app.startmenu.switch-to-list') : t('app.startmenu.switch-to-grid') },
    html: appIcon(isGrid ? 'list' : 'grid', 'qicon qicon-sm'),
    onClick: () => {
      const next = isGrid ? 'list' : 'grid';
      view.next = next;
    },
  });

  const cats = getCategories();
  const qLower = q.toLowerCase();
  const match = getApps().filter((app) => !qLower || hayOf(app).includes(qLower));
  const catN = new Map();
  for (const app of match) {
    const k = appCategoryKey(app);
    catN.set(k, (catN.get(k) || 0) + 1);
  }
  const favN = match.filter((e) => favList.includes(e.id)).length;
  const tabDefs = [
    { id: 'all', label: t('app.startmenu.tab-all'), n: match.length },
    { id: 'fav', label: t('app.startmenu.tab-fav'), n: favN },
    ...cats.map((c) => ({ id: c, label: categoryName(c), n: catN.get(c) || 0 })),
  ];
  const tabs = h('div', { class: 'sm-tabs', role: 'tablist' }, tabDefs.map((d) => h('button', {
    key: d.id,
    class: `sm-tab${tab.value === d.id ? ' active' : ''}`,
    role: 'tab',
    'aria-selected': tab.value === d.id ? 'true' : 'false',
    onClick: () => { tab.next = d.id; active.next = 0; searchEl.current?.focus(); },
  }, [
    h('span', { class: 'sm-tab-label', text: d.label }),
    d.n ? h('span', { class: 'sm-tab-n', text: String(d.n) }) : null,
  ].filter(Boolean))));

  const groups = visibleGroups();
  const list = groups.flatMap((g) => g.rows);
  ctl.value.items = list;
  const cur = Math.min(active.value, Math.max(0, list.length - 1));

  let cursor = 0;
  const body = list.length
    ? groups.map((g) => h('div', { class: 'sm-group', key: g.key || 'all' }, [
      g.title ? h('div', { class: 'sm-group-title', text: g.title }) : null,
      h('div', { class: isGrid ? 'sm-grid' : 'sm-rows' }, g.rows.map((r) => {
        const idx = cursor++;
        const app = r;
        return h('button', {
          key: app.id,
          class: `sm-item ${isGrid ? 'grid' : 'list'}${idx === cur ? ' active' : ''}`,
          role: 'option',
          'aria-selected': idx === cur ? 'true' : 'false',
          title: appName(app),
          onClick: () => launch(app),
          onContextmenu: (e) => { e.preventDefault(); openItemMenu(e.clientX, e.clientY, app); },
        }, [
          h('span', { class: 'sm-item-ic', html: appIcon(app.icon || app.id, 'qicon', app.id) }),
          h('span', { class: 'sm-item-text' }, [
            h('span', { class: 'sm-item-name', text: appName(app) }),
            !isGrid ? h('span', { class: 'sm-item-cat', text: appCategory(app) }) : null,
          ].filter(Boolean)),
          favList.includes(app.id) ? h('span', { class: 'sm-item-fav', html: appIcon('star', 'qicon qicon-sm') }) : null,
        ].filter(Boolean));
      })),
    ].filter(Boolean)))
    : [h('div', { class: 'sm-empty' }, [
      h('div', { class: 'sm-empty-ic', html: appIcon('search', 'qicon') }),
      h('div', {
        class: 'sm-empty-text',
        text: q
          ? tf('app.startmenu.empty-no-match', { v1: q })
          : (tab.value === 'fav' ? t('app.startmenu.empty-no-fav') : t('app.startmenu.empty-category')),
      }),
    ])];

  const bodyNode = h('div', {
    ref: (el) => { bodyEl.current = el; },
    class: 'sm-body',
    role: 'listbox',
    'aria-label': t('app.startmenu.aria-apps'),
  }, body);

  const fixed = h('div', { class: 'sm-fixed' }, [
    h('div', { class: 'sm-row' }, [
      h('button', {
        class: 'sm-fixed-btn',
        html: tf('app.startmenu.fixed-settings', { v1: (appIcon('settings', 'qicon qicon-sm')) }),
        onClick: () => {
          close();
          const app = getApps().find((a) => a.id === 'settings');
          if (app) onOpenApp(app);
          else toast(t('app.startmenu.settings-missing'), 'error');
        },
      }),
      h('button', {
        class: 'sm-fixed-btn',
        html: tf('app.startmenu.fixed-switch-host', { v1: (appIcon('user', 'qicon qicon-sm')) }),
        onClick: () => { close(); if (onSwitchHost) onSwitchHost(); },
      }),
    ]),
    h('div', { class: 'sm-row sm-row-power' }, [
      h('button', {
        class: 'sm-fixed-btn wide',
        html: tf('app.startmenu.fixed-close-all', { v1: (appIcon('x', 'qicon qicon-sm')) }),
        onClick: () => {
          close();
          if (onQuit) onQuit();
          else { wm.closeAll(); toast(t('app.startmenu.close-all-done'), 'success'); }
        },
      }),
      h('button', {
        class: 'sm-fixed-btn power',
        html: tf('app.startmenu.fixed-shutdown', { v1: (appIcon('power', 'qicon qicon-sm')) }),
        onClick: () => { powerAction('shutdown'); },
      }),
      h('button', {
        class: 'sm-fixed-btn power',
        html: tf('app.startmenu.fixed-reboot', { v1: (appIcon('restart', 'qicon qicon-sm')) }),
        onClick: () => { powerAction('reboot'); },
      }),
    ]),
  ]);

  return h('div', {
    class: `startmenu${open.value ? ' open' : ''}`,
    id: 'startmenu',
    role: 'dialog',
    'aria-label': t('app.startmenu.aria-start-menu'),
    onMount: () => {
      ctl.value.bound = { onGlobalKey, onKeyDown, outsideClick };
      document.addEventListener('keydown', onGlobalKey);
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('mousedown', outsideClick);
    },
    onUnmount: () => {
      const b = ctl.value.bound;
      if (!b) return;
      document.removeEventListener('keydown', b.onGlobalKey);
      document.removeEventListener('keydown', b.onKeyDown);
      document.removeEventListener('mousedown', b.outsideClick);
    },
  }, [
    h('div', { class: 'sm-top' }, [
      h('div', { class: 'sm-tools' }, [
        h('div', { class: 'sm-search' }, [
          h('span', { class: 'sm-search-ic', html: appIcon('search', 'qicon qicon-sm') }),
          searchInput,
        ]),
        viewBtn,
      ]),
    ]),
    h('div', {
      class: 'sm-hostbar',
      role: 'button',
      tabIndex: 0,
      dataset: { tip: `${host.name} · ${host.user}@${host.address}:${host.port}` },
      onClick: () => { close(); if (onSwitchHost) onSwitchHost(); },
      onKeyDown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        close();
        if (onSwitchHost) onSwitchHost();
      },
    }, [
      h('div', { class: 'sm-host-ic', text: (host.name || '?').slice(0, 1).toUpperCase() }),
      h('div', { class: 'sm-host-body' }, [
        h('div', { class: 'sm-host-name', text: host.name }),
        h('div', { class: 'sm-host-addr', text: `${host.user}@${host.address}:${host.port}` }),
      ]),
      h('span', { class: 'sm-host-go', html: appIcon('chevron', 'qicon qicon-sm') }),
    ]),
    tabs,
    bodyNode,
    fixed,
  ]);
}
