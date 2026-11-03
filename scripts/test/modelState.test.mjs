import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isModelReady, readModelFile, writeModelFile } from '../lib/modelState.mjs';
import { decideMode } from '../launcher.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));

test('decideMode', () => {
  assert.equal(decideMode({ modelReady: true }), 'serve');
  assert.equal(decideMode({ modelReady: false }), 'setup');
});

test('isModelReady', () => {
  const d = tmp();
  const f = path.join(d, 'm.gguf');
  assert.equal(isModelReady(f), false);
  fs.writeFileSync(f, '');
  assert.equal(isModelReady(f), false);
  fs.writeFileSync(f, 'x');
  assert.equal(isModelReady(f), true);
  fs.writeFileSync(f + '.part', 'x');
  assert.equal(isModelReady(f), false);
  fs.rmSync(d, { recursive: true });
});

test('writeModelFile only changes model.file', () => {
  const d = tmp();
  const c = path.join(d, 'c.yaml');
  const src = '# top\nhost: 127.0.0.1\nmodel:\n  file: models/a.gguf   # keep\n  contextSize: 4096\nother:\n  file: x\n';
  fs.writeFileSync(c, src);
  assert.equal(readModelFile(c), 'models/a.gguf');
  writeModelFile(c, 'models/b.gguf');
  assert.equal(fs.readFileSync(c, 'utf8'), src.replace('models/a.gguf', 'models/b.gguf'));
  assert.equal(readModelFile(c), 'models/b.gguf');
  fs.rmSync(d, { recursive: true });
});
