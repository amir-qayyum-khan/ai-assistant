import http from 'node:http';
import { validateHostConfig } from '../config/hostConfig.js';
import { route, completeToolCall } from '../router.js';

const MAX_BODY = 1024 * 1024;
const MAX_MESSAGE = 2000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

class HttpError extends Error {
  constructor(status, error, details) {
    super(error);
    this.status = status;
    this.body = details ? { error, details } : { error };
  }
}

function send(res, status, body, extraHeaders = {}) {
  if (body === undefined) {
    res.writeHead(status, CORS);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...CORS, ...extraHeaders, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) return reject(new HttpError(413, 'Body too large'));
    const chunks = [];
    let size = 0;
    let settled = false;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        settled = true;
        req.removeListener('data', onData);
        chunks.length = 0;
        reject(new HttpError(413, 'Body too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
  });
}

export function createHttpServer({ engine, store }) {
  const notReady = () => new HttpError(503, engine.status().error ?? 'Model is still loading');

  function requireSession(body) {
    const session = typeof body?.sessionId === 'string' ? store.get(body.sessionId) : null;
    if (!session) throw new HttpError(404, 'Unknown session');
    return session;
  }

  const handlers = {
    'GET /health': async () => {
      const { ready, error, model } = engine.status();
      return { ok: true, model, ready, error };
    },
    'POST /session': async (req) => {
      const result = validateHostConfig(await readJson(req));
      if (!result.ok) throw new HttpError(400, 'Invalid config', result.errors);
      return { sessionId: store.create(result.config).id };
    },
    'POST /chat': async (req) => {
      const body = await readJson(req);
      const session = requireSession(body);
      if (!engine.status().ready) throw notReady();
      const { message } = body;
      if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_MESSAGE) {
        throw new HttpError(400, `message must be a non-empty string of at most ${MAX_MESSAGE} characters`);
      }
      return route({ session, message, engine });
    },
    'POST /tool-result': async (req) => {
      const body = await readJson(req);
      const session = requireSession(body);
      if (!engine.status().ready) throw notReady();
      return completeToolCall({
        session, callId: body.callId, ok: body.ok === true, data: body.data, error: body.error, engine,
      });
    },
  };

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const handler = handlers[`${req.method} ${pathname}`];
      if (!handler) {
        req.resume();
        throw new HttpError(404, 'Not found');
      }
      send(res, 200, await handler(req));
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        req.resume();
        const timer = setTimeout(() => req.destroy(), 2000);
        timer.unref();
        const clear = () => clearTimeout(timer);
        req.once('end', clear);
        req.once('close', clear);
        return send(res, 413, err.body);
      }
      if (err instanceof HttpError) return send(res, err.status, err.body);
      if (err?.code === 'UNKNOWN_CALL') return send(res, 409, { error: 'Unknown or stale callId' });
      if (err?.code === 'MODEL_NOT_READY') return send(res, 503, { error: engine.status().error ?? 'Model is still loading' });
      console.error('Internal error:', err);
      send(res, 500, { error: 'Internal error' });
    }
  });
}
