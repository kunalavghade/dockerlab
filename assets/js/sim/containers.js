// Container commands: run/create/start/stop…, ps, logs, exec, inspect, cp, diff, commit, export.
import { CommandError, hex, short, flagSpec, parseArgs, parseFilters, parseMem, fmtMem, formatRows, renderTemplate, iso, refOf } from './util.js';
import { hubInfo } from './data.js';

const RUN_SPEC = flagSpec(
  'detach:d interactive:i tty:t rm publish-all:P read-only privileged init no-healthcheck sig-proxy oom-kill-disable quiet:q help',
  'name publish:p volume:v env:e env-file network net network-alias hostname:h workdir:w user:u entrypoint label:l label-file restart memory:m memory-swap memory-reservation cpus cpu-shares:c cpuset-cpus pids-limit mount add-host dns dns-search cap-add cap-drop security-opt platform pull expose health-cmd health-interval health-retries health-timeout health-start-period log-driver log-opt stop-signal stop-timeout tmpfs ulimit device gpus shm-size ip ipc pid userns runtime sysctl attach:a cidfile volumes-from domainname mac-address',
);
const RESTARTS = ['no', 'always', 'unless-stopped', 'on-failure'];
const isBindSrc = (s) => /^(\/|\.|~|\$)/.test(s);
const durationMs = (s) => {
  const m = /^(\d+)(s|m|h)$/.exec(s || '');
  return m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2]] : null;
};

