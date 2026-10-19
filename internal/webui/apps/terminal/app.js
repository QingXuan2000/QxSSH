import {
  bootApp, windowClass, windowFlash, onThemeChange, applyStoredTheme, provideApi, windowControl,
} from '/assets/js/app-bridge.js';

import { signal } from '/assets/js/core/signal.js';
import { throttle, debounce, fmtSize, fmtRate, modLabel } from '/assets/js/core/dom.js';
import { toast } from '/assets/js/core/ui.js';
import {
  promptDialog, menu, statusBar, statusDot, sideAction,
} from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { h, dom, Fragment } from '/assets/js/core/vdom.js';
import { setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { getJSONPref, setJSONPref } from '/assets/js/core/prefs.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import {
  getConfig, patchConfig, subscribe, DEFAULTS,
} from './config.js';
import { createPane } from './pane.js';
import { openTermSettings } from './settings.js';

const M = modLabel();

const sessKey = (hostId) => `qx-term-session-${hostId}`;

function loadSession(hostId) {
  const o = getJSONPref(sessKey(hostId), null);
  return Array.isArray(o && o.tabs) && o.tabs.length ? o : null;
}

function saveSession(hostId, data) {
  setJSONPref(sessKey(hostId), data);
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.14);
    o.stop(audioCtx.currentTime + 0.15);
  } catch { }
}

