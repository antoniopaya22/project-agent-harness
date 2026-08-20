// Thin, honest wrappers over git. Nothing here decides policy; policy lives in commit.mjs.

import { spawnSync } from 'node:child_process';

export function git(ctx, args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (res.status !== 0 && !allowFail) {
    const e = new Error(`git ${args.join(' ')} failed: ${err || out}`);
    e.gitStatus = res.status;
    throw e;
  }
  return { code: res.status ?? 1, out, err };
}

export function isRepo(ctx) {
  return git(ctx, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).out === 'true';
}

export function currentBranch(ctx) {
  return git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).out;
}

export function isClean(ctx) {
  return git(ctx, ['status', '--porcelain'], { allowFail: true }).out === '';
}

export function statusPorcelain(ctx) {
  return git(ctx, ['status', '--porcelain'], { allowFail: true })
    .out.split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3) }));
}

export function stagedFiles(ctx) {
  return git(ctx, ['diff', '--cached', '--name-only'], { allowFail: true }).out.split('\n').filter(Boolean);
}

export function changedFiles(ctx) {
  const tracked = git(ctx, ['diff', '--name-only'], { allowFail: true }).out.split('\n').filter(Boolean);
  const untracked = git(ctx, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })
    .out.split('\n')
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

export function branchExists(ctx, branch) {
  return git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).code === 0;
}

export function hasRemote(ctx, name = 'origin') {
  return git(ctx, ['remote'], { allowFail: true }).out.split('\n').includes(name);
}

export function upstreamOf(ctx, branch) {
  const r = git(ctx, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { allowFail: true });
  return r.code === 0 ? r.out : null;
}

/** @returns {{ahead:number, behind:number}|null} */
export function divergence(ctx, branch) {
  const upstream = upstreamOf(ctx, branch);
  if (!upstream) return null;
  const r = git(ctx, ['rev-list', '--left-right', '--count', `${upstream}...${branch}`], { allowFail: true });
  if (r.code !== 0) return null;
  const [behind, ahead] = r.out.split(/\s+/).map(Number);
  return { ahead, behind };
}

export function localBranches(ctx) {
  return git(ctx, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso8601)', 'refs/heads/'], {
    allowFail: true,
  })
    .out.split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, date] = l.split('\t');
      return { name, lastCommit: date };
    });
}

export function lastCommitOnBranch(ctx, branch) {
  const r = git(ctx, ['log', '-1', '--format=%H%x09%ci%x09%s', branch], { allowFail: true });
  if (r.code !== 0 || !r.out) return null;
  const [hash, date, subject] = r.out.split('\t');
  return { hash, date, subject };
}

/** Files touched most often — a cheap proxy for "where does this project actually live". */
export function hotspots(ctx, limit = 25) {
  const r = git(ctx, ['log', '--format=', '--name-only', '-n', '2000'], { allowFail: true });
  const counts = new Map();
  for (const line of r.out.split('\n')) {
    const f = line.trim();
    if (!f) continue;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, touches]) => ({ file, touches }));
}

export function gh(ctx, args, { allowFail = true } = {}) {
  const res = spawnSync('gh', args, { cwd: ctx.root, encoding: 'utf8' });
  return { code: res.status ?? 1, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

export function hasGh(ctx) {
  return gh(ctx, ['--version']).code === 0;
}

export function remoteUrlWeb(ctx) {
  const r = git(ctx, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (r.code !== 0) return null;
  return r.out
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}
