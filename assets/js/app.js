// App shell: hash router, sidebar, progress, and page renderers.
import { h, store, copyText, disposeTimers, getSpeed, setSpeed } from './dom.js';
import { LEVELS, LESSONS, CHEATSHEET } from './lessons.js';
import { ANIMATIONS } from './animations.js';
import './animations-more.js';
import { commandBlock, fileBlock, quizBlock } from './components.js';
import { renderPlayground } from './playground.js';
import { renderCommandIndex, renderCommandPage, commandSidebar, entryFor } from './commands.js';
import { REFERENCE } from './reference.js';

const view = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const DONE_KEY = 'dl-done';
const done = new Set(store.get(DONE_KEY, []));

const markDone = (id, value = true) => {
  value ? done.add(id) : done.delete(id);
  store.set(DONE_KEY, [...done]);
  renderSidebar();
  renderProgress();
};

// ---------- chrome ----------
const renderProgress = () => {
  const pct = Math.round((done.size / LESSONS.length) * 100);
  const pill = document.getElementById('progressPill');
  pill.textContent = `${done.size}/${LESSONS.length} · ${pct}%`;
  pill.style.setProperty('--p', `${pct}%`);
};

const renderSidebar = (activeId = currentLessonId()) => {
  if (location.hash.startsWith('#/commands')) {
    return sidebar.replaceChildren(
      h('div', { class: 'side-level side-extra' }, h('a', { class: 'side-link', href: '#/' }, h('span', { class: 'side-num' }, '←'), 'Lessons'), h('a', { class: `side-link ${activeId === 'commands' ? 'active' : ''}`, href: '#/commands' }, h('span', { class: 'side-num' }, '≡'), `All ${REFERENCE.length} commands`)),
      ...commandSidebar(activeId));
  }
  const levels = LEVELS.map((lvl) => {
    const lessons = LESSONS.filter((l) => l.level === lvl.id);
    const count = lessons.filter((l) => done.has(l.id)).length;
    return h('div', { class: 'side-level' },
      h('h4', {}, h('span', {}, lvl.title), h('span', {}, `${count}/${lessons.length}`)),
      lessons.map((l) => h('a', {
        class: `side-link ${l.id === activeId ? 'active' : ''} ${done.has(l.id) ? 'done' : ''}`,
        href: `#/lesson/${l.id}`,
      }, h('span', { class: 'side-num' }, done.has(l.id) ? '✓' : LESSONS.indexOf(l) + 1), l.title)));
  });
  sidebar.replaceChildren(...levels,
    h('div', { class: 'side-level side-extra' },
      h('a', { class: `side-link ${activeId === 'commands' ? 'active' : ''}`, href: '#/commands' }, h('span', { class: 'side-num' }, '📚'), `Command reference (${REFERENCE.length})`),
      h('a', { class: `side-link ${activeId === 'playground' ? 'active' : ''}`, href: '#/playground' }, h('span', { class: 'side-num' }, '▶'), 'Playground'),
      h('a', { class: `side-link ${activeId === 'cheatsheet' ? 'active' : ''}`, href: '#/cheatsheet' }, h('span', { class: 'side-num' }, '≡'), 'Cheat sheet')));
};

const setTopNav = (key) => document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));

// ---------- pages ----------
const renderHome = () => {
  const next = LESSONS.find((l) => !done.has(l.id)) || LESSONS[0];
  view.append(
    h('section', { class: 'hero' },
      h('span', { class: 'badge' }, '🐳 Free · interactive · zero to advanced'),
      h('h1', { html: 'Learn Docker by <em>seeing</em> it work.' }),
      h('p', {}, 'Every concept is an animation you can play with. Every command is broken down flag by flag. Every file is explained line by line. Then practice in a live playground.'),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn btn-primary', href: `#/lesson/${next.id}` }, done.size ? `Continue: ${next.title} →` : 'Start learning →'),
        h('a', { class: 'btn', href: '#/commands' }, '📚 Command reference'),
        h('a', { class: 'btn', href: '#/playground' }, '▶ Open playground')),
      h('div', { class: 'hero-ship', 'aria-hidden': 'true' },
        h('div', { class: 'boxes' }, Array.from({ length: 10 }, (_, i) => h('i', { class: i % 3 === 0 ? 'b' : '', style: { animationDelay: `${0.2 + i * 0.12}s` } }))),
        h('div', { class: 'hull' }), h('div', { class: 'waves' }))),
    h('div', { class: 'features' },
      [['🎬 Animations', 'Click buttons — or type the real docker command — and watch containers, layers, ports and networks move.'],
        ['🔍 Explained commands', 'Hover any part of a command to see exactly what it does.'],
        ['📄 Explained files', 'Dockerfile, compose.yaml, .dockerignore — line by line.'],
        ['📚 Every command', `${REFERENCE.length} commands, each with options, examples, errors and a live lab.`],
        ['🧪 Playground', 'A simulated Docker engine with challenges. Safe to break.']]
        .map(([b, t]) => h('div', { class: 'feature' }, h('b', {}, b), h('span', {}, t)))),
    ...LEVELS.flatMap((lvl) => [
      h('div', { class: 'section-title' }, h('h2', {}, lvl.title), h('p', {}, lvl.blurb)),
      h('div', { class: 'roadmap' }, LESSONS.filter((l) => l.level === lvl.id).map((l) => h('a', { class: `lesson-card ${done.has(l.id) ? 'done' : ''}`, href: `#/lesson/${l.id}` },
        h('span', { class: 'done-tick' }, done.has(l.id) ? '✓' : ''),
        h('span', { class: 'num' }, `LESSON ${String(LESSONS.indexOf(l) + 1).padStart(2, '0')} · ${l.minutes} MIN`),
        h('h3', {}, l.title),
        h('p', {}, l.summary)))),
    ]),
  );
};

