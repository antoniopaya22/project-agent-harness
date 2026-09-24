// `harness backlog migrate-to-github` — one-off move of the file backlog to GitHub.
//
// Reads every `.harness/backlog/tasks/*.json`, finds its issue on the board and rewrites it
// (title, body with the data block, labels, Status and the Rama/Reclamada fields) from the
// file, which is the truth until the cut-over. Resumable by construction: `save` only writes
// what differs from GitHub, so a second run after an interruption does the rest and nothing
// twice. Open tasks also get their worklog as one comment; closed ones keep it in git history.

import { OPEN_STATUSES, loadAll as loadAllAny, readWorklog, timeInStatus, validateTask } from './tasks.mjs';
import * as gh from './store-github.mjs';
import { EXIT, bad, c, info, ok, say, warn } from './util.mjs';

const DROP = ['$schema', 'external'];

function filesCtx(ctx) {
  return { ...ctx, project: { ...ctx.project, backlog: { ...(ctx.project.backlog || {}), store: 'files' } } };
}

function githubCtx(ctx) {
  return { ...ctx, project: { ...ctx.project, backlog: { ...(ctx.project.backlog || {}), store: 'github' } } };
}

export async function migrateToGithub(ctx, flags = {}) {
  const dryRun = Boolean(flags['dry-run']);
  const only = typeof flags.only === 'string' ? flags.only.toUpperCase() : null;
  const fctx = filesCtx(ctx);
  const gctx = githubCtx(ctx);

  const fileTasks = loadAllAny(fctx).filter((t) => !only || t.id === only);
  const invalid = fileTasks.flatMap((t) => validateTask(fctx, t).map((e) => `${t.id} ${e.path || ''}: ${e.message}`));
  if (invalid.length) {
    for (const i of invalid) bad(i);
    return EXIT.CHECK_FAILED;
  }

  process.env.HARNESS_FRESH = '1';
  const remote = new Map(gh.loadAll(gctx).map((t) => [t.id, t]));
  const ids = new Set(loadAllAny(fctx).map((t) => t.id));

  const orphans = [...remote.values()].filter((t) => !ids.has(t.id));
  let written = 0;
  let unchanged = 0;
  let created = 0;

  for (const file of fileTasks) {
    const target = { ...file };
    for (const k of DROP) delete target[k];
    // Keep "in this status for N days" meaningful after the move.
    target.status_changed_at = timeInStatus(fctx, file).since || file.created_at || null;
    const existing = remote.get(file.id);
    if (existing) Object.defineProperty(target, '__remote', { value: existing.__remote, enumerable: false, writable: true });

    const plan = describe(target, existing);
    if (plan.length === 0) {
      unchanged += 1;
      continue;
    }
    if (dryRun) {
      say(`${c.bold(file.id)} ${existing ? `#${existing.__remote.number}` : c.yellow('nueva')}: ${plan.join(', ')}`);
      continue;
    }
    gh.save(gctx, target, { keepDates: true });
    if (existing) written += 1;
    else created += 1;
    say(c.gray(`   ${file.id} → #${target.__remote.number} (${plan.join(', ')})`));
  }

  // The worklog of open tasks travels as one comment; it is what `timeInStatus` and a reader
  // of the issue need. Closed tasks keep theirs in git history, at no API cost.
  let logs = 0;
  for (const file of fileTasks.filter((t) => OPEN_STATUSES.includes(t.status))) {
    const events = readWorklog(fctx, file.id, 100);
    if (events.length === 0) continue;
    const already = gh.readWorklog(gctx, file.id, 200).some((e) => e.commentId && e.event);
    if (already) continue;
    if (dryRun) {
      say(`${c.bold(file.id)}: historial de ${events.length} entradas como comentario`);
      continue;
    }
    const number = (remote.get(file.id) || gh.load(gctx, file.id)).__remote.number;
    gh.comment(gctx, number, gh.renderEventsComment(events));
    logs += 1;
  }

  if (orphans.length) {
    warn(`en el tablero hay ${orphans.length} tarjeta(s) sin tarea: ${orphans.map((t) => `${t.id} #${t.__remote.number}`).join(', ')}`);
    if (flags['remove-orphans'] && !dryRun) {
      const board = gh.project(gctx);
      for (const t of orphans) {
        gh.graphql(gctx, `mutation($p:ID!,$i:ID!){ deleteProjectV2Item(input:{projectId:$p itemId:$i}){ deletedItemId } }`, { p: board.id, i: t.__remote.itemId });
        ok(`retirada del tablero ${t.id} (#${t.__remote.number}); la incidencia se conserva`);
      }
    } else info('pásale --remove-orphans para quitarlas del tablero (las incidencias se conservan)');
  }

  if (dryRun) info(`simulación: ${fileTasks.length - unchanged} por escribir, ${unchanged} ya al día`);
  else ok(`${written} actualizada(s), ${created} creada(s), ${unchanged} ya al día, ${logs} historial(es) importado(s)`);
  return EXIT.OK;
}

/** What `save` would change, in words, without calling anything. */
function describe(target, existing) {
  if (!existing) return ['crear incidencia'];
  const r = existing.__remote;
  const out = [];
  const title = `${target.id} · ${target.title}`;
  if (r.title !== title) out.push('título');
  if (String(r.body || '').replace(/\r\n/g, '\n').trim() !== gh.renderBody(target).trim()) out.push(r.hasData ? 'cuerpo' : 'cuerpo (formato nuevo)');
  if (gh.labelsFor(target).join(',') !== (r.labels || []).join(',')) out.push('etiquetas');
  const want = gh.STATUS_TO_OPTION[target.status];
  if (r.status !== want) out.push(`estado ${r.status ?? '—'} → ${want}`);
  const closed = target.status === 'done' || target.status === 'cancelled';
  if (closed !== (r.state === 'CLOSED')) out.push(closed ? 'cerrar' : 'reabrir');
  const rama = closed ? null : target.branch ?? null;
  if ((r.rama ?? null) !== rama) out.push('rama');
  return out;
}
