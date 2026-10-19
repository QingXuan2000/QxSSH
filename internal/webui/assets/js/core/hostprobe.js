/**
 * core/hostprobe.js —— 主机信息与性能指标采集解析
 * 要点：内置探测脚本，远端执行后把 lsblk/df/free/top/lscpu 等输出解析成结构化数据，供主机详情与监控页使用。
 */
import { execRun } from './qxssh-api.js';
import { t } from './i18n.js';

/** 磁盘信息探测脚本，各段用标记行分隔以便解析 */
export const DISK_PROBE_CMD = `
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH
LB=lsblk
command -v "$LB" >/dev/null 2>&1 || for p in /usr/bin/lsblk /usr/sbin/lsblk /sbin/lsblk /bin/lsblk; do [ -x "$p" ] && { LB="$p"; break; }; done
echo --LSBLKBIN--; command -v "$LB" 2>/dev/null || echo "(lsblk not found)"
echo --LSBLK--;  ("$LB" -b -P -o NAME,TYPE,FSTYPE,MOUNTPOINTS,PKNAME 2>/dev/null || "$LB" -b -P -o NAME,TYPE,FSTYPE,MOUNTPOINTS 2>/dev/null || "$LB" -P -o NAME,TYPE,FSTYPE,MOUNTPOINTS 2>/dev/null)
echo --LSBLKD--; ("$LB" -d -b -P -o NAME,SIZE,MODEL,TRAN,ROTA 2>/dev/null || "$LB" -d -b -P -o NAME,SIZE,MODEL 2>/dev/null || "$LB" -d -b -P -o NAME,SIZE 2>/dev/null)
echo --LSBLKTREE--; "$LB" -o NAME,TYPE 2>/dev/null
echo --DF--;     (df -PTB1 -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -PB1 -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null)
`;

/** 实时指标探测脚本：CPU、内存、网络与磁盘 IO */
export const METRICS_CMD = `
echo --CORES--;  (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
echo --CPU--;    top -bn1 2>/dev/null | grep -i 'cpu(s)' | head -1
echo --GPU--;    (nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1)
echo --MEM--;    free -m
echo --DISK--;   df -B1 / | tail -1
echo --NET--;    cat /proc/net/dev
echo --DISKIO--; cat /proc/diskstats
echo --UPTIME--; cat /proc/uptime 2>/dev/null
` + DISK_PROBE_CMD;

/** 主机静态信息探测脚本：系统、内核、CPU、内存、网卡 */
export const HOSTINFO_CMD = `
echo ==OS==; { . /etc/os-release 2>/dev/null && echo "PRETTY=$PRETTY_NAME"; } ; echo "KERNEL=$(uname -srm)"
echo ==HOST==; hostname 2>/dev/null
echo ==ARCH==; uname -m 2>/dev/null
echo ==UPTIME==; { uptime -p 2>/dev/null || true; } ; echo "SEC=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
echo ==CPU==; lscpu 2>/dev/null
echo ==MEM==; grep -iE 'MemTotal|MemAvailable' /proc/meminfo 2>/dev/null
echo ==DMI==; { command -v dmidecode >/dev/null 2>&1 && { sudo dmidecode -t memory 2>/dev/null || dmidecode -t memory 2>/dev/null; } | grep -iE 'Speed|Type:|Manufacturer|Part Number|Size|Locator' | head -40 || true; }
echo ==NET==; ip -o -4 addr show 2>/dev/null | awk '{print $2"="$4}'
` + DISK_PROBE_CMD;

const METRICS_TIMEOUT = 10;
const HOSTINFO_TIMEOUT = 15;

/** 采集实时指标并解析，失败时返回带 error 的空指标结构 */
export async function collectMetrics(hostId) {
  const r = await runProbe(hostId, METRICS_CMD, METRICS_TIMEOUT);
  if (!r.ok) return { ...emptyMetrics(), error: r.error, timedOut: r.timedOut };
  return parseMetrics(r.output);
}

/** 采集主机静态信息并解析，失败时返回带 error 的空结构 */
export async function collectHostInfo(hostId) {
  if (!hostId) return { ...emptyHostInfo(), error: t('core.probe.missing-host') };
  const r = await runProbe(hostId, HOSTINFO_CMD, HOSTINFO_TIMEOUT);
  if (!r.ok) return { ...emptyHostInfo(), error: r.error, timedOut: r.timedOut };
  return parseHostInfo(r.output);
}

