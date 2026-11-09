// Interactive animations, one per lesson. Each entry receives a mount element.
import { h, wait, every, fly, moveTo, flash, removeAnimated, randomHex, escapeHtml, scaled } from './dom.js';
import { scene } from './components.js';

export const ANIMATIONS = {};
const A = ANIMATIONS;

// ---------- shared mini helpers ----------
const mkTerm = (style = {}) => h('div', { class: 'term', style });
const out = (t, html) => { t.append(h('div', { html })); t.scrollTop = t.scrollHeight; };
const typed = (t, cmd, prompt = '$') => out(t, `<span class="p">${prompt}</span> ${escapeHtml(cmd)}`);
const mkBar = (cls = '') => h('div', { class: `bar ${cls}` }, h('i'));
const setBar = (bar, pct) => { bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`; };
const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : mb >= 1 ? `${Math.round(mb)} MB` : mb > 0 ? `${Math.round(mb * 1000)} KB` : '0 B');
const title = (text, small) => h('div', { class: 'node-title' }, text, small && h('small', {}, small));
const zone = (label, body) => h('div', { class: 'zone' }, h('div', { class: 'zone-title' }, label), body);
const rand = (a, b) => a + Math.random() * (b - a);
export const helpers = { mkTerm, out, typed, mkBar, setBar, fmtMB, title, zone, rand };

// =====================================================================
// 1. VMs vs containers
// =====================================================================
A.vmVsContainer = (root) => {
  const s = scene(root, { title: 'Virtual machines vs containers', hint: 'Add apps, then press <b>Boot all</b> to compare.' });
  const NAMES = ['Web', 'API', 'DB', 'Cache'];
  const rows = { vm: h('div', { class: 'apps-row' }), ct: h('div', { class: 'apps-row' }) };
  const meters = {};
  let apps = 0;

  const metric = (label) => {
    const bar = mkBar(), val = h('b');
    return { row: h('div', { class: 'metric' }, h('span', {}, label), bar, val), bar, val };
  };
  const side = (key, heading, middle) => {
    meters[key] = { size: metric('Disk + RAM'), boot: metric('Boot time') };
    return h('div', { class: 'node' }, title(heading),
      h('div', { class: 'stack' },
        h('div', { class: 'layer hw' }, 'Infrastructure'),
        h('div', { class: 'layer os' }, 'Host operating system'),
        middle, rows[key]),
      meters[key].size.row, meters[key].boot.row);
  };
  s.stage.append(h('div', { class: 'vm-grid' },
    side('vm', '🖥 Virtual machines', h('div', { class: 'layer guest', style: { background: 'var(--paper-2)' } }, 'Hypervisor')),
    side('ct', '📦 Containers', h('div', { class: 'layer engine' }, 'Docker Engine')),
  ));

  const updateSize = () => {
    const vm = apps * 4200, ct = apps * 150;
    setBar(meters.vm.size.bar, (vm / 17000) * 100); meters.vm.size.val.textContent = fmtMB(vm);
    setBar(meters.ct.size.bar, (ct / 17000) * 100); meters.ct.size.val.textContent = fmtMB(ct);
    for (const k of ['vm', 'ct']) { setBar(meters[k].boot.bar, 0); meters[k].boot.val.textContent = '—'; }
  };
  const addApp = () => {
    const name = NAMES[apps++];
    rows.vm.append(h('div', { class: 'app-col drop' },
      h('div', { class: 'layer app' }, name), h('div', { class: 'layer libs' }, 'Libs'), h('div', { class: 'layer guest' }, 'Guest OS')));
    rows.ct.append(h('div', { class: 'app-col drop' },
      h('div', { class: 'layer app' }, name), h('div', { class: 'layer libs' }, 'Libs')));
    updateSize();
  };
  const boot = async (key, ms, label) => {
    const { bar, val } = meters[key].boot;
    bar.firstChild.style.transition = 'none';
    setBar(bar, 0);
    void bar.offsetWidth;
    bar.firstChild.style.transition = `width ${scaled(ms)}ms linear`;
    setBar(bar, key === 'vm' ? 100 : 3);
    await wait(ms);
    val.textContent = label;
  };

  s.btn('+ Add app', async () => { addApp(); s.say(`Each <b>VM</b> needs a whole guest OS (~4 GB). Each <b>container</b> only needs the app and its libraries (~150 MB).`); }, { enabled: () => apps < 4 });
  s.btn('− Remove app', async () => {
    apps--;
    rows.vm.lastChild.remove(); rows.ct.lastChild.remove();
    updateSize();
  }, { enabled: () => apps > 1 });
  s.btn('▶ Boot all', async () => {
    s.say('Booting… VMs must start a full operating system kernel each. Containers just start a process.');
    await Promise.all([boot('vm', 3200, '~45 s'), boot('ct', 300, '~0.5 s')]);
    s.say(`Done. ${apps} containers started in <b>under a second</b>; ${apps} VMs took <b>about 45 seconds</b> and ~${(apps * 4.2).toFixed(1)} GB.`);
  }, { primary: true });
  s.command([/^docker (?:container )?run (?:-d )?(?:--name \S+ )?(?:-d )?[\w.:/-]+$/], async () => {
    addApp();
    s.say(`<code>docker run</code> added one more container: ~150 MB and it starts in under a second. The VM column shows what the same app would cost as a VM.`);
  }, { enabled: () => apps < 4, example: 'docker run -d redis' });
  s.command([/^docker (?:container )?(?:ps|ls)(?: -a)?$/], async () => {
    s.say(`${apps} container${apps === 1 ? '' : 's'} running, all sharing <b>one</b> host kernel.`);
  }, { example: 'docker ps' });
  addApp();
};

// =====================================================================
// 2. Client / daemon / registry
// =====================================================================
A.architecture = (root) => {
  const s = scene(root, { title: 'Client → daemon → registry', hint: 'Click a command and follow the messages.' });
  const term = mkTerm();
  const daemon = h('span', { class: 'chip blue' }, '⚙ dockerd');
  const imgZone = h('div', { class: 'chips' }), ctrZone = h('div', { class: 'chips' });
  const reg = Object.fromEntries(['nginx', 'redis', 'postgres', 'node'].map((n) => [n, h('span', { class: 'chip light' }, n)]));
  const local = new Map();
  let ctrCount = 0;

  s.stage.append(h('div', { class: 'arch' },
    h('div', { class: 'node' }, title('💻 Client', 'docker CLI'), term),
    h('div', { class: 'node blue' }, title('🖥 Docker host', 'Engine'),
      h('div', { style: { marginBottom: '10px' } }, daemon),
      zone('Images', imgZone),
      h('div', { style: { height: '8px' } }),
      zone('Containers', ctrZone)),
    h('div', { class: 'node' }, title('☁ Registry', 'Docker Hub'), h('div', { class: 'chips' }, Object.values(reg))),
  ));
  out(term, '<span class="dim"># your terminal</span>');

  const send = (label) => fly(s.stage, term, daemon, { label });
  const pull = async (name) => {
    await fly(s.stage, daemon, reg[name], { label: `pull ${name}` });
    flash(reg[name]);
    for (let i = 0; i < 3; i++) { fly(s.stage, reg[name], daemon, { label: 'layer', cls: 'white', ms: 800 }); await wait(220); }
    await wait(700);
    const chip = h('span', { class: 'chip pop' }, name);
    imgZone.append(chip);
    local.set(name, chip);
  };

  const IMG = '(nginx|redis|postgres|node|app)(?::latest)?';
  const running = [];
  s.btn('docker pull redis', async (_, m) => {
    const name = m?.[1] || 'redis';
    typed(term, m?.input || 'docker pull redis');
    if (name === 'app') { out(term, '<span class="bad">pull access denied for app — it only exists locally (you built it)</span>'); return s.say('<b>app</b> was built on this host; the registry has never seen it.'); }
    s.say('The <b>client</b> sends a pull request to the <b>daemon</b> over the Docker API…');
    await send('API: pull');
    if (local.has(name)) {
      out(term, `Status: Image is up to date for ${name}:latest`);
      return s.say(`The daemon already has <b>${name}</b>, so nothing is downloaded.`);
    }
    s.say('…the daemon asks the <b>registry</b> and downloads the image layers.');
    await pull(name);
    out(term, `<span class="ok">Status: Downloaded newer image for ${name}:latest</span>`);
    s.say('The image is now stored on the Docker host, ready to run.');
  }, { mono: true, cmd: new RegExp(`^docker (?:image )?pull ${IMG}$`), example: 'docker pull postgres' });

  s.btn('docker run nginx', async (_, m) => {
    const name = m?.[1] || 'nginx';
    typed(term, m?.input || 'docker run -d nginx');
    await send('API: run');
    if (!local.has(name)) {
      if (name === 'app') { out(term, "<span class=\"bad\">Unable to find image 'app:latest' locally — pull access denied</span>"); return s.say('Build <b>app</b> first: <code>docker build -t app .</code>'); }
      out(term, `Unable to find image '${name}:latest' locally`);
      s.say(`No local <b>${name}</b> image — the daemon pulls it first.`);
      await pull(name);
    }
    const cname = `${name}_${++ctrCount}`;
    const ctr = h('span', { class: 'chip ok pop' }, h('span', { class: 'status-dot running' }), cname);
    await fly(s.stage, local.get(name), ctrZone, { label: 'create', ms: 700 });
    ctrZone.append(ctr);
    running.push({ name: cname, image: name });
    out(term, randomHex(12));
    s.say('The daemon created a <b>container</b> from the image and started it. The CLI just prints the container ID.');
  }, { mono: true, cmd: new RegExp(`^docker (?:container )?run (?:-d |--detach |--rm |--name \\S+ |-p \\S+ )*${IMG}$`), example: 'docker run -d redis' });

  s.btn('docker build -t app .', async () => {
    typed(term, 'docker build -t app .');
    s.say('The client packs your folder (the <b>build context</b>) and sends it to the daemon, which runs the Dockerfile.');
    await send('build context');
    flash(daemon);
    for (const step of ['FROM', 'COPY', 'RUN', 'CMD']) { out(term, `<span class="dim"> => ${step} …</span>`); await wait(350); }
    if (!local.has('app')) {
      const chip = h('span', { class: 'chip blue pop' }, 'app');
      imgZone.append(chip);
      local.set('app', chip);
    }
    out(term, '<span class="ok"> => naming to docker.io/library/app:latest</span>');
    s.say('Built entirely on the Docker host — the registry was not involved.');
  }, { mono: true });

  s.btn('docker ps', async () => {
    typed(term, 'docker ps');
    await send('API: list');
    await fly(s.stage, daemon, term, { label: 'JSON', cls: 'white' });
    out(term, '<span class="dim">CONTAINER ID   IMAGE      NAMES</span>');
    if (!running.length) out(term, '<span class="dim">(none running)</span>');
    running.forEach((c) => out(term, `${randomHex(12)}   ${c.image.padEnd(9)}  ${c.name}`));
    s.say('Even listing containers is an API round-trip to the daemon.');
  }, { mono: true, cmd: [/^docker (?:container )?(?:ps|ls)(?: -a)?$/], example: 'docker ps' });
  s.command([/^docker (?:image ls|images)$/], async () => {
    typed(term, 'docker images');
    await send('API: images');
    await fly(s.stage, daemon, term, { label: 'JSON', cls: 'white' });
    out(term, '<span class="dim">REPOSITORY   TAG</span>');
    if (!local.size) out(term, '<span class="dim">(no images)</span>');
    [...local.keys()].forEach((n) => out(term, `${n.padEnd(12)} latest`));
    s.say('<b>docker images</b> lists what the daemon has stored locally.');
  }, { example: 'docker images' });
};

// =====================================================================
// 3. One image, many containers
// =====================================================================
A.imageToContainers = (root) => {
  const s = scene(root, { title: 'One image → many containers', hint: 'Press <b>docker run</b> a few times, then add files to one container.' });
  const LAYERS = ['debian base', 'nginx binaries', 'default config'];
  const imageEl = h('div', { class: 'node blue' }, title('📦 Image', 'nginx:1.27'),
    h('div', { class: 'stack' }, LAYERS.map((l) => h('div', { class: 'layer' }, `🔒 ${l}`))),
    h('div', { style: { fontSize: '12px', marginTop: '8px', color: 'var(--muted)' } }, 'Read-only · stored once on disk'));
  const list = h('div', { class: 'ctr-list' });
  const disk = h('div', { style: { fontSize: '13px', marginTop: '12px', fontWeight: 600 } });
  s.stage.append(h('div', { class: 'img-ctr' }, imageEl, h('div', {}, list, disk)));
  const ctrs = [];
  const NAMES = ['web-1', 'web-2', 'web-3', 'web-4'];

  const updateDisk = () => {
    const files = ctrs.reduce((n, c) => n + c.files, 0);
    disk.textContent = `Disk used: 187 MB (image, shared) + ${ctrs.length} writable layer(s) with ${files} file(s) ≈ ${files * 4 + ctrs.length * 2} KB`;
  };
  const addFile = (c, file) => {
    c.files++;
    const fname = file || `note${c.files}.txt`;
    c.rw.append(h('span', { class: 'file-chip pop' }, fname));
    updateDisk();
    s.say(`Wrote <b>${escapeHtml(fname)}</b> into <b>${c.name}</b>'s writable layer. The image and the other containers are untouched.`);
  };
  const byName = (n) => ctrs.find((c) => c.name === n);
  const removeCtr = async (c) => {
    ctrs.splice(ctrs.indexOf(c), 1);
    await removeAnimated(c.el);
    updateDisk();
    s.refresh();
    s.say(`<b>${c.name}</b> removed — its writable layer (and any files in it) is gone. The image is still there.`);
  };

  s.btn('▶ docker run nginx', async (_, m) => {
    const wanted = m?.[1];
    if (wanted && byName(wanted)) return s.say(`<span class="err">Conflict: the name "${wanted}" is already in use.</span> Container names must be unique.`);
    const name = wanted || NAMES.find((n) => !byName(n)) || `web-${Date.now() % 1000}`;
    const c = { name, files: 0, rw: h('div', { class: 'rw' }, h('span', { style: { fontSize: '10px', color: 'var(--blue-800)', fontWeight: 700 } }, 'writable ✎')) };
    c.el = h('div', { class: 'ctr-card pop' },
      h('div', { class: 'head' }, h('span', { class: 'status-dot running' }), name,
        h('button', { class: 'btn btn-sm', title: 'Write a file', onclick: () => s.run(async () => addFile(c)) }, '+ file'),
        h('button', { class: 'btn btn-sm', title: 'docker rm -f', onclick: () => s.run(() => removeCtr(c)) }, '✕')),
      c.rw,
      LAYERS.slice().reverse().map((l) => h('div', { class: 'layer ro', style: { fontSize: '10.5px', padding: '2px 4px' } }, l)));
    await fly(s.stage, imageEl, list, { label: 'docker run', ms: 700 });
    ctrs.push(c);
    list.append(c.el);
    updateDisk();
    s.say(`<b>${name}</b> created. It <b>reuses</b> the image's read-only layers and gets its own thin <b>writable layer</b> on top.`);
  }, { primary: true, enabled: () => ctrs.length < 4, why: 'This demo holds 4 containers — remove one with <code>docker rm -f web-1</code>.', cmd: [/^docker (?:container )?run (?:-d )?(?:--name ([\w.-]+) )?(?:-d )?nginx(?::1\.27)?$/], example: 'docker run -d --name blog nginx' });

  const need = (n) => byName(n) || (s.say(`<span class="err">Error: No such container: ${escapeHtml(n)}</span>`), null);
  s.command([/^docker exec (?:-it )?([\w.-]+) touch (\S+)$/, /^docker exec (?:-it )?([\w.-]+) sh -c "?echo .* > (\S+?)"?$/], async (_, m) => {
    const c = need(m[1]);
    if (c) addFile(c, m[2].split('/').pop());
  }, { example: 'docker exec web-1 touch hello.txt', enabled: () => ctrs.length > 0 });
  s.command([/^docker (?:container )?rm (?:-f |--force )?([\w.-]+)$/], async (_, m) => {
    const c = need(m[1]);
    if (c) await removeCtr(c);
  }, { example: 'docker rm -f web-1', enabled: () => ctrs.length > 0 });
  s.command([/^docker (?:container )?(?:ps|ls)(?: -a)?$/], async () => {
    s.say(ctrs.length ? `Running: ${ctrs.map((c) => `<b>${c.name}</b> (${c.files} file${c.files === 1 ? '' : 's'})`).join(', ')} — all from the same image.` : 'No containers yet.');
  }, { example: 'docker ps' });
  updateDisk();
};

