import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, estimateTokens } from '../src/session/compactor.js';
import { createSessionStore, addTurn, addResult } from '../src/session/store.js';

const config = { entities: { app: { CommonUI: ['common'] } } };
const TTL = 1000;
function mk() {
  let t = 0;
  const store = createSessionStore({ idleTtlMs: TTL, now: () => t });
  return { store, advance: (ms) => { t += ms; } };
}

test('small data unchanged', () => {
  assert.deepEqual(compact({ a: 1 }), { a: 1 });
});

test('large array compacted under budget', () => {
  const data = Array.from({ length: 1000 }, () => ({ file: 'src/x/y.js', pct: 50 }));
  const out = compact(data);
  assert.ok(estimateTokens(out) <= 1500);
  assert.deepEqual(out[0], { file: 'src/x/y.js', pct: 50 });
  assert.match(out[out.length - 1], /^… \d+ more$/);
});

test('long string truncated', () => {
  const out = compact({ s: 'a'.repeat(20000) });
  assert.ok(estimateTokens(out) <= 1500);
  assert.ok(out.s.endsWith('…'));
  assert.ok(out.s.length < 20000);
});

test('get after TTL returns null', () => {
  const { store, advance } = mk();
  const s = store.create(config);
  advance(TTL + 1);
  assert.equal(store.get(s.id), null);
});

test('get touches session', () => {
  const { store, advance } = mk();
  const s = store.create(config);
  advance(TTL - 1);
  assert.equal(store.get(s.id), s);
  advance(TTL - 1);
  assert.equal(store.get(s.id), s);
});

test('sweep removes expired', () => {
  const { store, advance } = mk();
  store.create(config);
  advance(TTL + 1);
  const fresh = store.create(config);
  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 1);
  assert.equal(store.get(fresh.id), fresh);
});

test('addTurn keeps last 10', () => {
  const { store } = mk();
  const s = store.create(config);
  for (let i = 1; i <= 12; i++) addTurn(s, 'user', `t${i}`);
  assert.equal(s.turns.length, 10);
  assert.equal(s.turns[0].text, 't3');
});

test('addResult keeps last 3 and compacts', () => {
  const { store } = mk();
  const s = store.create(config);
  for (let i = 1; i <= 4; i++) addResult(s, { tool: `t${i}`, params: {}, data: i === 4 ? Array.from({ length: 1000 }, () => ({ file: 'src/x/y.js', pct: 50 })) : { i } });
  assert.equal(s.results.length, 3);
  assert.equal(s.results[0].tool, 't2');
  assert.ok(estimateTokens(s.results[2].data) <= 1500);
  assert.ok(s.matcher && s.pendingCalls instanceof Map && s.pendingClarify === null);
});

test('wide object fallback stays within budget', () => {
  const data = {};
  for (let i = 0; i < 2000; i++) data[`key${i}`] = i;
  const out = compact(data);
  assert.equal(out.truncated, true);
  assert.ok(estimateTokens(out) <= 1500);
});

test('quote-heavy keys fallback stays within budget', () => {
  const data = {};
  for (let i = 0; i < 1000; i++) data[`k"${i}"x"`] = i;
  const out = compact(data);
  assert.equal(out.truncated, true);
  assert.ok(estimateTokens(out) <= 1500);
});

test('small maxTokens respected', () => {
  const out = compact({ a: 'x'.repeat(5000) }, { maxTokens: 10 });
  assert.equal(out.truncated, true);
  assert.ok(estimateTokens(out) <= 10);
});
