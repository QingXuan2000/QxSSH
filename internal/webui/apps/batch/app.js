import { bootApp } from '/assets/js/app-bridge.js';

import { h, Fragment, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import { runMany } from '/assets/js/core/appkit.js';
import { CodeEditor } from '/assets/js/core/code-editor.js';
import { getState, loadHosts, subscribe } from '/assets/js/core/store.js';
import { card, field, statusBar, execResults, sidebarSections } from '/assets/js/core/components.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import { setupI18n, t, tf } from '/assets/js/core/i18n.js';

function boot(el, ctx) {
  const hosts = signal([]);
  const checked = signal(new Set());
  const command = signal('');
  const running = signal(false);
  const results = signal(null);
  const executionError = signal(null);
  const timeout = { value: '60' };

  const allChecked = () => hosts.value.length > 0 && hosts.value.every((hh) => checked.value.has(hh.id));
  const canRun = () => !running.value && checked.value.size > 0 && command.value.trim() !== '';

  function toggleHost(id, on) {
    const s = new Set(checked.value);
    if (on) s.add(id);
    else s.delete(id);
    checked.next = s;
  }

  function toggleAll() {
    checked.next = allChecked() ? new Set() : new Set(hosts.value.map((hh) => hh.id));
  }

  async function run() {
    if (running.value) return;
    const cmd = command.value.trim();
    const ids = [...checked.value];
    if (!cmd) { toast(t('app.batch.err-no-command'), 'error'); return; }
    if (!ids.length) { toast(t('app.batch.err-no-host'), 'error'); return; }
    running.next = true;
    results.next = null;
    executionError.next = null;
    try {
      const byId = new Map(hosts.value.map((hh) => [hh.id, hh]));
      const targets = ids.map((id) => ({ id, name: (byId.get(id) || {}).name || id }));
      results.next = await runMany(targets, cmd, { timeout: parseInt(timeout.value, 10) || 60 });
    } catch (e) {
      executionError.next = e.message || t('app.batch.err-failed');
      toast(tf('app.batch.err-failed-detail', { v1: (executionError.value) }), 'error');
    } finally {
      running.next = false;
    }
  }

  function sideTree() {
    return h(Fragment, {}, [
      h('div', { class: 'qx-side-head' }, [
        h('span', { text: t('app.batch.sidebar-hosts') }),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          text: allChecked() ? t('app.batch.action-clear') : t('app.batch.action-select-all'),
          onClick: toggleAll,
        }),
      ]),
      hosts.value.length
        ? sidebarSections([{
          items: hosts.value.map((hh) => ({
            id: hh.id,
            label: hh.name,
            active: checked.value.has(hh.id),
            lead: h('input', {
              type: 'checkbox',
              checked: checked.value.has(hh.id),
              onChange: (e) => toggleHost(hh.id, e.target.checked),
            }),
          })),
        }], null, () => {})
        : h('div', { class: 'qx-side-note', text: t('app.batch.sidebar-empty') }),
      h('div', { class: 'qx-side-note', text: tf('app.batch.count-selected', { v1: (checked.value.size), v2: (hosts.value.length) }) }),
    ]);
  }

  function resultCount() {
    if (running.value) return t('app.batch.status-running');
    if (executionError.value) return t('app.batch.err-failed');
    if (!results.value) return '';
    return tf('app.batch.count-results', { v1: (results.value.length) });
  }

  function resultTree() {
    if (running.value) {
      return h('div', { class: 'qx-card-scroll' }, [
        h('div', { class: 'qx-card-empty', text: t('app.batch.status-running-please-wait') }),
      ]);
    }
    if (executionError.value) {
      return h('div', { class: 'qx-card-scroll' }, [
        h('div', { class: 'qx-card-empty' }, [
          h('div', { text: t('app.batch.err-failed') }),
          h('div', { class: 'bt-error', text: executionError.value }),
        ]),
      ]);
    }
    if (!results.value) {
      return h('div', { class: 'qx-card-scroll' }, [
        h('div', { class: 'qx-card-empty' }, [
          h('div', { text: t('app.batch.empty-not-run') }),
          h('div', { class: 'bt-empty-desc', text: t('app.batch.empty-hint') }),
        ]),
      ]);
    }
    if (!results.value.length) {
      return h('div', { class: 'qx-card-scroll' }, [
        h('div', { class: 'qx-card-empty', text: t('app.batch.empty-no-result') }),
      ]);
    }
    return h('div', { class: 'qx-card-scroll' }, execResults(results.value.map((r) => ({
      ok: !!r.success,
      name: r.hostName || r.hostId,
      out: typeof r.output === 'string' ? r.output : '',
      err: typeof r.error === 'string' ? r.error : '',
      dur: r.durationMs != null ? `${r.durationMs} ms` : '',
    }))));
  }

  function mainTree() {
    const n = results.value ? results.value.length : 0;
    const ok = results.value ? results.value.filter((r) => r.success).length : 0;
    return h('div', { class: 'app-root' }, [
      h('div', { class: 'qx-scroll' }, [
        card(t('app.batch.title-execute'), [
          h('div', { class: 'bt-cmd-row' }, [
            field(t('app.batch.field-command'), h(CodeEditor, {
              cls: 'bt-cmd-input',
              lang: 'sh',
              rows: 4,
              maxRows: 12,
              placeholder: t('app.batch.command-placeholder'),
              value: command.value,
              onChange: (v) => { command.next = v; },
              onSubmit: () => { if (canRun()) run(); },
            })),
            field(t('app.batch.field-timeout'), h('input', {
              class: 'input bt-timeout',
              type: 'number',
              value: timeout.value,
              min: '1',
              max: '300',
              onInput: (e) => { timeout.value = e.target.value; },
            })),
          ]),
          h('div', { class: 'bt-foot' }, [
            h('button', {
              class: 'btn btn-primary btn-sm bt-run',
              text: t('app.batch.action-execute'),
              disabled: !canRun(),
              onClick: run,
            }),
          ]),
        ]),
        card(t('app.batch.title-results'), [resultTree()], {
          fill: true,
          tools: h('span', { class: 'qx-count', text: resultCount() }),
        }),
      ]),
      statusBar([
        tf('app.batch.count-selected', { v1: (checked.value.size), v2: (hosts.value.length) }),
        running.value ? t('app.batch.status-running') : (results.value ? tf('app.batch.status-results', { v1: n, v2: ok }) : t('app.batch.status-waiting')),
        tf('app.batch.status-timeout', { v1: (timeout.value || 60) }),
      ]),
    ]);
  }

  const hostsBox = document.createElement('div');
  const sideView = createView(hostsBox);
  sideView.update(sideTree);

  const shell = createAppShell(el, { tabs: [], sideTop: [hostsBox] });
  shell.setMain(mainTree);

  const unsubscribe = subscribe(() => {
    hosts.next = (getState().hosts || []).slice();
    const alive = new Set(hosts.value.map((hh) => hh.id));
    const s = new Set([...checked.value].filter((id) => alive.has(id)));
    if (s.size !== checked.value.size) checked.next = s;
  });
  loadHosts()
    .then(() => { hosts.next = (getState().hosts || []).slice(); })
    .catch((err) => {
      console.warn('[batch] 读取主机列表失败', err);
      toast(tf('app.batch.err-hosts-load', { v1: (err.message) }), 'error');
    });

  return () => {
    unsubscribe();
    sideView.unmount();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'batch',
}).catch(() => { }).then(() => {
  bootApp(({ root, hostId }) => boot(root, { hostId }));
});
