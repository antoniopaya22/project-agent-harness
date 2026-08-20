// `harness init` — install the harness into a project that does not have it.
//
// The greenfield counterpart of /adopt. Everything it writes is either copied from this
// template or derived from evidence in the target directory; anything it cannot determine
// is left explicitly marked for a human rather than guessed, because a plausible invented
// purpose is worse than an obvious hole.

import fs from 'node:fs';
import path from 'node:path';
import { EXIT, HARNESS_VERSION, fail, listFiles, ok, say, toPosixPath, warn, writeFileIfChanged, writeJson } from './util.mjs';
import * as generate from './generate.mjs';
import { detectAreas, detectStack } from './survey.mjs';
import * as board from './board.mjs';

/** Directories and files copied verbatim from the template's .harness/. */
const COPY = [
  'ENTRYPOINT.md',
  'schema',
  'agents',
  'commands',
  'includes',
  'layouts',
  'templates',
];

/** Never copied: they belong to the template's own project, not to yours. */
const NEVER_COPY = ['backlog', 'workspace', 'project.json', '.cache', 'adoption', 'overrides', 'integrations'];

export const NEEDS_HUMAN = '[RELLENAR]';

// La detección vive en survey.mjs: init y /adopt tienen que ver exactamente lo mismo.
export { detectAreas, detectStack };


