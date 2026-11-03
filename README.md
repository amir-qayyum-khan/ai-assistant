# AI Assistant

A small, fully offline assistant server. A local LLM (Qwen3-1.7B via node-llama-cpp) routes a user's message to one of the tools your host application declares, the host app runs the tool, and the assistant turns the result into a short answer. Nothing leaves the machine at runtime.

## Requirements

- Node.js >= 20
- About 2 GB of free RAM for the default model
- Windows or Linux

## Quick start for non-technical users

1. Install Node.js 20 or newer from https://nodejs.org (once).
2. Open a terminal in this folder and run `npm install` (once).
3. Double-click `start.bat` (Windows) or run `./start.sh` (Linux/macOS). `npm start` does the same.

On the first run a setup page opens in your browser: pick a model, press "Download & start", and wait until it says Ready. Later runs start the assistant immediately at http://127.0.0.1:7071. Close the window to stop it. Developers can run the server directly with `npm run serve`.

## Quick start

```sh
npm install
npm run setup:models   # one-time download of the GGUF models into models/
npm run serve          # listens on 127.0.0.1:7071
```

Run the tests with `npm test`. Measure routing accuracy of the local model with `npm run eval` (optionally `-- --model models/Qwen3-0.6B-Q4_K_M.gguf`); it exits 1 below 90%.

## Configuration

- `server.config.yaml` — host, port, model file, context size, GPU, session TTL.
- Host config — sent by the client in `POST /session`; declares the assistant name, scope message, entities and tools. Example: [`examples/example-host.config.yaml`](examples/example-host.config.yaml).

## Client SDK

```js
const assistant = createAssistant({ serverUrl, config });
assistant.registerTool('run_unit_tests', async ({ app }, ctx) => { ... return data; });
const reply = await assistant.send('execute we common test', { onToolStart, onToolEnd });
// send(): POST /chat; if tool_call → run handler → POST /tool-result → return final answer.
```

- Throws a clear error at startup if a tool in config has no registered handler.
- Handler exceptions are sent back as `ok:false` with the message.

## HTTP API

All bodies are JSON.

- `GET /health` → `{ ok: true, model: "<file>", ready: true|false }`
- `POST /session` body: host config → `{ sessionId }`. Returns 400 with a list of validation errors if the config is invalid.
- `POST /chat` body: `{ sessionId, message }` → one of:
  - `{ type: "answer", text }`
  - `{ type: "tool_call", callId, tool, params, confirm? }`
  - `{ type: "clarify", text, missing: ["app"], options?: [...] }`
  - `{ type: "out_of_scope", text }` (text = `scope_message`)
- `POST /tool-result` body: `{ sessionId, callId, ok: true, data }` or `{ sessionId, callId, ok: false, error }` → `{ type: "answer", text }`
- Errors: 404 unknown session, 409 unknown/stale callId, 503 model not loaded.

## Air-gapped machines

Models are plain files. Run `npm install` and `npm run setup:models` on a connected machine, then copy the whole project folder (including `node_modules/` if the target has the same OS and Node version, and the `models/` directory) to the air-gapped machine. Otherwise copy just `models/` into the project root there, install dependencies from an offline npm cache, and run `npm start`. The server makes no network calls at runtime.

## License

MIT
