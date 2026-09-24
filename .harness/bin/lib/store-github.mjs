// Backlog stored in GitHub: one issue per task, the Projects board as the single status.
//
// Why this exists. With the tasks as JSON files in the repository, every worktree and every
// branch carried its own copy of the backlog: two sessions could claim the same task without
// seeing each other, a card moved by hand on the board changed nothing, and keeping the board
// in step needed a sync job that — when it misread GitHub — duplicated every issue on each push
// (2 361 copies on 2026-09-23/24). Here there is one copy, and it is the one people look at.
//
// Where each thing lives:
//   id + title        issue title, "FEAT-0030 · título"
//   status            the board's Status field — nothing else. Moving a card is a transition.
//   description       the issue body above the harness marker, free to edit by hand
//   everything else   a JSON block in the body, below the marker (criteria, context, deps...)
//   worklog           issue comments carrying a machine-readable marker
//   branch, claimant  also mirrored into the board's "Rama" / "Reclamada por" text fields
//
// Transport is the `gh` CLI, synchronously, like the rest of the harness: no dependency, and
// the user's own authentication (it needs the `project` scope).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, fail, nowIso } from './util.mjs';
import { validate } from './schema.mjs';

export const STATUS_TO_OPTION = {
  backlog: 'backlog',
  ready: 'ready',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'complete',
  cancelled: 'cancelled',
};
export const OPTION_TO_STATUS = Object.fromEntries(Object.entries(STATUS_TO_OPTION).map(([k, v]) => [v, k]));

const MARK = '<!-- harness:datos -->';
const TITLE_RE = /^([A-Z]+-\d{4})\s*·\s*(.*)$/;

/** Fields that live in the JSON block. id, title, status and description live elsewhere. */
const DATA_KEYS = [
  'type', 'priority', 'size', 'parent', 'acceptance_criteria', 'context', 'depends_on',
  'blocked_reason', 'resolution', 'labels', 'assignee', 'claimed_at', 'branch',
  'estimate_hours', 'links', 'status_changed_at', 'created_at', 'updated_at',
];

const CACHE_TTL_MS = Number(process.env.HARNESS_CACHE_TTL_MS || 60_000);

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export function config(ctx) {
  const cfg = ctx.project.backlog?.github;
  if (!cfg?.owner || !cfg?.project || !cfg?.repo) {
    fail('project.json backlog.github needs owner, project and repo', EXIT.PRECONDITION);
  }
  return cfg;
}

/**
 * `gh`, or — for the test suite only — a Node script that fakes it (`HARNESS_GH_SCRIPT`). Run
 * with `process.execPath` rather than as a shim so the fake works on Windows too.
 */
export function spawnGh(args, opts) {
  const script = process.env.HARNESS_GH_SCRIPT;
  return script ? spawnSync(process.execPath, [script, ...args], opts) : spawnSync('gh', args, opts);
}

function gh(ctx, args, { input = null, allowFail = false } = {}) {
  const res = spawnGh(args, {
    cwd: ctx.root,
    encoding: 'utf8',
    input: input === null ? undefined : input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) fail(`no se pudo ejecutar gh: ${res.error.message}`, EXIT.PRECONDITION);
  const out = (res.stdout || '').trim();
  if (res.status !== 0 && !allowFail) {
    const why = (res.stderr || out).trim().split('\n').slice(0, 3).join(' ');
    fail(`GitHub respondió con error (gh ${args.slice(0, 2).join(' ')}): ${why}`, EXIT.PRECONDITION);
  }
  return { code: res.status ?? 1, out, err: (res.stderr || '').trim() };
}

export function graphql(ctx, query, variables = {}) {
  const res = gh(ctx, ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }) });
  const parsed = JSON.parse(res.out);
  if (parsed.errors?.length) {
    fail(`GitHub GraphQL: ${parsed.errors.map((e) => e.message).join('; ')}`, EXIT.PRECONDITION);
  }
  return parsed.data;
}

export function rest(ctx, method, endpoint, body = null) {
  const args = ['api', '-X', method, endpoint];
  if (body !== null) args.push('--input', '-');
  const res = gh(ctx, args, { input: body === null ? null : JSON.stringify(body) });
  return res.out ? JSON.parse(res.out) : null;
}

// ---------------------------------------------------------------------------
// cache — local, never versioned (.harness/.cache is gitignored)
// ---------------------------------------------------------------------------

function cacheDir(ctx) {
  return path.join(ctx.harnessDir, '.cache');
}

function readCache(ctx, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(ctx), name), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(ctx, name, value) {
  fs.mkdirSync(cacheDir(ctx), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(ctx), name), JSON.stringify(value), 'utf8');
}

