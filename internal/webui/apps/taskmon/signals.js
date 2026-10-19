import { h, useState } from '/assets/js/core/vdom.js';
import { toast, confirmAction, copyText as copyToClipboard } from '/assets/js/core/ui.js';
import { menu, dialog } from '/assets/js/core/components.js';
import { requestSudoElevation } from '/assets/js/core/sys.js';
import { taskmonSignal } from './api.js';
import { hostId, elevated, setElevated, refresh, toggleGroup } from './state.js';
import { t, tf } from '/assets/js/core/i18n.js';

const SIGNALS = ['TERM', 'KILL', 'HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'STOP', 'CONT', 'PIPE', 'ALRM', 'CHLD', 'WINCH', 'TRAP'];

const mi = (label, fn, opts = {}) => ({ label, icon: opts.icon, hint: opts.hint, danger: opts.danger, onClick: fn });
const mhead = (text) => ({ head: text });
const msep = () => ({ sep: true });

function openMenu(e, items) {
  menu(items, { x: e.clientX, y: e.clientY });
}

function copyText(text, okMsg) {
  copyToClipboard(text).then((ok) => {
    if (ok) toast(okMsg, 'success');
    else toast(t('app.taskmon.copy-failed') + text, 'warning');
  });
}

async function sendSignal(p, sig) {
  const attempt = () => taskmonSignal({
    host: hostId.value, pid: p.pid, signal: sig, sudo: elevated.value,
  });
  try {
    await attempt();
    toast(tf('app.taskmon.signal-sent', { v1: (p.name), v2: (p.pid), v3: sig }), 'success');
    refresh();
    return true;
  } catch (e) {
    if (elevated.value) {
      toast(e.message || String(e), 'error');
      return false;
    }
    const r = await requestSudoElevation(hostId.value, { title: t('app.taskmon.sudo-required') });
    if (!r.ok) {
      toast((r.error || t('app.taskmon.cancelled')) + tf('app.taskmon.signal-cancelled-suffix', { v1: (p.pid), v2: sig }), 'error');
      return false;
    }
    setElevated(true);
    try {
      await attempt();
      toast(tf('app.taskmon.signal-sent-admin', { v1: (p.name), v2: (p.pid), v3: sig }), 'success');
      refresh();
      return true;
    } catch (e2) {
      toast(e2.message || String(e2), 'error');
      return false;
    }
  }
}

async function sendMany(list, sig) {
  if (!list.length) return;
  const run = () => Promise.allSettled(list.map((p) =>
    taskmonSignal({ host: hostId.value, pid: p.pid, signal: sig, sudo: elevated.value })));
  let results = await run();
  let failed = results.filter((r) => r.status === 'rejected').length;

  if (failed === list.length && !elevated.value) {
    const r = await requestSudoElevation(hostId.value, { title: t('app.taskmon.sudo-required') });
    if (r.ok) {
      setElevated(true);
      results = await run();
      failed = results.filter((r) => r.status === 'rejected').length;
    } else if (!r.cancelled) {
      toast(r.error, 'error');
    }
  }

  const ok = list.length - failed;
  if (ok > 0) {
    toast(tf('app.taskmon.signal-bulk-sent', {
      v1: ok,
      v2: sig,
      v3: failed ? tf('app.taskmon.signal-bulk-failed-count', { v1: failed }) : '',
    }), failed ? 'warning' : 'success');
    refresh();
  } else {
    const first = results.find((r) => r.status === 'rejected');
    toast(first?.reason?.message || tf('app.taskmon.signal-bulk-failed', { v1: sig }), 'error');
  }
}

function confirmKill(p) {
  confirmAction(
    t('app.taskmon.confirm-kill-title'),
    tf('app.taskmon.confirm-kill-body', { v1: (p.name), v2: (p.pid), v3: (p.user) }),
    { okText: t('app.taskmon.action-kill'), danger: true },
  ).then((ok) => { if (ok) sendSignal(p, 'KILL'); });
}

function confirmGroup(g, sig) {
  const hard = sig === 'KILL';
  confirmAction(
    hard ? t('app.taskmon.confirm-kill-app-title') : t('app.taskmon.confirm-term-app-title'),
    tf('app.taskmon.confirm-kill-app-body', { v1: (g.name), v2: (g.count), v3: sig })
      + (hard ? t('app.taskmon.confirm-kill-app-note-hard') : t('app.taskmon.confirm-kill-app-note-soft')),
    { okText: hard ? t('app.taskmon.action-kill-all') : t('app.taskmon.action-term-all'), danger: hard },
  ).then((ok) => { if (ok) sendMany(g.procs, sig); });
}

function SendButton(props) {
  const { p, sel, onDone } = props;
  const busy = useState(false);
  return h('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: t('app.taskmon.w-send'),
    disabled: busy.value,
    onClick: async () => {
      busy.next = true;
      const sig = sel.current ? sel.current.value : 'TERM';
      const ok = await sendSignal(p, sig);
      busy.next = false;
      onDone(ok);
    },
  });
}

