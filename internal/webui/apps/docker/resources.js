import { h, island, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, chipGroup, emptyState, errorState, searchBox, spinner,
} from '/assets/js/core/components.js';
import * as api from './api.js';
import { imageRef, fmtMaybeSize } from './format.js';
import { t, tf } from '/assets/js/core/i18n.js';

function listHost() {
  const root = document.createElement('div');
  root.className = 'dk-body';
  const col = document.createElement('div');
  col.className = 'dk-listcol';
  root.appendChild(col);
  const view = createView(col);
  return {
    el: root,
    mount: (tree) => view.update(tree),
    dispose: () => view.unmount(),
  };
}

function readInput(ref) {
  const el = ref.current;
  return el ? String(el.value || '').trim() : '';
}

function loadFailed(msg, onRetry) {
  return h('div', { class: 'qx-card-scroll' }, [
    errorState(msg),
    h('div', { style: { textAlign: 'center' } }, [
      h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-retry'), onClick: onRetry }),
    ]),
  ]);
}

export function streamDialog({ title, formNodes, start, onDone, requestPerm, onClose = null }) {
  const running = signal(false);
  const out = signal('');
  const finished = signal(false);
  const preRef = { current: null };
  let abort = null;
  let started = false;

  function write(t) {
    out.next = out.value + t;
    const pre = preRef.current;
    if (pre && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60) pre.scrollTop = pre.scrollHeight;
  }

  async function run() {
    started = true;
    running.next = true;
    finished.next = false;
    out.next = '';
    abort = new AbortController();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await start({ signal: abort.signal, write });
        finished.next = true;
        out.next = tf('app.docker.exec-done-sep', { v1: (out.value) });
        onDone?.(true);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (e.status === 403 && e.code !== 'permission' && attempt === 0) {
          const ok = requestPerm ? await requestPerm() : false;
          if (ok) {
            out.next = tf('app.docker.exec-needs-root', { v1: (out.value) });
            abort = new AbortController();
            continue;
          }
        }
        out.next = tf('app.docker.exec-failed-sep', { v1: (out.value), v2: (e.message) });
        running.next = false;
        started = false;
        onDone?.(false);
        return;
      }
    }
  }

  function FormPart() {
    return h('div', {
      class: 'dk-form-grid',
      style: running.value ? { display: 'none' } : {},
    }, formNodes);
  }

  function OutputPart() {
    return h('pre', {
      class: 'dk-modal-log',
      ref: preRef,
      style: running.value ? {} : { display: 'none' },
      text: out.value,
    });
  }

  function StartBtn() {
    if (finished.value) return null;
    return h('button', {
      class: 'btn btn-primary btn-sm',
      text: running.value ? t('app.docker.status-running') : t('app.docker.action-start-run'),
      disabled: running.value,
      onClick: run,
    });
  }

  const handle = { closed: false };
  const close = () => {
    if (handle.closed) return;
    handle.closed = true;
    abort?.abort();
    isl.close();
    onClose?.();
  };

  function Panel() {
    return h('div', {
      class: 'overlay',
      onClick: (e) => { if (e.target === e.currentTarget && !started) close(); },
      onKeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } },
    }, h('div', { class: 'dialog dialog-sm' }, [
      h('div', { class: 'dialog-head' }, [h('div', { class: 'dialog-title', text: title })]),
      h('div', { class: 'dialog-body' }, [h(FormPart, {}), h(OutputPart, {})]),
      h('div', { class: 'dialog-foot' }, [
        h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-close'), onClick: close }),
        h(StartBtn, {}),
      ]),
    ]));
  }

  const isl = island(() => h(Panel, {}));
  return { close, run, isFinished: () => finished.value };
}

