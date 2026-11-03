# Project rules

## Model selection

- **Code implementation → Sonnet 5.5** (`claude-sonnet-5-5`). Writing or changing code, tests,
  scripts, configs, and executing plan tasks. When working from Opus, dispatch these as subagents
  with `model: "sonnet"`.
- **Architectural changes → Opus 5.5** (`claude-opus-5-5`). Specs, implementation plans, module
  boundaries, HTTP API / config schema / client SDK interface changes, model/runtime choices,
  and review of architectural decisions.
- If an implementation task turns out to need an architectural change, stop and hand it back to
  Opus before continuing.

## Codebase graph (graphify)

- Use graphify to build and query the knowledge graph of this repo. Output lives in
  `graphify-out/` (git-ignored).
- Consult the graph before broad file searches (`graphify query "<question>"`,
  `graphify explain "<node>"`); rebuild with `graphify update .` after structural changes.

## After every commit or push

- A project hook ([.claude/settings.json](.claude/settings.json) →
  [.claude/hooks/post-git.sh](.claude/hooks/post-git.sh)) updates the graphify graph automatically.
- Then remind the user to run `/compact` (Claude cannot run slash commands itself).