// =====================================================================
// 4. What docker run does
// =====================================================================
A.runFlow = (root) => {
  const s = scene(root, { title: 'Inside docker run', hint: 'Press run. Then run again — the second time the image is cached.' });
  const STEPS = ['Look for image locally', 'Pull from registry', 'Create container', 'Start process', 'Running'];
  const stepEls = STEPS.map((t, i) => h('div', { class: 'step' }, h('span', { class: 'n' }, `STEP ${i + 1}`), t));
  const dl = h('div', { class: 'node' }, title('⬇ Layer downloads'), h('div', { class: 'pg-empty' }, 'Nothing downloaded yet.'));
  const term = mkTerm({ minHeight: '170px', maxHeight: '220px' });
  s.stage.append(h('div', { class: 'steps' }, stepEls), h('div', { class: 'split' }, dl, term));

  const cached = h('input', { type: 'checkbox' });
  s.add(h('label', { class: 'inline' }, cached, 'Image already on my machine'));
  s.sep();

  const reset = () => stepEls.forEach((el) => { el.className = 'step'; });
  const activate = (i) => { stepEls[i].className = 'step active'; };
  const done = (i) => { stepEls[i].className = 'step done'; };

  const download = async () => {
    dl.replaceChildren(title('⬇ Layer downloads', 'from Docker Hub'));
    const layers = Array.from({ length: 4 }, () => ({ id: randomHex(12), bar: mkBar(), st: h('span', {}, 'Waiting') }));
    layers.forEach((l) => dl.append(h('div', { class: 'dl-row' }, h('span', {}, l.id), l.bar, l.st)));
    await Promise.all(layers.map(async (l) => {
      await wait(rand(0, 400));
      for (let p = 0; p < 100;) {
        p = Math.min(100, p + rand(7, 22));
        setBar(l.bar, p);
        l.st.textContent = p < 100 ? `${Math.round(p)}%` : 'Pull complete';
        await wait(140);
      }
      out(term, `${l.id}: <span class="ok">Pull complete</span>`);
    }));
  };

  const pulled = new Set();
  s.btn('▶ docker run -d -p 8080:80 nginx', async (_, m) => {
    const cmd = m?.input || 'docker run -d -p 8080:80 nginx';
    const img = m?.[2] || 'nginx';
    const port = (cmd.match(/-p (\d+):\d+/) || [])[1];
    const detached = /(^| )-d( |$)/.test(cmd);
    const isCached = img === 'nginx' ? cached.checked : pulled.has(img);
    reset();
    term.replaceChildren();
    typed(term, cmd);
    activate(0);
    s.say(`<b>Step 1:</b> the daemon checks its local image store for <code>${img}:latest</code>.`);
    await wait(900);
    done(0);
    if (isCached) {
      stepEls[1].className = 'step skip';
      s.say('Found locally — <b>no download needed</b>. This is why the second run is fast.');
      await wait(700);
    } else {
      out(term, `Unable to find image '${img}:latest' locally`);
      out(term, `latest: Pulling from library/${img}`);
      activate(1);
      s.say('<b>Step 2:</b> not found, so it pulls the image. Layers download <b>in parallel</b>.');
      await download();
      out(term, `Digest: sha256:${randomHex(24)}…`);
      out(term, `Status: Downloaded newer image for ${img}:latest`);
      done(1);
      pulled.add(img);
      if (img === 'nginx') cached.checked = true;
    }
    activate(2);
    s.say(`<b>Step 3:</b> create the container: a writable layer, a network interface${port ? `, and the port mapping ${port}→container` : ' (no -p, so no port is published)'}.`);
    await wait(1000);
    done(2);
    activate(3);
    s.say(`<b>Step 4:</b> start the image's default command (<code>${{ nginx: 'nginx -g "daemon off;"', redis: 'redis-server', httpd: 'httpd-foreground' }[img]}</code>) as PID 1 inside the container.`);
    await wait(1000);
    done(3);
    stepEls[4].className = 'step active';
    if (detached) out(term, `<span class="y">${randomHex(64)}</span>`);
    else out(term, '<span class="dim">…attached: the server\'s logs stream here until you press Ctrl+C</span>');
    s.say(`<b>Running!</b> ${detached ? 'Because of <code>-d</code> the CLI prints the full container ID and gives your terminal back.' : 'Without <code>-d</code> your terminal stays attached to the container\'s output.'}${port ? ` Visit <code>localhost:${port}</code>.` : ''}`);
  }, { primary: true, mono: true, cmd: [/^docker (?:container )?run ((?:-d |--detach |--rm |--name \S+ |-p \d+:\d+ )*)(nginx|redis|httpd)(?::latest)?$/], example: 'docker run -d -p 8080:80 nginx' });
  s.btn('Forget image (docker rmi)', async () => {
    cached.checked = false;
    pulled.clear();
    reset();
    dl.replaceChildren(title('⬇ Layer downloads'), h('div', { class: 'pg-empty' }, 'Image removed — next run downloads again.'));
    s.say('Local image removed. The next run has to pull it again.');
  }, { cmd: [/^docker (?:rmi|image rm)(?: -f)? (nginx|redis|httpd)(?::latest)?$/], example: 'docker rmi nginx' });
};

// =====================================================================
// 5. Lifecycle state machine
// =====================================================================
A.lifecycle = (root) => {
  const s = scene(root, { title: 'Container lifecycle', hint: 'Start with <b>docker create</b>. Only valid commands are enabled.' });
  const NODES = { none: [75, 200, 'Nothing'], created: [260, 200, 'Created'], running: [460, 90, 'Running'], paused: [670, 90, 'Paused'], exited: [460, 310, 'Exited'], removed: [670, 310, 'Removed'] };
  const EDGES = {
    'none-created': ['M137 200 L196 200', 167, 188, 'create'],
    'created-running': ['M290 175 L398 112', 330, 132, 'start'],
    'running-paused': ['M522 80 L606 80', 564, 68, 'pause'],
    'paused-running': ['M608 102 L524 102', 566, 122, 'unpause'],
    'running-exited': ['M440 117 L440 283', 440, 170, 'stop / kill'],
    'exited-running': ['M482 283 L482 117', 482, 240, 'start'],
    'exited-removed': ['M522 310 L606 310', 564, 298, 'rm'],
    'created-removed': ['M260 227 C 260 395, 560 395, 640 337', 420, 372, 'rm'],
    'paused-exited': ['M640 117 L522 288', 600, 205, 'stop'],
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  };
  const svg = svgEl('svg', { viewBox: '0 0 780 400', class: 'sm-svg', role: 'img', 'aria-label': 'Container state diagram' });
  svg.append(svgEl('defs', {}, svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, svgEl('path', { d: 'M0 0 L10 5 L0 10 z', fill: '#0a0f1e' }))));
  const edgeEls = {}, nodeEls = {};
  for (const [k, [d, lx, ly, label]] of Object.entries(EDGES)) {
    edgeEls[k] = svgEl('path', { d, class: 'sm-edge' });
    svg.append(edgeEls[k], svgEl('text', { x: lx, y: ly, class: 'sm-label' }, label));
  }
  for (const [k, [x, y, label]] of Object.entries(NODES)) {
    nodeEls[k] = svgEl('g', { class: 'sm-node' }, svgEl('rect', { x: x - 60, y: y - 25, width: 120, height: 50, rx: 10 }), svgEl('text', { x, y }, label));
    svg.append(nodeEls[k]);
  }
  const token = svgEl('g', { class: 'sm-token' },
    svgEl('rect', { x: -20, y: -13, width: 40, height: 26, rx: 4, fill: '#1d5cff', stroke: '#0a0f1e', 'stroke-width': 2 }),
    ...[-10, 0, 10].map((x) => svgEl('line', { x1: x, y1: -8, x2: x, y2: 8, stroke: '#fff', 'stroke-width': 2 })));
  svg.append(token);

  const info = h('div', { class: 'proc' });
  const term = mkTerm({ maxHeight: '130px', minHeight: '60px', marginTop: '10px' });
  s.stage.append(svg, info, term);

  let state = 'none', exitCode = null;
  const place = (st) => {
    const [x, y] = NODES[st];
    token.style.transform = `translate(${x}px, ${y - 42}px)`;
    Object.entries(nodeEls).forEach(([k, el]) => el.classList.toggle('cur', k === st));
  };
  const describe = () => {
    const map = {
      none: '⬜ No container yet',
      created: '⬜ Filesystem ready · no process running',
      running: '🟢 PID 1: nginx — running',
      paused: '⏸ Processes frozen · memory kept, 0% CPU',
      exited: `⬛ Process ended · exit code ${exitCode}`,
      removed: '🗑 Container and its writable layer deleted',
    };
    info.textContent = map[state];
  };
  const go = async (to, edge) => {
    if (edge && edgeEls[edge]) {
      edgeEls[edge].classList.add('lit');
      setTimeout(() => edgeEls[edge]?.classList.remove('lit'), scaled(1200));
    }
    state = to;
    place(to);
    describe();
    await wait(850);
  };

  const ACTIONS = {
    create: { from: ['none', 'removed'], run: async () => {
      if (state === 'removed') { await go('none'); }
      typed(term, 'docker create --name web nginx');
      await go('created', 'none-created');
      s.say('<b>create</b> prepares the filesystem and config. Nothing is running yet.');
    } },
    start: { from: ['created', 'exited'], run: async () => {
      typed(term, 'docker start web');
      await go('running', `${state}-running`);
      s.say('<b>start</b> launches the main process. The container is now <b>running</b>.');
    } },
    pause: { from: ['running'], run: async () => {
      typed(term, 'docker pause web');
      await go('paused', 'running-paused');
      s.say('<b>pause</b> freezes every process with the cgroup freezer. Memory stays allocated.');
    } },
    unpause: { from: ['paused'], run: async () => {
      typed(term, 'docker unpause web');
      await go('running', 'paused-running');
      s.say('<b>unpause</b> resumes exactly where it left off.');
    } },
    stop: { from: ['running', 'paused'], run: async () => {
      typed(term, 'docker stop web');
      out(term, '<span class="dim">→ SIGTERM sent, app shutting down gracefully…</span>');
      exitCode = 0;
      await go('exited', `${state}-exited`);
      s.say('<b>stop</b> sends SIGTERM, lets the app clean up (up to 10 s), then SIGKILL if needed. Exit code <b>0</b>.');
    } },
    kill: { from: ['running', 'paused'], run: async () => {
      typed(term, 'docker kill web');
      out(term, '<span class="bad">→ SIGKILL: process terminated immediately</span>');
      exitCode = 137;
      await go('exited', `${state}-exited`);
      s.say('<b>kill</b> sends SIGKILL — no cleanup. Exit code <b>137</b> (128 + signal 9).');
    } },
    restart: { from: ['running', 'exited'], run: async () => {
      typed(term, 'docker restart web');
      if (state === 'running') { exitCode = 0; await go('exited', 'running-exited'); }
      await go('running', 'exited-running');
      s.say('<b>restart</b> = stop + start. Same container, same writable layer.');
    } },
    rm: { from: ['created', 'exited'], run: async () => {
      typed(term, 'docker rm web');
      await go('removed', `${state}-removed`);
      s.say('<b>rm</b> deletes the container. Use <code>docker rm -f</code> to remove a running one.');
    } },
  };
  for (const [name, a] of Object.entries(ACTIONS)) {
    const cmd = name === 'create' ? [/^docker (?:container )?create (?:--name web )?nginx$/] : [new RegExp(`^docker (?:container )?${name} web$`)];
    s.btn(name, a.run, { mono: true, primary: name === 'start', enabled: () => a.from.includes(state), cmd, example: name === 'create' ? 'docker create --name web nginx' : `docker ${name} web`,
      why: () => (state === 'none' || state === 'removed' ? 'There is no container named <b>web</b> yet — <code>docker create --name web nginx</code> first.' : `web is <b>${state}</b>; <b>${name}</b> only works from: ${a.from.join(', ')}.`) });
  }
  s.command([/^docker (?:container )?run (?:-d )?--name web (?:-d )?nginx$/], async () => {
    await ACTIONS.create.run();
    await ACTIONS.start.run();
    s.say('<b>run</b> = <b>create</b> + <b>start</b> in one command.');
  }, { enabled: () => ACTIONS.create.from.includes(state), example: 'docker run -d --name web nginx' });
  s.command([/^docker (?:container )?rm (?:-f|--force) web$/], async () => {
    if (state === 'running' || state === 'paused') await ACTIONS.kill.run();
    await ACTIONS.rm.run();
    s.say('<b>rm -f</b> kills a running container and removes it in one go.');
  }, { enabled: () => ['created', 'running', 'paused', 'exited'].includes(state), example: 'docker rm -f web' });
  s.command([/^docker (?:container )?(?:ps -a|ls -a|ps|ls)$/], async () => {
    const shown = state === 'running' || state === 'paused' || (state !== 'none' && state !== 'removed');
    s.say(shown ? `<code>web</code> is <b>${state}</b>.${state === 'created' || state === 'exited' ? ' (Plain <code>docker ps</code> would hide it — only <code>-a</code> shows non-running containers.)' : ''}` : 'No container named web exists.');
  }, { example: 'docker ps -a' });
  place('none');
  describe();
};

