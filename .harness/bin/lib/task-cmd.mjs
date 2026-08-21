// `harness task <sub>` — every backlog mutation, each one validated. Agents change the
// backlog through these commands and never by hand-editing JSON, which is how a schema
// survives contact with a language model.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { EXIT, bad, c, fail, info, matchesAny, ok, rejectUnknownFlags, say, table, toPosixPath } from './util.mjs';
import * as tasksLib from './tasks.mjs';
import * as board from './board.mjs';
import { actor } from './actor.mjs';
import * as git from './git.mjs';
import { writeHandoff } from './workspace.mjs';

const taskSubs = {};



/**
 * Does this task have anything to do with that path?
 *
 * Two ways to be relevant, and both matter: the path is named in `context.files`, or it
 * falls inside the globs of the task's area. Impact analysis before a change, and a cheap
 * way to see whether two tasks are about to fight over the same files.
 */
export function touchesPath(ctx, task, target) {
  const wanted = toPosixPath(target).replace(/\/+$/, '');
  for (const file of task.context?.files || []) {
    const f = toPosixPath(file);
    // Exact match, or the task names a directory that contains the path (or vice versa).
    // Compared segment-wise so `src/api` never matches `src/apiary`.
    if (f === wanted || f.startsWith(`${wanted}/`) || wanted.startsWith(`${f}/`)) return true;
  }
  const area = (ctx.project.areas || []).find((a) => a.id === task.context?.area);
  if (area && matchesAny(wanted, area.globs)) return true;
  return false;
}

taskSubs.list = (ctx, { flags }) => {
  let tasks = tasksLib.loadAll(ctx);
  if (flags.status) tasks = tasks.filter((t) => t.status === flags.status);
  if (flags.area) tasks = tasks.filter((t) => t.context?.area === flags.area);
  if (flags.type) tasks = tasks.filter((t) => t.type === flags.type);
  if (flags.open) tasks = tasks.filter((t) => tasksLib.OPEN_STATUSES.includes(t.status));
  if (typeof flags.touching === 'string') {
    tasks = tasks.filter((t) => touchesPath(ctx, t, flags.touching));
  }
  tasks.sort((a, b) => tasksLib.priorityRank(a.priority) - tasksLib.priorityRank(b.priority) || a.id.localeCompare(b.id));
  if (flags.json) {
    say(JSON.stringify(tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })), null, 2));
    return EXIT.OK;
  }
  if (tasks.length === 0) {
    info('no tasks match');
    return EXIT.OK;
  }
  say(table(tasks.map((t) => [t.id, t.status, t.priority ?? '—', t.context?.area ?? '—', t.title]), ['ID', 'ESTADO', 'PRIO', 'ÁREA', 'TÍTULO']));
  return EXIT.OK;
};

taskSubs.show = (ctx, { positional, flags }) => {
  const task = tasksLib.load(ctx, requireId(positional[0]));
  if (flags.json) {
    say(JSON.stringify(task, null, 2));
    return EXIT.OK;
  }
  say(`${c.bold(task.id)}  ${task.title}`);
  say(c.gray(`${task.type} · ${task.status} · ${task.priority ?? 'medium'}${task.size ? ` · ${task.size}` : ''}${task.context?.area ? ` · área ${task.context.area}` : ''}`));
  say('');
  say(task.description);
  say('');
  say(c.bold('Criterios de aceptación'));
  for (const ac of task.acceptance_criteria || []) {
    const mark = { pass: c.green('PASS'), fail: c.red('FAIL'), pending: c.gray('----'), unverifiable: c.yellow('N/V') }[ac.status] || '?';
    say(`  ${mark} ${c.bold(ac.id)} ${ac.must}`);
    if (ac.check?.type === 'command') say(c.gray(`         $ ${ac.check.run}`));
    else say(c.gray(`         check: ${ac.check?.type}`));
    if (ac.evidence) say(c.gray(`         ${ac.evidence}`));
  }
  if (task.depends_on?.length) {
    say('');
    say(`${c.bold('Depende de')} ${task.depends_on.join(', ')}`);
  }
  if (task.blocked_reason) {
    say('');
    say(`${c.yellow('Bloqueada')}: ${task.blocked_reason}`);
  }
  const history = tasksLib.readWorklog(ctx, task.id, flags.history ? 50 : 5);
  if (history.length) {
    say('');
    say(c.bold('Historial') + c.gray(flags.history ? '' : '  (últimas entradas; --history para más)'));
    for (const e of history) {
      say(c.gray(`  ${e.at}  ${String(e.by).padEnd(12)} ${e.event}${e.note ? `  ${e.note}` : ''}`));
    }
  }
  return EXIT.OK;
};

