// Command reference pages: #/commands (searchable index) and #/commands/<id> (detail + live lab).
import { h, escapeHtml, copyText } from './dom.js';
import { commandBlock } from './components.js';
import { createTerminal } from './terminal.js';
import { createStateView } from './stateview.js';
import { REFERENCE, REF_GROUPS, refById } from './reference.js';
import { LESSONS } from './lessons.js';

const MGMT = { compose: 'Docker Compose — runs multi-container apps from compose.yaml.', container: 'Management command for containers.', image: 'Management command for images.', network: 'Management command for networks.', volume: 'Management command for volumes.', system: 'Management command for the whole engine.', buildx: 'Docker Buildx — the BuildKit build plugin.', builder: 'Management command for builders and build cache.', context: 'Management command for contexts (which engine you talk to).', swarm: 'Management command for the swarm cluster.', node: 'Management command for swarm nodes.', service: 'Management command for swarm services.', stack: 'Management command for stacks.', secret: 'Management command for swarm secrets.', config: 'Management command for swarm configs.', scout: 'Docker Scout — image vulnerability analysis.', manifest: 'Management command for image manifests.', imagetools: 'Tools that read images straight from a registry.', plugin: 'Management command for engine plugins.' };
const SHELL_EXPLAIN = { cat: 'Print a file on your computer.', ls: 'List the files in your project folder.', echo: 'Print text — with > or >> it writes to a file.', curl: 'Send an HTTP request from your computer.', ssh: 'Run the rest of the line on another machine.', scp: 'Copy a file to another machine.', rm: 'Delete files on your computer.', grep: 'Keep only lines matching a pattern.' };

// Splits like a shell (quotes kept together) for display.
const words = (line) => (line.match(/"[^"]*"|'[^']*'|\$\([^)]*\)|\S+/g) || []);

// Finds the reference entry whose command is the longest prefix of the line.
export const entryFor = (line) => {
  const norm = line.replace(/^sudo\s+/, '').trim();
  return REFERENCE.filter((r) => norm === r.cmd || norm.startsWith(`${r.cmd} `) || r.aliases.some((a) => norm === a || norm.startsWith(`${a} `)))
    .sort((a, b) => b.cmd.length - a.cmd.length)[0] || null;
};

const flagInfo = (entry, flag) => {
  const name = flag.split('=')[0];
  return entry?.flags.find(([names]) => names.split(/,\s*|\s*\/\s*/).map((n) => n.trim()).includes(name)) || null;
};

/** Turns a command line into commandBlock parts, explaining every token from the reference. */
export const explainParts = (line) => {
  const toks = words(line);
  if (toks[0] !== 'docker') return [[line, SHELL_EXPLAIN[toks[0]] || 'A shell command on your computer.', 'cli']];
  const entry = entryFor(line);
  const subWords = entry ? (entry.cmd.split(' ').length - 1) : 1;
  const parts = [['docker', 'The Docker CLI. It sends the request to the Docker daemon (the engine), which does the work.', 'cli']];
  for (let i = 1; i <= subWords && i < toks.length; i++) {
    const last = i === subWords;
    parts.push([toks[i], last && entry ? entry.summary : MGMT[toks[i]] || 'Subcommand.', 'sub']);
  }
  let argIdx = 0;
  for (let i = subWords + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('$(')) { parts.push([t, `Command substitution: runs <code>${escapeHtml(t.slice(2, -1))}</code> first and puts its output here.`, 'val']); continue; }
    if (['|', '>', '>>', '<', '&&'].includes(t)) { parts.push([t, { '|': 'Pipe: send the output into the next command.', '>': 'Write the output to a file.', '>>': 'Append the output to a file.', '<': 'Read input from a file.', '&&': 'Run the next command only if this one succeeded.' }[t], 'cli']); continue; }
    if (t.startsWith('-') && t.length > 1) {
      let info = flagInfo(entry, t);
      if (!info && /^-[a-zA-Z]{2,}$/.test(t)) {
        const chars = t.slice(1).split('').map((ch) => flagInfo(entry, `-${ch}`));
        if (chars.every(Boolean)) { parts.push([t, chars.map((c) => `<code>${c[0].split(',')[0]}</code> ${c[2]}`).join('<br>'), 'flag']); continue; }
        if (/^-(it|ti|dit|itd)$/.test(t)) { parts.push([t, '<code>-i</code> keeps input open and <code>-t</code> adds a terminal: an interactive session.' + (t.includes('d') ? ' <code>-d</code> runs it in the background.' : ''), 'flag']); continue; }
      }
      const takesValue = info && info[1] && !t.includes('=') && toks[i + 1] != null;
      const tok = takesValue ? `${t} ${toks[++i]}` : t;
      parts.push([tok, info ? info[2] : 'An option for this command (see the options table).', 'flag']);
      continue;
    }
    const arg = entry?.args[argIdx];
    const isLast = arg && argIdx === entry.args.length - 1;
    if (arg && !isLast) argIdx++;
    parts.push([t, arg ? arg[1] : 'Argument.', 'val']);
  }
  return parts;
};