// =====================================================================
// 6. logs / exec / stats
// =====================================================================
A.logsExec = (root) => {
  const s = scene(root, { title: 'Looking inside a running container', hint: 'The <b>web</b> container is serving requests. Explore it.' });
  const term = mkTerm({ height: '250px' });
  const stdout = h('div', { class: 'term', style: { height: '110px', fontSize: '11px' } });
  const procs = h('div', {}, h('div', { class: 'proc' }, h('span', { class: 'status-dot running' }), 'PID 1  nginx: master process'), h('div', { class: 'proc' }, h('span', { class: 'status-dot running' }), 'PID 29 nginx: worker process'));
  const box = h('div', { class: 'node blue' }, title('📦 container: web', 'nginx:1.27'), zone('Processes', procs), h('div', { style: { height: '8px' } }), zone('stdout / stderr', stdout));
  s.stage.append(h('div', { class: 'split' }, term, box));
  out(term, '<span class="dim"># host terminal</span>');

  const PATHS = ['/', '/index.html', '/about', '/api/users', '/favicon.ico', '/missing'];
  const logs = [];
  let follow = false, inside = false, shProc = null;
  const prompt = () => (inside ? '/ #' : '$');

  every(() => {
    const path = PATHS[Math.floor(Math.random() * PATHS.length)];
    const code = path === '/missing' ? 404 : 200;
    const line = `172.17.0.1 "GET ${path}" ${code}`;
    logs.push(line);
    out(stdout, code === 404 ? `<span class="bad">${line}</span>` : line);
    if (follow) { fly(s.stage, stdout, term, { cls: 'dot', ms: 600 }); setTimeout(() => out(term, line), scaled(600)); }
  }, 1300);

  const toggleFollow = async () => {
    follow = !follow;
    followBtn.textContent = follow ? '^C stop following' : 'docker logs -f web';
    if (follow) {
      typed(term, 'docker logs -f web');
      s.say('<b>Following</b>: every new line the app writes to stdout is streamed to your terminal live.');
    } else {
      out(term, '^C');
      s.say('Stopped following. The container keeps running — only your view stopped.');
    }
  };
  const followBtn = s.btn('docker logs -f web', async (_, m) => {
    if (m && follow) return s.say('Already following. Type <code>^C</code> (or press the button) to stop.');
    await toggleFollow();
  }, { mono: true, enabled: () => !inside, why: 'You are inside the container shell — type <code>exit</code> first.', cmd: [/^docker (?:container )?logs (?:-f|--follow)(?: --tail \d+| -n \d+)? web$/], example: 'docker logs -f web' });
  s.command(['^c', 'ctrl+c', 'ctrl-c'], toggleFollow, { enabled: () => follow, example: '^C', why: 'Nothing to interrupt — you are not following logs.' });
  s.btn('docker logs --tail 3 web', async (_, m) => {
    const n = Number(m?.[1] || m?.[2] || (m ? 8 : 3));
    typed(term, m?.input || 'docker logs --tail 3 web');
    logs.slice(-n).forEach((l) => out(term, l));
    s.say('<b>logs</b> prints what the container already wrote to stdout/stderr. <code>--tail</code> limits it.');
  }, { mono: true, enabled: () => !inside && !follow, cmd: [/^docker (?:container )?logs(?: --tail (\d+)| -n (\d+))? web$/], example: 'docker logs --tail 5 web' });
  s.btn('docker exec -it web sh', async (_, m) => {
    typed(term, m?.input || 'docker exec -it web sh');
    await fly(s.stage, term, procs, { label: 'exec sh' });
    shProc = h('div', { class: 'proc pop', style: { background: 'var(--blue-100)' } }, h('span', { class: 'status-dot running' }), 'PID 47 sh  ← you are here');
    procs.append(shProc);
    inside = true;
    out(term, '<span class="dim">(now inside the container)</span>');
    s.say('<b>exec</b> started an extra process (<code>sh</code>) <b>inside</b> the running container. Your prompt is now the container\'s.');
  }, { mono: true, enabled: () => !inside && !follow, cmd: [/^docker (?:container )?exec -it web (?:sh|bash|\/bin\/sh|\/bin\/bash)$/], example: 'docker exec -it web sh' });
  // Commands a shell inside the nginx container can answer.
  const SHELL = {
    ls: (arg) => (/nginx\/html/.test(arg) ? '50x.html    index.html' : /etc\/nginx/.test(arg) ? 'conf.d  mime.types  nginx.conf' : 'bin  boot  dev  docker-entrypoint.sh  etc  home  lib  proc  root  run  sbin  tmp  usr  var'),
    pwd: () => '/',
    whoami: () => 'root',
    hostname: () => '3f9c2a1b7e4d',
    ps: () => 'PID   USER     COMMAND\n    1 root     nginx: master process\n   29 nginx    nginx: worker process\n   47 root     sh\n   53 root     ps',
    cat: (arg) => (/os-release/.test(arg) ? 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"' : /index\.html/.test(arg) ? '<h1>Welcome to nginx!</h1> …' : `cat: ${arg || ''}: No such file or directory`),
    env: () => 'HOSTNAME=3f9c2a1b7e4d\nNGINX_VERSION=1.27.0\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  const runShell = (line) => {
    const [prog, ...rest] = line.split(' ');
    return SHELL[prog] ? SHELL[prog](rest.join(' ')) : `sh: ${prog}: not found`;
  };
  s.btn('ls /usr/share/nginx/html', async (_, m) => {
    const line = m?.input || 'ls /usr/share/nginx/html';
    typed(term, line, prompt());
    out(term, escapeHtml(runShell(line)).replace(/\n/g, '<br>'));
    s.say('You are looking at the <b>container\'s</b> filesystem, not your laptop\'s.');
  }, { mono: true, enabled: () => inside, cmd: [/^(?:ls|pwd|whoami|hostname|ps|cat|env)(?: .*)?$/], example: 'ls /usr/share/nginx/html' });
  s.command([/^docker (?:container )?exec web ((?:ls|pwd|whoami|hostname|ps|cat|env)(?: .*)?)$/], async (_, m) => {
    typed(term, m.input);
    out(term, escapeHtml(runShell(m[1])).replace(/\n/g, '<br>'));
    s.say('Without <code>-it</code>, <b>exec</b> runs one command inside the container, prints its output and returns.');
  }, { enabled: () => !inside && !follow, example: 'docker exec web cat /etc/os-release' });
  s.btn('exit', async () => {
    typed(term, 'exit', prompt());
    await removeAnimated(shProc);
    inside = false;
    s.say('The <code>sh</code> process ended. The container keeps running because its main process (PID 1) is untouched.');
  }, { mono: true, enabled: () => inside, cmd: ['exit'], example: 'exit' });
  s.btn('docker stats --no-stream', async () => {
    typed(term, 'docker stats --no-stream');
    out(term, '<span class="dim">NAME  CPU %   MEM USAGE / LIMIT    NET I/O</span>');
    out(term, `web   ${rand(0.1, 2.5).toFixed(2)}%   ${rand(6, 12).toFixed(1)}MiB / 7.6GiB   ${Math.round(rand(20, 90))}kB / ${Math.round(rand(40, 200))}kB`);
    s.say('<b>stats</b> shows live resource usage (drop <code>--no-stream</code> to keep it updating).');
  }, { mono: true, enabled: () => !inside && !follow, cmd: [/^docker (?:container )?stats(?: --no-stream)?(?: web)?$/], example: 'docker stats --no-stream' });
  s.command([/^docker (?:container )?top web$/], async (_, m) => {
    typed(term, m.input);
    out(term, escapeHtml(SHELL.ps().split('\n').slice(0, inside ? 4 : 3).join('\n')).replace(/\n/g, '<br>'));
    s.say('<b>top</b> lists the processes running inside the container, from the host\'s point of view.');
  }, { enabled: () => !inside && !follow, example: 'docker top web' });
  s.btn('docker inspect web', async () => {
    typed(term, "docker inspect --format '{{.State.Status}} {{.NetworkSettings.IPAddress}}' web");
    out(term, 'running 172.17.0.2');
    s.say('<b>inspect</b> returns the full JSON description; <code>--format</code> picks fields out of it.');
  }, { mono: true, enabled: () => !inside && !follow, cmd: [/^docker (?:container )?inspect (?:--format .* |-f .* )?web$/], example: 'docker inspect web' });
};

// =====================================================================
// 7. docker build → layers
// =====================================================================
A.buildLayers = (root) => {
  const s = scene(root, { title: 'docker build, one layer at a time', hint: 'Press <b>Next step</b> to execute one instruction.' });
  const STEPS = [
    ['FROM node:20-alpine', 'node:20-alpine (base)', 132, 'Pulls the base image. Its layers become the bottom of your image.'],
    ['WORKDIR /app', 'WORKDIR /app', 0, 'Sets the working directory. Metadata only — no real size.'],
    ['COPY package*.json ./', 'package.json + lock', 0.004, 'Copies just the dependency manifest — a tiny layer.'],
    ['RUN npm ci --omit=dev', 'node_modules', 48, 'Runs npm inside a temporary container and saves the resulting files as a new layer.'],
    ['COPY . .', 'source code', 1.2, 'Copies your app\'s source code.'],
    ['EXPOSE 3000', 'EXPOSE 3000', 0, 'Metadata: documents the port.'],
    ['USER node', 'USER node', 0, 'Metadata: the user the app runs as.'],
    ['CMD ["node", "server.js"]', 'CMD', 0, 'Metadata: the default start command.'],
  ];
  const lines = STEPS.map(([ins]) => h('div', { class: 'df-line' }, h('span', {}, ins), h('span', { class: 'st' })));
  const stack = h('div', { class: 'img-stack' });
  const total = h('div', { style: { font: '700 14px var(--mono)', marginTop: '10px' } });
  const term = mkTerm({ height: '110px', marginTop: '12px' });
  s.stage.append(h('div', { class: 'split' },
    h('div', {}, h('div', { class: 'df-lines' }, lines), term),
    h('div', { class: 'node' }, title('📦 Image: myapp:1.0', 'layers (bottom = first)'), stack, total)));

  let i = 0, size = 0;
  const reset = () => {
    i = 0; size = 0;
    stack.replaceChildren();
    term.replaceChildren();
    lines.forEach((l) => { l.classList.remove('cur'); l.lastChild.className = 'st'; l.lastChild.textContent = ''; });
    total.textContent = 'Total: 0 B';
  };
  const step = async () => {
    const [ins, label, mb, why] = STEPS[i];
    lines.forEach((l, j) => l.classList.toggle('cur', j === i));
    const st = lines[i].lastChild;
    st.className = 'st work'; st.textContent = 'running';
    out(term, `#${i + 2} [${i + 1}/${STEPS.length}] ${escapeHtml(ins)}`);
    await wait(mb > 10 ? 1200 : 500);
    st.className = 'st built'; st.textContent = 'done';
    stack.append(h('div', { class: `layer pop ${mb ? '' : 'meta'}`, style: mb ? { background: i === 0 ? 'var(--blue-100)' : '#fff' } : {} }, h('span', {}, label), h('span', {}, fmtMB(mb))));
    size += mb;
    total.textContent = `Total: ${fmtMB(size)}`;
    s.say(`<b>${escapeHtml(ins.split(' ')[0])}</b> — ${why}`);
    i++;
    if (i === STEPS.length) {
      out(term, '<span class="ok">=> naming to docker.io/library/myapp:1.0  done</span>');
      lines.forEach((l) => l.classList.remove('cur'));
      s.say(`Build finished: <b>${STEPS.filter((x) => x[2]).length} filesystem layers</b> + metadata, ${fmtMB(size)} total. Each layer is cached for the next build.`);
    }
  };
  s.btn('Next step ▸', step, { primary: true, enabled: () => i < STEPS.length });
  s.btn('Build all', async () => { while (i < STEPS.length) await step(); }, { enabled: () => i < STEPS.length });
  s.btn('Reset', async () => { reset(); s.say('Reset. Press <b>Next step</b>.'); });
  s.command([/^docker (?:image )?build (?:-t|--tag) myapp(?::[\w.-]+)? \.$/, /^docker (?:image )?build \.$/], async () => {
    reset();
    while (i < STEPS.length) await step();
  }, { example: 'docker build -t myapp:1.0 .' });
  s.command([/^docker (?:image )?history myapp(?::1\.0)?$/], async () => {
    if (i < STEPS.length) return s.say('<span class="err">Error: No such image: myapp:1.0</span> — build it first.');
    out(term, '<span class="dim">CREATED BY                    SIZE</span>');
    STEPS.slice().reverse().forEach(([ins, , mb]) => out(term, `${escapeHtml(ins.padEnd(30))}${fmtMB(mb)}`));
    s.say('<b>history</b> lists the layers newest-first, with the instruction that made each one.');
  }, { example: 'docker history myapp:1.0' });
  reset();
};

// =====================================================================
// 8. Build cache
// =====================================================================
A.cacheDemo = (root) => {
  const s = scene(root, { title: 'Build cache: bad order vs good order', hint: 'Build once, then edit your code and rebuild.' });
  const VARIANTS = {
    bad: [['FROM node:20-alpine', [], 3], ['WORKDIR /app', [], 0.1], ['COPY . .', ['src', 'pkg'], 0.6], ['RUN npm install', [], 42], ['CMD ["node","app.js"]', [], 0]],
    good: [['FROM node:20-alpine', [], 3], ['WORKDIR /app', [], 0.1], ['COPY package*.json ./', ['pkg'], 0.2], ['RUN npm install', [], 42], ['COPY . .', ['src', 'pkg'], 0.6], ['CMD ["node","app.js"]', [], 0]],
  };
  let variant = 'bad', built = false;
  const changes = new Set();
  const box = h('div', { class: 'df-lines' });
  const timeEl = h('div', { style: { font: '700 22px var(--mono)' } }, '—');
  const pending = h('div', { class: 'chips' });
  s.stage.append(h('div', { class: 'split' }, box,
    h('div', { class: 'node' }, title('⏱ Last build time'), timeEl, h('div', { style: { height: '12px' } }), title('✎ Changed since last build'), pending)));

  const render = () => {
    box.replaceChildren(...VARIANTS[variant].map(([ins]) => h('div', { class: 'df-line' }, h('span', {}, ins), h('span', { class: 'st' }))));
    pending.replaceChildren(...(changes.size ? [...changes].map((c) => h('span', { class: 'chip warn pop' }, c === 'src' ? 'app.js' : 'package.json')) : [h('span', { class: 'pg-empty' }, 'nothing')]));
  };
  const sel = h('select', { onchange: (e) => { variant = e.target.value; built = false; changes.clear(); timeEl.textContent = '—'; render(); s.refresh(); s.say(variant === 'bad' ? '<b>Bad order:</b> all source is copied before installing dependencies.' : '<b>Good order:</b> dependencies are installed from package.json before the source is copied.'); } },
    h('option', { value: 'bad' }, '❌ Bad order'), h('option', { value: 'good' }, '✅ Good order'));
  s.add(h('label', { class: 'inline' }, 'Dockerfile:', sel));
  s.sep();

  s.btn('▶ docker build', async () => {
    let cascade = false, secs = 0;
    const rows = [...box.children];
    for (const [idx, [, deps, t]] of VARIANTS[variant].entries()) {
      const st = rows[idx].lastChild;
      rows.forEach((r, j) => r.classList.toggle('cur', j === idx));
      const rebuild = !built || cascade || deps.some((d) => changes.has(d));
      if (rebuild) cascade = true;
      st.className = 'st work'; st.textContent = rebuild ? 'building' : 'checking';
      await wait(rebuild ? (t > 10 ? 1400 : 400) : 180);
      st.className = `st ${rebuild ? 'built' : 'cached'}`;
      st.textContent = rebuild ? `BUILT ${t}s` : 'CACHED';
      if (rebuild) secs += t;
    }
    rows.forEach((r) => r.classList.remove('cur'));
    timeEl.textContent = `${secs.toFixed(1)} s`;
    const npmRebuilt = VARIANTS[variant].findIndex((l) => l[0].startsWith('RUN'));
    const reran = rows[npmRebuilt].lastChild.textContent.startsWith('BUILT');
    s.say(!built ? 'First build: everything runs. Now <b>edit app.js</b> and rebuild.'
      : reran ? `<b>npm install ran again</b> (${secs.toFixed(1)} s) because a layer above it changed. ${variant === 'bad' ? 'Switch to the <b>good order</b> and compare!' : 'That is expected when dependencies change.'}`
        : `Only the last layers rebuilt — <b>${secs.toFixed(1)} s</b>. npm install came from cache. 🎉`);
    built = true;
    changes.clear();
    render();
  }, { primary: true, mono: true, cmd: [/^docker (?:image )?build (?:(?:-t|--tag) [\w.:-]+ )?\.$/], example: 'docker build -t app .' });
  s.btn('✎ Edit app.js', async () => { changes.add('src'); render(); s.say('You changed source code. Which layers will rebuild?'); }, { enabled: () => built, cmd: [/^(?:echo .*>>? ?app\.js|vim app\.js|nano app\.js|code app\.js|touch app\.js)$/], example: 'echo "// fix" >> app.js' });
  s.btn('📦 Add a dependency', async () => { changes.add('pkg'); render(); s.say('You changed <b>package.json</b>. This must re-run npm install in both orders.'); }, { enabled: () => built, cmd: [/^npm (?:install|i|add) [\w@./-]+$/, /^npm uninstall [\w@./-]+$/], example: 'npm install express' });
  render();
};

// =====================================================================
// 9. Port mapping
// =====================================================================
A.portMapping = (root) => {
  const s = scene(root, { title: 'Port mapping: -p HOST:CONTAINER', hint: 'Send a request from the browser.' });
  const url = h('div', { class: 'url' });
  const page = h('div', { class: 'page' }, 'Press "Send request"');
  const browser = h('div', { class: 'browser' }, url, page);
  const hostPort = h('div', { class: 'host-port' });
  const ctrPort = h('div', { class: 'ctr-port' });
  const nginx = h('div', { class: 'chip blue' }, 'nginx listening on :80');
  s.stage.append(h('div', { class: 'port-scene' }, browser,
    h('div', { class: 'host-box' }, hostPort, title('💻 Your machine (localhost)'),
      h('div', { class: 'ctr-box' }, ctrPort, title('📦 container', 'own network namespace'), nginx))));

  const publish = h('input', { type: 'checkbox', checked: true });
  const hp = h('input', { type: 'number', value: 8080, min: 1, max: 65535 });
  const cp = h('input', { type: 'number', value: 80, min: 1, max: 65535 });
  const preview = h('code', { style: { fontSize: '12.5px' } });
  const sync = () => {
    hostPort.textContent = `:${hp.value}`;
    hostPort.classList.toggle('open', publish.checked);
    ctrPort.textContent = `:${cp.value}`;
    url.textContent = `🔒 http://localhost:${hp.value}`;
    preview.textContent = publish.checked ? `docker run -d -p ${hp.value}:${cp.value} nginx` : 'docker run -d nginx';
  };
  [publish, hp, cp].forEach((el) => el.addEventListener('input', sync));
  s.add(h('label', { class: 'inline' }, publish, 'Publish (-p)'), h('label', { class: 'inline' }, 'host', hp), h('label', { class: 'inline' }, 'container', cp));
  s.sep();

  const send = async (reqPort = hp.value) => {
    url.textContent = `🔒 http://localhost:${reqPort}`;
    page.textContent = 'Loading…';
    await fly(s.stage, browser, hostPort, { label: `GET :${reqPort}` });
    if (String(reqPort) !== String(hp.value) && publish.checked) {
      flash(hostPort, 'shake');
      await fly(s.stage, hostPort, browser, { label: 'refused', cls: 'bad' });
      page.innerHTML = '<b>ERR_CONNECTION_REFUSED</b><br>Nothing listens on this port.';
      return s.say(`Nothing is published on host port <b>${reqPort}</b> — the container is mapped to <b>${hp.value}</b>. Use <code>curl localhost:${hp.value}</code>.`);
    }
    if (!publish.checked) {
      flash(hostPort, 'shake');
      await fly(s.stage, hostPort, browser, { label: 'refused', cls: 'bad' });
      page.innerHTML = '<b>ERR_CONNECTION_REFUSED</b><br>Nothing on your machine listens on this port.';
      return s.say('Without <code>-p</code>, the container\'s port 80 is <b>not reachable</b> from your machine. The container is isolated.');
    }
    await fly(s.stage, hostPort, ctrPort, { label: `→ :${cp.value}` });
    if (Number(cp.value) !== 80) {
      flash(ctrPort, 'shake');
      await fly(s.stage, ctrPort, browser, { label: 'reset', cls: 'bad' });
      page.innerHTML = '<b>ERR_EMPTY_RESPONSE</b><br>Forwarded, but nothing listens there.';
      return s.say(`Docker forwarded to container port <b>${cp.value}</b>, but nginx listens on <b>80</b>. The container port must match what the app listens on.`);
    }
    await fly(s.stage, ctrPort, nginx, { ms: 500 });
    flash(nginx);
    await fly(s.stage, nginx, browser, { label: '200 OK', cls: 'ok', ms: 1100 });
    page.innerHTML = '<b style="font-size:15px">Welcome to nginx!</b><br><small>served from inside the container</small>';
    s.say(`Request to <b>localhost:${hp.value}</b> was forwarded by Docker to <b>port ${cp.value} inside the container</b>. 🎉`);
  };
  s.btn('▶ Send request', () => send(), { primary: true });
  s.command([/^docker (?:container )?run (?:-d |--rm |--name \S+ )*(?:-p (?:127\.0\.0\.1:)?(\d+):(\d+) )?(?:-d |--rm |--name \S+ )*nginx(?::[\w.-]+)?$/], async (_, m) => {
    publish.checked = !!m[1];
    if (m[1]) { hp.value = m[1]; cp.value = m[2]; }
    sync();
    flash(hostPort);
    s.say(m[1] ? `Container started with host <b>${m[1]}</b> → container <b>${m[2]}</b>. Now test it: <code>curl localhost:${m[1]}</code>` : 'Container started <b>without</b> <code>-p</code>. Try <code>curl localhost:8080</code> and see what happens.');
  }, { example: 'docker run -d -p 3000:80 nginx' });
  s.command([/^curl (?:-\w+ )*(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d+))?\/?$/], (_, m) => send(m[1] || '80'), { example: 'curl localhost:8080' });
  s.add(preview);
  sync();
};

