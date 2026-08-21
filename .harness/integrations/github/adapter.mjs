// GitHub sink: the default projection, and the one that needs no secret.
//
// Transport is `gh`, which is already authenticated, so nothing lands in .env. Two halves
// with different credential needs, and the split matters in CI:
//
//   - Issues are a *repository* resource, so Actions' GITHUB_TOKEN can write them.
//   - A Project is a *user or organisation* resource, so it needs a PAT or App with the
//     `project` scope. Locally: `gh auth refresh -s project`.
//
// The project half therefore disables itself with an explanation rather than failing the
// build. Verified against the GraphQL schema on 2026-08-20 (see docs/areas/integrations.md).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const skipEpics = false;

/** The seven harness statuses, projected one-to-one so the mapping is the identity. */
export const STATUS_OPTIONS = [
  { name: 'backlog', color: 'GRAY' },
  { name: 'ready', color: 'BLUE' },
  { name: 'in progress', color: 'YELLOW' },
  { name: 'in review', color: 'ORANGE' },
  { name: 'blocked', color: 'RED' },
  { name: 'complete', color: 'GREEN' },
  { name: 'cancelled', color: 'PURPLE' },
];

const STATUS_TO_OPTION = {
  backlog: 'backlog',
  ready: 'ready',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'complete',
  cancelled: 'cancelled',
};

function configFile(ctx) {
  return path.join(ctx.harnessDir, 'integrations', 'github', 'config.json');
}

