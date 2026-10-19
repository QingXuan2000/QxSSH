import { execRun, execStatus, localFsList, localFsMkdir, localFsWrite } from '/assets/js/core/qxssh-api.js';
import { t, tf } from '/assets/js/core/i18n.js';

const PROBE_MS = 900;
const POLL_MS = 150;
const ALIVE_RECHECKS = 3;

const CHROMIUM_DIR = 'browser-profile';
const FIREFOX_DIR = 'browser-profile-firefox';

const state = {
  goos: '',
  win: false,
  home: '',
  tempDir: '',
  configDir: '',
  bases: [],
  preferred: '',
  sep: '/',
  list: null,
  detecting: null,
  ready: false,
};

export function hostGoos(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.startsWith('win')) return 'windows';
  if (p.startsWith('mac') || p.includes('darwin')) return 'darwin';
  if (p.startsWith('linux')) return 'linux';
  return '';
}

function trimEnd(p) {
  return String(p || '').replace(/[/\\]+$/, '');
}

function join(base, rel) {
  const b = trimEnd(base);
  const r = String(rel || '');
  if (!b) return r;
  if (!r) return b;
  const sep = state.sep;
  return b + sep + r.replace(/[/\\]/g, sep);
}

export function kindOfBrowser(p) {
  const s = String(p || '').toLowerCase().replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (base.startsWith('safari')) return 'safari';
  const ffWords = ['firefox', 'tor', 'waterfox', 'librewolf', 'mullvad'];
  for (const w of ffWords) if (base.includes(w)) return 'firefox';
  if (base.startsWith('zen')) return 'firefox';
  return 'chromium';
}

const NOT_BROWSER = [
  '-sandbox', 'gnome-shell', 'crashpad', '-wrapper',
  'chromedriver', 'geckodriver', 'update',
];

const BROWSER_WORDS = [
  'chrome', 'chromium', 'msedge', 'microsoft-edge', 'brave', 'vivaldi',
  'firefox', 'opera', 'yandex-browser', 'zen-browser', 'tor-browser',
  'torbrowser', 'ladybird', 'duckduckgo', 'comet', 'dia', 'neon',
  'sigmaos', 'samsung',
];

export function isBrowserName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return false;
  for (const w of NOT_BROWSER) if (s.includes(w)) return false;
  for (const w of BROWSER_WORDS) if (s.includes(w)) return true;
  return false;
}

export function browserKeyFromName(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('microsoft-edge')) return 'microsoft-edge';
  if (s.includes('msedge')) return 'microsoft-edge';
  if (s.includes('yandex-browser')) return 'yandex-browser';
  if (s.includes('zen-browser') || s.includes('zen')) return 'zen-browser';
  if (s.includes('duckduckgo')) return 'duckduckgo';
  if (s.includes('sigmaos')) return 'sigmaos';
  if (s.includes('ladybird')) return 'ladybird';
  if (s.includes('chromium')) return 'chromium';
  if (s.includes('vivaldi')) return 'vivaldi';
  if (s.includes('firefox')) return 'firefox';
  if (s.includes('brave')) return 'brave';
  if (s.includes('opera')) return 'opera';
  if (s.includes('chrome')) return 'chrome';
  if (s.includes('comet')) return 'comet';
  if (s.includes('dia')) return 'dia';
  if (s.includes('neon')) return 'neon';
  if (s.includes('samsung')) return 'samsung';
  return '';
}

const DISPLAY_NAMES = {
  safari: 'Safari',
  'microsoft-edge': 'Microsoft Edge',
  'yandex-browser': 'Yandex Browser',
  'zen-browser': 'Zen Browser',
  duckduckgo: 'DuckDuckGo',
  sigmaos: 'SigmaOS',
  ladybird: 'Ladybird',
  chromium: 'Chromium',
  vivaldi: 'Vivaldi',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  comet: 'Comet',
  dia: 'Dia',
  neon: 'Neon',
  samsung: 'Samsung Internet',
  chrome: 'Google Chrome',
};

export function browserDisplayName(name) {
  const key = browserKeyFromName(name);
  return DISPLAY_NAMES[key] || 'Google Chrome';
}

