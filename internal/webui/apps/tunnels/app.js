import { h, Fragment } from '/assets/js/core/vdom.js';
import { bootApp, provideApi } from '/assets/js/app-bridge.js';
import { setupI18n, t, tf } from '/assets/js/core/i18n.js';

import { fmtTime, esc } from '/assets/js/core/dom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction, task } from '/assets/js/core/ui.js';
import { listTunnels, startTunnel, stopTunnel, preconnectHost, tunnelTypeLabel, tunnelTypeDesc, tunnelKind, tunnelProtoLabel } from '/assets/js/core/tunnels.js';
import { getState } from '/assets/js/core/store.js';
import { card, field, statusBar, table, sideAction, SwitchToggle } from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { createDataView } from '/assets/js/core/data-view.js';
import { createAppShell } from '/assets/js/core/app-shell.js';

const shortLabel = (type) => (tunnelTypeLabel(type) || type).split(' ')[0];

const FILTER_TABS = [
  { id: 'all', key: 'app.tunnels.card-overview', icon: 'network' },
  { id: 'local', key: 'app.tunnels.type-local', icon: 'server' },
  { id: 'remote', key: 'app.tunnels.type-remote', icon: 'monitor' },
  { id: 'dynamic', key: 'app.tunnels.type-dynamic', icon: 'activity' },
  { id: 'udp', key: 'app.tunnels.type-udp', icon: 'zap' },
  { id: 'tun', key: 'app.tunnels.type-tun', icon: 'route' },
];

function filterTabsNow() {
  return FILTER_TABS.map((x) => ({ id: x.id, icon: x.icon, label: t(x.key) }));
}

