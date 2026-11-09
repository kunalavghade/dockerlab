// Live picture of the simulated engine: containers, images, volumes, networks and — when they
// exist — project files, swarm nodes/services, contexts and builders. New items pop in.
import { h } from './dom.js';

const BUILTIN_NETS = new Set(['bridge', 'host', 'none', 'ingress', 'docker_gwbridge']);

/** Returns { el, render(state) }. compact=true hides the less common panels until they are used. */
export const createStateView = ({ compact = false } = {}) => {
  const seen = new Set();
  const el = h('div', { class: 'pg-vis' });
  const panel = (label, count, body) => h('div', { class: 'pg-panel' }, h('h4', {}, label, h('small', {}, count)), body);
  const empty = (text) => h('div', { class: 'pg-empty' }, text);

  const render = (S) => {
    const known = new Set(seen);
    const mark = (key) => { const cls = known.size && !known.has(key) ? 'pop' : ''; seen.add(key); return cls; };
    const ctrs = S.containers;
    const ctrCards = ctrs.map((c) => h('div', { class: `pg-ctr ${c.status} ${mark(`c:${c.id}:${c.status}`)}` },
      h('div', { class: 'nm', title: c.name }, h('span', { class: `status-dot ${c.status}` }), c.name.length > 22 ? `${c.name.slice(0, 20)}…` : c.name),
      h('div', { class: 'sub' }, `${c.image} · ${c.status}${c.status === 'exited' ? ` (${c.exitCode})` : ''}`),
      c.ports.length ? h('div', { class: 'sub' }, `ports ${c.ports.map((p) => `${p.host}→${p.ctr}`).join(', ')}`) : null,
      Object.keys(c.networks).some((n) => n !== 'bridge') ? h('div', { class: 'sub' }, `net ${Object.keys(c.networks).join(', ')}`) : null,
      c.mounts.length ? h('div', { class: 'sub' }, `mount ${c.mounts.map((m) => `${m.type === 'volume' ? (m.name.length > 20 ? `${m.name.slice(0, 8)}…` : m.name) : m.type === 'tmpfs' ? 'tmpfs' : m.src}→${m.dst}`).join(', ')}`) : null,
      c.fs.size ? h('div', { class: 'sub' }, `${c.fs.size} change${c.fs.size > 1 ? 's' : ''} in writable layer`) : null,
      c.compose ? h('span', { class: 'tagline' }, `compose: ${c.compose.service}`) : null,
      c.task ? h('span', { class: 'tagline' }, `swarm: ${c.task.service}`) : null));

    const uniqImages = S.images;
    const panels = [
      panel(`📦 Containers${S.machine !== 'laptop' ? ` on ${S.machine}` : ''}`, `${ctrs.filter((c) => c.status === 'running').length} running · ${ctrs.length} total`, h('div', { class: 'pg-ctrs' }, ...(ctrs.length ? ctrCards : [empty('No containers yet')]))),
      h('div', { class: 'pg-2col' },
        panel('🖼 Images', `${uniqImages.length}`, h('div', { class: 'chips' }, ...(uniqImages.length ? uniqImages.map((i) => h('span', { class: `chip ${i.built ? 'blue' : i.repo === '<none>' ? 'warn' : 'light'} ${mark(`i:${i.id}:${i.repo}:${i.tag}`)}` }, `${i.repo}:${i.tag}`)) : [empty('none')]))),
        panel('🗄 Volumes', `${S.volumes.length}`, h('div', { class: 'chips' }, ...(S.volumes.length ? S.volumes.map((v) => h('span', { class: `chip ${mark(`v:${v.name}`)}` }, `🗄 ${v.name.length > 22 ? `${v.name.slice(0, 10)}…` : v.name}${v.files.size ? ` · ${v.files.size} file${v.files.size > 1 ? 's' : ''}` : ''}`)) : [empty('none')])))),
      panel('🌐 Networks', `${S.networks.length}`, h('div', { class: 'chips' }, ...S.networks.filter((n) => !compact || !BUILTIN_NETS.has(n.name) || n.name === 'bridge').map((n) => {
        const members = ctrs.filter((c) => c.networks[n.name]).map((c) => (c.name.length > 18 ? `${c.name.slice(0, 16)}…` : c.name));
        const shown = members.length > 4 ? [...members.slice(0, 4), `+${members.length - 4}`] : members;
        return h('span', { class: `chip ${BUILTIN_NETS.has(n.name) ? '' : 'blue'} ${mark(`n:${n.id}`)}` }, `${n.name}${shown.length ? ` [${shown.join(', ')}]` : ''}`);
      }))),
    ];

    if (S.swarm) {
      const cl = S.swarm;
      panels.push(panel('🐝 Swarm', `${cl.nodes.length} node${cl.nodes.length > 1 ? 's' : ''} · ${cl.services.length} service${cl.services.length === 1 ? '' : 's'}`,
        h('div', { class: 'swarm-mini' }, ...cl.nodes.map((n) => {
          const tasks = cl.services.flatMap((s) => s.tasks.filter((t) => t.node === n.hostname && t.desired === 'Running' && t.state === 'Running').map((t) => `${s.name}.${t.slot}`));
          return h('div', { class: `swarm-node-mini ${n.availability} ${n.status === 'Down' ? 'down' : ''} ${mark(`node:${n.id}:${n.availability}:${n.status}`)}` },
            h('b', {}, `${n.role === 'manager' ? '👑 ' : ''}${n.hostname}`), h('small', {}, n.status === 'Down' ? 'down' : n.availability),
            h('div', { class: 'chips' }, ...(tasks.length ? tasks.map((t) => h('span', { class: `chip light ${mark(`t:${n.hostname}:${t}`)}` }, t)) : [empty('no tasks')])));
        })),
        cl.secrets.length || cl.configs.length ? h('div', { class: 'chips', style: { marginTop: '8px' } }, ...cl.secrets.map((x) => h('span', { class: `chip warn ${mark(`s:${x.id}`)}` }, `🔐 ${x.name}`)), ...cl.configs.map((x) => h('span', { class: `chip ${mark(`cf:${x.id}`)}` }, `📄 ${x.name}`))) : null));
    }

    const extras = [];
    if (S.contexts.length > 1 || S.context !== 'default') extras.push(h('div', {}, h('b', {}, 'Contexts '), ...S.contexts.map((c) => h('span', { class: `chip ${c.name === S.context ? 'blue' : ''}` }, `${c.name === S.context ? '● ' : ''}${c.name}`))));
    if (S.builders.length > 1) extras.push(h('div', {}, h('b', {}, 'Builders '), ...S.builders.map((b) => h('span', { class: `chip ${b.name === S.builder ? 'blue' : ''}` }, `${b.name} (${b.driver}${b.status === 'running' ? '' : `, ${b.status}`})`))));
    if (S.registry.size) extras.push(h('div', {}, h('b', {}, 'Registry '), ...[...S.registry.entries()].map(([k, v]) => h('span', { class: `chip ok ${mark(`r:${k}`)}` }, `☁ ${k.replace(/^docker\.io\//, '')}${v.platforms.length > 1 ? ` (${v.platforms.length} platforms)` : ''}`))));
    const files = [...S.files.entries()].filter(([k]) => !k.includes('/'));
    const special = files.filter(([, v]) => typeof v === 'object' && v).map(([k, v]) => h('span', { class: `chip warn ${mark(`f:${k}`)}` }, `📦 ${k} (${v.tar === 'fs' ? 'file system' : 'images'})`));
    if (special.length) extras.push(h('div', {}, h('b', {}, 'Tar files '), ...special));
    if (extras.length) panels.push(h('div', { class: 'pg-panel extras' }, ...extras));

    el.replaceChildren(...panels);
  };
  return { el, render };
};