async function runProbe(hostId, script, timeout) {
  let r;
  try {
    r = await execRun({ host: hostId, argv: ['sh', '-c', script], timeout });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), timedOut: false };
  }
  if (!r || !r.ok) {
    const msg = String((r && (r.error || r.output)) || '').trim() || t('core.probe.failed');
    return { ok: false, error: msg, timedOut: /timeout|timed out|deadline|超时/i.test(msg) };
  }
  return { ok: true, output: String(r.output || '') };
}

function emptyMetrics() {
  return {
    cpuCores: 0, cpuPct: 0, gpuPct: -1, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0,
    uptimeSec: 0, netRxBytes: 0, netTxBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, disks: [],
  };
}

function emptyHostInfo() {
  return {
    hostname: '', os: '-', kernel: '', arch: '', cpuModel: '', cpuVendor: '', cores: 0, threads: 0,
    cpuFreq: '', memTotal: 0, memSpeed: t('core.probe.unknown'), memType: t('core.probe.unknown'), disks: [], storage: [],
    rootTotal: 0, rootUsed: 0, net: '', uptime: '-',
  };
}

const DISK_MARKERS = new Set(['--LSBLKBIN--', '--LSBLK--', '--LSBLKD--', '--LSBLKTREE--', '--DF--']);
const METRIC_MARKERS = new Set(['--CORES--', '--CPU--', '--GPU--', '--MEM--', '--DISK--', '--NET--', '--DISKIO--', '--UPTIME--']);

const WHOLE_DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|md[0-9]+|dm-[0-9]+|zd[a-z]+)$/;

function round2(v) {
  return Math.trunc(v * 100 + 0.5) / 100;
}

function fields(s) {
  return String(s).trim().split(/\s+/).filter(Boolean);
}

