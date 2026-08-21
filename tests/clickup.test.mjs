import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as clickup from '../.harness/integrations/clickup/adapter.mjs';
import { makeTask, REPO, tempHarness } from './helpers.mjs';

/** A temp harness carrying the real mapping and config, so the test exercises the real files. */
function withClickup({ config = {} } = {}) {
  const { ctx, cleanup } = tempHarness();
  const dir = path.join(ctx.harnessDir, 'integrations', 'clickup');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO, '.harness', 'integrations', 'clickup', 'mapping.json'),
    path.join(dir, 'mapping.json'),
  );
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    `${JSON.stringify({ enabled: true, list_id: '901', custom_fields: {}, users: {}, ...config }, null, 2)}\n`,
  );
  return { ctx, cleanup };
}

/** A fetch that records what it was asked and answers from a script. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    const next = script.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: (name) => next.headers?.[name] ?? null },
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { impl, calls };
}

const ENV = { CLICKUP_API_TOKEN: 'pk_12345_ABCDEF' };

test('a personal token goes raw and an OAuth token takes Bearer', () => {
  // Two different formats. Confusing them returns a 401 that reads like a permissions problem
  // and sends you looking in entirely the wrong place.
  assert.equal(clickup.authHeader('pk_12345_ABC'), 'pk_12345_ABC');
  assert.equal(clickup.authHeader('abc123'), 'Bearer abc123');
});

test('without a credential it says so and nothing else depends on it', () => {
  const { ctx, cleanup } = withClickup();
  try {
    const verdict = clickup.isEnabled(ctx, {});
    assert.equal(verdict.enabled, false);
    assert.match(verdict.reason, /CLICKUP_API_TOKEN/);
    assert.match(verdict.reason, /sale con 0/, 'y dice que no rompe nada');
  } finally {
    cleanup();
  }
});

test('isEnabled returns a verdict object, never a bare boolean', () => {
  // The engine spreads this into its report, so a boolean produces a row reading "disabled"
  // with an empty reason and no error anywhere. That is exactly what the first version did.
  const { ctx, cleanup } = withClickup();
  try {
    for (const env of [{}, ENV]) {
      const verdict = clickup.isEnabled(ctx, env);
      assert.equal(typeof verdict, 'object');
      assert.equal(typeof verdict.enabled, 'boolean');
      assert.ok(verdict.reason, 'y siempre trae motivo, también cuando está activo');
    }
  } finally {
    cleanup();
  }
});

test('the status mapping is the identity, and comes from the file', () => {
  const { ctx, cleanup } = withClickup();
  try {
    const mapping = clickup.readMapping(ctx);
    assert.equal(clickup.mapStatus(mapping, 'in_progress'), 'in progress');
    assert.equal(clickup.mapStatus(mapping, 'done'), 'complete');
    assert.equal(clickup.unmapStatus(mapping, 'in review'), 'in_review');
    assert.equal(clickup.unmapStatus(mapping, 'Complete'), 'done', 'sin distinguir mayúsculas');
    assert.equal(clickup.unmapStatus(mapping, 'inventado'), null);
  } finally {
    cleanup();
  }
});

test('a status can be added by editing the mapping, without touching code', () => {
  // The whole point of the file. If the code carried a fallback table, this would pass while
  // the coupling stayed.
  const { ctx, cleanup } = withClickup();
  try {
    const file = path.join(ctx.harnessDir, 'integrations', 'clickup', 'mapping.json');
    const mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
    mapping.status.in_review = 'pendiente de revisar';
    fs.writeFileSync(file, JSON.stringify(mapping, null, 2));

    const reloaded = clickup.readMapping(ctx);
    assert.equal(clickup.mapStatus(reloaded, 'in_review'), 'pendiente de revisar');
    assert.equal(clickup.unmapStatus(reloaded, 'pendiente de revisar'), 'in_review');
  } finally {
    cleanup();
  }
});

test('a status missing from the mapping is an error naming the file, not a guess', () => {
  const { ctx, cleanup } = withClickup();
  try {
    const mapping = clickup.readMapping(ctx);
    assert.throws(() => clickup.mapStatus(mapping, 'inventado'), /mapping\.json/);
  } finally {
    cleanup();
  }
});

test('a missing mapping file is an error rather than a silent default', () => {
  // Falling back to a hardcoded table would reintroduce exactly the coupling the file removes,
  // and it would do it invisibly.
  const { ctx, cleanup } = withClickup();
  try {
    fs.rmSync(path.join(ctx.harnessDir, 'integrations', 'clickup', 'mapping.json'));
    assert.throws(() => clickup.readMapping(ctx), /no existe/);
  } finally {
    cleanup();
  }
});

test('the estimate is sent in milliseconds, which is what the API wants', () => {
  // Sending hours produces estimates nobody connects back to the cause.
  const { ctx, cleanup } = withClickup();
  try {
    const mapping = clickup.readMapping(ctx);
    assert.equal(clickup.timeEstimate(mapping, makeTask({ estimate_hours: 2 })), 7200000);
    assert.equal(clickup.timeEstimate(mapping, makeTask()), null, 'sin estimación no se envía el campo');
  } finally {
    cleanup();
  }
});

test('the body carries the criteria as a markdown checklist, in the field that wins', () => {
  // ClickUp uses `markdown_content` when both it and `description` are present, and the
  // criteria only read correctly as markdown.
  const { ctx, cleanup } = withClickup();
  try {
    const mapping = clickup.readMapping(ctx);
    const task = makeTask({
      priority: 'high',
      acceptance_criteria: [
        { id: 'AC1', must: 'Algo comprobable.', check: { type: 'review', run: null }, status: 'pass' },
        { id: 'AC2', must: 'Otra cosa.', check: { type: 'review', run: null }, status: 'pending' },
      ],
    });
    const body = clickup.taskBody(ctx, mapping, task);

    assert.match(body.name, /^FEAT-0001 · /, 'el id delante, para poder buscarla');
    assert.match(body.markdown_content, /- \[x\] \*\*AC1\*\*/);
    assert.match(body.markdown_content, /- \[ \] \*\*AC2\*\*/);
    assert.equal(body.description, undefined, 'no se envían los dos: gana markdown_content');
    assert.equal(body.status, 'backlog');
    assert.equal(body.priority, 2, 'high -> 2, y 1 es urgente');
    assert.match(body.markdown_content, /El repositorio manda/);
  } finally {
    cleanup();
  }
});

