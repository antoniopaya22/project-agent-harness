import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isGenerated, isTaskFile, validateTaskFile } from '../.harness/bin/guard.mjs';
import { claudeSettings } from '../.harness/bin/lib/generate.mjs';
import { GENERATED_MARK } from '../.harness/bin/lib/util.mjs';
import { REPO, makeTask, tempHarness } from './helpers.mjs';

/** The guard as the provider runs it: a JSON payload on stdin, a verdict in the exit code. */
function runGuard(payload, mode = 'pre', cwd = REPO) {
  return spawnSync(process.execPath, ['.harness/bin/guard.mjs', mode], {
    cwd: REPO,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_GUARD_CWD: cwd },
  });
}

test('editing a generated file is blocked, and the message says where the source is', () => {
  // "Do not edit this" without saying where the real source is leaves the agent to guess,
  // and it guesses wrong in a plausible-looking way.
  const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: 'CLAUDE.md' } });
  assert.equal(r.status, 2, 'bloqueado de verdad, no avisado');
  assert.match(r.stderr, new RegExp(GENERATED_MARK));
  assert.match(r.stderr, /harness generate/);
  assert.match(r.stderr, /overrides/, 'y cuál es la escotilla legítima');

  // Both shapes: the JSON verdict for providers that read one, exit 2 for those that do not.
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('editing a task file by hand is blocked in favour of the commands that validate', () => {
  const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: '.harness/backlog/tasks/FEAT-0001.json' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /harness task/);
  assert.match(r.stderr, /guardas de transición|esquema/);
});

test('an ordinary source file is allowed, silently', () => {
  const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: '.harness/bin/lib/util.mjs' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'un guard que habla cuando permite es un guard que nadie lee');
});

test('a tool that does not write is never blocked', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash']) {
    const r = runGuard({ tool_name: tool, tool_input: { file_path: 'CLAUDE.md' } });
    assert.equal(r.status, 0, `${tool} no escribe`);
  }
});

test('an unparseable payload allows rather than blocks', () => {
  // The provider's format changing must not block every edit until somebody notices. That
  // failure mode is far worse than letting one edit through.
  const r = spawnSync(process.execPath, ['.harness/bin/guard.mjs', 'pre'], {
    cwd: REPO,
    input: 'esto no es json',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
});

test('the generated header is detected from the top of the file only', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    fs.writeFileSync(path.join(ctx.root, 'arriba.md'), `<!-- ${GENERATED_MARK} v1 -->\ncontenido\n`);
    fs.writeFileSync(path.join(ctx.root, 'abajo.md'), `${'x'.repeat(2000)}\n<!-- ${GENERATED_MARK} -->\n`);

    assert.equal(isGenerated(ctx.root, 'arriba.md'), true);
    assert.equal(isGenerated(ctx.root, 'abajo.md'), false, 'la cabecera es una cabecera, no una aparición cualquiera');
    assert.equal(isGenerated(ctx.root, 'no-existe.md'), false, 'y un fichero que no existe no está generado');
  } finally {
    cleanup();
  }
});

test('only real task paths count as task files', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    assert.equal(isTaskFile(ctx.root, '.harness/backlog/tasks/FEAT-0042.json'), true);
    assert.equal(isTaskFile(ctx.root, '.harness/backlog/index.json'), false);
    assert.equal(isTaskFile(ctx.root, 'docs/FEAT-0042.json'), false);
    assert.equal(isTaskFile(ctx.root, '.harness/backlog/tasks/notas.md'), false);
  } finally {
    cleanup();
  }
});

test('an invalid task file is reported after the write, not repaired', () => {
  // Repairing it would hide the fact that something wrote an invalid task, and that is the
  // thing worth knowing.
  const { ctx, cleanup } = tempHarness();
  try {
    const file = path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0001.json');
    fs.writeFileSync(file, JSON.stringify({ ...makeTask(), status: 'inventado' }, null, 2));
    const { ok, problems } = validateTaskFile(ctx.root, file);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => /status/.test(p)));

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'inventado', 'sigue mal: informar no es arreglar');
  } finally {
    cleanup();
  }
});

test('unparseable JSON in a task file is reported as such', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const file = path.join(ctx.harnessDir, 'backlog', 'tasks', 'FEAT-0002.json');
    fs.writeFileSync(file, '{ roto');
    const { ok, problems } = validateTaskFile(ctx.root, file);
    assert.equal(ok, false);
    assert.match(problems[0], /no se puede leer como JSON/);
  } finally {
    cleanup();
  }
});

test('the projected settings point every hook at the one guard', () => {
  // The policy lives in one place; the provider format is just a projection of it.
  const { ctx, cleanup } = tempHarness();
  try {
    const settings = JSON.parse(claudeSettings(ctx));
    for (const event of ['PreToolUse', 'PostToolUse']) {
      assert.equal(settings.hooks[event].length, 1);
      assert.match(settings.hooks[event][0].hooks[0].command, /guard\.mjs/);
    }
    assert.match(settings.hooks.PreToolUse[0].matcher, /Edit/);
  } finally {
    cleanup();
  }
});

test('regenerating does not duplicate the hooks, and keeps somebody else settings', () => {
  // Replacing the file wholesale would delete settings that are none of the harness's
  // business; appending blindly would add a hook on every single regeneration.
  const { ctx, cleanup } = tempHarness();
  try {
    fs.mkdirSync(path.join(ctx.root, '.claude'), { recursive: true });
    const settingsFile = path.join(ctx.root, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          permissions: { allow: ['Bash(npm test)'] },
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/mio.mjs' }] }],
          },
        },
        null,
        2,
      ),
    );

    for (let i = 0; i < 3; i += 1) fs.writeFileSync(settingsFile, claudeSettings(ctx));

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash(npm test)'], 'lo ajeno se conserva');
    const ours = settings.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes('guard.mjs')));
    const theirs = settings.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes('mio.mjs')));
    assert.equal(ours.length, 1, 'uno solo tras tres regeneraciones');
    assert.equal(theirs.length, 1, 'y el suyo sigue ahí');
  } finally {
    cleanup();
  }
});

test('a broken settings file is left completely alone', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    fs.mkdirSync(path.join(ctx.root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, '.claude', 'settings.json'), '{ a medio escribir');
    const settings = JSON.parse(claudeSettings(ctx));
    assert.ok(settings.hooks.PreToolUse, 'se proyecta lo nuestro');
    assert.equal(fs.readFileSync(path.join(ctx.root, '.claude', 'settings.json'), 'utf8'), '{ a medio escribir');
  } finally {
    cleanup();
  }
});

test('the policy can be switched off from the configuration', () => {
  const { ctx, cleanup } = tempHarness({ project: { hooks: { enabled: false } } });
  try {
    assert.equal(claudeSettings(ctx), null);
  } finally {
    cleanup();
  }
});
