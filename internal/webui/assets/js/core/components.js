/**
 * core/components.js —— 界面组件库
 * 要点：基于 vdom 的通用控件集合（布局卡片、表单、表格、菜单、对话框、状态占位等），各应用页按需组合使用；同时转出图标接口。
 */
/** 转出图标模块的查询与判断函数，方便调用方只依赖本文件 */
export { icon, iconNames, hasIcon } from '../icons/index.js';
import { icon, iconNames } from '../icons/index.js';
import { h, island, useState } from './vdom.js';
import { esc } from './dom.js';
import { copyText, task, toast } from './ui.js';
import { t, tf } from './i18n.js';
import { focusWindow } from '../app-bridge.js';

function tip(t) {
  return t ? { dataset: { tip: String(t) } } : {};
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/** 卡片容器，可选标题栏与右上角工具区 */
export function card(title, body, opts = {}) {
  return h('div', { class: cx('cmp-card', opts.fill && 'qx-card-fill', opts.cls) }, [
    title
      ? h('div', { class: cx('cmp-card-title', opts.tools && 'qx-card-head') }, [
        h('span', { text: title }),
        opts.tools,
      ])
      : null,
    h('div', { class: 'cmp-card-body' }, body),
  ]);
}

/** 浮层卡片：标题栏 + 内容区，用于悬浮面板 */
export function FloatCard(props) {
  const { title = '', actions = null, body = [], cls = '', hidden = false } = props;
  return h('div', { class: cx('qx-fcard', cls, hidden && 'hidden') }, [
    (title || actions)
      ? h('div', { class: 'qx-fcard-bar' }, [
        h('span', { class: 'qx-fcard-title', text: title }),
        h('span', { class: 'qx-fcard-actions' }, actions),
      ])
      : null,
    h('div', { class: 'qx-fcard-body' }, body),
  ]);
}

/** 区块小标题 */
export function sectionTitle(t) {
  return h('div', { class: 'cmp-section-title', text: t });
}

/** 键值对展示行，值为空时显示占位符 */
export function keyValue(key, value, opts = {}) {
  const v = (value == null || value === '') ? (opts.placeholder ?? '-') : String(value);
  return h('div', { class: cx('cmp-kv', opts.cls) }, [
    h('span', { class: 'cmp-k', text: key }),
    h('span', { class: cx('cmp-v', opts.mono && 'mono'), text: v }),
  ]);
}

/** 表单字段布局：标签与控件成对出现 */
export function field(label, control) {
  return h('div', { class: 'cmp-field' }, [
    h('label', { class: 'cmp-field-label', text: label }),
    h('div', { class: 'cmp-field-control' }, control),
  ]);
}

/** 图标标签组，点击后回传所选项 id */
export function chipGroup(items, active, onChange, opts = {}) {
  return h('div', { class: cx('cmp-chips', opts.cls) }, items.map((it) => h('button', {
    key: it.id,
    class: cx('cmp-chip', active === it.id && 'active'),
    type: 'button',
    html: it.icon ? `${icon(it.icon, 'qicon-sm')}<span>${it.label}</span>` : `<span>${it.label}</span>`,
    onClick: () => onChange(it.id),
  })));
}

/** 分段选择器：少量互斥选项间切换，带平滑滑动滑块 */
export function segmented(items, value, onChange, opts = {}) {
  const cls = typeof opts === 'string' ? opts : (opts && opts.cls) || '';

  const updateThumb = (root, instant = false) => {
    if (!root) return;
    const thumb = root.querySelector(':scope > .cmp-seg-thumb');
    const active = root.querySelector(':scope > .cmp-seg-item.active');
    if (!thumb) return;
    if (active && active.offsetWidth > 0) {
      const needInstant = instant || !root.__hasSnapped;
      if (needInstant) thumb.style.transition = 'none';
      thumb.style.transform = `translateX(${active.offsetLeft}px)`;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.top = `${active.offsetTop}px`;
      thumb.style.height = `${active.offsetHeight}px`;
      thumb.style.opacity = '1';
      root.__hasSnapped = true;
      if (needInstant) {
        requestAnimationFrame(() => {
          if (thumb) thumb.style.transition = '';
        });
      }
    } else if (active) {
      requestAnimationFrame(() => {
        if (!root.isConnected) return;
        const curActive = root.querySelector(':scope > .cmp-seg-item.active');
        if (curActive && curActive.offsetWidth > 0) {
          const needInstant = instant || !root.__hasSnapped;
          if (needInstant) thumb.style.transition = 'none';
          thumb.style.transform = `translateX(${curActive.offsetLeft}px)`;
          thumb.style.width = `${curActive.offsetWidth}px`;
          thumb.style.top = `${curActive.offsetTop}px`;
          thumb.style.height = `${curActive.offsetHeight}px`;
          thumb.style.opacity = '1';
          root.__hasSnapped = true;
          if (needInstant) {
            requestAnimationFrame(() => {
              if (thumb) thumb.style.transition = '';
            });
          }
        }
      });
    } else {
      thumb.style.opacity = '0';
    }
  };

  const onRef = (el) => {
    if (!el) return;
    updateThumb(el, !el.__hasSnapped);
    requestAnimationFrame(() => updateThumb(el, !el.__hasSnapped));
    if (!el.__segObs && typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(() => updateThumb(el, true));
      obs.observe(el);
      el.__segObs = obs;
    }
  };

  return h('div', { class: cx('cmp-seg', cls), ref: onRef }, [
    h('span', { class: 'cmp-seg-thumb', 'aria-hidden': 'true' }),
    ...items.map((it) => {
      const isActive = value === it.value || (value != null && it.value != null && String(value) === String(it.value));
      return h('button', {
        key: it.value,
        class: cx('cmp-seg-item', isActive && 'active'),
        type: 'button',
        text: it.label,
        onClick: (e) => {
          const btn = e.currentTarget;
          const root = btn?.parentElement;
          if (root) {
            for (const item of root.querySelectorAll(':scope > .cmp-seg-item')) {
              item.classList.toggle('active', item === btn);
            }
            const thumb = root.querySelector(':scope > .cmp-seg-thumb');
            if (thumb && btn.offsetWidth > 0) {
              thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
              thumb.style.width = `${btn.offsetWidth}px`;
              thumb.style.top = `${btn.offsetTop}px`;
              thumb.style.height = `${btn.offsetHeight}px`;
              thumb.style.opacity = '1';
              root.__hasSnapped = true;
            }
          }
          onChange?.(it.value);
        },
      });
    }),
  ]);
}


function sideIcon(v) {
  if (isVNodeish(v)) return v;
  const cls = v && typeof v === 'object' && typeof v.cls === 'string' ? v.cls : 'qicon-sm';
  const name = typeof v === 'string' ? v : v && v.name;
  return h('span', { html: icon(name, cls) });
}

function isVNodeish(v) {
  return !!v && typeof v === 'object' && (typeof v.nodeType === 'number' || v.uid !== undefined);
}

/** 侧边栏分组列表：支持分组标题、空态提示、计数与尾部节点 */
export function sidebarSections(blocks, activeId, onSelect, opts = {}) {
  const pick = (group) => (activeId && typeof activeId === 'object')
    ? (activeId instanceof Map ? activeId.get(group) : activeId[group])
    : activeId;
  const rows = [];
  for (const b of blocks || []) {
    if (b.title != null) {
      rows.push(h('div', { class: 'qx-side-head' }, [
        h('span', { text: b.title }),
        b.actions || null,
      ]));
    }
    if (b.note != null) rows.push(h('div', { class: 'qx-side-note', text: b.note }));
    if (b.node != null) { rows.push(b.node); continue; }
    if (!b.items) continue;
    if (!b.items.length) {
      if (b.empty != null) rows.push(h('div', { class: 'qx-side-note', text: b.empty }));
      continue;
    }
    const want = b.active !== undefined ? b.active : pick(b.group);
    rows.push(h('div', { class: cx('qx-side-list', b.cls) }, b.items.map((it) => {
      const kids = [];
      if (it.lead) kids.push(it.lead);
      if (it.icon) kids.push(sideIcon(it.icon));
      if (it.label != null) kids.push(h('span', { class: 'qx-side-label', text: it.label }));
      if (it.count != null) {
        kids.push(h('span', { class: 'qx-grow' }), h('span', { class: 'qx-count', text: String(it.count) }));
      }
      if (it.trail) kids.push(h('span', { class: 'qx-grow' }), it.trail);
      const on = it.onClick || (it.id == null ? null : () => onSelect(it.id, b.group, it));
      return listRow(kids, {
        key: it.id != null ? it.id : it.label,
        onClick: it.disabled ? undefined : on,
        active: !it.disabled && (it.active !== undefined ? it.active : want === it.id),
        tip: it.tip || '',
        cls: it.disabled ? 'qx-side-off' : '',
        onContext: it.disabled ? undefined : it.onContext,
        onDblClick: it.disabled ? undefined : it.onDblClick,
      });
    })));
  }
  return h('div', { class: cx('qx-side-sections', opts.cls) }, rows);
}

/** 侧边栏单个操作按钮（图标 + 文字） */
export function sideAction({ icon: iconName, label, onClick, tip: tipText = '', on = false, disabled = false }) {
  return h('button', {
    class: cx('cmp-tab', 'qx-side-act', on && 'is-on'),
    type: 'button',
    disabled,
    ...tip(tipText),
    html: `${icon(iconName, 'qicon-sm')}<span>${esc(label)}</span>`,
    onClick,
  });
}

/** 顶部标签页 */
export function Tabs({ items, active, onChange, cls = '' }) {
  return h('div', { class: cx('cmp-tabs', cls) }, items.map((it) => h('button', {
    key: it.id,
    class: cx('cmp-tab-top', active === it.id && 'active'),
    type: 'button',
    html: it.icon ? `${icon(it.icon, 'qicon-sm')}<span>${it.label}</span>` : `<span>${it.label}</span>`,
    onClick: () => onChange(it.id),
  })));
}

/** 面包屑导航，末级不可点击 */
export function breadcrumb(items, onNavigate, { cls = '' } = {}) {
  const nodes = [];
  items.forEach((it, i) => {
    if (i > 0) nodes.push(h('span', { class: 'cmp-crumb-sep', text: '/' }));
    const last = i === items.length - 1;
    nodes.push(h('button', {
      key: it.label,
      class: cx('cmp-crumb-seg', last && 'cur'),
      type: 'button',
      text: it.label,
      disabled: last || !onNavigate,
      onClick: () => onNavigate?.(it, i),
    }));
  });
  return h('div', { class: cx('cmp-crumb', cls) }, nodes);
}

/** 分页控件：页码、省略号与上下页 */
export function pagination(page, totalPages, onChange, { cls = '', siblings = 1 } = {}) {
  const tp = Math.max(1, Math.floor(totalPages) || 1);
  const pg = Math.min(Math.max(1, Math.floor(page) || 1), tp);
  const btn = (target, label, iconName, o = {}) => {
    const props = {
      key: `${label}-${target}`,
      class: cx('cmp-page-btn', o.active && 'active'),
      type: 'button',
      'aria-label': iconName ? label : null,
      'aria-current': o.active ? 'page' : null,
      disabled: !!o.disabled,
      onClick: () => { if (!o.disabled && !o.active) onChange?.(target); },
    };
    if (iconName) props.html = icon(iconName, 'qicon-sm');
    else props.text = String(label);
    return h('button', props);
  };
  const gap = (k) => h('span', { key: k, class: 'cmp-page-ellipsis', text: '…' });

  const out = [btn(pg - 1, t('app.core.page-prev'), 'arrow-left', { disabled: pg <= 1 })];
  out.push(btn(1, 1, null, { active: pg === 1 }));

  const cells = 2 * siblings + 3;
  if (tp - 2 <= cells) {
    for (let i = 2; i <= tp - 1; i++) out.push(btn(i, i, null, { active: i === pg }));
  } else {
    let lo = Math.max(pg - siblings, 2);
    let hi = Math.min(pg + siblings, tp - 1);
    for (;;) {
      const used = (hi - lo + 1) + (lo > 2 ? 1 : 0) + (hi < tp - 1 ? 1 : 0);
      if (used >= cells) break;
      if (hi < tp - 1) hi++;
      else if (lo > 2) lo--;
      else break;
    }
    if (lo > 2) out.push(gap('g1'));
    for (let i = lo; i <= hi; i++) out.push(btn(i, i, null, { active: i === pg }));
    if (hi < tp - 1) out.push(gap('g2'));
  }

  if (tp > 1) out.push(btn(tp, tp, null, { active: pg === tp }));
  out.push(btn(pg + 1, t('app.core.page-next'), 'arrow-right', { disabled: pg >= tp }));
  return h('div', { class: cx('cmp-pagination', cls) }, out);
}

/** 步骤条：展示多步流程进度 */
export function steps(items, current = 0, { cls = '' } = {}) {
  return h('div', { class: cx('cmp-steps', cls) }, items.map((it, i) => h('div', {
    key: it.label ?? i,
    class: cx('cmp-step', i < current && 'done', i === current && 'active'),
  }, [
    h('span', { class: 'cmp-step-dot' }, [
      i < current ? h('span', { html: icon('check', 'qicon-sm') }) : h('span', { text: String(i + 1) }),
    ]),
    h('span', { class: 'cmp-step-copy' }, [
      h('span', { class: 'cmp-step-label', text: it.label ?? '' }),
      it.desc ? h('span', { class: 'cmp-step-desc', text: it.desc }) : null,
    ]),
  ])));
}

/** 时间线列表，用于事件流水展示 */
export function timeline(items, { cls = '' } = {}) {
  return h('div', { class: cx('cmp-timeline', cls) }, items.map((it) => h('div', {
    key: it.title,
    class: 'cmp-tl-item',
  }, [
    h('span', { class: cx('cmp-tl-dot', it.kind) }),
    h('div', { class: 'cmp-tl-body' }, [
      h('div', { class: 'cmp-tl-title', text: it.title ?? '' }),
      it.desc ? h('div', { class: 'cmp-tl-desc', text: it.desc }) : null,
      it.time ? h('div', { class: 'cmp-tl-time mono', text: it.time }) : null,
    ]),
  ])));
}

/** 复选框（可带文字标签） */
export function Checkbox(props) {
  const { label, checked = false, onChange, disabled = false, cls = '', tip: tipText = '' } = props;
  const cur = useState(!!checked);
  const last = useState(!!checked);
  if (last.value !== !!checked) {
    last.value = !!checked;
    cur.value = !!checked;
  }
  return h('label', { class: cx('cmp-check', cls) }, [
    h('input', {
      type: 'checkbox',
      checked: cur.value,
      disabled,
      ...tip(tipText),
      onChange: (e) => { cur.next = e.target.checked; onChange?.(e.target.checked); },
    }),
    label ? h('span', { text: label }) : null,
  ]);
}

/** 开关切换控件 */
export function SwitchToggle(props) {
  const { label, checked = false, onChange, disabled = false, cls = '', tip: tipText = '' } = props;
  const cur = useState(!!checked);
  const last = useState(!!checked);
  if (last.value !== !!checked) {
    last.value = !!checked;
    cur.value = !!checked;
  }
  return h('label', { class: cx('cmp-switch-wrap', cls) }, [
    h('input', {
      type: 'checkbox',
      class: 'cmp-switch',
      checked: cur.value,
      disabled,
      ...tip(tipText),
      onChange: (e) => { cur.next = e.target.checked; onChange?.(e.target.checked); },
    }),
    label ? h('span', { class: 'cmp-switch-label', text: label }) : null,
  ]);
}

/** 文本输入字段（标签 + 输入框） */
export function inputField(label, value, onInput, { type = 'text', placeholder = '', mono = false, cls = '', tip: tipText = '' } = {}) {
  return h('label', { class: cx('cmp-input-field', cls) }, [
    label ? h('span', { class: 'cmp-input-label', text: label }) : null,
    h('input', {
      class: cx('input', mono && 'mono'),
      type,
      value: value ?? '',
      placeholder,
      ...tip(tipText),
      onInput: (e) => onInput?.(e.target.value),
    }),
  ]);
}

/** 下拉选择字段 */
export function selectField(label, options, value, onChange, { cls = '', tip: tipText = '' } = {}) {
  return h('label', { class: cx('cmp-input-field', cls) }, [
    label ? h('span', { class: 'cmp-input-label', text: label }) : null,
    h('select', {
      class: 'select',
      value: value ?? '',
      ...tip(tipText),
      onChange: (e) => onChange?.(e.target.value),
    }, options.map((it) => h('option', {
      key: it.value,
      value: it.value,
      text: it.label ?? it.text ?? '',
      selected: it.value === value,
    }))),
  ]);
}

/** 密码字段，带显示/隐藏切换 */
export function PasswordField(props) {
  const {
    label, value = '', onInput, placeholder = '', cls = '',
    showLabel = t('app.core.show-password'), hideLabel = t('app.core.hide-password'),
  } = props;
  const shown = useState(false);
  return h('label', { class: cx('cmp-input-field', cls) }, [
    label ? h('span', { class: 'cmp-input-label', text: label }) : null,
    h('div', { class: 'cmp-pw-wrap' }, [
      h('input', {
        class: 'input',
        type: shown.value ? 'text' : 'password',
        value,
        placeholder,
        autocomplete: 'new-password',
        onInput: (e) => onInput?.(e.target.value),
      }),
      h('button', {
        class: 'qx-ibtn cmp-pw-eye',
        type: 'button',
        'aria-label': shown.value ? hideLabel : showLabel,
        html: icon(shown.value ? 'eye-off' : 'eye', 'qicon-sm'),
        onClick: () => { shown.next = !shown.value; },
      }),
    ]),
  ]);
}

/** 多行文本域字段 */
export function textareaField(label, value, onInput, { rows = 4, placeholder = '', mono = false, cls = '' } = {}) {
  return h('label', { class: cx('cmp-input-field', cls) }, [
    label ? h('span', { class: 'cmp-input-label', text: label }) : null,
    h('textarea', {
      class: cx('input', 'textarea', mono && 'mono'),
      rows,
      placeholder,
      text: value ?? '',
      onInput: (e) => onInput?.(e.target.value),
    }),
  ]);
}

/** 滑块字段，标题右侧实时显示当前值 */
export function SliderField(props) {
  const { label, value, onChange, min = 0, max = 100, step = 1, unit = '', cls = '' } = props;
  const cur = useState(Number(value));
  return h('div', { class: cx('cmp-slider-field', cls) }, [
    label
      ? h('span', { class: 'cmp-input-label cmp-slider-label' }, [
        h('span', { text: label }),
        h('span', { class: 'cmp-slider-value mono', text: `${cur.value}${unit}` }),
      ])
      : null,
    h('input', {
      type: 'range',
      min,
      max,
      step,
      value: cur.value,
      class: 'cmp-slider',
      onInput: (e) => {
        const n = Number(e.target.value);
        cur.next = n;
        onChange?.(n);
      },
    }),
  ]);
}

/** 数字步进字段（减号/输入框/加号），自动限制范围 */
export function StepperField(props) {
  const { label, value, onChange, min = 0, max = 65535, step = 1, unit = '', cls = '' } = props;
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const cur = useState(clamp(Number(value) || min));
  const emit = (n) => {
    const v = clamp(Number.isFinite(n) ? n : min);
    cur.next = v;
    onChange?.(v);
  };
  return h('div', { class: cx('cmp-stepper', cls) }, [
    label ? h('span', { class: 'cmp-input-label', text: unit ? `${label}（${unit}）` : label }) : null,
    h('div', { class: 'cmp-stepper-row' }, [
      h('button', {
        class: 'qx-ibtn qx-ibtn-sm', type: 'button', html: icon('circle-minus', 'qicon-sm'),
        'aria-label': t('app.core.decrease'), onClick: () => emit(cur.value - step),
      }),
      h('input', {
        class: 'input mono cmp-stepper-input',
        type: 'text',
        inputmode: 'numeric',
        value: String(cur.value),
        onChange: (e) => emit(parseInt(e.target.value, 10)),
      }),
      h('button', {
        class: 'qx-ibtn qx-ibtn-sm', type: 'button', html: icon('circle-plus', 'qicon-sm'),
        'aria-label': t('app.core.increase'), onClick: () => emit(cur.value + step),
      }),
    ]),
  ]);
}

/** 单选组 */
export function RadioGroup(props) {
  const { items, value, onChange, name = 'qx-radio', cls = '', disabled = false } = props;
  const cur = useState(value);
  return h('div', { class: cx('cmp-radio-group', cls) }, items.map((it) => h('label', {
    key: it.value,
    class: 'cmp-radio',
  }, [
    h('input', {
      type: 'radio',
      name,
      disabled,
      checked: cur.value === it.value,
      onChange: (e) => {
        if (!e.target.checked) return;
        cur.next = it.value;
        onChange?.(it.value);
      },
    }),
    it.label ? h('span', { text: it.label }) : null,
  ])));
}

/** 标签输入框：回车或逗号添加，退格删除末尾项 */
export function TagInput(props) {
  const { tags, onChange, placeholder = t('app.core.enter-to-add'), cls = '' } = props;
  const list = useState([...(tags || [])]);
  const next = (arr) => { list.next = arr; onChange?.(arr); };
  return h('div', { class: cx('cmp-tag-input', cls) }, [
    ...list.value.map((t) => h('span', { key: t, class: 'cmp-tag-chip' }, [
      h('span', { text: t }),
      h('button', {
        class: 'cmp-tag-x', type: 'button', html: icon('close', 'qicon-sm'),
        'aria-label': tf('app.core.remove-item', { v1: t }),
        onClick: () => next(list.value.filter((x) => x !== t)),
      }),
    ])),
    h('input', {
      class: 'cmp-tag-entry',
      placeholder,
      spellcheck: 'false',
      onKeyDown: (e) => {
        const input = e.target;
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const v = input.value.trim();
          if (v && !list.value.includes(v)) next([...list.value, v]);
          input.value = '';
        } else if (e.key === 'Backspace' && !input.value && list.value.length) {
          next(list.value.slice(0, -1));
        }
      },
    }),
  ]);
}

