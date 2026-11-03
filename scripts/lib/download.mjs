import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function downloadFile(url, destPath, opts = {}) {
  const { onProgress } = opts;
  try {
    const st = fs.statSync(destPath);
    if (st.size > 0) return { skipped: true, bytes: st.size };
  } catch {
    // does not exist; download it
  }

  const partPath = destPath + '.part';
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    fs.rmSync(partPath, { force: true });
    throw new Error(`Download failed (${res.status}): ${url}`);
  }

  const lenHeader = res.headers.get('content-length');
  const total = lenHeader ? Number(lenHeader) : null;
  let received = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (onProgress) onProgress(received, total);
  });

  try {
    await pipeline(source, fs.createWriteStream(partPath));
    fs.renameSync(partPath, destPath);
  } catch (err) {
    fs.rmSync(partPath, { force: true });
    throw err;
  }
  return { skipped: false, bytes: received };
}
