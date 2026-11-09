// Networks, volumes, system, events, info/version, contexts, plugins and help.
import { CommandError, hex, short, flagSpec, parseArgs, parseFilters, formatRows, renderTemplate, fmtSize } from './util.js';
import { REFERENCE } from '../reference.js';

export const installResources = (ctx) => {
  const { CMDS, out } = ctx;
  const D = () => ctx.D();
  const confirm = (p, text) => { if (!p.has('force')) out.warn(`WARNING! ${text}\nAre you sure you want to continue? [y/N] y   (auto-answered — add -f to skip this prompt)`); };

  // ---------- networks ----------
  const NET_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan', 'host', 'none'];
  const netRow = (n) => ({ ID: short(n.id), Name: n.name, Driver: n.driver, Scope: n.scope, IPv6: 'false', Internal: String(!!n.internal), CreatedAt: new Date(n.created).toString().slice(0, 24) });
  CMDS.network = ([sub, ...rest]) => {
    switch (sub) {
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q no-trunc', 'filter:f format'), { command: 'docker network ls' });
        const filters = parseFilters(p.all('filter'));
        const list = D().networks.filter((n) => filters.every(({ key, value }) => (key === 'driver' ? n.driver === value : key === 'name' ? n.name.includes(value) : key === 'type' ? (value === 'builtin') === !!n.builtin : key === 'scope' ? n.scope === value : true)));
        if (p.has('quiet')) return list.forEach((n) => out.print(short(n.id)));
        if (p.get('format')) return formatRows(p.get('format'), list.map(netRow)).forEach((l) => out.print(l));
        return out.table(['NETWORK ID', 'NAME', 'DRIVER', 'SCOPE'], list.map((n) => [short(n.id), n.name, n.driver, n.scope]));
      }
      default: break;
    }
    if (sub === 'create') {
      const p = parseArgs(rest, flagSpec('internal attachable ipv6 ingress', 'driver:d subnet gateway ip-range label opt:o scope'), { command: 'docker network create' });
      const name = p.pos[0];
      if (!name) throw new CommandError('"docker network create" requires exactly 1 argument.\nUsage:  docker network create [OPTIONS] NETWORK');
      const driver = p.get('driver', 'bridge');
      if (!NET_DRIVERS.includes(driver)) throw new CommandError(`Error response from daemon: plugin "${driver}" not found`);
      if (driver === 'overlay' && !D().swarm) throw new CommandError('Error response from daemon: This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.');
      if (ctx.networkByName(name) && ctx.networkByName(name).name === name) throw new CommandError(`Error response from daemon: network with name ${name} already exists`);
      const seq = D().subnetSeq++;
      const subnet = p.get('subnet') || (driver === 'overlay' ? `10.0.${seq}.0/24` : `172.${seq}.0.0/16`);
      const n = { name, driver, id: hex(64), subnet, gateway: p.get('gateway') || subnet.replace(/\.0\/\d+$/, '.1'), scope: driver === 'overlay' ? 'swarm' : 'local', internal: p.has('internal'), attachable: p.has('attachable'), labels: Object.fromEntries(p.all('label').map((l) => l.split('='))), created: Date.now() };
      D().networks.push(n);
      ctx.ev('network', 'create', n.id, { name, type: driver });
      return out.print(n.id);
    }
    if (sub === 'rm' || sub === 'remove') {
      if (!rest.length) throw new CommandError('"docker network rm" requires at least 1 argument.');
      const errors = [];
      rest.filter((a) => !a.startsWith('-')).forEach((name) => {
        const n = ctx.networkByName(name);
        if (!n) return errors.push(`Error response from daemon: network ${name} not found`);
        if (n.builtin) return errors.push(`Error response from daemon: ${n.name} is a pre-defined network and cannot be removed`);
        const users = ctx.ctrs().filter((c) => c.networks[n.name] && c.status === 'running');
        if (users.length) return errors.push(`Error response from daemon: error while removing network: network ${n.name} id ${n.id} has active endpoints (${users.map((c) => c.name).join(', ')})`);
        ctx.ctrs().forEach((c) => delete c.networks[n.name]);
        D().networks.splice(D().networks.indexOf(n), 1);
        ctx.ev('network', 'destroy', n.id, { name: n.name });
        out.print(name);
      });
      if (errors.length) throw new CommandError(errors.join('\n'));
      return;
    }
    if (sub === 'connect') {
      const p = parseArgs(rest, flagSpec('', 'alias ip ip6 link driver-opt'), { command: 'docker network connect' });
      const [netName, key] = p.pos;
      const n = ctx.networkByName(netName || '');
      if (!n) throw new CommandError(`Error response from daemon: network ${netName} not found`);
      const c = ctx.mustCtr(key, 'docker network connect');
      if (c.networks[n.name]) throw new CommandError(`Error response from daemon: endpoint with name ${c.name} already exists in network ${n.name}`);
      if (n.driver === 'host' || n.driver === 'null') throw new CommandError(`Error response from daemon: container cannot be disconnected from host network or connected to host network`);
      ctx.attach(c, n, [...p.all('alias'), short(c.id)]);
      if (p.get('ip')) c.networks[n.name].ip = p.get('ip');
      ctx.ev('network', 'connect', n.id, { container: c.id, name: n.name });
      return;
    }
    if (sub === 'disconnect') {
      const p = parseArgs(rest, flagSpec('force:f'), { command: 'docker network disconnect' });
      const [netName, key] = p.pos;
      const n = ctx.networkByName(netName || '');
      if (!n) throw new CommandError(`Error response from daemon: network ${netName} not found`);
      const c = ctx.mustCtr(key, 'docker network disconnect');
      if (!c.networks[n.name]) throw new CommandError(`Error response from daemon: container ${short(c.id)} is not connected to network ${n.name}`);
      delete c.networks[n.name];
      ctx.ev('network', 'disconnect', n.id, { container: c.id, name: n.name });
      return;
    }
    if (sub === 'inspect') {
      const p = parseArgs(rest, flagSpec('verbose:v', 'format:f'), { command: 'docker network inspect' });
      if (!p.pos.length) throw new CommandError('"docker network inspect" requires at least 1 argument.');
      return ctx.printInspect(p.pos.map((name) => { const n = ctx.networkByName(name); if (!n) throw new CommandError(`Error response from daemon: network ${name} not found`); return ctx.inspectNetwork(n); }), p.get('format'));
    }
    if (sub === 'prune') {
      const p = parseArgs(rest, flagSpec('force:f', 'filter'), { command: 'docker network prune' });
      confirm(p, 'This will remove all custom networks not used by at least one container.');
      const gone = D().networks.filter((n) => !n.builtin && !ctx.ctrs().some((c) => c.networks[n.name]) && n.scope !== 'swarm');
      D().networks = D().networks.filter((n) => !gone.includes(n));
      gone.forEach((n) => ctx.ev('network', 'destroy', n.id, { name: n.name }));
      ctx.W.events.add('prune');
      return gone.length ? out.print(`Deleted Networks:\n${gone.map((n) => n.name).join('\n')}`) : null;
    }
    throw new CommandError('Usage:  docker network COMMAND\n\nCommands: connect, create, disconnect, inspect, ls, prune, rm');
  };

  // ---------- volumes ----------
  const volUsers = (v) => ctx.ctrs().filter((c) => c.mounts.some((m) => m.name === v.name));
  CMDS.volume = ([sub, ...rest]) => {
    switch (sub) {
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q', 'filter:f format'), { command: 'docker volume ls' });
        const filters = parseFilters(p.all('filter'));
        const list = D().volumes.filter((v) => filters.every(({ key, value }) => (key === 'dangling' ? (!volUsers(v).length) === (value === 'true') : key === 'name' ? v.name.includes(value) : key === 'driver' ? v.driver === value : key === 'label' ? value.split('=')[0] in (v.labels || {}) : true)));
        if (p.has('quiet')) return list.forEach((v) => out.print(v.name));
        if (p.get('format')) return formatRows(p.get('format'), list.map((v) => ({ Name: v.name, Driver: v.driver, Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Scope: 'local', Labels: '' }))).forEach((l) => out.print(l));
        return out.table(['DRIVER', 'VOLUME NAME'], list.map((v) => [v.driver, v.name]));
      }
      case 'create': {
        const p = parseArgs(rest, flagSpec('', 'driver:d label opt:o name'), { command: 'docker volume create' });
        const name = p.pos[0] || p.get('name') || hex(64);
        ctx.ensureVolume(name, { driver: p.get('driver', 'local'), labels: Object.fromEntries(p.all('label').map((l) => l.split('='))) });
        return out.print(name);
      }
      case 'rm': case 'remove': {
        const p = parseArgs(rest, flagSpec('force:f'), { command: 'docker volume rm' });
        if (!p.pos.length) throw new CommandError('"docker volume rm" requires at least 1 argument.');
        const errors = [];
        p.pos.forEach((name) => {
          const v = D().volumes.find((x) => x.name === name);
          if (!v) return errors.push(`Error response from daemon: get ${name}: no such volume`);
          const users = volUsers(v);
          if (users.length) return errors.push(`Error response from daemon: remove ${name}: volume is in use - [${users.map((c) => c.id).join(', ')}]\n(remove the container first: docker rm -f ${users[0].name})`);
          D().volumes.splice(D().volumes.indexOf(v), 1);
          ctx.ev('volume', 'destroy', name, {});
          out.print(name);
        });
        if (errors.length) throw new CommandError(errors.join('\n'));
        return;
      }
      case 'inspect': {
        const p = parseArgs(rest, flagSpec('', 'format:f'), { command: 'docker volume inspect' });
        if (!p.pos.length) throw new CommandError('"docker volume inspect" requires at least 1 argument.');
        return ctx.printInspect(p.pos.map((name) => { const v = D().volumes.find((x) => x.name === name); if (!v) throw new CommandError(`Error response from daemon: get ${name}: no such volume`); return ctx.inspectVolume(v); }), p.get('format'));
      }
      case 'prune': {
        const p = parseArgs(rest, flagSpec('all:a force:f', 'filter'), { command: 'docker volume prune' });
        confirm(p, `This will remove ${p.has('all') ? 'all' : 'anonymous'} local volumes not used by at least one container.`);
        const gone = D().volumes.filter((v) => !volUsers(v).length && (p.has('all') || v.anon));
        D().volumes = D().volumes.filter((v) => !gone.includes(v));
        gone.forEach((v) => ctx.ev('volume', 'destroy', v.name, {}));
        ctx.W.events.add('prune');
        if (gone.length) out.print(`Deleted Volumes:\n${gone.map((v) => v.name).join('\n')}\n`);
        out.print(`Total reclaimed space: ${gone.length ? fmtSize(gone.reduce((n, v) => n + v.files.size * 0.4, 0)) : '0B'}`);
        if (!p.has('all') && D().volumes.some((v) => !v.anon && !volUsers(v).length)) out.note('(named volumes are kept since Docker 23 — add --all to also remove unused named volumes)');
        return;
      }
      default: throw new CommandError('Usage:  docker volume COMMAND\n\nCommands: create, inspect, ls, prune, rm');
    }
  };

  // ---------- system ----------
  const df = (verbose) => {
    const d = D();
    const used = new Set(ctx.ctrs().map((c) => c.imageId));
    const uniq = [...new Map(d.images.map((i) => [i.id, i])).values()];
    const imgMb = uniq.reduce((n, i) => n + i.mb, 0);
    const reclaim = uniq.filter((i) => !used.has(i.id)).reduce((n, i) => n + i.mb, 0);
    const volUsed = (v) => volUsers(v).length > 0;
    const volMb = (v) => v.files.size * 0.4;
    const cache = d.buildCache.size * 12.4;
    out.table(['TYPE', 'TOTAL', 'ACTIVE', 'SIZE', 'RECLAIMABLE'], [
      ['Images', uniq.length, used.size, fmtSize(imgMb), `${fmtSize(reclaim)} (${imgMb ? Math.round((reclaim / imgMb) * 100) : 0}%)`],
      ['Containers', d.containers.length, d.containers.filter((c) => c.status === 'running').length, `${(d.containers.length * 1.09).toFixed(2)}kB`, `${(d.containers.filter((c) => c.status !== 'running').length * 1.09).toFixed(2)}kB`],
      ['Local Volumes', d.volumes.length, d.volumes.filter(volUsed).length, fmtSize(d.volumes.reduce((n, v) => n + volMb(v), 0)), fmtSize(d.volumes.filter((v) => !volUsed(v)).reduce((n, v) => n + volMb(v), 0))],
      ['Build Cache', d.buildCache.size, 0, fmtSize(cache), fmtSize(cache)],
    ]);
    if (verbose) {
      out.print('\nImages space usage:\n');
      out.table(['REPOSITORY', 'TAG', 'IMAGE ID', 'SIZE', 'CONTAINERS'], d.images.map((i) => [i.repo, i.tag, short(i.id), fmtSize(i.mb), ctx.ctrs().filter((c) => c.imageId === i.id).length]));
      out.print('\nLocal Volumes space usage:\n');
      out.table(['VOLUME NAME', 'LINKS', 'SIZE'], d.volumes.map((v) => [v.name, volUsers(v).length, fmtSize(volMb(v))]));
    }
  };
  const info = () => {
    const d = D();
    const m = ctx.M(ctx.frame.daemon);
    out.print([
      'Client: Docker Engine - Community (playground)', ` Version:    27.3.1`, ` Context:    ${ctx.W.context}`, ' Plugins:', '  buildx: Docker Buildx (v0.18.0)', '  compose: Docker Compose (v2.30.3)', '  scout: Docker Scout (v1.15.0)', '',
      'Server:', ` Containers: ${d.containers.length}`, `  Running: ${d.containers.filter((c) => c.status === 'running').length}`, `  Paused: ${d.containers.filter((c) => c.status === 'paused').length}`, `  Stopped: ${d.containers.filter((c) => c.status === 'exited' || c.status === 'created').length}`,
      ` Images: ${new Set(d.images.map((i) => i.id)).size}`, ' Server Version: 27.3.1', ' Storage Driver: overlay2', ' Logging Driver: json-file', ' Cgroup Driver: systemd', ' Cgroup Version: 2',
      ` Swarm: ${d.swarm ? `active\n  NodeID: ${d.nodeId}\n  Is Manager: ${d.swarm.nodes.find((n) => n.host === m.name)?.role === 'manager'}\n  Nodes: ${d.swarm.nodes.length}` : 'inactive'}`,
      ' Runtimes: io.containerd.runc.v2 runc', ' Default Runtime: runc', ' Kernel Version: 6.10.14-linuxkit', ' Operating System: Ubuntu 24.04 LTS', ' OSType: linux', ' Architecture: x86_64', ' CPUs: 8', ' Total Memory: 7.656GiB', ` Name: ${m.name}`, ' Docker Root Dir: /var/lib/docker', ' Live Restore Enabled: false',
    ].join('\n'));
  };
  CMDS.info = (args) => {
    const p = parseArgs(args, flagSpec('', 'format:f'), { command: 'docker info' });
    if (p.get('format')) return out.print(renderTemplate(p.get('format'), { ServerVersion: '27.3.1', Containers: D().containers.length, ContainersRunning: D().containers.filter((c) => c.status === 'running').length, Images: D().images.length, Driver: 'overlay2', OperatingSystem: 'Ubuntu 24.04 LTS', NCPU: 8, MemTotal: 8220000000, Name: ctx.frame.daemon, Swarm: { LocalNodeState: D().swarm ? 'active' : 'inactive', NodeID: D().swarm ? D().nodeId : '' } }));
    info();
  };
  CMDS.version = (args) => {
    const p = parseArgs(args, flagSpec('', 'format:f'), { command: 'docker version' });
    const v = { Client: { Version: '27.3.1', APIVersion: '1.47', Os: 'linux', Arch: 'amd64', Context: ctx.W.context }, Server: { Version: '27.3.1', APIVersion: '1.47', MinAPIVersion: '1.24', Os: 'linux', Arch: 'amd64' } };
    if (p.get('format')) return out.print(renderTemplate(p.get('format'), v));
    out.print(`Client: Docker Engine - Community\n Version:           ${v.Client.Version}\n API version:       ${v.Client.APIVersion}\n OS/Arch:           linux/amd64\n Context:           ${ctx.W.context}\n\nServer: Docker Engine - Community (simulated)\n Engine:\n  Version:          27.3.1\n  API version:      1.47 (minimum version 1.24)\n  OS/Arch:          linux/amd64\n containerd:\n  Version:          1.7.22\n runc:\n  Version:          1.1.14`);
  };

  const EVENT_SPEC = flagSpec('', 'filter:f format since until');
  CMDS.events = (args) => {
    const p = parseArgs(args, EVENT_SPEC, { command: 'docker events' });
    const filters = parseFilters(p.all('filter'));
    const list = D().log.filter((e) => filters.every(({ key, value }) => {
      switch (key) {
        case 'type': return e.Type === value;
        case 'event': return e.Action.split(':')[0] === value;
        case 'container': return e.Type === 'container' && (e.Actor.Attributes.name === value || e.Actor.ID.startsWith(value));
        case 'image': return (e.Actor.Attributes.image || e.Actor.Attributes.name || '').startsWith(value);
        case 'network': return e.Type === 'network' && e.Actor.Attributes.name === value;
        case 'volume': return e.Type === 'volume' && e.Actor.ID === value;
        case 'label': return true;
        default: throw new CommandError(`invalid filter '${key}'`);
      }
    }));
    if (p.get('format')) list.forEach((e) => out.print(renderTemplate(p.get('format'), { ...e, Status: e.Action, ID: e.Actor.ID, From: e.Actor.Attributes.image || '' })));
    else list.forEach((e) => out.print(`${new Date(e.time).toISOString().replace('Z', '000000+00:00')} ${e.Type} ${e.Action} ${e.Actor.ID} (${Object.entries(e.Actor.Attributes).map(([k, v]) => `${k}=${v}`).join(', ')})`));
    if (!list.length) out.note('(no events match yet — run, stop or remove a container and look again)');
    out.note('(this shows past events; the real command keeps streaming new ones until Ctrl+C. Tip: run it in a second terminal while you work.)');
  };

  CMDS.system = ([sub, ...rest]) => {
    switch (sub) {
      case 'df': return df(rest.includes('-v') || rest.includes('--verbose'));
      case 'info': return CMDS.info(rest);
      case 'events': return CMDS.events(rest);
      case 'prune': {
        const p = parseArgs(rest, flagSpec('all:a force:f volumes', 'filter'), { command: 'docker system prune' });
        const all = p.has('all');
        confirm(p, `This will remove:\n  - all stopped containers\n  - all networks not used by at least one container\n${p.has('volumes') ? '  - all anonymous volumes not used by at least one container\n' : ''}  - ${all ? 'all images without at least one container associated to them' : 'all dangling images'}\n  - ${all ? 'all build cache' : 'unused build cache'}`);
        const ctrs = ctx.ctrs().filter((c) => c.status === 'exited' || c.status === 'created');
        ctrs.forEach((c) => ctx.removeContainer(c));
        const used = new Set(ctx.ctrs().map((c) => c.imageId));
        const imgs = D().images.filter((i) => !used.has(i.id) && (all || i.repo === '<none>'));
        D().images = D().images.filter((i) => !imgs.includes(i));
        const nets = D().networks.filter((n) => !n.builtin && n.scope !== 'swarm' && !ctx.ctrs().some((c) => c.networks[n.name]));
        D().networks = D().networks.filter((n) => !nets.includes(n));
        const vols = p.has('volumes') ? D().volumes.filter((v) => v.anon && !volUsers(v).length) : [];
        D().volumes = D().volumes.filter((v) => !vols.includes(v));
        const cache = D().buildCache.size;
        D().buildCache.clear();
        ctx.W.events.add('prune');
        if (ctrs.length) out.print(`Deleted Containers:\n${ctrs.map((c) => c.id).join('\n')}\n`);
        if (nets.length) out.print(`Deleted Networks:\n${nets.map((n) => n.name).join('\n')}\n`);
        if (vols.length) out.print(`Deleted Volumes:\n${vols.map((v) => v.name).join('\n')}\n`);
        if (imgs.length) out.print(`Deleted Images:\n${imgs.map((i) => (i.repo === '<none>' ? `deleted: sha256:${i.id}` : `untagged: ${i.repo}:${i.tag}`)).join('\n')}\n`);
        if (cache) out.print(`Deleted build cache objects: ${cache}\n`);
        out.print(`Total reclaimed space: ${fmtSize(imgs.reduce((n, i) => n + i.mb, 0) + cache * 12.4)}`);
        if (!p.has('volumes')) out.note('(volumes are never removed by system prune unless you add --volumes — your data is safe)');
        return;
      }
      default: throw new CommandError('Usage:  docker system COMMAND\n\nCommands: df, events, info, prune');
    }
  };

  // ---------- contexts ----------
  CMDS.context = ([sub, ...rest]) => {
    const W = ctx.W;
    switch (sub) {
      case 'ls': case 'list': {
        const p = parseArgs(rest, flagSpec('quiet:q', 'format'), { command: 'docker context ls' });
        if (p.has('quiet')) return W.contexts.forEach((c) => out.print(c.name));
        return out.table(['NAME', 'DESCRIPTION', 'DOCKER ENDPOINT', 'ERROR'], W.contexts.map((c) => [`${c.name}${c.name === W.context ? ' *' : ''}`, c.desc, c.endpoint, '']));
      }
      case 'create': {
        const p = parseArgs(rest, flagSpec('', 'docker description from'), { command: 'docker context create' });
        const name = p.pos[0];
        if (!name) throw new CommandError('"docker context create" requires exactly 1 argument.\nUsage:  docker context create [OPTIONS] CONTEXT');
        if (W.contexts.some((c) => c.name === name)) throw new CommandError(`context "${name}" already exists`);
        const spec = p.get('docker') || '';
        const host = /host=([^,]+)/.exec(spec)?.[1];
        if (!host) throw new CommandError('docker endpoint config is required: --docker host=ssh://user@server (or host=tcp://server:2376)');
        const machineName = host.startsWith('unix://') ? W.local : host.replace(/^(ssh|tcp):\/\/([^@]+@)?/, '').replace(/:\d+$/, '');
        ctx.M(machineName);
        W.contexts.push({ name, desc: p.get('description') || '', endpoint: host, machine: machineName });
        out.print(name);
        return out.print(`Successfully created context "${name}"`);
      }
      case 'use': {
        const name = rest[0];
        ctx.contextMachine(name || '');
        W.context = name;
        out.print(name);
        return out.print(`Current context is now "${name}"`);
      }
      case 'show': return out.print(W.context);
      case 'inspect': {
        const names = rest.filter((r) => !r.startsWith('-'));
        return out.print(JSON.stringify((names.length ? names : [W.context]).map((n) => { const c = W.contexts.find((x) => x.name === n); if (!c) throw new CommandError(`context "${n}" does not exist`); return { Name: c.name, Metadata: { Description: c.desc }, Endpoints: { docker: { Host: c.endpoint, SkipTLSVerify: false } } }; }), null, 4));
      }
      case 'rm': case 'remove': {
        rest.filter((r) => !r.startsWith('-')).forEach((n) => {
          if (n === 'default') throw new CommandError('default context cannot be removed');
          if (n === W.context && !rest.includes('-f') && !rest.includes('--force')) throw new CommandError(`failed to remove context ${n}: context "${n}" is in use, set -f flag to force remove`);
          W.contexts = W.contexts.filter((c) => c.name !== n);
          if (W.context === n) W.context = 'default';
          out.print(n);
        });
        return;
      }
      default: throw new CommandError('Usage:  docker context COMMAND\n\nCommands: create, inspect, ls, rm, show, use');
    }
  };

  // ---------- plugins ----------
  CMDS.plugin = ([sub, ...rest]) => {
    const d = D();
    switch (sub) {
      case 'ls': case 'list': return out.table(['ID', 'NAME', 'DESCRIPTION', 'ENABLED'], d.plugins.map((pl) => [short(pl.id), pl.name, pl.desc, String(pl.enabled)]));
      case 'install': {
        const name = rest.find((r) => !r.startsWith('-'));
        if (!name) throw new CommandError('"docker plugin install" requires at least 1 argument.');
        out.print(`Plugin "${name}" is requesting the following privileges:\n - network: [host]\n - capabilities: [CAP_SYS_ADMIN]\nDo you grant the above permissions? [y/N] y   (auto-answered)`);
        d.plugins.push({ id: hex(64), name: name.includes(':') ? name : `${name}:latest`, desc: name.includes('sshfs') ? 'sshFS plugin for Docker' : 'Docker engine plugin', enabled: true });
        return out.print(`Installed plugin ${name}`);
      }
      case 'disable': case 'enable': { const pl = d.plugins.find((x) => x.name.startsWith(rest[0] || '-')); if (!pl) throw new CommandError(`Error response from daemon: plugin ${rest[0]} not found`); pl.enabled = sub === 'enable'; return out.print(rest[0]); }
      case 'rm': case 'remove': { const pl = d.plugins.find((x) => x.name.startsWith(rest.find((r) => !r.startsWith('-')) || '-')); if (!pl) throw new CommandError(`Error response from daemon: plugin ${rest[0]} not found`); if (pl.enabled && !rest.includes('-f')) throw new CommandError(`Error response from daemon: plugin ${pl.name} is enabled — disable it first or use -f`); d.plugins.splice(d.plugins.indexOf(pl), 1); return out.print(rest.find((r) => !r.startsWith('-'))); }
      default: throw new CommandError('Usage:  docker plugin COMMAND\n\nCommands: disable, enable, install, ls, rm\n(engine plugins add volume, network or log drivers. CLI plugins like buildx and compose are different — see docker info)');
    }
  };

  // ---------- help (generated from the command reference) ----------
  CMDS.help = (topic = []) => {
    const words = topic.filter((t) => t && t !== 'docker');
    if (!words.length) {
      out.html('<span class="ok">Usage:  docker [OPTIONS] COMMAND</span>');
      out.print('\nThe playground simulates these commands — add --help to any of them for details:\n');
      const groups = new Map();
      REFERENCE.forEach((r) => { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r.cmd.replace(/^docker /, '')); });
      groups.forEach((cmds, g) => out.html(`<span class="y">${ctx.escape(g)}</span>  ${ctx.escape(cmds.join(', '))}`));
      out.print('\nShell helpers on your computer: ls, cat, echo, curl, ssh, scp, grep, head, tail, wc, jq, clear');
      return out.note('(Full explanations with a live lab for every command: open the Commands page in the menu.)');
    }
    const key = words.join(' ');
    const entry = REFERENCE.find((r) => r.cmd === `docker ${key}`) || REFERENCE.find((r) => r.cmd.startsWith(`docker ${key} `) || r.aliases?.includes(`docker ${key}`));
    const subs = REFERENCE.filter((r) => r.cmd.startsWith(`docker ${key} `));
    if (!entry && !subs.length) throw new CommandError(`docker: '${key}' is not a docker command.\nSee 'docker --help'`);
    if (entry && entry.cmd === `docker ${key}`) {
      out.html(`<span class="ok">Usage:  ${ctx.escape(entry.syntax)}</span>`);
      out.print(`\n${entry.summary}\n`);
      if (entry.aliases?.length) out.print(`Aliases:\n  ${entry.aliases.join(', ')}\n`);
      if (entry.flags?.length) {
        out.print('Options:');
        entry.flags.forEach(([names, value, desc]) => out.print(`  ${`${names}${value ? ` ${value}` : ''}`.padEnd(30)} ${desc.replace(/<[^>]+>/g, '')}`));
      }
      return out.note(`(details, examples and a live lab: #/commands/${entry.id})`);
    }
    out.html(`<span class="ok">Usage:  docker ${ctx.escape(key)} COMMAND</span>\n`);
    subs.forEach((r) => out.print(`  ${r.cmd.replace(`docker ${key} `, '').padEnd(16)} ${r.summary}`));
  };
};
