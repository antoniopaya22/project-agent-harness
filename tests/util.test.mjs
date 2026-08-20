import assert from 'node:assert/strict';
import test from 'node:test';
import { globToRegExp, matchesAny, parseArgs, parseFrontMatter, table } from '../.harness/bin/lib/util.mjs';

test('parseArgs handles the three flag spellings and positionals', () => {
  const { flags, positional } = parseArgs(['show', 'FEAT-0001', '--json', '--area', 'api', '--size=M']);
  assert.deepEqual(positional, ['show', 'FEAT-0001']);
  assert.equal(flags.json, true);
  assert.equal(flags.area, 'api');
  assert.equal(flags.size, 'M');
});

test('a repeated flag accumulates instead of overwriting', () => {
  // Losing all but the last value silently discards input the caller believed it passed.
  const { flags } = parseArgs(['context', 'FEAT-0001', '--file', '.gitignore', '--file', 'src/a.mjs']);
  assert.deepEqual([].concat(flags.file), ['.gitignore', 'src/a.mjs']);

  const three = parseArgs(['--doc', 'a.md', '--doc', 'b.md', '--doc', 'c.md']).flags.doc;
  assert.deepEqual(three, ['a.md', 'b.md', 'c.md']);
});

test('a single occurrence stays a scalar, so typeof checks keep working', () => {
  assert.equal(typeof parseArgs(['--area', 'api']).flags.area, 'string');
});

test('everything after -- is positional, even if it looks like a flag', () => {
  const { flags, positional } = parseArgs(['split', 'FEAT-0001', '--', '--raro', 'otro']);
  assert.deepEqual(positional, ['split', 'FEAT-0001', '--raro', 'otro']);
  assert.deepEqual(flags, {});
});

test('a flag whose value begins with -- is only reachable via --key=value', () => {
  assert.equal(parseArgs(['--message', '--no-verify']).flags.message, true);
  assert.equal(parseArgs(['--message=--no-verify']).flags.message, '--no-verify');
});

test('an empty string value is preserved rather than becoming true', () => {
  assert.equal(parseArgs(['--reason=']).flags.reason, '');
});

test('globToRegExp distinguishes * from ** across path segments', () => {
  assert.ok(globToRegExp('src/*.mjs').test('src/a.mjs'));
  assert.ok(!globToRegExp('src/*.mjs').test('src/deep/a.mjs'), '* must not cross a separator');
  assert.ok(globToRegExp('src/**/*.mjs').test('src/deep/nested/a.mjs'));
  assert.ok(globToRegExp('src/**/*.mjs').test('src/a.mjs'), '**/ must also match zero segments');
  assert.ok(globToRegExp('.harness/**').test('.harness/bin/lib/util.mjs'));
});

test('a dot in a glob is literal, not any-character', () => {
  assert.ok(globToRegExp('*.mjs').test('a.mjs'));
  assert.ok(!globToRegExp('*.mjs').test('axmjs'));
});

test('matchesAny normalises separators so Windows paths match', () => {
  assert.ok(matchesAny('src\\api\\users.py', ['src/api/**']));
});

test('front matter reads scalars, inline arrays and block arrays', () => {
  const { data, body } = parseFrontMatter(
    ['---', 'id: worker', 'network: false', 'effort: 3', 'capabilities: [read, edit]', 'writes:', '  - src', '  - tests', '---', '', 'El cuerpo.'].join('\n'),
  );
  assert.equal(data.id, 'worker');
  assert.equal(data.network, false);
  assert.equal(data.effort, 3);
  assert.deepEqual(data.capabilities, ['read', 'edit']);
  assert.deepEqual(data.writes, ['src', 'tests']);
  assert.equal(body.trim(), 'El cuerpo.');
});

test('a document without front matter returns its body untouched', () => {
  const { data, body } = parseFrontMatter('# Solo texto\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# Solo texto\n');
});

test('a quoted value keeps characters that would otherwise be parsed', () => {
  const { data } = parseFrontMatter(['---', 'args: "<TASK-ID>"', 'purpose: Hacer algo, con coma', '---', ''].join('\n'));
  assert.equal(data.args, '<TASK-ID>');
  assert.equal(data.purpose, 'Hacer algo, con coma');
});

test('table aligns columns and never leaves trailing whitespace', () => {
  const lines = table([['a', 'bb'], ['ccc', 'd']], ['X', 'Y']).split('\n');
  for (const line of lines) {
    assert.equal(line, line.trimEnd(), 'a padded last column would leave trailing spaces');
  }
  // The second column must begin at the same offset on every row.
  const offsets = [lines[0].indexOf('Y'), lines[1].indexOf('bb'), lines[2].indexOf('d')];
  assert.equal(new Set(offsets).size, 1, `columns misaligned: ${offsets.join(', ')}`);
});
