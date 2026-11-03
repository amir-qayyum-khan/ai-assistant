import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { loadServerConfig } from '../src/config/serverConfig.js';
import { validateHostConfig } from '../src/config/hostConfig.js';
import { createEngine } from '../src/llm/engine.js';
import { createSessionStore, addResult } from '../src/session/store.js';
import { route } from '../src/router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const THRESHOLD = 90;

const args = process.argv.slice(2);
const mi = args.indexOf('--model');
const modelOverride = mi >= 0 ? args[mi + 1] : null;

const serverConfig = loadServerConfig(path.join(root, 'server.config.yaml'));
const modelFile = modelOverride ? path.resolve(process.cwd(), modelOverride) : serverConfig.model.file;

const raw = yaml.parse(fs.readFileSync(path.join(root, 'examples', 'example-host.config.yaml'), 'utf8'));
const { ok, config, errors } = validateHostConfig(raw);
if (!ok) {
  console.error(`Invalid host config:\n- ${(errors ?? []).join('\n- ')}`);
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(path.join(here, 'prompts.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sample-test-result.json'), 'utf8'));

const engine = createEngine({ modelFile, contextSize: serverConfig.model.contextSize, gpu: serverConfig.model.gpu });
await engine.load();
const st = engine.status();
if (!st.ready) {
  console.error(`Model not ready: ${st.error ?? 'unknown error'}`);
  process.exit(1);
}

const store = createSessionStore({ idleTtlMs: serverConfig.session.idleTtlMinutes * 60000 });
console.log(`Model: ${path.basename(modelFile)}`);

function matches(expect, actual) {
  if (actual.type !== expect.type) return false;
  if (expect.type !== 'tool_call') return true;
  if (actual.tool !== expect.tool) return false;
  try {
    assert.deepEqual(actual.params, expect.params ?? {});
    return true;
  } catch {
    return false;
  }
}

function describe(actual) {
  if (actual.type === 'tool_call') return `tool_call ${actual.tool} ${JSON.stringify(actual.params)}`;
  return actual.type;
}

let passed = 0;
for (const c of cases) {
  const session = store.create(config);
  if (c.seed) addResult(session, { tool: 'run_unit_tests', params: { app: 'CommonUI' }, data: fixture });
  let actual;
  try {
    actual = await route({ session, message: c.message, engine });
  } catch (err) {
    actual = { type: `error: ${err.message}` };
  }
  const good = matches(c.expect, actual);
  if (good) passed++;
  console.log(`${good ? 'PASS' : 'FAIL'} ${c.message} → ${describe(actual)}`);
}

const pct = Math.round((passed / cases.length) * 1000) / 10;
console.log(`Accuracy: ${passed}/${cases.length} (${pct}%)`);
process.exit(pct < THRESHOLD ? 1 : 0);