function windowsSpecs() {
  return [
    { name: 'Google Chrome', rel: 'Google\\Chrome\\Application\\chrome.exe', kind: 'chromium' },
    { name: 'Microsoft Edge', rel: 'Microsoft\\Edge\\Application\\msedge.exe', kind: 'chromium' },
    { name: 'Brave', rel: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', kind: 'chromium' },
    { name: 'Vivaldi', rel: 'Vivaldi\\Application\\vivaldi.exe', kind: 'chromium' },
    { name: 'Chromium', rel: 'Chromium\\Application\\chrome.exe', kind: 'chromium' },
    { name: 'Yandex Browser', rel: 'Yandex\\YandexBrowser\\Application\\browser.exe', kind: 'chromium' },
    { name: 'Opera', rel: 'Programs\\Opera\\opera.exe', kind: 'chromium' },
    { name: 'Opera GX', rel: 'Programs\\Opera GX\\opera.exe', kind: 'chromium' },
    { name: 'Opera Air', rel: 'Programs\\Opera Air\\opera.exe', kind: 'chromium' },
    { name: 'DuckDuckGo', rel: 'DuckDuckGo\\DuckDuckGo.exe', kind: 'chromium' },
    { name: 'Arc', rel: 'Arc\\Application\\arc.exe', kind: 'chromium' },
    { name: 'Sidekick', rel: 'Sidekick\\Application\\sidekick.exe', kind: 'chromium' },
    { name: 'Thorium', rel: 'Thorium\\Application\\thorium.exe', kind: 'chromium' },
    { name: 'Ladybird', rel: 'Ladybird\\ladybird.exe', kind: 'chromium' },
    { name: 'Comet', rel: 'Comet\\Comet.exe', kind: 'chromium' },
    { name: 'Dia', rel: 'Dia\\Dia.exe', kind: 'chromium' },
    { name: 'Neon', rel: 'Neon\\Neon.exe', kind: 'chromium' },
    { name: 'SigmaOS', rel: 'SigmaOS\\SigmaOS.exe', kind: 'chromium' },
    { name: 'Zen Browser', rel: 'Zen Browser\\zen.exe', kind: 'firefox' },
    { name: 'Firefox', rel: 'Mozilla Firefox\\firefox.exe', kind: 'firefox' },
    { name: 'Tor Browser', rel: 'Tor Browser\\Browser\\firefox.exe', kind: 'firefox' },
    { name: 'Mullvad Browser', rel: 'Mullvad Browser\\firefox.exe', kind: 'firefox' },
  ];
}

function darwinApps() {
  return [
    { name: 'Google Chrome', app: 'Google Chrome.app', exe: 'Google Chrome' },
    { name: 'Microsoft Edge', app: 'Microsoft Edge.app', exe: 'Microsoft Edge' },
    { name: 'Brave', app: 'Brave Browser.app', exe: 'Brave Browser' },
    { name: 'Vivaldi', app: 'Vivaldi.app', exe: 'Vivaldi' },
    { name: 'Chromium', app: 'Chromium.app', exe: 'Chromium' },
    { name: 'Opera', app: 'Opera.app', exe: 'Opera' },
    { name: 'Opera GX', app: 'Opera GX.app', exe: 'Opera GX' },
    { name: 'Opera Air', app: 'Opera Air.app', exe: 'Opera Air' },
    { name: 'Yandex Browser', app: 'Yandex.app', exe: 'Yandex' },
    { name: 'Arc', app: 'Arc.app', exe: 'Arc' },
    { name: 'DuckDuckGo', app: 'DuckDuckGo.app', exe: 'DuckDuckGo' },
    { name: 'Comet', app: 'Comet.app', exe: 'Comet' },
    { name: 'Dia', app: 'Dia.app', exe: 'Dia' },
    { name: 'Neon', app: 'Neon.app', exe: 'Neon' },
    { name: 'SigmaOS', app: 'SigmaOS.app', exe: 'SigmaOS' },
    { name: 'Ladybird', app: 'Ladybird.app', exe: 'ladybird' },
    { name: 'Firefox', app: 'Firefox.app', exe: 'Firefox' },
    { name: 'Firefox Developer Edition', app: 'Firefox Developer Edition.app', exe: 'firefox' },
    { name: 'Zen Browser', app: 'Zen Browser.app', exe: 'zen' },
    { name: 'Tor Browser', app: 'Tor Browser.app', exe: 'firefox' },
    { name: 'Mullvad Browser', app: 'Mullvad Browser.app', exe: 'firefox' },
  ];
}

function darwinCLI() {
  return [
    { name: 'Chromium', cmd: 'chromium' },
    { name: 'Google Chrome', cmd: 'google-chrome' },
  ];
}

function linuxBare() {
  return [
    'google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable',
    'chromium', 'chromium-browser', 'chromium-freeworld',
    'microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev',
    'brave-browser', 'brave', 'brave-browser-beta',
    'vivaldi-stable', 'vivaldi', 'vivaldi-snapshot',
    'opera', 'opera-stable',
    'yandex-browser', 'yandex-browser-beta',
    'firefox', 'firefox-esr', 'firefox-developer-edition', 'firefox-nightly',
    'torbrowser-launcher', 'zen-browser', 'opera-air', 'duckduckgo',
  ];
}

function linuxAbs() {
  return [
    '/opt/google/chrome/chrome',
    '/opt/google/chrome-beta/chrome',
    '/opt/microsoft/msedge/msedge',
    '/opt/microsoft/msedge-beta/msedge',
    '/opt/vivaldi/vivaldi',
    '/opt/vivaldi-snapshot/vivaldi-snapshot',
    '/usr/lib/x86_64-linux-gnu/opera/opera',
    '/usr/lib/aarch64-linux-gnu/opera/opera',
    '/usr/lib/chromium/chromium',
    '/usr/lib64/chromium-browser/chromium-browser',
    '/snap/bin/chromium',
    '/snap/bin/firefox',
    '/snap/bin/brave',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/org.mozilla.firefox',
    '/var/lib/flatpak/exports/bin/com.brave.Browser',
  ];
}

function linuxScanDirs() {
  const dirs = ['/usr/bin', '/usr/local/bin', '/opt', '/snap/bin', '/usr/lib/chromium'];
  if (state.home) dirs.push(join(state.home, '.local/bin'));
  return dirs;
}

function darwinRoots() {
  const roots = ['/Applications'];
  if (state.home) roots.push(join(state.home, 'Applications'));
  return roots;
}

export async function prepare(info) {
  if (state.ready) return state;
  const facts = (info && info.host) || {};
  state.goos = facts.goos || hostGoos(info && info.platform);
  state.win = state.goos === 'windows';
  state.sep = facts.pathSep || (state.win ? '\\' : '/');
  state.home = trimEnd(facts.home);
  state.tempDir = trimEnd(facts.tempDir) || (state.win ? '' : '/tmp');
  state.configDir = trimEnd(facts.configDir) ||
    join(state.tempDir || state.home || '.', 'qxssh-browser');
  state.bases = [];
  if (state.win) {
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData']) {
      const v = facts.env && facts.env[k];
      if (v) state.bases.push(trimEnd(v));
    }
  }
  state.preferred = trimEnd(facts.env && facts.env.QXSSH_BROWSER);
  state.ready = true;
  return state;
}

