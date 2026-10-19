/**
 * wm/appframe.js —— 内嵌应用框架与宿主能力实现
 * 要点：用 iframe 承载应用页，处理应用与宿主之间的消息：注册宿主方法、调度跨应用 API、广播事件并管理权限会话。
 */
import { toast } from '../core/ui.js';
import { writeClipboard as copyToClipboard } from '../core/clipboard.js';
import { on as onBus, emit as emitBus } from '../core/bus.js';
import { h, dom, island, useState } from '../core/vdom.js';
import { readCachedPref, setPref, allPrefs, delPref } from '../core/prefs.js';
import * as api from '../core/qxssh-api.js';
import { sysCall } from '../core/sys.js';
import { getApps } from '../apps/registry.js';
import { appName, appCategory, appDesc, appLangCode } from '../apps/apptext.js';
import { appIcon } from '../icons/index.js';
import { applyWallpaper } from '../desktop/wallpaper.js';
import { setGlassAlpha, getGlassAlpha } from '../desktop/glass.js';
import { setTaskbarPos, getTaskbarPos } from '../desktop/taskbar.js';
import { t, tf, lang, setLang } from '../core/i18n.js';
import { pickTerm } from '../core/terms.js';
import { hostHook, callHostHook } from '../core/host-hooks.js';

const FRAME_CLASS = 'qx-app-frame';

const FRAME_ALLOW = /Firefox\//.test(navigator.userAgent)
  ? 'fullscreen'
  : 'clipboard-read; clipboard-write; fullscreen';

// 应用 iframe 的沙箱标志：刻意不含 allow-same-origin（保留不透明源隔离），
// 也不含 allow-popups-to-escape-sandbox（否则应用可开无沙箱弹窗逃逸隔离）。
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

// 应用入口「就绪」的等待上限；超时即判定入口异常，改由宿主侧给出错误面板。
const FRAME_READY_MS = 8000;

const frames = new Set();
const hostCalls = new Map();
const waitingCalls = new Map();

const silentFrames = new Map();

const SILENT_IDLE_MS = 30000;

function makeSilentWin(appId, title) {
  const noop = () => { };
  return {
    id: null,
    appId,
    title: title || appId || 'app',
    state: 'normal',
    el: null,
    manager: null,
    _closed: false,
    focus: noop, close: noop, minimize: noop, maximize: noop,
    restore: noop, toggleMaximize: noop, setTitle: noop,
    setBadge: noop, setAccent: noop, addClass: noop, removeClass: noop, flash: noop,
    overlayEl: null,
    currentRect: () => null,
  };
}

function silentBox() {
  let box = document.getElementById('qx-silent-frames');
  if (!box) {
    box = dom('div', {
      id: 'qx-silent-frames',
      style: {
        position: 'fixed', left: '-20000px', top: '0', width: '1280px', height: '800px',
        border: '0', margin: '0', padding: '0', overflow: 'hidden', visibility: 'hidden',
        pointerEvents: 'none',
      },
    });
    document.body.append(box);
  }
  return box;
}

function post(iframe, msg) {
  try {
    // 应用是不透明源（sandbox 无 allow-same-origin），targetOrigin 只能用 '*'。
    // 安全性由接收端的 e.source === window.parent 校验承担；宿主侧见 onMessage 的 e.source 反查。
    iframe.contentWindow?.postMessage({ __qx: true, ...msg }, '*');
  } catch (err) {
    console.warn('[frame] postMessage 失败', err);
  }
}

/** 重新加载应用帧：不透明源下读不到 contentWindow.location，回退为重置 src */
function reloadFrame(iframe) {
  try {
    if (iframe?.contentWindow?.location?.reload) {
      iframe.contentWindow.location.reload();
      return true;
    }
  } catch { }
  try {
    const src = iframe.getAttribute('src') || iframe.src;
    if (src) {
      iframe.src = src;
      return true;
    }
  } catch { }
  return false;
}

/** 标记应用帧已就绪：取消入口超时探测，并撤掉可能已渲染的错误面板（自愈） */
function markFrameReady(entry) {
  entry.ready = true;
  if (entry.readyTimer) {
    clearTimeout(entry.readyTimer);
    entry.readyTimer = 0;
  }
  if (entry.errEl) {
    entry.errEl.remove();
    entry.errEl = null;
  }
}

function notifyPermChanged(app) {
  const target = app ? String(app) : null;
  for (const f of frames) {
    f.grantP = null;
    if (!target || f.ctx.appId === target) {
      post(f.iframe, { type: 'perm-changed', app: target });
      // 权限变更时为运行中的该应用帧重新签发并下发最新令牌，确保动态授权即刻生效；已吊销无令牌的帧不再重新签发
      if (f.ctx.appId && f.iframe && f.token) {
        mintSession(f.ctx.appId, Array.from(f.sessionScopes || [])).then((tok) => {
          if (tok && f.iframe && f.token) {
            f.token = tok;
            post(f.iframe, { type: 'session', token: tok });
          }
        }).catch(() => { });
      }
    }
  }
}

export function notifySessionRevoked(app) {
  const target = app ? String(app) : null;
  for (const f of frames) {
    if (!target || f.ctx.appId === target) {
      f.token = null;
      f.minted = null;
      if (f.sessionScopes) f.sessionScopes.clear();
      f.grantP = null;
      post(f.iframe, { type: 'session', token: '' });
      post(f.iframe, { type: 'session-revoked', app: target });
    }
  }
}

function currentTheme() {
  const mode = readCachedPref('qx-theme') || 'system';
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let hostVersion = '';
async function loadHostVersion() {
  if (hostVersion) return hostVersion;
  try {
    const d = await api.getInfo();
    hostVersion = String((d && d.version) || '');
  } catch { }
  return hostVersion;
}
loadHostVersion();

function hostInfo(entry) {
  return {
    version: hostVersion,
    theme: currentTheme(),
    platform: navigator.platform || '',
    userAgent: navigator.userAgent || '',
    language: navigator.language || '',
    hostId: entry.ctx.hostId || null,
    appId: entry.ctx.appId || null,
    windowId: entry.win?.id || null,
    viewport: (() => {
      const vp = entry.win?.manager?.viewport?.();
      return vp ? { width: vp.width, height: vp.height } : { width: window.innerWidth, height: window.innerHeight };
    })(),
    dpr: window.devicePixelRatio || 1,
  };
}

async function workspaceInfo() {
  try {
    const d = await api.listHosts();
    const hosts = (d && Array.isArray(d.hosts)) ? d.hosts : [];
    const hostId = callHostHook('workspaceHostId', [], null) || null;
    const host = hosts.find((h) => h.id === hostId) || null;
    return {
      hostId,
      host,
      hosts: hosts.map((h) => ({
        id: h.id, name: h.name, group: h.group || '',
        address: h.address, port: h.port, user: h.user,
        jumpHostId: h.jumpHostId || '',
      })),
    };
  } catch {
    return null;
  }
}

function notifyHost(opts) {
  if (typeof Notification === 'undefined') return false;
  const title = String(opts.title || '');
  if (!title) return false;
  const body = String(opts.body || '');
  try {
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body,
        tag: opts.tag ? String(opts.tag) : undefined,
        silent: opts.silent === true,
      });
      return true;
    }
    if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') {
          try { new Notification(title, { body }); } catch { }
        }
      });
    }
  } catch { }
  return false;
}

