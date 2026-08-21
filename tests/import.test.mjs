import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { classify, taskFromIssue, typeOf } from '../.harness/bin/lib/import.mjs';
import { taskFile } from '../.harness/bin/lib/tasks.mjs';
import { validate } from '../.harness/bin/lib/schema.mjs';
import { makeTask, tempHarness } from './helpers.mjs';

const ISSUE = {
  number: 12,
  title: 'El importador de CSV se cae con ficheros vacíos',
  body: 'Cuando el fichero no tiene cabecera, el proceso termina con una traza sin explicación.',
  url: 'https://github.com/acme/app/issues/12',
  labels: [{ name: 'bug' }],
};

test('an imported issue lands unrefined, and linked to where it came from', () => {
  // An issue is somebody's idea, not a refined task: nobody has said what "done" means for
  // it, and marking it ready would be lying about its state to whoever picks it up.
  const { ctx, cleanup } = tempHarness();
  try {
    const task = taskFromIssue(ctx, ISSUE);
    assert.equal(task.status, 'backlog');
    assert.equal(task.type, 'fix', 'la etiqueta bug es la única señal que hay, y es explícita');
    assert.match(task.id, /^FIX-\d{4}$/);
    assert.equal(task.links.issue, ISSUE.url);
    assert.equal(task.external.github.issue, 12);
    assert.match(task.acceptance_criteria[0].must, /SIN REFINAR/);
    assert.equal(task.acceptance_criteria[0].check.type, 'manual', 'inventar el check sería inventar el criterio');
    assert.match(task.description, /issues\/12/, 'y el origen queda dentro de la descripción, no solo en un campo');
  } finally {
    cleanup();
  }
});

test('an imported task is schema-valid even when the issue was nearly empty', () => {
  // Real backlogs are full of one-line issues. If those produce an invalid task the import
  // fails on exactly the input it will see most.
  const { ctx, cleanup } = tempHarness();
  try {
    const task = taskFromIssue(ctx, { number: 3, title: 'Arreglar', body: '', url: 'https://x/3', labels: [] });
    const problems = validate(task, ctx.taskSchema);
    assert.deepEqual(problems, [], `tarea inválida: ${problems.join('; ')}`);
    assert.ok(task.title.length >= 10, 'un título de una palabra se completa en lugar de romper el esquema');
  } finally {
    cleanup();
  }
});

test('a second import does not duplicate what is already there', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const first = classify(ctx, [ISSUE]);
    assert.equal(first.take.length, 1);

    const task = taskFromIssue(ctx, ISSUE);
    fs.writeFileSync(taskFile(ctx, task.id), `${JSON.stringify(task, null, 2)}\n`);

    const second = classify(ctx, [ISSUE]);
    assert.equal(second.take.length, 0);
    assert.equal(second.skip[0].reason, 'ya importada');
  } finally {
    cleanup();
  }
});

test('the harness never re-imports its own projection', () => {
  // `harness sync` writes issues titled `FEAT-0042 · …` with a marker in the body. Importing
  // those back creates a task per task, forever, and the loop is invisible in the output
  // until the backlog has doubled.
  const { ctx, cleanup } = tempHarness();
  try {
    const projected = [
      { number: 90, title: 'FEAT-0042 · Frescura de documentos', body: 'algo\n<!-- Proyectado por harness -->', url: 'https://x/90', labels: [] },
      { number: 91, title: 'CHORE-0002 · Proyectos de prueba', body: 'sin marcador pero con el título de siempre', url: 'https://x/91', labels: [] },
    ];
    const { take, skip } = classify(ctx, projected);
    assert.equal(take.length, 0);
    assert.equal(skip.length, 2);
    for (const s of skip) assert.match(s.reason, /proyección del propio harness/);
  } finally {
    cleanup();
  }
});

test('a task that already carries the issue number counts as imported, however it got there', () => {
  // The link can come from `sync` as well as from `import`, and both mean the same thing:
  // this issue is already represented in the backlog.
  const { ctx, cleanup } = tempHarness({
    tasks: [makeTask({ id: 'FEAT-0001', links: { pr: null, issue: 44, commits: [] } })],
  });
  try {
    const { take } = classify(ctx, [{ number: 44, title: 'Algo que ya está', body: 'x', url: 'https://x/44', labels: [] }]);
    assert.equal(take.length, 0);
  } finally {
    cleanup();
  }
});

test('the type comes from an explicit label, and defaults to the least presumptuous thing', () => {
  assert.equal(typeOf({ labels: [{ name: 'enhancement' }] }), 'feature');
  assert.equal(typeOf({ labels: [{ name: 'documentation' }] }), 'docs');
  assert.equal(typeOf({ labels: [{ name: 'question' }] }), 'spike');
  assert.equal(typeOf({ labels: [{ name: 'good first issue' }] }), 'chore', 'llamarlo feature implicaría que alguien decidió que debe existir');
  assert.equal(typeOf({ labels: [] }), 'chore');
});

test('every skipped issue says why, so a no-op import is not mistaken for an empty one', () => {
  const { ctx, cleanup } = tempHarness();
  try {
    const { skip } = classify(ctx, [{ number: 5, title: 'FEAT-0001 · proyectada', body: '', url: 'https://x/5', labels: [] }]);
    assert.equal(skip.length, 1);
    assert.ok(skip[0].reason, 'un motivo, siempre');
  } finally {
    cleanup();
  }
});
