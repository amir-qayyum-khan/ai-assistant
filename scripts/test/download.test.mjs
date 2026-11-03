import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadFile } from '../lib/download.mjs';

const payload = Buffer.alloc(1000, 7);
let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloads file content exactly', async () => {
  const dest = path.join(dir, 'a.bin');
  const result = await downloadFile(`${base}/ok`, dest);
  assert.deepEqual(result, { skipped: false, bytes: 1000 });
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.equal(fs.existsSync(dest + '.part'), false);
});

test('skips existing file', async () => {
  const dest = path.join(dir, 'b.bin');
  await downloadFile(`${base}/ok`, dest);
  const second = await downloadFile(`${base}/ok`, dest);
  assert.equal(second.skipped, true);
});

test('404 rejects and leaves nothing', async () => {
  const dest = path.join(dir, 'c.bin');
  await assert.rejects(downloadFile(`${base}/missing`, dest), /Download failed \(404\)/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(dest + '.part'), false);
});