function listWindows() {
  const wm = hostHook('wm');
  if (!wm) return [];
  return wm.getWindows().map((w) => ({
    id: w.id, appId: w.appId, title: w.title, state: w.state,
    active: wm.activeWindow === w,
  }));
}

function setWinBadge(entry, text) {
  entry.win?.setBadge?.(text == null ? '' : String(text));
}

function openSettings(tab) {
  const fn = hostHook('openSettingsTab');
  if (typeof fn !== 'function') return false;
  fn(String(tab || ''));
  return true;
}

function workspaceHostId() {
  const id = callHostHook('workspaceHostId', [], null);
  return typeof id === 'string' && id ? id : undefined;
}

async function mintSession(appId, extraScopes = []) {
  if (!appId) return null;
  try {
    const payload = { app: appId, host: workspaceHostId() };
    if (Array.isArray(extraScopes) && extraScopes.length > 0) {
      payload.extraScopes = extraScopes;
    }
    const d = await sysCall('session/mint', payload);
    return d && typeof d.token === 'string' && d.token ? d.token : null;
  } catch {
    return null;
  }
}

function revokeSession(token) {
  if (!token) return;
  sysCall('session/revoke', { token, host: workspaceHostId() }).catch(() => { });
}

let permCatalogCache = null;

function permCatalog() {
  if (!permCatalogCache) permCatalogCache = api.permCatalog().catch(() => null);
  return permCatalogCache;
}

async function normalizeNeed(keys) {
  const catalog = await permCatalog();
  const alias = (catalog && catalog.aliases) || {};
  return [...new Set(keys.map((k) => alias[k] || k))];
}

function appNameOf(entry) {
  const id = entry.ctx.appId;
  const reg = id ? getApps().find((a) => a.id === id) : null;
  return (reg && appName(reg)) || entry.win?.title || id || t('app.frame.app-unknown');
}

function ensureGrants(entry) {
  if (entry.system) return Promise.resolve(null);
  if (!entry.grantP) {
    const appId = entry.ctx.appId;
    entry.grantP = api.permGrants(appId)
      .then((d) => {
        const set = new Set(Object.keys((d && d.grants && d.grants[appId]) || {}));
        if (entry.sessionScopes) {
          for (const s of entry.sessionScopes) set.add(s);
        }
        return set;
      })
      .catch(() => {
        const set = new Set();
        if (entry.sessionScopes) {
          for (const s of entry.sessionScopes) set.add(s);
        }
        return set;
      });
  }
  return entry.grantP;
}

async function requirePermission(entry, need) {
  const raw = (Array.isArray(need) ? need : [need]).map(String).filter(Boolean);
  if (!raw.length || entry.system) return true;
  const keys = await normalizeNeed(raw);
  const granted = await ensureGrants(entry);
  if (granted === null || keys.every((k) => granted.has(k))) return true;
  return askPermission(entry, keys);
}

function PermDialog(props) {
  const busy = useState(false);
  const { onKey, hasHighRisk } = props;
  return h('div', {
    class: 'overlay qx-perm-overlay',
    onClick: (e) => { if (e.target === e.currentTarget) props.onSettle(false); },
    onMount: () => { document.addEventListener('keydown', onKey); },
    onUnmount: () => { document.removeEventListener('keydown', onKey); },
  }, [
    h('div', { class: 'dialog dialog-sm' }, [
      h('div', { class: 'confirm-body' }, [
        h('div', { class: `confirm-ic${hasHighRisk ? '' : ' confirm-ic-info'}` }, [h('span', { html: qiconMark(hasHighRisk ? 'warn' : 'info') })]),
        h('div', { class: 'confirm-content' }, [
          h('div', { class: 'confirm-title', text: tf('app.frame.grant-title', { v1: (props.appName) }) }),
          h('div', {
            class: 'confirm-desc',
            text: t('app.frame.grant-body'),
          }),
          hasHighRisk ? h('div', { class: 'alert alert-error', style: { marginTop: '8px', fontSize: '12px' }, text: t('app.frame.grant-danger-warn') }) : null,
        ].filter(Boolean)),
      ]),
      h('div', { class: 'qx-perm-list' }, props.rows),
      h('div', { class: 'dialog-foot' }, [
        h('button', {
          class: 'btn btn-ghost btn-sm', text: t('app.frame.grant-deny'),
          disabled: busy.value,
          onClick: () => props.onSettle(false),
        }),
        h('button', {
          class: 'btn btn-secondary btn-sm', text: t('app.frame.grant-session'),
          disabled: busy.value,
          onClick: async () => {
            busy.next = true;
            const ok = await props.onAllow('session');
            if (ok) props.onSettle(true);
            else busy.next = false;
          },
        }),
        h('button', {
          class: 'btn btn-primary btn-sm', text: t('app.frame.grant-allow'),
          disabled: busy.value,
          onClick: async () => {
            busy.next = true;
            const ok = await props.onAllow('always');
            if (ok) props.onSettle(true);
            else busy.next = false;
          },
        }),
      ]),
    ]),
  ]);
}

