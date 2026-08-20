import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyRewrites,
  planRewrites,
  recomputeRelative,
  rewriteJsFile,
  rewritePathsInText,
} from '../.harness/bin/lib/refs.mjs';
import { loadLayout } from '../.harness/bin/lib/layouts.mjs';
import { repoCtx } from './helpers.mjs';

const ctx = repoCtx();
let n = 0;

function project(files) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-refs-${n}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a relative specifier is recomputed when the importer moves', () => {
  const moves = [{ from: 'a.mjs', to: 'src/a.mjs' }];
  assert.equal(recomputeRelative('a.mjs', 'src/a.mjs', './b.mjs', moves), '../b.mjs');
});

test('a relative specifier is recomputed when the target moves', () => {
  const moves = [{ from: 'b.mjs', to: 'src/b.mjs' }];
  assert.equal(recomputeRelative('a.mjs', 'a.mjs', './b.mjs', moves), './src/b.mjs');
});

test('when both ends move together the specifier is unchanged', () => {
  const moves = [
    { from: 'a.mjs', to: 'src/a.mjs' },
    { from: 'b.mjs', to: 'src/b.mjs' },
  ];
  assert.equal(recomputeRelative('a.mjs', 'src/a.mjs', './b.mjs', moves), './b.mjs');
});

test('a bare specifier is never touched', () => {
  const moves = [{ from: 'a.mjs', to: 'src/a.mjs' }];
  assert.equal(recomputeRelative('a.mjs', 'src/a.mjs', 'node:fs', moves), 'node:fs');
  assert.equal(recomputeRelative('a.mjs', 'src/a.mjs', 'lodash', moves), 'lodash');
});

test('an omitted extension is not invented', () => {
  const moves = [{ from: 'b.ts', to: 'src/b.ts' }];
  assert.equal(recomputeRelative('a.ts', 'a.ts', './b', moves), './src/b');
});

test('a config path is substituted whole, so src/api never matches src/apiary', () => {
  const before = 'testpaths = ["src/api", "src/apiary"]\n';
  const { text, changes } = rewritePathsInText(before, [{ from: 'src/api', to: 'src/app/api' }]);
  assert.equal(changes, 1);
  assert.match(text, /"src\/app\/api"/);
  assert.match(text, /"src\/apiary"/, 'the longer name must survive untouched');
});

test('a nested move is not half-rewritten by its parent', () => {
  const before = 'a = "src/api/users.py"\nb = "src/api"\n';
  const { text } = rewritePathsInText(before, [
    { from: 'src/api', to: 'pkg/api' },
    { from: 'src/api/users.py', to: 'pkg/api/user.py' },
  ]);
  assert.match(text, /"pkg\/api\/user\.py"/);
  assert.match(text, /b = "pkg\/api"/);
});

test('backslash paths in config are rewritten as backslashes', () => {
  const { text } = rewritePathsInText('COPY src\\\\api /app\n', [{ from: 'src/api', to: 'pkg/api' }]);
  assert.match(text, /pkg\\\\api/);
});

test('a python absolute import gains the package prefix when the module moves', () => {
  const { dir, cleanup } = project({
    'utils.py': 'X = 1\n',
    'main.py': 'import utils\nfrom utils import X\nimport utilsplus\n',
    'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["utils.py"]\n',
  });
  try {
    const moves = [{ from: 'utils.py', to: 'src/miapp/utils.py' }];
    const plan = planRewrites(dir, moves, loadLayout(ctx, 'python'), { packageName: 'miapp' });
    const main = plan.sources.find((s) => s.file === 'main.py');
    assert.ok(main, 'main.py was not rewritten');
    assert.match(main.text, /import miapp\.utils/);
    assert.match(main.text, /from miapp\.utils import X/);
    assert.match(main.text, /import utilsplus/, 'a longer module name must not be caught');
  } finally {
    cleanup();
  }
});

test('the declared config families are rewritten and reported by name', () => {
  const { dir, cleanup } = project({
    'pyproject.toml': '[tool.coverage.run]\nsource = ["app"]\n',
    'Dockerfile': 'COPY app /srv/app\n',
    'MANIFEST.in': 'recursive-include app *.py\n',
    'app/__init__.py': '',
  });
  try {
    const plan = planRewrites(dir, [{ from: 'app', to: 'src/app' }], loadLayout(ctx, 'python'));
    const files = plan.configs.map((c) => c.file).sort();
    assert.deepEqual(files, ['Dockerfile', 'MANIFEST.in', 'pyproject.toml']);
    for (const c of plan.configs) assert.ok(c.changes > 0);
  } finally {
    cleanup();
  }
});

