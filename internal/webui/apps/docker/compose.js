import { h, createView } from '/assets/js/core/vdom.js';
import { createPoller } from '/assets/js/core/dom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, chipGroup, dialog, emptyState, spinner,
} from '/assets/js/core/components.js';
import { icon } from '/assets/js/icons/index.js';
import { CodeEditor } from '/assets/js/core/code-editor.js';
import { getPref, setPref, delPref, prefSignal } from '/assets/js/core/prefs.js';
import * as api from './api.js';
import { callAppApi } from '/assets/js/app-bridge.js';
import { createLineBuffer, renderLog, stateLabel, fmtStatus, fmtHealth } from './format.js';
import { streamDialog } from './resources.js';
import { t, tf } from '/assets/js/core/i18n.js';

const DIR_KEY = 'qx-docker-dir';
const AUTO_KEY = 'qx-docker-autoref';
const LOGH_KEY = 'qx-docker-logh';

const AUTO_MS = 15000;
const LOGH_MIN = 140;
const LOGH_MAX = 900;

const ACTION_TITLE_KEYS = {
  up: 'app.docker.svc-start',
  down: 'app.docker.svc-stop',
  restart: 'app.docker.svc-restart',
  build: 'app.docker.build-title',
};

function actionTitle(act) {
  const key = ACTION_TITLE_KEYS[act];
  return key ? t(key) : act;
}

function stateDotClass(st) {
  if (st === 'running') return 'running';
  if (st === 'paused') return 'paused';
  if (st === 'dead' || st === 'restarting' || st === 'removing') return 'bad';
  return '';
}