async function askPermission(entry, need) {
  if (entry.system) return true;
  const keys = await normalizeNeed(need.map(String).filter(Boolean));
  if (!keys.length) return true;
  if (entry.permOpen) return entry.permOpen;
  const run = (async () => {
    const catalog = await permCatalog();
    const byId = new Map(((catalog && catalog.perms) || []).map((p) => [p.id, p]));
    const groups = new Map(((catalog && catalog.groups) || []).map((g) => [g.key, g]));
    const appName = appNameOf(entry);

    let hasHighRisk = false;
    const rows = keys.map((id) => {
      const p = byId.get(id);
      const danger = p ? Number(p.danger) || 0 : 0;
      if (danger >= 3) hasHighRisk = true;
      const tone = !p ? '' : danger >= 3 ? ' alert-error' : danger === 2 ? ' alert-warning' : ' alert-success';
      const dangerBadge = danger >= 2 ? h('span', { class: 'qx-perm-tag qx-perm-tag-high', text: danger >= 3 ? t('app.frame.risk-high') : t('app.frame.risk-moderate') })
        : danger === 1 ? h('span', { class: 'qx-perm-tag', text: t('app.frame.risk-caution') }) : null;
      const g = p ? groups.get(p.group) : null;
      return h('div', { key: id, class: 'qx-perm-row alert' + tone }, [
        h('div', { class: 'qx-perm-row-main' }, [
          h('span', { class: 'qx-perm-label', text: p ? pickTerm(p.labelKey, p.label) : id }),
          dangerBadge,
        ]),
        h('div', { class: 'qx-perm-group', text: g ? pickTerm(g.labelKey, g.label) : '' }),
        p && p.desc ? h('div', { class: 'qx-perm-desc', text: pickTerm(p.descKey, p.desc) }) : null,
      ].filter(Boolean));
    });

    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        isl.close();
        resolve(ok);
      };
      const onKey = (e) => {
        if (done) return;
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      };
      const allow = async (mode) => {
        try {
          if (!entry.sessionScopes) entry.sessionScopes = new Set();
          if (mode === 'session') {
            // 真·本次允许：完全不落库，仅保存在当前窗口实例的内存中
            for (const k of keys) entry.sessionScopes.add(k);
            const current = await ensureGrants(entry).catch(() => new Set());
            const merged = new Set(current || []);
            for (const k of keys) merged.add(k);
            entry.grantP = Promise.resolve(merged);
          } else {
            // 始终允许：落盘写入数据库
            await api.permGrant(entry.ctx.appId, keys, 0);
            const current = await ensureGrants(entry).catch(() => new Set());
            const merged = new Set(current || []);
            for (const k of keys) merged.add(k);
            entry.grantP = Promise.resolve(merged);
            notifyPermChanged(entry.ctx.appId);
          }

          // 重新签发带新 scope 的访问令牌（包含持久化 scope + 本窗口 sessionScopes），并推送给应用沙箱
          const newToken = await mintSession(entry.ctx.appId, Array.from(entry.sessionScopes));
          if (newToken && entry.iframe) {
            entry.token = newToken;
            post(entry.iframe, { type: 'session', token: newToken });
          }
          return true;
        } catch (e) {
          toast(t('app.frame.grant-failed') + (e.message || e), 'error');
          return false;
        }
      };
      const isl = island(
        () => h(PermDialog, { appName, rows, onKey, hasHighRisk, onAllow: allow, onSettle: finish }),
        document.body,
      );
      try {
        if (entry.win?.state === 'minimized') entry.win.restore();
        entry.win?.focus?.();
      } catch { }
      isl.el.querySelector('.btn-primary')?.focus();
    });
  })().finally(() => { entry.permOpen = null; });
  entry.permOpen = run;
  return run;
}

function winRect(win) {
  const r = win && typeof win.currentRect === 'function' ? win.currentRect() : null;
  if (!r) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height, state: win.state };
}

function setWinRect(win, rect) {
  if (!win || win._closed || !win.manager || typeof win.setRect !== 'function') return;
  win.setRect(rect);
}

function HostDialogPanel(props) {
  const { onKey, inputRef, btnRef } = props;
  const contentChildren = [
    h('div', { class: 'confirm-title', text: props.title }),
    props.desc ? h('div', { class: 'confirm-desc', text: props.desc }) : null,
  ].filter(Boolean);

  if (props.kind === 'prompt') {
    contentChildren.push(
      h('div', { style: { marginTop: '10px' } }, [
        h('input', {
          ref: (el) => { inputRef.current = el; },
          class: 'input',
          type: 'text',
          value: String(props.value || ''),
          placeholder: String(props.placeholder || ''),
        }),
      ]),
    );
  }

  const body = h('div', { class: 'confirm-body' }, [
    h('div', { class: `confirm-ic${props.danger ? '' : ' confirm-ic-info'}` }, [
      h('span', { html: qiconMark(props.danger ? 'warn' : 'info') }),
    ]),
    h('div', { class: 'confirm-content' }, contentChildren),
  ]);
  return h('div', {
    class: 'overlay',
    onClick: (e) => { if (e.target === e.currentTarget) props.onSettle({ ok: false }); },
    onMount: () => { document.addEventListener('keydown', onKey); },
    onUnmount: () => { document.removeEventListener('keydown', onKey); },
  }, [
    h('div', { class: 'dialog dialog-sm' }, [
      body,
      h('div', { class: 'dialog-foot' }, [
        props.kind === 'alert' ? null : h('button', {
          class: 'btn btn-ghost btn-sm', text: props.cancelText,
          onClick: () => props.onSettle({ ok: false }),
        }),
        h('button', {
          ref: (el) => { btnRef.current = el; },
          class: `btn ${props.danger ? 'btn-danger' : 'btn-primary'} btn-sm`,
          text: props.okText,
          onClick: () => props.onSettle({ ok: true }),
        }),
      ].filter(Boolean)),
    ]),
  ]);
}

function hostDialog(entry, reqId, opts) {
  const kind = opts.kind === 'prompt' ? 'prompt' : (opts.kind === 'confirm' ? 'confirm' : 'alert');
  const inputRef = { current: null };
  const btnRef = { current: null };
  let done = false;

  const finish = (result) => {
    if (done) return;
    done = true;
    isl.close();
    post(entry.iframe, { type: 'host-result', reqId, ok: true, value: result });
  };
  const settle = (result) => {
    if (!result.ok) { finish({ ok: false }); return; }
    if (kind === 'prompt') finish({ ok: true, value: inputRef.current ? inputRef.current.value : '' });
    else finish({ ok: true });
  };
  const onKey = (e) => {
    if (done) return;
    if (e.key === 'Escape') { e.preventDefault(); settle({ ok: false }); }
    else if (e.key === 'Enter') { e.preventDefault(); settle({ ok: true }); }
  };

  const isl = island(() => h(HostDialogPanel, {
    kind,
    title: String(opts.title || ''),
    desc: String(opts.desc || ''),
    okText: String(opts.okText || t('app.frame.action-ok')),
    cancelText: String(opts.cancelText || t('app.frame.action-cancel')),
    danger: opts.danger === true,
    value: opts.value,
    placeholder: opts.placeholder,
    inputRef,
    btnRef,
    onKey,
    onSettle: settle,
  }), document.body);

  (inputRef.current || btnRef.current)?.focus();
}

