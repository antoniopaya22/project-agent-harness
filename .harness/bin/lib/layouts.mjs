// Layout profiles: the written standard that code gets moved *towards*.
//
// The point of declaring the target instead of letting an agent decide is that a
// reorganisation then has something to be right or wrong against. `as-is` is a first-class
// value and the default: a project that should not be touched says so, and nothing about the
// harness needs the source tree to look any particular way.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, fail, listFiles, matchesAny, toPosixPath } from './util.mjs';

export const AS_IS = 'as-is';

export function layoutsDir(ctx) {
  return path.join(ctx.harnessDir, 'layouts');
}

export function availableLayouts(ctx) {
  return listFiles(layoutsDir(ctx), '.json').map((f) => path.basename(f, '.json'));
}

/** @returns {object|null} null means "do not move anything" */
export function loadLayout(ctx, id) {
  const name = id ?? ctx.project.layout ?? AS_IS;
  if (name === AS_IS) return null;
  const file = path.join(layoutsDir(ctx), `${name}.json`);
  if (!fs.existsSync(file)) {
    fail(
      `unknown layout "${name}" (available: ${[...availableLayouts(ctx), AS_IS].join(', ')})`,
      EXIT.USAGE,
    );
  }
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = layoutProblems(layout);
  if (problems.length) {
    fail(`layout "${name}" is malformed:\n${problems.map((p) => `   - ${p}`).join('\n')}`, EXIT.CHECK_FAILED);
  }
  return layout;
}

/** A profile that cannot be acted on must fail loudly, not half-move a project. */
export function layoutProblems(layout) {
  const problems = [];
  if (!layout || typeof layout !== 'object') return ['not an object'];
  if (!layout.id) problems.push('no id');
  if (!Array.isArray(layout.target) || layout.target.length === 0) problems.push('no target structure');
  for (const entry of layout.target || []) {
    if (!entry.role) problems.push('a target entry has no role');
    if (!entry.path) problems.push(`target "${entry.role}" has no path`);
  }
  if (!Array.isArray(layout.moves)) problems.push('no moves declared');
  for (const move of layout.moves || []) {
    if (!move.when) problems.push('a move has no `when`');
    if (!move.to) problems.push(`move "${move.when}" has no destination`);
    if (!['low', 'medium', 'high'].includes(move.risk)) {
      problems.push(`move "${move.when}" declares risk "${move.risk}" (expected low, medium or high)`);
    }
  }
  if (!Array.isArray(layout.reference_rewrites)) problems.push('no reference_rewrites declared');
  if (!Array.isArray(layout.never_move)) problems.push('no never_move list');
  return problems;
}

/** Detects which profile a directory looks like, from evidence only. */
export function detectLayout(ctx, dir) {
  for (const id of availableLayouts(ctx)) {
    const layout = JSON.parse(fs.readFileSync(path.join(layoutsDir(ctx), `${id}.json`), 'utf8'));
    const any = layout.detect?.any_file || [];
    if (any.some((f) => fs.existsSync(path.join(dir, f)))) return id;
  }
  return AS_IS;
}

/**
 * Is this path allowed to move under this profile?
 * `never_move` exists because some things break in ways tests do not catch: migrations
 * referenced by name, vendored code, anything generated.
 */
export function isMovable(layout, relPath) {
  if (!layout) return false;
  const p = toPosixPath(relPath);
  return !matchesAny(p, layout.never_move || []);
}

/** The config families a move must fix up, so nothing is silently left pointing at the old place. */
export function referenceTargets(layout) {
  if (!layout) return [];
  return (layout.reference_rewrites || []).map((r) => ({ file: r.file, keys: r.keys || [] }));
}

/**
 * Substitutes the placeholders a profile uses (`{package}`) so a target path becomes real.
 * Left visible when unresolved, because a silently blank path would move files to the root.
 */
export function resolveTargetPath(templatePath, vars = {}) {
  return String(templatePath).replace(/\{(\w+)\}/g, (whole, key) => (vars[key] === undefined ? whole : vars[key]));
}

export function summarise(layout) {
  if (!layout) return 'as-is: no file will be moved';
  const targets = layout.target.map((t) => `${t.role} -> ${t.path}`).join(', ');
  return `${layout.id}: ${targets}`;
}
