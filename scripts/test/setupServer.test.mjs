import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupServer } from '../setup-ui/server.mjs';

const CFG = '# c\nmodel:\n  file: models/Qwen3-1.7B-Q4_K_M.gguf # x\n  gpu: auto\n';

async function boot(opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'su-'));
  const configPath = path.join(root, 'server.config.yaml');
  fs.writeFileSync(configPath, CFG);
  const srv = createSetupServer({ root, configPath, ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const until = async (state) => {
    for (let i = 0; i < 200; i++) {
      const s = await get('/api/progress');
      if (s.state === state) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('never reached ' + state + ': ' + JSON.stringify(await get('/api/progress')));
  };
  const close = () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { srv, root, configPath, get, post, until, close };
}

const okDownload = async (url, dest, { onProgress }) => {
  onProgress(500e6, 1000e6);
  fs.writeFileSync(dest, 'x');
  return { skipped: false, bytes: 1 };
};

test('binds loopback only and serves page + models', async () => {
  const t = await boot({ downloadFn: okDownload, startServer: async () => ({ url: 'u' }) });
  assert.equal(t.srv.address().address, '127.0.0.1');
  const { models } = await t.get('/api/models');
  assert.deepEqual(models.map((m) => [m.id, m.present]), [['standard', false], ['light', false]]);
  assert.match(await (await fetch(`http://127.0.0.1:${t.srv.address().port}/`)).text(), /AI Assistant/);
  t.close();
});

test('happy path reaches ready, rewrites config, computes progress', async () => {
  let clock = 0;
  const fake = async (url, dest, { onProgress }) => { clock = 10000; return okDownload(url, dest, { onProgress }); };
  const t = await boot({ downloadFn: fake, startServer: async () => ({ url: 'http://127.0.0.1:7071' }), now: () => clock });
  assert.equal((await t.post('/api/download', { id: 'light' })).status, 202);
  const s = await t.until('ready');
  assert.equal(s.url, 'http://127.0.0.1:7071');
  assert.equal(s.percent, 100);
  assert.match(fs.readFileSync(t.configPath, 'utf8'), /file: models\/Qwen3-0\.6B-Q4_K_M\.gguf # x\n/);
  assert.equal(fs.readFileSync(t.configPath, 'utf8').split('\n')[0], '# c');
  t.close();
});

test('progress math and 409 when busy', async () => {
  let clock = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = async (u, d, { onProgress }) => { clock = 10000; onProgress(500e6, 1000e6); await gate; fs.writeFileSync(d, 'x'); return {}; };
  const t = await boot({ downloadFn: fake, startServer: async () => ({ url: 'u' }), now: () => clock });
  await t.post('/api/download', { id: 'standard' });
  await new Promise((r) => setTimeout(r, 30));
  const s = await t.get('/api/progress');
  assert.deepEqual([s.state, s.percent, s.receivedMB, s.totalMB, s.speedMBps, s.etaSeconds], ['downloading', 50, 500, 1000, 50, 10]);
  assert.equal((await t.post('/api/download', { id: 'standard' })).status, 409);
  release();
  await t.until('ready');
  t.close();
});

test('error is plain language, retry succeeds', async () => {
  let n = 0;
  const fake = async (u, d, o) => {
    if (n++ === 0) throw new TypeError('fetch failed');
    return okDownload(u, d, o);
  };
  const t = await boot({ downloadFn: fake, startServer: async () => ({ url: 'u' }) });
  await t.post('/api/download', { id: 'standard' });
  const e = await t.until('error');
  assert.match(e.message, /internet/);
  assert.equal((await t.post('/api/download', { id: 'standard' })).status, 202);
  await t.until('ready');
  t.close();
});

test('start failure reports error', async () => {
  const t = await boot({ downloadFn: okDownload, startServer: async () => { throw new Error('boom'); } });
  await t.post('/api/download', { id: 'standard' });
  assert.match((await t.until('error')).message, /could not start/);
  t.close();
});
