// Moving a project's code to the layout it declares.
//
// This is the most dangerous thing the harness does, so almost all of it is conditions
// rather than mechanism (D5):
//
//   1. towards a written profile, never the agent's taste
//   2. clean tree only
//   3. `git mv` always, so history survives and `git status` shows renames
//   4. one squashed commit on its own branch: reverting is one command
//   5. gates are the oracle — compared against a baseline taken before anything moved
//   6. no green baseline, no movement: the reorganisation becomes backlog tasks instead
//
// Batches are committed as they go and squashed at the end. That is what makes a bad batch
// revertible without losing the good ones, and it is why the loop can stop safely.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, c, fail, ok, say, toPosixPath, warn } from './util.mjs';
import * as git from './git.mjs';
import { isMovable, resolveTargetPath } from './layouts.mjs';
import { applyRewrites, planRewrites } from './refs.mjs';
import { runAllGates } from './gates.mjs';

const PY_ROOT_KEEP = new Set(['setup.py', 'conftest.py', 'noxfile.py', 'tasks.py', 'manage.py']);
const JS_CONFIG = /\.(config|conf)\.(js|mjs|cjs|ts)$/;

function listRoot(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
}

/** The package a Python profile should move loose modules into. */
export function derivePackageName(dir, fallback) {
  for (const entry of listRoot(dir)) {
    if (entry.isDir && fs.existsSync(path.join(dir, entry.name, '__init__.py'))) return entry.name;
  }
  const src = path.join(dir, 'src');
  if (fs.existsSync(src)) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(src, entry.name, '__init__.py'))) return entry.name;
    }
  }
  return String(fallback || 'app').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Turns the profile's declared `when` rules into concrete moves.
 * Anything the profile marks `never_move` is skipped, and so is anything already in place.
 */
export function planMoves(dir, layout, { packageName = null } = {}) {
  if (!layout) return [];
  const pkg = packageName || derivePackageName(dir, layout.id);
  const moves = [];
  const root = listRoot(dir);
  const add = (from, to, rule) => {
    const f = toPosixPath(from);
    const t = toPosixPath(to);
    if (f === t) return;
    if (!isMovable(layout, f)) return;
    moves.push({ from: f, to: t, rule });
  };

  for (const rule of layout.moves || []) {
    if (rule.when === 'loose_modules_at_root') {
      for (const e of root) {
        if (e.isDir || !e.name.endsWith('.py') || PY_ROOT_KEEP.has(e.name)) continue;
        if (/^test_|_test\.py$/.test(e.name)) continue;
        add(e.name, `${resolveTargetPath(rule.to, { package: pkg })}${e.name}`, rule.when);
      }
    }
    if (rule.when === 'package_at_root') {
      for (const e of root) {
        if (!e.isDir || e.name === 'src' || e.name === 'tests') continue;
        if (!fs.existsSync(path.join(dir, e.name, '__init__.py'))) continue;
        add(e.name, `${rule.to}${e.name}`, rule.when);
      }
    }
    if (rule.when === 'flat_tests_at_root') {
      for (const e of root) {
        if (e.isDir) continue;
        const isPyTest = /^test_.*\.py$|_test\.py$/.test(e.name);
        const isJsTest = /\.(test|spec)\.[jt]sx?$/.test(e.name);
        if (isPyTest || isJsTest) add(e.name, `${rule.to}${e.name}`, rule.when);
      }
    }
    if (rule.when === 'loose_sources_at_root') {
      for (const e of root) {
        if (e.isDir || JS_CONFIG.test(e.name)) continue;
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) continue;
        if (/\.(test|spec)\./.test(e.name)) continue;
        add(e.name, `${rule.to}${e.name}`, rule.when);
      }
    }
    if (rule.when === 'lib_dir') {
      const lib = path.join(dir, 'lib');
      if (fs.existsSync(lib) && fs.statSync(lib).isDirectory()) {
        for (const f of fs.readdirSync(lib)) add(`lib/${f}`, `${rule.to}${f}`, rule.when);
      }
    }
  }
  return moves;
}

/** Small groups, so a failure is attributable and revertible. */
export function batches(moves, size = 10) {
  const byDestination = new Map();
  for (const move of moves) {
    const key = path.posix.dirname(move.to);
    if (!byDestination.has(key)) byDestination.set(key, []);
    byDestination.get(key).push(move);
  }
  const out = [];
  for (const group of byDestination.values()) {
    for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size));
  }
  return out;
}

/** Did any gate get worse than it was before anything moved? */
export function comparedToBaseline(baseline, now) {
  const worse = [];
  for (const [name, before] of Object.entries(baseline)) {
    const after = now.find((r) => r.name === name);
    if (!after) continue;
    if (before.state === 'pass' && after.state !== 'pass') {
      worse.push(`${name}: pasaba antes y ahora ${after.state}`);
    }
  }
  return worse;
}

function gatesNow(ctx) {
  return runAllGates(ctx, { capture: true, cache: false });
}

/**
 * @returns {{moved: object[], skipped: string[], commits: number, aborted: object|null, report: string[]}}
 */
