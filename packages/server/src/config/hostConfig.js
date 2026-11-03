const NAME_RE = /^[a-z][a-z0-9_]*$/;
const SIMPLE_TYPES = ['string', 'number', 'boolean'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

function validateEntities(raw, errors) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    errors.push('entities must be an object');
    return out;
  }
  for (const [type, values] of Object.entries(raw)) {
    if (!isObj(values)) {
      errors.push(`entities.${type} must be an object`);
      continue;
    }
    out[type] = {};
    for (const [value, aliases] of Object.entries(values)) {
      if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string')) {
        errors.push(`entities.${type}.${value} must be an array of strings`);
        continue;
      }
      out[type][value] = [...aliases];
    }
  }
  return out;
}

function validateParam(prefix, p, entities, errors) {
  if (!isObj(p)) {
    errors.push(`${prefix}: must be an object`);
    return null;
  }
  const required = p.required === undefined ? false : p.required;
  if (typeof required !== 'boolean') {
    errors.push(`${prefix}: required must be a boolean`);
  }
  let param;
  if (p.entity !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(entities, p.entity)) {
      errors.push(`${prefix}: unknown entity "${p.entity}"`);
      return null;
    }
    param = { kind: 'entity', entity: p.entity, required };
  } else if (p.enum !== undefined) {
    if (!Array.isArray(p.enum) || p.enum.length === 0) {
      errors.push(`${prefix}: enum must be a non-empty array`);
      return null;
    }
    param = { kind: 'enum', values: [...p.enum], required };
    if (p.default !== undefined && !p.enum.includes(p.default)) {
      errors.push(`${prefix}: default "${p.default}" is not in enum`);
    }
  } else if (SIMPLE_TYPES.includes(p.type)) {
    param = { kind: p.type, required };
  } else {
    errors.push(`${prefix}: must define entity, enum, or type (${SIMPLE_TYPES.join('|')})`);
    return null;
  }
  if (p.default !== undefined) param.default = p.default;
  return param;
}

function validateTools(raw, entities, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('tools must be a non-empty array');
    return [];
  }
  const seen = new Set();
  const tools = [];
  raw.forEach((t, i) => {
    const at = `tools[${i}]`;
    if (!isObj(t)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const tool = {};
    if (typeof t.name !== 'string' || !NAME_RE.test(t.name)) {
      errors.push(`${at}.name "${t.name}" must match ^[a-z][a-z0-9_]*$`);
    } else if (t.name === 'out_of_scope') {
      errors.push(`${at}.name "${t.name}" is reserved`);
    } else if (seen.has(t.name)) {
      errors.push(`${at}.name "${t.name}" is duplicated`);
    }
    if (typeof t.name === 'string') seen.add(t.name);
    tool.name = t.name;

    if (!nonEmptyStr(t.description)) errors.push(`${at}.description is required`);
    tool.description = t.description;

    if (t.confirm !== undefined) {
      if (t.confirm !== 'folder') errors.push(`${at}.confirm must be "folder"`);
      else tool.confirm = 'folder';
    }
    if (t.answer_template !== undefined) {
      if (typeof t.answer_template !== 'string') errors.push(`${at}.answer_template must be a string`);
      else tool.answerTemplate = t.answer_template;
    }

    tool.params = {};
    if (t.params !== undefined && t.params !== null) {
      if (!isObj(t.params)) {
        errors.push(`${at}.params must be an object`);
      } else {
        for (const [pName, p] of Object.entries(t.params)) {
          const param = validateParam(`${at}.params.${pName}`, p, entities, errors);
          if (param) tool.params[pName] = param;
        }
      }
    }
    tools.push(tool);
  });
  return tools;
}

export function validateHostConfig(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ['config must be an object'] };

  const a = isObj(raw.assistant) ? raw.assistant : {};
  if (!nonEmptyStr(a.name)) errors.push('assistant.name is required');
  if (!nonEmptyStr(a.scope_message)) errors.push('assistant.scope_message is required');

  const entities = validateEntities(raw.entities, errors);
  const tools = validateTools(raw.tools, entities, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: { assistant: { name: a.name, scopeMessage: a.scope_message }, entities, tools },
  };
}
