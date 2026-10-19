import { setTitle, openApp, provideApi, bootApp, windowControl } from '/assets/js/app-bridge.js';

import { fmtSize, fmtTime, isMod, modLabel } from '/assets/js/core/dom.js';
import { Fragment, createView, dom, h, useState } from '/assets/js/core/vdom.js';
import { effect, signal } from '/assets/js/core/signal.js';
import { getJSONPref, setJSONPref, prefSignal } from '/assets/js/core/prefs.js';
import { createSplitter } from '/assets/js/core/splitter.js';
import { toast, confirmAction, copyText as copyToClipboard } from '/assets/js/core/ui.js';
import {
  dialog, menu, promptDialog, sidebarSections, statusBar, sideAction,
} from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { requestSudoElevation, isSudoPermError } from '/assets/js/core/sys.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { lang, setupI18n, t, tf } from '/assets/js/core/i18n.js';
import { CodeEditor, highlightCode, languageForFile, isTextFile } from '/assets/js/core/code-editor.js';
import {
  sftpList, sftpMkdir, sftpRemove, sftpRename, sftpUpload, sftpDownloadUrl,
  sftpCopy, sftpMove, sftpPreviewUrl, sftpStat, sftpSetAttrs,
  sftpSudoForget,
} from '/assets/js/core/qxssh-api.js';

const LS_VIEW = 'qx-fm-view';
const LS_HIDDEN = 'qx-fm-hidden';
const LS_BOOKMARKS = 'qx-fm-bookmarks';

const VIEW_DEFS = [
  { id: 'list', icon: 'list', tipKey: 'app.files.view-list' },
  { id: 'grid', icon: 'grid', tipKey: 'app.files.view-icons' },
  { id: 'compact', icon: 'rows-2', tipKey: 'app.files.view-compact' },
];

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  code: ['js', 'ts', 'go', 'py', 'rs', 'c', 'h', 'cpp', 'java', 'sh', 'json', 'yml', 'yaml', 'toml', 'css', 'html', 'xml', 'sql'],
  doc: ['txt', 'md', 'log', 'conf', 'ini', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
};
const KIND_BY_EXT = (() => {
  const m = {};
  for (const [kind, exts] of Object.entries(EXT_KIND)) for (const e of exts) m[e] = kind;
  return m;
})();

function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function kindOf(f) { return f.isDir ? 'dir' : (KIND_BY_EXT[extOf(f.name)] || 'file'); }

const KIND_ICON = {
  dir: 'folder', image: 'image', archive: 'archive', file: 'file',
  video: 'Film', audio: 'Music', code: 'file-code', doc: 'FileText',
};
function iconFor(f) { return KIND_ICON[kindOf(f)] || 'file'; }
function isHidden(name) { return name.startsWith('.'); }

function joinPath(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return dir.replace(/\/+$/, '') + '/' + name;
}
function parentPath(p) {
  if (!p || p === '/' || p === '~') return null;
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i <= 0) return '/';
  return s.slice(0, i) || '/';
}
function promptInput(title, desc, value = '') {
  return promptDialog({ title, desc, value }).then((v) => (v == null ? null : v.trim()));
}