/** 键值对编辑器，用于环境变量一类配置 */
export function KvEditor(props) {
  const { pairs, onChange, keyPlaceholder = t('app.core.col-key'), valuePlaceholder = t('app.core.col-value'), cls = '' } = props;
  const rows = useState((pairs || []).map(([k, v]) => [String(k ?? ''), String(v ?? '')]));
  const emit = () => onChange?.(rows.value.filter(([k]) => k.trim()));
  const set = (i, k, v) => {
    const next = rows.value.map((r, j) => (j === i ? [k, v] : r));
    rows.next = next;
    emit();
  };
  return h('div', { class: cx('cmp-kv-editor', cls) }, [
    ...rows.value.map(([k, v], i) => h('div', { key: i, class: 'cmp-kv-row' }, [
      h('input', {
        class: 'input cmp-kv-key', placeholder: keyPlaceholder, value: k, spellcheck: 'false',
        onInput: (e) => set(i, e.target.value, rows.value[i][1]),
      }),
      h('input', {
        class: 'input cmp-kv-val', placeholder: valuePlaceholder, value: v, spellcheck: 'false',
        onInput: (e) => set(i, rows.value[i][0], e.target.value),
      }),
      h('button', {
        class: 'qx-ibtn qx-ibtn-sm', type: 'button', html: icon('trash', 'qicon-sm'),
        'aria-label': t('app.core.remove-row'),
        onClick: () => { rows.next = rows.value.filter((_, j) => j !== i); emit(); },
      }),
    ])),
    h('button', {
      class: 'btn btn-ghost btn-sm cmp-kv-add', type: 'button',
      html: tf('app.core.add-item', { v1: (icon('plus', 'qicon-sm')) }),
      onClick: () => { rows.next = [...rows.value, ['', '']]; },
    }),
  ]);
}

