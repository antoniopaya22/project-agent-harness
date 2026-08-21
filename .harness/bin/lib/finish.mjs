// `harness finish` — the four calls that end every task, as one.
//
// Closing a task is always the same sequence: check the criteria, check the docs did not go
// stale, move the status, commit. Four round trips, always in that order, and forgetting one
// is silent — the commonest failure was reaching `in_review` with the documentation still
// describing the old behaviour.
//
// Every stage stops the sequence. A stage that fails and lets the next one run would produce
// exactly the outcome this command exists to prevent: a closed task whose claim is false.

import { EXIT, bad, c, info, ok, say } from './util.mjs';
import { load, logStatusChange, save, transitionProblems } from './tasks.mjs';
import { printGateResults, runAllGates, summarize } from './gates.mjs';
import * as board from './board.mjs';
import * as doctorLib from './doctor.mjs';
import * as generate from './generate.mjs';
import { doCommit } from './commit.mjs';

export const STAGES = ['criterios', 'gates', 'documentos', 'estado', 'commit'];

/**
 * @returns {{ok:boolean, stopped:string|null, done:string[], problems:string[], exit:number}}
 */
export function finish(ctx, taskId, { dryRun = false, push = true, message = null } = {}) {
  const task = load(ctx, taskId);
  const previousStatus = task.status;
  const result = { task: task.id, ok: false, stopped: null, done: [], problems: [], exit: EXIT.OK };

  const stop = (stage, problems, exit) => {
    result.stopped = stage;
    result.problems = problems;
    result.exit = exit;
    return result;
  };

  // 1 — the criteria. First, because it is free and it is the one that matters: a task whose
  // criteria are unresolved is not finished, whatever else is green.
  const pending = (task.acceptance_criteria || []).filter((ac) => ac.status === 'pending');
  const failed = (task.acceptance_criteria || []).filter((ac) => ac.status === 'fail');
  if (pending.length || failed.length) {
    const problems = [
      ...pending.map((ac) => `${ac.id} sin resolver: ${ac.must}`),
      ...failed.map((ac) => `${ac.id} en fallo: ${ac.must}`),
    ];
    return stop('criterios', problems, EXIT.PRECONDITION);
  }
  result.done.push('criterios');

  // 2 — the gates. Cached against the tree fingerprint, so an unchanged tree is nearly free.
  const gates = summarize(runAllGates(ctx, { capture: true }));
  if (!gates.ok) {
    printGateResults(gates.results);
    return stop('gates', gates.requiredFailed.map((g) => `gate "${g.name}" en rojo (exit ${g.code})`), EXIT.CHECK_FAILED);
  }
  result.done.push('gates');

  // 3 — the documents. Not "are they good", which no command can answer, but the two things
  // that are checkable: the generated adapters match their definitions, and the harness's own
  // invariants hold. Documentation that drifted is the commonest way a closed task lies.
  //
  // The index and the board are regenerated rather than checked. They are derived from the
  // task files with no human judgement in them, so a stale one is not a warning worth acting
  // on — it is a keystroke, and refusing to close a finished task over a keystroke is the
  // kind of friction that gets a command abandoned. The adapters below are different: those
  // can hold hand edits worth noticing, so drift there refuses.
  board.regenerate(ctx);

  const { drifted, missing } = generate.check(ctx);
  if (drifted.length || missing.length) {
    return stop(
      'documentos',
      [
        ...drifted.map((f) => `${f} no coincide con su definición`),
        ...missing.map((f) => `${f} no existe`),
        'ejecuta `harness generate`',
      ],
      EXIT.CHECK_FAILED,
    );
  }
  const health = doctorLib.runDoctor(ctx, { fix: false });
  const errors = health.issues.filter((i) => i.level === 'error');
  if (errors.length) {
    return stop('documentos', errors.map((e) => `${e.check}: ${e.message}`), EXIT.CHECK_FAILED);
  }
  result.done.push('documentos');

  // 4 — the status. The transition guard is the authority, not this command: duplicating its
  // rules here would let the two drift apart, and then one of them would be wrong.
  if (task.status !== 'in_review') {
    const problems = transitionProblems(ctx, task, 'in_review', { actorKind: 'agent', skipGates: true });
    if (problems.length) return stop('estado', problems, EXIT.PRECONDITION);
    if (!dryRun) task.status = 'in_review';
  }
  result.done.push('estado');

  if (dryRun) {
    result.ok = true;
    return result;
  }

  // 5 — the commit. Saved first so the status change is part of what gets committed.
  save(ctx, task);
  logStatusChange(ctx, task, previousStatus, 'in_review', 'harness', 'finish');

  const report = doCommit(ctx, { taskId: task.id, push, message, noVerify: true });
  result.commit = report;
  result.done.push('commit');
  result.ok = true;
  return result;
}

export function printFinish(result) {
  for (const stage of STAGES) {
    if (result.done.includes(stage)) say(`${c.green('OK')} ${stage}`);
    else if (result.stopped === stage) say(`${c.red('XX')} ${stage}`);
    else say(c.gray(`.. ${stage}`));
  }
  say('');
  if (result.ok) {
    ok(`${result.task} cerrada: en revisión y subida`);
    return;
  }
  bad(`parado en "${result.stopped}"`);
  for (const p of result.problems) say(`   ${p}`);
  say('');
  info('nada posterior se ha ejecutado: una etapa que falla y deja seguir produce justo lo que este comando evita');
}