function copyTree(from, to, report) {
  if (!fs.existsSync(from)) return;
  if (fs.statSync(from).isDirectory()) {
    for (const entry of fs.readdirSync(from)) {
      if (NEVER_COPY.includes(entry)) continue;
      copyTree(path.join(from, entry), path.join(to, entry), report);
    }
    return;
  }
  // Never overwrite: an existing file is somebody's decision.
  if (fs.existsSync(to)) {
    report.skipped.push(to);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  report.written.push(to);
}

/**
 * @param {string} templateRoot the harness template to install from (this repository)
 * @param {string} target the project to install into
 */
export function initProject(templateRoot, target, { name, purpose, language = 'es', layout = 'as-is', force = false } = {}) {
  const targetHarness = path.join(target, '.harness');
  if (fs.existsSync(path.join(targetHarness, 'project.json')) && !force) {
    fail(
      `${toPosixPath(path.relative(target, path.join(targetHarness, 'project.json')))} already exists — this project has a harness.\n` +
        '   Use `harness doctor` to check it, or --force to install missing pieces alongside it.',
      EXIT.PRECONDITION,
    );
  }

  const report = { written: [], skipped: [], unresolved: [] };

  for (const entry of COPY) {
    copyTree(path.join(templateRoot, '.harness', entry), path.join(targetHarness, entry), report);
  }
  for (const shim of ['harness', 'harness.ps1', 'harness.cmd']) {
    copyTree(path.join(templateRoot, shim), path.join(target, shim), report);
  }
  copyTree(path.join(templateRoot, '.harness', 'bin'), path.join(targetHarness, 'bin'), report);

  const stack = detectStack(target);
  const areas = detectAreas(target);
  if (areas.length === 0) areas.push({ id: 'core', globs: ['src/**'] });

  const gates = {};
  for (const gate of ['format', 'lint', 'typecheck', 'test', 'build', 'start']) {
    const found = stack.gates[gate];
    gates[gate] = found
      ? { run: found.run, required: gate === 'lint' || gate === 'test', status: 'configured' }
      : { run: null, required: false, status: 'not-configured' };
  }

  const config = {
    $schema: './schema/project.schema.json',
    harness_version: HARNESS_VERSION,
    project: {
      name: name || path.basename(path.resolve(target)),
      purpose: purpose || `${NEEDS_HUMAN} Un párrafo: para qué existe este proyecto y quién lo usa. Nadie puede deducirlo del código, y un propósito inventado es peor que un hueco visible.`,
      output_language: language,
    },
    git: {
      default_branch: 'main',
      protected_branches: ['main', 'master', 'develop'],
      commit_scopes: areas.map((a) => a.id),
      auto_pr: 'ready',
    },
    gates,
    areas: areas.map((a) => ({ id: a.id, globs: a.globs, doc: `docs/areas/${a.id}.md` })),
    layout,
    providers: { claude: true, agents_md: true, cursor: false, copilot: false },
    integrations: { clickup: { enabled: false, list_id: null, custom_fields: {}, users: {} } },
    packages: [],
    implement: { max_verify_loops: 2 },
    read_path: [
      { path: '.harness/ENTRYPOINT.md', max_tokens: 1800 },
      { path: '.harness/backlog/tasks/{task}.json', max_tokens: 1200 },
      { path: '.harness/project.json', max_tokens: 1200 },
      { path: 'docs/areas/{area}.md', max_tokens: 2000 },
    ],
    read_path_total_max_tokens: 6500,
  };

  const configPath = path.join(targetHarness, 'project.json');
  if (fs.existsSync(configPath) && !force) report.skipped.push(configPath);
  else {
    writeJson(configPath, config);
    report.written.push(configPath);
  }

  // An area without its doc makes doctor fail, which is the right order: the doc is the
  // read path, so the harness should not look healthy until it exists.
  const areaTemplate = path.join(templateRoot, '.harness', 'templates', 'area.md');
  for (const area of config.areas) {
    const doc = path.join(target, area.doc);
    if (fs.existsSync(doc)) {
      report.skipped.push(doc);
      continue;
    }
    const body = fs.existsSync(areaTemplate) ? fs.readFileSync(areaTemplate, 'utf8') : '# Área\n';
    writeFileIfChanged(doc, body.replace('area: <id>', `area: ${area.id}`).replace('# Área: <nombre>', `# Área: ${area.id}`));
    report.written.push(doc);
    report.unresolved.push(`${area.doc} está sin rellenar`);
  }

  for (const dir of ['backlog/tasks', 'backlog/worklog', 'workspace', 'overrides']) {
    fs.mkdirSync(path.join(targetHarness, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(target, 'docs', 'adr'), { recursive: true });

  if (!purpose) report.unresolved.push('project.purpose sigue marcado para rellenar');
  const missingGates = Object.entries(gates).filter(([, g]) => g.status === 'not-configured').map(([n]) => n);
  if (missingGates.length) report.unresolved.push(`gates sin configurar: ${missingGates.join(', ')}`);

  // One command must leave a project whose self-check is green, otherwise the first thing a
  // newcomer sees is a wall of errors about files the installer could have written itself.
  const newCtx = {
    root: target,
    harnessDir: targetHarness,
    project: config,
    taskSchema: JSON.parse(fs.readFileSync(path.join(targetHarness, 'schema', 'task.schema.json'), 'utf8')),
  };
  for (const p of generate.apply(newCtx)) report.written.push(path.join(target, p));
  board.regenerate(newCtx);

  return { report, config, stack, areas: config.areas };
}

export function printInitReport(target, { report, config, stack }) {
  ok(`harness ${HARNESS_VERSION} instalado en ${toPosixPath(path.relative(process.cwd(), target)) || '.'}`);
  say(`   ${report.written.length} fichero(s) escritos, ${report.skipped.length} respetados por existir ya`);
  say(`   stack detectado: ${stack.language || 'desconocido'}${stack.evidence.length ? ` (${stack.evidence.join(', ')})` : ''}`);
  say(`   áreas: ${config.areas.map((a) => a.id).join(', ')}`);
  const configured = Object.entries(config.gates).filter(([, g]) => g.status === 'configured');
  say(`   gates con evidencia: ${configured.length ? configured.map(([n]) => n).join(', ') : 'ninguno'}`);
  if (report.unresolved.length) {
    say('');
    warn('lo que tienes que rellenar tú:');
    for (const u of report.unresolved) say(`   - ${u}`);
  }
  say('');
  say('   siguiente: rellena lo anterior y ejecuta `harness doctor`, luego `harness generate`');
}

/** Files a freshly initialised project must not have inherited from the template. */
export function leakedFromTemplate(target) {
  const leaked = [];
  const tasks = path.join(target, '.harness', 'backlog', 'tasks');
  if (listFiles(tasks, '.json').length > 0) leaked.push('.harness/backlog/tasks is not empty');
  for (const entry of NEVER_COPY) {
    if (entry === 'backlog' || entry === 'project.json') continue;
    if (fs.existsSync(path.join(target, '.harness', entry)) && ['adoption', '.cache'].includes(entry)) {
      leaked.push(`.harness/${entry} came from the template`);
    }
  }
  return leaked;
}
