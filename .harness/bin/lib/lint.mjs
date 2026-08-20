// Backlog hygiene. These are the failure modes a JSON Schema cannot express:
// cross-task consistency, cycles, and "this task claims to be ready but isn't".

import fs from 'node:fs';
import path from 'node:path';
import { PREFIX_TYPE, loadAll, transitionProblems } from './tasks.mjs';

/** @typedef {{level:'error'|'warn', id:string|null, message:string}} Finding */

export function lintBacklog(ctx, { tasks = null } = {}) {
  const all = tasks || loadAll(ctx);
  /** @type {Finding[]} */
  const findings = [];
  const byId = new Map();
  const areaIds = new Set((ctx.project.areas || []).map((a) => a.id));

  for (const t of all) {
    const fileId = path.basename(t.__file || '', '.json');
    if (fileId && fileId !== t.id) {
      findings.push({ level: 'error', id: t.id, message: `filename says ${fileId} but id field says ${t.id}` });
    }
    if (byId.has(t.id)) {
      findings.push({ level: 'error', id: t.id, message: 'duplicate id (two tasks claim it)' });
    }
    byId.set(t.id, t);
  }

  for (const t of all) {
    const prefix = t.id.split('-')[0];
    const expected = PREFIX_TYPE[prefix];
    if (expected && expected !== t.type) {
      // Frozen ids are allowed to diverge once the task has left backlog (§5.1).
      findings.push({
        level: t.status === 'backlog' ? 'error' : 'warn',
        id: t.id,
        message:
          t.status === 'backlog'
            ? `id prefix ${prefix} implies type "${expected}" but type is "${t.type}" — run \`harness task retype ${t.id} ${t.type}\``
            : `id prefix ${prefix} diverges from type "${t.type}" (frozen at claim time; informational)`,
      });
    }

    const acIds = new Set();
    for (const ac of t.acceptance_criteria || []) {
      if (acIds.has(ac.id)) {
        findings.push({ level: 'error', id: t.id, message: `duplicate acceptance criterion id ${ac.id}` });
      }
      acIds.add(ac.id);
      if (ac.check?.type === 'command' && !ac.check.run) {
        findings.push({ level: 'error', id: t.id, message: `${ac.id}: check.type "command" without check.run` });
      }
    }

    for (const dep of t.depends_on || []) {
      if (!byId.has(dep)) {
        findings.push({ level: 'error', id: t.id, message: `depends_on ${dep}, which does not exist` });
      }
    }

    if (t.parent) {
      const parent = byId.get(t.parent);
      if (!parent) findings.push({ level: 'error', id: t.id, message: `parent ${t.parent} does not exist` });
      else if (parent.type !== 'epic') {
        findings.push({ level: 'error', id: t.id, message: `parent ${t.parent} is not an epic (type ${parent.type})` });
      }
    }

    if (t.context?.area && !areaIds.has(t.context.area)) {
      findings.push({
        level: 'error',
        id: t.id,
        message: `context.area "${t.context.area}" is not declared in project.json areas`,
      });
    }

    // A task claiming a status it does not qualify for is the most dangerous drift:
    // /implement trusts `ready`.
    if (t.status === 'ready') {
      const problems = transitionProblems(ctx, { ...t, status: 'backlog' }, 'ready', { allTasks: all });
      for (const p of problems) {
        if (p === 'already ready') continue;
        findings.push({ level: 'error', id: t.id, message: `marked ready but: ${p}` });
      }
    }
    if (t.status === 'in_progress') {
      if (!t.branch) findings.push({ level: 'error', id: t.id, message: 'in_progress without a branch' });
      if (!t.assignee) findings.push({ level: 'error', id: t.id, message: 'in_progress without an assignee' });
    }
    if (t.status === 'blocked' && !t.blocked_reason) {
      findings.push({ level: 'error', id: t.id, message: 'blocked without blocked_reason' });
    }
    if (t.status === 'cancelled' && !t.resolution) {
      findings.push({ level: 'error', id: t.id, message: 'cancelled without resolution' });
    }

    // Titles are read by non-technical people on the board.
    if (/[\\/]|\.(js|mjs|ts|py|json|md)\b|\(\)|_[a-z]+_/.test(t.title)) {
      findings.push({
        level: 'warn',
        id: t.id,
        message: 'title looks technical (paths/identifiers) — the board is read by non-technical people',
      });
    }

    for (const doc of t.context?.docs || []) {
      if (!fs.existsSync(path.join(ctx.root, doc))) {
        findings.push({ level: 'warn', id: t.id, message: `context.docs points at missing ${doc}` });
      }
    }
    for (const f of t.context?.files || []) {
      if (!fs.existsSync(path.join(ctx.root, f)) && !f.includes('*')) {
        findings.push({ level: 'warn', id: t.id, message: `context.files points at missing ${f}` });
      }
    }
  }

  findings.push(...findCycles(all));

  // Workspace dirs whose task vanished.
  const wsRoot = path.join(ctx.harnessDir, 'workspace');
  if (fs.existsSync(wsRoot)) {
    for (const entry of fs.readdirSync(wsRoot)) {
      if (!byId.has(entry) && entry !== '.gitkeep') {
        findings.push({ level: 'warn', id: null, message: `workspace/${entry}/ has no matching task` });
      }
    }
  }

  return findings;
}

function findCycles(tasks) {
  const graph = new Map(tasks.map((t) => [t.id, t.depends_on || []]));
  const state = new Map();
  const findings = [];
  const stack = [];

  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      findings.push({ level: 'error', id, message: `dependency cycle: ${cycle.join(' -> ')}` });
      return;
    }
    state.set(id, 'active');
    stack.push(id);
    for (const dep of graph.get(id) || []) if (graph.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of graph.keys()) visit(id);
  // Deduplicate: a cycle is reported once per entry point otherwise.
  const seen = new Set();
  return findings.filter((f) => {
    const key = f.message.split(': ')[1].split(' -> ').slice().sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
