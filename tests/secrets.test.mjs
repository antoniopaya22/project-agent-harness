import assert from 'node:assert/strict';
import test from 'node:test';
import { findSecrets } from '../.harness/bin/lib/secrets.mjs';

test('an assignment of something long to a secret-ish name is caught', () => {
  for (const line of [
    '+api_key = "a1b2c3d4e5f6g7h8i9j0"',
    "+const token: 'abcdefghijklmnopqrstuvwx'",
    '+PASSWORD=supersecretovalorlargo1234',
    '+credential: aaaaaaaaaaaaaaaaaaaaaaa',
  ]) {
    assert.equal(findSecrets(line).length, 1, `missed: ${line}`);
  }
});

test('known provider token shapes are caught without needing a provider list per release', () => {
  const cases = [
    'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'xoxb-aaaaaaaaaaaaaaaaaaaaaaaa',
    'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'glpat-aaaaaaaaaaaaaaaaaaaaaa',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaa',
  ];
  for (const line of cases) {
    assert.ok(findSecrets(`+${line}`).length > 0, `missed: ${line}`);
  }
});

test('ordinary code is not flagged', () => {
  const clean = [
    '+const token = readToken();',
    '+  password: null,',
    '+// api_key goes in .env',
    '+CLICKUP_API_TOKEN=',
    '+import { estimateTokens } from "./util.mjs";',
    '+  "secret": "",',
  ];
  for (const line of clean) {
    assert.deepEqual(findSecrets(line), [], `false positive: ${line}`);
  }
});

test('the finding names what matched and quotes the line, so it can be judged', () => {
  const hits = findSecrets('+  api_key = "a1b2c3d4e5f6g7h8i9j0"');
  assert.equal(hits[0].name, 'assignment');
  assert.equal(hits[0].line, 1);
  assert.match(hits[0].excerpt, /api_key/);
});

test('the excerpt is truncated, so a huge line does not flood the output', () => {
  const hits = findSecrets(`+api_key = "${'a'.repeat(500)}"`);
  assert.ok(hits[0].excerpt.length <= 80);
});

test('several lines report several hits with their line numbers', () => {
  const hits = findSecrets(['+limpio', '+api_key = "aaaaaaaaaaaaaaaaaaaaaa"', '+limpio', '+AKIAIOSFODNN7EXAMPLE'].join('\n'));
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.line), [2, 4]);
});