test('a custom field with no resolved id is skipped, never posted to an invented one', () => {
  // Posting to an invented field id fails with an error that says nothing about which field.
  const { ctx, cleanup } = withClickup({ config: { custom_fields: { 'Harness ID': 'cf-1' } } });
  try {
    const mapping = clickup.readMapping(ctx);
    const values = clickup.customFieldValues(ctx, mapping, makeTask({ branch: 'feat/0001-x' }));
    assert.deepEqual(values, [{ id: 'cf-1', value: 'FEAT-0001' }], 'Rama no tiene id: no se manda');
  } finally {
    cleanup();
  }
});

test('creating a task posts to the list, then sets the fields', () => {
  const { ctx, cleanup } = withClickup({ config: { custom_fields: { 'Harness ID': 'cf-1' } } });
  return (async () => {
    try {
      const { impl, calls } = fakeFetch([
        { status: 200, body: { id: 'abc123', url: 'https://app.clickup.com/t/abc123' } },
        { status: 200, body: {} },
      ]);
      const result = await clickup.apply(ctx, { op: 'create', task: makeTask(), env: ENV, fetchImpl: impl });

      assert.equal(result.id, 'abc123');
      assert.equal(result.fields_set, true);
      assert.match(calls[0].url, /\/list\/901\/task$/);
      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].headers.Authorization, 'pk_12345_ABCDEF', 'crudo, sin Bearer');
      assert.match(calls[1].url, /\/task\/abc123\/field\/cf-1$/);
      assert.deepEqual(calls[1].body, { value: 'FEAT-0001' });
    } finally {
      cleanup();
    }
  })();
});