// =====================================================================
// 10. Volumes
// =====================================================================
A.volumes = (root) => {
  const s = scene(root, { title: 'Where does the data live?', hint: 'Choose a storage type, write files, remove the container, run a new one.' });
  const MODES = {
    none: { cmd: 'docker run -d --name app myapp', host: 'No mount — files live only in the container\'s writable layer', path: '/data' },
    volume: { cmd: 'docker run -d -v appdata:/data myapp', host: '🗄 Docker volume "appdata"  (/var/lib/docker/volumes/appdata)', path: '/data → appdata' },
    bind: { cmd: 'docker run -d -v ./site:/data myapp', host: '📁 Your folder ./site', path: '/data → ./site' },
  };
  let mode = 'none', ctr = null, n = 0, gen = 0;
  const hostFiles = [];
  const ctrArea = h('div', { class: 'vol-ctrs' });
  const hostChips = h('div', { class: 'chips' });
  const hostTitle = h('div', { class: 'node-title' });
  const disk = h('div', { class: 'disk' }, hostTitle, hostChips);
  const preview = h('code', { style: { fontSize: '12.5px' } });
  s.stage.append(h('div', { class: 'vol-scene' }, ctrArea, disk));

  const renderHost = () => {
    hostTitle.textContent = `💽 Host disk — ${MODES[mode].host}`;
    disk.style.opacity = mode === 'none' ? 0.45 : 1;
    hostChips.replaceChildren(...hostFiles.map((f) => h('span', { class: 'chip light' }, f)));
    preview.textContent = MODES[mode].cmd;
  };
  const fileChip = (name) => h('span', { class: 'file-chip pop' }, name);
  const makeCtr = () => {
    gen++;
    const files = h('div', { class: 'chips' });
    const el = h('div', { class: 'node blue pop', style: { minWidth: '230px' } }, title(`📦 container #${gen}`, MODES[mode].path), files);
    return { el, files, own: [] };
  };

  const setMode = (m) => { mode = m; sel.value = m; ctr = null; hostFiles.length = 0; ctrArea.replaceChildren(); renderHost(); s.refresh(); };
  const sel = h('select', { onchange: (e) => { setMode(e.target.value); s.say('Storage type changed. Press <b>docker run</b>.'); } },
    h('option', { value: 'none' }, 'No volume'), h('option', { value: 'volume' }, 'Named volume'), h('option', { value: 'bind' }, 'Bind mount'));
  s.add(h('label', { class: 'inline' }, 'Storage:', sel));
  s.sep();

  s.btn('▶ docker run', async (_, m) => {
    if (m) {
      const wanted = !m[1] ? 'none' : /^(\.|\/|\$|~)/.test(m[1]) ? 'bind' : 'volume';
      if (wanted !== mode) setMode(wanted);
    }
    ctr = makeCtr();
    ctrArea.append(ctr.el);
    if (mode !== 'none' && hostFiles.length) {
      await fly(s.stage, disk, ctr.el, { label: 'mount', ms: 700 });
      hostFiles.forEach((f) => ctr.files.append(fileChip(f)));
      s.say(`The new container mounts the same ${mode === 'volume' ? 'volume' : 'folder'} — <b>all ${hostFiles.length} file(s) are back</b>. 🎉`);
    } else s.say(mode === 'none' ? 'Fresh container, empty writable layer.' : 'Container started with the mount attached.');
  }, { primary: true, enabled: () => !ctr, why: 'A container is already running — remove it first: <code>docker rm -f app</code>', cmd: [/^docker (?:container )?run (?:-d |--name [\w-]+ )*(?:-v ([^\s:]+):\/data )?(?:-d |--name [\w-]+ )*myapp$/], example: 'docker run -d -v appdata:/data myapp' });
  s.btn('✎ Write file', async (_, m) => {
    n++;
    const name = m?.[1] || m?.[2] || `file${n}.txt`;
    ctr.files.append(fileChip(name));
    if (mode === 'none') { ctr.own.push(name); return s.say(`<b>${name}</b> written into the container's writable layer.`); }
    await fly(s.stage, ctr.el, disk, { label: name, cls: 'white', ms: 700 });
    hostFiles.push(name);
    renderHost();
    s.say(`<b>${name}</b> written to <code>/data</code> — which is really the ${mode === 'volume' ? 'volume' : 'host folder'}.`);
  }, { enabled: () => !!ctr, cmd: [/^docker exec (?:-it )?[\w-]+ (?:touch \/data\/([\w.-]+)|sh -c "?echo .*> ?\/data\/([\w.-]+)"?)$/], example: 'docker exec app touch /data/notes.txt' });
  s.btn('🗑 docker rm -f', async () => {
    const lost = ctr.own.length;
    await removeAnimated(ctr.el);
    ctr = null;
    s.say(mode === 'none' ? `Container removed. <b>${lost} file(s) lost forever</b> — they lived in the writable layer.` : `Container removed, but the data is <b>safe on the host</b> (${hostFiles.length} file(s)).`);
  }, { enabled: () => !!ctr, cmd: [/^docker (?:container )?rm (?:-f|--force) [\w-]+$/], example: 'docker rm -f app' });
  s.btn('✎ Edit on host', async (_, m) => {
    n++;
    const name = m?.[1] || m?.[2] || `edited${n}.html`;
    hostFiles.push(name);
    renderHost();
    await fly(s.stage, disk, ctr.el, { label: name, cls: 'white', ms: 700 });
    ctr.files.append(fileChip(name));
    s.say('You changed a file in your editor and it appeared <b>instantly</b> inside the container. This is why bind mounts are great for development.');
  }, { enabled: () => mode === 'bind' && !!ctr, why: () => (mode !== 'bind' ? 'This only works with a bind mount: <code>docker run -d -v ./site:/data myapp</code>' : 'Start a container first.'), cmd: [/^(?:touch \.?\/?site\/([\w.-]+)|echo .*> ?\.?\/?site\/([\w.-]+))$/], example: 'echo "<h1>hi</h1>" > site/index.html' });
  s.command([/^docker volume (?:ls|list)$/], async () => {
    s.say(mode === 'volume' ? 'DRIVER  VOLUME NAME<br><code>local   appdata</code> — Docker keeps it even when no container uses it.' : 'No named volumes in this setup. Bind mounts are just host folders, so they do not show up here.');
  }, { example: 'docker volume ls' });
  s.command([/^docker volume rm [\w-]+$/], async () => {
    if (ctr) return s.say('<span class="err">Error: remove appdata: volume is in use</span> — remove the container first.');
    hostFiles.length = 0;
    renderHost();
    s.say('Volume deleted — <b>its data is gone for good</b>. This is the one way named-volume data really disappears.');
  }, { enabled: () => mode === 'volume', example: 'docker volume rm appdata' });
  s.add(preview);
  renderHost();
};

