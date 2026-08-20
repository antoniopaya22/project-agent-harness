// Rewriting what pointed at the old place.
//
// Moving files is the easy half. The half that breaks a project silently is everything that
// referenced them: imports, packaging metadata, test discovery, coverage config, container
// build steps, CI paths. A `git mv` with clean imports and a stale `testpaths` leaves a
// project that looks fine and runs nothing.
//
// This is textual rewriting, and textual rewriting misses things. That is not a defect to
// hide: it is why the gate baseline is the oracle and why nothing here is trusted without
// running the gates afterwards. Every file touched is reported by name so a human can read
// the diff.

import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp, toPosixPath } from './util.mjs';

/** @typedef {{from: string, to: string}} Move */

const SOURCE_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function moduleOf(relPath) {
  return toPosixPath(relPath).replace(/\.py$/, '').split('/').join('.');
}

/**
 * Python: an absolute import of a module that moved into a package has to gain the package
 * prefix. Relative imports inside a subtree that moved together are unaffected, which is
 * why only top-level module names are rewritten here.
 */
export function pythonImportRewrites(moves, { packageName } = {}) {
  const rules = [];
  for (const move of moves) {
    const fromMod = moduleOf(move.from);
    const toMod = moduleOf(move.to);
    if (fromMod === toMod) continue;
    // `src/` is a packaging root, not part of the import path.
    const target = toMod.replace(/^src\./, '');
    const source = fromMod.replace(/^src\./, '');
    if (source === target) continue;
    rules.push({
      re: new RegExp(`(^\\s*(?:import|from)\\s+)${escapeRe(source)}(?=[\\s.,)]|$)`, 'gm'),
      replacement: `$1${packageName && !target.startsWith(`${packageName}.`) ? target : target}`,
      why: `${source} -> ${target}`,
    });
  }
  return rules;
}

/**
 * JavaScript: a relative specifier is relative to the importing file, so it must be
 * recomputed whenever either end moves. Bare specifiers and path aliases are untouched —
 * aliases move via tsconfig, which is handled as a config rewrite.
 */
export function recomputeRelative(importerFrom, importerTo, specifier, moves) {
  if (!specifier.startsWith('.')) return specifier;
  const movedMap = new Map(moves.map((m) => [toPosixPath(m.from), toPosixPath(m.to)]));

  const resolvedOld = toPosixPath(path.posix.normalize(path.posix.join(path.posix.dirname(toPosixPath(importerFrom)), specifier)));
  // The target may itself have moved; extensions are often omitted in the specifier.
  const candidates = [resolvedOld, `${resolvedOld}.js`, `${resolvedOld}.mjs`, `${resolvedOld}.ts`, `${resolvedOld}.tsx`, `${resolvedOld}/index.ts`, `${resolvedOld}/index.js`];
  const movedTargetKey = candidates.find((c) => movedMap.has(c));
  const targetNew = movedTargetKey ? movedMap.get(movedTargetKey) : resolvedOld;

  // Keep the original extension habit: if the specifier had none, do not invent one.
  const hadExtension = /\.[a-z]+$/.test(specifier);
  const stripped = hadExtension ? targetNew : targetNew.replace(/\.(js|mjs|cjs|ts|tsx|jsx)$/, '');

  let next = path.posix.relative(path.posix.dirname(toPosixPath(importerTo)), stripped);
  if (!next.startsWith('.')) next = `./${next}`;
  return next;
}

/**
 * Every shape a relative specifier appears in. `import './x'` — a side-effect import with
 * no binding and no `from` — is common and was missed by the first version, which is the
 * kind of gap that leaves a project importing nothing and looking fine.
 */
const JS_SPECIFIER = /(from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]*)\2/g;

export function rewriteJsFile(text, importerFrom, importerTo, moves) {
  let changes = 0;
  const next = text.replace(JS_SPECIFIER, (whole, lead, quote, spec) => {
    const rewritten = recomputeRelative(importerFrom, importerTo, spec, moves);
    if (rewritten === spec) return whole;
    changes += 1;
    return `${lead}${quote}${rewritten}${quote}`;
  });
  return { text: next, changes };
}

export function rewritePythonFile(text, rules) {
  let changes = 0;
  let next = text;
  for (const rule of rules) {
    next = next.replace(rule.re, (...args) => {
      changes += 1;
      return `${args[1]}${rule.why.split(' -> ')[1]}`;
    });
  }
  return { text: next, changes };
}