export function createImagesView(deps) {
  const rows = signal([]);
  const search = signal('');
  const filter = signal('all');
  const checked = signal(new Set());
  const loading = signal(true);
  const error = signal('');

  const host = listHost();
  host.mount(listTree);

  function isDangling(img) {
    return !img.Repository || img.Repository === '<none>';
  }

  function shown() {
    let list = rows.value;
    if (filter.value === 'dangling') list = list.filter(isDangling);
    const q = search.value;
    if (!q) return list;
    return list.filter((img) =>
      String(img.Repository || '').toLowerCase().includes(q)
      || String(img.Tag || '').toLowerCase().includes(q)
      || String(img.ID || '').toLowerCase().includes(q));
  }

  function toggleOne(ref, on) {
    const next = new Set(checked.value);
    if (on) next.add(ref);
    else next.delete(ref);
    checked.next = next;
  }

  function toggleAll(list, on) {
    const next = new Set(checked.value);
    for (const img of list) {
      const ref = imageRef(img);
      if (on) next.add(ref);
      else next.delete(ref);
    }
    checked.next = next;
  }

  async function refresh() {
    loading.next = true;
    error.next = '';
    try {
      const d = await deps.auth(() => api.dockerImages(deps.host()));
      rows.next = d.images || [];
      loading.next = false;
    } catch (e) {
      loading.next = false;
      error.next = e.message || String(e);
    }
    deps.changed();
  }

  function tableTree(list) {
    const sel = checked.value;
    const allChecked = list.every((img) => sel.has(imageRef(img)));
    return h('table', { class: 'qx-table' }, [
      h('thead', null, [h('tr', null, [
        h('th', null, [h('input', { type: 'checkbox', class: 'dk-check',
          checked: allChecked,
          onChange: (e) => toggleAll(list, e.target.checked),
        })]),
        h('th', { text: t('app.docker.col-repo') }),
        h('th', { text: t('app.docker.col-tag') }),
        h('th', { text: 'ID' }),
        h('th', { text: t('app.docker.col-size') }),
        h('th', { text: t('app.docker.col-created') }),
      ])]),
      h('tbody', null, list.map((img) => {
        const ref = imageRef(img);
        return h('tr', {
          key: ref,
          onContextmenu: (e) => {
            e.preventDefault();
            deps.menu(e.clientX, e.clientY, [
              { icon: 'trash', label: t('app.docker.image-delete-ellipsis'), danger: true, onClick: () => removeRefs([ref]) },
            ]);
          },
        }, [
          h('td', null, [h('input', { type: 'checkbox', class: 'dk-check',
            checked: sel.has(ref),
            onChange: (e) => toggleOne(ref, e.target.checked),
          })]),
          h('td', { class: isDangling(img) ? 'dk-tag-none' : 'mono', text: img.Repository || '<none>' }),
          h('td', { class: img.Tag ? 'mono' : 'dk-tag-none', text: img.Tag || '-' }),
          h('td', { class: 'mono', text: String(img.ID || '').slice(0, 12) }),
          h('td', { text: fmtMaybeSize(img.Size) }),
          h('td', { text: img.CreatedAt || img.CreatedSince || '-' }),
        ]);
      })),
    ]);
  }

  function bodyTree() {
    const all = rows.value;
    if (loading.value && !all.length) {
      return h('div', { class: 'qx-card-scroll' }, [spinner(t('app.docker.images-loading'))]);
    }
    if (error.value && !all.length) return loadFailed(error.value, () => refresh());
    const list = shown();
    if (!list.length) {
      return h('div', { class: 'qx-card-scroll' }, [emptyState(all.length ? t('app.docker.images-no-match') : t('app.docker.images-none'))]);
    }
    return h('div', { class: 'qx-card-scroll' }, [tableTree(list)]);
  }

  function listTree() {
    return card(t('app.docker.label-images'), [
      h('div', { class: 'qx-card-tools dk-toolbar' }, [
        searchBox(t('app.docker.images-search'), (v) => { search.next = v.toLowerCase(); }),
        chipGroup([
          { id: 'all', label: t('app.docker.filter-all') },
          { id: 'dangling', label: t('app.docker.filter-dangling') },
        ], filter.value, (id) => { filter.next = id; }),
        h('div', { class: 'dk-toolbar-actions' }, [
          h('button', { class: 'btn btn-primary btn-sm', text: t('app.docker.action-pull'), onClick: () => pullDialog() }),
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-build'), onClick: () => buildDialog() }),
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-prune-dangling'), onClick: () => pruneDangling() }),
          h('button', {
            class: 'btn btn-ghost btn-sm btn-text-danger',
            text: t('app.docker.action-delete-selected'),
            onClick: () => removeSelected(),
          }),
        ]),
      ]),
      bodyTree(),
    ], { fill: true, tools: h('span', { class: 'qx-count', text: tf('app.docker.images-count', { v1: (rows.value.length) }) }) });
  }

  function pullDialog() {
    const inputRef = { current: null };
    const input = h('input', {
      ref: inputRef,
      class: 'input',
      placeholder: t('app.docker.pull-placeholder'),
      value: 'nginx:latest',
    });
    streamDialog({
      title: t('app.docker.action-pull'),
      formNodes: [
        h('div', { class: 'dk-form-row' }, [input]),
        h('div', { class: 'help', text: t('app.docker.pull-hint') }),
      ],
      start: ({ signal: sig, write }) => {
        const image = readInput(inputRef);
        if (!image) return Promise.reject(new Error(t('app.docker.pull-no-name')));
        return api.dockerPullStream(deps.host(), image, { signal: sig, onChunk: write });
      },
      onDone: (ok) => {
        if (ok) {
          toast(t('app.docker.pull-done'), 'success');
          deps.notify(t('app.docker.pull-done'), readInput(inputRef));
          refresh();
        }
      },
      requestPerm: () => deps.requestPerm(),
    });
  }

  function buildDialog() {
    const dirRef = { current: null };
    const tagRef = { current: null };
    const dirInput = h('input', { ref: dirRef, class: 'input', placeholder: t('app.docker.build-dir-placeholder') });
    const tagInput = h('input', { ref: tagRef, class: 'input', placeholder: t('app.docker.build-tag-placeholder') });
    streamDialog({
      title: t('app.docker.build-title'),
      formNodes: [
        h('div', { class: 'dk-form-row' }, [dirInput]),
        h('div', { class: 'dk-form-row' }, [tagInput]),
        h('div', { class: 'help', text: t('app.docker.build-hint') }),
      ],
      start: ({ signal: sig, write }) => {
        const dir = readInput(dirRef);
        if (!dir) return Promise.reject(new Error(t('app.docker.build-no-dir')));
        return api.dockerBuildStream(deps.host(), dir, readInput(tagRef), { signal: sig, onChunk: write });
      },
      onDone: (ok) => {
        if (ok) {
          toast(t('app.docker.build-done-label'), 'success');
          deps.notify(t('app.docker.build-done'), readInput(tagRef) || t('app.docker.build-no-tag'));
          refresh();
        }
      },
      requestPerm: () => deps.requestPerm(),
    });
  }

  async function removeRefs(refs) {
    const v = await deps.checkConfirm(
      refs.length > 1 ? tf('app.docker.confirm-delete-many', { v1: (refs.length) }) : t('app.docker.confirm-delete-one'),
      t('app.docker.confirm-delete-body'),
      [{ key: 'force', label: t('app.docker.field-force-delete') }],
      t('app.docker.action-delete'),
    );
    if (!v) return;
    try {
      await deps.auth(() => api.dockerImageAction({ host: deps.host(), action: 'rm', refs, force: v.force }));
      toast(t('app.docker.image-deleted'), 'success');
      checked.next = new Set();
      refresh();
    } catch (e) {
      toast(tf('app.docker.delete-failed', { v1: (e.message) }), 'error');
    }
  }

  async function removeSelected() {
    const refs = [...checked.value].filter(Boolean);
    if (!refs.length) { toast(t('app.docker.no-images-checked'), 'warning'); return; }
    await removeRefs(refs);
  }

  async function pruneDangling() {
    const ok = await confirmAction(t('app.docker.confirm-prune-dangling'), t('app.docker.confirm-prune-dangling-body'), { okText: t('app.docker.action-prune') });
    if (!ok) return;
    try {
      await deps.auth(() => api.dockerImageAction({ host: deps.host(), action: 'prune' }));
      toast(t('app.docker.pruned-dangling'), 'success');
      refresh();
    } catch (e) {
      toast(tf('app.docker.prune-failed', { v1: (e.message) }), 'error');
    }
  }

  return {
    el: host.el,
    refresh,
    statusBits: () => [tf('app.docker.images-count', { v1: (rows.value.length) })],
    dispose: () => host.dispose(),
  };
}

