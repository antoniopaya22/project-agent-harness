// `harness doctor` — the harness validating itself. This is what stops the structure
// from rotting: every invariant the design relies on is checked mechanically here (P3).

import fs from 'node:fs';
import path from 'node:path';
import { countLines, countTokens, listFiles, matchesAny, parseFrontMatter, toPosixPath } from './util.mjs';
import { loadAll, validateTask } from './tasks.mjs';
import { lintBacklog } from './lint.mjs';
import { git } from './git.mjs';
import { budgetProblems } from './readpath.mjs';
import * as generate from './generate.mjs';
import { buildIndex, indexPath, boardPath, renderBoard } from './board.mjs';
import { validate } from './schema.mjs';

/** @typedef {{level:'error'|'warn', check:string, message:string}} Issue */

export function runDoctor(ctx, { fix = false } = {}) {
  /** @type {Issue[]} */
  const issues = [];
  const fixed = [];
  const tasks = loadAll(ctx);

  // 1. project.json against its schema
  const projectSchemaFile = path.join(ctx.harnessDir, 'schema', 'project.schema.json');
  if (fs.existsSync(projectSchemaFile)) {
    const errs = validate(ctx.project, JSON.parse(fs.readFileSync(projectSchemaFile, 'utf8')));
    for (const e of errs) {
      issues.push({ level: 'error', check: 'project-schema', message: `project.json ${e.path || '(root)'}: ${e.message}` });
    }
  }

  // 2. every task against the task schema
  for (const t of tasks) {
    for (const e of validateTask(ctx, t)) {
      issues.push({ level: 'error', check: 'task-schema', message: `${t.id} ${e.path || '(root)'}: ${e.message}` });
    }
  }

  // 3. backlog hygiene
  for (const f of lintBacklog(ctx, { tasks })) {
    issues.push({ level: f.level, check: 'backlog', message: f.id ? `${f.id}: ${f.message}` : f.message });
  }

  // 4. generated views up to date
  const index = buildIndex(tasks);
  const indexOnDisk = fs.existsSync(indexPath(ctx)) ? fs.readFileSync(indexPath(ctx), 'utf8') : null;
  const wantIndex = `${JSON.stringify(index, null, 2)}\n`;
  const boardOnDisk = fs.existsSync(boardPath(ctx)) ? fs.readFileSync(boardPath(ctx), 'utf8') : null;
  const wantBoard = renderBoard(ctx, index);
  if (norm(indexOnDisk) !== norm(wantIndex) || norm(boardOnDisk) !== norm(wantBoard)) {
    if (fix) {
      fs.mkdirSync(path.dirname(indexPath(ctx)), { recursive: true });
      fs.writeFileSync(indexPath(ctx), wantIndex, 'utf8');
      fs.writeFileSync(boardPath(ctx), wantBoard, 'utf8');
      fixed.push('regenerated backlog/index.json and backlog/BOARD.md');
    } else {
      issues.push({ level: 'error', check: 'index', message: 'index.json/BOARD.md are stale — run `harness index`' });
    }
  }

  // 5. provider adapters in sync
  const { drifted, missing } = generate.check(ctx);
  if (drifted.length || missing.length) {
    if (fix) {
      const written = generate.apply(ctx);
      if (written.length) fixed.push(`regenerated ${written.length} adapter file(s)`);
    } else {
      for (const p of missing) {
        issues.push({ level: 'error', check: 'adapters', message: `missing generated file ${p} — run \`harness generate\`` });
      }
      for (const p of drifted) {
        issues.push({ level: 'error', check: 'adapters', message: `${p} differs from its canonical source — run \`harness generate\`` });
      }
    }
  }

  // 6. the read-path budget, in tokens. This is the mechanical guard on "read the
  // minimum" (§4), and the only number the central claim of the design rests on.
  for (const entry of ctx.project.read_path || []) {
    for (const file of expandReadPath(ctx, entry.path)) {
      const tokens = countTokens(file);
      if (tokens === null) {
        issues.push({ level: 'error', check: 'read-path', message: `${rel(ctx, file)} does not exist` });
      } else if (tokens > entry.max_tokens) {
        issues.push({
          level: 'error',
          check: 'read-path',
          message:
            `${rel(ctx, file)} costs ~${tokens} tokens, budget is ${entry.max_tokens}. ` +
            'Move content out — raising the budget is how the read path stops being short.',
        });
      }
    }
  }
  const totalCap = ctx.project.read_path_total_max_tokens;
  if (totalCap) {
    const worstCase = (ctx.project.read_path || []).reduce((sum, e) => sum + e.max_tokens, 0);
    if (worstCase > totalCap) {
      issues.push({
        level: 'error',
        check: 'read-path',
        message: `the declared budgets add up to ${worstCase} tokens, over the cap of ${totalCap}`,
      });
    }
    // Per-file budgets are not enough: a task can stay inside every one of them and still
    // be unworkable because `context.docs` points at something enormous. This checks the
    // cold start an agent would *actually* pay for each task.
    for (const t of tasks) {
      if (t.type === 'epic') continue; // never implemented directly, so it has no read path
      for (const p of budgetProblems(ctx, t)) {
        issues.push({ level: 'error', check: 'read-path', message: `${t.id}: ${p}` });
      }
    }
  }

  // 7. every declared area has its doc, and every doc is declared
  const areaDocs = new Set();
  for (const area of ctx.project.areas || []) {
    areaDocs.add(area.doc);
    if (!fs.existsSync(path.join(ctx.root, area.doc))) {
      issues.push({ level: 'error', check: 'areas', message: `area "${area.id}" declares ${area.doc}, which does not exist` });
    }
  }
  const areaDir = path.join(ctx.root, 'docs', 'areas');
  if (fs.existsSync(areaDir)) {
    for (const file of listFiles(areaDir, '.md')) {
      const relPath = rel(ctx, file);
      if (path.basename(file).startsWith('_')) continue;
      if (!areaDocs.has(relPath)) {
        issues.push({ level: 'warn', check: 'areas', message: `${relPath} is not declared as any area's doc` });
      }
    }
  }

  // 8. CODEMAP paths still exist — the anti-rot mechanism that actually works
  const codemap = path.join(ctx.root, 'docs', 'CODEMAP.md');
  if (fs.existsSync(codemap)) {
    for (const { pathRef, line } of extractPathRefs(fs.readFileSync(codemap, 'utf8'))) {
      if (!pathExistsLoose(ctx, pathRef)) {
        issues.push({ level: 'error', check: 'codemap', message: `docs/CODEMAP.md:${line} references ${pathRef}, which does not exist` });
      }
    }
  }

  // 9. agent and command definitions are well formed
  for (const kind of ['agents', 'commands']) {
    for (const file of listFiles(path.join(ctx.harnessDir, kind), '.md')) {
      const { data } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
      const id = data.id || path.basename(file, '.md');
      if (!data.purpose) {
        issues.push({ level: 'error', check: 'definitions', message: `${rel(ctx, file)} has no \`purpose\` in front matter` });
      }
      if (kind === 'agents' && (!data.forbidden || data.forbidden.length === 0)) {
        issues.push({
          level: 'error',
          check: 'definitions',
          message: `agent "${id}" declares nothing in \`forbidden\` — an agent without limits has no reason to be a separate role`,
        });
      }
      const lines = countLines(file);
      if (lines > 200) {
        issues.push({ level: 'warn', check: 'definitions', message: `${rel(ctx, file)} is ${lines} lines; a prompt nobody reads is a prompt that does not exist` });
      }
    }
  }

  // 10. secrets never land in tracked harness files
  const secretish = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i;
  for (const file of [...listFiles(path.join(ctx.harnessDir, 'backlog', 'tasks'), '.json'), path.join(ctx.harnessDir, 'project.json')]) {
    if (!fs.existsSync(file)) continue;
    if (secretish.test(fs.readFileSync(file, 'utf8'))) {
      issues.push({ level: 'error', check: 'secrets', message: `${rel(ctx, file)} looks like it contains a credential` });
    }
  }

  // 11. nothing the harness needs is invisible to git.
  // A stray unanchored pattern in .gitignore (a `lib/` meant for a virtualenv, say) will
  // silently swallow .harness/bin/lib/ — `git add` skips ignored files without a word, and
  // the breakage only surfaces on a fresh clone or in CI. This check moves that discovery
  // to the machine where the files still exist.
  issues.push(...checkGitVisibility(ctx));

  return { issues, fixed, counts: tally(issues) };
}

