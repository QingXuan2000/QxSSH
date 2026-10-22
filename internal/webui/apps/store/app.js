/**
 * app.js —— 应用商店主入口
 * 浏览 / 搜索已安装应用，校验并安装 .qxp 包、下载链接或 Git 仓库（含分支选择），
 * 以及启用 / 禁用与卸载。数据面全部走 qxssh-api 的 apps/* 接口。
 * 三条安装入口共用 doInstall：先 validate 拿确认信息，用户确认后才 install，
 * 因此每个入口的载荷形态必须与 qxssh-api 的 appPkgRequest 分支一一对应。
 * Git 入口不内置任何官方仓库：仓库地址由用户自行填写，子目录按需填写。
 */
import { bootAppNoInit, notifyAppsChanged, reloadApp } from '/assets/js/app-bridge.js';
import { setupI18n, t, tf, lang } from '/assets/js/core/i18n.js';

import { fmtSize, debounce } from '/assets/js/core/dom.js';
import { h, island, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  sidebarSections, searchBox,
  badge, statTile, emptyState, kvGrid, iconButton, tipAttrs,
} from '/assets/js/core/components.js';
import { createAppShell } from '/assets/js/core/app-shell.js';
import {
  listUserApps, validateApp, installApp, uninstallApp, setAppEnabled, auditNote, linkApp, getGitBranches,
} from '/assets/js/core/qxssh-api.js';
import { appIcon } from '/assets/js/icons/index.js';
import { setIconHidden, hiddenIconIds } from '/assets/js/desktop/iconvis.js';
import { appName, appDesc, appCategory, appCategoryKey, categoryName } from '/assets/js/apps/apptext.js';

const SCOPES = [
  { id: 'all', key: 'app.store.tab-all', icon: 'grid' },
  { id: 'builtin', key: 'app.store.tab-system', icon: 'shield' },
  { id: 'store', key: 'app.store.tab-user', icon: 'package' },
  { id: 'disabled', key: 'app.store.tab-disabled', icon: 'CircleSlash' },
];

const INSTALL = { id: 'install', key: 'app.store.action-install', icon: 'cloud-download' };

const isBuiltin = (a) => a.systemApp === true || a.source === 'builtin';

const canToggle = (a) => !isBuiltin(a) || a.disableable === true;

const CAT_OTHER = 'core.category-other';
const catKeyOf = (a) => appCategoryKey(a) || CAT_OTHER;

const catOf = (a) => appCategory(a) || t('app.store.category-other');

