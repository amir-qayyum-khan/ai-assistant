import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouterSchema } from '../src/llm/grammar.js';

test('router schema omits entity params and nulls others', () => {
  const config = { tools: [{ name: 'run_tests', params: {
    app: { kind: 'entity', entity: 'app', required: true },
    metric: { kind: 'enum', values: ['lines', 'all'], required: false },
    n: { kind: 'number', required: false },
  } }] };
  assert.deepEqual(buildRouterSchema(config), { oneOf: [
    { type: 'object', properties: {
      tool: { const: 'run_tests' },
      params: { type: 'object', properties: {
        metric: { enum: ['lines', 'all', null] },
        n: { type: ['number', 'null'] },
      } } } },
    { type: 'object', properties: { tool: { const: 'out_of_scope' } } },
    { type: 'object', properties: { tool: { const: 'answer_from_context' } } },
  ] });
});
