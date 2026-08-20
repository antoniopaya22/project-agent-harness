#!/usr/bin/env node
// harness — the deterministic CLI. Everything an agent must not improvise lives here.
// Zero dependencies (D2). Same command name on PowerShell and POSIX via the shims.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  EXIT,
  HARNESS_VERSION,
  HarnessError,
  bad,
  c,
  fail,
  findRoot,
  info,
  ok,
  parseArgs,
  readJson,
  say,
  table,
  warn,
} from './lib/util.mjs';
import * as tasksLib from './lib/tasks.mjs';
import * as board from './lib/board.mjs';
import * as gates from './lib/gates.mjs';
import * as generate from './lib/generate.mjs';
import * as doctorLib from './lib/doctor.mjs';
import * as statusLib from './lib/status.mjs';
import * as commitLib from './lib/commit.mjs';
import { SUBCOMMANDS, taskCommand, next as taskNext } from './lib/task-cmd.mjs';
import * as readpath from './lib/readpath.mjs';
import * as workspace from './lib/workspace.mjs';
import { lintBacklog } from './lib/lint.mjs';

function actorId(ctx, flags) {
  return String(flags.as || process.env.HARNESS_ACTOR || 'human');
}

function loadContext() {
  const root = findRoot();
  if (!root) {
    fail(
      'no harness found: expected a .harness/project.json in this directory or a parent.\n' +
        '   If this project has not adopted the harness yet, run /adopt.',
      EXIT.NOT_FOUND,
    );
  }
  const harnessDir = path.join(root, '.harness');
  const project = readJson(path.join(harnessDir, 'project.json'));
  const taskSchema = readJson(path.join(harnessDir, 'schema', 'task.schema.json'));
  return { root, harnessDir, project, taskSchema };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const commands = {};

commands.help = () => {
  say(`${c.bold('harness')} v${HARNESS_VERSION} — provider-agnostic coding-agent harness`);
  say('');
  say(
    table(
      [
        ['status', 'one-screen situational awareness'],
        ['brief <ID>', 'the whole cold-start read path as one payload, projected'],
        ['read-path <ID>', 'the exact files to read to work on a task, with their cost'],
        ['task <sub>', 'list | show | next | new | claim | unclaim | set-status | ac | retype | split | edit'],
        ['gate <name>', 'run a gate (format|lint|typecheck|test|build|start) [--scope area] [--no-cache]'],
        ['gates', 'run every blocking gate and summarise'],
        ['validate', 'every task against the schema'],
        ['lint-backlog', 'cross-task hygiene: cycles, orphans, unready "ready"'],
        ['index', 'regenerate backlog/index.json and backlog/BOARD.md'],
        ['generate [--check]', 'write provider adapters from .harness/ (--check for CI)'],
        ['doctor [--fix]', 'validate the harness itself, including read-path budgets'],
        ['handoff <sub> <ID>', 'read | write | validate | resume the in-flight state of a task'],
        ['plan-risk <ID>', 'exit 3 when the plan needs a human checkpoint before coding'],
        ['commit [--task ID]', 'conventional commit + push (+ PR when the task is in_review)'],
        ['sync [--dry-run]', 'project the backlog to the external tracker (optional)'],
        ['version', 'print the harness version'],
      ],
      ['COMMAND', 'WHAT IT DOES'],
    ),
  );
  say('');
  say(c.gray('Global flags: --as <actor>  --json  --quiet'));
  return EXIT.OK;
};

commands.version = () => {
  say(HARNESS_VERSION);
  return EXIT.OK;
};

commands.status = (ctx, { flags }) => {
  const r = statusLib.report(ctx);
  if (flags.json) {
    say(JSON.stringify({ counts: r.counts, branch: r.branch, task: r.currentTaskId, next: r.next?.id ?? null, drift: r.drift }, null, 2));
    return EXIT.OK;
  }
  statusLib.print(ctx, r);
  return EXIT.OK;
};

commands['read-path'] = (ctx, { positional, flags }) => {
  const id = positional[0];
  if (!id) fail('usage: harness read-path <TASK-ID>', EXIT.USAGE);
  const task = tasksLib.load(ctx, id);
  const area = (ctx.project.areas || []).find((a) => a.id === task.context?.area);
  const entries = [
    { path: '.harness/ENTRYPOINT.md', why: 'rules + map' },
    { path: `.harness/backlog/tasks/${task.id}.json`, why: 'the task' },
    { path: '.harness/project.json', why: 'gates, areas, git conventions' },
  ];
  if (area) entries.push({ path: area.doc, why: `area "${area.id}"` });
  else entries.push({ path: '(no area set)', why: 'task is under-groomed: context.area is empty' });
  for (const doc of task.context?.docs || []) entries.push({ path: doc, why: 'context.docs' });
  for (const f of task.context?.files || []) entries.push({ path: f, why: 'context.files' });

  if (flags.json) {
    say(JSON.stringify(entries, null, 2));
    return EXIT.OK;
  }
  say(c.bold(`${task.id}  ${task.title}`));
  say('');
  let total = 0;
  const budgets = new Map((ctx.project.read_path || []).map((e) => [e.path, e.max_tokens]));
  const rows = entries.map((e) => {
    const full = path.join(ctx.root, e.path);
    if (!fs.existsSync(full)) return [e.path, c.red('missing'), '', c.gray(e.why)];
    const text = fs.readFileSync(full, 'utf8');
    const tokens = Math.ceil(text.length / 4);
    total += tokens;
    // Tokens are what the model pays; lines are shown only for human orientation.
    const budget = budgets.get(e.path) ?? budgets.get(e.path.replace(/[^/]+\.json$/, '{task}.json'));
    const over = budget && tokens > budget;
    return [
      e.path,
      over ? c.red(`~${tokens} tok`) : `~${tokens} tok`,
      c.gray(`${text.split('\n').length} ln`),
      c.gray(e.why),
    ];
  });
  say(table(rows, ['FILE', 'COST', 'LINES', 'WHY']));
  say('');
  const cap = ctx.project.read_path_total_max_tokens;
  const verdict = cap && total > cap ? c.red(`over the ${cap} cap`) : c.gray(`cap ${cap ?? 'n/a'}`);
  say(`${c.gray(`${entries.length} files, ~${total} tokens`)}  ${verdict}`);
  say(c.gray('Read nothing else unless the work forces you to.'));
  return EXIT.OK;
};

commands.brief = (ctx, { positional, flags }) => {
  const id = positional[0];
  if (!id) fail('usage: harness brief <TASK-ID> [--with-files] [--json]', EXIT.USAGE);
  const task = tasksLib.load(ctx, id);
  const { body, stats } = readpath.renderBrief(ctx, task, { withFiles: Boolean(flags['with-files']) });
  if (flags.json) {
    say(JSON.stringify({ task: task.id, stats, body }, null, 2));
    return EXIT.OK;
  }
  process.stdout.write(body);
  if (!flags.quiet) {
    const saved = stats.naiveTokens > 0 ? Math.round((1 - stats.briefTokens / stats.naiveTokens) * 100) : 0;
    say(
      c.gray(
        `
===== brief =====
~${stats.briefTokens} tokens in 1 call ` +
          `(vs ~${stats.naiveTokens} in ${stats.naiveCalls} reads: ${saved >= 0 ? '-' : '+'}${Math.abs(saved)}% context, ` +
          `-${stats.naiveCalls - 1} calls)`,
      ),
    );
  }
  return EXIT.OK;
};

commands.handoff = (ctx, { positional, flags }) => {
  const sub = positional.shift() || 'read';
  const id = tasksLib.normalizeId(positional.shift() || flags.task || '');
  if (!id) fail('usage: harness handoff <read|write|validate|resume> <TASK-ID> [--stage x] [--summary "..."]', EXIT.USAGE);

  if (sub === 'write') {
    const patch = {};
    for (const key of ['stage', 'by', 'branch', 'summary', 'next', 'notes_for_next']) {
      if (typeof flags[key] === 'string') patch[key] = flags[key];
    }
    if (!patch.stage) fail(`--stage is required (one of ${workspace.STAGES.join(', ')})`, EXIT.USAGE);
    if (!patch.by) patch.by = actorId(ctx, flags);
    if (!patch.summary) fail('--summary is required: a handoff without one is not a handoff', EXIT.USAGE);
    const written = workspace.writeHandoff(ctx, id, patch);
    ok(`handoff for ${id}: stage ${written.stage}`);
    return EXIT.OK;
  }

  const { exists, handoff, errors } = workspace.readHandoff(ctx, id);
  if (sub === 'validate') {
    if (!exists) {
      info(`no handoff for ${id}`);
      return EXIT.OK;
    }
    if (errors.length) {
      bad(`handoff for ${id} is invalid — do not trust its stage:`);
      for (const e of errors) say(`   - ${e.path || '(root)'}: ${e.message}`);
      return EXIT.CHECK_FAILED;
    }
    ok(`handoff for ${id} is valid (stage ${handoff.stage})`);
    return EXIT.OK;
  }

  if (sub === 'resume') {
    const r = workspace.resumeStage(ctx, id);
    if (r.invalid) {
      bad(`${r.reason}:`);
      for (const e of r.errors) say(`   - ${e.path || '(root)'}: ${e.message}`);
      return EXIT.CHECK_FAILED;
    }
    if (flags.json) say(JSON.stringify({ stage: r.stage, reason: r.reason }, null, 2));
    else say(r.stage ? `${r.stage}` : `${c.gray('(none)')}  ${r.reason}`);
    return EXIT.OK;
  }

  if (!exists) {
    info(`no handoff for ${id}`);
    return EXIT.OK;
  }
  say(JSON.stringify(handoff, null, 2));
  return errors.length ? EXIT.CHECK_FAILED : EXIT.OK;
};

commands['plan-risk'] = (ctx, { positional, flags }) => {
  const id = tasksLib.normalizeId(positional[0] || '');
  if (!id) fail('usage: harness plan-risk <TASK-ID>', EXIT.USAGE);
  const verdict = workspace.planNeedsHumanReview(ctx, id);
  if (flags.json) {
    say(JSON.stringify(verdict, null, 2));
    return verdict.stop ? EXIT.PRECONDITION : EXIT.OK;
  }
  if (!verdict.stop) {
    ok(`plan risk ${verdict.risk} — implementation may proceed without a checkpoint`);
    return EXIT.OK;
  }
  bad('stop and get a human to confirm the approach before implementing:');
  for (const r of verdict.reasons) say(`   - ${r}`);
  return EXIT.PRECONDITION;
};

commands.validate = (ctx) => {
  const tasks = tasksLib.loadAll(ctx);
  let errors = 0;
  for (const t of tasks) {
    const problems = tasksLib.validateTask(ctx, t);
    for (const p of problems) {
      bad(`${t.id} ${p.path || '(root)'}: ${p.message}`);
      errors += 1;
    }
  }
  if (errors === 0) {
    ok(`${tasks.length} task(s) valid against the schema`);
    return EXIT.OK;
  }
  bad(`${errors} schema error(s)`);
  return EXIT.CHECK_FAILED;
};

commands['lint-backlog'] = (ctx) => {
  const findings = lintBacklog(ctx);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  for (const f of errors) bad(`${f.id ? `${f.id}: ` : ''}${f.message}`);
  for (const f of warns) warn(`${f.id ? `${f.id}: ` : ''}${f.message}`);
  if (errors.length === 0) ok(`backlog clean${warns.length ? ` (${warns.length} warning(s))` : ''}`);
  return errors.length ? EXIT.CHECK_FAILED : EXIT.OK;
};

commands.index = (ctx) => {
  const { index, changed } = board.regenerate(ctx);
  if (changed.length === 0) info('index and board already up to date');
  else for (const f of changed) ok(`wrote ${f}`);
  info(`${index.counts.total} task(s): ${Object.entries(index.counts).filter(([k, v]) => v && k !== 'total').map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return EXIT.OK;
};

commands.generate = (ctx, { flags }) => {
  if (flags.check) {
    const { drifted, missing } = generate.check(ctx);
    for (const p of missing) bad(`missing ${p}`);
    for (const p of drifted) bad(`drifted ${p}`);
    if (!drifted.length && !missing.length) {
      ok('provider adapters match their canonical sources');
      return EXIT.OK;
    }
    bad('run `harness generate` to regenerate');
    return EXIT.CHECK_FAILED;
  }
  const written = generate.apply(ctx);
  if (written.length === 0) info('adapters already up to date');
  else for (const p of written) ok(`wrote ${p}`);
  return EXIT.OK;
};

commands.doctor = (ctx, { flags }) => {
  const { issues, fixed, counts } = doctorLib.runDoctor(ctx, { fix: Boolean(flags.fix) });
  for (const f of fixed) ok(f);
  const byCheck = new Map();
  for (const i of issues) {
    if (!byCheck.has(i.check)) byCheck.set(i.check, []);
    byCheck.get(i.check).push(i);
  }
  for (const [check, list] of byCheck) {
    say(c.bold(check));
    for (const i of list) (i.level === 'error' ? bad : warn)(`  ${i.message}`);
  }
  say('');
  if (counts.error === 0) ok(`harness healthy${counts.warn ? ` (${counts.warn} warning(s))` : ''}`);
  else bad(`${counts.error} error(s), ${counts.warn} warning(s)`);
  return counts.error ? EXIT.CHECK_FAILED : EXIT.OK;
};

commands.gate = (ctx, { positional, flags }) => {
  const name = gates.requireGateName(positional[0]);
  const r = gates.runGate(ctx, name, {
    check: Boolean(flags.check),
    capture: false,
    scope: typeof flags.scope === 'string' ? flags.scope : null,
    cache: !flags['no-cache'],
  });
  gates.printGateResults([r]);
  if (r.state === 'fail') return EXIT.CHECK_FAILED;
  return EXIT.OK;
};

commands.gates = (ctx, { flags }) => {
  const summary = gates.summarize(
    gates.runAllGates(ctx, {
      check: Boolean(flags.check),
      capture: true,
      scope: typeof flags.scope === 'string' ? flags.scope : null,
      cache: !flags['no-cache'],
    }),
  );
  gates.printGateResults(summary.results);
  if (flags.json) say(JSON.stringify(summary.map, null, 2));
  return summary.ok ? EXIT.OK : EXIT.CHECK_FAILED;
};

commands.commit = (ctx, { flags }) => {
  commitLib.doCommit(ctx, {
    taskId: flags.task || null,
    message: typeof flags.message === 'string' ? flags.message : null,
    scope: typeof flags.scope === 'string' ? flags.scope : null,
    body: typeof flags.body === 'string' ? flags.body : null,
    noVerify: Boolean(flags['no-verify']),
    push: flags.push !== 'false' && flags['no-push'] !== true,
    closes: Boolean(flags.closes),
  });
  return EXIT.OK;
};

commands.sync = (ctx, { flags }) => {
  const cfg = ctx.project.integrations?.clickup;
  if (!cfg?.enabled) {
    info('sync disabled: integrations.clickup.enabled is false in project.json');
    return EXIT.OK;
  }
  if (!process.env.CLICKUP_API_TOKEN) {
    info('sync disabled: CLICKUP_API_TOKEN is not set');
    return EXIT.OK;
  }
  const adapter = path.join(ctx.harnessDir, 'integrations', 'clickup', 'adapter.mjs');
  if (!fs.existsSync(adapter)) {
    warn('ClickUp adapter not installed yet (phase 5 of docs/HARNESS-PLAN.md)');
    return EXIT.OK;
  }
  return import(`file://${adapter}`).then((m) => m.run(ctx, { dryRun: Boolean(flags['dry-run']) }));
};

commands.task = (ctx, parsed) => taskCommand(ctx, parsed);
commands.next = (ctx, parsed) => taskNext(ctx, parsed);

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main(argv) {
  const parsed = parseArgs(argv);
  const name = parsed.positional.shift() || 'help';
  const fn = commands[name];
  if (!fn) {
    bad(`unknown command "${name}"`);
    commands.help();
    return EXIT.USAGE;
  }
  if (name === 'help' || name === 'version') return fn();
  const ctx = loadContext();
  const result = await fn(ctx, parsed);
  return typeof result === 'number' ? result : EXIT.OK;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof HarnessError) {
      bad(err.message);
      for (const d of err.details || []) say(`   - ${d}`);
      process.exit(err.code);
    }
    bad(err.stack || String(err));
    process.exit(1);
  });