/** 数据表格：支持自定义列渲染、行点击与空态 */
export function table(columns, rows, { cls = '', empty = t('app.core.empty-no-data'), rowKey = null, onRowClick = null } = {}) {
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', {
    key: c.key,
    class: c.cls || '',
    style: c.width ? { width: c.width } : {},
    text: c.label ?? '',
  }))));
  const tbody = h('tbody', null, (rows || []).map((row, i) => {
    const key = rowKey ? String(rowKey(row, i)) : String(i);
    return h('tr', {
      key,
      dataset: rowKey ? { key } : {},
      class: onRowClick ? 'clickable' : '',
      onClick: onRowClick ? () => onRowClick(row, i) : undefined,
    }, columns.map((c) => {
      const rendered = c.render ? c.render(row, i) : null;
      if (isVNodeish(rendered)) return h('td', { key: c.key, class: c.cls || '' }, [rendered]);
      if (rendered == null) return h('td', { key: c.key, class: c.cls || '', text: String(row[c.key] ?? '') });
      return h('td', { key: c.key, class: c.cls || '', html: String(rendered) });
    }));
  }));
  const el = h('table', { class: cx('qx-table', cls) }, [thead, tbody]);
  if (!rows || !rows.length) {
    return h('div', { class: 'qx-card-scroll' }, [el, h('div', { class: 'qx-card-empty', text: empty })]);
  }
  return el;
}