taskSubs.next = (ctx, { flags }) => {
  const all = tasksLib.loadAll(ctx);
  const count = flags.count ? Number(flags.count) : 1;
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive integer', EXIT.USAGE);

  // Asking for more than one is asking "what can I run at the same time", which is not the
  // same as "the top N": two ready tasks over the same files are not parallel work.
  if (count > 1 || flags.parallel) {
    const { chosen, deferred } = tasksLib.pickParallel(all, flags.parallel ? Number(flags.parallel) || count : count);
    if (flags.json) {
      say(JSON.stringify({
        chosen: chosen.map((t2) => ({ id: t2.id, title: t2.title })),
        deferred: deferred.map((d) => ({ id: d.task.id, against: d.against, reasons: d.reasons })),
      }, null, 2));
      return EXIT.OK;
    }
    if (chosen.length === 0) {
      info('no ready, unblocked, unclaimed task');
      return EXIT.OK;
    }
    const unblocks = tasksLib.unblockCounts(all);
    say(table(chosen.map((t2) => [t2.id, t2.priority ?? '—', `desbloquea ${unblocks.get(t2.id) ?? 0}`, t2.title]), ['ID', 'PRIO', 'IMPACTO', 'TÍTULO']));
    for (const d of deferred) {
      say(c.gray(`   aparte: ${d.task.id} choca con ${d.against} (${d.reasons.join('; ')})`));
    }
    return EXIT.OK;
  }

  const next = tasksLib.pickNext(all);
  if (!next) {
    if (flags.json) say('null');
    else info('no ready, unblocked, unclaimed task');
    return EXIT.OK;
  }
  const unblocks = tasksLib.unblockCounts(all).get(next.id) ?? 0;
  if (flags.json) say(JSON.stringify({ id: next.id, title: next.title, unblocks }, null, 2));
  else say(`${next.id}  ${next.title}${unblocks ? c.gray(`  (desbloquea ${unblocks})`) : ''}`);
  return EXIT.OK;
};

taskSubs.new = (ctx, { flags }) => {
  const type = String(flags.type || 'feature');
  const title = flags.title;
  if (!title || title === true) fail('usage: harness task new --type <type> --title "..." [--priority high] [--area api]', EXIT.USAGE);
  const id = tasksLib.allocateId(ctx, type);
  const task = tasksLib.newTask({
    id,
    title: String(title),
    type,
    priority: flags.priority ? String(flags.priority) : 'medium',
    description: typeof flags.description === 'string' ? flags.description : null,
    area: typeof flags.area === 'string' ? flags.area : null,
  });
  if (flags.parent) task.parent = tasksLib.normalizeId(flags.parent);
  if (flags.size) task.size = String(flags.size);
  tasksLib.save(ctx, task);
  tasksLib.logEvent(ctx, id, actor(ctx, flags).id, 'created', null);
  board.regenerate(ctx);
  ok(`created ${id} (${task.status})`);
  info(`refine it with /plan ${id} — it cannot become ready until it has real acceptance criteria`);
  return EXIT.OK;
};

