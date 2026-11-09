// A terminal UI bound to a simulated engine: output, prompt, history and tab completion.
// Used by the playground and by every command-reference lab.
import { h, store, escapeHtml } from './dom.js';
import { createEngine } from './sim/engine.js';

/**
 * opts: { title, height, historyKey, placeholder, onChange(engine), welcome(html) }
 * Returns { el, engine, input, run(cmd, { echo }), reset(), focus() }.
 */
export const createTerminal = ({ title = 'you@docker-lab: ~/project', height = 420, historyKey = null, placeholder = 'type a docker command…', onChange = () => {}, welcome = '' } = {}) => {
  const outEl = h('div', { class: 'pg-out', 'aria-live': 'polite' });
  const promptEl = h('span', {}, '$');
  const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Command', placeholder });
  const writer = {
    print: (text, cls = '') => outEl.append(h('div', { class: cls }, text === '' ? ' ' : text)),
    html: (markup) => outEl.append(h('div', { html: markup })),
    clear: () => outEl.replaceChildren(),
  };
  const engine = createEngine(writer);
  const history = historyKey ? store.get(historyKey, []) : [];
  let hIdx = history.length;

  const scroll = () => { outEl.scrollTop = outEl.scrollHeight; };
  const syncPrompt = () => {
    const p = engine.prompt();
    promptEl.textContent = p;
    promptEl.classList.toggle('inside', p !== '$');
    input.placeholder = p === '$' ? placeholder : 'you are inside a container — type exit to leave';
  };

  const run = (raw, { echo = true } = {}) => {
    const line = String(raw || '').trim();
    if (echo) writer.html(`<span class="p">${escapeHtml(engine.prompt())}</span> ${escapeHtml(line)}`);
    if (!line) return;
    if (history.at(-1) !== line) history.push(line);
    hIdx = history.length;
    if (historyKey) store.set(historyKey, history.slice(-80));
    if (line === 'clear' || line === 'cls') writer.clear();
    else engine.execute(line);
    syncPrompt();
    scroll();
    onChange(engine);
  };

  const complete = () => {
    const parts = input.value.split(' ');
    const last = parts.at(-1);
    if (!last) return;
    const hits = [...new Set(engine.completions())].filter((x) => x.startsWith(last));
    if (hits.length === 1) { parts[parts.length - 1] = hits[0]; input.value = `${parts.join(' ')} `; }
    else if (hits.length > 1) { writer.print(hits.slice(0, 40).join('  '), 'dim'); scroll(); }
  };

  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Enter': run(input.value); input.value = ''; break;
      case 'ArrowUp': if (hIdx > 0) input.value = history[--hIdx]; e.preventDefault(); break;
      case 'ArrowDown': hIdx = Math.min(history.length, hIdx + 1); input.value = history[hIdx] || ''; e.preventDefault(); break;
      case 'Tab': e.preventDefault(); complete(); break;
      case 'l': if (e.ctrlKey) { e.preventDefault(); writer.clear(); } break;
      case 'c': if (e.ctrlKey && !window.getSelection()?.toString()) { e.preventDefault(); writer.html(`<span class="p">${escapeHtml(engine.prompt())}</span> ${escapeHtml(input.value)}^C`); input.value = ''; } break;
      default: break;
    }
  });
  outEl.addEventListener('click', () => { if (!window.getSelection()?.toString()) input.focus({ preventScroll: true }); });

  const resetBtn = h('button', { class: 'btn btn-sm', type: 'button', style: { marginLeft: 'auto' } }, '↺ Reset');
  const el = h('div', { class: 'pg-term', style: { height: `${height}px` } },
    h('div', { class: 'pg-term-bar' }, h('i'), h('i'), h('i'), h('span', {}, title), resetBtn),
    outEl,
    h('div', { class: 'pg-in' }, promptEl, input));

  const api = {
    el, engine, input, writer, run,
    focus: () => input.focus({ preventScroll: true }),
    onReset: null,
    reset() {
      engine.reset();
      writer.clear();
      if (welcome) writer.html(welcome);
      api.onReset?.();
      syncPrompt();
      onChange(engine);
    },
  };
  resetBtn.addEventListener('click', () => api.reset());
  if (welcome) writer.html(welcome);
  syncPrompt();
  return api;
};
