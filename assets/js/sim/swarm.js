// Swarm mode: swarm, node, service, stack, secret and config. Every task is a real container
// on the daemon of the node it is scheduled on, so `ssh worker-1 docker ps` shows it.
import { CommandError, hex, short, flagSpec, parseArgs, formatRows, parseYaml, splitRef, cleanRepo, refOf } from './util.js';
import { hubInfo } from './data.js';

const SERVICE_SPEC = flagSpec('detach:d quiet:q with-registry-auth no-resolve-image read-only force rollback',
  'name replicas mode publish:p env:e secret config network constraint update-parallelism update-delay update-failure-action update-order rollback-parallelism limit-cpu limit-memory reserve-cpu reserve-memory restart-condition restart-max-attempts health-cmd mount label:l hostname replicas-max-per-node user:u workdir:w entrypoint image env-add env-rm publish-add publish-rm secret-add secret-rm constraint-add constraint-rm label-add args');
const BAR = '[==================================================>]';

export const installSwarm = (ctx) => {
  const { CMDS, out } = ctx;
  const W = () => ctx.W;
  const clusters = () => (W().clusters ||= []);
  const here = () => ctx.frame.daemon;
  const cluster = () => ctx.D().swarm;
  const selfNode = () => cluster()?.nodes.find((n) => n.host === here());

  const requireSwarm = () => {
    if (!cluster()) throw new CommandError('Error response from daemon: This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.');
    return cluster();
  };
  const requireManager = () => {
    const cl = requireSwarm();
    if (selfNode()?.role !== 'manager') throw new CommandError('Error response from daemon: This node is not a swarm manager. Worker nodes can\'t be used to view or modify cluster state. Please run this command on a manager node or promote the current node to a manager.');
    return cl;
  };
  const findNode = (cl, key) => {
    const n = key === 'self' ? selfNode() : cl.nodes.find((x) => x.hostname === key || x.id.startsWith(key));
    if (!n) throw new CommandError(`Error response from daemon: node ${key} not found`);
    return n;
  };
  const findService = (cl, key) => {
    const s = cl.services.find((x) => x.name === key || x.id.startsWith(key));
    if (!s) throw new CommandError(`Error response from daemon: service ${key} not found`);
    return s;
  };

  // ---------- scheduling ----------
  const eligible = (cl, svc) => cl.nodes.filter((n) => n.status === 'Ready' && n.availability === 'active' && matches(n, svc.constraint));
  const matches = (n, constraint) => {
    if (!constraint) return true;
    const m = /^\s*([\w.]+)\s*(==|!=)\s*(\S+)\s*$/.exec(constraint);
    if (!m) return true;
    const [, key, op, val] = m;
    const actual = key === 'node.role' ? n.role : key === 'node.hostname' ? n.hostname : key.startsWith('node.labels.') ? n.labels[key.slice(12)] : null;
    return op === '==' ? actual === val : actual !== val;
  };
  const running = (svc) => svc.tasks.filter((t) => t.desired === 'Running' && t.state === 'Running');

  const startTask = (cl, svc, slot, node) => {
    const task = { id: hex(25), slot, node: node?.hostname || '', host: node?.host, image: svc.image, desired: 'Running', state: 'Pending', since: Date.now(), err: '', version: svc.version };
    svc.tasks.push(task);
    if (!node) { task.err = `no suitable node (${cl.nodes.length} node${cl.nodes.length > 1 ? 's' : ''} not available for new tasks${svc.constraint ? `; scheduling constraints not satisfied (${svc.constraint})` : ''})`; return task; }
    ctx.withFrame({ daemon: node.host, client: node.host }, () => {
      const [repo, tag] = splitRef(svc.image);
      let img = ctx.findImage(refOf(cleanRepo(repo), tag));
      if (!img) {
        try { img = ctx.pullImage(svc.image, { quiet: true }); } catch {
          task.state = 'Rejected';
          task.err = `"No such image: ${svc.image}"`;
          return;
        }
      }
      svc.networks.forEach((net) => {
        if (!ctx.networkByName(net)) ctx.D().networks.push({ ...cl.networks.find((n) => n.name === net), builtin: false });
      });
      const args = ['--name', `${svc.name}.${slot}.${task.id}`, '--label', `com.docker.swarm.service.name=${svc.name}`, ...(svc.networks[0] ? ['--network', svc.networks[0], '--network-alias', svc.shortName || svc.name] : []), ...Object.entries(svc.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...(svc.limitMemory ? ['--memory', svc.limitMemory] : []), refOf(img.repo, img.tag), ...svc.args];
      const o = ctx.parseRunOptions(args, 'docker service');
      o.task = { service: svc.name, slot };
      o.secrets = svc.secrets;
      const c = ctx.createContainer(o, img);
      ctx.startContainer(c);
      task.ctrName = c.name;
      task.state = c.status === 'running' ? 'Running' : 'Failed';
      if (task.state === 'Failed') task.err = `"task: non-zero exit (${c.exitCode})"`;
    });
    return task;
  };
  const stopTask = (task) => {
    task.desired = 'Shutdown';
    if (task.state === 'Running' || task.state === 'Pending') task.state = 'Shutdown';
    task.since = Date.now();
    if (!task.ctrName || !task.host) return;
    ctx.withFrame({ daemon: task.host, client: task.host }, () => {
      const c = ctx.findCtr(task.ctrName);
      if (c) { ctx.stopContainer(c); c.task = null; ctx.removeContainer(c); }
    });
  };
  // Brings a service to its desired replica count, spreading tasks over the least-busy nodes.
  const converge = (cl, svc) => {
    svc.tasks.filter((t) => t.desired === 'Running' && t.state === 'Pending').forEach((t) => { t.desired = 'Shutdown'; t.state = 'Shutdown'; });
    const load = (n) => cl.services.reduce((k, s) => k + running(s).filter((t) => t.node === n.hostname).length, 0);
    if (svc.mode === 'global') {
      const nodes = eligible(cl, svc);
      running(svc).filter((t) => !nodes.some((n) => n.hostname === t.node)).forEach(stopTask);
      nodes.filter((n) => !running(svc).some((t) => t.node === n.hostname)).forEach((n) => startTask(cl, svc, n.id.slice(0, 6), n));
    } else {
      const live = running(svc).sort((a, b) => a.slot - b.slot);
      live.filter((t) => t.slot > svc.replicas).forEach(stopTask);
      for (let slot = 1; slot <= svc.replicas; slot++) {
        if (running(svc).some((t) => t.slot === slot)) continue;
        const nodes = eligible(cl, svc).sort((a, b) => load(a) - load(b));
        startTask(cl, svc, slot, nodes[0]);
      }
    }
    trimHistory(svc);
  };
  const trimHistory = (svc) => {
    const bySlot = new Map();
    svc.tasks.forEach((t) => { if (!bySlot.has(t.slot)) bySlot.set(t.slot, []); bySlot.get(t.slot).push(t); });
    svc.tasks = [...bySlot.values()].flatMap((list) => list.slice(-5));
  };
  const progress = (svc, verb = '') => {
    const n = svc.mode === 'global' ? running(svc).length : svc.replicas;
    out.print(`overall progress: ${verb}${running(svc).length} out of ${n} tasks`);
    running(svc).sort((a, b) => a.slot - b.slot).forEach((t, i) => out.print(`${svc.mode === 'global' ? t.node : `${i + 1}/${n}`}: running   ${BAR}`));
    const pending = svc.tasks.filter((t) => t.desired === 'Running' && t.state !== 'Running');
    if (pending.length) return out.warn(`${pending.length} task(s) not running: ${pending[0].err || pending[0].state}`);
    out.print(`verify: Service ${svc.name} converged`);
  };
  const reschedule = (cl) => cl.services.forEach((s) => {
    s.tasks.filter((t) => t.desired === 'Running' && t.state === 'Running' && !eligible(cl, s).some((n) => n.hostname === t.node)).forEach(stopTask);
    converge(cl, s);
  });

  // ---------- swarm ----------
  const tokens = () => ({ worker: `SWMTKN-1-${hex(50)}-${hex(25)}`, manager: `SWMTKN-1-${hex(50)}-${hex(25)}` });
  const addr = (cl) => `${ctx.M(cl.leader).ip}:2377`;
  const joinCmd = (cl, role) => `docker swarm join --token ${cl.tokens[role]} ${addr(cl)}`;
  const addNode = (cl, role) => {
    const d = ctx.D();
    const n = { id: d.nodeId, host: here(), hostname: here(), role, availability: 'active', status: 'Ready', labels: {}, engine: '27.3.1' };
    cl.nodes = cl.nodes.filter((x) => x.host !== here());
    cl.nodes.push(n);
    d.swarm = cl;
    if (!d.networks.some((x) => x.name === 'ingress')) d.networks.push({ name: 'ingress', driver: 'overlay', id: hex(64), scope: 'swarm', subnet: '10.0.0.0/24', gateway: '10.0.0.1', builtin: true, created: Date.now() });
    if (!d.networks.some((x) => x.name === 'docker_gwbridge')) d.networks.push({ name: 'docker_gwbridge', driver: 'bridge', id: hex(64), scope: 'local', subnet: '172.30.0.0/16', gateway: '172.30.0.1', builtin: true, created: Date.now() });
    return n;
  };

  CMDS.swarm = ([sub, ...rest]) => {
    switch (sub) {
      case 'init': {
        const p = parseArgs(rest, flagSpec('force-new-cluster autolock', 'advertise-addr listen-addr default-addr-pool'), { command: 'docker swarm init' });
        if (cluster()) throw new CommandError('Error response from daemon: This node is already part of a swarm. Use "docker swarm leave" to leave this swarm and join another one.');
        const cl = { id: hex(25), leader: here(), tokens: tokens(), nodes: [], services: [], secrets: [], configs: [], networks: [], created: Date.now() };
        clusters().push(cl);
        const n = addNode(cl, 'manager');
        n.leader = true;
        void p;
        out.print(`Swarm initialized: current node (${n.id}) is now a manager.\n\nTo add a worker to this swarm, run the following command:\n\n    ${joinCmd(cl, 'worker')}\n\nTo add a manager to this swarm, run 'docker swarm join-token manager' and follow the instructions.`);
        return out.note(`(playground: other machines exist too — join one with: ssh worker-1 ${joinCmd(cl, 'worker').slice(0, 30)}…  Easiest: copy the full line above and put "ssh worker-1 " in front of it.)`);
      }
      case 'join': {
        const p = parseArgs(rest, flagSpec('', 'token advertise-addr listen-addr availability'), { command: 'docker swarm join' });
        if (cluster()) throw new CommandError('Error response from daemon: This node is already part of a swarm. Use "docker swarm leave" to leave this swarm and join another one.');
        const token = p.get('token');
        if (!token) throw new CommandError('"docker swarm join" requires --token TOKEN and the manager address.\n(get it on the manager with: docker swarm join-token worker)');
        const cl = clusters().find((c) => c.tokens.worker === token || c.tokens.manager === token);
        if (!cl) throw new CommandError('Error response from daemon: rpc error: code = InvalidArgument desc = A valid join token is necessary to join this cluster');
        const role = cl.tokens.manager === token ? 'manager' : 'worker';
        addNode(cl, role).availability = p.get('availability', 'active');
        cl.services.forEach((s) => converge(cl, s));
        return out.print(`This node joined a swarm as a ${role}.`);
      }
      case 'join-token': {
        const p = parseArgs(rest, flagSpec('quiet:q rotate'), { command: 'docker swarm join-token' });
        const cl = requireManager();
        const role = p.pos[0];
        if (!['worker', 'manager'].includes(role)) throw new CommandError('"docker swarm join-token" requires exactly 1 argument: worker or manager');
        if (p.has('rotate')) { cl.tokens[role] = tokens()[role]; out.print(`Successfully rotated ${role} join token.\n`); }
        if (p.has('quiet')) return out.print(cl.tokens[role]);
        return out.print(`To add a ${role} to this swarm, run the following command:\n\n    ${joinCmd(cl, role)}\n`);
      }
      case 'leave': {
        const p = parseArgs(rest, flagSpec('force:f'), { command: 'docker swarm leave' });
        const cl = requireSwarm();
        const me = selfNode();
        const managers = cl.nodes.filter((n) => n.role === 'manager' && n.status === 'Ready');
        if (me.role === 'manager' && !p.has('force')) throw new CommandError(`Error response from daemon: You are attempting to leave the swarm on a node that is participating as a manager. ${managers.length === 1 ? 'Removing the last manager erases all current state of the swarm.' : 'Demote it first (docker node demote).'} Use \`--force\` to ignore this message.`);
        ctx.ctrs().filter((c) => c.task).forEach((c) => { ctx.stopContainer(c); c.task = null; ctx.removeContainer(c); });
        ctx.D().swarm = null;
        ctx.D().networks = ctx.D().networks.filter((n) => n.scope !== 'swarm' && n.name !== 'docker_gwbridge');
        if (me.role === 'manager' && managers.length === 1) {
          cl.nodes.forEach((n) => { if (n.host !== here()) { const d = ctx.daemonOf(n.host); d.containers.filter((c) => c.task).forEach((c) => d.containers.splice(d.containers.indexOf(c), 1)); d.swarm = null; } });
          clusters().splice(clusters().indexOf(cl), 1);
          return out.print('Node left the swarm.\n(it was the last manager, so the whole swarm and its services are gone)');
        }
        me.status = 'Down';
        cl.services.forEach((s) => s.tasks.filter((t) => t.node === me.hostname && t.desired === 'Running').forEach((t) => { t.desired = 'Shutdown'; t.state = 'Shutdown'; }));
        reschedule(cl);
        return out.print('Node left the swarm.');
      }
      case 'update': case 'unlock': case 'unlock-key': case 'ca':
        requireManager();
        return out.note(`(docker swarm ${sub} is not simulated — it changes cluster security settings)`);
      default: throw new CommandError('Usage:  docker swarm COMMAND\n\nCommands: ca, init, join, join-token, leave, unlock, unlock-key, update');
    }
  };

  // ---------- node ----------
  const nodeRow = (cl, n) => ({ ID: `${n.id}${n.host === here() ? ' *' : ''}`, Hostname: n.hostname, Status: n.status, Availability: n.availability.replace(/^./, (c) => c.toUpperCase()), ManagerStatus: n.role === 'manager' ? (n.leader ? 'Leader' : 'Reachable') : '', EngineVersion: n.engine });
  CMDS.node = ([sub, ...rest]) => {
    const cl = requireManager();
    switch (sub) {
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q', 'filter:f format'), { command: 'docker node ls' });
        const rows = cl.nodes.map((n) => nodeRow(cl, n));
        if (p.has('quiet')) return cl.nodes.forEach((n) => out.print(n.id));
        if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
        return out.table(['ID', 'HOSTNAME', 'STATUS', 'AVAILABILITY', 'MANAGER STATUS', 'ENGINE VERSION'], rows.map((r) => [r.ID, r.Hostname, r.Status, r.Availability, r.ManagerStatus, r.EngineVersion]));
      }
      case 'inspect': {
        const p = parseArgs(rest, flagSpec('pretty'), { command: 'docker node inspect' });
        const nodes = (p.pos.length ? p.pos : ['self']).map((k) => findNode(cl, k));
        if (p.has('pretty')) return nodes.forEach((n) => out.print(`ID:\t\t\t${n.id}\nHostname:\t\t${n.hostname}\nJoined at:\t\t${new Date(cl.created).toISOString()}\nStatus:\n State:\t\t\t${n.status}\n Availability:\t\t${n.availability}\n Address:\t\t${ctx.M(n.host).ip}\n${n.role === 'manager' ? `Manager Status:\n Address:\t\t${ctx.M(n.host).ip}:2377\n Raft Status:\t\tReachable\n Leader:\t\t${n.leader ? 'Yes' : 'No'}\n` : ''}Platform:\n Operating System:\tlinux\n Architecture:\t\tx86_64\nResources:\n CPUs:\t\t\t4\n Memory:\t\t7.6GiB\nEngine Version:\t\t${n.engine}${Object.keys(n.labels).length ? `\nEngine Labels:\n${Object.entries(n.labels).map(([k, v]) => ` - ${k}=${v}`).join('\n')}` : ''}`));
        return out.print(JSON.stringify(nodes.map((n) => ({ ID: n.id, Spec: { Labels: n.labels, Role: n.role, Availability: n.availability }, Description: { Hostname: n.hostname, Platform: { Architecture: 'x86_64', OS: 'linux' } }, Status: { State: n.status.toLowerCase(), Addr: ctx.M(n.host).ip }, ManagerStatus: n.role === 'manager' ? { Leader: !!n.leader, Reachability: 'reachable', Addr: `${ctx.M(n.host).ip}:2377` } : undefined })), null, 4));
      }
      case 'update': {
        const p = parseArgs(rest, flagSpec('', 'availability role label-add label-rm'), { command: 'docker node update' });
        const n = findNode(cl, p.pos[0] || '');
        if (p.get('availability')) {
          if (!['active', 'pause', 'drain'].includes(p.get('availability'))) throw new CommandError(`invalid argument "${p.get('availability')}" for "--availability" flag: invalid availability (use active, pause or drain)`);
          n.availability = p.get('availability');
        }
        if (p.get('role')) n.role = p.get('role');
        p.all('label-add').forEach((l) => { const [k, v = ''] = l.split('='); n.labels[k] = v; });
        p.all('label-rm').forEach((l) => delete n.labels[l]);
        if (n.availability === 'drain') reschedule(cl);
        out.print(p.pos[0]);
        if (p.get('availability') === 'drain') out.note(`(${n.hostname} is drained: its tasks were moved to other nodes and it gets no new ones)`);
        if (p.get('availability') === 'active') out.note('(the node takes new tasks again — Swarm does not move existing tasks back on its own; use docker service update --force SERVICE to rebalance)');
        return;
      }
      case 'promote': case 'demote': {
        rest.forEach((k) => {
          const n = findNode(cl, k);
          if (sub === 'demote' && cl.nodes.filter((x) => x.role === 'manager').length === 1) throw new CommandError('Error response from daemon: rpc error: code = FailedPrecondition desc = attempting to demote the last manager of the swarm');
          n.role = sub === 'promote' ? 'manager' : 'worker';
          if (sub === 'demote') n.leader = false;
          out.print(`Node ${k} ${sub === 'promote' ? 'promoted to a manager' : 'demoted'} in the swarm.`);
        });
        return;
      }
      case 'rm': case 'remove': {
        const p = parseArgs(rest, flagSpec('force:f'), { command: 'docker node rm' });
        p.pos.forEach((k) => {
          const n = findNode(cl, k);
          if (n.host === here()) throw new CommandError('Error response from daemon: rpc error: code = FailedPrecondition desc = node is the current node — use docker swarm leave');
          if (n.status !== 'Down' && !p.has('force')) throw new CommandError(`Error response from daemon: rpc error: code = FailedPrecondition desc = node ${n.id} is not down and can't be removed\n(drain it first, or run docker swarm leave on that node)`);
          cl.nodes.splice(cl.nodes.indexOf(n), 1);
          ctx.daemonOf(n.host).swarm = null;
          reschedule(cl);
          out.print(k);
        });
        return;
      }
      case 'ps': {
        const n = findNode(cl, rest.find((r) => !r.startsWith('-')) || 'self');
        return taskTable(cl.services.flatMap((s) => s.tasks.filter((t) => t.node === n.hostname).map((t) => ({ s, t }))));
      }
      default: throw new CommandError('Usage:  docker node COMMAND\n\nCommands: demote, inspect, ls, promote, ps, rm, update');
    }
  };

  // ---------- service ----------
  const taskTable = (pairs) => {
    const bySlot = new Map();
    pairs.forEach(({ s, t }) => { const k = `${s.name}.${t.slot}`; if (!bySlot.has(k)) bySlot.set(k, []); bySlot.get(k).push({ s, t }); });
    const rows = [];
    [...bySlot.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).forEach(([name, list]) => {
      [...list].reverse().forEach(({ t }, i) => rows.push([short(t.id), `${i === 0 ? '' : ' \\_ '}${name}`, t.image, t.node, t.desired, `${t.state} ${ctx.ago(t.since)} ago`, t.err, '']));
    });
    out.table(['ID', 'NAME', 'IMAGE', 'NODE', 'DESIRED STATE', 'CURRENT STATE', 'ERROR', 'PORTS'], rows);
  };
  const resolveServiceImage = (ref) => {
    const [repo, tag] = splitRef(ref);
    const clean = cleanRepo(repo);
    const known = hubInfo(clean) || W().registry.get(ctx.registryKey(clean, tag));
    if (!known) out.warn(`image ${ref} could not be accessed on a registry to record\nits digest. Each node will access ${ref} independently,\npossibly leading to different nodes running different\nversions of the image.`);
    return refOf(clean, tag);
  };
  const ensureClusterNetwork = (cl, name) => {
    if (cl.networks.some((n) => n.name === name)) return;
    const local = ctx.networkByName(name);
    if (local && local.driver !== 'overlay') throw new CommandError(`Error response from daemon: network ${name} is not an overlay network — create one with: docker network create -d overlay ${name}`);
    if (!local) throw new CommandError(`Error response from daemon: network ${name} not found`);
    cl.networks.push(local);
  };
  const createService = (cl, o) => {
    if (cl.services.some((s) => s.name === o.name)) throw new CommandError(`Error response from daemon: rpc error: code = AlreadyExists desc = name conflicts with an existing object: service ${o.name} already exists`);
    o.secrets.forEach((sname) => { if (!cl.secrets.some((x) => x.name === sname)) throw new CommandError(`Error response from daemon: secret not found: ${sname}\n(create it first: echo "s3cret" | docker secret create ${sname} -)`); });
    o.networks.forEach((n) => ensureClusterNetwork(cl, n));
    (o.ports || []).forEach((pp) => {
      const owner = cl.services.find((x) => x.ports.some((q) => q.split(':')[0] === pp.split(':')[0]));
      if (owner) throw new CommandError(`Error response from daemon: rpc error: code = InvalidArgument desc = port '${pp.split(':')[0]}' is already in use by service '${owner.name}' (${owner.id}) as an ingress port`);
    });
    const svc = { id: hex(25), mode: 'replicated', replicas: 1, env: {}, args: [], ports: [], secrets: [], networks: [], constraint: null, created: Date.now(), version: 1, tasks: [], updateParallelism: 1, ...o };
    cl.services.push(svc);
    converge(cl, svc);
    return svc;
  };
  const parseServiceArgs = (p) => ({
    replicas: p.get('replicas') != null ? Number(p.get('replicas')) : undefined,
    mode: p.get('mode') || undefined,
    env: Object.fromEntries(p.all('env').map((e) => { const [k, ...v] = e.split('='); return [k, v.join('=')]; })),
    ports: p.all('publish').map((pp) => (/published=/.test(pp) ? `${/published=(\d+)/.exec(pp)[1]}:${/target=(\d+)/.exec(pp)?.[1] || 80}` : pp)),
    secrets: p.all('secret').map((s) => s.split(',')[0].replace(/^source=/, '')),
    networks: p.all('network'),
    constraint: p.get('constraint'),
    limitMemory: p.get('limit-memory'),
    updateParallelism: Number(p.get('update-parallelism') || 1),
  });

  const rolling = (cl, svc, label = 'updating') => {
    const old = running(svc);
    old.forEach(stopTask);
    converge(cl, svc);
    out.print(svc.name);
    progress(svc, label === 'rollback' ? 'rolling back update: ' : '');
  };

  CMDS.service = ([sub, ...rest]) => {
    const cl = requireManager();
    switch (sub) {
      case 'create': {
        const p = parseArgs(rest, SERVICE_SPEC, { stopAtPositional: true, command: 'docker service create' });
        const [image, ...args] = p.pos;
        if (!image) throw new CommandError('"docker service create" requires at least 1 argument.\nUsage:  docker service create [OPTIONS] IMAGE [COMMAND] [ARG...]');
        const o = parseServiceArgs(p);
        const name = p.get('name') || `${['vibrant', 'zealous', 'happy', 'eager'][cl.services.length % 4]}_${['hopper', 'curie', 'bose', 'raman'][cl.services.length % 4]}`;
        const svc = createService(cl, { ...o, name, mode: o.mode || 'replicated', replicas: o.mode === 'global' ? 0 : o.replicas ?? 1, image: resolveServiceImage(image), args });
        out.print(svc.id);
        if (!p.has('detach')) progress(svc);
        ctx.W.events.add('service');
        return;
      }
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q', 'filter:f format'), { command: 'docker service ls' });
        const rows = cl.services.map((s) => ({ ID: short(s.id), Name: s.name, Mode: s.mode, Replicas: `${running(s).length}/${s.mode === 'global' ? eligible(cl, s).length : s.replicas}`, Image: s.image, Ports: s.ports.map((pp) => `*:${pp.split(':')[0]}->${pp.split(':')[1] || pp}/tcp`).join(', ') }));
        if (p.has('quiet')) return rows.forEach((r) => out.print(r.ID));
        if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
        return out.table(['ID', 'NAME', 'MODE', 'REPLICAS', 'IMAGE', 'PORTS'], rows.map((r) => [r.ID, r.Name, r.Mode, r.Replicas, r.Image, r.Ports]));
      }
      case 'ps': {
        const p = parseArgs(rest, flagSpec('quiet:q no-trunc no-resolve', 'filter:f format'), { command: 'docker service ps' });
        if (!p.pos.length) throw new CommandError('"docker service ps" requires at least 1 argument.');
        const desired = p.all('filter').find((f) => f.startsWith('desired-state='))?.split('=')[1];
        const pairs = p.pos.flatMap((k) => { const s = findService(cl, k); return s.tasks.filter((t) => !desired || t.desired.toLowerCase() === desired).map((t) => ({ s, t })); });
        if (p.has('quiet')) return pairs.forEach(({ t }) => out.print(t.id));
        return taskTable(pairs);
      }
      case 'logs': {
        const p = parseArgs(rest, flagSpec('follow:f timestamps:t no-trunc raw no-task-ids', 'tail:n since'), { command: 'docker service logs' });
        const s = findService(cl, p.pos[0] || '');
        running(s).forEach((t) => ctx.withFrame({ daemon: t.host, client: t.host }, () => {
          const c = ctx.findCtr(t.ctrName);
          const lines = c ? (p.get('tail') ? c.logs.slice(-Number(p.get('tail'))) : c.logs) : [];
          lines.forEach((l) => out.print(`${s.name}.${t.slot}.${short(t.id)}@${t.node}    | ${l.line}`));
        }));
        if (p.has('follow')) out.note('(following — the real command streams until Ctrl+C)');
        return;
      }
      case 'scale': {
        const p = parseArgs(rest, flagSpec('detach:d'), { command: 'docker service scale' });
        if (!p.pos.length || !p.pos.every((kv) => /^[\w.-]+=\d+$/.test(kv))) throw new CommandError('"docker service scale" requires SERVICE=REPLICAS arguments, e.g. docker service scale web=5');
        p.pos.forEach((kv) => {
          const [k, v] = kv.split('=');
          const s = findService(cl, k);
          if (s.mode === 'global') throw new CommandError(`${k}: scale can only be used with replicated mode`);
          s.replicas = Number(v);
          converge(cl, s);
          out.print(`${s.name} scaled to ${v}`);
          if (!p.has('detach')) progress(s);
        });
        return;
      }
      case 'update': {
        const p = parseArgs(rest, SERVICE_SPEC, { command: 'docker service update' });
        const s = findService(cl, p.pos.at(-1) || '');
        if (p.has('rollback')) return CMDS.service(['rollback', s.name]);
        s.prev = { image: s.image, replicas: s.replicas, env: { ...s.env }, ports: [...s.ports], secrets: [...s.secrets] };
        let needsRoll = p.has('force');
        if (p.get('image')) { s.image = resolveServiceImage(p.get('image')); needsRoll = true; }
        if (p.get('replicas') != null) s.replicas = Number(p.get('replicas'));
        p.all('env-add').forEach((e) => { const [k, ...v] = e.split('='); s.env[k] = v.join('='); needsRoll = true; });
        p.all('env-rm').forEach((k) => { delete s.env[k]; needsRoll = true; });
        p.all('publish-add').forEach((pp) => s.ports.push(pp));
        p.all('publish-rm').forEach((pp) => { s.ports = s.ports.filter((x) => x.split(':')[1] !== pp && x !== pp); });
        p.all('secret-add').forEach((sec) => { if (!cl.secrets.some((x) => x.name === sec)) throw new CommandError(`Error response from daemon: secret not found: ${sec}`); s.secrets.push(sec); needsRoll = true; });
        p.all('secret-rm').forEach((sec) => { s.secrets = s.secrets.filter((x) => x !== sec); needsRoll = true; });
        if (p.get('constraint-add')) { s.constraint = p.get('constraint-add'); needsRoll = true; }
        if (p.get('update-parallelism')) s.updateParallelism = Number(p.get('update-parallelism'));
        s.version++;
        if (needsRoll) return rolling(cl, s);
        converge(cl, s);
        out.print(s.name);
        return progress(s);
      }
      case 'rollback': {
        const s = findService(cl, rest.find((r) => !r.startsWith('-')) || '');
        if (!s.prev) throw new CommandError(`Error response from daemon: rpc error: code = FailedPrecondition desc = service ${s.id} does not have a previous spec`);
        const cur = { image: s.image, replicas: s.replicas, env: s.env, ports: s.ports, secrets: s.secrets };
        Object.assign(s, s.prev, { prev: cur });
        s.version++;
        out.print('rollback: manually requested rollback');
        return rolling(cl, s, 'rollback');
      }
      case 'inspect': {
        const p = parseArgs(rest, flagSpec('pretty'), { command: 'docker service inspect' });
        const list = p.pos.map((k) => findService(cl, k));
        if (p.has('pretty')) return list.forEach((s) => out.print(`ID:\t\t${s.id}\nName:\t\t${s.name}\nService Mode:\t${s.mode === 'global' ? 'Global' : `Replicated\n Replicas:\t${s.replicas}`}\nPlacement:${s.constraint ? `\n Constraints:\t[${s.constraint}]` : ''}\nUpdateConfig:\n Parallelism:\t${s.updateParallelism}\n On failure:\tpause\n Order:\t\tstop-first\nRollbackConfig:\n Parallelism:\t1\nContainerSpec:\n Image:\t\t${s.image}${Object.keys(s.env).length ? `\n Env:\t\t${Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}${s.secrets.length ? `\nSecrets:\n Target:\t/run/secrets/${s.secrets.join(', /run/secrets/')}` : ''}${s.ports.length ? `\nPorts:\n${s.ports.map((pp) => ` PublishedPort = ${pp.split(':')[0]}\n  Protocol = tcp\n  TargetPort = ${pp.split(':')[1]}\n  PublishMode = ingress`).join('\n')}` : ''}`));
        return out.print(JSON.stringify(list.map((s) => ({ ID: s.id, Spec: { Name: s.name, TaskTemplate: { ContainerSpec: { Image: s.image, Env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`), Secrets: s.secrets.map((x) => ({ SecretName: x, File: { Name: x } })) }, Placement: { Constraints: s.constraint ? [s.constraint] : [] } }, Mode: s.mode === 'global' ? { Global: {} } : { Replicated: { Replicas: s.replicas } }, EndpointSpec: { Ports: s.ports.map((pp) => ({ Protocol: 'tcp', TargetPort: Number(pp.split(':')[1]), PublishedPort: Number(pp.split(':')[0]), PublishMode: 'ingress' })) } }, PreviousSpec: s.prev ? { TaskTemplate: { ContainerSpec: { Image: s.prev.image } } } : undefined, Version: { Index: s.version } })), null, 4));
      }
      case 'rm': case 'remove': {
        if (!rest.length) throw new CommandError('"docker service rm" requires at least 1 argument.');
        rest.forEach((k) => {
          const s = findService(cl, k);
          s.tasks.filter((t) => t.desired === 'Running').forEach(stopTask);
          cl.services.splice(cl.services.indexOf(s), 1);
          out.print(k);
        });
        return;
      }
      default: throw new CommandError('Usage:  docker service COMMAND\n\nCommands: create, inspect, logs, ls, ps, rm, rollback, scale, update');
    }
  };

  // ---------- stack ----------
  const stackServices = (cl, name) => cl.services.filter((s) => s.stack === name);
  CMDS.stack = ([sub, ...rest]) => {
    const cl = requireManager();
    switch (sub) {
      case 'deploy': case 'up': {
        const p = parseArgs(rest, flagSpec('prune with-registry-auth detach:d quiet:q', 'compose-file:c resolve-image'), { command: 'docker stack deploy' });
        const name = p.pos[0];
        const file = p.get('compose-file');
        if (!name || !file) throw new CommandError('"docker stack deploy" requires a compose file and a stack name.\nUsage:  docker stack deploy -c stack.yaml STACK');
        const f = ctx.hostFile(file);
        if (!f.exists) throw new CommandError(`open ${file}: no such file or directory`);
        const model = ctx.normaliseCompose(parseYaml(f.value));
        Object.entries(model.secrets).forEach(([sname, spec]) => {
          if (spec?.external && !cl.secrets.some((x) => x.name === sname)) throw new CommandError(`service ${Object.values(model.services).find((s) => s.secrets.includes(sname))?.name || sname}: secret not found: ${sname}\n(create it first: echo "s3cret" | docker secret create ${sname} -)`);
        });
        if (Object.values(model.services).some((s) => s.build)) out.warn('Ignoring unsupported options: build\n(stacks run images from a registry — build and push them first)');
        Object.values(model.services).forEach((s) => { if (!s.image) throw new CommandError(`service ${s.name}: image is required for docker stack deploy`); });
        const net = `${name}_default`;
        if (!cl.networks.some((n) => n.name === net)) {
          out.print(`Creating network ${net}`);
          const n = { name: net, driver: 'overlay', id: hex(64), scope: 'swarm', subnet: `10.0.${ctx.D().subnetSeq++}.0/24`, created: Date.now(), labels: { 'com.docker.stack.namespace': name } };
          ctx.D().networks.push(n);
          cl.networks.push(n);
        }
        Object.values(model.services).forEach((s) => {
          const full = `${name}_${s.name}`;
          const existing = cl.services.find((x) => x.name === full);
          const spec = { image: resolveServiceImage(s.image), replicas: s.replicas, env: s.env, ports: s.ports, secrets: s.secrets, networks: [net], constraint: s.constraint ? s.constraint.replace(/\s+/g, '') : null, stack: name, shortName: s.name, args: s.command };
          if (existing) {
            out.print(`Updating service ${full} (id: ${existing.id})`);
            const changed = existing.image !== spec.image || JSON.stringify(existing.env) !== JSON.stringify(spec.env);
            existing.prev = { image: existing.image, replicas: existing.replicas, env: existing.env, ports: existing.ports, secrets: existing.secrets };
            Object.assign(existing, spec, { version: existing.version + 1 });
            if (changed) running(existing).forEach(stopTask);
            return converge(cl, existing);
          }
          out.print(`Creating service ${full}`);
          createService(cl, { ...spec, name: full });
        });
        ctx.W.events.add('stack');
        return;
      }
      case 'ls': case 'list': {
        const names = [...new Set(cl.services.map((s) => s.stack).filter(Boolean))];
        return out.table(['NAME', 'SERVICES'], names.map((n) => [n, stackServices(cl, n).length]));
      }
      case 'services': {
        const name = rest.find((r) => !r.startsWith('-'));
        const list = stackServices(cl, name);
        if (!list.length) return out.print(`Nothing found in stack: ${name}`);
        return out.table(['ID', 'NAME', 'MODE', 'REPLICAS', 'IMAGE', 'PORTS'], list.map((s) => [short(s.id), s.name, s.mode, `${running(s).length}/${s.replicas}`, s.image, s.ports.map((pp) => `*:${pp.split(':')[0]}->${pp.split(':')[1]}/tcp`).join(', ')]));
      }
      case 'ps': {
        const name = rest.find((r) => !r.startsWith('-'));
        const list = stackServices(cl, name);
        if (!list.length) return out.print(`nothing found in stack: ${name}`);
        return taskTable(list.flatMap((s) => s.tasks.map((t) => ({ s, t }))));
      }
      case 'rm': case 'remove': case 'down': {
        rest.filter((r) => !r.startsWith('-')).forEach((name) => {
          const list = stackServices(cl, name);
          if (!list.length) return out.print(`Nothing found in stack: ${name}`);
          list.forEach((s) => { out.print(`Removing service ${s.name}`); s.tasks.filter((t) => t.desired === 'Running').forEach(stopTask); cl.services.splice(cl.services.indexOf(s), 1); });
          const net = cl.networks.find((n) => n.name === `${name}_default`);
          if (net) {
            out.print(`Removing network ${net.name}`);
            cl.networks.splice(cl.networks.indexOf(net), 1);
            ctx.D().networks = ctx.D().networks.filter((n) => n.name !== net.name);
          }
        });
        return;
      }
      default: throw new CommandError('Usage:  docker stack COMMAND\n\nCommands: deploy, ls, ps, rm, services');
    }
  };

  // ---------- secrets & configs ----------
  const objects = (kind) => (cl) => cl[kind];
  const objectCmd = (kind, label) => ([sub, ...rest], io) => {
    const cl = requireManager();
    const list = objects(kind)(cl);
    const users = (name) => cl.services.filter((s) => (kind === 'secrets' ? s.secrets : s.configs || []).includes(name));
    switch (sub) {
      case 'create': {
        const p = parseArgs(rest, flagSpec('', 'label:l driver:d template-driver'), { command: `docker ${label} create` });
        const [name, src] = p.pos;
        if (!name || !src) throw new CommandError(`"docker ${label} create" requires exactly 2 arguments.\nUsage:  docker ${label} create [OPTIONS] ${label.toUpperCase()} file|-\n(from a pipe: echo "value" | docker ${label} create NAME -)`);
        if (list.some((x) => x.name === name)) throw new CommandError(`Error response from daemon: rpc error: code = AlreadyExists desc = ${label} ${name} already exists`);
        let value;
        if (src === '-') {
          if (io.stdin == null && !io.stdinFile) throw new CommandError(`Error reading content from "-": stdin is empty (pipe a value in: echo "s3cret" | docker ${label} create ${name} -)`);
          value = io.stdin ?? ctx.hostFile(io.stdinFile).value;
        } else {
          const f = ctx.hostFile(src);
          if (!f.exists) throw new CommandError(`Error reading content from "${src}": open ${src}: no such file or directory`);
          value = f.value;
        }
        const obj = { id: hex(25), name, created: Date.now(), labels: Object.fromEntries(p.all('label').map((l) => l.split('='))), data: kind === 'configs' ? String(value) : undefined };
        list.push(obj);
        if (kind === 'secrets') W().secretValues.set(name, String(value).trim());
        return out.print(obj.id);
      }
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q', 'filter:f format'), { command: `docker ${label} ls` });
        if (p.has('quiet')) return list.forEach((x) => out.print(x.id));
        return out.table(['ID', 'NAME', ...(kind === 'secrets' ? ['DRIVER'] : []), 'CREATED', 'UPDATED'], list.map((x) => [x.id, x.name, ...(kind === 'secrets' ? [''] : []), `${ctx.ago(x.created)} ago`, `${ctx.ago(x.created)} ago`]));
      }
      case 'inspect': {
        const p = parseArgs(rest, flagSpec('pretty', 'format:f'), { command: `docker ${label} inspect` });
        const objs = p.pos.map((k) => { const x = list.find((o) => o.name === k || o.id.startsWith(k)); if (!x) throw new CommandError(`Error response from daemon: ${label} ${k} not found`); return x; });
        if (p.has('pretty')) return objs.forEach((x) => out.print(`ID:              ${x.id}\nName:            ${x.name}\nCreated at:      ${new Date(x.created).toISOString()}\nUpdated at:      ${new Date(x.created).toISOString()}${kind === 'configs' ? `\nData:\n${x.data}` : ''}`));
        ctx.printInspect(objs.map((x) => ({ ID: x.id, Version: { Index: 11 }, CreatedAt: new Date(x.created).toISOString(), UpdatedAt: new Date(x.created).toISOString(), Spec: { Name: x.name, Labels: x.labels, ...(kind === 'configs' ? { Data: btoa(x.data) } : {}) } })), p.get('format'));
        if (kind === 'secrets') out.note('(notice: the secret value is never shown — it only exists inside containers of services that use it, at /run/secrets/NAME)');
        return;
      }
      case 'rm': case 'remove': {
        if (!rest.length) throw new CommandError(`"docker ${label} rm" requires at least 1 argument.`);
        rest.forEach((k) => {
          const x = list.find((o) => o.name === k || o.id.startsWith(k));
          if (!x) throw new CommandError(`Error response from daemon: ${label} ${k} not found`);
          const u = users(x.name);
          if (u.length) throw new CommandError(`Error response from daemon: rpc error: code = InvalidArgument desc = ${label} '${x.name}' is in use by the following service: ${u.map((s) => s.name).join(', ')}`);
          list.splice(list.indexOf(x), 1);
          if (kind === 'secrets') W().secretValues.delete(x.name);
          out.print(k);
        });
        return;
      }
      default: throw new CommandError(`Usage:  docker ${label} COMMAND\n\nCommands: create, inspect, ls, rm`);
    }
  };
  CMDS.secret = objectCmd('secrets', 'secret');
  CMDS.config = objectCmd('configs', 'config');
};