// =====================================================================
// 11. Networking
// =====================================================================
A.networks = (root) => {
  const s = scene(root, { title: 'Default bridge vs user-defined network', hint: 'Try pinging <b>db</b> by name first.' });
  const mk = (name, ip) => {
    const ipEl = h('small', {}, ip);
    return { name, el: h('div', { class: 'net-ctr' }, `📦 ${name}`, ipEl), ipEl, net: 'bridge' };
  };
  const C = { web: mk('web', '172.17.0.2'), api: mk('api', '172.17.0.3'), db: mk('db', '172.17.0.4') };
  const bridgeCtrs = h('div', { class: 'net-ctrs' }, C.web.el, C.api.el, C.db.el);
  const dns = h('span', { class: 'chip light' }, '🧭 DNS 127.0.0.11');
  const appCtrs = h('div', { class: 'net-ctrs' });
  const appTitle = h('div', { class: 'zone-title' }, 'appnet (not created)');
  const appZone = h('div', { class: 'net-zone hidden-zone' }, appTitle, h('div', { style: { marginBottom: '8px' } }, dns), appCtrs);
  s.stage.append(h('div', { class: 'net-scene' },
    h('div', { class: 'net-zone' }, h('div', { class: 'zone-title' }, 'bridge (default) · no DNS'), bridgeCtrs), appZone));
  let created = false;

  const ping = async (from, target = 'db') => {
    const a = C[from];
    const byIp = /^\d+\.\d+\.\d+\.\d+$/.test(target);
    const b = byIp ? Object.values(C).find((c) => c.ipEl.textContent === target) : C[target];
    s.say(`<code>docker exec ${from} ping ${target}</code>…`);
    if (b === a) return s.say(`Pinging itself works, but that does not teach us much — try another container.`);
    if (byIp) {
      if (!b || b.net !== a.net) {
        flash(a.el, 'shake');
        return s.say(`<b>100% packet loss</b> — no container at ${target} on <b>${a.net}</b>. Different networks cannot reach each other.`);
      }
      await fly(s.stage, a.el, b.el, { label: 'ICMP', ms: 700 });
      await fly(s.stage, b.el, a.el, { label: 'reply', cls: 'ok', ms: 700 });
      return s.say(`<b>64 bytes from ${target}</b> — IPs work on the same network${a.net === 'bridge' ? ', even the default bridge. But IPs change when containers restart, which is why names are better' : ''}.`);
    }
    if (!b) return s.say(`<span class="err">ping: bad address '${escapeHtml(target)}'</span> — there is no container with that name.`);
    if (a.net !== 'appnet' || b.net !== 'appnet') {
      flash(a.el, 'shake');
      return s.say(a.net === 'bridge' && b.net === 'bridge'
        ? `<b>ping: bad address '${target}'</b> — the default bridge has no DNS, so names do not resolve. (Its IP ${b.ipEl.textContent} would work, but IPs change.)`
        : `<b>ping: bad address '${target}'</b> — <b>${from}</b> and <b>${target}</b> are not both on <b>appnet</b>. Networks isolate containers from each other.`);
    }
    await fly(s.stage, a.el, dns, { label: `${target}?`, cls: 'white', ms: 700 });
    await fly(s.stage, dns, a.el, { label: b.ipEl.textContent, ms: 700 });
    await fly(s.stage, a.el, b.el, { label: 'ICMP', ms: 700 });
    await fly(s.stage, b.el, a.el, { label: 'reply', cls: 'ok', ms: 700 });
    s.say(`<b>64 bytes from ${target} (${b.ipEl.textContent})</b> — Docker's embedded DNS resolved the name <b>${target}</b>. 🎉`);
  };
  const connect = async (k) => {
    await moveTo(C[k].el, appCtrs);
    C[k].net = 'appnet';
    C[k].ipEl.textContent = `172.18.0.${appCtrs.children.length + 1}`;
  };
  const createNet = async () => {
    created = true;
    appZone.classList.remove('hidden-zone');
    appTitle.textContent = 'appnet (user-defined) · DNS on';
    flash(appZone);
    s.say('Created <b>appnet</b>, a user-defined bridge with built-in DNS.');
  };

  s.btn('api → ping db', () => ping('api'), { mono: true, primary: true });
  s.btn('web → ping db', () => ping('web'), { mono: true });
  s.command([/^docker exec (?:-it )?(web|api|db) ping (?:-c \d+ )?([\w.-]+)(?: -c \d+)?$/], (_, m) => ping(m[1], m[2]), { example: 'docker exec api ping db' });
  s.sep();
  s.btn('docker network create appnet', createNet, { mono: true, enabled: () => !created, cmd: [/^docker network create (?:-d bridge |--driver bridge )?appnet$/] });
  s.btn('run api + db on appnet', async () => {
    for (const k of ['api', 'db']) if (C[k].net !== 'appnet') await connect(k);
    s.say('<code>docker run --network appnet …</code> — api and db now share appnet. <b>web</b> stays on the default bridge. Try both pings!');
  }, { mono: true, enabled: () => created && C.api.net !== 'appnet' });
  s.command([/^docker network connect appnet (web|api|db)$/], async (_, m) => {
    if (!created) return s.say('<span class="err">Error: network appnet not found</span> — create it first.');
    if (C[m[1]].net === 'appnet') return s.say(`<b>${m[1]}</b> is already on appnet.`);
    await connect(m[1]);
    s.say(`<b>${m[1]}</b> joined appnet and can now reach other appnet containers by name.`);
  }, { example: 'docker network connect appnet web' });
  s.command([/^docker network (?:ls|list)$/], async () => {
    s.say(`NETWORK: <code>bridge</code> (default) · <code>host</code> · <code>none</code>${created ? ' · <code>appnet</code> (yours)' : ''}`);
  }, { example: 'docker network ls' });
  s.command([/^docker network inspect (appnet|bridge)$/], async (_, m) => {
    if (m[1] === 'appnet' && !created) return s.say('<span class="err">Error: No such network: appnet</span>');
    const members = Object.values(C).filter((c) => c.net === m[1]).map((c) => `${c.name} ${c.ipEl.textContent}`);
    s.say(`<b>${m[1]}</b> containers: ${members.length ? members.map((x) => `<code>${x}</code>`).join(', ') : 'none'}`);
  }, { example: 'docker network inspect appnet' });
};

// =====================================================================
// 12. ARG vs ENV, build time vs run time
// =====================================================================
A.buildVsRun = (root) => {
  const s = scene(root, { title: 'Build time vs run time', hint: 'Build first, then run — with and without an override.' });
  const buildBox = h('div', { class: 'chips', style: { minHeight: '70px' } });
  const imgBox = h('div', { class: 'chips', style: { minHeight: '70px' } });
  const runTerm = mkTerm({ minHeight: '90px' });
  const buildNode = h('div', { class: 'node' }, title('🔨 docker build'), buildBox);
  const imgNode = h('div', { class: 'node blue' }, title('📦 image myapp'), imgBox);
  const runNode = h('div', { class: 'node' }, title('▶ docker run', 'printenv'), runTerm);
  s.stage.append(h('div', { class: 'reg-scene' }, buildNode, imgNode, runNode));
  let built = false;

  const useOverride = h('input', { type: 'checkbox' });
  const val = h('input', { type: 'text', value: 'staging' });
  s.add(h('label', { class: 'inline' }, useOverride, '-e APP_ENV='), val);
  s.sep();

  s.btn('1. docker build', async (_, m) => {
    const nodeVer = m?.[1] || m?.[2] || '20';
    buildBox.replaceChildren(); imgBox.replaceChildren(); runTerm.replaceChildren();
    const arg = h('span', { class: 'chip warn pop' }, `ARG NODE_VERSION=${nodeVer}`);
    const env = h('span', { class: 'chip blue pop' }, 'ENV APP_ENV=production');
    buildBox.append(arg);
    s.say(`<b>ARG</b> is available while the Dockerfile runs — here it picks <code>FROM node:${nodeVer}-alpine</code>.${nodeVer !== '20' ? ' Your <code>--build-arg</code> overrode the default 20.' : ''}`);
    await wait(900);
    buildBox.append(env);
    s.say('<b>ENV</b> is set during the build too…');
    await wait(900);
    await fly(s.stage, env, imgBox, { label: 'APP_ENV', ms: 800 });
    imgBox.append(h('span', { class: 'chip blue pop' }, 'APP_ENV=production'));
    s.say('…and is <b>saved into the image</b> as a default.');
    await wait(700);
    arg.classList.add('fade-out');
    await wait(500);
    buildBox.append(h('span', { class: 'chip ghost pop' }, 'build finished: ARG discarded'));
    built = true;
    s.say('Build done. The <b>ARG is gone</b>; only ENV made it into the image. Now run a container.');
  }, { primary: true, cmd: [/^docker (?:image )?build (?:--build-arg node_version=(\d+) )?(?:-t myapp(?::[\w.-]+)? )?(?:--build-arg node_version=(\d+) )?\.$/], example: 'docker build --build-arg NODE_VERSION=22 -t myapp .' });
  s.btn('2. docker run', async (_, m) => {
    if (m) { useOverride.checked = !!m[1]; if (m[1]) val.value = m[1]; }
    const override = useOverride.checked ? val.value.trim() || 'staging' : null;
    runTerm.replaceChildren();
    await fly(s.stage, imgNode, runNode, { label: 'start', ms: 700 });
    if (override) await fly(s.stage, s.controls, runNode, { label: `-e APP_ENV=${override}`, cls: 'white', ms: 800 });
    typed(runTerm, 'printenv APP_ENV NODE_VERSION', '/ #');
    out(runTerm, `APP_ENV=<span class="${override ? 'y' : 'ok'}">${escapeHtml(override || 'production')}</span>`);
    out(runTerm, '<span class="bad">NODE_VERSION: (not set)</span>');
    s.say(override ? `<b>-e</b> overrode the image default: same image, now configured as <b>${escapeHtml(override)}</b>.` : 'The container sees the image\'s ENV default. NODE_VERSION is missing — ARGs never reach runtime.');
  }, { enabled: () => built, why: 'There is no <b>myapp</b> image yet — build it first: <code>docker build -t myapp .</code>', cmd: [/^docker (?:container )?run (?:--rm |-d )*(?:-e app_env=([\w-]+) )?(?:--rm |-d )*myapp(?: printenv.*)?$/], example: 'docker run -e APP_ENV=staging myapp' });
};

// =====================================================================
// 13. Docker Compose
// =====================================================================
A.compose = (root) => {
  const s = scene(root, { title: 'docker compose up / down', hint: 'Bring the whole stack up with one command.' });
  const net = h('div', { class: 'compose-net', style: { opacity: 0.25 } });
  const netTitle = h('div', { class: 'zone-title' }, 'network: myapp_default (not created)');
  const volChip = h('span', { class: 'chip ghost' }, '🗄 volume myapp_pgdata (none)');
  const term = mkTerm({ height: '140px' });
  s.stage.append(h('div', { class: 'compose-scene' }, h('div', {}, netTitle, net), h('div', {}, volChip), term));
  let up = false, volume = false;
  const svcs = [];

  const startSvc = async (name, image, extra = '') => {
    const status = h('small', {}, 'starting…');
    const el = h('div', { class: 'svc pop' }, h('span', { class: 'status-dot running' }), ` ${name}`, h('small', {}, image), status);
    net.append(el);
    svcs.push({ name, el, status });
    out(term, ` ✔ Container ${name}  <span class="ok">Started</span>${extra}`);
    await wait(500);
    status.textContent = 'running';
    return status;
  };

  s.btn('docker compose up -d', async () => {
    typed(term, 'docker compose up -d');
    net.style.opacity = 1; netTitle.textContent = 'network: myapp_default';
    flash(net);
    out(term, ' ✔ Network myapp_default  <span class="ok">Created</span>');
    s.say('First the project <b>network</b>, so services can find each other by name…');
    await wait(700);
    if (!volume) {
      volume = true;
      volChip.className = 'chip light pop'; volChip.textContent = '🗄 volume myapp_pgdata';
      out(term, ' ✔ Volume myapp_pgdata  <span class="ok">Created</span>');
      await wait(600);
    } else out(term, ' ✔ Volume myapp_pgdata  <span class="dim">Exists (data kept!)</span>');
    s.say('…then <b>db</b>. api waits until its healthcheck passes (<code>condition: service_healthy</code>).');
    const dbStatus = await startSvc('myapp-db-1', 'postgres:16');
    dbStatus.textContent = 'health: starting';
    await wait(1300);
    dbStatus.textContent = 'healthy ✓';
    out(term, ' ✔ Container myapp-db-1  <span class="ok">Healthy</span>');
    s.say('db is <b>healthy</b> → start <b>api</b>, then <b>web</b> (depends_on api).');
    await startSvc('myapp-api-1', 'build: ./api');
    await startSvc('myapp-web-1', 'nginx:1.27', '  0.0.0.0:8080→80');
    up = true;
    s.say('Stack is up: 3 containers, 1 network, 1 volume — from <b>one command</b>. Open <code>localhost:8080</code>.');
  }, { primary: true, mono: true, enabled: () => !up, why: 'The stack is already up.', cmd: [/^docker[ -]compose up(?: -d| --detach)?(?: --build)?$/] });
  const apiCount = () => svcs.filter((x) => x.name.startsWith('myapp-api-')).length;
  s.btn('--scale api=3', async (_, m) => {
    const want = Math.max(1, Math.min(5, Number(m?.[1] || 3)));
    typed(term, `docker compose up -d --scale api=${want}`);
    for (let i = apiCount() + 1; i <= want; i++) await startSvc(`myapp-api-${i}`, 'build: ./api');
    for (let i = apiCount(); i > want; i--) {
      const x = svcs.find((v) => v.name === `myapp-api-${i}`);
      out(term, ` ✔ Container ${x.name}  <span class="bad">Removed</span>`);
      svcs.splice(svcs.indexOf(x), 1);
      await removeAnimated(x.el);
    }
    s.say(`<b>api</b> now runs <b>${want}</b> replica${want > 1 ? 's' : ''}. Compose DNS round-robins the name <code>api</code> across them.${Number(m?.[1]) > 5 ? ' (This demo caps it at 5.)' : ''}`);
  }, { mono: true, enabled: () => up, why: 'Start the stack first: <code>docker compose up -d</code>', cmd: [/^docker[ -]compose up (?:-d |--detach )?--scale api=(\d+)(?: -d| --detach)?$/], example: 'docker compose up -d --scale api=4' });
  s.btn('docker compose ps', async () => {
    typed(term, 'docker compose ps');
    out(term, '<span class="dim">NAME            STATUS</span>');
    svcs.forEach((x) => out(term, `${x.name.padEnd(16)}${x.status.textContent}`));
  }, { mono: true, enabled: () => up, why: 'Nothing is running — start the stack with <code>docker compose up -d</code>.', cmd: [/^docker[ -]compose (?:ps|ls)$/] });
  s.command([/^docker[ -]compose logs (?:-f )?(web|api|db)$/], async (_, m) => {
    typed(term, m.input);
    const LOGS = { db: 'database system is ready to accept connections', api: 'Listening on :3000, connected to db:5432', web: '"GET / HTTP/1.1" 200 615' };
    svcs.filter((x) => x.name.includes(`-${m[1]}-`)).forEach((x) => out(term, `<span class="y">${x.name}</span>  | ${escapeHtml(LOGS[m[1]])}`));
    s.say(`Logs from every <b>${m[1]}</b> container, each line prefixed with the container name.`);
  }, { enabled: () => up, why: 'No containers yet — <code>docker compose up -d</code> first.', example: 'docker compose logs api' });
  const down = async (withVolumes) => {
    typed(term, `docker compose down${withVolumes ? ' -v' : ''}`);
    for (const x of svcs.slice().reverse()) {
      out(term, ` ✔ Container ${x.name}  <span class="bad">Removed</span>`);
      await removeAnimated(x.el);
    }
    svcs.length = 0;
    net.style.opacity = 0.25; netTitle.textContent = 'network: myapp_default (removed)';
    out(term, ' ✔ Network myapp_default  <span class="bad">Removed</span>');
    if (withVolumes) {
      volume = false;
      volChip.className = 'chip ghost'; volChip.textContent = '🗄 volume myapp_pgdata (deleted)';
      out(term, ' ✔ Volume myapp_pgdata  <span class="bad">Removed</span>');
    }
    up = false;
    s.say(withVolumes ? 'Everything removed, <b>including the database volume</b>. The data is gone.' : 'Containers and network removed. The <b>volume is kept</b> — run up again and your data is still there.');
  };
  s.btn('docker compose down', () => down(false), { mono: true, enabled: () => up, why: 'The stack is already down.', cmd: [/^docker[ -]compose down$/] });
  s.btn('down -v', () => down(true), { mono: true, enabled: () => up, why: 'The stack is already down.', cmd: [/^docker[ -]compose down (?:-v|--volumes)$/], example: 'docker compose down -v' });

  // ---- everyday compose workflow (typed only) ----
  const pick = (svc) => svcs.filter((x) => !svc || x.name.includes(`-${svc}-`));
  const setState = (list, state) => list.forEach((x) => {
    x.status.textContent = state;
    x.el.querySelector('.status-dot').className = `status-dot ${state === 'running' ? 'running' : state === 'paused' ? 'paused' : 'exited'}`;
    flash(x.el);
  });
  const lifecycle = (verb, state) => s.command([new RegExp(`^docker[ -]compose ${verb}(?: (web|api|db))?$`)], async (_, m) => {
    typed(term, m.input);
    const list = pick(m[1]);
    for (const x of list) { setState([x], state); out(term, ` ✔ Container ${x.name}  <span class="ok">${verb === 'stop' ? 'Stopped' : verb === 'pause' ? 'Paused' : 'Started'}</span>`); await wait(250); }
    s.say({ stop: 'Stopped, but <b>not removed</b>: containers, network and volume stay. <code>docker compose start</code> brings them back.', start: 'Started the existing containers again — <code>start</code> never creates new ones (that is <code>up</code>).', restart: 'Restarted. Note: restart does <b>not</b> apply edits to compose.yaml — use <code>up -d</code> for that.', pause: 'Frozen in place. <code>docker compose unpause</code> continues.', unpause: 'Running again.' }[verb]);
  }, { enabled: () => up, why: 'Start the stack first: <code>docker compose up -d</code>', example: `docker compose ${verb}${verb === 'stop' ? ' api' : ''}` });
  lifecycle('stop', 'exited');
  lifecycle('start', 'running');
  lifecycle('restart', 'running');
  lifecycle('pause', 'paused');
  lifecycle('unpause', 'running');

  const EXEC = { 'ping db': 'PING db (172.18.0.2): 64 bytes from 172.18.0.2: seq=0 ttl=64 time=0.08 ms', 'ping api': 'PING api (172.18.0.3): 64 bytes from 172.18.0.3: seq=0 ttl=64 time=0.07 ms', ls: 'node_modules  package.json  server.js', env: 'DATABASE_URL=postgres://postgres:example@db:5432/app', 'psql -u postgres -c "select 1"': ' ?column?\n----------\n        1\n(1 row)', sh: '(interactive shell — try it for real in the Compose commands lab)' };
  s.command([/^docker[ -]compose exec (web|api|db) (.+)$/], async (_, m) => {
    typed(term, m.input);
    const x = pick(m[1])[0];
    if (x.status.textContent !== 'running') return s.say(`<span class="err">service "${m[1]}" is not running</span> — <code>docker compose start ${m[1]}</code>`);
    flash(x.el);
    out(term, escapeHtml(EXEC[m[2]] || `(ran "${m[2]}" inside ${x.name})`).replace(/\\n/g, '\n'));
    s.say(`<code>exec</code> runs <b>inside the existing</b> ${m[1]} container — use the service name, no <code>-it</code> needed. Service names resolve on the project network.`);
  }, { enabled: () => up, why: 'Nothing is running — <code>docker compose up -d</code> first.', example: 'docker compose exec api ping db' });
  s.command([/^docker[ -]compose run (?:--rm )?(api|web|db)(?: (.+))?$/], async (_, m) => {
    typed(term, m.input);
    const name = `myapp-${m[1]}-run-${Math.random().toString(16).slice(2, 8)}`;
    const el = h('div', { class: 'svc pop', style: { borderStyle: 'dashed' } }, h('span', { class: 'status-dot running' }), ` ${name}`, h('small', {}, 'one-off'), h('small', {}, m[2] || 'default command'));
    net.append(el);
    await wait(900);
    out(term, escapeHtml(m[2] === 'node --version' ? 'v20.18.0' : m[2] ? `(output of ${m[2]})` : 'Listening on :3000'));
    const rm = /--rm/.test(m.input);
    if (rm) await removeAnimated(el); else { el.querySelector('.status-dot').className = 'status-dot exited'; }
    s.say(`<code>run</code> makes a <b>new one-off container</b> from the ${m[1]} service config (dependencies started, ports <b>not</b> published).${rm ? ' <code>--rm</code> removed it afterwards.' : ' Without <code>--rm</code> it stays behind — add --rm next time.'}`);
  }, { enabled: () => up, why: 'Start the stack first: <code>docker compose up -d</code>', example: 'docker compose run --rm api node --version' });
  s.command([/^docker[ -]compose config(?: --services)?$/], async (_, m) => {
    typed(term, m.input);
    if (/--services/.test(m.input)) ['db', 'api', 'web'].forEach((x) => out(term, x));
    else out(term, 'name: myapp\nservices:\n  api: { build: ./api, depends_on: { db: { condition: service_healthy } } }\n  db: { image: postgres:16, volumes: [pgdata:/var/lib/postgresql/data] }\n  web: { image: nginx:1.27, ports: ["8080:80"] }');
    s.say('<code>config</code> validates the file and prints what Compose will really use — after defaults, merges and variable substitution.');
  }, { example: 'docker compose config --services' });
  s.command([/^docker[ -]compose (build|pull)$/], async (_, m) => {
    typed(term, m.input);
    if (m[1] === 'build') { out(term, ' => [api] building ./api'); await wait(600); out(term, ' ✔ Service api  <span class="ok">Built</span>'); }
    else { out(term, ' - api Skipped - No image to be pulled'); out(term, ' ✔ db  <span class="ok">Pulled</span>'); out(term, ' ✔ web <span class="ok">Pulled</span>'); }
    s.say(m[1] === 'build' ? 'Only services with a <code>build:</code> section are built — here just api.' : 'Pulls image-based services; build-only services are skipped. Then <code>up -d</code> recreates on the new images.');
  }, { example: 'docker compose build' });
};

