// The adoption commands: taking a project that already exists and leaving it usable.
//
// Split out of harness.mjs because they are a phase of their own — init, survey, interview,
// propose, apply, layouts, restructure — and the dispatcher stays readable when a phase
// lives in one file.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { EXIT, bad, c, fail, info, ok, say, table, warn } from './util.mjs';
import * as surveyLib from './survey.mjs';
import * as layoutsLib from './layouts.mjs';
import * as restructureLib from './restructure.mjs';
import * as interviewLib from './interview.mjs';
import * as proposalLib from './proposal.mjs';
import * as applyLib from './apply.mjs';
import * as init from './init.mjs';

/** Markdown fence, kept as a constant so writing it never fights with template literals. */
const FENCE = "```";

export const commands = {};

commands.init = (_unused, { positional, flags }) => {
  const target = path.resolve(positional[0] || process.cwd());
  // The template is the repository this CLI lives in: .harness/bin/lib/ -> repo root.
  const templateRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  if (!fs.existsSync(path.join(templateRoot, '.harness', 'ENTRYPOINT.md'))) {
    fail('cannot locate the harness template to install from', EXIT.NOT_FOUND);
  }
  if (!fs.existsSync(target)) fail(`${target} does not exist`, EXIT.NOT_FOUND);
  if (path.resolve(templateRoot) === target) {
    fail('refusing to initialise the template into itself', EXIT.PRECONDITION);
  }

  const result = init.initProject(templateRoot, target, {
    name: typeof flags.name === 'string' ? flags.name : null,
    purpose: typeof flags.purpose === 'string' ? flags.purpose : null,
    language: typeof flags.language === 'string' ? flags.language : 'es',
    layout: typeof flags.layout === 'string' ? flags.layout : 'as-is',
    force: Boolean(flags.force),
  });
  if (flags.json) {
    say(JSON.stringify(result, null, 2));
    return EXIT.OK;
  }
  init.printInitReport(target, result);
  return EXIT.OK;
};

commands.survey = (ctx, { positional, flags }) => {
  const target = path.resolve(positional[0] || ctx.root);
  const result = surveyLib.survey(target);
  if (flags.baseline) {
    // Separate and opt-in: unlike the rest of the survey, this executes the project's own
    // tooling, which can leave artefacts that are not ours to create.
    result.baseline = surveyLib.gateBaseline(target, result.stack);
    result.safetyNet = surveyLib.hasSafetyNet(result.baseline);
  }
  if (flags.json) {
    say(JSON.stringify(result, null, 2));
    return EXIT.OK;
  }
  say(c.bold(`${result.root}`) + c.gray(`  ${result.fileCount} ficheros${result.isGitRepo ? '' : '  (sin git)'}`));
  say('');
  say(`${c.bold('stack')}      ${result.stack.language || c.yellow('no reconocido')}${result.stack.packageManager ? c.gray(`  ·  ${result.stack.packageManager}`) : ''}`);
  const gates = Object.entries(result.stack.gates);
  say(`${c.bold('gates')}      ${gates.length ? '' : c.yellow('ninguno con evidencia')}`);
  for (const [name, g] of gates) say(`  ${name.padEnd(10)} ${g.run}${c.gray(`   [${g.evidence}]`)}`);
  say(`${c.bold('areas')}      ${result.areas.map((a) => a.id).join(', ') || c.yellow('ninguna evidente')}`);
  say(`${c.bold('ci')}         ${result.ci.map((x) => x.file).join(', ') || c.gray('ninguna')}`);
  say(`${c.bold('docs')}       ${result.docs.length} ficheros markdown`);
  say(`${c.bold('pendientes')} ${result.pending.length} marcas TODO/FIXME`);
  if (result.existingHarness) {
    say('');
    warn(`este proyecto ya tiene harness v${result.existingHarness.version}: ${result.existingHarness.gates.join(', ') || 'sin gates'}`);
    say(c.gray('   adoptarlo otra vez no es lo que quieres; usa `harness doctor`.'));
  }
  if (result.hotspots.length) {
    say('');
    say(c.bold('Más tocados'));
    say(table(result.hotspots.slice(0, 8).map((x) => [String(x.touches), x.file]), ['COMMITS', 'FICHERO']));
  }
  if (result.baseline) {
    say('');
    say(c.bold('Línea base'));
    for (const [name, b] of Object.entries(result.baseline)) {
      const mark = b.state === 'pass' ? c.green('PASS') : c.red(b.state.toUpperCase());
      say(`  ${mark} ${name.padEnd(10)} ${c.gray(b.command)}`);
    }
    say('');
    if (result.safetyNet.safe) ok(`Red de seguridad: ${result.safetyNet.reason}`);
    else bad(`Sin red de seguridad: ${result.safetyNet.reason}`);
  }
  return EXIT.OK;
};