function promptSignal(p) {
  const sel = { current: null };
  const dlg = dialog({
    title: tf('app.taskmon.signal-dialog-title', { v1: (p.name) }),
    width: 'sm',
    body: [
      h('div', { class: 'help', text: tf('app.taskmon.signal-dialog-desc', { v1: (p.pid), v2: (p.user) }) }),
      h('select', { class: 'select', ref: (el) => { sel.current = el; } },
        SIGNALS.map((s) => h('option', {
          key: s, value: s, text: `SIG${s}`, selected: s === 'TERM',
        }))),
      h('div', { class: 'qx-sudo-err' }),
    ],
    actions: [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.taskmon.action-cancel'), onClick: () => dlg.close() }),
      h(SendButton, { p, sel, onDone: (ok) => { if (ok) dlg.close(); } }),
    ],
  });
  if (sel.current) sel.current.focus();
}

export function openProcMenu(e, p) {
  const ident = `PID ${p.pid}${p.user ? ' · ' + p.user : ''}`;
  openMenu(e, [
    mhead(t('app.taskmon.action-terminate')),
    mi(t('app.taskmon.sig-term'), () => sendSignal(p, 'TERM'), { icon: 'circle-minus', hint: 'SIGTERM' }),
    mi(t('app.taskmon.sig-kill'), () => confirmKill(p), { icon: 'trash', hint: 'SIGKILL', danger: true }),
    msep(),
    mhead(t('app.taskmon.menu-run-control')),
    mi(t('app.taskmon.sig-stop'), () => sendSignal(p, 'STOP'), { icon: 'circle-minus', hint: 'SIGSTOP' }),
    mi(t('app.taskmon.sig-cont'), () => sendSignal(p, 'CONT'), { icon: 'activity', hint: 'SIGCONT' }),
    mi(t('app.taskmon.sig-int'), () => sendSignal(p, 'INT'), { icon: 'circle-minus', hint: 'SIGINT' }),
    mi(t('app.taskmon.sig-hup'), () => sendSignal(p, 'HUP'), { icon: 'reload', hint: 'SIGHUP' }),
    mi(t('app.taskmon.action-other-signals'), () => promptSignal(p), { icon: 'activity' }),
    msep(),
    mhead(ident),
    mi(t('app.taskmon.action-copy-pid'), () => copyText(String(p.pid), t('app.taskmon.copied-pid')), { icon: 'copy' }),
    mi(t('app.taskmon.action-copy-cmdline'), () => copyText(p.args || p.name, t('app.taskmon.copied-cmdline')), { icon: 'copy' }),
    msep(),
    mi(t('app.taskmon.action-refresh-procs'), () => refresh(), { icon: 'reload' }),
  ]);
}

export function openGroupMenu(e, g) {
  openMenu(e, [
    mhead(tf('app.taskmon.group-menu-title', { v1: (g.name), v2: (g.count) })),
    mi(t('app.taskmon.action-expand'), () => toggleGroup(g.name), { icon: 'chevron' }),
    msep(),
    mi(t('app.taskmon.action-term-all-procs'), () => confirmGroup(g, 'TERM'), { icon: 'circle-minus', hint: 'SIGTERM' }),
    mi(t('app.taskmon.action-kill-all-procs'), () => confirmGroup(g, 'KILL'), { icon: 'trash', hint: 'SIGKILL', danger: true }),
    msep(),
    mi(t('app.taskmon.action-copy-count'), () => copyText(String(g.count), t('app.taskmon.copied-count')), { icon: 'copy' }),
    mi(t('app.taskmon.action-copy-name'), () => copyText(g.name, t('app.taskmon.copied-name')), { icon: 'copy' }),
    msep(),
    mi(t('app.taskmon.action-refresh-procs'), () => refresh(), { icon: 'reload' }),
  ]);
}
