import { openApp, openExternal } from '/assets/js/app-bridge.js';
import { t, tf } from '/assets/js/core/i18n.js';

import { h, dom } from '/assets/js/core/vdom.js';
import { throttle } from '/assets/js/core/dom.js';
import { toast, copyText as copyToClipboard } from '/assets/js/core/ui.js';
import { getConfig } from './config.js';
import { termTheme } from './theme.js';
import { createSession } from './session.js';

async function copyText(text) {
  if (!text) return false;
  return copyToClipboard(text);
}

async function readText() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch { }
  return null;
}

export function extractLines(term) {
  const buf = term.buffer.active;
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out[i] = line ? line.translateToString(true) : '';
  }
  return out;
}

export function findMatches(lines, query, { caseSensitive = false, regex = false } = {}) {
  const out = [];
  if (!query) return out;
  let re;
  try {
    re = regex
      ? new RegExp(query, caseSensitive ? 'g' : 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch {
    return out;
  }
  for (let row = 0; row < lines.length; row++) {
    const text = lines[row];
    if (!text) continue;
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 1000) {
      out.push({ row, col: m.index, len: Math.max(1, m[0].length) });
      if (m[0] === '') re.lastIndex += 1;
    }
  }
  return out;
}

const RE_URL = /\b(?:https?|ftp):\/\/[^\s"'`<>(){}|\\^[\]]+/g;
const RE_PATH = /(?:^|[\s"'(=|:,\[])((?:~|\/|\.\.?\/)[\w.\-+@%]*(?:\/[\w.\-+@%]*)*)/g;
const RE_HOSTPORT = /\b((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\b/gi;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

export function findLinks(text) {
  if (!text) return [];
  const found = [];
  const push = (m, index, kind) => { found.push({ text: m, index, kind, end: index + m.length }); };

  let m;
  RE_URL.lastIndex = 0;
  while ((m = RE_URL.exec(text)) !== null) push(m[0], m.index, 'url');

  const taken = (i, len) => found.some((f) => i < f.end && i + len > f.index);

  RE_PATH.lastIndex = 0;
  while ((m = RE_PATH.exec(text)) !== null) {
    const val = m[1];
    const idx = m.index + m[0].length - val.length;
    if (val.length >= 2 && !taken(idx, val.length)) push(val, idx, 'path');
  }
  RE_EMAIL.lastIndex = 0;
  while ((m = RE_EMAIL.exec(text)) !== null) {
    if (!taken(m.index, m[0].length)) push(m[0], m.index, 'email');
  }
  RE_HOSTPORT.lastIndex = 0;
  while ((m = RE_HOSTPORT.exec(text)) !== null) {
    if (!taken(m.index, m[0].length)) push(m[0], m.index, 'host');
  }

  found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);

  const out = [];
  let cursor = -1;
  for (const f of found) {
    if (f.index < cursor) continue;
    out.push(f);
    cursor = f.index + f.text.length;
  }
  return out;
}

let paneSeq = 0;

export function createPane(opts) {
  const Term = window.Terminal;
  const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
  if (!Term || !FitAddon) return null;

  const id = `pane-${++paneSeq}`;
  const emit = (type, payload) => {
    try { opts.onEvent && opts.onEvent(type, payload, pane); } catch (e) { console.error(e); }
  };

  const view = dom('div', { class: 'term-pane-view' });
  const badge = dom('div', { class: 'term-pane-badge' });
  const el = dom('div', { class: 'term-pane', dataset: { pane: id } }, [view, badge]);

  const cfg0 = getConfig();
  const term = new Term({
    fontFamily: cfg0.fontFamily,
    fontSize: cfg0.fontSize,
    lineHeight: cfg0.lineHeight,
    letterSpacing: cfg0.letterSpacing,
    cursorStyle: cfg0.cursorStyle,
    cursorBlink: cfg0.cursorBlink,
    scrollback: cfg0.scrollback,
    smoothScrollDuration: cfg0.smoothScroll ? 90 : 0,
    fastScrollModifier: cfg0.fastScrollModifier,
    allowTransparency: true,
    convertEol: false,
    theme: termTheme(),
    linkHandler: {
      activate(event, text) { openLink(text, 'url', event); },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(view);

  const state = {
    id,
    connected: false,
    connecting: false,
    exitCode: null,
    cwd: opts.cwd || '',
    title: '',
    bell: 0,
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    cols: term.cols || 0,
    rows: term.rows || 0,
  };

  const io = { disposed: false, ro: null, mode: null };

  const session = createSession({
    hostId: opts.hostId,
    cwd: opts.cwd || '',
    size: () => ({ cols: term.cols || 0, rows: term.rows || 0 }),
    shouldReconnect: () => getConfig().autoReconnect !== false,
    onData: (bytes) => {
      if (io.disposed) return;
      state.bytesIn += bytes.byteLength || 0;
      term.write(bytes);
    },
    onNotice: (text) => { if (!io.disposed) term.write(text); },
    onExit: (code) => emit('exit', code),
    onState: () => {
      state.connected = session.state.connected;
      state.connecting = session.state.connecting;
      state.exitCode = session.state.exitCode;
      emit('state');
    },
  });

  const pane = {
    id,
    el,
    term,
    fit,
    state,
    fit: doFit,
    focus,
    setActive,
    setConfig,
    applyTheme,
    dispose,
    reconnect: () => session.reconnect(),
    write: (text) => send(String(text || '')),
    copySelection,
    pasteFromClipboard,
    hasSelection: () => !!term.getSelection(),
    selectAll: () => term.selectAll(),
    clearScreen,
    clearScrollback,
    exportText,
    search: {
      open: openSearch,
      close: closeSearch,
      setQuery: updateQuery,
      next: (dir) => gotoMatch(dir || 1),
      info: searchInfo,
      isOpen: () => !!io.mode,
    },
  };

  function doFit() {
    if (io.disposed) return;
    if (view.clientWidth > 0 && view.clientHeight > 0) {
      try { fit.fit(); } catch { }
    }
  }

  function focus() {
    try { term.focus(); } catch { }
  }

  function setActive(on) {
    el.classList.toggle('active', !!on);
    badge.textContent = on ? '' : String(pane.index || '');
  }

  function send(text) {
    if (session.send(text)) state.bytesOut += text.length;
  }

  term.onData((d) => send(d));

  term.onResize(({ cols, rows }) => {
    state.cols = cols;
    state.rows = rows;
    session.resize(cols, rows);
    emit('state');
  });

  term.onSelectionChange(() => {
    if (getConfig().copyOnSelect) {
      const sel = term.getSelection();
      if (sel && sel.trim().length > 1) copyText(sel);
    }
    emit('state');
  });

  term.onTitleChange((t) => {
    state.title = t || '';
    emit('title', state.title);
  });

  term.onBell(() => {
    state.bell += 1;
    emit('bell');
  });

  const fitOnResize = throttle(doFit, 100);
  io.ro = new ResizeObserver(fitOnResize);
  io.ro.observe(view);

  requestAnimationFrame(() => { doFit(); focus(); });

  function onPasteEvent(e) {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!text) {
      if (e.clipboardData && e.clipboardData.items && e.clipboardData.items.length) {
        toast(t('app.terminal.paste-unsupported'), 'warning');
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    writeToShell(text);
  }
  if (term.textarea) term.textarea.addEventListener('paste', onPasteEvent);

  function writeToShell(text) {
    let d = text;
    if (term.modes && term.modes.bracketedPasteMode) d = `\x1b[200~${d}\x1b[201~`;
    send(d);
    focus();
  }

  async function pasteFromClipboard() {
    const text = await readText();
    if (text == null) {
      toast(t('app.terminal.paste-no-permission'), 'warning');
      return;
    }
    if (!text) { toast(t('app.terminal.clipboard-empty'), 'info'); return; }
    writeToShell(text);
  }

  view.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = getConfig().fontSizeStep;
    emit('fontsize', e.deltaY < 0 ? step : -step);
  }, { passive: false });

  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const mode = getConfig().rightClick;
    if (mode === 'paste') { pasteFromClipboard(); return; }
    if (mode === 'copyPaste') {
      const sel = term.getSelection();
      if (sel) { copyText(sel); term.clearSelection(); } else pasteFromClipboard();
      return;
    }
    emit('contextmenu', { x: e.clientX, y: e.clientY });
  });

  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const bufLine = term.buffer.active.getLine(lineNumber - 1);
      if (!bufLine) { callback(undefined); return; }
      const found = findLinks(bufLine.translateToString(true));
      if (!found.length) { callback(undefined); return; }
      callback(found.map((f) => ({
        range: {
          start: { x: f.index + 1, y: lineNumber },
          end: { x: f.index + f.text.length, y: lineNumber },
        },
        text: f.text,
        activate: (event, linkText) => openLink(linkText || f.text, f.kind, event),
      })));
    },
  });

  function openLink(text, kind, event) {
    if (kind === 'url') {
      openExternal(text);
      return;
    }
    if (kind === 'path' && event && (event.ctrlKey || event.metaKey)) {
      openApp('files', { cwd: text });
      return;
    }
    copyText(text).then((ok) => toast(ok ? tf('app.terminal.copied', { v1: text }) : tf('app.terminal.copied-link', { v1: text }), ok ? 'success' : 'info'));
  }

  term.parser.registerOscHandler(7, (data) => {
    try {
      const u = new URL(data);
      if (u.pathname) {
        state.cwd = decodeURIComponent(u.pathname);
        emit('cwd', state.cwd);
      }
    } catch { }
    return true;
  });

  function searchInfo() {
    if (!io.mode) return null;
    return {
      query: io.mode.query,
      caseSensitive: io.mode.caseSensitive,
      regex: io.mode.regex,
      index: io.mode.index < 0 ? 0 : io.mode.index + 1,
      total: io.mode.matches.length,
    };
  }

  function openSearch() {
    io.mode = io.mode || { query: '', caseSensitive: false, regex: false, matches: [], index: -1 };
    const info = searchInfo();
    emit('search', info);
    return info;
  }

  function closeSearch() {
    io.mode = null;
    emit('search', null);
    focus();
  }

  function updateQuery(query, { caseSensitive, regex, silent } = {}) {
    if (!io.mode) io.mode = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 };
    if (query !== undefined) io.mode.query = query;
    if (caseSensitive !== undefined) io.mode.caseSensitive = !!caseSensitive;
    if (regex !== undefined) io.mode.regex = !!regex;
    io.mode.matches = findMatches(extractLines(term), io.mode.query, {
      caseSensitive: io.mode.caseSensitive,
      regex: io.mode.regex,
    });
    io.mode.index = io.mode.matches.length ? 0 : -1;
    if (!silent) highlightCurrent();
    emit('search', searchInfo());
    return searchInfo();
  }

  function gotoMatch(dir) {
    const st = io.mode;
    if (!st || !st.matches.length) return;
    st.index = (st.index + dir + st.matches.length) % st.matches.length;
    highlightCurrent();
    emit('search', searchInfo());
  }

  function highlightCurrent() {
    const st = io.mode;
    if (!st || st.index < 0) return;
    const m = st.matches[st.index];
    if (!m) return;
    try {
      term.select(m.col, m.row, m.len);
      term.scrollToLine(Math.max(0, m.row - Math.floor((state.rows || 24) / 3)));
    } catch { }
  }

  function clearScreen() {
    term.write('\x1b[2J\x1b[H');
  }

  function clearScrollback() {
    term.write('\x1b[3J\x1b[2J\x1b[H');
    toast(t('app.terminal.cleared'), 'success');
  }

  function exportText() {
    const lines = extractLines(term);
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end -= 1;
    return lines.slice(0, end).join('\n');
  }

  function copySelection() {
    const sel = term.getSelection();
    if (!sel) { toast(t('app.terminal.no-selection'), 'info'); return false; }
    copyText(sel).then((ok) => toast(ok ? tf('app.terminal.copied-chars', { v1: (sel.length) }) : t('app.terminal.copy-failed'), ok ? 'success' : 'error'));
    return true;
  }

  function applyTheme() {
    term.options.theme = termTheme();
  }

  function setConfig(cfg) {
    const o = term.options;
    o.fontFamily = cfg.fontFamily;
    o.fontSize = cfg.fontSize;
    o.lineHeight = cfg.lineHeight;
    o.letterSpacing = cfg.letterSpacing;
    o.cursorStyle = cfg.cursorStyle;
    o.cursorBlink = cfg.cursorBlink;
    o.smoothScrollDuration = cfg.smoothScroll ? 90 : 0;
    o.fastScrollModifier = cfg.fastScrollModifier;
    o.scrollback = cfg.scrollback;
    applyTheme();
    el.classList.toggle('term-ligatures', !!cfg.ligatures);
    requestAnimationFrame(doFit);
  }

  function handleShortcutKey(e) {
    if (!e.ctrlKey && !e.metaKey) return false;
    const k = e.key;
    const lower = (k || '').toLowerCase();

    if (e.shiftKey) {
      switch (lower) {
        case 'c': copySelection(); return true;
        case 'v': pasteFromClipboard(); return true;
        case 'a': term.selectAll(); return true;
        case 'f': emit('search-open'); return true;
        case 'k': clearScrollback(); return true;
        case 's': emit('save-output'); return true;
        case 't': emit('newtab'); return true;
        case 'w': emit('closetab'); return true;
        case ',': emit('settings'); return true;
        case 'd': emit('split-right'); return true;
        case 'e': emit('split-down'); return true;
        case 'arrowup': term.scrollLines(1); return true;
        case 'arrowdown': term.scrollLines(-1); return true;
        case 'arrowleft':
        case 'arrowright': emit('focus-pane', lower === 'arrowleft' ? -1 : 1); return true;
        default: break;
      }
      if (k === 'Tab') { emit('tab-cycle', -1); return true; }
      return false;
    }

    if (k === 'Tab') { emit('tab-cycle', 1); return true; }
    if (k === '=' || k === '+') { emit('fontsize', getConfig().fontSizeStep); return true; }
    if (k === '-' || k === '_') { emit('fontsize', -getConfig().fontSizeStep); return true; }
    if (k === '0') { emit('fontsize', 0); return true; }
    if (k === 'Insert') { emit('copy-or-paste'); return true; }
    return false;
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.isComposing || e.keyCode === 229) return true;

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Insert') {
      pasteFromClipboard();
      return false;
    }
    return !handleShortcutKey(e);
  });

  function dispose() {
    io.disposed = true;
    fitOnResize.cancel();
    if (io.ro) io.ro.disconnect();
    if (term.textarea) term.textarea.removeEventListener('paste', onPasteEvent);
    session.dispose();
    try { term.dispose(); } catch { }
    el.remove();
  }

  session.connect();
  return pane;
}