export function readConfig(ctx) {
  const file = configFile(ctx);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(ctx, config) {
  const file = configFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function gh(ctx, args, { allowFail = false } = {}) {
  const res = spawnSync('gh', args, { cwd: ctx.root, encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  if (res.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(res.stderr || out).trim().split('\n')[0]}`);
  }
  return { code: res.status ?? 1, out, err: (res.stderr || '').trim() };
}

export function hasGh(ctx) {
  return gh(ctx, ['--version'], { allowFail: true }).code === 0;
}

/**
 * Can this credential reach *that* board?
 *
 * The first version asked whether the caller could read its own projects. Actions'
 * GITHUB_TOKEN passes that — the bot's own empty list reads fine — and then every board
 * write failed one task at a time with "Resource not accessible by integration". The only
 * probe worth making is against the resource actually being written.
 */
export function canReachProject(ctx, project) {
  if (!project?.owner || !project?.number) return { ok: false, reason: 'no project configured' };
  try {
    discoverProject(ctx, project);
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: classifyProjectError(e.message) };
  }
}

export const DENIED_HINT =
  'the credential cannot reach the board (locally: gh auth refresh -s project; in CI: a PAT in HARNESS_PROJECT_TOKEN)';

/**
 * A permission problem and a configuration mistake need different answers, so they are told
 * apart rather than reported as one vague failure.
 */
export function classifyProjectError(message) {
  const denied = /not accessible|resource not accessible|insufficient|scope|forbidden|401|403/i.test(String(message));
  return denied ? DENIED_HINT : String(message);
}

export function isEnabled(ctx) {
  const cfg = readConfig(ctx);
  if (cfg.enabled === false) return { enabled: false, reason: 'disabled in integrations/github/config.json' };
  if (!hasGh(ctx)) return { enabled: false, reason: 'the gh CLI is not installed' };
  const repo = gh(ctx, ['repo', 'view', '--json', 'nameWithOwner'], { allowFail: true });
  if (repo.code !== 0) return { enabled: false, reason: 'no GitHub repository detected for this directory' };
  return { enabled: true, reason: `projecting to ${JSON.parse(repo.out).nameWithOwner}` };
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

/** `FEAT-0042 · Título` — the id leads so the issue is findable by search and by eye. */
export function issueTitle(task) {
  return `${task.id} · ${task.title}`;
}

export function issueBody(ctx, task) {
  const criteria = (task.acceptance_criteria || [])
    .map((ac) => `- [${ac.status === 'pass' ? 'x' : ' '}] **${ac.id}** ${ac.must}`)
    .join('\n');
  const lines = [
    task.description,
    '',
    '### Criterios de aceptación',
    '',
    criteria || '_Sin criterios._',
    '',
    '---',
    '',
    `Estado en el harness: \`${task.status}\`${task.context?.area ? ` · área \`${task.context.area}\`` : ''}`,
    `Tarea: \`.harness/backlog/tasks/${task.id}.json\``,
    '',
    '<!-- Proyectado por harness. El repositorio es la fuente de verdad: editar aquí no cambia nada',
    '     y se sobrescribirá en la siguiente sincronización. -->',
  ];
  return lines.join('\n');
}

/** Hash of a body we wrote, so a later comparison can tell an edit from an update. */
export function bodyHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex').slice(0, 16);
}

export function labelsFor(task) {
  const labels = [`type:${task.type}`];
  if (task.priority) labels.push(`priority:${task.priority}`);
  if (task.context?.area) labels.push(`area:${task.context.area}`);
  return [...labels, ...(task.labels || [])];
}

/** Closed statuses close the issue; everything else keeps it open. */
export function isClosed(task) {
  return task.status === 'done' || task.status === 'cancelled';
}

/**
 * Every issue, fetched once.
 *
 * The first version searched the API per task. On a backlog of ninety that is ninety
 * searches — measured at roughly half a minute each, so the projection would have taken half
 * an hour. One list plus a lookup table is the same information for one round trip.
 */
let issueIndex = null;

function loadIssueIndex(ctx) {
  const index = new Map();
  for (let page = 0; page < 20; page += 1) {
    const res = gh(
      ctx,
      ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,state,body,id'],
      { allowFail: true },
    );
    if (res.code !== 0 || !res.out) break;
    let issues;
    try {
      issues = JSON.parse(res.out);
    } catch {
      break;
    }
    for (const issue of issues) {
      const id = String(issue.title).split(' ')[0];
      if (/^[A-Z]+-\d{4}$/.test(id)) index.set(id, issue);
    }
    break; // `gh issue list` caps at its limit; 1000 covers any backlog this tool is for
  }
  return index;
}

function findIssueByTitle(ctx, task) {
  if (!issueIndex) issueIndex = loadIssueIndex(ctx);
  return issueIndex.get(task.id) || null;
}

/** Keeps the table honest after a create, so a re-run inside one session does not duplicate. */
function rememberIssue(task, issue) {
  if (issueIndex) issueIndex.set(task.id, issue);
}

// ---------------------------------------------------------------------------
// project board
// ---------------------------------------------------------------------------

/**
 * Discovers the three stable ids — project, status field, and one per option — in a single
 * query, and caches them. Four ids are needed to move a card; only the item id is per task.
 */
export function discoverProject(ctx, { owner, number }) {
  const query = `query($owner:String!,$number:Int!){
    user(login:$owner){ projectV2(number:$number){ id title
      fields(first:50){ nodes{
        ... on ProjectV2SingleSelectField { id name options { id name } }
        ... on ProjectV2Field { id name }
      } } } }
  }`;
  const res = gh(ctx, ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `number=${number}`], {
    allowFail: true,
  });
  if (res.code !== 0) throw new Error(`cannot read project ${owner}/#${number}: ${res.err.split('\n')[0]}`);
  const project = JSON.parse(res.out).data?.user?.projectV2;
  if (!project) throw new Error(`project ${owner}/#${number} not found`);
  const statusField = (project.fields.nodes || []).find((f) => f.name === 'Status' && f.options);
  if (!statusField) throw new Error('the project has no single-select field named "Status"');
  return {
    project_id: project.id,
    status_field_id: statusField.id,
    status_options: Object.fromEntries(statusField.options.map((o) => [o.name, o.id])),
  };
}

function addToProject(ctx, projectId, contentId) {
  const mutation = `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p contentId:$c}){ item { id } } }`;
  const res = gh(ctx, ['api', 'graphql', '-f', `query=${mutation}`, '-F', `p=${projectId}`, '-F', `c=${contentId}`]);
  return JSON.parse(res.out).data.addProjectV2ItemById.item.id;
}

