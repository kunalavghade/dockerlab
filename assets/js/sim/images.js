// Image commands: images, pull, push, tag, rmi, history, save/load, import, search, login,
// build (BuildKit-style output with a real layer cache), buildx, builder, manifest, scout, init.
import { CommandError, hex, seededHex, short, flagSpec, parseArgs, parseFilters, formatRows, splitRef, cleanRepo, refOf, fmtSize, plural } from './util.js';
import { HUB, hubInfo, PROJECT_DIR } from './data.js';

const BUILD_SPEC = flagSpec('no-cache pull quiet:q load push rm force-rm', 'tag:t file:f target build-arg label platform progress output:o secret ssh cache-from cache-to network iidfile builder add-host shm-size ulimit');
const CONTAINER_PLATFORMS = ['linux/amd64', 'linux/amd64/v2', 'linux/arm64', 'linux/riscv64', 'linux/ppc64le', 'linux/s390x', 'linux/386', 'linux/arm/v7', 'linux/arm/v6'];
const SCOUT = { alpine: [0, 0, 0, 0], busybox: [0, 0, 0, 0], nginx: [0, 2, 3, 34], 'nginx:alpine': [0, 0, 1, 2], node: [1, 6, 12, 70], 'node:alpine': [0, 1, 2, 0], postgres: [0, 3, 6, 40], redis: [0, 1, 3, 22], python: [1, 5, 11, 64], ubuntu: [0, 0, 4, 12], debian: [0, 1, 6, 30], httpd: [0, 2, 4, 30], mysql: [0, 2, 5, 18], golang: [1, 4, 9, 50] };
const hash = (s) => { let x = 0; for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x.toString(16); };
const validRef = (ref) => {
  if (ref !== ref.toLowerCase().replace(/:[^/]*$/, (t) => t)) throw new CommandError(`invalid reference format: repository name (${ref}) must be lowercase`);
  if (!/^[a-z0-9]+([._/:-]?[a-z0-9]+)*(:[\w][\w.-]{0,127})?$/.test(ref)) throw new CommandError(`invalid reference format: "${ref}"`);
};