let memo = null; // this process's view of the whole backlog

function fresh() {
  return process.env.HARNESS_FRESH === '1';
}

// ---------------------------------------------------------------------------
// the project: ids of the board, its fields and their options, discovered once
// ---------------------------------------------------------------------------

const PROJECT_QUERY = `query($owner:String!,$number:Int!){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){ id
    fields(first:50){ nodes{
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name dataType }
    } } } } } }`;

export function project(ctx, { refresh = false } = {}) {
  const cfg = config(ctx);
  const cached = readCache(ctx, 'github-project.json');
  if (!refresh && cached && cached.owner === cfg.owner && cached.number === cfg.project && cached.fields?.rama) return cached;
  const data = graphql(ctx, PROJECT_QUERY, { owner: cfg.owner, number: cfg.project });
  const p = data?.repositoryOwner?.projectV2;
  if (!p) fail(`no encuentro el proyecto ${cfg.owner}/#${cfg.project}`, EXIT.NOT_FOUND);
  const byName = (n) => p.fields.nodes.find((f) => f.name === n);
  const status = byName('Status');
  if (!status?.options) fail('el tablero no tiene un campo de selección "Status"', EXIT.PRECONDITION);
  const out = {
    owner: cfg.owner,
    number: cfg.project,
    id: p.id,
    fields: {
      status: status.id,
      rama: byName('Rama')?.id ?? null,
      reclamada: byName('Reclamada por')?.id ?? null,
    },
    options: Object.fromEntries(status.options.map((o) => [o.name, o.id])),
  };
  if (!out.fields.rama || !out.fields.reclamada) {
    // First run against a board without them: create the two text fields once.
    for (const [key, name] of [['rama', 'Rama'], ['reclamada', 'Reclamada por']]) {
      if (out.fields[key]) continue;
      const created = graphql(
        ctx,
        `mutation($p:ID!,$n:String!){ createProjectV2Field(input:{projectId:$p dataType:TEXT name:$n}){
          projectV2Field{ ... on ProjectV2Field { id } } } }`,
        { p: out.id, n: name },
      );
      out.fields[key] = created.createProjectV2Field.projectV2Field.id;
    }
  }
  for (const s of Object.values(STATUS_TO_OPTION)) {
    if (!out.options[s]) fail(`el campo Status del tablero no tiene la opción "${s}"`, EXIT.PRECONDITION);
  }
  writeCache(ctx, 'github-project.json', out);
  return out;
}

// ---------------------------------------------------------------------------
// issue <-> task
// ---------------------------------------------------------------------------

function splitBody(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const at = text.indexOf(MARK);
  if (at === -1) return { description: text.trim(), data: null };
  const description = text.slice(0, at).trim();
  const tail = text.slice(at);
  const m = tail.match(/```json\n([\s\S]*?)\n```/);
  let data = null;
  if (m) {
    try {
      data = JSON.parse(m[1]);
    } catch {
      data = null;
    }
  }
  return { description, data };
}