export function restructure(ctx, dir, { layout, baseline, safetyNet, dryRun = false, batchSize = 10, packageName = null }) {
  const report = [];
  const moves = planMoves(dir, layout, { packageName });

  if (moves.length === 0) {
    report.push('nada que mover: el proyecto ya sigue el perfil declarado');
    return { moved: [], skipped: [], commits: 0, aborted: null, report };
  }

  // Condition 6, and the one that matters most: without an oracle there is no way to know
  // whether a move broke something, so nothing moves and the work becomes backlog tasks.
  if (!safetyNet?.safe) {
    return {
      moved: [],
      skipped: moves.map((m) => m.from),
      commits: 0,
      aborted: { reason: 'no safety net', detail: safetyNet?.reason ?? 'no baseline was taken', asTasks: true },
      report: [
        `no se mueve nada: ${safetyNet?.reason ?? 'no hay línea base'}`,
        `${moves.length} movimiento(s) quedan como tareas del backlog, más una previa para conseguir una red de seguridad`,
      ],
    };
  }

  const plan = planRewrites(dir, moves, layout, { packageName: packageName || derivePackageName(dir, layout.id) });
  if (dryRun) {
    report.push(`${moves.length} movimiento(s) en ${batches(moves, batchSize).length} lote(s)`);
    for (const m of moves) report.push(`  ${m.from}  ->  ${m.to}   (${m.rule})`);
    report.push('');
    report.push('referencias a reescribir:');
    for (const cfg of plan.configs) report.push(`  config  ${cfg.file}  (${cfg.changes})`);
    for (const src of plan.sources) report.push(`  código  ${src.finalPath}  (${src.changes})`);
    if (plan.unmatched.length) report.push(`  no presentes, no revisados: ${plan.unmatched.join(', ')}`);
    return { moved: [], skipped: [], commits: 0, aborted: null, report, plan, moves };
  }

  // Condition 2: a dirty tree makes a revert ambiguous.
  if (!git.isClean(ctx)) {
    fail('el árbol de trabajo tiene cambios sin commitear: la reorganización necesita poder revertir sin ambigüedad', EXIT.PRECONDITION);
  }

  const moved = [];
  let commits = 0;
  let aborted = null;

  for (const [i, batch] of batches(moves, batchSize).entries()) {
    for (const move of batch) {
      fs.mkdirSync(path.dirname(path.join(dir, move.to)), { recursive: true });
      // Condition 3: git mv, so history survives and the diff reads as a rename.
      git.git(ctx, ['mv', move.from, move.to]);
    }
    // Condition: references are fixed in the same batch, never deferred.
    const batchPlan = planRewrites(dir, batch, layout, { packageName: packageName || derivePackageName(dir, layout.id) });
    applyRewrites(dir, batchPlan);
    git.git(ctx, ['add', '-A']);
    git.git(ctx, ['commit', '-q', '-m', `chore(restructure): lote ${i + 1}`]);
    commits += 1;

    const worse = comparedToBaseline(baseline, gatesNow(ctx));
    if (worse.length) {
      // Condition 5: revert this batch and stop. Earlier batches are committed and survive.
      git.git(ctx, ['reset', '--hard', 'HEAD~1']);
      commits -= 1;
      aborted = { reason: 'un gate empeoró respecto a la línea base', detail: worse, batch: i + 1, moves: batch };
      report.push(`lote ${i + 1} revertido: ${worse.join('; ')}`);
      break;
    }
    moved.push(...batch);
    report.push(`lote ${i + 1}: ${batch.length} fichero(s) movidos, gates igual o mejor que la línea base`);
  }

  return { moved, skipped: [], commits, aborted, report, plan };
}

/** Squashes the batch commits into the single revertible commit condition 4 promises. */
export function squashInto(ctx, commits, message) {
  if (commits <= 1) return;
  git.git(ctx, ['reset', '--soft', `HEAD~${commits}`]);
  git.git(ctx, ['commit', '-q', '-m', message]);
}

/** What condition 6 emits instead of moving: the work, as tasks a human can schedule. */
export function movesAsTasks(moves, safetyNet) {
  const grouped = new Map();
  for (const move of moves) {
    const key = move.rule;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(move);
  }
  const tasks = [
    {
      type: 'test',
      title: 'Conseguir una red de seguridad mínima antes de reorganizar',
      description:
        `No se puede reorganizar el código porque ${safetyNet?.reason ?? 'no hay línea base'}. ` +
        'Sin un gate de tests que pase hoy, mover un fichero no se distingue de romperlo. ' +
        'Esta tarea va antes que cualquier movimiento.',
    },
  ];
  for (const [rule, group] of grouped) {
    tasks.push({
      type: 'refactor',
      title: `Reorganizar: ${rule.replace(/_/g, ' ')}`,
      description:
        `${group.length} fichero(s) que el perfil de layout coloca en otro sitio:\n` +
        group.map((m) => `- ${m.from} -> ${m.to}`).join('\n'),
    });
  }
  return tasks;
}

export function printReport(result) {
  for (const line of result.report) say(line);
  if (result.aborted) {
    say('');
    warn(`reorganización detenida: ${result.aborted.reason}`);
    for (const d of [].concat(result.aborted.detail || [])) say(`   - ${d}`);
    if (result.aborted.asTasks) say(c.gray('   nada se ha movido; el trabajo queda en el backlog'));
    else say(c.gray(`   ${result.commits} lote(s) anteriores se conservan; el que falló está revertido`));
  } else if (result.moved.length) {
    ok(`${result.moved.length} fichero(s) movidos en ${result.commits} lote(s), gates nunca peores que la línea base`);
  }
}
