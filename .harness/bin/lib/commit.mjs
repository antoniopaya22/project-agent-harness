// `harness commit` — the deterministic half of /commit. It enforces the git conventions
// so the agent never has to remember them: branch grammar, conventional commit with the
// task trailer, protected-branch refusal, and the gate check.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, c, fail, info, ok, say, toPosixPath, warn } from './util.mjs';
import { findSecrets } from './secrets.mjs';
import * as git from './git.mjs';
import { TYPE_GIT, branchFor, idFromBranch, load, logEvent, save, taskFile } from './tasks.mjs';
import { printGateResults, runAllGates, summarize } from './gates.mjs';

export function resolveTask(ctx, explicitId) {
  if (explicitId) return load(ctx, explicitId);
  const branch = git.currentBranch(ctx);
  const id = idFromBranch(ctx, branch);
  if (!id) {
    fail(
      `cannot tell which task this is: branch "${branch}" does not follow <type>/<number>-<slug>. ` +
        'Pass --task <ID>.',
      EXIT.USAGE,
    );
  }
  return load(ctx, id);
}

/** Subject line, ≤72 chars including the `type(scope): ` prefix. */
export function buildSubject(task, { message = null, scope = null } = {}) {
  const type = TYPE_GIT[task.type] || 'chore';
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
  let subject = (message || task.title).trim().replace(/\.$/, '');
  const budget = 72 - prefix.length;
  if (subject.length > budget) subject = `${subject.slice(0, budget - 1).trimEnd()}…`;
  return prefix + subject;
}

export function buildMessage(ctx, task, { message = null, scope = null, closes = false, body = null } = {}) {
  const subject = buildSubject(task, { message, scope });
  const parts = [subject, ''];
  if (body) {
    parts.push(body.trim(), '');
  } else if (!message) {
    // Without an explicit message, the task description carries the "why".
    const why = String(task.description).split('\n')[0].trim();
    if (why && why.length > 0) parts.push(why, '');
  }
  parts.push(`${closes ? 'Closes' : 'Refs'}: ${task.id}`);
  return `${parts.join('\n')}\n`;
}

/** Infer a conventional-commit scope from the areas the staged files belong to. */
export function inferScope(ctx, files) {
  const areas = ctx.project.areas || [];
  const allowed = ctx.project.git?.commit_scopes || [];
  const hits = new Set();
  for (const file of files) {
    const rel = toPosixPath(file);
    for (const area of areas) {
      if (area.globs.some((g) => matchGlob(rel, g))) hits.add(area.id);
    }
  }
  const candidates = [...hits].filter((id) => allowed.length === 0 || allowed.includes(id));
  return candidates.length === 1 ? candidates[0] : null;
}

function matchGlob(p, glob) {
  const re = new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')}$`,
  );
  return re.test(p);
}

export function ensureBranch(ctx, task, { create = true } = {}) {
  const want = task.branch || branchFor(task);
  const current = git.currentBranch(ctx);
  if (current === want) return { branch: want, switched: false };

  const protectedBranches = ctx.project.git?.protected_branches || [ctx.project.git?.default_branch || 'main'];
  if (!git.branchExists(ctx, want)) {
    if (!create) fail(`branch ${want} does not exist`, EXIT.PRECONDITION);
    if (!git.isClean(ctx) && protectedBranches.includes(current)) {
      fail(
        `you are on protected branch "${current}" with uncommitted changes. ` +
          `Create the task branch first: git switch -c ${want}`,
        EXIT.PRECONDITION,
      );
    }
    git.git(ctx, ['switch', '-c', want]);
    return { branch: want, switched: true, created: true };
  }
  git.git(ctx, ['switch', want]);
  return { branch: want, switched: true, created: false };
}

/**
 * The whole flow. Returns a report the caller prints; it never prints "done" for
 * something it did not do.
 */
