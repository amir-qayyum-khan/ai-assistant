import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { getLlama, LlamaLogLevel } from 'node-llama-cpp';
import { createEngine, createSerialQueue } from '../src/llm/engine.js';
import { buildRouterSchema } from '../src/llm/grammar.js';
import { validateHostConfig } from '../src/config/hostConfig.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleConfig = () => {
  const r = validateHostConfig(parse(fs.readFileSync(path.join(root, 'examples', 'example-host.config.yaml'), 'utf8')));
  assert.ok(r.ok, JSON.stringify(r));
  return r.config;
};

test('serial queue runs one at a time in order', async () => {
  const q = createSerialQueue();
  let active = 0, max = 0; const order = [];
  await Promise.all([1, 2, 3, 4].map(i => q(async () => {
    active++; max = Math.max(max, active);
    await new Promise(r => setTimeout(r, 10 * (5 - i)));
    order.push(i); active--;
  })));
  assert.equal(max, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('serial queue continues after rejection', async () => {
  const q = createSerialQueue();
  const a = q(async () => { throw new Error('boom'); });
  const b = q(async () => 'ok');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
});

test('missing model reports setup hint', async () => {
  const e = createEngine({ modelFile: path.join(root, 'models', 'nope.gguf'), contextSize: 2048, gpu: false });
  await e.load();
  const s = e.status();
  assert.equal(s.ready, false);
  assert.equal(s.model, 'nope.gguf');
  assert.match(s.error, /Run npm run setup:models/);
  await assert.rejects(e.complete({ system: 's', prompt: 'p' }), err => err.code === 'MODEL_NOT_READY');
});

test('grammar compiles in node-llama-cpp', async () => {
  const llama = await getLlama({ gpu: false, logLevel: LlamaLogLevel.error });
  await llama.createGrammarForJsonSchema(buildRouterSchema(exampleConfig()));
});

const small = path.join(root, 'models', 'Qwen3-0.6B-Q4_K_M.gguf');
test('real model routes to a tool name', { skip: !fs.existsSync(small), timeout: 300000 }, async () => {
  const config = exampleConfig();
  const e = createEngine({ modelFile: small, contextSize: 2048, gpu: false });
  await e.load();
  assert.equal(e.status().ready, true, e.status().error);
  const result = await e.complete({
    system: 'You route user requests to a tool. Reply with JSON only.',
    prompt: 'run unit tests for CoreUI',
    jsonSchema: buildRouterSchema(config),
  });
  const allowed = [...config.tools.map(t => t.name), 'out_of_scope', 'answer_from_context'];
  assert.ok(allowed.includes(result.tool), JSON.stringify(result));
});
