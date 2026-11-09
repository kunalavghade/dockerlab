// Shell simulation: programs inside containers (ls, cat, curl, ping…) and on the host
// (ls, cat, echo, curl, ssh, scp, grep…). Add a program by adding it to IN_CTR or HOST.
import { CommandError, tokenize, short, fmtSize } from './util.js';
import { hubInfo, PROJECT_DIR } from './data.js';

// Ends a shell program early. final=true for "exit", 'main' when PID 1 is killed.
class ShellExit extends Error {
  constructor(lines, code, final = false) { super('exit'); this.lines = lines; this.code = code; this.final = final; }
}
const fail = (lines, code = 1) => { throw new ShellExit([].concat(lines), code); };

const PROGRAM_VERSIONS = { node: 'v20.18.0', npm: '10.8.2', python3: 'Python 3.12.7', python: 'Python 3.12.7', go: 'go version go1.23.2 linux/amd64', nginx: 'nginx version: nginx/1.27.2', 'redis-server': 'Redis server v=7.4.1', psql: 'psql (PostgreSQL) 16.4' };
const KNOWN_BINS = ['sh', 'ls', 'cat', 'echo', 'ps', 'env', 'hostname', 'ping', 'touch', 'rm', 'mkdir', 'id', 'whoami', 'date', 'uname', 'kill', 'sleep', 'df', 'free', 'top', 'which', 'nslookup', 'grep', 'head', 'tail', 'wc'];

// ---------- text filters shared by host and container shells ----------
const FILTERS = {
  grep: (args, input) => {
    const flags = args.filter((a) => /^-[ivcE]+$/.test(a)).join('');
    const [pattern] = args.filter((a) => !/^-[ivcE]+$/.test(a));
    if (pattern == null) fail('Usage: grep [-ivc] PATTERN [FILE]', 2);
    let re;
    try { re = new RegExp(pattern, flags.includes('i') ? 'i' : ''); } catch { fail(`grep: bad regex '${pattern}'`, 2); }
    const hits = input.filter((l) => re.test(l) !== flags.includes('v'));
    if (flags.includes('c')) return [String(hits.length)];
    if (!hits.length) fail([], 1);
    return hits;
  },
  head: (args, input) => input.slice(0, Number((args.find((a) => /^-?\d+$/.test(a.replace(/^-n/, ''))) || '10').replace(/^-n?/, '')) || 10),
  tail: (args, input) => input.slice(-(Number((args.find((a) => /^-?\d+$/.test(a.replace(/^-n/, ''))) || '10').replace(/^-n?/, '')) || 10)),
  wc: (args, input) => [args.includes('-l') ? String(input.length) : `${input.length} ${input.join(' ').split(/\s+/).filter(Boolean).length} ${input.join('\n').length}`],
  sort: (args, input) => (args.includes('-r') ? [...input].sort().reverse() : [...input].sort()),
  uniq: (_, input) => input.filter((l, i) => l !== input[i - 1]),
  jq: (args, input) => {
    const expr = (args.find((a) => !a.startsWith('-')) || '.').trim();
    let data;
    try { data = JSON.parse(input.join('\n')); } catch { fail('jq: error: input is not valid JSON', 2); }
    const path = expr.replace(/^\./, '').match(/[^.[\]]+|\[\d+\]/g) || [];
    const value = path.reduce((o, k) => (o == null ? null : o[k.startsWith('[') ? Number(k.slice(1, -1)) : k]), data);
    return (args.includes('-r') && typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)).split('\n');
  },
};

const resolvePath = (cwd, p) => {
  const parts = (p.startsWith('/') ? p : `${cwd}/${p}`).split('/');
  const outParts = [];
  parts.forEach((x) => { if (x === '..') outParts.pop(); else if (x && x !== '.') outParts.push(x); });
  return `/${outParts.join('/')}`;
};
const childrenOf = (fs, dir) => {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  const names = new Set();
  [...fs.keys()].forEach((p) => { if (p.startsWith(prefix) && p !== dir) names.add(p.slice(prefix.length).split('/')[0]); });
  return [...names].filter(Boolean).sort();
};
const columns = (names) => (names.length ? [names.join('  ')] : []);

