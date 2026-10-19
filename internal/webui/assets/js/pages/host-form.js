/**
 * pages/host-form.js —— 主机新增/编辑表单
 * 要点：以对话框形式编辑主机信息（含跳板与认证方式），支持测试连接、清除已探测系统信息，保存后回调。
 */
import { h, Fragment } from '../core/vdom.js';
import { dialog, PasswordField, segmented } from '../core/components.js';
import { signal } from '../core/signal.js';
import { createHost, updateHost, testHost, forgetHostOS } from '../core/qxssh-api.js';
import { getState } from '../core/store.js';
import { toast } from '../core/ui.js';
import { t, tf } from '../core/i18n.js';

/** 打开主机表单对话框，保存成功后回调 onSaved */
export function openHostForm({ host = null, groups = [], onSaved }) {
  const authType = signal(host?.authType || 'password');
  const testRes = signal(null);
  const testing = signal(false);
  const forgot = signal(false);
  const saving = signal(false);
  const keyNote = signal('');

  const cred = { pass: '', keyPass: '', keyData: '' };

  const R = {
    name: null, group: null, address: null, port: null, user: null, note: null,
    jump: null, keyFile: null,
  };

  const closer = { close: () => {} };

  const blocked = new Set();
  if (host?.id) {
    blocked.add(host.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of getState().hosts || []) {
        if (x.jumpHostId && blocked.has(x.jumpHostId) && !blocked.has(x.id)) {
          blocked.add(x.id);
          grew = true;
        }
      }
    }
  }

  function collect() {
    const b = {
      name: R.name ? R.name.value.trim() : '',
      group: R.group ? R.group.value.trim() : '',
      address: R.address ? R.address.value.trim() : '',
      port: (R.port && parseInt(R.port.value, 10)) || 22,
      user: R.user ? R.user.value.trim() : '',
      authType: authType.value,
      note: R.note ? R.note.value.trim() : '',
      jumpHostId: (R.jump && R.jump.value) || '',
    };
    if (cred.pass) b.password = cred.pass;
    if (cred.keyPass) b.keyPassphrase = cred.keyPass;
    if (authType.value === 'key' && cred.keyData.trim()) b.keyData = cred.keyData.trim();
    return b;
  }

  function onPickKeyFile(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      cred.keyData = String(reader.result || '');
      keyNote.next = tf('app.hostform.key-loaded', { v1: (f.name), v2: (cred.keyData.length) });
    };
    reader.onerror = () => toast(t('app.hostform.key-read-failed'), 'error');
    reader.readAsText(f);
    ev.target.value = '';
  }

  async function doTest() {
    const f = collect();
    if (!f.address || !f.user) { toast(t('app.hostform.need-addr-user'), 'warning'); return; }
    const hasKey = !!(host && (host.hasKey || host.keyPath));
    const hasPassword = !!(host && host.hasPassword);
    if (authType.value === 'key' && !f.keyData && !hasKey) {
      toast(t('app.hostform.need-key'), 'warning'); return;
    }
    if (authType.value === 'password' && !f.password && !hasPassword) {
      toast(t('app.hostform.need-password'), 'warning'); return;
    }
    const fields = {
      address: f.address, port: f.port, user: f.user, authType: f.authType,
      password: f.password || '', keyData: f.keyData || '',
      keyPassphrase: f.keyPassphrase || '', jumpHostId: f.jumpHostId,
    };
    testing.next = true;
    try {
      testRes.next = await testHost(host ? { id: host.id, ...fields } : fields);
    } catch (e) {
      testRes.next = { ok: false, error: e.message };
    } finally {
      testing.next = false;
    }
  }

  async function doForgetOS() {
    forgot.next = true;
    try {
      await forgetHostOS(host.id);
      toast(t('app.hostform.os-cleared'), 'success');
    } catch (e) {
      forgot.next = false;
      toast(e.message, 'error');
    }
  }

  function doSave(close) {
    const f = collect();
    if (!f.name || !f.address || !f.user) { toast(t('app.hostform.required-fields'), 'warning'); return; }
    if (authType.value === 'key' && !f.keyData && !(host && (host.hasKey || host.keyPath))) {
      toast(t('app.hostform.need-key'), 'warning');
      return;
    }
    if (authType.value === 'password' && !host && !f.password) { toast(t('app.hostform.need-password'), 'warning'); return; }
    saving.next = true;
    (host ? updateHost(host.id, f) : createHost(f))
      .then((saved) => {
        toast(host ? t('app.hostform.host-saved') : t('app.hostform.host-added'), 'success');
        close();
        onSaved?.(saved, !!host);
      })
      .catch((e) => { toast(e.message, 'error'); saving.next = false; });
  }

  function field(label, input, required = false) {
    return h('div', { class: 'field' }, [
      h('label', { class: 'label', html: required ? `${label} <span class="required">*</span>` : label }),
      input,
    ]);
  }

  function alertOf(r) {
    const ic = r.ok
      ? '<svg class="alert-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><path d="M5.5 8.2l1.8 1.8 3.5-4"/></svg>'
      : '<svg class="alert-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>';
    return h('div', { class: `alert ${r.ok ? 'alert-success' : 'alert-error'}` }, [
      h('div', { html: ic }),
      h('div', {}, [
        h('span', { class: 'alert-title', text: r.ok ? t('app.hostform.test-ok') : t('app.hostform.test-failed') }),
        h('span', { class: 'alert-desc', text: r.ok ? tf('app.hostform.test-latency', { v1: (r.latencyMs) }) : (r.error || t('app.hostform.unknown-error')) }),
      ]),
    ]);
  }

  function HostFormBody() {
    const key = authType.value === 'key';
    const r = testRes.value;
    return h('form', { class: 'form-section', onSubmit: (e) => e.preventDefault() }, [
      h('div', { class: 'form-section-title', text: t('app.hostform.section-basic') }),
      h('div', { class: 'form-grid-row' }, [
        field(t('app.hostform.field-name'), h('input', {
          ref: (el) => { R.name = el; },
          class: 'input', placeholder: t('app.hostform.name-placeholder'), spellcheck: 'false', value: host?.name || '',
        }), true),
        field(t('app.hostform.field-group'), h('input', {
          ref: (el) => { R.group = el; },
          class: 'input', placeholder: t('app.hostform.group-placeholder'), list: 'qx-group-list',
          spellcheck: 'false', value: host?.group || '',
        })),
      ]),
      h('div', { class: 'form-grid-row' }, [
        field(t('app.hostform.field-address'), h('input', {
          ref: (el) => { R.address = el; },
          class: 'input', placeholder: t('app.hostform.address-placeholder'), spellcheck: 'false', value: host?.address || '',
        }), true),
        field(t('app.hostform.field-port'), h('input', {
          ref: (el) => { R.port = el; },
          class: 'input', type: 'number', value: host?.port || 22, min: '1', max: '65535',
        })),
      ]),
      h('div', { class: 'form-grid-row' }, [
        field(t('app.hostform.field-username'), h('input', {
          ref: (el) => { R.user = el; },
          class: 'input', placeholder: 'root', spellcheck: 'false', value: host?.user || '',
        }), true),
        field(t('app.hostform.field-note'), h('input', {
          ref: (el) => { R.note = el; },
          class: 'input', placeholder: t('app.hostform.optional'), spellcheck: 'false', value: host?.note || '',
        })),
      ]),
      h('div', { class: 'form-grid-row' }, [
        field(t('app.hostform.field-jump'), h('select', {
          ref: (el) => { R.jump = el; },
          class: 'select',
        }, [
          h('option', { value: '', text: t('app.hostform.jump-none') }),
          ...(getState().hosts || [])
            .filter((x) => !blocked.has(x.id))
            .map((x) => h('option', {
              key: x.id, value: x.id, text: x.name,
              selected: host?.jumpHostId === x.id,
            })),
        ])),
      ]),
      h('hr', { class: 'divider' }),
      h('div', { class: 'form-section-title', text: t('app.hostform.section-auth') }),
      h('div', { class: 'field' }, [
        h('label', { class: 'label', text: t('app.hostform.field-cred-type') }),
        segmented([
          { value: 'password', label: t('app.hostform.cred-password') },
          { value: 'key', label: t('app.hostform.cred-key') },
        ], authType.value, (v) => { authType.next = v; }),
      ]),
      h('div', { class: `field${key ? ' hidden' : ''}` }, [
        h('label', { class: 'label', text: t('app.hostform.cred-password') }),
        h(PasswordField, {
          value: '',
          placeholder: host?.hasPassword ? t('app.hostform.saved-keep') : t('app.hostform.field-login-password'),
          onInput: (v) => { cred.pass = v; },
        }),
        h('span', { class: 'help', text: t('app.hostform.cred-encryption-note') }),
      ]),
      h('div', { class: `field${key ? '' : ' hidden'}` }, [
        h('label', {
          class: 'label',
          html: (host?.hasKey || host?.keyPath) ? t('app.hostform.cred-key') : t('app.hostform.cred-key-required'),
        }),
        h('textarea', {
          class: 'textarea mono',
          rows: 6,
          spellcheck: 'false',
          value: '',
          placeholder: host?.hasKey
            ? t('app.hostform.saved-key-keep')
            : t('app.hostform.key-placeholder'),
          onInput: (e) => { cred.keyData = e.target.value; keyNote.next = ''; },
        }),
        h('div', { class: 'field-actions' }, [
          h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', text: t('app.hostform.upload-key'),
            onClick: () => { if (R.keyFile) R.keyFile.click(); },
          }),
          h('span', {
            class: 'help',
            text: keyNote.value || t('app.hostform.cred-encryption-note'),
          }),
        ]),
        h('input', {
          ref: (el) => { R.keyFile = el; },
          type: 'file', hidden: true, onChange: onPickKeyFile,
        }),
      ]),
      h('div', { class: `field${key ? '' : ' hidden'}` }, [
        h('label', { class: 'label', text: t('app.hostform.field-key-passphrase') }),
        h(PasswordField, {
          value: '',
          placeholder: host?.hasKeyPassphrase ? t('app.hostform.saved-keep') : t('app.hostform.passphrase-none'),
          onInput: (v) => { cred.keyPass = v; },
        }),
      ]),
      r ? alertOf(r) : null,
    ].filter(Boolean));
  }

  function FormActions() {
    const busy = testing.value;
    return h(Fragment, {}, [
      h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        text: busy ? t('app.hostform.testing') : t('app.hostform.action-test'),
        disabled: busy,
        onClick: doTest,
      }),
      host?.osId
        ? h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          text: forgot.value ? t('app.hostform.cleared-redetect') : t('app.hostform.redetect-os'),
          disabled: forgot.value,
          onClick: doForgetOS,
        })
        : null,
      h('span', { style: { flex: '1' } }),
      h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: t('app.hostform.action-cancel'),
        onClick: () => closer.close(),
      }),
      h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        text: saving.value ? t('app.hostform.status-saving') : t('app.hostform.action-save'),
        disabled: saving.value,
        onClick: () => doSave(closer.close),
      }),
    ].filter(Boolean));
  }

  const dlg = dialog({
    title: host ? t('app.hostform.title-edit') : t('app.hostform.title-add'),
    body: [
      h(HostFormBody),
      h('datalist', { id: 'qx-group-list' }, groups.map((g) => h('option', { key: g, value: g }))),
    ],
    actions: h(FormActions),
    width: 'lg',
  });
  closer.close = (result) => dlg.close(result);

  setTimeout(() => { if (R.name) R.name.focus(); }, 60);
  return dlg;
}
