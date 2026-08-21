import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectExistingHarness,
  didNotRun,
  gateBaseline,
  hasSafetyNet,
  leadingExecutable,
  resolveExecutable,
  survey,
} from '../.harness/bin/lib/survey.mjs';
import {
  UNVERIFIED,
  proposalStats,
  proposeAreas,
  proposeGates,
  proposeSeedTasks,
  renderProposal,
  writeProposal,
} from '../.harness/bin/lib/proposal.mjs';

let n = 0;
function project(files, { git = true } = {}) {
  n += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-survey-${n}-`));
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

const NODE_PROJECT = {
  'package.json': JSON.stringify({
    name: 'demo',
    main: 'src/index.js',
    scripts: { lint: 'eslint .', test: 'vitest run', build: 'tsc -p .' },
  }),
  'tsconfig.json': '{}',
  'src/api/users.ts': '// TODO: validar el email\nexport const x = 1;\n',
  'src/web/page.tsx': 'export const y = 2;\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'README.md': '# demo\n',
};

const PYTHON_PROJECT = {
  'pyproject.toml': '[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.mypy]\nstrict = true\n',
  'src/app/__init__.py': '',
  'src/app/main.py': '# FIXME: esto no maneja el caso vacio\n',
  'tests/test_main.py': 'def test_ok():\n    assert True\n',
};

test('a Node project is detected with its real gate commands and their evidence', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, 'typescript');
    assert.equal(s.stack.packageManager, 'npm');
    assert.equal(s.stack.gates.lint.run, 'npm run lint');
    assert.equal(s.stack.gates.lint.evidence, 'package.json scripts.lint');
    assert.equal(s.stack.gates.typecheck, undefined, 'a tsconfig is not a typecheck command');
    assert.deepEqual(s.areas.map((a) => a.id).sort(), ['api', 'web']);
    assert.deepEqual(s.ci.map((x) => x.file), ['.github/workflows/ci.yml']);
    assert.ok(s.entryPoints.some((e) => e.path === 'src/index.js'));
  } finally {
    cleanup();
  }
});

test('a Python project is detected from its own configuration', () => {
  const { dir, cleanup } = project(PYTHON_PROJECT);
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, 'python');
    assert.equal(s.stack.gates.lint.run, 'ruff check .');
    assert.equal(s.stack.gates.test.run, 'pytest -q');
    assert.equal(s.stack.gates.typecheck.run, 'mypy .');
    assert.match(s.stack.gates.typecheck.evidence, /tool\.mypy/);
  } finally {
    cleanup();
  }
});

test('nothing is invented when there is no evidence', () => {
  const { dir, cleanup } = project({ 'notas.txt': 'hola', 'algo.mjs': 'export const x = 1;\n' });
  try {
    const s = survey(dir);
    assert.equal(s.stack.language, null, 'loose .mjs files are not a declared stack');
    assert.deepEqual(s.stack.gates, {});
    assert.deepEqual(s.ci, []);
  } finally {
    cleanup();
  }
});

test('the survey writes nothing at all', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
    const listing = (d) => fs.readdirSync(d, { recursive: true }).sort().join('\n');
    const treeBefore = listing(dir);

    survey(dir);

    assert.equal(listing(dir), treeBefore, 'no file appeared or vanished');
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout, before);
  } finally {
    cleanup();
  }
});

test('unfinished work the code admits to is collected with file and line', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    const todo = s.pending.find((p) => p.kind === 'TODO');
    assert.ok(todo, 'the TODO in src/api/users.ts was missed');
    assert.equal(todo.file, 'src/api/users.ts');
    assert.equal(todo.line, 1);
    assert.match(todo.text, /validar el email/);
  } finally {
    cleanup();
  }
});

test('the hotspots come from git history, and an absent history is not an error', () => {
  const withGit = project(NODE_PROJECT);
  try {
    spawnSync('git', ['add', '-A'], { cwd: withGit.dir });
    spawnSync('git', ['commit', '-q', '-m', 'inicial'], { cwd: withGit.dir });
    assert.ok(survey(withGit.dir).hotspots.length > 0);
  } finally {
    withGit.cleanup();
  }

  const noGit = project(NODE_PROJECT, { git: false });
  try {
    assert.deepEqual(survey(noGit.dir).hotspots, [], 'no history means no hotspots, not a crash');
    assert.equal(survey(noGit.dir).isGitRepo, false);
  } finally {
    noGit.cleanup();
  }
});

test('the baseline records what each gate does today, before anything changes', () => {
  const { dir, cleanup } = project({
    'package.json': JSON.stringify({ name: 'd', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(1)"' } }),
  });
  try {
    const s = survey(dir);
    const baseline = gateBaseline(dir, s.stack);
    assert.equal(baseline.test.state, 'pass');
    assert.equal(baseline.lint.state, 'fail');
    assert.equal(baseline.lint.code, 1);
    assert.equal(baseline.test.evidence, 'package.json scripts.test');
  } finally {
    cleanup();
  }
});

test('a passing test gate is a safety net; anything else is not', () => {
  assert.equal(hasSafetyNet({ test: { state: 'pass', command: 'pytest' } }).safe, true);
  assert.equal(hasSafetyNet({ test: { state: 'fail', command: 'pytest' } }).safe, false);
  assert.match(hasSafetyNet({ test: { state: 'fail' } }).reason, /cannot tell you what you broke/);
  assert.equal(hasSafetyNet({ lint: { state: 'pass' } }).safe, false, 'lint is not a safety net');
  assert.match(hasSafetyNet({}).reason, /nothing to detect a break/);
});

test('a project that already has a harness is recognised instead of adopted again', () => {
  const { dir, cleanup } = project({
    'package.json': '{"name":"d"}',
    '.harness/project.json': JSON.stringify({
      harness_version: '1.0.0',
      gates: { test: { run: 'pytest' }, lint: { run: null } },
      areas: [{ id: 'core' }],
    }),
  });
  try {
    const existing = detectExistingHarness(dir);
    assert.equal(existing.version, '1.0.0');
    assert.deepEqual(existing.gates, ['test'], 'only gates with a real command count');
    assert.deepEqual(survey(dir).existingHarness.areas, ['core']);
  } finally {
    cleanup();
  }
});

test('a corrupt harness config is reported as unreadable, not treated as absent', () => {
  const { dir, cleanup } = project({ '.harness/project.json': '{ roto' });
  try {
    assert.equal(detectExistingHarness(dir).version, 'ilegible');
  } finally {
    cleanup();
  }
});

// --- stage 3: the proposal ---------------------------------------------------

test('every statement in the proposal carries evidence or is marked unverified', () => {
  // The whole value of an adoption is that its output can be trusted. A claim with neither
  // a file behind it nor a marker on it is the one thing this file exists to prevent.
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    const body = renderProposal({ root: dir, harnessDir: path.join(dir, '.harness') }, {
      survey: s,
      baseline: gateBaseline(dir, s.stack),
      answers: { known: {}, unverified: [] },
    });

    for (const line of body.split('\n')) {
      // Only prose claims are checked: headings, tables, quotes and list scaffolding carry
      // no assertion of their own.
      if (!/^[A-ZÁÉÍÓÚ¿].*[a-z]/.test(line)) continue;
      if (/^(Perfil|Nada|El código|Esto queda|Ninguna)/.test(line)) continue;
      assert.ok(
        line.includes('[evidencia:') || line.includes(UNVERIFIED),
        `una afirmación sin respaldo ni marca: ${line}`,
      );
    }
    const stats = proposalStats(body);
    assert.ok(stats.evidenced > 0, 'y alguna afirmación sí trae evidencia');
  } finally {
    cleanup();
  }
});

test('nothing but the proposal is written in this stage', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const before = new Set(fs.readdirSync(dir, { recursive: true }).map(String));
    const s = survey(dir);
    const ctx = { root: dir, harnessDir: path.join(dir, '.harness') };
    writeProposal(ctx, { survey: s, baseline: null, answers: { known: {}, unverified: [] } });

    const after = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => !before.has(f));
    const created = after.filter((f) => !fs.statSync(path.join(dir, f)).isDirectory());
    assert.deepEqual(
      created.map((f) => f.split(path.sep).join('/')),
      ['.harness/adoption/PROPOSAL.md'],
      'la etapa 3 escribe un fichero y solo uno',
    );
  } finally {
    cleanup();
  }
});

test('a gate nobody confirmed and no file declares is proposed as absent, not guessed', () => {
  const { dir, cleanup } = project({ 'src/loose.mjs': 'export const a = 1;\n' });
  try {
    const gates = proposeGates(survey(dir), { known: {} });
    assert.equal(gates.test.status, 'not-configured');
    assert.equal(gates.test.run, null);
    assert.equal(gates.lint.run, null);
  } finally {
    cleanup();
  }
});

test('a human correction beats the inference, and is recorded as confirmed', () => {
  const { dir, cleanup } = project(PYTHON_PROJECT);
  try {
    const gates = proposeGates(survey(dir), { known: { 'gate.test': 'pytest -q --cov' } });
    assert.equal(gates.test.run, 'pytest -q --cov');
    assert.equal(gates.test.confirmed, true);
    assert.match(gates.test.evidence, /pytest/, 'sin perder de dónde salió la inferencia original');
  } finally {
    cleanup();
  }
});

test('the areas proposed are the ones the human confirmed, not everything on disk', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const s = survey(dir);
    assert.ok(s.areas.length >= 2, 'el proyecto de prueba tiene varias');
    const chosen = proposeAreas(s, { known: { areas: ['api'] } });
    assert.deepEqual(chosen.map((a) => a.id), ['api']);
    assert.equal(chosen[0].doc, 'docs/areas/api.md');
  } finally {
    cleanup();
  }
});

test('the seed backlog comes from what the code admits, and never lands as ready', () => {
  const { dir, cleanup } = project(PYTHON_PROJECT);
  try {
    const seeds = proposeSeedTasks(survey(dir));
    assert.ok(seeds.length >= 1);
    for (const t of seeds) {
      assert.equal(t.status, 'backlog', 'marcarlas listas sería mentir sobre su estado');
      assert.match(t.evidence, /:\d+$/, 'y cada una apunta a fichero y línea');
    }
    assert.equal(seeds[0].type, 'fix', 'un FIXME es un fix, no una tarea de mantenimiento');
  } finally {
    cleanup();
  }
});

test('without a safety net the proposal moves nothing and says so', () => {
  const { dir, cleanup } = project({ 'a.py': 'x = 1\n' });
  try {
    const body = renderProposal({ root: dir, harnessDir: path.join(dir, '.harness') }, {
      survey: survey(dir),
      baseline: {},
      answers: { known: {}, unverified: [] },
      layout: { id: 'src-layout' },
      moves: [{ from: 'a.py', to: 'src/demo/a.py', rule: 'x' }],
    });
    assert.match(body, /No se mueve nada/);
    assert.doesNotMatch(body, /src\/demo\/a\.py/, 'no se anuncia un movimiento que no va a ocurrir');
    assert.match(body, /tareas del backlog/, 'y se ofrece la salida que sí es honesta');
  } finally {
    cleanup();
  }
});

test('what the human did not know surfaces in the proposal instead of being filled in', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const body = renderProposal({ root: dir, harnessDir: path.join(dir, '.harness') }, {
      survey: survey(dir),
      baseline: null,
      answers: { known: { purpose: 'Un catálogo interno.' }, unverified: [{ id: 'glossary', question: '¿Términos de dominio?' }] },
    });
    assert.match(body, /Un catálogo interno\./);
    assert.match(body, /¿Términos de dominio\?/);
    assert.ok(proposalStats(body).unverified > 0);
  } finally {
    cleanup();
  }
});

test('proposing twice over the same answers gives the same file, byte for byte', () => {
  // The loop is propose, correct, propose again. If the file churned on its own, a human
  // could not tell their correction from noise.
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const ctx = { root: dir, harnessDir: path.join(dir, '.harness') };
    const input = { survey: survey(dir), baseline: null, answers: { known: {}, unverified: [] } };
    const a = writeProposal(ctx, input).body;
    const b = writeProposal(ctx, input).body;
    assert.equal(a, b);
  } finally {
    cleanup();
  }
});

test('an existing document is announced as an overlap, never as an overwrite', () => {
  const { dir, cleanup } = project({ ...NODE_PROJECT, 'docs/ARCHITECTURE.md': '# lo nuestro\n' });
  try {
    const body = renderProposal({ root: dir, harnessDir: path.join(dir, '.harness') }, {
      survey: survey(dir),
      baseline: null,
      answers: { known: {}, unverified: [] },
    });
    assert.match(body, /docs\/ARCHITECTURE\.md`\s+\*\*ya existe/);
    assert.ok(fs.readFileSync(path.join(dir, 'docs', 'ARCHITECTURE.md'), 'utf8').includes('lo nuestro'));
  } finally {
    cleanup();
  }
});

