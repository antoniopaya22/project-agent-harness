#!/usr/bin/env node
// A stand-in for the `gh` CLI, for the tests of the GitHub backlog store and of the GitHub sink.
//
// It keeps one repository's issues and one Projects board in a JSON file (FAKE_GH_STATE), answers
// exactly the calls the harness makes, and appends every call to FAKE_GH_LOG so a test can count
// them. It is deliberately small: a call it does not know exits 1 with the arguments, so a new
// call in the code shows up as a failing test instead of a silent success.
//
// Knobs: FAKE_GH_FAIL_LIST=1 makes `gh issue list` fail (the sync-duplication incident).

import fs from 'node:fs';

const args = process.argv.slice(2);
const STATE = process.env.FAKE_GH_STATE;
const LOG = process.env.FAKE_GH_LOG;

function load() {
  if (STATE && fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return {
    nextIssue: 1,
    nextComment: 1000,
    nextItem: 1,
    issues: [],
    board: { id: 'PVT_1', fields: [{ id: 'F_STATUS', name: 'Status', options: ['backlog', 'ready', 'in progress', 'in review', 'blocked', 'complete', 'cancelled'].map((n, i) => ({ id: `O_${i}`, name: n })) }], items: [] },
  };
}

const state = load();
const save = () => STATE && fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = (entry) => LOG && fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const out = (value) => {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  save();
  process.exit(0);
};
const die = (msg) => {
  process.stderr.write(`${msg}\n`);
  save();
  process.exit(1);
};

const stdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

const issueNode = (i) => ({
  id: i.nodeId, number: i.number, title: i.title, body: i.body, state: i.state,
  createdAt: i.createdAt, updatedAt: i.updatedAt,
  repository: { nameWithOwner: 'acme/app' },
  labels: { nodes: i.labels.map((name) => ({ name })) },
});

const fieldById = (id) => state.board.fields.find((f) => f.id === id);
const fieldByName = (name) => state.board.fields.find((f) => f.name === name);

function itemFields(item) {
  const value = (name) => item.values[fieldByName(name)?.id];
  const status = value('Status');
  return {
    status: status ? { name: fieldByName('Status').options.find((o) => o.id === status).name } : null,
    rama: value('Rama') ? { text: value('Rama') } : null,
    reclamada: value('Reclamada por') ? { text: value('Reclamada por') } : null,
  };
}

function graphql() {
  const { query, variables: v = {} } = JSON.parse(stdin());
  log({ kind: 'graphql', op: (query.match(/\b(mutation|query)\b[^{]*\{\s*(\w+)/) || [])[2] || '?' });
  if (/createProjectV2Field/.test(query)) {
    const f = { id: `F_${v.n.replace(/\W/g, '')}`, name: v.n };
    state.board.fields.push(f);
    return out({ data: { createProjectV2Field: { projectV2Field: { id: f.id } } } });
  }
  if (/addProjectV2ItemById/.test(query)) {
    const issue = state.issues.find((i) => i.nodeId === v.c);
    let item = state.board.items.find((x) => x.issue === issue.number);
    if (!item) {
      item = { id: `PVTI_${state.nextItem++}`, issue: issue.number, values: {} };
      state.board.items.push(item);
    }
    return out({ data: { addProjectV2ItemById: { item: { id: item.id } } } });
  }
  if (/updateProjectV2ItemFieldValue/.test(query)) {
    const item = state.board.items.find((x) => x.id === v.i);
    const f = fieldById(v.f);
    item.values[v.f] = v.v.singleSelectOptionId ?? v.v.text;
    if (!f) die(`unknown field ${v.f}`);
    return out({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
  }
  if (/clearProjectV2ItemFieldValue/.test(query)) {
    const item = state.board.items.find((x) => x.id === v.i);
    delete item.values[v.f];
    return out({ data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
  }
  if (/deleteProjectV2Item/.test(query)) {
    state.board.items = state.board.items.filter((x) => x.id !== v.i);
    return out({ data: { deleteProjectV2Item: { deletedItemId: v.i } } });
  }
  if (/fields\(first:50\)/.test(query)) {
    return out({ data: { repositoryOwner: { projectV2: {
      id: state.board.id,
      fields: { nodes: state.board.fields.map((f) => (f.options ? { id: f.id, name: f.name, options: f.options } : { id: f.id, name: f.name, dataType: 'TEXT' })) },
    } } } });
  }
  if (/items\(first:100/.test(query)) {
    const nodes = state.board.items.map((item) => ({
      id: item.id, ...itemFields(item), content: issueNode(state.issues.find((i) => i.number === item.issue)),
    }));
    return out({ data: { repositoryOwner: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
  }
  if (/comments\(last:100\)/.test(query)) {
    const issue = state.issues.find((i) => i.number === v.n);
    return out({ data: { repository: { issue: issue ? { comments: { nodes: issue.comments.map((c) => ({ databaseId: c.id, body: c.body, createdAt: c.at })) } } : null } } });
  }
  if (/issue\(number:\$n\)/.test(query)) {
    const issue = state.issues.find((i) => i.number === v.n);
    if (!issue) return out({ data: { repository: { issue: null } } });
    const items = state.board.items.filter((x) => x.issue === issue.number).map((item) => ({ id: item.id, project: { id: state.board.id }, ...itemFields(item) }));
    return out({ data: { repository: { issue: { ...issueNode(issue), projectItems: { nodes: items } } } } });
  }
  die(`fake gh: unknown graphql query: ${query.slice(0, 80)}`);
}

function restCall(method, endpoint) {
  const body = method === 'GET' ? null : JSON.parse(stdin() || 'null');
  log({ kind: 'rest', method, endpoint });
  const now = new Date().toISOString();
  let m;
  if (method === 'POST' && (m = endpoint.match(/\/issues$/))) {
    const issue = {
      number: state.nextIssue++, nodeId: `I_${state.nextIssue}`, title: body.title, body: body.body ?? '',
      state: 'OPEN', labels: [...(body.labels || [])].sort(), comments: [], createdAt: now, updatedAt: now,
    };
    state.issues.push(issue);
    return out({ number: issue.number, node_id: issue.nodeId });
  }
  if (method === 'PATCH' && (m = endpoint.match(/\/issues\/(\d+)$/))) {
    const issue = state.issues.find((i) => i.number === Number(m[1]));
    if (body.title !== undefined) issue.title = body.title;
    if (body.body !== undefined) issue.body = body.body;
    if (body.state) issue.state = body.state === 'closed' ? 'CLOSED' : 'OPEN';
    issue.updatedAt = now;
    return out({ number: issue.number });
  }
  if (method === 'PUT' && (m = endpoint.match(/\/issues\/(\d+)\/labels$/))) {
    const issue = state.issues.find((i) => i.number === Number(m[1]));
    issue.labels = [...body.labels].sort();
    return out([]);
  }
  if (method === 'POST' && (m = endpoint.match(/\/issues\/(\d+)\/comments$/))) {
    const issue = state.issues.find((i) => i.number === Number(m[1]));
    const c = { id: state.nextComment++, body: body.body, at: now };
    issue.comments.push(c);
    return out({ id: c.id });
  }
  die(`fake gh: unknown REST ${method} ${endpoint}`);
}

if (args[0] === 'api' && args[1] === 'graphql') graphql();
if (args[0] === 'api' && args[1] === '-X') restCall(args[2], args[3]);
if (args[0] === 'label' && args[1] === 'list') {
  log({ kind: 'label-list' });
  out([]);
}
if (args[0] === 'label' && args[1] === 'create') {
  log({ kind: 'label-create' });
  out('');
}
if (args[0] === 'issue' && args[1] === 'list') {
  log({ kind: 'issue-list' });
  if (process.env.FAKE_GH_FAIL_LIST === '1') die('HTTP 502: Server Error');
  out(state.issues.map((i) => ({ number: i.number, title: i.title, state: i.state, body: i.body, id: i.nodeId, labels: i.labels.map((name) => ({ name })) })));
}
if (args[0] === 'issue' && args[1] === 'create') {
  log({ kind: 'issue-create' });
  die('fake gh: issue create is not simulated');
}
if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: 'acme/app' });
die(`fake gh: unknown call: ${args.join(' ')}`);
