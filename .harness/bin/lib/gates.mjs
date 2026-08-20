// The gate runner. The single place a build/test/lint command is executed, so that
// no agent ever has to guess one (D7).

import { spawnSync } from 'node:child_process';
import { EXIT, c, fail, say } from './util.mjs';

export const GATE_NAMES = ['format', 'lint', 'typecheck', 'test', 'build', 'start'];

/** Gates that a red result must block on. `start` is never a gate you "pass". */
export const BLOCKING_CANDIDATES = ['format', 'lint', 'typecheck', 'test', 'build'];

export function gateConfig(ctx, name) {
  const gate = (ctx.project.gates || {})[name];
  if (!gate) return null;
  return gate;
}

/**
 * @returns {{name:string, state:'pass'|'fail'|'skipped'|'missing', code:number|null, command:string|null, reason?:string}}
 */
export function runGate(ctx, name, { check = false, capture = false } = {}) {
  const gate = gateConfig(ctx, name);
  if (!gate) return { name, state: 'missing', code: null, command: null, reason: 'not declared in project.json' };

  const status = gate.status || 'configured';
  if (status !== 'configured') {
    return { name, state: 'skipped', code: null, command: null, reason: status };
  }
  const command = (check && gate.check) || gate.run;
  if (!command) {
    return { name, state: 'skipped', code: null, command: null, reason: 'no command' };
  }

  const res = spawnSync(command, {
    cwd: ctx.root,
    shell: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '' },
  });

  const code = res.status === null ? 1 : res.status;
  return {
    name,
    state: code === 0 ? 'pass' : 'fail',
    code,
    command,
    stdout: capture ? res.stdout : undefined,
    stderr: capture ? res.stderr : undefined,
    required: Boolean(gate.required),
  };
}

/** Runs every blocking-candidate gate. Used by /verify, /commit and the restructure loop. */
export function runAllGates(ctx, { check = false, capture = true, only = null } = {}) {
  const names = only || BLOCKING_CANDIDATES;
  return names.map((n) => runGate(ctx, n, { check, capture }));
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
    if (r.state === 'pass') say(`${c.green('OK')} ${label} ${c.gray(r.command || '')}`);
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
