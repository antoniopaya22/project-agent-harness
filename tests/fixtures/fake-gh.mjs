#!/usr/bin/env node
// A stand-in for the `gh` CLI, driven entirely by two env vars set by the test:
//
//   FAKE_GH_CONFIG — path to a JSON file mapping a coarse command key (see keyFor below) to
//                    { out?, err?, code? }. A key with no entry answers with exit 0, no output.
//   FAKE_GH_LOG    — path to a file that gets one JSON line per invocation (the full argv),
//                    so a test can assert not just what came back but what was actually asked.
//
// This exists because adapter.mjs shells out to the real `gh` binary directly (no injection
// point), and this repo's own convention is not to fake a network — so instead of mocking
// the module, this fakes the one thing on the other side of that shell-out: the executable.

import fs from 'node:fs';

const args = process.argv.slice(2);

const logPath = process.env.FAKE_GH_LOG;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`);

function keyFor(a) {
  if (a[0] === 'api' && a[1] === 'graphql') {
    const query = a.find((x) => x.startsWith('query=')) || '';
    if (query.includes('repositoryOwner')) return 'discoverProject';
    if (query.includes('user(login')) return 'discoverProject:legacy';
    if (query.includes('addProjectV2ItemById')) return 'addToProject';
    if (query.includes('updateProjectV2ItemFieldValue')) return 'setStatus';
    return 'graphql:unknown';
  }
  return a.slice(0, 2).join(' ');
}

const configPath = process.env.FAKE_GH_CONFIG;
const config = configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const entry = config[keyFor(args)] || {};

if (entry.err) process.stderr.write(String(entry.err));
if (entry.out !== undefined) {
  process.stdout.write(typeof entry.out === 'string' ? entry.out : JSON.stringify(entry.out));
}
process.exit(entry.code ?? 0);
