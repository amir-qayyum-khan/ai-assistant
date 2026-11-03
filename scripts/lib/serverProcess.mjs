import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

export function getHealth(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 2000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Poll /health until {ready:true}. Rejects on engine error, child exit, or timeout. */
export async function waitForReady({ port, child, timeoutMs = 300000, intervalMs = 500 }) {
  const start = Date.now();
  let exited = false;
  child?.once('exit', () => { exited = true; });
  while (Date.now() - start < timeoutMs) {
    if (exited) throw new Error('server exited');
    const h = await getHealth(port);
    if (h?.ready) return h;
    if (h?.error) throw new Error(h.error);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('timed out waiting for model to load');
}

export function spawnServer({ root, configPath }) {
  return spawn(process.execPath,
    [path.join(root, 'packages/server/src/index.js'), '--config', configPath],
    { cwd: root, stdio: 'inherit' });
}
