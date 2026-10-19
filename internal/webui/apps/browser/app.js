import { bootApp, callAppApi, getHostInfo, provideApi, windowControl } from '/assets/js/app-bridge.js';

import { h, Fragment } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, copyText as copyToClipboard } from '/assets/js/core/ui.js';
import { getPref, setPref } from '/assets/js/core/prefs.js';
import { localHostInfo, startWebProxy, stopWebProxy } from '/assets/js/core/qxssh-api.js';
import { browserErrorText, launchBrowser, listBrowsers, prepareBrowsers } from './api.js';
import { preconnectHost } from '/assets/js/core/tunnels.js';
import { sidebarSections, sideAction } from '/assets/js/core/components.js';
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

function copyText(text) {
  copyToClipboard(text).then((ok) => {
    if (ok) toast(t('app.browser.copied') + text, 'success');
    else toast(t('app.browser.copy-failed') + text, 'warning');
  });
}

function parseTarget(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  let scheme = 'http';
  const m = s.match(/^(https?):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  s = s.split('/')[0].split('?')[0].split('#')[0];
  let host = '127.0.0.1';
  let port = scheme === 'https' ? 443 : 80;
  if (s.includes(':')) {
    const i = s.lastIndexOf(':');
    host = s.slice(0, i) || '127.0.0.1';
    port = parseInt(s.slice(i + 1), 10);
  } else if (/^\d+$/.test(s)) {
    port = parseInt(s, 10);
  } else if (s) {
    host = s;
  }
  if (!host) host = '127.0.0.1';
  if (!port || port < 1 || port > 65535) return null;
  return { host, port, scheme };
}

function toUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}/`;
  return `http://${s}`;
}

