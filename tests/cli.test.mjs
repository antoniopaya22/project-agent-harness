import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EXIT } from '../.harness/bin/lib/util.mjs';
import { REPO } from './helpers.mjs';

const ENTRY = path.join(REPO, '.harness', 'bin', 'harness.mjs');

function run(args, cwd = REPO) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('the zero-dependency guarantee holds: no manifest, no installed packages', () => {
  // The harness is copied into other people's repositories; it must not bring a
  // package manager's opinions with it.
  assert.ok(!fs.existsSync(path.join(REPO, 'package.json')), 'a package.json would create install steps');
  assert.ok(!fs.existsSync(path.join(REPO, 'node_modules')));

  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) sources.push(full);
    }
  };
  walk(REPO);

  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      const bare = !spec.startsWith('.') && !spec.startsWith('/');
      assert.ok(
        !bare || spec.startsWith('node:'),
        `${path.relative(REPO, file)} imports "${spec}"; only node: builtins and relative paths are allowed`,
      );
    }
  }
});

test('help exits 0 and works without a harness in the working directory', () => {
  const res = run(['help'], path.dirname(REPO));
  assert.equal(res.status, EXIT.OK);
  assert.match(res.stdout, /provider-agnostic coding-agent harness/);
});

test('an unknown command is a usage error, not a crash', () => {
  const res = run(['frobnicate']);
  assert.equal(res.status, EXIT.USAGE);
  assert.match(res.stdout, /unknown command/);
});

test('outside a harness, commands say what to do instead of failing obscurely', () => {
  const res = run(['status'], path.dirname(REPO));
  assert.equal(res.status, EXIT.NOT_FOUND);
  assert.match(res.stdout, /no harness found/);
  assert.match(res.stdout, /adopt/, 'it points at the way forward');
});

test('a missing task is a not-found with the path it looked at', () => {
  const res = run(['task', 'show', 'FEAT-9999']);
  assert.equal(res.status, EXIT.NOT_FOUND);
  assert.match(res.stdout, /not found/);
});

test('read-path prints a short, bounded list of files', () => {
  const res = run(['read-path', 'FEAT-0017']);
  assert.equal(res.status, EXIT.OK);
  assert.match(res.stdout, /ENTRYPOINT\.md/);
  assert.match(res.stdout, /project\.json/);
  assert.match(res.stdout, /Read nothing else/);
  const fileLines = res.stdout.split('\n').filter((l) => /\d+ lines/.test(l));
  assert.ok(fileLines.length <= 8, `read-path listed ${fileLines.length} files; it must stay small`);
});

test('the whole harness validates itself', () => {
  const validate = run(['validate']);
  assert.equal(validate.status, EXIT.OK, validate.stdout);

  const lint = run(['lint-backlog']);
  assert.equal(lint.status, EXIT.OK, lint.stdout);

  const drift = run(['generate', '--check']);
  assert.equal(drift.status, EXIT.OK, drift.stdout);

  const doctor = run(['doctor']);
  assert.equal(doctor.status, EXIT.OK, doctor.stdout);
});

test('index is idempotent when invoked through the CLI', () => {
  const first = run(['index']);
  assert.equal(first.status, EXIT.OK);
  const second = run(['index']);
  assert.match(second.stdout, /already up to date/);
});

test('an illegal transition exits with the precondition code, so hooks can branch on it', () => {
  const res = run(['task', 'set-status', 'FEAT-0017', 'done']);
  assert.equal(res.status, EXIT.PRECONDITION);
  assert.match(res.stdout, /not allowed/);
});

test('sync is optional: with no credentials it succeeds and says why it did nothing', () => {
  const res = run(['sync']);
  assert.equal(res.status, EXIT.OK, 'the harness must work without any integration');
  assert.match(res.stdout, /disabled/);
});
