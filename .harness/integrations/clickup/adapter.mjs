// ClickUp, as the optional second projection of the backlog.
//
// GitHub is the default and costs nothing (D9): `gh` is already authenticated and no secret
// enters the project. ClickUp is for the case the whole feature exists for — colleagues who do
// not read a repository and need a board they already live in.
//
// Three things this adapter will not do, and all three are structural rather than polite:
//
//   **It never reads a status back.** The repository is the source of truth (D6). Somebody
//   dragging a card is reported as drift and overwritten, because merging two truths is how a
//   backlog stops being trustworthy.
//   **It never stores a credential.** `config.json` holds identifiers; the token lives in `.env`,
//   which is gitignored, and `doctor` fails if anything credential-shaped appears in a task.
//   **Without a token it warns and exits 0.** No other command may depend on this area (P4). A
//   projection that can break a build is a projection somebody disables.
//
// Every path and field here is verified against the official documentation — see
// `docs/HARNESS-PLAN.md`, «La API de ClickUp, verificada». Nothing is written from memory.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, toPosixPath, writeJson } from '../../bin/lib/util.mjs';

export const BASE = 'https://api.clickup.com/api/v2';

/** Epics are containers, and a container on a board for non-technical readers is noise. */
export const skipEpics = true;

export function configFile(ctx) {
  return path.join(ctx.harnessDir, 'integrations', 'clickup', 'config.json');
}

export function mappingFile(ctx) {
  return path.join(ctx.harnessDir, 'integrations', 'clickup', 'mapping.json');
}

export function readConfig(ctx) {
  const file = configFile(ctx);
  return fs.existsSync(file) ? readJson(file) : { enabled: false, list_id: null, custom_fields: {}, users: {} };
}

export function writeConfig(ctx, config) {
  writeJson(configFile(ctx), config);
}

/**
 * The mapping, from the file, with no defaults baked into the code.
 *
 * The point of the file is that adding a status or renaming a field is a configuration change.
 * Falling back to a hardcoded table when the file is missing would quietly reintroduce the
 * coupling the file exists to remove — so a missing mapping is an error, not a default.
 */
export function readMapping(ctx) {
  const file = mappingFile(ctx);
  if (!fs.existsSync(file)) {
    throw new Error(`${toPosixPath(path.relative(ctx.root, file))} no existe: sin él no hay correspondencia que aplicar`);
  }
  return readJson(file);
}

/** The token, from the environment only. Never from configuration, never from a task. */
export function token(env = process.env) {
  const value = env.CLICKUP_API_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Personal tokens go raw; OAuth tokens take `Bearer`. Two different formats, and confusing them
 * returns a 401 that reads like a permissions problem and sends you looking in the wrong place.
 * A personal token starts with `pk_`.
 */
export function authHeader(value) {
  return String(value).startsWith('pk_') ? String(value) : `Bearer ${value}`;
}

/**
 * `{ enabled, reason }`, never a bare boolean.
 *
 * The engine spreads this into its report, so returning `false` produces a row that reads
 * "disabled" with an empty reason and no error anywhere — which is exactly what the first
 * version of this function did.
 */
export function isEnabled(ctx, env = process.env) {
  const cfg = readConfig(ctx);
  if (!cfg.enabled) return { enabled: false, reason: 'desactivado en integrations/clickup/config.json (enabled: false)' };
  if (!cfg.list_id) return { enabled: false, reason: 'no hay list_id: crea la lista destino y anótalo (CHORE-0003)' };
  if (!token(env)) {
    return {
      enabled: false,
      reason: 'falta CLICKUP_API_TOKEN en .env — se avisa y se sale con 0, nada más depende de esto',
    };
  }
  return { enabled: true, reason: `proyectando a la lista ${cfg.list_id}` };
}

/** Why this sink cannot run, or null. The same verdict, as a single string. */
export function disabledReason(ctx, env = process.env) {
  const verdict = isEnabled(ctx, env);
  return verdict.enabled ? null : verdict.reason;
}

// --- the mapping, applied ---------------------------------------------------

export function mapStatus(mapping, status) {
  const mapped = mapping.status?.[status];
  if (!mapped) throw new Error(`el estado "${status}" no está en mapping.json: añádelo ahí, no en el código`);
  return mapped;
}

/** The inverse, for telling a remote status apart from ours when detecting drift. */
export function unmapStatus(mapping, remote) {
  const wanted = String(remote || '').toLowerCase();
  for (const [ours, theirs] of Object.entries(mapping.status || {})) {
    if (ours.startsWith('$')) continue;
    if (String(theirs).toLowerCase() === wanted) return ours;
  }
  return null;
}

export function mapPriority(mapping, priority) {
  const value = mapping.priority?.[priority];
  return typeof value === 'number' ? value : null;
}

/** Reads `links.pr`-style dotted paths out of a task, so the mapping can name any field. */
export function pick(task, dotted) {
  return String(dotted)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), task);
}

