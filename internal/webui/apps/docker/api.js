import { t, tf } from '/assets/js/core/i18n.js';
import { execRun, execStream, execWSUrl } from '/assets/js/core/qxssh-api.js';
import { isSudoPermError } from '/assets/js/core/sys.js';

const T_PROBE = 12;
const T_LIST = 25;
const T_STATS = 30;
const T_INSPECT = 20;
const T_ACTION = 90;
const T_IMAGE_ACTION = 180;
const T_COMPOSE = 25;
const T_DETECT = 20;

const EXEC_OUT_CAP = 16 << 10;
const BATCH_MAX = 64;
const BATCH_WORKERS = 6;
const STREAM_CAP = 1 << 20;

const TAIL_RE = /^(?:\d{1,7}|all)$/;
const SINCE_RE = /^\d+[smhdw]$/;
const USER_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*$|^\d+$/;

const CONTAINER_ACTIONS = new Set([
  'start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'rm',
]);
const COMPOSE_ACTIONS = {
  up: ['up', '-d'], down: ['down'], restart: ['restart'], build: ['build'],
};
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const DETECT_SCRIPT = [
  'cd -- "$1" || exit 2',
  'base=$PWD',
  `for f in ${COMPOSE_NAMES.join(' ')}; do`,
  `  if [ -f "$f" ]; then printf '%s/%s' "$base" "$f"; exit 0; fi`,
  'done',
  'exit 1',
].join('\n');

const ENTRY_SCRIPT = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
const ENTRY_SCRIPT_LOCAL = (cols, rows) =>
  `if command -v stty >/dev/null 2>&1 && [ -t 0 ]; then stty cols ${cols} rows ${rows} 2>/dev/null; fi; ${ENTRY_SCRIPT}`;

const elev = new Set();

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  e.code = 'bad_request';
  return e;
}

function checkRef(s) {
  if (!s || s.length > 512 || s.startsWith('-') || /[\x00\n\r]/.test(s)) {
    throw bad(tf('app.docker.bad-spec', { v1: (JSON.stringify(s)) }));
  }
}

function firstLine(s) {
  const t = String(s || '').trim();
  const i = t.indexOf('\n');
  return i < 0 ? t : t.slice(0, i);
}

function permText(msg) {
  const m = String(msg || '').toLowerCase();
  return isSudoPermError(msg)
    || m.includes('a password is required')
    || m.includes('incorrect password')
    || m.includes('no password was provided')
    || m.includes('not in the sudoers')
    || m.includes('must be root')
    || m.includes(t('app.docker.need-sudo'))
    || m.includes(t('app.docker.need-root'));
}

function cmdFail(r) {
  const out = String(r.output || '').trim();
  const msg = out || String(r.error || '').trim() || t('app.docker.exec-failed');
  const e = new Error(msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg);
  e.exit = r.exit;
  e.output = r.output || '';
  const perm = permText(msg) || permText(String(r.error || ''));
  e.status = perm ? 403 : 400;
  e.code = perm ? 'forbidden' : 'bad_request';
  return e;
}

async function runTry(host, argv, { timeout = T_ACTION, elevated = elev.has(host), stdin = '' } = {}) {
  const r = await execRun({ host, argv, timeout, elevated, stdin });
  if (!r.ok && !elevated && permText(`${r.output || ''} ${r.error || ''}`)) {
    const r2 = await execRun({ host, argv, timeout, elevated: true, stdin });
    if (r2.ok) elev.add(host);
    return r2;
  }
  return r;
}

async function hostRun(host, argv, opts) {
  const r = await runTry(host, argv, opts);
  if (!r.ok) throw cmdFail(r);
  return r.output;
}

async function dockerRun(host, argv, opts) {
  return hostRun(host, ['docker', ...argv], opts);
}

export async function dockerProbe(host) {
  await dockerRun(host, ['ps', '-q'], { timeout: T_PROBE });
  return elev.has(host);
}

function jsonRows(raw, idKey) {
  const list = [];
  for (const ln of String(raw || '').split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && (!idKey || o[idKey])) list.push(o);
    } catch { }
  }
  return list;
}

