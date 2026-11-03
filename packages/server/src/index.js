import { loadServerConfig } from './config/serverConfig.js';
import { createSessionStore } from './session/store.js';
import { createEngine } from './llm/engine.js';
import { createHttpServer } from './http/server.js';

function configPath(argv) {
  const i = argv.indexOf('--config');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : 'server.config.yaml';
}

const config = loadServerConfig(configPath(process.argv.slice(2)));
const store = createSessionStore({ idleTtlMs: config.session.idleTtlMinutes * 60000 });
const engine = createEngine({
  modelFile: config.model.file,
  contextSize: config.model.contextSize,
  gpu: config.model.gpu,
});
const server = createHttpServer({ engine, store });

server.listen(config.port, config.host, () => {
  console.log(`AI assistant server listening on http://${config.host}:${config.port}`);
  engine.load().then(
    () => console.log(`Model ready: ${config.model.file}`),
    (err) => console.error(`Model failed to load: ${err.message}`),
  );
});

setInterval(() => store.sweep(), 5 * 60 * 1000).unref();

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
