// The task model: ids, the status machine and its guards, and disk I/O.
// Everything that can be enforced by a machine is enforced here rather than
// asked of an agent's goodwill.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, fail, listFiles, nowIso, readJson, writeJson } from './util.mjs';
import { validate } from './schema.mjs';
import { runAllGates, summarize } from './gates.mjs';

/** type <-> id prefix. The prefix is frozen once a task leaves `backlog` (see §5.1). */
export const TYPE_PREFIX = {
  feature: 'FEAT',
  fix: 'FIX',
  chore: 'CHORE',
  docs: 'DOCS',
  refactor: 'RFCT',
  test: 'TEST',
  spike: 'SPIKE',
  epic: 'EPIC',
};
export const PREFIX_TYPE = Object.fromEntries(
  Object.entries(TYPE_PREFIX).map(([t, p]) => [p, t]),
);

/** Conventional-commit / branch type per task type. */
export const TYPE_GIT = {
  feature: 'feat',
  fix: 'fix',
  chore: 'chore',
  docs: 'docs',
  refactor: 'refactor',
  test: 'test',
  spike: 'spike',
  epic: 'chore',
};

export const STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

export const OPEN_STATUSES = ['backlog', 'ready', 'in_progress', 'in_review', 'blocked'];

/** Allowed transitions. Anything not listed is refused by set-status. */
export const TRANSITIONS = {
  backlog: ['ready', 'blocked', 'cancelled'],
  ready: ['in_progress', 'backlog', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'ready', 'blocked', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['backlog', 'ready', 'in_progress', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['backlog'],
};

/** Statuses only a human may set. Agents move tasks up to in_review and no further. */
export const HUMAN_ONLY = ['done', 'cancelled'];

export function tasksDir(ctx) {
  return path.join(ctx.harnessDir, 'backlog', 'tasks');
}

export function taskFile(ctx, id) {
  return path.join(tasksDir(ctx), `${id}.json`);
}

export function workspaceDir(ctx, id) {
  return path.join(ctx.harnessDir, 'workspace', id);
}

export function loadAll(ctx) {
  return listFiles(tasksDir(ctx), '.json').map((file) => {
    const task = readJson(file);
    Object.defineProperty(task, '__file', { value: file, enumerable: false });
    return task;
  });
}

export function load(ctx, id) {
  const file = taskFile(ctx, normalizeId(id));
  if (!fs.existsSync(file)) {
    fail(`task ${normalizeId(id)} not found (looked in ${path.relative(ctx.root, file)})`, EXIT.NOT_FOUND);
  }
  const task = readJson(file);
  Object.defineProperty(task, '__file', { value: file, enumerable: false });
  return task;
}

export function exists(ctx, id) {
  return fs.existsSync(taskFile(ctx, normalizeId(id)));
}

/** Writes with a stable key order so diffs stay readable and reviewable. */
export function save(ctx, task) {
  task.updated_at = nowIso();
  writeJson(taskFile(ctx, task.id), orderTask(task));
}

const KEY_ORDER = [
  '$schema', 'id', 'title', 'type', 'status', 'priority', 'size', 'parent',
  'description', 'acceptance_criteria', 'context', 'depends_on', 'blocked_reason',
  'resolution', 'labels', 'assignee', 'claimed_at', 'branch', 'estimate_hours',
  'links', 'external', 'created_at', 'updated_at',
];

export function orderTask(task) {
  const out = {};
  for (const k of KEY_ORDER) if (task[k] !== undefined) out[k] = task[k];
  for (const k of Object.keys(task)) if (out[k] === undefined && task[k] !== undefined) out[k] = task[k];
  return out;
}

export function normalizeId(id) {
  return String(id).trim().toUpperCase();
}

export function validateTask(ctx, task) {
  return validate(task, ctx.taskSchema);
}

/** Allocates the next free number for a type. No counter file: counters are merge poison. */
export function allocateId(ctx, type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) fail(`unknown task type "${type}" (expected ${Object.keys(TYPE_PREFIX).join('|')})`, EXIT.USAGE);
  const used = listFiles(tasksDir(ctx), '.json')
    .map((f) => path.basename(f, '.json'))
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => Number(id.slice(prefix.length + 1)))
    .filter((n) => Number.isInteger(n));
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

export function slugify(title, maxWords = 6) {
  return String(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-');
}

/** Branch grammar: `<git-type>/<number>-<slug>` — the type is NOT repeated (§7.2). */
export function branchFor(task) {
  const gitType = TYPE_GIT[task.type] || 'chore';
  const number = task.id.split('-')[1];
  return `${gitType}/${number}-${slugify(task.title)}`;
}

/** Inverse of branchFor: which task does this branch belong to? */
export function idFromBranch(ctx, branch) {
  const m = String(branch).match(/^([a-z]+)\/(\d{4})-/);
  if (!m) return null;
  const [, gitType, number] = m;
  const candidates = Object.entries(TYPE_GIT)
    .filter(([, g]) => g === gitType)
    .map(([type]) => `${TYPE_PREFIX[type]}-${number}`);
  return candidates.find((id) => exists(ctx, id)) || null;
}

export function newTask({ id, title, type, priority = 'medium', description, area = null }) {
  const at = nowIso();
  return orderTask({
    $schema: '../../schema/task.schema.json',
    id,
    title,
    type,
    status: 'backlog',
    priority,
    description: description || `${title}. (Sin refinar: falta descripción real y criterios de aceptación.)`,
    acceptance_criteria: [
      {
        id: 'AC1',
        must: 'Pendiente de refinar por el planner: sustituir por un criterio observable.',
        check: { type: 'manual', run: null },
        status: 'pending',
      },
    ],
    context: { area, docs: [], files: [], out_of_scope: [] },
    depends_on: [],
    labels: [],
    assignee: null,
    claimed_at: null,
    branch: null,
    links: { pr: null, issue: null, commits: [] },
    created_at: at,
    updated_at: at,
  });
}

export function worklogFile(ctx, id) {
  return path.join(ctx.harnessDir, 'backlog', 'worklog', `${id}.jsonl`);
}

/**
 * The history lives beside the task, not inside it.
 *
 * It used to be an array in the task file — which sits at step 2 of the cold-start read
 * path, so every implementation paid for twenty history entries that are useless for
 * implementing. Append-only JSONL also means concurrent writers never rewrite each
 * other's lines, unlike a JSON array.
 */
export function logEvent(ctx, id, by, event, note = null) {
  const file = worklogFile(ctx, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), by, event, note })}\n`, 'utf8');
}

/** @returns the last `limit` entries, oldest first */
export function readWorklog(ctx, id, limit = 10) {
  const file = worklogFile(ctx, id);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * The guards behind each status. Returns the list of unmet requirements;
 * empty means the transition is allowed.
 */
export function transitionProblems(ctx, task, to, { actorKind = 'human', allTasks = null, skipGates = false } = {}) {
  const problems = [];
  const from = task.status;

  if (!STATUSES.includes(to)) {
    problems.push(`"${to}" is not a status (${STATUSES.join(', ')})`);
    return problems;
  }
  if (from === to) {
    problems.push(`already ${to}`);
    return problems;
  }
  if (!(TRANSITIONS[from] || []).includes(to)) {
    problems.push(`transition ${from} -> ${to} is not allowed (from ${from} you may go to: ${(TRANSITIONS[from] || []).join(', ') || 'nowhere'})`);
    return problems;
  }
  if (HUMAN_ONLY.includes(to) && actorKind !== 'human') {
    problems.push(`only a human may set status ${to} — agents stop at in_review`);
  }

  const tasks = allTasks || loadAll(ctx);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  if (to === 'ready') {
    const withCheck = (task.acceptance_criteria || []).filter((ac) => ac.check && ac.check.type);
    if (withCheck.length === 0) {
      problems.push('needs at least one acceptance criterion with a check');
    }
    for (const ac of task.acceptance_criteria || []) {
      if (ac.check?.type === 'command' && !ac.check.run) {
        problems.push(`${ac.id}: check.type is "command" but check.run is empty`);
      }
      if (/pendiente de refinar|to be refined|TBD/i.test(ac.must)) {
        problems.push(`${ac.id}: still a placeholder criterion`);
      }
    }
    // An epic spans areas by nature and is never implemented directly, so it has no read
    // path and needs no area. Every other type does.
    if (task.type !== 'epic' && !task.context?.area) problems.push('context.area is not set');
    // Only existence is checked here. `ready` means *refined*, not *unblocked* — conflating
    // the two would forbid grooming the backlog ahead of time, which is what a backlog is for.
    // Being blocked by dependencies is enforced at `in_progress` and surfaced by `next`.
    for (const dep of task.depends_on || []) {
      if (!byId.has(dep)) problems.push(`depends_on ${dep} does not exist`);
    }
  }

  if (to === 'in_progress') {
    for (const dep of task.depends_on || []) {
      const d = byId.get(dep);
      if (d && d.status !== 'done') problems.push(`blocked by ${dep} (${d.status})`);
    }
  }

  if (to === 'blocked' && !task.blocked_reason) {
    problems.push('blocked_reason must be set (use --reason)');
  }

  if (to === 'in_review') {
    const unresolved = (task.acceptance_criteria || []).filter((ac) => ac.status === 'pending');
    if (unresolved.length > 0) {
      problems.push(`${unresolved.length} acceptance criteria still pending: ${unresolved.map((a) => a.id).join(', ')}`);
    }
    const failed = (task.acceptance_criteria || []).filter((ac) => ac.status === 'fail');
    if (failed.length > 0) {
      problems.push(`${failed.length} acceptance criteria failing: ${failed.map((a) => a.id).join(', ')}`);
    }
    // ENTRYPOINT.md has always said `in_review` requires the required gates green, and
    // nothing enforced it: running the choreography by hand closed a task with a red test
    // suite. A documented entry condition that no code checks is not a condition.
    // Affordable because the gate cache makes an unchanged tree nearly free.
    if (!skipGates) {
      const red = summarize(runAllGates(ctx, { capture: true })).requiredFailed;
      for (const gate of red) problems.push(`required gate "${gate.name}" is red (exit ${gate.code})`);
    }
  }

  if (to === 'cancelled' && !task.resolution) {
    problems.push('resolution must be set (use --reason)');
  }

  return problems;
}

/** True when the task's dependencies are all done. */
export function isBlockedByDeps(task, byId) {
  return (task.depends_on || []).some((d) => (byId.get(d)?.status ?? 'missing') !== 'done');
}

/**
 * "What should I work on next?" — answered from the index in one read.
 * Ready, unblocked, unclaimed, highest priority, then lowest id for stable ordering.
 */
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * How many open tasks each task is holding up, counted transitively.
 *
 * This is the critical path. Sorting only by priority means an isolated task can outrank one
 * that five others are waiting on, which is how a queue looks busy while nothing gets
 * unblocked.
 */
export function unblockCounts(tasks) {
  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      if (dependents.has(dep)) dependents.get(dep).push(t.id);
    }
  }
  const open = new Set(tasks.filter((t) => OPEN_STATUSES.includes(t.status)).map((t) => t.id));
  const counts = new Map();

  const walk = (id, seen) => {
    let total = 0;
    for (const child of dependents.get(id) || []) {
      if (seen.has(child)) continue; // a cycle is a lint error; here it must simply terminate
      seen.add(child);
      if (open.has(child)) total += 1;
      total += walk(child, seen);
    }
    return total;
  };

  for (const t of tasks) counts.set(t.id, walk(t.id, new Set([t.id])));
  return counts;
}

export function workable(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Epics are containers, never work items: they complete when their children do.
  return tasks.filter(
    (t) => t.type !== 'epic' && t.status === 'ready' && !isBlockedByDeps(t, byId) && !t.assignee,
  );
}

/**
 * The queue, best first. Declared priority still dominates — a critical task stays first
 * even if it unblocks nothing — and how much a task unblocks breaks the tie.
 */
export function rankNext(tasks) {
  const unblocks = unblockCounts(tasks);
  return workable(tasks).sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 2;
    const pb = PRIORITY_RANK[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    const ua = unblocks.get(a.id) ?? 0;
    const ub = unblocks.get(b.id) ?? 0;
    if (ua !== ub) return ub - ua;
    return a.id.localeCompare(b.id);
  });
}

export function pickNext(tasks) {
  return rankNext(tasks)[0] || null;
}

/**
 * Two tasks are not safely parallel when they would edit the same things: overlapping
 * `context.files`, or the same area. Both are ready and unblocked, so nothing else stops an
 * agent taking them at once — and finding out at merge time is the expensive way.
 */
export function conflictsWith(a, b) {
  const filesA = (a.context?.files || []).map(String);
  const filesB = (b.context?.files || []).map(String);
  const shared = filesB.filter((f) => filesA.includes(f));
  if (shared.length) return [`same files: ${shared.join(', ')}`];

  // When both tasks name their files and the sets are disjoint, that finer signal wins over
  // the area. Otherwise a project where one area dominates — as this one does — would report
  // that nothing is ever parallel, which is true but useless.
  if (filesA.length > 0 && filesB.length > 0) return [];

  if (a.context?.area && a.context.area === b.context?.area) {
    return [`same area (${a.context.area}) and at least one of them does not say which files`];
  }
  return [];
}

/**
 * A queue of tasks that can genuinely be worked at the same time, plus the ones that were
 * set aside and why.
 */
export function pickParallel(tasks, count = 3) {
  const ranked = rankNext(tasks);
  const chosen = [];
  const deferred = [];
  for (const task of ranked) {
    if (chosen.length >= count) break;
    const clash = chosen.map((c) => ({ id: c.id, reasons: conflictsWith(c, task) })).find((x) => x.reasons.length);
    if (clash) deferred.push({ task, against: clash.id, reasons: clash.reasons });
    else chosen.push(task);
  }
  return { chosen, deferred };
}

export function priorityRank(p) {
  return PRIORITY_RANK[p] ?? 2;
}

/**
 * How long a task has been in its current status, from the worklog.
 *
 * Not from `updated_at`, which moves on any edit — a task nobody has advanced in nine days
 * would look fresh because somebody fixed a typo in it. For a reader outside the project,
 * "in progress for nine days" is worth more than "in progress".
 */
export function timeInStatus(ctx, task) {
  const events = readWorklog(ctx, task.id, 200);
  const marker = `-> ${task.status}`;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const isChange = typeof e.note === 'string' && e.note.includes(marker);
    const isClaim = task.status === 'in_progress' && e.event === 'claimed';
    if (isChange || isClaim) return { since: e.at, days: daysSince(e.at) };
  }
  return { since: task.created_at ?? null, days: task.created_at ? daysSince(task.created_at) : null };
}

function daysSince(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}
