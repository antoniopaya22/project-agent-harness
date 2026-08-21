// Stages 3 and 5 of /adopt: what will be created, and then creating it.
//
// The whole value of an adoption is that its output can be trusted, so every statement in
// the proposal carries the file it came from or is marked unverified. A confident, wrong
// document is worse than an obvious hole: the next agent reads it and builds on it.
//
// Nothing is applied from here. The proposal is one file, the human corrects it, and only
// then does anything get created.

import fs from 'node:fs';
import path from 'node:path';
import { toPosixPath, writeFileIfChanged } from './util.mjs';
import { findings, loadAnswers } from './interview.mjs';
import { hasSafetyNet } from './survey.mjs';

export const UNVERIFIED = '[SIN VERIFICAR — confirmar]';

export function proposalFile(ctx) {
  return path.join(ctx.harnessDir, 'adoption', 'PROPOSAL.md');
}

/** `claim [evidencia: fichero]`, or the claim marked as unverified. There is no third form. */
export function claim(text, evidence) {
  return evidence ? `${text}  \`[evidencia: ${evidence}]\`` : `${text}  ${UNVERIFIED}`;
}

/**
 * Gates, from evidence only.
 * A command nobody confirmed and no file declares is not proposed as configured — it is
 * proposed as absent, which is a thing a human can fix and a lie is not.
 */
export function proposeGates(survey, answers) {
  const proposed = {};
  for (const gate of ['format', 'lint', 'typecheck', 'test', 'build', 'start']) {
    const found = survey.stack?.gates?.[gate];
    const confirmed = answers.known?.[`gate.${gate}`];
    if (!found) {
      proposed[gate] = { run: null, status: 'not-configured', evidence: null, confirmed: false };
      continue;
    }
    proposed[gate] = {
      run: typeof confirmed === 'string' && confirmed.length > 0 ? confirmed : found.run,
      status: 'configured',
      required: gate === 'lint' || gate === 'test',
      evidence: found.evidence,
      confirmed: Boolean(confirmed),
    };
  }
  return proposed;
}

/**
 * Areas, from directories that exist crossed with the files git says are actually touched.
 * A directory nobody has edited in two thousand commits is not where the project lives.
 */
export function proposeAreas(survey, answers) {
  const confirmed = answers.known?.areas;
  const touched = new Set((survey.hotspots || []).map((h) => h.file));
  const scored = (survey.areas || []).map((area) => {
    const prefix = area.globs[0].replace(/\/\*\*$/, '');
    const hits = [...touched].filter((f) => f === prefix || f.startsWith(`${prefix}/`)).length;
    return { ...area, hotspotHits: hits, doc: `docs/areas/${area.id}.md` };
  });
  if (Array.isArray(confirmed) && confirmed.length) {
    return scored.filter((a) => confirmed.includes(a.id));
  }
  return scored;
}

/**
 * The seed backlog: what the codebase already admits is unfinished.
 * Everything lands in `backlog`, never `ready` — they are unrefined ideas, and marking them
 * ready would be lying about their state.
 */
export function proposeSeedTasks(survey, { limit = 40 } = {}) {
  const byFile = new Map();
  for (const mark of survey.pending || []) {
    if (!byFile.has(mark.file)) byFile.set(mark.file, []);
    byFile.get(mark.file).push(mark);
  }
  const tasks = [];
  for (const [file, marks] of byFile) {
    if (tasks.length >= limit) break;
    const kind = marks.some((m) => m.kind === 'FIXME' || m.kind === 'HACK') ? 'fix' : 'chore';
    tasks.push({
      type: kind,
      status: 'backlog',
      title: `Resolver lo pendiente anotado en ${path.posix.basename(file)}`,
      description:
        `El propio código marca ${marks.length} cosa(s) sin terminar aquí:\n` +
        marks.map((m) => `- ${m.kind} (${m.file}:${m.line}) ${m.text}`).join('\n') +
        '\n\nSin refinar: hace falta decidir si sigue siendo cierto y qué es «hecho».',
      evidence: `${file}:${marks[0].line}`,
    });
  }
  return tasks;
}

/**
 * @returns {string} the proposal, and nothing written to disk
 */