function hostOf(proxy) {
  const s = String(proxy || '').replace(/^socks5:\/\//i, '');
  const i = s.lastIndexOf(':');
  return i > 0 ? s.slice(0, i) : s;
}

function portOf(proxy) {
  const s = String(proxy || '').replace(/^socks5:\/\//i, '');
  const i = s.lastIndexOf(':');
  return i > 0 ? parseInt(s.slice(i + 1), 10) || 0 : 0;
}

function browserLabel(b) {
  const ver = String(b.version || '').split('.').slice(0, 2).join('.');
  const name = ver ? `${b.name} ${ver}` : b.name;
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

function boot(el, ctx) {
  const hostId = ctx.hostId;

  const session = {
    kind: null, id: null, proxy: '', proxyHost: '', proxyPort: 0, pageUrl: '',
  };

  const mode = signal('socks');
  const addr = signal('');
  const busy = signal(false);
  const status = signal({ dot: '', key: 'app.browser.status-not-started', params: null });
  const proxyLine = signal('');
  const nav = signal({ hist: [], idx: -1 });
  const pane = signal({ kind: 'idle', url: '', proxy: '', err: '' });
  const browsers = signal([]);
  const browsersErr = signal('');
  const browserPath = signal('');
  const platform = signal('');

  const setStatus = (dot, key, params = null) => status.next = { dot, key, params };

  function loadFrame(url, push) {
    if (push) {
      const cur = nav.value;
      const hist = cur.hist.slice(0, cur.idx + 1);
      hist.push(url);
      nav.next = { hist, idx: hist.length - 1 };
    }
    pane.next = { kind: 'frame', url, proxy: '', err: '' };
  }

  function goBack() {
    const cur = nav.value;
    if (mode.value !== 'iframe' || cur.idx <= 0) return;
    const idx = cur.idx - 1;
    nav.next = { hist: cur.hist, idx };
    loadFrame(cur.hist[idx], false);
  }

  function goForward() {
    const cur = nav.value;
    if (mode.value !== 'iframe' || cur.idx >= cur.hist.length - 1) return;
    const idx = cur.idx + 1;
    nav.next = { hist: cur.hist, idx };
    loadFrame(cur.hist[idx], false);
  }

  function reload() {
    if (mode.value === 'iframe') {
      const cur = nav.value;
      if (cur.idx < 0) { toast(t('app.browser.no-page-open'), 'info'); return; }
      loadFrame(cur.hist[cur.idx], false);
      setStatus('busy', 'app.browser.reloading');
      setTimeout(() => setStatus('on', 'app.browser.connected-embedded'), 400);
    } else {
      doOpen();
    }
  }

  async function doOpen() {
    await stopSession(true);
    busy.next = true;
    try {
      if (mode.value === 'socks') {
        setStatus('busy', 'app.browser.tunneling');
        let tun;
        try {
          tun = await callAppApi('tunnels', 'create',
            { type: 'dynamic', bind: '127.0.0.1', port: 0 },
            { silent: true, timeout: 60000 });
        } catch (e) {
          setStatus('off', 'app.browser.status-tunnel-failed');
          pane.next = { kind: 'idle', url: '', proxy: '', err: '' };
          toast(socksErrorText(e), 'error');
          return;
        }
        session.kind = 'tunnel';
        session.id = tun.id;
        session.proxy = tun.proxy || `socks5://${tun.listen}`;
        setStatus('busy', 'app.browser.launching-browser');
        const res = await launchBrowser(toUrl(addr.value), browserPath.value, session.proxy);
        session.proxyHost = hostOf(session.proxy);
        session.proxyPort = portOf(session.proxy);
        session.pageUrl = toUrl(addr.value);
        proxyLine.next = `SOCKS5 ${session.proxyHost}:${session.proxyPort}`;
        if (!res.ok) {
          setStatus('off', 'app.browser.proxy-ready-browser-not');
          pane.next = {
            kind: 'fallback', url: '', proxy: session.proxy,
            err: res.error || t('app.browser.launch-died'),
          };
        } else {
          if (res.error) toast(res.error, 'warning');
          setStatus('on',
            res.name ? 'app.browser.launched-named' : 'app.browser.launched-system',
            res.name ? { v1: res.name } : null);
          pane.next = { kind: 'idle', url: '', proxy: '', err: '' };
        }
      } else {
        const parsed = parseTarget(addr.value);
        if (!parsed) { toast(t('app.browser.invalid-address'), 'error'); return; }
        setStatus('busy', 'app.browser.proxying');
        const inst = await startWebProxy(hostId, `${parsed.host}:${parsed.port}`, parsed.scheme === 'https');
        session.kind = 'proxy';
        session.id = inst.id;
        session.pageUrl = `${parsed.host}:${parsed.port}`;
        proxyLine.next = `${inst.url}  →  ${parsed.host}:${parsed.port}`;
        loadFrame(inst.url, true);
        setStatus('on', 'app.browser.connected-embedded');
      }
    } catch (e) {
      setStatus('off', 'app.browser.status-launch-failed');
      pane.next = { kind: 'idle', url: '', proxy: '', err: '' };
      toast(t('app.browser.status-launch-failed-detail') + (e.message || e), 'error');
    } finally {
      busy.next = false;
    }
  }

  async function stopSession(silent) {
    try {
      if (session.kind === 'proxy' && session.id) await stopWebProxy(session.id);
      else if (session.kind === 'tunnel' && session.id) {
        await callAppApi('tunnels', 'stop', { id: session.id }, { silent: true, timeout: 15000 });
      }
    } catch { }
    session.kind = null;
    session.id = null;
    session.proxy = '';
    session.proxyHost = '';
    session.proxyPort = 0;
    session.pageUrl = '';
    nav.next = { hist: [], idx: -1 };
    proxyLine.next = '';
    setStatus('', 'app.browser.status-not-started');
    pane.next = { kind: 'idle', url: '', proxy: '', err: '' };
    if (!silent) toast(t('app.browser.status-stopped'), 'success');
  }

  async function loadBrowsers() {
    let list = [];
    let err = '';
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
    if (p.kind === 'frame') {
      return h('iframe', { key: p.url, class: 'brw-frame', src: p.url });
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

  function BrowserPicker() {
    lang();
    const list = browsers.value;
    const err = browsersErr.value;
    const kind = platform.value;
    const nodes = [
      h('select', {
        class: 'select brw-side-prog',
        disabled: !list.length,
        onChange: (e) => {
          browserPath.next = e.target.value;
          setPref(BROWSER_KEY, e.target.value);
        },
      }, list.length
        ? list.map((b) => h('option', {
          key: b.path, value: b.path, text: browserLabel(b),
          selected: b.path === browserPath.value,
        }))
        : [h('option', {
          value: '',
          text: err ? t('app.browser.read-failed') : t('app.browser.no-browser-found'),
        })]),
      err ? h('div', { class: 'brw-err', text: tf('app.browser.browser-list-failed', { v1: err }) }) : null,
      !list.length && !err ? h('div', { class: 'brw-err', text: noBrowserHint(kind) }) : null,
    ];
    return sidebarSections([{
      title: t('app.browser.mode-system'),
      node: h('div', { class: 'brw-prog-wrap' }, nodes.filter(Boolean)),
    }]);
  }

  function mainTree() {
    const cur = nav.value;
    const isFrame = mode.value === 'iframe';
    const st = status.value;
    return h(Fragment, {}, [
      h('div', { class: 'brw-nav' }, [
        h('div', { class: 'brw-nav-group' }, [
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
        ]),
        h('div', { class: 'brw-omni' }, [
          h('span', { class: 'brw-omni-ic', html: icon('globe', 'qicon-sm') }),
          h('input', {
            class: 'brw-omni-input',
            type: 'text',
            value: addr.value,
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
          h('span', { class: `qx-dot ${st.dot}` }),
          h('span', { class: 'brw-status-text', text: st.params ? tf(st.key, st.params) : t(st.key) }),
        ]),
        h('span', { class: 'brw-proxy mono', text: proxyLine.value }),
      ]),
    ]);
  }

  const shell = createAppShell(el, {
    tabs: () => [
      { id: 'socks', label: t('app.browser.mode-system'), icon: 'server' },
      { id: 'iframe', label: t('app.browser.mode-embedded'), icon: 'monitor' },
    ],
    active: 'socks',
    onChange: (id) => {
      mode.next = id;
    },
    sideTop: [h(BrowserPicker)],
    actions: [
      () => sideAction({
        icon: 'copy',
        label: t('app.browser.copy-proxy'),
        onClick: () => {
          if (!session.proxyHost) { toast(t('app.browser.no-running-proxy'), 'info'); return; }
          copyText(`${session.proxyHost}:${session.proxyPort}`);
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
    if (a.mode === 'socks' || a.mode === 'iframe') mode.next = a.mode;
    addr.next = url;
    windowControl('focus');
    await doOpen();
    return { mode: mode.value, proxy: session.proxy || '', url: session.pageUrl || '' };
  }, {
    description: t('app.browser.api-open-desc'),
    version: '1',
    needsWindow: true,
    perm: 'term:open',
  });

  return () => {
    shell.destroy();
    stopSession(true);
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'browser',
}).catch(() => { }).then(() => {
  bootApp(({ root, ctx }) => boot(root, ctx));
});