const BLOCKS = {
  p: (html) => h('p', { html }),
  h: (text) => h('h2', {}, text),
  h3: (text) => h('h3', {}, text),
  list: (items) => h('ul', { class: 'points' }, items.map((html) => h('li', { html }))),
  tip: (html) => h('div', { class: 'callout' }, h('span', { class: 'ico' }, '💡'), h('p', { html })),
  warn: (html) => h('div', { class: 'callout warn' }, h('span', { class: 'ico' }, '⚠️'), h('p', { html })),
  analogy: (html) => h('div', { class: 'callout analogy' }, h('span', { class: 'ico' }, '🚢'), h('p', { html })),
  cmd: commandBlock,
  file: fileBlock,
  table: ({ head, rows }) => h('table', { class: 'ref' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { html: c })))))),
  compare: ({ a, b }) => h('div', { class: 'compare' }, [a, b].map((side) => h('div', {}, h('h4', {}, side.title), h('ul', {}, side.items.map((t) => h('li', {}, t)))))),
  anim: (key) => {
    const mount = h('div', {});
    const make = ANIMATIONS[key];
    if (!make) return h('div', { class: 'callout warn' }, h('p', {}, `Animation "${key}" is missing.`));
    // Mount after insertion so layout-dependent animations can measure the DOM.
    queueMicrotask(() => {
      try { make(mount); } catch (err) {
        console.error(`[animation:${key}]`, err);
        mount.append(h('div', { class: 'callout warn' }, h('p', {}, 'This animation failed to load. Try reloading the page.')));
      }
    });
    return mount;
  },
};

// Every reference page that names this lesson, as links to the full command docs and labs.
const lessonCommands = (lessonId) => {
  const refs = REFERENCE.filter((r) => r.lesson === lessonId);
  if (!refs.length) return null;
  return h('section', { class: 'lesson-refs' },
    h('h3', {}, '📚 Every command from this lesson, in depth'),
    h('p', {}, 'Each page explains every option and has its own live lab.'),
    h('div', { class: 'chips' }, refs.map((r) => h('a', { class: 'chip light', href: `#/commands/${r.id}` }, r.cmd))));
};