export function hostFacts() {
  return {
    goos: state.goos, home: state.home, tempDir: state.tempDir,
    configDir: state.configDir, sep: state.sep,
  };
}

async function listDir(dir) {
  try {
    const r = await localFsList(dir);
    return (r && r.entries) || [];
  } catch {
    return [];
  }
}

function isFileEntry(e) {
  return !!e && !e.isDir;
}

function entryPath(dir, e) {
  return join(dir, e && e.name);
}

function hasPathSep(p) {
  const s = String(p || '');
  if (state.win) return s.includes('/') || s.includes('\\');
  return s.includes('/');
}

function isExecEntry(e) {
  if (!isFileEntry(e)) return false;
  if (state.win) return true;
  const n = String(e.name || '');
  return !/\.(txt|md|json|js|html|so|dylib|dll|icns|png|svg|plist)$/i.test(n);
}

async function statExec(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '';
  const dir = i === 0 ? s.slice(0, 1) : s.slice(0, i);
  const name = s.slice(i + 1);
  if (!name) return '';
  const entries = await listDir(dir);
  const hit = entries.find((e) => isExecEntry(e) && e.name === name);
  return hit ? entryPath(dir, hit) : '';
}

const PROBE_TIMEOUT_S = 25;
const PROBE_CONCURRENCY = 6;

const WIN_PROGID_KEYS = [
  ['MSEdgeHTM', 'microsoft-edge'], ['ChromeHTML', 'chrome'], ['ChromiumHTM', 'chromium'],
  ['FirefoxURL', 'firefox'], ['BraveHTML', 'brave'], ['VivaldiHTM', 'vivaldi'],
  ['OperaStable', 'opera'], ['OperaGX', 'opera'], ['YandexHTML', 'yandex-browser'],
  ['ZenHTML', 'zen-browser'],
];

const MAC_BUNDLE_KEYS = {
  'com.apple.safari': 'safari',
  'com.google.chrome': 'chrome',
  'com.google.chrome.canary': 'chrome',
  'org.chromium.chromium': 'chromium',
  'com.microsoft.edgemac': 'microsoft-edge',
  'com.brave.browser': 'brave',
  'com.vivaldi.vivaldi': 'vivaldi',
  'com.operasoftware.opera': 'opera',
  'com.operasoftware.operagx': 'opera',
  'ru.yandex.desktop.yandex-browser': 'yandex-browser',
  'company.thebrowser.browser': 'chrome',
  'com.duckduckgo.macos.browser': 'duckduckgo',
  'org.mozilla.firefox': 'firefox',
  'org.mozilla.firefoxdeveloperedition': 'firefox',
  'org.mozilla.nightly': 'firefox',
  'app.zen-browser.zen': 'zen-browser',
  'org.torproject.torbrowser': 'firefox',
  'net.mullvad.mullvadbrowser': 'firefox',
  'org.ladybird.ladybird': 'ladybird',
};

