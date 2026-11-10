/**
 * Keeps lessons and the command reference in sync. Instead of a hand-written list, it reads
 * every lesson's blocks, finds the docker commands it actually uses, and builds both directions:
 * lesson → commands (in the order they appear) and command → lessons.
 */
import { LESSONS } from './lessons.js';
import { REFERENCE, entryFor, refById } from './reference.js';

const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const codeSpans = (html) => [...String(html).matchAll(/<code>([^<]*(?:<(?!\/code>)[^<]*)*)<\/code>/g)].map((m) => decode(m[1]));

// Every command line a lesson shows, in reading order.
const commandLines = (lesson) => lesson.blocks.flatMap(([type, data]) => {
  switch (type) {
    case 'cmd': return [data.parts.map((p) => p[0]).join(' ')];
    case 'p': case 'tip': case 'warn': case 'analogy': return codeSpans(data);
    case 'list': return data.flatMap(codeSpans);
    case 'table': return data.rows.flat().flatMap(codeSpans);
    default: return [];
  }
}).filter((line) => /(^|\s)docker\s/.test(line)).map((line) => line.slice(line.indexOf('docker')));

const LESSON_IDS = LESSONS.map((l) => l.id);
export const lessonCommands = new Map(LESSONS.map((l) => [l.id, []]));
export const commandLessons = new Map(REFERENCE.map((r) => [r.id, []]));

LESSONS.forEach((l) => {
  const ids = new Set();
  commandLines(l).forEach((line) => { const r = entryFor(line); if (r) ids.add(r.id); });
  // Commands taught here but only typed in the animation come after the ones in the text.
  REFERENCE.filter((r) => r.lesson === l.id).forEach((r) => ids.add(r.id));
  lessonCommands.set(l.id, [...ids]);
  ids.forEach((id) => commandLessons.get(id).push(l.id));
});
commandLessons.forEach((list, id) => {
  const primary = refById(id).lesson;
  list.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : LESSON_IDS.indexOf(a) - LESSON_IDS.indexOf(b)));
});

/** The lesson a command is mainly taught in (falls back to the first lesson that uses it). */
export const homeLesson = (id) => LESSONS.find((l) => l.id === (refById(id)?.lesson || commandLessons.get(id)?.[0]));

/** All commands in learning-path order: by home lesson, then by how the lesson introduces them. */
export const PATH_ORDER = LESSONS.flatMap((l) => lessonCommands.get(l.id).filter((id) => homeLesson(id)?.id === l.id))
  .concat(REFERENCE.filter((r) => !homeLesson(r.id)).map((r) => r.id));

/** Turns <code>docker …</code> inside lesson HTML into links to the reference page. */
export const linkCommands = (html) => String(html).replace(/<code>([^<]*)<\/code>/g, (whole, inner) => {
  const text = decode(inner);
  if (!/^(sudo )?docker\s/.test(text)) return whole;
  const r = entryFor(text);
  return r ? `<a class="cmd-link" href="#/commands/${r.id}" title="${r.cmd} — open the reference and lab">${whole}</a>` : whole;
});