const renderLesson = (id) => {
  const idx = LESSONS.findIndex((l) => l.id === id);
  if (idx < 0) return renderNotFound();
  const l = LESSONS[idx];
  const prev = LESSONS[idx - 1], next = LESSONS[idx + 1];
  document.title = `${l.title} — Docker Lab`;

  const completeBtn = h('button', { class: `btn ${done.has(l.id) ? '' : 'btn-primary'}` });
  const syncComplete = () => { completeBtn.textContent = done.has(l.id) ? '✓ Completed (undo)' : 'Mark lesson complete'; completeBtn.className = `btn ${done.has(l.id) ? '' : 'btn-primary'}`; };
  completeBtn.addEventListener('click', () => { markDone(l.id, !done.has(l.id)); syncComplete(); });
  syncComplete();

  view.append(h('article', { class: 'lesson' },
    h('header', { class: 'lesson-head' },
      h('div', { class: 'meta' }, h('span', { class: `badge ${l.level}` }, l.level), h('span', {}, `Lesson ${idx + 1} of ${LESSONS.length}`), h('span', {}, `· ${l.minutes} min`)),
      h('h1', {}, l.title),
      h('p', { class: 'lead' }, l.summary),
      h('div', { class: 'learn-box' }, h('h4', {}, 'You will learn'), h('ul', {}, l.learn.map((t) => h('li', {}, t))))),
    l.blocks.map(([type, data]) => (BLOCKS[type] ? BLOCKS[type](data) : null)),
    lessonCommands(l.id),
    quizBlock(l.quiz, () => { if (!done.has(l.id)) { markDone(l.id); syncComplete(); } }),
    h('div', { class: 'complete-row' }, h('span', {}, 'Answer every quiz question correctly to complete the lesson automatically — or mark it yourself.'), completeBtn),
    h('nav', { class: 'lesson-foot' },
      prev ? h('a', { class: 'nav-card', href: `#/lesson/${prev.id}` }, h('small', {}, '← Previous'), h('b', {}, prev.title)) : h('span'),
      next ? h('a', { class: 'nav-card next', href: `#/lesson/${next.id}` }, h('small', {}, 'Next →'), h('b', {}, next.title))
        : h('a', { class: 'nav-card next', href: '#/playground' }, h('small', {}, 'Finished! Next →'), h('b', {}, 'Practice in the playground'))),
  ));
};

const renderCheatsheet = () => {
  document.title = 'Cheat sheet — Docker Lab';
  const grid = h('div', { class: 'cs-grid' });
  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    grid.replaceChildren(...CHEATSHEET.map((g) => {
      const items = g.items.filter(([c, d]) => !needle || c.toLowerCase().includes(needle) || d.toLowerCase().includes(needle));
      return items.length ? h('section', { class: 'cs-group' }, h('h3', {}, g.group),
        items.map(([c, d]) => {
          const ref = entryFor(c);
          return h('div', { class: 'cs-item', title: 'Click to copy', onclick: () => copyText(c) }, h('code', {}, c), h('span', {}, d,
            ref ? h('a', { class: 'cs-ref', href: `#/commands/${ref.id}`, onclick: (e) => e.stopPropagation() }, ' details →') : null));
        })) : null;
    }).filter(Boolean));
    if (!grid.children.length) grid.append(h('p', { class: 'pg-empty' }, 'No command matches your search.'));
  };
  view.append(h('div', { class: 'lesson', style: { maxWidth: '1200px' } },
    h('div', { class: 'lesson-head' }, h('h1', {}, 'Docker cheat sheet'), h('p', { class: 'lead', html: `The commands you will actually use. Click a command to copy it, or <b>details →</b> for its full page and live lab. All ${REFERENCE.length} commands: <a href="#/commands">command reference</a>.` })),
    h('input', { class: 'cs-search', type: 'search', placeholder: 'Search commands… (e.g. volume, logs, prune)', oninput: (e) => draw(e.target.value), 'aria-label': 'Search commands' }),
    grid));
  draw();
};

const renderNotFound = () => view.append(h('div', { class: 'lesson' }, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/' }, 'Back to the roadmap'))));

// ---------- router ----------
function currentLessonId() {
  const [, page, id] = location.hash.replace(/^#/, '').split('?')[0].split('/');
  return page === 'lesson' || (page === 'commands' && id) ? id : page;
}

const route = () => {
  disposeTimers();
  document.body.classList.remove('nav-open');
  view.replaceChildren();
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const [, page, id] = path.split('/');
  switch (page || '') {
    case '': document.title = 'Docker Lab — Learn Docker Visually'; setTopNav('home'); renderHome(); break;
    case 'lesson': setTopNav(''); renderLesson(id); break;
    case 'playground': document.title = 'Playground — Docker Lab'; setTopNav('playground'); renderPlayground(view, new URLSearchParams(query).get('cmd')); break;
    case 'cheatsheet': setTopNav('cheatsheet'); renderCheatsheet(); break;
    case 'commands':
      setTopNav('commands');
      if (!id) renderCommandIndex(view, new URLSearchParams(query).get('q') || '');
      else if (!renderCommandPage(view, id)) renderNotFound();
      break;
    default: renderNotFound();
  }
  renderSidebar(currentLessonId());
  window.scrollTo({ top: 0, behavior: 'instant' });
};

// ---------- boot ----------
const speedSel = document.getElementById('speedSel');
speedSel.value = String(getSpeed());
if (!speedSel.value) { speedSel.value = '1'; setSpeed(1); } // stored value is not one of the options
speedSel.addEventListener('change', () => setSpeed(speedSel.value));
document.getElementById('menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
window.addEventListener('hashchange', route);
renderProgress();
route();
