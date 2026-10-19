import { t, tf } from '/assets/js/core/i18n.js';
import { h, Fragment, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { createPoller, throttle } from '/assets/js/core/dom.js';
import { toast } from '/assets/js/core/ui.js';
import { createSplitter } from '/assets/js/core/splitter.js';
import {
  card, chipGroup, dialog, emptyState, errorState, execResults, keyValue, searchBox, spinner,
} from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { CodeEditor } from '/assets/js/core/code-editor.js';
import * as api from './api.js';
import {
  containerGroup, groupLabel, parseMemUsage, parsePercent, parsePairIO,
  createLineBuffer, renderLog, fmtStatus,
} from './format.js';

const DTABS = [
  { id: 'overview', key: 'app.docker.tab-overview' },
  { id: 'logs', key: 'app.docker.tab-logs' },
  { id: 'term', key: 'app.docker.tab-terminal' },
  { id: 'stats', key: 'app.docker.tab-stats' },
  { id: 'env', key: 'app.docker.detail-env' },
  { id: 'mounts', key: 'app.docker.detail-volumes' },
  { id: 'net', key: 'app.docker.detail-networks' },
];

const PLAIN_PANES = new Set(['logs', 'term']);

const RUNTIME_PANES = new Set(['logs', 'term', 'stats']);

const INSPECT_PANES = new Set(['overview', 'env', 'mounts', 'net']);

const FILTERS = [
  { id: 'all', key: 'app.docker.filter-all' },
  { id: 'running', key: 'app.docker.state-running' },
  { id: 'stopped', key: 'app.docker.state-stopped' },
  { id: 'bad', key: 'app.docker.state-dead' },
];

const GROUP_ORDER = ['running', 'paused', 'stopped', 'bad'];

const STAT_DEFS = [
  { key: 'cpu', title: 'CPU' },
  { key: 'mem', titleKey: 'app.docker.col-mem' },
  { key: 'net', titleKey: 'app.docker.stat-net' },
  { key: 'disk', titleKey: 'app.docker.stat-disk' },
];

function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
  return {
    background: v('--background', '#ffffff'),
    foreground: v('--foreground', '#1d1d1f'),
    cursor: v('--primary', '#0037ff'),
    selectionBackground: v('--term-selection', 'rgba(0, 55, 255, 0.22)'),
  };
}

