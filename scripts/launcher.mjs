import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isModelReady, readModelFile } from './lib/modelState.mjs';
import { waitForReady, spawnServer } from './lib/serverProcess.mjs';
import { downloadFile } from './lib/download.mjs';
import { createSetupServer } from './setup-ui/server.mjs';

export function decideMode({ modelReady }) {
  return modelReady ? 'serve' : 'setup';
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'server.config.yaml');

function readPort() {
  const m = fs.readFileSync(configPath, 'utf8').match(/^port:\s*(\d+)/m);
  return m ? Number(m[1]) : 7071;
}

const readyMessage = (port) => {
  console.log(`\nReady on http://127.0.0.1:${port}`);
  console.log('Close this window to stop.');
};

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* URL is printed anyway */ }
}

function forward(child) {
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const port = readPort();
  const modelPath = path.resolve(root, readModelFile(configPath));
  if (decideMode({ modelReady: isModelReady(modelPath) }) === 'serve') {
    const child = spawnServer({ root, configPath });
    forward(child);
    try { await waitForReady({ port, child }); readyMessage(port); }
    catch (e) { console.error('The assistant could not finish starting: ' + e.message); }
    return;
  }
  let child;
  const setup = createSetupServer({
    root, configPath, downloadFn: downloadFile,
    startServer: async () => {
      child = spawnServer({ root, configPath });
      forward(child);
      await waitForReady({ port, child });
      readyMessage(port);
      return { url: `http://127.0.0.1:${port}` };
    },
  });
  await new Promise((r) => setup.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${setup.address().port}`;
  console.log(`First-time setup. If your browser does not open, visit ${url}`);
  openBrowser(url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
