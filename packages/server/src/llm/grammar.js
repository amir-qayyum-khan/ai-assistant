function paramSchema(p) {
  if (p.kind === 'enum') return { enum: [...p.values, null] };
  return { type: [p.kind, 'null'] };
}

export function buildRouterSchema(config) {
  const tools = config.tools.map(t => {
    const properties = {};
    for (const [name, p] of Object.entries(t.params ?? {})) {
      if (p.kind === 'entity') continue;
      properties[name] = paramSchema(p);
    }
    return { type: 'object', properties: {
      tool: { const: t.name },
      params: { type: 'object', properties },
    } };
  });
  return { oneOf: [
    ...tools,
    { type: 'object', properties: { tool: { const: 'out_of_scope' } } },
    { type: 'object', properties: { tool: { const: 'answer_from_context' } } },
  ] };
}