taskSubs.claim = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  if (task.type === 'epic') {
    bad(`${task.id} is an epic: it is a container, not work. Claim one of its children instead.`);
    return EXIT.PRECONDITION;
  }
  const branch = task.branch || tasksLib.branchFor(task);
  task.assignee = { kind: who.kind, id: who.id };
  task.claimed_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  task.branch = branch;
  const problems = tasksLib.transitionProblems(ctx, task, 'in_progress', { actorKind: who.kind });

  // Claiming used to be advisory: two agents in two worktrees could both take the same
  // task and only find out at merge time. A branch already on the remote is the one signal
  // that somebody else really started, and it costs one network call to check.
  if (!flags.force && git.hasRemote(ctx)) {
    const remote = git.git(ctx, ['ls-remote', '--heads', 'origin', branch], { allowFail: true });
    if (remote.code === 0 && remote.out.trim()) {
      problems.push(
        `branch ${branch} already exists on the remote, so somebody has this task. ` +
          'Coordinate, or pass --force if you know it is stale.',
      );
    }
  }

  if (problems.length) {
    for (const p of problems) bad(p);
    return EXIT.PRECONDITION;
  }
  task.status = 'in_progress';
  tasksLib.logEvent(ctx, task.id, who.id, 'claimed', `branch ${branch}`);
  tasksLib.save(ctx, task);
  board.regenerate(ctx);
  ok(`${task.id} claimed by ${who.kind}:${who.id}`);

  // Claiming used to print the branch and the handoff as homework for the agent. Running
  // the choreography by hand showed the obvious failure: forget either one and the task is
  // in_progress pointing at a branch that does not exist, which nothing detects.
  if (flags['no-branch']) {
    info(`branch not created: ${branch}  (git switch -c ${branch})`);
  } else if (git.isRepo(ctx)) {
    if (git.branchExists(ctx, branch)) {
      git.git(ctx, ['switch', branch]);
      info(`switched to ${branch}`);
    } else {
      git.git(ctx, ['switch', '-c', branch]);
      ok(`created and switched to ${branch}`);
    }
  }

  writeHandoff(ctx, task.id, {
    stage: 'claimed',
    by: who.id,
    branch,
    summary: `Tarea reclamada por ${who.kind}:${who.id}. Rama ${branch}. Nada implementado todavía.`,
    next: 'planner',
  });
  return EXIT.OK;
};

taskSubs.unclaim = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  task.assignee = null;
  task.claimed_at = null;
  task.status = 'ready';
  tasksLib.logEvent(ctx, task.id, who.id, 'status_changed', 'unclaimed');
  tasksLib.save(ctx, task);
  board.regenerate(ctx);
  ok(`${task.id} back to ready`);
  return EXIT.OK;
};

taskSubs['set-status'] = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const to = positional[1];
  if (!to) fail(`usage: harness task set-status <ID> <${tasksLib.STATUSES.join('|')}> [--reason "..."]`, EXIT.USAGE);
  if (to === 'blocked' && typeof flags.reason === 'string') task.blocked_reason = flags.reason;
  if (to === 'cancelled' && typeof flags.reason === 'string') task.resolution = flags.reason;
  const problems = tasksLib.transitionProblems(ctx, task, to, { actorKind: who.kind });
  if (problems.length) {
    bad(`cannot move ${task.id} from ${task.status} to ${to}:`);
    for (const p of problems) say(`   - ${p}`);
    return EXIT.PRECONDITION;
  }
  const from = task.status;
  task.status = to;
  if (to !== 'blocked') task.blocked_reason = null;
  tasksLib.logStatusChange(ctx, task, from, to, who.id);
  tasksLib.save(ctx, task);
  board.regenerate(ctx);
  ok(`${task.id}: ${from} -> ${to}`);
  return EXIT.OK;
};

taskSubs.ac = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const acId = (positional[1] || '').toUpperCase();
  const status = positional[2];
  const allowed = ['pending', 'pass', 'fail', 'unverifiable'];
  const usage = `usage: harness task ac <ID> <AC1> <${allowed.join('|')}> [--evidence "..."]`;
  if (!acId || !allowed.includes(status)) fail(usage, EXIT.USAGE);
  rejectUnknownFlags(flags, ['evidence'], usage);
  const ac = (task.acceptance_criteria || []).find((x) => x.id === acId);
  if (!ac) fail(`${task.id} has no criterion ${acId}`, EXIT.NOT_FOUND);
  if (status === 'pass' && ac.baseline === 'pass' && !flags.force) {
    bad(
      `${acId} already passed before the change (baseline: pass), so a pass now proves nothing.
` +
        '   Fix the check or regroom the criterion. Use --force only if you can say why this is legitimate.',
    );
    return EXIT.CHECK_FAILED;
  }
  ac.status = status;
  if (typeof flags.evidence === 'string') ac.evidence = flags.evidence;
  tasksLib.logEvent(ctx, task.id, who.id, 'verified', `${acId} -> ${status}`);
  tasksLib.save(ctx, task);
  ok(`${task.id} ${acId}: ${status}`);
  return EXIT.OK;
};

