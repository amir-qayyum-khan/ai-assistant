import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { validateHostConfig } from '../src/config/hostConfig.js';
import { createSessionStore, addResult } from '../src/session/store.js';
import { route, completeToolCall, buildRouterSystem } from '../src/router.js';
import { createFakeEngine } from './helpers/fakeEngine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = yaml.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'example-host.config.yaml'), 'utf8'));
const { ok, config } = validateHostConfig(raw);
assert.ok(ok);
const newSession = (cfg = config) => createSessionStore({ idleTtlMs: 60000 }).create(cfg);
const decide = (d) => createFakeEngine(() => d);

test('run_unit_tests resolves entity from hints', async () => {
  const s = newSession();
  const r = await route({ session: s, message: 'execute we common test', engine: decide({ tool: 'run_unit_tests', params: {} }) });
  assert.equal(r.type, 'tool_call');
  assert.deepEqual(r.params, { app: 'CommonUI' });
  assert.equal(r.confirm, 'folder');
  assert.ok(s.pendingCalls.has(r.callId));
});

test('get_coverage takes enum from model', async () => {
  const r = await route({ session: newSession(), message: 'total number of lines cover in wecore', engine: decide({ tool: 'get_coverage', params: { metric: 'lines' } }) });
  assert.deepEqual(r.params, { app: 'CoreUI', metric: 'lines' });
});

test('get_coverage null metric uses default', async () => {
  const r = await route({ session: newSession(), message: 'coverage of wecore', engine: decide({ tool: 'get_coverage', params: { metric: null } }) });
  assert.equal(r.params.metric, 'all');
});

test('group entity from hints, optional omitted', async () => {
  const e = decide({ tool: 'get_test_totals', params: {} });
  const r1 = await route({ session: newSession(), message: 'how many unit tests in we apps', engine: e });
  assert.deepEqual(r1.params, { group: 'we' });
  const r2 = await route({ session: newSession(), message: 'unit test totals', engine: e });
  assert.deepEqual(r2.params, {});
});

test('out_of_scope returns scope message', async () => {
  const r = await route({ session: newSession(), message: 'write me a poem', engine: decide({ tool: 'out_of_scope' }) });
  assert.deepEqual(r, { type: 'out_of_scope', text: config.assistant.scopeMessage });
});

test('missing required entity clarifies, then fills without engine', async () => {
  for (const reply of ['we common', 'CommonUI']) {
    const s = newSession();
    const engine = decide({ tool: 'run_unit_tests', params: {} });
    const c = await route({ session: s, message: 'run the unit tests', engine });
    assert.equal(c.type, 'clarify');
    assert.deepEqual(c.missing, ['app']);
    assert.equal(c.options.length, 17);
    assert.ok(c.text.startsWith('Which app? Options: '));
    const calls = engine.calls.length;
    const r = await route({ session: s, message: reply, engine });
    assert.equal(r.type, 'tool_call');
    assert.equal(r.tool, 'run_unit_tests');
    assert.deepEqual(r.params, { app: 'CommonUI' });
    assert.equal(engine.calls.length, calls);
    assert.equal(s.pendingClarify, null);
  }
});

test('ambiguous inline entity clarifies with candidates', async () => {
  const cfg = validateHostConfig({
    assistant: { name: 'T', scope_message: 'nope' },
    entities: { app: { CertUI: ['cert'], YouCertUI: ['cert'] } },
    tools: [{ name: 'run_tests', description: 'Run tests', params: { app: { entity: 'app', required: true } } }],
  });
  assert.ok(cfg.ok, JSON.stringify(cfg.errors));
  const s = newSession(cfg.config);
  const r = await route({ session: s, message: 'run tests for cert', engine: decide({ tool: 'run_tests', params: {} }) });
  assert.equal(r.type, 'clarify');
  assert.deepEqual(r.options, ['CertUI', 'YouCertUI']);
  assert.equal(r.text, 'Which app do you mean: CertUI, YouCertUI?');
  assert.deepEqual(s.pendingClarify.missing, ['app']);
});

