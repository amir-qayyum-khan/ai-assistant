#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "AI Assistant needs Node.js 20 or newer."
  echo "Please install it from https://nodejs.org and then run this again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: please run 'npm install' in this folder once, then start again."
  exit 1
fi
exec node scripts/launcher.mjs
