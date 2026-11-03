import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateHostConfig } from '../src/config/hostConfig.js';
import { createAliasMatcher } from '../src/entities/aliasMatcher.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = parse(fs.readFileSync(path.join(repoRoot, 'examples', 'example-host.config.yaml'), 'utf8'));
const { ok, config } = validateHostConfig(raw);
assert.ok(ok);
const matcher = createAliasMatcher(config.entities);

test('independent matching per entity type', () => {
  assert.deepEqual(matcher.match('execute we common test'), {
    app: { value: 'CommonUI' },
  });
});

test('compact and spaced forms match each other', () => {
  assert.equal(matcher.match('total number of lines cover in wecore').app.value, 'CoreUI');
  assert.equal(matcher.match('lines in we core').app.value, 'CoreUI');
  assert.equal(matcher.match('run tests for CoreUI').app.value, 'CoreUI');
  assert.equal(matcher.match('statement coverage for we track').app.value, 'WeTrackUI');
});

test('group only, no app', () => {
  const r = matcher.match('how many unit tests in you apps');
  assert.equal(r.group.value, 'you');
  assert.equal('app' in r, false);
});

test('fuzzy match for a single typo', () => {
  assert.equal(matcher.match('run tests for comonui').app.value, 'CommonUI');
});

test('no false positives on ordinary words', () => {
  assert.deepEqual(matcher.match('what is my score'), {});
  assert.deepEqual(matcher.match('write a react component'), {});
  assert.equal('app' in matcher.match('run the unit tests'), false);
});

test('ambiguous alias returns sorted candidates', () => {
  const m = createAliasMatcher({ app: { YouCertUI: ['cert'], CertUI: ['cert'] } });
  assert.deepEqual(m.match('tests for cert'), { app: { candidates: ['CertUI', 'YouCertUI'] } });
});

test('values lists configured values', () => {
  assert.equal(matcher.values('app').length, 17);
  assert.deepEqual(matcher.values('nope'), []);
});

test('bare you/we do not match a group', () => {
  assert.equal('group' in matcher.match('what do we have for you'), false);
  assert.equal(matcher.match('tests in we group').group.value, 'we');
});