// ---------- programs inside a container ----------
const IN_CTR = {
  ls: (x, args) => {
    const long = args.some((a) => /^-\w*l/.test(a)), all = args.some((a) => /^-\w*a/.test(a));
    const targets = args.filter((a) => !a.startsWith('-'));
    const fs = x.fs();
    const lines = [];
    (targets.length ? targets : ['.']).forEach((t, i, list) => {
      const path = resolvePath(x.cwd, t);
      if (!fs.has(path) && path !== '/') fail(`ls: ${t}: No such file or directory`, 1);
      if (fs.get(path) != null) { lines.push(long ? `-rw-r--r--    1 root     root     ${String(fs.get(path).length).padStart(6)} Nov  9 10:00 ${t}` : t); return; }
      const kids = childrenOf(fs, path).filter((n) => all || !n.startsWith('.'));
      if (list.length > 1) lines.push(`${t}:`);
      if (long) {
        lines.push(`total ${kids.length * 4}`);
        kids.forEach((n) => {
          const v = fs.get(`${path === '/' ? '' : path}/${n}`);
          lines.push(`${v === null || v === undefined ? 'drwxr-xr-x    2' : '-rw-r--r--    1'} root     root     ${String(v == null ? 4096 : v.length).padStart(6)} Nov  9 10:00 ${n}`);
        });
      } else lines.push(...columns(kids));
    });
    return lines;
  },
  cat: (x, args, input) => {
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return input;
    return files.flatMap((f) => {
      const path = resolvePath(x.cwd, f);
      const special = x.special(path);
      if (special) return special;
      const fs = x.fs();
      if (!fs.has(path)) fail(`cat: can't open '${f}': No such file or directory`, 1);
      if (fs.get(path) === null) fail(`cat: read error: Is a directory`, 1);
      return String(fs.get(path)).split('\n');
    });
  },
  echo: (x, args) => [args.filter((a) => a !== '-n' && a !== '-e').join(' ')],
  printf: (x, args) => [args.join(' ').replace(/\\n/g, '\n')],
  touch: (x, args) => { args.filter((a) => !a.startsWith('-')).forEach((f) => { const p = resolvePath(x.cwd, f); if (!x.fs().has(p)) x.write(p, ''); }); return []; },
  mkdir: (x, args) => {
    args.filter((a) => !a.startsWith('-')).forEach((f) => {
      const p = resolvePath(x.cwd, f);
      if (x.fs().has(p) && !args.includes('-p')) fail(`mkdir: can't create directory '${f}': File exists`, 1);
      x.write(p, null);
    });
    return [];
  },
  rm: (x, args) => {
    const recursive = args.some((a) => /^-\w*r/i.test(a)), force = args.some((a) => /^-\w*f/.test(a));
    args.filter((a) => !a.startsWith('-')).forEach((f) => {
      const p = resolvePath(x.cwd, f);
      const fs = x.fs();
      if (!fs.has(p)) { if (!force) fail(`rm: can't remove '${f}': No such file or directory`, 1); return; }
      if (fs.get(p) === null && !recursive) fail(`rm: '${f}' is a directory`, 1);
      [...fs.keys()].filter((k) => k === p || k.startsWith(`${p}/`)).sort().reverse().forEach((k) => x.del(k));
    });
    return [];
  },
  cp: (x, args) => {
    const [a, b] = args.filter((v) => !v.startsWith('-'));
    const fs = x.fs();
    const src = resolvePath(x.cwd, a || '');
    if (!fs.has(src)) fail(`cp: can't stat '${a}': No such file or directory`, 1);
    const dst = resolvePath(x.cwd, b || '');
    x.write(fs.get(dst) === null ? `${dst}/${src.split('/').pop()}` : dst, fs.get(src));
    return [];
  },
  mv: (x, args) => { IN_CTR.cp(x, args); x.del(resolvePath(x.cwd, args.filter((v) => !v.startsWith('-'))[0])); return []; },
  pwd: (x) => [x.cwd],
  cd: (x, args) => {
    const p = resolvePath(x.cwd, args[0] || '/root');
    if (!x.fs().has(p) && p !== '/') fail(`sh: cd: can't cd to ${args[0]}: No such file or directory`, 2);
    x.setCwd(p);
    return [];
  },
  whoami: (x) => (/^\d+$/.test(x.userName) ? fail(`whoami: unknown uid ${x.userName}`, 1) : [x.userName]),
  id: (x) => [x.userName === 'root' ? 'uid=0(root) gid=0(root) groups=0(root),1(bin),2(daemon)' : /^\d+$/.test(x.userName) ? `uid=${x.userName} gid=0(root) groups=0(root)` : `uid=${x.uid}(${x.userName}) gid=${x.uid}(${x.userName}) groups=${x.uid}(${x.userName})`],
  hostname: (x, args) => [args.includes('-i') ? Object.values(x.c.networks).map((n) => n.ip).join(' ') : x.c.cfg.hostname || short(x.c.id)],
  env: (x) => Object.entries({ HOSTNAME: x.c.cfg.hostname || short(x.c.id), HOME: x.userName === 'root' ? '/root' : `/home/${x.userName}`, ...x.c.cfg.env, ...x.env }).map(([k, v]) => `${k}=${v}`),
  printenv: (x, args) => (args[0] ? [String({ ...x.c.cfg.env, ...x.env }[args[0]] ?? '')] : IN_CTR.env(x)),
  ps: (x) => {
    const main = [...(x.c.entrypoint || []).filter((e) => !e.endsWith('.sh')), ...x.c.argv].join(' ');
    const rows = ['PID   USER     TIME  COMMAND', `    1 ${x.mainUser.padEnd(8)} 0:00 ${main}`];
    if (x.c.flavor === 'nginx') rows.push('   29 nginx    0:00 nginx: worker process', '   30 nginx    0:00 nginx: worker process');
    rows.push(`   ${41 + Math.floor(Math.random() * 30)} ${x.userName.padEnd(8)} 0:00 ps`);
    return rows;
  },
  top: (x) => [...IN_CTR.ps(x), '(top would keep refreshing — showing one snapshot)'],
  date: () => [new Date().toUTCString().replace('GMT', 'UTC')],
  uname: (x, args) => [args.includes('-a') ? `Linux ${short(x.c.id)} 6.10.14-linuxkit #1 SMP x86_64 Linux` : 'Linux'],
  sleep: () => [],
  true: () => [],
  false: () => fail([], 1),
  which: (x, args) => args.map((a) => (KNOWN_BINS.includes(a) || x.fs().has(`/usr/bin/${a}`) || hubInfo(x.c.flavor || '')?.cmd?.[0] === a ? `/usr/bin/${a}` : fail([], 1))),
  df: () => ['Filesystem                Size      Used Available Use% Mounted on', 'overlay                  58.4G     12.1G     43.3G  22% /', 'tmpfs                    64.0M         0     64.0M   0% /dev'],
  free: (x) => {
    const total = x.c.limits.memory || 7840;
    return ['              total        used        free', `Mem:   ${String(Math.round(total)).padStart(12)}M ${String(Math.round(total * 0.12)).padStart(10)}M ${String(Math.round(total * 0.88)).padStart(10)}M`];
  },
  ip: (x) => Object.entries(x.c.networks).flatMap(([, n], i) => [`${i + 2}: eth${i}@if${i + 9}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500`, `    link/ether ${n.mac}`, `    inet ${n.ip}/16 scope global eth${i}`]),
  ifconfig: (x) => IN_CTR.ip(x),
  ping: (x, args) => {
    const target = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a)).pop();
    if (!target) fail('ping: usage error: Destination address required', 2);
    const ip = x.resolve(target);
    if (!ip) fail([`ping: bad address '${target}'`, x.dnsHint(target)].filter(Boolean), 1);
    if (ip === 'unreachable') fail([`PING ${target}: 56 data bytes`, '--- ping statistics ---', '3 packets transmitted, 0 packets received, 100% packet loss', '(no shared network — the packets never arrive)'], 1);
    return [`PING ${target} (${ip}): 56 data bytes`, `64 bytes from ${ip}: seq=0 ttl=64 time=0.081 ms`, `64 bytes from ${ip}: seq=1 ttl=64 time=0.094 ms`, `64 bytes from ${ip}: seq=2 ttl=64 time=0.102 ms`, '', `--- ${target} ping statistics ---`, '3 packets transmitted, 3 packets received, 0% packet loss'];
  },
  nslookup: (x, args) => {
    const ip = x.resolve(args[0] || '');
    if (!ip || ip === 'unreachable') fail([`** server can't find ${args[0]}: NXDOMAIN`, x.dnsHint(args[0])].filter(Boolean), 1);
    return ['Server:\t\t127.0.0.11', 'Address:\t127.0.0.11:53', '', `Name:\t${args[0]}`, `Address: ${ip}`];
  },
  getent: (x, args) => { const ip = x.resolve(args[1] || ''); if (!ip || ip === 'unreachable') fail([], 2); return [`${ip}      ${args[1]}`]; },
  curl: (x, args) => {
    const url = args.find((a) => !a.startsWith('-')) || '';
    const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/.exec(url);
    if (!m) fail('curl: try \'curl --help\' for more information', 2);
    const [, host, port = '80'] = m;
    if (!Object.keys(x.c.networks).length && host !== 'localhost') fail(`curl: (6) Could not resolve host: ${host}`, 6);
    if (host === 'localhost' || host === '127.0.0.1') {
      const listens = (x.c.kind === 'server' && String(hubInfo(x.c.flavor || '')?.port || 80) === port) || (x.c.kind === 'app' && port === '3000');
      if (!listens) fail(`curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server`, 7);
      return x.ctx.httpBody(x.c, port).split('\n');
    }
    const target = x.peer(host);
    if (target === 'unreachable') fail(`curl: (28) Failed to connect to ${host} port ${port}: Connection timed out`, 28);
    if (target) return target.kind === 'server' || target.kind === 'app' ? x.ctx.httpBody(target, port).split('\n') : fail(`curl: (7) Failed to connect to ${host} port ${port}: Connection refused`, 7);
    if (/\./.test(host) && !/^\d/.test(host)) return ['<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>'];
    fail(`curl: (6) Could not resolve host: ${host}`, 6);
  },
  wget: (x, args) => IN_CTR.curl(x, args.filter((a) => !['-q', '-O-', '-qO-', '-O', '-'].includes(a))),
  nginx: (x, args) => {
    if (!(x.c.flavor || '').includes('nginx')) fail('sh: nginx: not found', 127);
    if (args.includes('-t')) return ['nginx: the configuration file /etc/nginx/nginx.conf syntax is ok', 'nginx: configuration file /etc/nginx/nginx.conf test is successful'];
    if (args.includes('-v')) return [PROGRAM_VERSIONS.nginx];
    if (args.join(' ') === '-s reload') { x.ctx.log(x.c, '[notice] 1#1: signal 1 (SIGHUP) received, reconfiguring'); return []; }
    return ['nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)'];
  },
  'redis-cli': (x, args) => {
    const hostIdx = args.indexOf('-h');
    const targetName = hostIdx >= 0 ? args[hostIdx + 1] : null;
    const target = targetName ? x.peer(targetName) : x.c;
    if (!target || target === 'unreachable' || target.flavor !== 'redis') fail(`Could not connect to Redis at ${targetName || '127.0.0.1'}:6379: ${targetName ? 'Name or service not known' : 'Connection refused'}`, 1);
    const cmd = args.filter((_, i) => i !== hostIdx && i !== hostIdx + 1);
    target.redis ||= {};
    switch ((cmd[0] || '').toLowerCase()) {
      case 'ping': return ['PONG'];
      case 'set': target.redis[cmd[1]] = cmd.slice(2).join(' '); return ['OK'];
      case 'get': return [target.redis[cmd[1]] == null ? '(nil)' : `"${target.redis[cmd[1]]}"`];
      case 'keys': return Object.keys(target.redis).length ? Object.keys(target.redis).map((k, i) => `${i + 1}) "${k}"`) : ['(empty array)'];
      case 'info': return ['# Server', 'redis_version:7.4.1', 'redis_mode:standalone'];
      default: return ['(simulated redis-cli understands: ping, set KEY VALUE, get KEY, keys *, info)'];
    }
  },
  psql: (x, args) => {
    if (x.c.flavor !== 'postgres') fail('sh: psql: not found', 127);
    return args.includes('-c') ? [' version ', '-----------', ' PostgreSQL 16.4 on x86_64-pc-linux-gnu', '(1 row)'] : ['psql (16.4)', '(interactive psql is not simulated — run one query: psql -U postgres -c "select version()")'];
  },
  apk: (x, args) => x.install('apk', args),
  'apt-get': (x, args) => x.install('apt-get', args),
  apt: (x, args) => x.install('apt-get', args),
  kill: (x, args) => {
    const pid = args.filter((a) => !a.startsWith('-')).pop();
    if (pid !== '1') return [];
    x.killMain(args.includes('-9') ? 137 : 143);
    return [];
  },
  exit: (x, args) => { throw new ShellExit([], Number(args[0] || 0), true); },
  sh: (x, args, input) => (args[0] === '-c' ? x.run(args.slice(1).join(' '), input) : ['(nested interactive shells are not simulated — you are already in one)']),
};
['bash', 'ash', '/bin/sh', '/bin/bash'].forEach((n) => { IN_CTR[n] = IN_CTR.sh; });
Object.entries(PROGRAM_VERSIONS).forEach(([prog, version]) => {
  IN_CTR[prog] ||= (x, args) => {
    const owns = prog === x.c.argv[0] || (x.c.flavor || '').startsWith(prog.replace(/3$/, '')) || x.fs().has(`/usr/bin/${prog}`) || (prog === 'npm' && x.c.flavor === 'node') || x.c.kind === 'app';
    if (!owns) fail(`sh: ${prog}: not found`, 127);
    return args.some((a) => /^(-v|-V|--version|version)$/.test(a)) ? [version] : [`(${prog} is installed — the playground only simulates "${prog} --version")`];
  };
});
Object.entries(FILTERS).forEach(([name, fn]) => {
  IN_CTR[name] = (x, args, input) => {
    const files = args.filter((a, i) => !a.startsWith('-') && !(args[i - 1] === '-n' || /^\d+$/.test(a))).slice(name === 'grep' || name === 'jq' ? 1 : 0);
    const text = files.length ? files.flatMap((f) => IN_CTR.cat(x, [f], [])) : input;
    return fn(args.filter((a) => !files.includes(a)), text);
  };
});

