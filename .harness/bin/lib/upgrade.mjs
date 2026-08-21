// `harness upgrade` — moving a project from the harness version it adopted to this one.
//
// A project that adopted 1.0.0 and finds 1.2.0 has two options without this: redo the setup by
// hand, or stay behind forever. Both are how a template stops being used.
//
// Three properties make a migration safe to run, and all three are enforced here rather than
// left to whoever writes the next one:
//
//   1. **Idempotent.** Running it twice is running it once. A migration that appends is a
//      migration that corrupts on the second run, and the second run always happens — after an
//      interrupted upgrade, after a merge, after somebody re-runs it "just in case".
//   2. **Reports, never guesses.** Anything it cannot do deterministically becomes a line the
//      human has to act on, not a default it invented.
//   3. **In order, stopping at the first failure.** Migration 3 assumes 2 ran.
//
// A migration only ever touches `.harness/project.json` and the harness's own files. It never
// touches project code: that is what `restructure` is for, and it asks first.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, HARNESS_VERSION, c, fail, info, ok, readJson, say, warn, writeJson } from './util.mjs';

/** `1.2.3` -> `[1, 2, 3]`, so comparison is not string comparison. */
export function parseVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a) || [0, 0, 0];
  const pb = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Every migration, in order.
 *
 * `to` is the version the migration brings a project *up to*. `apply` receives the config and
 * the context and returns `{ changed, notes }` — `changed` false means there was nothing to do,
 * which is exactly what a second run must report.
 */
export const MIGRATIONS = [
  {
    to: '1.1.0',
    title: 'Declarar la política de automatismos y el umbral de frescura de documentos',
    apply(config) {
      const notes = [];
      let changed = false;

      // Both keys were added after 1.0.0. Absent means "never configured", which is different
      // from `false`: a project that deliberately turned hooks off keeps them off.
      if (config.hooks === undefined) {
        config.hooks = { enabled: true };
        notes.push('hooks.enabled = true — ejecuta `harness generate` para escribir los automatismos');
        changed = true;
      }
      if (config.doc_freshness_threshold === undefined) {
        config.doc_freshness_threshold = 15;
        notes.push('doc_freshness_threshold = 15 commits por área');
        changed = true;
      }
      return { changed, notes };
    },
    /** What the migration cannot do itself. Reported, never guessed. */
    manual(ctx) {
      const pending = [];
      for (const area of ctx.project.areas || []) {
        const doc = path.join(ctx.root, area.doc || `docs/areas/${area.id}.md`);
        if (fs.existsSync(doc) && !/^verified_commit:/m.test(fs.readFileSync(doc, 'utf8'))) {
          pending.push(`docs/areas/${area.id}.md no tiene marca de verificación: \`harness doc verified ${area.id}\``);
        }
      }
      return pending;
    },
  },
];

/** Which migrations a project still needs, given the version it records. */
export function pending(fromVersion, { target = HARNESS_VERSION } = {}) {
  return MIGRATIONS.filter(
    (m) => compareVersions(fromVersion, m.to) < 0 && compareVersions(m.to, target) <= 0,
  );
}

/**
 * @returns {{from:string, to:string, applied:Array, manual:string[], upToDate:boolean, ahead:boolean}}
 */
export function upgrade(ctx, { dryRun = false, target = HARNESS_VERSION } = {}) {
  const configPath = path.join(ctx.harnessDir, 'project.json');
  const config = readJson(configPath);
  const from = config.harness_version || '0.0.0';

  // A project recording a *newer* version than the CLI is a real situation — somebody pulled a
  // branch, or the shims are stale — and downgrading its config silently would be the worst
  // possible response.
  if (compareVersions(from, target) > 0) {
    return { from, to: target, applied: [], manual: [], upToDate: false, ahead: true };
  }

  const todo = pending(from, { target });
  const applied = [];
  const manual = [];

  for (const migration of todo) {
    const { changed, notes } = migration.apply(config, ctx);
    applied.push({ to: migration.to, title: migration.title, changed, notes });
    if (migration.manual) manual.push(...migration.manual(ctx));
  }

  const versionChanged = compareVersions(from, target) !== 0;
  if (!dryRun && (applied.some((a) => a.changed) || versionChanged)) {
    config.harness_version = target;
    writeJson(configPath, config);
  }

  return { from, to: target, applied, manual, upToDate: todo.length === 0 && !versionChanged, ahead: false };
}

export function printUpgrade(result) {
  if (result.ahead) {
    warn(`este proyecto declara la versión ${result.from} y el CLI es ${result.to}`);
    say(c.gray('   no se toca nada: bajar la versión de la configuración en silencio sería lo peor que podría hacer'));
    say(c.gray('   actualiza el CLI, o corrige harness_version a mano si sabes que está mal'));
    return;
  }
  if (result.upToDate) {
    ok(`ya en ${result.to}: nada que migrar`);
    return;
  }

  say(c.bold(`${result.from} → ${result.to}`));
  say('');
  for (const step of result.applied) {
    say(`${step.changed ? c.green('OK') : c.gray('..')} ${step.to}  ${step.title}`);
    for (const note of step.notes) say(c.gray(`     ${note}`));
    if (!step.changed) say(c.gray('     nada que hacer: ya estaba'));
  }

  if (result.manual.length) {
    say('');
    warn('lo que tienes que hacer tú:');
    for (const m of result.manual) say(`   - ${m}`);
  }
  say('');
  info('siguiente: `harness generate` y `harness doctor`');
}

/** The version this CLI is, and the version the project records. */
export function versions(ctx) {
  return {
    cli: HARNESS_VERSION,
    project: ctx.project.harness_version || null,
    pending: pending(ctx.project.harness_version || '0.0.0').map((m) => m.to),
  };
}

export function requireVersionMatch(ctx) {
  const v = versions(ctx);
  if (v.pending.length === 0) return;
  fail(
    `este proyecto está en ${v.project} y el harness es ${v.cli}: faltan ${v.pending.length} migración(es).\n` +
      '   Ejecuta `harness upgrade`.',
    EXIT.PRECONDITION,
  );
}
