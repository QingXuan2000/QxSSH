import { execRun } from '/assets/js/core/qxssh-api.js';
import { t, tf } from '/assets/js/core/i18n.js';

const T_LIST = 25;
const T_SIGNAL = 15;

const TASKMON_SCRIPT = `
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
echo --WHO--
if [ -n "\${SUDO_USER:-}" ]; then
  echo "$SUDO_USER"
  id -u "$SUDO_USER" 2>/dev/null || id -u
else
  id -u -n 2>/dev/null
  id -u 2>/dev/null
fi
echo --LOAD--
cat /proc/loadavg 2>/dev/null
echo --IO--
for d in /proc/[0-9]*; do
  [ -d "$d" ] || continue
  e=0
  i=0
  r=0
  w=0
  [ -L "$d/exe" ] && e=1
  if [ -r "$d/io" ]; then
    i=1
    while read -r k v; do
      case "$k" in
        read_bytes:) r=$v ;;
        write_bytes:) w=$v ;;
      esac
    done < "$d/io" 2>/dev/null
  fi
  echo "\${d#/proc/} $r $w $e $i"
done
echo --PROC--
ps -eo pid=,ppid=,uid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args= 2>/dev/null
echo --END--
`;

const SIGNALS = new Set([
  'HUP', 'INT', 'QUIT', 'KILL', 'TERM', 'USR1', 'USR2', 'STOP', 'CONT',
  'PIPE', 'ALRM', 'CHLD', 'WINCH', 'TRAP',
]);

function firstLine(s) {
  const t = String(s || '').trim();
  const i = t.indexOf('\n');
  return i < 0 ? t : t.slice(0, i);
}

function procName(pid, args) {
  if (!args) return String(pid);
  if (args.startsWith('[') && args.endsWith(']')) return args;
  const first = args.split(/[ \t]/)[0] || '';
  if (!first) return String(pid);
  const trimmed = first.replace(/\/+$/, '');
  const base = trimmed.split('/').pop();
  if (base && base !== '.' && base !== '/') return base;
  return first;
}

function parseProc(ln) {
  const f = ln.trim().split(/\s+/);
  if (f.length < 9) return null;
  const pid = Number(f[0]);
  if (!Number.isInteger(pid)) return null;
  const args = f.slice(9).join(' ');
  return {
    pid,
    ppid: Number(f[1]) || 0,
    uid: Number(f[2]) || 0,
    user: f[3],
    cpu: Number(f[4]) || 0,
    mem: Number(f[5]) || 0,
    rss: Number(f[6]) || 0,
    stat: f[7],
    etime: Number(f[8]) || 0,
    args,
    name: procName(pid, args),
    ioR: 0,
    ioW: 0,
    hasIO: false,
    kthread: false,
  };
}

function parseTaskmon(raw) {
  const res = { user: '', uid: 0, load1: 0, load5: 0, load15: 0, procs: [], count: 0 };
  const ioByID = new Map();
  let section = '';
  let whoLine = 0;

  for (const rawLine of String(raw || '').split('\n')) {
    const ln = rawLine.trim();
    if (ln === '--WHO--' || ln === '--LOAD--' || ln === '--PROC--' || ln === '--IO--' || ln === '--END--') {
      section = ln;
      continue;
    }
    if (!ln) continue;
    if (section === '--WHO--') {
      whoLine++;
      if (whoLine === 1) res.user = ln;
      else if (Number.isInteger(Number(ln))) res.uid = Number(ln);
    } else if (section === '--LOAD--') {
      const f = ln.split(/\s+/);
      if (f.length >= 3) {
        res.load1 = Number(f[0]) || 0;
        res.load5 = Number(f[1]) || 0;
        res.load15 = Number(f[2]) || 0;
      }
    } else if (section === '--IO--') {
      const f = ln.split(/\s+/);
      if (f.length < 5) continue;
      const pid = Number(f[0]);
      if (!Number.isInteger(pid)) continue;
      ioByID.set(pid, [Number(f[1]) || 0, Number(f[2]) || 0, Number(f[3]) || 0, Number(f[4]) || 0]);
    } else if (section === '--PROC--') {
      const p = parseProc(ln);
      if (!p) continue;
      const v = ioByID.get(p.pid);
      if (v) {
        p.ioR = v[0];
        p.ioW = v[1];
        p.kthread = v[2] === 0;
        p.hasIO = v[3] === 1;
      } else {
        p.kthread = p.args.startsWith('[') && p.args.endsWith(']');
      }
      res.procs.push(p);
    }
  }

  if (!res.procs.length) {
    res.error = t('app.taskmon.api-no-list');
    return res;
  }
  res.count = res.procs.length;
  return res;
}

export async function taskmonProcesses(hostId, elevated = false) {
  const host = hostId || '';
  let r;
  try {
    r = await execRun({ host, argv: ['sh', '-c', TASKMON_SCRIPT], timeout: T_LIST, elevated: !!elevated });
  } catch (e) {
    return { user: '', uid: 0, load1: 0, load5: 0, load15: 0, procs: [], count: 0, error: e.message || String(e) };
  }
  if (!r.ok) {
    let msg = String(r.error || '').trim();
    if (!msg || msg.startsWith('--')) msg = tf('app.taskmon.api-collect-failed', { v1: (r.exit) });
    return { user: '', uid: 0, load1: 0, load5: 0, load15: 0, procs: [], count: 0, error: msg };
  }
  return parseTaskmon(r.output);
}

export async function taskmonSignal({ host, pid, signal, sudo = false } = {}) {
  if (!host) {
    const e = new Error(t('app.taskmon.api-no-host'));
    e.status = 400;
    e.code = 'bad_request';
    throw e;
  }
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 1) {
    const e = new Error(t('app.taskmon.api-bad-pid'));
    e.status = 400;
    e.code = 'bad_request';
    throw e;
  }
  const sig = String(signal || '').trim().toUpperCase().replace(/^SIG/, '');
  if (!SIGNALS.has(sig)) {
    const e = new Error(tf('app.taskmon.api-bad-signal', { v1: signal }));
    e.status = 400;
    e.code = 'bad_request';
    throw e;
  }

  const r = await execRun({ host, argv: ['kill', '-s', sig, String(numPid)], timeout: T_SIGNAL, elevated: !!sudo });
  if (!r.ok) {
    let msg = String(r.error || '').trim();
    if (!msg) msg = tf('app.taskmon.api-exec-failed', { v1: (r.exit) });
    const e = new Error(tf('app.taskmon.api-signal-failed', { v1: numPid, v2: sig, v3: (firstLine(msg)) }));
    e.status = 400;
    e.code = 'bad_request';
    throw e;
  }
  return { ok: true, signal: sig };
}
