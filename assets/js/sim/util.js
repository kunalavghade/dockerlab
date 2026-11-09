// Pure helpers for the simulated Docker engine: parsing, formatting and Go-style templates.
// No DOM access, so the engine also runs under Node for tests.

export class CommandError extends Error {
  constructor(message, code = 'COMMAND_ERROR') {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

export const hex = (n = 12) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
// Same seed → same hex string, so digests stay stable for unchanged content.
export const seededHex = (seed, n = 64) => {
  let x = 2166136261;
  for (const ch of String(seed)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  let outStr = '';
  while (outStr.length < n) { x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0; outStr += x.toString(16).padStart(8, '0'); }
  return outStr.slice(0, n);
};
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const short = (id) => String(id).slice(0, 12);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const fmtSize = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(2)}GB` : mb >= 1 ? `${Math.round(mb)}MB` : mb > 0 ? `${Math.max(1, Math.round(mb * 1000))}kB` : '0B');
export const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} seconds` : s < 3600 ? plural(Math.round(s / 60), 'minute') : plural(Math.round(s / 3600), 'hour');
};
export const iso = (t = Date.now()) => new Date(t).toISOString().replace('Z', '000000Z');

// "nginx:1.27" → ['nginx', '1.27']; registry ports ("localhost:5000/app") are not tags.
export const splitRef = (ref) => {
  const clean = String(ref).split('@')[0];
  const at = clean.lastIndexOf(':');
  return at > 0 && !clean.slice(at).includes('/') ? [clean.slice(0, at), clean.slice(at + 1)] : [clean, 'latest'];
};
export const cleanRepo = (repo) => repo.replace(/^docker\.io\//, '').replace(/^library\//, '');
export const baseName = (repo) => repo.split('/').pop();
export const refOf = (repo, tag) => `${repo}:${tag}`;

// Splits a command line like a shell: quotes group words; | || && ; > >> < are operator tokens.
export const tokenize = (line) => {
  const out = [];
  let cur = '', quote = null, has = false;
  const flush = () => { if (cur || has) out.push(cur); cur = ''; has = false; };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { ch === quote ? (quote = null) : (cur += ch); continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === '&' && line[i + 1] === '&') { flush(); out.push({ op: '&&' }); i++; continue; }
    if (ch === '|' && line[i + 1] === '|') { flush(); out.push({ op: '||' }); i++; continue; }
    if (ch === '|' || ch === '<' || ch === ';') { flush(); out.push({ op: ch }); continue; }
    if (ch === '>') {
      flush();
      const append = line[i + 1] === '>';
      if (append) i++;
      out.push({ op: append ? '>>' : '>' });
      continue;
    }
    cur += ch;
  }
  if (quote) throw new CommandError('unexpected end of line: unmatched quote');
  flush();
  return out;
};

// Finds the matching ")" of every "$(" so "docker rm $(docker ps -aq)" can be expanded.
export const findSubstitutions = (line) => {
  const found = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '$' || line[i + 1] !== '(') continue;
    let depth = 0;
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === '(') depth++;
      if (line[j] === ')' && --depth === 0) { found.push({ start: i, end: j + 1, inner: line.slice(i + 2, j) }); i = j; break; }
    }
  }
  return found;
};

/**
 * Builds a flag spec from compact strings: "detach:d rm interactive:i" for booleans and
 * "publish:p name" for flags that take a value. Repeated flags collect every value.
 */
export const flagSpec = (bools = '', values = '') => {
  const spec = { bool: new Set(), value: new Set(), alias: {} };
  const load = (list, set) => list.split(/\s+/).filter(Boolean).forEach((entry) => {
    const [long, shortName] = entry.split(':');
    set.add(long);
    if (shortName) spec.alias[shortName] = long;
  });
  load(bools, spec.bool);
  load(values, spec.value);
  return spec;
};

const needValue = (args, i, flag) => {
  if (args[i] == null) throw new CommandError(`flag needs an argument: ${flag}`);
  return args[i];
};

/** Parses args against a spec. `stopAtPositional` keeps "docker run IMAGE --flag" args for the image. */
export const parseArgs = (args, spec, { stopAtPositional = false, command = 'docker' } = {}) => {
  const flags = {}, pos = [];
  const add = (name, v) => { (flags[name] ||= []).push(v); };
  const unknown = (f) => new CommandError(`unknown flag: ${f}\nSee '${command} --help' — the playground may not simulate this flag.`, 'UNKNOWN_FLAG');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') {
      pos.push(a);
      if (stopAtPositional) { pos.push(...args.slice(i + 1)); break; }
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq > 0 ? eq : undefined);
      const inline = eq > 0 ? a.slice(eq + 1) : null;
      if (spec.value.has(name)) add(name, inline ?? needValue(args, ++i, a));
      else if (spec.bool.has(name)) add(name, inline ? inline !== 'false' : true);
      else throw unknown(a);
      continue;
    }
    const chars = a.slice(1);
    for (let j = 0; j < chars.length; j++) {
      const long = spec.alias[chars[j]];
      if (!long) throw unknown(`-${chars[j]}${chars.length > 1 ? ` in ${a}` : ''}`);
      if (!spec.value.has(long)) { add(long, true); continue; }
      const rest = chars.slice(j + 1).replace(/^=/, '');
      add(long, rest || needValue(args, ++i, a));
      break;
    }
  }
  return {
    flags, pos,
    has: (n) => !!flags[n] && flags[n].at(-1) !== false,
    get: (n, dflt = null) => flags[n]?.at(-1) ?? dflt,
    all: (n) => flags[n] || [],
  };
};

