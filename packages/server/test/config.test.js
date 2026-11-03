import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadServerConfig } from '../src/config/serverConfig.js';
import { validateHostConfig } from '../src/config/hostConfig.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmpYaml(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const file = path.join(dir, 'server.config.yaml');
  fs.writeFileSync(file, text);
  return file;
}

function exampleRaw() {
  return parse(fs.readFileSync(path.join(repoRoot, 'examples', 'example-host.config.yaml'), 'utf8'));
}

function base(overrides = {}) {
  return {
    assistant: { name: 'A', scope_message: 'S' },
    entities: { app: { X: ['x'] } },
    tools: [{ name: 't', description: 'd', params: {} }],
    ...overrides,
  };
}

test('loads example server config with absolute model path', () => {
  const cfg = loadServerConfig(path.join(repoRoot, 'server.config.yaml'));
  assert.equal(cfg.model.file, path.resolve(repoRoot, 'models/Qwen3-1.7B-Q4_K_M.gguf'));
  assert.equal(cfg.port, 7071);
});

test('applies defaults', () => {
  const file = tmpYaml('model: {file: x.gguf}\n');
  const cfg = loadServerConfig(file);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 7071);
  assert.equal(cfg.model.contextSize, 4096);
  assert.equal(cfg.model.gpu, 'auto');
  assert.equal(cfg.model.file, path.resolve(path.dirname(file), 'x.gguf'));
  assert.equal(cfg.session.idleTtlMinutes, 120);
  assert.equal(cfg.auth.enabled, false);
});

test('rejects bad port and gpu in one error', () => {
  const file = tmpYaml('port: 99999\nmodel: {file: x.gguf, gpu: maybe}\n');
  assert.throws(() => loadServerConfig(file), (e) => /port/.test(e.message) && /gpu/.test(e.message));
});

test('rejects bad contextSize', () => {
  const file = tmpYaml('model: {file: x.gguf, contextSize: 0}\n');
  assert.throws(() => loadServerConfig(file), /contextSize/);
});

test('example host config is valid', () => {
  const r = validateHostConfig(exampleRaw());
  assert.equal(r.ok, true, r.errors && r.errors.join('\n'));
  assert.equal(Object.keys(r.config.entities.app).length, 17);
  assert.deepEqual(r.config.tools.map((t) => t.name), ['run_unit_tests', 'get_coverage', 'get_test_totals']);
  const cov = r.config.tools[1];
  assert.deepEqual(cov.params.metric, { kind: 'enum', values: ['lines', 'statements', 'branches', 'all'], required: false, default: 'all' });
  assert.equal(cov.answerTemplate, '{app}: {covered} / {total} {metric} covered ({pct}%)');
  assert.equal(r.config.tools[0].confirm, 'folder');
  assert.equal(r.config.assistant.scopeMessage, 'I can run unit tests and answer coverage questions for You/We apps.');
});

function errorsOf(raw) {
  const r = validateHostConfig(raw);
  assert.equal(r.ok, false);
  return r.errors;
}

test('missing assistant fields', () => {
  assert.ok(errorsOf(base({ assistant: { scope_message: 'S' } })).includes('assistant.name is required'));
  assert.ok(errorsOf(base({ assistant: { name: 'A' } })).includes('assistant.scope_message is required'));
});

test('tools must be non-empty array', () => {
  assert.ok(errorsOf(base({ tools: [] })).includes('tools must be a non-empty array'));
  assert.ok(errorsOf(base({ tools: undefined })).includes('tools must be a non-empty array'));
});

test('tool name rules', () => {
  const tool = (name) => ({ name, description: 'd', params: {} });
  assert.ok(errorsOf(base({ tools: [tool('Bad-Name')] })).includes('tools[0].name "Bad-Name" must match ^[a-z][a-z0-9_]*$'));
  assert.ok(errorsOf(base({ tools: [tool('x'), tool('x')] })).includes('tools[1].name "x" is duplicated'));
  assert.ok(errorsOf(base({ tools: [tool('out_of_scope')] })).includes('tools[0].name "out_of_scope" is reserved'));
});

test('param errors', () => {
  const e1 = errorsOf(base({ tools: [{ name: 't', description: 'd', params: { app: { entity: 'foo' } } }] }));
  assert.ok(e1.includes('tools[0].params.app: unknown entity "foo"'));
  const e2 = errorsOf(base({ tools: [{ name: 't', description: 'd', params: { metric: { enum: ['a', 'b'], default: 'x' } } }] }));
  assert.ok(e2.includes('tools[0].params.metric: default "x" is not in enum'));
});

test('confirm must be folder', () => {
  const e = errorsOf(base({ tools: [{ name: 't', description: 'd', params: {}, confirm: 'nope' }] }));
  assert.ok(e.includes('tools[0].confirm must be "folder"'));
});

test('simple typed params normalize', () => {
  const r = validateHostConfig(base({ tools: [{ name: 't', description: 'd', params: { n: { type: 'number', required: true } } }] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.tools[0].params.n, { kind: 'number', required: true });
});

test('refuses non-loopback host', () => {
  for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
    assert.throws(() => loadServerConfig(tmpYaml(`host: '${host}'
model: {file: x.gguf}
`)), /loopback/);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(loadServerConfig(tmpYaml(`host: '${host}'
model: {file: x.gguf}
`)).host, host);
  }
});
