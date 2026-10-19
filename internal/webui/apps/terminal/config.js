import { getJSONPref, setJSONPref, delPref } from '/assets/js/core/prefs.js';

const KEY = 'qx-term-config';

export const FONT_STACKS = {
  'JetBrains Mono': '"JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace',
  'MiSans / Inter': 'MiSans, "Inter", system-ui, sans-serif',
  'System Mono': 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace',
};

const num = (min, max, round = false) => ({ kind: 'num', min, max, round });
const enumOf = (...values) => ({ kind: 'enum', values });
const bool = { kind: 'bool' };

const FIELDS = {
  fontFamily: { kind: 'enum', values: Object.values(FONT_STACKS), def: FONT_STACKS['JetBrains Mono'] },
  fontSize: { ...num(6, 32), def: 13 },
  lineHeight: { ...num(1, 2.5), def: 1.2 },
  letterSpacing: { ...num(-2, 4), def: 0 },
  ligatures: { ...bool, def: false },
  cursorStyle: { ...enumOf('block', 'bar', 'underline'), def: 'block' },
  cursorBlink: { ...bool, def: true },

  frameless: { ...bool, def: false },
  showStatusbar: { ...bool, def: true },

  scrollback: { ...num(0, 200000, true), def: 5000 },
  smoothScroll: { ...bool, def: false },
  fastScrollModifier: { ...enumOf('alt', 'ctrl', 'shift', ''), def: 'alt' },

  rightClick: { ...enumOf('menu', 'paste', 'copyPaste'), def: 'menu' },
  copyOnSelect: { ...bool, def: true },
  fontSizeStep: { ...num(1, 4), def: 1 },

  bell: { ...enumOf('off', 'visual', 'sound', 'both'), def: 'visual' },
  showTransferRate: { ...bool, def: true },

  restoreSession: { ...bool, def: true },
  autoReconnect: { ...bool, def: true },
};

export const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def]));

export const FALLBACK_COLS = 80;
export const FALLBACK_ROWS = 24;

export function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    const v = src[key];
    if (f.kind === 'num') {
      const n = Number(v);
      if (!Number.isFinite(n)) { out[key] = f.def; continue; }
      const clamped = Math.min(f.max, Math.max(f.min, n));
      out[key] = f.round ? Math.round(clamped) : clamped;
    } else if (f.kind === 'enum') {
      out[key] = f.values.includes(v) ? v : f.def;
    } else {
      out[key] = typeof v === 'boolean' ? v : f.def;
    }
  }
  return out;
}

let state = normalize(getJSONPref(KEY, null));
const listeners = new Set();

function emit() {
  const snap = { ...state };
  listeners.forEach((fn) => {
    try { fn(snap); } catch (e) { console.error('[term] config listener', e); }
  });
  return snap;
}

export function getConfig() {
  return { ...state };
}

export function patchConfig(partial) {
  state = normalize({ ...state, ...partial });
  setJSONPref(KEY, state);
  return emit();
}

export function resetConfig() {
  state = normalize({});
  delPref(KEY);
  return emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