/** The issue body: the description, a readable summary, and the data block. */
export function renderBody(task) {
  const data = {};
  for (const k of DATA_KEYS) if (task[k] !== undefined) data[k] = task[k];
  const criteria = (task.acceptance_criteria || [])
    .map((ac) => `- [${ac.status === 'pass' ? 'x' : ' '}] **${ac.id}** ${ac.must}${ac.status === 'fail' ? ' — **en fallo**' : ''}`)
    .join('\n');
  const meta = [
    task.context?.area ? `área \`${task.context.area}\`` : null,
    task.depends_on?.length ? `depende de ${task.depends_on.join(', ')}` : null,
    task.branch ? `rama \`${task.branch}\`` : null,
  ].filter(Boolean).join(' · ');
  return [
    String(task.description || '').trim(),
    '',
    MARK,
    '<!-- Desde aquí lo escribe el harness: se regenera en cada cambio. Edita la descripción de arriba; los criterios y el contexto, con `harness task ...`. -->',
    '',
    '### Criterios de aceptación',
    '',
    criteria || '_Sin criterios._',
    '',
    meta ? `${meta}\n` : '',
    '<details><summary>Datos del harness</summary>',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

export function labelsFor(task) {
  const labels = [`type:${task.type}`];
  if (task.priority) labels.push(`priority:${task.priority}`);
  if (task.context?.area) labels.push(`area:${task.context.area}`);
  return [...new Set([...labels, ...(task.labels || [])])].sort();
}

function taskFromNode(node) {
  const issue = node.issue;
  const m = String(issue.title).match(TITLE_RE);
  if (!m) return null;
  const { description, data } = splitBody(issue.body);
  const task = {
    id: m[1],
    title: m[2].trim(),
    status: OPTION_TO_STATUS[node.status] || (issue.state === 'CLOSED' ? 'done' : 'backlog'),
    description,
    ...(data || {}),
  };
  if (!task.type) task.type = typeFromId(task.id);
  if (!Array.isArray(task.acceptance_criteria)) task.acceptance_criteria = [];
  if (!task.context) task.context = { area: null, docs: [], files: [], out_of_scope: [] };
  if (!Array.isArray(task.depends_on)) task.depends_on = [];
  if (!Array.isArray(task.labels)) task.labels = [];
  // An issue written by hand on the board has no data block: it still has to be a valid task.
  if (!task.created_at) task.created_at = issue.createdAt || null;
  if (!task.updated_at) task.updated_at = issue.updatedAt || task.created_at;
  if (!task.priority) task.priority = 'medium';
  const remote = {
    number: issue.number,
    nodeId: issue.id,
    itemId: node.itemId,
    state: issue.state,
    body: issue.body,
    title: issue.title,
    labels: (issue.labels?.nodes || []).map((l) => l.name).sort(),
    status: node.status,
    rama: node.rama ?? null,
    reclamada: node.reclamada ?? null,
    updatedAt: issue.updatedAt,
    hasData: Boolean(data),
  };
  Object.defineProperty(task, '__remote', { value: remote, enumerable: false, writable: true });
  return task;
}

function typeFromId(id) {
  const prefix = id.split('-')[0];
  return { FEAT: 'feature', FIX: 'fix', CHORE: 'chore', DOCS: 'docs', RFCT: 'refactor', TEST: 'test', SPIKE: 'spike', EPIC: 'epic' }[prefix] || 'chore';
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

const ITEM_FIELDS = `
  status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
  rama: fieldValueByName(name:"Rama"){ ... on ProjectV2ItemFieldTextValue { text } }
  reclamada: fieldValueByName(name:"Reclamada por"){ ... on ProjectV2ItemFieldTextValue { text } }`;

const ISSUE_FIELDS = `id number title body state createdAt updatedAt repository{ nameWithOwner } labels(first:30){ nodes{ name } }`;

const ALL_QUERY = `query($owner:String!,$number:Int!,$after:String){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){
    items(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id ${ITEM_FIELDS}
      content{ ... on Issue { ${ISSUE_FIELDS} } } } } } } } }`;

function nodeFrom(item, issue) {
  return {
    itemId: item?.id ?? null,
    status: item?.status?.name ?? null,
    rama: item?.rama?.text ?? null,
    reclamada: item?.reclamada?.text ?? null,
    issue,
  };
}

/** Every task on the board. One paginated query; cached for read-only use. */
export function loadAll(ctx) {
  if (memo) return memo.tasks;
  const cached = fresh() ? null : readCache(ctx, 'backlog.json');
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    memo = { tasks: cached.nodes.map(taskFromNode).filter(Boolean) };
    return memo.tasks;
  }
  const cfg = config(ctx);
  const nodes = [];
  let after = null;
  for (;;) {
    const data = graphql(ctx, ALL_QUERY, { owner: cfg.owner, number: cfg.project, after });
    const items = data.repositoryOwner.projectV2.items;
    for (const item of items.nodes) {
      const issue = item.content;
      if (!issue?.number || issue.repository?.nameWithOwner !== cfg.repo) continue;
      nodes.push(nodeFrom(item, issue));
    }
    if (!items.pageInfo.hasNextPage) break;
    after = items.pageInfo.endCursor;
  }
  // Two cards for one id would mean two sources of truth again: refuse loudly instead of
  // picking one. It is how the duplicates of 2026-09 would have been caught on day one.
  const seen = new Map();
  for (const n of nodes) {
    const id = String(n.issue.title).match(TITLE_RE)?.[1];
    if (!id) continue;
    if (seen.has(id)) {
      fail(`el tablero tiene dos incidencias para ${id} (#${seen.get(id)} y #${n.issue.number}): deja una`, EXIT.CHECK_FAILED);
    }
    seen.set(id, n.issue.number);
  }
  writeCache(ctx, 'backlog.json', { at: Date.now(), nodes });
  writeCache(ctx, 'ids.json', Object.fromEntries(nodes.map((n) => [String(n.issue.title).match(TITLE_RE)?.[1], n.issue.number]).filter(([k]) => k)));
  memo = { tasks: nodes.map(taskFromNode).filter(Boolean) };
  return memo.tasks;
}

const ONE_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner, name:$repo){ issue(number:$n){ ${ISSUE_FIELDS}
    projectItems(first:10){ nodes{ id project{ id } ${ITEM_FIELDS} } } } } }`;

export function issueNumber(ctx, id) {
  const ids = readCache(ctx, 'ids.json');
  if (ids?.[id]) return ids[id];
  memo = null;
  const prev = process.env.HARNESS_FRESH;
  process.env.HARNESS_FRESH = '1';
  try {
    loadAll(ctx);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_FRESH;
    else process.env.HARNESS_FRESH = prev;
  }
  return readCache(ctx, 'ids.json')?.[id] ?? null;
}

/** One task, always fresh from GitHub: writes start from here, never from the cache. */
export function load(ctx, id) {
  const number = issueNumber(ctx, id);
  if (!number) fail(`la tarea ${id} no existe en el tablero`, EXIT.NOT_FOUND);
  const cfg = config(ctx);
  const [owner, repo] = cfg.repo.split('/');
  const data = graphql(ctx, ONE_QUERY, { owner, repo, n: number });
  const issue = data.repository.issue;
  if (!issue) fail(`la incidencia #${number} de ${id} ya no existe`, EXIT.NOT_FOUND);
  const board = project(ctx);
  const item = (issue.projectItems.nodes || []).find((x) => x.project?.id === board.id) || null;
  const task = taskFromNode(nodeFrom(item, issue));
  if (!task || task.id !== id) fail(`la incidencia #${number} ya no es ${id} (título: ${issue.title})`, EXIT.CHECK_FAILED);
  return task;
}

