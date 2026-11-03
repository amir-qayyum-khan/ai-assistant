export function createFakeEngine(handler, { ready = true } = {}) {
  const calls = [];
  return {
    calls,
    async load() {},
    status: () => ({ ready, error: ready ? null : 'fake not ready', model: 'fake.gguf' }),
    async complete(req) {
      if (!ready) {
        const err = new Error('fake not ready');
        err.code = 'MODEL_NOT_READY';
        throw err;
      }
      calls.push(req);
      return handler(req);
    },
  };
}
