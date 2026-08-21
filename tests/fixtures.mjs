// The fake projects the adoption is tested against.
//
// They are real directories with real git repositories, not mocks, because the whole claim
// of an adoption is about files on disk and a mock would only test the mock.
//
// Two of them carry the claim of the epic between them:
//
//   GREEN_PROJECT     tests that pass, so a full adoption must end with a green doctor and a
//                     gate that really runs.
//   NO_TESTS_PROJECT  no tests at all, so the reorganisation must refuse and emit tasks —
//                     without an oracle, moving a file is indistinguishable from breaking it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let n = 0;

/** A throwaway project on disk. Returns its path plus a cleanup function. */
export function fakeProject(files, { git = true } = {}) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-fixture-${n}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (git) {
    for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T']]) {
      spawnSync('git', args, { cwd: dir });
    }
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A project whose tests pass. Deliberately uses `node --test` rather than a framework: the
 * fixture must not depend on anything being installed, or the test would be measuring the
 * machine instead of the harness.
 */
export const GREEN_PROJECT = {
  'package.json': JSON.stringify({ name: 'verde', scripts: { test: 'node --test test/' } }, null, 2),
  'src/core/index.js': 'export const suma = (a, b) => a + b;\n',
  'src/web/page.js': '// TODO: paginar el listado\nexport const page = 1;\n',
  'test/core.test.mjs':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('suma', () => assert.equal(1 + 1, 2));\n",
  'README.md': '# verde\n',
};

/** A project with no tests, and therefore no safety net. */
export const NO_TESTS_PROJECT = {
  'app.py': '# FIXME: esto no valida la entrada\nx = 1\n',
  'util.py': 'y = 2\n',
  'requirements.txt': 'requests\n',
};

/** Runs the template CLI (the one under test) against a target directory. */
export function harness(args, opts = {}) {
  return spawnSync(process.execPath, ['.harness/bin/harness.mjs', ...args], { encoding: 'utf8', ...opts });
}

/** Runs the CLI a project got installed into, from inside that project. */
export function harnessIn(dir, args) {
  return spawnSync(process.execPath, [path.join(dir, '.harness', 'bin', 'harness.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}
