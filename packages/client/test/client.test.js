'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/index.js');

const config = { tools: [{ name: 'get_test_totals' }] };

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    const r = typeof route === 'function' ? route(body, calls) : route;
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

test('missing handler', async () => {
  const a = createAssistant({ serverUrl: 'http://x', config, fetch: makeFetch({}) });
  await assert.rejects(a.start(), { message: 'No handler registered for tool "get_test_totals"' });
});

test('answer passthrough', async () => {
  const f = makeFetch({
    'POST /session': { body: { sessionId: 's1' } },
    'POST /chat': { body: { type: 'answer', text: 'hi' } },
  });
  const a = createAssistant({ serverUrl: 'http://x/', config: { tools: [] }, fetch: f });
  assert.deepEqual(await a.send('hello'), { type: 'answer', text: 'hi' });
  assert.deepEqual(f.calls[1].body, { sessionId: 's1', message: 'hello' });
});

test('tool_call flow', async () => {
  const f = makeFetch({
    'POST /session': { body: { sessionId: 's1' } },
    'POST /chat': { body: { type: 'tool_call', callId: 'c1', tool: 'get_test_totals', params: { app: 'CommonUI' }, confirm: 'folder' } },
    'POST /tool-result': { body: { type: 'answer', text: 'done' } },
  });
  const a = createAssistant({ serverUrl: 'http://x', config, fetch: f });
  let seen;
  a.registerTool('get_test_totals', async (params, ctx) => { seen = { params, ctx }; return { n: 3 }; });
  const ev = [];
  const r = await a.send('totals', {
    onToolStart: (e) => ev.push(['start', e]),
    onToolEnd: (e) => ev.push(['end', e]),
  });
  assert.deepEqual(seen.params, { app: 'CommonUI' });
  assert.equal(seen.ctx.confirm, 'folder');
  assert.equal(seen.ctx.callId, 'c1');
  assert.deepEqual(ev, [
    ['start', { tool: 'get_test_totals', params: { app: 'CommonUI' } }],
    ['end', { tool: 'get_test_totals', ok: true }],
  ]);
  assert.deepEqual(f.calls.find((c) => c.path === '/tool-result').body, { sessionId: 's1', callId: 'c1', ok: true, data: { n: 3 } });
  assert.deepEqual(r, { type: 'answer', text: 'done' });
});

test('handler throws', async () => {
  const f = makeFetch({
    'POST /session': { body: { sessionId: 's1' } },
    'POST /chat': { body: { type: 'tool_call', callId: 'c1', tool: 'get_test_totals', params: {} } },
    'POST /tool-result': { body: { type: 'answer', text: 'sorry' } },
  });
  const a = createAssistant({ serverUrl: 'http://x', config, fetch: f });
  a.registerTool('get_test_totals', async () => { throw new Error('boom'); });
  const ends = [];
  await a.send('x', { onToolEnd: (e) => ends.push(e) });
  assert.deepEqual(f.calls.find((c) => c.path === '/tool-result').body, { sessionId: 's1', callId: 'c1', ok: false, error: 'boom' });
  assert.equal(ends[0].ok, false);
  assert.equal(ends[0].error, 'boom');
});

test('404 on chat recreates session and retries once', async () => {
  let n = 0;
  const f = makeFetch({
    'POST /session': () => ({ body: { sessionId: `s${++n}` } }),
    'POST /chat': (body) => (body.sessionId === 's1' ? { status: 404, body: { error: 'unknown session' } } : { body: { type: 'answer', text: 'ok' } }),
  });
  const a = createAssistant({ serverUrl: 'http://x', config: { tools: [] }, fetch: f });
  const r = await a.send('hi');
  assert.equal(r.text, 'ok');
  assert.equal(f.calls.filter((c) => c.path === '/session').length, 2);
  assert.equal(f.calls.filter((c) => c.path === '/chat').length, 2);
});