/** Runs a shell line inside container c and returns the output lines. */
export const runInContainer = (ctx, c, line, { interactive = false, asMain = false, env = {}, user = null, workdir = null } = {}) => {
  const sess = interactive ? ctx.shell : null;
  const userName = String(user ?? c.cfg.user ?? '') || 'root';
  const uid = /^\d+$/.test(userName) ? userName : userName === 'root' ? '0' : '1000';
  const x = {
    ctx, c, env, uid,
    userName: userName === '0' ? 'root' : userName,
    mainUser: String(c.cfg.user || 'root'),
    cwd: sess?.cwd || workdir || c.cfg.workdir || '/',
    setCwd: (p) => { x.cwd = p; if (sess) sess.cwd = p; },
    fs: () => ctx.ctrFS(c),
    write: (p, content) => {
      const isRoot = x.uid === '0';
      const writable = isRoot || p.startsWith('/tmp') || p.startsWith(`/home/${userName}`) || c.mounts.some((m) => p.startsWith(m.dst)) || p.startsWith(c.cfg.workdir && c.cfg.workdir !== '/' ? c.cfg.workdir : '/nonexistent');
      if (!writable) fail(`${p.split('/').pop()}: ${p}: Permission denied (you are ${x.userName}, not root)`, 1);
      try { ctx.writeFile(c, p, content); } catch (err) { fail(err.message, 1); }
    },
    del: (p) => { try { ctx.deleteFile(c, p); } catch (err) { fail(err.message, 1); } },
    special: (p) => {
      if (p === '/etc/hostname') return [c.cfg.hostname || short(c.id)];
      if (p === '/etc/hosts') return ['127.0.0.1\tlocalhost', ...Object.values(c.networks).map((n) => `${n.ip}\t${c.cfg.hostname || short(c.id)}`), ...c.extraHosts.map((h) => h.split(':').reverse().join('\t'))];
      if (p === '/etc/resolv.conf') return Object.keys(c.networks).some((n) => n !== 'bridge') ? ['nameserver 127.0.0.11', 'options ndots:0'] : ['nameserver 192.168.65.7'];
      if (p === '/sys/fs/cgroup/memory.max') return [c.limits.memory ? String(Math.round(c.limits.memory * 1048576)) : 'max'];
      if (p === '/sys/fs/cgroup/cpu.max') return [c.limits.cpus ? `${Math.round(c.limits.cpus * 100000)} 100000` : 'max 100000'];
      if (p === '/proc/1/cmdline') return [[...(c.entrypoint || []), ...c.argv].join(' ')];
      return null;
    },
    // DNS: names resolve only on shared user-defined networks (the default bridge has no DNS).
    peer: (name) => {
      const others = ctx.ctrs().filter((o) => o !== c && o.status === 'running');
      const byIp = others.find((o) => Object.values(o.networks).some((n) => n.ip === name));
      if (byIp) return Object.keys(byIp.networks).some((n) => c.networks[n]) ? byIp : 'unreachable';
      const shared = (o) => Object.keys(o.networks).filter((n) => n !== 'bridge' && c.networks[n]);
      const hit = others.find((o) => shared(o).some((n) => o.name === name || o.networks[n].aliases.includes(name) || o.cfg.hostname === name));
      return hit || null;
    },
    resolve: (name) => {
      if (name === 'localhost' || name === '127.0.0.1') return '127.0.0.1';
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) { const p = x.peer(name); return p === 'unreachable' ? 'unreachable' : name; }
      const host = c.extraHosts.find((h) => h.split(':')[0] === name);
      if (host) return host.split(':').slice(1).join(':').replace('host-gateway', '192.168.65.254');
      if (name === 'host.docker.internal') return '192.168.65.254';
      const p = x.peer(name);
      if (!p) return /\.(com|org|io|net)$/.test(name) ? '93.184.215.14' : null;
      const net = Object.keys(p.networks).find((n) => c.networks[n] && n !== 'bridge');
      return p.networks[net].ip;
    },
    dnsHint: (name) => {
      const other = ctx.ctrs().find((o) => o.name === name);
      if (!other) return '';
      if (other.status !== 'running') return `(${name} exists but is not running)`;
      return Object.keys(c.networks).every((n) => n === 'bridge') ? '(hint: the default bridge network has no DNS — put both containers on a user-defined network: docker network create appnet)' : `(hint: ${c.name} and ${name} are not on a shared network — docker network connect NET ${name})`;
    },
    install: (tool, args) => {
      if (args[0] === 'update') return ['Hit:1 http://deb.debian.org/debian bookworm InRelease', 'Reading package lists... Done'];
      const pkgs = args.filter((a) => !a.startsWith('-') && !['add', 'install'].includes(a));
      if (x.uid !== '0') fail(tool === 'apk' ? 'ERROR: Unable to lock database: Permission denied' : 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)', 1);
      if (tool === 'apk' && !/alpine|busybox/.test(c.repo) && !/alpine/.test(c.image)) fail('sh: apk: not found (this image is Debian/Ubuntu based — use apt-get install)', 127);
      if (tool === 'apt-get' && /alpine|busybox/.test(c.repo + c.image)) fail('sh: apt-get: not found (this image is Alpine based — use apk add)', 127);
      pkgs.forEach((p) => { ctx.writeFile(c, `/usr/bin/${p}`, ''); KNOWN_BINS.push(p); });
      ctx.writeFile(c, tool === 'apk' ? '/lib/apk/db/installed' : '/var/lib/dpkg/status', pkgs.join('\n'));
      return tool === 'apk' ? [`fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz`, ...pkgs.map((p, i) => `(${i + 1}/${pkgs.length}) Installing ${p} (8.10.1-r0)`), `OK: ${(12 + pkgs.length * 2).toFixed(0)} MiB in ${18 + pkgs.length} packages`] : ['Reading package lists... Done', ...pkgs.map((p) => `Setting up ${p} ...`)];
    },
    killMain: (code) => { throw new ShellExit([], code, 'main'); },
    run: (text, input = []) => runText(text, input),
  };

  // Mini shell: ; && || chains, | pipes and > >> redirects.
  const runText = (text, input = []) => {
    const tokens = tokenize(text);
    const chains = [[]];
    const joins = [];
    tokens.forEach((t) => { if (['&&', '||', ';'].includes(t.op)) { chains.push([]); joins.push(t.op); } else chains.at(-1).push(t); });
    const lines = [];
    let ok = true;
    chains.forEach((chain, i) => {
      const j = joins[i - 1];
      if (!chain.length || (j === '&&' && !ok) || (j === '||' && ok)) return;
      try { lines.push(...runPipe(chain, input)); ok = true; } catch (err) {
        if (!(err instanceof ShellExit) || err.final) throw err;
        lines.push(...err.lines);
        ok = false;
        x.lastCode = err.code;
      }
    });
    return lines;
  };
  const runPipe = (tokens, input) => {
    const segs = [[]];
    tokens.forEach((t) => (t.op === '|' ? segs.push([]) : segs.at(-1).push(t)));
    let data = input;
    segs.forEach((seg) => {
      const words = [], redirect = [];
      for (let i = 0; i < seg.length; i++) {
        if (seg[i].op === '>' || seg[i].op === '>>') { redirect.push({ file: seg[i + 1], append: seg[i].op === '>>' }); i++; } else if (!seg[i].op) words.push(seg[i]);
      }
      const expanded = words.map((w) => w.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => String({ HOSTNAME: c.cfg.hostname || short(c.id), ...c.cfg.env, ...env }[a || b] ?? '')));
      const [prog, ...args] = expanded;
      const fn = IN_CTR[prog];
      if (!fn) fail(`sh: ${prog}: not found${/^(docker|systemctl)$/.test(prog) ? ` (you are inside the container ${c.name} — type exit to get back to your computer)` : ''}`, 127);
      data = fn(x, args, data) || [];
      redirect.forEach(({ file, append }) => {
        const path = resolvePath(x.cwd, file);
        const prev = append && typeof x.fs().get(path) === 'string' ? `${x.fs().get(path)}\n` : '';
        x.write(path, prev + data.join('\n'));
        data = [];
      });
    });
    return data;
  };

  try {
    const lines = runText(line);
    if (asMain) c.pendingExit = x.lastCode ?? 0;
    return lines;
  } catch (err) {
    if (!(err instanceof ShellExit)) throw err;
    if (asMain) { c.pendingExit = err.code; return err.lines; }
    if (err.final === 'main') {
      const res = ctx.exitContainer(c, err.code);
      if (interactive) ctx.shell = null;
      return [...err.lines, res === 'restarted' ? `(PID 1 died with code ${err.code} — the "${c.restart.name}" restart policy started ${c.name} again, RestartCount=${c.restartCount})` : `(PID 1 was the container's main process, so ${c.name} stopped with exit code ${err.code})`];
    }
    if (err.final && interactive) {
      const main = ctx.shell?.mainProcess;
      ctx.shell = null;
      if (main) { ctx.exitContainer(c, err.code, { manual: true }); return ['exit', `(the shell was ${c.name}'s main process, so the container stopped — docker ps -a shows it as Exited (${err.code}))`]; }
      return ['exit', `(back on your computer — ${c.name} keeps running)`];
    }
    return err.lines;
  }
};

