// Docker playground: the shared simulated engine with a big terminal, a live view of engine
// state and challenges. The engine itself lives in sim/; this file is only the page.
import { h, store, toast } from './dom.js';
import { createTerminal } from './terminal.js';
import { createStateView } from './stateview.js';

const userNet = (c) => Object.keys(c.networks).some((n) => !['bridge', 'host', 'none'].includes(n));
const CHALLENGES = [
  { id: 'pull', text: 'Pull any image', hint: 'docker pull alpine', check: (s) => s.images.length > 0 },
  { id: 'web', text: 'Run nginx in the background on host port 8080', hint: 'docker run -d -p 8080:80 nginx', check: (s) => s.containers.some((c) => c.status === 'running' && c.flavor === 'nginx' && c.ports.some((p) => p.host === '8080')) },
  { id: 'name', text: 'Start a container with your own name', hint: '--name web', check: (s) => s.containers.some((c) => c.named && !c.compose) },
  { id: 'logs', text: 'Read a container\'s logs', hint: 'docker logs web', check: (s) => s.events.has('logs') },
  { id: 'shell', text: 'Open a shell inside a container', hint: 'docker exec -it web sh', check: (s) => s.inShell },
  { id: 'stop', text: 'Stop a running container gracefully', hint: 'docker stop web', check: (s) => s.events.has('stop') },
  { id: 'cp', text: 'Copy your index.html into nginx and curl it', hint: 'docker cp index.html web:/usr/share/nginx/html/', check: (s) => s.containers.some((c) => c.fs.get('/usr/share/nginx/html/index.html')?.content?.includes('my own page')) },
  { id: 'vol', text: 'Run a container with a named volume', hint: '-v data:/data', check: (s) => s.containers.some((c) => c.mounts.some((m) => m.type === 'volume' && !/^[0-9a-f]{64}$/.test(m.name))) },
  { id: 'net', text: 'Put two containers on your own network', hint: 'docker network create appnet', check: (s) => s.containers.filter(userNet).length >= 2 },
  { id: 'build', text: 'Build your own image', hint: 'docker build -t myapp .', check: (s) => s.images.some((i) => i.built) },
  { id: 'commit', text: 'Snapshot a container into an image', hint: 'docker commit web mynginx:v1', check: (s) => s.images.some((i) => i.committed) },
  { id: 'save', text: 'Save an image to a tar file', hint: 'docker save -o app.tar myapp', check: (s) => [...s.files.values()].some((v) => v?.tar === 'images') },
  { id: 'compose', text: 'Start the whole app with Compose', hint: 'docker compose up -d', check: (s) => s.events.has('compose-up') },
  { id: 'swarm', text: 'Create a swarm service', hint: 'docker swarm init, then docker service create …', check: (s) => s.events.has('service') || s.events.has('stack') },
  { id: 'clean', text: 'Clean up with a prune command', hint: 'docker container prune', check: (s) => s.events.has('prune') },
];
const QUICK = ['docker run hello-world', 'docker run -d -p 8080:80 --name web nginx', 'curl localhost:8080', 'docker ps -a', 'docker logs web', 'docker exec -it web sh', 'docker cp index.html web:/usr/share/nginx/html/', 'docker diff web', 'docker build -t myapp .', 'docker compose up -d', 'docker system df', 'help'];
const WELCOME = '<span class="ok">Welcome to the Docker Lab playground!</span><br><span class="dim">A simulated engine with your project folder (</span><span class="y">ls</span><span class="dim">), other machines (</span><span class="y">ssh server …</span><span class="dim">) and every docker command. Type </span><span class="y">help</span><span class="dim"> for the list.</span>';

export const renderPlayground = (view, initialCmd) => {
  const doneSaved = new Set(store.get('dl-pg-done', []));
  const chList = h('div', { class: 'challenges' });
  const chCount = h('small');
  const stateView = createStateView();

  const renderChallenges = (S) => {
    let n = 0;
    chList.replaceChildren(...CHALLENGES.map((ch) => {
      const done = doneSaved.has(ch.id) || ch.check(S);
      if (done && !doneSaved.has(ch.id)) { doneSaved.add(ch.id); store.set('dl-pg-done', [...doneSaved]); toast(`🎯 Challenge complete: ${ch.text}`); }
      if (done) n++;
      return h('div', { class: `challenge ${done ? 'done' : ''}` }, h('span', { class: 'ck' }, done ? '✓' : ''), h('div', {}, ch.text, h('br'), h('code', {}, ch.hint)));
    }));
    chCount.textContent = `${n} / ${CHALLENGES.length}`;
  };
  const onChange = (engine) => { const S = engine.state(); stateView.render(S); renderChallenges(S); };
  const term = createTerminal({ height: 560, historyKey: 'dl-pg-history', placeholder: 'type a command, e.g. docker run -d -p 8080:80 --name web nginx', welcome: WELCOME, onChange });

  view.append(h('div', { class: 'lesson', style: { maxWidth: '1300px' } },
    h('div', { class: 'lesson-head' },
      h('div', { class: 'meta' }, h('span', { class: 'badge' }, '🧪 Playground'), h('span', {}, 'A safe, simulated Docker engine — nothing runs on your computer')),
      h('h1', {}, 'Docker playground'),
      h('p', { class: 'lead', html: 'Type real Docker commands on the left and watch images, containers, networks and volumes change on the right. Pipes, <code>$(…)</code>, <code>&amp;&amp;</code>, Compose, Swarm and remote machines all work. Every command is explained on the <a href="#/commands">Commands</a> page.' })),
    h('div', { class: 'pg' },
      h('div', {}, term.el, h('div', { class: 'quick-cmds' }, QUICK.map((c) => h('button', { class: 'btn btn-sm mono', onclick: () => { term.input.value = c; term.focus(); } }, c)))),
      h('div', {}, stateView.el, h('div', { class: 'pg-panel', style: { marginTop: '12px' } }, h('h4', {}, '🎯 Challenges', chCount), chList)))));

  onChange(term.engine);
  if (initialCmd) {
    term.writer.html('<span class="dim"># command sent from a lesson:</span>');
    term.run(initialCmd);
  }
  term.focus();
};