/**
 * Config files reference paths as plain strings, so a path-for-path substitution is both the
 * simplest and the most faithful thing to do. Substituting whole path prefixes rather than
 * bare names is what keeps `src/api` from matching `src/apiary`.
 */
export function rewritePathsInText(text, moves) {
  let changes = 0;
  let next = text;
  // Longest first, so a nested move is not partly rewritten by its parent.
  const ordered = [...moves].sort((a, b) => toPosixPath(b.from).length - toPosixPath(a.from).length);
  for (const move of ordered) {
    const from = toPosixPath(move.from);
    const to = toPosixPath(move.to);
    if (from === to) continue;
    // Both separator spellings, deduplicated: a path with no slash yields the same string
    // twice, and running the substitution twice turned "app" into "src/src/app".
    const variants = [...new Set([from, from.replace(/\//g, '\\\\')])];
    for (const variant of variants) {
      const replacement = variant === from ? to : to.replace(/\//g, '\\\\');
      // Bounded on both sides: without a left boundary `app` also matches inside `myapp`,
      // and without a right one `src/api` matches inside `src/apiary`.
      const re = new RegExp(`(?<![\\w/\\\\.-])${escapeRe(variant)}(?=["'\\s,:;)\\]}]|$)`, 'g');
      next = next.replace(re, () => {
        changes += 1;
        return replacement;
      });
    }
  }
  return { text: next, changes };
}

function walk(dir, root, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, acc);
    else acc.push(toPosixPath(path.relative(root, full)));
  }
  return acc;
}

function configFilesFor(root, layout) {
  const declared = (layout?.reference_rewrites || []).map((r) => r.file);
  const all = walk(root, root);
  const matched = new Set();
  for (const pattern of declared) {
    if (pattern.includes('*')) {
      const re = globToRegExp(pattern);
      for (const f of all) if (re.test(f)) matched.add(f);
    } else if (all.includes(pattern)) {
      matched.add(pattern);
    }
  }
  return [...matched].sort();
}

/**
 * Plans every rewrite a set of moves implies, without writing anything.
 *
 * @returns {{sources: object[], configs: object[], unmatched: string[]}}
 */
export function planRewrites(root, moves, layout, { packageName = null } = {}) {
  const movedFrom = new Map(moves.map((m) => [toPosixPath(m.from), toPosixPath(m.to)]));
  const pyRules = pythonImportRewrites(moves, { packageName });
  const sources = [];
  const configs = [];

  for (const rel of walk(root, root)) {
    const ext = path.extname(rel);
    if (!SOURCE_EXT.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    // A file that moved is rewritten at its new location; one that stayed, in place.
    const finalPath = movedFrom.get(rel) ?? rel;
    const result = ext === '.py' ? rewritePythonFile(text, pyRules) : rewriteJsFile(text, rel, finalPath, moves);
    if (result.changes > 0) sources.push({ file: rel, finalPath, changes: result.changes, text: result.text });
  }

  for (const rel of configFilesFor(root, layout)) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const result = rewritePathsInText(text, moves);
    if (result.changes > 0) configs.push({ file: rel, changes: result.changes, text: result.text });
  }

  // Declared families that are not present: reported so a reader knows what was not checked
  // rather than assuming it was.
  const present = new Set(configFilesFor(root, layout));
  const unmatched = (layout?.reference_rewrites || [])
    .map((r) => r.file)
    .filter((f) => !f.includes('*') && !present.has(f));

  return { sources, configs, unmatched };
}

/** Applies a plan. Returns the files it touched, by name, for the report. */
export function applyRewrites(root, plan) {
  const touched = { sources: [], configs: [] };
  for (const item of plan.sources) {
    fs.writeFileSync(path.join(root, item.finalPath), item.text, 'utf8');
    touched.sources.push(item.finalPath);
  }
  for (const item of plan.configs) {
    fs.writeFileSync(path.join(root, item.file), item.text, 'utf8');
    touched.configs.push(item.file);
  }
  return touched;
}

export function describePlan(plan) {
  const lines = [];
  lines.push(`${plan.sources.length} fichero(s) de código y ${plan.configs.length} de configuración`);
  for (const c of plan.configs) lines.push(`  config  ${c.file}  (${c.changes} referencia(s))`);
  for (const s of plan.sources.slice(0, 20)) lines.push(`  código  ${s.finalPath}  (${s.changes} importación(es))`);
  if (plan.sources.length > 20) lines.push(`  … y ${plan.sources.length - 20} más`);
  if (plan.unmatched.length) {
    lines.push(`  no presentes, y por tanto no revisados: ${plan.unmatched.join(', ')}`);
  }
  return lines.join('\n');
}
