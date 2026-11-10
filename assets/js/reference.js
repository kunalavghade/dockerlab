/**
 * The command reference: one entry per Docker command, shown at #/commands/<id> with a live lab.
 * Entry shape:
 *   cmd, group, summary, syntax, details[html], args?[[name, html]], flags?[[names, value, html]],
 *   examples[[command, html]], setup?[commands run silently before the lab], errors?[[message, fix]],
 *   lesson? (lesson id), related?[ids], aliases?[commands]
 * The id is the command without "docker " and with spaces as dashes ("compose up" → "compose-up").
 * Add a command by adding an entry to one of the ref/*.js files.
 */
import { CONTAINER_REFS } from './ref/containers.js';
import { IMAGE_REFS } from './ref/images.js';
import { RESOURCE_REFS } from './ref/resources.js';
import { COMPOSE_REFS } from './ref/compose.js';
import { SWARM_REFS } from './ref/swarm.js';

export const REF_GROUPS = [
  { name: 'Run & manage containers', icon: '📦', blurb: 'Start, stop, list and remove containers.' },
  { name: 'Look inside containers', icon: '🔍', blurb: 'Logs, shells, files, processes and events.' },
  { name: 'Images & registries', icon: '🖼', blurb: 'Pull, tag, push and clean up images.' },
  { name: 'Move images without a registry', icon: '💾', blurb: 'Save, load, export and import tar files.' },
  { name: 'Build images', icon: '🏗', blurb: 'Dockerfiles, BuildKit, buildx and multi-platform.' },
  { name: 'Volumes', icon: '🗄', blurb: 'Data that outlives containers.' },
  { name: 'Networks', icon: '🌐', blurb: 'Let containers find and talk to each other.' },
  { name: 'Compose', icon: '🧩', blurb: 'Run multi-container apps from one file.' },
  { name: 'System & contexts', icon: '⚙️', blurb: 'Disk usage, engine info and remote engines.' },
  { name: 'Swarm', icon: '🐝', blurb: 'Clusters, nodes and services.' },
  { name: 'Stacks, secrets & configs', icon: '🔐', blurb: 'Deploy whole apps and handle secrets safely.' },
  { name: 'Security', icon: '🛡', blurb: 'Scan images for vulnerabilities.' },
];

export const refId = (cmd) => cmd.replace(/^docker /, '').trim().replace(/\s+/g, '-');

export const REFERENCE = [...CONTAINER_REFS, ...IMAGE_REFS, ...RESOURCE_REFS, ...COMPOSE_REFS, ...SWARM_REFS]
  .map((r) => ({ setup: [], args: [], flags: [], errors: [], related: [], aliases: [], ...r, id: refId(r.cmd) }));

export const refById = (id) => REFERENCE.find((r) => r.id === id);

// Finds the entry whose command (or alias) is the longest prefix of a command line.
export const entryFor = (line) => {
  const text = String(line).replace(/\s+/g, ' ');
  const at = text.search(/(^|\s)docker\s/); // "echo x | docker secret create …" → the docker part
  if (at < 0) return null;
  // Global flags (-H, --context) sit between "docker" and the command.
  const norm = text.slice(at).trim().replace(/^docker (?:(?:-H|--host|-c|--context) \S+ )+/, 'docker ');
  return REFERENCE.filter((r) => [r.cmd, ...r.aliases].some((c) => norm === c || norm.startsWith(`${c} `)))
    .sort((a, b) => b.cmd.length - a.cmd.length)[0] || null;
};