export function doCommit(ctx, opts = {}) {
  const {
    taskId = null,
    message = null,
    scope = null,
    body = null,
    noVerify = false,
    push = true,
    closes = false,
    allowSecret = false,
    all = true,
    paths = [],
  } = opts;

  if (!git.isRepo(ctx)) fail('not a git repository', EXIT.PRECONDITION);

  const task = resolveTask(ctx, taskId);
  const report = { task: task.id, committed: false, pushed: false, pr: null, gates: null, branch: null };

  const current = git.currentBranch(ctx);
  const protectedBranches = ctx.project.git?.protected_branches || ['main'];
  if (protectedBranches.includes(current)) {
    const want = task.branch || branchFor(task);
    fail(
      `refusing to commit on protected branch "${current}".\n` +
        `   Create the task branch and retry:  git switch -c ${want}`,
      EXIT.PRECONDITION,
    );
  }
  report.branch = current;

  // Nothing to do is not an error.
  const dirty = git.statusPorcelain(ctx);
  if (dirty.length === 0) {
    info('nothing to commit (working tree clean)');
    return report;
  }

  if (!noVerify) {
    const gates = summarize(runAllGates(ctx, { capture: false }));
    report.gates = gates.map;
    printGateResults(gates.results);
    if (!gates.ok) {
      fail(
        `required gate(s) failing: ${gates.requiredFailed.map((g) => g.name).join(', ')}. ` +
          'Fix them, or pass --no-verify and say so in the commit body.',
        EXIT.CHECK_FAILED,
      );
    }
  } else {
    warn('gates skipped (--no-verify)');
  }

  if (all) git.git(ctx, ['add', '-A']);
  else if (paths.length) git.git(ctx, ['add', '--', ...paths]);

  const staged = git.stagedFiles(ctx);
  if (staged.length === 0) {
    info('nothing staged after add — nothing to commit');
    return report;
  }

  // The moment to catch a credential is before it exists in history, not after.
  if (!allowSecret) {
    const added = git
      .git(ctx, ['diff', '--cached', '--unified=0'], { allowFail: true })
      .out.split(/\r?\n/)
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
    const hits = findSecrets(added);
    if (hits.length) {
      const lines = hits.slice(0, 5).map((h) => `   - ${h.name}: ${h.excerpt}`);
      fail(
        [
          `refusing to commit: ${hits.length} line(s) look like a credential`,
          ...lines,
          '   Move it to .env. If this is a false positive, pass --allow-secret and say why.',
        ].join('\n'),
        EXIT.CHECK_FAILED,
      );
    }
  }

  const finalScope = scope || inferScope(ctx, staged);
  const msg = buildMessage(ctx, task, {
    message,
    scope: finalScope,
    closes,
    // Every bypass leaves a trace in the commit body: a skipped check nobody can see
    // afterwards is the same as no check at all.
    body:
      [
        body || null,
        noVerify ? 'Note: committed with --no-verify; gates were not run.' : null,
        allowSecret ? 'Note: committed with --allow-secret; the credential scan was bypassed.' : null,
      ]
        .filter(Boolean)
        .join('\n\n') || null,
  });

  const msgFile = path.join(ctx.harnessDir, 'workspace', task.id, 'COMMIT_MSG.txt');
  fs.mkdirSync(path.dirname(msgFile), { recursive: true });
  fs.writeFileSync(msgFile, msg, 'utf8');
  git.git(ctx, ['commit', '-F', msgFile]);
  fs.rmSync(msgFile, { force: true });
  report.committed = true;
  const head = git.git(ctx, ['rev-parse', 'HEAD']).out;
  ok(`committed ${head.slice(0, 8)} on ${current}`);
  say(c.gray(msg.split('\n')[0]));

  task.branch = current;
  task.links = task.links || { pr: null, issue: null, commits: [] };
  task.links.commits = [...(task.links.commits || []), head.slice(0, 12)].slice(-20);
  logEvent(ctx, task.id, 'harness', 'committed', msg.split('\n')[0]);

  if (push) {
    if (!git.hasRemote(ctx)) {
      warn('no remote "origin" — skipping push');
    } else {
      const up = git.upstreamOf(ctx, current);
      const div = git.divergence(ctx, current);
      if (div && div.behind > 0) {
        save(ctx, task);
        fail(
          `branch is ${div.behind} commit(s) behind its upstream. Reconcile first ` +
            '(git pull --rebase) — this command will not force-push.',
          EXIT.PRECONDITION,
        );
      }
      const args = up ? ['push'] : ['push', '-u', 'origin', current];
      git.git(ctx, args);
      report.pushed = true;
      ok(`pushed ${current}${up ? '' : ' (upstream set)'}`);
    }
  }

  // The PR opens once, when the task is actually finished — not on every commit.
  const autoPr = ctx.project.git?.auto_pr ?? 'ready';
  if (report.pushed && autoPr !== 'never' && task.status === 'in_review' && !task.links.pr) {
    const pr = openPullRequest(ctx, task, { draft: autoPr === 'draft' });
    if (pr.url) {
      task.links.pr = pr.url;
      ok(`pull request: ${pr.url}`);

    } else if (pr.manualUrl) {
      warn(`gh not available — open the PR here:\n   ${pr.manualUrl}`);
    }
    report.pr = pr.url || pr.manualUrl || null;
  } else if (report.pushed && task.status !== 'in_review' && autoPr !== 'never') {
    info(`no PR yet: task is ${task.status} (a PR opens when it reaches in_review)`);
  }

  save(ctx, task);
  recordAfterCommit(ctx, task, report);
  return report;
}

