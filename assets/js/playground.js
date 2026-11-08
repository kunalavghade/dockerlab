// Docker playground: a simulated engine + terminal + live visual of engine state.
import { h, escapeHtml, store, randomHex, toast } from './dom.js';

// ---------- Simulated Docker Hub ----------
const HUB = {
  nginx: { mb: 187, kind: 'server', cmd: 'nginx -g daemon off;', port: 80, log: ['/docker-entrypoint.sh: Configuration complete; ready for start up', 'nginx/1.27.0: start worker processes'] },
  httpd: { mb: 148, kind: 'server', cmd: 'httpd-foreground', port: 80, log: ['AH00558: httpd: Could not reliably determine the server\'s FQDN', 'Apache/2.4 configured -- resuming normal operations'] },
  redis: { mb: 138, kind: 'server', cmd: 'redis-server', port: 6379, log: ['Redis version=7.4.0, bits=64', 'Ready to accept connections tcp'] },
  postgres: { mb: 432, kind: 'server', cmd: 'postgres', port: 5432, needs: 'POSTGRES_PASSWORD', log: ['PostgreSQL init process complete; ready for start up.', 'database system is ready to accept connections'] },
  mysql: { mb: 586, kind: 'server', cmd: 'mysqld', port: 3306, needs: 'MYSQL_ROOT_PASSWORD', log: ['mysqld: ready for connections. Version: 8.4'] },
  mongo: { mb: 757, kind: 'server', cmd: 'mongod', port: 27017, log: ['Waiting for connections on port 27017'] },
  alpine: { mb: 7.8, kind: 'shell', cmd: '/bin/sh' },
  busybox: { mb: 4.3, kind: 'shell', cmd: 'sh' },
  ubuntu: { mb: 78, kind: 'shell', cmd: '/bin/bash' },
  node: { mb: 1100, kind: 'shell', cmd: 'node' },
  python: { mb: 1020, kind: 'shell', cmd: 'python3' },
  'hello-world': { mb: 0.013, kind: 'once', cmd: '/hello', log: ['Hello from Docker!', 'This message shows that your installation appears to be working correctly.'] },
};
const ADJ = ['brave', 'eager', 'happy', 'jolly', 'quirky', 'sleepy', 'clever', 'focused', 'gentle', 'nifty'];
const SCI = ['turing', 'lovelace', 'hopper', 'curie', 'tesla', 'darwin', 'newton', 'raman', 'bose', 'noether'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fmtSize = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(2)}GB` : mb >= 1 ? `${Math.round(mb)}MB` : `${Math.round(mb * 1000)}kB`);
const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} seconds` : `${Math.round(s / 60)} minutes`;
};
const splitRef = (ref) => {
  const at = ref.lastIndexOf(':');
  return at > 0 && !ref.slice(at).includes('/') ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest'];
};
const baseName = (repo) => repo.split('/').pop();
const cleanRepo = (repo) => repo.replace(/^docker\.io\//, '').replace(/^library\//, '');

// Splits a command line respecting single and double quotes.
const tokenize = (line) => {
  const out = [];
  let cur = '', quote = null, has = false;
  for (const ch of line) {
    if (quote) { ch === quote ? (quote = null) : (cur += ch); continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
};

class CommandError extends Error {}

// ---------- Engine ----------
const freshState = () => ({
  images: [],
  containers: [],
  networks: [
    { name: 'bridge', driver: 'bridge', builtin: true, id: randomHex(12) },
    { name: 'host', driver: 'host', builtin: true, id: randomHex(12) },
    { name: 'none', driver: 'null', builtin: true, id: randomHex(12) },
  ],
  volumes: [],
  events: new Set(),
});

const CHALLENGES = [
  { id: 'pull', text: 'Pull any image', hint: 'docker pull alpine', check: (s) => s.images.length > 0 },
  { id: 'web', text: 'Run nginx in the background on host port 8080', hint: 'docker run -d -p 8080:80 nginx', check: (s) => s.containers.some((c) => c.status === 'running' && baseName(c.repo) === 'nginx' && c.ports.some((p) => p.startsWith('8080:'))) },
  { id: 'name', text: 'Start a container with your own name', hint: '--name web', check: (s) => s.containers.some((c) => c.named) },
  { id: 'logs', text: 'Read a container\'s logs', hint: 'docker logs web', check: (s) => s.events.has('logs') },
  { id: 'stop', text: 'Stop a running container gracefully', hint: 'docker stop web', check: (s) => s.events.has('stop') },
  { id: 'vol', text: 'Run a container with a named volume', hint: '-v data:/data', check: (s) => s.containers.some((c) => c.mounts.some((m) => !m.src.startsWith('/') && !m.src.startsWith('.'))) },
  { id: 'net', text: 'Put two containers on your own network', hint: 'docker network create appnet', check: (s) => s.containers.filter((c) => !['bridge', 'host', 'none'].includes(c.network)).length >= 2 },
  { id: 'build', text: 'Build your own image', hint: 'docker build -t myapp .', check: (s) => s.images.some((i) => i.built) },
  { id: 'clean', text: 'Clean up with a prune command', hint: 'docker container prune', check: (s) => s.events.has('prune') },
];

const DOCKERFILE = ['FROM node:20-alpine', 'WORKDIR /app', 'COPY package*.json ./', 'RUN npm ci --omit=dev', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "server.js"]'];

export const renderPlayground = (view, initialCmd) => {
  let S = freshState();
  const history = store.get('dl-pg-history', []);
  let hIdx = history.length;
  const doneSaved = new Set(store.get('dl-pg-done', []));

  // ---------- DOM ----------
  const outEl = h('div', { class: 'pg-out', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Docker command', placeholder: 'type a command, e.g. docker run -d -p 8080:80 --name web nginx' });
  const panels = {
    containers: h('div', { class: 'pg-ctrs' }),
    images: h('div', { class: 'chips' }),
    networks: h('div', { class: 'chips' }),
    volumes: h('div', { class: 'chips' }),
  };
  const counts = { containers: h('small'), images: h('small'), networks: h('small'), volumes: h('small') };
  const chList = h('div', { class: 'challenges' });
  const panel = (key, label) => h('div', { class: 'pg-panel' }, h('h4', {}, label, counts[key]), panels[key]);
  const QUICK = ['docker run hello-world', 'docker run -d -p 8080:80 --name web nginx', 'docker ps -a', 'docker logs web', 'docker exec web ls /', 'docker images', 'docker network create appnet', 'docker volume create data', 'docker build -t myapp .', 'docker system df', 'help'];

  view.append(
    h('div', { class: 'lesson', style: { maxWidth: '1300px' } },
      h('div', { class: 'lesson-head' },
        h('div', { class: 'meta' }, h('span', { class: 'badge' }, '🧪 Playground'), h('span', {}, 'A safe, simulated Docker engine — nothing runs on your computer')),
        h('h1', {}, 'Docker playground'),
        h('p', { class: 'lead' }, 'Type real Docker commands on the left and watch images, containers, networks and volumes change on the right. Complete the challenges to practice.')),
      h('div', { class: 'pg' },
        h('div', {},
          h('div', { class: 'pg-term' },
            h('div', { class: 'pg-term-bar' }, h('i'), h('i'), h('i'), h('span', {}, 'you@docker-lab: ~/project'),
              h('button', { class: 'btn btn-sm', style: { marginLeft: 'auto' }, onclick: () => { S = freshState(); outEl.replaceChildren(); welcome(); render(); } }, '↺ Reset engine')),
            outEl,
            h('div', { class: 'pg-in' }, h('span', {}, '$'), input)),
          h('div', { class: 'quick-cmds' }, QUICK.map((c) => h('button', { class: 'btn btn-sm mono', onclick: () => { input.value = c; input.focus(); } }, c)))),
        h('div', { class: 'pg-vis' },
          panel('containers', '📦 Containers'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, panel('images', '🖼 Images'), panel('volumes', '🗄 Volumes')),
          panel('networks', '🌐 Networks'),
          h('div', { class: 'pg-panel' }, h('h4', {}, '🎯 Challenges', h('small', { id: 'chCount' })), chList)))),
  );

  // ---------- output helpers ----------
  const print = (text = '', cls = '') => outEl.append(h('div', { class: cls }, text));
  const printHtml = (html) => outEl.append(h('div', { html }));
  const table = (head, rows) => {
    const widths = head.map((col, i) => Math.max(col.length, ...rows.map((r) => String(r[i]).length)) + 3);
    const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('').trimEnd();
    print(line(head), 'dim tbl');
    rows.forEach((r) => print(line(r), 'tbl'));
  };
  const welcome = () => {
    printHtml('<span class="ok">Welcome to the Docker Lab playground!</span>');
    printHtml('<span class="dim">This is a simulated engine. Type </span><span class="y">help</span><span class="dim"> to see supported commands, or click a quick command below.</span>');
  };

  // ---------- lookups ----------
  const findImage = (ref) => {
    const [rawRepo, tag] = splitRef(ref);
    const repo = cleanRepo(rawRepo);
    return S.images.find((i) => (i.repo === repo || baseName(i.repo) === repo) && i.tag === tag) || S.images.find((i) => i.id.startsWith(ref));
  };
  const findCtr = (key) => S.containers.find((c) => c.name === key || c.id.startsWith(key));
  const mustCtr = (key) => {
    if (!key) throw new CommandError('"docker" requires a container name or ID.');
    const c = findCtr(key);
    if (!c) throw new CommandError(`Error response from daemon: No such container: ${key}`);
    return c;
  };
  const hubInfo = (repo) => HUB[baseName(repo).split('@')[0]];

  const pull = (ref, quiet = false) => {
    const [rawRepo, tag] = splitRef(ref);
    const repo = cleanRepo(rawRepo);
    const existing = findImage(`${repo}:${tag}`);
    if (existing) { if (!quiet) print(`Status: Image is up to date for ${repo}:${tag}`); return existing; }
    const info = hubInfo(repo);
    if (!info || repo.includes('/')) {
      throw new CommandError(`Error response from daemon: pull access denied for ${repo}, repository does not exist or may require 'docker login'\n(The playground knows: ${Object.keys(HUB).join(', ')})`);
    }
    print(`${tag}: Pulling from library/${baseName(repo)}`);
    const layers = Math.max(1, Math.min(6, Math.round(Math.log10(info.mb * 10 + 1) * 2)));
    for (let i = 0; i < layers; i++) printHtml(`${randomHex(12)}: <span class="ok">Pull complete</span>`);
    print(`Digest: sha256:${randomHex(64)}`, 'dim');
    print(`Status: Downloaded newer image for ${baseName(repo)}:${tag}`);
    const img = { repo: baseName(repo), tag, id: randomHex(12), mb: info.mb, created: Date.now() };
    S.images.push(img);
    return img;
  };

  // ---------- run ----------
  const parseRun = (args) => {
    const o = { detach: false, interactive: false, rm: false, name: null, ports: [], vols: [], network: 'bridge', env: {}, restart: 'no' };
    let i = 0;
    const val = (flag) => {
      if (flag.includes('=')) return flag.slice(flag.indexOf('=') + 1);
      const v = args[++i];
      if (v == null) throw new CommandError(`flag needs an argument: ${flag}`);
      return v;
    };
    for (; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith('-')) break;
      const flag = a.split('=')[0];
      switch (flag) {
        case '-d': case '--detach': o.detach = true; break;
        case '-it': case '-ti': o.interactive = true; break;
        case '-i': case '-t': case '--interactive': case '--tty': o.interactive = true; break;
        case '-dit': case '-itd': o.detach = true; o.interactive = true; break;
        case '--rm': o.rm = true; break;
        case '--name': o.name = val(a); break;
        case '-p': case '--publish': o.ports.push(val(a)); break;
        case '-v': case '--volume': o.vols.push(val(a)); break;
        case '--network': case '--net': o.network = val(a); break;
        case '-e': case '--env': { const [k, ...v] = val(a).split('='); o.env[k] = v.join('='); break; }
        case '--restart': o.restart = val(a); break;
        case '-m': case '--memory': case '--cpus': case '--env-file': case '--mount': case '-w': case '--workdir': case '--user': case '-u': case '--health-cmd': case '--entrypoint': val(a); break;
        case '--read-only': case '-P': case '--privileged': break;
        default: throw new CommandError(`unknown flag: ${flag}\nSee 'help' for supported flags.`);
      }
    }
    o.image = args[i];
    o.cmd = args.slice(i + 1).join(' ');
    if (!o.image) throw new CommandError('"docker run" requires at least 1 argument: an image.');
    return o;
  };

  const createCtr = (o, img) => {
    if (o.name && findCtr(o.name)) throw new CommandError(`Conflict. The container name "/${o.name}" is already in use. Remove it first (docker rm -f ${o.name}).`);
    if (!S.networks.some((n) => n.name === o.network)) throw new CommandError(`Error response from daemon: network ${o.network} not found`);
    for (const p of o.ports) {
      const host = p.split(':').length > 1 ? p.split(':').slice(-2, -1)[0] : null;
      if (!/^\d+(:\d+){0,2}(\/(tcp|udp))?$/.test(p.replace(/^[\d.]+:(?=\d+:\d+)/, ''))) throw new CommandError(`invalid publish spec: ${p}`);
      const clash = host && S.containers.find((c) => c.status === 'running' && c.ports.some((q) => q.split(':').slice(-2, -1)[0] === host));
      if (clash) throw new CommandError(`Bind for 0.0.0.0:${host} failed: port is already allocated (used by ${clash.name})`);
    }
    const mounts = o.vols.map((v) => {
      const [src, dst] = v.split(':');
      if (!dst) return { src: randomHex(12), dst: src, anon: true };
      const isBind = src.startsWith('/') || src.startsWith('.') || src.startsWith('$') || src.startsWith('~');
      if (!isBind && !S.volumes.some((x) => x.name === src)) S.volumes.push({ name: src, created: Date.now() });
      return { src, dst, bind: isBind };
    });
    const info = hubInfo(img.repo) || { kind: img.built ? 'app' : 'shell', cmd: img.cmd || 'sh' };
    const ctr = {
      id: randomHex(64), name: o.name || `${pick(ADJ)}_${pick(SCI)}`, named: !!o.name,
      repo: img.repo, ref: `${img.repo}${img.tag === 'latest' ? '' : `:${img.tag}`}`, img,
      cmd: o.cmd || info.cmd, userCmd: !!o.cmd, interactive: o.interactive, kind: info.kind, ports: o.ports, mounts, network: o.network, env: o.env,
      rm: o.rm, restart: o.restart, status: 'created', exitCode: 0, created: Date.now(), started: null, logs: [],
      ip: o.network === 'host' || o.network === 'none' ? '' : `172.${o.network === 'bridge' ? 17 : 18}.0.${S.containers.filter((c) => c.network === o.network).length + 2}`,
    };
    S.containers.push(ctr);
    return ctr;
  };

  const startCtr = (c, o = {}) => {
    const info = hubInfo(c.repo);
    c.started = Date.now();
    if (info?.needs && !c.env[info.needs]) {
      c.status = 'exited'; c.exitCode = 1;
      c.logs.push(`Error: Database is uninitialized and superuser password is not specified.`, `       You must specify ${info.needs} to a non-empty value.`);
      return 'error';
    }
    if (c.userCmd && c.kind !== 'server' && !o.interactive) {
      // Explicit one-off commands (e.g. "alpine echo hi") run and exit.
      c.logs.push(...simulateCommand(c, c.cmd));
      c.status = 'exited'; c.exitCode = 0;
      return 'once';
    }
    if (c.kind === 'once') { c.logs.push(...info.log); c.status = 'exited'; return 'once'; }
    if (c.kind === 'shell' && !o.interactive) { c.status = 'exited'; return 'shell-exit'; }
    c.status = 'running';
    if (info?.log) c.logs.push(...info.log);
    if (c.kind === 'app') c.logs.push('Server listening on http://0.0.0.0:3000');
    return 'running';
  };

  const simulateCommand = (c, cmd) => {
    const [prog, ...rest] = tokenize(cmd);
    switch (prog) {
      case 'echo': return [rest.join(' ')];
      case 'ls': return rest[0] === '/usr/share/nginx/html' ? ['50x.html  index.html'] : ['bin   dev   etc   home  lib   media mnt   opt   proc  root  run   sbin  srv   sys   tmp   usr   var'];
      case 'hostname': return [c.id.slice(0, 12)];
      case 'whoami': return ['root'];
      case 'pwd': return ['/'];
      case 'date': return [new Date().toUTCString()];
      case 'env': case 'printenv': return [`HOSTNAME=${c.id.slice(0, 12)}`, 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`)];
      case 'cat': return rest[0] === '/etc/os-release' ? ['NAME="Alpine Linux"', 'VERSION_ID=3.20.2'] : [`cat: can't open '${rest[0] || ''}': No such file or directory`];
      case 'ps': return ['PID   USER     COMMAND', `    1 root     ${c.cmd}`, `   ${Math.floor(Math.random() * 40) + 7} root     ps`];
      case 'ping': {
        const target = rest.filter((r) => !r.startsWith('-')).pop();
        const t = target && S.containers.find((x) => x.name === target && x.status === 'running');
        if (!target) return ['ping: usage error: Destination address required'];
        if (t && t.network === c.network && c.network !== 'bridge') return [`PING ${target} (${t.ip}): 56 data bytes`, `64 bytes from ${t.ip}: seq=0 ttl=64 time=0.081 ms`, `64 bytes from ${t.ip}: seq=1 ttl=64 time=0.094 ms`];
        return [`ping: bad address '${target}'`, c.network === 'bridge' ? '(hint: the default bridge has no DNS — use a user-defined network)' : '(hint: both containers must be running on the same network)'];
      }
      case 'sh': case 'bash': case '/bin/sh': case '/bin/bash': return ['(interactive shells are simulated — run single commands instead, e.g. docker exec web ls /)'];
      default: return [`sh: ${prog}: not found`];
    }
  };

  // ---------- commands ----------
  const CMDS = {
    run(args) {
      const o = parseRun(args);
      let img = findImage(o.image);
      if (!img) {
        print(`Unable to find image '${o.image.includes(':') ? o.image : `${o.image}:latest`}' locally`);
        img = pull(o.image);
      }
      const c = createCtr(o, img);
      const res = startCtr(c, o);
      const showLogs = () => c.logs.forEach((l) => print(l));
      switch (res) {
        case 'error': if (!o.detach) showLogs(); else print(c.id); printHtml(`<span class="bad">Container exited with code 1.</span> <span class="dim">Hint: docker logs ${c.name}</span>`); break;
        case 'once': showLogs(); break;
        case 'shell-exit': if (o.detach) print(c.id, 'y'); printHtml(`<span class="dim">(${c.cmd} had no terminal attached, so it exited immediately — add -it (or -dit) to keep it running, or pass a command: docker run ${c.repo} echo hi)</span>`); break;
        default:
          if (o.detach) print(c.id, 'y');
          else if (o.interactive) printHtml(`<span class="dim">(interactive terminal simulated — container "${c.name}" is running. Try: docker exec ${c.name} ls /)</span>`);
          else { showLogs(); printHtml(`<span class="dim">(attached to logs — in a real terminal press Ctrl+C. Tip: use -d to run in the background)</span>`); }
      }
      if (c.rm && c.status === 'exited') S.containers.splice(S.containers.indexOf(c), 1);
    },
    create(args) {
      const o = parseRun(args);
      const img = findImage(o.image) || pull(o.image);
      print(createCtr(o, img).id);
    },
    pull(args) {
      if (!args[0]) throw new CommandError('"docker pull" requires exactly 1 argument.');
      pull(args[0]);
    },
    images() { CMDS.image(['ls']); },
    image([sub, ...rest]) {
      switch (sub) {
        case 'ls': case 'list':
          return table(['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'], S.images.map((i) => [i.repo, i.tag, i.id, `${ago(i.created)} ago`, fmtSize(i.mb)]));
        case 'rm': return CMDS.rmi(rest);
        case 'prune': {
          const used = new Set(S.containers.map((c) => c.img));
          const all = rest.includes('-a') || rest.includes('--all');
          const gone = S.images.filter((i) => !used.has(i) && (all || i.tag === '<none>'));
          S.images = S.images.filter((i) => !gone.includes(i));
          gone.forEach((i) => print(`deleted: sha256:${i.id}`));
          S.events.add('prune');
          return print(`Total reclaimed space: ${fmtSize(gone.reduce((n, i) => n + i.mb, 0))}`);
        }
        default: throw new CommandError(`Usage: docker image ls | rm | prune`);
      }
    },
    rmi(args) {
      if (!args.length) throw new CommandError('"docker rmi" requires at least 1 argument.');
      for (const ref of args.filter((a) => !a.startsWith('-'))) {
        const img = findImage(ref);
        if (!img) throw new CommandError(`Error response from daemon: No such image: ${ref}`);
        const user = S.containers.find((c) => c.img === img);
        if (user && !args.includes('-f')) throw new CommandError(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${user.id.slice(0, 12)} is using its referenced image`);
        S.images.splice(S.images.indexOf(img), 1);
        print(`Untagged: ${img.repo}:${img.tag}`);
        print(`Deleted: sha256:${img.id}`);
      }
    },
    ps(args) {
      const all = args.includes('-a') || args.includes('--all');
      const rows = S.containers.filter((c) => all || c.status === 'running' || c.status === 'paused').map((c) => [
        c.id.slice(0, 12), c.ref, `"${c.cmd.slice(0, 18)}"`,
        `${ago(c.created)} ago`,
        { running: `Up ${ago(c.started)}`, paused: `Up ${ago(c.started)} (Paused)`, exited: `Exited (${c.exitCode}) ${ago(c.started || c.created)} ago`, created: 'Created' }[c.status],
        c.ports.map((p) => { const parts = p.split(':'); return parts.length > 1 ? `0.0.0.0:${parts[parts.length - 2]}->${parts[parts.length - 1]}/tcp` : `${p}/tcp`; }).join(', '),
        c.name,
      ]);
      table(['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'], rows);
    },
    container([sub, ...rest]) {
      if (sub === 'ls') return CMDS.ps(rest);
      if (sub === 'prune') {
        const gone = S.containers.filter((c) => c.status === 'exited' || c.status === 'created');
        S.containers = S.containers.filter((c) => !gone.includes(c));
        if (gone.length) print('Deleted Containers:');
        gone.forEach((c) => print(c.id));
        S.events.add('prune');
        return print(`\nTotal reclaimed space: ${gone.length * 2}kB`);
      }
      if (CMDS[sub]) return CMDS[sub](rest);
      throw new CommandError('Usage: docker container ls | prune | start | stop | rm …');
    },
    start(args) {
      for (const k of args) {
        const c = mustCtr(k);
        if (c.status !== 'running') startCtr(c, { detach: true, interactive: c.interactive });
        print(c.name);
      }
    },
    stop(args) {
      for (const k of args.filter((a) => !a.startsWith('-'))) {
        const c = mustCtr(k);
        if (c.status === 'running' || c.status === 'paused') { c.status = 'exited'; c.exitCode = 0; S.events.add('stop'); }
        print(k);
        if (c.rm) S.containers.splice(S.containers.indexOf(c), 1);
      }
    },
    kill(args) {
      for (const k of args) {
        const c = mustCtr(k);
        if (c.status !== 'running' && c.status !== 'paused') throw new CommandError(`Error response from daemon: cannot kill container: ${k}: container is not running`);
        c.status = 'exited'; c.exitCode = 137;
        print(k);
      }
    },
    restart(args) { for (const k of args) { const c = mustCtr(k); c.status = 'exited'; startCtr(c, { detach: true, interactive: c.interactive }); print(k); } },
    pause(args) {
      for (const k of args) {
        const c = mustCtr(k);
        if (c.status !== 'running') throw new CommandError(`Error response from daemon: container ${k} is not running`);
        c.status = 'paused'; print(k);
      }
    },
    unpause(args) {
      for (const k of args) {
        const c = mustCtr(k);
        if (c.status !== 'paused') throw new CommandError(`Error response from daemon: container ${k} is not paused`);
        c.status = 'running'; print(k);
      }
    },
    rm(args) {
      const force = args.includes('-f') || args.includes('--force');
      const keys = args.filter((a) => !a.startsWith('-'));
      if (!keys.length) throw new CommandError('"docker rm" requires at least 1 argument.');
      for (const k of keys) {
        const c = mustCtr(k);
        if (c.status === 'running' && !force) throw new CommandError(`Error response from daemon: cannot remove container "${c.name}": container is running: stop the container before removing or force remove`);
        S.containers.splice(S.containers.indexOf(c), 1);
        print(k);
      }
    },
    logs(args) {
      const c = mustCtr(args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a)).pop());
      const tailIdx = args.indexOf('--tail');
      const lines = tailIdx >= 0 ? c.logs.slice(-Number(args[tailIdx + 1] || 10)) : c.logs;
      lines.forEach((l) => print(l));
      if (c.status === 'running' && baseName(c.repo) === 'nginx' && c.ports.length) print(`172.17.0.1 - - "GET / HTTP/1.1" 200 615 "-" "Mozilla/5.0"`);
      if (args.includes('-f')) printHtml('<span class="dim">(following simulated — in a real terminal this keeps streaming until Ctrl+C)</span>');
      S.events.add('logs');
    },
    exec(args) {
      const rest = args.filter((a) => !['-it', '-ti', '-i', '-t', '-d'].includes(a));
      const c = mustCtr(rest[0]);
      if (c.status !== 'running') throw new CommandError(`Error response from daemon: container ${c.id.slice(0, 12)} is not running`);
      const cmd = rest.slice(1).join(' ');
      if (!cmd) throw new CommandError('"docker exec" requires at least 2 arguments: a container and a command.');
      simulateCommand(c, cmd).forEach((l) => print(l));
    },
    inspect(args) {
      const key = args.filter((a) => !a.startsWith('-')).pop();
      const c = findCtr(key);
      if (!c) {
        const img = key && findImage(key);
        if (!img) throw new CommandError(`Error: No such object: ${key}`);
        return print(JSON.stringify([{ Id: `sha256:${img.id}`, RepoTags: [`${img.repo}:${img.tag}`], Size: Math.round(img.mb * 1e6) }], null, 2));
      }
      print(JSON.stringify([{
        Id: c.id, Name: `/${c.name}`, Image: c.ref,
        State: { Status: c.status, Running: c.status === 'running', ExitCode: c.exitCode },
        Config: { Cmd: c.cmd.split(' '), Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`) },
        HostConfig: { PortBindings: c.ports, RestartPolicy: { Name: c.restart } },
        Mounts: c.mounts.map((m) => ({ Type: m.bind ? 'bind' : 'volume', Source: m.src, Destination: m.dst })),
        NetworkSettings: { Networks: { [c.network]: { IPAddress: c.ip } } },
      }], null, 2));
    },
    top(args) { const c = mustCtr(args[0]); simulateCommand(c, 'ps').forEach((l) => print(l)); },
    port(args) { const c = mustCtr(args[0]); c.ports.forEach((p) => { const pp = p.split(':'); print(`${pp[pp.length - 1]}/tcp -> 0.0.0.0:${pp[pp.length - 2] || '32768'}`); }); },
    stats() {
      table(['CONTAINER ID', 'NAME', 'CPU %', 'MEM USAGE / LIMIT', 'NET I/O'],
        S.containers.filter((c) => c.status === 'running').map((c) => [c.id.slice(0, 12), c.name, `${(Math.random() * 3).toFixed(2)}%`, `${(Math.random() * 40 + 5).toFixed(1)}MiB / 7.6GiB`, `${Math.round(Math.random() * 90)}kB / 0B`]));
      printHtml('<span class="dim">(snapshot — the real command keeps updating)</span>');
    },
    network([sub, ...rest]) {
      switch (sub) {
        case 'ls': return table(['NETWORK ID', 'NAME', 'DRIVER', 'SCOPE'], S.networks.map((n) => [n.id, n.name, n.driver, 'local']));
        case 'create': {
          const name = rest.filter((a) => !a.startsWith('-')).pop();
          if (!name) throw new CommandError('"docker network create" requires exactly 1 argument.');
          if (S.networks.some((n) => n.name === name)) throw new CommandError(`Error response from daemon: network with name ${name} already exists`);
          const n = { name, driver: 'bridge', id: randomHex(12) };
          S.networks.push(n);
          return print(randomHex(64));
        }
        case 'rm': {
          for (const name of rest) {
            const n = S.networks.find((x) => x.name === name);
            if (!n) throw new CommandError(`Error response from daemon: network ${name} not found`);
            if (n.builtin) throw new CommandError(`Error response from daemon: ${name} is a pre-defined network and cannot be removed`);
            if (S.containers.some((c) => c.network === name && c.status === 'running')) throw new CommandError(`Error response from daemon: error while removing network: network ${name} has active endpoints`);
            S.networks.splice(S.networks.indexOf(n), 1);
            print(name);
          }
          return;
        }
        case 'connect': {
          const [net, key] = rest;
          if (!S.networks.some((n) => n.name === net)) throw new CommandError(`Error response from daemon: network ${net} not found`);
          const c = mustCtr(key);
          c.network = net; c.ip = `172.18.0.${S.containers.filter((x) => x.network === net).length + 1}`;
          return printHtml(`<span class="dim">(${c.name} is now on ${net} — the playground shows one network per container)</span>`);
        }
        case 'inspect': {
          const n = S.networks.find((x) => x.name === rest[0]);
          if (!n) throw new CommandError(`Error: No such network: ${rest[0]}`);
          return print(JSON.stringify([{ Name: n.name, Driver: n.driver, Containers: Object.fromEntries(S.containers.filter((c) => c.network === n.name).map((c) => [c.id.slice(0, 12), { Name: c.name, IPv4Address: `${c.ip}/16` }])) }], null, 2));
        }
        case 'prune': {
          const used = new Set(S.containers.map((c) => c.network));
          const gone = S.networks.filter((n) => !n.builtin && !used.has(n.name));
          S.networks = S.networks.filter((n) => !gone.includes(n));
          S.events.add('prune');
          return gone.forEach((n) => print(n.name));
        }
        default: throw new CommandError('Usage: docker network ls | create | rm | connect | inspect | prune');
      }
    },
    volume([sub, ...rest]) {
      switch (sub) {
        case 'ls': return table(['DRIVER', 'VOLUME NAME'], S.volumes.map((v) => ['local', v.name]));
        case 'create': {
          const name = rest.filter((a) => !a.startsWith('-')).pop() || randomHex(32);
          if (!S.volumes.some((v) => v.name === name)) S.volumes.push({ name, created: Date.now() });
          return print(name);
        }
        case 'rm': {
          for (const name of rest) {
            const v = S.volumes.find((x) => x.name === name);
            if (!v) throw new CommandError(`Error response from daemon: get ${name}: no such volume`);
            const user = S.containers.find((c) => c.mounts.some((m) => m.src === name));
            if (user) throw new CommandError(`Error response from daemon: remove ${name}: volume is in use - [${user.id.slice(0, 12)}]`);
            S.volumes.splice(S.volumes.indexOf(v), 1);
            print(name);
          }
          return;
        }
        case 'inspect': {
          const v = S.volumes.find((x) => x.name === rest[0]);
          if (!v) throw new CommandError(`Error: No such volume: ${rest[0]}`);
          return print(JSON.stringify([{ Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Name: v.name, Scope: 'local' }], null, 2));
        }
        case 'prune': {
          const used = new Set(S.containers.flatMap((c) => c.mounts.map((m) => m.src)));
          const gone = S.volumes.filter((v) => !used.has(v.name));
          S.volumes = S.volumes.filter((v) => !gone.includes(v));
          S.events.add('prune');
          if (gone.length) print('Deleted Volumes:');
          return gone.forEach((v) => print(v.name));
        }
        default: throw new CommandError('Usage: docker volume ls | create | rm | inspect | prune');
      }
    },
    build(args) {
      let tag = null;
      for (let i = 0; i < args.length; i++) if (args[i] === '-t' || args[i] === '--tag') tag = args[++i];
      if (!args.includes('.')) throw new CommandError('"docker build" requires exactly 1 argument: the build context (try: docker build -t myapp .)');
      const [repo, t] = tag ? splitRef(tag) : ['<none>', '<none>'];
      print(`[+] Building ${(Math.random() * 8 + 4).toFixed(1)}s (${DOCKERFILE.length + 2}/${DOCKERFILE.length + 2}) FINISHED`, 'ok');
      print(' => [internal] load build definition from Dockerfile', 'dim');
      print(' => [internal] load .dockerignore', 'dim');
      const base = findImage('node:20-alpine') || (() => { const img = { repo: 'node', tag: '20-alpine', id: randomHex(12), mb: 132, created: Date.now() }; S.images.push(img); return img; })();
      DOCKERFILE.forEach((line, i) => {
        const cached = S.images.some((x) => x.built) && i < 4;
        printHtml(` => ${cached ? '<span class="dim">CACHED </span>' : ''}[${i + 1}/${DOCKERFILE.length}] ${escapeHtml(line)}`);
      });
      print(' => exporting to image', 'dim');
      const old = tag && findImage(tag);
      if (old) { old.repo = '<none>'; old.tag = '<none>'; }
      const img = { repo: baseName(repo), tag: t, id: randomHex(12), mb: base.mb + 49, created: Date.now(), built: true, cmd: 'node server.js' };
      S.images.push(img);
      print(` => naming to docker.io/library/${repo}:${t}`, 'ok');
    },
    tag(args) {
      const [src, dst] = args;
      const img = src && findImage(src);
      if (!img || !dst) throw new CommandError(`Error response from daemon: No such image: ${src || ''}`);
      const [repo, t] = splitRef(dst);
      S.images.push({ ...img, repo, tag: t, created: img.created });
    },
    push(args) {
      const ref = args[0] || '';
      if (!findImage(ref)) throw new CommandError(`An image does not exist locally with the tag: ${ref}`);
      if (!ref.includes('/')) throw new CommandError(`denied: requested access to the resource is denied\n(hint: tag it with your account first, e.g. docker tag ${ref} yourname/${ref})`);
      printHtml(`The push refers to repository [docker.io/${escapeHtml(splitRef(ref)[0])}]`);
      for (let i = 0; i < 3; i++) printHtml(`${randomHex(12)}: <span class="ok">Pushed</span>`);
      print(`${splitRef(ref)[1]}: digest: sha256:${randomHex(64)} size: 1157`);
      printHtml('<span class="dim">(simulated — nothing was uploaded)</span>');
    },
    login() { print('Login Succeeded', 'ok'); printHtml('<span class="dim">(simulated)</span>'); },
    system([sub, ...rest]) {
      if (sub === 'df') {
        const used = new Set(S.containers.map((c) => c.img));
        const imgMb = S.images.reduce((n, i) => n + i.mb, 0);
        const free = S.images.filter((i) => !used.has(i)).reduce((n, i) => n + i.mb, 0);
        return table(['TYPE', 'TOTAL', 'ACTIVE', 'SIZE', 'RECLAIMABLE'], [
          ['Images', S.images.length, used.size, fmtSize(imgMb), fmtSize(free)],
          ['Containers', S.containers.length, S.containers.filter((c) => c.status === 'running').length, `${S.containers.length * 2}kB`, `${S.containers.filter((c) => c.status !== 'running').length * 2}kB`],
          ['Local Volumes', S.volumes.length, S.volumes.filter((v) => S.containers.some((c) => c.mounts.some((m) => m.src === v.name))).length, '0B', '0B'],
          ['Build Cache', S.images.filter((i) => i.built).length * 4, 0, `${S.images.filter((i) => i.built).length * 18}MB`, `${S.images.filter((i) => i.built).length * 18}MB`],
        ]);
      }
      if (sub === 'prune') {
        const ctrs = S.containers.filter((c) => c.status !== 'running' && c.status !== 'paused');
        S.containers = S.containers.filter((c) => !ctrs.includes(c));
        const used = new Set(S.containers.map((c) => c.img));
        const all = rest.includes('-a') || rest.includes('--all');
        const imgs = S.images.filter((i) => !used.has(i) && (all || i.tag === '<none>'));
        S.images = S.images.filter((i) => !imgs.includes(i));
        const usedNets = new Set(S.containers.map((c) => c.network));
        S.networks = S.networks.filter((n) => n.builtin || usedNets.has(n.name));
        S.events.add('prune');
        printHtml('<span class="y">WARNING! This will remove all stopped containers, unused networks, dangling images and build cache.</span>');
        print(`Deleted ${ctrs.length} container(s), ${imgs.length} image(s).`);
        return print(`Total reclaimed space: ${fmtSize(imgs.reduce((n, i) => n + i.mb, 0))}`);
      }
      if (sub === 'info') return CMDS.info();
      throw new CommandError('Usage: docker system df | prune | info');
    },
    version() {
      print('Client:\n Version:    27.3.1 (playground)\n API version: 1.47\n\nServer: Docker Engine (simulated)\n Engine:\n  Version:   27.3.1\n  OS/Arch:   linux/amd64');
    },
    info() {
      print(`Containers: ${S.containers.length}\n Running: ${S.containers.filter((c) => c.status === 'running').length}\n Paused: ${S.containers.filter((c) => c.status === 'paused').length}\n Stopped: ${S.containers.filter((c) => c.status === 'exited').length}\nImages: ${S.images.length}\nServer Version: 27.3.1 (simulated)\nStorage Driver: overlay2`);
    },
    history(args) {
      const img = args[0] && findImage(args[0]);
      if (!img) throw new CommandError(`Error response from daemon: No such image: ${args[0] || ''}`);
      const rows = img.built ? DOCKERFILE.slice().reverse().map((l, i) => [i === 0 ? img.id : '<missing>', l.slice(0, 32), l.startsWith('RUN') ? '48MB' : l.startsWith('COPY') ? '1.2MB' : '0B']) : [[img.id, `/bin/sh -c #(nop) CMD ["${hubInfo(img.repo)?.cmd || 'sh'}"]`, '0B'], ['<missing>', '/bin/sh -c #(nop) ADD file:… in /', fmtSize(img.mb)]];
      table(['IMAGE', 'CREATED BY', 'SIZE'], rows);
    },
    compose() {
      printHtml('<span class="dim">Compose is not simulated here — see the interactive animation in the <a href="#/lesson/compose">Docker Compose</a> lesson.</span>');
    },
  };

  const HELP = [
    ['docker run [-d] [-it] [--rm] [--name N] [-p H:C] [-v vol:/path] [--network net] [-e K=V] IMAGE [CMD]', 'create + start'],
    ['docker ps [-a]  |  docker images  |  docker pull IMAGE', 'list / download'],
    ['docker start|stop|restart|pause|unpause|kill|rm [-f] NAME', 'lifecycle'],
    ['docker logs [--tail N] NAME  |  docker exec NAME CMD', 'look inside'],
    ['docker inspect NAME  |  docker top NAME  |  docker port NAME  |  docker stats', 'details'],
    ['docker network ls|create|rm|connect|inspect|prune', 'networks'],
    ['docker volume ls|create|rm|inspect|prune', 'volumes'],
    ['docker build -t NAME .  |  docker history IMAGE  |  docker tag  |  docker push', 'images'],
    ['docker rmi IMAGE  |  docker image prune [-a]  |  docker container prune', 'cleanup'],
    ['docker system df|prune  |  docker version  |  docker info', 'system'],
    ['ls  |  cat Dockerfile  |  clear  |  help', 'shell helpers'],
  ];

  const SHELL = {
    help: () => { print('Supported commands:', 'ok'); HELP.forEach(([c, d]) => printHtml(`  <span class="y">${escapeHtml(c)}</span> <span class="dim"># ${d}</span>`)); },
    clear: () => outEl.replaceChildren(),
    ls: () => print('Dockerfile  package.json  package-lock.json  server.js  .dockerignore'),
    cat: (args) => { if (args[0] === 'Dockerfile') DOCKERFILE.forEach((l) => print(l)); else if (args[0] === 'server.js') print("require('http').createServer((q, r) => r.end('hi from my container')).listen(3000);"); else print(`cat: ${args[0] || ''}: No such file`, 'bad'); },
    pwd: () => print('/home/you/project'),
    whoami: () => print('you'),
  };

  const execute = (line) => {
    const trimmed = line.trim();
    printHtml(`<span class="p">$</span> ${escapeHtml(trimmed)}`);
    if (!trimmed) return;
    if (history[history.length - 1] !== trimmed) history.push(trimmed);
    store.set('dl-pg-history', history.slice(-50));
    hIdx = history.length;
    const [prog, sub, ...rest] = tokenize(trimmed);
    try {
      if (SHELL[prog]) return SHELL[prog]([sub, ...rest].filter((x) => x != null));
      if (prog !== 'docker') throw new CommandError(`${prog}: command not found (type "help")`);
      if (!sub) return SHELL.help();
      const fn = CMDS[sub];
      if (!fn) throw new CommandError(`docker: '${sub}' is not a docker command (or not simulated here).\nSee 'help'.`);
      fn(rest);
    } catch (err) {
      if (!(err instanceof CommandError)) console.error('[playground]', err);
      print(err instanceof CommandError ? err.message : `internal error: ${err.message}`, 'bad');
    } finally {
      render();
      outEl.scrollTop = outEl.scrollHeight;
    }
  };

  // ---------- visual state ----------
  const render = () => {
    const ctrs = S.containers;
    counts.containers.textContent = `${ctrs.filter((c) => c.status === 'running').length} running · ${ctrs.length} total`;
    panels.containers.replaceChildren(...(ctrs.length ? ctrs.map((c) => h('div', { class: `pg-ctr ${c.status} pop` },
      h('div', { class: 'nm' }, h('span', { class: `status-dot ${c.status}` }), c.name),
      h('div', { class: 'sub' }, `${c.ref} · ${c.status}${c.status === 'exited' ? ` (${c.exitCode})` : ''}`),
      c.ports.length && h('div', { class: 'sub' }, `ports ${c.ports.join(', ')}`),
      c.network !== 'bridge' && h('div', { class: 'sub' }, `net ${c.network}`),
      c.mounts.length && h('div', { class: 'sub' }, `mount ${c.mounts.map((m) => `${m.anon ? 'anon' : m.src}→${m.dst}`).join(', ')}`),
    )) : [h('div', { class: 'pg-empty' }, 'No containers yet — try docker run hello-world')]));
    counts.images.textContent = `${S.images.length}`;
    panels.images.replaceChildren(...(S.images.length ? S.images.map((i) => h('span', { class: `chip ${i.built ? 'blue' : i.tag === '<none>' ? 'warn' : 'light'}` }, `${i.repo}:${i.tag}`)) : [h('div', { class: 'pg-empty' }, 'none')]));
    counts.volumes.textContent = `${S.volumes.length}`;
    panels.volumes.replaceChildren(...(S.volumes.length ? S.volumes.map((v) => h('span', { class: 'chip' }, `🗄 ${v.name}`)) : [h('div', { class: 'pg-empty' }, 'none')]));
    counts.networks.textContent = `${S.networks.length}`;
    panels.networks.replaceChildren(...S.networks.map((n) => {
      const members = ctrs.filter((c) => c.network === n.name).map((c) => c.name);
      return h('span', { class: `chip ${n.builtin ? '' : 'blue'}` }, `${n.name}${members.length ? ` [${members.join(', ')}]` : ''}`);
    }));
    let doneCount = 0;
    chList.replaceChildren(...CHALLENGES.map((ch) => {
      const done = doneSaved.has(ch.id) || ch.check(S);
      if (done && !doneSaved.has(ch.id)) { doneSaved.add(ch.id); store.set('dl-pg-done', [...doneSaved]); toast(`🎯 Challenge complete: ${ch.text}`); }
      if (done) doneCount++;
      return h('div', { class: `challenge ${done ? 'done' : ''}` }, h('span', { class: 'ck' }, done ? '✓' : ''), h('div', {}, ch.text, h('br'), h('code', {}, ch.hint)));
    }));
    view.querySelector('#chCount').textContent = `${doneCount} / ${CHALLENGES.length}`;
  };

  // ---------- input handling ----------
  const complete = () => {
    const parts = input.value.split(' ');
    const last = parts[parts.length - 1];
    const pool = parts.length <= 2 ? [...Object.keys(CMDS), ...Object.keys(SHELL)] : [...S.containers.map((c) => c.name), ...S.images.map((i) => `${i.repo}:${i.tag}`), ...Object.keys(HUB)];
    const hits = pool.filter((x) => x.startsWith(last));
    if (hits.length === 1) { parts[parts.length - 1] = hits[0]; input.value = `${parts.join(' ')} `; }
    else if (hits.length > 1) print(hits.join('  '), 'dim');
  };
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Enter': execute(input.value); input.value = ''; break;
      case 'ArrowUp': if (hIdx > 0) input.value = history[--hIdx]; e.preventDefault(); break;
      case 'ArrowDown': hIdx = Math.min(history.length, hIdx + 1); input.value = history[hIdx] || ''; e.preventDefault(); break;
      case 'Tab': e.preventDefault(); complete(); break;
      case 'l': if (e.ctrlKey) { e.preventDefault(); outEl.replaceChildren(); } break;
      default: break;
    }
  });
  outEl.addEventListener('click', () => { if (!window.getSelection()?.toString()) input.focus(); });

  welcome();
  render();
  if (initialCmd) {
    printHtml('<span class="dim"># command sent from a lesson:</span>');
    execute(initialCmd);
  }
  input.focus({ preventScroll: true });
};