// The planner edits criteria through these rather than by hand-editing JSON: free-form
// edits by a model are exactly how a schema rots.
taskSubs['ac-set'] = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const acId = (positional[1] || '').toUpperCase();
  if (!/^AC\d+$/.test(acId)) fail('usage: harness task ac-set <ID> <AC1> --must "..." [--check command|review|manual] [--run "..."]', EXIT.USAGE);
  const must = typeof flags.must === 'string' ? flags.must : null;
  const checkType = typeof flags.check === 'string' ? flags.check : null;
  if (checkType && !['command', 'review', 'manual'].includes(checkType)) {
    fail('--check must be one of: command, review, manual', EXIT.USAGE);
  }
  task.acceptance_criteria = task.acceptance_criteria || [];
  let ac = task.acceptance_criteria.find((x) => x.id === acId);
  if (!ac) {
    if (!must) fail(`${acId} does not exist yet: pass --must to create it`, EXIT.USAGE);
    ac = { id: acId, must, check: { type: 'manual', run: null }, status: 'pending' };
    task.acceptance_criteria.push(ac);
  }
  if (must) ac.must = must;
  if (checkType) ac.check = { type: checkType, run: checkType === 'command' ? ac.check?.run ?? null : null };
  if (typeof flags.run === 'string') {
    ac.check = { type: checkType || 'command', run: flags.run };
  }
  if (ac.check.type === 'command' && !ac.check.run) fail(`${acId}: a "command" check needs --run`, EXIT.USAGE);
  task.acceptance_criteria.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  const problems = tasksLib.validateTask(ctx, tasksLib.orderTask(task));
  if (problems.length) {
    for (const p of problems) bad(`${p.path || '(root)'}: ${p.message}`);
    return EXIT.CHECK_FAILED;
  }
  tasksLib.logEvent(ctx, task.id, who.id, 'groomed', `${acId} set`);
  tasksLib.save(ctx, task);
  ok(`${task.id} ${acId}: ${ac.must} [${ac.check.type}]`);
  return EXIT.OK;
};

taskSubs['ac-rm'] = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const acId = (positional[1] || '').toUpperCase();
  const before = (task.acceptance_criteria || []).length;
  task.acceptance_criteria = (task.acceptance_criteria || []).filter((x) => x.id !== acId);
  if (task.acceptance_criteria.length === before) fail(`${task.id} has no criterion ${acId}`, EXIT.NOT_FOUND);
  if (task.acceptance_criteria.length === 0) fail('a task must keep at least one acceptance criterion', EXIT.PRECONDITION);
  tasksLib.logEvent(ctx, task.id, who.id, 'groomed', `${acId} removed`);
  tasksLib.save(ctx, task);
  ok(`${task.id}: removed ${acId}`);
  return EXIT.OK;
};

taskSubs.describe = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const text = typeof flags.text === 'string' ? flags.text : positional.slice(1).join(' ');
  if (!text) fail('usage: harness task describe <ID> --text "..."', EXIT.USAGE);
  task.description = text;
  tasksLib.logEvent(ctx, task.id, who.id, 'groomed', 'description rewritten');
  tasksLib.save(ctx, task);
  ok(`${task.id}: description updated (${text.length} chars)`);
  return EXIT.OK;
};

taskSubs.context = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  task.context = task.context || { area: null, docs: [], files: [], out_of_scope: [] };
  const changes = [];
  if (typeof flags.area === 'string') {
    const known = (ctx.project.areas || []).map((a) => a.id);
    if (!known.includes(flags.area)) fail(`unknown area "${flags.area}" (declared: ${known.join(', ') || 'none'})`, EXIT.USAGE);
    task.context.area = flags.area;
    changes.push(`area=${flags.area}`);
  }
  if (flags['clear-docs']) { task.context.docs = []; changes.push('docs cleared'); }
  if (flags['clear-files']) { task.context.files = []; changes.push('files cleared'); }
  for (const doc of [].concat(flags.doc || []).filter((d) => typeof d === 'string')) {
    task.context.docs = [...new Set([...(task.context.docs || []), doc])];
    changes.push(`doc+${doc}`);
  }
  for (const f of [].concat(flags.file || []).filter((d) => typeof d === 'string')) {
    task.context.files = [...new Set([...(task.context.files || []), f])];
    changes.push(`file+${f}`);
  }
  for (const o of [].concat(flags['out-of-scope'] || []).filter((d) => typeof d === 'string')) {
    task.context.out_of_scope = [...new Set([...(task.context.out_of_scope || []), o])];
    changes.push('out_of_scope+');
  }
  if (changes.length === 0) fail('usage: harness task context <ID> [--area a] [--doc path] [--file path] [--out-of-scope "..."]', EXIT.USAGE);
  tasksLib.logEvent(ctx, task.id, who.id, 'groomed', changes.join(' '));
  tasksLib.save(ctx, task);
  board.regenerate(ctx);
  ok(`${task.id} context: ${changes.join(', ')}`);
  return EXIT.OK;
};