function samePath(a, b) {
  const na = String(a || '');
  const nb = String(b || '');
  if (!state.win) return na === nb;
  return na.replace(/\//g, '\\').toLowerCase() === nb.replace(/\//g, '\\').toLowerCase();
}

async function runScript(argv) {
  try {
    const r = await execRun({ argv, timeout: PROBE_TIMEOUT_S });
    if (!r || !r.ok) return '';
    return String(r.output || '');
  } catch {
    return '';
  }
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}


export function windowsScript() {
  const rels = windowsSpecs().map((s) => `'${s.rel.replace(/'/g, "''")}'`).join(',');
  const exes = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe',
    'browser.exe', 'zen.exe', 'arc.exe', 'thorium.exe', 'chromium.exe', 'launcher.exe']
    .map((e) => `'${e}'`).join(',');
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$out=New-Object System.Collections.ArrayList',
    'function Add($name,$path,$source){',
    '  if(-not $path){return}',
    "  $p=[string]$path; $p=$p.Trim(); if($p.StartsWith('\"')){ $i=$p.IndexOf('\"',1); if($i -gt 0){ $p=$p.Substring(1,$i-1) } }",
    "  if(-not $p.ToLower().EndsWith('.exe')){ $j=$p.ToLower().IndexOf('.exe'); if($j -gt 0){ $p=$p.Substring(0,$j+4) } }",
    '  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){return}',
    '  $v=(Get-Item -LiteralPath $p).VersionInfo',
    '  [void]$out.Add([pscustomobject]@{name=[string]$name;path=$p;source=$source;version=[string]$v.ProductVersion;product=[string]$v.ProductName})',
    '}',
    "foreach($root in 'HKLM:\\SOFTWARE\\Clients\\StartMenuInternet','HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet','HKCU:\\SOFTWARE\\Clients\\StartMenuInternet'){",
    '  foreach($k in (Get-ChildItem -LiteralPath $root)){',
    "    $disp=(Get-ItemProperty -LiteralPath $k.PSPath).'(default)'",
    "    $cmd=(Get-ItemProperty -LiteralPath (Join-Path $k.PSPath 'shell\\open\\command')).'(default)'",
    "    Add $disp $cmd 'registry'",
    '  }',
    '}',
    `foreach($exe in ${exes}){`,
    "  foreach($root in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'){",
    "    $p=(Get-ItemProperty -LiteralPath (Join-Path $root $exe)).'(default)'",
    "    if($p){ Add '' $p 'apppaths' }",
    '  }',
    '}',
    `foreach($rel in @(${rels})){`,
    '  foreach($b in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LocalAppData)){',
    "    if($b){ Add '' (Join-Path $b $rel) 'path' }",
    '  }',
    '}',
    "$prog=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId",
    "if(-not $prog){ $prog=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId }",
    "$defCmd=''",
    "if($prog){ $defCmd=(Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $prog + '\\shell\\open\\command')).'(default)' }",
    '[pscustomobject]@{browsers=@($out);defaultProgId=[string]$prog;defaultCommand=[string]$defCmd} | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
}

function exeFromCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '';
  if (s.startsWith('"')) {
    const i = s.indexOf('"', 1);
    return i > 0 ? s.slice(1, i) : s.slice(1);
  }
  const j = s.toLowerCase().indexOf('.exe');
  return j > 0 ? s.slice(0, j + 4) : s.split(/\s+/)[0];
}

async function detectWindowsFast() {
  const out = await runScript([
    'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript(),
  ]);
  return parseWindowsProbe(out);
}

export function parseWindowsProbe(out) {
  const text = String(out || '').trim();
  if (!text.startsWith('{')) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const raw = Array.isArray(data.browsers) ? data.browsers : (data.browsers ? [data.browsers] : []);
  const list = [];
  for (const b of raw) {
    if (!b || !b.path) continue;
    if (list.some((x) => samePath(x.path, b.path))) continue;
    if (/[\\/]iexplore\.exe$/i.test(b.path)) continue;
    const name = String(b.name || '').trim() || String(b.product || '').trim() || browserDisplayName(b.path);
    list.push({
      name, path: b.path, kind: kindOfBrowser(b.path), version: String(b.version || '').trim(),
      source: b.source || 'registry', isDefault: false,
    });
  }
  const defExe = exeFromCommand(data.defaultCommand);
  let def = defExe ? list.find((x) => samePath(x.path, defExe)) : null;
  if (!def && data.defaultProgId) {
    const pid = String(data.defaultProgId);
    const hit = WIN_PROGID_KEYS.find(([prefix]) => pid.startsWith(prefix));
    if (hit) def = list.find((x) => browserKeyFromName(x.path) === hit[1]) || null;
  }
  if (def) def.isDefault = true;
  return list;
}

