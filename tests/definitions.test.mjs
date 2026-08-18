import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listFiles, parseFrontMatter } from '../.harness/bin/lib/util.mjs';
import { repoCtx } from './helpers.mjs';

const ctx = repoCtx();

function definitions(kind) {
  return listFiles(path.join(ctx.harnessDir, kind), '.md').map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return { file, id: path.basename(file, '.md'), ...parseFrontMatter(text), lines: text.split('\n').length };
  });
}

const AGENTS = definitions('agents');
const COMMANDS = definitions('commands');

test('the six roles exist', () => {
  assert.deepEqual(
    AGENTS.map((a) => a.id).sort(),
    ['implementer', 'planner', 'researcher', 'reviewer', 'scribe', 'tester'],
  );
});

test('every agent declares a non-empty forbidden list', () => {
  // The reasoning is load-bearing: a role justifies itself by what it cannot do.
  for (const agent of AGENTS) {
    assert.ok(Array.isArray(agent.data.forbidden), `${agent.id} has no forbidden list`);
    assert.ok(agent.data.forbidden.length > 0, `${agent.id} forbids nothing, so it is not a distinct role`);
  }
});

test('the separation that makes verification trustworthy is actually encoded', () => {
  const tester = AGENTS.find((a) => a.id === 'tester');
  assert.ok(
    tester.data.forbidden.includes('production_code'),
    'the tester must be unable to fix the code it verifies',
  );
  const implementer = AGENTS.find((a) => a.id === 'implementer');
  for (const rule of ['acceptance_criteria', 'task_status_done', 'test_weakening']) {
    assert.ok(implementer.data.forbidden.includes(rule), `implementer must be forbidden from ${rule}`);
  }
});

test('no agent may mark a task done', () => {
  for (const agent of AGENTS) {
    const body = agent.body.toLowerCase();
    // `task_json` is the stronger claim — those roles cannot touch a task at all.
    const declares =
      agent.data.forbidden.includes('task_status_done') || agent.data.forbidden.includes('task_json');
    const saysSo = /never (set|mark).*done|stop at .*in_review/.test(body);
    assert.ok(declares || saysSo, `${agent.id} does not rule out setting done`);
  }
});

test('every definition has a purpose, because that is what the provider uses to route', () => {
  for (const def of [...AGENTS, ...COMMANDS]) {
    assert.ok(typeof def.data.purpose === 'string' && def.data.purpose.length > 10, `${def.id} has no usable purpose`);
  }
});

test('every definition id matches its filename', () => {
  for (const def of [...AGENTS, ...COMMANDS]) {
    assert.equal(def.data.id, def.id, `${def.file} declares a different id`);
  }
});

test('definitions stay short enough to be read', () => {
  for (const def of [...AGENTS, ...COMMANDS]) {
    assert.ok(def.lines <= 150, `${def.id} is ${def.lines} lines; a prompt nobody reads does not exist`);
  }
});

test('every agent follows the shared section skeleton', () => {
  const required = ['## Role and limit', '## What to read', '## Procedure', '## Never', '## Output format', '## When to stop and ask'];
  for (const agent of AGENTS) {
    for (const heading of required) {
      assert.ok(agent.body.includes(heading), `${agent.id} is missing "${heading}"`);
    }
  }
});

test('capabilities and model tiers use the neutral vocabulary only', () => {
  const caps = new Set(['read', 'search', 'edit', 'shell', 'web', 'delegate', 'ask']);
  const models = new Set(['fast', 'primary', 'deep']);
  for (const def of [...AGENTS, ...COMMANDS]) {
    for (const cap of def.data.capabilities || []) {
      assert.ok(caps.has(cap), `${def.id} uses unknown capability "${cap}"`);
    }
    if (def.data.model) {
      assert.ok(models.has(def.data.model), `${def.id} uses a provider model name ("${def.data.model}") instead of a tier`);
    }
  }
});

test('every command referenced by the entrypoint exists as a definition', () => {
  const entrypoint = fs.readFileSync(path.join(ctx.harnessDir, 'ENTRYPOINT.md'), 'utf8');
  const mentioned = [...entrypoint.matchAll(/`\/([a-z-]+)`/g)].map((m) => m[1]);
  const ids = new Set(COMMANDS.map((cmd) => cmd.id));
  for (const name of new Set(mentioned)) {
    // /adopt and /sync are documented before their engines land; skip only what is declared as such.
    if (name === 'adopt') continue;
    assert.ok(ids.has(name), `ENTRYPOINT.md mentions /${name} but there is no definition for it`);
  }
});
