import { compact, estimateTokens } from '../session/compactor.js';

export const SUMMARY_SYSTEM =
  'You report tool results to a user. Use only the data given. Quote numbers exactly. At most 5 sentences. Never write code.';
export const FOLLOWUP_SYSTEM =
  "Answer the user's question using only the results and conversation below. If the answer is not there, say you don't have that information. Quote numbers exactly. At most 5 sentences. Never write code.";

const DEFAULT_CONTEXT = 4096;
const OUTPUT_TOKENS = 300;
const FOLLOWUP_FALLBACK = "I couldn't answer that from the results.";
const CODE_LINE = /^\s*(import\s|export\s|function[\s(]|(const|let|var)\s+[\w$]+\s*=)|=>|<[A-Z][A-Za-z0-9]*[\s>/]/;

export function looksLikeCode(text) {
  if (typeof text !== 'string') return false;
  if (text.includes('```')) return true;
  return text.split('\n').some((line) => CODE_LINE.test(line));
}

function guarded(text, config) {
  return looksLikeCode(text) ? config.assistant.scopeMessage : text;
}

function compactJson(data, max = 500) {
  const s = JSON.stringify(data) ?? 'null';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Shrink results so their JSON fits budgetTokens: compact each, then drop oldest, then hard-truncate.
export function fitResults(results, budgetTokens) {
  let items = results.map((r) => ({ ...r }));
  const fits = () => estimateTokens(items) <= budgetTokens;
  while (items.length > 0 && !fits()) {
    const per = Math.max(30, Math.floor(budgetTokens / items.length) - 30);
    items = items.map((r) => ({ ...r, data: compact(r.data, { maxTokens: per }) }));
    if (fits() || items.length === 1) break;
    items.shift();
  }
  if (items.length > 0 && !fits()) {
    const last = items[items.length - 1];
    items = [{ ...last, data: { truncated: true, preview: compactJson(last.data, Math.max(40, budgetTokens * 2)) } }];
  }
  return items;
}

export function formatValue(v) {
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(v);
}

export function fillTemplate(template, vars) {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      missing = true;
      return '';
    }
    return formatValue(v);
  });
  return missing ? null : out;
}

function renderTemplate(tool, params, data) {
  if (!tool.answerTemplate || data === null || data === undefined) return null;
  if (Array.isArray(data.items)) {
    const lines = data.items.map((item) => fillTemplate(tool.answerTemplate, { ...params, ...item }));
    return lines.includes(null) ? null : lines.join('\n');
  }
  return fillTemplate(tool.answerTemplate, { ...params, ...data });
}

export async function composeToolAnswer({ tool, params, result, engine, config }) {
  if (!result.ok) return `Couldn't complete ${tool.name}: ${result.error}`;
  const templated = renderTemplate(tool, params, result.data);
  if (templated !== null) return templated;
  const prompt = `Request: ${tool.name} ${JSON.stringify(params)}\nResult:\n${JSON.stringify(compact(result.data))}`;
  try {
    const out = await engine.complete({ system: SUMMARY_SYSTEM, prompt, maxTokens: OUTPUT_TOKENS });
    return config ? guarded(out, config) : out;
  } catch (err) {
    if (err?.code === 'MODEL_NOT_READY') throw err;
    return `Done. Result: ${compactJson(result.data)}`;
  }
}

export async function composeFollowUp({ message, session, engine }) {
  if (session.results.length === 0) {
    return `I don't have any results to answer from yet. ${session.config.assistant.scopeMessage}`;
  }
  const turns = session.turns.slice(-4).map((t) => `${t.role}: ${t.text}`).join('\n');
  const contextSize = engine.contextSize ?? DEFAULT_CONTEXT;
  const fixed = estimateTokens(`${FOLLOWUP_SYSTEM}\n\nConversation:\n${turns}\n\nQuestion: ${message}\nResults:\n`);
  const budget = Math.max(100, contextSize - OUTPUT_TOKENS - fixed - 100);
  const results = fitResults(session.results, budget);
  const prompt = `Results:\n${JSON.stringify(results)}\n\nConversation:\n${turns}\n\nQuestion: ${message}`;
  try {
    const out = await engine.complete({ system: FOLLOWUP_SYSTEM, prompt, maxTokens: OUTPUT_TOKENS });
    return guarded(out, session.config);
  } catch (err) {
    if (err?.code === 'MODEL_NOT_READY') throw err;
    return FOLLOWUP_FALLBACK;
  }
}
