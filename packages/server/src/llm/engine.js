import fs from 'node:fs';
import path from 'node:path';
import { getLlama, LlamaLogLevel, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';

export function createSerialQueue() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export function createEngine({ modelFile, contextSize, gpu }) {
  const model = path.basename(modelFile);
  const queue = createSerialQueue();
  const grammars = new Map();
  let ready = false;
  let error = null;
  let llama, sequence;

  async function load() {
    try {
      if (!fs.existsSync(modelFile)) {
        throw new Error(`Model file not found: ${modelFile}. Run npm run setup:models`);
      }
      llama = await getLlama({ gpu: gpu === false ? false : 'auto', logLevel: LlamaLogLevel.error });
      const m = await llama.loadModel({ modelPath: modelFile });
      const context = await m.createContext({ contextSize });
      sequence = context.getSequence();
      ready = true;
      error = null;
    } catch (e) {
      ready = false;
      error = e.message;
    }
  }

  function status() { return { ready, error, model }; }

  async function complete({ system, prompt, jsonSchema, maxTokens }) {
    if (!ready) {
      const err = new Error(error || 'Model not ready');
      err.code = 'MODEL_NOT_READY';
      throw err;
    }
    return queue(async () => {
      let grammar;
      if (jsonSchema) {
        const key = JSON.stringify(jsonSchema);
        grammar = grammars.get(key);
        if (!grammar) {
          grammar = await llama.createGrammarForJsonSchema(jsonSchema);
          grammars.set(key, grammar);
        }
      }
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: system,
        chatWrapper: new QwenChatWrapper({ thoughts: 'discourage' }),
      });
      try {
        const text = await session.prompt(prompt + ' /no_think', {
          grammar,
          maxTokens: maxTokens ?? (jsonSchema ? 200 : 300),
          temperature: jsonSchema ? 0 : 0.3,
        });
        return grammar ? grammar.parse(text) : text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      } finally {
        session.dispose();
        await sequence.clearHistory();
      }
    });
  }

  return { load, status, complete, contextSize };
}