export function darwinScript() {
  const roots = darwinRoots();
  const cli = darwinCLI().flatMap((s) => ['/opt/homebrew/bin', '/usr/local/bin'].map((p) => join(p, s.cmd)));
  const words = BROWSER_WORDS.concat(['arc', 'safari', 'edge', 'yandex', 'tor', 'mullvad', 'zen', 'orion']);
  const casePat = words.map((w) => `*${w}*`).join('|');
  return [
    'emit_app() {',
    '  app="$1"; exe="$2"; name="$3"',
    '  [ -d "$app" ] || return 0',
    '  bin="$app/Contents/MacOS/$exe"',
    '  if [ ! -x "$bin" ]; then bin=$(find "$app/Contents/MacOS" -maxdepth 1 -type f -perm +111 2>/dev/null | head -1); fi',
    '  [ -n "$bin" ] || return 0',
    '  bid=$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)',
    '  ver=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)',
    '  [ -n "$name" ] || name=$(defaults read "$app/Contents/Info" CFBundleDisplayName 2>/dev/null)',
    '  [ -n "$name" ] || name=$(basename "$app" .app)',
    "  printf 'APP\\t%s\\t%s\\t%s\\t%s\\n' \"$bin\" \"$bid\" \"$ver\" \"$name\"",
    '}',
    ...darwinApps().flatMap((spec) => roots.map((root) => `emit_app ${shQuote(join(root, spec.app))} ${shQuote(spec.exe)} ${shQuote(spec.name)}`)),
    "emit_app '/Applications/Safari.app' 'Safari' 'Safari'",
    ...roots.map((root) => [
      `for app in ${shQuote(root)}/*.app; do`,
      '  [ -d "$app" ] || continue',
      `  case "$(basename "$app" | tr 'A-Z' 'a-z')" in ${casePat}) emit_app "$app" "$(basename "$app" .app)" "" ;; esac`,
      'done',
    ].join('\n')),
    ...cli.map((p) => `[ -x ${shQuote(p)} ] && printf 'ABS\\t%s\\n' ${shQuote(p)}`),
    "def=$(defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | awk 'BEGIN{RS=\"{\"} /LSHandlerURLScheme = \"?https?\"?;/ { if (match($0, /LSHandlerRoleAll = \"?[^\";]+\"?/)) { s=substr($0, RSTART, RLENGTH); sub(/.*= \"?/, \"\", s); sub(/\"$/, \"\", s); print s; exit } }')",
    "printf 'DEFAULT\\t%s\\n' \"${def:-com.apple.Safari}\"",
    'exit 0',
  ].join('\n');
}

async function detectDarwinFast() {
  const out = await runScript(['/bin/sh', '-c', darwinScript()]);
  if (!out) return null;
  return parseDarwinProbe(out);
}

export function parseDarwinProbe(out) {
  const list = [];
  let defBundle = '';
  for (const line of String(out || '').split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols[0] === 'APP' && cols[1]) {
      if (list.some((x) => x.path === cols[1])) continue;
      const bundle = String(cols[2] || '').toLowerCase();
      const key = MAC_BUNDLE_KEYS[bundle] || browserKeyFromName(cols[1]);
      const kind = key === 'safari' ? 'safari' : kindOfBrowser(cols[1]);
      list.push({
        name: cols[4] || DISPLAY_NAMES[key] || browserDisplayName(cols[1]),
        path: cols[1], kind, version: cols[3] || '', source: 'app', bundle, isDefault: false,
      });
    } else if (cols[0] === 'ABS' && cols[1]) {
      if (list.some((x) => x.path === cols[1])) continue;
      list.push({ name: browserDisplayName(cols[1]), path: cols[1], kind: kindOfBrowser(cols[1]), version: '', source: 'path', isDefault: false });
    } else if (cols[0] === 'DEFAULT') {
      defBundle = String(cols[1] || '').toLowerCase();
    }
  }
  if (defBundle) {
    const def = list.find((x) => x.bundle === defBundle)
      || list.find((x) => MAC_BUNDLE_KEYS[defBundle] && browserKeyFromName(x.path) === MAC_BUNDLE_KEYS[defBundle]);
    if (def) def.isDefault = true;
  }
  list.sort((a, b) => (a.kind === 'safari') - (b.kind === 'safari'));
  return list;
}

