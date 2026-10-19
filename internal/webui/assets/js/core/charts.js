/**
 * core/charts.js —— 曲线图组件与时间序列缓冲
 * 要点：按需加载 uPlot 绘制曲线，跟随主题与容器尺寸自动重绘；timeSeries 提供定长滚动窗口数据。
 */
import { h, useState } from './vdom.js';

const LIB_URL = new URL('../../vendor/uplot.esm.js', import.meta.url).href;
const CSS_URL = new URL('../../vendor/uplot.min.css', import.meta.url).href;

const PALETTE = ['--chart-2', '--chart-1', '--chart-3', '--chart-4', '--chart-5'];

let libPromise = null;

/** 按需加载 uPlot 脚本与样式，加载失败返回 null */
export function loadChartLib() {
  if (!libPromise) {
    if (!document.querySelector(`link[href="${CSS_URL}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      document.head.appendChild(link);
    }
    libPromise = import(LIB_URL)
      .then((m) => m.default || m)
      .catch((err) => {
        console.warn('[charts] uPlot 加载失败，曲线图不可用', err);
        return null;
      });
  }
  return libPromise;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function resolveColor(color, i) {
  const name = color || PALETTE[i % PALETTE.length];
  return name.startsWith('--') ? cssVar(name, '#0037ff') : name;
}

function buildOpts(uPlot, props, width) {
  const {
    series = [], height = 160, time = false, legend = true, cursor = true,
    yFormat = null, xFormat = null, min = null, max = null, xAxis = true, yAxis = true,
    axisSize = 48, spline = true,
  } = props;
  const axisText = cssVar('--muted-foreground', '#8e8e93');
  const gridLine = cssVar('--hairline', 'rgba(0,0,0,.08)');
  const font = '10px "JetBrains Mono", ui-monospace, monospace';
  const yRange = (_u, mn, mx) => {
    const lo = min != null ? min : Math.min(0, mn);
    const hi = max != null ? max : (mx || 1) * 1.1;
    return [lo, hi > lo ? hi : lo + 1];
  };
  return {
    width: Math.max(80, width),
    height: Math.max(40, Number(height) || 160),
    legend: { show: legend },
    cursor: { show: cursor, drag: { x: false, y: false } },
    scales: { x: { time: !!time }, y: { range: yRange } },
    axes: [
      {
        show: xAxis, stroke: axisText, font, grid: { show: false }, ticks: { show: false },
        values: xFormat ? (_u, splits) => splits.map(xFormat) : undefined,
      },
      {
        show: yAxis, size: axisSize, stroke: axisText, font, ticks: { show: false },
        grid: { show: true, stroke: gridLine, width: 1 },
        values: yFormat ? (_u, splits) => splits.map(yFormat) : undefined,
      },
    ],
    series: [
      { label: props.xLabel || '' },
      ...series.map((s, i) => {
        const color = resolveColor(s.color, i);
        return {
          label: s.label || '',
          stroke: color,
          width: s.width || 1.5,
          dash: s.dash || undefined,
          fill: s.fill === false ? undefined : (typeof s.fill === 'string' ? s.fill : withAlpha(color, 0.14)),
          paths: (s.spline ?? spline) ? uPlot.paths.spline() : undefined,
          points: { show: false },
          value: yFormat ? (_u, v) => (v == null ? '—' : yFormat(v)) : undefined,
        };
      }),
    ],
  };
}

/** 曲线图组件：按 series/data 渲染，自适应尺寸与主题变化 */
export function LineChart(props) {
  const { height = 160, cls = '' } = props;
  const rt = useState(() => ({
    el: null, u: null, lib: null, ro: null, mo: null, sig: '', props: null, dead: false,
  })).value;
  rt.props = props;

  const build = () => {
    const { el, lib, u } = rt;
    if (!el || !lib || rt.dead) return;
    if (u) { u.destroy(); rt.u = null; }
    const width = el.clientWidth;
    if (width <= 0) return;
    const p = rt.props;
    rt.u = new lib(buildOpts(lib, p, width), p.data || [[]], el);
    rt.sig = structureSig(p);
    if (typeof p.onReady === 'function') p.onReady(rt.u);
  };

  if (rt.u && rt.lib) {
    if (structureSig(props) !== rt.sig) queueMicrotask(build);
    else rt.u.setData(props.data || [[]]);
  }

  return h('div', {
    class: `qx-chart ${cls}`.trim(),
    style: { height: `${Math.max(40, Number(height) || 160)}px` },
    ref: (el) => { rt.el = el; },
    onMount: (el) => {
      rt.el = el;
      loadChartLib().then((lib) => {
        if (!lib || rt.dead) return;
        rt.lib = lib;
        build();
      });
      if (typeof ResizeObserver === 'function') {
        rt.ro = new ResizeObserver(() => {
          if (rt.u && el.clientWidth > 0) rt.u.setSize({ width: el.clientWidth, height: rt.u.height });
          else if (!rt.u && rt.lib) build();
        });
        rt.ro.observe(el);
      }
      if (typeof MutationObserver === 'function') {
        rt.mo = new MutationObserver(() => build());
        rt.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      }
    },
    onUnmount: () => {
      rt.dead = true;
      if (rt.ro) rt.ro.disconnect();
      if (rt.mo) rt.mo.disconnect();
      if (rt.u) rt.u.destroy();
      rt.u = null;
      rt.el = null;
    },
  });
}

function structureSig(p) {
  const s = (p.series || []).map((x) => [x.label, x.color, x.fill, x.width, x.dash, x.spline].join('|')).join(';');
  return [s, p.height, p.time, p.legend, p.cursor, p.xAxis, p.yAxis, p.min, p.max, p.spline, p.axisSize,
    !!p.yFormat, !!p.xFormat].join('#');
}

/** 创建定长滚动窗口的时间序列缓冲，用于给曲线图喂数据 */
export function timeSeries(size, series = 1) {
  const n = Math.max(2, size | 0);
  const cols = Array.from({ length: series + 1 }, () => new Array(n).fill(null));
  let count = 0;
  return {
    push(values, ts = Date.now()) {
      const vs = Array.isArray(values) ? values : [values];
      for (const c of cols) c.shift();
      cols[0].push(Math.floor(ts / 1000));
      for (let i = 1; i < cols.length; i++) {
        const v = vs[i - 1];
        cols[i].push(Number.isFinite(v) ? v : null);
      }
      if (count < n) count++;
    },
    data() { return cols.map((c) => c.slice(n - count)); },
    peaks() {
      return cols.slice(1).map((c) => c.reduce((m, v) => (v != null && v > m ? v : m), 0));
    },
    get length() { return count; },
    clear() { for (const c of cols) c.fill(null); count = 0; },
  };
}
