import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, fetchModel } from '../lib/models.mjs';
import { isModelReady, writeModelFile } from '../lib/modelState.mjs';

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const MB = 1e6;

export function friendlyError(err) {
  const msg = String(err?.message ?? err);
  const code = err?.code ?? err?.cause?.code ?? '';
  if (code === 'ENOSPC' || /no space/i.test(msg)) return 'Your disk is full. Free up some space and press Retry.';
  if (/\(404\)/.test(msg)) return 'The download server could not find the model file (error 404). Please try again later.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminated|network/i.test(msg + code)) {
    return 'Could not reach the internet. Check your connection and press Retry.';
  }
  return `The download did not finish (${msg}). Press Retry.`;
}

export function createSetupServer({ root, configPath, downloadFn, startServer, now = Date.now }) {
  const modelsDir = path.join(root, 'models');
  let status = { state: 'idle', receivedMB: 0, totalMB: 0, percent: 0, speedMBps: 0, etaSeconds: null, message: '' };
  let busy = false;

  const set = (patch) => { status = { ...status, ...patch }; };
  const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

  async function run(model) {
    const dest = path.join(modelsDir, model.file);
    const t0 = now();
    set({ state: 'downloading', receivedMB: 0, totalMB: model.approxMB, percent: 0, speedMBps: 0, etaSeconds: null, message: '' });
    try {
      fs.mkdirSync(modelsDir, { recursive: true });
      await fetchModel(model, dest, downloadFn, (received, total) => {
        const elapsed = (now() - t0) / 1000;
        const speed = elapsed > 0 ? received / MB / elapsed : 0;
        const totalMB = total ? total / MB : model.approxMB;
        const remaining = Math.max(totalMB - received / MB, 0);
        set({
          receivedMB: round(received / MB), totalMB: round(totalMB),
          percent: total ? Math.min(Math.floor((received / total) * 100), 100) : 0,
          speedMBps: round(speed, 2),
          etaSeconds: speed > 0 ? Math.round(remaining / speed) : null,
        });
      });
    } catch (err) {
      set({ state: 'error', message: friendlyError(err) });
      return;
    }
    try {
      writeModelFile(configPath, `models/${model.file}`);
      set({ state: 'loading', percent: 100, etaSeconds: 0, message: '' });
      const { url } = await startServer();
      set({ state: 'ready', url, message: `The assistant is running at ${url}` });
    } catch (err) {
      set({ state: 'error', message: `The model was downloaded but the assistant could not start (${err.message}). Press Retry.` });
    }
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(uiDir, 'index.html')));
      }
      if (req.method === 'GET' && p === '/api/models') {
        return json(res, 200, { models: MODELS.map((m) => ({ ...m, present: isModelReady(path.join(modelsDir, m.file)) })) });
      }
      if (req.method === 'GET' && p === '/api/progress') return json(res, 200, status);
      if (req.method === 'POST' && p === '/api/download') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* handled below */ }
        const model = MODELS.find((m) => m.id === body.id);
        if (!model) return json(res, 400, { error: 'Unknown model' });
        if (busy || status.state === 'ready') return json(res, 409, { error: 'Already in progress' });
        busy = true;
        run(model).finally(() => { busy = false; });
        return json(res, 202, { started: true });
      }
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}