// Parses "--filter key=value" pairs into [{ key, value }].
export const parseFilters = (list) => list.map((f) => {
  const at = f.indexOf('=');
  if (at < 0) throw new CommandError(`bad format of filter (expected name=value): ${f}`);
  return { key: f.slice(0, at), value: f.slice(at + 1) };
});

// Memory strings ("512m", "1g") → megabytes.
export const parseMem = (s) => {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)b?$/i.exec(String(s || ''));
  if (!m) throw new CommandError(`invalid size: '${s}'`);
  const unit = { b: 1e-6, k: 1e-3, m: 1, g: 1024, '': 1e-6 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
};
export const fmtMem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)}GiB` : `${mb.toFixed(1)}MiB`);

// ---------- Go-template subset used by --format ----------
const lookup = (obj, path) => path.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const goValue = (v) => {
  if (v === undefined || v === null) return '<no value>';
  if (Array.isArray(v)) return `[${v.map(goValue).join(' ')}]`;
  if (typeof v === 'object') return `map[${Object.entries(v).map(([k, x]) => `${k}:${goValue(x)}`).join(' ')}]`;
  return String(v);
};
const FUNCS = {
  json: (v) => JSON.stringify(v ?? null),
  upper: (v) => goValue(v).toUpperCase(),
  lower: (v) => goValue(v).toLowerCase(),
  len: (v) => String(v == null ? 0 : Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : String(v).length),
};

/** Renders {{.A.B}}, {{json .A}}, {{range .A}}…{{end}} and {{index .A "key"}} against obj. */
export const renderTemplate = (tpl, obj) => {
  const text = tpl.replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  const ranged = text.replace(/\{\{\s*range\s+(\.[\w.]*)\s*\}\}([\s\S]*?)\{\{\s*end\s*\}\}/g, (_, p, inner) => {
    const v = p === '.' ? obj : lookup(obj, p.slice(1));
    const items = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
    return items.map((item) => renderTemplate(inner, item)).join('');
  });
  return ranged.replace(/\{\{\s*(?:(\w+)\s+)?(\.[\w.]*)(?:\s+"([^"]*)")?\s*\}\}/g, (all, fn, p, key) => {
    const v = p === '.' ? obj : lookup(obj, p.slice(1));
    if (fn === 'index') return goValue(v?.[key]);
    if (fn && !FUNCS[fn]) throw new CommandError(`template: function "${fn}" not defined`);
    return fn ? FUNCS[fn](v) : goValue(v);
  });
};

// "table {{.Names}}\t{{.Status}}" → header row from the field names, then one row per item.
export const formatRows = (format, items) => {
  const isTable = /^table\b/.test(format);
  const body = format.replace(/^table\s*/, '').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  if (!isTable) return items.map((it) => renderTemplate(body, it));
  const header = body.replace(/\{\{\s*(?:\w+\s+)?\.([\w.]*)\s*\}\}/g, (_, f) => (f.split('.').pop() || '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase());
  return [header, ...items.map((it) => renderTemplate(body, it))].map((l) => alignTabs(l));
};
const alignTabs = (line) => line.split('\t').map((c, i, a) => (i < a.length - 1 ? c.padEnd(Math.max(c.length + 3, 20)) : c)).join('');

// Pads columns like Docker's tabwriter.
export const tableLines = (head, rows) => {
  const widths = head.map((col, i) => Math.max(col.length, ...rows.map((r) => String(r[i] ?? '').length)) + 3);
  const line = (r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('').trimEnd();
  return [line(head), ...rows.map(line)];
};

// ---------- tiny YAML reader for compose files (maps, lists, scalars, inline [a, b]) ----------
const yamlScalar = (raw) => {
  const v = raw.replace(/\s+#.*$/, '').trim();
  if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((x) => yamlScalar(x)).filter((x) => x !== '');
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null' || v === '~') return null;
  return v;
};

export const parseYaml = (text) => {
  const lines = String(text).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l, n) => ({ indent: l.search(/\S/), text: l.trim(), n: n + 1 }));
  let i = 0;
  const node = () => {
    const first = lines[i];
    if (first.text.startsWith('- ') || first.text === '-') {
      const arr = [];
      while (i < lines.length && lines[i].indent === first.indent && lines[i].text.startsWith('-')) {
        const item = lines[i].text.replace(/^-\s*/, '');
        if (/^[\w.-]+:(\s|$)/.test(item)) { lines[i] = { ...lines[i], indent: first.indent + 2, text: item }; arr.push(node()); } else { arr.push(yamlScalar(item)); i++; }
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length && lines[i].indent === first.indent && !lines[i].text.startsWith('- ')) {
      const m = /^("[^"]+"|[^:]+):(?:\s+(.*))?$/.exec(lines[i].text);
      if (!m) throw new CommandError(`yaml: line ${lines[i].n}: could not find expected ':'`);
      i++;
      const key = m[1].replace(/^"|"$/g, '').trim();
      if (m[2] != null && m[2] !== '') obj[key] = yamlScalar(m[2]);
      else if (i < lines.length && (lines[i].indent > first.indent || (lines[i].indent === first.indent && lines[i].text.startsWith('- ')))) obj[key] = node();
      else obj[key] = null;
    }
    return obj;
  };
  return lines.length ? node() : {};
};
