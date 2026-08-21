// Does the harness pay for itself?
//
// The whole thesis is that this machinery saves context and makes the work better. There is not
// one number behind that. Twenty tasks of duration and consumption would answer it — and might
// answer no, which is the point of measuring instead of asserting.
//
// Two halves, and the split is deliberate:
//
//   **Duration is derived.** Every status transition is already stamped in the worklog, so the
//   time a task spent in each stage costs nothing extra to know. Asking anybody to record it by
//   hand would be asking for a number that is either wrong or missing.
//
//   **Consumption is declared.** Nothing in this repository can observe how many tokens a model
//   spent. Deriving it from file sizes or diff lines would produce a confident number with no
//   relationship to the thing being measured, which is worse than an empty column.

import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readJson, toPosixPath } from './util.mjs';
import { loadAll, readWorklog } from './tasks.mjs';

export function metricsFile(ctx) {
  return path.join(ctx.harnessDir, 'backlog', 'metrics.jsonl');
}

/** The stages a task passes through, in order, as the worklog records them. */
export const STAGES = ['grooming', 'implementation', 'review'];

/**
 * When each status was entered, from the worklog.
 * `claimed` counts as entering `in_progress`: `task claim` logs that rather than a transition,
 * and treating it as a different thing would lose the start of every implementation.
 */
const STATUS_WORDS = ['backlog', 'ready', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];

export function transitions(ctx, taskId) {
  const events = readWorklog(ctx, taskId, 500);
  const out = [];
  for (const e of events) {
    if (e.event === 'claimed') {
      out.push({ at: e.at, status: 'in_progress' });
      continue;
    }
    // `done` is logged as `completed`, everything else as `status_changed`. Reading only one of
    // the two loses the end of every task, which is the measurement that matters most.
    if (e.event !== 'status_changed' && e.event !== 'completed') continue;
    const note = typeof e.note === 'string' ? e.note : '';

    const canonical = note.match(/^([a-z_]+)\s*->\s*([a-z_]+)/);
    if (canonical && STATUS_WORDS.includes(canonical[2])) {
      out.push({ at: e.at, status: canonical[2] });
      continue;
    }
    // A short-lived earlier format wrote just the destination, so rows already on disk look
    // like `in_review (finish)`. Read rather than discarded: throwing away real history to keep
    // a parser tidy is the wrong trade. Nothing writes this shape any more — see `statusNote`.
    const legacy = note.match(/^([a-z_]+)\s*\(/);
    if (legacy && STATUS_WORDS.includes(legacy[1])) out.push({ at: e.at, status: legacy[1] });
  }
  return out;
}

function seconds(fromIso, toIso) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

/**
 * How long a task spent in each stage.
 *
 * A stage that never opened is absent rather than zero. Zero says "it took no time", which is a
 * claim; absent says "this did not happen", which is the truth and is what a mean has to skip.
 *
 * **What this actually measures is when statuses were flipped**, which is only the same as when
 * the work happened if the status was moved as the work happened. It often is not: doing the
 * work first and then walking the task through the machine produces an implementation time of
 * seconds. That is a real measurement of a real process, and it is not a measurement of effort —
 * the report says so rather than letting the number speak for itself.
 */
export function durations(ctx, task) {
  const events = transitions(ctx, task.id);
  const first = (status) => events.find((e) => e.status === status)?.at ?? null;

  const created = task.created_at ?? null;
  const ready = first('ready');
  const started = first('in_progress');
  const review = first('in_review');
  const done = first('done');

  const out = {};
  if (created && (ready || started)) out.grooming = seconds(created, ready || started);
  if (started && review) out.implementation = seconds(started, review);
  if (review && done) out.review = seconds(review, done);
  if (created && done) out.total = seconds(created, done);
  return out;
}

/**
 * Records consumption for a task, optionally per stage.
 * Append-only: two agents in two worktrees both write, and neither reads first.
 */
export function record(ctx, taskId, { stage = null, tokens = null, seconds: secs = null, model = null, note = null } = {}) {
  const row = { task: taskId, stage, tokens, seconds: secs, model, note, at: nowIso() };
  const file = metricsFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export function readMetrics(ctx) {
  const file = metricsFile(ctx);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Diagnostics: losing the whole history because one append was interrupted would be a
      // poor trade for strictness.
    }
  }
  return rows;
}

const MIN_SAMPLE = 20;

function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = clean.reduce((t, v) => t + v, 0);
  return {
    n: clean.length,
    total: sum,
    mean: Math.round(sum / clean.length),
    // The median is reported alongside the mean because one three-day task drags a mean of five
    // somewhere meaningless, and a single number would hide that.
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

/**
 * @returns {{rows:Array, byArea:Array, byType:Array, sample:number, confident:boolean}}
 */
export function report(ctx, { tasks = null } = {}) {
  const all = (tasks || loadAll(ctx)).filter((t) => t.type !== 'epic');
  const consumption = new Map();
  for (const row of readMetrics(ctx)) {
    if (!consumption.has(row.task)) consumption.set(row.task, { tokens: 0, seconds: 0, rows: 0 });
    const c = consumption.get(row.task);
    if (typeof row.tokens === 'number') c.tokens += row.tokens;
    if (typeof row.seconds === 'number') c.seconds += row.seconds;
    c.rows += 1;
  }

  const rows = all
    .map((task) => {
      const d = durations(ctx, task);
      const c = consumption.get(task.id) || null;
      return {
        id: task.id,
        type: task.type,
        size: task.size ?? null,
        area: task.context?.area ?? null,
        status: task.status,
        ...d,
        tokens: c?.tokens ?? null,
        measured: c !== null,
      };
    })
    .filter((r) => r.total != null || r.measured);

  const group = (key) => {
    const buckets = new Map();
    for (const r of rows) {
      const k = r[key] ?? '(sin declarar)';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    return [...buckets.entries()]
      .map(([name, list]) => ({
        name,
        tasks: list.length,
        total: stats(list.map((r) => r.total)),
        implementation: stats(list.map((r) => r.implementation)),
        tokens: stats(list.map((r) => r.tokens)),
      }))
      .sort((a, b) => b.tasks - a.tasks);
  };

  return {
    rows,
    byArea: group('area'),
    byType: group('type'),
    sample: rows.length,
    // Said out loud, because the failure mode of a metrics report is being believed too early.
    // Five tasks cannot compare two areas, however tidy the table looks.
    confident: rows.length >= MIN_SAMPLE,
    // What is missing is part of the answer: a column of nulls means nobody recorded, not zero.
    unmeasured: rows.filter((r) => !r.measured).length,
  };
}

export function humanDuration(secs) {
  if (secs == null) return '—';
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  if (secs < 172800) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

/** Where the metrics file lives, relative, for a report to name. */
export function metricsPath(ctx) {
  return toPosixPath(path.relative(ctx.root, metricsFile(ctx)));
}

/** The declared config, so a project can say what it is willing to record. */
export function config(ctx) {
  try {
    return readJson(path.join(ctx.harnessDir, 'project.json')).metrics || {};
  } catch {
    return {};
  }
}
