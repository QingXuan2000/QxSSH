/**
 * analyze.js —— 启动分析与单元校验视图
 * 数据面：systemd-analyze time / blame / critical-chain / verify
 */
import { t, tf } from '/assets/js/core/i18n.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast } from '/assets/js/core/ui.js';
import {
  card,
  codeBlock,
  copyButton,
  JsonViewer,
  progressBar,
  spinner,
  emptyState,
  icon,
} from '/assets/js/core/components.js';

import * as api from './api.js';
import { parseCriticalChain } from './format.js';
import { timingShader } from '/assets/js/core/json-shader.js';

export function createAnalyzeView(deps) {
  const el = document.createElement('div');
  el.className = 'sd-fill';

  const loading = signal(false);
  const blameLoading = signal(false);
  const timeInfo = signal(null);
  const blameRows = signal([]);
  const chainText = signal('');
  const blameLimit = signal(15);
  const verifyName = signal('');
  const verifyOut = signal(null);
  const verifyBusy = signal(false);

  async function loadTime() {
    const host = deps.host();
    if (!host) return;
    loading.next = true;
    try {
      const [info, chain] = await Promise.all([
        api.analyzeTime(host),
        api.analyzeCriticalChain(host),
      ]);
      timeInfo.next = info;
      chainText.next = chain || '';
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      loading.next = false;
    }
  }

  async function loadBlame() {
    const host = deps.host();
    if (!host) return;
    blameLoading.next = true;
    try {
      blameRows.next = await api.analyzeBlame(host, blameLimit.value);
    } catch (e) {
      toast(e.message || String(e), 'danger');
    } finally {
      blameLoading.next = false;
    }
  }

  async function loadAll() {
    await Promise.all([loadTime(), loadBlame()]);
  }

  /**
   * systemd-analyze time 里的阶段名是英文（firmware / loader / kernel / userspace），
   * 查中文词条，查不到就回落到原文，避免未知阶段名被抹成空串
   */
  function phaseLabel(name) {
    const key = `app.systemd.analyze-phase-${name}`;
    const text = t(key);
    return text === key ? name : text;
  }

  async function runVerify() {
    const host = deps.host();
    const unit = (verifyName.value || '').trim();
    if (!host || !unit) return;
    verifyBusy.next = true;
    try {
      verifyOut.next = await api.verifyUnit(host, unit);
    } catch (e) {
      verifyOut.next = { ok: false, output: e.message || String(e) };
      toast(e.message || String(e), 'danger');
    } finally {
      verifyBusy.next = false;
    }
  }

  function renderToolbar() {
    const limitSelect = h('select', {
      class: 'select',
      style: { width: '110px', height: '28px', fontSize: '0.76rem' },
      value: String(blameLimit.value),
      onChange: (e) => {
        blameLimit.next = Number(e.target.value);
        loadBlame();
      },
    }, [
      h('option', { value: '10', text: t('app.systemd.analyze-limit-10') }),
      h('option', { value: '15', text: t('app.systemd.analyze-limit-15') }),
      h('option', { value: '30', text: t('app.systemd.analyze-limit-30') }),
      h('option', { value: '50', text: t('app.systemd.analyze-limit-50') }),
    ]);

    return h('div', { class: 'sd-toolbar' }, [
      h('span', { class: 'sd-toolbar-hint', text: t('app.systemd.analyze-hint') }),
      h('div', { class: 'sd-toolbar-actions' }, [
        limitSelect,
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: loadAll,
          title: t('app.systemd.action-refresh'),
        }, [
          h('span', { html: icon('rotate-cw', 'qicon qicon-sm') }),
          h('span', { text: t('app.systemd.action-refresh') }),
        ]),
      ]),
    ]);
  }

  function renderTimeSection() {
    const info = timeInfo.value;
    if (!info) {
      return h('div', { class: 'py-8 flex justify-center' }, [spinner(t('app.systemd.loading'))]);
    }
    if (!info.ok) {
      return h('div', { class: 'py-6 flex justify-center' }, [emptyState(t('app.systemd.analyze-no-boot'))]);
    }

    const tiles = info.parts.map((p) => h('div', { class: 'an-tile' }, [
      h('div', { class: 'an-tile-label', text: phaseLabel(p.name) }),
      h('div', { class: 'an-tile-value mono', text: p.text }),
      h('div', { class: 'an-tile-bar' }, [
        progressBar(p.sec, { max: info.totalSec || 1, kind: 'primary', cls: 'an-progress' }),
      ]),
    ]));

    return h('div', { class: 'an-tiles' }, [
      ...tiles,
      h('div', { class: 'an-tile an-tile-total' }, [
        h('div', { class: 'an-tile-label', text: t('app.systemd.analyze-total') }),
        h('div', { class: 'an-tile-value mono', text: info.totalText || '-' }),
      ]),
    ]);
  }

  function renderBlameSection() {
    const rows = blameRows.value;
    if (blameLoading.value && !rows.length) {
      return h('div', { class: 'py-6 flex justify-center' }, [spinner(t('app.systemd.loading'))]);
    }
    if (!rows.length) {
      return h('div', { class: 'py-6 flex justify-center' }, [emptyState(t('app.systemd.empty-no-data'))]);
    }
    const max = rows.reduce((m, r) => (r.sec > m ? r.sec : m), 0) || 1;

    return h('div', { class: 'an-bars' }, rows.map((r) => h('div', {
      key: r.unit,
      class: 'an-bar-row',
      onClick: () => deps.openUnit?.(r.unit),
    }, [
      h('span', { class: 'an-bar-name mono', title: r.unit, text: r.unit }),
      h('div', { class: 'an-bar-track' }, [
        h('div', {
          class: 'an-bar-fill',
          style: { width: `${Math.max(2, Math.round((r.sec / max) * 100))}%` },
        }),
      ]),
      h('span', { class: 'an-bar-val mono', text: r.timeText }),
    ])));
  }

  function renderChainSection() {
    const text = chainText.value;
    if (!text) {
      return h('div', { class: 'py-6 flex justify-center' }, [emptyState(t('app.systemd.analyze-no-boot'))]);
    }
    // critical-chain 每级缩进 1 空格，与 list-dependencies 的 3 列不同，
    // parseTreeText 用标记字符索引建栈，两种缩进都能还原层级；
    // 末尾两行 @ / + 说明由 parseCriticalChain 摘出，放到树外单独展示
    const { root, tree, legend } = parseCriticalChain(text);
    if (!Object.keys(tree).length) return codeBlock(text);

    return h('div', { class: 'an-chain' }, [
      h(JsonViewer, {
        value: { [root]: tree },
        expandAll: true,
        shader: timingShader(),
        // 键形如「trim_init.service @19.268s +20.456s」：在首个空白处拆开，
        // 单元名留作键、@时刻与+耗时作值。只吃空白不吃 @，
        // 这样 getty@tty1.service 这类单元名里的 @ 不会被误判成时刻标记
        keySplit: /\s+/,
        cls: 'an-json',
      }),
      legend.at || legend.plus
        ? h('div', { class: 'an-legend' }, [
          legend.at ? h('div', { class: 'an-legend-row' }, [
            h('span', { class: 'an-legend-key an-legend-at mono', text: '@' }),
            h('span', { text: t('app.systemd.analyze-legend-at') }),
          ]) : null,
          legend.plus ? h('div', { class: 'an-legend-row' }, [
            h('span', { class: 'an-legend-key an-legend-plus mono', text: '+' }),
            h('span', { text: t('app.systemd.analyze-legend-plus') }),
          ]) : null,
        ].filter(Boolean))
        : null,
    ].filter(Boolean));
  }

  function renderVerifySection() {
    const input = h('input', {
      type: 'text',
      class: 'input',
      style: { width: '240px', height: '28px', fontSize: '0.76rem' },
      placeholder: t('app.systemd.analyze-verify-placeholder'),
      value: verifyName.value,
      onInput: (e) => { verifyName.next = e.target.value; },
      onKeyDown: (e) => { if (e.key === 'Enter') runVerify(); },
    });

    const result = verifyOut.value;
    return h('div', { class: 'flex flex-col gap-2' }, [
      h('div', { class: 'flex items-center gap-1.5' }, [
        input,
        h('button', {
          class: 'btn btn-sm btn-outline',
          onClick: runVerify,
          disabled: verifyBusy.value,
        }, [
          h('span', { html: icon('shield-check', 'qicon qicon-sm') }),
          h('span', { text: t('app.systemd.analyze-verify-run') }),
        ]),
        result ? copyButton(result.output) : null,
      ].filter(Boolean)),
      result
        ? codeBlock(result.output)
        : h('div', { class: 'sd-hint', text: t('app.systemd.analyze-verify-tip') }),
    ]);
  }

  function renderBody() {
    return h('div', { class: 'qx-card-scroll an-scroll' }, [
      h('section', { class: 'an-sec' }, [
        h('div', { class: 'an-sec-head' }, [
          h('span', { class: 'an-sec-title', text: t('app.systemd.analyze-sec-time') }),
          timeInfo.value && timeInfo.value.ok
            ? h('span', { class: 'an-sec-meta mono', text: timeInfo.value.raw })
            : null,
        ].filter(Boolean)),
        renderTimeSection(),
      ]),
      h('section', { class: 'an-sec' }, [
        h('div', { class: 'an-sec-head' }, [
          h('span', { class: 'an-sec-title', text: tf('app.systemd.analyze-sec-blame', { v1: blameRows.value.length }) }),
          h('span', { class: 'an-sec-meta', text: t('app.systemd.analyze-blame-tip') }),
        ]),
        renderBlameSection(),
      ]),
      h('section', { class: 'an-sec' }, [
        h('div', { class: 'an-sec-head' }, [
          h('span', { class: 'an-sec-title', text: t('app.systemd.analyze-sec-chain') }),
          chainText.value ? copyButton(chainText.value) : null,
        ].filter(Boolean)),
        renderChainSection(),
      ]),
      h('section', { class: 'an-sec' }, [
        h('div', { class: 'an-sec-head' }, [
          h('span', { class: 'an-sec-title', text: t('app.systemd.analyze-sec-verify') }),
        ]),
        renderVerifySection(),
      ]),
    ]);
  }

  const view = createView(el);
  view.update(() => {
    const info = timeInfo.value;
    const meta = info && info.ok ? tf('app.systemd.analyze-total-meta', { v1: info.totalText || '-' }) : '';
    return card(t('app.systemd.tab-analyze'), [
      renderToolbar(),
      renderBody(),
    ], {
      fill: true,
      tools: h('span', { class: 'qx-count', text: meta }),
    });
  });

  return {
    el,
    refresh: loadAll,
    statusBits: () => {
      const info = timeInfo.value;
      if (!info || !info.ok) return [];
      return [{
        text: tf('app.systemd.analyze-total-meta', { v1: info.totalText || '-' }),
        tip: t('app.systemd.analyze-sec-time'),
      }];
    },
    dispose: () => {
      view.unmount();
    },
  };
}
