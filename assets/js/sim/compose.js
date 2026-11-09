// docker compose: reads compose.yaml from the project folder and drives normal containers,
// networks and volumes labelled with their project and service.
import { CommandError, hex, short, flagSpec, parseArgs, formatRows, parseYaml, refOf } from './util.js';
import { PROJECT_DIR } from './data.js';

const GLOBAL = flagSpec('dry-run', 'file:f project-name:p project-directory env-file profile');
const toEnv = (e) => (Array.isArray(e) ? Object.fromEntries(e.map((kv) => { const [k, ...v] = String(kv).split('='); return [k, v.join('=')]; })) : Object.fromEntries(Object.entries(e || {}).map(([k, v]) => [k, String(v ?? '')])));
const toList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : v ? [v] : []);

/** Normalises a parsed compose file into { services: { name: {...} }, volumes, secrets }. */
export const normaliseCompose = (doc) => {
  if (!doc || typeof doc.services !== 'object' || !doc.services) throw new CommandError('no service selected — compose.yaml must have a top-level "services:" section');
  const services = Object.fromEntries(Object.entries(doc.services).map(([name, s]) => {
    const svc = s || {};
    if (!svc.image && !svc.build) throw new CommandError(`service "${name}" has neither an image nor a build context specified: invalid compose project`);
    return [name, {
      name, image: svc.image || null, build: typeof svc.build === 'object' && svc.build ? svc.build.context || '.' : svc.build || null,
      ports: toList(svc.ports).map(String), env: toEnv(svc.environment), volumes: toList(svc.volumes).map(String), deps: toList(svc.depends_on),
      restart: svc.restart || 'no', command: svc.command ? String(svc.command).split(' ') : [], replicas: Number(svc.deploy?.replicas || 1),
      secrets: toList(svc.secrets), constraint: (svc.deploy?.placement?.constraints || [])[0] || null, watch: svc.develop?.watch || null,
      healthcheck: svc.healthcheck || null, profiles: toList(svc.profiles),
    }];
  }));
  Object.values(services).forEach((s) => s.deps.forEach((d) => { if (!services[d]) throw new CommandError(`service "${s.name}" depends on undefined service "${d}": invalid compose project`); }));
  return { services, volumes: toList(doc.volumes), secrets: doc.secrets || {} };
};

// Dependency order: a service starts after everything it depends on.
const startOrder = (services, wanted) => {
  const order = [];
  const visit = (n, seen = new Set()) => {
    if (order.includes(n)) return;
    if (seen.has(n)) throw new CommandError(`dependency cycle detected: ${[...seen, n].join(' -> ')}`);
    seen.add(n);
    services[n].deps.forEach((d) => visit(d, seen));
    order.push(n);
  };
  wanted.forEach((n) => visit(n));
  return order;
};