commands.interview = (ctx, { positional, flags }) => {
  const target = path.resolve(positional[0] || ctx.root);
  const surveyed = surveyLib.survey(target);
  const answerCtx = { root: target, harnessDir: path.join(target, '.harness') };

  // Recording an answer and asking the next round are the same command on purpose: an
  // agent that has to remember a second command to persist what it just heard will forget.
  const answers = [].concat(flags.answer ?? []).filter((x) => typeof x === 'string');
  const unknowns = [].concat(flags.unknown ?? []).filter((x) => typeof x === 'string');
  for (const pair of answers) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`--answer expects id=valor, got "${pair}"`, EXIT.USAGE);
    interviewLib.recordAnswer(answerCtx, pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const id of unknowns) interviewLib.recordAnswer(answerCtx, id, null, { unknown: true });

  const state = interviewLib.loadAnswers(answerCtx);
  const rounds = interviewLib.pendingRounds(surveyed, state);
  const progress = interviewLib.progress(surveyed, state);

  if (flags.json) {
    say(JSON.stringify({ progress, round: rounds[0] ?? [], remainingRounds: rounds.length }, null, 2));
    return progress.complete ? EXIT.OK : EXIT.PRECONDITION;
  }

  say(c.bold('Entrevista de adopción') + c.gray(`  ${progress.answered} respondidas · ${progress.unknown} sin saber · ${progress.outstanding} pendientes`));
  say('');
  if (progress.complete) {
    ok('no queda nada por preguntar: ya se puede proponer');
    return EXIT.OK;
  }

  // One round at a time, because a wall of questions is a wall nobody answers.
  for (const q of rounds[0]) {
    say(`${c.bold(q.id)}  ${q.question}`);
    if (q.kind === 'confirm') say(c.gray(`   inferido: ${JSON.stringify(q.inferred)}   [${q.evidence}]`));
    else say(c.gray(`   por qué importa: ${q.why}`));
    say('');
  }
  info(`registra con: harness interview --answer <id>=<valor> --unknown <id>   (${rounds.length} ronda(s) por delante)`);
  // Exit 3, not 0: the interview being unfinished is a precondition for proposing, and a
  // caller that ignores it would propose from holes.
  return EXIT.PRECONDITION;
};

commands.propose = (ctx, { positional, flags }) => {
  const target = path.resolve(positional[0] || ctx.root);
  const surveyed = surveyLib.survey(target);
  const answerCtx = { root: target, harnessDir: path.join(target, '.harness') };
  const state = interviewLib.loadAnswers(answerCtx);
  const progress = interviewLib.progress(surveyed, state);

  if (!progress.complete && !flags.force) {
    fail(
      `quedan ${progress.outstanding} pregunta(s) sin resolver: proponer ahora inventa esas partes.\n` +
        '   sigue con `harness interview`, o usa --force para proponer con los huecos marcados.',
      EXIT.PRECONDITION,
    );
  }

  const baseline = flags.baseline ? surveyLib.gateBaseline(target, surveyed.stack) : null;
  const layout = layoutsLib.loadLayout(ctx, typeof flags.layout === 'string' ? flags.layout : undefined);
  const moves = layout ? restructureLib.planMoves(target, layout) : [];
  const answers = interviewLib.findings(surveyed, state);

  const { file, body } = proposalLib.writeProposal(answerCtx, { survey: surveyed, baseline, answers, layout, moves });
  const stats = proposalLib.proposalStats(body);

  if (flags.json) {
    say(JSON.stringify({ file, ...stats }, null, 2));
    return EXIT.OK;
  }
  ok(`propuesta escrita en ${file}`);
  say(c.gray(`   ${stats.evidenced} afirmación(es) con evidencia · ${stats.unverified} sin verificar`));
  say('');
  info('nada más se ha escrito. El humano la corrige y se vuelve a proponer: ese bucle es el punto.');
  return EXIT.OK;
};