/** Paths under .harness/ that are ignored on purpose (secrets, scratch, audit logs). */
const INTENTIONALLY_IGNORED = [
  '.harness/integrations/*/sync.log.jsonl',
  '.harness/workspace/*/COMMIT_MSG.txt',
  '.harness/workspace/*/PR_BODY.md',
  '.harness/workspace/*/gate-output/**',
];

function checkGitVisibility(ctx) {
  const issues = [];
  const res = git(ctx, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', '.harness', 'scripts', 'tests'], {
    allowFail: true,
  });
  if (res.code !== 0) return issues; // not a git repo, or git unavailable: not our problem to report
  for (const line of res.out.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    if (matchesAny(file, INTENTIONALLY_IGNORED)) continue;
    const rule = git(ctx, ['check-ignore', '-v', '--', file], { allowFail: true }).out;
    issues.push({
      level: 'error',
      check: 'git-visibility',
      message:
        `${file} is ignored by git but the harness needs it` +
        (rule ? ` (matched by ${rule.split('\t')[0]})` : '') +
        '. Anchor the pattern (/lib/ instead of lib/) or negate it.',
    });
  }
  return issues;
}

function tally(issues) {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
  };
}

function norm(s) {
  return s === null || s === undefined ? null : s.replace(/\r\n/g, '\n');
}