export function createContainersView(deps) {
  const list = signal([]);
  const stats = signal([]);
  const statsError = signal('');
  const filter = signal('all');
  const search = signal('');
  const checked = signal(new Set());
  const focused = signal('');
  const loading = signal(true);
  const error = signal('');

  let prevRunning = null;
  let detail = null;
  let watchTimer = null;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'dk-body';
  const listCol = document.createElement('div');
  listCol.className = 'dk-listcol';
  bodyEl.appendChild(listCol);

  const splitter = createSplitter({
    key: 'qx-docker-detailw',
    title: t('app.docker.detail-resize-hint'),
    getBody: () => bodyEl,
    getPanel: () => detail?.host,
  });

  const view = createView(listCol);
  view.update(listTree);

  async function fetchList() {
    const d = await deps.auth(() => api.dockerContainers(deps.host()));
    list.next = d.containers || [];
    stats.next = d.stats || [];
    statsError.next = d.statsError || '';
    detectExit();
    deps.changed();
  }

  async function refresh() {
    loading.next = true;
    error.next = '';
    try {
      await fetchList();
      loading.next = false;
    } catch (e) {
      loading.next = false;
      error.next = e.message || String(e);
      deps.changed();
    }
  }

  function startWatch() {
    if (watchTimer) return;
    watchTimer = createPoller(fetchList, 15000, { hiddenPause: false });
    watchTimer.start();
  }

  function stopWatch() {
    watchTimer?.dispose();
    watchTimer = null;
  }

  function detectExit() {
    const all = list.value;
    const running = new Set(all.filter((c) => containerGroup(c) === 'running').map((c) => c.ID));
    if (prevRunning && deps.notifyEnabled()) {
      for (const id of prevRunning) {
        if (running.has(id)) continue;
        const c = all.find((x) => x.ID === id);
        if (c && c.State === 'exited' && !/^Exited \(0\) /.test(c.Status || '')) {
          deps.notify(t('app.docker.container-dead'), `${c.Names}：${c.Status}`);
        }
      }
    }
    prevRunning = running;
  }

  function statFor(id) {
    return stats.value.find((s) => s.ID && id.startsWith(s.ID)) || null;
  }

  function shownList() {
    let rows = list.value;
    if (filter.value !== 'all') rows = rows.filter((c) => containerGroup(c) === filter.value);
    const q = search.value;
    if (!q) return rows;
    return rows.filter((c) =>
      (c.Names || '').toLowerCase().includes(q)
      || (c.Image || '').toLowerCase().includes(q)
      || (c.ID || '').toLowerCase().includes(q));
  }

  function toggleOne(id, on) {
    const next = new Set(checked.value);
    if (on) next.add(id);
    else next.delete(id);
    checked.next = next;
  }

  function toggleGroup(group, on) {
    const next = new Set(checked.value);
    for (const c of list.value) {
      if (containerGroup(c) !== group) continue;
      if (on) next.add(c.ID);
      else next.delete(c.ID);
    }
    checked.next = next;
  }

  function clearChecked() {
    checked.next = new Set();
  }

  function rowNode(c) {
    const g = containerGroup(c);
    const st = statFor(c.ID);
    return h('div', {
      key: c.ID,
      class: `dk-row${g === 'bad' ? ' bad' : ''}${focused.value === c.ID ? ' selected' : ''}`,
      dataset: { id: c.ID },
      onClick: () => { focused.next = c.ID; },
      onDblclick: () => openDetail(c, 'overview'),
      onContextmenu: (e) => {
        e.preventDefault();
        focused.next = c.ID;
        deps.menu(e.clientX, e.clientY, rowMenu(c));
      },
    }, [
      h('input', { type: 'checkbox', class: 'dk-check',
        checked: checked.value.has(c.ID),
        onChange: (e) => toggleOne(c.ID, e.target.checked),
        onClick: (e) => e.stopPropagation(),
      }),
      h('div', { class: 'dk-name' }, [
        h('span', { class: `dk-dot ${g === 'paused' ? 'paused' : g}` }),
        h('span', { class: 'dk-name-text', text: c.Names || c.ID, title: `${c.Names}\n${c.ID}` }),
      ]),
      h('div', { class: 'dk-img', text: c.Image || '-', title: c.Image }),
      h('div', { class: 'dk-num', text: st ? st.CPUPerc : '' }),
      h('div', { class: 'dk-num', text: st ? st.MemUsage : '' }),
      h('div', { class: 'dk-state', text: c.Status || c.State, title: c.Status }),
      h('div', { class: 'dk-ports', text: c.Ports || '-', title: c.Ports }),
    ]);
  }

  function groupHead(g, gr) {
    const sel = checked.value;
    const allChecked = gr.length > 0 && gr.every((c) => sel.has(c.ID));
    return h('label', {
      key: `g-${g}`,
      class: `dk-group${g === 'bad' ? ' bad' : ''}`,
    }, [
      h('input', { type: 'checkbox', class: 'dk-check',
        checked: allChecked,
        onChange: (e) => toggleGroup(g, e.target.checked),
      }),
      h('span', { text: groupLabel(g) }),
      h('span', { class: 'dk-group-count', text: `${gr.length}` }),
    ]);
  }

  function scrollTree() {
    const all = list.value;
    if (loading.value && !all.length) {
      return h('div', { class: 'qx-card-scroll' }, [spinner(t('app.docker.list-loading'))]);
    }
    if (error.value && !all.length) {
      return h('div', { class: 'qx-card-scroll' }, [
        errorState(error.value),
        h('div', { style: { textAlign: 'center' } }, [
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-retry'), onClick: () => refresh() }),
        ]),
      ]);
    }
    const rows = shownList();
    if (!rows.length) {
      return h('div', { class: 'qx-card-scroll' }, [
        emptyState(all.length ? t('app.docker.empty-no-match') : t('app.docker.empty-none')),
      ]);
    }
    const nodes = [];
    for (const g of GROUP_ORDER) {
      const gr = rows.filter((c) => containerGroup(c) === g);
      if (!gr.length) continue;
      nodes.push(groupHead(g, gr));
      nodes.push(...gr.map(rowNode));
    }
    return h('div', { class: 'qx-card-scroll' }, nodes);
  }

  function batchBar() {
    const n = checked.value.size;
    if (!n) return null;
    const ids = () => [...checked.value];
    return h('div', { class: 'dk-batch' }, [
      h('span', { class: 'dk-batch-count', text: tf('app.docker.count-selected', { v1: n }) }),
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-start'), onClick: () => batchAction('start') }),
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-stop'), onClick: () => batchAction('stop') }),
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-restart'), onClick: () => batchAction('restart') }),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        text: t('app.docker.action-exec-batch'),
        onClick: () => openExecDialog(ids()),
      }),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        text: t('app.docker.action-rebuild'),
        onClick: () => recreateDialog(ids()),
      }),
      h('button', {
        class: 'btn btn-ghost btn-sm btn-text-danger',
        text: t('app.docker.action-delete'),
        onClick: () => batchRemove(),
      }),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        text: t('app.docker.action-clear-selection'),
        onClick: () => clearChecked(),
      }),
    ]);
  }

  function listTree() {
    return card(t('app.docker.label-containers'), [
      h('div', { class: 'qx-card-tools dk-toolbar' }, [
        searchBox(t('app.docker.search-placeholder'), (v) => { search.next = v.toLowerCase(); }),
        chipGroup(FILTERS.map((f) => ({ id: f.id, label: t(f.key) })),
          filter.value, (id) => { filter.next = id; }),
      ]),
      batchBar(),
      scrollTree(),
    ], { fill: true, tools: h('span', { class: 'qx-count', text: tf('app.docker.containers-count', { v1: list.value.length }) }) });
  }

  function rowMenu(c) {
    const g = containerGroup(c);
    const items = [];
    if (g !== 'running' && g !== 'paused') {
      items.push({ icon: 'play', label: t('app.docker.action-start'), onClick: () => runAction('start', [c.ID]) });
    }
    if (g === 'running') {
      items.push({ icon: 'stop', label: t('app.docker.action-stop'), onClick: () => runAction('stop', [c.ID]) });
      items.push({ icon: 'refresh', label: t('app.docker.action-restart'), onClick: () => runAction('restart', [c.ID]) });
      items.push({ icon: 'circle-minus', label: t('app.docker.action-pause'), onClick: () => runAction('pause', [c.ID]) });
    }
    if (g === 'paused') {
      items.push({ icon: 'play', label: t('app.docker.action-resume'), onClick: () => runAction('unpause', [c.ID]) });
      items.push({ icon: 'refresh', label: t('app.docker.action-restart'), onClick: () => runAction('restart', [c.ID]) });
    }
    items.push('sep');
    items.push({ icon: 'list', label: t('app.docker.action-logs'), onClick: () => openDetail(c, 'logs') });
    items.push({ icon: 'terminal', label: t('app.docker.action-terminal'), disabled: g !== 'running' && g !== 'paused', onClick: () => openDetail(c, 'term') });
    items.push({ icon: 'chart', label: t('app.docker.action-stats'), disabled: g !== 'running', onClick: () => openDetail(c, 'stats') });
    items.push({ icon: 'terminal-prompt', label: t('app.docker.action-exec'), onClick: () => openExecDialog([c.ID]) });
    items.push('sep');
    if (g === 'running' || g === 'paused') {
      items.push({ icon: 'warning', label: t('app.docker.action-kill-risky'), danger: true, onClick: () => runAction('kill', [c.ID]) });
    }
    items.push({ icon: 'repeat', label: t('app.docker.action-rebuild'), onClick: () => recreateDialog([c.ID]) });
    items.push({ icon: 'trash', label: t('app.docker.action-delete-ellipsis'), danger: true, onClick: () => removeDialog([c.ID]) });
    return items;
  }

  async function runAction(action, ids, extra = {}) {
    try {
      await deps.auth(() => api.dockerContainerAction({
        host: deps.host(), action, ids, ...extra,
      }));
      toast(tf('app.docker.action-done', { v1: (labelOf(action)) }), 'success');
      await refresh();
      if (detail && ids.includes(detail.id)) detail.syncState();
    } catch (e) {
      toast(tf('app.docker.action-failed', { v1: (labelOf(action)), v2: (e.message) }), 'error');
    }
  }

  function labelOf(action) {
    return { start: t('app.docker.action-start'), stop: t('app.docker.action-stop'), restart: t('app.docker.action-restart'), pause: t('app.docker.action-pause'), unpause: t('app.docker.action-resume'), kill: t('app.docker.action-kill'), rm: t('app.docker.action-delete') }[action] || action;
  }

  async function removeDialog(ids) {
    const v = await deps.checkConfirm(
      ids.length > 1 ? tf('app.docker.confirm-delete-many', { v1: (ids.length) }) : t('app.docker.confirm-delete-one'),
      t('app.docker.confirm-delete-body'),
      [
        { key: 'volumes', label: t('app.docker.field-delete-volumes') },
        { key: 'force', label: t('app.docker.field-force-delete') },
      ],
      t('app.docker.action-delete'),
    );
    if (!v) return;
    await runAction('rm', ids, { volumes: v.volumes, force: v.force });
    if (detail && ids.includes(detail.id)) closeDetail();
  }

  async function batchAction(action) {
    const ids = [...checked.value];
    if (!ids.length) return;
    await runAction(action, ids);
  }

  async function batchRemove() {
    const ids = [...checked.value];
    if (!ids.length) return;
    await removeDialog(ids);
    clearChecked();
  }

  function nameOf(id) {
    const c = list.value.find((x) => x.ID === id);
    return c ? (c.Names || id) : id;
  }

  function openExecDialog(ids) {
    if (!ids.length) return;
    const cmdRef = { current: null };
    const busy = signal(false);
    const result = signal(null);

    async function run() {
      const el = cmdRef.current;
      const cmd = el ? String(el.value || '').trim() : '';
      if (!cmd) { toast(t('app.docker.exec-no-command'), 'warning'); return; }
      busy.next = true;
      result.next = null;
      try {
        const r = await deps.auth(() => api.dockerContainersExec({ host: deps.host(), ids, cmd }));
        result.next = {
          sum: tf('app.docker.exec-summary', { v1: (r.succeeded ?? 0), v2: (r.failed ?? 0) }),
          items: (r.results || []).map((res) => ({
            ok: !!res.ok,
            name: nameOf(res.id),
            title: res.id,
            out: res.out || '',
            err: res.error || '',
          })),
        };
      } catch (e) {
        result.next = { err: e.message || String(e) };
      }
      busy.next = false;
    }

    function ExecBody() {
      const r = result.value;
      return h('div', { class: 'confirm-body' }, [
        h('div', { class: 'confirm-title', text: tf('app.docker.exec-title', { v1: (ids.length) }) }),
        h('div', { class: 'confirm-desc', text: t('app.docker.exec-body') }),
        h(CodeEditor, {
          inputRef: cmdRef,
          cls: 'dk-exec-input',
          lang: 'sh',
          rows: 4,
          maxRows: 10,
          placeholder: t('app.docker.exec-placeholder'),
          onSubmit: () => { if (!busy.value) run(); },
        }),
        busy.value ? spinner(tf('app.docker.exec-running', { v1: (ids.length) }))
          : (r ? (r.err ? errorState(r.err) : execResults(r.items, { sum: r.sum })) : null),
      ]);
    }

    function RunBtn() {
      return h('button', {
        class: 'btn btn-primary btn-sm',
        text: busy.value ? t('app.docker.exec-in-progress') : t('app.docker.action-exec-confirm'),
        disabled: busy.value,
        onClick: run,
      });
    }

    const dlg = dialog({
      cls: 'dk-exec-dialog',
      body: [h(ExecBody, {})],
      actions: [
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-close'), onClick: () => dlg.close() }),
        h(RunBtn, {}),
      ],
    });
    setTimeout(() => cmdRef.current?.focus(), 0);
  }

  async function recreateDialog(ids) {
    if (!ids.length) return;
    const v = await deps.checkConfirm(
      ids.length > 1 ? tf('app.docker.confirm-rebuild-many', { v1: (ids.length) }) : tf('app.docker.confirm-rebuild-one', { v1: (nameOf(ids[0])) }),
      t('app.docker.confirm-rebuild-body'),
      [],
      t('app.docker.action-rebuild-confirm'),
    );
    if (!v) return;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await deps.auth(() => api.dockerContainerRecreate({ host: deps.host(), id }));
        const warns = (r && r.warnings) || [];
        if (warns.length) toast(tf('app.docker.rebuild-warned', { v1: (nameOf(id)), v2: (warns[0]) }), 'warning');
      } catch (e) {
        failed++;
        toast(tf('app.docker.rebuild-failed', { v1: (nameOf(id)), v2: (e.message) }), 'error');
      }
    }
    if (!failed) toast(ids.length > 1 ? tf('app.docker.rebuild-done-many', { v1: (ids.length) }) : t('app.docker.rebuild-done'), 'success');
    clearChecked();
    if (detail && ids.includes(detail.id)) closeDetail();
    await refresh();
  }

  function openDetail(c, tab = 'overview') {
    if (detail && detail.id === c.ID) {
      detail.show(tab);
      return;
    }
    closeDetail();
    detail = buildDetail(c);
    bodyEl.appendChild(splitter.el);
    bodyEl.appendChild(detail.host);
    splitter.restore();
    detail.show(tab);
  }

  function closeDetail() {
    if (!detail) return;
    detail.dispose();
    detail.host.remove();
    splitter.el.remove();
    detail = null;
  }

  function buildDetail(c) {
    const d = {
      id: c.ID,
      name: c.Names || c.ID,
      cur: signal(c),
      active: signal(''),
      inspect: signal({ loading: false, err: '', data: null }),
      built: {},
    };

    const tabRefs = new Map(DTABS.map((t) => [t.id, { current: null }]));
    const tabsRef = { current: null };
    const preRef = { current: null };
    const termWrapRef = { current: null };
    const termOverlay = signal({ text: '', retry: false });
    const statNote = signal(t('app.docker.stats-sampling-note'));
    const statValues = signal(['-', '-', '-', '-']);
    const canvasRefs = STAT_DEFS.map(() => ({ current: null }));
    const logSince = signal('');
    const logTail = signal('500');
    const logTimestamps = signal(false);
    const logFollow = signal(true);
    const logFoot = signal('');
    const logFilterRef = { current: null };
    const logBuf = createLineBuffer();

    const host = document.createElement('div');
    host.className = 'dk-detail';
    d.host = host;
    const view = createView(host);
    view.update(detailTree);

    async function ensureInspect() {
      if (d.inspect.value.data || d.inspect.value.err) return d.inspect.value.data;
      d.inspect.next = { loading: true, err: '', data: null };
      try {
        const res = await deps.auth(() => api.dockerInspect(deps.host(), d.id));
        d.inspect.next = { loading: false, err: '', data: res.container };
      } catch (e) {
        d.inspect.next = { loading: false, err: e.message || String(e), data: null };
      }
      return d.inspect.value.data;
    }

    function tabsTree() {
      const active = d.active.value;
      return h('div', { class: 'dk-tabs', ref: tabsRef }, DTABS.map((tab) => h('button', {
        key: tab.id,
        ref: tabRefs.get(tab.id),
        class: `dk-tab${active === tab.id ? ' active' : ''}`,
        type: 'button',
        text: t(tab.key),
        onClick: () => d.show(tab.id),
      })));
    }

    function scrollTabIntoView(id) {
      const strip = tabsRef.current;
      const b = tabRefs.get(id).current;
      if (!strip || !b) return;
      const tr = strip.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      if (br.left < tr.left) strip.scrollLeft -= (tr.left - br.left) + 8;
      else if (br.right > tr.right) strip.scrollLeft += (br.right - tr.right) + 8;
    }

    function paneTree(id) {
      if (id === 'overview') return overviewTree();
      if (id === 'logs') return logsTree();
      if (id === 'term') return h(TermPane, {});
      if (id === 'stats') return statsTree();
      if (id === 'env') return inspectTree(t('app.docker.detail-env'), renderEnv);
      if (id === 'mounts') return inspectTree(t('app.docker.detail-volumes'), renderMounts);
      return inspectTree(t('app.docker.detail-networks'), renderNet);
    }

    function panesTree() {
      const active = d.active.value;
      return h('div', { class: 'dk-panes' }, DTABS.map((tab) => h('div', {
        key: tab.id,
        class: `dk-pane${PLAIN_PANES.has(tab.id) ? ' dk-pane-plain' : ''}${active === tab.id ? ' active' : ''}`,
        dataset: { pane: tab.id },
      }, paneTree(tab.id))));
    }

    function detailTree() {
      return h(Fragment, {}, [headTree(), tabsTree(), panesTree()]);
    }

    function headTree() {
      const cur = d.cur.value;
      const g = containerGroup(cur);
      const dotCls = g === 'stopped' ? '' : g;
      return h('div', { class: 'dk-detail-head' }, [
        h('div', { class: 'dk-detail-head-main' }, [
          h('div', { class: 'dk-detail-title-row' }, [
            h('div', { class: 'dk-detail-title', text: d.name }),
            h('span', { class: `dk-svc-state${dotCls ? ` ${dotCls}` : ''}` }, [
              h('span', { class: `dk-dot${dotCls ? ` ${dotCls}` : ''}` }),
              h('span', { text: g ? groupLabel(g) : (cur.State || '-') }),
            ]),
          ]),
          h('div', { class: 'dk-detail-sub' }, [
            h('span', { text: cur.Image || '' }),
            h('span', { class: 'mono', text: d.id.slice(0, 12) }),
          ]),
        ]),
        h('button', {
          class: 'qx-ibtn',
          dataset: { tip: t('app.docker.detail-close') },
          html: icon('close', 'qicon qicon-sm'),
          onClick: () => closeDetail(),
        }),
      ]);
    }

    function overviewTree() {
      const st = d.inspect.value;
      const ins = st.data;
      if (st.loading || (!ins && !st.err)) return [spinner(t('app.docker.detail-loading'))];
      const cur = d.cur.value;
      const g = containerGroup(cur);
      const actions = [];
      const addBtn = (label, cls, fn) => actions.push(h('button', {
        class: `btn btn-sm ${cls}`, text: label, onClick: fn,
      }));
      if (g !== 'running' && g !== 'paused') addBtn(t('app.docker.action-start'), 'btn-primary', () => runAction('start', [d.id]));
      if (g === 'running') {
        addBtn(t('app.docker.action-stop'), 'btn-ghost', () => runAction('stop', [d.id]));
        addBtn(t('app.docker.action-restart'), 'btn-ghost', () => runAction('restart', [d.id]));
        addBtn(t('app.docker.action-pause'), 'btn-ghost', () => runAction('pause', [d.id]));
        addBtn(t('app.docker.action-kill'), 'btn-ghost btn-text-danger', () => runAction('kill', [d.id]));
      }
      if (g === 'paused') addBtn(t('app.docker.action-resume'), 'btn-primary', () => runAction('unpause', [d.id]));
      addBtn(t('app.docker.action-delete-ellipsis'), 'btn-ghost btn-text-danger', () => removeDialog([d.id]));

      const rows = [
        h('div', { class: 'dk-actions' }, actions),
        h('div', { class: 'cmp-section-title', text: t('app.docker.detail-basic') }),
        keyValue(t('app.docker.detail-status'), fmtStatus(cur.Status) || fmtStatus(cur.State)),
        keyValue(t('app.docker.detail-id'), d.id, { mono: true }),
        keyValue(t('app.docker.detail-image'), cur.Image, { mono: true }),
        keyValue(t('app.docker.detail-created'), cur.CreatedAt, { mono: true }),
        keyValue(t('app.docker.detail-command'), cur.Command, { mono: true }),
        h('div', { class: 'cmp-section-title', text: t('app.docker.detail-runtime') }),
        keyValue(t('app.docker.detail-uptime'), cur.RunningFor),
        keyValue(t('app.docker.detail-ports'), cur.Ports || '-', { mono: true }),
      ];
      if (ins) {
        rows.push(keyValue(t('app.docker.detail-restart-policy'), ins.HostConfig?.RestartPolicy?.Name || '-'));
        const ip = ins.NetworkSettings?.IPAddress
          || Object.values(ins.NetworkSettings?.Networks || {})[0]?.IPAddress || '';
        rows.push(keyValue(t('app.docker.detail-ip'), ip || '-', { mono: true }));
        rows.push(keyValue(t('app.docker.detail-elevated'), ins.HostConfig?.Privileged ? t('app.docker.yes') : t('app.docker.no')));
        rows.push(keyValue(t('app.docker.detail-env'), tf('app.docker.env-count', { v1: ((ins.Config?.Env || []).length) })));
      } else if (st.err) {
        rows.push(keyValue(t('app.docker.detail-failed'), st.err));
      }
      return rows;
    }

    function inspectTree(title, renderFn) {
      const st = d.inspect.value;
      if (st.loading || (!st.data && !st.err)) return [spinner(tf('app.docker.detail-section-loading', { v1: title }))];
      if (st.err) return [errorState(st.err)];
      if (!st.data) return [emptyState(tf('app.docker.detail-section-empty', { v1: title }))];
      return renderFn(st.data);
    }

    function renderEnv(ins) {
      const env = ins.Config?.Env || [];
      if (!env.length) return [emptyState(t('app.docker.env-none'))];
      return env.map((kv) => {
        const i = kv.indexOf('=');
        return i < 0
          ? keyValue(kv, '')
          : keyValue(kv.slice(0, i), kv.slice(i + 1), { mono: true });
      });
    }

    function renderMounts(ins) {
      const mounts = ins.Mounts || [];
      if (!mounts.length) return [emptyState(t('app.docker.vol-none'))];
      const out = [];
      for (const m of mounts) {
        out.push(h('div', { class: 'cmp-section-title', text: m.Name || m.Source || m.Type }));
        out.push(
          keyValue(t('app.docker.col-type'), m.Type),
          keyValue(t('app.docker.col-path-in-container'), m.Destination, { mono: true }),
          keyValue(t('app.docker.col-path-on-host'), m.Source || '-', { mono: true }),
          keyValue(t('app.docker.rw'), m.RW === false ? t('app.docker.ro') : t('app.docker.rw')),
        );
      }
      return out;
    }

    function renderNet(ins) {
      const nets = ins.NetworkSettings?.Networks || {};
      const names = Object.keys(nets);
      if (!names.length) return [emptyState(t('app.docker.net-none'))];
      const out = [];
      for (const n of names) {
        const v = nets[n];
        out.push(h('div', { class: 'cmp-section-title', text: n }));
        out.push(
          keyValue(t('app.docker.detail-ip'), v.IPAddress || '-', { mono: true }),
          keyValue(t('app.docker.col-gateway'), v.Gateway || '-', { mono: true }),
          keyValue(t('app.docker.col-mac'), v.MacAddress || '-', { mono: true }),
        );
      }
      return out;
    }

    function drawLog() {
      const pre = preRef.current;
      if (!pre) return;
      const input = logFilterRef.current;
      const shown = renderLog(pre, logBuf.get(), input ? String(input.value || '') : '');
      logFoot.next = tf('app.docker.logs-shown', { v1: shown, v2: (logBuf.count()) });
    }

    let logAbort = null;
    async function startLogs() {
      logAbort?.abort();
      logAbort = new AbortController();
      logBuf.clear();
      drawLog();
      logFoot.next = t('app.docker.logs-connecting');
      try {
        await api.dockerLogsStream(deps.host(), d.id, {
          follow: logFollow.value,
          tail: logTail.value,
          since: logSince.value,
          timestamps: logTimestamps.value,
        }, {
          signal: logAbort.signal,
          onChunk: (t) => { logBuf.push(t); drawLog(); },
        });
        logFoot.next = tf('app.docker.logs-ended', { v1: (logBuf.count()) });
      } catch (e) {
        if (e.name === 'AbortError') return;
        logFoot.next = tf('app.docker.logs-interrupted', { v1: (e.message) });
        if (e.status === 403 && e.code !== 'permission') toast(t('app.docker.logs-needs-root'), 'warning');
      }
    }

    function logsTree() {
      const restart = () => startLogs();
      return [
        h('div', { class: 'dk-log-bar' }, [
          h('label', { class: 'dk-host' }, [
            h('span', { text: t('app.docker.col-time') }),
            h('select', {
              class: 'select',
              onChange: (e) => { logSince.next = e.target.value; restart(); },
            }, [
              h('option', { value: '', text: t('app.docker.since-all') }),
              h('option', { value: '15m', text: t('app.docker.since-15m') }),
              h('option', { value: '1h', text: t('app.docker.since-1h') }),
              h('option', { value: '6h', text: t('app.docker.since-6h') }),
              h('option', { value: '24h', text: t('app.docker.since-24h') }),
            ]),
          ]),
          h('label', { class: 'dk-host' }, [
            h('span', { text: t('app.docker.label-lines') }),
            h('select', {
              class: 'select',
              onChange: (e) => { logTail.next = e.target.value; restart(); },
            }, [
              h('option', { value: '100', text: t('app.docker.tail-100') }),
              h('option', { value: '500', text: t('app.docker.tail-500'), selected: 'selected' }),
              h('option', { value: '2000', text: t('app.docker.tail-2000') }),
            ]),
          ]),
          h('label', { class: 'dk-host' }, [
            h('input', { type: 'checkbox', class: 'dk-check',
              checked: logTimestamps.value,
              onChange: (e) => { logTimestamps.next = e.target.checked; restart(); },
            }),
            h('span', { text: t('app.docker.label-timestamp') }),
          ]),
          h('label', { class: 'dk-host' }, [
            h('input', { type: 'checkbox', class: 'dk-check',
              checked: logFollow.value,
              onChange: (e) => { logFollow.next = e.target.checked; restart(); },
            }),
            h('span', { text: t('app.docker.follow') }),
          ]),
          h('div', { class: 'qx-search' }, [
            h('span', { html: icon('search', 'qicon qicon-sm') }),
            h('input', {
              ref: logFilterRef,
              class: 'input',
              type: 'search',
              placeholder: t('app.docker.keyword-filter'),
              onInput: () => drawLog(),
            }),
          ]),
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-reload'), onClick: restart }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            text: t('app.docker.action-clear'),
            onClick: () => { logBuf.clear(); drawLog(); },
          }),
        ]),
        h('pre', { class: 'dk-log-pre', ref: preRef }),
        h('div', { class: 'dk-log-foot' }, [h('span', { text: logFoot.value })]),
      ];
    }

    function TermPane() {
      return h('div', { class: 'dk-term-wrap' }, [
        h('div', { class: 'dk-term', ref: termWrapRef }),
        termOverlayNode(),
      ]);
    }

    function termOverlayNode() {
      const ov = termOverlay.value;
      if (!ov.text) return null;
      return h('div', { class: 'dk-term-overlay' }, [
        h('div', { text: ov.text }),
        ov.retry
          ? h('button', {
            class: 'btn btn-ghost btn-sm',
            text: t('app.docker.action-reconnect'),
            onClick: () => { termOverlay.next = { text: '', retry: false }; connectTerm(); },
          })
          : null,
      ].filter(Boolean));
    }

    let closed = false;

    function showTermOverlay(text, withRetry) {
      termOverlay.next = { text, retry: !!withRetry };
    }

    function hideTermOverlay() {
      termOverlay.next = { text: '', retry: false };
    }

    async function connectTerm() {
      if (closed || !d.term) return;
      d.term.settled = false;
      try { d.term.fit.fit(); } catch { }
      let url;
      try {
        await deps.auth(() => api.dockerProbe(deps.host()));
        url = api.dockerExecWSUrl(deps.host(), d.id, d.term.term.cols, d.term.term.rows);
      } catch (e) {
        d.term.settled = true;
        showTermOverlay((e && e.message) || t('app.docker.terminal-connect-failed'), true);
        return;
      }
      const term = d.term.term;
      const ws = new WebSocket(url);
      d.term.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        d.term.openedOnce = true;
        hideTermOverlay();
        ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }));
        term.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.t === 'exit') {
              d.term.settled = true;
              showTermOverlay(tf('app.docker.terminal-session-exited', { v1: (msg.code) }), true);
              return;
            }
            if (msg.t === 'err') {
              d.term.settled = true;
              showTermOverlay(msg.m || t('app.docker.terminal-connect-failed'), true);
              return;
            }
          } catch { }
          term.write(ev.data);
          return;
        }
        term.write(new Uint8Array(ev.data));
      };
      ws.onerror = () => { };
      ws.onclose = () => {
        if (closed || d.term.settled) return;
        showTermOverlay(d.term.openedOnce ? t('app.docker.terminal-disconnected') : t('app.docker.terminal-no-session'), true);
      };
    }

    function buildTerm() {
      const Term = window.Terminal;
      const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
      if (!Term || !FitAddon) {
        showTermOverlay(t('app.docker.terminal-component-failed'), false);
        return;
      }
      const term = new Term({
        fontSize: 12.5,
        scrollback: 5000,
        convertEol: false,
        cursorBlink: true,
        theme: termTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const wrap = termWrapRef.current;
      if (!wrap) return;
      term.open(wrap);
      d.term = {
        term, fit, ws: null, closed: false, openedOnce: false, settled: false,
        ro: null, fitOnResize: null,
      };
      term.onData((data) => {
        const ws = d.term.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'in', d: data }));
        }
      });
      d.term.fitOnResize = throttle(() => {
        if (closed || d.active.value !== 'term') return;
        try {
          fit.fit();
          const ws = d.term.ws;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }));
          }
        } catch { }
      }, 100);
      d.term.ro = new ResizeObserver(d.term.fitOnResize);
      d.term.ro.observe(wrap);
      showTermOverlay(t('app.docker.terminal-connecting'), false);
      connectTerm();
    }

    function statsTree() {
      const values = statValues.value;
      return [
        h('div', { class: 'dk-charts' }, STAT_DEFS.map((def, i) => h('div', { key: def.key, class: 'dk-chart' }, [
          h('div', { class: 'dk-chart-head' }, [
            h('span', { class: 'dk-chart-title', text: def.titleKey ? t(def.titleKey) : def.title }),
            h('span', { class: 'dk-chart-value', text: values[i] }),
          ]),
          h('canvas', { ref: canvasRefs[i] }),
        ]))),
        h('div', { class: 'dk-stats-note', text: statNote.value }),
      ];
    }

    const samples = { cpu: [], mem: [], net: [], disk: [] };
    let lastNet = null;
    let lastBlk = null;
    let statsTimer = null;

    async function pollStats() {
      if (closed) return;
      try {
        const res = await deps.auth(() => api.dockerStats(deps.host(), d.id));
        const s = (res.stats || [])[0];
        if (!s) return;
        const mem = parseMemUsage(s.MemUsage);
        const io = parsePairIO(s.NetIO);
        const blk = parsePairIO(s.BlockIO);
        const push = (arr, v) => { arr.push(v); if (arr.length > 60) arr.shift(); };
        push(samples.cpu, parsePercent(s.CPUPerc) ?? 0);
        push(samples.mem, mem ? mem.used : 0);
        const prevNet = lastNet;
        const prevBlk = lastBlk;
        lastNet = io;
        lastBlk = blk;
        if (io && prevNet) {
          push(samples.net, Math.max(0, (io[0] + io[1] - prevNet[0] - prevNet[1]) / 3));
        } else push(samples.net, 0);
        if (blk && prevBlk) {
          push(samples.disk, Math.max(0, (blk[0] + blk[1] - prevBlk[0] - prevBlk[1]) / 3));
        } else push(samples.disk, 0);

        statValues.next = [s.CPUPerc || '-', s.MemUsage || '-', s.NetIO || '-', s.BlockIO || '-'];
        drawSpark(canvasRefs[0].current, samples.cpu, { max: 100 });
        drawSpark(canvasRefs[1].current, samples.mem, {});
        drawSpark(canvasRefs[2].current, samples.net, {});
        drawSpark(canvasRefs[3].current, samples.disk, {});
      } catch (e) {
        statNote.next = tf('app.docker.sampling-failed', { v1: (e.message) });
      }
    }

    function startStats() {
      if (statsTimer) return;
      statsTimer = createPoller(pollStats, 3000);
      statsTimer.start();
    }

    function stopStats() {
      statsTimer?.dispose();
      statsTimer = null;
    }

    function initPane(tab) {
      if (d.built[tab]) return;
      d.built[tab] = true;
      if (RUNTIME_PANES.has(tab)) {
        if (tab === 'logs') startLogs();
        else if (tab === 'term') buildTerm();
        else startStats();
      } else if (INSPECT_PANES.has(tab)) {
        ensureInspect();
      }
    }

    d.show = (tab) => {
      d.active.next = tab;
      initPane(tab);
      if (tab === 'stats') startStats();
      else stopStats();
      if (tab === 'term' && d.term) setTimeout(() => { try { d.term.fit.fit(); } catch { } }, 30);
      scrollTabIntoView(tab);
    };

    d.syncState = () => {
      const c = list.value.find((x) => x.ID === d.id);
      if (!c) {
        closeDetail();
        return;
      }
      d.cur.next = c;
    };

    d.dispose = () => {
      closed = true;
      stopStats();
      logAbort?.abort();
      if (d.term) {
        d.term.fitOnResize?.cancel();
        d.term.ro?.disconnect();
        try { d.term.ws && d.term.ws.close(); } catch { }
        try { d.term.term.dispose(); } catch { }
      }
      view.unmount();
    };

    return d;
  }

  function drawSpark(canvas, data, { max } = {}) {
    if (!canvas || !canvas.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 200;
    const hgt = canvas.clientHeight || 52;
    if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
      canvas.width = w * dpr;
      canvas.height = hgt * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!data.length) return;
    const cs = getComputedStyle(document.documentElement);
    const color = (cs.getPropertyValue('--primary') || '#0037ff').trim();
    const grid = (cs.getPropertyValue('--hairline') || 'rgba(0,0,0,.1)').trim();
    const top = max || Math.max(...data) * 1.2 || 1;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hgt - 0.5);
    ctx.lineTo(w, hgt - 0.5);
    ctx.stroke();
    const step = data.length > 1 ? w / (data.length - 1) : w;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step;
      const y = hgt - Math.min(1, v / top) * (hgt - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo((data.length - 1) * step, hgt);
    ctx.lineTo(0, hgt);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  startWatch();

  return {
    el: bodyEl,
    refresh,
    closeDetail,
    statusBits() {
      const all = list.value;
      const run = all.filter((c) => containerGroup(c) === 'running').length;
      const bad = all.filter((c) => containerGroup(c) === 'bad').length;
      const bits = [
        { text: tf('app.docker.stat-total-value', { v1: (all.length) }), tip: t('app.docker.stat-total') },
        { text: tf('app.docker.stat-running', { v1: run }), tip: t('app.docker.stat-running-hint') },
      ];
      if (bad) bits.push({ text: tf('app.docker.stat-dead', { v1: bad }), tip: t('app.docker.stat-dead-hint') });
      if (statsError.value) bits.push({ text: t('app.docker.stats-unavailable'), tip: t('app.docker.stats-no-permission') });
      return bits;
    },
    dispose: () => {
      stopWatch();
      closeDetail();
      splitter.destroy();
      view.unmount();
    },
  };
}