function linesOf(raw) {
  return String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function dockerStream(host, argv, streamOpts) {
  await dockerProbe(host);
  return execStream({ host, argv: ['docker', ...argv], elevated: elev.has(host) }, streamOpts);
}

export async function dockerInfo(host) {
  const client = (await dockerRun(host, ['--version'], { timeout: 8 })).trim();
  await dockerRun(host, ['ps', '-q'], { timeout: T_PROBE });
  return { ok: true, client };
}

export async function dockerContainers(host) {
  const psOut = await dockerRun(host, ['ps', '-a', '--format', '{{json .}}'], { timeout: T_LIST });
  const containers = jsonRows(psOut, 'ID');
  let stats = [];
  let statsError = '';
  try {
    stats = jsonRows(
      await dockerRun(host, ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: T_STATS }),
      'ID',
    );
  } catch (e) {
    statsError = firstLine(e.message);
  }
  return { containers, stats, statsError };
}

export async function dockerStats(host, id) {
  const args = ['stats', '--no-stream', '--format', '{{json .}}'];
  if (id) {
    checkRef(id);
    args.push(id);
  }
  return { stats: jsonRows(await dockerRun(host, args, { timeout: T_STATS }), 'ID') };
}

export async function dockerInspect(host, id) {
  checkRef(id);
  const out = await dockerRun(host, ['inspect', id], { timeout: T_INSPECT });
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    throw bad(t('app.docker.inspect-unparsable'));
  }
  if (!Array.isArray(arr) || !arr.length) throw bad(t('app.docker.inspect-unparsable'));
  return { container: arr[0] };
}

export async function dockerContainerAction({ host, action, id, ids, force, volumes }) {
  if (!CONTAINER_ACTIONS.has(action)) throw bad(tf('app.docker.bad-action', { v1: action }));
  const list = ids ? ids.slice() : [];
  if (id) list.unshift(id);
  if (!list.length) throw bad(t('app.docker.missing-id'));
  for (const x of list) checkRef(x);
  let base;
  if (action === 'rm') {
    base = ['rm'];
    if (volumes) base.push('-v');
    if (force) base.push('-f');
  } else {
    base = [action];
  }
  const out = await dockerRun(host, [...base, ...list], { timeout: T_ACTION });
  return { ok: true, output: out.trim() };
}

export async function dockerContainersExec({ host, ids, cmd, timeoutSec }) {
  const run = String(cmd || '').trim();
  if (!run) throw bad(t('app.docker.missing-command'));
  if (run.length > 4096) throw bad(t('app.docker.command-too-long'));
  if (run.includes(String.fromCharCode(0))) throw bad(t('app.docker.command-bad-chars'));
  const list = ids || [];
  if (!list.length) throw bad(t('app.docker.missing-id'));
  if (list.length > BATCH_MAX) throw bad(tf('app.docker.too-many-containers', { v1: BATCH_MAX }));
  for (const id of list) checkRef(id);
  let timeout = Number(timeoutSec) || 60;
  if (timeout < 5) timeout = 5;
  else if (timeout > 300) timeout = 300;

  const results = new Array(list.length);
  let next = 0;
  let okCount = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const id = list[i];
      let r;
      try {
        r = await runTry(host, ['docker', 'exec', id, 'sh', '-c', run], { timeout });
      } catch (e) {
        if (e.code === 'permission') throw e;
        r = { ok: false, output: '', error: e.message, exit: -1 };
      }
      let out = String(r.output || '');
      if (out.length > EXEC_OUT_CAP) out = tf('app.docker.exec-output-truncated', { v1: (out.slice(0, EXEC_OUT_CAP)) });
      out = out.replace(/\n+$/, '');
      const res = { id, ok: !!r.ok, out };
      if (!r.ok) res.error = firstLine(r.error || r.output || t('app.docker.exec-failed-short'));
      results[i] = res;
      if (r.ok) okCount++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_WORKERS, list.length) }, worker));

  if (!okCount && results.every((r) => r.error && permText(r.error))) {
    const e = new Error(results[0].error);
    e.status = 403;
    e.code = 'forbidden';
    throw e;
  }
  return { results, succeeded: okCount, failed: results.length - okCount };
}

