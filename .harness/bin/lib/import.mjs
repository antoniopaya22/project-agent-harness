// `harness import` — seed a backlog from the issues a repository already has.
//
// Two rules make this safe to run more than once, and both are mechanical:
//
//   1. **Never re-import our own projection.** `harness sync` writes issues titled
//      `FEAT-0042 · …` with a marker in the body. Importing those back would create a task
//      per task, forever, and the loop is not obvious from the output until the backlog has
//      doubled.
//   2. **Everything lands in `backlog`.** An issue is somebody's idea, not a refined task:
//      nobody has said what "done" means for it. Marking it `ready` would be lying about its
//      state to whoever picks it up.

import { spawnSync } from 'node:child_process';
import * as board from './board.mjs';
import { allocateId, load, loadAll, taskFile } from './tasks.mjs';
import { c, nowIso, ok, say, warn, writeJson } from './util.mjs';

/** The marker `harness sync` leaves in every body it writes. */
export const PROJECTION_MARKER = 'Proyectado por harness';

/** A title our own projection would have produced. */
export const PROJECTED_TITLE = /^[A-Z]+-\d{4}\s/;

export function gh(ctx, args) {
  return spawnSync('gh', args, { cwd: ctx.root, encoding: 'utf8' });
}

export function hasGh(ctx) {
  return gh(ctx, ['--version']).status === 0;
}

/** Open issues, newest last, or an explanation of why none could be read. */
export function fetchIssues(ctx, { limit = 200, state = 'open', repo = null } = {}) {
  const args = ['issue', 'list', '--state', state, '--limit', String(limit), '--json', 'number,title,body,url,labels,author,createdAt'];
  if (repo) args.push('--repo', repo);
  const res = gh(ctx, args);
  if (res.status !== 0) {
    return { issues: [], error: (res.stderr || res.stdout || 'gh falló sin decir por qué').trim() };
  }
  try {
    return { issues: JSON.parse(res.stdout || '[]'), error: null };
  } catch (e) {
    return { issues: [], error: `respuesta de gh ilegible: ${e.message}` };
  }
}

/**
 * Which issues are worth importing, and why each one was left out.
 * The reasons are returned rather than dropped: an import that silently skips half its input
 * looks identical to one that had nothing to do.
 */
export function classify(ctx, issues, { tasks = null } = {}) {
  const existing = tasks || loadAll(ctx);
  const already = new Set();
  for (const task of existing) {
    const num = task.external?.github?.issue ?? task.links?.issue;
    if (num != null) already.add(Number(num));
  }

  const take = [];
  const skip = [];
  for (const issue of issues) {
    if (already.has(Number(issue.number))) {
      skip.push({ issue, reason: 'ya importada' });
    } else if (String(issue.body || '').includes(PROJECTION_MARKER) || PROJECTED_TITLE.test(String(issue.title))) {
      // Importing our own projection back would create a task per task, forever.
      skip.push({ issue, reason: 'es una proyección del propio harness' });
    } else {
      take.push(issue);
    }
  }
  return { take, skip };
}

/** Issue labels are the only signal available for the type, and only when they are explicit. */
export function typeOf(issue) {
  const labels = (issue.labels || []).map((l) => String(l.name || l).toLowerCase());
  if (labels.some((l) => /^(bug|fix|defect)$/.test(l))) return 'fix';
  if (labels.some((l) => /^(docs?|documentation)$/.test(l))) return 'docs';
  if (labels.some((l) => /^(chore|maintenance)$/.test(l))) return 'chore';
  if (labels.some((l) => /^(refactor)$/.test(l))) return 'refactor';
  if (labels.some((l) => /^(test|tests)$/.test(l))) return 'test';
  if (labels.some((l) => /^(spike|research|question)$/.test(l))) return 'spike';
  if (labels.some((l) => /^(feature|enhancement|feat)$/.test(l))) return 'feature';
  // No label that says otherwise: a chore is the least presumptuous default, since calling
  // something a feature implies somebody decided it should exist.
  return 'chore';
}

const MIN_DESCRIPTION = 40;

export function taskFromIssue(ctx, issue, { area = null } = {}) {
  const type = typeOf(issue);
  const id = allocateId(ctx, type);
  const title = String(issue.title).trim().slice(0, 120);
  const body = String(issue.body || '').trim();

  // The schema has a minimum description length, and an empty issue body is common. Padding
  // it with the issue's own provenance is honest; inventing a description is not.
  const description = [
    body || '_La incidencia no traía descripción._',
    '',
    `Importada de ${issue.url}. Sin refinar: hace falta decidir qué es «hecho» antes de pasarla a lista.`,
  ]
    .join('\n')
    .slice(0, 4000);

  return {
    $schema: '../../schema/task.schema.json',
    id,
    title: title.length >= 10 ? title : `${title} (importada de una incidencia)`,
    type,
    status: 'backlog',
    priority: 'medium',
    description: description.length >= MIN_DESCRIPTION ? description : `${description}\n\nSin más contexto que el de la incidencia original.`,
    acceptance_criteria: [
      {
        id: 'AC1',
        // Not a command: nobody has said how this is checked, and inventing a check turns a
        // criterion into a formality that always passes.
        must: '[SIN REFINAR] Decidir qué significa resolver esta incidencia y hacerlo.',
        check: { type: 'manual', run: null },
        status: 'pending',
      },
    ],
    context: { area, docs: [], files: [], out_of_scope: [] },
    depends_on: [],
    labels: ['importada'],
    assignee: null,
    claimed_at: null,
    branch: null,
    links: { pr: null, issue: issue.url, commits: [] },
    external: { github: { issue: issue.number, url: issue.url } },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/**
 * @returns {{created:Array, skipped:Array, error:string|null}}
 */
export function runImport(ctx, { limit = 200, state = 'open', repo = null, area = null, dryRun = false, max = 100 } = {}) {
  if (!hasGh(ctx)) {
    return { created: [], skipped: [], error: 'gh no está disponible: sin él no hay forma de leer las incidencias' };
  }
  const { issues, error } = fetchIssues(ctx, { limit, state, repo });
  if (error) return { created: [], skipped: [], error };

  const { take, skip } = classify(ctx, issues);
  const created = [];
  for (const issue of take.slice(0, max)) {
    const task = taskFromIssue(ctx, issue, { area });
    if (!dryRun) writeJson(taskFile(ctx, task.id), task);
    created.push({ id: task.id, type: task.type, issue: issue.number, title: task.title });
    // Written one at a time on purpose: `allocateId` counts the files on disk, so a batch
    // built before writing any of them would hand out the same id twice.
    if (!dryRun) load(ctx, task.id);
  }
  if (!dryRun && created.length) board.regenerate(ctx);
  return { created, skipped: skip, error: null, truncated: Math.max(0, take.length - created.length) };
}

export function printImportReport({ created, skipped, truncated }, { dryRun = false } = {}) {
  if (created.length === 0) say(c.gray('nada que importar'));
  else {
    ok(`${created.length} tarea(s) ${dryRun ? 'se importarían' : 'importadas'}, todas en backlog y sin refinar`);
    for (const t of created.slice(0, 20)) say(c.gray(`   ${t.id.padEnd(11)} #${String(t.issue).padEnd(5)} ${t.title}`));
    if (created.length > 20) say(c.gray(`   … y ${created.length - 20} más`));
  }
  if (truncated) warn(`${truncated} incidencia(s) no se importaron por el límite: sube --max si las quieres`);

  const reasons = new Map();
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) || 0) + 1);
  for (const [reason, count] of reasons) say(c.gray(`   ${count} omitida(s): ${reason}`));
}