export const installImages = (ctx) => {
  const { CMDS, out } = ctx;
  const W = () => ctx.W;
  const usedBy = (img) => ctx.ctrs().filter((c) => c.imageId === img.id);

  // ---------- listing ----------
  const imageRow = (i) => ({ ID: short(i.id), Repository: i.repo, Tag: i.tag, Digest: i.digest || '<none>', CreatedSince: `${ctx.ago(i.created)} ago`, CreatedAt: new Date(i.created).toString().slice(0, 24), Size: fmtSize(i.mb), Platform: i.platform });
  const matchImage = (i, { key, value }) => {
    switch (key) {
      case 'dangling': return (i.repo === '<none>') === (value === 'true');
      case 'reference': return new RegExp(`^${value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(refOf(i.repo, i.tag)) || new RegExp(`^${value.replace(/\*/g, '.*')}$`).test(i.repo);
      case 'label': { const [k, v] = value.split('='); return k in i.cfg.labels && (v == null || i.cfg.labels[k] === v); }
      case 'before': { const ref = ctx.findImage(value); return !!ref && i.created < ref.created; }
      case 'since': { const ref = ctx.findImage(value); return !!ref && i.created > ref.created; }
      default: throw new CommandError(`invalid filter '${key}'`);
    }
  };
  CMDS.images = (args) => {
    const p = parseArgs(args, flagSpec('all:a quiet:q digests no-trunc tree', 'filter:f format'), { command: 'docker images' });
    const filters = parseFilters(p.all('filter'));
    let list = ctx.imageRows().filter((i) => filters.every((f) => matchImage(i, f)));
    if (p.pos[0]) { const [repo, tag] = p.pos[0].includes(':') ? splitRef(p.pos[0]) : [p.pos[0], null]; list = list.filter((i) => i.repo === cleanRepo(repo) && (!tag || i.tag === tag)); }
    list = [...list].reverse();
    const rows = list.map(imageRow);
    if (p.has('no-trunc')) rows.forEach((r, i) => { r.ID = `sha256:${list[i].id}`; });
    if (p.has('quiet')) return [...new Set(rows.map((r) => r.ID))].forEach((id) => out.print(id));
    if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
    out.table(['REPOSITORY', 'TAG', ...(p.has('digests') ? ['DIGEST'] : []), 'IMAGE ID', 'CREATED', 'SIZE'], rows.map((r) => [r.Repository, r.Tag, ...(p.has('digests') ? [r.Digest] : []), r.ID, r.CreatedSince, r.Size]));
  };

  CMDS.pull = (args) => {
    const p = parseArgs(args, flagSpec('all-tags:a quiet:q disable-content-trust', 'platform'), { command: 'docker pull' });
    const ref = p.pos[0];
    if (!ref) throw new CommandError('"docker pull" requires exactly 1 argument.\nUsage:  docker pull [OPTIONS] NAME[:TAG|@DIGEST]');
    const [repo, tag] = splitRef(ref);
    const clean = cleanRepo(repo);
    const full = `${ctx.registryOf(clean) === 'docker.io' ? `docker.io/${clean.includes('/') ? '' : 'library/'}` : ''}${clean}:${tag}`;
    const platform = p.get('platform');
    if (p.has('quiet')) ctx.capture(() => ctx.pullImage(ref, { platform }));
    else ctx.pullImage(ref, { platform });
    out.print(full);
  };

  CMDS.tag = (args) => {
    const [src, dst] = args;
    if (!src || !dst) throw new CommandError('"docker tag" requires exactly 2 arguments.\nUsage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]');
    const img = ctx.mustImage(src);
    validRef(dst);
    const [repo, tag] = splitRef(dst);
    ctx.addImage({ ...img, repo: cleanRepo(repo), tag });
    ctx.ev('image', 'tag', `sha256:${img.id}`, { name: dst });
  };

  CMDS.rmi = (args) => {
    const p = parseArgs(args, flagSpec('force:f no-prune'), { command: 'docker rmi' });
    if (!p.pos.length) throw new CommandError('"docker rmi" requires at least 1 argument.');
    const errors = [];
    p.pos.forEach((ref) => {
      const row = ctx.findImage(ref);
      if (!row) return errors.push(`Error response from daemon: No such image: ${ref}`);
      const rows = ctx.tagRows(row);
      const byId = /^[0-9a-f]{4,}$/.test(ref.replace(/^sha256:/, '')) && row.id.startsWith(ref.replace(/^sha256:/, ''));
      const users = usedBy(row);
      if (byId && rows.length > 1 && !p.has('force')) return errors.push(`Error response from daemon: conflict: unable to delete ${short(row.id)} (must be forced) - image is referenced in multiple repositories`);
      if (rows.length === 1 && users.length && !p.has('force')) return errors.push(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${short(users[0].id)} is using its referenced image ${short(row.id)}`);
      const victims = byId ? rows : [row];
      victims.forEach((r) => {
        ctx.D().images.splice(ctx.D().images.indexOf(r), 1);
        if (r.repo !== '<none>') out.print(`Untagged: ${refOf(r.repo, r.tag)}`);
        ctx.ev('image', 'untag', `sha256:${r.id}`, { name: refOf(r.repo, r.tag) });
      });
      if (!ctx.tagRows(row).length) {
        out.print(`Deleted: sha256:${row.id}`);
        ctx.ev('image', 'delete', `sha256:${row.id}`, {});
      }
    });
    if (errors.length) throw new CommandError(errors.join('\n'));
  };

  CMDS.history = (args) => {
    const p = parseArgs(args, flagSpec('human:H no-trunc quiet:q', 'format'), { command: 'docker history' });
    const img = ctx.mustImage(p.pos[0]);
    const rows = [...img.layers].reverse().map((l, i) => ({ ID: i === 0 ? short(img.id) : '<missing>', CreatedSince: `${ctx.ago(img.created)} ago`, CreatedBy: p.has('no-trunc') ? l.by : l.by.length > 44 ? `${l.by.slice(0, 44)}…` : l.by, Size: fmtSize(l.mb), Comment: l.comment || '' }));
    if (p.has('quiet')) return rows.forEach((r) => out.print(r.ID));
    if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
    out.table(['IMAGE', 'CREATED', 'CREATED BY', 'SIZE', 'COMMENT'], rows.map((r) => [r.ID, r.CreatedSince, r.CreatedBy, r.Size, r.Comment]));
  };

  // ---------- save / load / import ----------
  CMDS.save = (args, io) => {
    const p = parseArgs(args, flagSpec('', 'output:o platform'), { command: 'docker save' });
    if (!p.pos.length) throw new CommandError('"docker save" requires at least 1 argument.\nUsage:  docker save [OPTIONS] IMAGE [IMAGE...]');
    const images = p.pos.map((r) => ({ ...ctx.structuredCopy(ctx.mustImage(r)), repo: ctx.mustImage(r).repo, tag: ctx.mustImage(r).tag }));
    ctx.writeTar(io, p.get('output'), { tar: 'images', images, mb: images.reduce((n, i) => n + i.mb, 0) }, 'save');
    images.forEach((i) => ctx.ev('image', 'save', `sha256:${i.id}`, { name: refOf(i.repo, i.tag) }));
  };
  CMDS.load = (args, io) => {
    const p = parseArgs(args, flagSpec('quiet:q', 'input:i platform'), { command: 'docker load' });
    const file = p.get('input') || io.stdinFile;
    if (!file) throw new CommandError('requested load from stdin, but stdin is empty\n(use docker load -i file.tar or docker load < file.tar)');
    const f = ctx.hostFile(file);
    if (!f.exists) throw new CommandError(`open ${file}: no such file or directory`);
    if (typeof f.value !== 'object' || f.value.tar !== 'images') {
      throw new CommandError(`Error processing tar file(exit status 1): open /var/lib/docker/tmp/docker-import-${hex(9)}/repositories: no such file or directory${f.value?.tar === 'fs' ? '\n(this tar came from docker export — a flat file system, not an image. Use: docker import ' + file + ' myimage:1.0)' : ''}`);
    }
    if (!p.has('quiet')) out.print(`${hex(12)}: Loading layer [==================================================>]  ${fmtSize(f.value.mb)}/${fmtSize(f.value.mb)}`);
    f.value.images.forEach((img) => {
      ctx.addImage(ctx.structuredCopy(img));
      ctx.ev('image', 'load', `sha256:${img.id}`, { name: refOf(img.repo, img.tag) });
      out.print(img.repo === '<none>' ? `Loaded image ID: sha256:${img.id}` : `Loaded image: ${refOf(img.repo, img.tag)}`);
    });
  };
  CMDS.import = (args, io) => {
    const p = parseArgs(args, flagSpec('', 'change:c message:m platform'), { command: 'docker import' });
    const [src, ref] = p.pos;
    if (!src) throw new CommandError('"docker import" requires at least 1 argument.\nUsage:  docker import [OPTIONS] file|URL|- [REPOSITORY[:TAG]]');
    const f = ctx.hostFile(src === '-' ? io.stdinFile || '' : src);
    if (!f.exists) throw new CommandError(`open ${src}: no such file or directory`);
    if (f.value?.tar === 'images') out.warn('(this tar came from docker save — import treats it as a plain file system. Use docker load to keep the layers, tags and CMD.)');
    const files = f.value?.files || {};
    const cfg = { cmd: null, entrypoint: null, env: {}, workdir: '/', user: '', expose: [], labels: {}, stopSignal: 'SIGTERM' };
    p.all('change').forEach((ch) => ctx.applyChange(cfg, ch));
    const [repo, tag] = ref ? splitRef(ref) : ['<none>', '<none>'];
    const img = ctx.addImage(ctx.makeImage({ repo, tag, mb: f.value?.mb || 1, files, cfg, imported: true, layers: [{ id: hex(64), by: p.get('message') || 'Imported from -', mb: f.value?.mb || 1 }] }));
    ctx.ev('image', 'import', `sha256:${img.id}`, { name: ref || '' });
    out.print(`sha256:${img.id}`);
  };

  // ---------- registry ----------
  CMDS.search = (args) => {
    const p = parseArgs(args, flagSpec('no-trunc', 'limit filter:f format'), { command: 'docker search' });
    const term = (p.pos[0] || '').toLowerCase();
    if (!term) throw new CommandError('"docker search" requires exactly 1 argument.\nUsage:  docker search [OPTIONS] TERM');
    const filters = parseFilters(p.all('filter'));
    const hits = Object.entries(HUB).filter(([name, info]) => name.includes(term) || info.desc.toLowerCase().includes(term))
      .filter(([, info]) => filters.every(({ key, value }) => (key === 'is-official' ? info.official === (value === 'true') : key === 'stars' ? info.stars >= Number(value) : true)))
      .sort((a, b) => b[1].stars - a[1].stars).slice(0, Number(p.get('limit') || 25));
    const rows = hits.map(([name, info]) => ({ Name: name, Description: info.desc, StarCount: String(info.stars), IsOfficial: info.official ? '[OK]' : '' }));
    if (p.get('format')) return formatRows(p.get('format'), rows).forEach((l) => out.print(l));
    out.table(['NAME', 'DESCRIPTION', 'STARS', 'OFFICIAL'], rows.map((r) => [r.Name, r.Description, r.StarCount, r.IsOfficial]));
    if (!rows.length) out.note('(no results in the playground\'s Docker Hub)');
  };

  const LOGIN_SPEC = flagSpec('password-stdin', 'username:u password:p');
  CMDS.login = (args) => {
    const p = parseArgs(args, LOGIN_SPEC, { command: 'docker login' });
    const server = p.pos[0] || 'docker.io';
    const user = p.get('username') || 'you';
    if (p.get('password')) out.warn('WARNING! Using --password via the CLI is insecure. Use --password-stdin.');
    if (!p.get('username')) out.print(`Log in with your Docker ID or email address to push and pull images from Docker Hub.\nUsername: ${user}\nPassword: ********`);
    W().auth.set(server, user);
    out.ok('Login Succeeded');
    out.note('(simulated — the playground never asks for or stores a real password. In real life prefer an access token with --password-stdin.)');
  };
  CMDS.logout = (args) => {
    const server = args[0] || 'docker.io';
    W().auth.delete(server);
    out.print(`Removing login credentials for ${server === 'docker.io' ? 'https://index.docker.io/v1/' : server}`);
  };

  const pushRef = (ref, { platforms, quiet = false } = {}) => {
    const [rawRepo, tag] = splitRef(ref);
    const repo = cleanRepo(rawRepo);
    const img = ctx.findImage(refOf(repo, tag));
    if (!img && !platforms) throw new CommandError(`An image does not exist locally with the tag: ${repo}`);
    const reg = ctx.registryOf(repo);
    if (reg === 'localhost:5000' || reg.startsWith('localhost:')) {
      if (!ctx.localRegistryUp()) throw new CommandError(`Get "http://${reg}/v2/": dial tcp [::1]:5000: connect: connection refused\n(hint: start a registry: docker run -d -p 5000:5000 --name registry registry:2)`);
    } else {
      if (!repo.includes('/')) throw new CommandError(`denied: requested access to the resource is denied\n(hint: Docker Hub images must be named ACCOUNT/NAME — tag it first: docker tag ${repo}:${tag} you/${repo}:${tag})`);
      const user = W().auth.get(reg);
      if (!user) throw new CommandError(`push access denied for ${repo}: unauthorized: authentication required\n(hint: log in first: docker login${reg === 'docker.io' ? '' : ` ${reg}`})`);
      const namespace = (reg === 'docker.io' ? repo : repo.slice(reg.length + 1)).split('/')[0];
      if (namespace !== user) throw new CommandError(`denied: requested access to the resource is denied\n(you are logged in as "${user}", so you can only push to ${reg === 'docker.io' ? '' : `${reg}/`}${user}/…)`);
    }
    const source = img || platforms.image;
    if (!quiet) out.print(`The push refers to repository [${reg === 'docker.io' ? `docker.io/${repo}` : repo}]`);
    W().blobs ||= new Set();
    source.layers.filter((l) => l.mb > 0).forEach((l) => {
      if (!quiet) out.html(W().blobs.has(l.id) ? `${short(l.id)}: <span class="dim">Layer already exists</span>` : `${short(l.id)}: <span class="ok">Pushed</span>`);
      W().blobs.add(l.id);
    });
    const digest = `sha256:${seededHex(source.id + source.layers.length)}`;
    W().registry.set(ctx.registryKey(repo, tag), { image: { ...ctx.structuredCopy(source), digest }, platforms: platforms?.list || [source.platform || 'linux/amd64'], pushed: Date.now() });
    if (img) img.digest = digest;
    if (!quiet) out.print(`${tag}: digest: ${digest} size: ${1200 + source.layers.length * 150}`);
    ctx.ev('image', 'push', refOf(repo, tag), { name: refOf(repo, tag) });
  };
  CMDS.push = (args) => {
    const p = parseArgs(args, flagSpec('all-tags:a quiet:q disable-content-trust', 'platform'), { command: 'docker push' });
    if (!p.pos[0]) throw new CommandError('"docker push" requires exactly 1 argument.\nUsage:  docker push [OPTIONS] NAME[:TAG]');
    if (p.has('all-tags')) {
      const repo = cleanRepo(p.pos[0]);
      const rows = ctx.imageRows().filter((i) => i.repo === repo);
      if (!rows.length) throw new CommandError(`An image does not exist locally with the tag: ${repo}`);
      return rows.forEach((r) => pushRef(refOf(r.repo, r.tag), { quiet: p.has('quiet') }));
    }
    pushRef(p.pos[0], { quiet: p.has('quiet') });
  };

  // ---------- build ----------
  const ignoreList = () => String(ctx.F().get('.dockerignore') || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.')}$`);
  const contextFiles = (dir) => {
    const prefix = dir ? `${dir}/` : '';
    const ignores = ignoreList().map(globRe);
    return [...ctx.F().entries()].filter(([k, v]) => k.startsWith(prefix) && typeof v === 'string').map(([k, v]) => [k.slice(prefix.length), v]).filter(([k]) => !ignores.some((re) => re.test(k) || re.test(k.split('/')[0])));
  };
  const parseDockerfile = (text) => {
    const stages = [];
    const globalArgs = {};
    text.split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const [, instr, rest = ''] = /^(\w+)\s*(.*)$/.exec(line) || [];
      const I = (instr || '').toUpperCase();
      if (!stages.length && I === 'ARG') { const [k, v = ''] = rest.split('='); globalArgs[k] = v; return; }
      if (I === 'FROM') {
        const [, from, name] = /^(\S+)(?:\s+AS\s+(\S+))?/i.exec(rest) || [];
        stages.push({ from, name: name || null, steps: [], index: stages.length });
        return;
      }
      if (!stages.length) throw new CommandError(`failed to solve: dockerfile parse error on line 1: ${I} before FROM`);
      if (!['RUN', 'COPY', 'ADD', 'WORKDIR', 'CMD', 'ENTRYPOINT', 'ENV', 'ARG', 'EXPOSE', 'USER', 'LABEL', 'VOLUME', 'HEALTHCHECK', 'STOPSIGNAL', 'SHELL', 'ONBUILD', 'MAINTAINER'].includes(I)) throw new CommandError(`ERROR: failed to solve: dockerfile parse error: unknown instruction: ${instr}`);
      stages.at(-1).steps.push({ instr: I, rest, line });
    });
    if (!stages.length) throw new CommandError('ERROR: failed to solve: the Dockerfile cannot be empty');
    return { stages, globalArgs };
  };
  const subst = (s, vars) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (_, a, dflt, b) => vars[a || b] ?? dflt ?? '');
  const argv = (s) => (s.trim().startsWith('[') ? JSON.parse(s) : ['/bin/sh', '-c', s]);

  const buildStage = (plan, stage, ctxDir, opts, log, done) => {
    if (done.has(stage.index)) return done.get(stage.index);
    const vars = { ...plan.globalArgs, ...opts.buildArgs };
    const fromRef = subst(stage.from, vars);
    let state;
    const label = stage.name || (plan.stages.length > 1 ? `stage-${stage.index}` : '');
    const tagStep = (n) => `[${label ? `${label} ` : ''}${n}/${stage.steps.length + 1}]`;
    const prevStage = plan.stages.find((s) => s.name === fromRef);
    if (prevStage) state = ctx.structuredCopy(buildStage(plan, prevStage, ctxDir, opts, log, done));
    else if (fromRef === 'scratch') state = { files: {}, mb: 0, layers: [], cfg: { cmd: null, entrypoint: null, env: {}, workdir: '/', user: '', expose: [], labels: {}, stopSignal: 'SIGTERM' }, kind: 'shell', key: 'scratch' };
    else {
      const [repo, tag] = splitRef(fromRef);
      const clean = cleanRepo(repo);
      const local = ctx.findImage(refOf(clean, tag));
      const remote = W().registry.get(ctx.registryKey(clean, tag));
      const info = hubInfo(clean);
      if (!local && !remote && !info) throw new CommandError(`ERROR: failed to solve: ${fromRef}: failed to resolve source metadata for docker.io/${clean}:${tag}: pull access denied, repository does not exist or may require authorization`);
      const base = local || (remote ? remote.image : ctx.hubImage(clean, tag, info));
      state = { files: { ...base.files }, mb: base.mb, layers: [...base.layers], cfg: ctx.structuredCopy(base.cfg), kind: base.kind || info?.kind || 'shell', key: `${clean}:${tag}`, baseRef: fromRef };
      log.push(`[internal] load metadata for docker.io/${clean.includes('/') ? '' : 'library/'}${clean}:${tag}`);
    }
    log.push(`${tagStep(1)} FROM ${prevStage ? fromRef : `docker.io/${fromRef.includes('/') ? '' : 'library/'}${fromRef}`}`);
    let key = state.key;
    const env = { ...vars };
    for (const [i, step] of stage.steps.entries()) {
      const rest = subst(step.rest, { ...env, ...state.cfg.env });
      let stepKey = `${key}|${step.line}`;
      let mb = 0;
      const wd = state.cfg.workdir || '/';
      const abs = (p) => (p.startsWith('/') ? p : `${wd === '/' ? '' : wd}/${p}`).replace(/\/\.?$/, '') || '/';
      switch (step.instr) {
        case 'RUN': {
          mb = /npm (ci|install)/.test(rest) ? 48 : /apt-get|apk add/.test(rest) ? 38 : /go build|npm run build|pip install/.test(rest) ? 12 : 0.1;
          if (/npm (ci|install)/.test(rest)) state.files[abs('node_modules/express/package.json')] = '{"name":"express"}';
          if (/npm run build/.test(rest)) contextFiles(ctxDir).filter(([k]) => k === 'index.html').forEach(([, v]) => { state.files[abs('dist/index.html')] = v; });
          if (/go build/.test(rest)) state.files['/out/app'] = '<binary>';
          if (/exit 1|false$/.test(rest)) throw new CommandError(`ERROR: failed to solve: process "/bin/sh -c ${rest}" did not complete successfully: exit code: 1`);
          break;
        }
        case 'COPY': case 'ADD': {
          const fromM = /--from=(\S+)/.exec(rest);
          const parts = rest.replace(/--\S+/g, '').trim().split(/\s+/);
          const dest = parts.pop();
          if (fromM) {
            const src = plan.stages.find((s) => s.name === fromM[1] || String(s.index) === fromM[1]);
            const srcFiles = src ? buildStage(plan, src, ctxDir, opts, log, done).files : ctx.hubImage(...splitRef(fromM[1]), hubInfo(cleanRepo(splitRef(fromM[1])[0])) || {}).files;
            parts.forEach((sp) => Object.entries(srcFiles).filter(([k]) => k === sp || k.startsWith(`${sp.replace(/\/$/, '')}/`)).forEach(([k, v]) => { state.files[`${abs(dest)}/${k.slice(sp.replace(/\/$/, '').length + 1) || k.split('/').pop()}`] = v; }));
            stepKey += hash(JSON.stringify(srcFiles));
            mb = 2;
          } else {
            const matches = parts.flatMap((sp) => contextFiles(ctxDir).filter(([k]) => sp === '.' || globRe(sp.replace(/^\.\//, '')).test(k) || k.startsWith(`${sp.replace(/^\.\/|\/$/g, '')}/`)));
            if (!matches.length) throw new CommandError(`ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/${parts.join(' ')}": not found`);
            matches.forEach(([k, v]) => { state.files[parts.length === 1 && parts[0] !== '.' && !dest.endsWith('/') && matches.length === 1 ? abs(dest) : `${abs(dest)}/${k}`] = v; });
            stepKey += hash(matches.map(([k, v]) => k + v).join());
            mb = matches.reduce((n, [, v]) => n + v.length, 0) / 1e6;
          }
          break;
        }
        case 'WORKDIR': state.cfg.workdir = abs(rest); state.files[state.cfg.workdir] = null; break;
        case 'CMD': state.cfg.cmd = argv(rest); break;
        case 'ENTRYPOINT': state.cfg.entrypoint = argv(rest); break;
        case 'ENV': rest.split(/\s+(?=\w+=)/).forEach((kv) => { const [k, ...v] = kv.split(/[= ]/); state.cfg.env[k] = v.join('=').replace(/^"|"$/g, ''); }); break;
        case 'ARG': { const [k, v = ''] = rest.split('='); env[k] = opts.buildArgs[k] ?? v; stepKey += env[k]; break; }
        case 'EXPOSE': state.cfg.expose.push(...rest.split(/\s+/).map((x) => (x.includes('/') ? x : `${x}/tcp`))); break;
        case 'USER': state.cfg.user = rest; break;
        case 'LABEL': rest.split(/\s+(?=[\w.-]+=)/).forEach((kv) => { const [k, ...v] = kv.split('='); state.cfg.labels[k] = v.join('=').replace(/^"|"$/g, ''); }); break;
        case 'STOPSIGNAL': state.cfg.stopSignal = rest; break;
        case 'HEALTHCHECK': state.cfg.health = rest; break;
        default: break;
      }
      key = hash(stepKey);
      const cached = !opts.noCache && ctx.D().buildCache.has(key);
      ctx.D().buildCache.add(key);
      const meta = !['RUN', 'COPY', 'ADD', 'WORKDIR'].includes(step.instr);
      if (!meta) log.push(`${cached ? 'CACHED ' : ''}${tagStep(i + 2)} ${step.line}`);
      state.layers.push({ id: hex(64), by: step.instr === 'RUN' ? `RUN /bin/sh -c ${rest} # buildkit` : meta ? `${step.instr} ${rest}` : `${step.line} # buildkit`, mb: meta ? 0 : mb, comment: 'buildkit.dockerfile.v0', cached });
      state.mb += meta ? 0 : mb;
      if (step.instr === 'CMD' && /node|python|java|go/.test(state.cfg.cmd.join(' '))) state.kind = 'app';
    }
    state.key = key;
    done.set(stage.index, state);
    return state;
  };

  const runBuild = (args, { buildx = false } = {}) => {
    const p = parseArgs(args, BUILD_SPEC, { command: buildx ? 'docker buildx build' : 'docker build' });
    const ctxArg = p.pos[0];
    if (!ctxArg) throw new CommandError(`"docker ${buildx ? 'buildx ' : ''}build" requires exactly 1 argument.\nUsage:  docker build [OPTIONS] PATH | URL | -\n(hint: the build context is usually the current folder: docker build -t myapp .)`);
    const ctxDir = ctxArg === '.' || ctxArg === './' || ctxArg === PROJECT_DIR ? '' : ctx.hostFile(ctxArg).key.replace(/\/$/, '');
    if (ctxDir && ![...ctx.F().keys()].some((k) => k.startsWith(`${ctxDir}/`))) throw new CommandError(`ERROR: unable to prepare context: path "${ctxArg}" not found`);
    const fileName = p.get('file') || `${ctxDir ? `${ctxDir}/` : ''}Dockerfile`;
    const text = ctx.F().get(ctx.hostFile(fileName).key);
    if (typeof text !== 'string') throw new CommandError(`ERROR: failed to solve: failed to read dockerfile: open ${fileName}: no such file or directory`);
    const builder = ctx.D().builders.find((b) => b.name === (p.get('builder') || ctx.D().builder)) || ctx.D().builders[0];
    const platforms = (p.get('platform') || '').split(',').filter(Boolean);
    if (platforms.length > 1 && builder.driver === 'docker') throw new CommandError('ERROR: Multi-platform build is not supported for the docker driver.\nSwitch to a different driver, or turn on the containerd image store, and try again.\nLearn more at https://docs.docker.com/go/build-multi-platform/\n(hint: docker buildx create --name multi --driver docker-container --use)');
    const bad = platforms.find((pl) => !(builder.driver === 'docker' ? [...builder.platforms, 'linux/arm64', 'linux/arm/v7'] : CONTAINER_PLATFORMS).includes(pl));
    if (bad) throw new CommandError(`ERROR: failed to solve: no match for platform in manifest: ${bad}`);
    if (platforms.length > 1 && p.has('load')) throw new CommandError('ERROR: docker exporter does not currently support exporting manifest lists');
    const tags = p.all('tag');
    tags.forEach(validRef);
    const buildArgs = Object.fromEntries(p.all('build-arg').map((kv) => { const [k, ...v] = kv.split('='); return [k, v.join('=')]; }));
    const plan = parseDockerfile(text);
    const target = p.get('target') ? plan.stages.find((s) => s.name === p.get('target')) : plan.stages.at(-1);
    if (!target) throw new CommandError(`ERROR: failed to solve: target stage "${p.get('target')}" could not be found`);
    if (builder.driver !== 'docker' && builder.status !== 'running') bootstrap(builder);
    const log = [];
    const started = Date.now();
    const result = buildStage(plan, target, ctxDir, { buildArgs, noCache: p.has('no-cache') }, log, new Map());
    const quiet = p.has('quiet');
    const img = ctx.makeImage({ repo: '<none>', tag: '<none>', mb: result.mb, layers: result.layers, files: ctx.withDirs(result.files), cfg: { ...result.cfg, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...result.cfg.env } }, built: true, kind: result.kind, platform: platforms[0] || 'linux/amd64', base: result.baseRef, labels: Object.fromEntries(p.all('label').map((l) => l.split('='))) });
    const steps = log.length + 4;
    if (!quiet) {
      out.print(`[+] Building ${(0.6 + log.filter((l) => !l.startsWith('CACHED')).length * 0.9 + (Date.now() - started) / 1000).toFixed(1)}s (${steps}/${steps}) FINISHED${' '.repeat(20)}${builder.driver === 'docker' ? 'docker:default' : `docker-container:${builder.name}`}`, 'ok');
      out.print(` => [internal] load build definition from ${fileName.split('/').pop()}\n => => transferring dockerfile: ${text.length}B`, 'dim');
      log.filter((l) => l.startsWith('[internal]')).forEach((l) => out.print(` => ${l}`, 'dim'));
      out.print(' => [internal] load .dockerignore\n => [internal] load build context', 'dim');
      log.filter((l) => !l.startsWith('[internal]')).forEach((l) => out.html(` => ${l.startsWith('CACHED') ? `<span class="ok">CACHED</span>${ctx.escape(l.slice(6))}` : ctx.escape(l)}`));
    }
    const destinations = p.get('output') || '';
    const push = p.has('push') || /push=true/.test(destinations);
    const load = builder.driver === 'docker' || p.has('load');
    if (push) {
      if (!tags.length) throw new CommandError('ERROR: tag is needed when pushing to registry');
      tags.forEach((t) => pushRef(t, { platforms: { list: platforms.length ? platforms : ['linux/amd64'], image: img }, quiet: true }));
      if (!quiet) out.print(` => pushing layers and manifest${platforms.length > 1 ? ` list (${platforms.join(', ')})` : ''} to ${tags.map((t) => ctx.registryKey(...splitRef(t))).join(', ')}`, 'dim');
    }
    if (!load && !push) {
      out.warn('WARNING: No output specified with docker-container driver. Build result will only remain in the build cache.\nTo push result image into registry use --push or to load image into docker use --load');
      return;
    }
    if (load) {
      if (!quiet) out.print(` => exporting to image\n => => writing image sha256:${img.id}`, 'dim');
      if (tags.length) tags.forEach((t, i) => { const [repo, tag] = splitRef(t); ctx.addImage(i === 0 ? Object.assign(img, { repo: cleanRepo(repo), tag }) : { ...img, repo: cleanRepo(repo), tag }); if (!quiet) out.print(` => => naming to docker.io/${repo.includes('/') ? '' : 'library/'}${refOf(repo, tag)}`, 'ok'); });
      else ctx.addImage(img);
      ctx.ev('image', 'tag', `sha256:${img.id}`, { name: tags[0] || '' });
      ctx.W.events.add('build');
      if (quiet) out.print(`sha256:${img.id}`);
      if (!tags.length && !quiet) out.note('(no -t given, so the image is untagged — it shows as <none> in docker images. Add -t myapp:1.0 to name it.)');
    }
  };
  CMDS.build = (args) => runBuild(args);

  // ---------- buildx / builder ----------
  const bootstrap = (b) => {
    if (b.status === 'running') return;
    const ref = 'moby/buildkit:buildx-stable-1';
    if (!ctx.findImage(ref)) ctx.addImage(ctx.makeImage({ repo: 'moby/buildkit', tag: 'buildx-stable-1', mb: 210, kind: 'server', cfg: { cmd: ['buildkitd'], entrypoint: null, env: {}, workdir: '/', user: '', expose: [], labels: {}, stopSignal: 'SIGTERM' } }));
    out.print(`[+] Building 2.1s (1/1) FINISHED\n => [internal] booting buildkit\n => => pulling image ${ref}\n => => creating container buildx_buildkit_${b.name}0`, 'dim');
    const o = ctx.parseRunOptions(['--privileged', '--name', `buildx_buildkit_${b.name}0`, ref], 'docker run');
    const c = ctx.createContainer(o, ctx.findImage(ref));
    c.kind = 'server';
    ctx.startContainer(c);
    b.status = 'running';
  };
  const builderTable = () => out.table(['NAME/NODE', 'DRIVER/ENDPOINT', 'STATUS', 'BUILDKIT', 'PLATFORMS'], ctx.D().builders.flatMap((b) => [
    [`${b.name}${b.name === ctx.D().builder ? '*' : ''}`, b.driver, '', '', ''],
    [` \\_ ${b.name}${b.driver === 'docker' ? '' : '0'}`, b.driver === 'docker' ? ' \\_ default' : ' \\_ unix:///var/run/docker.sock', b.status, b.status === 'running' ? 'v0.17.0' : '', b.status === 'running' || b.driver === 'docker' ? b.platforms.join(', ') : ''],
  ]));
  const pruneCache = (p) => {
    const n = ctx.D().buildCache.size;
    if (!p.has('force')) out.warn('WARNING! This will remove all dangling build cache. Are you sure you want to continue? [y/N] y   (auto-answered — add -f to skip)');
    ctx.D().buildCache.clear();
    ctx.W.events.add('prune');
    out.print(`Total:\t${n ? `${(n * 12.4).toFixed(1)}MB` : '0B'}`);
  };
  CMDS.buildx = ([sub, ...rest]) => {
    const d = ctx.D();
    switch (sub) {
      case 'build': case 'b': return runBuild(rest, { buildx: true });
      case 'ls': return builderTable();
      case 'version': return out.print('github.com/docker/buildx v0.18.0 (playground)');
      default: break;
    }
    if (sub === 'create') {
      const p = parseArgs(rest, flagSpec('use bootstrap append leave', 'name driver platform driver-opt buildkitd-flags node'), { command: 'docker buildx create' });
      const driver = p.get('driver', 'docker-container');
      if (!['docker-container', 'kubernetes', 'remote'].includes(driver)) throw new CommandError(`ERROR: failed to find driver "${driver}" (use docker-container, kubernetes or remote)`);
      const name = p.get('name') || ['amazing', 'brave', 'clever', 'eager'][d.builders.length % 4] + '_' + ['hopper', 'curie', 'turing', 'bose'][d.builders.length % 4];
      if (d.builders.some((b) => b.name === name)) throw new CommandError(`ERROR: existing instance for "${name}" but no append mode, specify the node name to make changes for existing instances`);
      const b = { name, driver, status: 'inactive', platforms: p.get('platform') ? p.get('platform').split(',') : CONTAINER_PLATFORMS, nodes: 1 };
      d.builders.push(b);
      if (p.has('use')) d.builder = name;
      if (p.has('bootstrap')) bootstrap(b);
      return out.print(name);
    }
    if (sub === 'use') {
      const name = rest.find((r) => !r.startsWith('-'));
      if (!d.builders.some((b) => b.name === name)) throw new CommandError(`ERROR: run \`docker buildx create --name ${name}\` first — no builder "${name}" found`);
      d.builder = name;
      return;
    }
    if (sub === 'inspect') {
      const p = parseArgs(rest, flagSpec('bootstrap'), { command: 'docker buildx inspect' });
      const b = d.builders.find((x) => x.name === (p.pos[0] || d.builder));
      if (!b) throw new CommandError(`ERROR: no builder "${p.pos[0]}" found`);
      if (p.has('bootstrap')) bootstrap(b);
      return out.print(`Name:          ${b.name}\nDriver:        ${b.driver}\nLast Activity: ${new Date().toUTCString()}\n\nNodes:\nName:                  ${b.name}${b.driver === 'docker' ? '' : '0'}\nEndpoint:              ${b.driver === 'docker' ? 'default' : 'unix:///var/run/docker.sock'}\nStatus:                ${b.status}\nBuildKit version:      ${b.status === 'running' ? 'v0.17.0' : ''}\nPlatforms:             ${b.status === 'running' || b.driver === 'docker' ? b.platforms.join(', ') : ''}`);
    }
    if (sub === 'rm') {
      const name = rest.find((r) => !r.startsWith('-')) || d.builder;
      if (name === 'default') throw new CommandError('ERROR: default is a built-in builder and cannot be removed');
      const b = d.builders.find((x) => x.name === name);
      if (!b) throw new CommandError(`ERROR: no builder "${name}" found`);
      d.builders.splice(d.builders.indexOf(b), 1);
      const c = ctx.findCtr(`buildx_buildkit_${name}0`);
      if (c) { ctx.stopContainer(c, { signal: 'SIGKILL' }); ctx.removeContainer(c); }
      if (d.builder === name) d.builder = 'default';
      return out.print(`${name} removed`);
    }
    if (sub === 'du') {
      const n = d.buildCache.size;
      out.table(['ID', 'RECLAIMABLE', 'SIZE', 'LAST ACCESSED'], [...d.buildCache].slice(-6).map((k) => [`${k}${hex(16)}`, 'true', '12.4MB', 'About a minute ago']));
      return out.print(`Shared:\t\t0B\nPrivate:\t${(n * 12.4).toFixed(1)}MB\nReclaimable:\t${(n * 12.4).toFixed(1)}MB\nTotal:\t\t${(n * 12.4).toFixed(1)}MB`);
    }
    if (sub === 'prune') return pruneCache(parseArgs(rest, flagSpec('all:a force:f verbose', 'filter keep-storage'), { command: 'docker buildx prune' }));
    if (sub === 'imagetools') {
      if (rest[0] !== 'inspect') throw new CommandError('Usage:  docker buildx imagetools inspect NAME');
      return manifestList(rest.slice(1).find((r) => !r.startsWith('-')), { pretty: true });
    }
    if (sub === 'bake') return bake(rest);
    throw new CommandError('Usage:  docker buildx COMMAND\n\nCommands: bake, build, create, du, imagetools, inspect, ls, prune, rm, use, version');
  };
  const bake = (rest) => {
    const targets = rest.filter((r) => !r.startsWith('-'));
    const svc = targets.length ? targets : ['api'];
    svc.forEach((s) => {
      if (s !== 'api') throw new CommandError(`ERROR: failed to find target "${s}" (compose.yaml only builds: api)`);
      out.note('(bake reads compose.yaml and builds every service that has a build: section)');
      runBuild(['-t', 'project-api', '.']);
    });
  };
  CMDS.builder = ([sub, ...rest]) => {
    switch (sub) {
      case 'prune': return pruneCache(parseArgs(rest, flagSpec('all:a force:f', 'filter keep-storage'), { command: 'docker builder prune' }));
      case 'ls': return builderTable();
      case 'build': return runBuild(rest);
      default: throw new CommandError('Usage:  docker builder COMMAND\n\nCommands: build, ls, prune');
    }
  };

  // ---------- manifests ----------
  const manifestList = (ref, { pretty = false } = {}) => {
    if (!ref) throw new CommandError('"docker manifest inspect" requires an image reference.\nUsage:  docker manifest inspect NAME[:TAG]');
    const [repo, tag] = splitRef(ref);
    const clean = cleanRepo(repo);
    const remote = W().registry.get(ctx.registryKey(clean, tag));
    const info = hubInfo(clean);
    if (!remote && !info) throw new CommandError(`no such manifest: docker.io/${clean}:${tag}\n(manifest inspect reads the registry, not your local images — push it first)`);
    const platforms = remote ? remote.platforms : info.platforms;
    const manifests = platforms.map((pl) => { const [os, architecture, variant] = pl.split('/'); return { mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 1795, digest: `sha256:${seededHex(clean + tag + pl)}`, platform: { architecture, os, ...(variant ? { variant } : {}) } }; });
    if (!pretty) return out.print(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests }, null, 3));
    out.print(`Name:      docker.io/${clean.includes('/') ? '' : 'library/'}${clean}:${tag}\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    sha256:${seededHex(clean + tag)}\n\nManifests:`);
    manifests.forEach((m) => out.print(`  Name:        docker.io/${clean}:${tag}@${m.digest.slice(0, 19)}…\n  MediaType:   ${m.mediaType}\n  Platform:    ${[m.platform.os, m.platform.architecture, m.platform.variant].filter(Boolean).join('/')}\n`));
  };
  CMDS.manifest = ([sub, ...rest]) => {
    if (sub !== 'inspect') throw new CommandError('Usage:  docker manifest inspect [OPTIONS] NAME[:TAG]\n(create/push/annotate are legacy — buildx build --platform … --push makes manifest lists for you)');
    manifestList(rest.find((r) => !r.startsWith('-')));
  };

  // ---------- scout (sample data) ----------
  const scoutCounts = (ref) => {
    const img = ctx.findImage(ref);
    const source = img?.base || ref;
    const [repo, tag] = splitRef(source);
    const clean = cleanRepo(repo);
    return SCOUT[/alpine/.test(tag) && SCOUT[`${clean}:alpine`] ? `${clean}:alpine` : clean] || [0, 1, 2, 5];
  };
  const fmtCounts = ([c, hh, m, l]) => `${c}C ${hh}H ${m}M ${l}L`;
  CMDS.scout = ([sub, ...rest]) => {
    const ref = rest.find((r, i) => !r.startsWith('-') && !/^--(only-severity|to|format)$/.test(rest[i - 1] || ''));
    if (!['quickview', 'qv', 'cves', 'recommendations', 'version', 'compare'].includes(sub)) throw new CommandError('Usage:  docker scout COMMAND\n\nCommands: quickview, cves, recommendations, compare, version');
    if (sub === 'version') return out.print('version: v1.15.0 (playground)');
    if (!ref) throw new CommandError(`"docker scout ${sub}" needs an image, e.g. docker scout ${sub} nginx`);
    if (!ctx.findImage(ref) && !hubInfo(cleanRepo(splitRef(ref)[0]))) throw new CommandError(`ERROR: image "${ref}" not found locally or on the playground's Docker Hub`);
    const counts = scoutCounts(ref);
    const img = ctx.findImage(ref);
    out.note('(sample data — real docker scout queries a live vulnerability database)');
    if (sub === 'quickview' || sub === 'qv') {
      out.print(`    ✓ SBOM of image already cached, ${120 + counts[3]} packages indexed\n\n  Target     │  ${ref.padEnd(20)} │  ${fmtCounts(counts)}\n    digest   │  ${hex(12)}\n  Base image │  ${img?.base || ref}\n`);
      if (counts[0] + counts[1] > 0) out.print('What\'s next:\n    View vulnerabilities → docker scout cves ' + ref + '\n    View base image update recommendations → docker scout recommendations ' + ref);
      return;
    }
    if (sub === 'cves') {
      const only = (rest.find((r) => r.startsWith('--only-severity'))?.split('=')[1] || rest[rest.indexOf('--only-severity') + 1] || '').split(',').filter(Boolean);
      const sev = ['critical', 'high', 'medium', 'low'];
      out.print(`    ✓ Detected ${counts.reduce((a, b) => a + b, 0)} vulnerable packages with a total of ${counts.reduce((a, b) => a + b, 0)} vulnerabilities\n`);
      sev.forEach((s, i) => {
        if ((only.length && !only.includes(s)) || !counts[i]) return;
        out.print(`   ${counts[i]}${s[0].toUpperCase()}  sample-package-${s} 1.2.${i}   (${s} severity — fixed in 1.2.${i + 1})`);
      });
      return out.print(`\n${counts.reduce((a, b) => a + b, 0)} vulnerabilities found${counts[0] + counts[1] ? ' — rebuild on a newer or smaller base (alpine, slim, distroless) to drop most of them' : ''}`);
    }
    if (sub === 'recommendations') {
      const base = (img?.base || ref).split(':')[0];
      return out.print(`  Recommended fixes for ${ref}\n\n  Base image is ${img?.base || ref}\n\n  ✓ Refresh base image: rebuild with --pull to get the latest patches\n  ✓ Change base image: ${base}:alpine  (smaller and ${fmtCounts(SCOUT[`${base}:alpine`] || [0, 0, 1, 1])})`);
    }
    return out.print(`  ## Overview\n  Analyzed image: ${ref}  ${fmtCounts(counts)}\n  Comparison image: ${rest.filter((r) => !r.startsWith('-'))[1] || '(add --to IMAGE)'}`);
  };

  // ---------- docker init ----------
  CMDS.init = () => {
    const files = ctx.F();
    out.print('Welcome to the Docker Init CLI!\n\nThis utility will walk you through creating the following files with sensible defaults for your project:\n  - .dockerignore\n  - Dockerfile\n  - compose.yaml\n  - README.Docker.md\n');
    if (files.has('Dockerfile') || files.has('compose.yaml')) {
      out.print('? The following Docker files already exist in this directory:\n  - Dockerfile\n  - compose.yaml\n  - .dockerignore\nDo you want to overwrite them? (y/N) N');
      return out.note('(your files are kept. Delete them first — rm Dockerfile compose.yaml — and run docker init again to see it generate new ones)');
    }
    out.print('? What application platform does your project use? Node\n? What version of Node do you want to use? 20\n? Which package manager do you want to use? npm\n? What command do you want to use to start the app? node server.js\n? What port does your server listen on? 3000\n');
    files.set('Dockerfile', '# syntax=docker/dockerfile:1\nARG NODE_VERSION=20\nFROM node:${NODE_VERSION}-alpine\nENV NODE_ENV production\nWORKDIR /usr/src/app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nUSER node\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]');
    files.set('compose.yaml', 'services:\n  server:\n    build:\n      context: .\n    environment:\n      NODE_ENV: production\n    ports:\n      - 3000:3000');
    files.set('.dockerignore', '**/.git\n**/node_modules\n**/.env\n*.tar\nREADME.Docker.md');
    files.set('README.Docker.md', '### Building and running your application\n\nWhen you\'re ready, start your application by running:\n`docker compose up --build`.');
    out.ok('✔ Created → .dockerignore\n✔ Created → Dockerfile\n✔ Created → compose.yaml\n✔ Created → README.Docker.md');
    out.print('\n→ Your Docker files are ready!\n  Take a moment to review them and tailor them to your application.\n\n  When you\'re ready, start your application by running: docker compose up --build');
  };

  // ---------- docker image … ----------
  CMDS.image = ([sub, ...rest], io) => {
    switch (sub) {
      case 'ls': case 'list': return CMDS.images(rest);
      case 'rm': case 'remove': return CMDS.rmi(rest);
      case 'inspect': return CMDS.inspect([...rest, '--type', 'image']);
      case 'prune': {
        const p = parseArgs(rest, flagSpec('all:a force:f', 'filter'), { command: 'docker image prune' });
        const all = p.has('all');
        if (!p.has('force')) out.warn(`WARNING! This will remove all ${all ? 'images without at least one container associated to them' : 'dangling images'}.\nAre you sure you want to continue? [y/N] y   (auto-answered — add -f to skip)`);
        const used = new Set(ctx.ctrs().map((c) => c.imageId));
        const gone = ctx.imageRows().filter((i) => !used.has(i.id) && (all || i.repo === '<none>'));
        gone.forEach((i) => ctx.D().images.splice(ctx.D().images.indexOf(i), 1));
        if (gone.length) out.print(`Deleted Images:\n${gone.map((i) => (i.repo === '<none>' ? `deleted: sha256:${i.id}` : `untagged: ${refOf(i.repo, i.tag)}`)).join('\n')}\n`);
        ctx.W.events.add('prune');
        return out.print(`Total reclaimed space: ${fmtSize([...new Map(gone.map((i) => [i.id, i.mb])).values()].reduce((a, b) => a + b, 0))}`);
      }
      case 'build': case 'history': case 'import': case 'load': case 'pull': case 'push': case 'save': case 'tag': return CMDS[sub](rest, io);
      default: throw new CommandError('Usage:  docker image COMMAND\n\nCommands: build, history, import, inspect, load, ls, prune, pull, push, rm, save, tag');
    }
  };

  ctx.runBuild = runBuild;
  ctx.pushRef = pushRef;
  ctx.plural = plural;
};
