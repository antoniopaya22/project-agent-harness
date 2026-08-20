// The gate runner. The single place a build/test/lint command is executed, so that
// no agent ever has to guess one (D7).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, c, fail, matchesAny, readJson, say, warn, writeJson } from './util.mjs';
import { git } from './git.mjs';

export const GATE_NAMES = ['format', 'lint', 'typecheck', 'test', 'build', 'start'];

/** Gates that a red result must block on. `start` is never a gate you "pass". */
export const BLOCKING_CANDIDATES = ['format', 'lint', 'typecheck', 'test', 'build'];

export function gateConfig(ctx, name) {
  const gate = (ctx.project.gates || {})[name];
  if (!gate) return null;
  return gate;
}

const CACHE_FILE = (ctx) => path.join(ctx.harnessDir, '.cache', 'gates.json');

/**
 * A fingerprint of everything a gate could possibly read: the index, both diffs (which
 * carry the actual content of modified files, so two different edits never collide) and
 * the untracked non-ignored files. Cheap because git does the hashing.
 */
function treeFingerprint(ctx) {
  const parts = [];
  for (const args of [['ls-files', '-s'], ['diff'], ['diff', '--cached']]) {
    const r = git(ctx, args, { allowFail: true });
    if (r.code !== 0) return null; // not a git repo: no fingerprint, no cache
    parts.push(r.out);
  }
  const others = git(ctx, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  for (const file of others.out.split('\n').filter(Boolean)) {
    // The cache must not be part of its own key. Writing it changes the tree, so a project
    // that has not gitignored .harness/.cache/ would invalidate every entry on write and
    // never get a hit — a cache that silently never works is worse than no cache.
    if (file.startsWith('.harness/.cache/')) continue;
    const full = path.join(ctx.root, file);
    try {
      parts.push(`${file}:${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`);
    } catch {
      parts.push(`${file}:unreadable`);
    }
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

function readCache(ctx) {
  const file = CACHE_FILE(ctx);
  if (!fs.existsSync(file)) return {};
  try {
    return readJson(file);
  } catch {
    return {};
  }
}

/**
 * Only passes are cached. A cached failure would stick to the tree even when the cause was
 * environmental — a missing service, a busy port — and the whole point of a gate is that
 * you can trust its red. Skipping a green suite you already ran is the win worth having.
 */
function writeCacheEntry(ctx, key, entry) {
  const cache = readCache(ctx);
  cache[key] = entry;
  writeJson(CACHE_FILE(ctx), cache);
}

/** Files a gate should look at when scoped to an area. */
function scopedPaths(ctx, areaId) {
  const area = (ctx.project.areas || []).find((a) => a.id === areaId);
  if (!area) fail(`unknown area "${areaId}" (declared: ${(ctx.project.areas || []).map((a) => a.id).join(', ')})`, EXIT.USAGE);
  const tracked = git(ctx, ['ls-files'], { allowFail: true }).out.split('\n').filter(Boolean);
  return tracked.filter((f) => matchesAny(f, area.globs));
}

/**
 * @returns {{name:string, state:'pass'|'fail'|'skipped'|'missing', code:number|null, command:string|null, reason?:string, cached?:boolean}}
 */
export function runGate(ctx, name, { check = false, capture = false, scope = null, cache = true } = {}) {
  const gate = gateConfig(ctx, name);
  if (!gate) return { name, state: 'missing', code: null, command: null, reason: 'not declared in project.json' };

  const status = gate.status || 'configured';
  if (status !== 'configured') {
    return { name, state: 'skipped', code: null, command: null, reason: status };
  }
  let command = (check && gate.check) || gate.run;
  if (!command) {
    return { name, state: 'skipped', code: null, command: null, reason: 'no command' };
  }

  // Scoping is opt-in per gate: without a template the gate simply runs whole, because a
  // gate that silently checked less than asked would be worse than a slow one.
  let scoped = false;
  if (scope) {
    if (gate.run_scoped) {
      const paths = scopedPaths(ctx, scope);
      if (paths.length === 0) {
        return { name, state: 'skipped', code: null, command: null, reason: `no files in area "${scope}"` };
      }
      command = gate.run_scoped.replace('{paths}', paths.map((p) => JSON.stringify(p)).join(' '));
      scoped = true;
    } else {
      warn(`gate "${name}" declares no run_scoped template; running it whole`);
    }
  }

  const fingerprint = cache ? treeFingerprint(ctx) : null;
  const key = fingerprint ? `${name}:${scoped ? scope : 'all'}:${crypto.createHash('sha1').update(command).digest('hex').slice(0, 12)}:${fingerprint}` : null;
  if (key) {
    const hit = readCache(ctx)[key];
    if (hit?.state === 'pass') {
      return { name, state: 'pass', code: 0, command, required: Boolean(gate.required), cached: true, scoped };
    }
  }

  const res = spawnSync(command, {
    cwd: ctx.root,
    shell: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '' },
  });

  const code = res.status === null ? 1 : res.status;
  const state = code === 0 ? 'pass' : 'fail';
  if (key && state === 'pass') writeCacheEntry(ctx, key, { state, at: new Date().toISOString() });

  return {
    name,
    state,
    code,
    command,
    stdout: capture ? res.stdout : undefined,
    stderr: capture ? res.stderr : undefined,
    required: Boolean(gate.required),
    cached: false,
    scoped,
  };
}

/** Runs every blocking-candidate gate. Used by /verify, /commit and the restructure loop. */
export function runAllGates(ctx, { check = false, capture = true, only = null, scope = null, cache = true } = {}) {
  const names = only || BLOCKING_CANDIDATES;
  return names.map((n) => runGate(ctx, n, { check, capture, scope, cache }));
}

export function summarize(results) {
  const failed = results.filter((r) => r.state === 'fail');
  const requiredFailed = failed.filter((r) => r.required);
  return {
    results,
    failed,
    requiredFailed,
    ok: requiredFailed.length === 0,
    map: Object.fromEntries(results.map((r) => [r.name, r.state])),
  };
}

export function printGateResults(results) {
  for (const r of results) {
    const label = r.name.padEnd(10);
    if (r.state === 'pass') {
      const tag = [r.cached ? 'cached' : null, r.scoped ? 'scoped' : null].filter(Boolean).join(', ');
      say(`${c.green('OK')} ${label} ${c.gray(r.command || '')}${tag ? c.gray(`  [${tag}]`) : ''}`);
    }
    else if (r.state === 'fail') {
      say(`${c.red('XX')} ${label} ${c.gray(r.command || '')} ${c.red(`exit ${r.code}`)}${r.required ? c.red(' [required]') : ''}`);
    } else if (r.state === 'skipped') say(`${c.gray('..')} ${label} ${c.gray(`skipped (${r.reason})`)}`);
    else say(`${c.gray('..')} ${label} ${c.gray(`missing (${r.reason})`)}`);
  }
}

export function requireGateName(name) {
  if (!name) fail(`which gate? one of: ${GATE_NAMES.join(', ')}`, EXIT.USAGE);
  if (!GATE_NAMES.includes(name)) fail(`unknown gate "${name}" (expected ${GATE_NAMES.join(', ')})`, EXIT.USAGE);
  return name;
}
