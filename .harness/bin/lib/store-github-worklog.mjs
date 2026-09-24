// The worklog of the GitHub backlog store: issue comments carrying a machine-readable marker,
// and the claim arbitration built on their order. Split from store-github.mjs to keep both files
// readable; store-github re-exports everything here, so callers use one module.

import { nowIso } from './util.mjs';
import { config, graphql, issueNumber, rest } from './store-github.mjs';

const EVENT_MARK = 'harness:evento';
const EVENTS_MARK = 'harness:eventos';

function renderEvent(e) {
  const line = `\`${e.at}\` · **${e.event}** · ${e.by}${e.note ? ` — ${e.note}` : ''}`;
  return `<!-- ${EVENT_MARK} ${JSON.stringify(e)} -->\n${line}`;
}

export function logEvent(ctx, task, by, event, note = null) {
  const number = task.__remote?.number ?? issueNumber(ctx, task.id);
  if (!number) return null;
  const e = { at: nowIso(), by, event, note };
  const res = rest(ctx, 'POST', `repos/${config(ctx).repo}/issues/${number}/comments`, { body: renderEvent(e) });
  return { ...e, commentId: res?.id ?? null };
}

const COMMENTS_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner, name:$repo){ issue(number:$n){ comments(last:100){ nodes{ databaseId body createdAt } } } } }`;

function parseEvents(comment) {
  const out = [];
  const one = comment.body.match(new RegExp(`<!-- ${EVENT_MARK} (\\{[\\s\\S]*?\\}) -->`));
  if (one) {
    try {
      out.push({ ...JSON.parse(one[1]), commentId: comment.databaseId });
    } catch { /* un comentario ilegible no es un evento */ }
  }
  const many = comment.body.match(new RegExp(`<!-- ${EVENTS_MARK} (\\[[\\s\\S]*?\\]) -->`));
  if (many) {
    try {
      for (const e of JSON.parse(many[1])) out.push({ ...e, commentId: comment.databaseId, imported: true });
    } catch { /* idem */ }
  }
  return out;
}

export function readWorklog(ctx, id, limit = 10) {
  const number = issueNumber(ctx, id);
  if (!number) return [];
  const [owner, repo] = config(ctx).repo.split('/');
  const data = graphql(ctx, COMMENTS_QUERY, { owner, repo, n: number });
  const events = (data.repository.issue?.comments.nodes || []).flatMap(parseEvents);
  return events.slice(-limit);
}

/** The historical worklog, as one comment, for the migration. */
export function renderEventsComment(events, { title = 'Historial importado del backlog en ficheros' } = {}) {
  const lines = events.map((e) => `- \`${e.at}\` · **${e.event}** · ${e.by}${e.note ? ` — ${e.note}` : ''}`);
  return `<!-- ${EVENTS_MARK} ${JSON.stringify(events)} -->\n**${title}** (${events.length} entradas)\n\n${lines.join('\n')}`;
}

export function comment(ctx, number, body) {
  return rest(ctx, 'POST', `repos/${config(ctx).repo}/issues/${number}/comments`, { body });
}

/**
 * Claiming without races. GitHub has no compare-and-set on a field, so the claim is a comment
 * and the order of comments is the arbiter: whoever commented first since the task last went
 * back to `ready` wins, and everybody else withdraws. Two sessions that both saw `ready`
 * therefore still end with exactly one owner.
 *
 * @returns {{won:boolean, winner:object|null}}
 */
export function arbitrateClaim(ctx, task, mine) {
  const events = readWorklog(ctx, task.id, 100);
  let since = -1;
  events.forEach((e, i) => {
    if (e.event === 'status_changed' && /-> ready\b/.test(String(e.note || ''))) since = i;
    if (e.event === 'status_changed' && String(e.note || '').startsWith('unclaimed')) since = i;
  });
  const withdrawn = new Set(events.filter((e) => e.event === 'claim_withdrawn').map((e) => String(e.note || '').replace(/^claim /, '')));
  // Imported history shares one comment and predates this store: it can never be a live claim.
  const claims = events.slice(since + 1).filter((e) => e.event === 'claimed' && !e.imported && !withdrawn.has(String(e.commentId)));
  const winner = claims.sort((a, b) => (a.commentId ?? 0) - (b.commentId ?? 0))[0] || null;
  return { won: Boolean(winner && winner.commentId === mine.commentId), winner };
}

