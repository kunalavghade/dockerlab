// Tiny DOM + timing helpers shared by every module.

export const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    switch (true) {
      case k === 'class': el.className = v; break;
      case k === 'html': el.innerHTML = v; break;
      case k === 'style' && typeof v === 'object': Object.assign(el.style, v); break;
      case k.startsWith('on'): el.addEventListener(k.slice(2).toLowerCase(), v); break;
      default: el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity))
    if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// localStorage can throw (private mode, blocked storage) — the site must work without it.
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export const toast = (msg) => {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
};

export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch { toast('Copy failed — select the text manually'); }
};

// ---------- Animation timing ----------
// Every timer goes through here so a route change can cancel all of them at once.
const timers = new Set();
let speed = Number(store.get('dl-speed', 1)) || 1;

export const getSpeed = () => speed;
export const setSpeed = (v) => { speed = Number(v) || 1; store.set('dl-speed', speed); };
export const scaled = (ms) => ms / speed;

export const wait = (ms) => new Promise((resolve) => {
  const t = setTimeout(() => { timers.delete(t); resolve(); }, scaled(ms));
  timers.add(t);
});

export const every = (fn, ms) => {
  const t = setInterval(fn, ms);
  timers.add(t);
  return t;
};

export const stopTimer = (t) => { clearTimeout(t); clearInterval(t); timers.delete(t); };

export const disposeTimers = () => {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers.clear();
};

// Moves a labelled "packet" between two elements inside a positioned stage.
export const fly = (stage, from, to, { label = '', cls = '', ms = 900 } = {}) => {
  if (!stage.isConnected) return Promise.resolve();
  const s = stage.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const dot = h('div', { class: `packet ${label ? '' : 'dot'} ${cls}` }, label);
  stage.append(dot);
  const w = dot.offsetWidth, ht = dot.offsetHeight;
  const pos = (r) => `translate(${r.left - s.left + r.width / 2 - w / 2}px, ${r.top - s.top + r.height / 2 - ht / 2}px)`;
  const anim = dot.animate(
    [
      { transform: `${pos(a)} scale(0.6)`, opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 1, offset: 0.88 },
      { transform: `${pos(b)} scale(1)`, opacity: 0 },
    ],
    { duration: scaled(ms), easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' },
  );
  return anim.finished.catch(() => {}).finally(() => dot.remove());
};

// FLIP: move a node to a new parent and animate it from its old spot.
export const moveTo = (node, parent, ms = 600) => {
  const before = node.getBoundingClientRect();
  parent.append(node);
  const after = node.getBoundingClientRect();
  const dx = before.left - after.left, dy = before.top - after.top;
  return node.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
    { duration: scaled(ms), easing: 'cubic-bezier(.45,0,.25,1)' },
  ).finished.catch(() => {});
};

export const flash = (el, cls = 'glow') => {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the CSS animation
  el.classList.add(cls);
};

export const removeAnimated = async (el) => {
  el.classList.add('fade-out');
  await wait(400);
  el.remove();
};

export const randomHex = (n = 12) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

let siteDescription; // read once, before the first page changes it
const setMeta = (selector, value) => document.querySelectorAll(selector).forEach((m) => m.setAttribute('content', value));

/** Sets the tab title and the description and share tags for the current page. */
export const setPage = (title, description) => {
  siteDescription ??= document.querySelector('meta[name="description"]')?.content || '';
  description ||= siteDescription;
  document.title = title;
  setMeta('meta[name="description"]', description);
  setMeta('meta[property="og:title"], meta[name="twitter:title"]', title);
  setMeta('meta[property="og:description"], meta[name="twitter:description"]', description);
};

export const GITHUB_PROFILE = 'https://github.com/kunalavghade';
export const GITHUB_REPO = `${GITHUB_PROFILE}/dockerlab`;