function createNamedListView(deps, {
  title, unit, searchTip, loadingText, emptyMatch, emptyNone,
  fetchList, listKey, doAction, removeTitle, removeDesc, pruneTitle, pruneDesc,
  columns, menuFor = null, lockedName = null, lockedText = null,
}) {
  const rows = signal([]);
  const search = signal('');
  const checked = signal(new Set());
  const loading = signal(true);
  const error = signal('');
  const noun = unit;

  const host = listHost();
  host.mount(listTree);

  function shown() {
    if (!search.value) return rows.value;
    const q = search.value;
    return rows.value.filter((r) =>
      String(r.Name || '').toLowerCase().includes(q)
      || String(r.Driver || '').toLowerCase().includes(q));
  }

  function toggleOne(name, on) {
    const next = new Set(checked.value);
    if (on) next.add(name);
    else next.delete(name);
    checked.next = next;
  }

  function toggleAll(list, on) {
    const next = new Set(checked.value);
    for (const r of list) {
      if (on) next.add(r.Name);
      else next.delete(r.Name);
    }
    checked.next = next;
  }

  async function refresh() {
    loading.next = true;
    error.next = '';
    try {
      const d = await deps.auth(() => fetchList(deps.host()));
      rows.next = d[listKey] || [];
      loading.next = false;
    } catch (e) {
      loading.next = false;
      error.next = e.message || String(e);
    }
    deps.changed();
  }

  function tableTree(list) {
    const sel = checked.value;
    const allChecked = list.length > 0 && list.every((r) => sel.has(r.Name));
    return h('table', { class: 'qx-table' }, [
      h('thead', null, [h('tr', null, [
        h('th', null, [h('input', { type: 'checkbox', class: 'dk-check',
          checked: allChecked,
          onChange: (e) => toggleAll(list, e.target.checked),
        })]),
        ...columns.map((c) => h('th', { text: c.label })),
      ])]),
      h('tbody', null, list.map((r) => h('tr', {
        key: r.Name,
        onContextmenu: (e) => {
          e.preventDefault();
          const items = menuFor ? menuFor(r) : null;
          if (items) deps.menu(e.clientX, e.clientY, items);
        },
      }, [
        h('td', null, [h('input', { type: 'checkbox', class: 'dk-check',
          checked: sel.has(r.Name),
          onChange: (e) => toggleOne(r.Name, e.target.checked),
        })]),
        ...columns.map((c) => h('td', { class: c.cls || '', text: c.render(r) })),
      ]))),
    ]);
  }

  function bodyTree() {
    const all = rows.value;
    if (loading.value && !all.length) {
      return h('div', { class: 'qx-card-scroll' }, [spinner(loadingText)]);
    }
    if (error.value && !all.length) return loadFailed(error.value, () => refresh());
    const list = shown();
    if (!list.length) {
      return h('div', { class: 'qx-card-scroll' }, [emptyState(all.length ? emptyMatch : emptyNone)]);
    }
    return h('div', { class: 'qx-card-scroll' }, [tableTree(list)]);
  }

  function listTree() {
    return card(title, [
      h('div', { class: 'qx-card-tools dk-toolbar' }, [
        searchBox(searchTip, (v) => { search.next = v.toLowerCase(); }),
        h('div', { class: 'dk-toolbar-actions' }, [
          h('button', { class: 'btn btn-ghost btn-sm', text: t('app.docker.action-prune-unused'), onClick: () => prune() }),
          h('button', {
            class: 'btn btn-ghost btn-sm btn-text-danger',
            text: t('app.docker.action-delete-selected'),
            onClick: () => removeSelected(),
          }),
        ]),
      ]),
      bodyTree(),
    ], { fill: true, tools: h('span', { class: 'qx-count', text: tf('app.docker.count-noun', { v1: (rows.value.length), v2: noun }) }) });
  }

  async function removeNames(names) {
    const locked = lockedName ? names.filter((n) => lockedName(n)) : [];
    const free = locked.length ? names.filter((n) => !lockedName(n)) : names;
    if (locked.length) {
      toast(lockedText ? lockedText(locked) : tf('app.docker.no-items-checked', { v1: noun }), 'warning');
      if (!free.length) return;
    }
    const ok = await confirmAction(
      free.length > 1 ? tf('app.docker.confirm-delete-n-many', { v1: (free.length), v2: noun }) : `${removeTitle}${noun} ${free[0]}？`,
      removeDesc,
      { okText: t('app.docker.action-delete') },
    );
    if (!ok) return;
    try {
      await deps.auth(() => doAction({ host: deps.host(), action: 'rm', names: free }));
      toast(tf('app.docker.deleted-noun', { v1: noun }), 'success');
      checked.next = new Set();
      refresh();
    } catch (e) {
      toast(tf('app.docker.delete-failed', { v1: (e.message) }), 'error');
    }
  }

  async function removeSelected() {
    const names = [...checked.value].filter(Boolean);
    if (!names.length) { toast(tf('app.docker.no-items-checked', { v1: noun }), 'warning'); return; }
    await removeNames(names);
  }

  async function prune() {
    const ok = await confirmAction(pruneTitle, pruneDesc, { okText: t('app.docker.action-prune') });
    if (!ok) return;
    try {
      await deps.auth(() => doAction({ host: deps.host(), action: 'prune' }));
      toast(tf('app.docker.pruned-noun', { v1: noun }), 'success');
      refresh();
    } catch (e) {
      toast(tf('app.docker.prune-failed', { v1: (e.message) }), 'error');
    }
  }

  return {
    el: host.el,
    refresh,
    statusBits: () => [tf('app.docker.count-noun', { v1: (rows.value.length), v2: noun })],
    dispose: () => host.dispose(),
  };
}