export function tagsFor(mapping, task) {
  const tags = [];
  for (const source of mapping.labels_from || []) {
    const value = pick(task, source);
    if (Array.isArray(value)) tags.push(...value.map(String));
    else if (value != null) tags.push(String(value));
  }
  return [...new Set(tags)];
}

/**
 * The estimate, in the unit ClickUp actually wants.
 * `time_estimate` is an integer in **milliseconds**. Sending hours produces estimates nobody
 * connects back to the cause, so the unit comes from the mapping and is applied here once.
 */
export function timeEstimate(mapping, task) {
  const spec = mapping.time_estimate;
  if (!spec?.field) return null;
  const hours = pick(task, spec.field);
  if (typeof hours !== 'number') return null;
  return Math.round(hours * (spec.multiplier ?? 1));
}

/**
 * The body of a create or update call, built from the mapping and nothing else.
 * `markdown_content` rather than `description`: ClickUp uses the former when both are present,
 * and the criteria are a checklist that only reads correctly as markdown.
 */
export function taskBody(ctx, mapping, task) {
  const criteria = (task.acceptance_criteria || [])
    .map((ac) => `- [${ac.status === 'pass' ? 'x' : ' '}] **${ac.id}** ${ac.must}`)
    .join('\n');

  const body = {
    name: `${task.id} · ${task.title}`,
    markdown_content: [
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
      'Proyectado por harness. El repositorio manda: editar aquí no cambia nada y se sobrescribe.',
    ].join('\n'),
    status: mapStatus(mapping, task.status),
    tags: tagsFor(mapping, task),
  };

  const priority = mapPriority(mapping, task.priority);
  if (priority !== null) body.priority = priority;

  const estimate = timeEstimate(mapping, task);
  if (estimate !== null) body.time_estimate = estimate;

  const assignee = (readConfig(ctx).users || {})[task.assignee?.id];
  if (typeof assignee === 'number') body.assignees = [assignee];

  return body;
}

/** Which custom fields to set after the task exists, resolved to the ids in config.json. */
export function customFieldValues(ctx, mapping, task) {
  const ids = readConfig(ctx).custom_fields || {};
  const out = [];
  for (const [name, source] of Object.entries(mapping.custom_fields || {})) {
    if (name.startsWith('$')) continue;
    const id = ids[name];
    const value = pick(task, source);
    // A field nobody has resolved an id for is skipped rather than guessed: posting to an
    // invented field id fails with an error that says nothing about which field.
    if (!id || value == null) continue;
    out.push({ id, value: String(value) });
  }
  return out;
}

// --- the transport ---------------------------------------------------------

/**
 * One call, with the rate limit respected.
 *
 * `X-RateLimit-Reset` is a Unix timestamp, so a 429 tells you exactly how long to wait. With an
 * enterprise plan (10.000/min) this never fires against a backlog of ninety; a project on the
 * business plan has 100/min and it fires immediately, which is why it is here from the start.
 */