// =====================================================================
// 14. Prune
// =====================================================================
A.prune = (root) => {
  const s = scene(root, { title: 'What does each prune remove?', hint: 'Try the prunes in different orders.' });
  const INITIAL = () => ({
    containers: [
      { id: 'web', image: 'nginx:1.27', vol: 'webdata', running: true, mb: 2 },
      { id: 'old-api', image: 'myapi:1', vol: 'apidata', running: false, mb: 5 },
      { id: 'test-1', image: 'alpine', running: false, mb: 1 },
      { id: 'test-2', image: 'alpine', running: false, mb: 1 },
    ],
    images: [
      { id: 'nginx:1.27', mb: 190 }, { id: 'myapi:1', mb: 320 }, { id: 'alpine', mb: 8 }, { id: 'postgres:15', mb: 420 },
      { id: '<none> a1f3', mb: 310, dangling: true }, { id: '<none> 9c2e', mb: 305, dangling: true }, { id: '<none> 77b0', mb: 290, dangling: true },
    ],
    volumes: [{ id: 'webdata', mb: 50 }, { id: 'apidata', mb: 120 }, { id: 'pgdata_old', mb: 900 }, { id: 'tmpvol', mb: 30 }],
    cache: [{ id: 'cache #1', mb: 400 }, { id: 'cache #2', mb: 380 }, { id: 'cache #3', mb: 260 }, { id: 'cache #4', mb: 150 }],
  });
  let st = INITIAL();
  const cols = { containers: h('div', { class: 'chips' }), images: h('div', { class: 'chips' }), volumes: h('div', { class: 'chips' }), cache: h('div', { class: 'chips' }) };
  const diskBar = mkBar(), diskTxt = h('b', { style: { fontFamily: 'var(--mono)' } });
  s.stage.append(
    h('div', { class: 'metric', style: { gridTemplateColumns: '120px 1fr 90px', marginBottom: '14px' } }, h('span', {}, 'docker system df'), diskBar, diskTxt),
    h('div', { class: 'prune-grid' }, ...Object.entries(cols).map(([k, el]) => h('div', { class: 'node' }, title(k[0].toUpperCase() + k.slice(1)), el))));

  const usedImages = () => new Set(st.containers.map((c) => c.image));
  const usedVols = () => new Set(st.containers.map((c) => c.vol).filter(Boolean));
  const total = () => Object.values(st).flat().reduce((n, x) => n + x.mb, 0);
  const render = () => {
    const ui = usedImages(), uv = usedVols();
    const chip = (x, cls, label = x.id) => h('span', { class: `chip ${cls}`, 'data-id': x.id }, label, h('small', { style: { fontWeight: 500 } }, ` ${fmtMB(x.mb)}`));
    cols.containers.replaceChildren(...st.containers.map((c) => chip(c, c.running ? 'ok' : '', `${c.running ? '🟢' : '⬛'} ${c.id}`)));
    cols.images.replaceChildren(...st.images.map((i) => chip(i, i.dangling ? 'warn' : ui.has(i.id) ? 'light' : '')));
    cols.volumes.replaceChildren(...st.volumes.map((v) => chip(v, uv.has(v.id) ? 'light' : '')));
    cols.cache.replaceChildren(...st.cache.map((c) => chip(c, '')));
    const t = total();
    setBar(diskBar, (t / 4100) * 100);
    diskTxt.textContent = fmtMB(t);
  };
  const sweep = async (kind, pred, cmd, msg) => {
    const victims = st[kind].filter(pred);
    if (!victims.length) return s.say(`<code>${cmd}</code> → nothing to remove. ${msg}`);
    const before = total();
    victims.forEach((v) => {
      const el = cols[kind].querySelector(`[data-id="${CSS.escape(v.id)}"]`);
      if (el) { el.classList.add('bad'); flash(el, 'shake'); }
    });
    await wait(600);
    victims.forEach((v) => cols[kind].querySelector(`[data-id="${CSS.escape(v.id)}"]`)?.classList.add('fade-out'));
    await wait(450);
    st[kind] = st[kind].filter((x) => !victims.includes(x));
    render();
    s.say(`<code>${cmd}</code> → removed ${victims.length} item(s), reclaimed <b>${fmtMB(before - total())}</b>. ${msg}`);
  };

  s.btn('container prune', () => sweep('containers', (c) => !c.running, 'docker container prune', 'Stopped containers are gone; their images may now be unused.'), { mono: true, cmd: [/^docker container prune(?: -f| --force)?$/], example: 'docker container prune' });
  s.btn('image prune', () => sweep('images', (i) => i.dangling, 'docker image prune', 'Only <b>dangling</b> &lt;none&gt; images.'), { mono: true, cmd: [/^docker image prune(?: -f| --force)?$/], example: 'docker image prune' });
  s.btn('image prune -a', () => sweep('images', (i) => !usedImages().has(i.id), 'docker image prune -a', 'Every image not used by <i>any</i> container (running or stopped).'), { mono: true, cmd: [/^docker image prune (?:-a|--all)(?: -f| --force)?$/, /^docker image prune -af$/], example: 'docker image prune -a' });
  s.btn('volume prune', () => sweep('volumes', (v) => !usedVols().has(v.id), 'docker volume prune', '⚠ Unused volumes deleted — <b>that was data</b>.'), { mono: true, cmd: [/^docker volume prune(?: -a| --all)?(?: -f| --force)?$/], example: 'docker volume prune' });
  s.btn('builder prune', () => sweep('cache', () => true, 'docker builder prune', 'Build cache cleared; next builds start cold.'), { mono: true, cmd: [/^docker (?:builder|buildx) prune(?: -f| --force)?$/], example: 'docker builder prune' });
  s.command([/^docker system prune(?: -a| --all)?(?: -f| --force)?$/], async (_, m) => {
    const all = /-a/.test(m.input);
    await sweep('containers', (c) => !c.running, 'docker container prune', '');
    await sweep('images', (i) => (all ? !usedImages().has(i.id) : i.dangling), all ? 'docker image prune -a' : 'docker image prune', '');
    await sweep('cache', () => true, 'docker builder prune', '');
    s.say(`<code>${escapeHtml(m.input)}</code> = stopped containers + ${all ? 'all unused' : 'dangling'} images + build cache (+ unused networks). <b>Volumes are kept</b> unless you add <code>--volumes</code>.`);
  }, { example: 'docker system prune' });
  s.command([/^docker system df$/], async () => {
    const sum = (k) => fmtMB(st[k].reduce((n, x) => n + x.mb, 0));
    s.say(`TYPE / SIZE — Images <b>${sum('images')}</b> · Containers <b>${sum('containers')}</b> · Volumes <b>${sum('volumes')}</b> · Build cache <b>${sum('cache')}</b>`);
  }, { example: 'docker system df' });
  s.btn('↺ Reset', async () => { st = INITIAL(); render(); s.say('Reset. Light-blue items are in use; orange are dangling.'); });
  render();
  s.say('Light-blue items are <b>in use</b> by a container. Orange images are <b>dangling</b>.');
};

// =====================================================================
// 15. Multi-stage builds
// =====================================================================
A.multiStage = (root) => {
  const s = scene(root, { title: 'Multi-stage build', hint: 'Press <b>Build</b> and watch what reaches the final image.' });
  const s1Items = h('div', { class: 'chips' });
  const s2Items = h('div', { class: 'chips' });
  const compile = mkBar();
  const s1 = h('div', { class: 'node', style: { transition: 'opacity .5s' } }, title('Stage 1 · build', 'golang:1.23'), s1Items, h('div', { style: { marginTop: '10px' } }, compile));
  const s2 = h('div', { class: 'node blue', style: { marginTop: '18px' } }, title('Stage 2 · final', 'distroless/static'), s2Items);
  const bars = { single: mkBar('bad'), multi: mkBar('ok') };
  const vals = { single: h('b'), multi: h('b') };
  s.stage.append(h('div', { class: 'ms-scene' }, h('div', {}, s1, s2),
    h('div', { class: 'size-bars node' }, title('📏 Final image size'),
      h('div', { class: 'row' }, h('span', {}, 'single-stage'), bars.single, vals.single),
      h('div', { class: 'row' }, h('span', {}, 'multi-stage'), bars.multi, vals.multi),
      h('p', { style: { fontSize: '13px', color: 'var(--muted)', margin: '10px 0 0' } }, 'Smaller images pull faster, start faster and have fewer packages to attack.'))));

  const reset = () => {
    s1Items.replaceChildren(); s2Items.replaceChildren(h('span', { class: 'pg-empty' }, 'empty'));
    setBar(compile, 0); s1.style.opacity = 1;
    Object.keys(bars).forEach((k) => { setBar(bars[k], 0); vals[k].textContent = '—'; });
  };
  s.btn('▶ Build', async () => {
    reset();
    for (const [label, why] of [['Go toolchain 800 MB', 'FROM golang:1.23'], ['go modules 60 MB', 'RUN go mod download'], ['source + tests', 'COPY . .']]) {
      s1Items.append(h('span', { class: 'chip pop' }, label));
      s.say(`Stage 1: <code>${why}</code>`);
      await wait(700);
    }
    s.say('Stage 1: <code>RUN go build</code> — compiling…');
    for (let p = 0; p <= 100; p += 10) { setBar(compile, p); await wait(110); }
    const bin = h('span', { class: 'chip blue pop' }, '⚙ app binary 9 MB');
    s1Items.append(bin);
    await wait(500);
    s.say('Stage 2: <code>COPY --from=build /out/app /app</code> — only the binary crosses over.');
    await fly(s.stage, bin, s2, { label: 'COPY --from=build', ms: 1200 });
    s2Items.replaceChildren(h('span', { class: 'chip pop' }, 'distroless base 2 MB'), h('span', { class: 'chip blue pop' }, '⚙ app 9 MB'));
    s1.style.opacity = 0.35;
    s1Items.append(h('span', { class: 'chip ghost pop' }, '✕ discarded — not shipped'));
    setBar(bars.single, 100); vals.single.textContent = '~870 MB';
    await wait(300);
    setBar(bars.multi, 1.3); vals.multi.textContent = '~11 MB';
    s.say('The final image contains <b>only stage 2</b>: about <b>80× smaller</b>, no compiler, no shell, no source code.');
  }, { primary: true, cmd: [/^docker (?:image |buildx )?build (?:(?:-t|--tag) [\w.:\/-]+ )?\.$/], example: 'docker build -t myapp .' });
  s.command([/^docker (?:image )?build --target build (?:(?:-t|--tag) [\w.:\/-]+ )?\.$/], async () => {
    s.say('<code>--target build</code> stops after stage 1 — you get the <b>big builder image</b> (~870 MB), handy for running tests with the toolchain.');
  }, { example: 'docker build --target build -t myapp:builder .' });
  s.btn('Reset', async () => { reset(); s.say('Reset.'); });
  reset();
};