function toInt(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function toFloat(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** 把指标脚本的原始输出解析为指标对象 */
export function parseMetrics(raw) {
  const m = emptyMetrics();
  let section = '';
  let memLine = '';
  let diskLine = '';
  for (const rawLine of String(raw || '').split('\n')) {
    const ln = rawLine.trim();
    if (METRIC_MARKERS.has(ln)) { section = ln; continue; }
    if (DISK_MARKERS.has(ln)) { section = ''; continue; }
    if (!ln) continue;
    switch (section) {
      case '--CORES--': {
        if (m.cpuCores === 0) {
          const n = parseInt(fields(ln)[0], 10);
          if (Number.isFinite(n) && String(n) === fields(ln)[0]) m.cpuCores = n;
        }
        break;
      }
      case '--CPU--':
        m.cpuPct = parseCPUPct(ln);
        break;
      case '--GPU--': {
        if (m.gpuPct < 0) {
          const v = parseFloat(fields(ln)[0]);
          if (Number.isFinite(v)) m.gpuPct = round2(v);
        }
        break;
      }
      case '--MEM--':
        if (ln.startsWith('Mem:') && !memLine) memLine = ln;
        break;
      case '--DISK--':
        if (!diskLine) diskLine = ln;
        break;
      case '--NET--': {
        const idx = ln.indexOf(':');
        if (idx < 0) break;
        const iface = ln.slice(0, idx).trim();
        if (!iface || iface === 'lo' || iface.includes('Inter-') || iface.includes('face')) break;
        const f = fields(ln.slice(idx + 1));
        if (f.length >= 9) {
          m.netRxBytes += toInt(f[0]);
          m.netTxBytes += toInt(f[8]);
        }
        break;
      }
      case '--DISKIO--': {
        const f = fields(ln);
        if (f.length < 10 || !WHOLE_DISK_RE.test(f[2])) break;
        m.diskReadBytes += toInt(f[5]) * 512;
        m.diskWriteBytes += toInt(f[9]) * 512;
        break;
      }
      case '--UPTIME--': {
        if (m.uptimeSec === 0) {
          const v = parseFloat(fields(ln)[0]);
          if (Number.isFinite(v) && v > 0) m.uptimeSec = Math.trunc(v);
        }
        break;
      }
      default:
        break;
    }
  }

  m.disks = parseDisks(raw);

  if (memLine) {
    const f = fields(memLine);
    if (f.length >= 3) {
      m.memTotal = round2(toFloat(f[1]) / 1024);
      m.memUsed = round2(toFloat(f[2]) / 1024);
    }
  }
  if (diskLine) {
    const f = fields(diskLine);
    if (f.length >= 3) {
      m.diskTotal = round2(toFloat(f[1]) / (1 << 30));
      m.diskUsed = round2(toFloat(f[2]) / (1 << 30));
    }
  }
  if (m.memTotal === 0 && m.diskTotal === 0) m.error = t('core.probe.unparsable-metrics');
  return m;
}

/** 从 top 输出中按空闲率换算 CPU 使用率 */
export function parseCPUPct(ln) {
  for (const part of String(ln).split(',')) {
    const p = part.trim();
    const m = /(-?\d+(?:\.\d+)?)\s*%?\s*id\b/.exec(p);
    if (m) {
      const idle = parseFloat(m[1]);
      if (Number.isFinite(idle)) return round2(100 - idle);
    }
  }
  return 0;
}

const SKIP_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/var/lib/docker', '/snap', '/boot/efi'];
const SKIP_FS_TYPES = ['nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'sshfs', 'autofs', 'rpc_pipefs', 'nfsd', 'davfs', 'ftp', 'curlftpfs'];
const MAX_SANE_DISK_GB = 1 << 20;

function isNumeric(s) {
  return s !== '' && Number.isFinite(Number(s));
}

/** 解析挂载点与文件系统信息，合并 lsblk 与 df 结果并去重 */
export function parseDisks(raw) {
  const lsblkRows = new Map();
  const lsblkByMount = new Map();
  const diskInfo = new Map();
  const treeParent = new Map();
  const treeStack = [];
  const seenMount = new Set();
  let disks = [];

  let section = '';
  for (const rawLine of String(raw || '').split('\n')) {
    const ln = rawLine.trim();
    if (DISK_MARKERS.has(ln)) { section = ln; continue; }
    if (!ln) continue;
    switch (section) {
      case '--LSBLK--': {
        const kv = parseLsblkLine(ln);
        const name = kv.NAME || '';
        const typ = kv.TYPE || '';
        const fstype = kv.FSTYPE || '';
        if (!name || typ === 'loop' || typ === 'rom') break;
        lsblkRows.set(name, { name, fstype, pkname: kv.PKNAME || '' });
        const mounts = kv.MOUNTPOINTS || kv.MOUNTPOINT || '';
        if (!mounts) break;
        for (const raw2 of mounts.split(/[\n,]/)) {
          const mp = raw2.trim();
          if (mp) lsblkByMount.set(mp, { name, fstype, pkname: kv.PKNAME || '' });
        }
        break;
      }
      case '--LSBLKD--': {
        const kv = parseLsblkLine(ln);
        const name = kv.NAME || '';
        if (!name) break;
        diskInfo.set(name, { sizeB: toInt(kv.SIZE), model: kv.MODEL || '', tran: kv.TRAN || '', rota: toInt(kv.ROTA) });
        break;
      }
      case '--LSBLKTREE--': {
        if (ln.startsWith('NAME')) break;
        const [depth, name] = parseTreeLine(rawLine);
        if (!name) break;
        while (treeStack.length && treeStack[treeStack.length - 1].depth >= depth) treeStack.pop();
        if (treeStack.length) treeParent.set(name, treeStack[treeStack.length - 1].name);
        treeStack.push({ depth, name });
        break;
      }
      case '--DF--': {
        if (ln.startsWith('Filesystem')) break;
        const f = fields(ln);
        if (f.length < 6) break;
        let fsType = '';
        let totalIdx = 1;
        if (!isNumeric(f[1])) { fsType = f[1].toLowerCase(); totalIdx = 2; }
        if (f.length < totalIdx + 5) break;
        if (SKIP_FS_TYPES.some((t) => fsType === t || fsType.startsWith(t + '.'))) break;
        const mount = f[f.length - 1];
        if (seenMount.has(mount)) break;
        if (SKIP_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(p + '/'))) break;
        const total = toFloat(f[totalIdx]);
        const used = toFloat(f[totalIdx + 1]);
        if (total <= 0) break;
        const totalGB = round2(total / (1 << 30));
        if (totalGB >= MAX_SANE_DISK_GB) break;
        let device = f[0];
        let leaf = '';
        const info = lsblkByMount.get(mount);
        if (info) {
          device = '/dev/' + info.name;
          leaf = info.name;
          fsType = info.fstype;
        } else if (lsblkByMount.size > 0 && mount !== '/') {
          break;
        }
        seenMount.add(mount);
        disks.push({
          mount, device, leafName: leaf, fsType, isSystem: mount === '/',
          usedGB: round2(used / (1 << 30)), totalGB,
          usedBytes: Math.trunc(used), totalBytes: Math.trunc(total),
          usedB: Math.trunc(used), totalB: Math.trunc(total),
        });
        break;
      }
      default:
        break;
    }
  }

  for (const [name, row] of lsblkRows) {
    if (!row.pkname && treeParent.has(name)) row.pkname = treeParent.get(name);
  }
  for (const [, info] of lsblkByMount) {
    if (!info.pkname && treeParent.has(info.name)) info.pkname = treeParent.get(info.name);
  }

  disks = dedupeDisks(disks, (d) => (d.device ? 'dev:' + d.device : 'mnt:' + d.mount));
  disks = dedupeDisks(disks, (d) => `size:${d.totalB}/${d.usedB}`);

  for (const d of disks) {
    if (!d.leafName) continue;
    let top = topDisk(d.leafName, lsblkRows);
    if (!diskInfo.has(top)) {
      for (const name of diskInfo.keys()) {
        if (d.leafName.startsWith(name) && name.length > top.length) top = name;
      }
    }
    d.disk = top;
    const meta = diskInfo.get(top);
    if (meta) {
      d.diskSize = meta.sizeB;
      d.model = meta.model;
    }
  }

  disks.sort((a, b) => {
    if (a.mount === '/' || b.mount === '/') return a.mount === '/' ? -1 : 1;
    return a.mount < b.mount ? -1 : a.mount > b.mount ? 1 : 0;
  });
  return disks.map((d) => {
    const out = { mount: d.mount };
    if (d.device) out.device = d.device;
    if (d.disk) out.disk = d.disk;
    if (d.fsType) out.fsType = d.fsType;
    if (d.isSystem) out.isSystem = true;
    if (d.diskSize) out.diskSize = d.diskSize;
    if (d.model) out.model = d.model;
    out.usedGB = d.usedGB;
    out.totalGB = d.totalGB;
    out.usedBytes = d.usedBytes;
    out.totalBytes = d.totalBytes;
    return out;
  });
}

/** 解析物理磁盘硬件清单（型号、容量、SSD/HDD、接口） */
export function parseDiskHw(raw) {
  let section = '';
  const out = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const ln = rawLine.trim();
    if (DISK_MARKERS.has(ln)) { section = ln; continue; }
    if (!ln || section !== '--LSBLKD--') continue;
    const kv = parseLsblkLine(ln);
    const name = kv.NAME || '';
    if (!name) continue;
    const rota = toInt(kv.ROTA);
    const typ = rota === 0 ? 'SSD' : rota === 1 ? 'HDD' : '-';
    out.push({ name, model: (kv.MODEL || '').trim(), size: toInt(kv.SIZE), type: typ, tran: (kv.TRAN || '').trim() });
  }
  return out;
}

function topDisk(name, rows) {
  let cur = name;
  const seen = new Set();
  for (;;) {
    if (!cur || seen.has(cur)) return cur;
    seen.add(cur);
    const row = rows.get(cur);
    if (!row || !row.pkname) return cur;
    cur = row.pkname;
  }
}

function dedupeDisks(list, keyOf) {
  const best = new Map();
  const order = [];
  for (const d of list) {
    const k = keyOf(d);
    const cur = best.get(k);
    if (!cur) { best.set(k, d); order.push(k); continue; }
    if (betterMount(d.mount, cur.mount)) best.set(k, d);
  }
  return order.map((k) => best.get(k));
}

function betterMount(a, b) {
  if (a === b) return false;
  if (a === '/') return true;
  if (b === '/') return false;
  const da = a.split('/').length - 1;
  const db = b.split('/').length - 1;
  if (da !== db) return da < db;
  return a < b;
}

function parseTreeLine(ln) {
  const idx = ln.search(/[├└`]/);
  let name = '';
  let depth = 0;
  if (idx < 0) {
    name = ln.trim();
  } else {
    const prefix = ln.slice(0, idx);
    depth = Math.trunc([...prefix].length / 2) + 1;
    const rest = ln.slice(idx).replace(/^[├└─`| ]+/, '');
    const f = fields(rest);
    if (f.length) name = f[0];
  }
  const i = name.search(/[ \t]/);
  if (i > 0) name = name.slice(0, i);
  return [depth, name];
}