export function linuxScript() {
  const bare = linuxBare().map(shQuote).join(' ');
  const abs = linuxAbs().map(shQuote).join(' ');
  const dirs = [
    '/usr/share/applications', '/usr/local/share/applications', '"$HOME/.local/share/applications"',
    '/var/lib/flatpak/exports/share/applications', '"$HOME/.local/share/flatpak/exports/share/applications"',
    '/var/lib/snapd/desktop/applications',
  ].join(' ');
  return [
    'rp() { readlink -f -- "$1" 2>/dev/null || printf %s "$1"; }',
    'exec_bin() {',
    '  set -- $1',
    '  while [ $# -gt 0 ]; do case "$1" in env|*=*) shift ;; *) break ;; esac; done',
    '  tok=$1; tok=${tok#\\"}; tok=${tok%\\"}',
    '  if [ "$tok" = flatpak ]; then',
    '    while [ $# -gt 0 ]; do case "$1" in *.*.*) break ;; *) shift ;; esac; done',
    '    for b in /var/lib/flatpak/exports/bin "$HOME/.local/share/flatpak/exports/bin"; do [ -x "$b/$1" ] && { printf %s "$b/$1"; return; }; done',
    '    return',
    '  fi',
    '  command -v -- "$tok" 2>/dev/null',
    '}',
    "d=$(xdg-settings get default-web-browser 2>/dev/null); [ -n \"$d\" ] && printf 'DEFAULT\\t%s\\n' \"$d\"",
    `for dir in ${dirs}; do`,
    '  [ -d "$dir" ] || continue',
    '  for f in "$dir"/*.desktop; do',
    '    [ -f "$f" ] || continue',
    "    grep -q '^Categories=.*WebBrowser' \"$f\" 2>/dev/null || continue",
    "    grep -q '^NoDisplay=true' \"$f\" 2>/dev/null && continue",
    "    name=$(grep -m1 '^Name=' \"$f\" | cut -d= -f2-)",
    "    ex=$(grep -m1 '^Exec=' \"$f\" | cut -d= -f2-)",
    '    bin=$(exec_bin "$ex")',
    '    [ -n "$bin" ] || continue',
    "    printf 'DESKTOP\\t%s\\t%s\\t%s\\t%s\\n' \"$(basename \"$f\")\" \"$name\" \"$bin\" \"$(rp \"$bin\")\"",
    '  done',
    'done',
    `for n in ${bare}; do p=$(command -v -- "$n" 2>/dev/null); [ -n "$p" ] && printf 'PATH\\t%s\\t%s\\t%s\\n' "$n" "$p" "$(rp "$p")"; done`,
    `for p in ${abs}; do [ -x "$p" ] && printf 'ABS\\t%s\\t%s\\n' "$p" "$(rp "$p")"; done`,
    'exit 0',
  ].join('\n');
}

async function detectLinuxFast() {
  const out = await runScript(['/bin/sh', '-c', linuxScript()]);
  if (!out) return null;
  return parseLinuxProbe(out);
}

export function parseLinuxProbe(out) {
  const list = [];
  const byReal = new Map();
  let defDesktop = '';
  const push = (entry, real) => {
    const key = real || entry.path;
    const prev = byReal.get(key);
    if (prev) {
      if (!prev.desktop && entry.desktop) prev.desktop = entry.desktop;
      return;
    }
    byReal.set(key, entry);
    list.push(entry);
  };
  for (const line of String(out || '').split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols[0] === 'DEFAULT') {
      defDesktop = String(cols[1] || '').trim();
    } else if (cols[0] === 'DESKTOP' && cols[3]) {
      push({
        name: cols[2] || browserDisplayName(cols[3]), path: cols[3], kind: kindOfBrowser(cols[3]),
        version: '', source: 'desktop', desktop: cols[1], isDefault: false,
      }, cols[4]);
    } else if (cols[0] === 'PATH' && cols[2]) {
      push({ name: browserDisplayName(cols[1]), path: cols[2], kind: kindOfBrowser(cols[1]), version: '', source: 'path', isDefault: false }, cols[3]);
    } else if (cols[0] === 'ABS' && cols[1]) {
      push({ name: browserDisplayName(cols[1]), path: cols[1], kind: kindOfBrowser(cols[1]), version: '', source: 'path', isDefault: false }, cols[2]);
    }
  }
  if (defDesktop) {
    const key = browserKeyFromName(defDesktop);
    const def = list.find((x) => x.desktop === defDesktop)
      || (key ? list.find((x) => browserKeyFromName(x.path) === key || browserKeyFromName(x.desktop || '') === key) : null);
    if (def) def.isDefault = true;
  }
  return list;
}

function makeDirCache() {
  const cache = new Map();
  return (dir) => {
    if (!cache.has(dir)) cache.set(dir, listDir(dir));
    return cache.get(dir);
  };
}