function rel(ctx, file) {
  return toPosixPath(path.relative(ctx.root, file));
}

/** `{task}` and `{area}` in a read-path entry expand to every real instance. */
function expandReadPath(ctx, pattern) {
  if (pattern.includes('{task}')) {
    return listFiles(path.join(ctx.harnessDir, 'backlog', 'tasks'), '.json');
  }
  if (pattern.includes('{area}')) {
    return (ctx.project.areas || []).map((a) => path.join(ctx.root, a.doc));
  }
  return [path.join(ctx.root, pattern)];
}

/**
 * Backtick-quoted things that look like repo paths.
 * Deliberately narrow: a path must contain a `/` and must not start with one. That single
 * rule excludes the three things that used to trip this check — slash commands (`/adopt`),
 * member expressions (`tasksLib.save`) and absolute paths — without a list of exceptions.
 */
function extractPathRefs(text) {
  const refs = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const candidate = m[1].trim();
      if (!candidate.includes('/')) continue;
      if (candidate.startsWith('/')) continue;
      if (!/^[A-Za-z0-9._\-/*]+$/.test(candidate)) continue;
      if (candidate.startsWith('http')) continue;
      refs.push({ pathRef: candidate, line: i + 1 });
    }
  });
  return refs;
}

/** A CODEMAP reference may be a glob or a directory; both count as existing. */
function pathExistsLoose(ctx, ref) {
  const clean = ref.replace(/\/$/, '');
  if (!clean.includes('*')) return fs.existsSync(path.join(ctx.root, clean));
  const base = clean.split('*')[0].replace(/\/[^/]*$/, '');
  const dir = path.join(ctx.root, base);
  if (!fs.existsSync(dir)) return false;
  const entries = walkRel(dir, ctx.root);
  return entries.some((e) => matchesAny(e, [clean]));
}

function walkRel(dir, root, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    acc.push(toPosixPath(path.relative(root, full)));
    if (entry.isDirectory()) walkRel(full, root, acc);
  }
  return acc;
}
