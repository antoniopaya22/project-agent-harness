// Test fixtures. A temp harness is built on disk because the CLI's contract is about
// files, and testing it against mocks would test the mocks.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function repoCtx() {
  const harnessDir = path.join(REPO, '.harness');
  return {
    root: REPO,
    harnessDir,
    project: JSON.parse(fs.readFileSync(path.join(harnessDir, 'project.json'), 'utf8')),
    taskSchema: JSON.parse(fs.readFileSync(path.join(harnessDir, 'schema', 'task.schema.json'), 'utf8')),
  };
}

let counter = 0;

/** A throwaway harness with its own backlog. Returns a ctx plus a cleanup function. */
export function tempHarness({ project = {}, tasks = [], agents = [], commands = [] } = {}) {
  counter += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness-test-${counter}-`));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'backlog', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'schema'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'areas'), { recursive: true });

  const taskSchema = JSON.parse(
    fs.readFileSync(path.join(REPO, '.harness', 'schema', 'task.schema.json'), 'utf8'),
  );
  fs.writeFileSync(path.join(harnessDir, 'schema', 'task.schema.json'), JSON.stringify(taskSchema, null, 2));

  const merged = {
    harness_version: '1.0.0',
    project: { name: 'fixture', purpose: 'Proyecto de prueba para los autotests del harness.', output_language: 'es' },
    git: { default_branch: 'main', protected_branches: ['main'], commit_scopes: [], auto_pr: 'ready' },
    gates: {},
    areas: [{ id: 'core', globs: ['src/**'], doc: 'docs/areas/core.md' }],
    providers: { claude: true, agents_md: false },
    ...project,
  };
  fs.writeFileSync(path.join(harnessDir, 'project.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(root, 'docs', 'areas', 'core.md'), '# core\n');

  for (const task of tasks) {
    fs.writeFileSync(
      path.join(harnessDir, 'backlog', 'tasks', `${task.id}.json`),
      `${JSON.stringify(task, null, 2)}\n`,
    );
  }
  for (const { id, content } of agents) {
    fs.writeFileSync(path.join(harnessDir, 'agents', `${id}.md`), content);
  }
  for (const { id, content } of commands) {
    fs.writeFileSync(path.join(harnessDir, 'commands', `${id}.md`), content);
  }

  const ctx = { root, harnessDir, project: merged, taskSchema };
  return { ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A schema-valid task, so each test only states what it actually cares about. */
export function makeTask(overrides = {}) {
  return {
    id: 'FEAT-0001',
    title: 'Una tarea de ejemplo suficientemente descriptiva',
    type: 'feature',
    status: 'backlog',
    priority: 'medium',
    description: 'Una descripción con la longitud mínima que exige el esquema de tarea.',
    acceptance_criteria: [
      { id: 'AC1', must: 'Algo observable ocurre cuando se hace X.', check: { type: 'review', run: null }, status: 'pending' },
    ],
    context: { area: 'core', docs: [], files: [], out_of_scope: [] },
    depends_on: [],
    labels: [],
    assignee: null,
    claimed_at: null,
    branch: null,
    links: { pr: null, issue: null, commits: [] },
    worklog: [],
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

export const AGENT_FIXTURE = `---
id: worker
purpose: Do a bounded thing and nothing else.
writes: [src]
forbidden: [tests]
capabilities: [read, edit]
model: primary
---

Body of the agent prompt.
`;

export const COMMAND_FIXTURE = `---
id: do-thing
purpose: Do the thing to a target.
args: "<TARGET>"
capabilities: [read, shell]
model: fast
---

Do the thing to $1.
`;