export function createComposeView(deps) {
  const dir = prefSignal(DIR_KEY, '', { json: false });
  const status = signal(null);
  const loading = signal(false);
  const busy = signal(false);
  const error = signal('');
  const logService = signal('');
  const autoRef = signal(getPref(AUTO_KEY, 'on') !== 'off');

  const tail = signal('500');
  const follow = signal(true);
  const logFoot = signal(t('app.docker.none'));
  const logFilterRef = { current: null };
  const logPreRef = { current: null };
  const sectionRef = { current: null };
  const logBuf = createLineBuffer();

  let logAbort = null;
  let logsStarted = false;
  let detectRun = 0;
  let detectQueued = false;
  let lastSvcKey = '';
  let logsDir = '';
  let gripMove = null;
  let gripUp = null;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'dk-body';
  const view = createView(bodyEl);
  view.update(listTree);

  async function pickDir() {
    let p;
    try {
      p = await callAppApi('files', 'pick', {
        type: 'dir',
        start: dir.value,
        title: t('app.docker.pick-dir-title'),
      }, { autoOpen: true, timeout: 600000 });
    } catch (e) {
      if (e.code === 'timeout') toast(t('app.docker.pick-timeout'), 'error');
      else toast(t('app.docker.picker-failed') + (e.message || e), 'error');
      return;
    }
    if (!p) return;
    if (p !== dir.value) {
      dir.next = p;

      status.next = null;
      lastSvcKey = '';
      if (logsStarted) startLogs();
    }
    detect();
  }

  async function detect({ auto = false } = {}) {
    if (loading.value) { detectQueued = true; return; }
    const d = dir.value;
    if (!d) { if (!auto) toast(t('app.docker.need-dir'), 'warning'); return; }
    loading.next = true;
    if (!auto) error.next = '';
    const my = ++detectRun;
    try {
      const st = await deps.auth(() => api.dockerComposeStatus(deps.host(), d));
      if (my !== detectRun) return;
      status.next = st;
      error.next = '';
      const key = (st.services || []).join('\n');
      if (key !== lastSvcKey) {
        lastSvcKey = key;
        if (logService.value && !(st.services || []).includes(logService.value)) setLogService('');
      } else if (logsStarted && logsDir !== d) {
        startLogs();
      }
    } catch (e) {
      if (my !== detectRun) return;
      if (!(auto && status.value)) {
        status.next = null;
        error.next = e.message || String(e);
      }
    }
    loading.next = false;
    deps.changed();
    if (detectQueued) { detectQueued = false; detect(); }
  }

  function portsOf(c) {
    if (!c) return '-';
    if (c.Ports) return c.Ports;
    if (Array.isArray(c.Publishers) && c.Publishers.length) {
      return c.Publishers.map((p) =>
        `${p.PublishedPort ?? ''}${p.PublishedPort != null ? ':' : ''}${p.TargetPort}/${p.Protocol || 'tcp'}`).join(', ');
    }
    return '-';
  }

  function servicesTree(st) {
    const byService = new Map();
    for (const c of st.containers || []) byService.set(c.Service || '', c);
    const services = [...(st.services || [])];
    for (const c of st.containers || []) {
      if (c.Service && !services.includes(c.Service)) services.push(c.Service);
    }
    if (!services.length) return emptyState(t('app.docker.no-services'));

    const onBusy = busy.value;
    return h('div', { class: 'qx-card-scroll' }, [h('table', { class: 'qx-table' }, [
      h('thead', null, [h('tr', null, [
        h('th', { text: t('app.docker.col-service') }),
        h('th', { text: t('app.docker.col-status') }),
        h('th', { text: t('app.docker.down-scope-container') }),
        h('th', { text: t('app.docker.label-images') }),
        h('th', { text: t('app.docker.col-ports') }),
        h('th', { text: t('app.docker.col-description') }),
        h('th', { class: 'qx-actions-col', text: t('app.docker.col-actions') }),
      ])]),
      h('tbody', null, services.map((name) => {
        const c = byService.get(name);
        const stName = c ? (c.State ? stateLabel(c.State) : '-') : t('app.docker.svc-not-created');
        const sc = c ? stateDotClass(c.State) : '';
        const isRunning = !!(c && c.State === 'running');
        const moreRef = { current: null };
        return h('tr', {
          key: name,
          onDblclick: () => setLogService(name),
          onContextmenu: (e) => {
            e.preventDefault();
            deps.menu(e.clientX, e.clientY, [
              { icon: 'list', label: t('app.docker.menu-logs-service'), onClick: () => setLogService(name) },
              { icon: 'list', label: t('app.docker.menu-logs-all'), onClick: () => setLogService('') },
              'sep',
              { icon: 'play', label: t('app.docker.menu-start-service'), onClick: () => action('up', name) },
              { icon: 'stop', label: t('app.docker.menu-stop-service'), disabled: !c, onClick: () => action('down', name) },
              { icon: 'refresh', label: t('app.docker.menu-restart-service'), disabled: !c, onClick: () => action('restart', name) },
              { icon: 'download', label: t('app.docker.menu-build-service'), onClick: () => action('build', name) },
              'sep',
              { icon: 'edit', label: t('app.docker.action-edit-compose'), onClick: () => editFile() },
            ]);
          },
        }, [
          h('td', { class: 'mono', text: name }),
          h('td', null, [h('span', { class: `dk-svc-state${sc ? ` ${sc}` : ''}` }, [
            h('span', { class: `dk-dot ${sc}` }),
            h('span', { text: stName }),
          ])]),
          h('td', { class: 'mono', text: c ? (c.Name || '-') : '-' }),
          h('td', { text: c ? (c.Image || '-') : '-' }),
          h('td', { class: 'mono', text: portsOf(c) }),
          h('td', { text: c ? (fmtStatus(c.Status) || fmtHealth(c.Health) || '-') : '-' }),
          h('td', { class: 'qx-actions-col' }, [
            h('button', {
              class: 'btn btn-ghost btn-sm',
              text: t('app.docker.tab-logs'),
              onClick: () => setLogService(name),
            }),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              text: isRunning ? t('app.docker.action-stop') : t('app.docker.action-start'),
              disabled: onBusy,
              onClick: () => action(isRunning ? 'down' : 'up', name),
            }),
            h('button', {
              ref: moreRef,
              class: 'btn btn-ghost btn-sm',
              text: '⋯',
              title: t('app.docker.menu-more'),
              onClick: () => {
                const el = moreRef.current;
                const r = el ? el.getBoundingClientRect() : { left: 0, bottom: 0 };
                deps.menu(r.left, r.bottom + 4, [
                  { icon: 'refresh', label: t('app.docker.menu-restart-service'), disabled: !c, onClick: () => action('restart', name) },
                  { icon: 'download', label: t('app.docker.menu-build-service'), onClick: () => action('build', name) },
                  'sep',
                  { icon: 'edit', label: t('app.docker.action-edit-compose'), onClick: () => editFile() },
                ]);
              },
            }),
          ]),
        ]);
      })),
    ])]);
  }

  function detectErrTree() {
    const msg = String(error.value || t('app.docker.detect-failed'));
    const dirIssue = msg.includes(t('app.docker.not-found')) || msg.includes(t('app.docker.cannot-enter'));
    const retry = () => detect();
    return h('div', { class: 'cmp-state dk-detect-err' }, [
      h('div', { class: 'dk-detect-err-ic', html: icon(dirIssue ? 'folder' : 'info', 'qicon') }),
      h('div', { class: 'dk-detect-err-title', text: dirIssue ? t('app.docker.compose-missing') : t('app.docker.detect-failed') }),
      h('div', {
        class: 'dk-detect-err-desc',
        text: dirIssue
          ? t('app.docker.compose-missing-detail')
          : msg,
      }),
      h('div', { class: 'dk-detect-err-actions' }, (dirIssue
        ? [
          h('button', { class: 'btn btn-primary btn-sm', text: t('app.docker.action-repick-dir'), onClick: () => pickDir() }),
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-retry'), onClick: retry }),
        ]
        : [h('button', { class: 'btn btn-primary btn-sm', text: t('app.docker.action-retry'), onClick: retry })])),
    ]);
  }

  function countText() {
    const st = status.value;
    if (!st || loading.value) return '';
    const running = (st.containers || []).filter((c) => c.State === 'running').length;
    return tf('app.docker.services-summary', { v1: ((st.services || []).length), v2: running });
  }

  function dirBarTree() {
    const d = dir.value;
    const st = status.value;
    const idle = loading.value || busy.value;
    const noFile = !st || !st.file;
    const btn = (label, cls, fn, dis = idle || noFile) => h('button', {
      class: cls, text: label, disabled: dis, onClick: fn,
    });
    return h('div', { class: 'qx-card-tools dk-dirbar' }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-pick-dir'), onClick: () => pickDir() }),
      h('span', {
        class: `dk-dirpath mono${d ? '' : ' empty'}`,
        text: d || t('app.docker.dir-none'),
        title: d || t('app.docker.dir-none-hint'),
      }),
      h('label', { class: 'dk-host', title: t('app.docker.auto-refresh-hint') }, [
        h('input', { type: 'checkbox', class: 'dk-check',
          checked: autoRef.value,
          onChange: (e) => {
            autoRef.next = e.target.checked;
            setPref(AUTO_KEY, e.target.checked ? 'on' : 'off');
          },
        }),
        h('span', { text: t('app.docker.auto-refresh') }),
      ]),
      h('div', { class: 'dk-toolbar-actions' }, [
        btn(t('app.docker.action-start'), 'btn btn-primary btn-sm', () => action('up')),
        btn(t('app.docker.action-stop'), 'btn btn-ghost btn-sm', () => action('down')),
        btn(t('app.docker.action-restart'), 'btn btn-ghost btn-sm', () => action('restart')),
        btn(t('app.docker.action-build'), 'btn btn-ghost btn-sm', () => action('build')),
        btn(t('app.docker.action-edit-file'), 'btn btn-ghost btn-sm', () => editFile(), busy.value || noFile),
      ]),
    ]);
  }

  function svcBodyTree() {
    const st = status.value;
    if (loading.value && !st) {
      return h('div', { class: 'qx-card-scroll' }, [spinner(t('app.docker.detect-loading'))]);
    }
    if (error.value && !st) {
      return h('div', { class: 'qx-card-scroll' }, [detectErrTree()]);
    }
    if (!st) {
      return h('div', { class: 'qx-card-scroll' }, [
        emptyState(t('app.docker.detect-none-hint-pick')),
      ]);
    }
    return servicesTree(st);
  }

  function listTree() {
    return h('div', { class: 'dk-listcol' }, [
      card(t('app.docker.services-title'), [dirBarTree(), svcBodyTree()], {
        fill: true,
        tools: h('span', { class: 'qx-count', text: countText() }),
      }),
      h(LogSection, {}),
    ]);
  }

  async function action(act, service) {
    if (!dir.value) { toast(t('app.docker.need-detect'), 'warning'); return; }
    if (!status.value?.file) { toast(t('app.docker.compose-missing-short'), 'warning'); return; }
    if (busy.value) return;
    const scope = service ? tf('app.docker.down-title-svc', { v1: service }) : t('app.docker.down-scope-container');
    if (act === 'down') {
      const ok = await confirmAction(tf('app.docker.confirm-down', { v1: scope }), t('app.docker.confirm-down-body'), { okText: t('app.docker.action-stop'), danger: false });
      if (!ok) return;
    }
    busy.next = true;
    const d = dir.value;
    streamDialog({
      title: service ? `${actionTitle(act)}：${service}` : actionTitle(act),
      formNodes: [h('div', { class: 'help', text: tf('app.docker.dir-label', { v1: d }) })],
      start: ({ signal, write }) => api.dockerComposeActionStream(
        { host: deps.host(), dir: d, action: act, service: service || '' },
        { signal, onChunk: write },
      ),
      onDone: (ok) => {
        if (ok) {
          toast(service ? tf('app.docker.action-done-svc', { v1: service, v2: actionTitle(act) }) : tf('app.docker.action-done', { v1: actionTitle(act) }), 'success');
          deps.notify(tf('app.docker.compose-done', { v1: act }), service ? `${service} · ${d}` : d);
          detect();
          if (logsStarted && !follow.value) startLogs();
        }
      },
      onClose: () => { busy.next = false; },
      requestPerm: () => deps.requestPerm(),
    }).run();
  }

  async function editFile() {
    if (!status.value?.file) { toast(t('app.docker.compose-missing-short'), 'warning'); return; }
    let data;
    try {
      data = await deps.auth(() => api.dockerComposeFile(deps.host(), dir.value));
    } catch (e) {
      toast(tf('app.docker.read-failed', { v1: (e.message) }), 'error');
      return;
    }
    const taRef = { current: null };
    const saving = signal(false);
    const errMsg = signal('');

    async function save() {
      if (saving.value) return;
      const el = taRef.current;
      saving.next = true;
      errMsg.next = '';
      try {
        await deps.auth(() => api.dockerComposeFileSave({
          host: deps.host(),
          dir: dir.value,
          content: el ? el.value : '',
        }));
        toast(t('app.docker.compose-saved'), 'success');
        dlg.close();
        detect();
      } catch (e) {
        errMsg.next = e.message || String(e);
        saving.next = false;
      }
    }

    function Editor() {
      return h('div', null, [
        h(CodeEditor, {
          inputRef: taRef,
          cls: 'dk-editor',
          lang: 'yaml',
          rows: 18,
          maxRows: 40,
          value: data.content || '',
        }),
        errMsg.value ? h('div', { class: 'qx-sudo-err', text: errMsg.value }) : null,
      ]);
    }

    function SaveBtn() {
      return h('button', {
        class: 'btn btn-primary btn-sm',
        text: saving.value ? t('app.docker.status-saving') : t('app.docker.action-save'),
        disabled: saving.value,
        onClick: save,
      });
    }

    function CancelBtn() {
      return h('button', {
        class: 'btn btn-ghost btn-sm',
        text: t('app.docker.action-cancel'),
        disabled: saving.value,
        onClick: () => dlg.close(),
      });
    }

    const dlg = dialog({
      title: data.path || t('app.docker.compose-file'),
      body: [h(Editor, {})],
      actions: [h(CancelBtn, {}), h(SaveBtn, {})],
    });
    setTimeout(() => taRef.current?.focus(), 0);
  }

  function setLogService(name) {
    logService.next = name;
    startLogs();
  }

  let drawQueued = false;
  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawNow(); });
  }

  function drawNow() {
    const pre = logPreRef.current;
    if (!pre) return;
    const input = logFilterRef.current;
    const shown = renderLog(pre, logBuf.get(), input ? String(input.value || '') : '');
    logFoot.next = logBuf.count() ? tf('app.docker.logs-shown', { v1: shown, v2: (logBuf.count()) }) : t('app.docker.none');
  }

  async function startLogs() {
    const d = dir.value;
    if (!d) return;
    logAbort?.abort();
    logAbort = new AbortController();
    logsStarted = true;
    logsDir = d;
    logBuf.clear();
    drawNow();
    logFoot.next = t('app.docker.logs-connecting');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api.dockerComposeLogsStream(deps.host(), d, {
          service: logService.value,
          follow: follow.value,
          tail: tail.value,
        }, {
          signal: logAbort.signal,
          onChunk: (t) => { logBuf.push(t); draw(); },
        });
        logFoot.next = tf('app.docker.logs-ended', { v1: (logBuf.count()) });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (e.status === 403 && e.code !== 'permission' && attempt === 0 && (await deps.requestPerm())) continue;
        logFoot.next = tf('app.docker.logs-interrupted', { v1: (e.message) });
        if (e.status === 403 && e.code !== 'permission') toast(t('app.docker.logs-needs-root'), 'warning');
        return;
      }
    }
  }

  function unbindGrip() {
    if (!gripMove) return;
    document.removeEventListener('mousemove', gripMove);
    document.removeEventListener('mouseup', gripUp);
    gripMove = null;
    gripUp = null;
  }

  function bindGrip(startY) {
    unbindGrip();
    const el = sectionRef.current;
    const startH = el ? el.getBoundingClientRect().height : LOGH_MIN;
    const maxH = Math.max(LOGH_MIN, Math.min(LOGH_MAX, (el?.parentElement?.clientHeight || LOGH_MAX) - 180));
    const clamp = (v) => Math.min(maxH, Math.max(LOGH_MIN, v));
    gripMove = (ev) => {
      const node = sectionRef.current;
      if (!node) return;
      node.style.flexBasis = `${clamp(startH + (startY - ev.clientY))}px`;
    };
    gripUp = () => {
      unbindGrip();
      const node = sectionRef.current;
      if (node) setPref(LOGH_KEY, Math.round(node.getBoundingClientRect().height));
    };
    document.addEventListener('mousemove', gripMove);
    document.addEventListener('mouseup', gripUp);
  }

  function LogGrip() {
    const gripRef = { current: null };
    return h('div', {
      ref: gripRef,
      class: 'dk-log-grip',
      title: t('app.docker.logs-resize-hint'),
      onMousedown: (e) => {
        e.preventDefault();
        bindGrip(e.clientY);
      },
      onDblclick: () => {
        const el = sectionRef.current;
        if (el) el.style.flexBasis = '';
        delPref(LOGH_KEY);
      },
      onUnmount: () => unbindGrip(),
    });
  }

  function LogSection() {
    const names = status.value?.services || [];
    const saved = parseInt(getPref(LOGH_KEY), 10);
    return h('div', {
      class: 'dk-service-logs',
      ref: sectionRef,
      style: (saved >= LOGH_MIN && saved <= LOGH_MAX) ? { flexBasis: `${saved}px` } : {},
    }, [
      h(LogGrip, {}),
      h('div', { class: 'dk-log-bar' }, [
        chipGroup([
          { id: '', label: t('app.docker.filter-all') },
          ...names.map((n) => ({ id: n, label: n })),
        ], logService.value, setLogService),
        h('label', { class: 'dk-host' }, [
          h('span', { text: t('app.docker.label-lines') }),
          h('select', {
            class: 'select',
            onChange: (e) => { tail.next = e.target.value; startLogs(); },
          }, [
            h('option', { value: '200', text: t('app.docker.tail-200') }),
            h('option', { value: '500', text: t('app.docker.tail-500'), selected: 'selected' }),
            h('option', { value: '2000', text: t('app.docker.tail-2000') }),
          ]),
        ]),
        h('label', { class: 'dk-host' }, [
          h('input', { type: 'checkbox', class: 'dk-check',
            checked: follow.value,
            onChange: (e) => { follow.next = e.target.checked; startLogs(); },
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
            onInput: () => draw(),
          }),
        ]),
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-reload'), onClick: () => startLogs() }),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          text: t('app.docker.action-clear'),
          onClick: () => { logBuf.clear(); drawNow(); },
        }),
      ]),
      h('pre', { class: 'dk-log-pre', ref: logPreRef }),
      h('div', { class: 'dk-log-foot' }, [h('span', { text: logFoot.value })]),
    ]);
  }

  const autoTimer = createPoller(() => {
    if (!autoRef.value || !bodyEl.isConnected) return;
  if (loading.value || !dir.value || !status.value?.file) return;
  return detect({ auto: true });
}, AUTO_MS);
autoTimer.start();

  return {
    el: bodyEl,

    refresh: () => (dir.value ? detect() : Promise.resolve()),
    statusBits() {
      const st = status.value;
      if (error.value) return [{ text: t('app.docker.detect-failed'), tip: error.value }];
      if (!st) return [{ text: t('app.docker.detect-none'), tip: t('app.docker.detect-none-hint') }];
      const running = (st.containers || []).filter((c) => c.State === 'running').length;
      return [
        { text: tf('app.docker.services-count', { v1: ((st.services || []).length) }), tip: t('app.docker.stat-services-hint') },
        { text: tf('app.docker.services-running', { v1: running }), tip: t('app.docker.stat-running-hint') },
      ];
    },
    dispose() {
      logAbort?.abort();
      autoTimer.dispose();
      unbindGrip();
      view.unmount();
    },
  };
}