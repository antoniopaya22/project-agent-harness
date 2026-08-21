// Stage 5 of /adopt: create what the proposal promised, then check it is true.
//
// `init` lays down the structure. This adds the two things that need judgement and so must
// not be left to a prompt: the seed backlog, and proving the inferred gates actually run.
//
// A gate command that was read off a config file is a hypothesis. Recording it as
// `configured` without executing it once produces a harness whose first real command fails,
// which is the worst possible first impression and the hardest kind of wrong to notice.

import fs from 'node:fs';
import path from 'node:path';
import * as board from './board.mjs';
import { gateBaseline } from './survey.mjs';
import { allocateId, slugify, taskFile } from './tasks.mjs';
import { c, nowIso, ok, readJson, say, toPosixPath, warn, writeJson } from './util.mjs';
import { proposeSeedTasks } from './proposal.mjs';

/**
 * Executes each configured gate once and downgrades the ones that never ran.
 *
 * The distinction that matters: a test suite that **fails** is a configured gate telling the
 * truth, and stays configured. A command that could not start — not installed, wrong path,
 * missing script — is not a gate at all, and saying otherwise is the lie this prevents.
 */
export function verifyGates(target, gates, { timeoutMs = 300000 } = {}) {
  const stack = { gates: {} };
  for (const [name, g] of Object.entries(gates)) {
    if (g.status === 'configured' && g.run && name !== 'start') {
      stack.gates[name] = { run: g.run, evidence: 'declarado en project.json' };
    }
  }
  const baseline = gateBaseline(target, stack, { timeoutMs });

  const verified = {};
  const downgraded = [];
  for (const [name, g] of Object.entries(gates)) {
    const result = baseline[name];
    if (!result) {
      verified[name] = g;
      continue;
    }
    if (result.state === 'error' || result.state === 'timeout') {
      verified[name] = { run: g.run, required: false, status: 'not-configured' };
      downgraded.push({ gate: name, command: g.run, state: result.state, excerpt: result.excerpt });
    } else {
      verified[name] = { ...g, status: 'configured' };
    }
  }
  return { gates: verified, downgraded, baseline };
}

/**
 * Writes the seed tasks as real task files.
 *
 * Everything lands in `backlog`. They are unrefined ideas lifted off `TODO` markers: nobody
 * has decided what "done" means for them, and marking them `ready` would be lying about
 * their state to whoever picks one up next.
 */
export function seedBacklog(ctx, seeds, { limit = 40 } = {}) {
  const created = [];
  for (const seed of seeds.slice(0, limit)) {
    const id = allocateId(ctx, seed.type);
    const task = {
      $schema: '../../schema/task.schema.json',
      id,
      title: seed.title,
      type: seed.type,
      status: 'backlog',
      priority: 'low',
      size: 'S',
      description:
        `${seed.description}\n\n` +
        'Sembrada durante la adopción a partir de lo que el propio código admite. ' +
        'Sin refinar: antes de pasarla a lista hace falta decidir qué es «hecho».',
      acceptance_criteria: [
        {
          id: 'AC1',
          // Deliberately not a command: nobody has said how this is checked, and inventing a
          // check is how a criterion becomes a formality that always passes.
          must: `[SIN REFINAR] Decidir qué significa resolver lo anotado en ${seed.evidence} y hacerlo.`,
          check: { type: 'manual', run: null },
          status: 'pending',
        },
      ],
      context: { area: seed.area || null, docs: [], files: [seed.evidence.split(':')[0]], out_of_scope: [] },
      depends_on: [],
      labels: ['adopcion'],
      assignee: null,
      claimed_at: null,
      branch: null,
      links: { pr: null, issue: null, commits: [] },
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    writeJson(taskFile(ctx, id), task);
    created.push({ id, title: seed.title, slug: slugify(seed.title) });
  }
  return created;
}

/** Which area a seeded file belongs to, so the task is not orphaned from the read path. */
export function areaFor(config, file) {
  const posix = toPosixPath(file);
  for (const area of config.areas || []) {
    for (const glob of area.globs || []) {
      const prefix = glob.replace(/\/\*\*$/, '');
      if (posix === prefix || posix.startsWith(`${prefix}/`)) return area.id;
    }
  }
  return (config.areas || [])[0]?.id ?? null;
}

/**
 * Everything stage 5 does after `init`, as one call.
 * @returns {{seeded:Array, downgraded:Array, baseline:Object}}
 */
export function applyAdoption(target, surveyed, { seed = true, verify = true, timeoutMs = 300000 } = {}) {
  const harnessDir = path.join(target, '.harness');
  const configPath = path.join(harnessDir, 'project.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`${toPosixPath(path.relative(target, configPath))} does not exist — run \`harness init\` first`);
  }
  const config = readJson(configPath);
  const ctx = {
    root: target,
    harnessDir,
    project: config,
    taskSchema: readJson(path.join(harnessDir, 'schema', 'task.schema.json')),
  };

  let downgraded = [];
  let baseline = {};
  if (verify) {
    const result = verifyGates(target, config.gates || {}, { timeoutMs });
    downgraded = result.downgraded;
    baseline = result.baseline;
    if (downgraded.length) {
      config.gates = result.gates;
      writeJson(configPath, config);
      ctx.project = config;
    }
  }

  let seeded = [];
  if (seed) {
    const proposed = proposeSeedTasks(surveyed).map((s) => ({ ...s, area: areaFor(config, s.evidence.split(':')[0]) }));
    seeded = seedBacklog(ctx, proposed);
    if (seeded.length) board.regenerate(ctx);
  }

  return { seeded, downgraded, baseline, config };
}

export function printApplyReport({ seeded, downgraded, baseline }) {
  const ran = Object.entries(baseline);
  if (ran.length) {
    say(c.bold('Gates comprobados de verdad'));
    for (const [name, b] of ran) {
      const mark = b.state === 'pass' ? c.green('PASS') : b.state === 'fail' ? c.yellow('FAIL') : c.red(b.state.toUpperCase());
      say(`  ${mark} ${name.padEnd(10)} ${c.gray(b.command)}`);
    }
    say('');
  }
  if (downgraded.length) {
    warn('gates que no llegaron a ejecutarse, degradados a sin configurar:');
    for (const d of downgraded) {
      say(`   ${d.gate}: ${c.gray(d.command)}  ${c.red(`(${d.state})`)}`);
      if (d.excerpt) say(c.gray(`      ${d.excerpt.split('\n')[0]}`));
    }
    say(c.gray('   un comando que no arranca no es un gate; registrarlo como tal rompería el primer `harness gate`.'));
    say('');
  } else if (ran.length) {
    ok('todos los gates inferidos arrancan');
  }

  if (seeded.length) {
    ok(`${seeded.length} tarea(s) sembradas, todas en backlog y sin refinar`);
    for (const t of seeded.slice(0, 10)) say(c.gray(`   ${t.id}  ${t.title}`));
    if (seeded.length > 10) say(c.gray(`   … y ${seeded.length - 10} más`));
  } else {
    say(c.gray('nada que sembrar: el código no admite trabajo pendiente'));
  }
}
