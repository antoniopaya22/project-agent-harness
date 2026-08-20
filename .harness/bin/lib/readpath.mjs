// The cold-start read path, computed in one place so that `read-path`, `brief` and
// `doctor` cannot disagree about what an agent is expected to read or what it costs.

import fs from 'node:fs';
import path from 'node:path';
import { countTokens, estimateTokens, toPosixPath } from './util.mjs';

/**
 * Two kinds of cost, and the distinction is load-bearing:
 *
 * - **orientation** — what an agent reads to *understand*: the rules, the task, the
 *   project config, the area doc, plus whatever `context.docs` names. This is
 *   compressible and substitutable, so it is what the budget caps.
 * - **work** — what `context.files` names: the code the task exists to change. You cannot
 *   avoid reading it, so capping it would punish a task for being about a large file
 *   rather than for being badly groomed. Reported, never capped.
 */
export function readPathFor(ctx, task) {
  const area = (ctx.project.areas || []).find((a) => a.id === task.context?.area);

  const orientation = [
    entry(ctx, '.harness/ENTRYPOINT.md', 'rules + map'),
    entry(ctx, `.harness/backlog/tasks/${task.id}.json`, 'the task'),
    entry(ctx, '.harness/project.json', 'gates, areas, git conventions'),
  ];
  if (area) orientation.push(entry(ctx, area.doc, `area "${area.id}"`));
  else orientation.push({ path: '(no area set)', why: 'under-groomed: context.area is empty', tokens: 0, lines: 0, missing: true });

  for (const doc of task.context?.docs || []) orientation.push(entry(ctx, doc, 'context.docs'));

  const work = (task.context?.files || []).map((f) => entry(ctx, f, 'context.files'));

  const sum = (list) => list.reduce((total, e) => total + (e.tokens || 0), 0);
  return {
    area,
    orientation,
    work,
    orientationTokens: sum(orientation),
    workTokens: sum(work),
    cap: ctx.project.read_path_total_max_tokens ?? null,
    missing: [...orientation, ...work].filter((e) => e.missing && e.path !== '(no area set)'),
  };
}

function entry(ctx, relPath, why) {
  const full = path.join(ctx.root, relPath);
  if (!fs.existsSync(full)) return { path: toPosixPath(relPath), why, tokens: 0, lines: 0, missing: true };
  const text = fs.readFileSync(full, 'utf8');
  return {
    path: toPosixPath(relPath),
    why,
    tokens: countTokens(full),
    lines: text.split('\n').length,
    missing: false,
  };
}

/**
 * The task, reduced to what implementing it requires.
 *
 * Dropped: bookkeeping the agent cannot act on (timestamps, commit list, external tracker
 * ids) and fields that describe *who is doing it* rather than *what to do*.
 */
export function projectTask(task) {
  const out = {
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    description: task.description,
    acceptance_criteria: (task.acceptance_criteria || []).map((ac) => ({
      id: ac.id,
      must: ac.must,
      check: ac.check,
      status: ac.status,
    })),
    context: task.context,
  };
  if (task.size) out.size = task.size;
  if (task.parent) out.parent = task.parent;
  if (task.depends_on?.length) out.depends_on = task.depends_on;
  if (task.blocked_reason) out.blocked_reason = task.blocked_reason;
  return out;
}

/**
 * The project config, reduced to what implementing *this* task requires: how to run the
 * gates, the git conventions, and only the task's own area. Other areas' globs, the
 * provider flags, the tracker config and the read-path budgets are harness plumbing —
 * true, and irrelevant to writing the code.
 */
export function projectConfig(ctx, task) {
  const p = ctx.project;
  const area = (p.areas || []).find((a) => a.id === task.context?.area);
  return {
    project: { name: p.project?.name, purpose: p.project?.purpose, output_language: p.project?.output_language },
    git: p.git,
    gates: p.gates,
    area: area ?? null,
  };
}

const SEP = (label) => `\n===== ${label} =====\n`;

/** One payload instead of four reads. */
export function renderBrief(ctx, task, { withFiles = false } = {}) {
  const rp = readPathFor(ctx, task);
  const parts = [];

  const entrypoint = rp.orientation.find((e) => e.path.endsWith('ENTRYPOINT.md'));
  if (entrypoint && !entrypoint.missing) {
    parts.push(SEP(entrypoint.path) + fs.readFileSync(path.join(ctx.root, entrypoint.path), 'utf8').trimEnd());
  }

  parts.push(SEP(`task ${task.id} (projection)`) + JSON.stringify(projectTask(task), null, 2));
  parts.push(SEP('project config (projection)') + JSON.stringify(projectConfig(ctx, task), null, 2));

  if (rp.area) {
    parts.push(SEP(rp.area.doc) + fs.readFileSync(path.join(ctx.root, rp.area.doc), 'utf8').trimEnd());
  } else {
    parts.push(SEP('area') + 'This task has no area. It is under-groomed: run /plan before implementing.');
  }

  for (const doc of task.context?.docs || []) {
    const full = path.join(ctx.root, doc);
    parts.push(SEP(doc) + (fs.existsSync(full) ? fs.readFileSync(full, 'utf8').trimEnd() : '(missing)'));
  }

  const files = task.context?.files || [];
  if (files.length) {
    if (withFiles) {
      for (const f of files) {
        const full = path.join(ctx.root, f);
        parts.push(SEP(f) + (fs.existsSync(full) ? fs.readFileSync(full, 'utf8').trimEnd() : '(missing)'));
      }
    } else {
      // The work payload is listed, not inlined: read only what you actually touch.
      parts.push(
        SEP('files to work on (not inlined)') +
          files.map((f) => `- ${f}`).join('\n') +
          '\n\nRead these as you need them, or re-run with --with-files.',
      );
    }
  }

  const body = `${parts.join('\n')}\n`;
  return {
    body,
    stats: {
      briefTokens: estimateTokens(body),
      naiveTokens: rp.orientationTokens + (withFiles ? rp.workTokens : 0),
      orientationTokens: rp.orientationTokens,
      workTokens: rp.workTokens,
      calls: 1,
      naiveCalls: rp.orientation.filter((e) => !e.missing).length + (withFiles ? rp.work.length : 0),
    },
  };
}

/** @returns {string[]} human-readable reasons the task's cold start is too expensive */
export function budgetProblems(ctx, task) {
  const rp = readPathFor(ctx, task);
  const problems = [];
  if (rp.cap && rp.orientationTokens > rp.cap) {
    const worst = [...rp.orientation].sort((a, b) => b.tokens - a.tokens)[0];
    problems.push(
      `orientation costs ~${rp.orientationTokens} tokens, over the ${rp.cap} cap` +
        (worst ? ` — the largest single item is ${worst.path} at ~${worst.tokens}` : ''),
    );
  }
  for (const m of rp.missing) {
    problems.push(`${m.path} is referenced by the task but does not exist`);
  }
  return problems;
}