function qiconMark(kind) {
  if (kind === 'warn') {
    return '<svg class="qicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4.5M12 17h.01"/></svg>';
  }
  return '<svg class="qicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>';
}

async function writeClipboard(text) {
  return copyToClipboard(text);
}

function onMessage(e) {
  const d = e.data;
  if (!d || d.__qx !== true) return;
  // 应用处于不透明源（e.origin === 'null'），不能按 origin 判定；
  // 改为只接纳「消息源必须是我方已挂载的某个应用帧」，这比 origin 更严格。
  const entry = [...frames].find((f) => f.iframe.contentWindow === e.source);
  if (!entry) return;
  switch (d.type) {
    case 'ready':
      markFrameReady(entry);
      sendInit(entry);
      break;
    case 'app-error': {
      const msg = String(d.message || '').trim();
      if (!msg) break;
      if (!entry.ready) showFrameError(msg);
      else toast(tf('app.frame.app-error', { v1: msg }), 'error');
      break;
    }
    case 'title':
      if (d.title) {
        if (entry.win) entry.win._titleCustom = true;
        entry.win?.setTitle(String(d.title));
      }
      break;
    case 'open-app':
      if (d.id) callHostHook('openAppById', [String(d.id), d.opts || {}]);
      break;
    case 'close':
      entry.win?.close();
      break;
    case 'toast':
      if (d.text) toast(String(d.text), d.kind || 'info');
      break;
    case 'apps-changed':
      Promise.resolve(callHostHook('reloadUserApps')).then(reconcileAppFrames, reconcileAppFrames);
      break;
    case 'host-call':
      hostCall(entry, String(d.method || ''), d.reqId, d.params || {});
      break;
    case 'event-publish':
      if (typeof d.topic === 'string' && d.topic) {
        broadcastAppEvent(d.topic, d.payload, entry.ctx.appId, entry);
      }
      break;
    case 'win-focus':
      if (entry.win) {
        if (entry.win.state === 'minimized') entry.win.restore();
        entry.win.focus();
      }
      break;
    case 'win-control':
      if (entry.win) {
        switch (d.action) {
          case 'minimize': entry.win.minimize(); break;
          case 'maximize': entry.win.maximize(); break;
          case 'restore': entry.win.restore(); break;
          case 'toggle-maximize': entry.win.toggleMaximize(); break;
          case 'focus': entry.win.focus(); break;
          case 'close': entry.win.close(); break;
          case 'reload':
            if (entry.sessionScopes) entry.sessionScopes.clear();
            entry.grantP = null;
            reloadFrame(entry.iframe);
            break;
          default: break;
        }
      }
      break;
    case 'win-rect-set':
      if (entry.win && d.rect) setWinRect(entry.win, d.rect);
      break;
    case 'win-badge':
      setWinBadge(entry, d.text == null ? '' : String(d.text));
      break;
    case 'perm-changed':
      notifyPermChanged(d.app || entry.ctx.appId);
      break;
    case 'session-revoked-notify':
      notifySessionRevoked(d.app || entry.ctx.appId);
      break;
    case 'set-lang':
      if (d.lang) setLang(String(d.lang));
      break;
    case 'set-title-color': {
      entry.win?.setAccent?.(d.color ? String(d.color) : '');
      break;
    }
    case 'api-call':
      if (typeof d.reqId === 'string' && d.reqId) {
        routeApiCall(entry, d).catch((err) => {
          console.warn('[frame] api-call route failed', err);
          post(entry.iframe, { type: 'api-result', reqId: d.reqId, ok: false, code: 'handler', error: String((err && err.message) || err) });
        });
      }
      break;
    case 'api-provide':
      if (d.name) {
        entry.apis.set(String(d.name), {
          description: String(d.description || ''),
          version: String(d.version || ''),
          needsWindow: d.needsWindow === true,
          perm: String(d.perm || ''),
        });
        flushWaitingCalls(entry);
        armSilentIdle(entry);
        broadcastAppApis(entry.ctx.appId);
      }
      break;
    case 'api-revoke':
      if (d.name) {
        entry.apis.delete(String(d.name));
        broadcastAppApis(entry.ctx.appId);
      }
      break;
    case 'api-return': {
      const reqId = String(d.reqId || '');
      const call = hostCalls.get(reqId);
      if (!call) break;
      hostCalls.delete(reqId);
      clearTimeout(call.timer);
      post(call.from.iframe, {
        type: 'api-result',
        reqId,
        ok: d.ok !== false,
        value: d.value,
        code: d.code,
        error: d.error,
      });
      if (call.to && call.to.closeAfterApi && call.to.win) {
        const win = call.to.win;
        call.to.closeAfterApi = false;
        try { win.close(); } catch { }
      }
      retireSilentCall(call.to);
      break;
    }
    case 'api-progress': {
      const reqId = String(d.reqId || '');
      const call = hostCalls.get(reqId);
      if (!call || call.to !== entry) break;
      post(call.from.iframe, { type: 'api-progress', reqId, value: d.value });
      break;
    }
    case 'api-cancel': {
      const reqId = String(d.reqId || '');
      const call = hostCalls.get(reqId);
      if (call && call.from === entry) {
        hostCalls.delete(reqId);
        clearTimeout(call.timer);
        post(call.to.iframe, { type: 'api-cancel', reqId });
        if (call.to.closeAfterApi && call.to.win) {
          call.to.closeAfterApi = false;
          try { call.to.win.close(); } catch { }
        }
        retireSilentCall(call.to);
        break;
      }
      const waiting = waitingCalls.get(reqId);
      if (waiting && waiting.from === entry) waitingCalls.delete(reqId);
      break;
    }
    case 'api-list-request': {
      const reqId = typeof d.reqId === 'string' ? d.reqId : '';
      if (!reqId) break;
      const appId = String(d.appId || '');
      const winId = String(d.windowId || '');
      if (appId && !appAvailable(appId)) {
        post(entry.iframe, { type: 'api-list-result', reqId, code: 'not_open', error: tf('app.frame.target-unavailable', { v1: appId }) });
        break;
      }
      const target = winId
        ? findFrame(winId)
        : [...frames].find((f) => f !== entry && f.ctx.appId === appId && !f.silent)
          || [...frames].find((f) => f !== entry && f.ctx.appId === appId) || null;
      if (target && target.ctx.appId !== appId) {
        post(entry.iframe, { type: 'api-list-result', reqId, code: 'no_window', error: tf('app.frame.win-not-app', { v1: (appId || '?') }) });
        break;
      }
      const apis = winId && target ? apiCatalogOf([target]) : apiCatalog(appId);
      if (!target && !apis.length) {
        post(entry.iframe, { type: 'api-list-result', reqId, code: 'not_open', error: tf('app.frame.target-not-open', { v1: (appId || '?') }) });
        break;
      }
      post(entry.iframe, { type: 'api-list-result', reqId, apis });
      break;
    }
    case 'set-theme': {
      const mode = d.mode === 'dark' || d.mode === 'light' ? d.mode : 'system';
      setPref('qx-theme', mode);
      const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
      emitBus('theme-changed');
      for (const f of frames) post(f.iframe, { type: 'theme', theme: dark ? 'dark' : 'light', themeMode: mode });
      break;
    }
    case 'set-pref':
      if (d.key) {
        const k = String(d.key);
        const v = d.value === '' || d.value === null || d.value === undefined ? '' : String(d.value);
        if (!v) {
          delPref(k);
        } else {
          setPref(k, v);
        }
        if (k === 'qx-taskbar-pos' && v) {
          setTaskbarPos(v);
        } else if (k === 'qx-glass-a' && v) {
          setGlassAlpha(v);
        }
      }
      break;
    case 'apply-wallpaper':
      applyWallpaper().catch((err) => console.warn('[frame] apply wallpaper', err));
      break;
    case 'set-glass':
      setGlassAlpha(d.alpha);
      for (const f of frames) post(f.iframe, { type: 'glass' });
      break;
    case 'apply-taskbar':
      if (d.pos) setTaskbarPos(d.pos);
      break;
    case 'win-class':
      if (entry.win) {
        entry.win.addClass?.(...(Array.isArray(d.add) ? d.add.map(String) : []));
        entry.win.removeClass?.(...(Array.isArray(d.remove) ? d.remove.map(String) : []));
      }
      break;
    case 'win-flash':
      entry.win?.flash?.();
      break;
    default:
      break;
  }
}