export function createVolumesView(deps) {
  return createNamedListView(deps, {
    title: t('app.docker.label-volumes'),
    unit: t('app.docker.noun-volume'),
    searchTip: t('app.docker.volumes-search'),
    loadingText: t('app.docker.volumes-loading'),
    emptyMatch: t('app.docker.volumes-no-match'),
    emptyNone: t('app.docker.volumes-none'),
    fetchList: (host) => api.dockerVolumes(host),
    listKey: 'volumes',
    doAction: (arg) => api.dockerVolumeAction(arg),
    removeTitle: t('app.docker.action-delete-volume'),
    removeDesc: t('app.docker.confirm-delete-volume-body'),
    pruneTitle: t('app.docker.confirm-prune-volumes'),
    pruneDesc: t('app.docker.confirm-prune-volumes-body'),
    columns: [
      { label: t('app.docker.col-name'), cls: 'mono', render: (v) => v.Name || '-' },
      { label: t('app.docker.col-driver'), render: (v) => v.Driver || '-' },
      { label: t('app.docker.col-mountpoint'), cls: 'mono', render: (v) => v.Mountpoint || '-' },
    ],
    menuFor: (v) => [
      { icon: 'trash', label: t('app.docker.volume-delete-ellipsis'), danger: true, onClick: () => removeNames([v.Name]) },
    ],
  });
}

