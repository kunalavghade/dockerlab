// Runs every command-reference lab (setup + examples) against the simulated engine.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './engine.js';
import { REFERENCE, REF_GROUPS } from '../reference.js';

const capture = () => {
  const lines = [];
  const writer = {
    print: (text, cls = '') => lines.push({ text: String(text), bad: cls.includes('bad') }),
    html: (markup) => lines.push({ text: markup.replace(/<[^>]+>/g, ''), bad: /class="bad"/.test(markup) && !/^<span class="bad">D<\/span>/.test(markup) }),
    clear: () => {},
  };
  return { lines, engine: createEngine(writer) };
};

test('reference entries are well formed', () => {
  const ids = new Set(REFERENCE.map((r) => r.id));
  const groups = new Set(REF_GROUPS.map((g) => g.name));
  assert.equal(ids.size, REFERENCE.length, 'ids are unique');
  REFERENCE.forEach((r) => {
    assert.ok(groups.has(r.group), `${r.id}: unknown group ${r.group}`);
    assert.ok(r.summary && r.syntax && r.details.length && r.examples.length, `${r.id}: missing content`);
    r.related.forEach((x) => assert.ok(ids.has(x), `${r.id}: unknown related id ${x}`));
  });
});

test('every lab setup runs cleanly and no example crashes the engine', () => {
  REFERENCE.forEach((r) => {
    const { lines, engine } = capture();
    r.setup.filter((cmd) => cmd !== 'docker run --name db postgres:16').forEach((cmd) => {
      const before = lines.length;
      engine.execute(cmd);
      const errors = lines.slice(before).filter((l) => l.bad).map((l) => l.text);
      assert.deepEqual(errors, [], `${r.id}: setup "${cmd}" failed`);
    });
    r.examples.forEach(([cmd]) => {
      engine.execute(cmd);
      if (engine.prompt() !== '$') engine.execute('exit');
    });
    const crashes = lines.filter((l) => l.text.startsWith('internal error'));
    assert.deepEqual(crashes, [], `${r.id}: engine crashed`);
  });
});

test('core workflow: run, curl, cp, commit, save and load on another machine', () => {
  const { lines, engine } = capture();
  ['docker run -d --name web -p 8080:80 nginx', 'docker cp index.html web:/usr/share/nginx/html/', 'docker commit web mynginx:v1', 'docker save -o app.tar mynginx:v1', 'scp app.tar server:', 'ssh server docker load -i app.tar', 'ssh server docker run -d -p 80:80 mynginx:v1'].forEach((c) => engine.execute(c));
  assert.ok(!lines.some((l) => l.bad), lines.filter((l) => l.bad).map((l) => l.text).join('\n'));
  const before = lines.length;
  engine.execute('ssh server curl localhost:80');
  assert.match(lines.slice(before).map((l) => l.text).join('\n'), /my own page/);
});

test('DNS works only on user-defined networks', () => {
  const { lines, engine } = capture();
  ['docker run -d --name api alpine sleep infinity', 'docker run -d --name db redis'].forEach((c) => engine.execute(c));
  engine.execute('docker exec api ping -c 1 db');
  assert.match(lines.at(-2).text + lines.at(-1).text, /bad address|no DNS/);
  ['docker network create appnet', 'docker network connect appnet api', 'docker network connect appnet db'].forEach((c) => engine.execute(c));
  const before = lines.length;
  engine.execute('docker exec api redis-cli -h db ping');
  assert.equal(lines.slice(before).map((l) => l.text).join(''), 'PONG');
});

test('build cache: only steps after a changed file run again', () => {
  const { lines, engine } = capture();
  engine.execute('docker build -t myapp:1.0 .');
  engine.execute('echo "// change" >> server.js');
  const before = lines.length;
  engine.execute('docker build -t myapp:1.1 .');
  const text = lines.slice(before).map((l) => l.text).join('\n');
  assert.match(text, /CACHED \[4\/7\] RUN npm ci/);
  assert.doesNotMatch(text, /CACHED \[5\/7\] COPY \. \./);
});

test('stack secrets reach only the services that ask for them', () => {
  const { lines, engine } = capture();
  ['docker swarm init', 'echo "s3cret" | docker secret create db_password -', 'docker stack deploy -c stack.yaml shop'].forEach((c) => engine.execute(c));
  const before = lines.length;
  engine.execute('docker exec $(docker ps -q -f name=shop_db) cat /run/secrets/db_password');
  assert.equal(lines.slice(before).map((l) => l.text).join(''), 's3cret');
});
