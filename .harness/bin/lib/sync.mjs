// The projection engine: one backlog, N sinks.
//
// Deliberately not "a client for tracker X". Each sink reconciles against the repository on
// its own and none of them talk to each other, so two mirrors cannot conflict — they can
// only be more or less fresh. A sink that fails does not stop the others.
//
// One direction only (D6): the repository is the source of truth, because changing a task's
// status means touching the code. Remote edits are reported, never merged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { c, info, listFiles, ok, say, warn } from './util.mjs';
import { loadAll, save } from './tasks.mjs';

/**
 * The fields a sink projects. Hashing only these means an unrelated edit — a worklog entry,
 * a claim, a commit link — does not make every task look dirty and trigger a pointless
 * round of remote writes.
 */
export function contentHash(task) {
  const projected = {
    title: task.title,
    description: task.description,
    status: task.status,
    type: task.type,
    priority: task.priority ?? null,
    area: task.context?.area ?? null,
    labels: [...(task.labels || [])].sort(),
    parent: task.parent ?? null,
    criteria: (task.acceptance_criteria || []).map((ac) => `${ac.id}:${ac.status}:${ac.must}`),
  };
  return crypto.createHash('sha256').update(JSON.stringify(projected)).digest('hex').slice(0, 16);
}

export function sinksDir(ctx) {
  return path.join(ctx.harnessDir, 'integrations');
}

/** Discovers the installed sinks. A sink is a directory with an adapter.mjs. */
export async function loadSinks(ctx) {
  const root = sinksDir(ctx);
  if (!fs.existsSync(root)) return [];
  const sinks = [];
  for (const entry of fs.readdirSync(root).sort()) {
    const adapter = path.join(root, entry, 'adapter.mjs');
    if (!fs.existsSync(adapter)) continue;
    const mod = await import(`file://${adapter.split(path.sep).join('/')}`);
    sinks.push({ id: entry, module: mod });
  }
  return sinks;
}

/** @returns {{id:string, enabled:boolean, reason:string}[]} */
export function describeSinks(ctx, sinks) {
  return sinks.map(({ id, module }) => {
    const verdict = module.isEnabled ? module.isEnabled(ctx) : { enabled: false, reason: 'adapter declares no isEnabled' };
    return { id, ...verdict };
  });
}

/**
 * What a sink would do, per task. Kept separate from applying so `--dry-run` shows the real
 * plan rather than a description of one.
 */
export function planFor(ctx, sink, tasks) {
  const state = (task) => task.external?.[sink.id] || {};
  const operations = [];
  for (const task of tasks) {
    if (task.type === 'epic' && sink.module.skipEpics) continue;
    const remembered = state(task);
    const hash = contentHash(task);

    // An unchanged task can still have incomplete remote state — half of a projection
    // landing before the board was configured, say. Deciding `skip` from the content hash
    // alone left those tasks off the board permanently, because the hash was already
    // current. The sink is the only thing that knows what "complete" means for it.
    const incomplete = sink.module.incompleteReason ? sink.module.incompleteReason(ctx, task) : null;

    if (!remembered.id) operations.push({ op: 'create', task, hash });
    else if (remembered.content_hash !== hash) operations.push({ op: 'update', task, hash, remoteId: remembered.id });
    else if (incomplete) operations.push({ op: 'update', task, hash, remoteId: remembered.id, because: incomplete });
    else operations.push({ op: 'skip', task, hash, remoteId: remembered.id });
  }
  return operations;
}

/**
 * Runs one sink. Never throws: a broken sink is reported and the others continue.
 * @returns {{id:string, applied:number, skipped:number, failed:number, drifted:string[], errors:string[]}}
 */
export async function runSink(ctx, sink, tasks, { dryRun = false, limit = null } = {}) {
  const result = { id: sink.id, applied: 0, skipped: 0, failed: 0, drifted: [], errors: [] };
  let operations;
  try {
    // Prepare first: the plan asks the sink what is still missing, and it cannot answer that
    // before it knows what it is connected to. The other order made every plan claim there
    // was nothing to do.
    if (sink.module.prepare) await sink.module.prepare(ctx, { dryRun });
    operations = planFor(ctx, sink, tasks);
  } catch (e) {
    result.errors.push(`prepare failed: ${e.message}`);
    return result;
  }

  let applied = 0;
  for (const operation of operations) {
    if (limit !== null && applied >= limit) {
      result.skipped += 1;
      continue;
    }
    if (operation.op === 'skip') {
      result.skipped += 1;
      continue;
    }
    applied += 1;
    if (dryRun) {
      result.applied += 1;
      say(c.gray(`   would ${operation.op} ${operation.task.id} — ${operation.task.title}`));
      continue;
    }
    try {
      const applied = await sink.module.apply(ctx, operation);
      // Remote drift is reported and then overwritten: the repository wins (D6), but a
      // silent overwrite of somebody's manual edit would be worse than a noisy one.
      if (applied?.drifted) result.drifted.push(operation.task.id);
      recordState(ctx, sink.id, operation.task, { ...applied, content_hash: operation.hash });
      result.applied += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push(`${operation.task.id}: ${e.message}`);
    }
  }
  return result;
}

function recordState(ctx, sinkId, task, applied) {
  task.external = task.external || {};
  task.external[sinkId] = {
    ...(task.external[sinkId] || {}),
    ...applied,
    last_synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  save(ctx, task);
}

export function appendAuditLog(ctx, sinkId, entry) {
  const file = path.join(sinksDir(ctx), sinkId, 'sync.log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

/** The whole projection. Returns per-sink results; prints as it goes. */
export async function runSync(ctx, { dryRun = false, only = null, limit = null } = {}) {
  const sinks = await loadSinks(ctx);
  const described = describeSinks(ctx, sinks);
  const results = [];

  if (sinks.length === 0) {
    info('no sinks installed — nothing to project to');
    return results;
  }

  const tasks = loadAll(ctx);
  for (const sink of sinks) {
    if (only && sink.id !== only) continue;
    const verdict = described.find((d) => d.id === sink.id);
    if (!verdict.enabled) {
      info(`${sink.id}: skipped — ${verdict.reason}`);
      continue;
    }
    say(c.bold(`${sink.id}${dryRun ? c.gray('  (dry run)') : ''}`));
    const result = await runSink(ctx, sink, tasks, { dryRun, limit });
    results.push(result);
    if (!dryRun) appendAuditLog(ctx, sink.id, result);

    if (result.errors.length) {
      for (const e of result.errors) warn(`   ${e}`);
    }
    for (const id of result.drifted) {
      warn(`   ${id} was edited remotely; the repository wins and it has been overwritten`);
    }
    const verb = dryRun ? 'would change' : 'changed';
    say(
      `   ${verb} ${result.applied}, unchanged ${result.skipped}` +
        (result.failed ? c.red(`, failed ${result.failed}`) : ''),
    );
  }

  if (results.length === 0) info('no sink was enabled');
  else if (results.every((r) => r.failed === 0)) ok('projection complete');
  return results;
}

/** Used by `doctor`: an installed sink that cannot work should say so, not fail silently. */
export async function sinkStatus(ctx) {
  const sinks = await loadSinks(ctx);
  return describeSinks(ctx, sinks);
}

export function installedSinkIds(ctx) {
  const root = sinksDir(ctx);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => fs.existsSync(path.join(root, entry, 'adapter.mjs')))
    .sort();
}

export { listFiles };
