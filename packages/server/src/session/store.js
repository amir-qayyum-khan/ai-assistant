import crypto from 'node:crypto';
import { createAliasMatcher } from '../entities/aliasMatcher.js';
import { compact } from './compactor.js';

const MAX_TURNS = 10;
const MAX_RESULTS = 3;

export function createSessionStore({ idleTtlMs, now = Date.now }) {
  const sessions = new Map();
  const expired = (s) => now() - s.lastSeen > idleTtlMs;

  return {
    create(config) {
      const session = {
        id: crypto.randomUUID(),
        config,
        matcher: createAliasMatcher(config.entities),
        turns: [],
        results: [],
        pendingCalls: new Map(),
        pendingClarify: null,
        lastSeen: now(),
      };
      sessions.set(session.id, session);
      return session;
    },
    get(id) {
      const s = sessions.get(id);
      if (!s) return null;
      if (expired(s)) {
        sessions.delete(id);
        return null;
      }
      s.lastSeen = now();
      return s;
    },
    sweep() {
      let removed = 0;
      for (const [id, s] of sessions) {
        if (expired(s)) {
          sessions.delete(id);
          removed++;
        }
      }
      return removed;
    },
    size() {
      return sessions.size;
    },
  };
}

export function addTurn(session, role, text) {
  session.turns.push({ role, text });
  if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
}

export function addResult(session, { tool, params, data }) {
  session.results.push({ tool, params, data: compact(data) });
  if (session.results.length > MAX_RESULTS) session.results.splice(0, session.results.length - MAX_RESULTS);
}
