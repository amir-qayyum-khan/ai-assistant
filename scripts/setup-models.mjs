import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadFile } from './lib/download.mjs';
import { MODELS, fetchModel } from './lib/models.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'models');

function progress(label) {
  let last = -1;
  return (received, total) => {
    if (!total) return;
    const pct = Math.floor((received / total) * 100);
    if (pct !== last) {
      last = pct;
      process.stdout.write(`\r${label}: ${pct}% (${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`);
    }
  };
}

fs.mkdirSync(modelsDir, { recursive: true });
for (const m of MODELS) {
  const result = await fetchModel(m, path.join(modelsDir, m.file), downloadFile, progress(m.file));
  if (result.skipped) console.log(`${m.file}: skipped (already present, ${result.bytes} bytes)`);
  else console.log(`\n${m.file}: done (${result.bytes} bytes)`);
}