const lessonTitle = (id) => LESSONS.find((l) => l.id === id)?.title;

// ---------- index ----------
export const renderCommandIndex = (view, query = '') => {
  document.title = 'Docker command reference — Docker Lab';
  const grid = h('div', {});
  const count = h('span', { class: 'cs-count' });
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const hit = (r) => !needle || r.cmd.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle) || r.aliases.some((a) => a.includes(needle));
    let total = 0;
    grid.replaceChildren(...REF_GROUPS.map((g) => {
      const list = REFERENCE.filter((r) => r.group === g.name && hit(r));
      total += list.length;
      if (!list.length) return null;
      return h('section', { class: 'ref-group', id: `g-${g.name.replace(/\W+/g, '-')}` },
        h('div', { class: 'section-title' }, h('h2', {}, `${g.icon} ${g.name}`), h('p', {}, `${g.blurb} · ${list.length} command${list.length > 1 ? 's' : ''}`)),
        h('div', { class: 'ref-cards' }, list.map((r) => h('a', { class: 'ref-card', href: `#/commands/${r.id}` }, h('code', {}, r.cmd), h('span', {}, r.summary)))));
    }).filter(Boolean));
    count.textContent = `${total} of ${REFERENCE.length} commands`;
    if (!total) grid.append(h('p', { class: 'pg-empty' }, 'No command matches — try "logs", "port" or "volume".'));
  };
  const search = h('input', { class: 'cs-search', type: 'search', value: query, placeholder: 'Search all commands… (e.g. copy, port, secret, prune)', 'aria-label': 'Search commands', oninput: (e) => draw(e.target.value) });
  view.append(h('div', { class: 'lesson', style: { maxWidth: '1200px' } },
    h('div', { class: 'lesson-head' },
      h('div', { class: 'meta' }, h('span', { class: 'badge' }, '📚 Reference'), count),
      h('h1', {}, 'Every Docker command, explained'),
      h('p', { class: 'lead' }, 'Each page explains what the command does, every option, real examples and common errors — and has a live lab where you type the command and watch containers, images, networks and volumes change.')),
    h('div', { class: 'ref-jump' }, REF_GROUPS.map((g) => h('a', { class: 'chip', href: `#/commands?g=${encodeURIComponent(g.name)}`, onclick: (e) => { e.preventDefault(); document.getElementById(`g-${g.name.replace(/\W+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth' }); } }, `${g.icon} ${g.name}`))),
    search, grid));
  draw(query);
};

// ---------- detail ----------
export const renderCommandPage = (view, id) => {
  const r = refById(id);
  if (!r) return false;
  document.title = `${r.cmd} — Docker command reference`;
  const idx = REFERENCE.indexOf(r);
  const prev = REFERENCE[idx - 1], next = REFERENCE[idx + 1];
  const group = REF_GROUPS.find((g) => g.name === r.group);

  // Lab: a private engine prepared with the entry's setup commands.
  const stateView = createStateView({ compact: true });
  const term = createTerminal({
    title: `lab: ${r.cmd}`, height: 440, historyKey: 'dl-ref-history',
    placeholder: `try: ${r.examples[0]?.[0] || r.cmd}`,
    onChange: (e) => stateView.render(e.state()),
  });
  const prepare = () => {
    term.engine.run(r.setup, { silent: true });
    term.writer.html(`<span class="ok">Lab ready for ${escapeHtml(r.cmd)}.</span>`);
    if (r.setup.length) term.writer.html(`<span class="dim">Already done for you:</span>${r.setup.map((s) => `<br><span class="dim">  $ ${escapeHtml(s)}</span>`).join('')}`);
    term.writer.html('<span class="dim">Type a command, or press ▶ next to an example. ↑/↓ = history, Tab = complete.</span>');
    stateView.render(term.engine.state());
  };
  term.onReset = prepare;
  prepare();
  const sendToLab = (cmd) => {
    term.run(cmd);
    labEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const exampleRow = ([cmd, desc]) => {
    const explain = h('div', { class: 'ex-explain', style: { display: 'none' } });
    const toggle = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
      const open = explain.style.display === 'none';
      if (open && !explain.firstChild) explain.append(commandBlock({ title: 'Hover or click each part', parts: explainParts(cmd) }));
      explain.style.display = open ? '' : 'none';
      toggle.textContent = open ? 'Hide' : 'Explain';
    } }, 'Explain');
    return h('div', { class: 'ex' },
      h('div', { class: 'ex-row' },
        h('code', { class: 'ex-cmd' }, h('span', { class: 'p' }, '$ '), cmd),
        h('div', { class: 'ex-btns' }, toggle, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(cmd) }, 'Copy'), h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => sendToLab(cmd) }, '▶ Run'))),
      desc && h('p', { class: 'ex-desc', html: desc }),
      explain);
  };

  const labEl = h('section', { class: 'ref-lab' },
    h('div', { class: 'ref-lab-head' },
      h('h2', {}, '🧪 Try it in the lab'),
      h('p', {}, 'A private, simulated Docker engine just for this page. Nothing runs on your computer — break whatever you like and press ↺ Reset.')),
    h('div', { class: 'cmd-hints' }, h('span', {}, 'Try:'), r.examples.map(([cmd]) => h('button', { type: 'button', class: 'hint', onclick: () => { term.input.value = cmd; term.focus(); } }, cmd))),
    h('div', { class: 'pg' }, term.el, stateView.el));

  const firstDocker = r.examples.find(([c]) => c.startsWith('docker '))?.[0] || r.cmd;
  view.append(h('article', { class: 'lesson ref-page', style: { maxWidth: '1200px' } },
    h('nav', { class: 'crumbs' }, h('a', { href: '#/commands' }, 'Commands'), ' › ', h('span', {}, `${group?.icon || ''} ${r.group}`)),
    h('header', { class: 'lesson-head' },
      h('h1', { class: 'ref-title' }, r.cmd),
      h('p', { class: 'lead', html: r.summary }),
      h('div', { class: 'meta', style: { marginTop: '12px' } },
        r.aliases.length ? h('span', {}, 'Also: ', ...r.aliases.map((a) => h('code', { class: 'alias' }, a))) : null,
        r.lesson && lessonTitle(r.lesson) ? h('a', { class: 'chip blue', href: `#/lesson/${r.lesson}` }, `🎬 See it animated: ${lessonTitle(r.lesson)} →`) : null)),
    h('div', { class: 'syntax' }, h('span', { class: 'syntax-label' }, 'Syntax'), h('pre', {}, r.syntax)),
    h('h2', {}, 'What it does'),
    r.details.map((d) => h('p', { html: d })),
    h('h3', {}, 'Anatomy of a real command'),
    commandBlock({ title: 'Hover or click each part', parts: explainParts(firstDocker) }),
    r.args.length ? [h('h2', {}, 'Arguments'), h('table', { class: 'ref' }, h('thead', {}, h('tr', {}, h('th', {}, 'Argument'), h('th', {}, 'Meaning'))), h('tbody', {}, r.args.map(([n, d]) => h('tr', {}, h('td', {}, h('code', {}, n)), h('td', { html: d })))))] : null,
    r.flags.length ? [h('h2', {}, 'Options'), h('table', { class: 'ref flags' }, h('thead', {}, h('tr', {}, h('th', {}, 'Option'), h('th', {}, 'What it does'))), h('tbody', {}, r.flags.map(([n, v, d]) => h('tr', {}, h('td', {}, h('code', {}, n), v ? h('code', { class: 'val' }, v) : null), h('td', { html: d })))))] : null,
    h('h2', {}, 'Examples'),
    h('p', { class: 'muted' }, 'Run them in order in the lab below — each one builds on the one before.'),
    h('div', { class: 'examples' }, r.examples.map(exampleRow)),
    labEl,
    r.errors.length ? [h('h2', {}, 'Common errors'), h('table', { class: 'ref' }, h('thead', {}, h('tr', {}, h('th', {}, 'You see'), h('th', {}, 'What to do'))), h('tbody', {}, r.errors.map(([m, f]) => h('tr', {}, h('td', {}, h('code', { class: 'errline' }, m)), h('td', { html: f })))))] : null,
    r.related.length ? [h('h2', {}, 'Related commands'), h('div', { class: 'chips' }, r.related.map((x) => refById(x)).filter(Boolean).map((x) => h('a', { class: 'chip light', href: `#/commands/${x.id}` }, x.cmd)))] : null,
    h('nav', { class: 'lesson-foot' },
      prev ? h('a', { class: 'nav-card', href: `#/commands/${prev.id}` }, h('small', {}, '← Previous'), h('b', {}, prev.cmd)) : h('span'),
      next ? h('a', { class: 'nav-card next', href: `#/commands/${next.id}` }, h('small', {}, 'Next →'), h('b', {}, next.cmd)) : h('a', { class: 'nav-card next', href: '#/commands' }, h('small', {}, 'Done'), h('b', {}, 'All commands'))),
  ));
  return true;
};

// Sidebar for reference pages: every group, with the current group's commands listed.
export const commandSidebar = (activeId) => {
  const active = refById(activeId);
  return REF_GROUPS.map((g) => {
    const list = REFERENCE.filter((r) => r.group === g.name);
    const open = active?.group === g.name;
    return h('div', { class: 'side-level' },
      h('h4', {}, h('span', {}, `${g.icon} ${g.name}`), h('span', {}, String(list.length))),
      open ? list.map((r) => h('a', { class: `side-link mono ${r.id === activeId ? 'active' : ''}`, href: `#/commands/${r.id}` }, r.cmd.replace(/^docker /, ''))) : h('a', { class: 'side-link', href: `#/commands/${list[0].id}` }, h('span', { class: 'side-num' }, '›'), `${list.slice(0, 3).map((r) => r.cmd.replace(/^docker /, '')).join(', ')}…`));
  });
};