export function createNetworksView(deps) {
  return createNamedListView(deps, {
    title: t('app.docker.label-networks'),
    unit: t('app.docker.noun-network'),
    searchTip: t('app.docker.networks-search'),
    loadingText: t('app.docker.networks-loading'),
    emptyMatch: t('app.docker.networks-no-match'),
    emptyNone: t('app.docker.networks-none'),
    fetchList: (host) => api.dockerNetworks(host),
    listKey: 'networks',
    doAction: (arg) => api.dockerNetworkAction(arg),
    removeTitle: t('app.docker.action-delete-network'),
    removeDesc: t('app.docker.confirm-delete-network-body'),
    pruneTitle: t('app.docker.confirm-prune-networks'),
    pruneDesc: t('app.docker.confirm-prune-networks-body'),
    columns: [
      { label: t('app.docker.col-name'), cls: 'mono', render: (n) => n.Name || '-' },
      { label: t('app.docker.col-driver'), render: (n) => n.Driver || '-' },
      { label: t('app.docker.col-scope'), render: (n) => n.Scope || '-' },
      { label: 'ID', cls: 'mono', render: (n) => String(n.ID || '').slice(0, 12) },
    ],
    lockedName: (n) => ['bridge', 'host', 'none'].includes(n),
    lockedText: (names) => tf('app.docker.network-builtin-locked', { v1: names.join(', ') }),
    menuFor: (n) => [{
      icon: 'trash',
      label: t('app.docker.network-delete-ellipsis'),
      danger: true,
      disabled: ['bridge', 'host', 'none'].includes(n.Name),
      onClick: () => removeNames([n.Name]),
    }],
  });
}