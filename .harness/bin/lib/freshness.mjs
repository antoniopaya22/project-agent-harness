// Is an area document still true?
//
// `doctor` used to check that the paths a document cites exist. That catches a rename and
// nothing else: a document can describe behaviour that changed a year ago while every path
// in it is alive. "All the links work" is not the same claim as "this is still accurate", and
// only the first one was ever being checked.
//
// So each area document records the commit it was last read against. Counting the commits
// that touched that area since then is not proof of staleness — it is the only cheap signal
// there is, and it is a good one: an area with forty commits since anyone last checked its
// document is where the document is most likely to be lying.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter, toPosixPath } from './util.mjs';

export const MARKER = 'verified_commit';
export const DEFAULT_THRESHOLD = 15;

function git(ctx, args) {
  const res = spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8' });
  return { code: res.status ?? 1, out: (res.stdout || '').trim() };
}

/** The commit an area document says it was verified against, or null. */
export function verifiedCommit(ctx, doc) {
  const full = path.join(ctx.root, doc);
  if (!fs.existsSync(full)) return null;
  const { data } = parseFrontMatter(fs.readFileSync(full, 'utf8'));
  const value = data?.[MARKER];
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value : null;
}

/**
 * Is this still the untouched template?
 *
 * The difference decides whether a missing marker is an error or a starting condition. A
 * document somebody actually wrote and never recorded a commit for is a defect: the mechanism
 * cannot work without the marker. A freshly generated stub is just new, and failing a brand
 * new project's self-check over it would teach everybody to ignore the self-check.
 */
export function looksLikeTemplate(ctx, doc) {
  const full = path.join(ctx.root, doc);
  if (!fs.existsSync(full)) return false;
  const text = fs.readFileSync(full, 'utf8');
  return /\[RELLENAR\]|AAAA-MM-DD|<persona o equipo>|# Área: <nombre>/.test(text);
}

/**
 * Can this document hold the marker at all?
 *
 * The marker lives in front matter, so a document without any cannot carry one. Demanding it
 * anyway would be a check nobody can satisfy, which is worse than no check: it trains people
 * to ignore the output.
 */
export function canHoldMarker(ctx, doc) {
  const full = path.join(ctx.root, doc);
  if (!fs.existsSync(full)) return false;
  return /^---\n[\s\S]*?\n---\n/.test(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
}

/**
 * How many commits have touched this area's files since `sinceCommit`.
 * A commit that is not in the history any more (a rebase, a squash, a fresh clone) is
 * reported as unknown rather than as zero: zero would read as "nothing changed", which is
 * the opposite of what an unresolvable commit means.
 */
export function commitsSince(ctx, globs, sinceCommit) {
  if (!sinceCommit) return { count: null, reason: 'el documento no dice contra qué commit se verificó' };
  if (git(ctx, ['cat-file', '-e', `${sinceCommit}^{commit}`]).code !== 0) {
    return { count: null, reason: `el commit ${sinceCommit} ya no está en el historial (¿rebase o clon nuevo?)` };
  }
  const paths = globs.map((g) => g.replace(/\/\*\*$/, ''));
  const res = git(ctx, ['rev-list', '--count', `${sinceCommit}..HEAD`, '--', ...paths]);
  if (res.code !== 0) return { count: null, reason: 'git no pudo contar los commits' };
  return { count: Number(res.out) || 0, reason: null };
}

/** The current commit, so a freshly verified document can record it. */
export function headCommit(ctx) {
  const res = git(ctx, ['rev-parse', 'HEAD']);
  return res.code === 0 ? res.out.slice(0, 12) : null;
}

/**
 * @returns {Array<{area:string, doc:string, verified:string|null, commits:number|null,
 *   stale:boolean, reason:string|null, action:string}>}
 */
export function areaFreshness(ctx, { threshold = null } = {}) {
  const limit = threshold ?? ctx.project.doc_freshness_threshold ?? DEFAULT_THRESHOLD;
  const out = [];
  for (const area of ctx.project.areas || []) {
    const doc = area.doc || `docs/areas/${area.id}.md`;
    const verified = verifiedCommit(ctx, doc);
    const { count, reason } = commitsSince(ctx, area.globs || [], verified);
    const template = looksLikeTemplate(ctx, doc);
    const stampable = canHoldMarker(ctx, doc);
    const stale = count != null && count > limit;
    out.push({
      area: area.id,
      doc: toPosixPath(doc),
      verified,
      template,
      stampable,
      commits: count,
      threshold: limit,
      stale,
      reason,
      // Naming the command is the point. A warning that only says "this may be stale" leaves
      // somebody to work out both what to read and how to record that they read it, and the
      // second half is the part nobody guesses.
      action: `lee ${toPosixPath(doc)} contra los cambios reales (git log ${verified ? `${verified}..HEAD` : 'HEAD'} -- ${(area.globs || []).map((g) => g.replace(/\/\*\*$/, '')).join(' ')}), corrige lo que ya no sea cierto y sella con: harness doc verified ${area.id}`,
    });
  }
  return out;
}

/** Writes (or updates) the marker in an area document's front matter. */
export function stampVerified(ctx, areaId, { commit = null } = {}) {
  const area = (ctx.project.areas || []).find((a) => a.id === areaId);
  if (!area) return { ok: false, reason: `"${areaId}" no es un área declarada en project.json` };
  const doc = area.doc || `docs/areas/${areaId}.md`;
  const full = path.join(ctx.root, doc);
  if (!fs.existsSync(full)) return { ok: false, reason: `${doc} no existe` };

  const sha = commit || headCommit(ctx);
  if (!sha) return { ok: false, reason: 'no se pudo leer el commit actual' };

  const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { ok: false, reason: `${doc} no tiene front matter donde poner la marca` };

  const body = match[1];
  const line = `${MARKER}: ${sha}`;
  const next = new RegExp(`^${MARKER}:.*$`, 'm').test(body)
    ? body.replace(new RegExp(`^${MARKER}:.*$`, 'm'), line)
    : `${body}\n${line}`;

  fs.writeFileSync(full, text.replace(match[0], `---\n${next}\n---\n`), 'utf8');
  return { ok: true, doc: toPosixPath(doc), commit: sha };
}

/**
 * The distinction the report has to keep: a document nobody has ever verified is a different
 * problem from one that was verified and has gone stale since. The first needs a first read;
 * the second needs a diff.
 */
export function summarise(rows) {
  return {
    never: rows.filter((r) => !r.verified),
    stale: rows.filter((r) => r.stale),
    unresolvable: rows.filter((r) => r.verified && r.commits == null),
    fresh: rows.filter((r) => r.verified && r.commits != null && !r.stale),
  };
}