export const installContainers = (ctx) => {
  const { CMDS, out } = ctx;

  // ---------- option parsing ----------
  const parseMount = (spec) => {
    const kv = Object.fromEntries(spec.split(',').map((p) => { const [k, ...v] = p.split('='); return [k, v.length ? v.join('=') : true]; }));
    const type = kv.type || 'volume';
    const dst = kv.target || kv.destination || kv.dst;
    if (!dst) throw new CommandError(`invalid argument "${spec}" for "--mount" flag: target is required`);
    return { type, name: type === 'volume' ? kv.source || kv.src || null : null, src: type === 'bind' ? kv.source || kv.src : null, dst, ro: !!(kv.readonly || kv.ro) };
  };
  const parseVolume = (spec) => {
    const parts = spec.split(':');
    if (parts.length === 1) return { type: 'volume', name: null, dst: parts[0], ro: false };
    const [src, dst, mode = ''] = parts;
    const ro = mode.split(',').includes('ro');
    return isBindSrc(src) ? { type: 'bind', src, dst, ro } : { type: 'volume', name: src, dst, ro };
  };
  const parseEnv = (p) => {
    const env = {};
    p.all('env-file').forEach((f) => {
      const file = ctx.hostFile(f);
      if (!file.exists) throw new CommandError(`docker: open ${f}: no such file or directory.`);
      String(file.value).split('\n').filter((l) => l.trim() && !l.startsWith('#')).forEach((l) => { const [k, ...v] = l.split('='); env[k.trim()] = v.join('='); });
    });
    p.all('env').forEach((e) => { const [k, ...v] = e.split('='); if (v.length) env[k] = v.join('='); });
    return env;
  };
  const parseRestart = (value) => {
    const [name, max] = String(value || 'no').split(':');
    if (!RESTARTS.includes(name)) throw new CommandError(`docker: invalid restart policy '${value}' (use no, always, unless-stopped or on-failure[:N])`);
    return { name, max: Number(max) || 0 };
  };

  const parseRunOptions = (args, command) => {
    const p = parseArgs(args, RUN_SPEC, { stopAtPositional: true, command });
    const [image, ...cmd] = p.pos;
    if (!image) throw new CommandError(`"${command}" requires at least 1 argument.\nUsage:  ${command} [OPTIONS] IMAGE [COMMAND] [ARG...]`);
    if (p.has('rm') && p.get('restart') && p.get('restart') !== 'no') throw new CommandError('docker: Conflicting options: --restart and --rm.');
    const health = p.get('health-cmd') && !p.has('no-healthcheck') ? { cmd: p.get('health-cmd'), interval: p.get('health-interval', '30s'), retries: Number(p.get('health-retries', 3)) } : null;
    return {
      p, image, imageRef: image, cmd,
      detach: p.has('detach'), interactive: p.has('interactive'), tty: p.has('tty'), rm: p.has('rm'),
      name: p.get('name'), ports: p.all('publish'), publishAll: p.has('publish-all'),
      env: parseEnv(p), network: p.get('network') || p.get('net'), aliases: p.all('network-alias'),
      hostname: p.get('hostname'), workdir: p.get('workdir'), user: p.get('user'), entrypoint: p.get('entrypoint'),
      labels: Object.fromEntries(p.all('label').map((l) => { const [k, ...v] = l.split('='); return [k, v.join('=')]; })),
      restart: parseRestart(p.get('restart')),
      memory: p.get('memory') ? parseMem(p.get('memory')) : 0, memorySwap: p.get('memory-swap') ? parseMem(p.get('memory-swap')) : 0,
      cpus: Number(p.get('cpus') || 0), pids: Number(p.get('pids-limit') || 0),
      mounts: [...p.all('volume').map(parseVolume), ...p.all('mount').map(parseMount), ...p.all('tmpfs').map((t) => ({ type: 'tmpfs', dst: t.split(':')[0] }))],
      addHost: p.all('add-host'), dns: p.all('dns'), capAdd: p.all('cap-add'), capDrop: p.all('cap-drop'),
      readOnly: p.has('read-only'), privileged: p.has('privileged'), init: p.has('init'), platform: p.get('platform'), pull: p.get('pull', 'missing'),
      health, stopSignal: p.get('stop-signal'),
      extra: { logDriver: p.get('log-driver', 'json-file'), securityOpt: p.all('security-opt'), gpus: p.get('gpus'), shmSize: p.get('shm-size') },
    };
  };
  ctx.parseRunOptions = parseRunOptions;

  const resolveImage = (o) => {
    if (!['always', 'missing', 'never'].includes(o.pull)) throw new CommandError(`docker: invalid pull option: '${o.pull}' (use always, missing or never)`);
    const local = o.pull === 'always' ? null : ctx.findImage(o.image);
    if (local && (!o.platform || local.platform === o.platform)) return local;
    if (o.pull === 'never') throw new CommandError(`docker: Error response from daemon: No such image: ${o.image}`);
    if (o.pull !== 'always') out.print(`Unable to find image '${o.image.includes(':') ? o.image : `${o.image}:latest`}' locally`);
    return ctx.pullImage(o.image, { platform: o.platform });
  };

  const printLogs = (c, lines = c.logs) => lines.forEach((l) => out.print(l.line, l.stream === 'stderr' ? 'bad' : ''));

  // ---------- lifecycle ----------
  CMDS.run = (args) => {
    const o = parseRunOptions(args, 'docker run');
    const img = resolveImage(o);
    const c = ctx.createContainer(o, img);
    const res = ctx.startContainer(c, { interactive: o.interactive && o.tty });
    if (o.detach) {
      out.print(c.id, 'y');
      if (res === 'exited' || res === 'error') out.note(`(${c.name} exited right away with code ${c.exitCode}: ${c.kind === 'shell' && !c.userCmd ? 'a shell needs -it to stay alive — try docker run -dit' : 'its command finished'}. See: docker logs ${c.name})`);
      if (res === 'restarting') out.note(`(${c.name} keeps exiting and the restart policy keeps restarting it — see docker ps)`);
      return;
    }
    switch (res) {
      case 'shell': return ctx.enterShell(c, { mainProcess: true, cmd: c.argv[0] });
      case 'running':
        printLogs(c);
        return out.note(o.interactive && o.tty ? `(${c.name} is running in the foreground — in a real terminal you would see its output here. Use -d to run in the background.)` : `(attached to ${c.name}'s output — in a real terminal this keeps streaming and Ctrl+C stops the container. Tip: add -d to run in the background.)`);
      case 'restarting': printLogs(c); return out.note(`(${c.name} exited with code ${c.exitCode}; the "${c.restart.name}" restart policy keeps restarting it)`);
      default:
        printLogs(c);
        if (c.kind === 'shell' && !c.userCmd && !o.interactive) out.note(`(${c.argv[0]} had no terminal attached, so it exited immediately — add -it for a shell: docker run -it ${o.image} ${c.argv[0]})`);
        if (res === 'error') out.note(`(container exited with code ${c.exitCode}${c.rm ? ' and was removed (--rm)' : `. Read why: docker logs ${c.name}`})`);
    }
  };

  CMDS.create = (args) => {
    const o = parseRunOptions(args, 'docker create');
    const c = ctx.createContainer(o, resolveImage(o));
    out.print(c.id);
  };

  const eachCtr = (keys, fn, command) => {
    if (!keys.length) throw new CommandError(`"docker ${command}" requires at least 1 argument.`);
    const errors = [];
    keys.forEach((k) => {
      try { fn(ctx.mustCtr(k), k); } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        errors.push(err.message);
      }
    });
    if (errors.length) throw new CommandError(errors.join('\n'));
  };

  CMDS.start = (args) => {
    const p = parseArgs(args, flagSpec('attach:a interactive:i', 'detach-keys checkpoint'), { command: 'docker start' });
    eachCtr(p.pos, (c, k) => {
      if (c.status === 'running') return out.print(k);
      if (c.status === 'paused') throw new CommandError(`Error response from daemon: cannot start a paused container, try unpause instead`);
      const res = ctx.startContainer(c, { interactive: p.has('interactive') || (c.stdin && c.tty) });
      if (res === 'shell' && p.has('attach') && p.has('interactive')) return ctx.enterShell(c, { mainProcess: true, cmd: c.argv[0] });
      if (p.has('attach')) return printLogs(c);
      out.print(k);
      if (res === 'exited' || res === 'error') out.note(`(${c.name} started and exited again with code ${c.exitCode} — its command finished${c.kind === 'shell' && !c.tty ? '; a shell needs -it when the container is created' : ''})`);
    }, 'start');
  };

  CMDS.stop = (args) => {
    const p = parseArgs(args, flagSpec('', 'time:t timeout signal:s'), { command: 'docker stop' });
    eachCtr(p.pos, (c, k) => {
      const sig = p.get('signal') || c.stopSignal || 'SIGTERM';
      const stopped = ctx.stopContainer(c, { signal: sig });
      if (stopped) ctx.W.events.add('stop');
      out.print(k);
      if (stopped && c.exitCode === 137 && !c.init) out.note(`(${c.name}'s main process ignored ${sig}, so after ${p.get('time') || p.get('timeout') || 10}s Docker sent SIGKILL — exit code 137. Run with --init, or handle SIGTERM in your app, for a clean stop.)`);
    }, 'stop');
  };

  CMDS.kill = (args) => {
    const p = parseArgs(args, flagSpec('', 'signal:s'), { command: 'docker kill' });
    const sig = String(p.get('signal', 'SIGKILL')).toUpperCase().replace(/^(?!SIG)/, 'SIG');
    eachCtr(p.pos, (c, k) => {
      if (!['running', 'paused', 'restarting'].includes(c.status)) throw new CommandError(`Error response from daemon: cannot kill container: ${k}: container ${short(c.id)} is not running`);
      if (sig === 'SIGHUP' || sig === 'SIGUSR1') { ctx.ev('container', 'kill', c.id, { name: c.name, signal: sig }); ctx.log(c, `signal ${sig} received — reloading configuration`); return out.print(k); }
      ctx.stopContainer(c, { signal: 'SIGKILL' });
      out.print(k);
    }, 'kill');
  };

  CMDS.restart = (args) => {
    const p = parseArgs(args, flagSpec('', 'time:t timeout signal:s'), { command: 'docker restart' });
    eachCtr(p.pos, (c, k) => {
      if (['running', 'paused'].includes(c.status)) ctx.stopContainer(c, { manual: true });
      const res = ctx.startContainer(c);
      ctx.ev('container', 'restart', c.id, { name: c.name });
      out.print(k);
      if (res === 'exited' || res === 'error') out.note(`(${c.name} exited again with code ${c.exitCode})`);
    }, 'restart');
  };

  CMDS.pause = (args) => eachCtr(args, (c, k) => {
    if (c.status === 'paused') throw new CommandError(`Error response from daemon: container ${short(c.id)} is already paused`);
    if (c.status !== 'running') throw new CommandError(`Error response from daemon: container ${short(c.id)} is not running`);
    c.status = 'paused';
    ctx.ev('container', 'pause', c.id, { name: c.name });
    out.print(k);
  }, 'pause');

  CMDS.unpause = (args) => eachCtr(args, (c, k) => {
    if (c.status !== 'paused') throw new CommandError(`Error response from daemon: container ${short(c.id)} is not paused`);
    c.status = 'running';
    ctx.ev('container', 'unpause', c.id, { name: c.name });
    out.print(k);
  }, 'unpause');

  CMDS.rm = (args) => {
    const p = parseArgs(args, flagSpec('force:f volumes:v link:l'), { command: 'docker rm' });
    eachCtr(p.pos, (c, k) => {
      if (['running', 'paused', 'restarting'].includes(c.status) && !p.has('force')) throw new CommandError(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
      if (c.status !== 'exited' && c.status !== 'created') ctx.stopContainer(c, { signal: 'SIGKILL' });
      if (c.task) throw new CommandError(`Error response from daemon: ${c.name} is a swarm task — remove or scale the service instead (docker service rm / scale)`);
      ctx.removeContainer(c, { volumes: p.has('volumes') });
      out.print(k);
    }, 'rm');
  };

  CMDS.rename = (args) => {
    const [from, to] = args;
    if (!from || !to) throw new CommandError('"docker rename" requires exactly 2 arguments.\nUsage:  docker rename CONTAINER NEW_NAME');
    const c = ctx.mustCtr(from);
    if (ctx.findCtr(to)) throw new CommandError(`Error response from daemon: Conflict. The container name "/${to}" is already in use by container "${ctx.findCtr(to).id}".`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(to)) throw new CommandError(`Error response from daemon: Invalid container name (${to}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed`);
    ctx.ev('container', 'rename', c.id, { oldName: `/${c.name}`, name: to });
    c.name = to;
    c.named = true;
  };

  CMDS.update = (args) => {
    const p = parseArgs(args, flagSpec('', 'memory:m memory-swap memory-reservation cpus cpu-shares:c cpuset-cpus pids-limit restart blkio-weight'), { command: 'docker update' });
    if (!p.pos.length) throw new CommandError('"docker update" requires at least 1 argument.');
    if (!['memory', 'memory-swap', 'cpus', 'cpu-shares', 'pids-limit', 'restart', 'memory-reservation', 'cpuset-cpus'].some((f) => p.has(f))) throw new CommandError('You must provide one or more flags when using this command (for example --memory 512m, --cpus 1, --restart always).');
    eachCtr(p.pos, (c, k) => {
      if (p.has('memory')) c.limits.memory = parseMem(p.get('memory'));
      if (p.has('memory-swap')) c.limits.memorySwap = parseMem(p.get('memory-swap'));
      if (p.has('cpus')) c.limits.cpus = Number(p.get('cpus'));
      if (p.has('pids-limit')) c.limits.pids = Number(p.get('pids-limit'));
      if (p.has('restart')) c.restart = parseRestart(p.get('restart'));
      ctx.ev('container', 'update', c.id, { name: c.name });
      out.print(k);
    }, 'update');
  };

  CMDS.wait = (args) => eachCtr(args, (c) => {
    if (c.status === 'exited') return out.print(String(c.exitCode));
    out.note(`(docker wait blocks until ${c.name} stops, then prints its exit code. Stop it — docker stop ${c.name} — and run docker wait ${c.name} again.)`);
  }, 'wait');

  CMDS.attach = (args) => {
    const p = parseArgs(args, flagSpec('no-stdin sig-proxy', 'detach-keys'), { command: 'docker attach' });
    const c = ctx.mustCtr(p.pos[0], 'docker attach');
    if (c.status === 'paused') throw new CommandError('You cannot attach to a paused container, unpause it first');
    if (c.status !== 'running') throw new CommandError('You cannot attach to a stopped container, start it first');
    ctx.ev('container', 'attach', c.id, { name: c.name });
    if (c.stdin && c.tty && (c.kind === 'shell' || /sh$/.test(c.argv[0] || ''))) return ctx.enterShell(c, { mainProcess: true, cmd: c.argv[0] });
    printLogs(c, c.logs.slice(-5));
    out.note(`(attached to the main process of ${c.name}. Ctrl+C here would stop it — press Ctrl+P Ctrl+Q to detach instead, or use docker logs -f to only watch.)`);
  };

  // ---------- listing ----------
  const ctrRow = (c) => ({
    ID: short(c.id), Image: c.image, Command: `"${[...(c.entrypoint || []), ...c.argv].join(' ').slice(0, 20)}${[...(c.entrypoint || []), ...c.argv].join(' ').length > 20 ? '…' : ''}"`,
    CreatedAt: new Date(c.created).toString().slice(0, 24), RunningFor: `${ctx.ago(c.created)} ago`,
    Ports: c.ports.map(ctx.portText).join(', '), State: c.status, Status: ctx.statusText(c), Size: '0B',
    Names: c.name, Labels: Object.entries(c.cfg.labels).map(([k, v]) => `${k}=${v}`).join(','), Mounts: c.mounts.map((m) => m.name || m.src || m.dst).join(','),
    Networks: Object.keys(c.networks).join(','),
  });
  const matchFilter = (c, { key, value }) => {
    switch (key) {
      case 'status': return c.status === value;
      case 'name': return c.name.includes(value.replace(/^\^|\$$/g, ''));
      case 'id': return c.id.startsWith(value);
      case 'ancestor': return c.image === value || c.repo === value || c.image.startsWith(`${value}:`) || c.imageId.startsWith(value);
      case 'label': { const [k, v] = value.split('='); return k in c.cfg.labels && (v == null || c.cfg.labels[k] === v); }
      case 'network': return value in c.networks;
      case 'exited': return c.status === 'exited' && String(c.exitCode) === value;
      case 'volume': return c.mounts.some((m) => m.name === value || m.dst === value);
      case 'publish': case 'expose': return c.ports.some((pp) => pp.host === value || pp.ctr === value.split('/')[0]);
      case 'health': return (c.health ? 'healthy' : 'none') === value;
      default: throw new CommandError(`invalid filter '${key}'`);
    }
  };

  CMDS.ps = (args) => {
    const p = parseArgs(args, flagSpec('all:a quiet:q latest:l size:s no-trunc', 'filter:f format last:n'), { command: 'docker ps' });
    const filters = parseFilters(p.all('filter'));
    let list = ctx.ctrs().filter((c) => p.has('all') || filters.some((f) => f.key === 'status') || ['running', 'paused', 'restarting'].includes(c.status));
    list = list.filter((c) => filters.every((f) => matchFilter(c, f)));
    list = [...list].reverse();
    if (p.has('latest')) list = list.slice(0, 1);
    if (p.get('last')) list = list.slice(0, Number(p.get('last')));
    const rows = list.map(ctrRow);
    if (p.has('no-trunc')) rows.forEach((r, i) => { r.ID = list[i].id; });
    if (p.has('quiet')) return rows.forEach((r) => out.print(r.ID));
    if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
    out.table(['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES', ...(p.has('size') ? ['SIZE'] : [])],
      rows.map((r) => [r.ID, r.Image, r.Command, r.RunningFor, r.Status, r.Ports, r.Names, ...(p.has('size') ? ['1.09kB (virtual 192MB)'] : [])]));
  };

  // ---------- look inside ----------
  CMDS.logs = (args) => {
    const p = parseArgs(args, flagSpec('follow:f timestamps:t details', 'tail:n since until'), { command: 'docker logs' });
    const c = ctx.mustCtr(p.pos[0], 'docker logs');
    let lines = c.logs;
    const since = durationMs(p.get('since'));
    if (since) lines = lines.filter((l) => l.t >= Date.now() - since);
    const tail = p.get('tail');
    if (tail != null && tail !== 'all') lines = lines.slice(-Number(tail) || lines.length);
    if (tail === '0') lines = [];
    lines.forEach((l) => out.print(`${p.has('timestamps') ? `${iso(l.t)} ` : ''}${l.line}`, l.stream === 'stderr' ? 'bad' : ''));
    if (!c.logs.length) out.note(`(no output yet — ${c.name}'s main process has not printed anything${c.flavor === 'nginx' ? '. Send it a request: curl localhost:PORT' : ''})`);
    if (p.has('follow')) out.note(c.status === 'running' ? '(following — in a real terminal new lines keep appearing until you press Ctrl+C)' : '(the container is not running, so -f stops right away)');
    ctx.W.events.add('logs');
  };

  CMDS.exec = (args) => {
    const p = parseArgs(args, flagSpec('interactive:i tty:t detach:d privileged', 'env:e env-file user:u workdir:w detach-keys'), { stopAtPositional: true, command: 'docker exec' });
    const [key, ...cmd] = p.pos;
    const c = ctx.mustCtr(key, 'docker exec');
    if (c.status === 'paused') throw new CommandError(`Error response from daemon: container ${short(c.id)} is paused, unpause the container before exec`);
    if (c.status !== 'running') throw new CommandError(`Error response from daemon: container ${short(c.id)} is not running`);
    if (!cmd.length) throw new CommandError('"docker exec" requires at least 2 arguments.\nUsage:  docker exec [OPTIONS] CONTAINER COMMAND [ARG...]');
    ctx.ev('container', `exec_start: ${cmd.join(' ')}`, c.id, { name: c.name });
    if (/^(\/bin\/|\/usr\/bin\/)?(sh|bash|ash|zsh)$/.test(cmd[0]) && cmd.length === 1) {
      if (p.has('interactive') && p.has('tty')) return ctx.enterShell(c, { cmd: cmd[0] });
      return out.note(`(${cmd[0]} started without a terminal and exited at once — use docker exec -it ${c.name} ${cmd[0]})`);
    }
    if (p.has('detach')) return;
    const env = Object.fromEntries(p.all('env').map((e) => { const [k, ...v] = e.split('='); return [k, v.join('=')]; }));
    ctx.runInContainerLines(c, cmd, { env, user: p.get('user'), workdir: p.get('workdir') }).forEach((l) => out.print(l));
  };

  CMDS.top = (args) => {
    const c = ctx.mustCtr(args[0], 'docker top');
    if (c.status !== 'running' && c.status !== 'paused') throw new CommandError(`Error response from daemon: container ${short(c.id)} is not running`);
    const cmd = [...(c.entrypoint || []).filter((e) => !e.endsWith('.sh')), ...c.argv].join(' ');
    const who = c.cfg.user || 'root';
    const rows = [[who === 'root' ? 'root' : who, '2481', '2460', '0', '10:00', '?', '00:00:00', cmd]];
    if (c.flavor === 'nginx') rows.push(['101', '2533', '2481', '0', '10:00', '?', '00:00:00', 'nginx: worker process'], ['101', '2534', '2481', '0', '10:00', '?', '00:00:00', 'nginx: worker process']);
    if (c.flavor === 'postgres') rows.push(['999', '2540', '2481', '0', '10:00', '?', '00:00:00', 'postgres: checkpointer'], ['999', '2541', '2481', '0', '10:00', '?', '00:00:00', 'postgres: walwriter']);
    out.table(['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'], rows);
  };

  const usage = (c) => {
    const base = { server: 9.8, app: 38.4, shell: 1.2, once: 0.5 }[c.kind] || 4;
    const mem = c.limits.memory ? Math.min(base, c.limits.memory * 0.9) : base;
    return { mem, cpu: Math.min((c.kind === 'app' ? 0.8 : 0.1) + Math.random() * 0.2, c.limits.cpus ? c.limits.cpus * 100 : 800) };
  };
  CMDS.stats = (args) => {
    const p = parseArgs(args, flagSpec('all:a no-stream no-trunc', 'format'), { command: 'docker stats' });
    let list = p.pos.length ? p.pos.map((k) => ctx.mustCtr(k)) : ctx.ctrs().filter((c) => p.has('all') || c.status === 'running');
    list = list.filter(Boolean);
    const HOST_MB = 7840;
    const rows = list.map((c) => {
      const u = c.status === 'running' ? usage(c) : { mem: 0, cpu: 0 };
      const limit = c.limits.memory || HOST_MB;
      return { Container: short(c.id), ID: short(c.id), Name: c.name, CPUPerc: `${u.cpu.toFixed(2)}%`, MemUsage: `${fmtMem(u.mem)} / ${fmtMem(limit)}`, MemPerc: `${((u.mem / limit) * 100).toFixed(2)}%`, NetIO: c.status === 'running' ? '1.2kB / 0B' : '0B / 0B', BlockIO: '0B / 0B', PIDs: c.status === 'running' ? (c.flavor === 'nginx' ? '3' : '1') : '0' };
    });
    if (p.get('format')) formatRows(p.get('format'), rows).forEach((l) => out.print(l));
    else out.table(['CONTAINER ID', 'NAME', 'CPU %', 'MEM USAGE / LIMIT', 'MEM %', 'NET I/O', 'BLOCK I/O', 'PIDS'], rows.map((r) => [r.ID, r.Name, r.CPUPerc, r.MemUsage, r.MemPerc, r.NetIO, r.BlockIO, r.PIDs]));
    if (!p.has('no-stream')) out.note('(a snapshot — the real command redraws every second until Ctrl+C. Add --no-stream to print once.)');
  };

  CMDS.port = (args) => {
    const c = ctx.mustCtr(args[0], 'docker port');
    const want = args[1]?.split('/')[0];
    const list = c.ports.filter((pp) => !want || pp.ctr === want);
    if (want && !list.length) throw new CommandError(`Error: No public port '${args[1]}' published for ${c.name}`);
    list.forEach((pp) => out.print(want ? `${pp.ip}:${pp.host}` : `${pp.ctr}/${pp.proto} -> ${pp.ip}:${pp.host}`));
  };

  CMDS.diff = (args) => {
    const c = ctx.mustCtr(args[0], 'docker diff');
    const rows = ctx.diffOf(c);
    rows.forEach(([path, kind]) => out.html(`<span class="${{ A: 'ok', C: 'y', D: 'bad' }[kind]}">${kind}</span> ${ctx.escape(path)}`));
    if (!rows.length) out.note(`(no changes in ${c.name}'s writable layer yet — try docker exec ${c.name} touch /tmp/hello)`);
  };

  // ---------- copy, snapshot, export ----------
  const splitCtrPath = (s) => {
    const m = /^([a-zA-Z0-9][\w.-]*):(\/.*|\.)$/.exec(s);
    return m ? { ctr: m[1], path: m[2] } : null;
  };
  CMDS.cp = (args) => {
    const p = parseArgs(args, flagSpec('archive:a follow-link:L quiet:q'), { command: 'docker cp' });
    const [src, dst] = p.pos;
    if (!src || !dst) throw new CommandError('"docker cp" requires exactly 2 arguments.\nUsage:  docker cp CONTAINER:SRC_PATH DEST_PATH\n        docker cp SRC_PATH CONTAINER:DEST_PATH');
    const from = splitCtrPath(src), to = splitCtrPath(dst);
    if (from && to) throw new CommandError('copying between containers is not supported — copy to the host first');
    if (!from && !to) throw new CommandError('must specify at least one container source (CONTAINER:PATH)');
    if (from) {
      const c = ctx.mustCtr(from.ctr);
      const fs = ctx.ctrFS(c);
      if (!fs.has(from.path)) throw new CommandError(`Error response from daemon: Could not find the file ${from.path} in container ${from.ctr}`);
      const name = from.path.split('/').pop();
      const target = dst === '.' || dst === './' ? name : dst.replace(/\/$/, dst.endsWith('/') ? `/${name}` : '');
      const files = fs.get(from.path) === null ? [...fs.entries()].filter(([k, v]) => k.startsWith(`${from.path}/`) && v !== null).map(([k, v]) => [`${target}/${k.slice(from.path.length + 1)}`, v]) : [[target, fs.get(from.path)]];
      files.forEach(([k, v]) => ctx.F().set(ctx.hostFile(k).key, v));
      if (!p.has('quiet')) out.print(`Successfully copied ${Math.max(1, files.reduce((n, [, v]) => n + String(v).length, 0) / 1000).toFixed(2)}kB to ${target === name ? `${'/home/you/project'}/${name}` : target}`);
      return;
    }
    const c = ctx.mustCtr(to.ctr);
    const host = ctx.hostFile(src);
    const folder = [...ctx.F().keys()].filter((k) => k.startsWith(`${host.key.replace(/\/$/, '')}/`));
    if (!host.exists && !folder.length) throw new CommandError(`lstat ${src}: no such file or directory`);
    const fs = ctx.ctrFS(c);
    const intoDir = to.path.endsWith('/') || fs.get(to.path) === null;
    const name = host.key.split('/').pop();
    const base = intoDir ? `${to.path.replace(/\/$/, '')}/${name}` : to.path;
    const items = host.exists ? [[base, host.value]] : folder.map((k) => [`${base}/${k.slice(host.key.replace(/\/$/, '').length + 1)}`, ctx.F().get(k)]);
    items.forEach(([path, v]) => ctx.writeFile(c, path, typeof v === 'string' ? v : '<binary>'));
    if (!p.has('quiet')) out.print(`Successfully copied ${Math.max(0.01, items.reduce((n, [, v]) => n + String(v).length, 0) / 1000).toFixed(2)}kB to ${to.ctr}:${to.path}`);
  };

  const applyChange = (cfg, change) => {
    const [, instr, rest] = /^(\w+)\s+(.*)$/.exec(change.trim()) || [];
    const argv = (s) => (s.trim().startsWith('[') ? JSON.parse(s) : ['/bin/sh', '-c', s]);
    switch ((instr || '').toUpperCase()) {
      case 'CMD': cfg.cmd = argv(rest); break;
      case 'ENTRYPOINT': cfg.entrypoint = argv(rest); break;
      case 'ENV': { const [k, ...v] = rest.split(/[= ]/); cfg.env = { ...cfg.env, [k]: v.join('=') }; break; }
      case 'EXPOSE': cfg.expose = [...cfg.expose, `${rest.split('/')[0]}/tcp`]; break;
      case 'WORKDIR': cfg.workdir = rest; break;
      case 'USER': cfg.user = rest; break;
      case 'LABEL': { const [k, ...v] = rest.split('='); cfg.labels = { ...cfg.labels, [k]: v.join('=').replace(/^"|"$/g, '') }; break; }
      default: throw new CommandError(`${instr || change} is not a valid change command (use CMD, ENTRYPOINT, ENV, EXPOSE, WORKDIR, USER or LABEL)`);
    }
  };
  ctx.applyChange = applyChange;

  CMDS.commit = (args) => {
    const p = parseArgs(args, flagSpec('pause:p', 'author:a message:m change:c'), { command: 'docker commit' });
    const [key, ref] = p.pos;
    const c = ctx.mustCtr(key, 'docker commit');
    const parent = ctx.imageById(c.imageId);
    const files = { ...c.base };
    c.fs.forEach((ch, path) => { if (ch.kind === 'D') delete files[path]; else files[path] = ch.content; });
    const cfg = { ...ctx.structuredCopy(c.cfg), cmd: c.argv, entrypoint: c.entrypoint };
    p.all('change').forEach((ch) => applyChange(cfg, ch));
    const [repo, tag] = ref ? ref.split(':').length > 1 && !ref.endsWith(':') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [ref, 'latest'] : ['<none>', '<none>'];
    const changeKb = [...c.fs.values()].reduce((n, ch) => n + String(ch.content || '').length, 0) / 1000;
    const img = ctx.makeImage({
      repo, tag, mb: (parent?.mb || 10) + changeKb / 1000, files, cfg, committed: true, kind: c.kind, base: c.image,
      layers: [...(parent?.layers || []), { id: hex(64), by: p.get('message') || `commit of ${c.name}`, mb: changeKb / 1000, comment: p.get('message') || '' }],
      author: p.get('author') || '', comment: p.get('message') || '',
    });
    ctx.addImage(img);
    ctx.ev('container', 'commit', c.id, { name: c.name, imageName: ref || '' });
    out.print(`sha256:${img.id}`);
  };

  const writeTar = (io, file, payload, what) => {
    const target = file || (io.redirect && io.redirect.file);
    if (!target) throw new CommandError(`cowardly refusing to save to a terminal. Use the -o flag or redirect: docker ${what} … -o file.tar`);
    ctx.F().set(ctx.hostFile(target).key, payload);
    io.consumed = true;
  };
  ctx.writeTar = writeTar;

  CMDS.export = (args, io) => {
    const p = parseArgs(args, flagSpec('', 'output:o'), { command: 'docker export' });
    const c = ctx.mustCtr(p.pos[0], 'docker export');
    const files = Object.fromEntries([...ctx.ctrFS(c).entries()].filter(([path]) => !c.mounts.some((m) => path.startsWith(`${m.dst}/`))));
    writeTar(io, p.get('output'), { tar: 'fs', files, mb: Math.max(1, ctx.imageById(c.imageId)?.mb || 5), from: c.name }, 'export');
    ctx.ev('container', 'export', c.id, { name: c.name });
  };

  // ---------- inspect ----------
  const inspectContainer = (c) => ({
    Id: c.id, Created: new Date(c.created).toISOString(), Path: (c.entrypoint || c.argv)[0] || '', Args: [...(c.entrypoint ? c.entrypoint.slice(1) : []), ...(c.entrypoint ? c.argv : c.argv.slice(1))],
    State: { Status: c.status, Running: c.status === 'running', Paused: c.status === 'paused', Restarting: c.status === 'restarting', OOMKilled: false, Dead: false, Pid: c.status === 'running' ? 2481 : 0, ExitCode: c.exitCode, StartedAt: c.started ? new Date(c.started).toISOString() : '0001-01-01T00:00:00Z', FinishedAt: c.finished ? new Date(c.finished).toISOString() : '0001-01-01T00:00:00Z', ...(c.health ? { Health: { Status: 'healthy', FailingStreak: 0 } } : {}) },
    Image: `sha256:${c.imageId}`, Name: `/${c.name}`, RestartCount: c.restartCount, Platform: 'linux',
    HostConfig: {
      Binds: c.mounts.filter((m) => m.type !== 'tmpfs').map((m) => `${m.name || m.src}:${m.dst}${m.ro ? ':ro' : ''}`), NetworkMode: Object.keys(c.networks)[0] || 'host',
      PortBindings: Object.fromEntries(c.ports.map((pp) => [`${pp.ctr}/${pp.proto}`, [{ HostIp: '', HostPort: pp.host }]])),
      RestartPolicy: { Name: c.restart.name, MaximumRetryCount: c.restart.max }, AutoRemove: c.rm, Privileged: c.privileged, ReadonlyRootfs: c.readOnly,
      CapAdd: c.capAdd, CapDrop: c.capDrop, Memory: Math.round(c.limits.memory * 1048576), MemorySwap: Math.round(c.limits.memorySwap * 1048576), NanoCpus: Math.round(c.limits.cpus * 1e9), PidsLimit: c.limits.pids || null, ExtraHosts: c.extraHosts, Dns: c.dns, LogConfig: { Type: c.opts.logDriver || 'json-file' },
    },
    Mounts: c.mounts.map((m) => ({ Type: m.type, Name: m.name || undefined, Source: m.type === 'volume' ? `/var/lib/docker/volumes/${m.name}/_data` : m.type === 'bind' ? ctx.hostPath(m.src) : '', Destination: m.dst, RW: !m.ro })),
    Config: { Hostname: c.cfg.hostname || short(c.id), User: c.cfg.user, Tty: c.tty, OpenStdin: c.stdin, Env: Object.entries(c.cfg.env).map(([k, v]) => `${k}=${v}`), Cmd: c.argv, Image: c.image, WorkingDir: c.cfg.workdir === '/' ? '' : c.cfg.workdir, Entrypoint: c.entrypoint, Labels: c.cfg.labels, ExposedPorts: Object.fromEntries((c.cfg.expose || []).map((e) => [e, {}])), StopSignal: c.stopSignal, ...(c.health ? { Healthcheck: { Test: ['CMD-SHELL', c.health.cmd] } } : {}) },
    NetworkSettings: {
      IPAddress: c.networks.bridge?.ip || '', Ports: Object.fromEntries(c.ports.map((pp) => [`${pp.ctr}/${pp.proto}`, [{ HostIp: pp.ip, HostPort: pp.host }]])),
      Networks: Object.fromEntries(Object.entries(c.networks).map(([n, v]) => [n, { Aliases: v.aliases.length ? v.aliases : null, NetworkID: v.id, IPAddress: v.ip, Gateway: v.ip.replace(/\.\d+$/, '.1'), IPPrefixLen: 16, MacAddress: v.mac, DNSNames: n === 'bridge' ? null : [c.name, ...v.aliases] }])),
    },
  });
  const inspectImage = (img) => ({
    Id: `sha256:${img.id}`, RepoTags: ctx.tagRows(img).filter((i) => i.repo !== '<none>').map((i) => refOf(i.repo, i.tag)), RepoDigests: img.digest ? [`${img.repo}@${img.digest}`] : [],
    Created: new Date(img.created).toISOString(), Author: img.author || '', Comment: img.comment || '', Architecture: (img.platform || 'linux/amd64').split('/')[1], Os: 'linux', Size: Math.round(img.mb * 1e6),
    Config: { Env: Object.entries(img.cfg.env).map(([k, v]) => `${k}=${v}`), Cmd: img.cfg.cmd, Entrypoint: img.cfg.entrypoint, WorkingDir: img.cfg.workdir === '/' ? '' : img.cfg.workdir, User: img.cfg.user, ExposedPorts: Object.fromEntries((img.cfg.expose || []).map((e) => [e, {}])), Labels: img.cfg.labels, StopSignal: img.cfg.stopSignal },
    RootFS: { Type: 'layers', Layers: img.layers.filter((l) => l.mb > 0).map((l) => `sha256:${l.id}`) },
  });
  const inspectNetwork = (n) => ({
    Name: n.name, Id: n.id, Created: new Date(n.created).toISOString(), Scope: n.scope, Driver: n.driver, EnableIPv6: false,
    IPAM: { Driver: 'default', Config: n.subnet ? [{ Subnet: n.subnet, Gateway: n.gateway }] : [] }, Internal: !!n.internal, Attachable: !!n.attachable,
    Containers: Object.fromEntries(ctx.ctrs().filter((c) => c.networks[n.name]).map((c) => [c.id, { Name: c.name, MacAddress: c.networks[n.name].mac, IPv4Address: `${c.networks[n.name].ip}/${n.subnet?.split('/')[1] || 16}` }])),
    Labels: n.labels || {},
  });
  const inspectVolume = (v) => ({ CreatedAt: new Date(v.created).toISOString(), Driver: v.driver || 'local', Labels: v.labels || null, Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Name: v.name, Options: null, Scope: 'local' });
  Object.assign(ctx, { inspectContainer, inspectImage, inspectNetwork, inspectVolume });

  const printInspect = (objs, format) => {
    if (format) return objs.forEach((o) => out.print(renderTemplate(format, o)));
    out.print(JSON.stringify(objs, null, 4));
  };
  ctx.printInspect = printInspect;

  CMDS.inspect = (args) => {
    const p = parseArgs(args, flagSpec('size:s', 'format:f type'), { command: 'docker inspect' });
    if (!p.pos.length) throw new CommandError('"docker inspect" requires at least 1 argument.');
    const type = p.get('type');
    const objs = p.pos.map((key) => {
      const c = (!type || type === 'container') && ctx.findCtr(key);
      if (c) return inspectContainer(c);
      const img = (!type || type === 'image') && ctx.findImage(key);
      if (img) return inspectImage(img);
      const n = (!type || type === 'network') && ctx.networkByName(key);
      if (n) return inspectNetwork(n);
      const v = (!type || type === 'volume') && ctx.D().volumes.find((x) => x.name === key);
      if (v) return inspectVolume(v);
      throw new CommandError(`Error: No such object: ${key}`);
    });
    printInspect(objs, p.get('format'));
  };

  // ---------- management command: docker container … ----------
  const CONTAINER_SUBS = ['attach', 'commit', 'cp', 'create', 'diff', 'exec', 'export', 'kill', 'logs', 'pause', 'port', 'rename', 'restart', 'rm', 'run', 'start', 'stats', 'stop', 'top', 'unpause', 'update', 'wait'];
  CMDS.container = ([sub, ...rest], io) => {
    if (sub === 'ls' || sub === 'list' || sub === 'ps') return CMDS.ps(rest);
    if (sub === 'inspect') return CMDS.inspect([...rest, '--type', 'container']);
    if (sub === 'prune') {
      const p = parseArgs(rest, flagSpec('force:f', 'filter'), { command: 'docker container prune' });
      if (!p.has('force')) out.warn('WARNING! This will remove all stopped containers.\nAre you sure you want to continue? [y/N] y   (auto-answered — add -f to skip this prompt)');
      const gone = ctx.ctrs().filter((c) => c.status === 'exited' || c.status === 'created');
      gone.forEach((c) => ctx.removeContainer(c));
      if (gone.length) out.print(`Deleted Containers:\n${gone.map((c) => c.id).join('\n')}\n`);
      ctx.W.events.add('prune');
      return out.print(`Total reclaimed space: ${gone.length ? `${(gone.length * 1.09).toFixed(2)}kB` : '0B'}`);
    }
    if (CONTAINER_SUBS.includes(sub)) return CMDS[sub](rest, io);
    throw new CommandError(`Usage:  docker container COMMAND\n\nCommands: ls, ${CONTAINER_SUBS.join(', ')}, inspect, prune`);
  };
};
