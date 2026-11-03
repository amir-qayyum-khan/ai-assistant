'use strict';

function createAssistant({ serverUrl, config, fetch: fetchImpl } = {}) {
  const base = String(serverUrl || '').replace(/\/+$/, '');
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const handlers = new Map();
  let sessionId = null;
  let startPromise = null;

  async function request(method, path, body) {
    let res;
    try {
      res = await doFetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      const err = new Error(`Assistant server not reachable at ${serverUrl}`);
      err.code = 'SERVER_UNREACHABLE';
      err.cause = cause;
      throw err;
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed with status ${res.status}`);
      err.status = res.status;
      if (data && data.details !== undefined) err.details = data.details;
      throw err;
    }
    return data;
  }

  async function createSession() {
    for (const t of (config && config.tools) || []) {
      if (!handlers.has(t.name)) throw new Error(`No handler registered for tool "${t.name}"`);
    }
    const r = await request('POST', '/session', config);
    sessionId = r.sessionId;
  }

  function start() {
    if (!startPromise) {
      startPromise = createSession().catch((e) => {
        startPromise = null;
        throw e;
      });
    }
    return startPromise;
  }

  async function chat(message) {
    try {
      return await request('POST', '/chat', { sessionId, message });
    } catch (e) {
      if (e.status !== 404) throw e;
      startPromise = null;
      sessionId = null;
      await start();
      return request('POST', '/chat', { sessionId, message });
    }
  }

  function safely(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (_) {
      // UI callbacks must never break the protocol
    }
  }

  async function runTool(reply, opts) {
    const { callId, tool, params } = reply;
    const handler = handlers.get(tool);
    safely(opts.onToolStart, { tool, params });
    let result;
    try {
      if (!handler) throw new Error(`No handler registered for tool "${tool}"`);
      const data = await handler(params, { confirm: reply.confirm, callId });
      result = { ok: true, data: data === undefined ? null : data };
      JSON.stringify(result);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      result = { ok: false, error: result && result.ok ? `Tool result could not be serialised: ${msg}` : msg };
    }
    safely(opts.onToolEnd, result.ok ? { tool, ok: true } : { tool, ok: false, error: result.error });
    return request('POST', '/tool-result', { sessionId, callId, ...result });
  }

  return {
    registerTool(name, handler) {
      handlers.set(name, handler);
    },
    start,
    async send(message, opts = {}) {
      await start();
      let reply = await chat(message);
      if (reply.type === 'tool_call') reply = await runTool(reply, opts);
      const out = { type: reply.type, text: reply.text };
      if (reply.options) out.options = reply.options;
      return out;
    },
    health() {
      return request('GET', '/health');
    },
  };
}

module.exports = { createAssistant };