/**
 * Commits what `commit` itself wrote *after* the commit.
 *
 * Three things can only be known once the commit exists: its hash, the worklog entry for it,
 * and the pull request url. Writing them and stopping left the working tree dirty every
 * single time — the branch never recorded its own PR, and the next `git checkout` refused to
 * switch, which is how three merges in a row needed a manual stash.
 *
 * A follow-up commit rather than an amend, because the branch is already pushed and this
 * command never force-pushes. Its own hash is not recorded anywhere, deliberately: chasing
 * that tail never terminates, and a bookkeeping commit is not part of the work.
 */
export function recordAfterCommit(ctx, task, report) {
  if (!report.committed) return;

  const paths = [
    toPosixPath(path.relative(ctx.root, taskFile(ctx, task.id))),
    toPosixPath(path.relative(ctx.root, path.join(ctx.harnessDir, 'backlog', 'worklog', `${task.id}.jsonl`))),
  ].filter((p) => fs.existsSync(path.join(ctx.root, p)));

  git.git(ctx, ['add', '--', ...paths], { allowFail: true });
  const staged = git.git(ctx, ['diff', '--cached', '--name-only'], { allowFail: true });
  if (staged.code !== 0 || !staged.out.trim()) return;

  const what = report.pr ? 'la pull request y el commit' : 'el commit';
  git.git(ctx, ['commit', '-m', `chore(${task.id}): registrar ${what} en la tarea`], { allowFail: true });
  if (!report.pushed) {
    info('el registro quedó en un commit sin subir');
    return;
  }
  const pushed = git.git(ctx, ['push'], { allowFail: true });
  if (pushed.code === 0) ok(`registro de ${what} subido`);
  else warn('el registro quedó en un commit sin subir: haz `git push`');
}

export function openPullRequest(ctx, task, { draft = false } = {}) {
  const base = ctx.project.git?.default_branch || 'main';
  const title = buildSubject(task, { scope: null });
  const body = renderPrBody(ctx, task);

  if (!git.hasGh(ctx)) {
    const web = git.remoteUrlWeb(ctx);
    return { manualUrl: web ? `${web}/compare/${base}...${task.branch}?expand=1` : null };
  }

  const bodyFile = path.join(ctx.harnessDir, 'workspace', task.id, 'PR_BODY.md');
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, body, 'utf8');
  const args = ['pr', 'create', '--base', base, '--head', task.branch, '--title', title, '--body-file', bodyFile];
  if (draft) args.push('--draft');
  const res = git.gh(ctx, args);
  fs.rmSync(bodyFile, { force: true });
  if (res.code !== 0) {
    const web = git.remoteUrlWeb(ctx);
    return { error: res.err, manualUrl: web ? `${web}/compare/${base}...${task.branch}?expand=1` : null };
  }
  const url = (res.out.match(/https?:\/\/\S+/) || [null])[0];
  return { url };
}

export function renderPrBody(ctx, task) {
  const tpl = path.join(ctx.harnessDir, 'templates', 'pr.md');
  const criteria = (task.acceptance_criteria || [])
    .map((ac) => `- [${ac.status === 'pass' ? 'x' : ' '}] **${ac.id}** ${ac.must}${ac.evidence ? `\n      ${ac.evidence}` : ''}`)
    .join('\n');
  const gatesFile = path.join(ctx.harnessDir, 'workspace', task.id, 'verification.md');
  const evidence = fs.existsSync(gatesFile)
    ? fs.readFileSync(gatesFile, 'utf8').slice(0, 2000)
    : '_Sin informe de verificación: ejecuta `/verify` antes de pedir revisión._';

  const vars = {
    '{{id}}': task.id,
    '{{title}}': task.title,
    '{{description}}': task.description,
    '{{criteria}}': criteria,
    '{{evidence}}': evidence,
    '{{task_path}}': `.harness/backlog/tasks/${task.id}.json`,
  };

  let text = fs.existsSync(tpl)
    ? fs.readFileSync(tpl, 'utf8')
    : ['## {{id}} — {{title}}', '', '{{description}}', '', '### Criterios de aceptación', '', '{{criteria}}', '', '### Verificación', '', '{{evidence}}', ''].join('\n');
  for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
  return text;
}