commands.apply = (ctx, { positional, flags }) => {
  const target = path.resolve(positional[0] || ctx.root);
  if (!fs.existsSync(path.join(target, '.harness', 'project.json'))) {
    fail('este proyecto no tiene harness todavía: ejecuta `harness init` antes', EXIT.PRECONDITION);
  }
  const surveyed = surveyLib.survey(target);
  const result = applyLib.applyAdoption(target, surveyed, {
    seed: !flags['no-seed'],
    verify: !flags['no-verify'],
  });

  if (flags.json) {
    say(JSON.stringify({ seeded: result.seeded, downgraded: result.downgraded }, null, 2));
    return result.downgraded.length ? EXIT.CHECK_FAILED : EXIT.OK;
  }
  applyLib.printApplyReport(result);
  say('');
  info('siguiente: `harness generate` y `harness doctor`');
  // Exit 1 when something was downgraded: a caller chaining commands has to know the
  // configuration it just wrote is not the one it asked for.
  return result.downgraded.length ? EXIT.CHECK_FAILED : EXIT.OK;
};

commands.layouts = (ctx, { positional, flags }) => {
  const requested = positional[0];
  if (requested) {
    const layout = layoutsLib.loadLayout(ctx, requested);
    say(flags.json ? JSON.stringify(layout, null, 2) : layoutsLib.summarise(layout));
    return EXIT.OK;
  }
  const rows = [...layoutsLib.availableLayouts(ctx), layoutsLib.AS_IS].map((id) => {
    if (id === layoutsLib.AS_IS) return [id, 'no mueve ningún fichero'];
    return [id, layoutsLib.summarise(layoutsLib.loadLayout(ctx, id))];
  });
  say(table(rows, ['LAYOUT', 'ESTRUCTURA DESTINO']));
  say('');
  info(`este proyecto usa: ${ctx.project.layout || layoutsLib.AS_IS}`);
  return EXIT.OK;
};

commands.restructure = (ctx, { positional, flags }) => {
  const target = path.resolve(positional[0] || ctx.root);
  const layout = layoutsLib.loadLayout(ctx, typeof flags.layout === 'string' ? flags.layout : undefined);
  if (!layout) {
    info(`layout "${ctx.project.layout || layoutsLib.AS_IS}": no se mueve ningún fichero. Declara otro perfil para reorganizar.`);
    return EXIT.OK;
  }

  // The oracle has to exist before anything moves, so it is taken here rather than trusted.
  const stack = surveyLib.detectStack(target);
  const baseline = surveyLib.gateBaseline(target, stack);
  const safetyNet = surveyLib.hasSafetyNet(baseline);
  say(c.bold('Línea base'));
  for (const [name, b] of Object.entries(baseline)) {
    say(`  ${b.state === 'pass' ? c.green('PASS') : c.red(b.state.toUpperCase())} ${name.padEnd(10)} ${c.gray(b.command)}`);
  }
  if (Object.keys(baseline).length === 0) say(c.gray('  (ningún gate con evidencia)'));
  say('');

  const result = restructureLib.restructure(ctx, target, {
    layout,
    baseline,
    safetyNet,
    dryRun: Boolean(flags['dry-run']),
    batchSize: flags.batch ? Number(flags.batch) : 10,
    packageName: typeof flags.package === 'string' ? flags.package : null,
  });
  restructureLib.printReport(result);

  if (flags['dry-run'] && result.report.length) {
    const planFile = path.join(ctx.harnessDir, 'adoption', 'RESTRUCTURE-PLAN.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    const body = ['# Plan de reorganización', '', FENCE, ...result.report, FENCE, ''].join('\n');
    fs.writeFileSync(planFile, body, 'utf8');
    say('');
    ok(`plan escrito en ${path.relative(ctx.root, planFile)}`);
  }

  // Condition 4: whatever survived becomes one commit, so reverting is one command.
  if (!flags['dry-run'] && result.commits > 1) {
    restructureLib.squashInto(ctx, result.commits, 'chore(restructure): mover el código al layout declarado');
    ok('lotes combinados en un único commit revertible');
  }

  if (result.aborted?.asTasks) {
    say('');
    info('tareas que emitir en su lugar:');
    for (const t of restructureLib.movesAsTasks(restructureLib.planMoves(target, layout), safetyNet)) {
      say(`   ${t.type.padEnd(9)} ${t.title}`);
    }
    return EXIT.PRECONDITION;
  }
  return result.aborted ? EXIT.CHECK_FAILED : EXIT.OK;
};