export function renderProposal(ctx, { survey, baseline, answers, layout = null, moves = [] }) {
  const gates = proposeGates(survey, answers);
  const areas = proposeAreas(survey, answers);
  const seeds = proposeSeedTasks(survey);
  const net = baseline ? hasSafetyNet(baseline) : { safe: false, reason: 'no se tomó línea base' };

  const L = [];
  L.push('# Propuesta de adopción');
  L.push('');
  L.push('> Nada de esto se ha creado todavía. Lee, corrige lo que esté mal y dilo: la propuesta se');
  L.push('> vuelve a generar. Solo después se escribe algo.');
  L.push('>');
  L.push('> Cada afirmación lleva el fichero de donde salió, o va marcada como no verificada. No hay');
  L.push('> una tercera forma: un documento seguro de sí mismo y equivocado es peor que un hueco.');
  L.push('');

  L.push('## El proyecto');
  L.push('');
  const purpose = answers.known?.purpose;
  L.push(purpose ? claim(purpose, 'respondido en la entrevista') : claim('Propósito sin determinar.', null));
  L.push('');
  L.push(claim(`Lenguaje: ${survey.stack?.language ?? 'no reconocido'}`, (survey.stack?.evidence || []).join(', ') || null));
  L.push(claim(`Ficheros: ${survey.fileCount}`, 'recorrido del repositorio'));
  if (survey.ci?.length) L.push(claim(`Integración continua: ${survey.ci.map((c) => c.file).join(', ')}`, survey.ci[0].file));
  L.push('');

  L.push('## Gates');
  L.push('');
  L.push('| Gate | Comando | Estado | De dónde sale |');
  L.push('|------|---------|--------|---------------|');
  for (const [name, g] of Object.entries(gates)) {
    const from = g.confirmed ? `${g.evidence}, confirmado` : g.evidence || '—';
    L.push(`| ${name} | ${g.run ? `\`${g.run}\`` : '—'} | ${g.status} | ${from} |`);
  }
  L.push('');
  L.push(net.safe ? `**Red de seguridad**: ${net.reason}` : `**Sin red de seguridad**: ${net.reason}`);
  L.push('');

  L.push('## Áreas');
  L.push('');
  if (areas.length === 0) L.push(claim('Ninguna área evidente; habrá que declararlas a mano.', null));
  else {
    L.push('| Área | Ficheros | Documento | Aparece entre los más tocados |');
    L.push('|------|----------|-----------|-------------------------------|');
    for (const a of areas) L.push(`| ${a.id} | \`${a.globs.join(', ')}\` | ${a.doc} | ${a.hotspotHits} |`);
  }
  L.push('');

  L.push('## Documentación que se va a crear');
  L.push('');
  for (const doc of ['ARCHITECTURE.md', 'CODEMAP.md', 'CONVENTIONS.md', 'ENVIRONMENT.md', 'GLOSSARY.md']) {
    L.push(`- \`docs/${doc}\`${fs.existsSync(path.join(ctx.root, 'docs', doc)) ? '  **ya existe: se escribirá al lado y se reportará**' : ''}`);
  }
  for (const a of areas) L.push(`- \`${a.doc}\` — desde la plantilla, para rellenar`);
  L.push('');

  L.push('## Backlog semilla');
  L.push('');
  if (seeds.length === 0) L.push('El código no admite nada pendiente: no se siembra ninguna tarea.');
  else {
    L.push(`${seeds.length} tarea(s), todas en \`backlog\` y sin refinar — marcarlas listas sería mentir sobre su estado.`);
    L.push('');
    for (const t of seeds.slice(0, 15)) L.push(`- **${t.type}** ${t.title}  \`[evidencia: ${t.evidence}]\``);
    if (seeds.length > 15) L.push(`- … y ${seeds.length - 15} más`);
  }
  L.push('');

  L.push('## Reorganización');
  L.push('');
  if (!layout) L.push('Perfil `as-is`: no se mueve ningún fichero.');
  else if (!net.safe) {
    L.push(`No se mueve nada: ${net.reason}.`);
    L.push('');
    L.push('La reorganización se emite como tareas del backlog, empezando por una para conseguir la red');
    L.push('de seguridad. Sin oráculo, mover un fichero no se distingue de romperlo.');
  } else {
    L.push(`Perfil \`${layout.id}\`: ${moves.length} movimiento(s) en lotes verificados contra la línea base.`);
    for (const m of moves.slice(0, 20)) L.push(`- \`${m.from}\` → \`${m.to}\`  (${m.rule})`);
    if (moves.length > 20) L.push(`- … y ${moves.length - 20} más`);
  }
  L.push('');

  const unverified = answers.unverified || [];
  L.push('## Lo que no se sabe');
  L.push('');
  if (unverified.length === 0) L.push('Nada pendiente: todo lo preguntado tiene respuesta.');
  else {
    L.push('Esto queda marcado como no verificado en la documentación, no rellenado por mí.');
    L.push('Cada línea lleva la marca literal que aparecerá en los documentos, para que se vea igual');
    L.push('aquí que allí:');
    L.push('');
    for (const u of unverified) {
      L.push(`- ${u.question}  ${UNVERIFIED}${u.note ? `  _(${u.note})_` : ''}`);
    }
  }
  L.push('');

  return L.join('\n');
}

export function writeProposal(ctx, input) {
  const body = renderProposal(ctx, input);
  writeFileIfChanged(proposalFile(ctx), body);
  return { file: toPosixPath(path.relative(ctx.root, proposalFile(ctx))), body };
}

/** Counts what a reader should judge the proposal by. */
export function proposalStats(body) {
  const evidenced = (body.match(/\[evidencia:/g) || []).length;
  const unverified = (body.match(/\[SIN VERIFICAR/g) || []).length;
  return { evidenced, unverified, total: evidenced + unverified };
}

export function answersFor(ctx, survey) {
  return findings(survey, loadAnswers(ctx));
}