test('unreachable', async () => {
  const a = createAssistant({ serverUrl: 'http://x', config: { tools: [] }, fetch: async () => { throw new TypeError('fail'); } });
  await assert.rejects(a.send('hi'), (e) => e.code === 'SERVER_UNREACHABLE' && e.message === 'Assistant server not reachable at http://x');
});

test('non-2xx throws body.error with status and details', async () => {
  const f = makeFetch({ 'POST /session': { status: 400, body: { error: 'invalid config', details: ['a'] } } });
  const a = createAssistant({ serverUrl: 'http://x', config: { tools: [] }, fetch: f });
  await assert.rejects(a.start(), (e) => e.message === 'invalid config' && e.status === 400 && e.details[0] === 'a');
});

test('concurrent sends create one session; failed start can retry', async () => {
  let n = 0;
  const f = makeFetch({
    'POST /session': () => ({ body: { sessionId: `s${++n}` } }),
    'POST /chat': { body: { type: 'answer', text: 'ok' } },
  });
  const a = createAssistant({ serverUrl: 'http://x', config: { tools: [] }, fetch: f });
  await Promise.all([a.send('a'), a.send('b')]);
  assert.equal(n, 1);

  let fail = true;
  const g = makeFetch({
    'POST /session': () => (fail ? { status: 500, body: { error: 'x' } } : { body: { sessionId: 's' } }),
    'POST /chat': { body: { type: 'answer', text: 'ok' } },
  });
  const b = createAssistant({ serverUrl: 'http://x', config: { tools: [] }, fetch: g });
  await assert.rejects(b.send('a'));
  fail = false;
  assert.equal((await b.send('a')).text, 'ok');
});

test('health', async () => {
  const f = makeFetch({ 'GET /health': { body: { ok: true } } });
  const a = createAssistant({ serverUrl: 'http://x', config, fetch: f });
  assert.deepEqual(await a.health(), { ok: true });
});

function toolFlow(handler, opts) {
  const f = makeFetch({
    'POST /session': { body: { sessionId: 's1' } },
    'POST /chat': { body: { type: 'tool_call', callId: 'c1', tool: 'get_test_totals', params: {} } },
    'POST /tool-result': { body: { type: 'answer', text: 'final' } },
  });
  const a = createAssistant({ serverUrl: 'http://x', config, fetch: f });
  a.registerTool('get_test_totals', handler);
  return { f, run: () => a.send('x', opts) };
}

test('throwing onToolStart does not break the protocol', async () => {
  let ran = false;
  const { f, run } = toolFlow(async () => { ran = true; return 1; }, { onToolStart: () => { throw new Error('ui'); } });
  assert.equal((await run()).text, 'final');
  assert.equal(ran, true);
  assert.deepEqual(f.calls.find((c) => c.path === '/tool-result').body, { sessionId: 's1', callId: 'c1', ok: true, data: 1 });
});

test('throwing onToolEnd does not break the protocol', async () => {
  const { f, run } = toolFlow(async () => 1, { onToolEnd: () => { throw new Error('ui'); } });
  assert.equal((await run()).text, 'final');
  assert.equal(f.calls.filter((c) => c.path === '/tool-result').length, 1);
});

test('unserialisable handler data is posted as ok:false', async () => {
  const circ = {}; circ.self = circ;
  const ends = [];
  const { f, run } = toolFlow(async () => circ, { onToolEnd: (e) => ends.push(e) });
  assert.equal((await run()).text, 'final');
  const body = f.calls.find((c) => c.path === '/tool-result').body;
  assert.equal(body.ok, false);
  assert.match(body.error, /^Tool result could not be serialised: /);
  assert.equal(ends[0].ok, false);
});

test('undefined handler data is posted as null', async () => {
  const { f, run } = toolFlow(async () => undefined);
  await run();
  const body = f.calls.find((c) => c.path === '/tool-result').body;
  assert.deepEqual(body, { sessionId: 's1', callId: 'c1', ok: true, data: null });
});
