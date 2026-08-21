// The anti-rot commands: keeping the documentation honest.
//
// `doc` answers "is this area document still true?" and `read-log` answers "was the grooming
// any good?". Both exist because the harness makes claims about documentation that nothing
// used to check, and both live here rather than in the dispatcher because they are a concern
// of their own.

import { EXIT, c, fail, info, ok, say, table } from './util.mjs';
import * as tasksLib from './tasks.mjs';
import * as freshness from './freshness.mjs';
import * as feedback from './feedback.mjs';

export const commands = {};

commands.doc = (ctx, { positional, flags }) => {
  const sub = positional[0];
  if (sub === 'verified') {
    const area = positional[1];
    if (!area) fail('usage: harness doc verified <AREA> [--commit sha]', EXIT.USAGE);
    const result = freshness.stampVerified(ctx, area, {
      commit: typeof flags.commit === 'string' ? flags.commit : null,
    });
    if (!result.ok) fail(result.reason, EXIT.NOT_FOUND);
    ok(`${result.doc} sellado contra ${result.commit}`);
    say(c.gray('   la marca dice "alguien leyó esto contra este commit", no "esto es correcto"'));
    return EXIT.OK;
  }

  if (sub && sub !== 'freshness') fail(`unknown subcommand "${sub}" (freshness | verified)`, EXIT.USAGE);

  const rows = freshness.areaFreshness(ctx, {
    threshold: flags.threshold ? Number(flags.threshold) : null,
  });
  if (flags.json) {
    say(JSON.stringify(rows, null, 2));
    return EXIT.OK;
  }
  const groups = freshness.summarise(rows);
  say(
    table(
      rows.map((r) => [
        r.area,
        r.verified || c.yellow('nunca'),
        r.commits == null ? c.gray('?') : String(r.commits),
        r.stale ? c.red('obsoleto') : r.verified ? c.green('al día') : c.yellow('sin verificar'),
      ]),
      ['ÁREA', 'VERIFICADO EN', 'COMMITS DESDE', 'ESTADO'],
    ),
  );
  const needy = [...groups.never, ...groups.stale, ...groups.unresolvable];
  if (needy.length) {
    say('');
    for (const r of needy) say(`${c.bold(r.area)}\n   ${r.action}`);
  }
  // Exit 1 only for documents that were verified and have gone stale. One nobody has ever
  // read is a starting condition, not a regression, and failing a build over it on day one
  // would teach everybody to ignore this check.
  return groups.stale.length ? EXIT.CHECK_FAILED : EXIT.OK;
};

commands['read-log'] = (ctx, { positional, flags }) => {
  const sub = positional[0] || 'report';

  if (sub === 'add') {
    const id = positional[1];
    if (!id) fail('usage: harness read-log add <TASK-ID> --file <path> [--file <path>] [--note "..."]', EXIT.USAGE);
    const task = tasksLib.load(ctx, id);
    const files = [].concat(flags.file ?? []).filter((f) => typeof f === 'string');
    if (files.length === 0) fail('pass at least one --file: what did you have to read that the task did not name?', EXIT.USAGE);

    // Only the readings the task failed to predict are evidence. Recording the ones it did
    // name would drown the signal in the thing that already worked.
    const beyond = feedback.unexpected(ctx, task, files);
    const predicted = files.length - beyond.length;
    if (beyond.length === 0) {
      ok(`nada que registrar: los ${predicted} fichero(s) ya estaban en el camino de lectura`);
      return EXIT.OK;
    }
    const rows = feedback.record(ctx, task.id, beyond, {
      area: task.context?.area ?? null,
      note: typeof flags.note === 'string' ? flags.note : null,
    });
    ok(`${rows.length} lectura(s) fuera de lo previsto registradas para ${task.id}`);
    if (predicted) say(c.gray(`   ${predicted} ya estaban previstas y no cuentan`));
    for (const r of rows) say(c.gray(`   ${r.file}`));
    return EXIT.OK;
  }

  if (sub !== 'report') fail(`unknown subcommand "${sub}" (add | report)`, EXIT.USAGE);

  const report = feedback.aggregate(ctx);
  const findings = feedback.diagnose(report);
  if (flags.json) {
    say(JSON.stringify({ ...report, findings }, null, 2));
    return EXIT.OK;
  }

  if (report.total === 0) {
    info('nada registrado todavía: usa `harness read-log add <ID> --file <ruta>` al implementar');
    say(c.gray('   sin este dato, que un buen refinamiento acorte el camino de lectura sigue siendo una creencia'));
    return EXIT.OK;
  }

  say(c.bold(`${report.total} lectura(s) fuera de lo previsto en ${report.taskCount} tarea(s)`));
  if (!report.confident) {
    say(c.yellow(`   con ${report.taskCount} tarea(s) esto es una anécdota, no una medida. Hacen falta ~20.`));
  }
  say('');
  say(
    table(
      report.areas.map((a) => [a.area, String(a.readings), String(a.tasks), String(a.perTask), a.verdict]),
      ['ÁREA', 'LECTURAS', 'TAREAS', 'POR TAREA', 'VEREDICTO'],
    ),
  );

  if (findings.length === 0) {
    say('');
    ok('ningún patrón: ni documentación insuficiente ni tareas mal refinadas');
    return EXIT.OK;
  }
  say('');
  for (const f of findings) {
    say(`${c.bold(f.subject)}  ${f.kind === 'documentacion-insuficiente' ? c.yellow(f.kind) : c.red(f.kind)}`);
    say(c.gray(`   ${f.why}`));
    for (const e of f.evidence) say(c.gray(`   · ${e}`));
    say(`   ${f.action}`);
    say('');
  }
  // Always 0: this is diagnostics about how well people are grooming, and a report that can
  // fail a build gets switched off long before it has enough data to say anything.
  return EXIT.OK;
};