test('a second run over an unchanged task produces no remote change', () => {
  // Idempotence is the property that makes a projection safe to run from CI.
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      const task = makeTask({ external: { clickup: { id: 'abc123', last_synced_at: '2026-08-01T00:00:00Z' } } });
      const { impl, calls } = fakeFetch([
        { status: 200, body: { status: { status: 'backlog' } } },
        { status: 200, body: {} },
      ]);
      const result = await clickup.apply(ctx, { op: 'update', task, env: ENV, fetchImpl: impl });

      assert.equal(result.id, 'abc123', 'la misma tarjeta, no una nueva');
      assert.equal(result.drifted, false);
      assert.ok(!calls.some((c) => c.method === 'POST' && /\/list\//.test(c.url)), 'no crea nada');
    } finally {
      cleanup();
    }
  })();
});

test('a card somebody dragged is reported and overwritten, never merged', () => {
  // Two sources of truth for one task is how a backlog stops being worth reading. The report
  // says what was there so a human can decide whether the repository needs the change too.
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      const task = makeTask({ status: 'backlog', external: { clickup: { id: 'abc123', last_synced_at: '2026-08-01T00:00:00Z' } } });
      const { impl } = fakeFetch([
        { status: 200, body: { status: { status: 'complete' } } },
        { status: 200, body: {} },
      ]);
      const result = await clickup.apply(ctx, { op: 'update', task, env: ENV, fetchImpl: impl });

      assert.equal(result.drifted, true);
      assert.match(result.drift_note, /complete/);
      assert.match(result.drift_note, /se sobrescribe/);
    } finally {
      cleanup();
    }
  })();
});

test('a rate limit is waited out against the reset header, not guessed', () => {
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      const { impl, calls } = fakeFetch([
        { status: 429, headers: { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000)) } },
        { status: 200, body: { ok: true } },
      ]);
      const res = await clickup.call(ctx, 'GET', '/task/x', { env: ENV, fetchImpl: impl });
      assert.deepEqual(res, { ok: true });
      assert.equal(calls.length, 2, 'reintentó una vez');
    } finally {
      cleanup();
    }
  })();
});

test('a rate limit that never clears gives up with an actionable message', () => {
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      const { impl } = fakeFetch(Array.from({ length: 5 }, () => ({ status: 429, headers: {} })));
      await assert.rejects(
        () => clickup.call(ctx, 'GET', '/task/x', { env: ENV, fetchImpl: impl, retries: 1 }),
        /429.*reintentos/,
      );
    } finally {
      cleanup();
    }
  })();
});

test('pagination starts at zero and stops when the API says it is the last page', () => {
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      assert.match(clickup.listTasksEndpoint('901', 0), /page=0/);
      const { impl, calls } = fakeFetch([
        { status: 200, body: { tasks: [{ id: 'a' }], last_page: false } },
        { status: 200, body: { tasks: [{ id: 'b' }], last_page: true } },
      ]);
      const all = await clickup.listRemote(ctx, { env: ENV, fetchImpl: impl });
      assert.deepEqual(all.map((t) => t.id), ['a', 'b']);
      assert.equal(calls.length, 2);
      assert.match(calls[1].url, /page=1/);
    } finally {
      cleanup();
    }
  })();
});

test('an HTTP error carries the status and what the API said', () => {
  const { ctx, cleanup } = withClickup();
  return (async () => {
    try {
      const { impl } = fakeFetch([{ status: 401, body: { err: 'Token invalid' } }]);
      await assert.rejects(() => clickup.call(ctx, 'GET', '/task/x', { env: ENV, fetchImpl: impl }), /401.*Token invalid/);
    } finally {
      cleanup();
    }
  })();
});

test('no credential ever reaches the configuration on disk', () => {
  // The token lives in .env. `config.json` holds identifiers, and that separation is the reason
  // this integration adds no secret to the repository.
  const body = fs.readFileSync(path.join(REPO, '.harness', 'integrations', 'clickup', 'config.json'), 'utf8');
  assert.ok(!/pk_[A-Z0-9]/i.test(body));
  assert.match(body, /\.env/, 'y el fichero dice dónde vive el token');
  const adapter = fs.readFileSync(path.join(REPO, '.harness', 'integrations', 'clickup', 'adapter.mjs'), 'utf8');
  assert.match(adapter, /env\.CLICKUP_API_TOKEN/, 'el token se lee del entorno y de ningún otro sitio');
});

test('epics are not projected: a container is noise on a board for non-technical readers', () => {
  assert.equal(clickup.skipEpics, true);
});
