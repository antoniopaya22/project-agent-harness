// Shared plumbing: locating the harness, reading/writing JSON, and consistent output.
// Zero dependencies by design (see D2 in docs/HARNESS-PLAN.md).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const HARNESS_VERSION = '1.0.0';

/** Exit codes are part of the CLI contract: hooks and CI branch on them. */
export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1, // something the user must fix (invalid task, red gate, drift)
  USAGE: 2, // wrong invocation
  PRECONDITION: 3, // refused: dirty tree, illegal transition, protected branch
  NOT_FOUND: 4,
};

const noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
const paint = (code) => (s) => (noColor ? String(s) : `[${code}m${s}[0m`);

export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  cyan: paint(36),
  gray: paint(90),
};

export const SYM = { ok: 'OK', bad: 'XX', warn: '!!', info: '--', skip: '..' };

export function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}
export function ok(msg) {
  say(`${c.green(SYM.ok)} ${msg}`);
}
export function bad(msg) {
  say(`${c.red(SYM.bad)} ${msg}`);
}
export function warn(msg) {
  say(`${c.yellow(SYM.warn)} ${msg}`);
}
export function info(msg) {
  say(`${c.gray(SYM.info)} ${msg}`);
}

export class HarnessError extends Error {
  constructor(message, code = EXIT.PRECONDITION, details = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function fail(message, code = EXIT.PRECONDITION, details = []) {
  throw new HarnessError(message, code, details);
}

/** Walk up from `start` looking for `.harness/project.json`. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.harness', 'project.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read ${file}: ${e.code || e.message}`, EXIT.NOT_FOUND);
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    fail(`${file} is not valid JSON: ${e.message}`, EXIT.CHECK_FAILED);
  }
}

/**
 * Deterministic write: 2-space indent, trailing newline, LF endings.
 * Byte-stability matters because `generate --check` and `index` compare output.
 */
export function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`.replace(/\r\n/g, '\n');
  writeFileIfChanged(file, text);
}

export function writeFileIfChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = text.replace(/\r\n/g, '\n');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === normalized) {
    return false;
  }
  fs.writeFileSync(file, normalized, 'utf8');
  return true;
}

export function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !ext || f.endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function countLines(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** Minimal glob: supports **, * and ?. Enough for area globs and never_move lists. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; bare `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath, globs = []) {
  const p = relPath.split(path.sep).join('/');
  return globs.some((g) => globToRegExp(g).test(p));
}

/**
 * Parse `--flag`, `--key value`, `--key=value` and positionals.
 * A flag given more than once accumulates into an array, so `--file a --file b` keeps
 * both. Silently keeping only the last one loses data the caller believed it passed.
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  const set = (key, value) => {
    if (!(key in flags)) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        // A value that itself begins with `--` must be passed as --key=value.
        if (next !== undefined && !next.startsWith('--')) {
          set(a.slice(2), next);
          i += 1;
        } else {
          set(a.slice(2), true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Minimal YAML front-matter reader. Supports scalars, inline `[a, b]` arrays and
 * block `- item` arrays — which is exactly what agent and command definitions use.
 * Anything richer is a signal the definition format is drifting.
 */
export function parseFrontMatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const data = {};
  let currentKey = null;
  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(scalar(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;
    currentKey = key;
    if (rest === '') {
      data[key] = [];
    } else if (rest.startsWith('[')) {
      data[key] = rest
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((s) => scalar(s.trim()))
        .filter((s) => s !== '');
    } else {
      data[key] = scalar(rest);
    }
  }
  return { data, body };
}

function scalar(v) {
  const s = v.trim().replace(/^["'](.*)["']$/, '$1');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function serializeFrontMatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: ${v.join(', ')}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function table(rows, headers) {
  if (rows.length === 0) return '';
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells, painter = (s) => s) =>
    cells
      .map((cell, i) => painter(String(cell ?? '').padEnd(i === cols - 1 ? 0 : widths[i])))
      .join('  ')
      .trimEnd();
  return [line(headers, c.bold), ...rows.map((r) => line(r))].join('\n');
}

export function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export const GENERATED_MARK = 'GENERATED by harness';

export function generatedHeader(sourceLabel, comment = 'html') {
  const text = `${GENERATED_MARK} v${HARNESS_VERSION} from ${sourceLabel} — do not edit; run \`harness generate\``;
  if (comment === 'html') return `<!-- ${text} -->`;
  return `# ${text}`;
}