test('declared families that are absent are reported as not checked, not assumed fine', () => {
  const { dir, cleanup } = project({ 'pyproject.toml': 'source = ["app"]\n', 'app/x.py': '' });
  try {
    const plan = planRewrites(dir, [{ from: 'app', to: 'src/app' }], loadLayout(ctx, 'python'));
    assert.ok(plan.unmatched.includes('Dockerfile'), 'an absent Dockerfile must be listed as unchecked');
    assert.ok(!plan.unmatched.includes('pyproject.toml'));
  } finally {
    cleanup();
  }
});

test('planning writes nothing; applying writes exactly the planned files', () => {
  const { dir, cleanup } = project({
    'pyproject.toml': 'source = ["app"]\n',
    'app/__init__.py': '',
    'main.py': 'import app\n',
  });
  try {
    const moves = [{ from: 'app', to: 'src/app' }];
    const plan = planRewrites(dir, moves, loadLayout(ctx, 'python'));
    assert.equal(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), 'source = ["app"]\n', 'planning must not write');

    const touched = applyRewrites(dir, plan);
    assert.ok(touched.configs.includes('pyproject.toml'));
    assert.match(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), /"src\/app"/);
  } finally {
    cleanup();
  }
});

test('a file that itself moved is rewritten at its new location', () => {
  const { dir, cleanup } = project({ 'a.mjs': "import './b.mjs';\n", 'b.mjs': '', 'src/.keep': '' });
  try {
    const moves = [{ from: 'a.mjs', to: 'src/a.mjs' }];
    const plan = planRewrites(dir, moves, loadLayout(ctx, 'node-ts'));
    const item = plan.sources.find((s) => s.file === 'a.mjs');
    assert.equal(item.finalPath, 'src/a.mjs', 'the rewrite belongs at the destination');
    assert.match(item.text, /'\.\.\/b\.mjs'/);
  } finally {
    cleanup();
  }
});

test('a project with nothing to rewrite produces an empty plan, not an error', () => {
  const { dir, cleanup } = project({ 'README.md': '# nada\n' });
  try {
    const plan = planRewrites(dir, [{ from: 'a.py', to: 'src/a.py' }], loadLayout(ctx, 'python'));
    assert.deepEqual(plan.sources, []);
    assert.deepEqual(plan.configs, []);
  } finally {
    cleanup();
  }
});

test('a path with no separator is substituted once, not twice', () => {
  // The first version ran both separator spellings, which for a slash-free path was the
  // same string twice: "app" became "src/src/app".
  const { text, changes } = rewritePathsInText('source = ["app"]', [{ from: 'app', to: 'src/app' }]);
  assert.equal(text, 'source = ["src/app"]');
  assert.equal(changes, 1);
});

test('a longer name containing the moved one is left alone', () => {
  const { text, changes } = rewritePathsInText('source = ["myapp", "app"]', [{ from: 'app', to: 'src/app' }]);
  assert.equal(changes, 1);
  assert.match(text, /"myapp"/);
  assert.match(text, /"src\/app"/);
});

test('a side-effect import is rewritten too', () => {
  // `import './x'` has no binding and no `from`, and was missed at first — the kind of gap
  // that leaves a project importing nothing while looking fine.
  const { text, changes } = rewriteJsFile("import './b.mjs';\n", 'a.mjs', 'src/a.mjs', [{ from: 'a.mjs', to: 'src/a.mjs' }]);
  assert.equal(changes, 1);
  assert.match(text, /'\.\.\/b\.mjs'/);
});

test('dynamic import and require are both recognised', () => {
  const moves = [{ from: 'a.mjs', to: 'src/a.mjs' }];
  const dynamic = rewriteJsFile("const m = await import('./b.mjs');\n", 'a.mjs', 'src/a.mjs', moves);
  assert.equal(dynamic.changes, 1);
  const cjs = rewriteJsFile("const m = require('./b.js');\n", 'a.mjs', 'src/a.mjs', moves);
  assert.equal(cjs.changes, 1);
});
