import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { validateHostConfig } from '../src/config/hostConfig.js';
import { createSessionStore, addTurn, addResult } from '../src/session/store.js';
import { composeToolAnswer, composeFollowUp, SUMMARY_SYSTEM, FOLLOWUP_SYSTEM } from '../src/answer/composer.js';
import { createFakeEngine } from './helpers/fakeEngine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = yaml.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'example-host.config.yaml'), 'utf8'));
const { ok, config } = validateHostConfig(raw);
assert.ok(ok);
const tool = (name) => config.tools.find((t) => t.name === name);

test('coverage template exact', async () => {
  const engine = createFakeEngine(() => 'x');
  const out = await composeToolAnswer({
    tool: tool('get_coverage'),
    params: { app: 'CoreUI', metric: 'lines' },
    result: { ok: true, data: { metric: 'lines', covered: 80499, total: 106235, pct: 75.8 } },
    engine,
  });
  assert.equal(out, 'CoreUI: 80,499 / 106,235 lines covered (75.8%)');
  assert.equal(engine.calls.length, 0);
});

test('items render one line each', async () => {
  const engine = createFakeEngine(() => 'x');
  const items = ['lines', 'statements', 'branches'].map((metric, i) => ({ metric, covered: i + 1, total: 10, pct: 10 * (i + 1) }));
  const out = await composeToolAnswer({
    tool: tool('get_coverage'),
    params: { app: 'CoreUI' },
    result: { ok: true, data: { items } },
    engine,
  });
  assert.equal(out.split('\n').length, 3);
  assert.equal(out.split('\n')[1], 'CoreUI: 2 / 10 statements covered (20%)');
});

test('failure text', async () => {
  const out = await composeToolAnswer({
    tool: tool('run_unit_tests'),
    params: {},
    result: { ok: false, error: 'No folder selected' },
    engine: createFakeEngine(() => 'x'),
  });
  assert.equal(out, "Couldn't complete run_unit_tests: No folder selected");
});

test('missing placeholder falls back to LLM', async () => {
  const engine = createFakeEngine(() => 'summary');
  const out = await composeToolAnswer({
    tool: tool('get_coverage'),
    params: { app: 'CoreUI' },
    result: { ok: true, data: { covered: 1 } },
    engine,
  });
  assert.equal(out, 'summary');
  assert.equal(engine.calls[0].system, SUMMARY_SYSTEM);
});

function mkSession() {
  const store = createSessionStore({ idleTtlMs: 1000, now: () => 0 });
  return store.create(config);
}

test('follow-up without results', async () => {
  const out = await composeFollowUp({ message: 'and?', session: mkSession(), engine: createFakeEngine(() => 'x') });
  assert.equal(out, `I don't have any results to answer from yet. ${config.assistant.scopeMessage}`);
});

test('follow-up with results', async () => {
  const session = mkSession();
  addTurn(session, 'user', 'coverage of CommonUI');
  addResult(session, { tool: 'get_coverage', params: { app: 'CommonUI' }, data: { pct: 50 } });
  const engine = createFakeEngine(() => 'answer');
  const out = await composeFollowUp({ message: 'is that good?', session, engine });
  assert.equal(out, 'answer');
  assert.equal(engine.calls[0].system, FOLLOWUP_SYSTEM);
  assert.ok(engine.calls[0].prompt.includes('is that good?'));
  assert.ok(engine.calls[0].prompt.includes('"CommonUI"'));
});

import { looksLikeCode, fitResults } from '../src/answer/composer.js';
import { estimateTokens } from '../src/session/compactor.js';

const throwing = (code) => ({
  calls: [],
  async complete() {
    const e = new Error('boom');
    if (code) e.code = code;
    throw e;
  },
});

test('tool answer falls back on engine error, rethrows MODEL_NOT_READY', async () => {
  const args = { tool: tool('get_coverage'), params: { app: 'CoreUI' }, result: { ok: true, data: { covered: 1 } } };
  const out = await composeToolAnswer({ ...args, engine: throwing() });
  assert.equal(out, 'Done. Result: {"covered":1}');
  const long = await composeToolAnswer({ ...args, result: { ok: true, data: { x: 'a'.repeat(2000) } }, engine: throwing() });
  assert.ok(long.length < 560);
  await assert.rejects(composeToolAnswer({ ...args, engine: throwing('MODEL_NOT_READY') }), { code: 'MODEL_NOT_READY' });
});

test('follow-up falls back on engine error, rethrows MODEL_NOT_READY', async () => {
  const session = mkSession();
  addResult(session, { tool: 'get_coverage', params: {}, data: { pct: 1 } });
  assert.equal(await composeFollowUp({ message: 'q', session, engine: throwing() }), "I couldn't answer that from the results.");
  await assert.rejects(composeFollowUp({ message: 'q', session, engine: throwing('MODEL_NOT_READY') }), { code: 'MODEL_NOT_READY' });
});

test('code guard trips on code, not on prose', () => {
  for (const code of ['```js\nx\n```', "import a from 'b';", 'export default 1', 'function f() {}', 'const x = 1;', 'x.map(a => a)', 'return <Foo bar />']) {
    assert.equal(looksLikeCode(code), true, code);
  }
  for (const prose of ['CoreUI has 80,499 of 106,235 lines covered (75.8%).', 'Coverage is 50% and 3 tests failed.\nFramework is lowest at 12.5%.']) {
    assert.equal(looksLikeCode(prose), false, prose);
  }
});

test('guard replaces code output with scope message in summary and follow-up', async () => {
  const code = createFakeEngine(() => '```js\ntest(1)\n```');
  const s = await composeToolAnswer({ tool: tool('get_coverage'), params: {}, result: { ok: true, data: { covered: 1 } }, engine: code, config });
  assert.equal(s, config.assistant.scopeMessage);
  const session = mkSession();
  addResult(session, { tool: 'get_coverage', params: {}, data: { pct: 1 } });
  assert.equal(await composeFollowUp({ message: 'write a jest test', session, engine: code }), config.assistant.scopeMessage);
});

test('oversized results are truncated within the context budget', async () => {
  const session = mkSession();
  for (let i = 0; i < 3; i++) addResult(session, { tool: 'run_unit_tests', params: { app: 'A' + i }, data: { rows: Array.from({ length: 500 }, (_, j) => ({ j, name: 'x'.repeat(50) })) } });
  const engine = createFakeEngine(() => 'ok');
  engine.contextSize = 2048;
  await composeFollowUp({ message: 'how many?', session, engine });
  assert.ok(estimateTokens(engine.calls[0].prompt) + 300 < 2048, `prompt ${estimateTokens(engine.calls[0].prompt)}`);
  const fitted = fitResults([{ tool: 't', params: {}, data: 'z'.repeat(20000) }], 200);
  assert.ok(estimateTokens(fitted) <= 260);
});
