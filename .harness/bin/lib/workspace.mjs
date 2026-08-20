// The in-flight artefacts of a task: the handoff that makes `/implement` resumable, and
// the plan whose risk decides whether a human must look before code gets written.
//
// Both used to be free-form. That meant `/implement` trusted a model to notice a field and
// obey it, which is the failure mode this module exists to remove: anything a prompt says
// "pay attention to X" about is a candidate for an exit code.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, fail, nowIso, parseFrontMatter, readJson, writeJson } from './util.mjs';
import { validate } from './schema.mjs';

export const STAGES = ['claimed', 'planned', 'implemented', 'verified', 'reviewed', 'committed'];
export const RISKS = ['low', 'medium', 'high'];

export function workspaceDir(ctx, id) {
  return path.join(ctx.harnessDir, 'workspace', id);
}

export function handoffFile(ctx, id) {
  return path.join(workspaceDir(ctx, id), 'handoff.json');
}

export function planFile(ctx, id) {
  return path.join(workspaceDir(ctx, id), 'plan.md');
}

function handoffSchema(ctx) {
  const file = path.join(ctx.harnessDir, 'schema', 'handoff.schema.json');
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

/** @returns {{path:string, message:string}[]} */
export function validateHandoff(ctx, handoff) {
  const schema = handoffSchema(ctx);
  if (!schema) return [];
  return validate(handoff, schema);
}

/**
 * Reads the handoff, or explains why it cannot be trusted.
 * A caller must never fall back to "assume the earliest stage" on a malformed file: that
 * silently converts a broken handoff into redone work, and hides the breakage.
 */
export function readHandoff(ctx, id) {
  const file = handoffFile(ctx, id);
  if (!fs.existsSync(file)) return { exists: false, handoff: null, errors: [] };
  let handoff;
  try {
    handoff = readJson(file);
  } catch (e) {
    return { exists: true, handoff: null, errors: [{ path: '', message: e.message }] };
  }
  const errors = validateHandoff(ctx, handoff);
  if (handoff.task && handoff.task !== id) {
    errors.push({ path: 'task', message: `handoff says ${handoff.task} but lives in the workspace of ${id}` });
  }
  return { exists: true, handoff, errors };
}

export function writeHandoff(ctx, id, patch) {
  const { handoff } = readHandoff(ctx, id);
  const next = {
    $schema: '../../schema/handoff.schema.json',
    task: id,
    ...(handoff || {}),
    ...patch,
    at: nowIso(),
  };
  const errors = validateHandoff(ctx, next);
  if (errors.length) {
    fail(
      'refusing to write an invalid handoff — the next session would trust it:\n' +
        errors.map((e) => `   - ${e.path || '(root)'}: ${e.message}`).join('\n'),
      EXIT.CHECK_FAILED,
    );
  }
  fs.mkdirSync(workspaceDir(ctx, id), { recursive: true });
  writeJson(handoffFile(ctx, id), next);
  return next;
}

/** The stage `/implement` may safely resume *after*. */
export function resumeStage(ctx, id) {
  const { exists, handoff, errors } = readHandoff(ctx, id);
  if (!exists) return { stage: null, reason: 'no handoff: start from the beginning' };
  if (errors.length) {
    return { stage: null, invalid: true, errors, reason: 'handoff is invalid and must not be trusted' };
  }
  return { stage: handoff.stage, reason: `resume after "${handoff.stage}"`, handoff };
}

// ---------------------------------------------------------------------------
// the plan, and its risk
// ---------------------------------------------------------------------------

/**
 * @returns {{exists:boolean, risk:string|null, areas:string[], data:object, problems:string[]}}
 */
export function readPlan(ctx, id) {
  const file = planFile(ctx, id);
  if (!fs.existsSync(file)) {
    return { exists: false, risk: null, areas: [], data: {}, problems: ['no plan.md: run /plan first'] };
  }
  const { data } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const risk = typeof data.risk === 'string' ? data.risk.toLowerCase() : null;
  if (!risk) problems.push('plan.md has no `risk` in its front matter');
  else if (!RISKS.includes(risk)) problems.push(`plan.md declares risk "${risk}", expected one of ${RISKS.join(', ')}`);
  const areas = [].concat(data.areas || []).filter((a) => typeof a === 'string');
  return { exists: true, risk, areas, data, problems };
}

/**
 * Does a human have to look before implementation starts?
 *
 * Unknown risk counts as high. A plan with no declared risk is not a low-risk plan, it is
 * an unassessed one, and defaulting it to "carry on" would make the whole checkpoint
 * decorative — which is exactly what it was while it lived only in a prompt.
 */
export function planNeedsHumanReview(ctx, id) {
  const plan = readPlan(ctx, id);
  const reasons = [];
  if (!plan.exists) reasons.push('there is no plan');
  else if (plan.problems.length) reasons.push(...plan.problems, 'unassessed risk is treated as high');
  else if (plan.risk === 'high') reasons.push('the plan declares risk: high');
  if (plan.areas.length > 1) reasons.push(`the plan touches ${plan.areas.length} areas: ${plan.areas.join(', ')}`);
  return { stop: reasons.length > 0, reasons, risk: plan.risk, areas: plan.areas };
}