async function statExecCached(p, list) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '';
  const dir = i === 0 ? s.slice(0, 1) : s.slice(0, i);
  const name = s.slice(i + 1);
  if (!name) return '';
  const entries = await list(dir);
  const hit = entries.find((e) => isExecEntry(e) && e.name === name);
  return hit ? entryPath(dir, hit) : '';
}

async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, items.length) }, worker));
  return out;
}

async function resolveBare(cmd) {
  if (!cmd || hasPathSep(cmd)) return '';
  const r = await execRun({
    argv: ['/bin/sh', '-c', `command -v -- ${JSON.stringify(cmd)}`],
    timeout: 10,
  });
  if (!r || !r.ok || !r.output) return '';
  const p = String(r.output).trim().split('\n')[0].trim();
  return p && hasPathSep(p) ? p : '';
}

async function detectByProbe() {
  const list = makeDirCache();
  const cands = [];
  if (state.goos === 'windows') {
    for (const spec of windowsSpecs()) {
      for (const base of state.bases) cands.push({ name: spec.name, p: join(base, spec.rel), kind: spec.kind });
    }
  } else if (state.goos === 'darwin') {
    for (const spec of darwinApps()) {
      for (const root of darwinRoots()) cands.push({ name: spec.name, app: join(root, spec.app), exe: spec.exe });
    }
    for (const spec of darwinCLI()) {
      for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin']) cands.push({ name: spec.name, p: join(prefix, spec.cmd) });
    }
    cands.push({ name: 'Safari', p: '/Applications/Safari.app/Contents/MacOS/Safari', kind: 'safari' });
  } else {
    for (const cmd of [...linuxBare(), ...linuxAbs()]) cands.push({ name: browserDisplayName(cmd), p: cmd });
    for (const dir of linuxScanDirs()) {
      for (const e of await list(dir)) {
        if (!isExecEntry(e) || !isBrowserName(e.name)) continue;
        cands.push({ name: browserDisplayName(e.name), p: entryPath(dir, e) });
      }
    }
  }
  const resolved = await mapLimit(cands, async (c) => {
    if (c.app) {
      const inner = join(c.app, 'Contents' + state.sep + 'MacOS');
      const base = String(c.exe || '').trim() || String(c.app).replace(/[/\\]/g, '/').split('/').pop().replace(/\.app$/i, '');
      let bin = await statExecCached(join(inner, base), list);
      if (!bin) {
        const entries = await list(inner);
        const e = entries.find(isExecEntry);
        bin = e ? entryPath(inner, e) : '';
      }
      return bin ? { name: c.name, path: bin } : null;
    }
    const abs = hasPathSep(c.p) ? c.p : await resolveBare(c.p);
    if (!abs) return null;
    const r = await statExecCached(abs, list);
    return r ? { name: c.name, path: r, kind: c.kind } : null;
  });
  const out = [];
  for (const r of resolved) {
    if (!r || out.some((x) => samePath(x.path, r.path))) continue;
    out.push({ name: r.name, path: r.path, kind: r.kind || kindOfBrowser(r.path), version: '', source: 'probe', isDefault: false });
  }
  return out;
}

export async function detectBrowsers() {
  if (state.list) return state.list;
  if (!state.detecting) state.detecting = detectAll().finally(() => { state.detecting = null; });
  return state.detecting;
}

async function detectAll() {
  let list = null;
  if (state.goos === 'windows') list = await detectWindowsFast();
  else if (state.goos === 'darwin') list = await detectDarwinFast();
  else if (state.goos === 'linux') list = await detectLinuxFast();
  if (!list) list = await detectByProbe();

  if (state.preferred) {
    const r = await statExec(state.preferred);
    if (r) {
      list = list.filter((x) => !samePath(x.path, r));
      list.unshift({ name: t('app.browser.env-browser'), path: r, kind: kindOfBrowser(r), version: '', source: 'env', isDefault: false });
    }
  }
  const env = list.filter((x) => x.source === 'env');
  const def = list.filter((x) => x.source !== 'env' && x.isDefault);
  const rest = list.filter((x) => x.source !== 'env' && !x.isDefault);
  state.list = [...env, ...def, ...rest];
  return state.list;
}

export function resetBrowsers() {
  state.list = null;
}

async function profileDir(sub) {
  const dir = join(state.configDir, sub);
  try {
    await localFsMkdir(dir);
  } catch {
  }
  return dir;
}

