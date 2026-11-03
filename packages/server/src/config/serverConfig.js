import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

export function loadServerConfig(filePath) {
  const abs = path.resolve(filePath);
  const raw = parse(fs.readFileSync(abs, 'utf8')) ?? {};
  const model = raw.model ?? {};
  const cfg = {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 7071,
    model: {
      file: model.file,
      contextSize: model.contextSize ?? 4096,
      gpu: model.gpu ?? 'auto',
    },
    session: { idleTtlMinutes: raw.session?.idleTtlMinutes ?? 120 },
    auth: { enabled: raw.auth?.enabled ?? false },
  };

  const errors = [];
  if (!LOOPBACK.has(cfg.host)) {
    errors.push(`host must be a loopback address (127.0.0.1, ::1 or localhost); refusing to listen on ${JSON.stringify(cfg.host)}`);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push(`port must be an integer from 1 to 65535 (got ${JSON.stringify(cfg.port)})`);
  }
  if (cfg.model.gpu !== 'auto' && cfg.model.gpu !== false) {
    errors.push(`model.gpu must be 'auto' or false (got ${JSON.stringify(cfg.model.gpu)})`);
  }
  if (!isPosInt(cfg.model.contextSize)) {
    errors.push(`model.contextSize must be a positive integer (got ${JSON.stringify(cfg.model.contextSize)})`);
  }
  if (typeof cfg.model.file !== 'string' || !cfg.model.file) {
    errors.push('model.file is required');
  }
  if (errors.length) {
    throw new Error(`Invalid server config ${abs}:\n- ${errors.join('\n- ')}`);
  }

  cfg.model.file = path.resolve(path.dirname(abs), cfg.model.file);
  return cfg;
}