// =====================================================================
// 16. Registry: tag, login, push, pull
// =====================================================================
A.registry = (root) => {
  const s = scene(root, { title: 'tag → push → pull', hint: 'Tag the image, log in, push, then pull on the server.' });
  const term = mkTerm({ height: '130px', marginTop: '14px' });
  const tagsEl = h('div', { class: 'chips' });
  const layerBox = h('div', { class: 'stack' });
  const regBox = h('div', { class: 'chips', style: { minHeight: '60px' } });
  const regTags = h('div', { class: 'chips', style: { marginTop: '8px' } });
  const srvBox = h('div', { class: 'chips', style: { minHeight: '60px' } });
  const laptop = h('div', { class: 'node' }, title('💻 Laptop', 'image ID 4f2a…'), tagsEl, h('div', { style: { height: '8px' } }), layerBox);
  const registry = h('div', { class: 'node blue' }, title('☁ Registry', 'docker.io'), zone('Stored layers', regBox), regTags);
  const server = h('div', { class: 'node' }, title('🖥 Server', 'production'), zone('Layers', srvBox));
  s.stage.append(h('div', { class: 'reg-scene' }, laptop, registry, server), term);

  let tagged = false, logged = false, version = '1.0', codeId = randomHex(8), user = 'kunal';
  const remote = () => `${user}/myapp:${version}`;
  const regLayers = new Set(), srvLayers = new Set(), pushed = new Set();
  const layers = () => [['alpine base', '7 MB', 'base0001'], ['dependencies', '35 MB', 'deps0002'], ['your code', '2 MB', codeId]];
  const render = () => {
    tagsEl.replaceChildren(h('span', { class: 'chip' }, `myapp:${version}`), tagged && h('span', { class: 'chip blue pop' }, remote()));
    layerBox.replaceChildren(...layers().map(([n, sz, id]) => h('div', { class: 'layer', 'data-id': id }, `${n} · ${sz}`)));
    regBox.replaceChildren(...[...regLayers].map((id) => h('span', { class: 'chip light' }, id.slice(0, 8))));
    regTags.replaceChildren(...[...pushed].map((t) => h('span', { class: 'chip blue' }, t)));
    srvBox.replaceChildren(...[...srvLayers].map((id) => h('span', { class: 'chip light' }, id.slice(0, 8))));
  };

  s.btn('docker tag', async (_, m) => {
    if (m) {
      if (m[1] !== version) return s.say(`<span class="err">Error: No such image: myapp:${escapeHtml(m[1])}</span> — the local image is <code>myapp:${version}</code>.`);
      user = m[2];
      if (m[3] !== version) return s.say(`Tip: keep the same tag — use <code>docker tag myapp:${version} ${user}/myapp:${version}</code>.`);
    }
    typed(term, `docker tag myapp:${version} ${remote()}`);
    tagged = true;
    render();
    s.say(`A second <b>name</b> for the same image ID. The <code>${user}/</code> prefix says which Docker Hub account to push to.`);
  }, { mono: true, enabled: () => !tagged, cmd: [/^docker (?:image )?tag myapp:([\w.]+) ([a-z0-9][a-z0-9_-]*)\/myapp:([\w.]+)$/], example: 'docker tag myapp:1.0 yourname/myapp:1.0' });
  s.btn('docker login', async () => {
    typed(term, 'docker login');
    out(term, '<span class="ok">Login Succeeded</span>');
    logged = true;
    s.say('Logged in. Credentials are stored by your credential helper.');
  }, { mono: true, enabled: () => !logged, cmd: [/^docker login(?: -u \S+)?(?: docker\.io)?$/] });
  s.btn('docker push', async (_, m) => {
    if (m && (m[1] !== user || m[2] !== version)) {
      typed(term, m.input);
      out(term, `<span class="bad">An image does not exist locally with the tag: ${escapeHtml(m[1])}/myapp:${escapeHtml(m[2])}</span>`);
      return s.say(tagged ? `Your tagged image is <code>${remote()}</code>.` : 'Push needs a name with your account prefix. <b>Tag it first.</b>');
    }
    typed(term, `docker push ${remote()}`);
    if (!tagged) { out(term, `<span class="bad">An image does not exist locally with the tag: ${user}/myapp</span>`); return s.say('Push needs a name with your account prefix. <b>Tag it first.</b>'); }
    if (!logged) { out(term, '<span class="bad">denied: requested access to the resource is denied</span>'); return s.say('The registry does not know who you are. <b>Log in first.</b>'); }
    let sent = 0;
    for (const [n, , id] of layers()) {
      if (regLayers.has(id)) { out(term, `${id.slice(0, 8)}: <span class="dim">Layer already exists</span>`); continue; }
      await fly(s.stage, layerBox.querySelector(`[data-id="${id}"]`), registry, { label: n, ms: 800 });
      regLayers.add(id);
      sent++;
      out(term, `${id.slice(0, 8)}: <span class="ok">Pushed</span>`);
      render();
    }
    pushed.add(remote());
    out(term, `${version}: digest: sha256:${randomHex(16)}… size: 1157`);
    render();
    s.say(sent === 3 ? 'All 3 layers uploaded.' : `Only <b>${sent}</b> layer uploaded — the registry already had the others. Layers are <b>de-duplicated</b>.`);
  }, { mono: true, primary: true, cmd: [/^docker (?:image )?push ([a-z0-9][a-z0-9_-]*)\/myapp:([\w.]+)$/], example: 'docker push yourname/myapp:1.0' });
  s.btn('server: docker pull', async () => {
    typed(term, `ssh server docker pull ${remote()}`);
    for (const [n, , id] of layers()) {
      if (srvLayers.has(id)) { out(term, `${id.slice(0, 8)}: <span class="dim">Already exists</span>`); continue; }
      await fly(s.stage, registry, server, { label: n, ms: 800 });
      srvLayers.add(id);
      out(term, `${id.slice(0, 8)}: <span class="ok">Pull complete</span>`);
      render();
    }
    s.say(`The server now has <b>${remote()}</b> and can <code>docker run</code> it.`);
  }, { mono: true, enabled: () => pushed.has(remote()), why: () => `The registry doesn't have <b>${remote()}</b> yet — push it first.`, cmd: [/^(?:ssh server )?docker (?:image )?pull ([a-z0-9][a-z0-9_-]*)\/myapp:([\w.]+)$/], example: 'ssh server docker pull yourname/myapp:1.0' });
  s.btn('✎ change code → 1.1', async () => {
    version = '1.1'; codeId = randomHex(8); tagged = false;
    render();
    s.say('Rebuilt as <b>myapp:1.1</b>. Only the code layer changed. Tag and push again and count the uploads.');
  }, { enabled: () => version === '1.0' && pushed.size > 0, cmd: [/^docker (?:image )?build (?:-t|--tag) myapp:1\.1 \.$/], example: 'docker build -t myapp:1.1 .' });
  render();
};

// =====================================================================
// 17. Limits, restart policy and health
// =====================================================================
A.resources = (root) => {
  const s = scene(root, { title: 'Limits, restarts & healthchecks', hint: 'Raise the app load past the memory limit. Then break the health endpoint.' });
  const memBar = mkBar(), cpuBar = mkBar();
  const memMark = h('div', { style: { position: 'absolute', top: '-4px', bottom: '-4px', width: '3px', background: 'var(--bad)' } });
  const cpuMark = h('div', { style: { position: 'absolute', top: '-4px', bottom: '-4px', width: '3px', background: 'var(--bad)' } });
  const wrap = (bar, mark) => h('div', { style: { position: 'relative', flex: 1 } }, bar, mark);
  const memTxt = h('b'), cpuTxt = h('b');
  const stateChip = h('span', { class: 'chip ok' });
  const healthChip = h('span', { class: 'chip' });
  const restartsEl = h('span', { class: 'chip' });
  const preview = h('code', { style: { fontSize: '12px' } });
  const log = mkTerm({ height: '120px', marginTop: '12px' });
  s.stage.append(h('div', { class: 'node blue' },
    title('📦 container: myapp'),
    h('div', { class: 'chips', style: { marginBottom: '10px' } }, stateChip, healthChip, restartsEl),
    h('div', { class: 'metric', style: { gridTemplateColumns: '70px 1fr 140px' } }, h('span', {}, 'Memory'), wrap(memBar, memMark), memTxt),
    h('div', { class: 'metric', style: { gridTemplateColumns: '70px 1fr 140px' } }, h('span', {}, 'CPU'), wrap(cpuBar, cpuMark), cpuTxt),
    log), h('div', { style: { marginTop: '10px' } }, preview));

  const range = (min, max, step, value) => h('input', { type: 'range', min, max, step, value });
  const memLimit = range(128, 1024, 64, 512), cpus = range(0.5, 4, 0.5, 2), load = range(0, 100, 5, 20);
  const policy = h('select', {}, ...['no', 'on-failure', 'always', 'unless-stopped'].map((p) => h('option', { value: p, selected: p === 'on-failure' }, p)));
  const memLbl = h('span'), cpuLbl = h('span'), loadLbl = h('span');
  s.add(h('label', { class: 'inline' }, '--memory', memLimit, memLbl), h('label', { class: 'inline' }, '--cpus', cpus, cpuLbl),
    h('label', { class: 'inline' }, 'app load', load, loadLbl), h('label', { class: 'inline' }, '--restart', policy));
  s.sep();

  const st = { state: 'running', mem: 80, cpu: 0, restarts: 0, broken: false, tick: 0, fails: 0, health: 'starting', downTicks: 0, byUser: false };
  const logLine = (html) => out(log, `<span class="dim">${new Date().toLocaleTimeString()}</span> ${html}`);
  const render = () => {
    const lim = Number(memLimit.value), c = Number(cpus.value);
    memLbl.textContent = `${lim}m`; cpuLbl.textContent = c; loadLbl.textContent = `${load.value}%`;
    setBar(memBar, (st.mem / 1024) * 100); memMark.style.left = `${(lim / 1024) * 100}%`;
    setBar(cpuBar, (st.cpu / 4) * 100); cpuMark.style.left = `${(c / 4) * 100}%`;
    memTxt.textContent = `${Math.round(st.mem)} / ${lim} MiB`;
    const wantCpu = (Number(load.value) / 100) * 4;
    cpuTxt.textContent = `${st.cpu.toFixed(2)} cores${st.state === 'running' && wantCpu > c ? ' (throttled)' : ''}`;
    stateChip.className = `chip ${st.state === 'running' ? 'ok' : 'bad'}`;
    stateChip.textContent = { running: '🟢 running', oom: '💥 OOMKilled (137)', stopped: '⬛ stopped by you', exited: '⬛ exited' }[st.state];
    healthChip.className = `chip ${st.health === 'healthy' ? 'ok' : st.health === 'unhealthy' ? 'bad' : 'warn'}`;
    healthChip.textContent = st.state === 'running' ? `health: ${st.health}` : 'health: —';
    restartsEl.textContent = `restarts: ${st.restarts}`;
    preview.textContent = `docker run -d --memory ${memLimit.value}m --cpus ${cpus.value} --restart ${policy.value} --health-cmd "curl -f localhost/health" myapp`;
  };
  const shouldRestart = () => {
    const p = policy.value;
    if (st.byUser) return false;
    return p === 'always' || p === 'unless-stopped' || p === 'on-failure';
  };

  every(() => {
    st.tick++;
    if (st.state !== 'running') {
      st.cpu = 0;
      if (st.state === 'oom' && shouldRestart() && ++st.downTicks >= 3) {
        Object.assign(st, { state: 'running', mem: 80, restarts: st.restarts + 1, downTicks: 0, health: 'starting', fails: 0 });
        logLine(`<span class="y">restart policy "${policy.value}" → container restarted</span>`);
        s.say('Docker restarted it because of the restart policy. If the load is still too high it will crash again — fix the cause or raise the limit.');
      }
      return render();
    }
    const target = 60 + Number(load.value) * 9.4;
    st.mem += (target - st.mem) * 0.35 + rand(-6, 6);
    st.cpu = Math.min((Number(load.value) / 100) * 4, Number(cpus.value)) * rand(0.9, 1);
    if (st.mem > Number(memLimit.value)) {
      st.state = 'oom'; st.mem = 0; st.downTicks = 0;
      logLine('<span class="bad">OOM: memory limit exceeded → process killed (exit 137)</span>');
      s.say(policy.value === 'no' ? 'The kernel <b>OOM-killed</b> the process. Restart policy is <b>no</b>, so it stays dead.' : `The kernel <b>OOM-killed</b> the process. Restart policy <b>${policy.value}</b> will bring it back…`);
      return render();
    }
    if (st.tick % 3 === 0) {
      st.fails = st.broken ? st.fails + 1 : 0;
      const prev = st.health;
      st.health = st.fails >= 3 ? 'unhealthy' : st.broken ? prev === 'healthy' ? 'healthy' : prev : 'healthy';
      if (st.broken) logLine(`<span class="bad">healthcheck failed (${Math.min(st.fails, 3)}/3)</span>`);
      if (prev !== st.health) logLine(`health: <b>${st.health}</b>`);
      if (st.health === 'unhealthy' && prev !== 'unhealthy') s.say('3 failed checks in a row → <b>unhealthy</b>. The process is still running, so restart policies do nothing; an orchestrator would replace it.');
    }
    render();
  }, 500);

  const breakBtn = s.btn('💔 Break health endpoint', async () => {
    st.broken = !st.broken;
    breakBtn.textContent = st.broken ? '🩹 Fix health endpoint' : '💔 Break health endpoint';
    s.say(st.broken ? 'The app now returns errors on <code>/health</code>. Watch the checks fail…' : 'Fixed. The next successful check marks it <b>healthy</b> again.');
  });
  s.btn('docker stop', async () => {
    Object.assign(st, { state: 'stopped', byUser: true, mem: 0 });
    logLine('stopped by user');
    s.say(policy.value === 'always' ? 'Stopped by you. <b>always</b> would start it again when the Docker daemon restarts; <b>unless-stopped</b> would not.' : 'Stopped by you — no restart policy restarts a manually stopped container.');
    render();
  }, { mono: true, enabled: () => st.state === 'running', why: 'myapp is not running.', cmd: [/^docker (?:container )?stop myapp$/], example: 'docker stop myapp' });
  s.btn('docker start', async () => {
    Object.assign(st, { state: 'running', byUser: false, mem: 80, health: 'starting', fails: 0 });
    logLine('started');
    render();
    s.say('Started again with the same limits and restart policy.');
  }, { mono: true, enabled: () => st.state !== 'running', why: 'myapp is already running.', cmd: [/^docker (?:container )?(?:start|restart) myapp$/], example: 'docker start myapp' });

  // Reads --memory / --cpus / --restart out of a typed command and moves the sliders to match.
  const applyFlags = (flags) => {
    const mem = flags.match(/(?:--memory|-m)[ =](\d+(?:\.\d+)?)([mg])/);
    const cpu = flags.match(/--cpus[ =](\d+(?:\.\d+)?)/);
    const rp = flags.match(/--restart[ =]([\w-]+)(?::\d+)?/);
    const notes = [];
    if (mem) {
      const mb = Math.round(Number(mem[1]) * (mem[2] === 'g' ? 1024 : 1));
      memLimit.value = Math.max(128, Math.min(1024, Math.round(mb / 64) * 64));
      if (String(mb) !== memLimit.value) notes.push(`memory snapped to ${memLimit.value}m (demo range 128m–1g)`);
    }
    if (cpu) {
      cpus.value = Math.max(0.5, Math.min(4, Math.round(Number(cpu[1]) * 2) / 2));
      if (Number(cpu[1]) !== Number(cpus.value)) notes.push(`cpus snapped to ${cpus.value}`);
    }
    if (rp) {
      if (![...policy.options].some((o) => o.value === rp[1])) return `<span class="err">invalid restart policy "${escapeHtml(rp[1])}"</span> — use no, on-failure, always or unless-stopped`;
      policy.value = rp[1];
    }
    render();
    s.refresh();
    return notes.length ? ` (${notes.join(', ')})` : '';
  };
  s.command([/^docker (?:container )?run (?:-d )?(.*?)myapp$/], async (_, m) => {
    const note = applyFlags(m[1]);
    if (note.startsWith('<span')) return s.say(note);
    Object.assign(st, { state: 'running', byUser: false, mem: 80, health: 'starting', fails: 0, restarts: 0, broken: false });
    breakBtn.textContent = '💔 Break health endpoint';
    logLine(`started with --memory ${memLimit.value}m --cpus ${cpus.value} --restart ${policy.value}`);
    render();
    s.say(`New container running with your limits${note}. Now push the <b>app load</b> slider up and watch memory.`);
  }, { example: 'docker run -d --memory 256m --cpus 1 --restart always myapp' });
  s.command([/^docker (?:container )?update (.+?) myapp$/], async (_, m) => {
    const note = applyFlags(m[1]);
    if (note.startsWith('<span')) return s.say(note);
    logLine(`limits updated live: --memory ${memLimit.value}m --cpus ${cpus.value}`);
    s.say(`<b>docker update</b> changed the limits of the <b>running</b> container — no restart needed${note}.`);
  }, { example: 'docker update --memory 768m --cpus 2 myapp' });
  s.command([/^docker (?:container )?stats(?: --no-stream)?(?: myapp)?$/], async () => {
    s.say(`myapp — CPU <b>${st.cpu.toFixed(2)}</b> of ${cpus.value} cores · MEM <b>${Math.round(st.mem)}MiB / ${memLimit.value}MiB</b> · state <b>${st.state}</b>`);
  }, { example: 'docker stats myapp' });
  s.command([/^docker (?:container )?inspect (?:(?:--format|-f) .* )?myapp$/], async () => {
    s.say(`State: <b>${st.state}</b> · Health: <b>${st.state === 'running' ? st.health : '—'}</b> · RestartCount: <b>${st.restarts}</b> · RestartPolicy: <b>${policy.value}</b>`);
  }, { example: "docker inspect --format '{{.State.Health.Status}}' myapp" });
  [memLimit, cpus, load, policy].forEach((el) => el.addEventListener('input', () => { render(); s.refresh(); }));
  every(() => s.refresh(), 700);
  render();
};

