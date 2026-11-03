import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { createSessionStore } from '../src/session/store.js';
import { createHttpServer } from '../src/http/server.js';
import { createFakeEngine } from './helpers/fakeEngine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rawConfig = yaml.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'example-host.config.yaml'), 'utf8'));

const servers = [];
async function start({ ready = true } = {}) {
  const engine = createFakeEngine(() => ({ tool: 'get_coverage', params: { metric: 'lines' } }), { ready });
  const store = createSessionStore({ idleTtlMs: 60000 });
  const server = createHttpServer({ engine, store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, raw = false) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
  return { base, post };
}
after(() => servers.forEach((s) => s.close()));

async function newSession(post) {
  const res = await post('/session', rawConfig);
  return (await res.json()).sessionId;
}

test('health', async () => {
  const { base } = await start();
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.ready, true);
  assert.equal(body.model, 'fake.gguf');
});

test('create session', async () => {
  const { post } = await start();
  const res = await post('/session', rawConfig);
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).sessionId, 'string');
});

test('invalid config', async () => {
  const { post } = await start();
  const bad = structuredClone(rawConfig);
  delete bad.assistant.name;
  const res = await post('/session', bad);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'Invalid config');
  assert.ok(body.details.includes('assistant.name is required'));
});

test('chat -> tool_call -> tool-result', async () => {
  const { post } = await start();
  const sessionId = await newSession(post);
  const chat = await (await post('/chat', { sessionId, message: 'lines covered in wecore' })).json();
  assert.equal(chat.type, 'tool_call');
  assert.equal(chat.tool, 'get_coverage');
  const res = await post('/tool-result', {
    sessionId, callId: chat.callId, ok: true, data: { metric: 'lines', covered: 80499, total: 106235, pct: 75.8 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 'answer', text: 'CoreUI: 80,499 / 106,235 lines covered (75.8%)' });
});

test('unknown session 404, stale callId 409', async () => {
  const { post } = await start();
  const r1 = await post('/chat', { sessionId: 'nope', message: 'hi' });
  assert.equal(r1.status, 404);
  assert.equal((await r1.json()).error, 'Unknown session');
  const sessionId = await newSession(post);
  const r2 = await post('/tool-result', { sessionId, callId: 'stale', ok: true, data: {} });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error, 'Unknown or stale callId');
});

test('not ready: chat 503, session still 200', async () => {
  const { post } = await start({ ready: false });
  const sessionId = await newSession(post);
  assert.ok(sessionId);
  const res = await post('/chat', { sessionId, message: 'hello' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'fake not ready');
});

test('CORS preflight and headers', async () => {
  const { base } = await start();
  const res = await fetch(base + '/chat', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('malformed body and bad message', async () => {
  const { post } = await start();
  const r1 = await post('/session', '{', true);
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, 'Invalid JSON');
  const sessionId = await newSession(post);
  const r2 = await post('/chat', { sessionId, message: 'x'.repeat(2001) });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, 'message must be a non-empty string of at most 2000 characters');
});

test('not found and oversized body', async () => {
  const { base, post } = await start();
  const r1 = await fetch(base + '/nope');
  assert.equal(r1.status, 404);
  assert.equal((await r1.json()).error, 'Not found');
  const r2 = await post('/session', JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }), true);
  assert.equal(r2.status, 413);
});

test('413 arrives without client finishing the body', { timeout: 5000 }, async () => {
  const { base } = await start();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
    req.on('error', reject);
    const chunk = Buffer.alloc(256 * 1024, 'x');
    let n = 0;
    const t = setInterval(() => { if (n++ > 40) clearInterval(t); else req.write(chunk); }, 5);
    req.on('close', () => clearInterval(t));
  });
  assert.equal(status, 413);
});

test('413 on oversized Content-Length without sending the body', { timeout: 5000 }, async () => {
  const { base } = await start();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/session', { method: 'POST', headers: { 'Content-Length': String(2 * 1024 * 1024) } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(status, 413);
});
