/**
 * Simulated Docker engine shared by the playground and the command-reference labs.
 * Output goes through a writer ({ print(text, cls), html(markup), clear() }) so any terminal UI
 * can host it. Command groups live in sibling modules and register themselves on CMDS; add a
 * command by adding it to one of those modules (or a new one listed in MODULES).
 */
import { CommandError, hex, pick, short, splitRef, cleanRepo, baseName, refOf, tokenize, findSubstitutions, tableLines, iso, fmtSize } from './util.js';
import { HUB, hubInfo, baseFiles, PROJECT_FILES, PROJECT_DIR } from './data.js';
import { installContainers } from './containers.js';
import { installImages } from './images.js';
import { installResources } from './resources.js';
import { installCompose } from './compose.js';
import { installSwarm } from './swarm.js';
import { installShell, runInContainer } from './shell.js';

const MODULES = [installContainers, installImages, installResources, installCompose, installSwarm, installShell];
const ADJ = ['brave', 'eager', 'happy', 'jolly', 'quirky', 'sleepy', 'clever', 'focused', 'gentle', 'nifty', 'vibrant', 'zen'];
const SCI = ['turing', 'lovelace', 'hopper', 'curie', 'tesla', 'darwin', 'newton', 'raman', 'bose', 'noether', 'euler', 'kalam'];
const TOP_DIRS = ['bin', 'dev', 'etc', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var'];
const MAX_EVENTS = 300;

const builtinNetworks = () => [
  { name: 'bridge', driver: 'bridge', builtin: true, id: hex(64), subnet: '172.17.0.0/16', gateway: '172.17.0.1', scope: 'local', created: Date.now() },
  { name: 'host', driver: 'host', builtin: true, id: hex(64), scope: 'local', created: Date.now() },
  { name: 'none', driver: 'null', builtin: true, id: hex(64), scope: 'local', created: Date.now() },
];

const freshDaemon = (host) => ({
  host,
  images: [], containers: [], networks: builtinNetworks(), volumes: [], log: [],
  buildCache: new Set(),
  builders: [{ name: 'default', driver: 'docker', status: 'running', platforms: ['linux/amd64', 'linux/amd64/v2', 'linux/386'], nodes: 1 }],
  builder: 'default',
  plugins: [],
  swarm: null, // the cluster object this node belongs to
  nodeId: hex(25),
  subnetSeq: 18,
});

const machine = (name, ip, files = {}) => ({ name, ip, files: new Map(Object.entries(files)), daemon: freshDaemon(name) });

const freshWorld = () => ({
  machines: { laptop: machine('laptop', '192.168.1.10', PROJECT_FILES) },
  local: 'laptop',
  contexts: [{ name: 'default', desc: 'Current DOCKER_HOST based configuration', endpoint: 'unix:///var/run/docker.sock', machine: 'laptop' }],
  context: 'default',
  registry: new Map(), // "docker.io/you/myapp:1.0" → { image, platforms }
  auth: new Map(), // registry host → user
  events: new Set(), // challenge flags
  binds: new Map(), // absolute host path outside the project → Map(rel → content)
  secretValues: new Map(),
  hostSeq: 11,
});

export const createEngine = (writer) => {
  let W = freshWorld();
  let frame = { client: 'laptop', daemon: 'laptop' };
  let shell = null; // { ctrId, machine, cwd, mainProcess }
  const captures = [];
  const CMDS = {};
  const SHELL = {};

  // ---------- output ----------
  const out = {
    print(text = '', cls = '') {
      const lines = String(text).split('\n');
      if (captures.length) return captures.at(-1).push(...lines);
      lines.forEach((l) => writer.print(l, cls));
    },
    html: (markup) => writer.html(markup),
    note: (text) => writer.html(`<span class="dim">${escape(text)}</span>`),
    warn: (text) => writer.html(`<span class="y">${escape(text)}</span>`),
    ok: (text) => (captures.length ? out.print(text) : writer.print(text, 'ok')),
    table: (head, rows) => {
      const [h, ...body] = tableLines(head, rows);
      if (captures.length) return captures.at(-1).push(h, ...body);
      writer.print(h, 'dim tbl');
      body.forEach((l) => writer.print(l, 'tbl'));
    },
  };
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const capture = (fn) => {
    captures.push([]);
    try { fn(); return captures.at(-1); } finally { captures.pop(); }
  };

  // ---------- machines, contexts, daemons ----------
  const M = (name) => {
    if (!W.machines[name]) W.machines[name] = machine(name, `192.168.1.${W.hostSeq++}`);
    return W.machines[name];
  };
  const D = () => M(frame.daemon).daemon;
  const F = () => M(frame.client).files;
  const daemonOf = (host) => M(host).daemon;
  const withFrame = (next, fn) => {
    const prev = frame;
    frame = { ...frame, ...next };
    try { return fn(); } finally { frame = prev; }
  };
  const contextMachine = (name) => {
    const c = W.contexts.find((x) => x.name === name);
    if (!c) throw new CommandError(`context "${name}" does not exist`);
    return c.machine;
  };

  // ---------- events ----------
  const ev = (type, action, id, attrs = {}) => {
    const d = D();
    d.log.push({ time: Date.now(), Type: type, Action: action, Actor: { ID: id, Attributes: attrs }, scope: 'local' });
    if (d.log.length > MAX_EVENTS) d.log.splice(0, d.log.length - MAX_EVENTS);
  };

  // ---------- images ----------
  const imageRows = () => D().images;
  const findImage = (ref, d = D()) => {
    if (!ref) return null;
    const [rawRepo, tag] = splitRef(ref);
    const repo = cleanRepo(rawRepo);
    const id = ref.replace(/^sha256:/, '');
    return d.images.find((i) => i.repo === repo && i.tag === tag)
      || (/^[0-9a-f]{4,64}$/.test(id) ? d.images.find((i) => i.id.startsWith(id)) : null);
  };
  const mustImage = (ref) => {
    const img = findImage(ref);
    if (!img) throw new CommandError(`Error response from daemon: No such image: ${ref || '""'}`);
    return img;
  };
  const imageById = (id, d = D()) => d.images.find((i) => i.id === id);
  const sizeFor = (info, tag) => (/alpine|slim/.test(tag) && info.alpineMb ? info.alpineMb : info.mb);
  const makeImage = (fields) => ({
    id: hex(64), created: Date.now(), mb: 1, platform: 'linux/amd64', layers: [], files: {},
    cfg: { cmd: ['sh'], entrypoint: null, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, workdir: '/', user: '', expose: [], labels: {}, stopSignal: 'SIGTERM' },
    ...fields,
  });
  const addImage = (img, d = D()) => {
    const clash = d.images.find((i) => i.repo === img.repo && i.tag === img.tag && img.repo !== '<none>');
    if (clash && clash.id !== img.id) { clash.repo = '<none>'; clash.tag = '<none>'; }
    if (!clash || clash.id !== img.id) d.images.push(img);
    return img;
  };
  const tagRows = (img, d = D()) => d.images.filter((i) => i.id === img.id);

  // Registry key: "docker.io/you/app:1.0", "ghcr.io/you/app:1.0", "localhost:5000/app:1.0".
  const registryOf = (repo) => {
    const first = repo.split('/')[0];
    return repo.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
  };
  const registryKey = (repo, tag) => `${registryOf(repo) === 'docker.io' && !repo.startsWith('docker.io/') ? 'docker.io/' : ''}${repo}:${tag}`;

  // Adds every parent folder of every file so ls and diff see real directories.
  const withDirs = (files) => {
    const all = { ...files };
    Object.keys(files).forEach((p) => {
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) all[`/${parts.slice(0, i).join('/')}`] ??= null;
    });
    return all;
  };
  const hubImage = (repo, tag, info) => {
    const mb = sizeFor(info, tag);
    const cmd = JSON.stringify(info.cmd).replace(/,/g, ' ');
    const layers = [
      { by: `/bin/sh -c #(nop) ADD file:${hex(12)} in / `, mb: mb * 0.55 },
      { by: '/bin/sh -c #(nop)  CMD ["bash"]', mb: 0 },
      { by: `ENV ${repo.toUpperCase().replace(/\W/g, '_')}_VERSION=${tag === 'latest' ? '1.0.0' : tag}`, mb: 0 },
      { by: `RUN /bin/sh -c set -x && apt-get update && apt-get install --no-install-recommends -y ${repo} # buildkit`, mb: mb * 0.43 },
      ...(info.entrypoint ? [{ by: `COPY ${info.entrypoint[0].replace(/^\//, '')} / # buildkit`, mb: mb * 0.02 }, { by: `ENTRYPOINT ${JSON.stringify(info.entrypoint)}`, mb: 0 }] : []),
      ...(info.port ? [{ by: `EXPOSE map[${info.port}/tcp:{}]`, mb: 0 }] : []),
      ...(info.stopSignal ? [{ by: `STOPSIGNAL ${info.stopSignal}`, mb: 0 }] : []),
      { by: `CMD ${cmd}`, mb: 0 },
    ].map((l) => ({ ...l, id: hex(64) }));
    return makeImage({
      repo, tag, mb, layers, digest: `sha256:${hex(64)}`, hub: true, kind: info.kind,
      files: withDirs(Object.fromEntries([...TOP_DIRS.map((dir) => [`/${dir}`, null]), ...Object.entries(baseFiles(info))])),
      cfg: { cmd: info.cmd, entrypoint: info.entrypoint || null, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, workdir: '/', user: info.user || '', expose: info.port ? [`${info.port}/tcp`] : [], labels: {}, stopSignal: info.stopSignal || 'SIGTERM' },
    });
  };

  /** Pulls into the current daemon. quiet=true for implicit pulls by compose/swarm. */
  const pullImage = (ref, { quiet = false, platform = null } = {}) => {
    const [rawRepo, tag] = splitRef(ref);
    const repo = cleanRepo(rawRepo);
    const existing = findImage(refOf(repo, tag));
    if (existing && !platform) { if (!quiet) out.print(`${tag}: Pulling from ${repo.includes('/') ? repo : `library/${repo}`}\nDigest: ${existing.digest || `sha256:${hex(64)}`}\nStatus: Image is up to date for ${repo}:${tag}`); return existing; }
    const remote = W.registry.get(registryKey(repo, tag));
    const info = hubInfo(repo);
    if (registryOf(repo) === 'localhost:5000' || /^localhost:\d+\//.test(repo)) {
      if (!localRegistryUp()) throw new CommandError(`Error response from daemon: Get "http://${registryOf(repo)}/v2/": dial tcp [::1]:5000: connect: connection refused\n(hint: start a local registry first: docker run -d -p 5000:5000 --name registry registry:2)`);
    }
    if (!remote && !info) {
      const hint = repo.includes('/') ? `(hint: nothing was pushed to ${registryKey(repo, tag)} yet)` : `(the playground's Docker Hub has: ${Object.keys(HUB).filter((k) => !k.includes('/')).join(', ')})`;
      throw new CommandError(`Error response from daemon: pull access denied for ${repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied\n${hint}`);
    }
    if (platform && remote && !remote.platforms.includes(platform)) throw new CommandError(`Error response from daemon: no matching manifest for ${platform} in the manifest list entries`);
    const img = remote ? { ...structuredCopy(remote.image), repo, tag, id: remote.image.id } : hubImage(repo, tag, info);
    if (platform) img.platform = platform;
    if (!quiet) {
      out.print(`${tag}: Pulling from ${repo.includes('/') ? repo : `library/${repo}`}`);
      img.layers.filter((l) => l.mb > 0).forEach((l) => out.html(`${short(l.id)}: <span class="ok">Pull complete</span>`));
      out.print(`Digest: ${img.digest || `sha256:${hex(64)}`}\nStatus: Downloaded newer image for ${repo}:${tag}`);
      if (platform && platform !== 'linux/amd64') out.warn(`WARNING: The requested image's platform (${platform}) does not match the detected host platform (linux/amd64) and no specific platform was requested`);
    }
    ev('image', 'pull', refOf(repo, tag), { name: repo });
    return addImage(img);
  };
  const structuredCopy = (o) => JSON.parse(JSON.stringify(o));
  const localRegistryUp = () => D().containers.some((c) => c.status === 'running' && HUB[c.flavor]?.registry && c.ports.some((p) => p.host === '5000'));

  // ---------- containers ----------
  const ctrs = () => D().containers;
  const findCtr = (key, d = D()) => (key ? d.containers.find((c) => c.name === key.replace(/^\//, '')) || (/^[0-9a-f]{3,64}$/.test(key) ? d.containers.find((c) => c.id.startsWith(key)) : null) : null);
  const mustCtr = (key, cmd = 'docker') => {
    if (!key) throw new CommandError(`"${cmd}" requires at least 1 argument: a container name or ID.`);
    const c = findCtr(key);
    if (!c) throw new CommandError(`Error response from daemon: No such container: ${key}`);
    return c;
  };
  const newName = () => {
    for (;;) {
      const n = `${pick(ADJ)}_${pick(SCI)}`;
      if (!findCtr(n)) return n;
    }
  };
  const networkByName = (name, d = D()) => d.networks.find((n) => n.name === name || n.id.startsWith(name));
  const nextIp = (net, d = D()) => {
    if (!net.subnet) return '';
    const used = d.containers.filter((c) => c.networks[net.name]).map((c) => c.networks[net.name].ip);
    const prefix = net.subnet.split('.').slice(0, 3).join('.');
    for (let i = 2; i < 250; i++) if (!used.includes(`${prefix}.${i}`)) return `${prefix}.${i}`;
    return `${prefix}.250`;
  };
  const attach = (c, net, aliases = []) => {
    c.networks[net.name] = { ip: nextIp(net), aliases, mac: `02:42:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)}`, id: net.id };
  };
  const hostPortsInUse = (except) => {
    const used = new Map();
    D().containers.filter((c) => c !== except && c.status === 'running').forEach((c) => c.ports.forEach((p) => used.set(p.host, c.name)));
    (D().swarm?.services || []).forEach((s) => s.ports.forEach((p) => used.set(p.split(':')[0], `service ${s.name}`)));
    return used;
  };
  const checkPorts = (c) => {
    const used = hostPortsInUse(c);
    const clash = c.ports.find((p) => used.has(p.host));
    if (clash) throw new CommandError(`Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${clash.host} failed: port is already allocated (used by ${used.get(clash.host)})`);
  };
  let randomPort = 32768;
  const parsePort = (spec) => {
    const m = /^(?:(\d+\.\d+\.\d+\.\d+):)?(?:(\d+)?:)?(\d+)(?:\/(tcp|udp))?$/.exec(spec);
    if (!m) throw new CommandError(`invalid publish spec: "${spec}" (expected [IP:]HOST:CONTAINER[/PROTO])`);
    return { ip: m[1] || '0.0.0.0', host: m[2] || String(randomPort++), ctr: m[3], proto: m[4] || 'tcp' };
  };

  // Mount stores: named volume, bind to a host folder, or tmpfs.
  const volumeStore = (v) => ({ list: () => [...v.files.entries()], set: (rel, val) => v.files.set(rel, val), del: (rel) => v.files.delete(rel) });
  const hostPath = (src) => src.replace(/^\$\(pwd\)|^\$PWD|^\$\{PWD\}/, PROJECT_DIR).replace(/^\.(?=\/|$)/, PROJECT_DIR).replace(/^~/, '/home/you');
  const bindStore = (src) => {
    const abs = hostPath(src).replace(/\/$/, '');
    if (abs === PROJECT_DIR || abs.startsWith(`${PROJECT_DIR}/`)) {
      const prefix = abs === PROJECT_DIR ? '' : `${abs.slice(PROJECT_DIR.length + 1)}/`;
      const files = M(W.local).files;
      return {
        list: () => [...files.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]),
        set: (rel, val) => files.set(prefix + rel, val),
        del: (rel) => files.delete(prefix + rel),
      };
    }
    if (!W.binds.has(abs)) W.binds.set(abs, new Map());
    const m = W.binds.get(abs);
    return { list: () => [...m.entries()], set: (rel, val) => m.set(rel, val), del: (rel) => m.delete(rel) };
  };
  const storeFor = (c, mount) => {
    if (mount.type === 'volume') return volumeStore(D().volumes.find((v) => v.name === mount.name) || { files: new Map() });
    if (mount.type === 'tmpfs') return volumeStore(mount);
    return bindStore(mount.src);
  };
  const ensureVolume = (name, { anon = false, labels = {}, driver = 'local' } = {}) => {
    let v = D().volumes.find((x) => x.name === name);
    if (!v) {
      v = { name, driver, created: Date.now(), files: new Map(), anon, labels };
      D().volumes.push(v);
      ev('volume', 'create', name, { driver });
    }
    return v;
  };

  /** The container's file system: image files + writable-layer changes + mounts on top. */
  const ctrFS = (c) => {
    const files = new Map(Object.entries(c.base));
    c.fs.forEach((ch, p) => (ch.kind === 'D' ? files.delete(p) : files.set(p, ch.content)));
    c.mounts.forEach((m) => {
      [...files.keys()].filter((p) => p === m.dst || p.startsWith(`${m.dst}/`)).forEach((p) => files.delete(p));
      files.set(m.dst, null);
      storeFor(c, m).list().forEach(([rel, val]) => files.set(`${m.dst}/${rel}`.replace(/\/+/g, '/'), val));
    });
    return files;
  };
  const mountFor = (c, path) => c.mounts.filter((m) => path === m.dst || path.startsWith(`${m.dst}/`)).sort((a, b) => b.dst.length - a.dst.length)[0];
  const writeFile = (c, path, content) => {
    const m = mountFor(c, path);
    if (m) {
      if (m.ro) throw new CommandError(`${path}: Read-only file system`);
      return storeFor(c, m).set(path.slice(m.dst.length + 1), content);
    }
    if (c.readOnly) throw new CommandError(`can't create '${path}': Read-only file system`);
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = `/${parts.slice(0, i).join('/')}`;
      if (!(dir in c.base) && !c.fs.has(dir)) c.fs.set(dir, { kind: 'A', content: null });
    }
    c.fs.set(path, { kind: path in c.base ? 'C' : 'A', content });
  };
  const deleteFile = (c, path) => {
    const m = mountFor(c, path);
    if (m) return storeFor(c, m).del(path.slice(m.dst.length + 1));
    if (c.readOnly) throw new CommandError(`can't remove '${path}': Read-only file system`);
    if (path in c.base) c.fs.set(path, { kind: 'D', content: null });
    else c.fs.delete(path);
  };
  const diffOf = (c) => {
    const rows = new Map();
    c.fs.forEach((ch, p) => {
      rows.set(p, ch.kind);
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dir = `/${parts.slice(0, i).join('/')}`;
        if (!rows.has(dir) && !(c.fs.get(dir)?.kind === 'A')) rows.set(dir, 'C');
      }
    });
    return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  // Which Docker Hub image a container really behaves like (through tags, builds, commits and imports).
  const flavorOf = (img, argv0) => {
    const candidates = [img.repo, baseName(img.repo), img.base && cleanRepo(splitRef(img.base)[0]), img.base && baseName(cleanRepo(splitRef(img.base)[0]))];
    return candidates.find((k) => k && HUB[k]) || Object.keys(HUB).find((k) => HUB[k].kind === 'server' && HUB[k].cmd[0] === argv0) || null;
  };

  /** o: parsed run options (see containers.js parseRunOptions). */
  const createContainer = (o, img) => {
    const name = o.name || newName();
    if (findCtr(name)) throw new CommandError(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${findCtr(name).id}". You have to remove (or rename) that container to be able to reuse that name.`);
    const netName = o.network || 'bridge';
    const net = networkByName(netName);
    if (!net) throw new CommandError(`Error response from daemon: network ${netName} not found`);
    if (!img.cfg.cmd?.length && !o.cmd.length && !o.entrypoint) throw new CommandError('Error response from daemon: no command specified');
    const argv0 = (o.cmd.length ? o.cmd : img.cfg.cmd || [])[0];
    const flavor = flavorOf(img, argv0);
    const kind = img.kind || HUB[flavor]?.kind || 'shell';
    const c = {
      id: hex(64), name, named: !!o.name, flavor, imageId: img.id, image: o.imageRef || refOf(img.repo, img.tag), repo: img.repo,
      base: img.files, cfg: { ...img.cfg, env: { ...img.cfg.env, ...o.env }, labels: { ...img.cfg.labels, ...o.labels }, workdir: o.workdir || img.cfg.workdir, user: o.user ?? img.cfg.user, hostname: o.hostname || null },
      argv: o.cmd.length ? o.cmd : img.cfg.cmd || [], entrypoint: o.entrypoint ? [o.entrypoint] : img.cfg.entrypoint, userCmd: o.cmd.length > 0,
      tty: o.tty, stdin: o.interactive, kind,
      ports: [], mounts: [], networks: {}, rm: o.rm, restart: o.restart || { name: 'no', max: 0 }, restartCount: 0,
      status: 'created', exitCode: 0, created: Date.now(), started: null, finished: null, logs: [], fs: new Map(),
      limits: { memory: o.memory || 0, cpus: o.cpus || 0, memorySwap: o.memorySwap || 0, pids: o.pids || 0 }, health: o.health || null,
      readOnly: !!o.readOnly, privileged: !!o.privileged, capDrop: o.capDrop || [], capAdd: o.capAdd || [], platform: o.platform || img.platform,
      extraHosts: o.addHost || [], dns: o.dns || [], stopSignal: o.stopSignal || img.cfg.stopSignal, init: !!o.init, opts: o.extra || {},
      compose: o.compose || null, task: o.task || null, secrets: o.secrets || [],
    };
    if (netName === 'host' && o.ports.length) out.warn('WARNING: Published ports are discarded when using host network mode');
    c.ports = netName === 'host' ? [] : [...o.ports.map(parsePort), ...(o.publishAll ? img.cfg.expose.map((e) => parsePort(e.split('/')[0])) : [])];
    if (net.driver !== 'host' && net.driver !== 'null') attach(c, net, [...(o.aliases || []), ...(net.builtin ? [] : [short(c.id)])]);
    c.mounts = o.mounts.map((m) => {
      if (m.type === 'volume') {
        const v = ensureVolume(m.name || hex(64), { anon: !m.name });
        if (!v.files.size) Object.entries(c.base).filter(([p]) => p.startsWith(`${m.dst}/`)).forEach(([p, val]) => v.files.set(p.slice(m.dst.length + 1), val));
        return { ...m, name: v.name };
      }
      if (m.type === 'tmpfs') return { ...m, files: new Map() };
      return m;
    });
    c.secrets.forEach((s) => { c.fs.set(`/run/secrets/${s}`, { kind: 'A', content: W.secretValues.get(s) ?? '' }); });
    D().containers.push(c);
    ev('container', 'create', c.id, { image: c.image, name: c.name });
    return c;
  };

  const log = (c, line, stream = 'stdout') => c.logs.push({ t: Date.now(), line, stream });
  const procKind = (c) => {
    const first = c.argv.join(' ');
    if (/^(sleep (infinity|\d{3,})|tail -f|top|watch )/.test(first) || /while true/.test(first)) return 'daemon';
    return null;
  };

  /** Starts a created/exited container. Returns 'running' | 'exited' | 'error' | 'shell'. */
  const startContainer = (c, { interactive = c.stdin && c.tty } = {}) => {
    checkPorts(c);
    const info = HUB[c.flavor] || {};
    c.started = Date.now();
    c.finished = null;
    c.exitCode = 0;
    c.manualStop = false;
    ev('container', 'start', c.id, { image: c.image, name: c.name });
    if (info.needs && !c.cfg.env[info.needs] && !c.cfg.env[`${info.needs}_FILE`]) {
      log(c, 'Error: Database is uninitialized and superuser password is not specified.', 'stderr');
      log(c, `       You must specify ${info.needs} to a non-empty value for the superuser.`, 'stderr');
      return exitContainer(c, 1);
    }
    try {
      if (!c.fs.size) (info.runtimeDiff || []).forEach((p) => writeFile(c, p, ''));
    } catch (err) {
      log(c, `[emerg] 1#1: mkdir() "${info.runtimeDiff[0]}" failed (30: ${err.message.split(': ').pop()})`, 'stderr');
      return exitContainer(c, 1);
    }
    const daemonCmd = procKind(c);
    if (c.userCmd && !daemonCmd && c.kind !== 'server') {
      if (interactive && /^(\/bin\/)?(sh|bash|ash)$/.test(c.argv[0])) { c.status = 'running'; return 'shell'; }
      runInContainer(ctx, c, c.argv.join(' '), { asMain: true }).forEach((l) => log(c, l));
      return exitContainer(c, c.pendingExit ?? 0);
    }
    if (c.userCmd && c.kind === 'server' && !daemonCmd) {
      runInContainer(ctx, c, c.argv.join(' '), { asMain: true }).forEach((l) => log(c, l));
      return exitContainer(c, c.pendingExit ?? 0);
    }
    if (c.kind === 'once') { (info.log || []).forEach((l) => log(c, l)); return exitContainer(c, 0); }
    if (c.kind === 'shell' && !daemonCmd) {
      if (interactive || (c.stdin && c.tty)) { c.status = 'running'; return 'shell'; }
      return exitContainer(c, 0);
    }
    c.status = 'running';
    (info.log || []).forEach((l) => log(c, l));
    if (c.kind === 'app') log(c, `Server listening on http://0.0.0.0:${c.cfg.expose?.[0]?.split('/')[0] || 3000}`);
    return 'running';
  };

  // Applies the restart policy when the main process ends on its own (not via docker stop).
  const exitContainer = (c, code, { manual = false } = {}) => {
    c.status = 'exited';
    c.exitCode = code;
    c.finished = Date.now();
    c.pendingExit = undefined;
    ev('container', 'die', c.id, { exitCode: String(code), image: c.image, name: c.name });
    const p = c.restart.name;
    const wants = !manual && (p === 'always' || p === 'unless-stopped' || (p === 'on-failure' && code !== 0));
    if (wants && (!c.restart.max || c.restartCount < c.restart.max)) {
      c.restartCount++;
      if (c.kind === 'server' || c.kind === 'app' || procKind(c)) {
        c.status = 'running'; c.started = Date.now();
        ev('container', 'restart', c.id, { name: c.name });
        return 'restarted';
      }
      c.status = 'restarting';
      return 'restarting';
    }
    if (c.rm && !c.task) removeContainer(c, { volumes: true });
    return code ? 'error' : 'exited';
  };

  const stopContainer = (c, { signal = 'SIGTERM', manual = true } = {}) => {
    if (!['running', 'paused', 'restarting'].includes(c.status)) return false;
    c.manualStop = manual;
    ev('container', signal === 'SIGKILL' ? 'kill' : 'stop', c.id, { name: c.name, signal });
    if (shell?.ctrId === c.id) shell = null;
    // Servers handle SIGTERM and exit 0; a plain process as PID 1 ignores it and is SIGKILLed after the timeout.
    exitContainer(c, signal === 'SIGKILL' || c.kind !== 'server' ? 137 : 0, { manual: true });
    return true;
  };

  const removeContainer = (c, { volumes = false } = {}) => {
    const d = D();
    const i = d.containers.indexOf(c);
    if (i >= 0) d.containers.splice(i, 1);
    if (volumes) c.mounts.filter((m) => m.type === 'volume').forEach((m) => {
      const v = d.volumes.find((x) => x.name === m.name);
      if (v?.anon && !d.containers.some((x) => x.mounts.some((mm) => mm.name === v.name))) d.volumes.splice(d.volumes.indexOf(v), 1);
    });
    if (shell?.ctrId === c.id) shell = null;
    ev('container', 'destroy', c.id, { name: c.name });
  };

  const statusText = (c) => {
    const health = c.health && c.status === 'running' ? ` (${Date.now() - c.started < 3000 ? 'health: starting' : 'healthy'})` : '';
    switch (c.status) {
      case 'running': return `Up ${ago(c.started)}${health}`;
      case 'paused': return `Up ${ago(c.started)} (Paused)`;
      case 'restarting': return `Restarting (${c.exitCode}) 1 second ago`;
      case 'exited': return `Exited (${c.exitCode}) ${ago(c.finished || c.created)} ago`;
      default: return 'Created';
    }
  };
  const portText = (p) => `${p.ip}:${p.host}->${p.ctr}/${p.proto}`;
  const ago = (t) => {
    const s = Math.max(1, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s} seconds` : s < 3600 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`;
  };

  // ---------- shell sessions ----------
  const enterShell = (c, { mainProcess = false, cmd = 'sh' } = {}) => {
    shell = { ctrId: c.id, machine: frame.daemon, cwd: c.cfg.workdir || '/', mainProcess, cmd };
    out.note(`(you are now inside ${c.name} — try ls, cat /etc/os-release, hostname, ps. Type exit to leave${mainProcess ? '; that also stops the container, because the shell is its main process' : ''})`);
  };
  const shellCtr = () => (shell ? M(shell.machine).daemon.containers.find((c) => c.id === shell.ctrId) : null);
  const prompt = () => {
    const c = shellCtr();
    if (!c) { shell = null; return frame.client === W.local ? '$' : `${frame.client}$`; }
    const debianish = /bash/.test(shell.cmd) || /ubuntu|debian|node|python|postgres|nginx/.test(c.repo);
    const who = c.cfg.user || 'root';
    return debianish ? `${who}@${short(c.id)}:${shell.cwd}#` : `${shell.cwd === '/' ? '/' : shell.cwd} #`;
  };

  // ---------- host-side helpers ----------
  const hostFile = (name) => {
    const key = String(name || '').replace(/^\.\//, '').replace(new RegExp(`^${PROJECT_DIR}/`), '');
    return { key, exists: F().has(key), value: F().get(key) };
  };
  const curlLocal = (port) => {
    const c = D().containers.find((x) => x.status === 'running' && x.ports.some((p) => p.host === String(port)));
    const svc = !c && (D().swarm?.services || []).find((s) => s.ports.some((p) => p.split(':')[0] === String(port)));
    if (svc) return { ok: true, body: svc.image.startsWith('nginx') ? hubInfo('nginx').files['/usr/share/nginx/html/index.html'] : `hello from ${svc.name}` };
    if (!c) return { ok: false };
    const ctrPort = c.ports.find((p) => p.host === String(port)).ctr;
    return { ok: true, body: httpBody(c, ctrPort), ctr: c };
  };
  const httpBody = (c, ctrPort) => {
    const fs = ctrFS(c);
    if (c.kind === 'app') return 'hi from my container';
    const root = fs.has('/usr/share/nginx/html/index.html') || fs.has('/usr/share/nginx/html') ? '/usr/share/nginx/html' : '/usr/local/apache2/htdocs';
    const body = fs.get(`${root}/index.html`);
    if (body == null) return '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>';
    if (c.flavor === 'redis' || String(ctrPort) === '6379') return '-ERR wrong protocol (this is redis, not HTTP)';
    log(c, `172.17.0.1 - - [${new Date().toUTCString()}] "GET / HTTP/1.1" 200 ${body.length} "-" "curl/8.7.1"`);
    return body;
  };

  // ---------- dispatch ----------
  const GLOBAL_FLAGS = new Set(['--context', '-c', '-H', '--host', '--log-level', '-l', '--config']);
  const runDocker = (args, io) => {
    let i = 0;
    // On your own computer docker talks to the current context; over ssh it talks to that host.
    const next = { ...frame, daemon: frame.client === W.local ? contextMachine(W.context) : frame.daemon };
    for (; i < args.length && args[i].startsWith('-'); i++) {
      const a = args[i];
      if (a === '--version' || a === '-v') return out.print('Docker version 27.3.1, build ce12230 (playground)');
      if (a === '--help' || a === '-h') return CMDS.help(['docker']);
      const [flag, inline] = a.split('=');
      if (!GLOBAL_FLAGS.has(flag)) throw new CommandError(`unknown flag: ${a}\nSee 'docker --help'.`);
      const value = inline ?? args[++i];
      if (flag === '--context' || flag === '-c') next.daemon = contextMachine(value);
      if (flag === '-H' || flag === '--host') next.daemon = /^ssh:\/\//.test(value) ? value.replace(/^ssh:\/\/([^@]+@)?/, '') : W.local;
    }
    const [sub, ...rest] = args.slice(i);
    if (!sub) return CMDS.help(['docker']);
    if (rest.includes('--help') || rest[0] === 'help') return CMDS.help([sub, ...rest.filter((r) => r !== '--help' && r !== 'help' && !r.startsWith('-'))]);
    const fn = CMDS[sub];
    if (!fn) throw new CommandError(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
    return withFrame(next, () => fn(rest, io));
  };

  const runProgram = (tokens, io) => {
    const [prog, ...args] = tokens;
    if (prog === 'sudo') return runProgram(args, io);
    if (prog === 'docker') return runDocker(args, io);
    if (prog === 'docker-compose') return runDocker(['compose', ...args], io);
    if (SHELL[prog]) return SHELL[prog](args, io);
    throw new CommandError(`${prog}: command not found${/^(kubectl|podman|nerdctl)$/.test(prog) ? ' (the playground only simulates docker)' : ' (type "help")'}`);
  };

  // Runs one pipeline: "a | b | c > file", with optional "< file" on the first command.
  const runPipeline = (tokens) => {
    const segments = [[]];
    tokens.forEach((t) => (t.op === '|' ? segments.push([]) : segments.at(-1).push(t)));
    let stdinText = null;
    segments.forEach((seg, idx) => {
      const io = { stdin: stdinText, stdinFile: null, redirect: null, piped: idx < segments.length - 1 };
      const words = [];
      for (let i = 0; i < seg.length; i++) {
        const t = seg[i];
        if (t.op === '>' || t.op === '>>') { io.redirect = { file: seg[++i], append: t.op === '>>' }; continue; }
        if (t.op === '<') { io.stdinFile = seg[++i]; continue; }
        if (t.op) throw new CommandError(`syntax error near unexpected token '${t.op}'`);
        words.push(t);
      }
      if (!words.length) throw new CommandError('syntax error: empty command');
      if (io.stdinFile && !F().has(hostFile(io.stdinFile).key)) throw new CommandError(`sh: can't open ${io.stdinFile}: No such file`);
      const wantsCapture = io.piped || (io.redirect && typeof io.redirect.file === 'string');
      if (!wantsCapture) { runProgram(words, io); stdinText = null; return; }
      const lines = capture(() => runProgram(words, io));
      if (io.redirect && !io.consumed) {
        const { key } = hostFile(io.redirect.file);
        const prev = io.redirect.append && typeof F().get(key) === 'string' ? `${F().get(key)}\n` : '';
        F().set(key, prev + lines.join('\n'));
      }
      stdinText = io.piped ? lines.join('\n') : null;
    });
  };

  const expand = (line) => {
    let text = line.replace(/\$\{?PWD\}?/g, PROJECT_DIR).replace(/\$HOME\b/g, '/home/you');
    const subs = findSubstitutions(text);
    for (const s of subs.reverse()) {
      const inner = s.inner.trim();
      const value = inner === 'pwd' ? (shell ? shell.cwd : PROJECT_DIR) : capture(() => runLine(inner)).join(' ').trim();
      text = text.slice(0, s.start) + value + text.slice(s.end);
    }
    return text;
  };

  // "a && b || c ; d" — && runs on success, || on failure, ; always.
  const runLine = (line) => {
    const tokens = tokenize(expand(line));
    const chains = [];
    let cur = [], joiner = null;
    tokens.forEach((t) => {
      if (['&&', '||', ';'].includes(t.op)) { chains.push({ tokens: cur, joiner }); cur = []; joiner = t.op; return; }
      cur.push(t);
    });
    chains.push({ tokens: cur, joiner });
    let failed = false;
    for (const { tokens: tk, joiner: j } of chains) {
      if (!tk.length) continue;
      if ((j === '&&' && failed) || (j === '||' && !failed)) continue;
      try { runPipeline(tk); failed = false; } catch (err) {
        if (chains.length === 1 || !(err instanceof CommandError)) throw err;
        failed = true;
        writer.print(err.message, 'bad');
      }
    }
  };

  const ctx = {
    get W() { return W; }, D, F, M, daemonOf, withFrame, contextMachine,
    get frame() { return frame; },
    get shell() { return shell; }, set shell(v) { shell = v; },
    CMDS, SHELL, out, capture, ev, escape,
    findImage, mustImage, imageById, imageRows, addImage, makeImage, pullImage, withDirs, tagRows, registryKey, registryOf, hubImage, localRegistryUp, structuredCopy,
    ctrs, findCtr, mustCtr, createContainer, startContainer, stopContainer, exitContainer, removeContainer, statusText, portText, ago, log,
    networkByName, attach, nextIp, ensureVolume, ctrFS, writeFile, deleteFile, diffOf, storeFor, hostFile, hostPath, curlLocal, httpBody,
    enterShell, shellCtr, prompt, runLine, iso, fmtSize, parsePort, checkPorts,
  };
  MODULES.forEach((install) => install(ctx));

  // ---------- public API ----------
  const execute = (raw) => {
    const line = String(raw || '').trim();
    if (!line) return;
    try {
      if (shell && shellCtr()) return runInContainer(ctx, shellCtr(), line, { interactive: true }).forEach((l) => writer.print(l));
      shell = null;
      runLine(line);
    } catch (err) {
      if (!(err instanceof CommandError)) console.error('[engine]', err);
      writer.print(err instanceof CommandError ? err.message : `internal error: ${err.message}`, 'bad');
    }
  };

  return {
    execute,
    prompt,
    reset: () => { W = freshWorld(); frame = { client: 'laptop', daemon: 'laptop' }; shell = null; },
    // Current view for UIs: the daemon the active context points at, plus shared world data.
    state: () => {
      const m = M(contextMachine(W.context));
      return { ...m.daemon, machine: m.name, files: M(W.local).files, events: W.events, context: W.context, contexts: W.contexts, registry: W.registry, inShell: !!shellCtr(), world: W };
    },
    completions: () => [...Object.keys(CMDS), ...ctrs().map((c) => c.name), ...imageRows().map((i) => refOf(i.repo, i.tag)), ...Object.keys(HUB)],
    run: (lines, { silent = false } = {}) => {
      const real = { ...writer };
      if (silent) { writer.print = () => {}; writer.html = () => {}; }
      try { [].concat(lines).forEach(execute); } finally { Object.assign(writer, real); }
    },
    iso,
  };
};