test('propose refuses while the interview still has holes, and says how to continue', () => {
  // Proposing from an unfinished interview is exactly how an adoption invents the parts
  // nobody answered. Exit 3, not a warning nobody reads.
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const r = spawnSync(process.execPath, ['.harness/bin/harness.mjs', 'propose', dir], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr + r.stdout, /harness interview/);
    assert.ok(!fs.existsSync(path.join(dir, '.harness', 'adoption', 'PROPOSAL.md')), 'y no escribe nada');
  } finally {
    cleanup();
  }
});

test('propose --force writes the proposal with the holes visible as holes', () => {
  const { dir, cleanup } = project(NODE_PROJECT);
  try {
    const r = spawnSync(process.execPath, ['.harness/bin/harness.mjs', 'propose', dir, '--force', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.unverified > 0, 'los huecos se cuentan, no se disimulan');
    const body = fs.readFileSync(path.join(dir, '.harness', 'adoption', 'PROPOSAL.md'), 'utf8');
    assert.match(body, /Lo que no se sabe/);
  } finally {
    cleanup();
  }
});

// --- stage 5: applying it, and the end-to-end adoption -----------------------

/** A full adoption of a throwaway project, driven exactly as /adopt drives it. */
function adopt(dir, extra = []) {
  const run = (args) => spawnSync(process.execPath, ['.harness/bin/harness.mjs', ...args], { encoding: 'utf8' });
  const init = run(['init', dir, '--purpose', 'Un proyecto de prueba para los autotests.', ...extra]);
  const apply = run(['apply', dir]);
  return { init, apply, run };
}

test('a gate that never runs is not recorded as configured', () => {
  // Reading a command off a config file is a hypothesis. Writing it down as configured
  // without executing it once produces a harness whose first real command fails.
  const { dir, cleanup } = project({
    'pyproject.toml': '[tool.ruff]\nline-length = 100\n',
    'src/app/main.py': 'x = 1\n',
  });
  try {
    const { apply } = adopt(dir);
    assert.equal(apply.status, 1, 'y el fallo se propaga: quien encadena comandos tiene que saberlo');
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'project.json'), 'utf8'));
    assert.equal(config.gates.lint.status, 'not-configured', 'ruff no está instalado aquí, así que no es un gate');
    assert.equal(config.gates.lint.required, false, 'ni se queda como obligatorio');
    assert.match(apply.stdout, /no llegaron a ejecutarse/);
  } finally {
    cleanup();
  }
});

