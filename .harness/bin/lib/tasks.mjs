// The task model: ids, the status machine and its guards, and disk I/O.
// Everything that can be enforced by a machine is enforced here rather than
// asked of an agent's goodwill.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, fail, listFiles, nowIso, readJson, writeJson } from './util.mjs';
import { validate } from './schema.mjs';

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
export function transitionProblems(ctx, task, to, { actorKind = 'human', allTasks = null } = {}) {
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

export function pickNext(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const candidates = tasks.filter(
    // Epics are containers, never work items: they complete when their children do.
    (t) => t.type !== 'epic' && t.status === 'ready' && !isBlockedByDeps(t, byId) && !t.assignee,
  );
  candidates.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 2;
    const pb = PRIORITY_RANK[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
  return candidates[0] || null;
}

export function priorityRank(p) {
  return PRIORITY_RANK[p] ?? 2;
}