taskSubs.retype = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const type = positional[1];
  if (!tasksLib.TYPE_PREFIX[type]) fail(`usage: harness task retype <ID> <${Object.keys(tasksLib.TYPE_PREFIX).join('|')}>`, EXIT.USAGE);
  if (task.status !== 'backlog') {
    fail(
      `${task.id} is ${task.status}: its id is frozen (§5.1). Change the \`type\` field only — ` +
        'the id keeps its original prefix and doctor reports the divergence as informational.',
      EXIT.PRECONDITION,
    );
  }
  const oldId = task.id;
  const newId = tasksLib.allocateId(ctx, type);
  task.id = newId;
  task.type = type;
  tasksLib.logEvent(ctx, task.id, who.id, 'retyped', `${oldId} -> ${newId}`);
  tasksLib.save(ctx, task);
  fs.rmSync(tasksLib.taskFile(ctx, oldId), { force: true });
  board.regenerate(ctx);
  ok(`${oldId} -> ${newId} (${type})`);
  return EXIT.OK;
};

taskSubs.split = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const parentTask = tasksLib.load(ctx, requireId(positional[0]));
  const titles = [].concat(flags.into || []).filter((t) => typeof t === 'string');
  const extra = positional.slice(1);
  const allTitles = [...titles, ...extra];
  if (allTitles.length < 2) {
    fail('usage: harness task split <ID> "primera parte" "segunda parte" [...]', EXIT.USAGE);
  }
  let epicId = parentTask.id;
  if (parentTask.type !== 'epic') {
    if (parentTask.status !== 'backlog' && parentTask.status !== 'ready') {
      fail(`${parentTask.id} is ${parentTask.status}: split it before work starts, or create a new epic by hand`, EXIT.PRECONDITION);
    }
    epicId = tasksLib.allocateId(ctx, 'epic');
    const epic = tasksLib.newTask({
      id: epicId,
      title: parentTask.title,
      type: 'epic',
      priority: parentTask.priority,
      description: parentTask.description,
      area: parentTask.context?.area ?? null,
    });
    epic.acceptance_criteria = [
      { id: 'AC1', must: 'Todas las tareas hijas están en done.', check: { type: 'review', run: null }, status: 'pending' },
    ];
    tasksLib.logEvent(ctx, epic.id, who.id, 'split', `from ${parentTask.id}`);
    tasksLib.save(ctx, epic);
    parentTask.resolution = `Dividida en el epic ${epicId}`;
    parentTask.status = 'cancelled';
    tasksLib.logEvent(ctx, parentTask.id, who.id, 'split', `-> ${epicId}`);
    tasksLib.save(ctx, parentTask);
  }
  const created = [];
  for (const title of allTitles) {
    const id = tasksLib.allocateId(ctx, parentTask.type === 'epic' ? 'feature' : parentTask.type);
    const child = tasksLib.newTask({
      id,
      title,
      type: parentTask.type === 'epic' ? 'feature' : parentTask.type,
      priority: parentTask.priority,
      area: parentTask.context?.area ?? null,
    });
    child.parent = epicId;
    tasksLib.logEvent(ctx, child.id, who.id, 'split', `child of ${epicId}`);
    tasksLib.save(ctx, child);
    created.push(id);
  }
  board.regenerate(ctx);
  ok(`epic ${epicId} with children ${created.join(', ')}`);
  info('each child is in backlog with a placeholder criterion — refine with /plan');
  return EXIT.OK;
};