test('a gate that runs and fails stays configured, because that is the truth', () => {
  const { dir, cleanup } = project({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(1)"' } }),
    'src/a.js': 'export const a = 1;\n',
  });
  try {
    adopt(dir);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'project.json'), 'utf8'));
    assert.equal(config.gates.test.status, 'configured');
    assert.equal(config.gates.test.required, true);
  } finally {
    cleanup();
  }
});

test('the seeded tasks are unrefined and never marked ready', () => {
  const { dir, cleanup } = project(PYTHON_PROJECT);
  try {
    adopt(dir);
    const tasksDir = path.join(dir, '.harness', 'backlog', 'tasks');
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, 'el FIXME del proyecto de prueba produce al menos una');
    for (const f of files) {
      const t = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      assert.equal(t.status, 'backlog');
      assert.match(t.acceptance_criteria[0].must, /SIN REFINAR/);
      assert.equal(t.acceptance_criteria[0].check.type, 'manual', 'inventar el check sería inventar el criterio');
      assert.ok(t.context.area, 'y cada una cuelga de un área, para no quedar huérfana del read path');
    }
  } finally {
    cleanup();
  }
});

test('adoption never overwrites a file that was already there', () => {
  const { dir, cleanup } = project({
    ...NODE_PROJECT,
    'docs/areas/api.md': '# lo que ya habia escrito un humano\n',
    'README.md': '# el readme de verdad\n',
  });
  try {
    const { init } = adopt(dir);
    assert.equal(init.status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'docs', 'areas', 'api.md'), 'utf8'), /ya habia escrito/);
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /el readme de verdad/);
    assert.match(init.stdout, /respetados por existir ya/);
  } finally {
    cleanup();
  }
});