function boot(el) {
  const apps = signal([]);
  const error = signal('');
  const scope = signal('all');
  const category = signal('');
  const query = signal('');
  const hiddenIcons = signal(new Set(hiddenIconIds()));
  const urlBusy = signal(false);
  const urlMsg = signal('');
  const fileBusy = signal(false);
  const fileMsg = signal('');

  let loaded = false;
  let busyId = '';
  const urlInput = { current: null };
  const dirInput = { current: null };
  const devBusy = signal(false);
  const devMsg = signal('');
  const gitUrlInput = { current: null };
  const gitBranchInput = { current: null };
  const gitPathInput = { current: null };
  const gitBusy = signal(false);
  const gitMsg = signal('');
  const gitDetecting = signal(false);
  const gitBranches = signal([]);
  const gitDefaultBranch = signal('');
  const gitSelectedBranch = signal('');
  const gitCustomBranch = signal(false);
  const fileInput = { current: null };

  let lastDetectedUrl = '';
  const detectBranches = debounce(async (rawUrl) => {
    const url = (rawUrl || '').trim();
    if (!url || url === lastDetectedUrl) return;
    if (url.length < 5) return;
    lastDetectedUrl = url;
    gitDetecting.next = true;
    gitMsg.next = '';
    try {
      const res = await getGitBranches(url);
      const list = Array.isArray(res?.branches) ? res.branches : [];
      const def = res?.defaultBranch || (list[0] || '');
      gitBranches.next = list;
      gitDefaultBranch.next = def;
      gitSelectedBranch.next = def;
      gitCustomBranch.next = false;
    } catch (e) {
      gitBranches.next = [];
      gitDefaultBranch.next = '';
      gitSelectedBranch.next = '';
      const errMsg = e?.message || '';
      if (errMsg) gitMsg.next = tf('app.store.err-git-detect-failed', { v1: errMsg });
    } finally {
      gitDetecting.next = false;
    }
  }, 450);

  function triggerDetectBranches() {
    const u = (gitUrlInput.current ? gitUrlInput.current.value : '').trim();
    if (u) void detectBranches(u);
  }

  const onSearch = debounce((v) => { query.next = v; }, 250);

  function matches(a) {
    const s = scope.value;
    if (s === 'builtin' && !isBuiltin(a)) return false;
    if (s === 'store' && isBuiltin(a)) return false;
    if (s === 'disabled' && a.disabled !== true) return false;
    const q = query.value.trim().toLowerCase();
    if (!q) return true;
    const hay = [appName(a), appDesc(a), catOf(a), a.author, a.id, ...(a.keywords || [])];
    return hay.some((v) => String(v || '').includes(q));
  }

  function visibleApps() {
    const cat = category.value;
    return apps.value.filter((a) => matches(a) && (!cat || catKeyOf(a) === cat));
  }

  function categoriesOf() {
    const count = new Map();
    for (const a of apps.value) {
      if (!matches(a)) continue;
      const k = catKeyOf(a);
      count.set(k, (count.get(k) || 0) + 1);
    }
    return [...count.entries()].sort((x, y) => y[1] - x[1]
      || categoryName(x[0]).localeCompare(categoryName(y[0]), lang()));
  }

  async function loadApps(force = false) {
    if (loaded && !force) return;
    error.next = '';
    try {
      apps.next = await listUserApps();
      loaded = true;
    } catch (e) {
      error.next = e?.message || t('app.store.err-list-failed');
      apps.next = [];
    }
  }

  function setIconOnDesktop(a, visible) {
    setIconHidden(a.id, !visible);
    hiddenIcons.next = hiddenIconIds();
    notifyAppsChanged();
    auditNote('desktop-icon', `${visible ? 'show' : 'hide'} ${a.id}`);
    toast(visible ? tf('app.store.icon-shown', { v1: appName(a) }) : tf('app.store.icon-hidden', { v1: appName(a) }), 'success');
  }

  async function setEnabled(a, enabled) {
    if (busyId) return;
    busyId = a.id;
    try {
      await setAppEnabled(a.id, enabled);
      apps.next = apps.value.map((x) => (x.id === a.id ? { ...x, disabled: !enabled } : x));
      toast(enabled ? tf('app.store.enabled', { v1: appName(a) }) : tf('app.store.disabled', { v1: appName(a) }), 'success');
      notifyAppsChanged();
    } catch (e) {
      toast(e?.message || (enabled ? t('app.store.err-enable-failed') : t('app.store.err-disable-failed')), 'error');
    } finally {
      busyId = '';
    }
  }

  async function doUninstall(a) {
    const ok = await confirmAction(
      tf('app.store.confirm-uninstall-title', { v1: appName(a) }),
      t('app.store.confirm-uninstall-body'),
      { okText: t('app.store.action-uninstall'), danger: true },
    );
    if (!ok) return;
    try {
      await uninstallApp(a.id);
      toast(tf('app.store.uninstalled', { v1: appName(a) }), 'success');
      await loadApps(true);
      notifyAppsChanged();
    } catch (e) {
      toast(e?.message || t('app.store.err-uninstall-failed'), 'error');
    }
  }

  function appIconBox(a, cls = '') {
    return h('div', { class: `am-ic${cls ? ' ' + cls : ''}` }, [
      h('span', { class: 'qicon', html: appIcon(a.icon || a.id, 'qicon', a.id) }),
    ]);
  }

  function sourceBadge(a) {
    if (a.disabled === true) return badge(t('app.store.tab-disabled'), 'warning');
    if (a.dev === true) return badge(t('app.store.source-dev'), 'warning');
    if (a.source === 'git' || a.git) return badge('Git', 'primary');
    return isBuiltin(a) ? badge(t('app.store.source-system'), 'default') : badge(t('app.store.source-user'), 'success');
  }

  function appRow(a) {
    const builtin = isBuiltin(a);
    const off = a.disabled === true;
    const iconOff = hiddenIcons.value.has(a.id);
    const actions = h('div', { class: 'am-actions' }, [
      canToggle(a) ? iconButton('power', {
        active: !off,
        cls: 'am-act-1',
        tip: off ? t('app.store.state-disabled-click-enable') : t('app.store.state-enabled-click-disable'),
        onClick: () => { setEnabled(a, off); },
      }) : null,
      off ? null : iconButton(iconOff ? 'eye-off' : 'eye', {
        active: !iconOff,
        cls: 'am-act-2',
        tip: iconOff ? t('app.store.icon-off-click-on') : t('app.store.icon-on-click-off'),
        onClick: () => { setIconOnDesktop(a, iconOff); },
      }),
      iconButton('info', { tip: t('app.store.action-details'), onClick: () => showDetail(a), cls: 'am-act-3' }),
      !builtin
        ? iconButton('trash', {
          tip: t('app.store.action-uninstall'), cls: 'am-danger am-act-4', onClick: () => doUninstall(a),
        })
        : null,
    ]);

    return h('div', { key: a.id, class: `am-row${off ? ' is-off' : ''}` }, [
      appIconBox(a),
      h('div', { class: 'am-info' }, [
        h('div', { class: 'am-name-row' }, [
          h('span', { class: 'am-name', text: appName(a) || a.id }),
          a.version ? h('span', { class: 'am-ver mono', text: 'v' + a.version }) : null,
          sourceBadge(a),
          h('span', { class: 'am-cat', text: catOf(a) }),
        ]),
        h('div', { class: 'am-desc', text: appDesc(a) || t('app.store.desc-missing-installed') }),
      ]),
      actions,
    ]);
  }

  function showDetail(a) {
    let close = () => {};
    const isl = island(h('div', {
      class: 'overlay',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    }, h('div', { class: 'dialog am-detail' }, [
      h('div', { class: 'am-detail-head' }, [
        appIconBox(a, 'am-ic-lg'),
        h('div', { class: 'am-detail-heading' }, [
          h('div', { class: 'am-detail-title', text: appName(a) || a.id }),
          h('div', { class: 'am-detail-sub' }, [
            a.version ? h('span', { class: 'mono', text: 'v' + a.version }) : null,
            sourceBadge(a),
          ]),
        ]),
        iconButton('x', { tip: t('app.store.action-close'), onClick: () => close() }),
      ]),
      h('div', { class: 'dialog-body' }, [
        h('p', { class: 'am-detail-desc', text: appDesc(a) || t('app.store.desc-missing-installed') }),
        (() => {
          const rows = [
            [t('app.store.field-id'), a.id || '—'],
            [t('app.store.field-version'), a.version ? 'v' + a.version : '—'],
            [t('app.store.field-author'), a.author || '—'],
            [t('app.store.field-category'), catOf(a)],
            [t('app.store.field-entry'), a.entry || 'index.html'],
            [t('app.store.field-source'), isBuiltin(a) ? t('app.store.source-builtin') : (a.dev ? t('app.store.source-dev') : (a.git ? t('app.store.source-git') : t('app.store.source-installed')))],
            [t('app.store.field-status'), canToggle(a) ? (a.disabled === true ? t('app.store.tab-disabled') : t('app.store.status-enabled')) : t('app.store.status-always-on')],
            [t('app.store.field-permissions'), Array.isArray(a.permissions) && a.permissions.length
              ? a.permissions.join('、') : t('app.store.perm-none')],
            [t('app.store.field-preferred-size'), a.preferredSize
              ? `${a.preferredSize.width || '—'} × ${a.preferredSize.height || '—'}`
                + ((a.preferredSize.minWidth || a.preferredSize.minHeight)
                  ? tf('app.store.preferred-size-min', {
                    v1: a.preferredSize.minWidth || '—',
                    v2: a.preferredSize.minHeight || '—',
                  }) : '')
              : '—'],
            [t('app.store.field-singleton'), a.singleton === true ? t('app.store.yes') : t('app.store.no')],
          ];
          if (a.git) {
            rows.push([t('app.store.field-git-repo'), a.git.url || '—']);
            if (a.git.branch) rows.push([t('app.store.field-git-branch'), a.git.branch]);
            if (a.git.commit) rows.push([t('app.store.field-git-commit'), a.git.commit]);
            if (a.git.path) rows.push([t('app.store.field-git-path'), a.git.path]);
          }
          return kvGrid(rows);
        })(),
        Array.isArray(a.keywords) && a.keywords.length
          ? h('div', { class: 'am-detail-kw' },
            a.keywords.map((k) => h('span', { class: 'am-kw', text: k })))
          : null,
      ]),
      a.git ? h('div', { class: 'dialog-foot', style: { paddingTop: '10px' } }, [
        h('span', { class: 'qx-grow' }),
        h('button', {
          class: 'btn btn-outline btn-sm',
          text: t('app.store.action-git-update'),
          onClick: () => {
            close();
            void doInstall({
              validate: () => validateApp({ git: a.git.url, branch: a.git.branch, path: a.git.path }),
              run: () => installApp({ git: a.git.url, branch: a.git.branch, path: a.git.path }),
              busy: gitBusy,
              msg: gitMsg,
            });
          },
        }),
      ]) : null,
    ])));
    close = isl.close;
  }

  function confirmInstall(info) {
    const a = info.app || {};
    const cat = appCategory(a);
    return new Promise((resolve) => {
      let settled = false;
      let close = () => {};
      let okBtn = null;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        close();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const isl = island(h('div', {
        class: 'overlay',
        onClick: (e) => { if (e.target === e.currentTarget) finish(false); },
      }, h('div', { class: 'dialog dialog-sm am-confirm' }, [
        h('div', { class: 'am-detail-head' }, [
          appIconBox({ icon: a.icon, id: a.id }),
          h('div', { class: 'am-detail-heading' }, [
            h('div', { class: 'am-detail-title', text: appName(a) || a.id || t('app.store.name-missing') }),
            h('div', { class: 'am-detail-sub' }, [
              a.version ? h('span', { class: 'mono', text: 'v' + a.version }) : null,
              cat ? h('span', { class: 'am-cat', text: cat }) : null,
            ]),
          ]),
        ]),
        h('div', { class: 'dialog-body' }, [
          h('p', { class: 'am-detail-desc', text: appDesc(a) || t('app.store.desc-missing-package') }),
          kvGrid([
            [t('app.store.field-id'), a.id || '—'],
            [t('app.store.field-version'), a.version ? 'v' + a.version : '—'],
            [t('app.store.field-author'), a.author || '—'],
            [t('app.store.field-category'), cat || '—'],
            [t('app.store.field-entry'), a.entry || 'index.html'],
            [t('app.store.field-size'), `${fmtSize(info.size)}`
              + `${info.fileCount ? ` · ${info.fileCount} 个文件` : ''}`],
          ]),
          Array.isArray(a.permissions) && a.permissions.length
            ? h('div', { class: 'am-warn' }, [
              h('span', { class: 'am-warn-title', text: t('app.store.perm-declared') }),
              h('div', { class: 'am-detail-kw' },
                a.permissions.map((p) => h('span', { class: 'am-kw', text: p }))),
              h('span', { class: 'help', text: t('app.store.perm-adjust-hint') }),
            ])
            : null,
          info.installed
            ? h('div', {
              class: 'am-warn',
              text: t('app.store.confirm-overwrite'),
            })
            : null,
        ]),
        h('div', { class: 'dialog-foot' }, [
          h('button', {
            class: 'btn btn-ghost btn-sm', text: t('app.store.action-cancel'), onClick: () => finish(false),
          }),
          h('button', {
            ref: (el) => { okBtn = el; },
            class: 'btn btn-primary btn-sm',
            text: info.installed ? t('app.store.action-overwrite') : t('app.store.action-install-short'),
            onClick: () => finish(true),
          }),
        ]),
      ])));
      close = isl.close;
      document.addEventListener('keydown', onKey);
      if (okBtn) okBtn.focus();
    });
  }

  async function doInstall({ validate, run, busy, msg }) {
    busy.next = true;
    msg.next = '';
    let info;
    try {
      info = await validate();
    } catch (e) {
      const msgText = e?.message || t('app.store.err-package-failed');
      msg.next = msgText;
      toast(msgText, 'error');
      busy.next = false;
      return;
    }
    const ok = await confirmInstall(info);
    if (!ok) {
      toast(t('app.store.install-cancelled'), 'info');
      busy.next = false;
      return;
    }
    try {
      const m = await run();
      toast(tf('app.store.installed', { v1: appName(m) }), 'success');
      await loadApps(true);
      notifyAppsChanged();
    } catch (e) {
      const msgText = e?.message || t('app.store.err-install-failed');
      msg.next = msgText;
      toast(msgText, 'error');
    } finally {
      busy.next = false;
    }
  }

  function installHead(title, desc, iconName) {
    return h('div', { class: 'am-install-head' }, [
      h('span', { class: 'am-install-title' }, [
        h('span', { class: 'qicon', html: appIcon(iconName, 'qicon-sm') }),
        h('span', { text: title }),
      ]),
      h('span', { class: 'help', text: desc }),
    ]);
  }

  function installTree() {
    const urlForm = h('form', {
      class: 'am-install-card',
      onSubmit: (e) => {
        e.preventDefault();
        const url = (urlInput.current ? urlInput.current.value : '').trim();
        if (!url) { toast(t('app.store.err-url-required'), 'warning'); return; }
        void doInstall({
          validate: () => validateApp({ url }),
          run: () => installApp({ url })
            .then((m) => { if (urlInput.current) urlInput.current.value = ''; return m; }),
          busy: urlBusy,
          msg: urlMsg,
        });
      },
    }, [
      installHead(t('app.store.install-from-url'), t('app.store.install-from-url-hint'), 'cloud-download'),
      h('div', { class: 'am-install-row' }, [
        h('input', {
          ref: (el) => { urlInput.current = el; },
          class: 'input am-url', type: 'url', spellcheck: 'false',
          placeholder: 'https://example.com/my-app.qxp',
        }),
        h('button', {
          class: 'btn btn-primary btn-sm', type: 'submit',
          text: urlBusy.value ? t('app.store.status-installing') : t('app.store.action-download-install'),
          disabled: urlBusy.value,
        }),
      ]),
      h('span', { class: 'help am-msg', text: urlMsg.value }),
    ]);

    const fileCard = h('div', { class: 'am-install-card' }, [
      installHead(t('app.store.install-from-file'), t('app.store.install-from-file-hint'), 'folder-open'),
      h('div', { class: 'am-install-row' }, [
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          text: fileBusy.value ? t('app.store.status-installing') : t('app.store.action-pick-file'),
          disabled: fileBusy.value,
          onClick: () => { if (fileInput.current) fileInput.current.click(); },
        }),
      ]),
      h('span', { class: 'help am-msg', text: fileMsg.value }),
      h('input', {
        ref: (el) => { fileInput.current = el; },
        type: 'file', accept: '.qxp', hidden: true,
        onChange: (e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!f) return;
          if (!/\.qxp$/i.test(f.name || '')) {
            toast(t('app.store.err-pick-file'), 'warning');
            return;
          }
          void doInstall({
            validate: () => validateApp(f),
            run: () => installApp(f),
            busy: fileBusy,
            msg: fileMsg,
          });
        },
      }),
    ]);

    const gitForm = h('form', {
      class: 'am-install-card',
      onSubmit: (e) => {
        e.preventDefault();
        const url = (gitUrlInput.current ? gitUrlInput.current.value : '').trim();
        if (!url) { toast(t('app.store.err-git-required'), 'warning'); return; }
        const branch = (gitCustomBranch.value
          ? (gitBranchInput.current ? gitBranchInput.current.value : gitSelectedBranch.value)
          : (gitSelectedBranch.value || gitDefaultBranch.value)).trim();
        const path = (gitPathInput.current ? gitPathInput.current.value : '').trim();
        const payload = { git: url, branch, path };
        void doInstall({
          validate: () => validateApp(payload),
          run: () => installApp(payload)
            .then((m) => {
              if (gitUrlInput.current) gitUrlInput.current.value = '';
              if (gitBranchInput.current) gitBranchInput.current.value = '';
              if (gitPathInput.current) gitPathInput.current.value = '';
              gitBranches.next = [];
              gitDefaultBranch.next = '';
              gitSelectedBranch.next = '';
              gitCustomBranch.next = false;
              lastDetectedUrl = '';
              return m;
            }),
          busy: gitBusy,
          msg: gitMsg,
        });
      },
    }, [
      installHead(t('app.store.install-from-git'), t('app.store.install-from-git-hint'), 'git-branch'),
      h('div', { class: 'am-install-row' }, [
        h('input', {
          ref: (el) => { gitUrlInput.current = el; },
          class: 'input am-url mono', type: 'text', spellcheck: 'false',
          placeholder: t('app.store.git-repo-placeholder'),
          ...tipAttrs(t('app.store.field-git-repo')),
          onInput: (e) => {
            const v = e.target.value.trim();
            if (!v) {
              lastDetectedUrl = '';
              gitBranches.next = [];
              gitDefaultBranch.next = '';
              gitSelectedBranch.next = '';
              gitCustomBranch.next = false;
              gitDetecting.next = false;
              gitMsg.next = '';
            } else {
              detectBranches(v);
            }
          },
          onChange: () => triggerDetectBranches(),
          onBlur: () => triggerDetectBranches(),
        }),
        iconButton('refresh', {
          tip: t('app.store.git-branch-refresh'),
          disabled: gitDetecting.value,
          onClick: () => triggerDetectBranches(),
        }),
      ]),
      h('div', { class: 'am-install-row' }, [
        (() => {
          if (gitDetecting.value) {
            return h('select', {
              class: 'select mono',
              style: { flex: '1', minWidth: '0' },
              disabled: true,
              ...tipAttrs(t('app.store.git-branch-detecting-tip')),
            }, [
              h('option', { text: t('app.store.git-branch-detecting') }),
            ]);
          }
          if (gitBranches.value.length > 0 && !gitCustomBranch.value) {
            const opts = gitBranches.value.map((b) => h('option', {
              value: b,
              selected: b === gitSelectedBranch.value,
              text: b === gitDefaultBranch.value ? `${b} (${t('app.store.git-branch-default')})` : b,
            }));
            opts.push(h('option', {
              value: '__custom__',
              text: t('app.store.git-branch-custom-opt'),
            }));
            return h('div', { style: { flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px' } }, [
              h('select', {
                class: 'select mono',
                style: { flex: '1', minWidth: '0' },
                ...tipAttrs(t('app.store.field-git-branch')),
                value: gitSelectedBranch.value,
                onChange: (e) => {
                  if (e.target.value === '__custom__') {
                    gitCustomBranch.next = true;
                    gitSelectedBranch.next = '';
                  } else {
                    gitSelectedBranch.next = e.target.value;
                  }
                },
              }, opts),
              iconButton('edit', {
                tip: t('app.store.git-branch-custom-opt'),
                onClick: () => {
                  gitCustomBranch.next = true;
                  gitSelectedBranch.next = '';
                },
              }),
            ]);
          }
          return h('div', { style: { flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px' } }, [
            h('input', {
              ref: (el) => { gitBranchInput.current = el; },
              class: 'input mono', type: 'text', spellcheck: 'false',
              style: { flex: '1', minWidth: '0' },
              value: gitSelectedBranch.value,
              placeholder: t('app.store.git-branch-placeholder'),
              ...tipAttrs(t('app.store.field-git-branch')),
              onInput: (e) => { gitSelectedBranch.next = e.target.value; },
            }),
            gitBranches.value.length > 0 ? iconButton('list', {
              tip: t('app.store.git-branch-switch-select'),
              onClick: () => {
                gitCustomBranch.next = false;
                gitSelectedBranch.next = gitDefaultBranch.value || (gitBranches.value[0] || '');
              },
            }) : null,
          ]);
        })(),
      ]),
      h('div', { class: 'am-install-row' }, [
        h('input', {
          ref: (el) => { gitPathInput.current = el; },
          class: 'input am-url mono', type: 'text', spellcheck: 'false',
          placeholder: t('app.store.git-path-placeholder'),
          ...tipAttrs(t('app.store.field-git-path')),
        }),
      ]),
      h('div', { class: 'am-install-row' }, [
        (() => {
          if (gitMsg.value) {
            return h('span', {
              class: 'help am-msg',
              style: { flex: '0 1 auto', maxWidth: '55%', minWidth: '0' },
              text: gitMsg.value,
              ...tipAttrs(gitMsg.value),
            });
          }
          if (gitDetecting.value) {
            return h('div', {
              class: 'am-msg am-msg-row',
              style: { flex: '0 1 auto', maxWidth: '55%', minWidth: '0' },
            }, [
              h('span', { class: 'cmp-spinner', style: { width: '12px', height: '12px', borderWidth: '1.5px', flexShrink: '0' } }),
              h('span', {
                class: 'help am-msg-text',
                style: { color: 'var(--muted-foreground)' },
                text: t('app.store.git-branch-detecting-msg'),
              }),
            ]);
          }
          if (gitBranches.value.length > 0) {
            const detail = tf('app.store.git-branches-detected-full', {
              v1: gitBranches.value.length,
              v2: gitDefaultBranch.value || 'HEAD',
            });
            return h('div', {
              class: 'am-msg am-msg-row',
              style: { flex: '0 1 auto', maxWidth: '55%', minWidth: '0' },
              ...tipAttrs(detail),
            }, [
              badge(tf('app.store.git-branches-badge', { v1: gitBranches.value.length }), 'primary'),
              h('span', {
                class: 'help am-msg-text',
                style: { color: 'var(--muted-foreground)' },
                text: tf('app.store.git-branches-default-hint', { v1: gitDefaultBranch.value || 'HEAD' }),
              }),
            ]);
          }
          return null;
        })(),
        h('button', {
          class: 'btn btn-primary btn-sm', type: 'submit',
          style: { flex: '1', minWidth: '0' },
          text: gitBusy.value ? t('app.store.status-cloning') : t('app.store.action-git-install'),
          disabled: gitBusy.value || gitDetecting.value,
        }),
      ]),
    ]);

    const devForm = h('form', {
      class: 'am-install-card',
      onSubmit: async (e) => {
        e.preventDefault();
        const dir = (dirInput.current ? dirInput.current.value : '').trim();
        if (!dir) { toast(t('app.store.err-dir-required'), 'warning'); return; }
        devBusy.next = true;
        devMsg.next = '';
        try {
          const m = await linkApp(dir);
          toast(tf('app.store.linked', { v1: appName(m) }), 'success');
          if (dirInput.current) dirInput.current.value = '';
          await loadApps(true);
          notifyAppsChanged();
        } catch (err) {
          const msgText = err?.message || t('app.store.err-link-failed');
          devMsg.next = msgText;
          toast(msgText, 'error');
        } finally {
          devBusy.next = false;
        }
      },
    }, [
      installHead(t('app.store.link-dir'), t('app.store.link-dir-hint'), 'file-code'),
      h('div', { class: 'am-install-row' }, [
        h('input', {
          ref: (el) => { dirInput.current = el; },
          class: 'input am-url mono', type: 'text', spellcheck: 'false',
          placeholder: t('app.store.link-dir-placeholder'),
        }),
        h('button', {
          class: 'btn btn-primary btn-sm', type: 'submit',
          text: devBusy.value ? t('app.store.status-linking') : t('app.store.action-link'),
          disabled: devBusy.value,
        }),
      ]),
      h('span', { class: 'help am-msg', text: devMsg.value }),
    ]);

    return h('div', { class: 'am-main' }, [
      h('div', { class: 'am-toolbar' }, [h('div', { class: 'am-head' }, [
        h('div', { class: 'am-head-title', text: t('app.store.action-install') }),
        h('div', { class: 'am-head-sub', text: t('app.store.install-dialog-title') }),
      ])]),
      h('div', { class: 'am-scroll' }, h('div', { class: 'am-install-grid' }, [urlForm, fileCard, gitForm, devForm])),
    ]);
  }

  function onScopePick(id) {
    if (id.startsWith('cat:')) {
      const next = id.slice(4);
      category.next = category.value === next ? '' : next;
      return;
    }
    scope.next = id;
    category.next = '';
    if (id === INSTALL.id) query.next = '';
  }

  function sideTree() {
    const counts = new Map();
    for (const a of apps.value) {
      if (isBuiltin(a)) counts.set('builtin', (counts.get('builtin') || 0) + 1);
      else counts.set('store', (counts.get('store') || 0) + 1);
      if (a.disabled === true) counts.set('disabled', (counts.get('disabled') || 0) + 1);
    }
    counts.set('all', apps.value.length);

    const scopeItems = SCOPES.map((s) => ({
      id: s.id, label: t(s.key), icon: s.icon, count: counts.get(s.id) || 0,
    }));
    scopeItems.unshift({ id: INSTALL.id, label: t(INSTALL.key), icon: INSTALL.icon });

    const blocks = [{ title: t('app.store.sidebar-scope'), items: scopeItems }];
    if (scope.value !== INSTALL.id) {
      const cats = categoriesOf();
      blocks.push({
        title: t('app.store.field-category'),
        items: cats.map(([key, n]) => ({ id: `cat:${key}`, label: categoryName(key), icon: 'tag', count: n })),
        empty: cats.length ? '' : t('app.store.sidebar-no-category'),
      });
    }
    const cat = category.value;
    return sidebarSections(
      blocks, cat ? `cat:${cat}` : scope.value, onScopePick, { cls: 'am-side' }
    );
  }

  function statsTree() {
    const all = apps.value;
    const builtin = all.filter(isBuiltin).length;
    const off = all.filter((a) => a.disabled === true).length;
    const unit = t('app.store.unit-count', '');
    return h('div', { class: 'am-stats' }, [
      statTile(t('app.store.count-installed'), String(all.length), { unit }),
      statTile(t('app.store.tab-system'), String(builtin), { unit }),
      statTile(t('app.store.tab-user'), String(all.length - builtin), { unit }),
      statTile(t('app.store.tab-disabled'), String(off), { unit, kind: off ? 'warn' : '' }),
    ]);
  }

  function listBody() {
    if (error.value) {
      return h('div', { class: 'am-state' }, [
        h('div', { class: 'am-state-title', text: t('app.store.err-list-failed') }),
        h('div', { class: 'am-state-desc', text: error.value }),
        h('button', {
          class: 'btn btn-outline btn-sm', text: t('app.store.action-retry'),
          onClick: () => { void loadApps(true); },
        }),
      ]);
    }
    const list = visibleApps();
    const cat = category.value;
    if (!list.length) {
      const hasFilter = !!(query.value.trim() || cat);
      return emptyState(hasFilter
        ? t('app.store.empty-no-match')
        : (scope.value === 'disabled' ? t('app.store.empty-no-disabled') : t('app.store.empty-no-installed')));
    }
    const byName = (x, y) => appName(x).localeCompare(appName(y), lang());
    const sorted = [...list].sort((x, y) => (cat
      ? byName(x, y)
      : catOf(x).localeCompare(catOf(y), lang()) || byName(x, y)));
    return h('div', { class: 'am-list' }, sorted.map(appRow));
  }

  function listTree() {
    const cat = category.value;
    const cur = SCOPES.find((s) => s.id === scope.value);
    const scopeLabel = t(cur ? cur.key : 'app.store.tab-all');
    return h('div', { class: 'am-main' }, [
      h('div', { class: 'am-toolbar' }, [
        h('div', { class: 'am-head' }, [
          h('div', { class: 'am-head-title', text: cat ? tf('app.store.list-category', { v1: categoryName(cat) }) : scopeLabel }),
          h('div', { class: 'am-head-sub', text: tf('app.store.list-count', { v1: (visibleApps().length) }) }),
        ]),
        h('span', { class: 'qx-grow' }),
        searchBox(t('app.store.search-placeholder'), (v) => onSearch(v), { cls: 'am-search' }),
      ]),
      h('div', { class: 'am-scroll' }, h('div', { class: 'am-body' }, [
        statsTree(),
        listBody(),
      ])),
    ]);
  }

  function mainTree() {
    return scope.value === INSTALL.id ? installTree() : listTree();
  }

  const sideBox = document.createElement('div');
  sideBox.className = 'am-side';
  const sideView = createView(sideBox);
  sideView.update(sideTree);

  const shell = createAppShell(el, { sideTop: [sideBox] });
  shell.setMain(mainTree);

  void loadApps();

  return () => {
    onSearch.cancel();
    sideView.unmount();
    shell.destroy();
  };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'], scope: 'store',
})
  .catch(() => { })
  .then(() => bootAppNoInit(({ root }) => boot(root)));