taskSubs.edit = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const changes = [];
  const set = (key, value) => {
    changes.push(`${key}=${value}`);
  };
  if (typeof flags.priority === 'string') { task.priority = flags.priority; set('priority', flags.priority); }
  if (typeof flags.size === 'string') { task.size = flags.size; set('size', flags.size); }
  if (typeof flags.area === 'string') { task.context.area = flags.area; set('area', flags.area); }
  if (typeof flags.title === 'string') { task.title = flags.title; set('title', flags.title); }
  if (typeof flags.estimate === 'string') { task.estimate_hours = Number(flags.estimate); set('estimate_hours', flags.estimate); }
  if (typeof flags.parent === 'string') { task.parent = tasksLib.normalizeId(flags.parent); set('parent', task.parent); }
  if (typeof flags.label === 'string') { task.labels = [...new Set([...(task.labels || []), flags.label])]; set('label', flags.label); }
  if (typeof flags['depends-on'] === 'string') {
    task.depends_on = [...new Set([...(task.depends_on || []), tasksLib.normalizeId(flags['depends-on'])])];
    set('depends_on', flags['depends-on']);
  }
  if (changes.length === 0) fail('nothing to change: pass --priority/--size/--area/--title/--estimate/--parent/--label/--depends-on', EXIT.USAGE);
  tasksLib.logEvent(ctx, task.id, who.id, 'status_changed', changes.join(' '));
  tasksLib.save(ctx, task);
  board.regenerate(ctx);
  ok(`${task.id} updated: ${changes.join(', ')}`);
  return EXIT.OK;
};


export const SUBCOMMANDS = Object.keys(taskSubs);

export function taskCommand(ctx, parsed) {
  const sub = parsed.positional.shift();
  if (!sub || sub === 'help') {
    say(`harness task <${SUBCOMMANDS.join('|')}>`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  const fn = taskSubs[sub];
  if (!fn) fail(`unknown subcommand "task ${sub}" (try: ${SUBCOMMANDS.join(', ')})`, EXIT.USAGE);
  return fn(ctx, parsed);
}

export const next = (ctx, parsed) => taskSubs.next(ctx, parsed);

function requireId(id) {
  if (!id) fail('which task? pass a task id, e.g. FEAT-0001', EXIT.USAGE);
  return id;
}


/**
 * Records what each `command` check does BEFORE the change.
 *
 * The implementer prompt says "write the failing test first" and nothing verified it. A
 * check that already passes proves nothing about the criterion, and it is the most common
 * way a green result lies. Running the checks up front turns that from a warning into a
 * recorded fact the tester can compare against.
 */
taskSubs['ac-baseline'] = (ctx, { positional, flags }) => {
  const who = actor(ctx, flags);
  const task = tasksLib.load(ctx, requireId(positional[0]));
  const runnable = (task.acceptance_criteria || []).filter((a) => a.check?.type === 'command' && a.check.run);
  if (runnable.length === 0) {
    info(`${task.id} has no command checks to baseline`);
    return EXIT.OK;
  }

  const alreadyPassing = [];
  for (const ac of runnable) {
    const res = spawnSync(ac.check.run, {
      cwd: ctx.root,
      shell: true,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    // A command that cannot even start (missing test file, for instance) is the normal
    // state before the work exists, and is distinguished from a clean failing assertion.
    const started = res.error === undefined && res.status !== null;
    ac.baseline = !started ? 'error' : res.status === 0 ? 'pass' : 'fail';
    if (ac.baseline === 'pass') alreadyPassing.push(ac.id);
    const mark = ac.baseline === 'pass' ? c.red('PASS') : c.green(ac.baseline.toUpperCase());
    say(`${mark} ${c.bold(ac.id)} ${c.gray(ac.check.run)}`);
  }

  tasksLib.save(ctx, task);
  tasksLib.logEvent(ctx, task.id, who.id, 'verified', `baseline: ${runnable.map((a) => `${a.id}=${a.baseline}`).join(' ')}`);

  if (alreadyPassing.length) {
    bad(
      `${alreadyPassing.join(', ')} already pass before any change, so they cannot prove their criterion.\n` +
        '   Either the work is already done, or the check is testing the wrong thing. Regroom before implementing.',
    );
    return EXIT.CHECK_FAILED;
  }
  ok(`${runnable.length} check(s) baselined — all of them fail today, which is what makes them evidence`);
  return EXIT.OK;
};