test('adopting a project with passing tests leaves a harness that self-diagnoses green', () => {
  // The end-to-end claim of the whole epic. Anything less and the first thing a newcomer
  // sees is a wall of errors about files the installer could have written itself.
  const { dir, cleanup } = project({
    'package.json': JSON.stringify({ name: 'verde', scripts: { test: 'node --test test/' } }),
    'src/core/index.js': 'export const suma = (a, b) => a + b;\n',
    'test/core.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('suma', () => assert.equal(1 + 1, 2));\n",
  });
  try {
    const { apply, run } = adopt(dir);
    assert.equal(apply.status, 0, `apply falló: ${apply.stdout}${apply.stderr}`);

    const doctor = spawnSync(process.execPath, [path.join(dir, '.harness', 'bin', 'harness.mjs'), 'doctor'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(doctor.status, 0, `doctor no quedó verde:\n${doctor.stdout}\n${doctor.stderr}`);

    const gate = spawnSync(process.execPath, [path.join(dir, '.harness', 'bin', 'harness.mjs'), 'gate', 'test'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(gate.status, 0, `el gate inferido no funciona de verdad:\n${gate.stdout}\n${gate.stderr}`);
    void run;
  } finally {
    cleanup();
  }
});

test('a project with no tests turns the reorganisation into tasks instead of moving code', () => {
  // Without an oracle, moving a file is indistinguishable from breaking it. The honest
  // output is a backlog, and the first task is getting a safety net.
  const { dir, cleanup } = project({ 'app.py': 'x = 1\n', 'util.py': 'y = 2\n' });
  try {
    adopt(dir, ['--layout', 'python']);
    const before = fs.readdirSync(dir).sort();

    const r = spawnSync(process.execPath, [path.join(dir, '.harness', 'bin', 'harness.mjs'), 'restructure'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 3, `se esperaba una precondición, salió ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /tareas que emitir en su lugar/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'y no se movió absolutamente nada');
  } finally {
    cleanup();
  }
});

test('the executable is resolved against the PATH, not guessed from the shell message', () => {
  // The shell reports a missing program in the user's own language, so the message is not
  // something to build on. The PATH is.
  assert.ok(resolveExecutable(process.platform === 'win32' ? 'cmd' : 'sh'), 'lo que existe se encuentra');
  assert.equal(resolveExecutable('esto-no-existe-en-ningun-path-1234'), null);
  assert.equal(leadingExecutable('LC_ALL=C ruff check .'), 'ruff', 'los prefijos de entorno no son el programa');
  assert.equal(leadingExecutable('"C:/tools/my tool.exe" --x'), 'C:/tools/my tool.exe');
});

test('a wrapped miss stays a failure, and the gate stays configured', () => {
  // `npm run lint` where npm exists but the script's tool does not: npm reports it as a
  // plain failure and nothing machine-readable separates that from a real lint failure.
  // Recording the limit here so nobody later mistakes it for a bug.
  assert.equal(didNotRun(1, 'npm error algo salió mal'), false);
  assert.equal(didNotRun(127, ''), true, 'pero el 127 de POSIX sí es concluyente');
  assert.equal(didNotRun(1, 'npm error Missing script: "typecheck"'), true, 'y npm habla inglés siempre');
});
