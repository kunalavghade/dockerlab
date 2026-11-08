// Reusable lesson building blocks: command explainer, file explainer, scene frame, quiz.
import { h, escapeHtml, copyText } from './dom.js';

// ---------- Command explainer ----------
const tokenKind = (tok, i, seenFlag) => {
  if (i === 0) return 'cli';
  if (tok.startsWith('-')) return 'flag';
  if (!seenFlag && i <= 3 && /^[a-z-]+$/.test(tok)) return 'sub';
  return 'val';
};

/**
 * spec: { title?, parts: [[token, explanation, kind?], ...], note?, try?: boolean }
 */
export const commandBlock = (spec) => {
  const cmd = spec.parts.map((p) => p[0]).join(' ');
  const rows = [], toks = [];
  let seenFlag = false;

  const select = (i) => {
    toks.forEach((t, j) => t.classList.toggle('on', j === i));
    rows.forEach((r, j) => r.classList.toggle('on', j === i));
  };

  spec.parts.forEach(([tok, explain, kind], i) => {
    const k = kind || tokenKind(tok, i, seenFlag);
    if (k === 'flag') seenFlag = true;
    toks.push(h('button', {
      class: `tok k-${k}`, title: 'Click to explain',
      onmouseenter: () => select(i), onfocus: () => select(i), onclick: () => select(i),
    }, tok));
    rows.push(h('div', { class: 'cmd-row', onmouseenter: () => select(i) }, h('code', {}, tok), h('span', { html: explain })));
  });

  const bar = h('div', { class: 'cmd-bar' },
    h('span', { class: 'title' }, spec.title || 'Command — hover or click each part'),
    h('span', { class: 'spacer' }),
    spec.try && h('a', { class: 'btn btn-sm', href: `#/playground?cmd=${encodeURIComponent(cmd)}` }, '▶ Try in playground'),
    h('button', { class: 'btn btn-sm', onclick: () => copyText(cmd) }, 'Copy'),
  );

  return h('div', { class: 'cmd' },
    bar,
    h('div', { class: 'cmd-line' }, h('span', { class: 'prompt' }, '$'), toks),
    h('div', { class: 'cmd-explain' }, rows),
    spec.note && h('div', { class: 'cmd-note', html: spec.note }),
  );
};