function boot(el, ctx) {
  const hostId = ctx.hostId;
  const host = (getState().hosts || []).find((hh) => hh.id === hostId);
  const hostName = host ? host.name : hostId;

  const type = signal('local');
  const filter = signal('all');
  const port = signal('8080');
  const target = signal('');
  const udpOn = signal(false);
  // TUN 隧道用不到 bind/port/target，改为描述这条点到点链路：本机地址、对端地址、单元号、MTU、路由。
  const tunAddr = signal('10.99.0.1/30');
  const tunPeer = signal('10.99.0.2');
  const tunLocal = signal('0');
  const tunRemote = signal('0');
  const tunMtu = signal('1420');
  const tunRoutes = signal('');

  const textField = (label, sig, placeholder) => field(label, h('input', {
    class: 'input', type: 'text', value: sig.value, placeholder,
    onInput: (e) => { sig.next = e.target.value; },
  }));
  const numField = (label, sig, min, max, hint) => field(label, h('input', {
    class: 'input', type: 'number', value: sig.value, placeholder: hint, min, max,
    onInput: (e) => { sig.next = e.target.value; },
  }));

  function tunFields() {
    return [
      textField(t('app.tunnels.field-tun-addr'), tunAddr, t('app.tunnels.field-tun-addr-hint')),
      textField(t('app.tunnels.field-tun-peer'), tunPeer, t('app.tunnels.field-tun-peer-hint')),
      numField(t('app.tunnels.field-tun-local'), tunLocal, '-1', '255', t('app.tunnels.field-tun-unit-hint')),
      numField(t('app.tunnels.field-tun-remote'), tunRemote, '-1', '255', t('app.tunnels.field-tun-unit-hint')),
      numField(t('app.tunnels.field-tun-mtu'), tunMtu, '576', '9000', '1420'),
      textField(t('app.tunnels.field-tun-routes'), tunRoutes, t('app.tunnels.field-tun-routes-hint')),
    ];
  }

  function portFields(kind) {
    return [
      field(t('app.tunnels.field-bind'), h('input', {
        class: 'input', type: 'text', value: '127.0.0.1',
        readonly: true, tabindex: '-1',
        title: t('app.tunnels.bind-hint'),
      })),
      field(t('app.tunnels.field-port'), h('input', {
        class: 'input', type: 'number', value: port.value,
        placeholder: t('app.tunnels.field-port-hint'), min: '0', max: '65535',
        onInput: (e) => { port.next = e.target.value; },
      })),
      kind === 'dynamic' ? null : field(t('app.tunnels.field-target'), h('input', {
        class: 'input', type: 'text', value: target.value,
        placeholder: t('app.tunnels.field-target-hint'),
        onInput: (e) => { target.next = e.target.value; },
      })),
      kind === 'dynamic' ? h('div', { class: 'cmp-field tn-udp-field' }, [
        h('label', { class: 'cmp-field-label', text: t('app.tunnels.field-udp') }),
        h('div', { class: 'cmp-field-control' }, [
          h('div', { class: 'tn-udp' }, [
            h(SwitchToggle, {
              label: t('app.tunnels.field-udp-on'),
              checked: udpOn.value,
              onChange: (on) => { udpOn.next = on; },
            }),
            h('span', { class: 'tn-udp-hint', text: t('app.tunnels.field-udp-hint') }),
          ]),
        ]),
      ]) : null,
    ];
  }

  async function doStart() {
    const kind = type.value;
    if (kind === 'tun') {
      await task(async () => startTunnel({
        hostId,
        type: 'tun',
        tunAddr: tunAddr.value.trim(),
        tunPeer: tunPeer.value.trim(),
        tunRoutes: tunRoutes.value.trim(),
        tunLocal: parseInt(tunLocal.value, 10),
        tunRemote: parseInt(tunRemote.value, 10),
        tunMtu: parseInt(tunMtu.value, 10),
      }), {
        ok: (rec) => {
          tf('app.tunnels.started-tun', { v1: rec.listen, v2: rec.tunRemoteDev || t('app.tunnels.tun-remote-auto') });
          // 远端不是 root 时后端不改远端配置，把要手工执行的命令原样带回，这里必须露出来。
          if (rec.tunNote) toast(rec.tunNote, 'warning', 12000);
        },
        err: t('app.tunnels.err-start-failed'),
      });
      refresh();
      return;
    }
    const raw = port.value.trim();
    const p = raw === '' ? 0 : parseInt(raw, 10);
    if (Number.isNaN(p) || p < 0 || p > 65535) {
      toast(t('app.tunnels.err-port'), 'error');
      return;
    }
    await task(async () => {
      const rec = await startTunnel({
        hostId,
        type: kind,
        bind: '127.0.0.1',
        port: p,
        target: target.value.trim(),
        udp: kind === 'dynamic' && udpOn.value,
      });
      if (p === 0) port.next = String(rec.listen.split(':').pop());
      return rec;
    }, { ok: (rec) => tf('app.tunnels.started', { v1: (rec.listen) }), err: t('app.tunnels.err-start-failed') });
    refresh();
  }

  async function doStop(rec) {
    if (!rec) return;
    const ok = await confirmAction(
      t('app.tunnels.confirm-stop-title'),
      t('app.tunnels.confirm-stop-body'),
      { okText: t('app.tunnels.action-stop'), danger: true }
    );
    if (!ok) return;
    await task(() => stopTunnel(rec.id), { ok: t('app.tunnels.stopped'), err: t('app.tunnels.err-stop-failed') });
    refresh();
  }

  let dv = null;
  dv = createDataView({
    load: async () => (await listTunnels()).tunnels,
    pick: shown,
    empty: () => t('app.tunnels.empty-none'),
    error: () => t('app.tunnels.err-list-failed'),
    busyMs: 5000,
    idleMs: 20000,
    render: (rows) => table([
      { label: t('app.tunnels.col-type'), render: (row) => {
        const kind = tunnelKind(row);
        return `<span class="tn-type tn-type-${kind}">${esc(shortLabel(kind))} · ${esc(tunnelProtoLabel(row))}</span>`;
      } },
      { label: t('app.tunnels.col-listen'), cls: 'mono', key: 'listen' },
      { label: t('app.tunnels.col-target'), cls: 'mono', render: (row) => esc(row.target || '—') },
      { label: t('app.tunnels.col-host'), render: (row) => esc(row.hostName || row.hostId) },
      { label: t('app.tunnels.col-started-at'), cls: 'mono', render: (row) => esc(fmtTime(row.startedAt)) },
      {
        label: t('app.tunnels.col-actions'),
        cls: 'qx-actions-col',
        render: (row) => h('button', {
          class: 'btn btn-ghost btn-sm btn-text-danger',
          dataset: { tip: t('app.tunnels.action-stop') },
          html: icon('trash'),
          onClick: () => doStop(row),
        }),
      },
    ], rows, { rowKey: (row) => row.id }),
  });

  async function refreshNow() {
    dv.setRows(await listTunnels().then((d) => d.tunnels));
  }

  const refresh = () => dv.refresh(true);

  function shown() {
    const all = dv ? dv.rows : [];
    return filter.value === 'all' ? all : all.filter((row) => tunnelKind(row) === filter.value);
  }

  function mainTree() {
    const kind = type.value;
    const curTab = FILTER_TABS.find((x) => x.id === filter.value) || FILTER_TABS[0];
    const label = t(curTab.key);
    const all = dv ? dv.rows : [];
    return h('div', { class: 'app-root' }, [
      h('div', { class: 'qx-scroll' }, [
        h('div', { class: filter.value === 'all' ? 'hidden' : '' }, card(t('app.tunnels.title-new'), [
          h('div', { class: 'tn-desc' }, [
            h('span', { class: `tn-type tn-type-${kind}`, text: tunnelTypeLabel(kind) }),
            h('span', { text: tunnelTypeDesc(kind) }),
          ]),
          h('div', { class: 'tn-grid' }, (kind === 'tun' ? tunFields() : portFields(kind)).filter(Boolean)),
          h('div', { class: 'tn-foot' }, [
            h('button', {
              class: 'btn btn-primary btn-sm',
              html: icon('plus') + t('app.tunnels.action-start'),
              onClick: doStart,
            }),
          ]),
        ], { tools: h('span', { class: 'qx-count', text: tf('app.tunnels.card-host', { v1: hostName }) }) })),
        card(t('app.tunnels.title-tunnels'), [dv.element], {
          fill: true,
          tools: h('span', { class: 'qx-count', text: tf('app.tunnels.count-shown', { v1: (shown().length) }) }),
        }),
      ]),
      statusBar([tf('app.tunnels.card-running', { v1: (all.length) }), tf('app.tunnels.card-filter', { v1: label }), tf('app.tunnels.card-host', { v1: hostName })]),
    ]);
  }

  const shell = createAppShell(el, {
    tabs: filterTabsNow,
    active: 'all',
    onChange: (id) => {
      filter.next = id;
      if (id !== 'all') type.next = id;
    },
    actions: [
      () => sideAction({ icon: 'reload', label: t('app.tunnels.action-refresh'), onClick: () => refresh() }),
    ],
  });
  shell.setMain(mainTree);

  preconnectHost(hostId);

  provideApi('create', async (args) => {
    const a = args || {};
    if (String(a.type || '') === 'tun') {
      const rec = await startTunnel({
        hostId: String(a.hostId || hostId),
        type: 'tun',
        tunAddr: a.tunAddr == null ? '' : String(a.tunAddr),
        tunPeer: a.tunPeer == null ? '' : String(a.tunPeer),
        tunRoutes: Array.isArray(a.tunRoutes) ? a.tunRoutes.join(' ') : (a.tunRoutes == null ? '' : String(a.tunRoutes)),
        tunLocal: a.tunLocal == null ? 0 : Number(a.tunLocal),
        tunRemote: a.tunRemote == null ? 0 : Number(a.tunRemote),
        tunMtu: a.tunMtu == null ? 0 : Number(a.tunMtu),
      });
      await refreshNow();
      return rec;
    }
    const rec = await startTunnel({
      hostId: String(a.hostId || hostId),
      type: String(a.type || 'local'),
      bind: a.bind === undefined || a.bind === null ? undefined : String(a.bind),
      port: Number(a.port),
      target: a.target == null ? '' : String(a.target),
      udp: !!a.udp,
    });
    await refreshNow();
    return rec;
  }, {
    description: t('app.tunnels.api-create-desc')
      + 'args: { hostId?, type: "local"|"remote"|"dynamic"|"udp"|"tun", bind?, port, target?, udp? }；'
      + 'type="tun" 时改用 { tunAddr, tunPeer?, tunRoutes?, tunLocal?, tunRemote?, tunMtu? }。'
      + t('app.tunnels.api-create-hostid')
      + t('app.tunnels.api-create-local')
      + t('app.tunnels.api-create-remote')
      + t('app.tunnels.api-create-dynamic')
      + t('app.tunnels.api-create-udp')
      + t('app.tunnels.api-create-udp-socks')
      + t('app.tunnels.api-create-tun')
      + t('app.tunnels.api-create-port-zero')
      + t('app.tunnels.api-create-return')
      + t('app.tunnels.api-create-proxy')
      + t('app.tunnels.api-create-ready')
      + t('app.tunnels.api-create-errors'),
    version: '5',
    perm: 'tunnel:local',
  });

  provideApi('stop', async (args) => {
    const id = String((args && args.id) || '');
    if (!id) {
      const e = new Error(t('app.tunnels.api-stop-missing-id'));
      e.appApiCode = 'invalid_args';
      throw e;
    }
    await stopTunnel(id);
    await refreshNow();
    return { ok: true, id };
  }, {
    description: t('app.tunnels.api-stop-desc')
      + t('app.tunnels.api-stop-args')
      + t('app.tunnels.api-stop-idempotent'),
    version: '1',
    perm: 'tunnel:local',
  });

  provideApi('list', async () => {
    await refreshNow();
    return { tunnels: dv.rows };
  }, {
    description: t('app.tunnels.api-list-desc')
      + t('app.tunnels.api-list-return')
      + t('app.tunnels.api-list-direct'),
    version: '2',
    perm: 'tunnel:list',
  });

  provideApi('whereami', () => ({
    hostId,
    hostName,
    running: dv.rows.length,
    types: ['local', 'remote', 'dynamic', 'udp', 'tun'].map((k) => `${k}（${tunnelTypeLabel(k)}）`),
  }), {
    description: t('app.tunnels.api-info-desc')
      + t('app.tunnels.api-info-usage'),
    version: '1',
  });

  return () => { shell.destroy(); };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'tunnels',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
