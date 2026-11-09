// Animations for the lessons added with the command reference: debugging, snapshots,
// multi-platform builds, contexts, and stacks with secrets. Registered on ANIMATIONS.
import { h, wait, fly, flash, removeAnimated, escapeHtml } from './dom.js';
import { scene } from './components.js';
import { ANIMATIONS as A, helpers } from './animations.js';

const { mkTerm, out, typed, title, zone } = helpers;
const KIND = { A: 'ok', C: 'warn', D: 'bad' };

// =====================================================================
// Debugging: exec, cp, diff, inspect, events, rename, wait
// =====================================================================
A.debugTools = (root) => {
  const s = scene(root, { title: 'Look inside a running container', hint: 'Change files, copy files in and out, then ask <code>docker diff</code> what changed.' });
  const hostFiles = h('div', { class: 'chips' });
  const layers = h('div', { class: 'stack' });
  const rw = h('div', { class: 'rw-layer' });
  const nameEl = h('span', {}, 'web');
  const dot = h('span', { class: 'status-dot running' });
  const events = mkTerm({ height: '190px' });
  const term = mkTerm({ height: '120px' });
  ['debian base', 'nginx install', 'entrypoint', 'CMD nginx'].forEach((l) => layers.append(h('div', { class: 'layer ro-layer' }, `🔒 ${l}`)));
  const ctr = h('div', { class: 'node dbg-ctr' }, h('div', { class: 'node-title' }, dot, ' 📦 ', nameEl, h('small', {}, 'nginx')), h('div', { class: 'zone-title' }, 'writable layer (docker diff)'), rw, h('div', { class: 'zone-title', style: { marginTop: '8px' } }, 'image layers (read-only)'), layers);
  const host = zone('💻 your computer: ~/project', hostFiles);
  const evZone = h('div', { class: 'node' }, title('📡 docker events', 'every action is an event'), events);
  s.stage.append(h('div', { class: 'dbg-scene' }, host, ctr, evZone), term);

  let st = { name: 'web', running: true, changes: [], host: [], exitCode: 0 };
  const reset = () => {
    st = { name: 'web', running: true, changes: [['C', '/run'], ['A', '/run/nginx.pid'], ['A', '/var/cache/nginx/client_temp']], host: ['index.html', 'Dockerfile'], exitCode: 0 };
    nameEl.textContent = 'web';
    dot.className = 'status-dot running';
    events.replaceChildren();
    term.replaceChildren();
    render();
    ev('container', 'create');
    ev('container', 'start');
  };
  const render = () => {
    hostFiles.replaceChildren(...st.host.map((f) => h('span', { class: 'chip', 'data-f': f }, `📄 ${f}`)));
    rw.replaceChildren(...st.changes.map(([k, p]) => h('span', { class: `chip ${KIND[k]}`, 'data-p': p }, h('b', {}, k), ` ${p}`)));
  };
  const ev = (type, action, extra = '') => out(events, `<span class="dim">${new Date().toISOString().slice(11, 19)}</span> ${type} <span class="y">${action}</span> (name=${st.name}${extra})`);
  const change = (kind, path) => {
    st.changes = st.changes.filter(([, p]) => p !== path);
    st.changes.push([kind, path]);
    render();
    const el = rw.querySelector(`[data-p="${CSS.escape(path)}"]`);
    el?.classList.add('pop');
    return el;
  };
  const needsRunning = () => st.running;
  const notRunning = () => `${st.name} is stopped — <code>docker start ${st.name}</code> first.`;

  s.command([/^docker exec (\S+) (touch|mkdir -p|rm|rm -rf) (\/\S+)$/], async (_, m) => {
    if (m[1] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[1])}</span> — it is called <code>${st.name}</code>.`);
    typed(term, m.input);
    ev('container', `exec_start: ${m[2]} ${m[3]}`);
    const el = change(m[2].startsWith('rm') ? 'D' : 'A', m[3]);
    if (el) flash(el);
    s.say(m[2].startsWith('rm') ? `Deleting a file that came from the image does not touch the image — it is recorded as <b>D</b> in the writable layer.` : `New file → <b>A</b> in the writable layer. It disappears when the container is removed (unless it is in a volume).`);
  }, { enabled: needsRunning, why: notRunning, example: 'docker exec web touch /tmp/debug.log' });

  s.command([/^docker cp (?:\.\/)?(\S+) (\S+):(\/\S+)$/], async (_, m) => {
    if (m[2] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[2])}</span>`);
    if (!st.host.includes(m[1])) return s.say(`<span class="err">lstat ${escapeHtml(m[1])}: no such file or directory</span> — your folder has ${st.host.map((f) => `<code>${f}</code>`).join(', ')}.`);
    typed(term, m.input);
    const dst = m[3].endsWith('/') ? `${m[3]}${m[1]}` : m[3];
    await fly(s.stage, hostFiles.querySelector(`[data-f="${CSS.escape(m[1])}"]`), rw, { label: `📄 ${m[1]}`, cls: 'white' });
    change(dst.startsWith('/usr/share/nginx/html/index.html') ? 'C' : 'A', dst);
    out(term, `Successfully copied 0.03kB to ${st.name}:${m[3]}`);
    s.say(`Copied <b>into</b> the container's writable layer. ${dst.endsWith('index.html') ? 'nginx now serves your page — <b>C</b> because it replaced a file from the image.' : ''}`);
  }, { example: 'docker cp index.html web:/usr/share/nginx/html/' });

  s.command([/^docker cp (\S+):(\/\S+) (\S+)$/], async (_, m) => {
    if (m[1] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[1])}</span>`);
    typed(term, m.input);
    const file = m[2].split('/').pop();
    await fly(s.stage, ctr, hostFiles, { label: `📄 ${file}`, cls: 'white' });
    if (!st.host.includes(file)) st.host.push(file);
    render();
    hostFiles.querySelector(`[data-f="${CSS.escape(file)}"]`)?.classList.add('pop');
    out(term, `Successfully copied 1.2kB to /home/you/project/${file}`);
    s.say(`Copied <b>out</b> to your folder — handy for grabbing logs or a default config to edit. Works on stopped containers too.`);
  }, { example: 'docker cp web:/etc/nginx/nginx.conf .' });

  s.btn('docker diff web', async () => {
    typed(term, `docker diff ${st.name}`);
    [...rw.children].forEach((el) => flash(el));
    st.changes.slice().sort((a, b) => a[1].localeCompare(b[1])).forEach(([k, p]) => out(term, `<span class="${KIND[k] === 'warn' ? 'y' : KIND[k]}">${k}</span> ${escapeHtml(p)}`));
    s.say('<b>A</b> added · <b>C</b> changed · <b>D</b> deleted — compared with the image. Even an idle nginx writes a PID file and cache folders. This is how you find what should be a volume.');
  }, { mono: true, cmd: [new RegExp('^docker (?:container )?diff (\\S+)$')], example: 'docker diff web' });

  const FIELDS = () => ({ 'state.status': st.running ? 'running' : 'exited', 'state.exitcode': String(st.exitCode), restartcount: '0', 'networksettings.ipaddress': '172.17.0.2', 'config.image': 'nginx', name: `/${st.name}`, 'hostconfig.restartpolicy.name': 'no', 'config.env': '[PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NGINX_VERSION=1.27.2]' });
  s.command([/^docker inspect (?:-f|--format) ['"]?\{\{\s*\.([\w.]+)\s*\}\}['"]? (\S+)$/], async (_, m) => {
    typed(term, m.input);
    const v = FIELDS()[m[1]];
    out(term, v ?? '<no value>');
    flash(ctr);
    s.say(v ? `<code>--format</code> picks one field out of the big JSON — the standard way to script against Docker. Try <code>{{.State.Status}}</code>, <code>{{.NetworkSettings.IPAddress}}</code>, <code>{{.RestartCount}}</code>.` : 'That field is not in this demo — try <code>{{.State.Status}}</code> or <code>{{.NetworkSettings.IPAddress}}</code>.');
  }, { example: 'docker inspect -f "{{.State.Status}}" web' });
  s.command([/^docker inspect (\S+)$/], async (_, m) => {
    typed(term, m.input);
    out(term, `[{ "Name": "/${st.name}", "State": { "Status": "${FIELDS()['state.status']}", "ExitCode": ${st.exitCode} }, "NetworkSettings": { "IPAddress": "172.17.0.2" }, … 200 more lines … }]`);
    s.say('The full JSON is long. Use <code>-f "{{.Path.To.Field}}"</code> to pick one value.');
  }, { example: 'docker inspect web' });

  s.command([/^docker events(?: .*)?$/], async () => {
    flash(evZone);
    s.say('The events panel is <code>docker events</code>: create, start, exec, die, rename… — monitoring tools watch exactly this stream.');
  }, { example: 'docker events' });

  s.command([/^docker stop (\S+)$/], async (_, m) => {
    if (m[1] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[1])}</span>`);
    typed(term, m.input);
    st.running = false; st.exitCode = 0;
    dot.className = 'status-dot exited';
    ev('container', 'kill', ', signal=SIGQUIT'); ev('container', 'die', ', exitCode=0'); ev('container', 'stop');
    out(term, st.name);
    s.say('Stopped. The writable layer is <b>kept</b> — <code>docker diff</code> still shows your changes and <code>docker cp</code> still works.');
  }, { enabled: needsRunning, why: () => `${st.name} is already stopped.`, example: 'docker stop web' });
  s.command([/^docker start (\S+)$/], async (_, m) => {
    if (m[1] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[1])}</span>`);
    typed(term, m.input);
    st.running = true;
    dot.className = 'status-dot running';
    ev('container', 'start');
    out(term, st.name);
    s.say('Started again — same container, same files.');
  }, { enabled: () => !st.running, why: () => `${st.name} is already running.`, example: 'docker start web' });
  s.command([/^docker wait (\S+)$/], async (_, m) => {
    typed(term, m.input);
    if (st.running) return s.say(`<code>docker wait</code> would <b>block</b> until ${st.name} stops — scripts use it to wait for a job. Stop it, then wait again.`);
    out(term, String(st.exitCode));
    s.say('Prints the exit code. <code>0</code> = success.');
  }, { example: 'docker wait web' });
  s.command([/^docker rename (\S+) ([a-z0-9][\w.-]*)$/], async (_, m) => {
    if (m[1] !== st.name) return s.say(`<span class="err">No such container: ${escapeHtml(m[1])}</span>`);
    typed(term, m.input);
    const old = st.name;
    st.name = m[2];
    nameEl.textContent = m[2];
    flash(ctr);
    ev('container', 'rename', `, oldName=/${old}`);
    s.say(`Renamed — use <code>${m[2]}</code> from now on.`);
  }, { example: 'docker rename web site' });
  s.command([/^docker attach (\S+)$/], async (_, m) => {
    typed(term, m.input);
    ev('container', 'attach');
    out(term, '<span class="dim">(attached to nginx\'s output — Ctrl+C here would stop the container! Detach with Ctrl+P Ctrl+Q)</span>');
    s.say('<code>attach</code> connects to the <b>main process</b>; <code>exec</code> starts a new one. Prefer <code>logs -f</code> to just watch.');
  }, { enabled: needsRunning, why: notRunning, example: 'docker attach web' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};

// =====================================================================
// Snapshots: commit, save/load over scp, export/import
// =====================================================================
A.snapshots = (root) => {
  const s = scene(root, { title: 'Move images without a registry', hint: 'Snapshot a container, pack it into a tar file and carry it to an offline server.' });
  const laptopImgs = h('div', { class: 'img-col' });
  const serverImgs = h('div', { class: 'img-col' });
  const ctrBox = h('div', { class: 'ctr-card' }, h('div', { class: 'head' }, h('span', { class: 'status-dot running' }), 'web'), h('div', { class: 'rw' }, h('span', { class: 'file-chip' }, 'index.html ✎'), h('span', { class: 'file-chip' }, 'nginx.pid')));
  const tarSlot = h('div', { class: 'tar-slot' });
  const term = mkTerm({ height: '130px' });
  const laptop = h('div', { class: 'node' }, title('💻 laptop', 'has internet'), h('div', { class: 'zone-title' }, 'containers'), ctrBox, h('div', { class: 'zone-title', style: { marginTop: '8px' } }, 'images'), laptopImgs);
  const middle = h('div', { class: 'node tar-zone' }, title('📦 tar files', 'scp / USB'), tarSlot);
  const server = h('div', { class: 'node' }, title('🖥 server', 'no internet, no registry'), h('div', { class: 'zone-title' }, 'images'), serverImgs);
  s.stage.append(h('div', { class: 'snap-scene' }, laptop, middle, server), term);

  let st = { laptop: [], server: [], tars: {} };
  const imgEl = (img) => h('div', { class: 'mini-img pop', 'data-i': img.name },
    h('b', {}, img.name),
    h('div', { class: 'stack' }, ...img.layers.map((l, i) => h('div', { class: `layer ${i === img.layers.length - 1 && img.layers.length > 1 && img.committed ? 'app' : ''}` }, l))),
    h('small', {}, img.cmd ? `CMD ${img.cmd}` : '⚠ no CMD'));
  const render = () => {
    laptopImgs.replaceChildren(...st.laptop.map(imgEl));
    serverImgs.replaceChildren(...(st.server.length ? st.server.map(imgEl) : [h('div', { class: 'pg-empty' }, 'empty')]));
    tarSlot.replaceChildren(...(Object.keys(st.tars).length ? Object.entries(st.tars).map(([name, t]) => h('div', { class: `tarball ${t.where} pop`, 'data-t': name }, h('b', {}, `📦 ${name}`), h('small', {}, t.kind === 'images' ? `${t.img.layers.length} layers + tags + CMD` : 'flat file system — no layers, no CMD'), h('small', {}, t.where === 'server' ? 'on the server' : 'on the laptop'))) : [h('div', { class: 'pg-empty' }, 'no tar files yet')]));
  };
  const reset = () => {
    st = { laptop: [{ name: 'nginx:1.27', layers: ['debian', 'nginx', 'entrypoint'], cmd: 'nginx' }], server: [], tars: {} };
    term.replaceChildren();
    render();
  };
  const find = (list, name) => list.find((i) => i.name === name || i.name === `${name}:latest`);

  s.btn('docker commit web mynginx:v1', async (_, m) => {
    const name = (m?.[1] || 'mynginx:v1').includes(':') ? m?.[1] || 'mynginx:v1' : `${m[1]}:latest`;
    typed(term, `docker commit web ${name}`);
    await fly(s.stage, ctrBox, laptopImgs, { label: '✎ writable layer', cls: 'white' });
    st.laptop = st.laptop.filter((i) => i.name !== name);
    st.laptop.push({ name, layers: ['debian', 'nginx', 'entrypoint', 'your changes'], cmd: 'nginx', committed: true });
    render();
    out(term, 'sha256:4f1c…');
    s.say(`The container's writable layer became a <b>new top layer</b>. <code>${name}</code> = nginx + your edited index.html. (For real images prefer a Dockerfile — it is repeatable.)`);
  }, { mono: true, cmd: [/^docker commit (?:-m \S+ )?web ([a-z0-9][\w./-]*(?::[\w.-]+)?)$/], example: 'docker commit web mynginx:v1' });

  s.btn('docker save -o app.tar mynginx:v1', async (_, m) => {
    const file = m?.[1] || 'app.tar', ref = m?.[2] || 'mynginx:v1';
    const img = find(st.laptop, ref);
    if (!img) return s.say(`<span class="err">No such image: ${escapeHtml(ref)}</span> — commit it first.`);
    typed(term, `docker save -o ${file} ${img.name}`);
    await fly(s.stage, laptopImgs.querySelector(`[data-i="${CSS.escape(img.name)}"]`) || laptopImgs, tarSlot, { label: '📦', cls: 'white' });
    st.tars[file] = { kind: 'images', img, where: 'laptop' };
    render();
    s.say(`<code>${file}</code> holds <b>everything</b>: every layer, the tag and the config (CMD, ENV…).`);
  }, { mono: true, cmd: [/^docker save -o (\S+\.tar) (\S+)$/], example: 'docker save -o app.tar mynginx:v1' });

  s.command([/^scp (\S+\.tar) server:\S*$/], async (_, m) => {
    const t = st.tars[m[1]];
    if (!t) return s.say(`<span class="err">scp: ${escapeHtml(m[1])}: No such file</span>`);
    typed(term, m.input);
    await fly(s.stage, tarSlot, server, { label: `📦 ${m[1]}`, cls: 'white', ms: 1100 });
    t.where = 'server';
    render();
    out(term, `${m[1]}                    100%  195MB  42.0MB/s   00:04`);
    s.say('The tar file is now on the server — no registry and no internet needed.');
  }, { enabled: () => Object.keys(st.tars).length > 0, why: 'Make a tar file first: <code>docker save -o app.tar mynginx:v1</code>', example: 'scp app.tar server:' });

  s.command([/^ssh server docker load (?:-i |< )(\S+\.tar)$/], async (_, m) => {
    const t = st.tars[m[1]];
    if (!t || t.where !== 'server') return s.say(`<span class="err">open ${escapeHtml(m[1])}: no such file or directory</span> — copy it to the server first with <code>scp</code>.`);
    typed(term, m.input);
    if (t.kind !== 'images') {
      out(term, '<span class="bad">Error processing tar file: open …/repositories: no such file or directory</span>');
      return s.say('That tar came from <code>docker export</code> — a flat file system, not an image. <code>load</code> needs a <code>save</code> tar; use <code>docker import</code> for this one.');
    }
    st.server = st.server.filter((i) => i.name !== t.img.name);
    st.server.push({ ...t.img });
    render();
    out(term, `Loaded image: ${t.img.name}`);
    s.say(`The server has <b>${t.img.name}</b> with all ${t.img.layers.length} layers and its CMD — identical to the laptop's.`);
  }, { example: 'ssh server docker load -i app.tar' });

  s.btn('docker export web -o fs.tar', async (_, m) => {
    const file = m?.[1] || m?.[2] || 'fs.tar';
    typed(term, `docker export web -o ${file}`);
    await fly(s.stage, ctrBox, tarSlot, { label: '🗂', cls: 'white' });
    st.tars[file] = { kind: 'fs', where: 'laptop' };
    render();
    s.say('<code>export</code> flattens the <b>container\'s</b> whole file system into one tar: no layers, no history, no CMD, no ENV.');
  }, { mono: true, cmd: [/^docker export (?:-o (\S+\.tar) web|web -o (\S+\.tar))$/], example: 'docker export web -o fs.tar' });

  s.command([/^docker import (\S+\.tar) ([a-z0-9][\w./-]*(?::[\w.-]+)?)$/], async (_, m) => {
    const t = st.tars[m[1]];
    if (!t) return s.say(`<span class="err">open ${escapeHtml(m[1])}: no such file or directory</span>`);
    typed(term, m.input);
    const name = m[2].includes(':') ? m[2] : `${m[2]}:latest`;
    st.laptop = st.laptop.filter((i) => i.name !== name);
    st.laptop.push({ name, layers: ['everything (1 layer)'], cmd: null });
    render();
    out(term, 'sha256:9ab2…');
    s.say(`<code>${name}</code> has a <b>single layer</b> and <b>no CMD</b>${t.kind === 'images' ? ' — and you imported a save tar, which import treats as plain files!' : ''}. Add one while importing: <code>--change 'CMD ["nginx","-g","daemon off;"]'</code>.`);
  }, { example: 'docker import fs.tar flat:v1' });

  s.command([/^docker run (?:-d )?(\S+)$/], async (_, m) => {
    typed(term, m.input);
    const img = find(st.laptop, m[1]);
    if (!img) return out(term, `<span class="bad">Unable to find image '${escapeHtml(m[1])}' locally (and this laptop is in demo mode)</span>`);
    if (!img.cmd) { out(term, '<span class="bad">docker: Error response from daemon: no command specified.</span>'); return s.say('Imported images have no CMD — that is the big difference between <b>save/load</b> (keeps everything) and <b>export/import</b> (files only).'); }
    out(term, 'a81c…  (running)');
    s.say(`Runs fine: <code>${img.name}</code> kept its CMD.`);
  }, { example: 'docker run flat:v1' });

  s.command([/^(?:ssh server )?docker history (\S+)$/], async (_, m) => {
    typed(term, m.input);
    const img = find(m.input.startsWith('ssh') ? st.server : st.laptop, m[1]);
    if (!img) return out(term, `<span class="bad">No such image: ${escapeHtml(m[1])}</span>`);
    [...img.layers].reverse().forEach((l, i) => out(term, `${i ? '&lt;missing&gt;' : 'a1b2c3'}   ${escapeHtml(l)}`));
    s.say(`${img.layers.length} layer${img.layers.length > 1 ? 's' : ''}.`);
  }, { example: 'docker history flat:v1' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};

// =====================================================================
// Multi-platform builds with buildx and manifest lists
// =====================================================================
A.multiArch = (root) => {
  const s = scene(root, { title: 'One tag, many CPUs', hint: 'Build for amd64 and arm64, push one tag, and let each machine pull its own variant.' });
  const ALL = ['linux/amd64', 'linux/arm64', 'linux/arm/v7'];
  const builderEl = h('div', { class: 'node' });
  const manifest = h('div', { class: 'manifest' });
  const machines = [
    { key: 'laptop', label: '💻 laptop', arch: 'linux/amd64', host: 'laptop' },
    { key: 'mac', label: '🍎 Mac M3', arch: 'linux/arm64', host: 'mac' },
    { key: 'pi', label: '🍓 Raspberry Pi', arch: 'linux/arm/v7', host: 'pi' },
  ].map((m) => ({ ...m, img: h('div', { class: 'chips' }), el: null }));
  machines.forEach((m) => { m.el = h('div', { class: 'node machine' }, title(m.label, m.arch), m.img); });
  const term = mkTerm({ height: '130px' });
  const registry = h('div', { class: 'node' }, title('☁ registry: you/app:1.0', 'manifest list'), manifest);
  s.stage.append(h('div', { class: 'arch-scene' }, builderEl, registry, h('div', { class: 'machines' }, machines.map((m) => m.el))), term);

  let st = { builder: { name: 'default', driver: 'docker' }, pushed: [] };
  const renderBuilder = () => {
    const b = st.builder;
    builderEl.replaceChildren(title('🏗 builder', b.name),
      h('div', { class: 'chips' }, h('span', { class: `chip ${b.driver === 'docker' ? '' : 'blue'}` }, `driver: ${b.driver}`)),
      h('div', { class: 'zone-title', style: { marginTop: '8px' } }, 'can build'),
      h('div', { class: 'chips' }, ...(b.driver === 'docker' ? ['linux/amd64'] : ALL).map((p) => h('span', { class: 'chip light' }, p))));
  };
  const renderManifest = () => manifest.replaceChildren(...(st.pushed.length ? st.pushed.map((p) => h('div', { class: 'mf-row pop', 'data-p': p }, h('code', {}, p), h('small', {}, `sha256:${p.length}${p.charCodeAt(6)}a…`))) : [h('div', { class: 'pg-empty' }, 'nothing pushed yet')]));
  const reset = () => {
    st = { builder: { name: 'default', driver: 'docker' }, pushed: [] };
    machines.forEach((m) => m.img.replaceChildren(h('span', { class: 'pg-empty' }, 'no image')));
    term.replaceChildren();
    renderBuilder();
    renderManifest();
  };

  s.command([/^docker buildx create(?: --name (\S+))?(?: --driver docker-container)?(?: --use)?(?: --bootstrap)?$/], async (_, m) => {
    typed(term, m.input);
    st.builder = { name: m[1] || 'multi', driver: 'docker-container' };
    renderBuilder();
    flash(builderEl);
    out(term, st.builder.name);
    s.say(`A <b>docker-container</b> builder runs BuildKit in a container with QEMU, so it can build for <b>other CPUs</b>.${/--use/.test(m.input) ? '' : ' Add <code>--use</code> (or run <code>docker buildx use</code>) to make it the current builder.'}`);
  }, { example: 'docker buildx create --name multi --use' });
  s.command([/^docker buildx use (default|multi|\S+)$/], async (_, m) => {
    typed(term, m.input);
    st.builder = m[1] === 'default' ? { name: 'default', driver: 'docker' } : { name: m[1], driver: 'docker-container' };
    renderBuilder();
    s.say(`Current builder: <b>${m[1]}</b>.`);
  }, { example: 'docker buildx use default' });
  s.command([/^docker buildx ls$/], async () => {
    typed(term, 'docker buildx ls');
    out(term, `NAME        DRIVER             PLATFORMS\n${st.builder.driver === 'docker' ? 'default*' : 'default '}    docker             linux/amd64${st.builder.driver !== 'docker' ? `\n${st.builder.name}*      docker-container   ${ALL.join(', ')}` : ''}`);
  }, { example: 'docker buildx ls' });

  s.command([/^docker buildx build --platform ([\w/,]+) -t you\/app:1\.0 --push \.$/], async (_, m) => {
    typed(term, m.input);
    const plats = m[1].split(',');
    const bad = plats.find((p) => !ALL.includes(p));
    if (bad) return out(term, `<span class="bad">ERROR: failed to solve: no match for platform in manifest: ${escapeHtml(bad)}</span>`);
    if (st.builder.driver === 'docker' && plats.length > 1) {
      flash(builderEl, 'shake');
      out(term, '<span class="bad">ERROR: Multi-platform build is not supported for the docker driver.</span>');
      return s.say('The default <b>docker</b> driver builds one platform at a time. Create a capable builder: <code>docker buildx create --name multi --use</code>.');
    }
    for (const p of plats) {
      out(term, ` => [${p}] building…`);
      await fly(s.stage, builderEl, registry, { label: `🧱 ${p.replace('linux/', '')}`, cls: 'white', ms: 800 });
      if (!st.pushed.includes(p)) st.pushed.push(p);
      renderManifest();
    }
    out(term, ` => pushing manifest list for you/app:1.0 <span class="ok">done</span>`);
    s.say(`One tag, <b>${st.pushed.length}</b> image${st.pushed.length > 1 ? 's' : ''}: the registry stores a <b>manifest list</b> that maps each platform to its own image. Now pull it on each machine.`);
  }, { example: 'docker buildx build --platform linux/amd64,linux/arm64 -t you/app:1.0 --push .' });

  machines.forEach((mc) => {
    s.btn(`pull on ${mc.key}`, async () => {
      typed(term, `${mc.key === 'laptop' ? '' : `ssh ${mc.host} `}docker pull you/app:1.0`);
      if (!st.pushed.length) { out(term, '<span class="bad">pull access denied: repository does not exist</span>'); return s.say('Nothing has been pushed to <code>you/app:1.0</code> yet — build and push it first.'); }
      if (!st.pushed.includes(mc.arch)) {
        flash(mc.el, 'shake');
        out(term, `<span class="bad">no matching manifest for ${mc.arch} in the manifest list entries</span>`);
        return s.say(`${mc.label} has a <b>${mc.arch}</b> CPU, but nobody built that variant. Add it to <code>--platform</code> and build again.`);
      }
      const row = manifest.querySelector(`[data-p="${CSS.escape(mc.arch)}"]`);
      flash(row);
      await fly(s.stage, row, mc.el, { label: `🧱 ${mc.arch.replace('linux/', '')}`, cls: 'white' });
      mc.img.replaceChildren(h('span', { class: 'chip ok pop' }, `you/app:1.0 (${mc.arch.replace('linux/', '')})`));
      out(term, 'Status: Downloaded newer image for you/app:1.0');
      s.say(`Same command, same tag — Docker picked the <b>${mc.arch}</b> entry from the manifest list automatically.`);
    }, { mono: true, cmd: [mc.key === 'laptop' ? /^docker pull you\/app:1\.0$/ : new RegExp(`^ssh ${mc.host} docker pull you/app:1\\.0$`)], example: `${mc.key === 'laptop' ? '' : `ssh ${mc.host} `}docker pull you/app:1.0` });
  });
  s.command([/^docker (?:manifest|buildx imagetools) inspect you\/app:1\.0$/], async (_, m) => {
    typed(term, m.input);
    if (!st.pushed.length) return out(term, '<span class="bad">no such manifest: docker.io/you/app:1.0</span>');
    out(term, `{ "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [\n${st.pushed.map((p) => `   { "platform": { "os": "linux", "architecture": "${p.split('/')[1]}"${p.split('/')[2] ? `, "variant": "${p.split('/')[2]}"` : ''} } }`).join(',\n')}\n] }`);
    flash(registry);
    s.say('The manifest list: one entry per platform. This is what <code>docker pull</code> reads first.');
  }, { example: 'docker manifest inspect you/app:1.0' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};

// =====================================================================
// Contexts: one CLI, many engines
// =====================================================================
A.contexts = (root) => {
  const s = scene(root, { title: 'docker context: point your CLI at another engine', hint: 'Create a context for a server, switch to it and run containers there — from your laptop.' });
  const cli = h('div', { class: 'node cli-box' }, title('⌨️ docker CLI', 'on your laptop'), h('div', { class: 'chips' }));
  const engines = {};
  const term = mkTerm({ height: '120px' });
  const enginesEl = h('div', { class: 'engines' });
  s.stage.append(h('div', { class: 'ctx-scene' }, cli, enginesEl), term);
  let st = { contexts: ['default'], current: 'default', n: 0 };
  const addEngine = (name, label) => {
    const box = h('div', { class: 'chips' });
    const el = h('div', { class: 'node engine pop' }, title(label, name), box);
    engines[name] = { el, box, ctrs: [] };
    enginesEl.append(el);
  };
  const render = () => {
    cli.querySelector('.chips').replaceChildren(...st.contexts.map((c) => h('span', { class: `chip ${c === st.current ? 'blue' : ''}` }, `${c === st.current ? '● ' : ''}${c}`)));
    Object.entries(engines).forEach(([name, e]) => {
      e.el.classList.toggle('active', name === st.current);
      e.box.replaceChildren(...(e.ctrs.length ? e.ctrs.map((c) => h('span', { class: 'chip ok' }, `📦 ${c}`)) : [h('span', { class: 'pg-empty' }, 'no containers')]));
    });
  };
  const reset = () => {
    enginesEl.replaceChildren();
    Object.keys(engines).forEach((k) => delete engines[k]);
    addEngine('default', '💻 local engine');
    engines.default.ctrs = ['dev-db'];
    st = { contexts: ['default'], current: 'default', n: 0 };
    term.replaceChildren();
    render();
  };
  s.command([/^docker context create (\w[\w-]*) --docker (?:"|')?host=ssh:\/\/[\w.-]+@([\w.-]+)(?:"|')?$/], async (_, m) => {
    if (st.contexts.includes(m[1])) return s.say(`<span class="err">context "${escapeHtml(m[1])}" already exists</span>`);
    typed(term, m.input);
    st.contexts.push(m[1]);
    addEngine(m[1], `🖥 ${m[2]}`);
    render();
    out(term, `Successfully created context "${m[1]}"`);
    s.say(`Saved how to reach <b>${m[2]}</b> over SSH. Nothing is switched yet — <code>docker context use ${m[1]}</code>.`);
  }, { example: 'docker context create prod --docker host=ssh://you@prod-server' });
  s.command([/^docker context use (\S+)$/], async (_, m) => {
    if (!st.contexts.includes(m[1])) return s.say(`<span class="err">context "${escapeHtml(m[1])}" does not exist</span> — create it first.`);
    typed(term, m.input);
    st.current = m[1];
    render();
    await fly(s.stage, cli, engines[m[1]].el, { cls: 'dot' });
    out(term, `Current context is now "${m[1]}"`);
    s.say(`Every docker command now goes to <b>${m[1]}</b>. Check with <code>docker context show</code> before doing anything destructive!`);
  }, { example: 'docker context use prod' });
  s.command([/^docker (?:--context (\S+) )?ps$/], async (_, m) => {
    const target = m[1] || st.current;
    if (!engines[target]) return s.say(`<span class="err">context "${escapeHtml(target)}" does not exist</span>`);
    typed(term, m.input);
    await fly(s.stage, cli, engines[target].el, { cls: 'dot', ms: 600 });
    out(term, `NAMES\n${engines[target].ctrs.join('\n') || '(none)'}`);
    s.say(m[1] ? `<code>--context</code> runs <b>one</b> command elsewhere without switching.` : `You see the containers of <b>${target}</b>.`);
  }, { example: 'docker ps' });
  s.command([/^docker (?:--context (\S+) )?run -d (?:--name (\S+) )?(\S+)$/], async (_, m) => {
    const target = m[1] || st.current;
    if (!engines[target]) return s.say(`<span class="err">context "${escapeHtml(target)}" does not exist</span>`);
    typed(term, m.input);
    const name = m[2] || `${m[3].split(':')[0]}-${++st.n}`;
    await fly(s.stage, cli, engines[target].el, { label: '📦', cls: 'white' });
    engines[target].ctrs.push(name);
    render();
    out(term, 'b7e1…');
    s.say(`The container runs on <b>${target}</b> — the image is pulled there, not on your laptop.`);
  }, { example: 'docker run -d --name site nginx' });
  s.command([/^docker context (?:ls|list)$/], async () => {
    typed(term, 'docker context ls');
    out(term, st.contexts.map((c) => `${c}${c === st.current ? ' *' : ''}`).join('\n'));
    s.say('The <code>*</code> marks the current context.');
  }, { example: 'docker context ls' });
  s.command([/^docker context show$/], async () => { typed(term, 'docker context show'); out(term, st.current); s.say(`You are talking to <b>${st.current}</b>.`); }, { example: 'docker context show' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};

// =====================================================================
// Stacks with secrets
// =====================================================================
A.stackSecrets = (root) => {
  const s = scene(root, { title: 'docker stack deploy with a secret', hint: 'Create the secret, deploy the stack, and see which tasks get it.' });
  const vault = h('div', { class: 'chips' });
  const vaultEl = h('div', { class: 'node vault' }, title('🔐 swarm secrets', 'encrypted in the managers\' Raft log'), vault);
  const nodeNames = ['manager', 'worker-1', 'worker-2'];
  const nodes = Object.fromEntries(nodeNames.map((n) => {
    const slots = h('div', { class: 'slots' });
    return [n, { slots, el: h('div', { class: 'swarm-node' }, title(`🖥 ${n}`, n === 'manager' ? 'manager' : 'worker'), slots) }];
  }));
  const fileChip = h('span', { class: 'chip' }, '📄 stack.yaml: web ×3 · cache · db (needs db_password)');
  const term = mkTerm({ height: '130px' });
  s.stage.append(h('div', { class: 'chips', style: { marginBottom: '10px' } }, fileChip), vaultEl, h('div', { class: 'swarm-nodes', style: { marginTop: '12px' } }, nodeNames.map((n) => nodes[n].el)), term);
  let st = { secret: false, deployed: false, tasks: [], ver: '1.26', prev: null };
  const render = () => {
    vault.replaceChildren(...(st.secret ? [h('span', { class: 'chip warn pop' }, '🔒 db_password  (value hidden)')] : [h('span', { class: 'pg-empty' }, 'no secrets')]));
    nodeNames.forEach((n) => nodes[n].slots.replaceChildren(...st.tasks.filter((t) => t.node === n).map((t) => {
      t.el = h('div', { class: `task ${t.ver === '1.27' ? 'v2' : ''}`, 'data-id': t.id }, t.name, h('small', {}, t.svc === 'web' ? `nginx:${t.ver}` : t.svc === 'db' ? 'postgres' : 'redis'), t.secret ? h('small', {}, '🔒 /run/secrets') : null);
      return t.el;
    })));
  };
  const reset = () => { st = { secret: false, deployed: false, tasks: [], ver: '1.26', prev: null }; term.replaceChildren(); render(); };
  const plan = () => [
    { svc: 'web', node: 'manager' }, { svc: 'web', node: 'worker-1' }, { svc: 'web', node: 'worker-2' },
    { svc: 'cache', node: 'worker-1' }, { svc: 'db', node: 'manager', secret: true },
  ];

  s.btn('echo "s3cret" | docker secret create db_password -', async () => {
    typed(term, 'echo "s3cret" | docker secret create db_password -');
    st.secret = true;
    render();
    flash(vaultEl);
    out(term, 'q9x2m4k7p1…');
    s.say('Stored <b>encrypted</b>. The value came through a pipe, so it never touched a file or your shell history file.');
  }, { mono: true, enabled: () => !st.secret, why: 'db_password already exists.', cmd: [/^(?:echo|printf) ['"]?[^'"|]+['"]? \| docker secret create db_password -$/] });

  s.btn('docker stack deploy -c stack.yaml shop', async () => {
    typed(term, 'docker stack deploy -c stack.yaml shop');
    if (!st.secret) {
      flash(vaultEl, 'shake');
      out(term, '<span class="bad">service db: secret not found: db_password</span>');
      return s.say('stack.yaml marks the secret as <code>external: true</code> — it must exist <b>before</b> you deploy. Create it first.');
    }
    out(term, 'Creating network shop_default\nCreating service shop_web\nCreating service shop_cache\nCreating service shop_db');
    let i = 0;
    for (const p of plan()) {
      const t = { id: ++i, name: `shop_${p.svc}.${p.svc === 'web' ? i : 1}`, ver: st.ver, ...p };
      st.tasks.push(t);
      render();
      t.el.classList.add('pop');
      if (t.secret) await fly(s.stage, vaultEl, t.el, { label: '🔒', cls: 'white' });
      await wait(250);
    }
    st.deployed = true;
    s.say('Five tasks over three nodes. Only the <b>db</b> task received the secret — mounted as an in-memory file at <code>/run/secrets/db_password</code>. db sits on the manager because of its placement constraint.');
  }, { mono: true, primary: true, enabled: () => !st.deployed, why: 'The stack is already deployed — edit the file and deploy again to update.', cmd: [/^docker stack (?:deploy|up) (?:-c|--compose-file) stack\.yaml shop$/] });

  s.command([/^docker exec \S*db\S* cat \/run\/secrets\/db_password$/], async (_, m) => {
    typed(term, m.input);
    flash(st.tasks.find((t) => t.svc === 'db').el);
    out(term, 's3cret');
    s.say('Inside the db task the secret is just a file. Postgres reads it via <code>POSTGRES_PASSWORD_FILE</code>.');
  }, { enabled: () => st.deployed, why: 'Deploy the stack first.', example: 'docker exec shop_db.1 cat /run/secrets/db_password' });
  s.command([/^docker exec \S*(web|cache)\S* cat \/run\/secrets\/db_password$/], async (_, m) => {
    typed(term, m.input);
    out(term, '<span class="bad">cat: can\'t open \'/run/secrets/db_password\': No such file or directory</span>');
    s.say(`The ${m[1]} service did not ask for the secret, so it never receives it. Least privilege by default.`);
  }, { enabled: () => st.deployed, why: 'Deploy the stack first.', example: 'docker exec shop_web.1 cat /run/secrets/db_password' });
  s.command([/^docker secret inspect db_password$/], async () => {
    typed(term, 'docker secret inspect db_password');
    out(term, '[{ "ID": "q9x2m4k7p1", "Spec": { "Name": "db_password", "Labels": {} }, "CreatedAt": "…" }]');
    s.say('Metadata only — <b>there is no command that prints a secret\'s value</b>.');
  }, { enabled: () => st.secret, why: 'Create the secret first.', example: 'docker secret inspect db_password' });
  s.command([/^docker secret rm db_password$/], async () => {
    typed(term, 'docker secret rm db_password');
    if (st.deployed) { flash(vaultEl, 'shake'); out(term, '<span class="bad">secret \'db_password\' is in use by the following service: shop_db</span>'); return s.say('A secret in use cannot be removed. To rotate: create <code>db_password_v2</code>, then <code>service update --secret-rm db_password --secret-add db_password_v2 shop_db</code>.'); }
    st.secret = false;
    render();
    s.say('Removed.');
  }, { enabled: () => st.secret, why: 'There is no secret to remove.', example: 'docker secret rm db_password' });

  const roll = async (to) => {
    for (const t of st.tasks.filter((x) => x.svc === 'web')) {
      flash(t.el, 'shake');
      await wait(450);
      t.ver = to;
      render();
      st.tasks.find((x) => x.id === t.id).el.classList.add('pop');
      await wait(350);
    }
  };
  s.command([/^docker service update --image nginx:(1\.2[67]) shop_web$/], async (_, m) => {
    typed(term, m.input);
    st.prev = st.ver;
    st.ver = m[1];
    await roll(m[1]);
    out(term, 'shop_web\noverall progress: 3 out of 3 tasks\nverify: Service shop_web converged');
    s.say('A <b>rolling update</b>: one task at a time (<code>parallelism: 1</code>), so the site never goes down.');
  }, { enabled: () => st.deployed, why: 'Deploy the stack first.', example: 'docker service update --image nginx:1.27 shop_web' });
  s.command([/^docker service rollback shop_web$/], async () => {
    typed(term, 'docker service rollback shop_web');
    const back = st.prev;
    st.prev = st.ver;
    st.ver = back;
    await roll(back);
    out(term, 'rollback: manually requested rollback\nverify: Service shop_web converged');
    s.say(`Back on nginx:${back}.`);
  }, { enabled: () => st.deployed && !!st.prev, why: 'There is no previous version — update the service first.', example: 'docker service rollback shop_web' });
  s.command([/^docker stack (services|ps) shop$/], async (_, m) => {
    typed(term, m.input);
    if (m[1] === 'services') out(term, `NAME         REPLICAS   IMAGE\nshop_web     3/3        nginx:${st.ver}\nshop_cache   1/1        redis:7\nshop_db      1/1        postgres:16`);
    else st.tasks.forEach((t) => out(term, `${t.name.padEnd(14)} ${t.node.padEnd(10)} Running`));
    s.say(m[1] === 'services' ? 'Every service with running/desired replicas.' : 'Every task and the node it runs on.');
  }, { enabled: () => st.deployed, why: 'Deploy the stack first.', example: 'docker stack services shop' });
  s.command([/^docker stack rm shop$/], async () => {
    typed(term, 'docker stack rm shop');
    for (const t of [...st.tasks]) await removeAnimated(t.el);
    st.tasks = [];
    st.deployed = false;
    render();
    out(term, 'Removing service shop_web\nRemoving service shop_cache\nRemoving service shop_db\nRemoving network shop_default');
    s.say('Services and network are gone — the <b>secret is kept</b> for the next deploy.');
  }, { enabled: () => st.deployed, why: 'Nothing is deployed.', example: 'docker stack rm shop' });
  s.btn('↺ Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};
