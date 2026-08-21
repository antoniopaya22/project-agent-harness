// Shared plumbing: locating the harness, reading/writing JSON, and consistent output.
// Zero dependencies by design (see D2 in docs/HARNESS-PLAN.md).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const HARNESS_VERSION = '1.1.0';

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

/**
 * Approximate token count: characters / 4.
 *
 * Deliberately an estimate, and deliberately not lines. Lines are a bad proxy and they
 * rank wrongly: in this repository a 153-line project.json costs ~914 tokens while a
 * 132-line area doc costs ~1638 — fewer lines, 79% more context. Budgeting in lines
 * therefore protects the wrong files.
 *
 * chars/4 is the usual rule of thumb. It runs perhaps 20% low on dense JSON and code,
 * where punctuation tokenises poorly, so budgets are set with headroom rather than
 * pretending this is exact. A real tokeniser would mean a dependency, which the harness
 * does not take (D2), and would not change any decision this number drives.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

export function countTokens(file) {
  if (!fs.existsSync(file)) return null;
  return estimateTokens(fs.readFileSync(file, 'utf8'));
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

/**
 * Globs are always written with `/`, so a path is normalised to `/` before matching.
 * Note this converts backslashes unconditionally rather than using `path.sep`: on POSIX
 * `path.sep` is already `/`, so a Windows-style path handed to a POSIX process would go
 * unnormalised and silently fail to match. Every path reaching here is repo-relative,
 * from `path.relative` or from git, so no legitimate filename contains a backslash.
 */
export function toPosixPath(p) {
  return String(p).split('\\').join('/');
}

export function matchesAny(relPath, globs = []) {
  const p = toPosixPath(relPath);
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

/** Flags every command accepts, so a subcommand only has to declare its own. */
export const GLOBAL_FLAGS = ['as', 'json', 'quiet', 'force', 'help'];

/**
 * Refuses a flag nobody reads.
 *
 * `parseArgs` collects whatever it is given, so a misspelling — or a flag that simply does not
 * exist — used to be dropped without a word. That is how eight acceptance criteria in this
 * repository ended up recorded with `--note`, which nothing consumes: the command printed OK,
 * the evidence went nowhere, and the criteria read as verified.
 *
 * The failure is silent, which is what makes it worth an exit code. A typo costs one retry; a
 * flag that vanishes costs whatever was riding on it.
 */
export function rejectUnknownFlags(flags, known, usage) {
  const allowed = new Set([...known, ...GLOBAL_FLAGS]);
  const unknown = Object.keys(flags).filter((f) => !allowed.has(f));
  if (unknown.length === 0) return;
  const near = (bad) => {
    // Only an obvious neighbour is suggested. A wrong guess reads as authoritative and sends
    // somebody down the wrong path, which is worse than no suggestion at all.
    const hit = [...allowed].find((k) => k.startsWith(bad.slice(0, 3)) || bad.startsWith(k.slice(0, 3)));
    return hit ? ` (¿querías --${hit}?)` : '';
  };
  fail(
    `flag${unknown.length > 1 ? 's' : ''} desconocida${unknown.length > 1 ? 's' : ''}: ` +
      unknown.map((f) => `--${f}${near(f)}`).join(', ') +
      `\n   ${usage}`,
    EXIT.USAGE,
  );
}
