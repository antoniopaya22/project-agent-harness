#!/usr/bin/env node
// The `lint` gate for this repository: a real syntax check over every source file,
// with zero dependencies. `node --check` parses the file without executing it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function collect(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, acc);
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = collect(ROOT);
let failed = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL ${path.relative(ROOT, file)}\n${res.stderr}\n`);
  }
}

// A second, cheap invariant: no source file may exceed a size where nobody reads it.
const MAX_LINES = 600;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').length;
  if (lines > MAX_LINES) {
    failed += 1;
    process.stdout.write(`FAIL ${path.relative(ROOT, file)} is ${lines} lines (max ${MAX_LINES}); split it\n`);
  }
}

process.stdout.write(
  failed === 0
    ? `lint: ${files.length} file(s) OK\n`
    : `lint: ${failed} problem(s) across ${files.length} file(s)\n`,
);
process.exit(failed === 0 ? 0 : 1);