/** 键值对网格展示 */
export function kvGrid(pairs, { cols = 2, cls = '' } = {}) {
  return h('div', {
    class: cx('cmp-kv-grid', cls),
    style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` },
  }, pairs.map(([k, v]) => keyValue(k, v)));
}

/** 树形列表：支持折叠、选中与自定义行渲染 */
export function Tree(props) {
  const {
    items, collapsed = [], onToggle, onSelect, cls = '', indent = 16, rowRender = null,
  } = props;
  const isCollapsed = (v) => (collapsed instanceof Set ? collapsed.has(v) : (collapsed || []).includes(v));
  const out = [];
  paint(items, 0, out);
  return h('div', { class: cx('cmp-tree', cls) }, out);

  function paint(list, depth, acc) {
    for (const it of (list || [])) {
      const kids = Array.isArray(it.children) ? it.children : [];
      const expanded = !isCollapsed(it.id);
      const toggle = h('button', {
        class: cx('cmp-tree-tw', !kids.length && 'is-empty'),
        type: 'button',
        title: kids.length ? (expanded ? t('app.core.collapse') : t('app.core.expand')) : '',
        html: kids.length ? icon(expanded ? 'chevron-down' : 'chevron-right', 'qicon-sm') : '',
        onClick: (e) => { e.stopPropagation(); onToggle?.(it.id, !expanded); },
      });
      const content = rowRender
        ? rowRender(it, depth, expanded, toggle)
        : [
          toggle,
          it.lead || null,
          it.icon ? h('span', { class: 'qicon-sm', html: icon(it.icon, 'qicon-sm') }) : null,
          h('span', { class: 'cmp-tree-label', text: it.label == null ? '' : String(it.label) }),
          it.badge != null ? badge(it.badge, it.badgeKind || 'default') : null,
          it.trail || null,
        ];
      const row = rowRender
        ? content
        : listRow(content, {
          cls: it.disabled ? 'qx-side-off' : '',
          tip: it.tip || '',
          active: !!it.active,
          onClick: it.disabled ? undefined : (it.onClick || (it.id != null ? () => onSelect?.(it) : null)),
          onDblClick: it.onDblClick,
          onContext: it.onContext,
        });
      acc.push(cloneWithClass(row, 'cmp-tree-row', { '--cmp-tree-indent': `${depth * indent}px` }));
      if (kids.length && expanded) paint(kids, depth + 1, acc);
    }
    return acc;
  }
}

function cloneWithClass(vnode, extraClass, style) {
  if (!vnode) return vnode;
  if (typeof vnode.nodeType === 'number') {
    vnode.classList.add(extraClass);
    for (const [k, val] of Object.entries(style || {})) {
      if (k.startsWith('--')) vnode.style.setProperty(k, val);
      else vnode.style[k] = val;
    }
    return vnode;
  }
  return h(vnode.type, {
    ...vnode.props,
    class: cx(vnode.props.class, extraClass),
    style: { ...(vnode.props.style || {}), ...(style || {}) },
  }, vnode.children);
}

/** JSON 查看器：节点可折叠，默认按深度展开 */
export function JsonViewer(props) {
  const { value, maxDepth = 2, cls = '', rootLabel = '' } = props;
  const opened = useState(new Set());
  const toggle = (k) => {
    const s = new Set(opened.value);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    opened.next = s;
  };
  return h('div', { class: cx('cmp-json', cls) }, [
    rootLabel ? h('div', { class: 'cmp-json-root', text: rootLabel }) : null,
    node(null, value, 0),
  ].filter(Boolean));

  function isBranch(v) { return v !== null && typeof v === 'object'; }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }
  function preview(v) {
    if (Array.isArray(v)) return `[ ${v.length} ]`;
    return `{ ${Object.keys(v || {}).length} }`;
  }
  function pathKey(key, depth) { return `${depth}:${key}`; }

  function node(key, v, depth) {
    const branch = isBranch(v);
    const path = pathKey(key, depth);
    const open = depth < maxDepth || opened.value.has(path);
    return h('div', { class: 'cmp-json-node' }, [
      h('div', { class: 'cmp-json-row' }, [
        h('button', {
          class: cx('cmp-json-tw', !branch && 'is-empty', open && 'open'),
          type: 'button',
          html: branch ? icon(open ? 'chevron-down' : 'chevron-right', 'qicon-sm') : '',
          onClick: (e) => { e.stopPropagation(); if (branch) toggle(path); },
        }),
        key != null ? h('span', { class: 'cmp-json-key', text: String(key) }) : null,
        key != null && branch ? h('span', { class: 'cmp-json-colon', text: ':' }) : null,
        branch ? h('span', { class: 'cmp-json-summary', text: open ? '' : preview(v) }) : null,
        branch ? null : h('span', {
          class: `cmp-json-val cmp-json-${typeOf(v)}`,
          text: typeof v === 'string' ? `"${v}"` : String(v),
        }),
      ]),
      branch && open ? h('div', { class: 'cmp-json-kids' }, childNodes(key, v, depth)) : null,
    ].filter(Boolean));
  }

  function childNodes(key, v, depth) {
    return Array.isArray(v)
      ? v.map((x, i) => node(i, x, depth + 1))
      : Object.entries(v).map(([k, x]) => node(k, x, depth + 1));
  }
}

/** 代码块展示 */
export function codeBlock(code, { cls = '', mono = true } = {}) {
  return h('pre', { class: cx('cmp-code', mono && 'mono', cls), text: String(code ?? '') });
}

/** 复制按钮，复制完成后可选回调结果 */
export function copyButton(text, { tip: tipText = t('app.core.copy'), onDone, cls = '' } = {}) {
  return iconButton('copy', {
    tip: tipText,
    cls,
    onClick: async () => {
      const ok = await copyText(text);
      if (onDone) onDone(ok);
    },
  });
}

/** 只读文本 + 复制按钮的组合字段 */
export function copyField(text, { cls = '', mono = true, placeholder = '' } = {}) {
  return h('div', { class: cx('cmp-copy-field', cls) }, [
    h('input', { class: cx('input', mono && 'mono'), readonly: true, value: text ?? '', placeholder }),
    copyButton(text, { tip: t('app.core.copy') }),
  ]);
}

/** 日志面板，渲染后自动滚动到底部 */
export function LogPanel(props) {
  const { title = '', lines = [], maxHeight = '' } = props;
  return h('div', { class: 'cmp-log-panel' }, [
    title ? h('div', { class: 'cmp-log-head', text: title }) : null,
    h('pre', {
      class: 'cmp-log mono',
      style: maxHeight ? { maxHeight } : {},
      text: lines.join('\n'),
      ref: (el) => { if (el) el.scrollTop = el.scrollHeight; },
    }),
  ].filter(Boolean));
}

/** 进度条 */
export function progressBar(value, { max = 100, cls = '', kind = '' } = {}) {
  const pct = Math.max(0, Math.min(100, (Number(value) || 0) / (max || 100) * 100));
  return h('div', { class: cx('cmp-progress', kind && `cmp-progress-${kind}`, cls) }, [
    h('span', { class: 'cmp-progress-fill', style: { width: `${pct}%` } }),
  ]);
}

/** 细条状进度条变体 */
export function segmentedBar(value, { max = 100, kind = '', cls = '' } = {}) {
  return progressBar(value, { max, kind, cls: cx('cmp-bar', cls) });
}

/** 统计小卡片：标签 + 数值（可带单位） */
export function statTile(label, value, { unit = '', kind = '', cls = '' } = {}) {
  return h('div', { class: cx('cmp-stat', kind && `cmp-stat-${kind}`, cls) }, [
    h('div', { class: 'cmp-stat-label', text: label }),
    h('div', { class: 'cmp-stat-value' }, [
      h('span', { class: 'cmp-stat-num', text: String(value) }),
      unit ? h('span', { class: 'cmp-stat-unit', text: unit }) : null,
    ].filter(Boolean)),
  ]);
}

/** 环形进度指示器 */
export function progressRing(value, { size = 76, stroke = 7, max = 100, kind = '', cls = '', label = '' } = {}) {
  const pct = Math.max(0, Math.min(1, (Number(value) || 0) / (max || 100)));
  const r = (size - stroke) / 2;
  const c = (2 * Math.PI * r).toFixed(2);
  const circle = (clsName, offset) => h('circle', {
    cx: String(size / 2),
    cy: String(size / 2),
    r: String(r),
    fill: 'none',
    'stroke-width': String(stroke),
    'stroke-dasharray': c,
    'stroke-dashoffset': offset,
    class: clsName,
  });
  const svg = h('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: String(size),
    height: String(size),
    class: cx('cmp-ring-circle', kind && `cmp-ring-${kind}`),
  }, [
    circle('cmp-ring-bg', '0'),
    circle('cmp-ring-fill', (c * (1 - pct)).toFixed(2)),
  ]);
  return h('div', { class: cx('cmp-ring', cls), style: { width: `${size}px`, height: `${size}px` } }, [
    svg,
    h('span', { class: 'cmp-ring-text', text: label || `${Math.round(pct * 100)}%` }),
  ]);
}

/** 单条命令执行结果卡片（输出、错误与耗时） */
export function execResultCard({ ok, name = '', title = '', out = '', err = '', dur = '' }) {
  const text = err ? (out ? `${err}\n${out}` : err) : (out || t('app.core.no-output'));
  return h('div', { class: cx('qx-exec-item', !ok && 'fail') }, [
    h('div', { class: 'qx-exec-head' }, [
      h('span', { class: 'qx-exec-name', text: name, title }),
      h('span', { class: 'qx-exec-meta' }, [
        h('span', { class: cx('qx-exec-badge', !ok && 'fail'), text: ok ? t('app.core.ok') : t('app.core.failed') }),
        dur ? h('span', { class: 'qx-exec-dur mono', text: dur }) : null,
      ].filter(Boolean)),
    ]),
    h('pre', { class: 'qx-exec-out', text }),
  ]);
}

/** 多条命令执行结果汇总 */
export function execResults(items, { sum = '' } = {}) {
  return h('div', { class: 'qx-exec-results' }, [
    sum ? h('div', { class: 'qx-exec-sum', text: sum }) : null,
    ...items.map((it) => execResultCard(it)),
  ].filter(Boolean));
}

/** 加载中占位 */
export function spinner(text = t('app.core.loading')) {
  return h('div', { class: 'cmp-state' }, [
    h('div', { class: 'cmp-spinner' }),
    h('div', { class: 'cmp-state-text', text }),
  ]);
}

/** 空数据占位，支持纯文本字符串或 { title, desc } 对象 */
export function emptyState(text = t('app.core.empty-no-data')) {
  if (text && typeof text === 'object' && !isVNodeish(text)) {
    const { title = '', desc = '' } = text;
    return h('div', { class: 'cmp-state cmp-empty' }, [
      title ? h('div', { class: 'cmp-state-title', style: { fontWeight: '600', color: 'var(--foreground)' }, text: String(title) }) : null,
      desc ? h('div', { class: 'cmp-state-desc cmp-state-text', text: String(desc) }) : null,
    ].filter(Boolean));
  }
  return h('div', { class: 'cmp-state cmp-empty cmp-state-text', text: String(text ?? '') });
}

/** 加载失败占位 */
export function errorState(text = t('app.core.load-failed')) {
  return h('div', { class: 'cmp-state cmp-error', text });
}

/** 状态徽标 */
export function badge(text, kind = 'default') {
  return h('span', { class: `cmp-badge cmp-badge-${kind}`, text: String(text) });
}

/** 状态小圆点，用颜色表示状态并可带悬浮提示 */
export function statusDot(kind = '', tipText = '') {
  return h('span', { class: cx('qx-dot', kind), ...tip(tipText) });
}

/** 底部状态条：把若干片段拼成一行 */
export function statusBar(bits, { cls = '' } = {}) {
  const list = (Array.isArray(bits) ? bits : [bits]).filter(Boolean);
  return h('div', { class: cx('qx-status-bar', 'qx-status', cls) }, list.map((b, i) => {
    if (isVNodeish(b)) return b;
    if (b && typeof b === 'object') {
      return h('span', { key: i, class: 'qx-status-bit', text: String(b.text ?? ''), ...tip(b.tip) });
    }
    return h('span', { key: i, class: 'qx-status-bit', text: String(b) });
  }));
}

/** 提示横幅：info/success/error 等风格 */
export function alertBar(kind, title, desc = '', { cls = '' } = {}) {
  const ic = kind === 'error' ? 'warning' : (kind === 'success' ? 'check' : 'info');
  return h('div', { class: cx('alert', `alert-${kind}`, cls) }, [
    h('span', { class: 'alert-ic', html: icon(ic, 'qicon qicon-sm') }),
    h('span', null, [
      title ? h('span', { class: 'alert-title', text: title }) : null,
      desc ? h('span', { class: 'alert-desc', text: desc }) : null,
    ].filter(Boolean)),
  ]);
}

/** 骨架屏占位块 */
export function skeleton(cls = '') {
  return h('div', { class: cx('cmp-skel', cls) });
}

/** 可折叠区块 */
export function Collapsible(props) {
  const { title, body, open = false, cls = '' } = props;
  const isOpen = useState(!!open);
  return h('div', { class: cx('cmp-collapse', cls) }, [
    h('button', {
      class: cx('cmp-collapse-head', isOpen.value && 'open'),
      type: 'button',
      html: `${icon('chevron', 'qicon qicon-sm cmp-collapse-ic')}<span>${title}</span>`,
      onClick: () => { isOpen.next = !isOpen.value; },
    }),
    h('div', { class: cx('cmp-collapse-body', !isOpen.value && 'hidden') }, body),
  ]);
}

/** 带操作按钮的空态 */
export function emptyAction(text, actionLabel, onAction, { cls = '' } = {}) {
  return h('div', { class: cx('cmp-state', 'cmp-empty', cls) }, [
    h('div', { class: 'cmp-state-text', text }),
    actionLabel ? h('button', { class: 'btn btn-ghost btn-sm', text: actionLabel, onClick: onAction }) : null,
  ].filter(Boolean));
}

/** 行内确认条：确认或取消后自动消失 */
export function ConfirmBar(props) {
  const { message, onConfirm, okText = t('app.core.confirm'), cancelText = t('app.core.cancel'), danger = true, cls = '' } = props;
  const done = useState(false);
  if (done.value) return null;
  return h('div', { class: cx('cmp-confirm-bar', cls) }, [
    h('span', { class: 'cmp-confirm-msg', text: message }),
    h('button', { class: 'btn btn-ghost btn-sm', text: cancelText, onClick: () => { done.next = true; } }),
    h('button', {
      class: cx('btn', danger ? 'btn-danger' : 'btn-primary', 'btn-sm'),
      text: okText,
      onClick: () => { done.next = true; onConfirm?.(); },
    }),
  ]);
}

/** 图标按钮（纯图标 + 悬浮提示） */
export function iconButton(name, { tip: tipText = '', active = false, disabled = false, cls = '', onClick } = {}) {
  return h('button', {
    class: cx('qx-ibtn', active && 'active', cls),
    type: 'button',
    html: icon(name, 'qicon'),
    disabled,
    ...tip(tipText),
    onClick,
  });
}

/** 搜索框，实时回调输入内容并兼容中文输入法 */
export function searchBox(placeholder, onInput, { value, cls = '', tip: tipText = '' } = {}) {
  const composing = { on: false };
  const inputProps = {
    class: 'input',
    type: 'search',
    placeholder,
    ...tip(tipText),
    onCompositionstart: () => { composing.on = true; },
    onCompositionend: (e) => { composing.on = false; onInput(e.target.value.trim()); },
    onInput: (e) => { if (!composing.on) onInput(e.target.value.trim()); },
    onSearch: (e) => { onInput(e.target.value.trim()); },
  };
  if (value !== undefined) inputProps.value = String(value ?? '');
  return h('div', { class: cx('qx-search', cls) }, [
    h('span', { html: icon('search', 'qicon qicon-sm') }),
    h('input', inputProps),
  ]);
}

/** 工具栏容器：左内容右操作，中间自动撑开 */
export function toolbar(children, { cls = '', end = null } = {}) {
  const nodes = (Array.isArray(children) ? children : [children]).filter(Boolean);
  if (end) nodes.push(h('span', { class: 'qx-grow' }), end);
  return h('div', { class: cx('qx-card-tools', cls) }, nodes);
}

/** 列表行容器：支持选中、点击、双击与右键事件 */
export function listRow(children, {
  cls = '', onClick, active = false, tip: tipText = '', onContext = null, onDblClick = null, key,
} = {}) {
  return h('div', {
    key,
    class: cx('cmp-row', active && 'active', onClick && 'clickable', cls),
    ...tip(tipText),
    onClick,
    onDblClick,
    onContext,
  }, (Array.isArray(children) ? children : [children]).filter(Boolean));
}

/** 菜单面板视图，由 menu 弹出时使用 */
export function MenuPanel(props) {
  const { items, x = 0, y = 0, onClose = null, cls = '', zIndex = null } = props;
  const place = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    let left = x;
    if (left + r.width > window.innerWidth - m) left = x - r.width;
    let top = y;
    if (top + r.height > window.innerHeight - m) top = y - r.height;
    el.style.left = `${Math.max(m, left)}px`;
    el.style.top = `${Math.max(m, top)}px`;
  };
  return h('div', {
    class: cx('menu', 'qx-menu', cls),
    style: { left: `${x}px`, top: `${y}px`, zIndex: zIndex == null ? null : String(zIndex) },
    ref: place,
  }, items.map((it, i) => {
    if (it.sep) return h('hr', { key: `s${i}`, class: 'divider' });
    if (it.head) return h('div', { key: `h${i}`, class: 'menu-head', text: it.head });
    return h('button', {
      key: `i${i}`,
      class: cx('menu-item', it.danger && 'danger', it.active && 'active'),
      type: 'button',
      html: `${it.icon ? icon(it.icon, 'qicon qicon-sm') : ''}<span>${it.label ?? ''}</span>`,
      disabled: !!it.disabled,
      onClick: () => { onClose?.(); it.onClick?.(); },
    }, it.hint ? h('span', { class: 'menu-item-hint mono', text: it.hint }) : null);
  }));
}

/** 弹出上下文菜单，返回可关闭的句柄 */
export function menu(items, { x = 0, y = 0, onClose = null, cls = '', zIndex = null } = {}) {
  const handle = { closed: false, off: [], timer: null };
  const close = () => {
    if (handle.closed) return;
    handle.closed = true;
    if (handle.timer !== null) { clearTimeout(handle.timer); handle.timer = null; }
    for (const fn of handle.off) fn();
    handle.off.length = 0;
    handle.unmount();
    onClose?.();
  };
  const isl = island(() => h(MenuPanel, { items, x, y, cls, zIndex, onClose: close }));
  handle.unmount = isl.close;
  const onDown = (e) => { if (!isl.el.contains(e.target)) close(); };
  handle.timer = setTimeout(() => {
    handle.timer = null;
    if (handle.closed) return;
    document.addEventListener('mousedown', onDown, true);
    handle.off.push(() => document.removeEventListener('mousedown', onDown, true));
  }, 0);
  const onBlur = () => close();
  window.addEventListener('blur', onBlur);
  handle.off.push(() => window.removeEventListener('blur', onBlur));
  window.addEventListener('resize', onBlur);
  handle.off.push(() => window.removeEventListener('resize', onBlur));
  return { close, get closed() { return handle.closed; } };
}

/** 把面板挂在锚点附近并自动避让边界，返回可关闭的句柄 */
export function openPopper(panel, {
  anchor, placement = 'bottom', gap = 6, cls = '', zIndex = null, onClose = null,
  props = null,
} = {}) {
  const el = typeof anchor === 'function' ? anchor() : anchor;
  const handle = { closed: false, off: [], timer: null };
  const close = () => {
    if (handle.closed) return;
    handle.closed = true;
    if (handle.timer !== null) { clearTimeout(handle.timer); handle.timer = null; }
    for (const fn of handle.off) fn();
    handle.off.length = 0;
    handle.unmount();
    onClose?.();
  };
  const isl = island(() => h(panel, { ...(props || {}), cls, onClose: close }));
  handle.unmount = isl.close;
  const place = () => {
    const node = isl.el.firstElementChild;
    if (!node) return;
    if (zIndex != null) node.style.zIndex = String(zIndex);
    const a = el && el.isConnected ? el : null;
    if (!a) {
      node.style.left = '8px';
      node.style.top = '8px';
      return;
    }
    const r = a.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fits = (v) => v >= m && v + (placement === 'left' || placement === 'right' ? b.height : b.width) <=
      (placement === 'left' || placement === 'right' ? vh : vw) - m;
    let pos = { left: r.left, top: r.bottom + gap };
    if (placement === 'top') pos = { left: r.left, top: r.top - b.height - gap };
    else if (placement === 'right') pos = { left: r.right + gap, top: r.top };
    else if (placement === 'left') pos = { left: r.left - b.width - gap, top: r.top };
    if (!fits(pos.left) && (placement === 'left' || placement === 'right')) {
      pos.left = placement === 'left' ? r.right + gap : r.left - b.width - gap;
    } else if (!fits(pos.top) && placement !== 'left' && placement !== 'right') {
      pos.top = r.top - b.height - gap;
    }
    node.style.left = `${Math.min(Math.max(m, pos.left), Math.max(m, vw - b.width - m))}px`;
    node.style.top = `${Math.min(Math.max(m, pos.top), Math.max(m, vh - b.height - m))}px`;
  };
  place();
  window.addEventListener('scroll', place, true);
  handle.off.push(() => window.removeEventListener('scroll', place, true));
  const onDown = (e) => { if (!isl.el.contains(e.target)) close(); };
  handle.timer = setTimeout(() => {
    handle.timer = null;
    if (handle.closed) return;
    document.addEventListener('mousedown', onDown, true);
    handle.off.push(() => document.removeEventListener('mousedown', onDown, true));
  }, 0);
  const drop = () => close();
  window.addEventListener('blur', drop);
  handle.off.push(() => window.removeEventListener('blur', drop));
  window.addEventListener('resize', drop);
  handle.off.push(() => window.removeEventListener('resize', drop));
  return { close, get closed() { return handle.closed; } };
}

/** 对话框视图（遮罩 + 标题 + 内容 + 操作区） */
export function DialogPanel(props) {
  const { title = '', body = [], actions = null, width = '', onClose = null, cls = '' } = props;
  return h('div', {
    class: 'overlay',
    onClick: (e) => { if (e.target === e.currentTarget) onClose?.(undefined); },
    onKeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(undefined); } },
  }, h('div', { class: cx('dialog', width && `dialog-${width}`, cls) }, [
    title
      ? h('div', { class: 'dialog-head' }, [
        h('div', { class: 'dialog-title', text: title }),
        h('button', {
          class: 'dialog-close',
          type: 'button',
          html: '<svg class="qicon qicon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
          onClick: () => onClose?.(undefined),
        }),
      ])
      : null,
    h('div', { class: 'dialog-body' }, body),
    actions ? h('div', { class: 'dialog-foot' }, (Array.isArray(actions) ? actions : [actions]).filter(Boolean)) : null,
  ].filter(Boolean)));
}

/** 弹出对话框，返回可关闭的句柄 */
export function dialog({ title = '', body = [], actions = null, width = '', onClose = null, cls = '' } = {}) {
  try { focusWindow(); } catch { }
  const handle = { closed: false };
  const close = (result) => {
    if (handle.closed) return;
    handle.closed = true;
    handle.unmount();
    onClose?.(result);
  };
  const isl = island(() => h(DialogPanel, { title, body, actions, width, cls, onClose: close }));
  handle.unmount = isl.close;
  return { close, get isOpen() { return !handle.closed; } };
}

/** 弹出单输入框对话框，返回用户输入或 null */
export function promptDialog({
  title = '', desc = '', value = '', placeholder = '', mono = false, password = false,
  okText = t('app.core.ok-action'), cancelText = t('app.core.cancel'), danger = false,
} = {}) {
  try { focusWindow(); } catch { }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close(v);
      resolve(v ?? null);
    };
    const inputRef = { current: null };
    const dlg = dialog({
      title,
      body: [
        desc ? h('div', { class: 'help', text: desc }) : null,
        h('input', {
          ref: (el) => { inputRef.current = el; },
          class: cx('input', mono && 'mono'),
          type: password ? 'password' : 'text',
          value: value ?? '',
          placeholder,
          onKeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(e.target.value); }
          },
        }),
      ].filter(Boolean),
      actions: [
        h('button', { class: 'btn btn-ghost btn-sm', text: cancelText, onClick: () => finish(null) }),
        h('button', {
          class: cx('btn', danger ? 'btn-danger' : 'btn-primary', 'btn-sm'),
          text: okText,
          onClick: () => finish(inputRef.current ? inputRef.current.value : ''),
        }),
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => {
      if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
    }, 0);
  });
}

/** 异步操作按钮：执行期间禁用并提示成功/失败 */
export function AsyncButton(props) {
  const {
    label, fn, cls = 'btn btn-primary btn-sm',
    busyText = t('app.core.processing'), okToast: okText = '', errToast: errText = t('app.core.op-failed'),
  } = props;
  const busy = useState(false);
  return h('button', {
    class: cls,
    type: 'button',
    text: busy.value ? busyText : label,
    disabled: busy.value,
    onClick: async () => {
      if (busy.value) return;
      busy.next = true;
      try {
        await task(fn, { ok: okText, err: errText });
      } finally {
        busy.next = false;
      }
    },
  });
}

/** 下拉按钮：点击后在按钮下方弹出菜单 */
export function DropdownButton(props) {
  const { label, items, icon: iconName = 'chevron-down', cls = '', btnCls = 'btn btn-ghost btn-sm' } = props;
  const ref = { current: null };
  return h('button', {
    ref: (el) => { ref.current = el; },
    class: cx(btnCls, cls),
    type: 'button',
    html: `${label ? `<span>${label}</span>` : ''}${icon(iconName, 'qicon qicon-sm')}`,
    onClick: (e) => {
      e.stopPropagation();
      const r = ref.current ? ref.current.getBoundingClientRect() : { left: 0, bottom: 0 };
      menu(items, { x: r.left, y: r.bottom + 4 });
    },
  });
}

/** 文件拖放区，也可点击选择文件 */
export function FileDrop(props) {
  const { accept = '', multiple = false, onFiles, text: label = t('app.core.drop-files'), cls = '' } = props;
  const over = useState(false);
  const inputRef = { current: null };
  const take = (files) => {
    const list = [...(files || [])];
    if (list.length) onFiles?.(list);
  };
  return h('div', { class: 'cmp-file-drop-wrap' }, [
    h('div', {
      class: cx('cmp-file-drop', over.value && 'dragover', cls),
      onClick: () => inputRef.current && inputRef.current.click(),
      onDragover: (e) => { e.preventDefault(); over.next = true; },
      onDragleave: () => { over.next = false; },
      onDrop: (e) => { e.preventDefault(); over.next = false; take(e.dataTransfer && e.dataTransfer.files); },
    }, [
      h('span', { html: icon('cloud-upload', 'qicon') }),
      h('span', { class: 'cmp-file-drop-text', text: label }),
    ]),
    h('input', {
      ref: (el) => { inputRef.current = el; },
      type: 'file',
      accept,
      multiple,
      hidden: true,
      onChange: (e) => { take(e.target.files); e.target.value = ''; },
    }),
  ]);
}

/** 可搜索的下拉选择器 */
export function SearchSelect(props) {
  const { items, value, onChange, placeholder = t('app.core.search-or-pick'), cls = '', empty = t('app.core.no-match') } = props;
  const q = useState('');
  const cur = useState(value);
  const shown = items.filter((it) => !q.value || it.label.toLowerCase().includes(q.value));
  return h('div', { class: cx('cmp-search-select', cls) }, [
    h('input', {
      class: 'input', type: 'search', placeholder, value: q.value,
      onInput: (e) => { q.next = e.target.value; },
    }),
    h('div', { class: 'cmp-ss-list qx-card-scroll' },
      shown.length
        ? shown.map((it) => listRow([
          h('span', { key: 'l', text: it.label, class: 'qx-ellip' }),
          it.value === cur.value
            ? h('span', { key: 'c', html: icon('check', 'qicon-sm'), style: { color: 'var(--primary)' } })
            : null,
        ].filter(Boolean), {
          key: it.value,
          onClick: () => {
            cur.next = it.value;
            q.next = '';
            onChange?.(it.value);
          },
        }))
        : [emptyState(empty)]),
  ]);
}

/** 快捷键按键样式 */
export function kbd(label, { cls = '' } = {}) {
  return h('kbd', { class: cx('cmp-kbd', cls), text: String(label ?? '') });
}

/** 全屏加载遮罩，返回可关闭的句柄 */
export function loadingMask(text = t('app.core.loading')) {
  const handle = island(h('div', { class: 'cmp-loading-mask' }, spinner(text)));
  return { close: () => handle.close(), get closed() { return handle.closed; } };
}

/** 转出 tip 属性生成函数，供外部给节点挂悬浮提示 */
export { tip as tipAttrs };

void toast;
void iconNames;