export const installCompose = (ctx) => {
  const { CMDS, out } = ctx;
  const D = () => ctx.D();
  const done = (label, name, state) => out.html(` <span class="ok">✔</span> ${ctx.escape(`${label ? `${label} ` : ''}${name}`).padEnd(34)} <span class="ok">${state}</span>`);

  const load = (g) => {
    const file = g.get('file') || 'compose.yaml';
    const f = ctx.hostFile(file);
    if (!f.exists) throw new CommandError(`no configuration file provided: not found\n(compose looks for compose.yaml in ${PROJECT_DIR} — use -f to point at another file)`);
    const name = (g.get('project-name') || 'project').toLowerCase();
    return { name, file, model: normaliseCompose(parseYaml(f.value)) };
  };
  const projectCtrs = (name, svc = null) => ctx.ctrs().filter((c) => c.compose?.project === name && (!svc || c.compose.service === svc) && !c.compose.oneOff);
  const ctrName = (p, svc, n) => `${p}-${svc}-${n}`;
  const imageFor = (p, s) => s.image || `${p}-${s.name}`;

  const pickServices = (model, names) => {
    names.forEach((n) => { if (!model.services[n]) throw new CommandError(`no such service: ${n}`); });
    return names.length ? names : Object.keys(model.services);
  };

  const ensureNetwork = (p) => {
    const name = `${p}_default`;
    if (ctx.networkByName(name)?.name === name) return false;
    ctx.capture(() => CMDS.network(['create', '--label', `com.docker.compose.project=${p}`, name]));
    done('Network', name, 'Created');
    return true;
  };
  const ensureVolumes = (prj) => prj.model.volumes.forEach((v) => {
    const name = `${prj.name}_${v}`;
    if (D().volumes.some((x) => x.name === name)) return;
    ctx.ensureVolume(name, { labels: { 'com.docker.compose.project': prj.name } });
    done('Volume', `"${name}"`, 'Created');
  });
  const ensureImage = (prj, s, { build = false, quiet = false } = {}) => {
    const ref = imageFor(prj.name, s);
    if (s.build && (build || !ctx.findImage(ref))) {
      out.print(`[+] Building 1/1\n => [${s.name}] building ${s.build}`, 'dim');
      ctx.runBuild(['-t', ref, s.build]);
      done('Service', s.name, 'Built');
      return ctx.findImage(ref);
    }
    if (ctx.findImage(ref)) return ctx.findImage(ref);
    ctx.pullImage(ref, { quiet: true });
    if (!quiet) done('', `${s.name}`, 'Pulled');
    return ctx.findImage(ref);
  };

  const createFor = (prj, s, n, extra = {}) => {
    const img = ensureImage(prj, s, { quiet: true });
    const vols = s.volumes.map((v) => {
      const [src, dst, mode] = v.split(':');
      return dst && !/^(\/|\.|~|\$)/.test(src) ? `${prj.name}_${src}:${dst}${mode ? `:${mode}` : ''}` : v;
    });
    const args = [
      '--name', extra.name || ctrName(prj.name, s.name, n), '--network', `${prj.name}_default`, '--network-alias', s.name,
      '--label', `com.docker.compose.project=${prj.name}`, '--label', `com.docker.compose.service=${s.name}`, '--label', `com.docker.compose.container-number=${n}`,
      '--restart', extra.rm ? 'no' : s.restart,
      ...Object.entries({ ...s.env, ...(extra.env || {}) }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...(extra.noPorts ? [] : s.ports.flatMap((pp) => ['-p', pp])),
      ...vols.flatMap((v) => ['-v', v]),
      ...(extra.rm ? ['--rm'] : []), ...(extra.tty ? ['-it'] : []),
      refOf(img.repo, img.tag), ...(extra.cmd || s.command),
    ];
    const o = ctx.parseRunOptions(args, 'docker compose');
    o.compose = { project: prj.name, service: s.name, number: n, oneOff: !!extra.oneOff, file: prj.file };
    return ctx.createContainer(o, img);
  };

  const up = (prj, rest) => {
    const p = parseArgs(rest, flagSpec('detach:d build no-build force-recreate no-recreate no-deps remove-orphans wait no-start quiet-pull abort-on-container-exit watch:w no-color', 'scale timeout:t pull'), { command: 'docker compose up' });
    const wanted = pickServices(prj.model, p.pos);
    const order = p.has('no-deps') ? wanted : startOrder(prj.model.services, wanted);
    const scale = Object.fromEntries(p.all('scale').map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
    Object.keys(scale).forEach((k) => { if (!prj.model.services[k]) throw new CommandError(`no such service: ${k}`); });
    order.forEach((n) => { const s = prj.model.services[n]; ensureImage(prj, s, { build: p.has('build') }); });
    out.print(`[+] Running ${order.length + 1}/${order.length + 1}`);
    ensureNetwork(prj.name);
    ensureVolumes(prj);
    order.forEach((n) => {
      const s = prj.model.services[n];
      const want = scale[n] ?? Math.max(1, projectCtrs(prj.name, n).length || s.replicas);
      let list = projectCtrs(prj.name, n);
      if (p.has('force-recreate')) { list.forEach((c) => { ctx.stopContainer(c); ctx.removeContainer(c); done('Container', c.name, 'Recreated'); }); list = []; }
      list.slice(want).forEach((c) => { ctx.stopContainer(c); ctx.removeContainer(c); done('Container', c.name, 'Removed'); });
      for (let i = 1; i <= want; i++) {
        let c = list.find((x) => x.compose.number === i);
        if (c && c.status === 'running') { done('Container', c.name, 'Running'); continue; }
        const created = !c;
        if (!c) c = createFor(prj, s, i);
        if (p.has('no-start')) { done('Container', c.name, 'Created'); continue; }
        try { ctx.startContainer(c); } catch (err) {
          out.html(` <span class="bad">✘</span> Container ${ctx.escape(c.name)}  Error`);
          throw new CommandError(`Error response from daemon: ${err.message.replace(/^Error response from daemon: /, '')}${scale[n] > 1 && s.ports.length ? `\n(only one container can own host port ${s.ports[0].split(':')[0]} — remove the fixed host port to scale ${n})` : ''}`);
        }
        done('Container', c.name, c.status === 'running' ? (created ? 'Started' : 'Started') : `Exited (${c.exitCode})`);
      }
    });
    ctx.W.events.add('compose-up');
    if (p.has('detach')) return;
    order.flatMap((n) => projectCtrs(prj.name, n)).forEach((c) => c.logs.forEach((l) => out.print(`${`${c.compose.service}-${c.compose.number}`.padEnd(8)}| ${l.line}`)));
    out.note('(attached to the logs of every service — in a real terminal Ctrl+C stops them all. Use docker compose up -d to run in the background.)');
  };

  const down = (prj, rest) => {
    const p = parseArgs(rest, flagSpec('volumes:v remove-orphans', 'rmi timeout:t'), { command: 'docker compose down' });
    const list = ctx.ctrs().filter((c) => c.compose?.project === prj.name);
    const leftovers = p.has('volumes') && prj.model.volumes.some((v) => D().volumes.some((x) => x.name === `${prj.name}_${v}`));
    if (!list.length && !ctx.networkByName(`${prj.name}_default`) && !leftovers) return out.note(`(nothing to remove — project "${prj.name}" is not running)`);
    out.print(`[+] Running ${list.length + 1}/${list.length + 1}`);
    [...list].reverse().forEach((c) => { ctx.stopContainer(c); ctx.removeContainer(c); done('Container', c.name, 'Removed'); });
    const net = ctx.networkByName(`${prj.name}_default`);
    if (net?.name === `${prj.name}_default`) { D().networks.splice(D().networks.indexOf(net), 1); done('Network', net.name, 'Removed'); }
    if (p.has('volumes')) prj.model.volumes.forEach((v) => {
      const vol = D().volumes.find((x) => x.name === `${prj.name}_${v}`);
      if (vol) { D().volumes.splice(D().volumes.indexOf(vol), 1); done('Volume', vol.name, 'Removed'); }
    });
    else if (prj.model.volumes.length) out.note(`(volumes ${prj.model.volumes.map((v) => `${prj.name}_${v}`).join(', ')} are kept — your data survives. Add -v to delete them too.)`);
    const rmi = p.get('rmi');
    if (rmi) Object.values(prj.model.services).filter((s) => rmi === 'all' || s.build).forEach((s) => {
      const img = ctx.findImage(imageFor(prj.name, s));
      if (img) { D().images.splice(D().images.indexOf(img), 1); done('Image', refOf(img.repo, img.tag), 'Removed'); }
    });
  };

  const forEachCtr = (prj, names, verb, fn) => {
    const svcs = pickServices(prj.model, names);
    const list = svcs.flatMap((n) => projectCtrs(prj.name, n));
    if (!list.length) return out.note(`(no containers for ${names.length ? names.join(', ') : `project "${prj.name}"`} — run docker compose up -d first)`);
    list.forEach((c) => { fn(c); done('Container', c.name, verb); });
  };

  const SUBS = {
    up,
    down,
    create: (prj, rest) => up(prj, [...rest, '--no-start', '-d']),
    start: (prj, rest) => forEachCtr(prj, rest, 'Started', (c) => { if (c.status !== 'running') ctx.startContainer(c); }),
    stop: (prj, rest) => forEachCtr(prj, rest.filter((r) => !r.startsWith('-')), 'Stopped', (c) => ctx.stopContainer(c)),
    restart: (prj, rest) => forEachCtr(prj, rest.filter((r) => !r.startsWith('-')), 'Started', (c) => { ctx.stopContainer(c); ctx.startContainer(c); }),
    pause: (prj, rest) => forEachCtr(prj, rest, 'Paused', (c) => { if (c.status === 'running') c.status = 'paused'; }),
    unpause: (prj, rest) => forEachCtr(prj, rest, 'Unpaused', (c) => { if (c.status === 'paused') c.status = 'running'; }),
    kill: (prj, rest) => forEachCtr(prj, rest.filter((r) => !r.startsWith('-')), 'Killed', (c) => ctx.stopContainer(c, { signal: 'SIGKILL' })),
    rm: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('force:f stop:s volumes:v'), { command: 'docker compose rm' });
      const list = pickServices(prj.model, p.pos).flatMap((n) => projectCtrs(prj.name, n)).filter((c) => p.has('stop') || c.status !== 'running');
      if (p.has('stop')) list.forEach((c) => ctx.stopContainer(c));
      if (!list.length) return out.print('No stopped containers');
      if (!p.has('force')) out.print(`Going to remove ${list.map((c) => c.name).join(', ')}\n? Are you sure? Yes   (auto-answered — add -f to skip)`);
      list.forEach((c) => { ctx.removeContainer(c, { volumes: p.has('volumes') }); done('Container', c.name, 'Removed'); });
    },
    ps: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('all:a quiet:q services', 'format filter status'), { command: 'docker compose ps' });
      if (p.has('services')) return Object.keys(prj.model.services).forEach((n) => out.print(n));
      const list = ctx.ctrs().filter((c) => c.compose?.project === prj.name && (!p.pos.length || p.pos.includes(c.compose.service)) && (p.has('all') || ['running', 'paused', 'restarting'].includes(c.status)));
      if (p.has('quiet')) return list.forEach((c) => out.print(c.id));
      const rows = list.map((c) => ({ Name: c.name, Image: c.image, Command: `"${[...(c.entrypoint || []), ...c.argv].join(' ').slice(0, 22)}"`, Service: c.compose.service, CreatedAt: `${ctx.ago(c.created)} ago`, Status: ctx.statusText(c), Ports: c.ports.map(ctx.portText).join(', '), State: c.status }));
      if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
      out.table(['NAME', 'IMAGE', 'COMMAND', 'SERVICE', 'CREATED', 'STATUS', 'PORTS'], rows.map((r) => [r.Name, r.Image, r.Command, r.Service, r.CreatedAt, r.Status, r.Ports]));
    },
    logs: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('follow:f timestamps:t no-color no-log-prefix', 'tail:n since until index'), { command: 'docker compose logs' });
      const list = pickServices(prj.model, p.pos).flatMap((n) => projectCtrs(prj.name, n));
      if (!list.length) return out.note('(no containers yet — docker compose up -d)');
      list.forEach((c) => {
        const lines = p.get('tail') ? c.logs.slice(-Number(p.get('tail'))) : c.logs;
        lines.forEach((l) => out.print(`${p.has('no-log-prefix') ? '' : `${`${c.compose.service}-${c.compose.number}`.padEnd(8)}| `}${p.has('timestamps') ? `${new Date(l.t).toISOString()} ` : ''}${l.line}`, l.stream === 'stderr' ? 'bad' : ''));
      });
      if (p.has('follow')) out.note('(following — in a real terminal new lines keep coming until Ctrl+C)');
    },
    exec: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('detach:d no-TTY:T privileged interactive:i tty:t', 'env:e user:u workdir:w index'), { stopAtPositional: true, command: 'docker compose exec' });
      const [svc, ...cmd] = p.pos;
      if (!svc || !cmd.length) throw new CommandError('"docker compose exec" requires at least 2 arguments.\nUsage:  docker compose exec [OPTIONS] SERVICE COMMAND [ARGS...]');
      pickServices(prj.model, [svc]);
      const c = projectCtrs(prj.name, svc).find((x) => x.compose.number === Number(p.get('index') || 1));
      if (!c || c.status !== 'running') throw new CommandError(`service "${svc}" is not running\n(start it first: docker compose up -d ${svc})`);
      if (/^(\/bin\/)?(sh|bash|ash)$/.test(cmd[0]) && cmd.length === 1 && !p.has('no-TTY')) return ctx.enterShell(c, { cmd: cmd[0] });
      ctx.runInContainerLines(c, cmd, { env: Object.fromEntries(p.all('env').map((e) => e.split('='))), user: p.get('user'), workdir: p.get('workdir') }).forEach((l) => out.print(l));
    },
    run: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('rm detach:d no-deps service-ports:P build interactive:i tty:t no-TTY:T', 'env:e name entrypoint user:u workdir:w publish:p volume:v label:l'), { stopAtPositional: true, command: 'docker compose run' });
      const [svc, ...cmd] = p.pos;
      if (!svc) throw new CommandError('"docker compose run" requires at least 1 argument.\nUsage:  docker compose run [OPTIONS] SERVICE [COMMAND] [ARGS...]');
      const s = prj.model.services[svc];
      if (!s) throw new CommandError(`no such service: ${svc}`);
      if (!p.has('no-deps') && s.deps.length) {
        const missing = startOrder(prj.model.services, s.deps).filter((d) => !projectCtrs(prj.name, d).some((c) => c.status === 'running'));
        if (missing.length) up(prj, ['-d', '--no-deps', ...missing]);
      } else ensureNetwork(prj.name);
      const c = createFor(prj, s, 1, { name: p.get('name') || `${prj.name}-${svc}-run-${hex(12)}`, cmd: cmd.length ? cmd : null, rm: p.has('rm'), env: Object.fromEntries(p.all('env').map((e) => e.split('='))), noPorts: !p.has('service-ports'), oneOff: true, tty: !p.has('no-TTY') });
      const shell = /^(\/bin\/)?(sh|bash|ash)$/.test(c.argv[0] || '') && c.argv.length === 1;
      const res = ctx.startContainer(c, { interactive: shell });
      if (res === 'shell') return ctx.enterShell(c, { mainProcess: true, cmd: c.argv[0] });
      if (p.has('detach')) return out.print(c.name);
      c.logs.forEach((l) => out.print(l.line));
      out.note(`(one-off container ${c.name}${p.has('rm') ? ' was removed afterwards because of --rm' : ' is kept — add --rm to clean it up automatically'}. Ports from compose.yaml are not published unless you add --service-ports.)`);
    },
    build: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('no-cache pull quiet:q push', 'build-arg'), { command: 'docker compose build' });
      const list = pickServices(prj.model, p.pos).map((n) => prj.model.services[n]);
      const buildable = list.filter((s) => s.build);
      list.filter((s) => !s.build).forEach((s) => out.note(`(${s.name} uses a ready-made image (${s.image}) — nothing to build)`));
      buildable.forEach((s) => { ctx.runBuild(['-t', imageFor(prj.name, s), ...(p.has('no-cache') ? ['--no-cache'] : []), ...p.all('build-arg').flatMap((a) => ['--build-arg', a]), s.build]); done('Service', s.name, 'Built'); });
    },
    pull: (prj, rest) => {
      const list = pickServices(prj.model, rest.filter((r) => !r.startsWith('-'))).map((n) => prj.model.services[n]);
      out.print(`[+] Pulling ${list.length}/${list.length}`);
      list.forEach((s) => {
        if (!s.image) return out.html(` <span class="dim">-</span> ${s.name} Skipped - No image to be pulled (it has a build section)`);
        ctx.pullImage(s.image, { quiet: true });
        done('', s.name, 'Pulled');
      });
    },
    push: (prj, rest) => {
      const list = pickServices(prj.model, rest.filter((r) => !r.startsWith('-'))).map((n) => prj.model.services[n]);
      list.forEach((s) => {
        if (!s.build) return out.html(` <span class="dim">-</span> ${s.name} Skipped — only services you build are pushed`);
        ctx.pushRef(imageFor(prj.name, s));
      });
    },
    config: (prj, rest) => {
      const p = parseArgs(rest, flagSpec('services volumes quiet:q images no-interpolate', 'format output:o'), { command: 'docker compose config' });
      if (p.has('quiet')) return out.note('(compose.yaml is valid)');
      if (p.has('services')) return Object.keys(prj.model.services).forEach((n) => out.print(n));
      if (p.has('volumes')) return prj.model.volumes.forEach((v) => out.print(v));
      if (p.has('images')) return Object.values(prj.model.services).forEach((s) => out.print(imageFor(prj.name, s)));
      if (p.get('format') === 'json') return out.print(JSON.stringify({ name: prj.name, ...prj.model }, null, 2));
      out.print(`name: ${prj.name}`);
      out.print('services:');
      Object.values(prj.model.services).forEach((s) => {
        out.print(`  ${s.name}:`);
        if (s.build) out.print(`    build:\n      context: ${PROJECT_DIR}\n      dockerfile: Dockerfile`);
        if (s.deps.length) out.print(`    depends_on:\n${s.deps.map((d) => `      ${d}:\n        condition: service_started\n        required: true`).join('\n')}`);
        if (Object.keys(s.env).length) out.print(`    environment:\n${Object.entries(s.env).map(([k, v]) => `      ${k}: ${v}`).join('\n')}`);
        out.print(`    image: ${imageFor(prj.name, s)}`);
        out.print(`    networks:\n      default: null`);
        if (s.ports.length) out.print(`    ports:\n${s.ports.map((pp) => { const [hp, cp] = pp.split(':'); return `      - mode: ingress\n        target: ${cp || hp}\n        published: "${cp ? hp : ''}"\n        protocol: tcp`; }).join('\n')}`);
        if (s.volumes.length) out.print(`    volumes:\n${s.volumes.map((v) => { const [src, dst] = v.split(':'); return `      - type: ${/^(\/|\.)/.test(src) ? 'bind' : 'volume'}\n        source: ${src}\n        target: ${dst}`; }).join('\n')}`);
      });
      out.print(`networks:\n  default:\n    name: ${prj.name}_default`);
      if (prj.model.volumes.length) out.print(`volumes:\n${prj.model.volumes.map((v) => `  ${v}:\n    name: ${prj.name}_${v}`).join('\n')}`);
    },
    top: (prj, rest) => pickServices(prj.model, rest).flatMap((n) => projectCtrs(prj.name, n)).filter((c) => c.status === 'running').forEach((c) => { out.print(c.name); CMDS.top([c.name]); out.print(''); }),
    images: (prj) => out.table(['CONTAINER', 'REPOSITORY', 'TAG', 'IMAGE ID', 'SIZE'], projectCtrs(prj.name).map((c) => { const img = ctx.imageById(c.imageId); return [c.name, img?.repo || c.repo, img?.tag || 'latest', short(c.imageId), ctx.fmtSize(img?.mb || 0)]; })),
    port: (prj, rest) => {
      const [svc, port] = rest.filter((r) => !r.startsWith('-'));
      const c = projectCtrs(prj.name, svc)[0];
      if (!c) throw new CommandError(`service "${svc}" is not running`);
      const pp = c.ports.find((x) => x.ctr === String(port).split('/')[0]);
      if (!pp) throw new CommandError(`no port ${port} for container ${c.name}`);
      out.print(`${pp.ip}:${pp.host}`);
    },
    cp: (prj, rest) => {
      const map = (s) => s.replace(/^([\w-]+):/, (m, svc) => (prj.model.services[svc] ? `${projectCtrs(prj.name, svc)[0]?.name || svc}:` : m));
      CMDS.cp(rest.map(map));
    },
    events: (prj) => {
      const names = new Set(ctx.ctrs().filter((c) => c.compose?.project === prj.name).map((c) => c.name));
      D().log.filter((e) => e.Type === 'container' && names.has(e.Actor.Attributes.name)).forEach((e) => out.print(`${new Date(e.time).toISOString()} container ${e.Action} ${e.Actor.ID} (name=${e.Actor.Attributes.name}${e.Actor.Attributes.image ? `, image=${e.Actor.Attributes.image}` : ''})`));
      out.note('(the real command keeps streaming until Ctrl+C)');
    },
    ls: (prj, rest) => {
      const all = rest.includes('-a') || rest.includes('--all');
      const projects = [...new Set(ctx.ctrs().filter((c) => c.compose).map((c) => c.compose.project))];
      out.table(['NAME', 'STATUS', 'CONFIG FILES'], projects.map((n) => {
        const list = ctx.ctrs().filter((c) => c.compose?.project === n);
        const running = list.filter((c) => c.status === 'running').length;
        return [n, running ? `running(${running})` : `exited(${list.length})`, `${PROJECT_DIR}/${list[0].compose.file}`];
      }).filter((r) => all || r[1].startsWith('running')));
    },
    scale: (prj, rest) => up(prj, ['-d', '--no-deps', ...rest.filter((r) => r.includes('=')).flatMap((kv) => ['--scale', kv]), ...rest.filter((r) => r.includes('=')).map((kv) => kv.split('=')[0])]),
    stats: (prj) => CMDS.stats([...projectCtrs(prj.name).filter((c) => c.status === 'running').map((c) => c.name), '--no-stream']),
    attach: (prj, rest) => CMDS.attach([projectCtrs(prj.name, rest[0])[0]?.name || rest[0]]),
    wait: (prj, rest) => rest.forEach((svc) => CMDS.wait([projectCtrs(prj.name, svc)[0]?.name || svc])),
    version: () => out.print('Docker Compose version v2.30.3 (playground)'),
    watch: (prj) => {
      const watched = Object.values(prj.model.services).filter((s) => s.watch);
      if (!watched.length) throw new CommandError('none of the selected services is configured for watch, consider setting a \'develop\' section');
      const W = ctx.W;
      W.watchSnap ||= {};
      watched.forEach((s) => {
        const c = projectCtrs(prj.name, s.name).find((x) => x.status === 'running');
        if (!c) throw new CommandError(`service "${s.name}" is not running — start it first: docker compose up -d`);
        const rule = s.watch[0];
        const files = [...ctx.F().entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('.') && !k.endsWith('.tar'));
        const snap = W.watchSnap[s.name];
        const changed = snap ? files.filter(([k, v]) => snap[k] !== v) : [];
        W.watchSnap[s.name] = Object.fromEntries(files);
        if (!snap) return out.print(`Watch enabled\n(watching ${rule.path} for ${s.name} → ${rule.target}. Now change a file — echo "// edit" >> server.js — and run docker compose watch again to see the sync.)`);
        if (!changed.length) return out.print(`Watch enabled — no changes since the last sync for ${s.name}`);
        changed.forEach(([k, v]) => ctx.writeFile(c, `${rule.target}/${k}`, v));
        out.print(`Syncing service "${s.name}" after ${changed.length} changed files were detected:\n${changed.map(([k]) => `  - ${PROJECT_DIR}/${k}`).join('\n')}`);
        out.note(`(the files were copied into ${c.name}:${rule.target} without a rebuild — check: docker compose exec ${s.name} cat ${rule.target}/${changed[0][0]})`);
      });
    },
  };

  CMDS.compose = (args) => {
    const g = parseArgs(args, GLOBAL, { stopAtPositional: true, command: 'docker compose' });
    const [sub, ...rest] = g.pos;
    if (!sub) throw new CommandError(`Usage:  docker compose [OPTIONS] COMMAND\n\nCommands: ${Object.keys(SUBS).join(', ')}`);
    if (sub === 'version') return SUBS.version();
    const fn = SUBS[sub === 'convert' ? 'config' : sub];
    if (!fn) throw new CommandError(`unknown docker command: "compose ${sub}"`);
    if (sub === 'ls') return fn(null, rest);
    fn(load(g), rest);
  };
  ctx.normaliseCompose = normaliseCompose;
  ctx.composeStartOrder = startOrder;
};
