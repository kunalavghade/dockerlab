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

  s.btn('docker pull redis', async () => {
    typed(term, 'docker pull redis');
    s.say('The <b>client</b> sends a pull request to the <b>daemon</b> over the Docker API…');
    await send('API: pull');
    if (local.has('redis')) {
      out(term, 'Status: Image is up to date for redis:latest');
      return s.say('The daemon already has <b>redis</b>, so nothing is downloaded.');
    }
    s.say('…the daemon asks the <b>registry</b> and downloads the image layers.');
    await pull('redis');
    out(term, '<span class="ok">Status: Downloaded newer image for redis:latest</span>');
    s.say('The image is now stored on the Docker host, ready to run.');
  }, { mono: true });

  s.btn('docker run nginx', async () => {
    typed(term, 'docker run -d nginx');
    await send('API: run');
    if (!local.has('nginx')) {
      out(term, "Unable to find image 'nginx:latest' locally");
      s.say('No local <b>nginx</b> image — the daemon pulls it first.');
      await pull('nginx');
    }
    const ctr = h('span', { class: 'chip ok pop' }, h('span', { class: 'status-dot running' }), `nginx_${++ctrCount}`);
    await fly(s.stage, local.get('nginx'), ctrZone, { label: 'create', ms: 700 });
    ctrZone.append(ctr);
    out(term, randomHex(12));
    s.say('The daemon created a <b>container</b> from the image and started it. The CLI just prints the container ID.');
  }, { mono: true });

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
    out(term, '<span class="dim">CONTAINER ID   IMAGE   STATUS</span>');
    if (!ctrCount) out(term, '<span class="dim">(none running)</span>');
    for (let i = 1; i <= ctrCount; i++) out(term, `${randomHex(12)}   nginx   Up ${i * 2} min`);
    s.say('Even listing containers is an API round-trip to the daemon.');
  }, { mono: true });
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
  const addFile = (c) => {
    c.files++;
    c.rw.append(h('span', { class: 'file-chip pop' }, `note${c.files}.txt`));
    updateDisk();
    s.say(`Wrote <b>note${c.files}.txt</b> into <b>${c.name}</b>'s writable layer. The image and the other containers are untouched.`);
  };
  const removeCtr = async (c) => {
    ctrs.splice(ctrs.indexOf(c), 1);
    await removeAnimated(c.el);
    updateDisk();
    s.refresh();
    s.say(`<b>${c.name}</b> removed — its writable layer (and any files in it) is gone. The image is still there.`);
  };

  s.btn('▶ docker run nginx', async () => {
    const name = NAMES.find((n) => !ctrs.some((c) => c.name === n));
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
  }, { primary: true, enabled: () => ctrs.length < 4 });
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

  s.btn('▶ docker run -d -p 8080:80 nginx', async () => {
    reset();
    term.replaceChildren();
    typed(term, 'docker run -d -p 8080:80 nginx');
    activate(0);
    s.say('<b>Step 1:</b> the daemon checks its local image store for <code>nginx:latest</code>.');
    await wait(900);
    done(0);
    if (cached.checked) {
      stepEls[1].className = 'step skip';
      s.say('Found locally — <b>no download needed</b>. This is why the second run is fast.');
      await wait(700);
    } else {
      out(term, "Unable to find image 'nginx:latest' locally");
      out(term, 'latest: Pulling from library/nginx');
      activate(1);
      s.say('<b>Step 2:</b> not found, so it pulls the image. Layers download <b>in parallel</b>.');
      await download();
      out(term, `Digest: sha256:${randomHex(24)}…`);
      out(term, 'Status: Downloaded newer image for nginx:latest');
      done(1);
      cached.checked = true;
    }
    activate(2);
    s.say('<b>Step 3:</b> create the container: a writable layer, network interface, the port mapping 8080→80.');
    await wait(1000);
    done(2);
    activate(3);
    s.say('<b>Step 4:</b> start the image\'s default command (<code>nginx -g "daemon off;"</code>) as PID 1 inside the container.');
    await wait(1000);
    done(3);
    stepEls[4].className = 'step active';
    out(term, `<span class="y">${randomHex(64)}</span>`);
    s.say('<b>Running!</b> Because of <code>-d</code> the CLI prints the full container ID and gives your terminal back. Visit <code>localhost:8080</code>.');
  }, { primary: true, mono: true });
  s.btn('Forget image (docker rmi)', async () => {
    cached.checked = false;
    reset();
    dl.replaceChildren(title('⬇ Layer downloads'), h('div', { class: 'pg-empty' }, 'Image removed — next run downloads again.'));
    s.say('Local image removed. The next run has to pull it again.');
  });
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
  for (const [name, a] of Object.entries(ACTIONS))
    s.btn(name, a.run, { mono: true, primary: name === 'start', enabled: () => a.from.includes(state) });
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

  const followBtn = s.btn('docker logs -f web', async () => {
    follow = !follow;
    followBtn.textContent = follow ? '^C stop following' : 'docker logs -f web';
    if (follow) {
      typed(term, 'docker logs -f web');
      s.say('<b>Following</b>: every new line the app writes to stdout is streamed to your terminal live.');
    } else {
      out(term, '^C');
      s.say('Stopped following. The container keeps running — only your view stopped.');
    }
  }, { mono: true, enabled: () => !inside });
  s.btn('docker logs --tail 3 web', async () => {
    typed(term, 'docker logs --tail 3 web');
    logs.slice(-3).forEach((l) => out(term, l));
    s.say('<b>logs</b> prints what the container already wrote to stdout/stderr. <code>--tail</code> limits it.');
  }, { mono: true, enabled: () => !inside && !follow });
  s.btn('docker exec -it web sh', async () => {
    typed(term, 'docker exec -it web sh');
    await fly(s.stage, term, procs, { label: 'exec sh' });
    shProc = h('div', { class: 'proc pop', style: { background: 'var(--blue-100)' } }, h('span', { class: 'status-dot running' }), 'PID 47 sh  ← you are here');
    procs.append(shProc);
    inside = true;
    out(term, '<span class="dim">(now inside the container)</span>');
    s.say('<b>exec</b> started an extra process (<code>sh</code>) <b>inside</b> the running container. Your prompt is now the container\'s.');
  }, { mono: true, enabled: () => !inside && !follow });
  s.btn('ls /usr/share/nginx/html', async () => {
    typed(term, 'ls /usr/share/nginx/html', prompt());
    out(term, '50x.html    index.html');
    s.say('You are looking at the <b>container\'s</b> filesystem, not your laptop\'s.');
  }, { mono: true, enabled: () => inside });
  s.btn('exit', async () => {
    typed(term, 'exit', prompt());
    await removeAnimated(shProc);
    inside = false;
    s.say('The <code>sh</code> process ended. The container keeps running because its main process (PID 1) is untouched.');
  }, { mono: true, enabled: () => inside });
  s.btn('docker stats --no-stream', async () => {
    typed(term, 'docker stats --no-stream');
    out(term, '<span class="dim">NAME  CPU %   MEM USAGE / LIMIT    NET I/O</span>');
    out(term, `web   ${rand(0.1, 2.5).toFixed(2)}%   ${rand(6, 12).toFixed(1)}MiB / 7.6GiB   ${Math.round(rand(20, 90))}kB / ${Math.round(rand(40, 200))}kB`);
    s.say('<b>stats</b> shows live resource usage (drop <code>--no-stream</code> to keep it updating).');
  }, { mono: true, enabled: () => !inside && !follow });
  s.btn('docker inspect web', async () => {
    typed(term, "docker inspect --format '{{.State.Status}} {{.NetworkSettings.IPAddress}}' web");
    out(term, 'running 172.17.0.2');
    s.say('<b>inspect</b> returns the full JSON description; <code>--format</code> picks fields out of it.');
  }, { mono: true, enabled: () => !inside && !follow });
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
  }, { primary: true, mono: true });
  s.btn('✎ Edit app.js', async () => { changes.add('src'); render(); s.say('You changed source code. Which layers will rebuild?'); }, { enabled: () => built });
  s.btn('📦 Add a dependency', async () => { changes.add('pkg'); render(); s.say('You changed <b>package.json</b>. This must re-run npm install in both orders.'); }, { enabled: () => built });
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

  s.btn('▶ Send request', async () => {
    page.textContent = 'Loading…';
    await fly(s.stage, browser, hostPort, { label: `GET :${hp.value}` });
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
  }, { primary: true });
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

  const sel = h('select', { onchange: (e) => { mode = e.target.value; ctr = null; hostFiles.length = 0; ctrArea.replaceChildren(); renderHost(); s.refresh(); s.say('Storage type changed. Press <b>docker run</b>.'); } },
    h('option', { value: 'none' }, 'No volume'), h('option', { value: 'volume' }, 'Named volume'), h('option', { value: 'bind' }, 'Bind mount'));
  s.add(h('label', { class: 'inline' }, 'Storage:', sel));
  s.sep();

  s.btn('▶ docker run', async () => {
    ctr = makeCtr();
    ctrArea.append(ctr.el);
    if (mode !== 'none' && hostFiles.length) {
      await fly(s.stage, disk, ctr.el, { label: 'mount', ms: 700 });
      hostFiles.forEach((f) => ctr.files.append(fileChip(f)));
      s.say(`The new container mounts the same ${mode === 'volume' ? 'volume' : 'folder'} — <b>all ${hostFiles.length} file(s) are back</b>. 🎉`);
    } else s.say(mode === 'none' ? 'Fresh container, empty writable layer.' : 'Container started with the mount attached.');
  }, { primary: true, enabled: () => !ctr });
  s.btn('✎ Write file', async () => {
    const name = `file${++n}.txt`;
    ctr.files.append(fileChip(name));
    if (mode === 'none') { ctr.own.push(name); return s.say(`<b>${name}</b> written into the container's writable layer.`); }
    await fly(s.stage, ctr.el, disk, { label: name, cls: 'white', ms: 700 });
    hostFiles.push(name);
    renderHost();
    s.say(`<b>${name}</b> written to <code>/data</code> — which is really the ${mode === 'volume' ? 'volume' : 'host folder'}.`);
  }, { enabled: () => !!ctr });
  s.btn('🗑 docker rm -f', async () => {
    const lost = ctr.own.length;
    await removeAnimated(ctr.el);
    ctr = null;
    s.say(mode === 'none' ? `Container removed. <b>${lost} file(s) lost forever</b> — they lived in the writable layer.` : `Container removed, but the data is <b>safe on the host</b> (${hostFiles.length} file(s)).`);
  }, { enabled: () => !!ctr });
  s.btn('✎ Edit on host', async () => {
    const name = `edited${++n}.html`;
    hostFiles.push(name);
    renderHost();
    await fly(s.stage, disk, ctr.el, { label: name, cls: 'white', ms: 700 });
    ctr.files.append(fileChip(name));
    s.say('You changed a file in your editor and it appeared <b>instantly</b> inside the container. This is why bind mounts are great for development.');
  }, { enabled: () => mode === 'bind' && !!ctr });
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

  const ping = async (from) => {
    const a = C[from], b = C.db;
    s.say(`<code>docker exec ${from} ping db</code>…`);
    if (a.net !== 'appnet' || b.net !== 'appnet') {
      flash(a.el, 'shake');
      return s.say(a.net === 'bridge' && b.net === 'bridge'
        ? '<b>ping: bad address \'db\'</b> — the default bridge has no DNS, so names do not resolve. (The IP would work, but IPs change.)'
        : `<b>ping: bad address 'db'</b> — <b>${from}</b> is not on <b>appnet</b>. Networks isolate containers from each other.`);
    }
    await fly(s.stage, a.el, dns, { label: 'db?', cls: 'white', ms: 700 });
    await fly(s.stage, dns, a.el, { label: '172.18.0.3', ms: 700 });
    await fly(s.stage, a.el, b.el, { label: 'ICMP', ms: 700 });
    await fly(s.stage, b.el, a.el, { label: 'reply', cls: 'ok', ms: 700 });
    s.say(`<b>64 bytes from db (172.18.0.3)</b> — Docker's embedded DNS resolved the name <b>db</b>. 🎉`);
  };

  s.btn('api → ping db', () => ping('api'), { mono: true, primary: true });
  s.btn('web → ping db', () => ping('web'), { mono: true });
  s.sep();
  s.btn('docker network create appnet', async () => {
    created = true;
    appZone.classList.remove('hidden-zone');
    appTitle.textContent = 'appnet (user-defined) · DNS on';
    flash(appZone);
    s.say('Created <b>appnet</b>, a user-defined bridge with built-in DNS.');
  }, { mono: true, enabled: () => !created });
  s.btn('run api + db on appnet', async () => {
    for (const [k, ip] of [['api', '172.18.0.2'], ['db', '172.18.0.3']]) {
      await moveTo(C[k].el, appCtrs);
      C[k].net = 'appnet';
      C[k].ipEl.textContent = ip;
    }
    s.say('<code>docker run --network appnet …</code> — api and db now share appnet. <b>web</b> stays on the default bridge. Try both pings!');
  }, { mono: true, enabled: () => created && C.api.net !== 'appnet' });
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

  s.btn('1. docker build', async () => {
    buildBox.replaceChildren(); imgBox.replaceChildren(); runTerm.replaceChildren();
    const arg = h('span', { class: 'chip warn pop' }, 'ARG NODE_VERSION=20');
    const env = h('span', { class: 'chip blue pop' }, 'ENV APP_ENV=production');
    buildBox.append(arg);
    s.say('<b>ARG</b> is available while the Dockerfile runs — e.g. to pick <code>node:${NODE_VERSION}</code>.');
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
  }, { primary: true });
  s.btn('2. docker run', async () => {
    const override = useOverride.checked ? val.value.trim() || 'staging' : null;
    runTerm.replaceChildren();
    await fly(s.stage, imgNode, runNode, { label: 'start', ms: 700 });
    if (override) await fly(s.stage, s.controls, runNode, { label: `-e APP_ENV=${override}`, cls: 'white', ms: 800 });
    typed(runTerm, 'printenv APP_ENV NODE_VERSION', '/ #');
    out(runTerm, `APP_ENV=<span class="${override ? 'y' : 'ok'}">${escapeHtml(override || 'production')}</span>`);
    out(runTerm, '<span class="bad">NODE_VERSION: (not set)</span>');
    s.say(override ? `<b>-e</b> overrode the image default: same image, now configured as <b>${escapeHtml(override)}</b>.` : 'The container sees the image\'s ENV default. NODE_VERSION is missing — ARGs never reach runtime.');
  }, { enabled: () => built });
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
  }, { primary: true, mono: true, enabled: () => !up });
  s.btn('--scale api=3', async () => {
    typed(term, 'docker compose up -d --scale api=3');
    for (const i of [2, 3]) await startSvc(`myapp-api-${i}`, 'build: ./api');
    s.say('Two more <b>api</b> replicas. Compose DNS round-robins the name <code>api</code> across them.');
  }, { mono: true, enabled: () => up && !svcs.some((x) => x.name === 'myapp-api-3') });
  s.btn('docker compose ps', async () => {
    typed(term, 'docker compose ps');
    out(term, '<span class="dim">NAME            STATUS</span>');
    svcs.forEach((x) => out(term, `${x.name.padEnd(16)}${x.status.textContent}`));
  }, { mono: true, enabled: () => up });
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
  s.btn('docker compose down', () => down(false), { mono: true, enabled: () => up });
  s.btn('down -v', () => down(true), { mono: true, enabled: () => up });
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

  s.btn('container prune', () => sweep('containers', (c) => !c.running, 'docker container prune', 'Stopped containers are gone; their images may now be unused.'), { mono: true });
  s.btn('image prune', () => sweep('images', (i) => i.dangling, 'docker image prune', 'Only <b>dangling</b> &lt;none&gt; images.'), { mono: true });
  s.btn('image prune -a', () => sweep('images', (i) => !usedImages().has(i.id), 'docker image prune -a', 'Every image not used by <i>any</i> container (running or stopped).'), { mono: true });
  s.btn('volume prune', () => sweep('volumes', (v) => !usedVols().has(v.id), 'docker volume prune', '⚠ Unused volumes deleted — <b>that was data</b>.'), { mono: true });
  s.btn('builder prune', () => sweep('cache', () => true, 'docker builder prune', 'Build cache cleared; next builds start cold.'), { mono: true });
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
  }, { primary: true });
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

  let tagged = false, logged = false, version = '1.0', codeId = randomHex(8);
  const regLayers = new Set(), srvLayers = new Set(), pushed = new Set();
  const layers = () => [['alpine base', '7 MB', 'base0001'], ['dependencies', '35 MB', 'deps0002'], ['your code', '2 MB', codeId]];
  const render = () => {
    tagsEl.replaceChildren(h('span', { class: 'chip' }, `myapp:${version}`), tagged && h('span', { class: 'chip blue pop' }, `kunal/myapp:${version}`));
    layerBox.replaceChildren(...layers().map(([n, sz, id]) => h('div', { class: 'layer', 'data-id': id }, `${n} · ${sz}`)));
    regBox.replaceChildren(...[...regLayers].map((id) => h('span', { class: 'chip light' }, id.slice(0, 8))));
    regTags.replaceChildren(...[...pushed].map((t) => h('span', { class: 'chip blue' }, t)));
    srvBox.replaceChildren(...[...srvLayers].map((id) => h('span', { class: 'chip light' }, id.slice(0, 8))));
  };

  s.btn('docker tag', async () => {
    typed(term, `docker tag myapp:${version} kunal/myapp:${version}`);
    tagged = true;
    render();
    s.say('A second <b>name</b> for the same image ID. The <code>kunal/</code> prefix says which Docker Hub account to push to.');
  }, { mono: true, enabled: () => !tagged });
  s.btn('docker login', async () => {
    typed(term, 'docker login');
    out(term, '<span class="ok">Login Succeeded</span>');
    logged = true;
    s.say('Logged in. Credentials are stored by your credential helper.');
  }, { mono: true, enabled: () => !logged });
  s.btn('docker push', async () => {
    typed(term, `docker push kunal/myapp:${version}`);
    if (!tagged) { out(term, '<span class="bad">An image does not exist locally with the tag: kunal/myapp</span>'); return s.say('Push needs a name with your account prefix. <b>Tag it first.</b>'); }
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
    pushed.add(`kunal/myapp:${version}`);
    out(term, `${version}: digest: sha256:${randomHex(16)}… size: 1157`);
    render();
    s.say(sent === 3 ? 'All 3 layers uploaded.' : `Only <b>${sent}</b> layer uploaded — the registry already had the others. Layers are <b>de-duplicated</b>.`);
  }, { mono: true, primary: true });
  s.btn('server: docker pull', async () => {
    typed(term, `ssh server docker pull kunal/myapp:${version}`);
    for (const [n, , id] of layers()) {
      if (srvLayers.has(id)) { out(term, `${id.slice(0, 8)}: <span class="dim">Already exists</span>`); continue; }
      await fly(s.stage, registry, server, { label: n, ms: 800 });
      srvLayers.add(id);
      out(term, `${id.slice(0, 8)}: <span class="ok">Pull complete</span>`);
      render();
    }
    s.say(`The server now has <b>kunal/myapp:${version}</b> and can <code>docker run</code> it.`);
  }, { mono: true, enabled: () => pushed.has(`kunal/myapp:${version}`) });
  s.btn('✎ change code → 1.1', async () => {
    version = '1.1'; codeId = randomHex(8); tagged = false;
    render();
    s.say('Rebuilt as <b>myapp:1.1</b>. Only the code layer changed. Tag and push again and count the uploads.');
  }, { enabled: () => version === '1.0' && pushed.size > 0 });
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
  }, { mono: true, enabled: () => st.state === 'running' });
  s.btn('docker start', async () => {
    Object.assign(st, { state: 'running', byUser: false, mem: 80, health: 'starting', fails: 0 });
    logLine('started');
    render();
  }, { mono: true, enabled: () => st.state !== 'running' });
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

  s.btn('+ scale up', async () => { desired++; renderHeader(); await reconcile(); s.say(`<code>docker service scale web=${desired}</code> — the scheduler places new tasks on the <b>least busy</b> nodes.`); }, { enabled: () => desired < 9 });
  s.btn('− scale down', async () => { desired--; renderHeader(); await reconcile(); s.say(`<code>docker service scale web=${desired}</code>`); }, { enabled: () => desired > 1 });
  s.btn('💥 kill worker-1', async () => {
    const n = nodes[1];
    n.up = false;
    n.el.classList.add('down');
    const lost = tasks.filter((t) => t.node === n);
    lost.forEach((t) => flash(t.el, 'shake'));
    s.say(`<b>worker-1</b> went down with ${lost.length} task(s). Actual state ≠ desired state…`);
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
  }, { enabled: () => nodes[1].up });
  s.btn('↺ recover worker-1', async () => {
    nodes[1].up = true;
    nodes[1].el.classList.remove('down');
    s.say('worker-1 is back. Swarm does not move running tasks back automatically; new tasks will use it.');
  }, { enabled: () => !nodes[1].up });
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
  }, { primary: true, enabled: () => version === 'v1' });
  reconcile().then(() => s.refresh());
};