function shQuote(s) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function boot(el, ctx) {
  const hostId = ctx.hostId;

  const cfg = signal(getConfig());
  const statusRev = signal(0);
  const searchOpen = signal(false);
  const searchFlags = signal({ caseSensitive: false, regex: false });
  const searchState = signal({ index: 0, total: 0, query: '' });

  let seq = 0;
  let disposed = false;
  let menuHandle = null;
  const tabs = [];
  const pendingCmds = new Map();

  const gridsHost = dom('div', { class: 'term-grids' });
  const searchInputRef = { current: null };

  const shell = createAppShell(el, {
    tabs: [],
    active: '',
    onChange: (id) => showTab(id),
    actions: [
      () => sideAction({
        icon: 'plus',
        label: t('app.terminal.new-tab'),
        onClick: () => addTab({ cwd: activePaneObj() ? activePaneObj().state.cwd : '' }),
      }),
      () => sideAction({
        icon: 'MoreHorizontal',
        label: t('app.terminal.menu-more'),
        onClick: (e) => openMainMenu(e.clientX, e.clientY),
      }),
    ],
  });
  el.classList.add('term-root');

  shell.setMain(mainTree);


  function mainTree() {
    void statusRev.value;
    return h(Fragment, {}, [
      h('div', { key: 'main', class: 'term-main' }, [
        gridsHost,
        searchOpen.value ? searchBar() : null,
      ]),
      statusBarView(),
    ]);
  }

  function searchBar() {
    const flags = searchFlags.value;
    const info = searchState.value;
    const empty = !!info.query && !info.total;
    return h('div', { key: 'search', class: 'term-search' }, [
      h('span', { class: 'term-search-ic', html: icon('search', 'qicon-sm') }),
      h('input', {
        ref: (e2) => { searchInputRef.current = e2; },
        class: 'term-search-input',
        type: 'text',
        placeholder: t('app.terminal.find-placeholder'),
        spellcheck: 'false',
        value: info.query || '',
        onInput: (e2) => applySearch(e2.target.value),
        onKeydown: onSearchKey,
      }),
      h('button', {
        class: `term-search-flag${flags.caseSensitive ? ' active' : ''}`,
        type: 'button',
        text: 'Aa',
        dataset: { tip: t('app.terminal.find-case') },
        onClick: toggleCaseFlag,
      }),
      h('button', {
        class: `term-search-flag${flags.regex ? ' active' : ''}`,
        type: 'button',
        text: '.*',
        dataset: { tip: t('app.terminal.find-regex') },
        onClick: toggleRegexFlag,
      }),
      h('span', {
        class: `term-search-count mono${empty ? ' term-search-count-empty' : ''}`,
        text: `${info.index || 0}/${info.total || 0}`,
      }),
      h('button', {
        class: 'term-search-nav',
        type: 'button',
        html: '&#8593;',
        'aria-label': t('app.terminal.find-prev'),
        dataset: { tip: t('app.terminal.find-prev-key') },
        onClick: () => gotoSearch(-1),
      }),
      h('button', {
        class: 'term-search-nav',
        type: 'button',
        html: '&#8595;',
        'aria-label': t('app.terminal.find-next'),
        dataset: { tip: t('app.terminal.find-next-key') },
        onClick: () => gotoSearch(1),
      }),
      h('button', {
        class: 'term-search-x',
        type: 'button',
        html: '&times;',
        'aria-label': t('app.terminal.find-close'),
        dataset: { tip: t('app.terminal.find-close-key') },
        onClick: closeSearch,
      }),
    ]);
  }

  function statusBarView() {
    const c = cfg.value;
    const bits = [];
    const tab = activeTabObj();
    const p = tab ? tab.panes[tab.active] : null;

    if (p) {
      bits.push(h('span', { class: 'qx-status-bit' }, [
        statusDot(dotKind(p), connTip(p)),
        h('span', { text: connText(p) }),
      ]));
      bits.push(h('span', { class: 'qx-status-bit mono', text: `${p.state.cols || 0}×${p.state.rows || 0}` }));
      if (tab.panes.length > 1) {
        bits.push(h('span', { class: 'qx-status-bit', text: tf('app.terminal.pane-index', { v1: (tab.panes.indexOf(p) + 1), v2: (tab.panes.length) }) }));
      }
      if (p.state.cwd) {
        bits.push(h('span', {
          class: 'qx-status-bit term-s-path mono',
          text: p.state.cwd,
          dataset: { tip: p.state.cwd },
        }));
      }
      if (c.showTransferRate) {
        bits.push(h('span', {
          class: 'qx-status-bit mono',
          text: `${fmtRate(p.state.rateIn)} · ${fmtSize(p.state.bytesIn)}`,
        }));
      }
      if (p.state.bell) {
        bits.push(h('span', { class: 'qx-status-bit', text: tf('app.terminal.bell-count', { v1: (p.state.bell) }), dataset: { tip: t('app.terminal.bell-title') } }));
      }
    } else {
      bits.push(t('app.terminal.no-active-pane'));
    }

    return statusBar(bits, { cls: c.showStatusbar ? '' : 'hidden' });
  }


  function tabItems() {
    return tabs.map((tab) => ({
      id: tab.id,
      lead: statusDot(dotKind(tab.panes[tab.active]), connTip(tab.panes[tab.active])),
      label: tab.custom || tab.name,
      tip: tab.panes[0] ? (tab.panes[0].state.cwd || '') : '',
      onDblClick: () => renameTab(tab),
      onContext: (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, tab); },
      trail: h('button', {
        class: 'term-tab-x',
        type: 'button',
        html: '&times;',
        'aria-label': t('app.terminal.close-tab'),
        onClick: (e) => { e.stopPropagation(); closeTab(tab.id); },
      }),
    }));
  }

  function renderTabs() {
    shell.setTabs(tabItems());
  }

  function activeTabObj() {
    return tabs.find((t) => t.id === shell.active) || tabs[0] || null;
  }

  function activePaneObj() {
    const t = activeTabObj();
    return t ? t.panes[t.active] || null : null;
  }

  function newPaneFor(tab, inheritCwd) {
    const cur = tab.panes[tab.active];
    const cwd = inheritCwd || (cur ? (cur.state.cwd || '') : '');
    const pane = createPane({
      hostId,
      cwd,
      onEvent: (type, payload, p) => onPaneEvent(type, payload, p),
    });
    if (!pane) return null;
    tab.grid.appendChild(pane.el);
    tab.panes.push(pane);
    pane.index = tab.panes.length;
    return pane;
  }

  function addTab({ cwd = '', name = null } = {}) {
    const tab = {
      id: `t${++seq}`,
      name: name || tf('app.terminal.session-seq', { v1: seq }),
      custom: name || null,
      grid: dom('div', { class: 'term-grid' }),
      panes: [],
      active: 0,
      cols: 1,
      rows: 1,
    };
    gridApply(tab);
    tab.grid.style.display = 'none';
    gridsHost.appendChild(tab.grid);
    tabs.push(tab);
    newPaneFor(tab, cwd);
    labelPanes(tab);
    if (tab.panes[0]) tab.panes[0].setActive(true);
    renderTabs();
    showTab(tab.id);
    focusActive();
    return tab;
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = tabs.splice(i, 1);
    tab.panes.forEach((p) => p.dispose());
    tab.grid.remove();
    if (!tabs.length) {
      addTab({ cwd: ctx.cwd || '' });
      return;
    }
    renderTabs();
    showTab(tabs[Math.min(i, tabs.length - 1)].id);
    focusActive();
  }

  function showTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tabs.forEach((t) => { t.grid.style.display = t === tab ? '' : 'none'; });
    shell.setActive(tab.id);
    renderStatus();
    requestAnimationFrame(() => { focusActive(); doFitActive(); });
  }

  function gridApply(tab) {
    tab.grid.style.gridTemplateColumns = `repeat(${tab.cols}, minmax(0, 1fr))`;
    tab.grid.style.gridTemplateRows = `repeat(${tab.rows}, minmax(0, 1fr))`;
  }

  function labelPanes(tab) {
    tab.panes.forEach((p, k) => { p.index = k + 1; });
  }

  function setActivePane(i) {
    const t = activeTabObj();
    if (!t) return;
    t.active = Math.max(0, Math.min(i, t.panes.length - 1));
    labelPanes(t);
    t.panes.forEach((p, k) => p.setActive(k === t.active));
    renderStatus();
    requestAnimationFrame(() => { const p = activePaneObj(); if (p) p.fit(); });
  }

  function focusActive() {
    const p = activePaneObj();
    if (p) p.focus();
  }

  function doFitActive() {
    const t = activeTabObj();
    if (t) t.panes.forEach((p) => p.fit());
  }

  function split(dir) {
    const tab = activeTabObj();
    if (!tab) return;
    if (tab.cols === 2 && tab.rows === 2) { toast(t('app.terminal.split-limit'), 'warning'); return; }

    if (dir === 'right') {
      if (tab.cols === 2) tab.rows = 2;
      else tab.cols = 2;
    } else if (tab.rows === 2) {
      tab.cols = 2;
    } else {
      tab.rows = 2;
    }

    const need = tab.cols * tab.rows;
    while (tab.panes.length < need) {
      if (!newPaneFor(tab, '')) break;
    }
    gridApply(tab);
    labelPanes(tab);
    setActivePane(tab.panes.length - 1);
    renderStatus();
  }

  function unsplit() {
    const tab = activeTabObj();
    if (!tab) return;
    while (tab.panes.length > 1) {
      const p = tab.panes.pop();
      p.dispose();
    }
    tab.cols = 1;
    tab.rows = 1;
    tab.active = 0;
    gridApply(tab);
    setActivePane(0);
    requestAnimationFrame(doFitActive);
  }

  async function renameTab(tab) {
    const name = await promptDialog({
      title: t('app.terminal.rename-tab'),
      desc: t('app.terminal.rename-hint'),
      value: tab.custom || tab.name,
      placeholder: t('app.terminal.field-tab-name'),
      okText: t('app.terminal.rename'),
    });
    if (name == null) return;
    const v = name.trim();
    tab.custom = v || null;
    if (v) tab.name = v;
    renderTabs();
  }

  function cycleTab(dir) {
    if (tabs.length < 2) return;
    const cur = tabs.findIndex((t) => t.id === shell.active);
    showTab(tabs[(cur + dir + tabs.length) % tabs.length].id);
  }

  function movePaneFocus(dir) {
    const t = activeTabObj();
    if (!t || t.panes.length < 2) return;
    setActivePane((t.active + dir + t.panes.length) % t.panes.length);
  }


  function onPaneEvent(type, payload, p) {
    switch (type) {
      case 'state': {
        if (p.state.connected && pendingCmds.has(p.id)) {
          p.write(`${pendingCmds.get(p.id)}\r`);
          pendingCmds.delete(p.id);
        }
        if (p === activePaneObj()) renderStatus();
        const k = dotKind(p);
        if (p._dotKind !== k) { p._dotKind = k; renderTabs(); }
        break;
      }
      case 'title': {
        const t = tabs.find((x) => x.panes.includes(p));
        if (t && t.panes[t.active] === p && !t.custom && p.state.title) {
          t.name = p.state.title;
          renderTabs();
        }
        break;
      }
      case 'cwd':
        if (p === activePaneObj()) renderStatus();
        renderTabs();
        break;
      case 'bell': {
        const mode = cfg.value.bell;
        if (mode === 'visual' || mode === 'both') windowFlash();
        if (mode === 'sound' || mode === 'both') beep();
        renderStatus();
        renderTabs();
        break;
      }
      case 'search':
        searchState.next(payload || { index: 0, total: 0, query: '' });
        break;
      case 'search-open':
        openSearch();
        break;
      case 'contextmenu': {
        const t = tabs.find((x) => x.panes.includes(p));
        if (t && t.panes[t.active] !== p) setActivePane(t.panes.indexOf(p));
        openTerminalMenu(payload.x, payload.y, p);
        break;
      }
      case 'exit':
        renderStatus();
        renderTabs();
        break;

      case 'newtab': addTab({ cwd: activePaneObj() ? activePaneObj().state.cwd : '' }); break;
      case 'closetab': {
        const t = activeTabObj();
        if (t) closeTab(t.id);
        break;
      }
      case 'split-right': split('right'); break;
      case 'split-down': split('down'); break;
      case 'tab-cycle': cycleTab(payload); break;
      case 'focus-pane': movePaneFocus(payload); break;
      case 'fontsize': changeFontSize(payload); break;
      case 'save-output': exportOutput(); break;
      case 'settings': openSettings(); break;
      case 'copy-or-paste':
        if (p.term.getSelection()) p.copySelection();
        else p.pasteFromClipboard();
        break;
      default: break;
    }
  }


  function openSearch() {
    searchOpen.next = true;
    const p = activePaneObj();
    if (p) p.search.open();
    requestAnimationFrame(() => {
      const i = searchInputRef.current;
      if (i) { i.focus(); i.select(); }
    });
  }

  function closeSearch() {
    searchOpen.next = false;
    const p = activePaneObj();
    if (p) p.search.close();
  }

  function applySearch(value) {
    const p = activePaneObj();
    if (!p) return;
    const flags = searchFlags.value;
    p.search.setQuery(value, { caseSensitive: flags.caseSensitive, regex: flags.regex });
  }

  function toggleCaseFlag() {
    const f = searchFlags.value;
    searchFlags.next = { ...f, caseSensitive: !f.caseSensitive };
    reapplySearch();
  }

  function toggleRegexFlag() {
    const f = searchFlags.value;
    searchFlags.next = { ...f, regex: !f.regex };
    reapplySearch();
  }

  function reapplySearch() {
    const p = activePaneObj();
    if (!p) return;
    const f = searchFlags.value;
    const q = searchState.value.query || '';
    p.search.setQuery(q, { caseSensitive: f.caseSensitive, regex: f.regex });
    requestAnimationFrame(() => {
      const i = searchInputRef.current;
      if (i) i.focus();
    });
  }

  function gotoSearch(dir) {
    const p = activePaneObj();
    if (p) p.search.next(dir);
  }

  function onSearchKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); gotoSearch(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  }


  function openMenuAt(items, x, y) {
    closeMenu();
    menuHandle = menu(items, { x, y, onClose: () => { menuHandle = null; } });
  }

  function closeMenu() {
    if (menuHandle) { menuHandle.close(); menuHandle = null; }
  }

  function canSplit() {
    const t = activeTabObj();
    return !!t && !(t.cols === 2 && t.rows === 2);
  }

  function openTerminalMenu(x, y, pane) {
    const p = pane || activePaneObj();
    if (!p) return;
    openMenuAt([
      { icon: 'copy', label: t('app.terminal.menu-copy'), hint: `${M}+Shift+C`, disabled: !p.hasSelection(), onClick: () => p.copySelection() },
      { icon: 'paste', label: t('app.terminal.menu-paste'), hint: `${M}+Shift+V`, onClick: () => p.pasteFromClipboard() },
      { icon: 'TextSelect', label: t('app.terminal.menu-select-all'), hint: `${M}+Shift+A`, onClick: () => p.selectAll() },
      { sep: true },
      { icon: 'search', label: t('app.terminal.menu-find'), hint: `${M}+Shift+F`, onClick: openSearch },
      { sep: true },
      { icon: 'Eraser', label: t('app.terminal.menu-clear'), onClick: () => p.clearScreen() },
      { icon: 'Trash2', label: t('app.terminal.menu-clear-scrollback'), hint: `${M}+Shift+K`, onClick: () => p.clearScrollback() },
      { icon: 'download', label: t('app.terminal.menu-export'), hint: `${M}+Shift+S`, onClick: () => exportOutput(p) },
      { sep: true },
      { icon: 'reload', label: t('app.terminal.menu-reconnect'), onClick: () => p.reconnect() },
    ], x, y);
  }

  function openMainMenu(x, y) {
    const tab = activeTabObj();
    const p = activePaneObj();
    openMenuAt([
      { head: t('app.terminal.tab') },
      { icon: 'plus', label: t('app.terminal.new-tab'), hint: `${M}+Shift+T`, onClick: () => addTab({ cwd: p ? p.state.cwd : '' }) },
      { icon: 'edit', label: t('app.terminal.rename-tab'), onClick: () => { if (tab) renameTab(tab); } },
      { icon: 'close', label: t('app.terminal.close-current-tab'), hint: `${M}+Shift+W`, onClick: () => { if (tab) closeTab(tab.id); } },
      { sep: true },
      { head: t('app.terminal.split') },
      { icon: 'split-h', label: t('app.terminal.split-right'), hint: `${M}+Shift+D`, disabled: !canSplit(), onClick: () => split('right') },
      { icon: 'split-v', label: t('app.terminal.split-down'), hint: `${M}+Shift+E`, disabled: !canSplit(), onClick: () => split('down') },
      { label: t('app.terminal.split-cancel'), disabled: !tab || tab.panes.length < 2, onClick: () => unsplit() },
      { sep: true },
      { icon: 'settings', label: t('app.terminal.menu-settings'), hint: `${M}+Shift+,`, onClick: openSettings },
    ], x, y);
  }

  function openTabMenu(x, y, tab) {
    const i = tabs.indexOf(tab);
    openMenuAt([
      { head: tab.custom || tab.name },
      { label: t('app.terminal.rename'), onClick: () => renameTab(tab) },
      { label: t('app.terminal.new-tab-after'), onClick: () => { addTab({ cwd: tab.panes[0] ? tab.panes[0].state.cwd : '' }); } },
      { sep: true },
      { label: t('app.terminal.close-tab'), onClick: () => closeTab(tab.id) },
      {
        label: t('app.terminal.close-other-tabs'),
        disabled: tabs.length < 2,
        onClick: () => {
          for (let k = tabs.length - 1; k >= 0; k--) {
            if (k !== i) closeTab(tabs[k].id);
          }
        },
      },
    ], x, y);
  }


  function changeFontSize(delta) {
    const cur = cfg.value.fontSize;
    const raw = delta === 0 ? DEFAULTS.fontSize : cur + delta;
    const next = Math.min(32, Math.max(6, Math.round(raw * 10) / 10));
    if (next === cur) return;
    patchConfig({ fontSize: next });
    toast(tf('app.terminal.font-size', { v1: next }), 'info');
  }

  function exportOutput(pane) {
    const p = pane || activePaneObj();
    if (!p) return;
    const text = p.exportText();
    if (!text.trim()) { toast(t('app.terminal.export-empty'), 'info'); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal-output-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(t('app.terminal.export-done'), 'success');
  }

  function openSettings() {
    openTermSettings({ onClose: () => focusActive() });
  }

  function applyChrome() {
    const add = ['qx-term-glass'];
    if (cfg.value.frameless) add.push('qx-term-frameless');
    windowClass(add, cfg.value.frameless ? [] : ['qx-term-frameless']);
    el.classList.toggle('term-frameless', !!cfg.value.frameless);
  }

  function renderStatus() {
    statusRev.next = statusRev.value + 1;
  }


  function dotKind(p) {
    if (!p) return 'off';
    if (p.state.connected) return 'on';
    if (p.state.connecting) return 'busy';
    return 'off';
  }

  function connText(p) {
    if (!p) return t('app.terminal.conn-not-connected');
    if (p.state.connected) return t('app.terminal.conn-connected');
    if (p.state.connecting) return t('app.terminal.conn-connecting');
    if (p.state.exitCode != null) return tf('app.terminal.conn-exited', { v1: (p.state.exitCode) });
    return t('app.terminal.conn-disconnected');
  }

  function connTip(p) {
    if (!p) return '';
    return p.state.cwd || connText(p);
  }


  const offConfig = subscribe((next) => {
    cfg.next = next;
    applyChrome();
    tabs.forEach((t) => t.panes.forEach((p) => p.setConfig(next)));
    renderTabs();
    renderStatus();
  });

  const offTheme = onThemeChange(() => {
    applyStoredTheme();
    tabs.forEach((t) => t.panes.forEach((p) => p.applyTheme()));
  });

  const rateTimer = setInterval(() => {
    const now = Date.now();
    for (const t of tabs) {
      for (const p of t.panes) {
        const prevBytes = p.state.rateBytes == null ? p.state.bytesIn : p.state.rateBytes;
        const prevAt = p.state.rateAt == null ? now : p.state.rateAt;
        const dt = (now - prevAt) / 1000;
        p.state.rateIn = dt > 0 ? Math.max(0, (p.state.bytesIn - prevBytes) / dt) : 0;
        p.state.rateBytes = p.state.bytesIn;
        p.state.rateAt = now;
      }
    }
    if (cfg.value.showTransferRate) renderStatus();
  }, 1000);

  const fitOnResize = throttle(doFitActive, 100);
  const winRO = new ResizeObserver(fitOnResize);
  winRO.observe(gridsHost);

  const refitTrailing = debounce(doFitActive, 180);
  const resizeTrailing = debounce(doFitActive, 90);

  function refitSoon() {
    doFitActive();
    requestAnimationFrame(() => { doFitActive(); requestAnimationFrame(doFitActive); });
    refitTrailing();
  }

  function onWinResize() {
    doFitActive();
    resizeTrailing();
  }
  window.addEventListener('resize', onWinResize);
  refitSoon();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (!disposed) doFitActive(); }).catch(() => { });
  }

  applyChrome();


  const restored = cfg.value.restoreSession ? loadSession(hostId) : null;
  if (restored) {
    restored.tabs.forEach((t) => {
      const paneCwds = Array.isArray(t.panes) ? t.panes : [];
      const tab = addTab({ cwd: paneCwds[0] && paneCwds[0].cwd ? paneCwds[0].cwd : (t.cwd || ''), name: t.custom || null });
      if (t.name) tab.name = t.name;

      const want = Math.max(1, Math.min(4, Number(t.paneCount) || 1));
      if (want >= 3) { tab.cols = 2; tab.rows = 2; }
      else if (want === 2) {
        if (t.rows === 2 && t.cols !== 2) { tab.cols = 1; tab.rows = 2; }
        else { tab.cols = 2; tab.rows = 1; }
      } else { tab.cols = 1; tab.rows = 1; }

      while (tab.panes.length < want) {
        const cwd = paneCwds[tab.panes.length] ? paneCwds[tab.panes.length].cwd : '';
        if (!newPaneFor(tab, cwd)) break;
      }
      gridApply(tab);
      labelPanes(tab);
      setActivePane(0);
      renderTabs();
    });
    if (tabs.length) {
      const idx = Math.min(Math.max(0, Number(restored.active) || 0), tabs.length - 1);
      showTab(tabs[idx].id);
    }
    toast(t('app.terminal.layout-restored'), 'info');
  } else {
    addTab({ cwd: ctx.cwd || '' });
  }

  provideApi('open', (args) => {
    const a = args || {};
    const tab = addTab({ cwd: a.cwd ? String(a.cwd) : '', name: a.name ? String(a.name) : null });
    const pane = tab.panes[0];
    if (!pane) throw new Error(t('app.terminal.api-open-no-pane'));
    const cmd = Array.isArray(a.command)
      ? a.command.map((x) => shQuote(String(x))).join(' ')
      : String(a.command || '');
    if (cmd) {
      if (pane.state.connected) pane.write(`${cmd}\r`);
      else pendingCmds.set(pane.id, cmd);
    }
    windowControl('focus');
    return { tabId: tab.id, paneId: pane.id };
  }, {
    description: t('app.terminal.api-open-desc'),
    version: '1',
    needsWindow: true,
    perm: 'term:open',
  });

  return function disposeApp() {
    if (disposed) return;
    disposed = true;

    clearInterval(rateTimer);
    offConfig();
    offTheme();
    winRO.disconnect();
    fitOnResize.cancel();
    refitTrailing.cancel();
    resizeTrailing.cancel();
    window.removeEventListener('resize', onWinResize);
    closeMenu();

    saveSession(hostId, {
      active: Math.max(0, tabs.findIndex((t) => t.id === shell.active)),
      tabs: tabs.map((t) => ({
        name: t.name,
        custom: t.custom,
        paneCount: t.panes.length,
        cols: t.cols,
        rows: t.rows,
        cwd: t.panes[0] ? (t.panes[0].state.cwd || '') : '',
        panes: t.panes.map((p) => ({ cwd: p.state.cwd || '' })),
      })),
    });

    tabs.forEach((t) => t.panes.forEach((p) => p.dispose()));
    tabs.length = 0;
    shell.destroy();
    windowClass([], ['qx-term-glass', 'qx-term-frameless', 'term-bell-flash']);
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'terminal',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId, params }) => {
    if (!root) return;
    const placeholder = (title, desc) => dom('div', { class: 'app-placeholder' }, [
      dom('h3', { text: title }),
      dom('p', { text: desc }),
    ]);
    if (!hostId) {
      root.append(placeholder(
        t('app.terminal.placeholder-unavailable'),
        t('app.terminal.placeholder-no-host'),
      ));
      return;
    }
    try {
      return boot(root, { hostId, cwd: params.cwd || '' });
    } catch (err) {
      console.error('[terminal] mount failed', err);
      root.append(placeholder(
        t('app.terminal.placeholder-launch-failed'),
        String(err && err.message ? err.message : err),
      ));
    }
  });
});