// ---------- File explainer ----------
const HIGHLIGHT = {
  dockerfile: (s) => s
    .replace(/^(\s*#.*)$/, '<span class="cm">$1</span>')
    .replace(/^(\s*)(FROM|RUN|COPY|ADD|WORKDIR|CMD|ENTRYPOINT|ENV|ARG|EXPOSE|USER|VOLUME|HEALTHCHECK|LABEL|SHELL|STOPSIGNAL|ONBUILD)\b/i, '$1<span class="kw">$2</span>')
    .replace(/(&quot;[^&]*?&quot;)/g, '<span class="str">$1</span>')
    .replace(/(\sAS\s)/, '<span class="kw">$1</span>'),
  yaml: (s) => s
    .replace(/^(\s*#.*)$/, '<span class="cm">$1</span>')
    .replace(/^(\s*-?\s*)([\w.-]+):/, '$1<span class="key">$2</span>:')
    .replace(/(&quot;[^&]*?&quot;)/g, '<span class="str">$1</span>'),
  ignore: (s) => s.replace(/^(\s*#.*)$/, '<span class="cm">$1</span>'),
  env: (s) => s.replace(/^(\s*#.*)$/, '<span class="cm">$1</span>').replace(/^([\w]+)=/, '<span class="key">$1</span>='),
  text: (s) => s,
};

/**
 * spec: { name, lang: 'dockerfile'|'yaml'|'ignore'|'env'|'text', lines: [[code, explanation?], ...] }
 * Lines without explanation are rendered but not selectable.
 */
export const fileBlock = (spec) => {
  const paint = HIGHLIGHT[spec.lang] || HIGHLIGHT.text;
  const explained = spec.lines.map((l, i) => (l[1] ? i : -1)).filter((i) => i >= 0);
  const lineEls = [];
  const which = h('div', { class: 'which' });
  const what = h('div', { class: 'what' });
  const count = h('span', { class: 'count' });
  let cur = 0;

  const select = (pos) => {
    if (!explained.length) return;
    cur = (pos + explained.length) % explained.length;
    const idx = explained[cur];
    lineEls.forEach((el, i) => el.classList.toggle('on', i === idx));
    which.textContent = spec.lines[idx][0].trim();
    what.innerHTML = spec.lines[idx][1];
    count.textContent = `${cur + 1} / ${explained.length}`;
  };

  spec.lines.forEach(([code, explain], i) => {
    const el = h('div', {
      class: `file-line ${explain ? '' : 'blank'}`,
      onclick: explain ? () => select(explained.indexOf(i)) : null,
    }, h('span', { class: 'ln' }, i + 1), h('span', { html: paint(escapeHtml(code)) || ' ' }));
    lineEls.push(el);
  });

  const code = spec.lines.map((l) => l[0]).join('\n');
  const node = h('div', { class: 'file' },
    h('div', { class: 'cmd-bar' },
      h('span', { class: 'title' }, `📄 ${spec.name}`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'title', style: { fontWeight: 500 } }, 'click a line to explain it'),
      h('button', { class: 'btn btn-sm', onclick: () => copyText(code) }, 'Copy'),
    ),
    h('div', { class: 'file-body' },
      h('div', { class: 'file-code' }, lineEls),
      h('div', { class: 'file-side' },
        which, what,
        h('div', { class: 'nav' },
          h('button', { class: 'btn btn-sm', onclick: () => select(cur - 1) }, '← Prev'),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => select(cur + 1) }, 'Next →'),
          count,
        ),
      ),
    ),
  );
  select(0);
  return node;
};

// ---------- Scene frame for animations ----------
/**
 * Creates the standard animation frame and returns helpers.
 * btn(label, fn, { enabled }) — buttons auto-disable while an action runs and
 * re-evaluate `enabled()` after every action, so scenes stay consistent.
 */
export const scene = (root, { title, hint = '' }) => {
  const stage = h('div', { class: 'stage' });
  const controls = h('div', { class: 'controls' });
  const cap = h('div', { class: 'caption', 'aria-live': 'polite', html: hint });
  root.append(h('div', { class: 'scene' },
    h('div', { class: 'scene-head' }, h('span', { class: 'scene-dot' }), title, h('span', { class: 'scene-tag' }, 'Interactive')),
    stage, controls, cap,
  ));

  let busy = false;
  const buttons = [];
  const refresh = () => buttons.forEach(({ b, enabled }) => { b.disabled = busy || (enabled ? !enabled() : false); });

  const api = {
    stage, controls, refresh,
    say: (html) => { cap.innerHTML = html; },
    sep: () => controls.append(h('span', { class: 'sep' })),
    add: (...els) => controls.append(...els),
    btn(label, fn, { primary = false, mono = false, enabled } = {}) {
      const b = h('button', { class: `btn btn-sm ${primary ? 'btn-primary' : ''} ${mono ? 'mono' : ''}` }, label);
      b.addEventListener('click', () => api.run(() => fn(b)));
      buttons.push({ b, enabled });
      controls.append(b);
      refresh();
      return b;
    },
    async run(fn) {
      if (busy) return;
      busy = true;
      refresh();
      try { await fn(); } finally { busy = false; refresh(); }
    },
  };
  return api;
};

// ---------- Quiz ----------
export const quizBlock = (questions, onPass) => {
  let answered = 0, correct = 0;
  const score = h('span', { class: 'score' }, `0 / ${questions.length}`);

  const items = questions.map((q) => {
    const why = h('div', { class: 'why', style: { display: 'none' }, html: q.why || '' });
    const opts = q.options.map((text, i) => h('button', {
      class: 'opt',
      onclick: () => {
        opts.forEach((o, j) => {
          o.disabled = true;
          if (j === q.answer) o.classList.add('right');
        });
        if (i !== q.answer) opts[i].classList.add('wrong');
        else correct++;
        answered++;
        why.style.display = q.why ? 'block' : 'none';
        score.textContent = `${correct} / ${questions.length}`;
        if (answered === questions.length && correct === questions.length) onPass?.();
      },
    }, text));
    return h('div', { class: 'q' }, h('p', { class: 'ask', html: q.q }), h('div', { class: 'opts' }, opts), why);
  });

  return h('section', { class: 'quiz' },
    h('div', { class: 'quiz-head' }, h('h3', {}, '🧠 Check yourself'), score),
    items,
  );
};
