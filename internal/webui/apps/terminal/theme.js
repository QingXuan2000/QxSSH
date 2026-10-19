const TOKENS = [
  ['background', 'term-bg'],
  ['foreground', 'term-fg'],
  ['cursor', 'term-cursor'],
  ['selectionBackground', 'term-selection'],
  ['black', 'term-black'],
  ['red', 'term-red'],
  ['green', 'term-green'],
  ['yellow', 'term-yellow'],
  ['blue', 'term-blue'],
  ['magenta', 'term-magenta'],
  ['cyan', 'term-cyan'],
  ['white', 'term-white'],
  ['brightBlack', 'term-bright-black'],
  ['brightRed', 'term-bright-red'],
  ['brightGreen', 'term-bright-green'],
  ['brightYellow', 'term-bright-yellow'],
  ['brightBlue', 'term-bright-blue'],
  ['brightMagenta', 'term-bright-magenta'],
  ['brightCyan', 'term-bright-cyan'],
  ['brightWhite', 'term-bright-white'],
];

export function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const [key, token] of TOKENS) {
    const v = cs.getPropertyValue(`--${token}`).trim();
    if (v) out[key] = v;
  }
  return out;
}