window.addEventListener('message', onMessage);

window.addEventListener('blur', () => {
  setTimeout(() => {
    const el = document.activeElement;
    if (el && el.tagName === 'IFRAME') {
      for (const entry of frames) {
        if (entry.iframe === el && entry.win) {
          entry.win.focus?.();
          break;
        }
      }
    }
  }, 0);
});

onBus('theme-changed', () => {
  const mode = readCachedPref('qx-theme') || 'system';
  for (const f of frames) post(f.iframe, { type: 'theme', theme: currentTheme(), themeMode: mode });
});

onBus('i18n:changed', (code) => {
  for (const f of frames) {
    const app = f.ctx?.appId ? getApps().find((a) => a.id === f.ctx.appId) : null;
    const l = app ? appLangCode(app) : code;
    post(f.iframe, { type: 'lang', lang: l });
  }
});

function sendInit(entry) {
  const app = entry.ctx?.appId ? getApps().find((a) => a.id === entry.ctx.appId) : null;
  const bootLang = app ? appLangCode(app) : lang();
  const currentPrefs = allPrefs();
  return Promise.resolve(entry.minted).then((session) => {
    if (!frames.has(entry)) return;
    post(entry.iframe, {
      type: 'init',
      ctx: {
        hostId: entry.ctx.hostId,
        windowId: entry.win?.id,
        windowState: entry.win?.id ? entry.win.state : null,
        appId: entry.ctx.appId,
        title: entry.win?.title,
        theme: currentTheme(),
        themeMode: readCachedPref('qx-theme') || 'system',
        taskbarPos: getTaskbarPos(),
        lang: bootLang,
        glass: getGlassAlpha(),
        prefs: currentPrefs,
        session: session || null,
      },
    });
  });
}

const hostMethods = new Map();

const HANDLED = Symbol('host-method-handled');

/** 注册一个宿主方法，供应用通过 host-call 调用 */
export function registerHostMethod(method, handler) {
  if (!method || typeof handler !== 'function') throw new Error('registerHostMethod: method and handler are required');
  hostMethods.set(String(method), handler);
}

/** 列出已注册的宿主方法名 */
export function listHostMethods() {
  return [...hostMethods.keys()];
}

registerHostMethod('host.info', (_p, { entry }) => hostInfo(entry));
registerHostMethod('win.rect.get', (_p, { win }) => (win ? winRect(win) : null));
registerHostMethod('win.list', () => listWindows());
registerHostMethod('apps.list', () => getApps().map((a) => ({
  id: a.id,
  name: appName(a),
  icon: a.icon || a.id,
  iconSvg: appIcon(a.icon || a.id, 'qicon', a.id),
  category: appCategory(a) || t('app.frame.category-other'),
  source: a.source === 'store' ? 'store' : 'builtin',
  systemApp: a.systemApp === true,
  version: a.version || '',
  description: appDesc(a),
})));
registerHostMethod('dialog', (params, { entry, reqId }) => { hostDialog(entry, reqId, params); return HANDLED; });
registerHostMethod('clipboard.write', async (params) => {
  const ok = await writeClipboard(String(params.text ?? ''));
  return { ok, value: ok };
});
registerHostMethod('workspace.info', () => workspaceInfo());
registerHostMethod('notify', async (params, { requirePermission: need }) => {
  const ok = (await need('ui:notify')) ? notifyHost(params) : false;
  return { ok, value: ok };
});
registerHostMethod('settings.open', async (params, { requirePermission: need }) => {
  const ok = (await need('ui:settings')) ? openSettings(params.tab) : false;
  return { ok, value: ok };
});
export function reloadAppFrames(id) {
  const appId = String(id || '');
  let n = 0;
  for (const f of frames) {
    if (appId && f.ctx.appId !== appId) continue;
    if (f.sessionScopes) f.sessionScopes.clear();
    f.grantP = null;
    if (reloadFrame(f.iframe)) n += 1;
  }
  return n;
}