function parseLsblkLine(ln) {
  const out = {};
  for (const f of splitLsblkFields(ln)) {
    const eq = f.indexOf('=');
    if (eq <= 0) continue;
    const key = f.slice(0, eq).trim().toUpperCase();
    let val = f.slice(eq + 1).trim();
    val = val.replace(/^"+|"+$/g, '');
    out[key] = unescapeLsblk(val);
  }
  return out;
}

function splitLsblkFields(ln) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (const ch of ln) {
    if (ch === '"') { inQuote = !inQuote; cur += ch; } else if (ch === ' ' && !inQuote) {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function unescapeLsblk(s) {
  if (!s.includes('\\x')) return s;
  const bytes = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\' && s[i + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
      bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 4;
      continue;
    }
    for (const b of new TextEncoder().encode(s[i])) bytes.push(b);
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const HOSTINFO_MARKERS = new Set(['==OS==', '==HOST==', '==ARCH==', '==UPTIME==', '==CPU==', '==MEM==', '==DMI==', '==NET==']);

/** 把主机信息脚本的原始输出解析为结构化对象 */
export function parseHostInfo(raw) {
  const hi = emptyHostInfo();
  const cpuLines = []; const memLines = []; const dmiLines = []; const netLines = [];
  let osPretty = ''; let kernel = ''; let hostname = ''; let arch = ''; let uptimeStr = '';
  let section = '';
  for (const ln of String(raw || '').split('\n')) {
    const t = ln.trim();
    if (HOSTINFO_MARKERS.has(t)) { section = t; continue; }
    if (DISK_MARKERS.has(t)) { section = ''; continue; }
    if (!t) continue;
    switch (section) {
      case '==OS==':
        if (t.startsWith('PRETTY=')) osPretty = t.slice(7);
        else if (t.startsWith('KERNEL=')) kernel = t.slice(7);
        break;
      case '==HOST==': if (!hostname) hostname = t; break;
      case '==ARCH==': if (!arch) arch = t; break;
      case '==UPTIME==': if (!t.startsWith('SEC=') && !uptimeStr) uptimeStr = t; break;
      case '==CPU==': cpuLines.push(t); break;
      case '==MEM==': memLines.push(t); break;
      case '==DMI==': dmiLines.push(t); break;
      case '==NET==': netLines.push(t); break;
      default: break;
    }
  }

  hi.os = orDash(osPretty);
  hi.kernel = kernel;
  hi.hostname = hostname;
  hi.arch = arch;
  hi.uptime = orDash(uptimeStr);

  const cpu = {};
  for (const l of cpuLines) {
    const i = l.indexOf(':');
    if (i > 0) cpu[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  hi.cpuModel = cpu['Model name'] || '';
  hi.cpuVendor = cpu['Vendor ID'] || '';
  const sockets = atoiDefault(cpu['Socket(s)'], 1);
  const coresPer = atoiDefault(cpu['Core(s) per socket'], 0);
  hi.threads = atoiDefault(cpu['CPU(s)'], 0);
  if (coresPer > 0 && sockets > 0) hi.cores = sockets * coresPer;
  if (cpu['CPU max MHz']) hi.cpuFreq = mhzToGHz(cpu['CPU max MHz']);
  else if (cpu['CPU MHz']) hi.cpuFreq = mhzToGHz(cpu['CPU MHz']);

  for (const l of memLines) {
    const f = fields(l);
    if (f.length >= 2 && f[0].startsWith('MemTotal')) {
      const kb = parseInt(f[1], 10);
      if (Number.isFinite(kb)) hi.memTotal = kb * 1024;
    }
  }

  let memSpeed = '';
  let memType = '';
  for (const l of dmiLines) {
    if (!memSpeed && l.includes('Speed:')) memSpeed = l.slice(l.indexOf('Speed:') + 6).trim();
    if (!memType && l.includes('Type:')) memType = l.slice(l.indexOf('Type:') + 5).trim();
  }
  hi.memSpeed = memSpeed || t('core.probe.unknown');
  hi.memType = memType || t('core.probe.unknown');

  hi.storage = parseDisks(raw);
  hi.disks = parseDiskHw(raw);
  for (const d of hi.storage) {
    if (d.isSystem) { hi.rootTotal = d.totalBytes; hi.rootUsed = d.usedBytes; }
  }
  hi.net = netLines.join(', ');

  if (hi.os === '-' && !hi.cpuModel && hi.memTotal === 0 && !hi.disks.length && !hi.storage.length) {
    hi.error = t('core.probe.unparsable-hostinfo');
  }
  return hi;
}

function orDash(s) {
  const t = String(s || '').trim();
  return t || '-';
}

function atoiDefault(s, def) {
  let t = String(s || '').trim();
  if (!t) return def;
  const i = t.search(/[ (]/);
  if (i > 0) t = t.slice(0, i);
  const n = parseInt(t, 10);
  return Number.isFinite(n) && String(n) === t ? n : def;
}

function mhzToGHz(s) {
  const f = fields(s);
  if (!f.length) return '';
  const v = parseFloat(f[0]);
  if (!Number.isFinite(v)) return '';
  return (v / 1000).toFixed(2) + ' GHz';
}
