// `harness status` — one screen that answers: what is the state of this project, what
// should I do next, and where has reality drifted from the backlog?

import { c, pluralize, say, table } from './util.mjs';
import { OPEN_STATUSES, STATUSES, idFromBranch, loadAll, pickNext, timeInStatus, unblockCounts } from './tasks.mjs';
import * as git from './git.mjs';

const STALE_DAYS = 7;

export function report(ctx) {
  const tasks = loadAll(ctx);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const counts = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const inRepo = git.isRepo(ctx);
  const branch = inRepo ? git.currentBranch(ctx) : null;
  const currentTaskId = inRepo ? idFromBranch(ctx, branch) : null;

  const drift = [];
  if (inRepo) {
    const defaults = new Set([ctx.project.git?.default_branch || 'main', ...(ctx.project.git?.protected_branches || [])]);
    for (const b of git.localBranches(ctx)) {
      if (defaults.has(b.name)) continue;
      if (!idFromBranch(ctx, b.name)) {
        drift.push({ kind: 'branch-without-task', detail: b.name });
      }
    }
    for (const t of tasks.filter((x) => x.status === 'in_progress')) {
      const last = t.branch && git.branchExists(ctx, t.branch) ? git.lastCommitOnBranch(ctx, t.branch) : null;
      if (!last) {
        drift.push({ kind: 'in-progress-without-commits', detail: `${t.id} (branch ${t.branch || 'missing'})` });
      } else {
        const days = (Date.now() - new Date(last.date).getTime()) / 86400000;
        if (days > STALE_DAYS) {
          drift.push({ kind: 'stalled', detail: `${t.id} — last commit ${Math.floor(days)} days ago` });
        }
      }
    }
  }

  return { tasks, byId, counts, branch, currentTaskId, drift, next: pickNext(tasks) };
}

export function print(ctx, r) {
  const p = ctx.project;
  say(c.bold(`${p.project.name}`) + c.gray(`  ·  harness v${p.harness_version}`));
  say('');

  const cells = STATUSES.filter((s) => r.counts[s]).map((s) => `${s} ${c.bold(r.counts[s])}`);
  say(cells.join(c.gray('  |  ')) || c.gray('backlog vacío'));
  say('');

  if (r.branch) {
    const label = r.currentTaskId
      ? `${r.branch} ${c.gray('→')} ${r.currentTaskId} ${c.gray(r.byId.get(r.currentTaskId)?.title || '')}`
      : `${r.branch} ${c.gray('(no task)')}`;
    say(`${c.bold('branch')}  ${label}`);
  }

  const wip = r.tasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review');
  if (wip.length) {
    say('');
    say(c.bold('En curso'));
    say(
      table(
        wip.map((t) => {
          const age = timeInStatus(ctx, t);
          // For a reader from outside, how long it has been stuck is the useful number.
          const label = age.days === null ? '—' : age.days === 0 ? 'hoy' : `${age.days} d`;
          return [t.id, t.status, label, t.assignee ? `${t.assignee.kind}:${t.assignee.id}` : '—', t.title];
        }),
        ['ID', 'ESTADO', 'LLEVA', 'ASIGNADA', 'TÍTULO'],
      ),
    );
  }

  const blocked = r.tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    say('');
    say(c.bold('Bloqueadas'));
    say(table(blocked.map((t) => [t.id, t.blocked_reason || '—']), ['ID', 'MOTIVO']));
  }

  say('');
  if (r.next) {
    const unblocks = unblockCounts(r.tasks).get(r.next.id) ?? 0;
    say(`${c.bold('Siguiente')}  ${c.green(r.next.id)}  ${r.next.title}${unblocks ? c.gray(`  (desbloquea ${unblocks})`) : ''}`);
    say(c.gray(`          harness read-path ${r.next.id}   ·   /implement ${r.next.id}`));
  } else {
    const readyish = r.tasks.filter((t) => OPEN_STATUSES.includes(t.status));
    say(
      readyish.length === 0
        ? c.gray('Sin tareas abiertas.')
        : c.yellow('Ninguna tarea lista y libre: refina el backlog con /task o desbloquea dependencias.'),
    );
  }

  if (r.drift.length) {
    say('');
    say(c.yellow(`Deriva (${pluralize(r.drift.length, 'aviso', 'avisos')})`));
    for (const d of r.drift) say(`  ${c.gray(d.kind)}  ${d.detail}`);
  }
}
