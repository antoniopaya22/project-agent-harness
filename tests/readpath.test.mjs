// The mechanical guard on the design's central promise: an agent reaches full working
// context from a small, bounded set of files. Without this test, "read the minimum" is a
// slogan that decays the first time somebody appends a section to a doc.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { countLines, listFiles } from '../.harness/bin/lib/util.mjs';
import { repoCtx } from './helpers.mjs';

const ctx = repoCtx();

function expand(pattern) {
  if (pattern.includes('{task}')) return listFiles(path.join(ctx.harnessDir, 'backlog', 'tasks'), '.json');
  if (pattern.includes('{area}')) return (ctx.project.areas || []).map((a) => path.join(ctx.root, a.doc));
  return [path.join(ctx.root, pattern)];
}

test('the read path is declared, and it is short', () => {
  const readPath = ctx.project.read_path;
  assert.ok(Array.isArray(readPath) && readPath.length > 0, 'project.json must declare read_path');
  assert.ok(readPath.length <= 5, `the cold-start path is ${readPath.length} entries; it must stay small`);
});

test('every file in the read path exists and is inside its line budget', () => {
  for (const entry of ctx.project.read_path) {
    const files = expand(entry.path);
    assert.ok(files.length > 0, `${entry.path} expands to nothing`);
    for (const file of files) {
      const lines = countLines(file);
      const rel = path.relative(ctx.root, file);
      assert.notEqual(lines, null, `${rel} does not exist`);
      assert.ok(
        lines <= entry.max_lines,
        `${rel} is ${lines} lines, budget ${entry.max_lines}. Move content out — do not raise the budget.`,
      );
    }
  }
});

test('the whole cold start fits in a budget a model can actually hold', () => {
  const worst = ctx.project.read_path.reduce((sum, e) => sum + e.max_lines, 0);
  assert.ok(worst <= 900, `worst-case cold start is ${worst} lines; keep it under 900`);
});

test('every area declares a doc, and every doc is declared by an area', () => {
  const declared = new Set();
  for (const area of ctx.project.areas) {
    assert.ok(fs.existsSync(path.join(ctx.root, area.doc)), `area ${area.id} points at a missing doc`);
    assert.ok(area.globs.length > 0, `area ${area.id} matches nothing`);
    declared.add(path.basename(area.doc));
  }
  for (const file of listFiles(path.join(ctx.root, 'docs', 'areas'), '.md')) {
    const base = path.basename(file);
    if (base.startsWith('_')) continue;
    assert.ok(declared.has(base), `docs/areas/${base} belongs to no declared area`);
  }
});

test('each doc in the read path declares what it does not contain', () => {
  // The single-owner invariant is what makes the short path sufficient; a doc that does
  // not state its boundary will quietly absorb someone else's topic.
  for (const area of ctx.project.areas) {
    const text = fs.readFileSync(path.join(ctx.root, area.doc), 'utf8');
    assert.match(text, /##\s*Qué hace esta área/, `${area.doc} does not open by stating its scope`);
  }
});

test('the entrypoint names the read path so an agent cannot miss it', () => {
  const text = fs.readFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), 'utf8');
  assert.match(text, /Cold-start read path/);
  assert.match(text, /backlog\/tasks\/<ID>\.json/);
  assert.match(text, /project\.json/);
  assert.match(text, /docs\/areas\//);
});
