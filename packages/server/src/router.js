import crypto from 'node:crypto';
import { buildRouterSchema } from './llm/grammar.js';
import { addTurn, addResult } from './session/store.js';
import { composeToolAnswer, composeFollowUp } from './answer/composer.js';

export function buildRouterSystem(config, session) {
  const enumNote = (t) =>
    Object.entries(t.params ?? {})
      .filter(([, p]) => p.kind === 'enum')
      .map(([name, p]) => ` [${name}: ${[p.default, ...p.values.filter((v) => v !== p.default)].filter((v) => v !== undefined).join('|')}; ${p.default !== undefined ? `default ${p.default}; pick another value only if that exact word is in the message` : 'null unless that exact word is in the message'}]`)
      .join('');
  const lines = config.tools.map((t) => `- ${t.name}: ${t.description}${enumNote(t)}`);
  lines.push('- out_of_scope: anything else (writing code, general questions, actions not listed)');
  lines.push(
    session.results.length > 0
      ? '- answer_from_context: the message asks about the content of the recent results listed below (a figure, count, list or detail) instead of asking to run or look up something'
      : '- answer_from_context: follow-up questions about results already returned in this conversation (only when Recent results are listed below)',
  );
  let out = `You route a user message to exactly one of these tools. Pick the best match.\n${lines.join('\n')}`;
  out += '\nRule: a request that matches the purpose of a listed tool is a tool call, even if the name in it is unfamiliar, misspelled or written with spaces. Use out_of_scope only when no listed tool fits.';
  if (session.results.length > 0) {
    const recent = session.results
      .map((r) => `${r.tool}(${Object.entries(r.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')})`)
      .join('; ');
    out += `\nRecent results: ${recent}\nThe user message is a question about the content of these results (a figure, a count, a list or a detail) unless it explicitly asks to run or look up something. A question that names no target cannot be a tool call, so choose answer_from_context for it.`;
  }
  const turns = session.turns.slice(-4).map((t) => `${t.role}: ${t.text}`).join('\n');
  if (turns) out += `\nConversation:\n${turns}`;
  return out;
}

function unknownToolClarify(config) {
  const names = config.tools.map((t) => t.name);
  return {
    type: 'clarify',
    text: `Sorry, I didn't understand that. I can help with: ${names.join(', ')}.`,
    missing: [],
    options: names,
  };
}

function tryFillPending(session, hints, message) {
  const { tool: toolName, params, missing } = session.pendingClarify;
  const tool = session.config.tools.find((t) => t.name === toolName);
  if (!tool) return null;
  const filled = { ...params };
  const text = message.trim().toLowerCase();
  for (const name of missing) {
    const p = tool.params[name];
    if (!p) return null;
    if (p.kind === 'entity') {
      if (hints[p.entity]?.value !== undefined) {
        filled[name] = hints[p.entity].value;
      } else {
        const hit = session.matcher.values(p.entity).find((v) => v.toLowerCase() === text);
        if (hit === undefined) return null;
        filled[name] = hit;
      }
    } else if (p.kind === 'enum') {
      const hit = p.values.find((v) => String(v).toLowerCase() === text);
      if (hit === undefined) return null;
      filled[name] = hit;
    } else {
      return null;
    }
  }
  return { tool, params: filled };
}

function buildParams(tool, modelParams, hints) {
  const params = {};
  const ambiguous = [];
  for (const [name, p] of Object.entries(tool.params ?? {})) {
    if (p.kind === 'entity') {
      const h = hints[p.entity];
      if (h?.value !== undefined) params[name] = h.value;
      else if (h?.candidates) ambiguous.push({ name, options: h.candidates });
      continue;
    }
    const v = modelParams?.[name];
    if (p.kind === 'enum') {
      if (v !== null && v !== undefined && p.values.includes(v)) params[name] = v;
      else if (p.default !== undefined) params[name] = p.default;
    } else if (v !== null && v !== undefined && typeof v === p.kind) {
      params[name] = v;
    } else if (p.default !== undefined) {
      params[name] = p.default;
    }
  }
  return { params, ambiguous };
}

function finishCall(session, tool, params, ambiguous = []) {
  const clarify = (name, options, text) => {
    session.pendingClarify = { tool: tool.name, params, missing: [name] };
    return { type: 'clarify', text, missing: [name], options };
  };
  if (ambiguous.length > 0) {
    const { name, options } = ambiguous[0];
    return clarify(name, options, `Which ${name} do you mean: ${options.join(', ')}?`);
  }
  for (const [name, p] of Object.entries(tool.params ?? {})) {
    if (p.required && params[name] === undefined) {
      const options = p.kind === 'entity' ? session.matcher.values(p.entity) : p.kind === 'enum' ? p.values : [];
      return clarify(name, options, `Which ${name}? Options: ${options.join(', ')}`);
    }
  }
  const callId = crypto.randomUUID();
  session.pendingCalls.set(callId, { tool: tool.name, params });
  const result = { type: 'tool_call', callId, tool: tool.name, params };
  if (tool.confirm) result.confirm = tool.confirm;
  return result;
}

function record(session, result) {
  const text = result.type === 'tool_call' ? `[called ${result.tool} ${JSON.stringify(result.params)}]` : result.text;
  addTurn(session, 'assistant', text);
  return result;
}

export async function route({ session, message, engine }) {
  const { config } = session;
  addTurn(session, 'user', message);
  const hints = session.matcher.match(message);

  if (session.pendingClarify) {
    const filled = tryFillPending(session, hints, message);
    session.pendingClarify = null;
    if (filled) return record(session, finishCall(session, filled.tool, filled.params));
  }

  let decision;
  try {
    decision = await engine.complete({
      system: buildRouterSystem(config, session),
      prompt: message,
      jsonSchema: buildRouterSchema(config),
    });
  } catch (err) {
    if (err?.code === 'MODEL_NOT_READY') throw err;
    return record(session, unknownToolClarify(config));
  }

  if (decision?.tool === 'out_of_scope') {
    return record(session, { type: 'out_of_scope', text: config.assistant.scopeMessage });
  }
  if (decision?.tool === 'answer_from_context') {
    const text = await composeFollowUp({ message, session, engine });
    return record(session, { type: 'answer', text });
  }
  const tool = config.tools.find((t) => t.name === decision?.tool);
  if (!tool) return record(session, unknownToolClarify(config));

  const { params, ambiguous } = buildParams(tool, decision.params, hints);
  return record(session, finishCall(session, tool, params, ambiguous));
}

export async function completeToolCall({ session, callId, ok, data, error, engine }) {
  const pending = session.pendingCalls.get(callId);
  if (!pending) {
    const err = new Error(`Unknown callId: ${callId}`);
    err.code = 'UNKNOWN_CALL';
    throw err;
  }
  session.pendingCalls.delete(callId);
  const tool = session.config.tools.find((t) => t.name === pending.tool);
  if (ok) addResult(session, { tool: pending.tool, params: pending.params, data });
  const text = await composeToolAnswer({ tool, params: pending.params, result: { ok, data, error }, engine, config: session.config });
  addTurn(session, 'assistant', text);
  return { type: 'answer', text };
}
