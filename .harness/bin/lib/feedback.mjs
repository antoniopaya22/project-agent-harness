// Was the grooming any good?
//
// The whole thesis of this harness is that a well-groomed task makes the read path short: four
// files and you know what to do. Nothing has ever confirmed that. It is a belief, and a belief
// with a lot of machinery built on top of it.
//
// So whoever implements a task records the files they had to read that the task did not name.
// One reading is noise. Twenty of them, grouped by area, point at the areas whose
// documentation is not doing its job — and that turns the thesis into something measurable
// and self-correcting.
//
// The distinction the report has to keep is the one that decides what to fix:
//
//   the same file, read from many different tasks in an area  →  the AREA DOCUMENT is missing
//                                                                something everyone needs
//   many scattered files, all from one task                   →  THAT TASK was under-groomed
//
// Conflating them sends somebody to rewrite a document when the real problem was one task
// nobody refined, or the reverse.

import fs from 'node:fs';
import path from 'node:path';
import { nowIso, toPosixPath } from './util.mjs';

export function logFile(ctx) {
  return path.join(ctx.harnessDir, 'backlog', 'read-log.jsonl');
}

/**
 * Records files that had to be read beyond the task's declared read path.
 * Append-only JSONL: concurrent agents in separate worktrees both write, and neither has to
 * read the file first.
 */
export function record(ctx, taskId, files, { area = null, note = null } = {}) {
  const rows = [];
  for (const file of files) {
    rows.push({
      task: taskId,
      area,
      file: toPosixPath(file),
      note,
      at: nowIso(),
    });
  }
  if (rows.length === 0) return [];
  const file = logFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return rows;
}

export function readLog(ctx) {
  const file = logFile(ctx);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A corrupt line is skipped rather than fatal: this is diagnostics, and losing the
      // whole history because one append was interrupted would be a poor trade.
    }
  }
  return rows;
}

/** Which files the task itself already pointed at — reading those is not a miss. */
export function declaredPath(ctx, task) {
  const declared = new Set();
  for (const f of task.context?.files || []) declared.add(toPosixPath(f));
  for (const d of task.context?.docs || []) declared.add(toPosixPath(d));
  const area = (ctx.project.areas || []).find((a) => a.id === task.context?.area);
  if (area?.doc) declared.add(toPosixPath(area.doc));
  for (const entry of ctx.project.read_path || []) {
    if (!String(entry.path).includes('{')) declared.add(toPosixPath(entry.path));
  }
  return declared;
}

/** Files read that the task did not name. The ones it did name are not evidence of anything. */
export function unexpected(ctx, task, files) {
  const declared = declaredPath(ctx, task);
  return files.map((f) => toPosixPath(f)).filter((f) => !declared.has(f));
}

/** Which area a path belongs to, so a reading can be attributed. */
export function areaOf(ctx, file) {
  const posix = toPosixPath(file);
  for (const area of ctx.project.areas || []) {
    for (const glob of area.globs || []) {
      const prefix = glob.replace(/\/\*\*$/, '');
      if (posix === prefix || posix.startsWith(`${prefix}/`)) return area.id;
    }
  }
  return null;
}

const MIN_TASKS_FOR_A_PATTERN = 3;

/**
 * @returns {{areas:Array, tasks:Array, total:number, taskCount:number, confident:boolean}}
 */
export function aggregate(ctx, { rows = null } = {}) {
  const log = rows || readLog(ctx);
  const byArea = new Map();
  const byTask = new Map();

  for (const row of log) {
    const area = row.area || areaOf(ctx, row.file) || '(sin área)';
    if (!byArea.has(area)) byArea.set(area, { area, files: new Map(), tasks: new Set(), total: 0 });
    const a = byArea.get(area);
    a.total += 1;
    a.tasks.add(row.task);
    a.files.set(row.file, (a.files.get(row.file) || 0) + 1);

    if (!byTask.has(row.task)) byTask.set(row.task, { task: row.task, files: new Set(), areas: new Set() });
    byTask.get(row.task).files.add(row.file);
    byTask.get(row.task).areas.add(area);
  }

  const areas = [...byArea.values()]
    .map((a) => {
      // The signal that means "the document is missing something": one file read from
      // several *different* tasks. Read ten times from one task, it is that task's problem.
      const repeated = [...a.files.entries()]
        .map(([file, count]) => ({ file, count }))
        .filter((f) => f.count >= MIN_TASKS_FOR_A_PATTERN)
        .sort((x, y) => y.count - x.count);
      return {
        area: a.area,
        readings: a.total,
        tasks: a.tasks.size,
        perTask: a.tasks.size ? Number((a.total / a.tasks.size).toFixed(1)) : 0,
        repeated,
        verdict: repeated.length > 0 ? 'documentacion-insuficiente' : 'sin-patron',
      };
    })
    .sort((x, y) => y.readings - x.readings);

  const tasks = [...byTask.values()]
    .map((t) => ({
      task: t.task,
      files: t.files.size,
      areas: [...t.areas],
      // A task that sent somebody across several areas was scoped wrong, not documented wrong.
      verdict: t.files.size >= 5 || t.areas.length >= 3 ? 'tarea-mal-refinada' : 'normal',
    }))
    .sort((x, y) => y.files - x.files);

  return {
    areas,
    tasks,
    total: log.length,
    taskCount: byTask.size,
    // Said out loud rather than left implicit: with three tasks logged, every number here is
    // an anecdote, and presenting an anecdote as a measurement is how this kind of report
    // starts driving bad decisions.
    confident: byTask.size >= 20,
  };
}

export function diagnose(report) {
  const findings = [];
  for (const area of report.areas) {
    if (area.verdict !== 'documentacion-insuficiente') continue;
    findings.push({
      kind: 'documentacion-insuficiente',
      subject: area.area,
      why: `${area.repeated.length} fichero(s) que se leen desde varias tareas distintas de esta área`,
      evidence: area.repeated.slice(0, 5).map((f) => `${f.file} (${f.count} tareas)`),
      action: `añade a docs/areas/${area.area}.md lo que esos ficheros están enseñando, y sella con \`harness doc verified ${area.area}\``,
    });
  }
  for (const task of report.tasks) {
    if (task.verdict !== 'tarea-mal-refinada') continue;
    findings.push({
      kind: 'tarea-mal-refinada',
      subject: task.task,
      why: `hubo que leer ${task.files} ficheros fuera de lo previsto, en ${task.areas.length} área(s)`,
      evidence: task.areas,
      action: `esta tarea entró sin refinar: pásala por \`/plan\` antes de una parecida, o pártela`,
    });
  }
  return findings;
}