function setStatus(ctx, { projectId, itemId, fieldId, optionId }) {
  const mutation = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
    updateProjectV2ItemFieldValue(input:{projectId:$p itemId:$i fieldId:$f value:{singleSelectOptionId:$o}}){
      projectV2Item { id } } }`;
  gh(ctx, [
    'api', 'graphql', '-f', `query=${mutation}`,
    '-F', `p=${projectId}`, '-F', `i=${itemId}`, '-F', `f=${fieldId}`, '-F', `o=${optionId}`,
  ]);
}

// ---------------------------------------------------------------------------
// the sink contract
// ---------------------------------------------------------------------------

let projectIds = null;
let projectDisabledReason = null;

export function prepare(ctx, { dryRun = false } = {}) {
  const cfg = readConfig(ctx);
  projectIds = null;
  projectDisabledReason = null;

  if (!cfg.project) {
    projectDisabledReason = 'no project configured in integrations/github/config.json';
    return;
  }
  // Finding out what we can do belongs here, once — not in the writes, one failure per task.
  // A dry run discovers too: the queries are read-only, and a plan that could not see the
  // board would report nothing to do for every task already missing from it.
  const reach = canReachProject(ctx, cfg.project);
  if (!reach.ok) {
    // The honest degradation: issues still project, the board is skipped with a reason.
    projectDisabledReason = reach.reason;
    return;
  }
  projectIds = { ...cfg.project, ...discoverProject(ctx, cfg.project) };
  if (!dryRun) writeConfig(ctx, { ...cfg, project: projectIds });
}

export function projectSkipReason() {
  return projectDisabledReason;
}

/**
 * What this sink still owes for a task whose content is already current.
 *
 * Without this, a task that gained its issue before the board was configured stayed off
 * the board for ever: its content hash was up to date, so the engine skipped it.
 */
export function incompleteReason(ctx, task) {
  const state = task.external?.github || {};
  if (!state.issue) return null; // nothing projected yet; the engine will create it
  if (projectIds && !state.project_item_id) return "not on the project board yet";
  return null;
}

export async function apply(ctx, { op, task }) {
  const existing = findIssueByTitle(ctx, task);
  const body = issueBody(ctx, task);
  const title = issueTitle(task);
  let number = existing?.number ?? null;
  let drifted = false;

  if (!existing) {
    // Labels go in the create call: one round trip instead of one per label.
    const res = gh(ctx, ['issue', 'create', '--title', title, '--body', body, '--label', labelsFor(task).join(',')], {
      allowFail: true,
    });
    if (res.code !== 0) {
      // A label that does not exist yet makes the whole create fail, so retry without them
      // and add them after: losing a label is better than losing the issue.
      const bare = gh(ctx, ['issue', 'create', '--title', title, '--body', body]);
      number = Number((bare.out.match(/\/issues\/(\d+)/) || [])[1]) || null;
      if (number) gh(ctx, ['issue', 'edit', String(number), '--add-label', labelsFor(task).join(',')], { allowFail: true });
    } else {
      number = Number((res.out.match(/\/issues\/(\d+)/) || [])[1]) || null;
    }
    if (number) rememberIssue(task, { number, title, state: 'OPEN', body });
  } else {
    // Drift means "somebody edited this", not "the task changed". Comparing the remote body
    // to the *new* one flags every legitimate update, so the comparison is against a hash of
    // the body we last wrote. Without that record there is nothing to compare and no claim
    // to make.
    const lastWritten = task.external?.github?.remote_hash;
    if (op === 'update' && lastWritten && existing.body) {
      drifted = bodyHash(existing.body) !== lastWritten;
    }
    gh(ctx, ['issue', 'edit', String(number), '--title', title, '--body', body], { allowFail: true });
  }

  if (isClosed(task) && existing?.state !== 'CLOSED') gh(ctx, ['issue', 'close', String(number)], { allowFail: true });
  else if (!isClosed(task) && existing?.state === 'CLOSED') gh(ctx, ['issue', 'reopen', String(number)], { allowFail: true });

  const state = { id: String(number), url: null, issue: number, drifted, remote_hash: bodyHash(body) };

  if (projectIds) {
    // The node id comes from the list when we have it: one fewer round trip per task.
    const knownNodeId = existing?.id;
    const contentId = knownNodeId ? { code: 0, out: JSON.stringify({ id: knownNodeId }) } : gh(ctx, ['issue', 'view', String(number), '--json', 'id'], { allowFail: true });
    if (contentId.code === 0) {
      const nodeId = JSON.parse(contentId.out).id;
      const remembered = task.external?.github?.project_item_id;
      const itemId = remembered || addToProject(ctx, projectIds.project_id, nodeId);
      const optionName = STATUS_TO_OPTION[task.status];
      const optionId = projectIds.status_options?.[optionName];
      if (optionId) {
        setStatus(ctx, {
          projectId: projectIds.project_id,
          itemId,
          fieldId: projectIds.status_field_id,
          optionId,
        });
      }
      state.project_item_id = itemId;
    }
  }

  return state;
}
