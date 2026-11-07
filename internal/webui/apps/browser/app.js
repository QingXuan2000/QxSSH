import { bootApp, callAppApi, getHostInfo, provideApi, windowControl } from '/assets/js/app-bridge.js';

import { h, Fragment } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, copyText as copyToClipboard } from '/assets/js/core/ui.js';
import { getPref, prefSignal, setPref } from '/assets/js/core/prefs.js';
import { localHostInfo, startWebProxy, stopWebProxy, webProxyState } from '/assets/js/core/qxssh-api.js';
import { browserErrorText, launchBrowser, listBrowsers, prepareBrowsers, resetBrowserCache } from './api.js';
import { preconnectHost } from '/assets/js/core/tunnels.js';
import { menu, sidebarSections, sideAction } from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { lang, setupI18n, t, tf } from '/assets/js/core/i18n.js';

function socksErrorText(e) {
  const code = e && e.code;
  if (code === 'not_open') return t('app.browser.tunnel-not-open');
  if (code === 'not_provided') return t('app.browser.tunnel-no-create-api');
  if (code === 'no_window') return t('app.browser.tunnel-no-window');
  if (code === 'needs_window') return t('app.browser.tunnel-needs-window');
  if (code === 'timeout') return t('app.browser.tunnel-timeout');
  if (code === 'invalid_args') return t('app.browser.tunnel-bad-args') + (e.message || e);
  return t('app.browser.tunnel-failed') + ((e && e.message) || String(e));
}

const BROWSER_KEY = 'qx-browser-prog';
const OPTS_KEY = 'qx-browser-opts';
const BIND_CHOICES = ['127.0.0.1', 'localhost', '::1'];
/** 内嵌模式的历史栈上限：超了从头丢，避免长时间浏览把内存顶满 */
const HIST_MAX = 60;
/** iframe 迟迟不触发 load 时的提示阈值（毫秒） */
const FRAME_LOAD_TIMEOUT = 15000;
/** 轮询代理轨迹的间隔：起步 1.2s 跟得紧，连续无变化时按 1.6 倍退避，上限 6s */
const POLL_MIN_MS = 1200;
const POLL_MAX_MS = 6000;
const POLL_BACKOFF = 1.6;
/** iframe 的 sandbox 白名单：保留脚本、同源存储、表单、弹窗、下载，但挡住整页顶掉宿主 */
const FRAME_SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
  'allow-modals', 'allow-downloads', 'allow-popups-to-escape-sandbox',
  'allow-top-navigation-by-user-activation',
].join(' ');
/** iframe 允许使用的浏览器能力 */
const FRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media';

/** 「更多选项」的缺省值：不转发 UDP，回环监听，端口交给系统分配 */
const DEFAULT_OPTS = { udp: false, bind: '127.0.0.1', port: 0 };

/** 归一化读回来的选项，坏值一律回落到缺省，避免旧偏好把界面卡死 */
function tidyOpts(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const port = Number(o.port);
  return {
    udp: !!o.udp,
    bind: BIND_CHOICES.includes(o.bind) ? o.bind : DEFAULT_OPTS.bind,
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_OPTS.port,
  };
}

function copyText(text) {
  copyToClipboard(text).then((ok) => {
    if (ok) toast(t('app.browser.copied') + text, 'success');
    else toast(t('app.browser.copy-failed') + text, 'warning');
  });
}

/**
 * 解析地址栏输入，返回 { host, port, scheme, path, input }。
 * 与旧实现的差别：路径、查询串与 hash 全部保留——内嵌模式打开
 * http://host:8080/app/login 时，反向代理必须被指到 /app/login，而不是根路径。
 */
function parseTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let s = raw;
  let scheme = 'http';
  const m = s.match(/^(https?):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  let auth = s;
  let path = '/';
  const slash = s.indexOf('/');
  if (slash >= 0) {
    auth = s.slice(0, slash);
    path = s.slice(slash);
  } else {
    const q = s.search(/[?#]/);
    if (q >= 0) { auth = s.slice(0, q); path = '/' + s.slice(q); }
  }
  let host = '127.0.0.1';
  let port = scheme === 'https' ? 443 : 80;
  if (auth.includes(':')) {
    const i = auth.lastIndexOf(':');
    host = auth.slice(0, i) || '127.0.0.1';
    port = parseInt(auth.slice(i + 1), 10);
  } else if (/^\d+$/.test(auth)) {
    port = parseInt(auth, 10);
  } else if (auth) {
    host = auth;
  }
  if (!host) host = '127.0.0.1';
  if (!port || port < 1 || port > 65535) return null;
  if (!path.startsWith('/')) path = '/' + path;
  return { host, port, scheme, path, input: raw };
}

function toUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return 'http://127.0.0.1:' + s + '/';
  return 'http://' + s;
}

function stripScheme(s) {
  return String(s || '').replace(/^[a-z0-9]+:\/\//i, '');
}

function hostOf(proxy) {
  const s = stripScheme(proxy).replace(/^socks5/i, '');
  const i = s.lastIndexOf(':');
  return i > 0 ? s.slice(0, i) : s;
}

function portOf(proxy) {
  const s = stripScheme(proxy).replace(/^socks5/i, '');
  const i = s.lastIndexOf(':');
  return i > 0 ? parseInt(s.slice(i + 1), 10) || 0 : 0;
}

/** 把代理回报的 path 与 query 拼回地址栏里能看懂的形式 */
function remotePath(path, query) {
  let s = String(path || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) s = '/' + s;
  const q = String(query || '').trim();
  if (q) s += (s.includes('?') ? '&' : '?') + q;
  return s;
}

function browserLabel(b) {
  const ver = String(b.version || '').split('.').slice(0, 2).join('.');
  const name = ver ? b.name + ' ' + ver : b.name;
  return b.isDefault ? tf('app.browser.default-suffix', { v1: name }) : name;
}

function hostPlatformKind(info) {
  const p = String((info && info.platform) || '').toLowerCase();
  const ua = String((info && info.userAgent) || '').toLowerCase();
  if (p.startsWith('mac') || ua.includes('macintosh') || ua.includes('mac os x')) return 'mac';
  if (p.startsWith('win') || ua.includes('windows')) return 'win';
  if (p.startsWith('linux') || ua.includes('linux')) return 'linux';
  return '';
}

function noBrowserHint(kind) {
  if (kind === 'linux') return t('app.browser.no-browser-linux');
  if (kind === 'mac') return t('app.browser.no-browser-mac');
  if (kind === 'win') return t('app.browser.no-browser-win');
  return t('app.browser.no-browser-found');
}

/** 空闲面板：品牌占位 */
function idlePane() {
  return { kind: 'idle', url: '', blank: false, seq: 0, proxy: '', proxyId: '', err: '' };
}

function boot(el, ctx) {
  const hostId = ctx.hostId;

  // session.proxies：上游目标 -> 代理实例。同一目标只建一次，后退/前进复用同一个端口。
  // session.ids：建立过的全部实例 id，停止或销毁时统一收摊，避免残留本地监听端口。
  // socks* 只属于系统浏览器模式，frame* 只属于内嵌模式；混用会让「复制代理地址」在切模式后拿到错的端口。
  const session = {
    kind: null, id: null,
    socksProxy: '', socksHost: '', socksPort: 0,
    frameProxy: '', frameProxyId: '',
    pageUrl: '', proxies: new Map(), ids: new Set(),
  };

  const mode = signal('socks');
  const addr = signal('');
  const busy = signal(false);
  const status = signal({ dot: '', key: 'app.browser.status-not-started', params: null });
  // 两种模式的代理行分开：切模式时状态栏不会残留另一模式的信息
  const socksLine = signal('');
  const frameLine = signal('');
  const nav = signal({ hist: [], idx: -1 });
  const pane = signal(idlePane());
  const browsers = signal([]);
  const browsersLoading = signal(false);
  const browsersErr = signal('');
  const browserPath = signal('');
  const platform = signal('');
  // 「更多选项」存成一条 JSON 偏好：udp 决定这条动态转发是否支持 SOCKS5 UDP ASSOCIATE，
  // bind/port 决定代理监听在哪，port=0 交给系统分配。
  const optsRaw = prefSignal(OPTS_KEY, DEFAULT_OPTS);
  const opts = {
    get value() { return tidyOpts(optsRaw.value); },
    set next(v) { optsRaw.next = tidyOpts(v); },
  };

  let addrFocused = false;
  let loadTimer = 0;
  let pollTimer = 0;
  let pollBusy = false;
  let pollIdle = 0;

  const setStatus = (dot, key, params = null) => status.next = { dot, key, params };

  // ---- 历史记录与 iframe 显示 ------------------------------------------

  /** 历史条目：{ proxyId, proxyUrl, target, path, input, realUrl, tls } */
  function pushEntry(entry) {
    const cur = nav.value;
    const hist = cur.hist.slice(0, cur.idx + 1);
    hist.push(entry);
    while (hist.length > HIST_MAX) hist.shift();
    nav.next = { hist, idx: hist.length - 1 };
  }

  function currentEntry() {
    const cur = nav.value;
    return cur.idx >= 0 ? cur.hist[cur.idx] || null : null;
  }

  function entryLabel(e) {
    if (!e) return '';
    return e.path && e.path !== '/' ? e.target + e.path : e.target;
  }

  function frameUrlOf(e) {
    return e.proxyUrl + (e.path && e.path !== '/' ? e.path : '/');
  }

  /** 把 iframe 指到某条历史记录；seq 递增，刷新时靠它强制重挂载 */
  function displayEntry(e) {
    const p = pane.value;
    pane.next = {
      kind: 'frame', url: frameUrlOf(e), blank: false,
      seq: (p.seq || 0) + 1, proxy: e.proxyUrl, proxyId: e.proxyId, err: '',
    };
    session.pageUrl = e.realUrl || entryLabel(e);
    if (!addrFocused) addr.next = e.input || entryLabel(e);
    armLoadWatch();
    startPoll();
  }

  function goBack() {
    const cur = nav.value;
    if (mode.value !== 'iframe' || cur.idx <= 0) return;
    const idx = cur.idx - 1;
    nav.next = { hist: cur.hist, idx };
    displayEntry(cur.hist[idx]);
  }

  function goForward() {
    const cur = nav.value;
    if (mode.value !== 'iframe' || cur.idx >= cur.hist.length - 1) return;
    const idx = cur.idx + 1;
    nav.next = { hist: cur.hist, idx };
    displayEntry(cur.hist[idx]);
  }

  function armLoadWatch() {
    clearTimeout(loadTimer);
    setStatus('busy', 'app.browser.frame-loading');
    loadTimer = setTimeout(() => {
      const p = pane.value;
      if (p.kind === 'frame' && !p.blank) setStatus('busy', 'app.browser.frame-slow');
    }, FRAME_LOAD_TIMEOUT);
  }

  function markLoaded() {
    clearTimeout(loadTimer);
    if (pane.value.kind === 'frame') setStatus('on', 'app.browser.connected-embedded');
  }

  function reload() {
    if (mode.value !== 'iframe') { doOpen(); return; }
    const p = pane.value;
    if (p.kind !== 'frame' || p.blank) { toast(t('app.browser.no-page-open'), 'info'); return; }
    setStatus('busy', 'app.browser.reloading');
    // 跨源 iframe 调不到 contentWindow.location.reload()（会抛 SecurityError 或被策略拦下），
    // 把 src 先切 about:blank 再切回真实地址，浏览器才会真正重新发起文档请求。
    const seq = p.seq;
    pane.next = { ...p, blank: true };
    setTimeout(() => {
      const q = pane.value;
      if (q.kind !== 'frame' || q.seq !== seq || !q.blank) return;
      pane.next = { ...q, blank: false, seq: seq + 1 };
      armLoadWatch();
    }, 40);
  }

  // ---- 代理实例的建立与会话收摊 ----------------------------------------

  async function ensureProxy(parsed) {
    const key = parsed.scheme + ':' + parsed.host + ':' + parsed.port;
    const hit = session.proxies.get(key);
    if (hit) return hit;
    const inst = await startWebProxy(hostId, parsed.host + ':' + parsed.port, parsed.scheme === 'https');
    const rec = {
      id: inst.id, url: inst.url,
      target: parsed.host + ':' + parsed.port,
      tls: parsed.scheme === 'https',
    };
    session.proxies.set(key, rec);
    session.ids.add(inst.id);
    return rec;
  }

  async function stopTunnel() {
    if (session.kind !== 'tunnel' || !session.id) return;
    const id = session.id;
    session.kind = null;
    session.id = null;
    session.socksProxy = '';
    session.socksHost = '';
    session.socksPort = 0;
    try {
      await callAppApi('tunnels', 'stop', { id }, { silent: true, timeout: 15000 });
    } catch { }
  }

  async function stopProxies() {
    const ids = Array.from(session.ids);
    session.ids.clear();
    session.proxies.clear();
    session.frameProxy = '';
    session.frameProxyId = '';
    for (const id of ids) {
      try { await stopWebProxy(id); } catch { }
    }
  }

  // ---- 代理轨迹轮询：让地址栏、历史与状态栏跟上 iframe 内的真实导航 ------

  function stopPoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
  }

  /** 轮询间隔随「连续没有变化」的次数退避：刚打开时 1.2s 跟得紧，页面静下来拉到 6s，别平白刷审计日志 */
  function nextPollDelay() {
    if (typeof document !== 'undefined' && document.hidden) return POLL_MAX_MS;
    return Math.min(POLL_MIN_MS * Math.pow(POLL_BACKOFF, pollIdle), POLL_MAX_MS);
  }

  function startPoll() {
    stopPoll();
    pollIdle = 0;
    scheduleTick(POLL_MIN_MS);
  }

  function scheduleTick(ms) {
    stopPoll();
    pollTimer = setTimeout(async () => {
      pollTimer = 0;
      await tickState();
      if (mode.value === 'iframe' && pane.value.kind === 'frame') scheduleTick(nextPollDelay());
    }, ms);
  }

  async function tickState() {
    const p = pane.value;
    const e = currentEntry();
    if (mode.value !== 'iframe' || p.kind !== 'frame' || p.blank || !p.proxyId || !e) return;
    if (pollBusy) return;
    pollBusy = true;
    try {
      const changed = applyProxyState(e, await webProxyState(p.proxyId));
      pollIdle = changed ? 0 : pollIdle + 1;
    } catch { pollIdle += 1; } finally {
      pollBusy = false;
    }
  }

  /** 把代理侧轨迹套到界面上；返回「这一轮有没有变化」，供轮询退避用 */
  function applyProxyState(entry, st) {
    if (!st || typeof st !== 'object') return false;
    const p = pane.value;
    if (p.proxyId !== entry.proxyId || p.blank) return false;
    const before = status.value.key + '|' + JSON.stringify(status.value.params || null);
    const code = Number(st.status) || 0;
    if (st.error) setStatus('off', 'app.browser.frame-gateway-error', { v1: String(st.error).slice(0, 120) });
    else if (code >= 400) {
      // 目标自己回了 4xx/5xx：把上游地址一起带出来，内嵌窗口里看到错误页时能直接判断是谁回的
      setStatus('off', 'app.browser.frame-http-error', {
        v1: String(code), v2: String(st.upstream || entry.target),
      });
    } else if (code > 0) markLoaded();
    let changed = before !== status.value.key + '|' + JSON.stringify(status.value.params || null);
    const path = remotePath(st.path, st.query);
    if (!path || path === entry.path) return changed;
    // 页面在 iframe 内自己跳转了：追加一条历史（iframe 已在目标页上，不重载），地址栏跟上。
    // 这里不改写 entry 本身——它代表上一页，改写它会让「后退」退到同一页。
    const moved = {
      ...entry,
      path,
      realUrl: (entry.tls ? 'https://' : 'http://') + entry.target + path,
    };
    session.pageUrl = moved.realUrl;
    session.frameProxy = moved.proxyUrl;
    session.frameProxyId = moved.proxyId;
    pushEntry(moved);
    if (!addrFocused) addr.next = entryLabel(moved);
    return true;
  }

  // ---- 打开与停止 ------------------------------------------------------

  async function doOpen() {
    busy.next = true;
    try {
      if (mode.value === 'socks') {
        await stopTunnel();
        setStatus('busy', 'app.browser.tunneling');
        const o = opts.value;
        let tun;
        try {
          tun = await callAppApi('tunnels', 'create',
            { type: 'dynamic', bind: o.bind, port: o.port, udp: o.udp },
            { silent: true, timeout: 60000 });
        } catch (e) {
          setStatus('off', 'app.browser.status-tunnel-failed');
          pane.next = idlePane();
          toast(socksErrorText(e), 'error');
          return;
        }
        session.kind = 'tunnel';
        session.id = tun.id;
        session.socksProxy = tun.proxy || 'socks5://' + tun.listen;
        session.socksHost = hostOf(session.socksProxy);
        session.socksPort = portOf(session.socksProxy);
        setStatus('busy', 'app.browser.launching-browser');
        const res = await launchBrowser(toUrl(addr.value), browserPath.value, session.socksProxy);
        session.pageUrl = toUrl(addr.value);
        socksLine.next = 'SOCKS5 ' + session.socksHost + ':' + session.socksPort + (o.udp ? ' · UDP' : '');
        if (!res.ok) {
          setStatus('off', 'app.browser.proxy-ready-browser-not');
          pane.next = {
            kind: 'fallback', url: '', blank: false, seq: 0,
            proxy: session.socksProxy, proxyId: '', err: res.error || t('app.browser.launch-died'),
          };
        } else {
          if (res.error) toast(res.error, 'warning');
          setStatus('on',
            res.name ? 'app.browser.launched-named' : 'app.browser.launched-system',
            res.name ? { v1: res.name } : null);
          pane.next = idlePane();
        }
        return;
      }

      const parsed = parseTarget(addr.value);
      if (!parsed) { toast(t('app.browser.invalid-address'), 'error'); return; }
      setStatus('busy', 'app.browser.proxying');
      const rec = await ensureProxy(parsed);
      const entry = {
        proxyId: rec.id, proxyUrl: rec.url,
        target: parsed.host + ':' + parsed.port,
        path: parsed.path, input: parsed.input,
        realUrl: parsed.scheme + '://' + parsed.host + ':' + parsed.port + parsed.path,
        tls: rec.tls,
      };
      session.kind = 'proxy';
      session.id = rec.id;
      session.frameProxy = rec.url;
      session.frameProxyId = rec.id;
      frameLine.next = rec.url + '  →  ' + rec.target;
      pushEntry(entry);
      displayEntry(entry);
    } catch (e) {
      setStatus('off', 'app.browser.status-launch-failed');
      pane.next = idlePane();
      toast(t('app.browser.status-launch-failed-detail') + (e.message || e), 'error');
    } finally {
      busy.next = false;
    }
  }

  async function stopSession(silent) {
    stopPoll();
    clearTimeout(loadTimer);
    await stopTunnel();
    await stopProxies();
    session.kind = null;
    session.id = null;
    session.socksProxy = '';
    session.socksHost = '';
    session.socksPort = 0;
    session.frameProxy = '';
    session.frameProxyId = '';
    session.pageUrl = '';
    nav.next = { hist: [], idx: -1 };
    socksLine.next = '';
    frameLine.next = '';
    setStatus('', 'app.browser.status-not-started');
    pane.next = idlePane();
    if (!silent) toast(t('app.browser.status-stopped'), 'success');
  }

  /**
   * 主模式切换。离开系统浏览器模式时把 SOCKS5 隧道收掉，内嵌模式的代理实例与历史都保留：
   * 切回内嵌模式时直接回到最近一页，而不是停在空面板上。
   */
  async function onModeChange(id) {
    const prev = mode.value;
    if (id === prev) return;
    mode.next = id;
    if (id === 'iframe' && prev === 'socks') await stopTunnel();
    if (id === 'socks') {
      // 内嵌面板在系统浏览器模式下不显示，轮询也停掉，避免空打接口
      stopPoll();
      clearTimeout(loadTimer);
      if (session.kind !== 'tunnel') setStatus('', 'app.browser.status-not-started');
      return;
    }
    const e = currentEntry();
    if (e && session.proxies.size) displayEntry(e);
  }

  async function loadBrowsers() {
    let list = [];
    let err = '';
    browsersLoading.next = true;
    try {
      let plat = '';
      try {
        const info = await getHostInfo();
        plat = (info && info.platform) || navigator.platform || '';
      } catch {
        plat = navigator.platform || '';
      }
      platform.next = hostPlatformKind({ platform: plat });
      const facts = await localHostInfo();
      await prepareBrowsers({ platform: plat, host: facts });
      const stored = getPref(BROWSER_KEY, '');
      list = await listBrowsers();
      browsers.next = list;
      browsersErr.next = '';
      browserPath.next = list.length
        ? (list.some((b) => b.path === stored) ? stored : list[0].path)
        : '';
    } catch (e) {
      err = browserErrorText(e && e.code, (e && e.message) || String(e));
      browsers.next = [];
      browsersErr.next = err;
      browserPath.next = '';
    } finally {
      browsersLoading.next = false;
    }
  }

  function brandPane() {
    return h('div', { class: 'brw-hint' }, [
      h('div', { class: 'brw-hint-logo' }, [
        'Q',
        h('span', { class: 'brw-hint-accent', text: 'x' }),
        'SSH',
      ]),
    ]);
  }

  function paneTree() {
    const p = pane.value;
    // 内嵌页面只在内嵌模式下渲染：切到系统浏览器模式后留给品牌占位或回落面板，
    // 否则状态栏说「已启动 Chrome」，面板里却还挂着一个网页。
    if (mode.value === 'iframe' && p.kind === 'frame') {
      return h('iframe', {
        // key 在单子节点场景不参与 diff，这里保留给 keyed 场景；真正触发重载的是 src 的变化
        key: p.url + '#' + p.seq,
        class: 'brw-frame',
        src: p.blank ? 'about:blank' : p.url,
        sandbox: FRAME_SANDBOX,
        allow: FRAME_ALLOW,
        allowfullscreen: true,
        referrerpolicy: 'no-referrer',
        onLoad: () => { if (!pane.value.blank) markLoaded(); },
        onError: () => setStatus('off', 'app.browser.frame-error'),
      });
    }
    if (p.kind === 'fallback') {
      return h('div', { class: 'brw-hint' }, [
        h('div', { class: 'brw-hint-logo' }, [
          'Q',
          h('span', { class: 'brw-hint-accent', text: 'x' }),
          'SSH',
        ]),
        h('div', { class: 'brw-fb' }, [
          h('div', { class: 'brw-fb-title', text: t('app.browser.browser-not-open-proxy-ready') }),
          h('div', { class: 'brw-fb-addr mono', text: p.proxy }),
          h('button', {
            class: 'btn btn-primary btn-sm',
            text: t('app.browser.copy-proxy'),
            onClick: () => copyText(p.proxy),
          }),
          h('div', { class: 'brw-fb-tip', text: t('app.browser.proxy-hint') }),
          p.err ? h('div', { class: 'brw-fb-err', text: p.err }) : null,
        ].filter(Boolean)),
      ]);
    }
    return brandPane();
  }

  /** 选定浏览器并落进偏好，下次打开直接复用 */
  function pickBrowser(path) {
    browserPath.next = path;
    setPref(BROWSER_KEY, path);
  }

  /** 重新扫一遍本机浏览器：清掉检测缓存再走一次加载，失败原因会显示在下拉下面 */
  function reloadBrowsers() {
    resetBrowserCache();
    browsersErr.next = '';
    loadBrowsers();
  }

  /**
   * 浏览器下拉：不用原生 <select>。
   * 原生弹层依赖元素自身的 disabled/value 状态，列表是异步装进来的，挂载时还是空的，
   * 一旦元素进入 disabled，后面的属性补写只要有一次没落到 DOM 上，控件就永久点不开；
   * 这里改成自绘菜单，按钮永远可点，列表为空时也能点开看原因并重试。
   */
  function openBrowserMenu(ev) {
    const btn = ev && ev.currentTarget;
    const r = btn ? btn.getBoundingClientRect() : { left: 8, bottom: 8 };
    const list = browsers.value;
    const err = browsersErr.value;
    const cur = browserPath.value;
    const items = [{ head: t('app.browser.mode-system') }];
    if (!list.length && browsersLoading.value) {
      items.push({ icon: 'globe', label: t('app.browser.scanning'), disabled: true });
      menu(items, { x: r.left, y: r.bottom + 4 });
      return;
    }
    if (list.length) {
      for (const b of list) {
        items.push({
          icon: 'globe',
          label: browserLabel(b),
          hint: b.path,
          active: b.path === cur || (!cur && b === list[0]),
          onClick: () => pickBrowser(b.path),
        });
      }
    } else {
      items.push({
        icon: 'globe',
        label: err ? t('app.browser.read-failed') : t('app.browser.no-browser-found'),
        hint: err || noBrowserHint(platform.value),
        disabled: true,
      });
    }
    items.push({ sep: true });
    items.push({ icon: 'reload', label: t('app.browser.nav-reload'), onClick: reloadBrowsers });
    menu(items, { x: r.left, y: r.bottom + 4 });
  }

  function BrowserPicker() {
    lang();
    const list = browsers.value;
    const err = browsersErr.value;
    const kind = platform.value;
    const cur = browserPath.value;
    const hit = list.find((b) => b.path === cur) || list[0] || null;
    const busy = browsersLoading.value;
    const label = hit
      ? browserLabel(hit)
      : (busy ? t('app.browser.scanning')
        : (err ? t('app.browser.read-failed') : t('app.browser.no-browser-found')));
    return sidebarSections([{
      title: t('app.browser.mode-system'),
      node: h('div', { class: 'brw-prog-wrap' }, [
        h('button', {
          class: 'brw-prog-btn' + (hit ? '' : ' is-empty'),
          type: 'button',
          onClick: openBrowserMenu,
        }, [
          h('span', { class: 'brw-prog-ic', html: icon('globe', 'qicon-sm') }),
          h('span', { class: 'brw-prog-label', text: label }),
          h('span', { class: 'brw-prog-caret' }),
        ]),
        err ? h('div', { class: 'brw-err', text: tf('app.browser.browser-list-failed', { v1: err }) }) : null,
        !hit && !err ? h('div', { class: 'brw-err', text: noBrowserHint(kind) }) : null,
      ].filter(Boolean)),
    }]);
  }

  /** 三点菜单：系统浏览器模式管 UDP 开关，内嵌模式管当前页（复制 / 刷新 / 关闭） */
  function openMoreMenu(ev) {
    const btn = ev && ev.currentTarget;
    const r = btn ? btn.getBoundingClientRect() : { left: 8, bottom: 8 };
    const cur = opts.value;
    const p = pane.value;
    const items = [];
    if (mode.value === 'socks') {
      items.push(
        { head: t('app.browser.more-options') },
        {
          icon: 'zap',
          label: t('app.browser.opt-udp'),
          active: cur.udp,
          hint: cur.udp ? t('app.browser.more-udp-on') : t('app.browser.more-udp-off'),
          onClick: () => { opts.next = { ...cur, udp: !cur.udp }; },
        },
        { sep: true },
        {
          icon: 'server',
          label: t('app.browser.more-listen'),
          disabled: true,
          hint: cur.bind + ':' + (cur.port === 0 ? 'auto' : cur.port),
        },
      );
    } else {
      const has = p.kind === 'frame' && !!p.proxy;
      items.push(
        { head: t('app.browser.more-page') },
        {
          icon: 'copy',
          label: t('app.browser.copy-proxy-url'),
          disabled: !has,
          onClick: () => { if (has) copyText(p.blank ? p.proxy + '/' : p.url); },
        },
        { icon: 'reload', label: t('app.browser.nav-reload'), disabled: !has, onClick: reload },
        { sep: true },
        { icon: 'stop', label: t('app.browser.stop-embedded'), danger: true, onClick: () => stopSession(false) },
      );
    }
    menu(items, { x: r.left, y: r.bottom + 4 });
  }

  function mainTree() {
    const cur = nav.value;
    const isFrame = mode.value === 'iframe';
    const st = status.value;
    const p = pane.value;
    const udpOn = mode.value === 'socks' && opts.value.udp;
    return h(Fragment, {}, [
      h('div', { class: 'brw-nav' }, [
        h('div', { class: 'brw-nav-group' }, [
          // 三点「更多选项」：两个模式都有意义，系统浏览器模式管 UDP，内嵌模式管当前页
          h('button', {
            class: 'qx-ibtn brw-more-btn' + (udpOn ? ' on' : ''),
            html: icon('more-horizontal'),
            dataset: { tip: t('app.browser.more-options') },
            onClick: openMoreMenu,
          }),
          h('button', {
            class: 'qx-ibtn', html: icon('arrow-left'), dataset: { tip: t('app.browser.nav-back') },
            disabled: !(isFrame && cur.idx > 0),
            onClick: goBack,
          }),
          h('button', {
            class: 'qx-ibtn', html: icon('arrow-right'), dataset: { tip: t('app.browser.nav-forward') },
            disabled: !(isFrame && cur.idx < cur.hist.length - 1),
            onClick: goForward,
          }),
          h('button', {
            class: 'qx-ibtn', html: icon('reload'), dataset: { tip: t('app.browser.nav-reload') },
            onClick: reload,
          }),
        ].filter(Boolean)),
        h('div', { class: 'brw-omni' }, [
          h('span', { class: 'brw-omni-ic', html: icon('globe', 'qicon-sm') }),
          h('input', {
            class: 'brw-omni-input',
            type: 'text',
            value: addr.value,
            onFocus: () => { addrFocused = true; },
            onBlur: () => { addrFocused = false; },
            onInput: (e) => { addr.next = e.target.value; },
            onKeydown: (e) => { if (e.key === 'Enter') doOpen(); },
          }),
        ]),
        h('button', {
          class: 'btn btn-primary brw-go',
          html: icon('search', 'qicon-sm'),
          dataset: { tip: t('app.browser.nav-open-address') },
          disabled: busy.value,
          onClick: doOpen,
        }),
      ]),
      paneTree(),
      h('div', { class: 'qx-status-bar qx-status' }, [
        h('span', { class: 'brw-status-left' }, [
          h('span', { class: 'qx-dot ' + st.dot }),
          h('span', { class: 'brw-status-text', text: st.params ? tf(st.key, st.params) : t(st.key) }),
        ]),
        h('span', { class: 'brw-proxy mono', text: isFrame ? frameLine.value : socksLine.value }),
      ]),
    ]);
  }

  const shell = createAppShell(el, {
    tabs: () => [
      { id: 'socks', label: t('app.browser.mode-system'), icon: 'server' },
      { id: 'iframe', label: t('app.browser.mode-embedded'), icon: 'monitor' },
    ],
    active: 'socks',
    onChange: (id) => { onModeChange(id); },
    sideTop: [h(BrowserPicker)],
    actions: [
      () => sideAction({
        icon: 'copy',
        label: t('app.browser.copy-proxy'),
        onClick: () => {
          const p = pane.value;
          if (mode.value === 'iframe' && p.kind === 'frame' && p.proxy) { copyText(p.proxy + '/'); return; }
          if (!session.socksHost) { toast(t('app.browser.no-running-proxy'), 'info'); return; }
          copyText(session.socksHost + ':' + session.socksPort);
        },
      }),
      () => sideAction({ icon: 'reload', label: t('app.browser.reopen'), onClick: () => doOpen() }),
      () => sideAction({ icon: 'stop', label: t('app.browser.stop'), onClick: () => stopSession(false) }),
    ],
  });

  shell.setMain(mainTree);

  loadBrowsers();
  preconnectHost(hostId);

  provideApi('open', async (args) => {
    const a = args || {};
    const url = String(a.url || '').trim();
    if (!url) throw new Error(t('app.browser.api-open-need-url'));
    if (a.mode === 'socks' || a.mode === 'iframe') await onModeChange(a.mode);
    addr.next = url;
    windowControl('focus');
    await doOpen();
    const proxy = mode.value === 'iframe' ? (pane.value.proxy || '') : session.socksProxy;
    return { mode: mode.value, proxy, url: session.pageUrl || '' };
  }, {
    description: t('app.browser.api-open-desc'),
    version: '1',
    needsWindow: true,
    perm: 'term:open',
  });

  return () => {
    shell.destroy();
    stopPoll();
    clearTimeout(loadTimer);
    stopSession(true);
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'browser',
}).catch(() => { }).then(() => {
  bootApp(({ root, ctx }) => boot(root, ctx));
});