// ---------- host programs ----------
export const installShell = (ctx) => {
  const { SHELL, CMDS, out } = ctx;
  ctx.runInContainerLines = (c, argv, opts) => runInContainer(ctx, c, argv.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' '), opts);

  const files = () => ctx.F();
  const readLines = (args, io) => {
    const names = args.filter((a) => !a.startsWith('-'));
    if (!names.length) return String(io.stdin ?? (io.stdinFile ? files().get(ctx.hostFile(io.stdinFile).key) : '')).split('\n');
    return names.flatMap((n) => {
      const f = ctx.hostFile(n);
      if (!f.exists) throw new CommandError(`cat: ${n}: No such file or directory`);
      return typeof f.value === 'string' ? f.value.split('\n') : [`(binary ${f.value.tar === 'fs' ? 'file-system' : 'image'} archive, ${fmtSize(f.value.mb)})`];
    });
  };
  const filter = (name) => (args, io) => {
    const fileArgs = args.filter((a, i) => !a.startsWith('-') && !(args[i - 1] === '-n' || /^\d+$/.test(a))).slice(name === 'grep' || name === 'jq' ? 1 : 0);
    const input = fileArgs.length ? readLines(fileArgs, io) : String(io.stdin ?? '').split('\n').filter((l, i, a) => l || i < a.length - 1);
    try { FILTERS[name](args.filter((a) => !fileArgs.includes(a)), input).forEach((l) => out.print(l)); } catch (err) {
      if (err instanceof ShellExit) { err.lines.forEach((l) => out.print(l)); if (err.code > 1) throw new CommandError(''); return; }
      throw err;
    }
  };
  Object.keys(FILTERS).forEach((n) => { SHELL[n] = filter(n); });

  const listing = (dir = '') => {
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const names = new Set();
    [...files().keys()].forEach((k) => { if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0] + (k.slice(prefix.length).includes('/') ? '/' : '')); });
    return [...names].sort();
  };
  Object.assign(SHELL, {
    help: () => CMDS.help(['docker']),
    ls: (args) => {
      const all = args.some((a) => /^-\w*a/.test(a)), long = args.some((a) => /^-\w*l/.test(a));
      const dir = args.find((a) => !a.startsWith('-')) || '';
      const names = listing(ctx.hostFile(dir).key === '.' ? '' : ctx.hostFile(dir).key).filter((n) => all || !n.startsWith('.'));
      if (dir && !names.length) throw new CommandError(`ls: ${dir}: No such file or directory`);
      if (!long) return out.print(names.join('  '));
      names.forEach((n) => {
        const v = files().get(`${dir ? `${dir.replace(/\/$/, '')}/` : ''}${n}`);
        const size = v == null ? '-' : typeof v === 'string' ? `${v.length}B` : fmtSize(v.mb);
        out.print(`${n.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'}  you  staff  ${size.padStart(7)}  Nov  9 10:00  ${n}`);
      });
    },
    cat: (args, io) => readLines(args, io).forEach((l) => out.print(l)),
    echo: (args) => out.print(args.filter((a) => a !== '-n' && a !== '-e').join(' ')),
    printf: (args) => out.print(args.join(' ').replace(/\\n/g, '\n')),
    touch: (args) => args.forEach((a) => { const k = ctx.hostFile(a).key; if (!files().has(k)) files().set(k, ''); }),
    mkdir: (args) => args.filter((a) => !a.startsWith('-')).forEach((a) => files().set(`${ctx.hostFile(a).key.replace(/\/$/, '')}/.keep`, '')),
    rm: (args) => args.filter((a) => !a.startsWith('-')).forEach((a) => {
      const k = ctx.hostFile(a).key;
      const kids = [...files().keys()].filter((f) => f.startsWith(`${k.replace(/\/$/, '')}/`));
      if (!files().has(k) && !kids.length) throw new CommandError(`rm: ${a}: No such file or directory`);
      files().delete(k);
      kids.forEach((f) => files().delete(f));
    }),
    cp: (args) => {
      const [a, b] = args.filter((v) => !v.startsWith('-'));
      const src = ctx.hostFile(a);
      if (!src.exists) throw new CommandError(`cp: ${a}: No such file or directory`);
      files().set(ctx.hostFile(b).key, src.value);
    },
    mv: (args) => { SHELL.cp(args); files().delete(ctx.hostFile(args.filter((v) => !v.startsWith('-'))[0]).key); },
    pwd: () => out.print(ctx.frame.client === ctx.W.local ? PROJECT_DIR : '/home/you'),
    whoami: () => out.print('you'),
    hostname: () => out.print(ctx.frame.client),
    cd: (args) => out.note(`(the playground stays in ${PROJECT_DIR}${args[0] ? ` — use paths like ${args[0]}/file instead` : ''})`),
    sleep: () => {},
    clear: () => {},
    exit: () => out.note('(you are on your own computer — exit only leaves a container shell)'),
    history: () => out.note('(use the ↑ and ↓ keys to browse your command history)'),
    nano: () => out.note('(editors are not simulated — write files with: echo "text" > file)'),
    vim: () => SHELL.nano(),
    vi: () => SHELL.nano(),
    code: () => SHELL.nano(),
    uname: (args) => out.print(args.includes('-m') ? 'x86_64' : 'Linux'),
    curl: (args) => {
      const url = args.find((a) => !a.startsWith('-')) || '';
      const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/.exec(url);
      if (!m) throw new CommandError("curl: try 'curl --help' for more information");
      const [, host, port = '80'] = m;
      const headers = args.includes('-I') || args.includes('-i');
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) {
        const res = ctx.curlLocal(port);
        if (!res.ok) throw new CommandError(`curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server${ctx.ctrs().some((c) => c.status === 'running' && !c.ports.length && c.kind === 'server') ? '\n(hint: a server container is running but no host port is published — run it with -p HOST:CONTAINER)' : ''}`);
        if (headers) out.print('HTTP/1.1 200 OK\nServer: nginx/1.27.2\nContent-Type: text/html');
        if (!args.includes('-I')) res.body.split('\n').forEach((l) => out.print(l));
        return;
      }
      const byIp = ctx.ctrs().find((c) => c.status === 'running' && Object.values(c.networks).some((n) => n.ip === host));
      if (byIp) return ctx.httpBody(byIp, port).split('\n').forEach((l) => out.print(l));
      const byName = ctx.findCtr(host);
      if (byName) throw new CommandError(`curl: (6) Could not resolve host: ${host}\n(container names only resolve inside Docker networks — from your computer use localhost and a published port)`);
      if (/\./.test(host)) return out.print('<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>');
      throw new CommandError(`curl: (6) Could not resolve host: ${host}`);
    },
    wget: (args) => SHELL.curl(args.filter((a) => !['-q', '-O-', '-qO-', '-O', '-'].includes(a))),
    ssh: (args) => {
      // ssh's own options come before the host; everything after the host is the remote command.
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += /^-[ipolF]$/.test(args[i]) ? 2 : 1;
      const [target, ...cmd] = args.slice(i);
      if (!target) throw new CommandError('usage: ssh [user@]host [command]');
      const host = target.split('@').pop();
      if (!/^[a-z][\w.-]*$/i.test(host)) throw new CommandError(`ssh: Could not resolve hostname ${host}`);
      if (!cmd.length) return out.note(`(interactive ssh is not simulated — run one command on ${host}: ssh ${host} docker ps)`);
      ctx.M(host);
      ctx.withFrame({ client: host, daemon: host }, () => ctx.runLine(cmd.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')));
    },
    scp: (args) => {
      const [src, dst] = args.filter((a) => !a.startsWith('-'));
      const side = (s) => { const m = /^(?:[^@]+@)?([a-z][\w.-]*):(.*)$/i.exec(s || ''); return m ? { host: m[1], path: m[2] } : { host: ctx.frame.client, path: s }; };
      const a = side(src), b = side(dst);
      const from = ctx.M(a.host).files, to = ctx.M(b.host).files;
      const key = a.path.replace(/^\.\//, '').replace(/^~\//, '');
      if (!from.has(key)) throw new CommandError(`scp: ${a.path}: No such file or directory`);
      const name = key.split('/').pop();
      const target = !b.path || b.path === '.' || b.path.endsWith('/') ? `${b.path.replace(/^\.?\/?/, '')}${name}` : b.path.replace(/^~\//, '');
      to.set(target, from.get(key));
      out.print(`${name.padEnd(36)} 100%  ${typeof from.get(key) === 'string' ? `${from.get(key).length}B` : fmtSize(from.get(key).mb)}  12.0MB/s   00:01`);
    },
    // Restarting the daemon shows the difference between restart policies.
    systemctl: (args) => {
      if (!/^(restart|stop|start)$/.test(args[0]) || args[1] !== 'docker') return out.note('(the playground only simulates: sudo systemctl restart docker)');
      const back = [];
      ctx.ctrs().forEach((c) => {
        const wasRunning = ['running', 'paused', 'restarting'].includes(c.status);
        const stoppedByHand = !wasRunning && c.manualStop;
        if (wasRunning) ctx.stopContainer(c, { manual: false });
        const p = c.restart.name;
        if (c.started && (p === 'always' || (p === 'unless-stopped' && !stoppedByHand))) {
          ctx.startContainer(c);
          back.push(c.name);
        }
      });
      out.note(`(Docker daemon restarted. Containers brought back by their restart policy: ${back.length ? back.join(', ') : 'none'}. Containers with restart "no" or "on-failure" stay stopped; "always" even restarts containers you stopped by hand, "unless-stopped" does not.)`);
    },
    service: (args) => SHELL.systemctl([args[1], args[0]]),
    reboot: () => SHELL.systemctl(['restart', 'docker']),
    kubectl: () => { throw new CommandError('kubectl: command not found (Kubernetes is not simulated — see the Orchestration lesson)'); },
  });
};
