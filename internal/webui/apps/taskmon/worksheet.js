import { h, useState } from '/assets/js/core/vdom.js';
import { confirmAction } from '/assets/js/core/ui.js';
import { icon } from '/assets/js/icons/index.js';
import { SENSORS, SENSOR_MAP, newWidget, renderWidgetBody, widgetTitle, widgetHeaderValue, sensorGroupLabel, sensorLabel } from './widgets.js';
import { layout, samples, setLayout } from './state.js';
import { tmonCard } from './shell.js';
import { t, tf } from '/assets/js/core/i18n.js';

const WS_KIND_KEYS = {
  line: 'app.taskmon.ws-kind-line',
  bar: 'app.taskmon.ws-kind-bar',
  log: 'app.taskmon.ws-kind-log',
};

function wsKind(type) {
  const key = WS_KIND_KEYS[type];
  return t(key || 'app.taskmon.ws-kind-gauge');
}

function addWidget(pid, sensorId) {
  if (!SENSOR_MAP.has(sensorId)) return;
  const w = newWidget(sensorId);
  if (!w) return;
  setLayout(pid, [...(layout.value[pid] || []), w]);
}

function toggleSize(pid, w) {
  setLayout(pid, (layout.value[pid] || []).map((x) => (
    x === w ? { ...x, size: x.size === 'l' ? 'm' : 'l' } : x
  )));
}

function removeWidget(pid, w) {
  setLayout(pid, (layout.value[pid] || []).filter((x) => x !== w));
}

async function clearAll(pid) {
  const n = (layout.value[pid] || []).length;
  if (!n) return;
  const ok = await confirmAction(t('app.taskmon.confirm-clear-ws-title'), tf('app.taskmon.confirm-clear-ws-body', { v1: n }),
    { okText: t('app.taskmon.action-clear'), danger: true });
  if (!ok) return;
  setLayout(pid, []);
}

function sensorBrowser(pid) {
  return h('aside', { class: 'tmon-sensors' }, SENSORS.map((g) => h('div', {
    key: g.id, class: 'tmon-sgroup-wrap',
  }, [
    h('div', { class: 'tmon-sgroup' }, [
      h('div', { class: 'tmon-sgroup-t' }, [
        h('span', { html: icon(g.icon, 'qicon-sm') }),
        h('span', { text: sensorGroupLabel(g) }),
      ]),
      ...g.items.map((s) => h('div', {
        key: s.id,
        class: 'tmon-sensor',
        draggable: 'true',
        dataset: { id: s.id },
        title: tf('app.taskmon.ws-widget-label', { v1: sensorLabel(s), v2: wsKind(s.type) }),
        on: {
          dragstart: (e) => {
            e.dataTransfer.setData('text/plain', s.id);
            e.dataTransfer.effectAllowed = 'copy';
          },
          click: () => addWidget(pid, s.id),
        },
      }, [
        h('span', { html: icon(g.icon, 'qicon-sm') }),
        h('span', { text: sensorLabel(s) }),
      ])),
    ]),
  ])));
}

function widgetBox(pid, w) {
  return h('div', { key: w.id, class: `tmon-w${w.size === 'l' ? ' is-l' : ''}` }, [
    h('div', { class: 'tmon-w-head' }, [
      h('span', { class: 'tmon-w-title', text: widgetTitle(w) }),
      h('span', { class: 'tmon-w-now mono', text: widgetHeaderValue(w, samples.value) }),
      h('span', { class: 'tmon-w-acts' }, [
        h('button', {
          class: 'qx-ibtn qx-ibtn-sm',
          type: 'button',
          title: w.size === 'l' ? t('app.taskmon.ws-restore-size') : t('app.taskmon.ws-expand-row'),
          html: icon('layout', 'qicon-sm'),
          onClick: () => toggleSize(pid, w),
        }),
        h('button', {
          class: 'qx-ibtn qx-ibtn-sm',
          type: 'button',
          title: t('app.taskmon.ws-remove'),
          html: icon('circle-minus', 'qicon-sm'),
          onClick: () => removeWidget(pid, w),
        }),
      ]),
    ]),
    renderWidgetBody(w, samples.value),
  ]);
}

function WorksheetPage(props) {
  const { pid } = props;
  const dropping = useState(false);

  const ws = layout.value[pid] || [];

  const grid = h('div', {
    class: `tmon-grid${dropping.value ? ' is-drop' : ''}`,
    on: {
      dragover: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropping.next = true;
      },
      dragleave: (e) => {
        if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
        dropping.next = false;
      },
      drop: (e) => {
        e.preventDefault();
        dropping.next = false;
        addWidget(pid, e.dataTransfer.getData('text/plain'));
      },
    },
  }, ws.length
    ? ws.map((w) => widgetBox(pid, w))
    : [h('div', { class: 'tmon-ws-empty' }, [
      h('div', { html: icon('monitor', 'qicon') }),
      h('div', { text: t('app.taskmon.ws-empty') }),
    ])]);

  return h('div', {
    class: 'tmon-content-scroll',
    on: { dragend: () => { dropping.next = false; } },
  }, tmonCard(t('app.taskmon.ws-title'), [
    h('span', { class: 'tmon-hint', text: t('app.taskmon.ws-hint') }),
    h('div', { class: 'tmon-ws-body' }, [sensorBrowser(pid), grid]),
  ], {
    fill: true,
    tools: h('div', { class: 'qx-card-head-tools' }, [
      h('span', { class: 'qx-count', text: tf('app.taskmon.ws-count', { v1: (ws.length) }) }),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        html: tf('app.taskmon.ws-clear-widgets', { v1: (icon('trash', 'qicon-sm')) }),
        disabled: !ws.length,
        onClick: () => clearAll(pid),
      }),
    ]),
  }));
}

export function buildWorksheet(pid) {
  return h(WorksheetPage, { pid });
}