export function exists(ctx, id) {
  if (readCache(ctx, 'ids.json')?.[id]) return true;
  return loadAll(ctx).some((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

let knownLabels = null;

function ensureLabels(ctx, labels) {
  const cfg = config(ctx);
  if (!knownLabels) {
    const res = gh(ctx, ['label', 'list', '-R', cfg.repo, '--limit', '1000', '--json', 'name'], { allowFail: true });
    knownLabels = new Set(res.code === 0 && res.out ? JSON.parse(res.out).map((l) => l.name) : []);
  }
  for (const name of labels) {
    if (knownLabels.has(name)) continue;
    gh(ctx, ['label', 'create', name, '-R', cfg.repo, '--force'], { allowFail: true });
    knownLabels.add(name);
  }
}

function setField(ctx, board, itemId, fieldId, value) {
  if (value === null || value === '') {
    graphql(ctx, `mutation($p:ID!,$i:ID!,$f:ID!){ clearProjectV2ItemFieldValue(input:{projectId:$p itemId:$i fieldId:$f}){ projectV2Item{ id } } }`, { p: board.id, i: itemId, f: fieldId });
    return;
  }
  const value2 = fieldId === board.fields.status ? { singleSelectOptionId: board.options[value] } : { text: String(value) };
  graphql(
    ctx,
    `mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$p itemId:$i fieldId:$f value:$v}){ projectV2Item{ id } } }`,
    { p: board.id, i: itemId, f: fieldId, v: value2 },
  );
}

function claimant(task) {
  return task.assignee ? `${task.assignee.kind}:${task.assignee.id}` : null;
}

/**
 * Writes the task: only what differs from what was read, so an unchanged field costs no call.
 * A task without `__remote` is new and gets an issue and a card.
 */
export function save(ctx, task, { keepDates = false } = {}) {
  const cfg = config(ctx);
  const board = project(ctx);
  const remote = task.__remote || null;
  const now = nowIso();
  if (!keepDates) {
    if (remote && remote.status && OPTION_TO_STATUS[remote.status] !== task.status) task.status_changed_at = now;
    if (!remote && !task.status_changed_at) task.status_changed_at = now;
    task.updated_at = now;
  }

  // The schema is checked here, before anything leaves the machine: with no files there is
  // no CI step that could catch an invalid task later, and GitHub will not.
  const problems = ctx.taskSchema ? validate(task, ctx.taskSchema) : [];
  if (problems.length) {
    fail(`${task.id} no cumple el esquema, no se escribe`, EXIT.CHECK_FAILED, problems.map((p) => `${p.path || '(raíz)'}: ${p.message}`));
  }

  const title = `${task.id} · ${task.title}`;
  const body = renderBody(task);
  const labels = labelsFor(task);
  const closed = task.status === 'done' || task.status === 'cancelled';
  const stateReason = task.status === 'cancelled' ? 'not_planned' : 'completed';

  let number = remote?.number;
  let nodeId = remote?.nodeId;
  let itemId = remote?.itemId;

  if (!remote) {
    ensureLabels(ctx, labels);
    const created = rest(ctx, 'POST', `repos/${cfg.repo}/issues`, { title, body, labels });
    number = created.number;
    nodeId = created.node_id;
    if (closed) rest(ctx, 'PATCH', `repos/${cfg.repo}/issues/${number}`, { state: 'closed', state_reason: stateReason });
  } else {
    const patch = {};
    if (remote.title !== title) patch.title = title;
    if (String(remote.body || '').replace(/\r\n/g, '\n').trim() !== body.trim()) patch.body = body;
    if (closed && remote.state !== 'CLOSED') Object.assign(patch, { state: 'closed', state_reason: stateReason });
    if (!closed && remote.state === 'CLOSED') patch.state = 'open';
    if (Object.keys(patch).length) rest(ctx, 'PATCH', `repos/${cfg.repo}/issues/${number}`, patch);
    if (labels.join(',') !== (remote.labels || []).join(',')) {
      ensureLabels(ctx, labels);
      rest(ctx, 'PUT', `repos/${cfg.repo}/issues/${number}/labels`, { labels });
    }
  }

  if (!itemId) {
    const added = graphql(ctx, `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p contentId:$c}){ item{ id } } }`, { p: board.id, c: nodeId });
    itemId = added.addProjectV2ItemById.item.id;
  }
  const wantStatus = STATUS_TO_OPTION[task.status];
  // "Rama" and "Reclamada por" say who is working on it *now*: on a closed task they would be
  // noise on the board, and two writes per task for nothing.
  const open = !closed;
  const wantRama = open ? task.branch ?? null : null;
  const wantRecl = open ? claimant(task) : null;
  if (remote?.status !== wantStatus || !remote) setField(ctx, board, itemId, board.fields.status, wantStatus);
  if ((remote?.rama ?? null) !== wantRama) setField(ctx, board, itemId, board.fields.rama, wantRama);
  if ((remote?.reclamada ?? null) !== wantRecl) setField(ctx, board, itemId, board.fields.reclamada, wantRecl);

  Object.defineProperty(task, '__remote', {
    value: {
      number, nodeId, itemId, title, body, labels,
      state: closed ? 'CLOSED' : 'OPEN',
      status: wantStatus, rama: wantRama, reclamada: wantRecl, updatedAt: now, hasData: true,
    },
    enumerable: false,
    writable: true,
  });
  rememberInCache(ctx, task);
  return task;
}

function rememberInCache(ctx, task) {
  const ids = readCache(ctx, 'ids.json') || {};
  ids[task.id] = task.__remote.number;
  writeCache(ctx, 'ids.json', ids);
  const cached = readCache(ctx, 'backlog.json');
  if (cached) {
    const r = task.__remote;
    const node = {
      itemId: r.itemId, status: r.status, rama: r.rama, reclamada: r.reclamada,
      issue: { id: r.nodeId, number: r.number, title: r.title, body: r.body, state: r.state, updatedAt: r.updatedAt, labels: { nodes: r.labels.map((name) => ({ name })) } },
    };
    cached.nodes = cached.nodes.filter((n) => n.issue.number !== r.number).concat([node]);
    writeCache(ctx, 'backlog.json', cached);
  }
  if (memo) memo.tasks = memo.tasks.filter((t) => t.id !== task.id).concat([task]);
}

/** Next free id of a prefix, over the whole board — not over whatever branch is checked out. */
export function allocateId(ctx, prefix) {
  memo = null;
  const prev = process.env.HARNESS_FRESH;
  process.env.HARNESS_FRESH = '1';
  let tasks;
  try {
    tasks = loadAll(ctx);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_FRESH;
    else process.env.HARNESS_FRESH = prev;
  }
  const used = tasks.map((t) => t.id).filter((id) => id.startsWith(`${prefix}-`)).map((id) => Number(id.slice(prefix.length + 1)));
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// The worklog (comments with a marker) and the claim arbitration live in their own module.
export {
  arbitrateClaim,
  comment,
  logEvent,
  readWorklog,
  renderEventsComment,
} from './store-github-worklog.mjs';

export function forgetIds(ctx) {
  memo = null;
  for (const f of ['ids.json', 'backlog.json']) {
    try {
      fs.rmSync(path.join(cacheDir(ctx), f), { force: true });
    } catch { /* nada que olvidar */ }
  }
}

export function forgetCache(ctx) {
  memo = null;
  for (const f of ['backlog.json']) {
    try {
      fs.rmSync(path.join(cacheDir(ctx), f), { force: true });
    } catch { /* nada que olvidar */ }
  }
}