function proxyURL(proxy, proxyHost, proxyPort) {
  let raw = String(proxy || '').trim();
  if (!raw) {
    const h = String(proxyHost || '127.0.0.1');
    const p = String(proxyPort || '');
    raw = p ? `socks5://${h}:${p}` : '';
  }
  if (!raw) return '';
  if (!/^socks5:\/\//i.test(raw)) raw = 'socks5://' + raw.replace(/^[a-z0-9+.-]+:\/\//i, '');
  return raw;
}

function proxyAddr(url) {
  return String(url || '').replace(/^socks5:\/\//i, '');
}

function firefoxUserJS(host, port) {
  const h = String(host || '127.0.0.1');
  const p = Number(port) || 0;
  return [
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.socks", "' + h + '");',
    'user_pref("network.proxy.socks_port", ' + p + ');',
    'user_pref("network.proxy.socks_version", 5);',
    'user_pref("network.proxy.socks_remote_dns", true);',
    'user_pref("network.proxy.no_proxies_on", "");',
    'user_pref("network.proxy.allow_hijacking_localhost", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("startup.homepage_welcome_url", "");',
    'user_pref("startup.homepage_welcome_url.additional", "");',
    '',
  ].join('\n');
}

async function writeText(path, text) {
  await localFsWrite(path, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

async function launchPlan(path, kind, url, proxy) {
  const url2 = String(url || '');
  if (kind === 'safari') {
    return {
      argv: url2 ? [path, url2] : [path],
      warn: t('app.browser.warn-safari-proxy'),
    };
  }
  if (kind === 'firefox') {
    const dir = await profileDir(FIREFOX_DIR);
    const addr = proxyAddr(proxy);
    const i = addr.lastIndexOf(':');
    const host = i > 0 ? addr.slice(0, i) : addr;
    const port = i > 0 ? addr.slice(i + 1) : '';
    await writeText(join(dir, 'user.js'), firefoxUserJS(host, port));
    const argv = [path, '-profile', dir, '-no-remote'];
    if (url2) argv.push(url2);
    return { argv, warn: '' };
  }
  const dir = await profileDir(CHROMIUM_DIR);
  const argv = [
    path,
    '--user-data-dir=' + dir,
    '--proxy-server=' + proxy,
    '--proxy-bypass-list=<-loopback>',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (url2) argv.push(url2);
  return { argv, warn: '' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAlive(id) {
  const deadline = Date.now() + PROBE_MS;
  for (;;) {
    await sleep(POLL_MS);
    let st = null;
    try {
      st = await execStatus(id);
    } catch {
      return { alive: false, status: null };
    }
    const running = !!(st && st.running);
    if (!running) return { alive: false, status: st };
    if (Date.now() >= deadline) {
      for (let i = 0; i < ALIVE_RECHECKS; i++) {
        await sleep(POLL_MS);
        try {
          st = await execStatus(id);
        } catch {
          return { alive: false, status: st };
        }
        if (!(st && st.running)) return { alive: false, status: st };
      }
      return { alive: true, status: st };
    }
  }
}

function firstLines(text, cap) {
  const s = String(text || '').slice(0, cap || 400);
  const out = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(t);
    if (out.length >= 6) break;
  }
  return out.join('\n');
}

export async function launchBrowser(opts) {
  const o = opts || {};
  const path = String(o.path || '');
  const url = String(o.url || '');
  const proxy = proxyURL(o.proxy, o.proxyHost, o.proxyPort);
  const kind = kindOfBrowser(path);
  if (!path) return { ok: false, path, name: '', args: [], alive: false, error: 'no-browser' };

  const known = await detectBrowsers();
  if (!known.some((b) => b.path === path)) {
    return { ok: false, path, name: '', args: [], alive: false, error: 'not-in-list' };
  }

  let plan;
  try {
    plan = await launchPlan(path, kind, url, proxy);
  } catch (err) {
    const msg = (err && (err.message || err.error)) || String(err);
    return {
      ok: false, path, name: browserDisplayName(path), args: [], alive: false,
      error: tf('app.browser.error-write-profile', { v1: msg }),
    };
  }

  const req = { argv: plan.argv, background: true, timeout: 60 };
  if (o.cwd) req.cwd = o.cwd;
  let res;
  try {
    res = await execRun(req);
  } catch (err) {
    return {
      ok: false, path, name: browserDisplayName(path), args: plan.argv, alive: false,
      error: (err && (err.message || err.error)) || String(err),
    };
  }
  if (!res || res.running === false || res.id === undefined) {
    const out = firstLines((res && res.output) || '', 400);
    return {
      ok: false, path, name: browserDisplayName(path), args: plan.argv, alive: false,
      error: out || (res && res.error) || t('app.browser.launch-died'),
    };
  }

  const { alive, status } = await waitAlive(res.id);
  if (!alive) {
    const out = firstLines((status && status.output) || '', 400);
    return {
      ok: false, path, name: browserDisplayName(path), args: plan.argv, alive: false,
      error: out || (status && status.error) || t('app.browser.launch-died'),
    };
  }
  return {
    ok: true, path, name: browserDisplayName(path), args: plan.argv, alive: true,
    error: plan.warn || '', id: res.id, pid: res.pid,
  };
}