function recreateArgs(doc) {
  const cfg = doc.Config || {};
  const hc = doc.HostConfig || {};
  const image = cfg.Image || '';
  if (!image) throw bad(t('app.docker.rebuild-no-image'));
  const name = String(doc.Name || '').replace(/^\//, '');
  if (!name) throw bad(t('app.docker.rebuild-no-name'));

  const warnings = [];
  const extras = [];
  const run = ['run', '-d', '--name', name];

  const entry = cfg.Entrypoint || [];
  let positional = (cfg.Cmd || []).slice();
  if (entry.length) {
    if (entry[0] === '') warnings.push(t('app.docker.entrypoint-default'));
    else {
      run.push('--entrypoint', entry[0]);
      positional = [...entry.slice(1), ...positional];
    }
  }
  for (const e of cfg.Env || []) run.push('-e', e);
  for (const b of hc.Binds || []) run.push('-v', b);
  for (const [port, bps] of Object.entries(hc.PortBindings || {})) {
    const slash = port.indexOf('/');
    const base = slash >= 0 ? port.slice(0, slash) : port;
    const proto = slash >= 0 ? port.slice(slash + 1) : '';
    for (const bp of bps || []) {
      let spec = base;
      if (bp.HostPort && bp.HostIp) spec = `${bp.HostIp}:${bp.HostPort}:${base}`;
      else if (bp.HostPort) spec = `${bp.HostPort}:${base}`;
      else if (bp.HostIp) spec = `${bp.HostIp}::${base}`;
      if (proto) spec += `/${proto}`;
      run.push('-p', spec);
    }
  }
  for (const port of Object.keys(cfg.ExposedPorts || {})) run.push('--expose', port);
  for (const [k, v] of Object.entries(cfg.Labels || {})) run.push('-l', `${k}=${v}`);
  const pol = (hc.RestartPolicy || {}).Name || '';
  if (pol && pol !== 'no') run.push('--restart', pol);
  if (hc.Privileged) run.push('--privileged');
  if (hc.ReadonlyRootfs) run.push('--read-only');
  for (const c of hc.CapAdd || []) run.push('--cap-add', c);
  for (const h of hc.ExtraHosts || []) run.push('--add-host', h);
  for (const l of hc.Links || []) run.push('--link', l);
  if (cfg.WorkingDir) run.push('-w', cfg.WorkingDir);
  if (cfg.User) run.push('-u', cfg.User);

  const nets = (doc.NetworkSettings || {}).Networks || {};
  const names = Object.keys(nets).sort();
  const mode = hc.NetworkMode || '';
  let primary = '';
  if (mode && mode !== 'default') primary = mode;
  else if (names.length) primary = names[0];
  if (primary) {
    run.push('--network', primary);
    for (const al of (nets[primary] || {}).Aliases || []) {
      if (al !== name) run.push('--network-alias', al);
    }
  }
  for (const n of names) {
    if (n === primary) continue;
    extras.push({ name: n, aliases: (nets[n] || {}).Aliases || [] });
  }
  run.push(image, ...positional);
  return { run, extras, warnings };
}

export async function dockerContainerRecreate({ host, id }) {
  checkRef(id);
  const out = await dockerRun(host, ['inspect', id], { timeout: T_INSPECT });
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    throw bad(t('app.docker.inspect-unparsable'));
  }
  if (!Array.isArray(arr) || !arr.length) throw bad(t('app.docker.inspect-unparsable'));
  const doc = arr[0];
  const oldName = String(doc.Name || '').replace(/^\//, '');
  const { run: runArgs, extras, warnings } = recreateArgs(doc);
  const wasRunning = !!(doc.State || {}).Running;

  if (wasRunning) await dockerRun(host, ['stop', '-t', '10', id], { timeout: T_ACTION });
  const tmpName = `${oldName}.qxold-${Date.now() % 100000000}`;
  try {
    await dockerRun(host, ['rename', id, tmpName], { timeout: T_ACTION });
  } catch (e) {
    if (wasRunning) {
      try { await dockerRun(host, ['start', id], { timeout: T_ACTION }); } catch { }
    }
    throw e;
  }

  const rollback = async () => {
    try { await dockerRun(host, ['rename', tmpName, oldName], { timeout: T_ACTION }); } catch { }
    if (wasRunning) {
      try { await dockerRun(host, ['start', oldName], { timeout: T_ACTION }); } catch { }
    }
  };

  let newOut;
  try {
    newOut = await dockerRun(host, runArgs, { timeout: T_ACTION });
  } catch (e) {
    await rollback();
    throw e;
  }
  const newID = firstLine(newOut);

  for (const n of extras) {
    const cargs = ['network', 'connect'];
    for (const al of n.aliases) cargs.push('--alias', al);
    cargs.push(n.name, newID);
    try {
      await dockerRun(host, cargs, { timeout: T_ACTION });
    } catch (e) {
      warnings.push(tf('app.docker.network-attach-failed', { v1: (n.name), v2: (firstLine(e.message)) }));
    }
  }
  try {
    await dockerRun(host, ['rm', '-f', id], { timeout: T_ACTION });
  } catch (e) {
    const head = firstLine(e.message);
    const raw = firstLine(e.output || '');
    warnings.push(
      raw && raw !== head
        ? tf('app.docker.cleanup-failed-full', { v1: tmpName, v2: head, v3: raw })
        : tf('app.docker.cleanup-failed', { v1: tmpName, v2: head }),
    );
  }
  return { ok: true, id: newID, warnings };
}

export async function dockerLogsStream(host, id, opts = {}, streamOpts = {}) {
  checkRef(id);
  const tail = opts.tail || '500';
  if (!TAIL_RE.test(tail)) throw bad(t('app.docker.bad-tail'));
  const args = ['logs', '--tail', tail];
  if (opts.since) {
    if (!SINCE_RE.test(opts.since)) throw bad(t('app.docker.bad-since'));
    args.push('--since', opts.since);
  }
  if (opts.timestamps) args.push('--timestamps');
  if (opts.follow) args.push('--follow');
  args.push(id);
  return dockerStream(host, args, streamOpts);
}

export async function dockerImages(host) {
  const out = await dockerRun(host, ['images', '-a', '--format', '{{json .}}'], { timeout: T_LIST });
  return { images: jsonRows(out) };
}

export async function dockerImageAction({ host, action, refs, force }) {
  let args;
  if (action === 'rm') {
    const list = refs || [];
    if (!list.length || list.length > 100) throw bad(t('app.docker.no-images-selected'));
    for (const ref of list) checkRef(ref);
    args = ['rmi'];
    if (force) args.push('-f');
    args.push(...list);
  } else if (action === 'prune') {
    args = ['image', 'prune', '-f'];
  } else {
    throw bad(tf('app.docker.bad-action', { v1: action }));
  }
  const out = await dockerRun(host, args, { timeout: T_IMAGE_ACTION });
  return { ok: true, output: out.trim() };
}

export async function dockerPullStream(host, image, streamOpts = {}) {
  checkRef(image);
  return dockerStream(host, ['pull', image], streamOpts);
}

export async function dockerBuildStream(host, dir, tag, streamOpts = {}) {
  checkRef(dir);
  const args = ['build'];
  if (tag) {
    checkRef(tag);
    args.push('-t', tag);
  }
  args.push(dir);
  return dockerStream(host, args, streamOpts);
}

export async function dockerVolumes(host) {
  const out = await dockerRun(host, ['volume', 'ls', '--format', '{{json .}}'], { timeout: T_LIST });
  return { volumes: jsonRows(out) };
}

export async function dockerVolumeAction({ host, action, names }) {
  const out = await dockerRun(host, nameArgs(action, 'volume', names), { timeout: T_ACTION });
  return { ok: true, output: out.trim() };
}

export async function dockerNetworks(host) {
  const out = await dockerRun(host, ['network', 'ls', '--format', '{{json .}}'], { timeout: T_LIST });
  return { networks: jsonRows(out) };
}

export async function dockerNetworkAction({ host, action, names }) {
  const out = await dockerRun(host, nameArgs(action, 'network', names), { timeout: T_ACTION });
  return { ok: true, output: out.trim() };
}

function nameArgs(action, noun, names) {
  if (action === 'rm') {
    if (!names || !names.length) throw bad(t('app.docker.no-items-selected'));
    for (const n of names) checkRef(n);
    return [noun, 'rm', ...names];
  }
  if (action === 'prune') return [noun, 'prune', '-f'];
  throw bad(tf('app.docker.bad-action', { v1: action }));
}

async function detectCompose(host, dir) {
  checkRef(dir);
  const r = await runTry(host, ['sh', '-c', DETECT_SCRIPT, 'qx-compose', dir], { timeout: T_DETECT });
  if (r.ok) return String(r.output || '').trim();
  if (!String(r.output || '').trim()) {
    throw cmdFail({ ...r, output: '', error: t('app.docker.compose-not-found') });
  }
  throw cmdFail(r);
}

export async function dockerComposeStatus(host, dir) {
  const file = await detectCompose(host, dir);
  const svcOut = await dockerRun(host, ['compose', '-f', file, 'config', '--services'], { timeout: T_COMPOSE });
  const services = linesOf(svcOut);
  let containers = [];
  try {
    containers = jsonRows(await dockerRun(
      host,
      ['compose', '-f', file, 'ps', '--format', '{{json .}}'],
      { timeout: T_LIST },
    ));
  } catch (e) {
    if (e.status === 403) throw e;
  }
  return { file, services, containers };
}

export async function dockerComposeActionStream({ host, dir, action, service }, streamOpts = {}) {
  const actArgs = COMPOSE_ACTIONS[action];
  if (!actArgs) throw bad(tf('app.docker.bad-action', { v1: action }));
  if (service) checkRef(service);
  const file = await detectCompose(host, dir);
  const argv = ['compose', '-f', file, ...actArgs];
  if (service) argv.push(service);
  return dockerStream(host, argv, streamOpts);
}

export async function dockerComposeLogsStream(host, dir, opts = {}, streamOpts = {}) {
  const file = await detectCompose(host, dir);
  const tail = opts.tail || '500';
  if (!TAIL_RE.test(tail)) throw bad(t('app.docker.bad-tail'));
  const argv = ['compose', '-f', file, 'logs', '--no-color', '--tail', tail];
  if (opts.service) {
    checkRef(opts.service);
    argv.push(opts.service);
  }
  if (opts.follow) argv.push('--follow');
  return dockerStream(host, argv, streamOpts);
}

export async function dockerComposeFile(host, dir) {
  const file = await detectCompose(host, dir);
  const r = await runTry(host, ['cat', '--', file], { timeout: T_INSPECT });
  if (!r.ok) throw cmdFail(r);
  if (r.truncated) throw bad(t('app.docker.compose-too-big-load'));
  return { path: file, content: r.output };
}

export async function dockerComposeFileSave({ host, dir, content }) {
  const body = String(content || '');
  if (body.length > STREAM_CAP) throw bad(t('app.docker.compose-too-big-save'));
  if (body.includes(String.fromCharCode(0))) throw bad(t('app.docker.compose-nul-byte'));
  const file = await detectCompose(host, dir);
  await hostRun(host, ['sh', '-c', 'cat > "$1"', 'qx-save', file], { timeout: T_COMPOSE, stdin: body });
  return { ok: true, path: file };
}

export function dockerExecWSUrl(host, id, cols, rows, user) {
  checkRef(id);
  if (user && user !== 'image' && !USER_RE.test(user)) throw bad(t('app.docker.bad-user'));
  const c = Math.max(1, parseInt(cols, 10) || 80);
  const r = Math.max(1, parseInt(rows, 10) || 24);
  const script = host === '' ? ENTRY_SCRIPT_LOCAL(c, r) : ENTRY_SCRIPT;
  const argv = ['docker', 'exec', '-i', '-t'];
  if (user && user !== 'image') argv.push('-u', user);
  argv.push(id, 'sh', '-c', script);
  return execWSUrl({ host, argv, cols: c, rows: r, elevated: elev.has(host) });
}