registerHostMethod('apps.reload', (params) => {
  const n = reloadAppFrames(params.id);
  return { ok: n > 0, value: n };
});
registerHostMethod('open-external', (params) => {
  const url = String(params.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, value: false };
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
    return { ok: true, value: true };
  } catch {
    return { ok: false, value: false };
  }
});
registerHostMethod('perm.request', async (params, { entry }) => {
  const list = Array.isArray(params.need) ? params.need.map(String).filter(Boolean) : [];
  const granted = await askPermission(entry, list);
  return { ok: granted, value: granted };
});

function hostCall(entry, method, reqId, params) {
  if (!reqId) return;
  const handler = hostMethods.get(method);
  if (!handler) {
    post(entry.iframe, { type: 'host-result', reqId, ok: false, code: 'unknown_method', error: `unknown host method: ${method}` });
    return;
  }
  const ctx = {
    entry,
    appId: entry.ctx.appId,
    win: entry.win,
    reqId,
    requirePermission: (need) => requirePermission(entry, need),
  };
  Promise.resolve()
    .then(() => handler(params || {}, ctx))
    .then((r) => {
      if (r === HANDLED) return;
      if (r && typeof r === 'object' && typeof r.ok === 'boolean' && 'value' in r) {
        post(entry.iframe, { type: 'host-result', reqId, ok: r.ok, value: r.value });
      } else {
        post(entry.iframe, { type: 'host-result', reqId, ok: true, value: r });
      }
    })
    .catch((err) => {
      console.warn('[frame] host method failed', method, err);
      post(entry.iframe, {
        type: 'host-result', reqId, ok: false,
        code: (err && err.code) || 'handler', error: (err && err.message) || String(err),
      });
    });
}

function findApiTarget(fromEntry, appId, api) {
  const hits = [...frames].filter((f) => f !== fromEntry && f.ctx.appId === appId && f.apis.has(api));
  return hits.find((f) => !f.silent) || hits[0] || null;
}

function declaredApis(appId) {
  const app = getApps().find((a) => a.id === appId);
  return app && Array.isArray(app.apis) ? app.apis.filter((d) => d && d.name) : [];
}

/** 应用当前是否可用：已注册即未卸载、未禁用 */
function appAvailable(appId) {
  return !!appId && getApps().some((a) => a.id === appId);
}

/** 关闭已不可用应用（被禁用或卸载）的窗口与后台帧，使其行为等同卸载 */
function reconcileAppFrames() {
  const apps = getApps();
  // 注册表为空说明应用列表尚未加载或加载失败，此时不做任何关闭，避免误伤
  if (!apps.length) return;
  const available = new Set(apps.map((a) => a.id));
  const closed = new Map();
  for (const f of [...frames]) {
    if (available.has(f.ctx.appId)) continue;
    if (!f.silent) closed.set(f.ctx.appId, f.appTitle || f.ctx.appId || '');
    try { f.destroy?.(); } catch (err) { console.warn('[frame] 关闭不可用应用窗口失败', err); }
  }
  for (const appId of [...silentFrames.keys()]) {
    if (!available.has(appId)) dropSilentFrame(appId);
  }
  for (const name of closed.values()) toast(tf('app.frame.app-disabled-closed', { v1: name }), 'info');
}

function declaredApi(appId, name) {
  return declaredApis(appId).find((d) => d.name === name) || null;
}

function liveApisOf(list) {
  const out = new Map();
  for (const f of list) {
    for (const [name, meta] of f.apis) {
      const prev = out.get(name);
      if (prev && prev.silent === false) continue;
      out.set(name, { ...(meta || {}), silent: !!f.silent });
    }
  }
  return out;
}

function apiCatalog(appId) {
  const live = liveApisOf([...frames].filter((f) => f.ctx.appId === appId));
  const out = new Map();
  for (const d of declaredApis(appId)) {
    out.set(d.name, {
      name: d.name,
      description: String(d.description || ''),
      version: String(d.version || ''),
      needsWindow: d.needsWindow === true,
      launch: d.launch === 'window' || d.launch === 'background' ? d.launch : '',
      perm: String(d.perm || ''),
      live: false,
    });
  }
  for (const [name, meta] of live) {
    const base = out.get(name) || { name, launch: '', live: false };
    out.set(name, {
      ...base,
      description: meta.description || base.description || '',
      version: meta.version || base.version || '',
      needsWindow: !!meta.needsWindow,
      perm: meta.perm || base.perm || '',
      live: true,
    });
  }
  return [...out.values()];
}

function apiCatalogOf(list) {
  const appId = list[0] ? list[0].ctx.appId : '';
  return [...liveApisOf(list)].map(([name, meta]) => {
    const d = declaredApi(appId, name);
    return {
      name,
      description: meta.description || (d && d.description) || '',
      version: meta.version || (d && d.version) || '',
      needsWindow: !!meta.needsWindow,
      launch: d && (d.launch === 'window' || d.launch === 'background') ? d.launch : '',
      perm: meta.perm || (d && d.perm) || '',
      live: true,
    };
  });
}

function apiPermOf(target, appId, api) {
  const meta = target && target.apis.get(api);
  if (meta && meta.perm) return meta.perm;
  const d = declaredApi(appId, api);
  return d && d.perm ? String(d.perm) : '';
}

