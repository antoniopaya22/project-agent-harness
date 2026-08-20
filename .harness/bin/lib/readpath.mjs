// The cold-start read path, computed in one place so that `read-path`, `brief` and
// `doctor` cannot disagree about what an agent is expected to read or what it costs.

import fs from 'node:fs';
import path from 'node:path';
import { countTokens, toPosixPath } from './util.mjs';

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