// =====================================================================
// 18. Security
// =====================================================================
A.security = (root) => {
  const s = scene(root, { title: 'Shrink the attack surface', hint: 'Turn on each practice.' });
  const P = [
    ['base', 'Minimal base image', 'FROM node:20-alpine', '400+ OS packages'],
    ['user', 'Run as non-root', 'USER node', 'root in container'],
    ['pin', 'Pin versions / digests', 'FROM node:20.17-alpine3.20', 'surprise upgrades'],
    ['secret', 'No secrets in layers', 'RUN --mount=type=secret,id=npmrc …', 'leaked API key'],
    ['ro', 'Read-only filesystem', '--read-only --tmpfs /tmp', 'malware writes files'],
    ['caps', 'Drop capabilities', '--cap-drop ALL', 'kernel capabilities'],
    ['priv', 'Never --privileged / docker.sock', '(no) -v /var/run/docker.sock', 'host takeover'],
    ['scan', 'Scan images in CI', 'docker scout cves myapp', 'unpatched CVEs'],
  ];
  const on = new Set();
  const threats = {};
  const ring = h('div', { style: { position: 'relative', height: '300px' } });
  const core = h('div', { class: 'node blue', style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', width: '150px', transition: 'box-shadow .4s' } });
  ring.append(core);
  P.forEach(([id, , , threat], i) => {
    const a = (i / P.length) * Math.PI * 2 - Math.PI / 2;
    threats[id] = h('span', { class: 'chip bad', style: { position: 'absolute', left: `${50 + Math.cos(a) * 38}%`, top: `${50 + Math.sin(a) * 40}%`, transform: 'translate(-50%,-50%)', transition: 'opacity .4s, transform .4s' } }, `⚠ ${threat}`);
    ring.append(threats[id]);
  });
  const list = h('div', {}, P.map(([id, name, code]) => {
    const cb = h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? on.add(id) : on.delete(id); update(id, e.target.checked); } });
    return h('label', { class: 'toggle-row' }, cb, h('div', {}, h('b', {}, name), h('code', {}, code)));
  }));
  s.stage.append(h('div', { class: 'sec-scene' }, ring, list));

  const update = (id, enabled) => {
    if (id) {
      const t = threats[id];
      t.style.opacity = enabled ? 0.12 : 1;
      t.style.transform = `translate(-50%,-50%) scale(${enabled ? 0.7 : 1})`;
    }
    const score = 20 + on.size * 10;
    const cves = (on.has('base') ? 52 : 412) - (on.has('scan') ? Math.min(40, on.has('base') ? 40 : 300) : 0);
    core.replaceChildren(
      h('div', { style: { font: '700 34px var(--font-head)', color: score >= 90 ? 'var(--ok)' : 'var(--blue-800)' } }, `${score}`),
      h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'security score'),
      h('div', { style: { font: '600 12px var(--mono)', marginTop: '6px' } }, `${cves} known CVEs`),
      h('div', { style: { font: '600 12px var(--mono)' } }, on.has('base') ? 'image 160 MB' : 'image 1.1 GB'));
    core.style.boxShadow = `0 0 0 ${on.size * 2}px var(--blue-100), 0 0 0 ${on.size * 2 + 2}px var(--blue)`;
    s.say(on.size === P.length ? '<b>All practices on.</b> Small image, no root, no secrets, locked-down runtime, continuous scanning. 🛡' : `${on.size} of ${P.length} practices enabled. Each one removes a whole class of attacks.`);
  };
  const setPractice = (id, value) => {
    const idx = P.findIndex((p) => p[0] === id);
    const cb = list.querySelectorAll('input')[idx];
    cb.checked = value;
    value ? on.add(id) : on.delete(id);
    update(id, value);
  };
  s.command([/^docker (?:container )?run (.*?)myapp$/], async (_, m) => {
    const f = m[1];
    const hits = [];
    if (/--read-only/.test(f)) { setPractice('ro', true); hits.push('read-only filesystem'); }
    if (/--cap-drop[ =]all/.test(f)) { setPractice('caps', true); hits.push('no capabilities'); }
    if (/(?:--user|-u)[ =]\S+/.test(f)) { setPractice('user', true); hits.push('non-root user'); }
    if (/--privileged|docker\.sock/.test(f)) { setPractice('priv', false); return s.say('<span class="err">--privileged / docker.sock gives the container root on the host</span> — the score drops. Never do this for untrusted code.'); }
    if (!/--privileged|docker\.sock/.test(f) && hits.length) setPractice('priv', true);
    s.say(hits.length ? `Runtime hardening applied: <b>${hits.join(', ')}</b>.` : 'Started with default settings — try adding <code>--read-only --cap-drop ALL --user 1000</code>.');
  }, { example: 'docker run --read-only --cap-drop ALL --user 1000 myapp' });
  s.command([/^docker scout (?:cves|quickview) myapp(?::[\w.-]+)?$/, /^trivy image myapp(?::[\w.-]+)?$/], async () => {
    setPractice('scan', true);
    s.say(`Scan finished: <b>${on.has('base') ? 12 : 112} known CVEs</b> left. Scanning in CI catches new ones before they ship.`);
  }, { example: 'docker scout cves myapp' });
  s.btn('Enable all', async () => { list.querySelectorAll('input').forEach((cb, i) => { cb.checked = true; on.add(P[i][0]); update(P[i][0], true); }); }, { primary: true });
  s.btn('Reset', async () => { list.querySelectorAll('input').forEach((cb, i) => { cb.checked = false; on.delete(P[i][0]); update(P[i][0], false); }); });
  update();
};

// =====================================================================
// 19. Orchestration
// =====================================================================
A.swarm = (root) => {
  const s = scene(root, { title: 'Desired state: replicas, self-healing, rolling updates', hint: 'Scale the service, then kill a node.' });
  const nodes = ['manager-1', 'worker-1', 'worker-2'].map((name) => {
    const slots = h('div', {});
    return { name, up: true, slots, el: h('div', { class: 'swarm-node' }, title(`🖥 ${name}`, name.startsWith('m') ? 'manager' : 'worker'), slots) };
  });
  const header = h('div', { class: 'chips', style: { marginBottom: '12px' } });
  s.stage.append(header, h('div', { class: 'swarm-nodes' }, nodes.map((n) => n.el)));
  let desired = 3, version = 'v1', seq = 0;
  const tasks = [];

  const renderHeader = () => {
    const running = tasks.length;
    header.replaceChildren(
      h('span', { class: 'chip blue' }, `desired: ${desired}`),
      h('span', { class: `chip ${running === desired ? 'ok' : 'warn'}` }, `running: ${running}`),
      h('span', { class: 'chip' }, `image: web:${version}`));
  };
  const leastLoaded = () => nodes.filter((n) => n.up).sort((a, b) => tasks.filter((t) => t.node === a).length - tasks.filter((t) => t.node === b).length)[0];
  const spawn = (node, ver, from) => {
    const t = { id: ++seq, node, ver, el: h('div', { class: `task pop ${ver === 'v2' ? 'v2' : ''}` }, `web.${seq}`, h('small', {}, ver)) };
    tasks.push(t);
    node.slots.append(t.el);
    if (from) fly(s.stage, from, t.el, { cls: 'dot', ms: 700 });
    return t;
  };
  const kill = async (t) => {
    tasks.splice(tasks.indexOf(t), 1);
    await removeAnimated(t.el);
  };
  const reconcile = async (from) => {
    while (tasks.length < desired) { spawn(leastLoaded(), version, from); renderHeader(); await wait(350); }
    while (tasks.length > desired) { await kill(tasks[tasks.length - 1]); renderHeader(); }
    renderHeader();
  };

  const scaleTo = async (n) => {
    desired = Math.max(1, Math.min(9, n));
    renderHeader();
    await reconcile();
    s.say(`<code>docker service scale web=${desired}</code> — the scheduler places new tasks on the <b>least busy</b> nodes.${n > 9 ? ' (This demo caps it at 9.)' : ''}`);
  };
  const drain = async (n) => {
    if (nodes.filter((x) => x.up && x !== n).length === 0) return s.say('<span class="err">Refusing to take down the last available node</span> — nothing could run the tasks.');
    n.up = false;
    n.el.classList.add('down');
    const lost = tasks.filter((t) => t.node === n);
    lost.forEach((t) => flash(t.el, 'shake'));
    s.say(`<b>${n.name}</b> went down with ${lost.length} task(s). Actual state ≠ desired state…`);
    await wait(700);
    renderHeader();
    for (const t of lost) {
      const target = leastLoaded();
      await fly(s.stage, t.el, target.slots, { cls: 'dot', ms: 700 });
      await kill(t);
      spawn(target, t.ver);
      renderHeader();
    }
    s.say(`The orchestrator <b>rescheduled</b> ${lost.length} task(s) onto healthy nodes. Running = desired again — no human needed.`);
  };
  const recover = async (n) => {
    n.up = true;
    n.el.classList.remove('down');
    s.say(`${n.name} is back. Swarm does not move running tasks back automatically; new tasks will use it.`);
  };
  const nodeBy = (name) => nodes.find((x) => x.name === name);

  s.btn('+ scale up', () => scaleTo(desired + 1), { enabled: () => desired < 9 });
  s.btn('− scale down', () => scaleTo(desired - 1), { enabled: () => desired > 1 });
  s.command([/^docker service scale web=(\d+)$/, /^docker service update --replicas[ =](\d+) web$/], (_, m) => scaleTo(Number(m[1])), { example: 'docker service scale web=6' });
  s.btn('💥 kill worker-1', () => drain(nodes[1]), { enabled: () => nodes[1].up });
  s.btn('↺ recover worker-1', () => recover(nodes[1]), { enabled: () => !nodes[1].up });
  s.command([/^docker node update --availability[ =](drain|pause|active) (manager-1|worker-1|worker-2)$/], async (_, m) => {
    const n = nodeBy(m[2]);
    if (m[1] === 'active') return n.up ? s.say(`${n.name} is already active.`) : recover(n);
    if (!n.up) return s.say(`${n.name} is already unavailable.`);
    return drain(n);
  }, { example: 'docker node update --availability drain worker-2' });
  s.btn('⟳ rolling update → v2', async () => {
    version = 'v2';
    renderHeader();
    for (const t of tasks.filter((x) => x.ver === 'v1')) {
      const node = t.node;
      s.say(`<code>docker service update --image web:v2 web</code> — replacing <b>web.${t.id}</b> (parallelism 1)…`);
      flash(t.el);
      await wait(300);
      await kill(t);
      spawn(node, 'v2');
      renderHeader();
      await wait(500);
    }
    s.say('All tasks updated <b>one by one</b> — the service never went fully down.');
  }, { primary: true, enabled: () => version === 'v1', cmd: [/^docker service update (?:--update-parallelism \d+ )?--image web:v2 web$/], example: 'docker service update --image web:v2 web' });
  s.command([/^docker service ps web$/], async () => {
    s.say(tasks.map((t) => `<code>web.${t.id}</code> ${t.ver} on <b>${t.node.name}</b>`).join(' · ') || 'No tasks.');
  }, { example: 'docker service ps web' });
  s.command([/^docker node ls$/], async () => {
    s.say(nodes.map((n) => `<b>${n.name}</b> ${n.up ? 'Ready · Active' : '<span class="err">Drain</span>'}`).join(' · '));
  }, { example: 'docker node ls' });
  reconcile().then(() => s.refresh());
};
