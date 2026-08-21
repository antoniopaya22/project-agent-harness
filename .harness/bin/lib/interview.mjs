// Stage 2 of /adopt: the questions a codebase cannot answer about itself.
//
// Three rules make an interview survivable, and all three are enforced here rather than
// hoped for in a prompt:
//
//   1. Ask only what cannot be inferred. Everything the survey found is already known.
//   2. Prefer confirming an inference to asking in the open. "I found `pytest -q` in your CI
//      and 214 tests — is that the real command?" gets a yes in a second; "how do you run
//      the tests?" gets a paragraph, eventually.
//   3. Persist every answer. A second run must not ask the same thing twice, and an
//      interview that restarts from the top is one nobody finishes.

import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readJson, writeJson } from './util.mjs';

export const MAX_PER_ROUND = 4;

export function interviewFile(ctx) {
  return path.join(ctx.harnessDir, 'adoption', 'interview.json');
}

export function loadAnswers(ctx) {
  const file = interviewFile(ctx);
  if (!fs.existsSync(file)) return { answers: {}, skipped: {} };
  try {
    const data = readJson(file);
    return { answers: data.answers || {}, skipped: data.skipped || {} };
  } catch {
    return { answers: {}, skipped: {} };
  }
}

/**
 * Records an answer, or records that the human does not know.
 *
 * "I do not know" is a real answer and must be remembered: asking again next run wastes the
 * one resource an interview spends, which is somebody's patience. It becomes an
 * `[UNVERIFIED]` marker downstream instead.
 */
export function recordAnswer(ctx, id, value, { unknown = false } = {}) {
  const state = loadAnswers(ctx);
  if (unknown) state.skipped[id] = { at: nowIso() };
  else {
    state.answers[id] = { value, at: nowIso() };
    delete state.skipped[id];
  }
  writeJson(interviewFile(ctx), { $schema: null, ...state, updated_at: nowIso() });
  return state;
}

/**
 * The full question set for a surveyed project.
 *
 * `confirm` questions carry what was inferred and the file it came from, so the human is
 * checking a claim rather than composing an answer. `open` questions are the ones no file
 * can answer — what this is for, who uses it, what hurts.
 */
export function questions(survey) {
  const list = [];
  const gates = Object.entries(survey.stack?.gates || {});

  // --- confirmations, cheapest first -----------------------------------------
  for (const [gate, found] of gates) {
    list.push({
      id: `gate.${gate}`,
      kind: 'confirm',
      round: 1,
      question: `¿Es \`${found.run}\` el comando real de ${gate} en este proyecto?`,
      inferred: found.run,
      evidence: found.evidence,
    });
  }
  if ((survey.areas || []).length > 0) {
    list.push({
      id: 'areas',
      kind: 'confirm',
      round: 1,
      question: `¿Son estas las áreas con las que piensas el proyecto: ${survey.areas.map((a) => a.id).join(', ')}?`,
      inferred: survey.areas.map((a) => a.id),
      evidence: 'directorios de código que existen en el repositorio',
    });
  }
  if ((survey.stack?.language || null) !== null) {
    list.push({
      id: 'language',
      kind: 'confirm',
      round: 1,
      question: `He detectado ${survey.stack.language}. ¿Correcto?`,
      inferred: survey.stack.language,
      // Never an empty string: a blank evidence field reads as "no reason given" while
      // looking like a filled-in one, which is worse than saying plainly that there is none.
      evidence: (survey.stack.evidence || []).join(', ') || 'inferido sin fichero que lo declare',
    });
  }

  // --- the ones no file can answer -------------------------------------------
  list.push({
    id: 'purpose',
    kind: 'open',
    round: 2,
    question: 'En un párrafo: para qué existe este proyecto y quién lo usa.',
    why: 'Es lo primero que lee un agente para entender el contexto, y nadie puede deducirlo del código.',
  });
  list.push({
    id: 'users',
    kind: 'open',
    round: 2,
    question: '¿Quién lo usa y para qué? Perfiles, no nombres.',
    why: 'Decide qué es un cambio arriesgado y qué es rutina.',
  });
  list.push({
    id: 'glossary',
    kind: 'open',
    round: 3,
    question: 'Los cinco a quince términos de dominio que un recién llegado no entendería.',
    why: 'Un agente que no sabe qué es un «expediente» en este proyecto escribirá código que lo trata como otra cosa.',
  });
  list.push({
    id: 'deprecated',
    kind: 'open',
    round: 3,
    question: '¿Qué partes están deprecadas, congeladas o fuera de alcance?',
    why: 'Sin esto, un agente «mejorará» código que estabais a punto de borrar.',
  });
  list.push({
    id: 'pain',
    kind: 'open',
    round: 4,
    question: '¿Dónde duele? Qué se rompe a menudo, qué nadie quiere tocar.',
    why: 'Es lo más valioso de un documento de área y lo único que no se puede leer del código.',
  });
  if (survey.hotspots?.length) {
    list.push({
      id: 'hotspots',
      kind: 'confirm',
      round: 4,
      question: `Los ficheros más tocados son ${survey.hotspots.slice(0, 3).map((h) => h.file).join(', ')}. ¿Es ahí donde está el trabajo de verdad?`,
      inferred: survey.hotspots.slice(0, 3).map((h) => h.file),
      evidence: 'historial de git',
    });
  }
  list.push({
    id: 'restructure',
    kind: 'confirm',
    round: 4,
    question: '¿Reorganizamos el código al perfil de layout, o lo dejamos como está?',
    inferred: 'as-is',
    evidence: 'por defecto no se mueve nada',
  });

  return list;
}

/** What is still unanswered, in rounds of at most four. */
export function pendingRounds(survey, state, { maxPerRound = MAX_PER_ROUND } = {}) {
  const outstanding = questions(survey).filter((q) => !(q.id in state.answers) && !(q.id in state.skipped));
  const byRound = new Map();
  for (const q of outstanding) {
    if (!byRound.has(q.round)) byRound.set(q.round, []);
    byRound.get(q.round).push(q);
  }
  const rounds = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const group = byRound.get(round);
    for (let i = 0; i < group.length; i += maxPerRound) rounds.push(group.slice(i, i + maxPerRound));
  }
  return rounds;
}

/** @returns {{answered:number, unknown:number, outstanding:number, complete:boolean}} */
export function progress(survey, state) {
  const all = questions(survey);
  const answered = all.filter((q) => q.id in state.answers).length;
  const unknown = all.filter((q) => q.id in state.skipped).length;
  return {
    answered,
    unknown,
    outstanding: all.length - answered - unknown,
    complete: answered + unknown === all.length,
  };
}

/**
 * What the interview taught, ready for the proposal.
 * Anything the human did not know is returned as an explicit unverified marker rather than
 * quietly omitted, because a gap that looks like an answer is the worst outcome.
 */
export function findings(survey, state) {
  const out = { known: {}, unverified: [] };
  for (const q of questions(survey)) {
    if (q.id in state.answers) out.known[q.id] = state.answers[q.id].value;
    else if (q.id in state.skipped) out.unverified.push({ id: q.id, question: q.question });
    else out.unverified.push({ id: q.id, question: q.question, note: 'sin preguntar todavía' });
  }
  return out;
}