test('answer_from_context composes follow-up', async () => {
  const s = newSession();
  addResult(s, { tool: 'get_coverage', params: { app: 'CoreUI' }, data: { pct: 75.8 } });
  const engine = createFakeEngine((req) => (req.jsonSchema ? { tool: 'answer_from_context' } : 'It was 75.8%.'));
  const r = await route({ session: s, message: 'what was that again?', engine });
  assert.deepEqual(r, { type: 'answer', text: 'It was 75.8%.' });
});

test('engine error (non-MODEL_NOT_READY) gives generic clarify', async () => {
  const s = newSession();
  const engine = createFakeEngine(() => { const e = new Error('bad grammar parse'); e.code = 'PARSE'; throw e; });
  const r = await route({ session: s, message: 'hello', engine });
  const names = config.tools.map((t) => t.name);
  assert.deepEqual(r, {
    type: 'clarify',
    text: `Sorry, I didn't understand that. I can help with: ${names.join(', ')}.`,
    missing: [],
    options: names,
  });
  assert.equal(s.pendingClarify, null);
  assert.equal(s.turns.at(-1).role, 'assistant');
});

test('unknown tool in decision gives generic clarify', async () => {
  const r = await route({ session: newSession(), message: 'x', engine: decide({ tool: 'nope' }) });
  assert.equal(r.type, 'clarify');
  assert.deepEqual(r.missing, []);
});

test('MODEL_NOT_READY propagates', async () => {
  const engine = createFakeEngine(() => ({}), { ready: false });
  await assert.rejects(route({ session: newSession(), message: 'hi', engine }), { code: 'MODEL_NOT_READY' });
});

test('completeToolCall', async () => {
  const s = newSession();
  const engine = decide({ tool: 'get_coverage', params: { metric: 'lines' } });
  await assert.rejects(completeToolCall({ session: s, callId: 'nope', ok: true, data: {}, engine }), { code: 'UNKNOWN_CALL' });
  const r = await route({ session: s, message: 'lines coverage wecore', engine });
  const a = await completeToolCall({
    session: s, callId: r.callId, ok: true, data: { metric: 'lines', covered: 1, total: 2, pct: 50 }, engine,
  });
  assert.equal(a.type, 'answer');
  assert.equal(s.results.length, 1);
  await assert.rejects(completeToolCall({ session: s, callId: r.callId, ok: true, data: {}, engine }), { code: 'UNKNOWN_CALL' });
});

test('buildRouterSystem lists tools and recent results', () => {
  const s = newSession();
  assert.ok(buildRouterSystem(config, s).includes('- get_coverage: Coverage numbers'));
  addResult(s, { tool: 'run_unit_tests', params: { app: 'CommonUI' }, data: { ok: 1 } });
  assert.ok(buildRouterSystem(config, s).includes('Recent results: run_unit_tests(app=CommonUI)'));
});

test('completeToolCall stores result before composing; engine failure falls back and follow-up still works', async () => {
  const s = newSession();
  const r = await route({ session: s, message: 'coverage of wecore', engine: decide({ tool: 'get_coverage', params: {} }) });
  const failing = createFakeEngine(() => { throw new Error('boom'); });
  const out = await completeToolCall({ session: s, callId: r.callId, ok: true, data: { weird: 1 }, engine: failing });
  assert.equal(out.type, 'answer');
  assert.ok(out.text.startsWith('Done. Result: '));
  assert.equal(s.results.length, 1);
  const f = await route({ session: s, message: 'what was it?', engine: createFakeEngine((req) => (req.jsonSchema ? { tool: 'answer_from_context' } : 'weird is 1')) });
  assert.deepEqual(f, { type: 'answer', text: 'weird is 1' });
});

test('out-of-scope request with prior results gets the scope message when model emits code', async () => {
  const s = newSession();
  addResult(s, { tool: 'get_coverage', params: { app: 'CoreUI' }, data: { items: [{ metric: 'lines', pct: 5 }] } });
  const e = createFakeEngine((req) => (req.jsonSchema ? { tool: 'answer_from_context' } : '```js\ntest("x", () => {})\n```'));
  const r = await route({ session: s, message: 'write a jest test for the lowest coverage file', engine: e });
  assert.equal(r.text, config.assistant.scopeMessage);
});
