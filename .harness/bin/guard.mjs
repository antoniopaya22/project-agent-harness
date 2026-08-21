#!/usr/bin/env node
// The hard rules, as something the provider *prevents* rather than something the agent
// remembers.
//
// Three of them were written in ENTRYPOINT.md, in CLAUDE.md and in every agent prompt, and
// nothing enforced any of them. A rule repeated in three places and enforced in none is not a
// rule, it is a hope — and this session alone produced two commits that broke one.
//
// This is the deterministic half: it reads a tool call on stdin, answers allow or deny, and
// knows nothing about which provider asked. The provider-specific wiring is generated from
// `.harness/project.json` into whatever format that provider wants.
//
// Contract, kept deliberately boring so any provider can use it:
//   stdin   JSON with { tool_name, tool_input: { file_path, ... } }
//   exit 0  allowed (and, for a deny-capable provider, a JSON verdict on stdout)
//   exit 2  blocked — stderr is the explanation the agent reads
//
// It never edits, never fixes and never writes. A guard that repairs what it was asked to
// block is a guard whose verdict nobody can trust.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GENERATED_MARK, findRoot, readJson, toPosixPath } from './lib/util.mjs';
import { plan } from './lib/generate.mjs';
import { validate } from './lib/schema.mjs';

const HEADER_SCAN_BYTES = 400;

/** Tools that write to a path, whatever the provider calls them. */
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|str_replace|create|apply_patch)$/i;

/** Does this file carry the generated header? Only the top of it is read. */
export function hasGeneratedHeader(root, relOrAbs) {
  const full = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
  if (!fs.existsSync(full)) return false;
  try {
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(HEADER_SCAN_BYTES);
    const read = fs.readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read).toString('utf8').includes(GENERATED_MARK);
  } catch {
    // Unreadable is not the same as generated. Guessing "yes" here would block edits to files
    // nobody can even open, which is a worse outcome than letting one through.
    return false;
  }
}

/**
 * Every path `harness generate` would write, asked of `generate` itself.
 *
 * The header was the first mechanism and it was a proxy: it only works on files that can hold
 * a comment, so a generated `settings.json` slipped straight through. The generator's own plan
 * is the authoritative answer to "would this be overwritten?", and it costs about twenty
 * milliseconds, which a hook can afford.
 *
 * The header is still checked as well, because a project can generate files this harness knows
 * nothing about, and one that says it is generated should be believed.
 */
export function generatedPaths(root) {
  try {
    const harnessDir = path.join(root, '.harness');
    const ctx = {
      root,
      harnessDir,
      project: readJson(path.join(harnessDir, 'project.json')),
      taskSchema: readJson(path.join(harnessDir, 'schema', 'task.schema.json')),
    };
    return new Set(plan(ctx).map((item) => toPosixPath(item.path)));
  } catch {
    // A guard that crashes blocks nothing, so a broken plan must not become a broken guard.
    // The header check below still covers everything that can carry one.
    return new Set();
  }
}

export function isGenerated(root, relOrAbs) {
  const rel = toPosixPath(path.relative(root, path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs)));
  return generatedPaths(root).has(rel) || hasGeneratedHeader(root, relOrAbs);
}

export function isTaskFile(root, filePath) {
  const rel = toPosixPath(path.relative(root, path.isAbsolute(filePath) ? filePath : path.join(root, filePath)));
  return /^\.harness\/backlog\/tasks\/[A-Z]+-\d{4}\.json$/.test(rel);
}

/**
 * @returns {{decision:'allow'|'deny', reason:string|null, rule:string|null}}
 */