async function routeApiCall(entry, d) {
  const reqId = String(d.reqId);
  const appId = String(d.appId || '');
  const api = String(d.api || '');
  const winId = String(d.windowId || '');
  const fail = (code, error) => post(entry.iframe, { type: 'api-result', reqId, ok: false, code, error });
  const decl = declaredApi(appId, api);

  // 已禁用 / 已卸载的应用一律按“不可用”处理，禁止其它应用再调用其 API
  if (!appAvailable(appId)) {
    fail('not_open', tf('app.frame.target-unavailable', { v1: (appId || '?') }));
    return;
  }

  if (decl && decl.perm && !entry.system) {
    const ok = await requirePermission(entry, decl.perm);
    if (!frames.has(entry)) return;
    if (!ok) {
      fail('permission', tf('app.frame.api-perm-denied', { v1: api, v2: decl.perm }));
      return;
    }
  }

  let target = null;
  if (winId) {
    target = findFrame(winId);
    if (!target || target.ctx.appId !== appId) {
      fail('no_window', target ? tf('app.frame.win-not-owned', { v1: (appId || '?') }) : tf('app.frame.win-missing', { v1: winId }));
      return;
    }
    if (!target.apis.has(api)) {
      fail('not_provided', tf('app.frame.api-missing', { v1: api }));
      return;
    }
    if (target.silent && (target.apis.get(api) || {}).needsWindow) {
      fail('needs_window', tf('app.frame.api-needs-window', { v1: api }));
      return;
    }
  } else {
    target = findApiTarget(entry, appId, api);
  }
  if (target) {
    dispatchApiCall(reqId, entry, target, api, d.args, d.timeout);
    return;
  }

  const running = [...frames].some((f) => f !== entry && f.ctx.appId === appId && !f.silent);
  const booting = [...frames].some((f) => f !== entry && f.ctx.appId === appId && f.silent);
  const explicitOpen = d.autoOpen === true;
  const explicitSilent = d.silent === true;
  const launch = decl ? decl.launch : '';
  const wantWindow = explicitOpen || (!explicitSilent && launch === 'window');
  const wantSilent = !wantWindow && (explicitSilent || launch === 'background');
  const keepOpen = typeof d.keepOpen === 'boolean' ? d.keepOpen : (!explicitOpen && launch === 'window');

  if (!running && wantWindow && openApiWindow(appId, api)) {
    waitingCalls.set(reqId, { from: entry, appId, api, args: d.args, timeout: d.timeout, keepOpen });
    return;
  }
  if (!running && wantSilent && (booting || ensureSilentFrame(appId, entry.ctx.hostId))) {
    waitingCalls.set(reqId, { from: entry, appId, api, args: d.args, timeout: d.timeout, keepOpen: true });
    return;
  }
  const known = getApps().some((a) => a.id === appId);
  fail(running ? 'not_provided' : 'not_open',
    running ? tf('app.frame.api-missing', { v1: api })
      : known ? tf('app.frame.target-not-open', { v1: (appId || '?') })
        : tf('app.frame.target-unavailable', { v1: (appId || '?') }));
}

function findFrame(winId) {
  if (!winId) return null;
  return [...frames].find((f) => f.win?.id === winId) || null;
}

function openApiWindow(appId, api) {
  try {
    return callHostHook('openApiWindow', [appId, api], false) === true;
  } catch (err) {
    console.warn('[frame] open api window failed', err);
    return false;
  }
}

function ensureSilentFrame(appId, hostId) {
  const existing = silentFrames.get(appId);
  if (existing && frames.has(existing.entry)) return true;
  const app = getApps().find((a) => a.id === appId);
  if (!app || !app.frame) return false;
  const box = silentBox();
  const mounted = mountAppFrame(
    box,
    { src: String(app.frame), hostId: hostId || '', appId },
    makeSilentWin(appId, appName(app)),
    { silent: true },
  );
  silentFrames.set(appId, { entry: mounted.entry, destroy: mounted.destroy, box, timer: null });
  return true;
}

function dropSilentFrame(appId) {
  const rec = silentFrames.get(appId);
  if (!rec) return;
  silentFrames.delete(appId);
  if (rec.timer) clearTimeout(rec.timer);
  try { rec.destroy(); } catch (err) { console.warn('[frame] 销毁后台窗口失败', err); }
}

function armSilentIdle(entry) {
  if (!entry || !entry.silent) return;
  const rec = silentFrames.get(entry.ctx.appId);
  if (!rec || rec.entry !== entry) return;
  if (rec.timer) clearTimeout(rec.timer);
  if (entry.silentBusy > 0) return;
  rec.timer = setTimeout(() => {
    rec.timer = null;
    if (entry.silentBusy > 0) { armSilentIdle(entry); return; }
    dropSilentFrame(entry.ctx.appId);
  }, SILENT_IDLE_MS);
}

function dispatchApiCall(reqId, from, target, api, args, timeout) {
  const perm = apiPermOf(target, target.ctx.appId, api);
  if (!perm || from.system) {
    deliverApiCall(reqId, from, target, api, args, timeout);
    return;
  }
  requirePermission(from, perm).then((ok) => {
    if (!frames.has(from)) return;
    if (!frames.has(target)) {
      post(from.iframe, { type: 'api-result', reqId, ok: false, code: 'target_closed', error: t('app.frame.target-closed') });
      return;
    }
    if (!ok) {
      post(from.iframe, { type: 'api-result', reqId, ok: false, code: 'permission', error: tf('app.frame.api-perm-denied', { v1: api, v2: perm }) });
      return;
    }
    deliverApiCall(reqId, from, target, api, args, timeout);
  });
}