function wrapDownload(href, name) {
  const a = dom('a', { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function findFreeName(existing, name) {
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!existing.has(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

const PERM_COLS = [
  { key: 'u', labelKey: 'app.files.perm-owner' },
  { key: 'g', labelKey: 'app.files.perm-group' },
  { key: 'o', labelKey: 'app.files.perm-other' },
];
const PERM_ROWS = [
  { key: 'r', labelKey: 'app.files.perm-read', bit: { u: 0o400, g: 0o040, o: 0o004 } },
  { key: 'w', labelKey: 'app.files.perm-write', bit: { u: 0o200, g: 0o020, o: 0o002 } },
  { key: 'x', labelKey: 'app.files.perm-exec', bit: { u: 0o100, g: 0o010, o: 0o001 } },
];
const PERM_SPECIAL = [
  { label: 'setuid', bit: 0o4000 }, { label: 'setgid', bit: 0o2000 }, { label: 'sticky', bit: 0o1000 },
];

function octalOf(v) {
  const s = (v & 0o7777).toString(8).padStart(4, '0');
  return s[0] === '0' ? s.slice(1) : s;
}

function modeFromString(m) {
  const s = String(m || '');
  if (s.length < 9) return 0o644;
  const rwx = s.slice(-9);
  const B = [[0o400, 0o200, 0o100], [0o040, 0o020, 0o010], [0o004, 0o002, 0o001]];
  const SP = [0o4000, 0o2000, 0o1000];
  let v = 0;
  for (let i = 0; i < 9; i++) {
    const ch = rwx[i] || '-';
    const g = Math.floor(i / 3);
    switch (ch) {
      case '-': break;
      case 's': v |= SP[g] | B[g][i % 3]; break;
      case 'S': v |= SP[g]; break;
      case 't': v |= SP[2] | B[g][i % 3]; break;
      case 'T': v |= SP[2]; break;
      default: v |= B[g][i % 3];
    }
  }
  const pre = s.slice(0, -9);
  if (pre.includes('u')) v |= 0o4000;
  if (pre.includes('g')) v |= 0o2000;
  if (pre.includes('t')) v |= 0o1000;
  return v;
}

function symbolicOf(f, v) {
  const ex = (bit, sbit, sc) => {
    if (v & sbit) return (v & bit) ? sc : sc.toUpperCase();
    return (v & bit) ? 'x' : '-';
  };
  const type = f.isDir ? 'd' : (/^[Ll]/.test(f.mode || '') ? 'l' : '-');
  return type
    + (v & 0o400 ? 'r' : '-') + (v & 0o200 ? 'w' : '-') + ex(0o100, 0o4000, 's')
    + (v & 0o040 ? 'r' : '-') + (v & 0o020 ? 'w' : '-') + ex(0o010, 0o2000, 's')
    + (v & 0o004 ? 'r' : '-') + (v & 0o002 ? 'w' : '-') + ex(0o001, 0o1000, 't');
}

function boot(el, ctx) {
  const hostId = ctx.hostId;

  const viewMode = prefSignal(LS_VIEW, 'list');
  const showHidden = prefSignal(LS_HIDDEN, false);
  const bookmarks = prefSignal(LS_BOOKMARKS, []);
  const previewOn = signal(true);
  const elevated = signal(false);
  const homePath = signal('');
  const devices = signal(null);
  const devicesErr = signal('');
  const undoTick = signal(0);
  const pick = signal(null);

  function newPane(id) {
    return {
      id,
      path: ctx.cwd || '~',
      files: [], loading: false, error: null,
      query: '', sel: new Set(), anchor: null, editing: false, activeName: null,
      sort: { key: 'name', dir: 1 }, hist: [], hi: -1,
      sig: signal(0),
      drop: signal(''),
      root: null, listEl: null, omniEl: null, filterEl: null,
      rowEls: new Map(), gestures: new Map(),
    };
  }
  const panes = [newPane('A')];
  const A = () => panes[0];
  function repaint(pane) { pane.sig.next = pane.sig.value + 1; }

  const SFraw = {
    list: (h, p) => sftpList(h, p, elevated.value),
    mkdir: (h, p) => sftpMkdir(h, p, elevated.value),
    remove: (h, p, r) => sftpRemove(h, p, r, elevated.value),
    rename: (h, f, t) => sftpRename(h, f, t, elevated.value),
    copy: (h, f, t) => sftpCopy(h, f, t, elevated.value),
    move: (h, f, t) => sftpMove(h, f, t, elevated.value),
    stat: (h, p) => sftpStat(h, p, elevated.value),
    upload: (h, d, f) => sftpUpload(h, d, f, elevated.value),
    downloadUrl: (h, p) => sftpDownloadUrl(h, p, elevated.value),
    previewUrl: (h, p) => sftpPreviewUrl(h, p, elevated.value),
  };

  let permBusy = false;
  async function permGuard(fn, ...args) {
    if (elevated.value || permBusy) return fn(...args);
    try {
      return await fn(...args);
    } catch (e) {
      if (!isSudoPermError(e)) throw e;
      permBusy = true;
      let granted = false;
      try {
        granted = await autoRequestPermission(e);
      } finally {
        permBusy = false;
      }
      if (!granted) throw e;
      return fn(...args);
    }
  }

  async function autoRequestPermission(e) {
    const r = await requestSudoElevation(hostId, {
      title: t('app.files.sudo-required'),
      reason: tf('app.files.sudo-denied', { v1: (e.message) }),
    });
    if (!r.ok) {
      if (!r.cancelled) toast(r.error, 'error');
      return false;
    }
    elevated.next = true;
    toast(t('app.files.sudo-granted'), 'success');
    return true;
  }

  const GUARDED = ['list', 'mkdir', 'remove', 'rename', 'copy', 'move', 'stat', 'upload'];
  const SF = Object.fromEntries(Object.entries(SFraw).map(([k, fn]) =>
    [k, GUARDED.includes(k) ? (...args) => permGuard(fn, ...args) : fn]
  ));

  const HOME = () => (elevated.value && homePath.value ? homePath.value : '~');

  const undoStack = [];
  const UNDO_MAX = 50;
  function pushUndo(label, run) {
    undoStack.push({ label, run });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    undoTick.next = undoTick.value + 1;
  }
  async function doUndo() {
    const entry = undoStack.pop();
    undoTick.next = undoTick.value + 1;
    if (!entry) { toast(t('app.files.undo-empty'), 'info'); return; }
    try {
      await entry.run();
      toast(tf('app.files.undone', { v1: (entry.label) }), 'success');
    } catch (e) {
      toast(tf('app.files.undo-failed', { v1: (entry.label), v2: (e.message) }), 'error');
    }
    await reload(A());
  }

  let dragCtx = null;
  let uploadEl = null;

  const pickQueue = [];
  let pickBusy = false;

  function startPick(args) {
    const a = args || {};
    return new Promise((resolve) => {
      pickQueue.push(() => {
        const req = {
          type: a.type === 'dir' ? 'dir' : 'file',
          title: String(a.title || ''),
          sent: false,
          resolve,
        };
        pick.next = req;
        setTitle(req.title || (req.type === 'dir' ? t('app.files.pick-dir') : t('app.files.pick-file')));
        const start = String(a.start || '');
        if (start && panes[0]) navigate(start, { pane: panes[0] });
      });
      if (!pickBusy) {
        pickBusy = true;
        pickQueue.shift()();
      }
    });
  }

  function pickDone() {
    const next = pickQueue.shift();
    if (next) next();
    else pickBusy = false;
  }

  function finishPick(path) {
    const req = pick.value;
    if (!req || req.sent) return;
    req.sent = true;
    pick.next = null;
    req.resolve(typeof path === 'string' && path ? path : '');
    pickDone();
  }

  const sideBox = document.createElement('div');
  sideBox.className = 'fm-side';
  const sideView = createView(sideBox);
  sideView.update(sideTree);

  function sideTree() {
    lang();
    const pane = A();
    void pane.sig.value;
    void devices.value;
    void devicesErr.value;
    void bookmarks.value;
    void elevated.value;
    void homePath.value;
    const dev = devices.value;
    const bms = bookmarks.value;
    const go = (p) => () => navigate(p);
    return sidebarSections([
      {
        title: t('app.files.side-places'),
        items: [
          { id: HOME(), label: t('app.files.place-home'), icon: 'home', onClick: go(HOME()) },
          { id: '/', label: t('app.files.place-root'), icon: 'root', onClick: go('/') },
        ],
        cls: 'fm-side-flat',
      },
      {
        title: t('app.files.side-bookmarks'),
        actions: h('button', {
          class: 'qx-ibtn qx-ibtn-sm', html: icon('plus', 'qicon-sm'),
          dataset: { tip: t('app.files.bookmark-add') }, onClick: addBookmark,
        }),
        items: bms.map((bm, i) => ({
          id: bm.path, label: bm.name, icon: 'star',
          tip: tf('app.files.bookmark-item', { v1: (bm.path) }),
          onContext: (e) => { e.preventDefault(); removeBookmark(i); },
        })),
        note: bms.length ? '' : t('app.files.bookmark-empty'),
      },
      {
        title: t('app.files.side-devices'),
        note: dev === null ? t('app.files.status-reading')
          : (devicesErr.value ? tf('app.files.devices-failed', { v1: devicesErrText() })
            : (dev.length ? '' : t('app.files.devices-none'))),
        items: (dev || []).map((d) => ({
          id: d.mp, label: d.mp === '/' ? t('app.files.device-root') : d.mp, icon: 'hdd',
          tip: `${d.dev} · ${d.fstype}`,
        })),
      },
    ], pane.path, (id) => navigate(id));
  }

  function addBookmark() {
    const p = A().path;
    if (!p || p === '~') { toast(t('app.files.bookmark-need-dir'), 'warning'); return; }
    if (bookmarks.value.some((b) => b.path === p)) { toast(t('app.files.bookmark-exists'), 'info'); return; }
    bookmarks.next = [...bookmarks.value, {
      name: p.split('/').filter(Boolean).pop() || p, path: p,
    }];
    toast(t('app.files.bookmark-added'), 'success');
  }
  function removeBookmark(i) {
    const b = bookmarks.value[i];
    if (!b) return;
    bookmarks.next = bookmarks.value.filter((_, j) => j !== i);
    toast(tf('app.files.bookmark-removed', { v1: (b.name) }), 'success');
  }

  async function loadDevices() {
    devices.next = null;
    devicesErr.next = '';
    try {
      const res = await fetch(SF.previewUrl(hostId, '/proc/mounts'));
      if (!res.ok) {
        const e = new Error(`mounts HTTP ${res.status}`);
        e.term = { key: 'app.files.mounts-failed', params: { v1: res.status } };
        throw e;
      }
      const skip = /^(proc|sysfs|devtmpfs|devpts|tmpfs|cgroup|cgroup2|securityfs|pstore|efivarfs|bpf|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|binfmt_misc|autofs|rpc_pipefs|nsfs|overlay|squashfs|ramfs|systemd-1|sunrpc)$/;
      const seen = new Set();
      const out = [];
      for (const line of (await res.text()).split('\n')) {
        const p = line.split(' ');
        if (p.length < 3) continue;
        const [dev, mp, fstype] = p;
        if (!mp.startsWith('/') || skip.test(fstype) || seen.has(mp)) continue;
        seen.add(mp);
        out.push({ dev, mp, fstype });
        if (out.length >= 12) break;
      }
      devices.next = out;
    } catch (e) {
      devices.next = [];
      devicesErr.next = e && e.term
        ? { term: e.term }
        : { raw: (e && e.message) || String(e) };
    }
  }

  function devicesErrText() {
    const err = devicesErr.value;
    if (!err) return '';
    return err.term ? tf(err.term.key, err.term.params) : String(err.raw || '');
  }

  const bodyEl = { current: null };
  const previewEl = { current: null };
  const splitter = createSplitter({
    key: 'qx-fm-previeww',
    title: t('app.files.hint-resize-preview'),
    getBody: () => bodyEl.current,
    getPanel: () => previewEl.current,
  });

  const shell = createAppShell(el, {
    tabs: [],
    sideTop: [sideBox],
    actions: [
      () => sideAction({ icon: 'reload', label: t('app.files.action-reload'), onClick: () => reload(A()) }),
    ],
  });
  shell.setMain(mainTree);
  splitter.restore();

  effect(() => splitter.setHidden(!previewOn.value));

  function mainTree() {
    const req = pick.value;
    return h(Fragment, {}, [
      req ? pickBar(req) : null,
      h('div', { key: 'body', class: 'qx-scroll' }, [
        h('div', {
          key: 'fm',
          class: 'fm-body',
          ref: (el) => { bodyEl.current = el; },
        }, [
          h('div', {
            key: 'panes',
            class: 'fm-panes',
            onDragover: (e) => { if (dragCtx) e.preventDefault(); },
            onDrop: (e) => { if (dragCtx) onDropOnDir(e, A(), null); },
          }, panes.map((p) => h(PaneView, { key: p.id, pane: p }))),
          splitter.el,
          h(PreviewPanel),
        ]),
      ]),
      h(StatusBarView, { key: 'status' }),
      h('input', {
        key: 'upload',
        type: 'file', multiple: true, hidden: true,
        ref: (el) => { uploadEl = el; },
        onChange: onUploadPick,
      }),
    ]);
  }

  function pickBar(req) {
    return h('div', { key: 'pick', class: 'fm-pick-bar' }, [
      h('span', { class: 'fm-pick-badge', text: req.type === 'dir' ? t('app.files.pick-dir') : t('app.files.pick-file') }),
      h('span', {
        class: 'fm-pick-hint',
        text: req.type === 'dir'
          ? t('app.files.pick-dir-hint')
          : t('app.files.pick-file-hint'),
      }),
      h('span', { class: 'qx-grow' }),
      req.type === 'dir'
        ? h('button', {
            class: 'btn btn-primary btn-sm',
            text: t('app.files.pick-this-folder'),
            onClick: () => finishPick(A().path),
          })
        : null,
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.files.action-cancel'), onClick: () => finishPick('') }),
    ]);
  }

  function PaneView(props) {
    const pane = props.pane;
    void pane.sig.value;
    const up = parentPath(pane.path);
    return h('div', {
      class: cx('fm-pane cmp-card qx-card-fill',
        pane === A() && 'active', pane.editing && 'editing'),
      tabindex: '0',
      ref: (el) => { pane.root = el; },
    }, [
      h('div', { class: 'cmp-card-title qx-card-head fm-pane-nav' }, [
        navBtn('arrow-left', t('app.files.nav-back'), pane.hi <= 0, () => go(pane, -1)),
        navBtn('arrow-right', t('app.files.nav-forward'), pane.hi >= pane.hist.length - 1, () => go(pane, 1)),
        navBtn('arrow-up', t('app.files.nav-up'), !up, () => { if (up) navigate(up, { pane }); }),
        navBtn('reload', t('app.files.nav-reload'), false, () => reload(pane)),
        crumb(pane),
        omni(pane),
      ]),
      h('div', { class: 'cmp-card-body' }, [
        h(ToolbarView, { pane }),
        h(FileList, { pane }),
      ]),
    ]);
  }

  function navBtn(iconName, tip, disabled, onClick) {
    return h('button', {
      class: 'qx-ibtn qx-ibtn-sm',
      html: icon(iconName, 'qicon-sm'),
      dataset: { tip },
      disabled,
      onClick,
    });
  }

  function crumb(pane) {
    const segs = [];
    if (pane.path.startsWith('/')) {
      segs.push({ label: '/', path: '/', icon: 'root' });
      let acc = '';
      for (const seg of pane.path.split('/').filter(Boolean)) {
        acc += '/' + seg;
        segs.push({
          label: seg,
          path: acc,
          icon: homePath.value && acc === homePath.value ? 'home' : null,
        });
      }
    } else {
      segs.push({ label: pane.path, path: pane.path, icon: 'home' });
    }
    return h('div', { class: 'fm-crumb' }, [
      ...segs.map((s, i) => h('button', {
        key: s.path,
        class: `fm-crumb-seg${i === segs.length - 1 ? ' cur' : ''}`,
        onClick: () => { if (s.path) navigate(s.path, { pane }); },
      }, [
        s.icon ? h('span', { class: 'fm-seg-ic', html: icon(s.icon, 'qicon-sm') }) : null,
        h('span', { text: s.label }),
      ].filter(Boolean))),
      h('button', {
        class: 'fm-crumb-edit',
        html: icon('edit', 'qicon-sm'),
        dataset: { tip: tf('app.files.hint-edit-path', { v1: (modLabel()) }) },
        onClick: () => startEdit(pane),
      }),
    ]);
  }

  function omni(pane) {
    return h('input', {
      class: 'input fm-omni', type: 'text', spellcheck: 'false',
      value: pane.path,
      ref: (el) => { pane.omniEl = el; },
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          pane.editing = false;
          navigate(e.target.value.trim() || HOME(), { pane });
        } else if (e.key === 'Escape') {
          pane.editing = false;
          repaint(pane);
        }
      },
      onBlur: () => { if (pane.editing) { pane.editing = false; repaint(pane); } },
    });
  }

  function startEdit(pane) {
    pane.editing = true;
    repaint(pane);
    setTimeout(() => {
      if (pane.omniEl) { pane.omniEl.focus(); pane.omniEl.select(); }
    }, 0);
  }

  function ToolbarView(props) {
    const pane = props.pane;
    const v = viewMode.value;
    const hid = showHidden.value;
    const pv = previewOn.value;
    void undoTick.value;
    const top = undoStack[undoStack.length - 1];
    return h('div', { class: 'qx-card-tools' }, [
      ...VIEW_DEFS.map((it) => h('button', {
        key: it.id,
        class: cx('qx-ibtn', v === it.id && 'active'),
        html: icon(it.icon, 'qicon-sm'),
        dataset: { tip: t(it.tipKey) },
        onClick: () => setView(it.id),
      })),
      h('button', {
        class: cx('qx-ibtn', hid && 'active'),
        html: icon(hid ? 'eye' : 'eye-off', 'qicon-sm'),
        dataset: { tip: tf('app.files.hint-toggle-hidden', { v1: (modLabel()) }) },
        onClick: () => setHidden(!hid),
      }),
      h('span', { class: 'fm-tsep' }),
      h('button', {
        class: 'qx-ibtn', html: icon('folder-plus', 'qicon-sm'),
        dataset: { tip: t('app.files.action-new-dir') }, onClick: doNewFolder,
      }),
      h('button', {
        class: 'qx-ibtn', html: icon('file-plus', 'qicon-sm'),
        dataset: { tip: t('app.files.action-new-file') }, onClick: doNewFile,
      }),
      h('button', {
        class: 'qx-ibtn', html: icon('upload', 'qicon-sm'),
        dataset: { tip: t('app.files.action-upload') }, onClick: pickUpload,
      }),
      h('button', {
        class: 'qx-ibtn', html: icon('undo', 'qicon-sm'),
        dataset: { tip: top ? tf('app.files.undo-last', { v1: (top.label), v2: (modLabel()) }) : tf('app.files.undo', { v1: (modLabel()) }) },
        disabled: !top,
        onClick: () => doUndo(),
      }),
      h('span', { class: 'qx-grow' }),
      h('input', {
        class: 'input fm-filter', type: 'search', placeholder: t('app.files.filter-placeholder'),
        ref: (el) => { pane.filterEl = el; },
        onInput: (e) => { pane.query = e.target.value; repaint(pane); },
      }),
      h('span', { class: 'fm-tsep' }),
      h('button', {
        class: cx('qx-ibtn', pv && 'active'),
        html: icon('info', 'qicon-sm'),
        dataset: { tip: t('app.files.hint-preview-pane') },
        onClick: () => { previewOn.next = !pv; },
      }),
    ]);
  }

  function FileList(props) {
    const pane = props.pane;
    void pane.sig.value;
    void pane.drop.value;
    const v = viewMode.value;
    void showHidden.value;
    return h('div', {
      class: cx('fm-list', v === 'compact' && 'view-compact'),
      ref: (el) => { pane.listEl = el; },
      onContextMenu: (e) => onBlankContext(e, pane),
      onPointerdown: (e) => startRubberBand(e, pane),
    }, listBody(pane, v));
  }

  function listBody(pane, v) {
    if (pane.loading) {
      return [emptyBox(t('app.files.list-loading'))];
    }
    if (pane.error) {
      return [h('div', { key: 'error', class: 'fm-empty' }, [
        h('div', { class: 'fm-empty-title', text: t('app.files.list-unreadable') }),
        h('div', { class: 'fm-empty-desc', text: pane.error }),
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.files.action-retry'), onClick: () => reload(pane) }),
      ])];
    }
    const files = sortedVisible(pane);
    if (!files.length) {
      return [h('div', { key: 'empty', class: 'fm-empty' }, [
        h('div', {
          class: 'fm-empty-title',
          text: pane.query ? t('app.files.empty-no-match') : t('app.files.empty-dir'),
        }),
        h('div', {
          class: 'fm-empty-desc',
          text: pane.query ? t('app.files.empty-no-match-hint') : t('app.files.empty-dir-hint'),
        }),
      ])];
    }
    pane.rowEls.clear();
    if (v === 'grid') {
      return [h('div', { key: 'grid', class: 'fm-grid' }, files.map((f) => fileCard(pane, f)))];
    }
    return [listHead(pane), ...files.map((f) => fileRow(pane, f))];
  }

  function emptyBox(title) {
    return h('div', { key: 'loading', class: 'fm-empty' }, [
      h('div', { class: 'fm-empty-title', text: title }),
    ]);
  }

  function listHead(pane) {
    const th = (key, label, cls = '') => {
      const active = pane.sort.key === key;
      return h('button', {
        key,
        class: `fm-th${cls ? ' ' + cls : ''}${active ? ' active' : ''}`,
        onClick: () => { pane.sort = { key, dir: active ? -pane.sort.dir : 1 }; repaint(pane); },
      }, [
        h('span', { text: label }),
        active ? h('span', { class: 'fm-th-arrow', text: pane.sort.dir > 0 ? '↑' : '↓' }) : null,
      ].filter(Boolean));
    };
    return h('div', { key: 'head', class: 'fm-head qx-list-head' }, [
      th('name', t('app.files.col-name'), 'fm-col-name'),
      th('size', t('app.files.col-size'), 'fm-col'),
      th('mtime', t('app.files.col-modified'), 'fm-col'),
    ]);
  }

  function itemGestures(pane, f) {
    const cached = pane.gestures.get(f.name);
    if (cached) { cached.file = f; return cached.props; }
    const slot = { file: f, props: {} };
    slot.props = {
      onClick: (e) => onItemClick(pane, slot.file, e),
      onDblclick: () => openItem(pane, slot.file),
      onContextMenu: (e) => {
        e.preventDefault();
        if (!pane.sel.has(slot.file.name)) { selectOnly(pane, slot.file.name); repaint(pane); }
        openCtxMenu(e, pane);
      },
      onDragstart: (e) => onDragStart(e, pane, slot.file),
      onDragover: (e) => {
        if (slot.file.isDir && dragCtx) { e.preventDefault(); setDrop(pane, slot.file.name); }
      },
      onDragleave: () => setDrop(pane, ''),
      onDrop: (e) => { setDrop(pane, ''); onDropOnDir(e, pane, slot.file); },
    };
    pane.gestures.set(f.name, slot);
    return slot.props;
  }

  function fileRow(pane, f) {
    return h('div', {
      ...itemGestures(pane, f),
      key: f.name,
      class: cx('fm-row', pane.sel.has(f.name) && 'selected', pane.drop.value === f.name && 'drop'),
      draggable: 'true',
      dataset: { name: f.name },
      ref: (el) => { if (el) pane.rowEls.set(f.name, el); },
    }, [
      h('div', { class: 'fm-col-name fm-name' }, [
        h('span', { class: `fm-ic is-${kindOf(f)}`, html: icon(iconFor(f), 'qicon-sm') }),
        h('span', { class: 'fm-name-text', text: f.name }),
      ]),
      h('div', { class: 'fm-col fm-size mono', text: f.isDir ? '—' : fmtSize(f.size) }),
      h('div', { class: 'fm-col fm-mtime mono', text: fmtTime(f.modTime) }),
    ]);
  }

  function fileCard(pane, f) {
    return h('div', {
      ...itemGestures(pane, f),
      key: f.name,
      class: cx('fm-card', pane.sel.has(f.name) && 'selected',
        pane.drop.value === f.name && 'drop'),
      draggable: 'true',
      dataset: { name: f.name },
      ref: (el) => { if (el) pane.rowEls.set(f.name, el); },
    }, [
      h('span', { class: `fm-card-ic is-${kindOf(f)}`, html: icon(iconFor(f), 'qicon') }),
      h('span', { class: 'fm-card-name', text: f.name, dataset: { tip: f.name } }),
    ]);
  }

  function setDrop(pane, name) {
    if (pane.drop.peek() !== name) pane.drop.next = name;
  }

  function sortedVisible(pane) {
    const q = pane.query.trim().toLowerCase();
    const hidden = showHidden.value;
    const arr = pane.files.filter((f) => {
      if (!hidden && isHidden(f.name)) return false;
      if (q && !f.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const { key, dir } = pane.sort;
    arr.sort((x, y) => {
      if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
      let c = 0;
      if (key === 'size') c = (x.size || 0) - (y.size || 0);
      else if (key === 'mtime') c = new Date(x.modTime) - new Date(y.modTime);
      else c = x.name.localeCompare(y.name, 'zh');
      return c * dir;
    });
    return arr;
  }

  function onItemClick(pane, f, e) {
    if (e.ctrlKey || e.metaKey) {
      if (pane.sel.has(f.name)) pane.sel.delete(f.name); else pane.sel.add(f.name);
      pane.anchor = f.name;
    } else if (e.shiftKey && pane.anchor) {
      const list = sortedVisible(pane).map((x) => x.name);
      const a = list.indexOf(pane.anchor), b = list.indexOf(f.name);
      if (a >= 0 && b >= 0) {
        pane.sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) pane.sel.add(list[i]);
      }
    } else selectOnly(pane, f.name);
    pane.activeName = f.name;
    repaint(pane);
  }

  function selectOnly(pane, name) {
    pane.sel.clear();
    pane.sel.add(name);
    pane.anchor = name;
    pane.activeName = name;
  }
  function selectedFiles(pane) { return pane.files.filter((f) => pane.sel.has(f.name)); }

  function moveActive(pane, delta) {
    const list = sortedVisible(pane).map((x) => x.name);
    if (!list.length) return;
    let i = pane.activeName ? list.indexOf(pane.activeName) : -1;
    if (i < 0) i = delta > 0 ? 0 : list.length - 1;
    else i = Math.max(0, Math.min(list.length - 1, i + delta));
    selectOnly(pane, list[i]);
    repaint(pane);
    const row = pane.rowEls.get(list[i]);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function openItem(pane, f) {
    if (f.isDir) { navigate(joinPath(pane.path, f.name), { pane }); return; }
    const req = pick.value;
    if (req) {
      if (req.type === 'file') {
        finishPick(joinPath(pane.path, f.name));
      } else {
        selectOnly(pane, f.name);
        repaint(pane);
      }
      return;
    }
    const k = kindOf(f);
    if (k === 'image' || k === 'doc') {
      selectOnly(pane, f.name);
      repaint(pane);
      previewOn.next = true;
      return;
    }
    downloadFile(pane, f);
  }

  function downloadFile(pane, f) {
    const filename = f.isDir ? `${f.name}.tar.gz` : f.name;
    wrapDownload(SF.downloadUrl(hostId, joinPath(pane.path, f.name)), filename);
  }

  function downloadFiles(pane, files) {
    files.forEach((f, idx) => {
      setTimeout(() => downloadFile(pane, f), idx * 250);
    });
  }

  function openTerminalHere(pane) {
    const sel = selectedFiles(pane);
    const dir = (sel.length === 1 && sel[0].isDir) ? joinPath(pane.path, sel[0].name) : pane.path;
    openApp('terminal', { cwd: dir });
  }

  async function ensureSudoCred(reason = '') {
    if (elevated.value) return true;
    const r = await requestSudoElevation(hostId, { title: t('app.files.sudo-prompt'), reason });
    if (r.ok) return true;
    if (!r.cancelled) toast(r.error, 'error');
    return false;
  }

  async function enableElevated() {
    if (elevated.value) return;
    if (!(await ensureSudoCred())) return;
    const pane = A();
    elevated.next = true;
    await reload(pane);
    if (pane.error) {
      elevated.next = false;
      toast(t('app.files.root-open-failed') + pane.error, 'error');
      await reload(pane);
    } else {
      toast(t('app.files.root-opened'), 'success');
    }
  }

  async function disableElevated() {
    if (!elevated.value) return;
    elevated.next = false;
    sftpSudoForget(hostId).catch(() => { });
    await reload(A());
    toast(t('app.files.root-exited'), 'success');
  }

  async function navigate(path, { pane = A(), push = true } = {}) {
    pane.loading = true;
    pane.error = null;
    pane.query = '';
    if (pane === A() && pane.filterEl) pane.filterEl.value = '';
    if (push) {
      pane.hist = pane.hist.slice(0, pane.hi + 1);
      pane.hist.push(path);
      pane.hi = pane.hist.length - 1;
    }
    repaint(pane);
    try {
      const data = await SF.list(hostId, path);
      const abs = data.path || path;
      if (!homePath.peek() && path === '~') homePath.next = abs;
      pane.path = abs;
      pane.files = data.files || [];
      pane.gestures.clear();
      pane.sel.clear();
      pane.anchor = null;
      pane.activeName = null;
    } catch (e) {
      pane.error = e.message || String(e);
      pane.files = [];
      toast(t('app.files.list-failed') + pane.error, 'error');
    } finally {
      pane.loading = false;
      repaint(pane);
      if (pane.root) pane.root.focus();
    }
  }

  function go(pane, delta) {
    const ni = pane.hi + delta;
    if (ni < 0 || ni >= pane.hist.length) return;
    pane.hi = ni;
    navigate(pane.hist[ni], { pane, push: false });
  }

  function reload(pane) { navigate(pane.path, { pane, push: false }); }

  function setView(v) { viewMode.next = v; }
  function setHidden(v) { showHidden.next = v; }

  async function doNewFolder() {
    const pane = A();
    const name = await promptInput(
      t('app.files.action-new-dir'),
      tf('app.files.newdir-in', { v1: (pane.path) }),
      ''
    );
    if (!name) return;
    const created = joinPath(pane.path, name);
    try {
      await SF.mkdir(hostId, created);
      pushUndo(tf('app.files.newdir-title', { v1: name }), () => SF.remove(hostId, created, true));
      toast(t('app.files.newdir-done'), 'success');
      await reload(pane);
    } catch (e) { toast(t('app.files.newdir-failed') + e.message, 'error'); }
  }

  async function doNewFile() {
    const pane = A();
    const name = await promptInput(
      t('app.files.action-new-file'),
      tf('app.files.newfile-in', { v1: (pane.path) }),
      ''
    );
    if (!name) return;
    const created = joinPath(pane.path, name);
    try {
      await SF.upload(hostId, pane.path, new File([''], name));
      pushUndo(tf('app.files.newfile-title', { v1: name }), () => SF.remove(hostId, created, false));
      toast(t('app.files.newfile-done'), 'success');
      await reload(pane);
      selectOnly(pane, name);
      repaint(pane);
    } catch (e) { toast(t('app.files.newfile-failed') + e.message, 'error'); }
  }

  function pickUpload() { if (uploadEl) uploadEl.click(); }

  async function onUploadPick(e) {
    const pane = A();
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const before = new Set(pane.files.map((x) => x.name));
    const added = [];
    let ok = 0;
    for (const f of files) {
      try {
        await SF.upload(hostId, pane.path, f);
        ok++;
        if (!before.has(f.name)) added.push(joinPath(pane.path, f.name));
      } catch (err) { toast(tf('app.files.upload-one-failed', { v1: (f.name), v2: (err.message) }), 'error'); }
    }
    if (added.length) {
      pushUndo(tf('app.files.upload-summary', { v1: (added.length) }), async () => {
        for (const p of added) { try { await SF.remove(hostId, p, false); } catch { } }
      });
    }
    if (ok) toast(tf('app.files.upload-done', { v1: ok }), 'success');
    await reload(pane);
  }

  async function doRename(f) {
    const pane = A();
    const name = await promptInput(t('app.files.action-rename'), f.isDir ? t('app.files.rename-dir-label') : t('app.files.rename-file-label'), f.name);
    if (!name || name === f.name) return;
    const from = joinPath(pane.path, f.name), to = joinPath(pane.path, name);
    try {
      await SF.rename(hostId, from, to);
      pushUndo(tf('app.files.rename-title', { v1: (f.name), v2: name }), () => SF.rename(hostId, to, from));
      toast(t('app.files.rename-done'), 'success');
      await reload(pane);
    } catch (e) { toast(t('app.files.rename-failed') + e.message, 'error'); }
  }

  async function doDelete(files) {
    const pane = A();
    if (!files.length) return;
    const what = files.length === 1 ? `「${files[0].name}」` : tf('app.files.count-items', { v1: (files.length) });
    const ok = await confirmAction(tf('app.files.confirm-delete-title', { v1: what }), t('app.files.confirm-delete-body'), { okText: t('app.files.action-delete'), danger: true });
    if (!ok) return;

    let done = 0, failed = 0;
    for (const f of files) {
      try {
        await SF.remove(hostId, joinPath(pane.path, f.name), f.isDir);
        done++;
      } catch (e) { failed++; toast(tf('app.files.delete-failed', { v1: (f.name), v2: (e.message) }), 'error'); }
    }
    if (done) toast(tf('app.files.delete-done', { v1: done }), 'success');
    if (failed) toast(tf('app.files.delete-partial', { v1: failed }), 'error');
    await reload(pane);
  }

  async function doTransfer(mode) {
    const pane = A();
    const files = selectedFiles(pane);
    if (!files.length) { toast(t('app.files.need-selection'), 'warning'); return; }
    const target = await promptInput(mode === 'copy' ? t('app.files.action-copy-to') : t('app.files.action-move-to'), t('app.files.target-hint'), pane.path);
    if (!target) return;
    const existing = new Set((await SF.list(hostId, target)).files?.map((x) => x.name) || []);
    const pairs = [];
    let done = 0;
    for (const f of files) {
      const from = joinPath(pane.path, f.name);
      let name = f.name;
      if (existing.has(name)) name = findFreeName(existing, name);
      existing.add(name);
      try {
        const to = joinPath(target, name);
        if (mode === 'copy') await SF.copy(hostId, from, to);
        else await SF.move(hostId, from, to);
        pairs.push({ from, to });
        done++;
      } catch (e) { toast(tf('app.files.op-one-failed', { v1: (f.name), v2: (e.message) }), 'error'); }
    }
    if (pairs.length) {
      pushUndo(tf('app.files.transfer-summary', { v1: (mode === 'copy' ? t('app.files.verb-copy') : t('app.files.verb-move')), v2: pairs.length, v3: target }),
        () => undoTransfer(mode, pairs));
    }
    if (done) toast(tf('app.files.transfer-done', { v1: (mode === 'copy' ? t('app.files.verb-copy') : t('app.files.verb-move')), v2: done }), 'success');
    await reload(pane);
  }

  async function undoTransfer(mode, pairs) {
    for (const pr of pairs) {
      try {
        if (mode === 'copy') await SF.remove(hostId, pr.to, true);
        else await SF.move(hostId, pr.to, pr.from);
      } catch { }
    }
  }

  function onDragStart(e, pane, f) {
    if (!pane.sel.has(f.name)) { selectOnly(pane, f.name); repaint(pane); }
    dragCtx = { pane, names: [...pane.sel] };
    e.dataTransfer.effectAllowed = 'copyMove';
    try { e.dataTransfer.setData('text/plain', dragCtx.names.join('\n')); } catch { }
  }

  async function onDropOnDir(e, pane, dir) {
    if (!dragCtx) return;
    e.preventDefault();
    e.stopPropagation();
    const src = dragCtx;
    dragCtx = null;
    const copy = e.ctrlKey || e.metaKey || e.altKey;
    const destDir = dir ? joinPath(pane.path, dir.name) : pane.path;
    if (src.pane === pane && src.names.includes(dir?.name)) return;
    const existing = new Set((await SF.list(hostId, destDir)).files?.map((x) => x.name) || []);
    const pairs = [];
    let done = 0;
    for (const name of src.names) {
      const from = joinPath(src.pane.path, name);
      let target = name;
      if (existing.has(target)) target = findFreeName(existing, target);
      existing.add(target);
      try {
        const to = joinPath(destDir, target);
        if (copy) await SF.copy(hostId, from, to);
        else await SF.move(hostId, from, to);
        pairs.push({ from, to });
        done++;
      } catch (err) { toast(tf('app.files.op-named-failed', { v1: name, v2: (err.message) }), 'error'); }
    }
    if (pairs.length) {
      pushUndo(tf('app.files.transfer-summary', { v1: (copy ? t('app.files.verb-copy') : t('app.files.verb-move')), v2: pairs.length, v3: destDir }),
        () => undoTransfer(copy ? 'copy' : 'move', pairs));
    }
    if (done) toast(tf('app.files.transfer-done-to', { v1: (copy ? t('app.files.verb-copy') : t('app.files.verb-move')), v2: done, v3: destDir }), 'success');
    await reload(src.pane);
    if (pane !== src.pane) await reload(pane);
  }

  const mi = (icon2, label, fn, opts = {}) => {
    const o = typeof opts === 'boolean' ? { danger: opts } : (opts || {});
    return {
      label,
      icon: icon2,
      danger: !!o.danger,
      hint: o.hint || '',
      disabled: !!o.disabled,
      onClick: fn,
    };
  };
  const sep = () => ({ sep: true });

  function doSelectAll(pane) {
    pane.sel = new Set(sortedVisible(pane).map((f) => f.name));
    repaint(pane);
  }

  function openCtxMenu(e, pane) {
    const files = selectedFiles(pane);
    const single = files.length === 1 ? files[0] : null;
    const items = [];

    if (files.length) {
      if (single) {
        items.push(
          mi(
            single.isDir ? 'folder' : 'eye',
            single.isDir ? t('app.files.action-open') : t('app.files.action-preview'),
            () => openItem(pane, single),
            { hint: 'Enter' }
          ),
          mi(
            'download',
            single.isDir ? t('app.files.action-download-archive') : t('app.files.action-download'),
            () => downloadFile(pane, single)
          )
        );
        if (single.isDir) {
          items.push(mi(
            'terminal-prompt',
            t('app.files.action-open-terminal'),
            () => openTerminalHere(pane),
            { hint: 'F4' }
          ));
        }
      } else {
        items.push(
          mi(
            'download',
            tf('app.files.action-download-batch', { v1: files.length }),
            () => downloadFiles(pane, files)
          )
        );
      }
      items.push(
        sep(),
        mi('copy', t('app.files.action-copy-to'), () => doTransfer('copy')),
        mi('FolderInput', t('app.files.action-move-to'), () => doTransfer('move'))
      );
      if (single) {
        items.push(mi('edit', t('app.files.action-rename'), () => doRename(single), { hint: 'F2' }));
      }
      items.push(mi('copy', t('app.files.action-copy-path'), () => copyPathText(pane, single)));
      if (single) {
        items.push(mi('info', t('app.files.action-properties'), () => showProps(pane, single)));
      }
      items.push(
        sep(),
        mi('trash', t('app.files.action-delete'), () => doDelete(files), { danger: true, hint: 'Del' })
      );
    } else {
      items.push(
        mi('reload', t('app.files.action-reload'), () => reload(pane), { hint: 'F5' }),
        sep(),
        mi('folder-plus', t('app.files.action-new-dir'), doNewFolder),
        mi('file-plus', t('app.files.action-new-file'), doNewFile),
        mi('upload', t('app.files.action-upload'), pickUpload),
        sep(),
        mi(
          'terminal-prompt',
          t('app.files.action-open-terminal'),
          () => openTerminalHere(pane),
          { hint: 'F4' }
        ),
        mi(
          'check-square',
          t('app.files.action-select-all'),
          () => doSelectAll(pane),
          { hint: `${modLabel()}+A` }
        ),
        sep(),
        elevated.value
          ? mi('shield', t('app.files.action-exit-root'), () => disableElevated())
          : mi('shield', t('app.files.action-open-root'), () => enableElevated())
      );
    }

    menu(items, { x: e.clientX, y: e.clientY });
  }

  function copyPathText(pane, single) {
    const list = single ? [single] : selectedFiles(pane);
    const text = list.map((f) => joinPath(pane.path, f.name)).join('\n');
    copyToClipboard(text).then((ok) => {
      if (ok) toast(t('app.files.path-copied'), 'success');
      else toast(t('app.files.path-copy-failed') + text, 'warning');
    });
  }

  function onBlankContext(e, pane) {
    if (e.target.closest('.fm-row, .fm-card, .fm-head')) return;
    e.preventDefault();
    if (pane.sel.size) { pane.sel.clear(); repaint(pane); }
    openCtxMenu(e, pane);
  }

  function startRubberBand(e, pane) {
    const box = pane.listEl;
    if (!box || e.button !== 0) return;
    if (e.target.closest('.fm-row, .fm-card, .fm-empty, .fm-head')) return;
    const base = box.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const band = dom('div', { class: 'fm-rubber' });
    box.append(band);
    const onMove = (ev) => {
      moved = moved || Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4;
      if (!moved) return;
      Object.assign(band.style, {
        left: `${Math.min(sx, ev.clientX) - base.left + box.scrollLeft}px`,
        top: `${Math.min(sy, ev.clientY) - base.top + box.scrollTop}px`,
        width: `${Math.abs(ev.clientX - sx)}px`,
        height: `${Math.abs(ev.clientY - sy)}px`,
      });
      const R = {
        l: Math.min(sx, ev.clientX), t: Math.min(sy, ev.clientY),
        r: Math.max(sx, ev.clientX), b: Math.max(sy, ev.clientY),
      };
      if (!ev.ctrlKey && !ev.metaKey) pane.sel.clear();
      for (const [name, node] of pane.rowEls) {
        const r = node.getBoundingClientRect();
        if (r.left < R.r && r.right > R.l && r.top < R.b && r.bottom > R.t) pane.sel.add(name);
      }
      repaint(pane);
    };
    const onUp = () => {
      band.remove();
      if (!moved) { pane.sel.clear(); repaint(pane); }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function PreviewPanel() {
    const on = previewOn.value;
    const pane = A();
    void pane.sig.value;
    const files = selectedFiles(pane);
    return h('div', {
      class: cx('fm-preview', !on && 'hidden'),
      ref: (el) => { previewEl.current = el; },
    }, on ? [
      h('div', { key: 'bar', class: 'fm-pv-bar' }, [
        h('span', { class: 'fm-pv-bar-title', text: t('app.files.action-preview') }),
        h('span', { class: 'qx-grow' }),
        h('button', {
          class: 'qx-ibtn qx-ibtn-sm',
          html: icon('close', 'qicon-sm'),
          dataset: { tip: t('app.files.action-close-preview') },
          onClick: () => { previewOn.next = false; },
        }),
      ]),
      h('div', { key: 'body', class: 'fm-pv-body' }, previewContent(pane, files)),
    ] : []);
  }

  function previewContent(pane, files) {
    if (files.length !== 1) {
      return [h('div', {
        class: 'fm-pv-empty',
        text: files.length ? tf('app.files.count-selected', { v1: (files.length) }) : t('app.files.preview-hint'),
      })];
    }
    const f = files[0];
    const full = joinPath(pane.path, f.name);
    const kind = kindOf(f);
    const textLike = !f.isDir && kind !== 'image' && !/\.pdf$/i.test(f.name) && isTextFile(f.name);
    const out = [h('div', { class: 'fm-pv-head' }, [
      h('span', { class: 'fm-pv-name', text: f.name }),
      textLike ? h('button', {
        class: 'btn btn-ghost btn-sm fm-pv-edit',
        text: t('app.files.action-edit'),
        onClick: () => openEditor(pane, f),
      }) : null,
    ])];
    if (kind === 'image') {
      out.push(h('img', { class: 'fm-pv-img', src: SF.previewUrl(hostId, full), alt: f.name }));
    } else if (/\.pdf$/i.test(f.name)) {
      out.push(h('iframe', { class: 'fm-pv-frame', src: SF.previewUrl(hostId, full) }));
    } else if (textLike) {
      out.push(h(TextPreview, { key: full, url: SF.previewUrl(hostId, full), lang: languageForFile(f.name) }));
    } else {
      out.push(h('div', { class: 'fm-pv-empty', text: t('app.files.preview-unsupported') }));
    }
    out.push(h('div', {
      class: 'fm-pv-meta mono',
      text: tf('app.files.preview-meta', { v1: f.isDir ? t('app.files.kind-dir') : fmtSize(f.size), v2: fmtTime(f.modTime) }),
    }));
    return out;
  }

  function TextPreview(props) {
    const text = useState(null);
    const ctl = useState(null);
    return h('div', {
      class: 'fm-pv-textwrap',
      onMount: () => {
        const ac = new AbortController();
        ctl.next = ac;
        fetch(props.url, { signal: ac.signal })
          .then((r) => r.text())
          .then((t) => { text.next = t.slice(0, 20000); })
          .catch(() => { text.next = t('app.files.preview-unreadable'); });
      },
      onUnmount: () => { if (ctl.value) ctl.value.abort(); },
    }, [
      text.value == null
        ? h('pre', { class: 'fm-pv-text', text: t('app.files.status-reading') })
        : highlightCode(text.value, props.lang || 'text', { cls: 'fm-pv-code', lineNumbers: true }),
    ]);
  }

  const EDIT_MAX_BYTES = 1 << 20;

  async function openEditor(pane, f) {
    const full = joinPath(pane.path, f.name);
    if (f.size > EDIT_MAX_BYTES) {
      toast(tf('app.files.edit-too-large', { v1: fmtSize(EDIT_MAX_BYTES) }), 'warning');
      return;
    }
    let content;
    try {
      const res = await fetch(SF.previewUrl(hostId, full));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (e) {
      toast(tf('app.files.edit-load-failed', { v1: e.message || String(e) }), 'error');
      return;
    }
    const taRef = { current: null };
    const saving = signal(false);
    const dlg = { close: () => {} };

    async function save() {
      if (saving.value) return;
      const el = taRef.current;
      if (!el) return;
      saving.next = true;
      try {
        await SF.upload(hostId, pane.path, new File([el.value], f.name, { type: 'text/plain' }));
        toast(tf('app.files.edit-saved', { v1: f.name }), 'success');
        dlg.close();
        reload(pane);
      } catch (e) {
        toast(tf('app.files.edit-save-failed', { v1: e.message || String(e) }), 'error');
      } finally {
        saving.next = false;
      }
    }

    function SaveBtn() {
      return h('button', {
        class: 'btn btn-primary btn-sm',
        text: saving.value ? t('app.files.status-saving') : t('app.files.action-save'),
        disabled: saving.value,
        onClick: save,
      });
    }

    const d = dialog({
      title: full,
      cls: 'fm-edit-dialog',
      width: '860px',
      body: [h(CodeEditor, {
        inputRef: taRef,
        cls: 'fm-edit-code',
        lang: languageForFile(f.name),
        rows: 22,
        maxRows: 40,
        value: content,
        onSubmit: save,
      })],
      actions: [
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.files.action-cancel'), onClick: () => d.close() }),
        h(SaveBtn),
      ],
    });
    dlg.close = () => d.close();
    setTimeout(() => taRef.current?.focus(), 0);
  }

  function StatusBarView() {
    const pane = A();
    void pane.sig.value;
    const admin = elevated.value;
    const sel = selectedFiles(pane);
    const total = sel.reduce((s, f) => s + (f.isDir ? 0 : f.size), 0);
    const info = [tf('app.files.count-total', { v1: (sortedVisible(pane).length) })];
    if (sel.length) info.push(tf('app.files.count-selected-size', { v1: (sel.length), v2: (total ? ' · ' + fmtSize(total) : '') }));
    return statusBar([
      admin
        ? h('span', {
            class: 'fm-admin',
            text: t('app.files.admin-badge'),
            dataset: { tip: t('app.files.admin-hint') },
          })
        : null,
      h('span', { class: 'fm-status-path mono', text: pane.path }),
      h('span', { class: 'qx-grow' }),
      h('span', { class: 'fm-status-info', text: info.join(' · ') }),
    ]);
  }

  function showProps(pane, f) {
    const path = joinPath(pane.path, f.name);
    const tick = signal(0);
    const refs = { owner: null, group: null, selinux: null, rec: null, sudo: null };
    const st = {
      tick, refs, pane, file: f,
      stat: null, err: '', perm: 0, base: null, dirty: false,
    };

    function applyStat(s) {
      const wo = s.owner || (s.uid ? String(s.uid) : '');
      const wg = s.group || (s.gid ? String(s.gid) : '');
      st.base = {
        perm: /^[0-7]{3,4}$/.test(s.permOct || '')
          ? parseInt(s.permOct, 8)
          : modeFromString(s.mode || f.mode),
        owner: wo, group: wg, selinux: s.selinux || '',
      };
      st.perm = st.base.perm;
    }

    function loadProps() {
      st.stat = null;
      st.err = '';
      st.tick.next = st.tick.value + 1;
      SF.stat(hostId, path).then((s) => {
        applyStat(s);
        st.dirty = false;
        st.stat = s;
        st.tick.next = st.tick.value + 1;
      }).catch((e) => {
        st.err = (e && e.message) || String(e);
        st.tick.next = st.tick.value + 1;
      });
    }

    function payloadOf() {
      const p = { host: hostId, path };
      if (st.perm !== st.base.perm) p.mode = octalOf(st.perm);
      const ow = (refs.owner ? refs.owner.value : '').trim();
      const gr = (refs.group ? refs.group.value : '').trim();
      const sx = (refs.selinux ? refs.selinux.value : '').trim();
      if (ow && ow !== st.base.owner) p.owner = ow;
      if (gr && gr !== st.base.group) p.group = gr;
      if (st.stat.selinux && sx && sx !== st.base.selinux) p.selinux = sx;
      if (refs.rec && refs.rec.checked) p.recursive = true;
      if (elevated.value) p.elevated = true;
      else if (refs.sudo && refs.sudo.checked) p.sudo = true;
      return p;
    }

    const changed = () => ['mode', 'owner', 'group', 'selinux']
      .filter((k) => payloadOf()[k] !== undefined);

    function mark() {
      st.dirty = changed().length > 0;
      st.tick.next = st.tick.value + 1;
    }

    async function save() {
      if (!changed().length) { toast(t('app.files.props-no-change'), 'info'); return; }
      const payload = payloadOf();
      if (payload.sudo && !(await ensureSudoCred())) return;
      st.dirty = false;
      st.tick.next = st.tick.value + 1;
      try {
        const r = await sftpSetAttrs(payload);
        const bad = (r.results || []).filter((x) => !x.ok);
        if (bad.length) bad.forEach((b) => toast(tf('app.files.props-op-failed', { v1: (b.op), v2: (b.error) }), 'error'));
        else toast(tf('app.files.props-updated', { v1: payload.recursive ? t('app.files.props-recursive') : '' }), 'success');
        await reload(st.pane);
        loadProps();
      } catch (e) {
        toast(t('app.files.props-save-failed') + e.message, 'error');
        st.dirty = true;
        st.tick.next = st.tick.value + 1;
      }
    }

    const kv = (k, node, span) => h('div', {
      class: 'fm-kv',
      style: span ? { gridColumn: '1 / -1' } : {},
    }, [h('span', { class: 'fm-k', text: k }), node]);
    const roVal = (v) => h('span', {
      class: 'fm-v mono', text: String(v), dataset: { tip: String(v) },
    });

    const cell = (bit) => h('input', {
      type: 'checkbox',
      checked: !!(st.perm & bit),
      onChange: (e) => {
        st.perm = e.target.checked ? (st.perm | bit) : (st.perm & ~bit);
        mark();
      },
    });

    function permEditor() {
      const matrix = h('table', { class: 'fm-ptable' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: '' }),
          ...PERM_COLS.map((c) => h('th', { key: c.key, text: t(c.labelKey) })),
        ])]),
        h('tbody', {}, PERM_ROWS.map((r) => h('tr', { key: r.key }, [
          h('th', { class: 'fm-ptable-row', text: t(r.labelKey) }),
          ...PERM_COLS.map((c) => h('td', { key: c.key }, [cell(r.bit[c.key])])),
        ]))),
      ]);
      return [
        h('div', { class: 'fm-pedit' }, [
          matrix,
          h('div', { class: 'fm-pedit-side' }, [
            kv(t('app.files.props-octal'), h('input', {
              class: 'input mono fm-perm-oct', type: 'text', spellcheck: 'false', maxlength: '4',
              value: octalOf(st.perm),
              onInput: (e) => {
                const v = e.target.value.trim();
                if (!/^[0-7]{3,4}$/.test(v)) return;
                st.perm = parseInt(v, 8);
                mark();
              },
            })),
            kv(t('app.files.props-symbolic'), h('span', { class: 'fm-v mono', text: symbolicOf(f, st.perm) })),
          ]),
        ]),
        h('div', { class: 'fm-pspecial' }, PERM_SPECIAL.map((s) => h('label', {
          key: s.label, class: 'fm-pcheck',
        }, [cell(s.bit), h('span', { text: s.label })]))),
        h('div', { class: 'fm-pedit-grid' }, [
          kv(t('app.files.props-owner'), h('input', {
            class: 'input', type: 'text', spellcheck: 'false',
            value: st.base.owner, placeholder: t('app.files.props-owner-hint'),
            ref: (el) => { refs.owner = el; },
            onInput: mark,
          })),
          kv(t('app.files.perm-group'), h('input', {
            class: 'input', type: 'text', spellcheck: 'false',
            value: st.base.group, placeholder: t('app.files.props-group-hint'),
            ref: (el) => { refs.group = el; },
            onInput: mark,
          })),
          kv('SELinux', h('input', {
            class: 'input mono', type: 'text', spellcheck: 'false',
            value: st.base.selinux,
            placeholder: st.stat.selinux ? '' : t('app.files.selinux-disabled'),
            disabled: !st.stat.selinux,
            ref: (el) => { refs.selinux = el; },
            onInput: mark,
          }), true),
        ]),
        h('div', { class: 'fm-pedit-opts' }, [
          h('label', { class: 'fm-pcheck' }, [
            h('input', {
              type: 'checkbox', ref: (el) => { refs.rec = el; },
            }),
            h('span', { text: t('app.files.props-recursive-label') }),
          ]),
          elevated.value
            ? h('div', {
                class: 'fm-props-note',
                text: t('app.files.props-root-note'),
              })
            : h('label', { class: 'fm-pcheck' }, [
              h('input', {
                type: 'checkbox', ref: (el) => { refs.sudo = el; },
              }),
              h('span', { text: t('app.files.props-sudo-note') }),
            ]),
        ]),
        st.stat.symlink
          ? h('div', {
              class: 'fm-props-note',
              text: tf('app.files.props-symlink-note', { v1: (st.stat.linkTo || '?') }),
            })
          : null,
        st.stat.note ? h('div', { class: 'fm-props-note', text: st.stat.note }) : null,
      ].filter(Boolean);
    }

    function PropsBody() {
      void tick.value;
      void elevated.value;
      const s = st.stat;
      return h('div', { class: 'fm-props' }, [
        h('div', { class: 'fm-props-sec' }, [
          h('div', { class: 'fm-props-title', text: t('app.files.props-general') }),
          kv(t('app.files.col-name'), roVal(f.name)),
          kv(t('app.files.side-places'), roVal(st.pane.path)),
          kv(t('app.files.col-type'), roVal(f.isDir ? t('app.files.kind-dir') : tf('app.files.kind-file', { v1: (kindOf(f)) }))),
          kv(t('app.files.col-size'), roVal(f.isDir ? '—' : tf('app.files.props-size', { v1: (fmtSize(f.size)), v2: (f.size) }))),
          kv(t('app.files.col-modified'), roVal(fmtTime(f.modTime))),
        ]),
        h('div', { class: 'fm-props-sec' }, [
          h('div', { class: 'fm-props-title', text: t('app.files.props-perm-owner') }),
          st.err
            ? h('div', { class: 'fm-props-note', text: tf('app.files.props-read-failed', { v1: (st.err) }) })
            : (s ? permEditor() : h('div', { class: 'fm-props-note', text: t('app.files.status-reading') })),
        ]),
      ]);
    }

    function PropsActions() {
      void tick.value;
      return h(Fragment, {}, [
        h('span', { class: 'qx-grow' }),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          text: t('app.files.action-close'),
          onClick: () => closer.close(),
        }),
        h('button', {
          class: 'btn btn-primary btn-sm',
          text: t('app.files.action-save'),
          disabled: !st.dirty,
          onClick: save,
        }),
      ]);
    }

    const closer = {};
    const dlg = dialog({
      title: t('app.files.action-properties'),
      body: [h(PropsBody)],
      actions: h(PropsActions),
    });
    closer.close = () => dlg.close();

    loadProps();
  }

  function focusFilter() {
    const el = A().filterEl;
    if (el) { el.focus(); el.select(); }
  }

  function onKey(e) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    const pane = A();

    if (isMod(e) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { if (!typing) { e.preventDefault(); doUndo(); } return; }
      if (k === 'l') { e.preventDefault(); startEdit(pane); return; }
      if (k === 'f') { e.preventDefault(); focusFilter(); return; }
      if (k === 'h') { e.preventDefault(); setHidden(!showHidden.value); return; }
      if (k === 'a' && !typing) {
        e.preventDefault();
        doSelectAll(pane);
        return;
      }
      return;
    }
    if (typing) return;

    const single = () => { const a = selectedFiles(pane); return a.length === 1 ? a[0] : null; };
    switch (e.key) {
      case 'F4': e.preventDefault(); openTerminalHere(pane); break;
      case 'F5': e.preventDefault(); reload(pane); break;
      case 'F2': { const f = single(); if (f) { e.preventDefault(); doRename(f); } break; }
      case 'Delete': { const a = selectedFiles(pane); if (a.length) { e.preventDefault(); doDelete(a); } break; }
      case 'Enter': { const f = single(); if (f) { e.preventDefault(); openItem(pane, f); } break; }
      case 'Backspace': { const u = parentPath(pane.path); if (u) { e.preventDefault(); navigate(u, { pane }); } break; }
      case 'ArrowDown': e.preventDefault(); moveActive(pane, 1); break;
      case 'ArrowUp': e.preventDefault(); moveActive(pane, -1); break;
      case 'Home': e.preventDefault(); moveActive(pane, -99999); break;
      case 'End': e.preventDefault(); moveActive(pane, 99999); break;
      case 'ArrowRight': { const f = single(); if (f && f.isDir) { e.preventDefault(); openItem(pane, f); } break; }
      case 'ArrowLeft': { const u = parentPath(pane.path); if (u) { e.preventDefault(); navigate(u, { pane }); } break; }
      case 'Escape': pane.sel.clear(); repaint(pane); break;
      default:
        if (e.key.length === 1) {
          const f = sortedVisible(pane).find((x) => x.name.toLowerCase().startsWith(e.key.toLowerCase()));
          if (f) {
            selectOnly(pane, f.name);
            repaint(pane);
            const row = pane.rowEls.get(f.name);
            if (row) row.scrollIntoView({ block: 'nearest' });
          }
        }
    }
  }

  setTimeout(() => { if (panes[0].root) panes[0].root.focus(); }, 0);
  loadDevices();
  navigate('~', { pane: panes[0] });

  document.addEventListener('keydown', onKey);

  const dispose = () => {
    finishPick('');
    document.removeEventListener('keydown', onKey);
    sideView.unmount();
    shell.destroy();
    splitter.destroy();
  };

  provideApi('pick', startPick, {
    description: t('app.files.api-pick-desc')
      + t('app.files.api-pick-args')
      + t('app.files.api-pick-needs-window'),
    version: '1',
    needsWindow: true,
  });
  provideApi('stat', (args) => SF.stat(hostId, (args && args.path) || ''), {
    description: t('app.files.api-stat-desc') + t('app.files.api-stat-args'),
    version: '1',
    perm: 'server:read',
  });
  provideApi('list', (args) => SF.list(hostId, (args && args.path) || '~'), {
    description: t('app.files.api-list-desc') + t('app.files.api-list-args'),
    version: '1',
    perm: 'server:read',
  });
  provideApi('whereami', () => ({ hostId, path: A() ? A().path : '', count: panes.length }), {
    description: t('app.files.api-cwd-desc'),
    version: '1',
  });
  provideApi('open', async (args) => {
    const path = String((args && args.path) || '').trim();
    if (!path) throw new Error(t('app.files.api-open-need-path'));
    let st = null;
    try { st = await SF.stat(hostId, path); } catch { }
    const dir = st && st.isDir === false ? (parentPath(path) || path) : path;
    await navigate(dir);
    windowControl('focus');
    return { hostId, path: dir, isDir: st ? st.isDir !== false : null };
  }, {
    description: t('app.files.api-open-desc'),
    version: '1',
    needsWindow: true,
  });

  return dispose;
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'files',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId, params }) => boot(root, {
    hostId,
    cwd: params.cwd || undefined,
    initialTab: params.tab || undefined,
  }));
});