export async function call(ctx, method, endpoint, { body = null, env = process.env, fetchImpl = fetch, retries = 3 } = {}) {
  const auth = token(env);
  if (!auth) throw new Error('CLICKUP_API_TOKEN no está en el entorno');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetchImpl(`${BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: authHeader(auth),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status !== 429) {
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }
      if (!res.ok) {
        const err = new Error(`ClickUp ${method} ${endpoint} -> ${res.status}: ${parsed?.err || parsed?.raw || 'sin detalle'}`);
        err.status = res.status;
        throw err;
      }
      return parsed;
    }

    if (attempt === retries) {
      const err = new Error(`ClickUp devolvió 429 tras ${retries} reintentos: baja el ritmo o sube de plan`);
      err.status = 429;
      throw err;
    }
    const reset = Number(res.headers?.get?.('X-RateLimit-Reset'));
    const waitMs = Number.isFinite(reset) && reset > 0
      ? Math.max(1000, reset * 1000 - Date.now())
      : 2000 * (attempt + 1);
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(waitMs, 60000));
    });
  }
  throw new Error('inalcanzable');
}

export function listTasksEndpoint(listId, page = 0) {
  // `page` starts at 0 and a page holds at most 100 tasks; `last_page` in the response says
  // whether to keep going. There is no cursor.
  return `/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`;
}

/** Every remote task, paginated to the end. */
export async function listRemote(ctx, { env = process.env, fetchImpl = fetch, maxPages = 50 } = {}) {
  const listId = readConfig(ctx).list_id;
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const res = await call(ctx, 'GET', listTasksEndpoint(listId, page), { env, fetchImpl });
    out.push(...(res?.tasks || []));
    if (res?.last_page !== false) break;
  }
  return out;
}

// --- the sink interface ----------------------------------------------------

let index = null;
let skipReason = null;

export function prepare(ctx, { dryRun = false, env = process.env, fetchImpl = fetch } = {}) {
  index = null;
  skipReason = disabledReason(ctx, env);
  if (skipReason) return;
  void dryRun;
  void fetchImpl;
  // The remote index is loaded lazily by `apply`: unlike GitHub, one list call is cheap and
  // a dry run has nothing to compare against until it knows the ids anyway.
}

export function projectSkipReason() {
  return skipReason;
}

export function incompleteReason(ctx, task) {
  const state = task.external?.clickup || {};
  if (!state.id) return null; // nothing projected yet; the engine will create it
  const ids = readConfig(ctx).custom_fields || {};
  const mapping = readMapping(ctx);
  for (const name of Object.keys(mapping.custom_fields || {})) {
    if (name.startsWith('$')) continue;
    if (ids[name] && !state.fields_set) return `los campos personalizados no se han fijado todavía`;
  }
  return null;
}

/**
 * One operation. Push-only: `create`, `update`, `close`.
 *
 * A remote edit is reported and overwritten, never merged. Two sources of truth for one task is
 * how a backlog stops being worth reading.
 */
export async function apply(ctx, { op, task, env = process.env, fetchImpl = fetch } = {}) {
  const mapping = readMapping(ctx);
  const cfg = readConfig(ctx);
  const state = task.external?.clickup || {};
  const body = taskBody(ctx, mapping, task);

  if (op === 'create' || !state.id) {
    const created = await call(ctx, 'POST', `/list/${cfg.list_id}/task`, { body, env, fetchImpl });
    const result = { id: created.id, url: created.url ?? null, fields_set: false };
    await setFields(ctx, mapping, task, result.id, { env, fetchImpl });
    return { ...result, fields_set: true, last_synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  const drifted = await detectDrift(ctx, task, { env, fetchImpl });
  await call(ctx, 'PUT', `/task/${state.id}`, { body, env, fetchImpl });
  await setFields(ctx, mapping, task, state.id, { env, fetchImpl });
  return {
    id: state.id,
    url: state.url ?? null,
    fields_set: true,
    drifted: drifted.drifted,
    drift_note: drifted.note,
    last_synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function setFields(ctx, mapping, task, taskId, opts) {
  for (const field of customFieldValues(ctx, mapping, task)) {
    await call(ctx, 'POST', `/task/${taskId}/field/${field.id}`, { body: { value: field.value }, ...opts });
  }
}

/**
 * Did somebody edit the card by hand?
 *
 * Reported and logged, then overwritten. Nothing is merged, and the report says what was there
 * so the human can decide whether the repository needs the change too.
 */
export async function detectDrift(ctx, task, { env = process.env, fetchImpl = fetch } = {}) {
  const state = task.external?.clickup || {};
  if (!state.id || !state.last_synced_at) return { drifted: false, note: null };
  try {
    const remote = await call(ctx, 'GET', `/task/${state.id}`, { env, fetchImpl });
    const mapping = readMapping(ctx);
    const remoteStatus = unmapStatus(mapping, remote?.status?.status);
    if (remoteStatus && remoteStatus !== task.status) {
      return {
        drifted: true,
        note: `alguien movió la tarjeta a "${remote.status.status}" (aquí está en ${task.status}); se sobrescribe`,
      };
    }
    return { drifted: false, note: null };
  } catch {
    // Failing to check for drift is not a reason to fail the projection: the push is still
    // correct, and a sink that stops working because a diagnostic failed is worse.
    return { drifted: false, note: null };
  }
}