function deliverApiCall(reqId, from, target, api, args, timeout) {
  const budget = Math.min(Math.max(Number(timeout) || 30000, 1000) + 5000, 660000);
  const call = { from, to: target, timer: null };
  hostCalls.set(reqId, call);
  call.timer = setTimeout(() => {
    if (!hostCalls.delete(reqId)) return;
    post(from.iframe, { type: 'api-result', reqId, ok: false, code: 'timeout', error: tf('app.frame.target-timeout', { v1: budget }) });
    retireSilentCall(target);
  }, budget);
  if (target.silent) {
    target.silentBusy = (target.silentBusy || 0) + 1;
    const rec = silentFrames.get(target.ctx.appId);
    if (rec && rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
  }
  post(target.iframe, {
    type: 'api-invoke',
    reqId,
    api,
    args,
    from: from.ctx.appId,
    windowId: from.win?.id || '',
  });
}

function retireSilentCall(target) {
  if (!target || !target.silent) return;
  target.silentBusy = Math.max(0, (target.silentBusy || 0) - 1);
  armSilentIdle(target);
}

function flushWaitingCalls(target) {
  if (!waitingCalls.size) return;
  for (const [reqId, w] of [...waitingCalls]) {
    if (w.appId !== target.ctx.appId || !target.apis.has(w.api)) continue;
    waitingCalls.delete(reqId);
    if (target.silent && (target.apis.get(w.api) || {}).needsWindow) {
      post(w.from.iframe, {
        type: 'api-result',
        reqId,
        ok: false,
        code: 'needs_window',
        error: tf('app.frame.api-needs-window', { v1: w.api }),
      });
      if (!(target.silentBusy > 0)) dropSilentFrame(target.ctx.appId);
      continue;
    }
    target.closeAfterApi = !target.silent && !w.keepOpen;
    dispatchApiCall(reqId, w.from, target, w.api, w.args, w.timeout);
  }
}

function broadcastAppApis(appId) {
  const apis = apiCatalog(appId);
  for (const f of frames) post(f.iframe, { type: 'app-apis', appId, apis });
}

const EVENT_TOPIC_MAX = 128;

/** 把事件广播给所有应用窗口，并同步到宿主事件总线 */
export function broadcastAppEvent(topic, payload, from = null, except = null) {
  const name = String(topic || '').slice(0, EVENT_TOPIC_MAX);
  if (!name) return;
  const msg = { type: 'app-event', topic: name, payload, from: from ? String(from) : null };
  for (const f of frames) {
    if (f === except) continue;
    post(f.iframe, msg);
  }
  emitBus('app:event', { topic: name, payload, from: msg.from });
}

onBus('wm:changed', () => {
  for (const f of frames) {
    const win = f.win;
    if (!win || !win.id) continue;
    const state = win.state;
    if (f.lastState === state) continue;
    const prev = f.lastState;
    f.lastState = state;
    post(f.iframe, { type: 'win-state', state, prev });
  }
});

/**
 * 把应用页挂进窗口内容区，建立消息通道与权限会话。
 *
 * 给应用入口地址附加 `?theme=`：应用在不透明源下读不到 localStorage，
 * `init` 消息又必然晚于首屏渲染，只能靠 URL 参数让首帧主题不闪。
 */
function frameSrcWithTheme(src, appId) {
  try {
    const u = new URL(src, location.href);
    if (u.origin !== location.origin) return src;
    u.searchParams.set('theme', currentTheme());
    const app = appId ? getApps().find((a) => a.id === appId) : null;
    const l = app ? appLangCode(app) : lang();
    u.searchParams.set('lang', l);
    return u.pathname + u.search + u.hash;
  } catch {
    return src;
  }
}

export function mountAppFrame(bodyEl, frame, win, opts = {}) {
  const appId = win?.appId || frame.appId || null;
  const entrySrc = frameSrcWithTheme(frame.src, appId);
  const iframe = dom('iframe', {
    class: FRAME_CLASS,
    title: win?.title || 'app',
    allow: FRAME_ALLOW,
    sandbox: FRAME_SANDBOX,
    src: entrySrc,
  });
  const entry = {
    iframe,
    win,
    bodyEl,
    src: entrySrc,
    ready: false,
    readyTimer: 0,
    errEl: null,
    ctx: { hostId: frame.hostId, appId },
    apis: new Map(),
    closeAfterApi: false,
    silent: !!(opts && opts.silent),
    silentBusy: 0,
    system: appId ? !!getApps().find((a) => a.id === appId)?.systemApp : false,
    grantP: null,
    permOpen: null,
    lastState: win && win.id ? win.state : undefined,
    appTitle: String((win && win.title) || appId || ''),
    sessionScopes: new Set(),
  };
  entry.minted = mintSession(appId);

  // 应用是不透明源，宿主已读不到它的 DOM；加载失败改由宿主侧判定：
  // 就绪握手超时后再自查入口 URL，把错误渲染成覆盖在 iframe 之上的宿主面板。
  function showFrameError(msg) {
    if (entry.errEl || !bodyEl) return;
    const line = msg ? tf('app.frame.app-load-failed', { v1: msg }) : t('app.frame.app-load-timeout');
    console.warn('[frame] 应用加载失败', msg || '', entry.src);
    const box = dom('div', {
      class: 'qx-frame-error',
      style: { position: 'absolute', inset: '0', background: 'var(--background, #fff)' },
    }, [
      dom('div', { text: line }),
      dom('div', { class: 'qx-frame-error-src', text: entry.src || '' }),
    ]);
    entry.errEl = box;
    bodyEl.append(box);
    toast(line, 'error');
  }

  async function probeFrameEntry() {
    if (!frames.has(entry) || entry.ready || entry.errEl) return;
    let msg = '';
    try {
      const res = await fetch(entry.src, { headers: { Accept: 'application/json' } });
      let detail = '';
      try {
        const j = JSON.parse(await res.text());
        if (j && j.error) detail = String(j.error);
      } catch { }
      if (!detail && !res.ok) detail = `HTTP ${res.status}`;
      msg = detail;
    } catch (err) {
      msg = String((err && err.message) || err);
    }
    if (!frames.has(entry) || entry.ready || entry.errEl) return;
    showFrameError(msg);
  }

  const onLoad = () => {
    if (!frames.has(entry)) return;
    clearTimeout(entry.readyTimer);
    if (!entry.ready) entry.readyTimer = setTimeout(probeFrameEntry, FRAME_READY_MS);
    sendInit(entry);
  };
  iframe.addEventListener('load', onLoad);

  // 不透明源下无法在应用文档内挂监听；改由 iframe 元素自身的 focus 事件
  // （宿主文档事件，不受跨域限制）与应用经桥上报的 win-focus 来置顶窗口。
  iframe.addEventListener('focus', () => win?.focus?.());
  const destroy = () => {
    frames.delete(entry);
    if (entry.readyTimer) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = 0;
    }
    if (entry.errEl) {
      entry.errEl.remove();
      entry.errEl = null;
    }
    for (const [id, call] of hostCalls) {
      if (call.to === entry) {
        hostCalls.delete(id);
        clearTimeout(call.timer);
        post(call.from.iframe, { type: 'api-result', reqId: id, ok: false, code: 'target_closed', error: t('app.frame.target-closed') });
      } else if (call.from === entry) {
        hostCalls.delete(id);
        clearTimeout(call.timer);
      }
    }
    for (const [id, w] of waitingCalls) {
      if (w.from !== entry && w.appId !== entry.ctx.appId) continue;
      waitingCalls.delete(id);
      post(w.from.iframe, { type: 'api-result', reqId: id, ok: false, code: 'target_closed', error: t('app.frame.target-closed-early') });
    }
    broadcastAppApis(entry.ctx.appId);
    if (entry.silent) {
      const rec = silentFrames.get(entry.ctx.appId);
      if (rec && rec.entry === entry) {
        silentFrames.delete(entry.ctx.appId);
        if (rec.timer) clearTimeout(rec.timer);
      }
    }
    if (entry.token && entry.token !== entry.minted) {
      Promise.resolve(entry.token).then(revokeSession).catch(() => { });
    }
    Promise.resolve(entry.minted).then(revokeSession).catch(() => { });
    iframe.removeEventListener('load', onLoad);
    iframe.src = 'about:blank';
    iframe.remove();
  };

  entry.destroy = destroy;
  frames.add(entry);
  bodyEl.append(iframe);

  return { el: iframe, entry, destroy };
}