export function verdict(root, { tool_name: tool, tool_input: input } = {}) {
  const filePath = input?.file_path || input?.path || input?.filePath;
  if (!filePath || !WRITE_TOOLS.test(String(tool || ''))) {
    return { decision: 'allow', reason: null, rule: null };
  }
  const rel = toPosixPath(path.relative(root, path.isAbsolute(filePath) ? filePath : path.join(root, filePath)));

  if (isGenerated(root, filePath)) {
    // Which of the two reasons applies is stated, not glossed. Telling somebody a JSON file
    // "carries the generated header" when JSON cannot hold a comment sends them looking for
    // something that is not there.
    const why = hasGeneratedHeader(root, filePath)
      ? `lleva la cabecera "${GENERATED_MARK}"`
      : '`harness generate` lo escribe (sale en su plan; este formato no puede llevar cabecera)';
    return {
      decision: 'deny',
      rule: 'generated-file',
      // The message says where the real source is, because "do not edit this" without that
      // leaves the agent to guess, and it will guess wrong in a plausible-looking way.
      reason:
        `${rel} está generado: ${why}. Editarlo se pierde en el siguiente \`harness generate\`.\n` +
        '   Edita la definición en .harness/ (agents/, commands/, ENTRYPOINT.md, project.json) y ejecuta `harness generate`.\n' +
        '   Si de verdad hace falta algo específico de un proveedor, va en .harness/overrides/<proveedor>/.',
    };
  }

  if (isTaskFile(root, filePath) && /^(Edit|MultiEdit|Write|str_replace)$/i.test(String(tool))) {
    return {
      decision: 'deny',
      rule: 'task-file',
      reason:
        `${rel} es un fichero de tarea: editarlo a mano se salta las guardas de transición y el esquema.\n` +
        '   Usa `harness task set-status|ac|edit|claim`, que validan antes de escribir.\n' +
        '   Para un campo sin subcomando, `harness task edit` y, si tampoco, di qué falta en lugar de escribirlo a mano.',
    };
  }

  return { decision: 'allow', reason: null, rule: null };
}

/**
 * After a task file changes, whatever wrote it: is it still valid?
 * Reported, not repaired. Fixing it here would hide the fact that something wrote an invalid
 * task, and that is the thing worth knowing.
 */
export function validateTaskFile(root, filePath) {
  const harnessDir = path.join(root, '.harness');
  const schemaFile = path.join(harnessDir, 'schema', 'task.schema.json');
  if (!fs.existsSync(schemaFile)) return { ok: true, problems: [] };
  const full = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  if (!fs.existsSync(full)) return { ok: true, problems: [] };
  try {
    const problems = validate(readJson(full), readJson(schemaFile)).map((e) => `${e.path || '(raíz)'}: ${e.message}`);
    return { ok: problems.length === 0, problems };
  } catch (e) {
    return { ok: false, problems: [`no se puede leer como JSON: ${e.message}`] };
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const mode = process.argv[2] || 'pre';
  const raw = readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // A payload we cannot parse is not grounds to block: the provider's format changed and
    // blocking every edit until somebody notices would be the worst possible failure mode.
    process.exit(0);
  }

  const root = findRoot(process.cwd());
  if (!root) process.exit(0);

  if (mode === 'post') {
    const filePath = payload.tool_input?.file_path || payload.tool_input?.path;
    if (!filePath || !isTaskFile(root, filePath)) process.exit(0);
    const { ok, problems } = validateTaskFile(root, filePath);
    if (ok) process.exit(0);
    process.stderr.write(
      `${toPosixPath(path.relative(root, filePath))} ya no cumple el esquema de tarea:\n` +
        problems.map((p) => `   - ${p}`).join('\n') +
        '\n   Arréglalo con `harness task ...` o revierte el fichero.\n',
    );
    process.exit(2);
  }

  const answer = verdict(root, payload);
  if (answer.decision === 'allow') process.exit(0);

  // Both shapes, on purpose: the JSON verdict for providers that read one, and exit 2 with
  // stderr for those that do not. Emitting only one would tie the guard to a single provider,
  // which is the thing this whole layer exists to avoid.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: answer.reason,
      },
    })}\n`,
  );
  process.stderr.write(`${answer.reason}\n`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
